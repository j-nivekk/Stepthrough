# Hybrid v2 Engine — Efficiency & Accuracy Improvement Plan

**Project:** Stepthrough
**Date:** March 2026
**Version:** 1.0

---

## 1. Executive Summary

This work plan details eight targeted improvements to the Hybrid v2 detection engine in Stepthrough. The proposals address two core objectives: reducing per-frame processing cost (efficiency) and improving detection sensitivity for edge cases that the current implementation handles poorly (accuracy). Each change is scoped as an independent, backwards-compatible increment that can be developed, tested, and shipped in isolation.

The engine currently combines four signal components (structural loss, tile change ratio, changed region detection, and edge differencing) with optional OCR confirmation and an event-window state machine. The improvements below refine each layer without altering the public API contract defined in `models.py` or the candidate output schema consumed by the frontend.

---

## 2. Scope and Assumptions

### 2.1 Scope

All changes are confined to the backend detection pipeline. The primary file under modification is `hybrid_detection.py`, with supporting changes to `models.py` (new optional fields on `HybridAdvancedSettings`), `similarity.py` (deduplication utilities), and `test_hybrid_detection.py` (expanded test coverage). Frontend changes are limited to exposing any new advanced settings through the existing `AnalysisParametersPanel` component.

### 2.2 Assumptions

- **Python 3.11+:** The codebase already uses `from __future__ import annotations` and modern typing; all new code continues this convention.
- **OpenCV 4.x:** `cv2` is the sole image processing backend. No additional native dependencies are introduced except where noted.
- **PaddleOCR optional:** OCR remains opt-in. All improvements degrade gracefully when PaddleOCR is not installed.
- **Backwards compatibility:** Existing preset defaults, threshold values, and the candidate output schema remain unchanged. New behaviour is additive and gated behind configuration.
- **Test-driven:** Each change includes unit tests against synthetic frame sequences. The existing `conftest` `video_factory` fixture is extended where needed.
- **No GPU requirement:** All compute remains CPU-bound. NumPy vectorisation is preferred over GPU-dependent paths.

---

## 3. Change Register

| ID | Change | Category | Effort | Priority |
|---|---|---|---|---|
| WP-01 | Windowed (patch-based) SSIM | Accuracy | Medium | High |
| WP-02 | Finer tile grid with adaptive threshold | Accuracy | Low | Medium |
| WP-03 | OCR region cropping and result caching | Efficiency | Medium | High |
| WP-04 | Sequential frame decoding | Efficiency | Low | High |
| WP-05 | Adaptive signal weighting (calibration pass) | Accuracy | High | Medium |
| WP-06 | Compound-transition merge post-processing | Accuracy | Medium | Medium |
| WP-07 | In-scan perceptual deduplication | Efficiency | Low | Medium |
| WP-08 | Adaptive contour threshold for dark themes | Accuracy | Low | Low |

---

## 4. Detailed Work Packages

### 4.1 WP-01: Windowed (Patch-Based) SSIM

#### 4.1.1 Problem Statement

The current `_structural_loss` function computes a single global SSIM score across the entire grayscale frame. When a small but meaningful UI change occurs (a toast notification, a status badge, a toggle switch), the unchanged majority of the frame dominates the calculation, suppressing the loss value. This causes the engine to miss subtle but important transitions, particularly on the `subtle_ui` preset.

#### 4.1.2 Proposed Change

Replace the global SSIM with a patch-based approach. Divide both the previous and current grayscale frames into non-overlapping patches (default 64×64 pixels, configurable). Compute SSIM independently for each patch. Report the structural loss as the mean of the top-k worst patches (e.g., top 10% by loss), rather than the global mean. This ensures localised changes contribute proportionally to the final score.

#### 4.1.3 Code Changes

