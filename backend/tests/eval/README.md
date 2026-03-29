# Hybrid v2 Detection Engine — Eval Pipeline

Synthetic video generator and evaluation framework for measuring the accuracy
of the hybrid v2 scene detection engine.

## Quick start

```bash
cd backend

# Run all scenarios and save results
python -m tests.eval.runner

# Run with detailed per-candidate output
python -m tests.eval.runner --debug

# Compare against previous run
python -m tests.eval.runner --compare

# Run as pytest
pytest tests/eval/ -v

# Run the curated realistic smoke matrix
python -m tests.eval.runner --matrix realistic-smoke

# Run one high-resolution fullscreen realistic variant
python -m tests.eval.runner --matrix realistic-full --profile fullscreen_vertical --resolution-tier 1080x1920 --source-fps 60 --sample-fps 12 --scenario feed_fullscreen_swipe
```

## Architecture

```
tests/eval/
├── README.md            ← this file
├── __init__.py
├── types.py             ← GroundTruthEvent, ScenarioResult, EvalMetrics
├── rendering.py         ← UI rendering toolkit (widgets, layouts, transitions)
├── scenarios.py         ← scenario generators organized by category
├── evaluator.py         ← matching algorithm, metrics, breakdowns, debug reports
├── runner.py            ← standalone CLI runner + JSON output
├── test_eval_suite.py   ← pytest integration
└── results/             ← timestamped JSON results (gitignored except .gitkeep)
```

### Data flow

```
Scenario generator       →  ScenarioResult (video_path + ground_truth)
                                ↓
detect_candidates_hybrid  →  list[candidate dicts]
                                ↓
evaluator.evaluate        →  EvalMetrics (precision, recall, F1, timing error)
                                ↓
runner / pytest           →  summary table + JSON results file
```

## Modules

### `types.py`

Core data types shared across the pipeline.

| Type | Purpose |
|------|---------|
| `GroundTruthEvent` | A known event: type, start/end ms, difficulty, metadata |
| `ScenarioResult` | Video path + ground truth + metadata |
| `EventMatchResult` | Per-event match detail |
| `EvalMetrics` | Aggregate precision/recall/F1/timing |
| `Difficulty` | `"easy"` \| `"medium"` \| `"hard"` |
| `Category` | `"navigation"` \| `"scrolling"` \| `"feed"` \| `"overlay"` \| `"content"` \| `"composite"` |

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

### `runner.py`

CLI runner with options:

```
--matrix NAME         Scenario matrix: baseline, realistic-smoke, realistic-full
--scenario NAME       Filter scenarios by name substring
--category CAT        Filter by category prefix
--profile PROFILE     Filter realistic matrices by device profile
--resolution-tier T   Filter realistic matrices by encoded resolution tier
--preset PRESET       Analysis preset: subtle_ui, balanced, noise_resistant
--ocr                 Enable OCR during detection
--debug               Print per-candidate debug detail
--compare             Compare the two most recent saved runs
--no-save             Don't save results to disk
--source-fps FPS      Override source FPS used to render scenarios
--sample-fps FPS      Override detector sampling FPS for eval runs
--fps FPS             Backward-compatible alias for --source-fps
```

### Realistic variant matrices

The realistic matrices add device-aware rendering and detector sampling
metadata on top of the baseline suite.

Profiles:

| Profile | Shell | Logical size | Resolution tiers |
|---------|-------|--------------|------------------|
| `phone_portrait` | `mobile_app` | `390x844` | `390x844`, `780x1688` |
| `laptop_landscape` | `desktop_browser` | `1280x800` | `1280x800` |
| `fullscreen_vertical` | `fullscreen` | `540x960` | `540x960`, `1080x1920` |
| `fullscreen_horizontal` | `fullscreen` | `960x540` | `960x540`, `1920x1080` |

Variant names use:

```text
base__profile__resolution__src{fps}__sample{fps}
```

This keeps existing `nav` / `scroll` / `feed` prefix filtering working.

Results are saved to `tests/eval/results/eval_YYYYMMDD_HHMMSS.json`.

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

3. Run `python -m tests.eval.runner --scenario my_scenario --debug` to verify.

## Interpreting results

- **PASS** = recall >= 50% (soft threshold, will tighten as engine improves)
- **FAIL** = recall < 50%
- **FP** (false positive) = candidate not matched to any ground truth event
- **miss** = ground truth event with no matching candidate
- **err** = mean timing error in ms

The difficulty breakdown shows detection rate by difficulty level — expect
easy events to be detected first, hard events to improve as the engine
evolves.

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
