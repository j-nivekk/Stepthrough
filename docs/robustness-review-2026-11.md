# Stepthrough robustness review (November 2026)

Scope: is the backend's interface-change detection reliable enough to serve as research infrastructure for master's courses at the UvA, what should students be able to tune, is the current approach the right one, and what does it take to run a shared server instance. The frontend design language is out of scope and stays as it is.

Everything below was measured on this machine (M-series Mac, ffmpeg 9.0.2, OpenCV 4.10, Python 3.12) against the code at `483822d`. The scripts are in `backend/experiments/` so every number can be reproduced (see the last section).

## 1. Verdict in brief

**Not yet robust enough for course use, but fixable, and the fix doubles as a simplification.**

- On clean synthetic recordings hybrid v2 does well (F1 0.84). On the same scenarios encoded the way phones actually record (variable frame rate), it drops to **F1 0.34**, and a quarter of the screenshots it does produce show the wrong screen. The cause is one assumption, that the video has a constant frame rate, and it applies to every iOS, Android and macOS screen recording. On the four real recordings in `data/` the detector looks at a frame up to 2.7 s away from the time it reports.
- HDR recordings from recent iPhones are exported as grey, low-contrast screenshots.
- Several signals inside the engine are weaker than they look (the tile signal reads zero on a full screen change). A spinner or blinking caret can hold an event open for the whole recording, and the opening screen is never offered as a step.
- The eval suite cannot catch any of this, because it only tests constant-frame-rate MJPEG and scores timestamps rather than screenshots.
- A ground-up alternative, detecting **stable intervals** (screens that stay still for at least *n* ms) with real timestamps, measured noise and automatic masking of animations, scored **F1 0.91** on the phone-style variant in a 150-line prototype. Every screenshot is a settled frame by construction, it ran 7 to 10 times faster on the real recordings, and it needs fewer, physically meaningful settings. It still over-segments typing, which needs one more merge rule.
- As a shared server it is currently unsafe: the database and all recordings are downloadable from `/assets`, anyone can wipe all data through `/admin/reset-db`, and there are no users. Section 6 sets out a conventional container setup with SURFconext login, a job queue and private file serving.

### Update: phase 1 implemented (stable-screen engine)

Phase 1 of section 7 is in place as a third engine, `stable_v3` ("stable screens"), now the default for new runs. Code: `backend/app/services/stable_detection.py`.

*Later update (4 November 2026):* hybrid v2 and v1 are retired. Only `stable_v3` starts new runs; runs made with the earlier engines still open, review, compare and export. Their code, and the scripts that produced the hybrid v2 numbers below, are at the git tag `last-with-hybrid-v2`.

**How it works.** A step is a screen that stays still for at least the minimum time on screen. The working copy is decoded small and grey on a fixed real-time grid. Two passes then run:

1. Frame-to-frame differences give a noise floor measured on the recording itself, a map of regions that keep moving (busy in most frames of most seconds, such as a spinner or embedded video, but not typing or a blinking caret), and the content's vertical motion.
2. A stable screen is a run of frames that all match its *first* frame. That catches slow, accumulating change such as slow typing, which a frame-to-frame test misses. "Match" means no connected change larger than the smallest change, outside ignored regions. A thin vertical mark on its own (a caret) does not count.

Afterwards:
- Neighbouring stable screens that show the same state are merged.
- The change into each step is labelled.
- Typing bursts are grouped into one step.
- Optionally, scroll stops are merged.
- One screenshot is extracted per step, 200 ms after it settles.
- A revisit means the same state by that same test, not by image-hash similarity. Hash similarity had marked typing states as revisits of each other.

**Typing groups.** A burst is a run of small changes, each pause under 6 s, where every part of each change connects to the edit so far:
- the same place redrawn, or the input field growing a line;
- text further along the same line, with the gap scaled to the line height;
- the start of the next line.

On phones, a change confined to the keyboard (switching to numbers or symbols) continues a burst once text has been typed. A burst only counts if text grew somewhere, from earlier text that the change leaves alone, and it never ends on the screen from before it. The synthetic stress tests (section 8) check that these two conditions keep a column of toggles, tab titles switching, and a toast coming and going from being grouped as typing.

**Student-facing settings (section 4), all stored with the run.**
- Recording type: phone or tablet, or computer.
- Minimum time on screen (ms).
- Smallest change (% of screen, also shown as a patch size in pixels on the selected recording).
- Ignore areas, drawn on a frame of the recording.
- Phone status bar.
- Scrolling: each stop, or merge stops.
- Group typing.
- Opening screen.
- Read text (OCR).
- Advanced: pixel threshold in multiples of the measured noise, and analysis rate.