- **`hybrid_detection.py` — `_structural_loss`:** Refactor to accept a `patch_size` parameter (default 64). Iterate over the frame in non-overlapping tiles, compute per-patch SSIM, collect losses into a list, sort descending, and return the mean of the top 10%. Fall back to global SSIM if the frame is smaller than 2×2 patches.
- **`hybrid_detection.py` — `HybridDetectorConfig`:** Add optional `ssim_patch_size: int = 64` field.
- **`models.py` — `HybridAdvancedSettings`:** No change required initially; patch size can be exposed later if power users need it.
- **`test_hybrid_detection.py`:** Add `test_windowed_ssim_detects_small_region_change` using a synthetic 640×360 frame with a 40×40 pixel change. Assert that the windowed approach produces a higher loss than the global approach for the same input.

#### 4.1.4 Assumptions and Risks

- A 64×64 patch is fine-grained enough for typical 960px-wide analysis frames (yields ~15×6 = 90 patches).
- Top-10% aggregation avoids inflating scores from compression noise while still surfacing localised changes.
- Performance impact is marginal: the per-patch SSIM loop is NumPy-vectorisable and operates on the already-resized analysis frame.

#### 4.1.5 Expected Outcome

- The `subtle_ui` preset detects small badge/indicator changes that currently fall below `proposal_threshold`.
- No increase in false positives on the `balanced` and `noise_resistant` presets, because the top-k aggregation filters out sensor-noise patches.
- Global SSIM behaviour is preserved as a fallback for very small frames.

---

### 4.2 WP-02: Finer Tile Grid with Adaptive Threshold

#### 4.2.1 Problem Statement

The `_tile_change_ratio` function uses a fixed 4×4 grid (16 tiles), each covering approximately 6.25% of the frame. A subtle change confined to a small region may not push any single tile's mean pixel difference above the hardcoded 0.08 threshold. Additionally, the threshold is static and does not account for per-tile variance, meaning noisy tiles are treated identically to stable ones.

#### 4.2.2 Proposed Change

Increase the default grid to 8×8 (64 tiles, each covering ~1.5% of the frame). Replace the static 0.08 threshold with an adaptive threshold per tile: a tile is marked as changed if its mean difference exceeds `max(0.04, 2.5 × baseline_std)`, where `baseline_std` is the standard deviation of pixel differences across the entire frame. The grid size becomes a configurable parameter on `HybridDetectorConfig`.

#### 4.2.3 Code Changes

- **`hybrid_detection.py` — `_tile_change_ratio`:** Accept `tile_size` parameter (default 8 instead of 4). Compute the global standard deviation of the difference frame. Apply per-tile adaptive threshold: `max(0.04, 2.5 * global_std)`.
- **`hybrid_detection.py` — `HybridDetectorConfig`:** Add `tile_grid_size: int = 8`.
- **`test_hybrid_detection.py`:** Add test verifying that a 32×32 pixel change in a 640×360 frame registers as changed on the 8×8 grid but is missed on the 4×4 grid.

#### 4.2.4 Expected Outcome

- Improved sensitivity to small, localised changes without raising the false positive rate, because the adaptive threshold adjusts for frame-level noise.
- Negligible performance cost: the operation is a slice-and-mean over 64 tiles.

---

### 4.3 WP-03: OCR Region Cropping and Result Caching

#### 4.3.1 Problem Statement

PaddleOCR is the most expensive operation in the pipeline. Currently it runs on the entire analysis frame for every frame that crosses the `ocr_trigger_threshold`. This is wasteful in two ways: (a) it processes unchanged text regions, diluting results and slowing inference, and (b) it re-processes frames that are nearly identical to recently OCR'd frames.

#### 4.3.2 Proposed Change

Introduce two optimisations. First, crop the OCR input to the bounding boxes identified by `_changed_regions`, with a configurable padding margin (default 20px). PaddleOCR runs only on these crops, which are typically 5–20% of the full frame area. Second, maintain an LRU cache keyed by perceptual hash of the analysis frame. If the current frame's perceptual hash has a Hamming distance of 3 or less from a cached entry, reuse the cached OCR text without re-running inference.

#### 4.3.3 Code Changes

