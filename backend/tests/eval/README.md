# Detection Eval Pipeline

Synthetic screen recordings with known ground truth, used to measure the stable-screen engine
(`stable_v3`) the way real uploads arrive.

## Quick start

```bash
cd backend

# Regression gates (part of the normal test run)
uv run pytest tests/eval/ -q

# Full stress matrix with a summary table
uv run python -m tests.eval.stress --set all
```

## Architecture

```
tests/eval/
├── README.md             ← this file
├── types.py              ← GroundTruthEvent, ScenarioResult, EvalMetrics
├── rendering.py          ← UI rendering toolkit (widgets, layouts, transitions)
├── scenarios.py          ← baseline scenario generators, by category
├── step_scenarios.py     ← scenarios about what a step should be (typing, form fields, toggles)
├── evaluator.py          ← matching algorithm and metrics
├── stress.py             ← uploads as they really arrive (H.264, phone-style VFR, overlays); CLI
├── cards.py              ← test cards: countdowns, colour-only change, size sweep, colour accuracy, long recording
├── wide.py               ← device sizes, upload formats and test cards; CLI
├── web/                  ← the web tester: mock apps with scripted people, which say what they show
├── webrec.py             ← records the web tester, frame by frame; CLI
├── webreal.py            ← takes in a recording of it that a phone or a computer made; CLI
├── webtruth.py           ← the steps a recording should give, from the tester's own log
├── webscore.py           ← the engine on those recordings: steps, labels, boxes, returns; CLI
├── webtext.py            ← reading text: screens of the web tester at eight sizes, and eleven languages; CLI
├── test_eval_stress.py   ← pytest regression gates for the stress matrix
├── test_eval_wide.py     ← pytest regression gates for the wider evaluation
├── test_eval_web.py      ← pytest for the rules in webtruth.py
└── results/              ← JSON summaries written with --json (gitignored except .gitkeep)
```

## Modules

### `types.py`

Core data types shared across the pipeline: `GroundTruthEvent` (a known event with type, start and end
time, difficulty), `ScenarioResult` (video path, ground truth, metadata), `EventMatchResult` and
`EvalMetrics` (precision, recall, F1, timing error).

### `rendering.py`

UI rendering toolkit using OpenCV + numpy.  No external assets.

**Layers:**

| Layer | Examples |
|-------|----------|
| Primitives | `solid`, `text`, `rect`, `circle`, `divider`, `add_noise` |
| Widgets | `button`, `chip`, `avatar`, `list_item`, `card`, `search_bar`, `input_field`, `toggle_switch`, `badge`, `progress_bar`, `skeleton_block` |
| Layouts | `app_chrome`, `settings_screen`, `dashboard_screen`, `chat_screen`, `form_screen`, `list_screen`, `feed_card_content`, `loading_skeleton_screen` |
| Transitions | `fade`, `slide_vertical`, `write_transition` |
| Scroll | `tall_content_strip`, `tall_feed_strip`, `scroll_crop`, `write_scroll` |
| Video I/O | `create_writer`, `write_n`, `frames_for_duration` |

### `scenarios.py`

Baseline scenarios organized by category:

| Category | Scenarios | Tests |
|----------|-----------|-------|
| **navigation** | `nav_basic`, `nav_with_fade`, `nav_dark_theme`, `nav_rapid` | Instant cuts, fades, dark themes, rapid switching |
| **scrolling** | `scroll_list`, `scroll_slow`, `scroll_then_navigate` | List scroll, slow scroll (0.9px/frame), scroll + nav |
| **feed** | `feed_card_swap`, `feed_scroll` | TikTok-style slide, Instagram-style incremental |
| **overlay** | `overlay_modal`, `overlay_toast`, `overlay_bottom_sheet` | Dialog, toast notification, bottom sheet |
| **content** | `content_text_update`, `content_loading_to_data`, `content_typing`, `content_dwell` | Metric changes, skeleton→content, typing, dwell |
| **composite** | `composite_browse_session`, `composite_back_and_forth`, `composite_with_noise` | Multi-event session, A→B→A→B, noise |

Each scenario is tagged with `difficulty` (easy/medium/hard) and `category`.

### `evaluator.py`

**Matching algorithm:** Greedy closest-match.  For each ground truth event
(chronological order), find the nearest engine candidate within
`[start_ms - tolerance_ms, end_ms + tolerance_ms]`.  Default tolerance: 500ms.

**Metrics:**

| Metric | Definition |
|--------|------------|
| Precision | TP / (TP + FP) — what fraction of candidates are correct |
| Recall | TP / (TP + FN) — what fraction of events were detected |
| F1 | Harmonic mean of P and R |
| Mean timing error | Average `abs(candidate_ts - event_midpoint)` for matches |

**Breakdowns:** `category_breakdown()` and `difficulty_breakdown()` slice
metrics by event type and difficulty level.

