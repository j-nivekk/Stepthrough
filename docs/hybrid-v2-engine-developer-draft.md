# Hybrid v2 Engine in Stepthrough (Developer Draft)

## Scope

This draft documents the hybrid v2 engine as it is currently implemented in the app, not as older manuals describe it and not as future work plans propose it.

If this document and older user docs disagree, treat the backend implementation as the source of truth:

- `backend/app/analysis_metadata.py`
- `backend/app/services/hybrid_detection.py`
- `backend/app/main.py`
- `backend/app/models.py`
- `backend/app/repository.py`
- `backend/tests/test_hybrid_detection.py`

## Where hybrid v2 lives in the app

### Core implementation

- `backend/app/analysis_metadata.py`
  Defines the backend-owned hybrid preset registry, control applicability metadata, and manual-section renderer.
- `backend/app/services/hybrid_detection.py:39-1491`
  Defines config resolution, feature extraction, OCR integration, event assembly, screenshot extraction, and candidate post-processing.

### App integration

- `backend/app/models.py:62-95`
  Defines `HybridAdvancedSettings` and `RunSettings`.
- `backend/app/main.py:187-203`
  Disables OCR in incoming hybrid settings when the backend health state says OCR is unavailable.
- `backend/app/main.py`
  Exposes `GET /analysis/metadata` so the frontend can render preset baselines from the backend-owned registry.
- `backend/app/main.py:465-517`
  Selects `detect_candidates_hybrid`, resolves and persists `analysis_config`, and runs the job.
- `backend/app/repository.py:217-255`
  Persists the run payload, including hybrid-specific fields and shared legacy fields.
- `backend/app/repository.py:306-338`
  Persists emitted candidates, including `score_breakdown`.

### Frontend integration

- `frontend/src/lib/runSettings.ts:4-34`
  Default run settings and frontend preset labels/baselines.
- `frontend/src/features/analysis/components/AnalysisParametersPanel.tsx:347-620`
  Hybrid preset and advanced controls.
- `frontend/src/components/CandidateCard.tsx:14-272`
  Displays the hybrid score breakdown in review.

### Validation and eval

- `backend/tests/test_hybrid_detection.py`
  Unit coverage for config resolution, feature detection, OCR probing, gap merge behavior, and score breakdowns.
- `backend/tests/eval/README.md`
  Synthetic eval harness for hybrid v2.

## High-level app flow

1. The frontend defaults new runs to `analysis_engine='hybrid_v2'` and `analysis_preset='balanced'` in `frontend/src/lib/runSettings.ts:4-14`.
2. The shared `RunSettings` schema is sent to `POST /recordings/{recording_id}/runs` and validated in `backend/app/main.py:731-742`.
3. Before the run is created, `_lock_unavailable_ocr()` can coerce `advanced.enable_ocr=false` and `ocr_backend=None` if OCR health is unavailable (`backend/app/main.py:187-203`, `backend/app/main.py:572-585`).
4. The job runner resolves a concrete `HybridDetectorConfig` with `resolve_hybrid_config()` and stores it as JSON in `detection_runs.analysis_config` (`backend/app/main.py:500-503`).
5. `detect_candidates_hybrid()` scans the video, groups sample-to-sample changes into event windows, extracts representative screenshots, fingerprints them, and annotates similarity (`backend/app/services/hybrid_detection.py:1277-1491`).
6. The backend persists `score_breakdown` alongside each candidate, and the review UI surfaces `visual`, `text`, `motion`, `transition_type`, scroll metrics, chrome/content change, and dwell metadata (`backend/app/models.py:155-170`, `frontend/src/components/CandidateCard.tsx:211-272`).

## Which run settings hybrid v2 actually uses

The app shares one `RunSettings` payload across `scene_v1` and `hybrid_v2`, but hybrid does not consume every field.

