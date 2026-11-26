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

Deleting a recording while its working copy is still being made stops ffmpeg and waits for it before the folder
is removed, so the copy cannot write the folder back; a deleted recording's copy cannot start later either.

## Detection engine

Runs use **`stable_v3` ("stable screens")**, in `app/services/stable_detection.py`. A step is a screen that
stays still for at least the minimum time on screen. The engine takes one screenshot from inside each such
screen, 200 ms after it settles, so screenshots never catch an animation half-way. The design, its
evaluation and its limits are in [`docs/evaluation.md`](../docs/evaluation.md).

The earlier engines, `hybrid_v2` and `scene_v1`, are retired. Their runs still load, review, compare and
export (their stored settings and field notes are kept), but `POST /recordings/{id}/runs` refuses them with
422. Their code is at the git tag `last-with-hybrid-v2`.

Reading the text of screenshots (`enable_ocr`) is not part of the analysis: see [Text recognition](#text-recognition).

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
| `enable_ocr` | read the text of each screenshot after the analysis; not used to find steps | off |
| `sensitivity` | pixel threshold in multiples of the noise measured on the recording (at least 10 grey levels) | 4 |
| `sample_fps` | analysis rate, rounded to a whole share of the working copy's frame rate | 15 |

Each run stores what it actually used in `analysis_config`: the resolved settings, `engine_version`, and
`measured` (noise, pixel threshold, stable intervals found, typing groups).

## Exports

An export is a zip with `images/` (one PNG per step), `steps.json` and `steps.csv`. `steps.json` holds the
project, the recording (with the working copy's `width`, `height` and `fps`), the run (its `number` among the
runs of the recording, which never changes, the `name` someone gave it if any, `analysis_engine`,
`engine_version`, the `settings` as chosen and the `resolved_settings` actually used, including what was
measured), `field_notes` explaining each per-step field for that run's engine, and the steps. Per step:
time, image path inside the bundle, the reviewer's status, title and notes, `origin` (`detected`, or `manual`
for a step added by hand, which has no timing or label), `ocr_text` with `text_state`, `text_lines` and
`text_page_xml`, the score breakdown, revisit links and the timing columns `transition_type`, `change_started_ms`, `settled_ms`,
`time_on_screen_ms` and `grouped_states`. Changed regions are in pixels of the recording for every engine.
`steps.csv` has the same per-step fields without the nested score breakdown.

Each export is written to the task's `exports/` as a folder and a zip of it, named by the export's id. Only the
latest export of a task is offered (`GET /exports/{id}/download`); `app/export_cleanup.py` removes the others
after each export and every hour: their record once it is ten minutes old, then the folder and zip no record
points to, also those left by earlier versions. Anything else in `exports/`, and files younger than ten minutes
(an export may still be writing them), stays.

The zip also has `pathway.json`: the same steps folded into the screens they show and the moves between
those screens (`app/services/pathway.py`). Steps share a screen when one is a revisit of the other, or when the
engine found them to show the same screen (`same_screen_as` and `same_screen_reason`, since engine 1.2.0; see
`app/services/screens.py`). Runs of earlier engines go by the label: a step reached by a change that stays on the
screen (`scroll`, `text_entry`, `feed_card_swap`, `content_update`, `small_ui_change`) joins the step before it, and
one reached by a pop-up closing (`modal_close`) the screen the pop-up opened over. Every candidate of the run takes
part in that grouping, also rejected ones, because a label describes the change from the detector's previous step.
`GET /runs/{id}/pathway` returns the same for the accepted steps, and `?detail=steps` joins revisits only.
`GET /runs/{id}` lists the run's `phases` too, as where each starts (`start_ms`, `name`; an empty name starts a
stretch outside every phase), so the step review can show and set each step's phase. `PUT /runs/{id}/phases`
(`name`, `first_step`, `last_step`, optionally `replacing`) answers with every phase after the change, and
`PUT /runs/{id}/phases/all` puts them all back (`phases`), refusing with 409 when `expected` no longer matches:
the pathway's undo, which leaves a change someone else made since.

A reviewer can overrule the grouping per step (`PATCH /candidates/{id}`): `screen_link` is `auto`, `new` (a
screen of its own) or the id of another step of the run that shows the same screen, and `screen_kind` is
`auto`, `screen` or `popup`. A step joins another step, by the first that applies: the
reviewer's choice, a revisit, what the engine found (or, in older runs, a pop-up closing or a label that stays on
the screen).