- **`hybrid_detection.py` — `_extract_ocr_text`:** Accept the `changed_regions` list. If regions are available, crop and concatenate OCR results from each region. If no regions are provided, fall back to full-frame OCR.
- **`hybrid_detection.py` — New `_OcrCache` class:** Implement a simple LRU cache (capacity 32) keyed on the 64-bit perceptual hash of each frame. The cache stores the extracted text string. Lookup uses Hamming distance ≤ 3 as a match.
- **`hybrid_detection.py` — `_build_signal`:** Pass `changed_regions` to `_extract_ocr_text`. Integrate cache lookup before invoking the OCR engine.
- **`similarity.py`:** Extract the perceptual hash helper into a standalone utility so `hybrid_detection` can import it for cache keying.
- **`test_hybrid_detection.py`:** Add tests for cache hit/miss behaviour and for region-cropped OCR producing equivalent results to full-frame OCR on synthetic text frames.

#### 4.3.4 Assumptions and Risks

- PaddleOCR accuracy on cropped regions is equal to or better than full-frame accuracy, because the text-to-background ratio improves.
- Perceptual hash collisions within Hamming distance 3 are rare enough that stale cache hits do not meaningfully degrade text score accuracy.
- The LRU cache memory footprint is negligible (32 entries × short strings).

#### 4.3.5 Expected Outcome

- OCR inference time per frame reduced by 60–80% on typical UI recordings with localised text changes.
- Cache hit rate of 30–50% during settle windows where consecutive frames are nearly identical.
- No change to text score accuracy; validated by comparative test on reference video set.

---

### 4.4 WP-04: Sequential Frame Decoding

#### 4.4.1 Problem Statement

The `_read_frame` function calls `capture.set(cv2.CAP_PROP_POS_MSEC, ...)` for every frame, even though `_sample_timestamps` generates a monotonically increasing sequence. Random seeking on compressed video (H.264, H.265) is expensive because the decoder must locate and decode from the nearest keyframe. For a 60-second video sampled at 6 FPS, this means 360 seek operations instead of sequential decoding.

#### 4.4.2 Proposed Change

Replace the seek-per-frame approach with sequential reading. Read frames in order using `capture.read()`, skipping unwanted frames by counting. Only seek when the gap between the current position and the target exceeds a configurable threshold (default: 5 frames), which handles edge cases like very low sample FPS on high-FPS source video. Track the decoder's current position in milliseconds to decide between sequential read and seek.

#### 4.4.3 Code Changes

- **`hybrid_detection.py` — `_read_frame`:** Rename to `_seek_frame` and keep as fallback. Introduce a new `_SequentialReader` class wrapping `cv2.VideoCapture` that tracks current position, decides between `grab()` (skip) and `read()` (decode), and falls back to seeking when the gap is large.
- **`hybrid_detection.py` — `detect_candidates_hybrid`:** Replace the per-frame `_read_frame` call with `_SequentialReader.next(timestamp_ms)`.
- **`test_hybrid_detection.py`:** Add test that the sequential reader produces identical frames to the seek-based reader on a reference video.

#### 4.4.4 Expected Outcome

- 30–50% reduction in scan-phase wall-clock time for H.264/H.265 recordings.
- Negligible improvement for MJPEG or very short recordings, but no regression.
- Frame content is byte-identical to the seek-based approach.

---

### 4.5 WP-05: Adaptive Signal Weighting (Calibration Pass)

#### 4.5.1 Problem Statement

The combined score formula (`visual × 0.60 + motion × 0.25 + text × 0.15`) is static across all content types. A text-editor screencast benefits from heavier text weighting; a design-tool walkthrough benefits from heavier visual weighting. The current fixed ratio forces the `balanced` preset to be a compromise that is suboptimal for both extremes.

#### 4.5.2 Proposed Change