| Setting | Used by hybrid v2? | Where | Notes |
| --- | --- | --- | --- |
| `analysis_engine` | Yes | `backend/app/main.py:482-483` | Chooses the hybrid code path. |
| `analysis_preset` | Yes | `backend/app/services/hybrid_detection.py:532-560` | Selects preset defaults and thresholds. |
| `advanced.sample_fps_override` | Yes | `backend/app/services/hybrid_detection.py:535-536` | Clamped to source FPS. |
| `advanced.min_dwell_ms` | Yes | `backend/app/services/hybrid_detection.py:537` | Overrides preset dwell. |
| `advanced.settle_window_ms` | Yes | `backend/app/services/hybrid_detection.py:538-542` | Overrides preset settle window. |
| `advanced.proposal_threshold` | Yes | `backend/app/services/hybrid_detection.py:543-547` | Overrides the preset threshold for opening an event window. |
| `advanced.settle_threshold` | Yes | `backend/app/services/hybrid_detection.py:548-552` | Overrides the preset threshold for keeping an event active. |
| `advanced.ocr_trigger_threshold` | Yes | `backend/app/services/hybrid_detection.py:553-557` | Overrides the preset threshold for OCR escalation. |
| `advanced.enable_ocr` | Yes | `backend/app/services/hybrid_detection.py:543` | Enables or disables OCR probing. |
| `advanced.ocr_backend` | Yes | `backend/app/services/hybrid_detection.py:544`, `843-865` | Only `paddleocr` is currently supported. |
| `min_scene_gap_ms` | Yes | `backend/app/services/hybrid_detection.py:549`, `1017-1036`, `1376`, `1395` | Applied after event finalization by merge-or-replace logic. |
| `tolerance` | No | N/A | Shared v1 field; hybrid ignores it. |
| `sample_fps` | No | N/A | Shared v1 field; hybrid uses preset sample FPS or `advanced.sample_fps_override`. |
| `allow_high_fps_sampling` | No | N/A | Shared v1 guardrail; hybrid does not consult it. |
| `detector_mode` | No | N/A | Shared v1 detector selector; hybrid ignores it. |
| `extract_offset_ms` | No in current hybrid implementation | N/A | Persisted and shown in UI, but `detect_candidates_hybrid()` extracts at the representative event timestamp without applying an offset. |

## Current preset baselines

These are the actual backend-owned defaults from `backend/app/analysis_metadata.py`, which `resolve_hybrid_config()` consumes.

| Preset | `sample_fps` | `min_dwell_ms` | `settle_window_ms` | `proposal_threshold` | `settle_threshold` | `ocr_trigger_threshold` | Intended effect |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `subtle_ui` | 8 | 250 | 250 | 0.19 | 0.09 | 0.13 | More sensitive to small and brief UI changes. |
| `balanced` | 6 | 350 | 350 | 0.20 | 0.10 | 0.15 | Default compromise between sensitivity and noise resistance. |
| `noise_resistant` | 4 | 700 | 700 | 0.31 | 0.16 | 0.22 | Fewer candidates on noisy or motion-heavy recordings. |

## Detection pipeline

### 1. Sampling

`_sample_timestamps()` builds a monotonic timestamp list from `duration_ms` and resolved `sample_fps` (`backend/app/services/hybrid_detection.py:567-575`).

`sample_fps` is resolved like this (`backend/app/services/hybrid_detection.py:532-560`):

- start from preset default
- override with `advanced.sample_fps_override` if provided
- clamp to `1 <= sample_fps <= source_fps`

Reading uses `_SequentialReader` when source FPS is known (`backend/app/services/hybrid_detection.py:193-245`, `1315-1326`) to avoid repeated full seeks on nearby timestamps.

### 2. Frame preparation

Each sampled frame is normalized by `_prepare_frame()` (`backend/app/services/hybrid_detection.py:595-599`):

- downscale so the longest edge is at most `960 px`
- convert to grayscale
- compute a Canny edge map

The detector works on the resized analysis frame, but final screenshots are extracted from the original video during the extract phase (`backend/app/services/hybrid_detection.py:1448-1456`).

### 3. Transition features between frames

`_transition_signal()` combines several feature families into `visual` and `motion` scores (`backend/app/services/hybrid_detection.py:787-840`).

#### Structural loss

`_structural_loss()` computes SSIM loss on `64x64` patches, sorts patch losses, and averages the highest `10%` (`backend/app/services/hybrid_detection.py:620-633`).

This matters because hybrid v2 is intentionally local-change sensitive: a small toast or badge can contribute strongly even when most of the frame is unchanged.

#### Tile change ratio

`_tile_change_ratio()` divides the grayscale diff into an `8x8` grid, marks tiles changed when mean diff exceeds `max(0.04, std(diff) * 2.5)`, and returns both the ratio and the boolean tile map (`backend/app/services/hybrid_detection.py:635-655`).

#### Changed regions

`_changed_regions()` finds localized change boxes (`backend/app/services/hybrid_detection.py:733-766`):

- absolute diff
- Otsu threshold, clamped to `[8, 30]`
- dilation
- external contours
- reject boxes smaller than `0.2%` of frame area
- keep up to 6 regions, sorted by score

