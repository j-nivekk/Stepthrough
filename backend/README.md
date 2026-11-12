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
evaluation and its limits are in [`docs/evaluation.md`](../docs/evaluation.md).

The earlier engines, `hybrid_v2` and `scene_v1`, are retired. Their runs still load, review, compare and
export (their stored settings and field notes are kept), but `POST /recordings/{id}/runs` refuses them with
422. Their code is at the git tag `last-with-hybrid-v2`.

OCR (`enable_ocr`) needs the optional PaddleOCR packages: `uv sync --group ocr`. Note that a plain `uv sync`,
`uv add` or `uv remove` uninstalls them again unless `--group ocr` is passed.

### PaddlePaddle version bugs

OCR is pinned to `paddlepaddle==3.3.0` with `paddleocr==3.3.0`. Change the two together, and test on an x86
machine before bumping either (CI's `test-ocr` job does this for the Docker image).

- **oneDNN fails in 3.3.0 on x86 CPUs** (Linux servers, and Windows machines running the desktop app). The first
  prediction stops with `(Unimplemented) ConvertPirAttribute2RuntimeAttribute not support
  [pir::ArrayAttribute<pir::DoubleAttribute>]` from `onednn_instruction.cc`, a regression in that release
  ([Paddle#77340](https://github.com/PaddlePaddle/Paddle/issues/77340)). Stepthrough therefore turns oneDNN off
  (`enable_mkldnn=False` in `app/services/ocr.py`), so x86 recognition runs on plain CPU kernels and is slower.
  Apple silicon never uses oneDNN and is unaffected. If the error comes back, the fix reported upstream is
  `paddlepaddle==3.2.2`.
- **Mismatched versions** of `paddleocr` and `paddlepaddle` cause similar errors
  ([PaddleOCR discussion #17350](https://github.com/PaddlePaddle/PaddleOCR/discussions/17350)).
- **No Linux ARM packages** exist for 3.3.0, so the `-ocr` Docker image is x86-64 only.
- **No emulation.** The x86-64 build crashes (segmentation fault) under Docker Desktop's emulation on an ARM Mac
  as soon as recognition starts, even with oneDNN off, so it can only be tested on real x86 hardware. Even
  building it under emulation needs `--build-arg COMPILE_BYTECODE=0`.

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
| `STEPTHROUGH_AUTH` | `none` in `local`, `password` in `server` | `none`: no logins, every request comes from the built-in user; `password`: people log in (see [Accounts](#accounts)) |
| `STEPTHROUGH_PUBLIC_URL` | unset | the address people open, such as `https://stepthrough.example.org`, so `python -m app.users` prints whole links; an `https` address also keeps the session cookie to HTTPS, even when the web server in front does not say the browser used HTTPS |

Project media (recordings, screenshots, exports) is served under `/assets/projects/` only to people who may
open that project; the database, OCR models and other files in the data root are not reachable over HTTP.
Runs that were queued or running when the backend stopped are marked failed at the next start-up.

Run the API with a single worker process: run progress, cancel requests and the run queue live in that process's
memory. The database uses SQLite's write-ahead log; copy it with `python -m app.backup` (SQLite's backup API)
rather than copying the file. For the Docker image, see [`DEPLOY.md`](../DEPLOY.md).

Not yet in place for a shared server: a page for sharing projects (see below), and analysis in a separate worker
that survives restarts.

## Accounts

Each project has members (`project_members`): a user, or everyone with a tag (`tag:<name>`), as an owner (may
change it) or a viewer (may only look). Recordings, runs, steps and exports follow their project, and every
endpoint checks the role. People who may not open a project get the same 404 as for one that does not exist.
Users with the `admin` tag may open every project, though their project list shows only their own. Sharing a
project with other people or a tag works in the data model but has no page yet.

Settings saved for new runs (`saved_run_settings`) belong to the person who saved them: their own defaults, and
theirs for any project they may open, as a viewer too. They are deleted with the account or the project; resetting
the database keeps everyone's own defaults. Earlier versions kept them in the browser; the app moves those to the
first account that opens it there.

With `STEPTHROUGH_AUTH=none` (the desktop app) there are no logins: every request comes from the built-in user
`local`, an administrator, who also owns every project made before users existed.

With `STEPTHROUGH_AUTH=password` people log in with a name and a password:

- **Making accounts.** Administrators make them on the users page (account menu, then **manage users**) or with
  `python -m app.users`; nobody can sign up. The first administrator comes from the command line:
  `python -m app.users add NAME --admin --password`. Names match in any case, have no spaces, and do not start
  with `=`, `+`, `-` or `@` (spreadsheets would run them as formulas in a CSV of links).
- **Passwords.** A new account gets a one-time link (`<address>/#link=<token>`, valid for 14 days) with which
  its owner chooses a password; a forgotten password gets a reset link the same way (valid for 3 days), and a new
  link replaces the old one. The part after `#` never reaches the server, so links stay out of its logs. As NIST
  SP 800-63B advises, passwords need at least 8 characters and have no composition rules, but the 20,000 most
  common ones from breaches (`app/wordlists/common-passwords.txt`), one character repeated, and passwords
  containing the person's name or "stepthrough" are refused. They are stored as PBKDF2-SHA256 hashes (600,000
  iterations).
- **Lists.** A CSV in 4CAT's bulk-user layout imports many people at once: a `name` column, and optionally
  `expires`, `tags`, `password` and `notes`, separated by commas, semicolons or tabs. People without a password
  get a link; the page offers all links as a CSV, and `python -m app.users import` prints one. A password from
  the list (or from `python -m app.users add --password`) is kept as given, even one the rules above would
  refuse, since it usually comes from another system where people already use it; the import names those people.
- **Sessions** last 30 days, or end after 7 days unused, in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over
  HTTPS, or whenever `STEPTHROUGH_PUBLIC_URL` is an `https` address). Setting a new password logs out the
  account's other browsers, and switching an account off logs it out at once. Only the SHA-256 of session and
  link tokens is stored.
- **Guessing.** Wrong logins get one answer, in the same time, whether or not the name exists. Within 15 minutes,
  further attempts are refused after 10 wrong passwords for a name from one address, 100 for a name from anywhere,
  or 100 from one address (generous, since a class may share one address). Wrong current passwords when changing
  a password count too. The counts live in memory, at most 100,000 of them. Failed and refused attempts are
  logged with the name and address. The address is the last `X-Forwarded-For` entry, the one the web server
  added, so a client cannot choose it.
- **Deletion dates.** From an account's `delete_after` date, the account and the projects only it owns are
  deleted (the server checks every hour, and `python -m app.users expire` does it at once). In the month before,
  its owner sees a notice. Deleting an account by hand does the same; projects it shares as an owner stay.
- **Projects from before logins** belong to `local`, which cannot log in. An administrator takes them over on
  the users page or with `python -m app.users transfer local NAME`.

In both modes, requests that change something are refused when the browser says they come from another website
(`Sec-Fetch-Site`, `Origin`); the origins in `STEPTHROUGH_CORS_ORIGINS` are trusted. Every answer carries
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and frame protection (`X-Frame-Options`,
`frame-ancestors`). On a server (`STEPTHROUGH_DEPLOYMENT=server`) the API description (`/docs`, `/openapi.json`)
is switched off, and `/health` gives its details (folders, library versions) only to administrators. A database
reset deletes projects but keeps accounts.