`POST /runs/{id}/pathway/merge` takes `source_candidate_id`, `target_candidate_id` and `detail` (`screens`
by default). It moves every member of the source box to the target together, including rejected members,
so accepting one later preserves the merge. Both candidates must belong to that run, and the caller must
be a project owner. It answers `{"changed": [...]}`, the steps it linked, so a browser can take the merge back
step by step (the pathway's undo, which is each browser's own and leaves steps someone else changed since).

Where a box is drawn is the reviewer's say too, on a step (`PATCH /candidates/{id}`): `pathway_row` is `auto`,
`continue` (on the row of the box it was reached from) or `below` (on a row of its own). The box's first step with
a say decides, and the pathway gives it as the screen's `row_choice`. It changes the figure only, not the screens
or the moves.

Phases are named stretches of a run: `PUT /runs/{id}/phases` takes `name`, `first_step` and `last_step` (ids of
accepted steps) and names that stretch as one phase; an empty name takes it out of every phase, and `replacing`
(another `first_step` and `last_step`) lets go of the stretch a phase had before. They are stored in `run_phases`
as where each phase starts in the recording, up to the moment of the step after the last one, so a step added by
hand in between belongs to the phase. The pathway gives each step its `phase` and lists the `phases` with their
steps, screens and duration; the export puts `phase` in `steps.csv` and `steps.json` and the list in
`pathway.json`.

## Text recognition

The text of screenshots is read by ONNX Runtime with PP-OCRv6 models (PaddlePaddle, Apache License 2.0):

- `app/services/text_models.py`: the three model files (23 MB), each pinned to a commit on Hugging Face and a SHA-256.
  They are fetched the first time text is read, into `STEPTHROUGH_OCR_MODELS` or `ocr-models/ppocrv6` in the data
  folder; `uv run python -m app.services.text_models` gets them beforehand. The Docker image has them.
- `app/services/text_engine.py`: reads one screenshot. A small model marks where text is, on the screenshot at half its
  size (longest side 1280 to 1920 pixels); each line is cut out of the full screenshot and read by the other. Lines that
  look the same in the same place as on the run's screenshot before are not read again. `ENGINE` goes up whenever the
  same screenshot could be read differently.
- `app/text_reader.py`: the process that reads, at low priority, spoken to in lines of JSON. The web server never loads
  ONNX Runtime: at start it only runs `python -m app.text_reader --check` in the background, for `/health`.
- `app/services/text_queue.py`: the screenshots waiting to be read, of every run, and the readers. Runs take turns (four
  screenshots each). A screenshot that takes longer than two minutes, or whose reader dies, is tried once more with a
  new reader, then marked `failed`; a reader that used more than 2.5 GB is replaced, and one without work ends after a
  minute. When text cannot be read at all (no models, a package that does not load), what waits is let go of and the
  run says why.
- `app/text_reading.py`: what is asked for and how it is stored. `candidate_frames.text_state` is NULL (not asked for),
  `waiting`, `read` or `failed`; `text_reading` has the engine, the screenshot's size and the lines with their places;
  `ocr_text` the same text in one piece. What is `waiting` when the server stops is read when it is back. Text without a
  `text_state` was read by a version before 1.5.0 (`earlier`): those used an engine that shared one text between
  screenshots with nearly the same perceptual hash, so it can be another screen's.

Exports also have the text of each screenshot whose text was read as PAGE XML (`app/services/page_xml.py`, version
2013-07-15, as Transkribus, eScriptorium, OCR-D and Loghi read it), in `images/page/` with the screenshot's name: one text
region with the lines in reading order, each with its box as a rectangle and `conf`; there are no baselines.
`tests/test_page_xml.py` checks the files against PAGE's schema when `STEPTHROUGH_PAGE_SCHEMA` names its
`pagecontent.xsd`.

How long a run's text still takes (`text.seconds_left`) follows from the turns: before a run's last screenshot is read,
every other run has at most as many read, each at the time its screenshots take, measured as they are read (the run's
own once three are read, else what screenshots of its size took lately). Runs whose analysis is still going and will
read text join the reckoning when they are expected to be done, with as many screenshots as analyses on the server had
per minute of recording. Without measurements, there is no estimate.