Each run stores its resolved settings, the engine version and what was measured (noise, pixel threshold, intervals found, typing groups). These appear in the run header and in exports: `steps.json` gains `engine_version`, `settings` and `resolved_settings`, and `steps.csv` gains `transition_type`, `change_started_ms`, `settled_ms`, `time_on_screen_ms` and `grouped_states`. Both now include `ocr_text`. `steps.json` also carries `field_notes`, which explain each field for the run's engine. Changed regions are in recording pixels for every engine, and the server-only `image_url` is gone.

**Stress matrix, 25 scenarios.** The 22 baseline scenarios plus three new ones in `backend/tests/eval/step_scenarios.py`:
- a chat message typed word by word with reading pauses, then sent;
- two form fields filled in turn;
- three toggles switched in a column, which must stay three steps.

Precision and recall leave the opening screen out, because ground truth lists changes only. It is checked separately ("opening": present and showing the first frame). Hybrid v2 uses the balanced preset with OCR off. Both engines run on the working copy.

| variant | hybrid v2 F1 | **stable v3 F1** | hybrid v2 right screenshot | stable v3 right screenshot | stable v3 opening |
|---|---|---|---|---|---|
| `raw` | 0.79 | **0.98** | 35/35 | 49/49 | 25/25 |
| `h264_cfr` | 0.79 | **0.98** | 35/35 | 49/49 | 25/25 |
| `h264_vfr` | 0.77 | **0.98** | 34/34 | 49/49 | 25/25 |
| `h264_vfr+cursor` | 0.58 | **0.98** | 26/27 | 49/49 | 25/25 |
| `h264_vfr+spinner` | 0.46 | **0.97** | 15/19 | 48/48 | 25/25 |
| `h264_vfr+pointer` | 0.40 | **0.85** | 11/15 | 40/42 | 25/25 |
| `h264_vfr+clock` | 0.77 | **0.98** | 33/34 | 49/49 | 25/25 |

Notes on the table:
- **Why hybrid v2 scores lower than in phase 0:** the set now includes the typing scenarios.
- **Stable v3 false positives (precision 0.96):** these are all returns to an earlier screen, such as a toast going away or a dialog closing. They are real states, the ground truth does not list them, and the engine marks them as revisits.
- **Pointer row:** it uses the "computer" recording type. The remaining misses are in the "rapid" scenarios, whose screens last 0.5 to 0.6 s, shorter than that type's 600 ms minimum.
- **Labels:** the transition label agrees with the ground-truth event type for 63 % of matched events, against 47 to 51 % for hybrid v2.
- **Speed:** the whole matrix takes 5 to 6 s of detection per variant, against 7 to 9 s for hybrid v2.

**Real recordings** (phone type, defaults):

| recording | length | hybrid v2 (phase 0) | stable v3 | stable v3 time (hybrid v2) |
|---|---|---|---|---|
| 03-24 10:48 | 23 s | 4 candidates | 7 steps | 1.8 s (3.6 s) |
| 03-25 18:28 (HDR) | 25 s | 6 | 8 | 2.7 s (4.1 s) |
| 03-24 11:34 | 46 s | 5 | 8 | 2.6 s (6.8 s) |
| 03-24 09:34 | 68 s | 3 | 8 | 3.2 s (9.5 s) |

On the 68 s recording, a prompt typed over 38 s with 16 pauses is now one step showing the finished prompt; the prototype had made 19 steps of it. The steps match the states identifiable by eye: Control Centre at the start, the app with the keyboard up, the typed prompt, the sent prompt, the streamed answer and the scroll stops. Peak memory was about 300 MB.

**Found along the way:**
- **OpenCV `phaseCorrelate` bug.** It multiplies its inputs by the window *in place* when no padding is needed. Hybrid v2 then measured scroll confidence on corrupted images, so its confidence was usually near zero. This is fixed in both engines, which is where hybrid v2's label agreement gain (from 38 % to about 50 %) comes from.
- **Frontend type check.** The root `frontend/tsconfig.json` lists no files, so `tsc --noEmit` there checks nothing. The real check is `tsc --project tsconfig.app.json`, which `npm run build` runs. The phase 0 note that the frontend "passes `tsc --noEmit`" was therefore vacuous. The app project does type-check now.
- **Screenshot check.** The stress harness's check compared whole frames, so a correct screenshot of a small change (a toggle) failed against compression noise. It now compares the region where the pre- and post-event frames differ.

**Limits that remain:**
- The typing rules were tuned on one real typing recording (iOS keyboard) and synthetic scenarios. Android keyboards, desktop typing and right-to-left scripts are untested on real data, which is what the phase 3 benchmark is for.
- Labels are descriptions only.
  - Full-screen video swipes are mostly labelled "navigation".
  - Sheets that do not dim the screen are labelled "content update".
  - Nothing tells a feed card swap from a long scroll unless the swipe covers about one full screen.