Add an optional calibration pass that samples a short prefix of the video (first 3–5 seconds, configurable) to characterise the content. During calibration, measure the variance of each signal channel (visual, motion, text). If one channel has very low variance (near-zero), reduce its weight and redistribute to the remaining channels. If OCR is disabled, text weight is zero and redistributed proportionally. Expose a new `enable_auto_weights: bool = False` field on `HybridAdvancedSettings`. When enabled, the calibration pass runs before the main scan and adjusts the weights stored on the config object. When disabled (the default), the current static weights are used, preserving backwards compatibility.

#### 4.5.3 Code Changes

- **`hybrid_detection.py` — New `_calibrate_weights` function:** Accepts a list of `CandidateSignal` samples from the calibration window. Computes variance of visual, motion, and text arrays. Applies a softmax-like normalisation to produce final weights summing to 1.0, with a floor of 0.05 per channel to prevent any signal from being completely zeroed.
- **`hybrid_detection.py` — `HybridDetectorConfig`:** Add `visual_weight`, `motion_weight`, `text_weight` fields with current defaults.
- **`hybrid_detection.py` — `_build_signal`:** Read weights from config instead of hardcoded constants.
- **`hybrid_detection.py` — `detect_candidates_hybrid`:** If `enable_auto_weights`, run calibration on the first N samples, call `_calibrate_weights`, and update config.
- **`models.py` — `HybridAdvancedSettings`:** Add `enable_auto_weights: bool = False`.
- **Frontend — `AnalysisParametersPanel.tsx`:** Add a toggle for auto-weighting in the advanced settings panel, with a tooltip explaining when to use it.
- **`test_hybrid_detection.py`:** Add tests for calibration on synthetic text-heavy and visual-heavy sequences, asserting that weights shift appropriately.

#### 4.5.4 Assumptions and Risks

- The first 3–5 seconds of a recording are representative of its overall content type. This may not hold for recordings that start with a splash screen or loading animation.
- The feature is opt-in (default off), so risk to existing users is zero.
- A minimum weight floor of 0.05 prevents degenerate configurations where a signal is entirely ignored.

#### 4.5.5 Expected Outcome

- Text-heavy recordings see 15–25% improvement in detection of meaningful text changes.
- Visual-heavy recordings see reduced false positives from text noise.
- No impact on existing users until explicitly enabled.

---

### 4.6 WP-06: Compound-Transition Merge Post-Processing

#### 4.6.1 Problem Statement

When a UI goes through a rapid multi-step transition (e.g., a modal opens and then its content loads, or a page navigates and then renders), the settle window may close between the two steps. This splits what is conceptually one event into two separate candidates, or worse, captures the intermediate (incomplete) state as the representative frame.

#### 4.6.2 Proposed Change

Add a post-processing merge step after all events are finalised. For each pair of consecutive events where the temporal gap is less than a configurable `merge_gap_ms` (default: 500ms), compare the representative frames using `blended_distance` from `similarity.py`. If the distance is above 0.20 (indicating the two events captured genuinely different states), keep both. If the distance is below 0.20 (indicating the second event is a continuation of the first), merge them: keep the strongest `score_breakdown` from either event but use the later event's representative frame (since it is more likely to show the final settled state).

#### 4.6.3 Code Changes

- **`hybrid_detection.py` — New `_merge_compound_events` function:** Accepts the list of finalised event dicts and `merge_gap_ms`. Iterates pairwise, applies the merge logic, returns the reduced list.
- **`hybrid_detection.py` — `detect_candidates_hybrid`:** Call `_merge_compound_events` after the event finalisation loop and before screenshot extraction.
- **`hybrid_detection.py` — `HybridDetectorConfig`:** Add `merge_gap_ms: int = 500`.
- **`test_hybrid_detection.py`:** Add test with a synthetic three-state video (black → gray → white at 200ms intervals), asserting that at tight timing the gray intermediate is merged into the white final state.

#### 4.6.4 Expected Outcome

- Reduction of 10–20% in redundant candidates on recordings with rapid multi-step transitions.
- Representative frames are more likely to capture the fully settled (final) UI state.
- No change to detection of well-separated events.

---

