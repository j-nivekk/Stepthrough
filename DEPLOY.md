# Running Stepthrough on a server

Stepthrough runs as one Docker container that holds the web interface, the API and the analysis. Everything it stores
is kept in one Docker volume. A web server on the host (nginx in the examples) adds HTTPS and the domain name.
Settings go in a `.env` file next to `compose.yaml`, and new versions come as a published image that you fetch with
`docker compose pull`.

To run Stepthrough on your own computer instead, see section 3 of [`GUIDE.md`](GUIDE.md#3-installing-and-starting-stepthrough).

People log in with accounts that administrators make (see [Accounts](#accounts)). Each person's projects are
theirs: others cannot see them, except the server's administrators.

## What you need

- A Linux server with Docker Engine and the Compose plugin (`docker compose version` prints 2.17 or later).
- A web server with a TLS certificate for a subdomain, for example `stepthrough.example.org`. Stepthrough must sit at
  the root of its domain; a path such as `example.org/stepthrough/` does not work.
- CPU: each analysis keeps one or two cores busy while it runs. `STEPTHROUGH_MAX_CONCURRENT_RUNS` (default 2) sets how
  many run at once; the rest wait in line.
- Disk: about twice the size of everything uploaded. Each recording is kept as uploaded, plus a working copy used for
  analysis and previews, plus screenshots and exports.

## Install

```bash
mkdir stepthrough && cd stepthrough
curl -fsSLO https://raw.githubusercontent.com/j-nivekk/Stepthrough/main/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/j-nivekk/Stepthrough/main/.env.example
docker compose up -d --wait
curl -fsS http://127.0.0.1:8080/health
```

`--wait` returns once the container reports itself healthy. The app now listens on `127.0.0.1:8080`, reachable only
from the server itself, until the web server is set up.

Then make yourself the first administrator. It asks for your password twice:

```bash
docker compose exec stepthrough python -m app.users add yourname --admin --password
```

## Settings

Edit `.env`, then apply it with `docker compose up -d --wait`. Every setting is optional.

| setting | default | meaning |
|---|---|---|
| `STEPTHROUGH_TAG` | `stable` | image version: `stable` (latest release), a release such as `1.0.0`, or `edge` (latest from `main`) |
| `STEPTHROUGH_BIND_ADDRESS` | `127.0.0.1` | host address to listen on; keep `127.0.0.1` behind a web server |
| `STEPTHROUGH_PORT` | `8080` | host port |
| `STEPTHROUGH_MAX_CONCURRENT_RUNS` | `2` | analyses that run at once; `0` is no limit |
| `STEPTHROUGH_MAX_UPLOAD_MB` | `1024` | largest recording accepted; nginx's `client_max_body_size` must be at least this |
| `STEPTHROUGH_CPUS`, `STEPTHROUGH_MEMORY` | `0` (no limit) | caps for the container, for example `4` and `8g`, so analyses cannot starve other tools on the host |
| `STEPTHROUGH_VOLUME` | `stepthrough_data` | name of the Docker volume with all data |
| `STEPTHROUGH_OCR_MODEL_SOURCE` | `auto` | where the text recognition image downloads its models (`auto`, `huggingface`, `bos`) |
| `STEPTHROUGH_PUBLIC_URL` | unset | the address people open, such as `https://stepthrough.example.org`; the command line prints password links with it |
| `STEPTHROUGH_AUTH` | `password` | whether people log in. Keep `password` on a server; `none` (no logins, everyone is an administrator) is only for Stepthrough on one person's own computer |

## Web server

[`docker/nginx.conf.example`](docker/nginx.conf.example) is a complete site configuration. Beyond the usual proxy
settings, Stepthrough needs three things from the web server:

- an upload limit (`client_max_body_size`) at least as large as `STEPTHROUGH_MAX_UPLOAD_MB`;
- WebSocket upgrades (the `Upgrade` and `Connection` headers), which carry live progress while a run works;
- long timeouts and no request buffering, so large uploads and long runs are not cut off.

The example also does three things for security. It **replaces** `X-Forwarded-For` with the visitor's address
instead of adding to it, so login limits count real addresses (another web server must do the same). It limits
login attempts per address before they reach Stepthrough (`limit_req`; raise it if many people share one
address, as on a campus network). And it tells browsers to use only HTTPS for the address (HSTS).

Then check the whole chain from outside, using the smoke test from the repository. It logs in, uploads a short
generated recording, analyses it, exports it and deletes it again:

```bash
curl -fsSLO https://raw.githubusercontent.com/j-nivekk/Stepthrough/main/docker/smoke_test.py
python3 smoke_test.py https://stepthrough.example.org --user yourname   # asks for your password; needs ffmpeg
docker compose exec -T stepthrough python - < smoke_test.py   # or inside the container, without the web server
```

Inside the container, the smoke test makes a throwaway account for itself and deletes it at the end.

## Accounts

Administrators look after accounts on the users page: open the menu with your name at the bottom right, then
**manage users**. Nobody can sign up on their own.

- **Adding people.** Type the name they will log in with, optionally with tags and a deletion date, and give them
  the link that appears. With the link they choose their own password; it works once, for 14 days.
  Common passwords, and passwords containing their name, are refused.
- **Importing a list.** A CSV file in the layout of 4CAT's bulk user import works as it is: a `name` column, and
  optionally `expires` (a date as `2027-02-01`), `tags`, `password` and `notes`. Everyone without a password gets
  a link, and the page offers all of them as a CSV, ready for a mail merge. Passwords in the list are kept as
  given, even weak ones (the result lists who has one); people's own new passwords follow the rules.
- **Forgotten passwords.** Give the person a new link (**reset link** on their row). It works for 3 days, and
  earlier links stop working.
- **Deletion dates.** From an account's deletion date, the account and the projects only it owns are deleted.
  People see a notice in the month before. Accounts without a date are kept until an administrator deletes them.
- **Switching off** an account logs it out at once and keeps its projects.
- **Guessing.** After too many wrong passwords, further attempts wait 15 minutes; see the log for who and from
  where: `docker compose logs stepthrough | grep -E "Wrong|Refused"`.

The same can be done from the command line, which also lists accounts with when they were last seen:

```bash
docker compose exec stepthrough python -m app.users list
docker compose exec stepthrough python -m app.users link yourname          # a new password link
docker compose exec -T stepthrough python -m app.users import /dev/stdin --tag group-a < people.csv > links.csv
docker compose exec stepthrough python -m app.users --help                 # everything else
```

**Upgrading from a version without accounts.** Projects made before then belong to a built-in account that nobody
logs in with, so they appear in nobody's list. Take them over with **take over its projects** on the built-in
account's row, or `docker compose exec stepthrough python -m app.users transfer local yourname`.

## Upgrade

```bash
docker compose pull && docker compose up -d --wait
```

Data lives in the volume and survives upgrades. Database changes are applied automatically at start-up. A restart
ends analyses that are still running; they show as interrupted and can be started again, so upgrade when nobody is
using it. To stay on a known version, set `STEPTHROUGH_TAG` to a release number instead of `stable`.

To see which version a server runs, look at the bottom right of the app: a release shows `v 1.0.0`, a build of
`main` adds `edge` and its commit (`v 1.0.0 · edge 80892ff`). `/health` reports the same as `version` and `build`.

## Back up and restore

Everything is in the volume: the database (`stepthrough.sqlite3`) and, under `projects/`, the recordings,
screenshots and exports. The simplest consistent backup stops the app for a moment:

```bash
docker compose stop
docker run --rm -v stepthrough_data:/data:ro -v "$PWD":/backup debian:trixie-slim \
  tar czf /backup/stepthrough-$(date +%F).tar.gz -C /data .
docker compose start
```

To copy only the database while the app keeps running, use SQLite's backup function rather than copying the file
(recent changes may still be in `stepthrough.sqlite3-wal`). The copy is written to `backups/` in the volume:

```bash
docker compose exec stepthrough python -m app.backup
```

To restore an archive into an empty volume:

```bash
docker compose down
docker run --rm -v stepthrough_data:/data -v "$PWD":/backup debian:trixie-slim \
  sh -c 'tar xzf /backup/stepthrough-2026-11-07.tar.gz -C /data && chown -R 10001:10001 /data'
docker compose up -d --wait
```

## Text recognition (OCR)

Reading the text of each screenshot into exports needs PaddleOCR, which adds well over a gigabyte, so it comes in a
separate image: set `STEPTHROUGH_TAG=stable-ocr` (or add `-ocr` to any other tag). This image is for x86-64 (Intel
and AMD) machines only: PaddlePaddle publishes no packages for ARM Linux, and the x86-64 image does not work under
emulation. The first run with text recognition downloads its models into the volume, so the server needs internet
access. To check it end to end, add `--ocr` to the smoke test:
`docker compose exec -T stepthrough python - --ocr < smoke_test.py`.

Recognition runs without PaddlePaddle's oneDNN acceleration, which is broken on x86-64 in PaddlePaddle 3.3.0, so it
is slower than it could be. The known PaddlePaddle version bugs are listed in
[`backend/README.md`](backend/README.md#paddlepaddle-version-bugs).

## Build the image yourself

```bash
git clone https://github.com/j-nivekk/Stepthrough.git && cd Stepthrough
docker compose up -d --build --wait                                  # build and run this checkout
STEPTHROUGH_WITH_OCR=true docker compose build                       # the text recognition variant
docker build -f docker/Dockerfile --target test -t stepthrough:test . && docker run --rm stepthrough:test   # backend tests
```

The build uses only what the image needs (see `.dockerignore`), so recordings in a local `data/` folder never end up
in it.

## How the Docker image differs from running Stepthrough from source

- It serves the interface and the API from one address, so no cross-origin settings are needed.
- People log in (`STEPTHROUGH_AUTH=password`); from source, the app has no logins unless that is set.
- The database reset in **settings** is switched off.
- At most `STEPTHROUGH_MAX_CONCURRENT_RUNS` analyses run at once; later ones show as `queued` and start in order.
- It runs as one process, because live progress and the run queue are kept in memory. Restarting ends active runs.
- The container runs as an unprivileged user with no extra Linux capabilities. Logs go to Docker
  (`docker compose logs -f`), rotated at 5 × 10 MB.

Still to come: sharing a project with other people from the app, and analysis in a separate worker that survives
restarts.