- Hybrid v2's self-normalising tile threshold (finding 3.3) is not fixed. Hybrid v2 is kept only for comparison.
- iPhone recordings started from Control Centre begin with one or two Control Centre steps. There is no trim setting yet, so students reject those steps.

### Update: phase 0 implemented

The must-do items from section 7 are in place (merged into `main` on 4 November 2026):

- **Working copy at ingest** (`backend/app/services/ingest.py`). Every upload is converted once into a constant-frame-rate, SDR, upright H.264 file, using ffmpeg's `fps` filter. Analysis, the browser preview, detected screenshots and manual steps all use it, so the frame the detector analysed is the frame that gets exported. HDR10 and HLG are tone-mapped with a generated 3D LUT through ffmpeg's built-in `lut3d`, so no special ffmpeg build is needed. It is built in the background after upload, or by the first run, and took 2.7 to 9.7 s for the four real recordings.
- **Frame-exact reader.** Samples carry their frame's exact time. Sequential reads replace a keyframe seek per sample, and when settled samples tie within compression noise the earliest is taken.
- **Server holes closed.** Only `data/projects/` is served. The reset endpoint needs a confirmation header and is off in `server` mode. CORS is limited to configured origins, uploads have a size limit (413), and runs interrupted by a restart are marked failed. Settings are documented in `backend/README.md`. Authentication is still to come.
- **Honest eval.** `backend/tests/eval/stress.py` runs the matrix through the real pipeline, and `test_eval_stress.py` gates it in `pytest`.

Same scenarios and emulator, original engine (`483822d`, upload analysed directly) against phase 0 (working copy), balanced preset:

| variant | F1 before | F1 after | right screenshot before | after |
|---|---|---|---|---|
| `raw` | 0.83 | 0.83 | 33/33 | 33/33 |
| `h264_cfr` | 0.74 | 0.86 | 27/29 | 33/34 |
| **`h264_vfr`** | **0.28** | **0.82** | **7/10** | **32/32** |
| `h264_vfr+cursor` | 0.23 | 0.57 | 5/8 | 20/23 |
| `h264_vfr+spinner` | 0.45 | 0.53 | 13/15 | 14/18 |
| `h264_vfr+pointer` | 0.30 | 0.34 | 8/10 | 8/11 |
| `h264_vfr+clock` | 0.53 | 0.81 | 19/20 | 31/31 |

These "before" numbers differ slightly from section 3, because the phone-style emulator was corrected to write a final frame on stop, as real recorders do. On the four real recordings the current engine now returns 4, 6, 5 and 3 candidates (previously 4, 1, 2 and 3), the HDR screenshots look normal, the mid-transition double exposure is gone, and detection runs 3 to 10 times faster.

What phase 0 does not fix: persistent animation, the pointer and the caret (rows above), typing bursts, the missing opening screen and the self-normalising tile signal. Those are phase 1.

## 2. How it was tested

1. **Existing tests.** `pytest` (58 unit and workflow tests) and the synthetic eval suite in `backend/tests/eval` (22 scenarios, 42 ground-truth events).
2. **Real recordings.** The four iPhone screen recordings already in `data/` (HEVC, 1180 to 1284 px wide, 23 to 67 s, one 10-bit).
3. **A new stress matrix.** Every synthetic scenario is re-encoded the way real uploads arrive, and four common sources of interface noise are overlaid:

   | variant | what it simulates |
   |---|---|
   | `mjpeg_cfr` | what the eval suite tests today: near-lossless, constant frame rate |
   | `h264_cfr` | a typical compressed upload (H.264, CRF 23) |
   | `h264_vfr` | a phone screen recording: a frame is only written when the screen changes (at least one per second), with real timestamps |
   | `+cursor` | a blinking text caret |
   | `+spinner` | a looping activity indicator |
   | `+pointer` | a desktop mouse pointer that keeps moving |
   | `+clock` | a status-bar clock that ticks every second |

4. **A screenshot-correctness check.** The existing evaluator only asks whether a candidate's *timestamp* falls within 500 ms of an event. That passes a screenshot taken mid-animation and fails a perfect screenshot taken 505 ms after a hard cut (which is exactly what happens in `composite_with_noise`). The stress harness additionally checks whether the exported PNG actually shows the settled state after the event (it must be at least twice as close to the post-event frame as to the pre-event frame).

**Not covered:** the OCR path (PaddleOCR is installed, but every run here had OCR off so the engines are compared like for like), real Android or desktop recordings (only iPhone recordings were available), and the frontend.

## 3. Findings: detection

Ordered by how much they matter for course use.

### 3.1 Critical: the detector assumes a constant frame rate, and phone recordings do not have one