Those regions are later reused for localized OCR probes.

#### Chrome vs content split

Hybrid tries to discount repeated change in persistent chrome:

- `_TileStabilityMap` tracks which `8x8` tiles have stayed stable over the last `30` updates (`backend/app/services/hybrid_detection.py:130-157`)
- `_chrome_tile_mask()` treats the top `12.5%` of rows as likely chrome (`backend/app/services/hybrid_detection.py:657-667`)
- `_split_chrome_content_change()` separately estimates change in likely chrome vs likely content (`backend/app/services/hybrid_detection.py:669-684`)

This produces `chrome_change` and `content_change`, which are later surfaced in `score_breakdown`.

#### Scroll displacement

`_scroll_displacement()` uses phase correlation on the central `60% x 60%` crop (`backend/app/services/hybrid_detection.py:692-731`):

- crop to the central band
- apply a Hanning window
- estimate `(dx, dy)` with `cv2.phaseCorrelate`
- compute an alignment-based confidence score

The downstream scroll strength is based mainly on `abs(scroll_dy)` and confidence (`backend/app/services/hybrid_detection.py:806-809`, `954-959`).

### 4. Feature fusion

Inside `_transition_signal()`, feature weights are:

#### Visual score

```
visual =
  structural * 0.38 +
  content_change * 0.26 +
  region_strength * 0.20 +
  edge_ratio * 0.08 +
  tile_ratio * 0.08 -
  chrome_penalty
```

Source: `backend/app/services/hybrid_detection.py:810-819`

#### Motion score

```
motion =
  scroll_strength * 0.38 +
  edge_ratio * 0.20 +
  content_change * 0.20 +
  tile_ratio * 0.12 +
  region_strength * 0.10
```

Source: `backend/app/services/hybrid_detection.py:820-826`

### 5. Anchor comparison for gradual change

`_build_signal()` can compare the current frame against both:

- the immediately previous sampled frame
- an anchor frame

When an anchor comparison is used, `_merge_transition_features()` keeps the stronger evidence across the two comparisons (`backend/app/services/hybrid_detection.py:962-979`, `1038-1068`).

This is how hybrid v2 stays responsive to gradual, cumulative changes that may look weak frame-to-frame but obvious relative to an earlier baseline.

### 6. OCR path

OCR is optional and selective.

#### Load and health model

- Backend startup launches a background OCR probe (`backend/app/main.py:158-171`).
- Hybrid runs can be coerced to OCR-off if health says OCR is unavailable (`backend/app/main.py:187-203`, `731-739`).
- `_maybe_load_ocr_engine()` validates env config, package versions, and runtime init before a scan proceeds with OCR (`backend/app/services/hybrid_detection.py:843-865`).

#### Supported stack

Hybrid currently targets:

- `paddlepaddle==3.3.0`
- `paddleocr==3.3.0`

Source: `backend/app/services/hybrid_detection.py:275-327`

Runtime env config is built in `backend/app/config.py:73-120` from:

- `STEPTHROUGH_OCR_MODEL_SOURCE`
- `STEPTHROUGH_OCR_DET_MODEL_DIR`
- `STEPTHROUGH_OCR_REC_MODEL_DIR`
- `STEPTHROUGH_OCR_CACHE_DIR`

#### Region probe, then full-frame fallback

OCR is not run on every sample.

- `_should_region_probe()` opens localized OCR when changed regions exist and the signal exceeds a low probe threshold (`backend/app/services/hybrid_detection.py:941-951`).
- `_extract_ocr_text()` crops up to 4 changed regions plus padding and OCRs only those crops (`backend/app/services/hybrid_detection.py:868-938`).
- If the overall signal crosses `ocr_trigger_threshold`, hybrid can also OCR the full current and previous frames (`backend/app/services/hybrid_detection.py:1095-1103`).

#### OCR cache

`_OcrCache` caches OCR results by perceptual hash, with a Hamming distance tolerance of `2` (`backend/app/services/hybrid_detection.py:170-190`).

This keeps repeated region probes from re-running OCR on essentially identical crops.

#### Text score

`text_distance()` in `backend/app/services/similarity.py:98-113` is a token-based Jaccard distance:

```
1 - (intersection(tokens_left, tokens_right) / union(tokens_left, tokens_right))
```

In practice:

- completely different token sets -> closer to `1.0`
- identical token sets -> `0.0`

### 7. Combined signal used to open or continue events

The current backend combined score is computed in `_build_signal()` (`backend/app/services/hybrid_detection.py:1104-1111`):

