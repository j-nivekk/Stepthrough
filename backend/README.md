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

## Configuration

| variable | default | meaning |
|---|---|---|
| `STEPTHROUGH_DATA_ROOT` | `<repo>/data` | where the database, recordings and exports live |
| `STEPTHROUGH_DEPLOYMENT` | `local` | `local` for a single-user install, `server` for a shared instance |
| `STEPTHROUGH_CORS_ORIGINS` | the Vite dev and preview origins in `local`; none in `server` | comma-separated origins allowed to call the API from a browser |
| `STEPTHROUGH_MAX_UPLOAD_MB` | `2048` | largest accepted upload; also enforce it in the reverse proxy (`client_max_body_size`) |
| `STEPTHROUGH_ALLOW_ADMIN_RESET` | on in `local`, off in `server` | whether `POST /admin/reset-db` is available (it also requires the `X-Stepthrough-Confirm: reset-database` header) |

Only `data/projects/` is served under `/assets/projects/`; the database, OCR models and other files in
the data root are not reachable over HTTP. Runs that were queued or running when the backend stopped are
marked failed at the next start-up.

Not yet in place for a shared server: user accounts and per-user access checks (planned behind SURFconext
login at the reverse proxy), and a job queue that bounds concurrent runs.