`POST /runs/{id}/text` reads what this version has not read of a finished run, `DELETE` stops it, and `GET` gives the
text of every step in one piece; `GET /candidates/{id}/text` has a step's lines. Run summaries say how far it is
(`text`: `waiting`, `read`, `failed`, `earlier`, `problem`). Administrators set the number of readers (0: off) and their
threads (`text_readers`, `text_threads` in `/admin/server-settings`).

The packages are in the `ocr` group, which a plain `uv sync` installs; `uv sync --no-group ocr` leaves it out. ONNX
Runtime has no packages for Intel Macs, for macOS before 14 and for Linux with glibc before 2.28; on Macs it is left out
by itself, and text recognition is unavailable there.

`python -m tests.eval.webtext` measures how well text is read
([results](../docs/evaluation.md#text-recognition)). Reading is not exactly the same on every processor; a letter can
differ.

## Carrying a review over

After a run with other settings, `POST /runs/{id}/review-from` brings the review of another completed run of the
same recording over to run `{id}`. The body names `source_run_id` and `pairs`, each a `source_candidate_id` and a
`target_candidate_id`: steps of the two runs that show the same moment. The app pairs detected steps by time, as
its comparison shows them (at most 750 ms apart; `buildCandidateComparison` in `frontend/src/lib/analysis.ts`),
and leaves steps added by hand out of the pairs. Each step can be in one pair.

For every pair, only what is still empty on the target is filled in: the decision of a pending step, the title,
the notes, the pop-up choice (`screen_kind`), the screen choice (`screen_link`, `new` or mapped through the
pairs) and the row choice (`pathway_row`). Steps of the source run that were added by hand and are not paired are
added again at the same moment. The phases come along when the target has none of its own (`phases`: true).
The answer counts what was filled in (`decisions`, `titles`, `notes`, `screen_choices`), the steps added again
(`added_manual`), and `unmatched`: reviewed steps of the source run without a match, whose review stays there.
The caller must be an owner of both runs' project.

## How long it takes

Run summaries say about how long an analysis that waits or runs still takes (`seconds_left`) and, while it waits for a
slot, how long until it starts (`seconds_to_start`); `null` where the server cannot say (`app/estimates.py`). An analysis
is expected to take the median of the server's last 20 finished ones, in seconds per minute of recording times the square
root of its megapixels; analyses that read text during the analysis (before 1.5.0) and copies of runs do not count, and
with fewer than five there is no estimate. A running analysis has what is left of that, or `null` once it took longer.
The slots are then filled in turn, from when those holding one are expected to be free. Text: see
[Text recognition](#text-recognition).

## Configuration

| variable | default | meaning |
|---|---|---|
| `STEPTHROUGH_DATA_ROOT` | `<repo>/data` | where the database, recordings and exports live |
| `STEPTHROUGH_DEPLOYMENT` | `local` | `local` for a single-user install, `server` for a shared instance |
| `STEPTHROUGH_CORS_ORIGINS` | the Vite dev and preview origins in `local`; none in `server` | comma-separated origins allowed to call the API from a browser |
| `STEPTHROUGH_MAX_UPLOAD_MB` | `2048` | largest accepted upload; also enforce it in the reverse proxy (`client_max_body_size`) |
| `STEPTHROUGH_ALLOW_ADMIN_RESET` | on in `local`, off in `server` | whether `POST /admin/reset-db` is available (it also requires the `X-Stepthrough-Confirm: reset-database` header) |
| `STEPTHROUGH_MAX_CONCURRENT_RUNS` | no limit in `local`, `2` in `server` | analyses that may run at once; later runs wait as `queued`, first come first served, and can be ended while they wait. `0` lifts the limit. It is the default for the setting administrators change while the server runs (below) |
| `STEPTHROUGH_OCR_MODELS` | `ocr-models/ppocrv6` in the data folder | the folder with the models that read text (see [Text recognition](#text-recognition)) |
| `STEPTHROUGH_OCR_MODEL_URL` | `https://huggingface.co` | where they are fetched from, the first time text is read |
| `STEPTHROUGH_FRONTEND_DIR` | unset | a built frontend (`frontend/dist`) to serve from the API's own origin, as the Docker image does; it must contain `index.html` |
| `STEPTHROUGH_AUTH` | `none` in `local`, `password` in `server` | `none`: no logins, every request comes from the built-in user; `password`: people log in (see [Accounts](#accounts)) |
| `STEPTHROUGH_PUBLIC_URL` | unset | the address people open, such as `https://stepthrough.example.org`, so `python -m app.users` prints whole links; an `https` address also keeps the session cookie to HTTPS, even when the web server in front does not say the browser used HTTPS |

Project media (recordings, screenshots, exports) is served under `/assets/projects/` only to people who may
open that project; the database, models and other files in the data root are not reachable over HTTP.
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
first account that opens it there. `DELETE /me/run-settings/default` and `DELETE /me/run-settings/projects/{id}`
forget a person's own defaults and their settings for one project (**restore factory settings** in the app).

With `STEPTHROUGH_AUTH=none` (the desktop app) there are no logins: every request comes from the built-in user
`local`, an administrator, who also owns every project made before users existed.

With `STEPTHROUGH_AUTH=password` people log in with a name and a password:

- **Making accounts.** Administrators make them in the admin panel (account menu, then **admin panel**) or with
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
  the admin panel or with `python -m app.users transfer local NAME`.

In both modes, requests that change something are refused when the browser says they come from another website
(`Sec-Fetch-Site`, `Origin`); the origins in `STEPTHROUGH_CORS_ORIGINS` are trusted. Every answer carries
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and frame protection (`X-Frame-Options`,
`frame-ancestors`). On a server (`STEPTHROUGH_DEPLOYMENT=server`) the API description (`/docs`, `/openapi.json`)
is switched off, and `/health` gives its details (folders, library versions) only to administrators. A database
reset deletes projects but keeps accounts.

## Server settings and compression

`app/server_settings.py` holds what an administrator changes while the server runs (`GET` and `PATCH
/admin/server-settings`, shown in the admin panel under **server**). Each starts from the configuration and is stored
in `server_settings` once changed, unless changed back to the configuration's value:

- `analyses_at_a_time` (0: no limit) sets the job manager's limit at once; with a higher limit, runs waiting start.
  Analyses are threads of the one process, so more than two or three mostly slows the API down;
- `compression` switches `app/compression.py` on or off. It gzips answers of 1 KB or more whose type is JSON,
  text, JavaScript or SVG, for browsers that accept it, and leaves media, zips, partial answers (`Range`) and `HEAD`
  alone. A large task is a tenth of its size compressed;
- `live_spread_seconds`: the live feed tells browsers (`pace.spread_ms`) to reload a task after a change at a
  random moment within this time, after the usual pause, so the browsers of a shared account spread their requests.

## Usage report

`app/usage.py` records how the app is used, on a server with logins, for accounts that are not administrators:
`login` (and `login_failed`, without an account), `open` and `working` in five-minute slots (any request, and a
change; noted in `current_user`), `project_created`, `recording_uploaded` (its minutes), `analysis_started` and
`analysis_finished` (status, seconds waited and taken, steps), `step_decided`, `steps_decided` (status, count),
`step_annotated` (title or notes, not the text), `step_added`, `screen_corrected` (which choice: the same screen
as, a new screen, back to automatic, pop-up or not), `review_carried_over`, `screens_merged`, `exported` (mode,
steps) and `figure_downloaded` (format; `POST /runs/{id}/pathway/figure`). Browsers add what only they see through
`POST /me/usage`, from a fixed list (`CLIENT_EVENTS`): the page, the pathway tutorial (invited, opened and from
where, each lesson reached and solved, "show me", closed with lessons solved and minutes), the run comparison
opened, the pathway's boxes switched, and the guide opened. Each event carries a browser key derived from the
session (`User.browser`), so the people under one shared account count apart; no names, addresses, files or text.
Events are queued in memory and written in batches, and deleted after `usage_keep_days` by the hourly clean-up (14
by default; 0 records nothing; null keeps them for ever; at most 3650).

`GET /admin/usage` adds them up for a period (`app/report_window.py`): `days` whole local days up to today (0:
everything kept), or `start` to `end` (local dates, both included), in the reader's time zone (`tz`, minutes east
of UTC), and only for the accounts with `tag`, when given. It returns totals, per hour of the day and per day
(browsers in the app and making changes, each counted once a day), per account (with minutes on each page, by the
last page a browser opened, and minutes making changes on each day), the tutorial per lesson, and pages; `long=true`
adds a row per account, day and measure. Eight weeks of 36 groups (about 140,000 events) take under half a second.
`tests/test_usage.py` covers it.

`app/traffic.py` counts bytes in (request bodies) and out (response bodies, after compression: it is the outermost
middleware) per hour, account and kind (`uploads`, `media`, `exports`, `live`, `data`, `app`, from the path), as
totals in `traffic`, kept and deleted with the usage events. A request counts for the account `current_user`
found, or else for the account whose session cookie it carries (remembered in memory, keyed by a hash of the
token, at login and on every checked request), or for nobody. `GET /admin/traffic` adds it up for a period and tag
like the usage report, with the busiest hour.

## Progress report

`app/progress.py` reads how far each account (not administrators) has got from its projects, not from the usage log,
so it is not affected by the keeping time: per project, videos and their minutes, videos analysed, analyses (failed,
running, and videos whose latest analysis failed), the settings of the stable-screen engine changed from their
defaults, and, from each video's working analysis (of its completed analyses, the one with the most decisions), steps
found, added, accepted, rejected and undecided, accepted steps with a title or notes, and accepted steps with a
screen correction. Each stage (`videos`, `analysed`, `reviewed`, `described`, `pathway`, `exported`) comes with the
date it was reached: the first video, analysis, figure (`figure_downloaded_at` on the run, set the first time a
group downloads one) and kept export, and for reviewed and described the last change to the steps once they were
done. `GET /admin/progress?tag=` returns it; the admin panel decides what counts as done. `tests/test_progress.py`
covers it.

## Shared accounts

An account tagged `shared` (never one with `admin`; the tag is refused there and removed by the migration) is for a
group working under one login, up to about 30 browsers at once. `app/live.py` keeps them in step, in memory, in the
one server process:

- **Live changes.** Every change in a project is announced to the shared accounts that can open it.
  `GET /me/live?after=<seq>&epoch=<epoch>&wait=<seconds>` answers at once with the changes after `seq`, or waits up
  to 25 seconds for one (a long poll, which needs no WebSocket support in the proxy). Each change says what it
  touched (`projects`, `project`, `project_deleted`, `recording`, `run`, `candidate` with the step as it now is,
  `settings`) and which browser made it (`by`, the `X-Stepthrough-Client` header every change carries). The answer
  has `reset` when the browser cannot catch up from the last 1,000 changes or the server restarted (a new `epoch`):
  it then loads everything again. Answers also give `presence` and `busy` below.
- **Presence.** `PUT /me/presence` with `{"targets": [...]}` says what a browser is doing: editing a step's text
  (`{"kind": "editing", "run_id", "candidate_id"}`) or uploading (`{"kind": "uploading", "project_id", "name",
  "progress"}`). It lasts 25 seconds unless repeated; `[]` ends it. Of two browsers editing one step, the one that
  began first (`since`) holds it, and the others show its text read-only.
- **Busy work.** Adding a step by hand, carrying a review over, merging pathway screens and exporting are listed
  in `busy` while they run, for the banner on the task.
- **One change at a time per task** (for every account): changes to a task's steps wait for one another rather
  than interleave, so that renumbering the steps cannot write back a decision made meanwhile. One waiting longer
  than 30 seconds gets a 409. `POST /runs/{id}/candidates/status` sets the status of several steps in one change.
- **Conflicts.** `PATCH /candidates/{id}` takes `previous_title` and `previous_notes`, and `PATCH /projects/{id}`
  and `PATCH /recordings/{id}` take `previous_name` and `previous_filename`: in a shared account a change made from
  text that someone else has changed since is refused (409) instead of written over theirs. Decisions and screen
  choices are simply the latest.
- **Passwords.** `POST /me/password` is refused (403) for a shared account, since it logs out the other browsers;
  an administrator gives the account a new link instead.
- **Exports** of a shared account are all kept (`export_bundles.retained`) for ten minutes, even when a newer
  export of the task replaces them, so two people exporting the same task at once each download their own.

`tests/test_shared_accounts.py` covers these, and `tests/test_server_settings.py` the settings and compression.