```
combined =
  transition.visual * 0.50 +
  transition.motion * 0.20 +
  text_score * 0.15 +
  transition.content_change * 0.10 +
  scroll_strength * 0.05
```

This is the current implementation. It is more complex than the older simplified three-term descriptions that predated the backend-owned metadata cleanup.

## Event assembly

### Open event

`_should_propose_event()` opens a normal event when (`backend/app/services/hybrid_detection.py:1009-1011`):

- `combined >= proposal_threshold`, or
- `text >= 0.3`

### Continue event

`_should_continue_event()` keeps an event active when (`backend/app/services/hybrid_detection.py:1013-1015`):

- `combined >= settle_threshold`, or
- `text >= 0.22`, or
- the sample qualifies as a micro-change candidate

### Micro-change path

Hybrid has a secondary path for tiny text-led or localized UI changes (`backend/app/services/hybrid_detection.py:994-1006`, `1354-1365`).

The detector buffers up to two micro-change samples and converts them into an event window when enough evidence accumulates.

Micro-change candidates are rejected if they look too chrome-heavy, too large, too multi-region, or too scroll-like.

### Keep or discard finalized event

`_should_keep_event()` keeps an event if one of these is true (`backend/app/services/hybrid_detection.py:1132-1144`):

- active duration meets `min_dwell_ms`
- peak `combined` is at least `proposal_threshold * 1.25`
- peak `text >= 0.3`
- peak `text >= 0.22` and `peak_content_change >= 0.04`
- peak `structural >= proposal_threshold * 0.7`

So `min_dwell_ms` is important, but it is not the only way an event survives.

### Representative frame selection

When finalizing an event (`backend/app/services/hybrid_detection.py:1232-1274`):

- `strongest` = highest-signal active sample
- `representative` =
  - `strongest` in micro-change mode
  - otherwise the lowest-motion sample from the settle samples, or the last active sample if there are no settle samples

That representative timestamp is what becomes the candidate screenshot timestamp.

### Transition classification

`_classify_transition()` emits one of:

- `navigation`
- `scroll`
- `feed_card_swap`
- `modal`
- `content_update`
- `small_ui_change`
- `unknown`

Source: `backend/app/models.py:16`, `backend/app/services/hybrid_detection.py:1147-1213`

Classification uses heuristics based on:

- `chrome_change`
- `content_change`
- cumulative scroll
- scroll confidence
- dominant changed region size and position
- strong multi-region structural changes

### Min-scene-gap behavior

Hybrid does not freeze detection for `min_scene_gap_ms`.

Instead, `_merge_or_append_event()` applies the gap after an event is finalized (`backend/app/services/hybrid_detection.py:1017-1036`):

- if the new event is outside the gap, keep both
- if it is inside the gap, keep only the stronger event
- on equal score, keep the later event

This matches the UI hint in `frontend/src/lib/runSettings.ts:290-296` and the workflow test in `backend/tests/test_run_workflow.py:321-350`.

### Dwell annotations

After events are finalized, `_annotate_dwell_durations()` adds:

- `dwell_before_ms`
- `dwell_after_ms`
- `event_start_ms`
- `event_end_ms`

Source: `backend/app/services/hybrid_detection.py:1216-1230`

## Candidate extraction and post-processing

If no events are detected, hybrid still emits a fallback candidate at `0 ms` (`backend/app/services/hybrid_detection.py:1416-1439`).

Otherwise it:

1. extracts the representative frame with `ffmpeg` via `extract_frame()` (`backend/app/services/hybrid_detection.py:1448-1450`, `backend/app/services/video.py:97-138`)
2. fingerprints the image (`backend/app/services/hybrid_detection.py:1451`, `backend/app/services/similarity.py:45-58`)
3. optionally OCRs the extracted screenshot if the event never carried OCR text (`backend/app/services/hybrid_detection.py:1452-1457`)
4. stores `scene_score`, `ocr_text`, hashes, histogram signature, and `score_breakdown`
5. runs `annotate_candidate_similarity()` to tag revisit-like near-duplicates (`backend/app/services/hybrid_detection.py:1489-1491`, `backend/app/services/similarity.py:149-174`)

Similarity grouping currently uses a threshold of `0.16` (`backend/app/services/similarity.py:166-172`).

## What changing parameters actually does

### Preset

Changing the preset changes more than human-facing labels. It changes:

- default `sample_fps`
- default `min_dwell_ms`
- default `settle_window_ms`
- `proposal_threshold`
- `settle_threshold`
- `ocr_trigger_threshold`

