# Stepthrough Backend

FastAPI service for local video ingestion, scene detection, review persistence, and export packaging.

## Working copies

Every imported recording gets a working copy at `recordings/<recording>/working/working.mp4`, built in the
background right after upload (or by the first run if it is not ready yet). Analysis, the browser
preview, detected screenshots and manual steps all use it; the original upload is kept untouched in
`source/`.

The working copy is:

- **constant frame rate** (the source rate if it is already constant and at most 30 fps, otherwise 30 fps).
  Phone and desktop screen recordings are variable frame rate, and seeking such a file by time returns
  the *next* frame rather than the one on screen. Resampling uses ffmpeg's `fps` filter, so each frame
  is the one on screen at that instant.
- **SDR BT.709.** HDR10 (PQ) and HLG recordings are tone-mapped with a generated 3D LUT applied by
  ffmpeg's built-in `lut3d` filter (`working/hdr_to_sdr.cube`), so no extra ffmpeg libraries are needed.
  For PQ, the brightness of interface white is measured from the recording.
- **upright** (rotation metadata is applied) and **H.264 + AAC with faststart**, so it plays in every browser.

Recording `fps`, `duration_ms`, `width` and `height` describe the working copy once it exists.

## Detection engine

Runs use **`stable_v3` ("stable screens")**, in `app/services/stable_detection.py`. A step is a screen that
stays still for at least the minimum time on screen. The engine takes one screenshot from inside each such
screen, 200 ms after it settles, so screenshots never catch an animation half-way. The design, its
evaluation and its limits are in `docs/robustness-review-2026-11.md`, section 1.

The earlier engines, `hybrid_v2` and `scene_v1`, are retired. Their runs still load, review, compare and
export (their stored settings and field notes are kept), but `POST /recordings/{id}/runs` refuses them with
422. Their code is at the git tag `last-with-hybrid-v2`.

OCR (`enable_ocr`) needs the optional PaddleOCR packages: `uv sync --group ocr`. Note that a plain `uv sync`,
`uv add` or `uv remove` uninstalls them again unless `--group ocr` is passed.

Settings (`RunSettings.stable`; `null` means the recording type's default):

| setting | meaning | phone / computer default |
|---|---|---|
| `recording_type` | `phone` (phone or tablet) or `desktop` (computer with a mouse pointer) | `phone` |
| `min_dwell_ms` | how long a screen must stay still to be a step | 450 / 600 ms |
| `min_change_percent` | smallest connected change that ends a stable screen, % of the frame | 0.10 / 0.25 % |
| `ignore_regions` | boxes to ignore, as shares (0 to 1) of the frame: `{x, y, width, height}` | none |
| `ignore_status_bar` | ignore the phone status bar (top 6 % of a portrait phone, 2.5 to 3.2 % on tablets) | on / off |
| `scroll_mode` | `each_stop` (every scroll stop is a step) or `merge` (keep the first) | `each_stop` |
| `group_typing` | a burst of typing with short pauses becomes one step with the finished text | on |
| `include_opening_screen` | the first screen is step 0 | on |
| `enable_ocr` | read the text of each screenshot into exports (`ocr_text`); not used to find steps | off |
| `sensitivity` | pixel threshold in multiples of the noise measured on the recording (at least 10 grey levels) | 4 |
| `sample_fps` | analysis rate, rounded to a whole share of the working copy's frame rate | 15 |

Each run stores what it actually used in `analysis_config`: the resolved settings, `engine_version`, and
`measured` (noise, pixel threshold, stable intervals found, typing groups).

## Exports

An export is a zip with `images/` (one PNG per step), `steps.json` and `steps.csv`. `steps.json` holds the
project, the recording (with the working copy's `width`, `height` and `fps`), the run (`analysis_engine`,
`engine_version`, the `settings` as chosen and the `resolved_settings` actually used, including what was
measured), `field_notes` explaining each per-step field for that run's engine, and the steps. Per step:
time, image path inside the bundle, the reviewer's status, title and notes, `ocr_text`, the score
breakdown, revisit links and the timing columns `transition_type`, `change_started_ms`, `settled_ms`,
`time_on_screen_ms` and `grouped_states`. Changed regions are in pixels of the recording for every engine.
`steps.csv` has the same per-step fields without the nested score breakdown.

## Configuration

| variable | default | meaning |
|---|---|---|
| `STEPTHROUGH_DATA_ROOT` | `<repo>/data` | where the database, recordings and exports live |
| `STEPTHROUGH_DEPLOYMENT` | `local` | `local` for a single-user install, `server` for a shared instance |
| `STEPTHROUGH_CORS_ORIGINS` | the Vite dev and preview origins in `local`; none in `server` | comma-separated origins allowed to call the API from a browser |
| `STEPTHROUGH_MAX_UPLOAD_MB` | `2048` | largest accepted upload; also enforce it in the reverse proxy (`client_max_body_size`) |
| `STEPTHROUGH_ALLOW_ADMIN_RESET` | on in `local`, off in `server` | whether `POST /admin/reset-db` is available (it also requires the `X-Stepthrough-Confirm: reset-database` header) |
| `STEPTHROUGH_MAX_CONCURRENT_RUNS` | no limit in `local`, `2` in `server` | analyses that may run at once; later runs wait as `queued`, first come first served, and can be ended while they wait. `0` lifts the limit |
| `STEPTHROUGH_FRONTEND_DIR` | unset | a built frontend (`frontend/dist`) to serve from the API's own origin, as the Docker image does; it must contain `index.html` |

Only `data/projects/` is served under `/assets/projects/`; the database, OCR models and other files in
the data root are not reachable over HTTP. Runs that were queued or running when the backend stopped are
marked failed at the next start-up.

Run the API with a single worker process: run progress, cancel requests and the run queue live in that process's
memory. The database uses SQLite's write-ahead log; copy it with `python -m app.backup` (SQLite's backup API)
rather than copying the file. For the Docker image, see [`DEPLOY.md`](../DEPLOY.md).

Not yet in place for a shared server: user accounts and per-user access checks (planned behind SURFconext
login at the reverse proxy), and a job queue that bounds concurrent runs.