`_SequentialReader` converts a sample time into a frame number with `round(t * avg_fps)` and then counts frames (or seeks with `CAP_PROP_POS_FRAMES`). Screen recordings from iOS, Android and macOS are variable frame rate: frames are only written when something on screen changes. All four recordings in `data/` are like this (nominal 60 or 240 fps, average 35 to 44 fps, gaps of up to 1 s between frames).

Measured on those recordings at the balanced preset, comparing the time the detector *thinks* it is analysing with the real presentation time of the frame it decoded:

| recording | median drift | 90th percentile | worst |
|---|---|---|---|
| 03-24 09:34 (67 s) | 427 ms | 876 ms | 2.1 s |
| 03-24 10:48 (23 s) | 333 ms | 1.5 s | 2.7 s |
| 03-24 11:34 (45 s) | 518 ms | 1.6 s | 2.7 s |
| 03-25 18:28 (25 s, 10-bit) | 930 ms | 2.0 s | 2.3 s |

The screenshot is then extracted with `ffmpeg -ss <nominal time>`, which uses real time. So the exported PNG is frequently not the frame the detector judged to be settled. In the 09:34 recording at nominal 2.2 s, the detector analysed the Control Centre grid while the exported screenshot shows the expanded Now Playing panel: a different interface state. Dwell, settle and minimum-gap windows are also measured in the wrong time base.

In the stress matrix this is the dominant failure. Current engine, balanced preset, 22 scenarios and 42 events per row:

| variant | precision | recall | F1 | screenshot shows the right state |
|---|---|---|---|---|
| `mjpeg_cfr` (today's suite) | 0.89 | 0.79 | 0.84 | 33/33 |
| `h264_cfr` | 0.81 | 0.71 | 0.76 | 30/30 |
| **`h264_vfr`** | **0.41** | **0.29** | **0.34** | **9/12** |
| `h264_vfr+cursor` | 0.39 | 0.29 | 0.33 | 8/12 |
| `h264_vfr+spinner` | 0.52 | 0.31 | 0.39 | 10/13 |
| `h264_vfr+pointer` | 0.38 | 0.21 | 0.27 | 7/9 |
| `h264_vfr+clock` | 0.59 | 0.48 | 0.53 | 18/20 |

The subtle-UI preset behaves the same way (F1 0.88 on `mjpeg_cfr`, 0.37 on `h264_vfr`). The clock row looks better only because a ticking clock forces the encoder to write a frame every second, which makes the file closer to constant frame rate.

On the real recordings the consequence is visible in the screenshots themselves. In the 03-24 11:34 recording the first candidate (5.3 s) is a double exposure: the Gemini start screen half-faded into the conversation view. On the 03-25 recording (25 s, prompt, streamed answer, four scroll stops) the engine returns a single candidate for the whole session.

The synthetic suite cannot see any of this because it only renders constant-frame-rate MJPEG files.

### 3.2 Critical: HDR recordings are exported grey

The 03-25 recording is HDR10 (10-bit, BT.2020 primaries, PQ transfer), which recent iPhones produce when HDR capture is on. Nothing in the pipeline tone-maps, so every exported PNG from that recording is a flat grey version of the screen (brightest 1 % of pixels at 130 of 255 instead of white), and detection runs on compressed contrast. A tone-map at ingest fixes it. `backend/experiments/out/hdr_pair.jpg` shows today's export next to a quick tone-mapped version. Homebrew's ffmpeg lacks `zscale`, so a server build needs ffmpeg with `zscale` (libzimg) or `libplacebo`.

### 3.3 High: the tile-change signal switches itself off for large changes

`_tile_change_ratio` marks a tile as changed when its mean difference exceeds `max(0.04, 2.5 * std(diff))`, where the standard deviation is taken over the very difference image being tested. A large change raises the standard deviation, which raises the bar. On a full navigation between two synthetic screens the threshold becomes 0.26, no tile passes, and `tile_ratio`, `content_change` and `chrome_change` are all 0.00, although `structural` is 1.00. The `content_change` term (weighted into both `visual` and `combined`) and the chrome/content split that `_classify_transition` relies on (`navigation` needs both above 0.25) are therefore mostly dead. Detection still works because SSIM carries it, but the transition labels shown to students are unreliable. The threshold should be relative to a noise floor measured on unchanged content, not to the change itself.

### 3.4 High: the opening screen is never a candidate

The first sampled frame only becomes the comparison anchor. Unless nothing at all is detected, the starting screen of the walkthrough never appears as a step. For walkthrough documentation, step 0 is usually wanted.

### 3.5 High: persistent animation and pointer motion

A looping spinner, an autoplaying video, a blinking caret or a moving mouse pointer either keeps an event window "active" (so separate steps merge into one) or crosses the micro-change rules and creates extra candidates. The tile stability map only feeds the chrome/content split. It does not exclude those regions from the change signal. A concrete case: `nav_basic` (two navigations, at 1.5 s and 3.0 s) with a small spinner in one corner, encoded as plain constant-frame-rate H.264. The engine opens one event at 0.17 s that never settles before the clip ends at 4.5 s, so both navigations become a single candidate, labelled `scroll`. See also the `+spinner`, `+cursor` and `+pointer` rows above.

### 3.6 Medium: text-only changes need OCR, and OCR flicker counts as maximal change

`content_text_update` (dashboard numbers change, layout identical) produces no detection at the balanced preset without OCR: the run falls back to a single frame at 0 ms. With OCR on, `text_distance` returns 1.0 (maximum change) whenever one side has text and the other has none, so a missed OCR read on one frame looks like a complete text change and passes the `text >= 0.3` proposal rule.

### 3.7 Medium: "sequential decoding" is mostly seeking

`_SequentialReader` reads forward only if the next sample is at most 5 frames away. At the balanced preset (6 fps) on a 35 to 44 fps recording the gap is 6 to 7 frames, so every sample becomes a seek and decodes from the previous keyframe. The same applies to any 60 fps desktop recording at balanced or noise-resistant settings. On the 46 s recording, decoding the samples alone took 21 s of wall time at about 5.6 cores, and the full detection run took 25 s.

### 3.8 Medium: the evaluation suite measures the wrong thing

Synthetic MJPEG at 640x360 and 30 fps constant, matched on timestamps within a 500 ms window. There is no compressed or variable-frame-rate input, no phone-resolution input, no persistent animation, and no check that the screenshot shows the right state. A suite that scores F1 0.84 here scores 0.34 on the same scenarios encoded like a phone recording.

### 3.9 Low, but worth cleaning up

- The ffmpeg extraction fallback silently steps back up to 4 s if the requested frame fails, without flagging the candidate.
- `extract_offset_ms` is ignored by hybrid v2 (documented, but it still appears in the API).
- `_scroll_displacement` has two identical return branches (leftover gating).
- The revisit-group threshold (0.16 blended distance) is a constant with no setting or test.
- `@app.on_event("startup")` is deprecated in FastAPI; the test run also logs a foreign-key race when a run event is written after its run is deleted.
- `website/` including its `node_modules` is tracked in git (5,191 files, 118 MB on disk) despite `.gitignore`.
- The v1 engine (PySceneDetect) was not evaluated. It is built for film cuts, reads frames by count in the same way, and takes its screenshot a fixed offset after the cut starts, so it is likely to share findings 3.1 and 3.2 and to capture mid-animation frames.

## 4. Parameters: what students should be able to set

Today a student sees a preset plus six unitless thresholds between 0 and 1 (`proposal`, `settle`, `ocr_trigger`, sample fps, dwell, settle window), and the v1 engine adds four more. The thresholds act on hand-weighted sums of five signals, so their effect is not predictable without reading the code, and they interact (for example `settle_threshold` against the micro-change rules). For a master's cohort the controls should be few, stated in physical units, and each should answer a question a researcher would actually ask:

| control (student-facing) | unit | answers | default |
|---|---|---|---|
| **Recording type** | phone / desktop with pointer / web prototype | sets sensible defaults for the rest | phone |
| **Minimum time on screen** | ms | "how long must a screen stay still to count as a step?" | 450 to 600 |
| **Smallest change that counts** | % of screen (with a visual preview box) | "should a badge or a typed character be a step?" | 0.1 % |
| **Ignore areas** | boxes drawn on the first frame | status bar, keyboard, an embedded video, a live clock | none (status bar on phones) |
| **Scrolling** | one step per scroll stop / ignore scrolls | how scrolling is treated | one per stop |
| **Group typing into one step** | on/off | collapse a burst of keystrokes into its finished state | on |
| **Include the opening screen** | on/off | step 0 | on |
| **Text-aware matching (OCR)** | on/off | catch text-only changes, deduplicate revisits | off for speed |

Expert controls (sensitivity in multiples of the measured noise, analysis rate, merge distance for revisits) can stay behind an "advanced" disclosure. Every run should store the fully resolved settings and engine version with its results, so that course output stays reproducible and citable.

## 5. Is the approach right? Rethinking it from the ground up

### 5.1 What the task actually is

A walkthrough step is a *settled interface state*: the screen stops changing long enough for a person to read it. The current engine instead detects *change events* and then tries to find a settled frame after each one. That puts the hard part (the settle point) at the end of a chain of thresholds, and every failure upstream (timing drift, an animation keeping the event alive, a missed small change) ends up as a wrong or missing screenshot.

### 5.2 Formulations considered

| approach | idea | strengths | weaknesses |
|---|---|---|---|
| **A. Current: online change scoring** | weighted sum of SSIM, tiles, edges, contours, scroll and OCR feeds a propose/continue/settle state machine | handles many cases once tuned; already has scroll and modal labels | many coupled magic numbers; settle point is indirect; hard to explain to students or in a methods section |
| **B. Stable intervals ("plateaus")** | find periods where the screen does not change for at least *d* ms (ignoring masked dynamic regions); take one screenshot inside each; merge adjacent intervals showing the same state | screenshot is a settled frame by construction; one main knob in ms; easy to explain and to cite; robust to variable frame rate if timestamps are real | needs explicit handling of always-moving content (masking) and of pointer motion |
| **C. Offline change-point detection** | compute a per-frame feature vector (pixel or embedding differences) and segment it globally (for example PELT in `ruptures`) with a single penalty parameter | globally consistent; one tuning parameter; well-established statistics | still needs B's keyframe rule inside each segment; the penalty is less intuitive than milliseconds |
| **D. Learned or semantic similarity** | compare frames with image embeddings (DINOv2, SigLIP), UI parsers (OmniParser) or a vision-language model asked "same screen or new step?" | understands that a new message bubble matters but a shimmer does not; can caption steps | heavy (GPU or remote API); a remote API would send research recordings off-premises; less reproducible across model versions |

There is direct precedent for B in software-engineering research on GUI recordings. GIFdroid (Feng and Chen, ICSE 2022) locates keyframes as steady-state stretches where consecutive frames stay similar for a minimum duration. CAPdroid (ICSE 2023) segments GUI recordings into action clips before describing them. Both are published, citable baselines.

### 5.3 Prototype result

To test whether B is worth it, I wrote a 150-line prototype (`backend/experiments/plateau.py`). It uses true presentation timestamps from ffmpeg, a noise floor measured from the recording itself, masking of grid cells that change in at least 75 % of the one-second bins around each moment, and one screenshot per stable interval. It ran through the same stress matrix with no per-scenario tuning:

| variant | current engine F1 | prototype F1 | prototype: right screenshot |
|---|---|---|---|
| `mjpeg_cfr` | 0.84 | 0.90 | 36/36 |
| `h264_cfr` | 0.76 | 0.89 | 35/35 |
| **`h264_vfr`** | **0.34** | **0.91** | **32/37** |
| `h264_vfr+cursor` | 0.33 | 0.91 | 35/37 |
| `h264_vfr+spinner` | 0.39 | 0.81 | 29/29 |
| `h264_vfr+pointer` | 0.27 | 0.22 (0.89 with the "desktop with pointer" area setting) | 6/6 (35/35) |
| `h264_vfr+clock` | 0.53 | 0.90 | 36/36 |

The prototype's remaining misses are in the "rapid" scenarios, where screens are held for only 0.5 to 1 s. That is the minimum-time-on-screen trade-off, not a malfunction. Results are deterministic across reruns.

Two lessons from building it apply to any engine:

1. **Resample by real time, never by frame count.** My first decoder thinned frames by timestamp gap and skipped the last frame of each animation, because it came 40 ms after the previous one. On a phone recording that frame is the settled screen, held for a full second. ffmpeg's `fps` filter ("whatever was on screen at time *t*") is the correct primitive. With it, the current engine's fixed sampling grid would also become correct on variable-frame-rate input.
2. **Measure noise on unchanged content.** Variable-frame-rate files drop duplicate frames, so most consecutive pairs are genuine changes. A median-based noise estimate then comes out huge and swallows everything. A low percentile with a cap works.

**On the real recordings** (balanced preset, OCR off, contact sheets in `backend/experiments/out/`):

| recording | length | current engine | prototype |
|---|---|---|---|
| 03-24 10:48 | 23 s | 4 candidates, 14.0 s | 9 candidates, 1.9 s |
| 03-25 18:28 (HDR) | 25 s | **1** candidate, 45.3 s | 9 candidates, 4.6 s |
| 03-24 11:34 | 46 s | 2 candidates (one a mid-transition blend), 25.3 s | 8 candidates, 2.7 s |
| 03-24 09:34 | 68 s | 3 candidates, 58.2 s | 28 candidates, 6.9 s |

The current engine under-segments badly on real input. The prototype finds every state I could identify by eye (start screen, Control Centre, the sent prompt, the streamed answer, each scroll stop). In the 68 s recording, though, it also makes a step of about 19 pauses while the user types a long prompt. Neither behaviour is what a walkthrough wants. The missing concept in both engines is an **edit burst**: consecutive small changes confined to the same region (a text field plus the keyboard) should collapse into one step showing the finished input. That is a simple post-processing pass over stable intervals, and it should get its own switch ("group typing into one step", on by default).

### 5.4 Recommendation

- **Adopt B as the core of the next engine, and keep A's best parts as labels.** Scroll estimation (phase correlation), changed-region boxes and the modal and navigation heuristics are useful *descriptions* of a step. They should annotate stable intervals, not decide whether a step exists.
- **Use C only if B's simple run-length rule proves too brittle on the real benchmark.** It would be the natural next step and can reuse the same features.
- **Keep D optional and local.** It is useful for merging revisits ("same screen as step 3") and for captions. It should not be the detector: it costs a GPU or an external API, and results change with model versions, which matters for research that has to be reproducible.
- **Caveats on the prototype.** It has been tuned on nothing but these synthetic scenarios and four unlabelled recordings. A constantly moving pointer still needs the "desktop with pointer" setting (a coarser smallest-change area). Single typed characters sit right at the default smallest-change threshold. These numbers show the formulation is promising, not that it is finished.

## 6. Findings: running it as a shared server

The backend is built as a single-user desktop tool, and that is fine for that purpose. Exposed to a cohort, several things become serious. The first three were confirmed against a throwaway instance:

| issue | evidence | consequence on a shared server |
|---|---|---|
| `/assets` serves the whole data root | `GET /assets/stepthrough.sqlite3` returns the database (200, `SQLite format 3`) | anyone can download every project, every recording and the database |
| `POST /admin/reset-db` has no authentication | returns 204 and deletes all projects | any student can wipe the whole course |
| no users or ownership | `GET /projects` lists everyone's projects | no privacy between students; a GDPR problem if recordings show participants |
| CORS `allow_origins=["*"]` | any origin receives `access-control-allow-origin: *` | other sites can script the API from a logged-in browser |
| detection runs as an unbounded thread per run, in the API process | `JobManager.start` | 30 simultaneous runs saturate the machine; each OCR-enabled run loads its own PaddleOCR model |
| run progress lives in process memory | `JobManager._events` | lost on restart; cannot scale past one process |
| runs left `running` after a restart are never reconciled, and active runs cannot be deleted | `startup()`, `_run_is_deletable` | stuck runs after every deploy |
| no upload size limit, no quotas, no retention | `save_upload_file` | a few 4K recordings fill the disk; data outlives the course |
| browser preview plays the raw upload | `<video src=source_url>` | iPhone HEVC files do not play in every browser and operating system; students see a blank preview |
| started with `uvicorn --reload` and the Vite dev server | `start.sh` | not a production setup |

### 6.1 Target setup for a course instance

A conventional, boring stack that UvA or SURF system administrators will recognise:

```
             SURFconext / SRAM (OIDC)
                       |
   browser ── Caddy or nginx (TLS, upload limit, auth via oauth2-proxy)
                       |
          ┌────────────┴─────────────┐
     api (FastAPI, gunicorn+uvicorn)   static frontend (vite build)
          |            |
      PostgreSQL   job queue ── worker(s): ffmpeg + detection (+ OCR image variant)
          |                         |
          └──── shared volume: originals, preview proxies, frames, exports
```

- **Packaging.** One multi-stage `Dockerfile` (frontend build, then a Python image with ffmpeg), with a separate `-ocr` tag because PaddleOCR adds well over a gigabyte. A `compose.yaml` with `proxy`, `api`, `worker`, `db` and named volumes. Health and readiness endpoints already exist and can drive container health checks.
- **Authentication.** Let the proxy handle SURFconext or SRAM login (oauth2-proxy or `mod_auth_openidc`) and pass a verified user header. The app maps that to a user and a course, and checks ownership on every endpoint. Roles: student, instructor (sees the course), admin.
- **Private files.** Replace the open `StaticFiles` mount with an authenticated route that answers with `X-Accel-Redirect` (nginx) or streams the file, so images and videos are only served to their owners.
- **Jobs.** Move detection into a worker process with a bounded queue: one job per 2 to 4 cores, fair across users, cancellable, and reconciled on start-up. A Postgres-backed queue (for example Procrastinate) avoids adding Redis. Progress goes through the database, so the WebSocket endpoint works with several API processes.
- **Ingest.** Validate and normalise on upload: probe, reject unsupported files early, apply rotation, tone-map 10-bit HDR to 8-bit, and write an H.264 preview proxy for the browser. Keep the original for exports. Use resumable uploads (tus) for large files and enforce a per-user quota.
- **Data governance.** A retention policy per course (for example, delete 60 days after the course ends), export-then-delete for students, audit logging, and backups of the database and volume. If recordings can contain participants, a DPIA and hosting on UvA or SURF infrastructure rather than a commercial cloud.
- **Where to host.** A UvA ICTS virtual machine or SURF Research Cloud. Research Cloud can expose web applications behind SRAM authentication. I could not confirm from public documentation how it handles arbitrary Docker Compose stacks, so that needs checking with UvA research IT before committing.

### 6.2 Sizing

Measured here, without hardware decoding:

- **Current engine:** 0.6 to 1.8 times real time, using about 5 to 6 cores while it runs (most of the cost is a keyframe seek per sample, finding 3.7). The 25 s HDR recording took 45 s.
- **Prototype:** 0.06 to 0.18 times real time. It decodes once, sequentially, at 480 px.
- **H.264 preview proxy at 720p:** about 1 s for a 23 s recording.
- **Memory:** the process peaked at about 950 MB after running both engines on all four files. The prototype keeps every analysis frame in memory (about 100 KB each), so a production version should stream.

For a cohort of 40 students each submitting a few 2 to 5 minute recordings close to a deadline, a single VM with 16 vCPU, 32 GB RAM and 500 GB of storage, running 4 concurrent jobs, should keep queue times to minutes with a streaming stable-interval engine. With the current engine it would be closer to an hour at peak. I did not measure OCR memory. Today each OCR-enabled run loads its own PaddleOCR models, so a shared OCR worker process would be the first thing to add. These are estimates from the measurements above and must be confirmed by the load test in phase 2 (step 11). A Linux server without a hardware HEVC decoder will be slower than this Mac.

## 7. Roadmap

### Phase 0: before any student touches it (must-do; done except authentication, see the update in section 1)

1. **Timestamps.** Decode with real presentation timestamps (an ffmpeg pipe with the `fps` filter, or PyAV) and export the screenshot from the same decoded frame, or at least the same timestamp. This removes finding 3.1 for both engines. As a stop-gap, normalising uploads to constant frame rate at ingest (`-fps_mode cfr`) also removes the drift.
2. **Ingest normalisation.** Tone-map HDR to SDR, apply rotation, and write an H.264 preview proxy (findings 3.2 and section 6). Analyse and export from the normalised file.
3. **Close the server holes in section 6.** Authentication, private file serving, no public admin endpoints, restricted CORS, upload limits.
4. **Make the evaluation suite honest.** Add compressed and variable-frame-rate encodings, phone resolutions, persistent animation overlays and the screenshot-correctness check to CI (the harness in `backend/experiments/stress.py` is a starting point).

### Phase 1: detection core (done as engine `stable_v3`, see the update in section 1; hybrid v2's tile threshold in item 6 left as is)

5. Rebuild the core as stable-interval detection (section 5), keeping the current scroll, modal and navigation logic as *labels* on intervals rather than as gates.
6. Collapse edit bursts (typing) into one step; fix the self-normalising tile threshold and measure noise on unchanged content.
7. Add the opening screen as step 0 (on by default).
8. Mask persistent animation automatically; add drawn ignore areas and a recording-type preset (phone, desktop with pointer).
9. Replace the six unitless thresholds with the controls in section 4; store the resolved settings and engine version with every run.

### Phase 2: hosting

10. Worker queue, PostgreSQL, ingest normalisation and preview proxies, Docker images, Compose file, SURFconext login, retention.
11. Load test with a realistic course batch (for example 40 recordings of 2 to 5 minutes submitted within an hour).

### Phase 3: research-grade quality

12. **A labelled benchmark from real recordings.** Collect 30 to 50 consented recordings across phone, desktop and prototype tools; two annotators mark the settled states. Report per-engine state recall, duplicate rate and transient rate (mid-animation screenshots), with inter-annotator agreement.
13. **Learn from use.** The review interface already records accepts, rejects and manual additions: these are free labels for misses and false positives. With consent, aggregate them per engine version to tune defaults.
14. **Optional semantic layer.** OCR or local image embeddings for revisit grouping and "same screen" merging; a local vision-language model for step captions, kept on-premises.

## 8. Reproducing these numbers

From `backend/`:

```bash
# real-recording timestamp drift
uv run python experiments/vfr_drift.py ../data/projects/*/recordings/*/source/*.mp4
# stable_v3 through the real pipeline (working copy), 25 scenarios
uv run python -m tests.eval.stress --set all
# stable_v3 on real recordings, with labelled contact sheets; CACHE keeps the working copies
uv run python experiments/real_stable.py experiments/out CACHE ../data/projects/*/recordings/*/source/*.mp4

# The hybrid v2 and prototype numbers (experiments/stress.py, real_compare.py, tests.eval.stress --engine
# hybrid_v2, real_stable.py --hybrid) need a checkout of the tag last-with-hybrid-v2.
```

## References

- Feng, S. and Chen, C. (2022). GIFdroid: An Automated Light-weight Tool for Replaying Visual Bug Reports. ICSE 2022 Companion, pp. 95 to 99. https://arxiv.org/abs/2112.04128
- Feng, S., Xie, M., Xue, Y. and Chen, C. (2023). Read It, Don't Watch It: Captioning Bug Recordings Automatically. ICSE 2023, pp. 2349 to 2361. https://arxiv.org/abs/2302.00886