**Debug report:** `format_debug_report()` prints per-candidate detail showing
which ground truth event each candidate matched (or didn't), with score
breakdowns.

## Stress matrix (`stress.py`)

The baseline scenarios are clean MJPEG at constant frame rate, which real uploads never are. `stress.py`
re-encodes every scenario the way uploads arrive and adds interface noise, then runs each variant
through the app's own pipeline (ingest working copy, ffprobe metadata, stable-screen detection):

| variant | simulates |
|---|---|
| `raw` | the generated file itself (what the baseline suite tests) |
| `h264_cfr` | a compressed upload (H.264, CRF 23) |
| `h264_vfr` | a phone screen recording: a frame is written only when the screen changes (at least one per second) |
| `+cursor` / `+spinner` / `+pointer` / `+clock` | blinking caret, looping activity indicator, moving mouse pointer, ticking status-bar clock |

Besides P/R/F1 it reports:

- **screenshot fidelity**: whether each matched candidate's PNG shows the settled post-event state rather
  than the pre-event one, judged where those two frames differ (so a toggle is not lost in compression
  noise). The timing-window evaluator alone passes mid-animation screenshots.
- **opening**: the opening-screen step is present and shows the first frame. Ground truth
  lists changes only, so that step is left out of precision and recall.
- **labels**: how often the matched candidate's `transition_type` describes the ground-truth event type.

`--set steps` (or `all`) adds the scenarios in `step_scenarios.py`, which test what a step should be
rather than whether a change is found: a message typed word by word with pauses (one step), two form
fields filled in turn (one step each) and three toggles in a column (three steps, not a typing group).
They are kept out of `BASELINE_SCENARIOS` so the baseline set stays comparable with earlier results.

```bash
python -m tests.eval.stress --set all            # all 25 scenarios, every variant
python -m tests.eval.stress --no-ingest          # detect on the upload itself, as before working copies
python -m tests.eval.stress --only nav_basic --variants h264_vfr,h264_vfr+spinner
```

`test_eval_stress.py` holds the regression gates that run in `pytest`. On a set of scenarios, a
phone-style (VFR) upload must find at least as much as a constant-frame-rate upload of the same content,
with every matched screenshot settled. On 14 scenarios (including the typing and toggle ones), a
phone-style upload must find every event with a settled screenshot and the opening screen, and any extra
step must be a return to an earlier screen.

The retired hybrid v2 engine and its scenario runner (`runner.py`, realistic matrices, stored results)
are at the git tag `last-with-hybrid-v2`. The current engine's results on this matrix, and its known limits, are
in `docs/evaluation.md`.

## Wider evaluation (`wide.py`, `cards.py`)

Everything is generated, so every result has exact ground truth and needs no real recordings. `wide.py`
has three sections:

| section | what it runs |
|---|---|
| `devices` | the device-aware scenarios at the sizes devices record at: iPhone (1180x2556), Android phone (1080x2400), tablet (1640x2360), Retina laptop (2560x1600) and 1080p desktop, both with and without a moving pointer, and full-screen video in both orientations |
| `formats` | the phone scenarios at 780x1688 in every upload format the app meets: H.264 and HEVC with variable frame rate, 60 and 120 fps sources, WebM (VP9), rotated, BT.709-tagged, full range, HDR PQ and HDR HLG |
| `cards` | the test cards in `cards.py`: a countdown over colour bars (with and without a dial that keeps turning), a change to a colour of the same brightness, a sweep of squares of growing size, the colour accuracy of the working copy per format, and a 5 min 40 s recording that the engine has to decode twice |

The device profiles are in `scenarios.PROFILES`; `scenarios.device_scenario()` builds one scenario for a
profile and size. Frames are streamed from the rendered file, never held at full size, so Retina-sized
scenarios fit in memory. The colour-accuracy card compares every bar and grey step of the working copy with
the original, in 8-bit levels.

```bash
python -m tests.eval.wide                       # everything, about ten minutes
python -m tests.eval.wide --section cards       # one section
python -m tests.eval.wide --json results.json   # also write the numbers
python -m tests.eval.wide --save-videos tests/eval/results/videos   # keep every generated video
```

The videos are made in a temporary folder and deleted after the run. With `--save-videos DIR`, every upload
the app was given (about 130 for a full run) is copied into `DIR/devices`, `DIR/formats` and `DIR/cards`.
Each comes with a `.json` file of the same name. It lists the changes the video contains (the ground truth,
in seconds) and what the engine found when the video was made. `DIR/index.csv` lists every video with its
numbers, and `DIR/README.txt` explains the layout. Saving into an existing folder adds to it, and the index
covers everything there. `tests/eval/results/videos/` is ignored by git.

`test_eval_wide.py` gates a fast part of each section in `pytest`.

## Web tester (`web/`, `webrec.py`, `webtruth.py`, `webscore.py`)

The drawn scenarios above have exact timing but simple screens. The web tester is made of real ones: nine mock apps in
HTML (an admin console, a window in two halves with an assistant at work, mail, documentation, a chat with answers that
stream, a shop, phone settings, short videos, a feed), each with scripts in which somebody uses them, at a person's pace
and with a person's slips.

| covered | how |
|---|---|
| scrolling | flicks with momentum, wheel, slow; of a page, of one pane, of a list of rows that look alike |
| typing | one field, several, a field that grows, a list that follows; pauses and slips; a phone keyboard with key pop-ups |
| overlays | menus and submenus that dim nothing, pop-overs, dialogs, sheets, a drawer, a panel, toasts, a tooltip |
| returns | back to a list where it was left, the same page scrolled elsewhere, with a menu closed, pages made alike |
| what is no step | rows that light up, a moving pointer, scroll bars that fade, clips, spinners, a blinking caret |
| the rest | answers that stream, pages that load, content pushed down, things folded open, switches, dark mode, swipes |

**The app says what it shows.** At every frame it logs which screen it is, what lies over it, how far every pane is
scrolled, what is in the fields and what is moving. `webtruth.py` works the expected steps out of that, for any minimum
time on screen, so there is nothing to mark by hand. Recordings are made with the clock turned by hand, one frame at a
time: a script gives the same log every time, and the same pictures but for a few pixels.

```bash
python -m tests.eval.webrec                      # record every script (22, about four minutes; needs Chrome)
python -m tests.eval.webscore                    # and score the engine on them
python -m tests.eval.webscore --set dev --steps --only workshop_a    # every step, and what it was
```

Script `a` of every app is there to develop with. Script `b`, with another theme and other texts, is kept apart: look at
its totals only. The apps are the same in both, and drawn by the same project that makes the engine, so good numbers here
say less than good numbers on real recordings.

The results of the current engine are in [docs/evaluation.md](../../../docs/evaluation.md#4-labels-and-screens-the-web-tester).

**Recorded by something else.** To record the tester with a phone, a Mac or a simulator: serve `web/`, open it there and
choose *watch* (it plays a script) or *use it yourself*. Start the screen recording, press *start* when there is one, and
*save the log* (*done*) at the end. A magenta and green flash at both ends ties the log to the video:

```bash
python -m http.server --directory tests/eval/web 8400
python -m tests.eval.webreal recording.mov larder_a__phone__log.json
python -m tests.eval.webscore --set real --steps
```

**Reading text.** Every word of these screens is known too, so they also measure how well text is read
(`app/services/text_engine.py`): at eight sizes, from a phone to a 4K display, with a page of sentences in eleven
languages. It needs Chrome and the models; the results are in
[docs/evaluation.md](../../../docs/evaluation.md#text-recognition).

```bash
python -m app.services.text_models               # once: get the models
python -m tests.eval.webtext                     # every size (about fifteen minutes)
python -m tests.eval.webtext --sizes phone,laptop
```

A new app is an entry in `Kit.apps` with a `build` and two scripts (`web/apps_computer.js`, `web/apps_phone.js`). It says
what it shows through the kit: `Kit.show` and `Kit.at` for screens, `Kit.open` and `Kit.close` for what lies over them,
`data-pane` and `data-field` on what scrolls and what is typed in, `Kit.set` for switches and what is folded open,
`Kit.came` for what comes in late, `Kit.loop` for what never stops. Things left to chance go through `Kit.fixed` when
they are drawn again, or a screen that is come back to would not look the same.

## Adding a new scenario

1. Write a function in `scenarios.py` following the pattern:

```python
def my_scenario(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Description of what this tests."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "my_scenario.avi"
    writer = r.create_writer(path, w, h, fps)

    # Build frames using rendering.py helpers
    screen = r.app_chrome(r.list_screen(w, r.CONTENT_HEIGHT), header_text="My Screen")
    r.write_n(writer, screen, r.frames_for_duration(fps, 2.0))
    # ... more frames ...

    writer.release()

    return _result(
        Path(str(path)),
        category="navigation",
        difficulty="medium",
        fps=fps,
        duration_ms=...,
        description="What this scenario tests",
        ground_truth=[
            GroundTruthEvent("navigation", start_ms=..., end_ms=..., metadata={...}, difficulty="medium"),
        ],
    )
```

2. Register it in `ALL_SCENARIOS` at the bottom of `scenarios.py`.

3. Run `python -m tests.eval.stress --only my_scenario` to verify.

## Ground truth event types

| Type | Meaning |
|------|---------|
| `navigation` | Full-screen or major layout change |
| `scroll` | Content moves within a viewport |
| `card_swap` | Feed card replaced (chrome stays fixed) |
| `content_update` | Text/data change, layout unchanged |
| `modal` | Overlay/dialog/sheet appears |
| `small_ui_change` | Toast, badge, indicator — small region |
| `loading` | Skeleton/spinner → content transition |