### 4.7 WP-07: In-Scan Perceptual Deduplication

#### 4.7.1 Problem Statement

When a user navigates back and forth between the same screens (e.g., toggling between two tabs), the engine produces near-duplicate candidates. The existing `annotate_candidate_similarity` function in `similarity.py` flags these with `revisit_group_id`, but only after all candidates are extracted and fingerprinted. This wastes time extracting screenshots that will ultimately be marked as duplicates.

#### 4.7.2 Proposed Change

During the scan phase, maintain a rolling buffer of perceptual fingerprints from recently emitted events. Before finalising a new event, compute a lightweight perceptual hash of its representative frame and compare against the buffer. If the Hamming distance to any buffered entry is below a suppression threshold (default: 6 bits out of 64), suppress the event entirely rather than emitting it as a candidate. The buffer size is capped at 20 entries.

#### 4.7.3 Code Changes

- **`hybrid_detection.py` — New `_DeduplicationBuffer` class:** Maintains a list of `(perceptual_hash, timestamp_ms)` tuples, capped at 20 entries. Provides a `should_suppress(frame)` method that computes the perceptual hash of the candidate's representative frame and checks Hamming distance against all buffered hashes.
- **`hybrid_detection.py` — `detect_candidates_hybrid`:** After `_finalize_event` returns a non-None result, check `should_suppress` before appending to `detected_events`. If not suppressed, add the hash to the buffer.
- **`similarity.py`:** Extract the `_perceptual_hash` function (currently on `ImageFingerprint` via PIL) into a lightweight variant that operates on a NumPy grayscale array, avoiding the PIL dependency in the scan loop.
- **`test_hybrid_detection.py`:** Add test with a synthetic A→B→A→B video, asserting that the second A and second B are suppressed.

#### 4.7.4 Expected Outcome

- 15–30% reduction in candidate count on recordings with repetitive navigation patterns.
- Proportional reduction in screenshot extraction and fingerprinting time.
- No impact on recordings with all-unique screens.

---

### 4.8 WP-08: Adaptive Contour Threshold for Dark Themes

#### 4.8.1 Problem Statement

The `_changed_regions` function uses a fixed binary threshold of 18 on the pixel difference frame. Dark-themed UIs with subtle colour shifts (e.g., a button going from `#333333` to `#444444`, a difference of 17 in each channel) fall just below this threshold and are invisible to the contour detector. This causes the engine to miss hover states, selection changes, and active/inactive indicators in dark mode applications.

#### 4.8.2 Proposed Change

Replace the fixed threshold of 18 with an adaptive approach using Otsu's method on the difference image. `cv2.threshold` with `cv2.THRESH_OTSU` automatically selects the optimal threshold that separates the changed from unchanged pixels, based on the actual distribution of pixel differences in each frame pair. Add a floor of 8 and a ceiling of 30 to prevent degenerate thresholds on uniform or extremely noisy frames. Additionally, expose a `contour_threshold_override: int | None = None` on `HybridAdvancedSettings` for users who need manual control.

#### 4.8.3 Code Changes

- **`hybrid_detection.py` — `_changed_regions`:** Replace `cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)` with `cv2.threshold(diff, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)`. Clamp the Otsu-selected threshold between 8 and 30. If a `contour_threshold_override` is present in config, use that value instead.
- **`hybrid_detection.py` — `HybridDetectorConfig`:** Add `contour_threshold_override: int | None = None`.
- **`models.py` — `HybridAdvancedSettings`:** Add `contour_threshold_override: int | None = Field(default=None, ge=4, le=60)`.
- **`test_hybrid_detection.py`:** Add test with two dark frames differing by 15 intensity units in a 100×100 region. Assert that the adaptive threshold detects the region while the fixed threshold of 18 would not.

#### 4.8.4 Expected Outcome

- Improved detection of UI changes in dark-themed applications, where pixel differences are typically in the 8–20 range.
- No regression on light-themed content, where Otsu's method selects a threshold similar to or higher than 18.
- Manual override provides an escape hatch for unusual content types.