So moving from `balanced` to `subtle_ui` is both:

- denser sampling
- shorter persistence requirements
- lower proposal/settle/OCR thresholds

### `advanced.sample_fps_override`

Higher values:

- sample more densely
- make brief overlays, menus, and very short states easier to detect
- increase compute cost and usually increase candidate count

Lower values:

- reduce sensitivity to very short-lived changes
- calm down noisy recordings
- can miss brief UI states

The resolved value is clamped to source FPS (`backend/app/services/hybrid_detection.py:535-536`).

### `advanced.min_dwell_ms`

Lower values:

- allow short-lived events to survive finalization
- help with brief menus, toasts, and momentary text states
- increase false positives from flicker and transient motion

Higher values:

- require more persistence before an event is kept
- reduce false positives from shimmer or jitter
- can suppress legitimate short UI states

Important nuance: a very strong event can still survive even if it does not meet dwell, because `_should_keep_event()` also checks peak score, text, and structural conditions (`backend/app/services/hybrid_detection.py:1132-1144`).

### `advanced.settle_window_ms`

Lower values:

- finalize events sooner
- capture earlier screenshots
- increase the chance of mid-animation or mid-scroll screenshots

Higher values:

- wait longer for motion to decay
- produce calmer representative screenshots
- risk landing later than the user-perceived moment of change

### `advanced.proposal_threshold`

Lower values:

- open event windows more readily
- improve sensitivity to subtle and brief UI changes
- increase the chance of low-value or noisy proposals

Higher values:

- require stronger evidence before an event starts
- reduce overfiring on shimmer, scroll noise, or small motion
- can suppress real but subtle UI changes

### `advanced.settle_threshold`

Lower values:

- keep active event windows alive longer once they start
- help multi-frame interactions stay grouped together
- can make one interaction absorb more nearby motion than desired

Higher values:

- let the engine settle sooner after the main change passes
- reduce event stretch on noisy recordings
- can split one real interaction into smaller nearby events

### `advanced.ocr_trigger_threshold`

Lower values:

- escalate to OCR confirmation more readily
- help text-led changes contribute sooner
- increase OCR work on recordings where visual evidence is weak or noisy

Higher values:

- keep OCR confirmation more selective
- reduce OCR cost when strong visual change is usually enough
- can miss text-led changes that need OCR to cross the finish line

### `advanced.enable_ocr`

When on:

- text-led changes can contribute via `text_score`
- localized OCR probes can rescue subtle changes that are visually small
- first-use backend startup or model init cost may apply depending on OCR config

When off:

- the engine becomes visual/motion-only
- text-only or text-dominant changes are easier to miss
- the run avoids OCR model initialization and OCR inference cost

If OCR init fails during a run, hybrid logs a warning and continues without OCR instead of failing the entire run (`backend/app/services/hybrid_detection.py:1296-1305`).

### `min_scene_gap_ms`

Higher values:

- compress clusters of nearby events
- prefer the strongest candidate in a local time neighborhood

Lower values:

- allow tightly clustered candidates
- make scroll-heavy or multi-step flows denser

At `0`, hybrid will keep nearby finalized events instead of replacing within a gap window.

### Shared app parameters with no current hybrid effect

These fields are still stored on the run, but the hybrid detector does not read them:

- `tolerance`
- `sample_fps`
- `allow_high_fps_sampling`
- `detector_mode`
- `extract_offset_ms`

That means changing them will not alter hybrid candidate detection today, except insofar as the UI, run summaries, or preset text echo them back.

### Still-internal engine constants

The current UI intentionally does not expose deeper implementation constants such as:

- `max_frame_edge`
- `tile_grid_size`
- `contour_threshold_floor`
- `contour_threshold_ceiling`
- tile stability window and threshold
- OCR cache size and hash distance
- transition classification heuristics

## Documentation notes

### Extract offset behavior

- The shared UI describes `extract_offset_ms` as controlling screenshot timing (`frontend/src/lib/runSettings.ts:298-304`, `frontend/src/features/analysis/AnalysisScreen.tsx:324`).
- The hybrid extraction path currently ignores it and extracts exactly at the representative event timestamp (`backend/app/services/hybrid_detection.py:1448-1450`).

### User-facing docs

- `manual.md` now sources the hybrid preset section from the backend registry through `scripts/sync_hybrid_v2_manual.py`.
- Non-developer docs should prefer qualitative descriptions of the combined score unless exact implementation detail is needed.