---

## 5. Implementation Priority and Sequencing

The work packages are independent and can be implemented in any order. However, the following sequence maximises value delivery and minimises integration risk.

### 5.1 Phase 1: Quick Wins (Weeks 1–2)

These changes are low-effort, high-confidence, and immediately testable.

| Order | Work Package | Rationale |
|---|---|---|
| 1 | WP-04: Sequential Decoding | Pure performance gain with no behavioural change. Simplest to validate (byte-identical output). |
| 2 | WP-02: Finer Tile Grid | Small code change with clear accuracy benefit. Easy to A/B test on existing recordings. |
| 3 | WP-08: Adaptive Contour Threshold | Single-function change. Otsu's method is well-understood and deterministic. |

### 5.2 Phase 2: Core Accuracy Improvements (Weeks 3–4)

| Order | Work Package | Rationale |
|---|---|---|
| 4 | WP-01: Windowed SSIM | Largest single accuracy improvement. Requires careful threshold tuning on the preset defaults. |
| 5 | WP-06: Compound-Transition Merge | Depends on accurate detection from WP-01 and WP-02 to produce clean merge decisions. |

### 5.3 Phase 3: Efficiency and Polish (Weeks 5–6)

| Order | Work Package | Rationale |
|---|---|---|
| 6 | WP-03: OCR Caching and Cropping | Depends on `_changed_regions` improvements from WP-08. Largest efficiency gain for OCR-enabled runs. |
| 7 | WP-07: In-Scan Deduplication | Benefits from all prior accuracy improvements to produce cleaner dedup decisions. |
| 8 | WP-05: Adaptive Weighting | Most complex change. Best implemented last when all signal channels are at their most accurate. |

---

## 6. Testing Strategy

### 6.1 Unit Tests

Each work package includes dedicated unit tests in `test_hybrid_detection.py`. Tests use synthetic NumPy frames generated in-memory (no external video files) to ensure deterministic, fast execution. The existing `video_factory` fixture is extended with new helpers for generating multi-state sequences with controlled timing.

### 6.2 Regression Tests

A reference set of 5–10 real-world recordings (UI walkthroughs, dark-theme apps, text-heavy editors, rapid-navigation sessions) is run through the engine before and after each change. The output candidate lists are compared on three metrics: candidate count, mean scene score, and revisit group assignment. Any regression beyond a 5% tolerance triggers investigation.

### 6.3 Performance Benchmarks

Wall-clock time for the scan phase is measured on a standardised 120-second, 30 FPS, 1920×1080 recording on a reference machine. The benchmark is run before and after WP-03 and WP-04 to validate the expected efficiency gains. Results are logged to a `benchmark.json` file for historical comparison.

---

## 7. Key Outcomes and Behaviours

| Outcome | Metric | Expected Change |
|---|---|---|
| Subtle change detection | Candidates detected on `subtle_ui` preset | +20–35% on dark-theme and small-change recordings |
| False positive rate | Manual rejections per run | No increase (validated by regression suite) |
| Scan-phase speed | Wall-clock time for 120s/30fps recording | 30–50% faster (WP-04 + WP-03 combined) |
| OCR throughput | OCR invocations per run | 40–60% fewer (WP-03 caching + cropping) |
| Duplicate candidates | Candidates flagged as revisit | 15–30% fewer emitted (WP-07 pre-filtering) |
| Compound transition handling | Split events on rapid transitions | 10–20% reduction in fragmented events (WP-06) |
| Dark theme accuracy | Missed events on dark-themed recordings | Near-zero with adaptive threshold (WP-08) |
| Content-adaptive scoring | Detection accuracy on text-heavy content | 15–25% improvement when auto-weights enabled (WP-05) |

All changes preserve the existing candidate output schema, preset defaults, and public API surface. No frontend changes are required except the optional exposure of new advanced settings fields (WP-05 auto-weighting toggle, WP-08 contour threshold override). The engine remains fully functional without PaddleOCR installed.
