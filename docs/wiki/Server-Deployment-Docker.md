Stepthrough runs as one Docker container that holds the web interface, the API and the analysis. Everything it stores
is kept in one Docker volume. A web server on the host (nginx in the examples) adds HTTPS and the domain name.
Settings go in a `.env` file next to `compose.yaml`, and new versions come as a published image that you fetch with
`docker compose pull`.

To run Stepthrough on your own computer instead, see [Installing and starting Stepthrough](Installing-and-Starting.md).
On a server without Docker, see [Server deployment (without Docker)](Server-Deployment-Without-Docker.md).

People log in with accounts that administrators make (see [Managing accounts](Managing-Accounts.md)). Each person's
projects are theirs: others cannot see them, except the server's administrators.

## What you need

- A Linux server with Docker Engine and the Compose plugin (`docker compose version` prints 2.17 or later).
- A web server with a TLS certificate for a subdomain, for example `stepthrough.example.org`. Stepthrough must sit at
  the root of its domain; a path such as `example.org/stepthrough/` does not work.
- CPU: each analysis keeps one or two cores busy while it runs. `STEPTHROUGH_MAX_CONCURRENT_RUNS` (default 2) sets how
  many run at once; the rest wait in line. Analyses share the server's one process, so more cores do not make more
  of them at once faster: beyond two or three, they mostly slow the app down for everyone.
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
| `STEPTHROUGH_TAG` | `stable` | image version: `stable` (latest release), a release such as `1.5.1`, or `edge` (latest from `main`) |
| `STEPTHROUGH_BIND_ADDRESS` | `127.0.0.1` | host address to listen on; keep `127.0.0.1` behind a web server |
| `STEPTHROUGH_PORT` | `8080` | host port |
| `STEPTHROUGH_MAX_CONCURRENT_RUNS` | `2` | analyses that run at once; `0` is no limit. Administrators can change it while the server runs (see [Managing accounts](Managing-Accounts.md#server-settings)) |
| `STEPTHROUGH_MAX_UPLOAD_MB` | `1024` | largest recording accepted; nginx's `client_max_body_size` must be at least this |
| `STEPTHROUGH_MAX_PROJECT_FILE_MB` | `4096` | largest project file brought in at once (a whole project, every video in it; never less than the upload limit); nginx's limit for the project-file paths must be at least this. A download larger than this is warned about, as it could not come back |
| `STEPTHROUGH_CPUS`, `STEPTHROUGH_MEMORY` | `0` (no limit) | caps for the container, for example `4` and `8g`, so analyses cannot starve other tools on the host |
| `STEPTHROUGH_VOLUME` | `stepthrough_data` | name of the Docker volume with all data |
| `STEPTHROUGH_PUBLIC_URL` | unset | the address people open, such as `https://stepthrough.example.org`; the command line prints password links with it, and an `https` address keeps the login cookie to HTTPS |
| `STEPTHROUGH_AUTH` | `password` | whether people log in. Keep `password` on a server; `none` (no logins, everyone is an administrator) is only for Stepthrough on one person's own computer |

## Web server

[`docker/nginx.conf.example`](https://github.com/j-nivekk/Stepthrough/blob/main/docker/nginx.conf.example) is a
complete site configuration. Beyond the usual proxy settings, Stepthrough needs three things from the web server:

- an upload limit (`client_max_body_size`) at least as large as `STEPTHROUGH_MAX_UPLOAD_MB`, and a larger one, at
  least `STEPTHROUGH_MAX_PROJECT_FILE_MB`, for the project-file paths (`/projects/project-file` and
  `/projects/<id>/project-file`), whose downloads are also passed on unbuffered, as they are made while they go;
- WebSocket upgrades (the `Upgrade` and `Connection` headers), which carry live progress while a run works;
- long timeouts and no request buffering, so large uploads and long runs are not cut off. Browsers of a shared
  account also wait up to 25 seconds at a time for each other's changes (`/me/live`), so the read timeout must be longer.

Stepthrough compresses its data, pages and scripts itself, so the web server need not (it leaves them alone once
compressed).

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

## Upgrade

```bash
docker compose pull && docker compose up -d --wait
```

Data lives in the volume and survives upgrades. Database changes are applied automatically at start-up. A restart
ends analyses that are still running; they show as interrupted and can be started again, so upgrade when nobody is
using it. To stay on a known version, set `STEPTHROUGH_TAG` to a release number instead of `stable`.

To see which version a server runs, look at the bottom right of the app: a release shows `v 1.5.1`, a build of
`main` adds `edge` (`v 1.5.1 · edge`). **about** there also names the commit it was built from (`55b864b`, or
`55b864b modified` for a checkout with uncommitted changes). `/health` reports the same as `version` and `build`.

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

The text on every screenshot can be read, to show, search and export it. The image has all it needs for that, on
x86-64 and ARM alike, the models included, so nothing is downloaded. Reading never holds anyone up, whoever asks for it:

- An analysis does not read text. Its steps are there first, and their text follows; people can also ask for the text
  of a run afterwards.
- It is read in a process of its own (a **text reader**), at low priority, one screenshot at a time. However many runs
  wait, there is one reader unless an administrator sets more, and the runs take turns: four screenshots of one, then
  the next. A reader uses up to 1 GB while there is something to read, and ends a minute after.
- What is still to be read survives a restart.

Administrators set how many readers there may be and how many threads each uses in the admin panel under **server**;
0 readers turns text recognition off. The default is one reader with half the processor's cores, at most four. More
threads make one run faster, more readers keep more runs going; on an Apple M4, one reader with four threads reads
a phone screenshot in 0.2 seconds and a full desktop window in 0.8.

To check it end to end, add `--ocr` to the smoke test:
`docker compose exec -T stepthrough python - --ocr < smoke_test.py`.

Up to 1.4.5, text recognition was another engine in an image of its own, with `-ocr` behind the tag. Those tags are now
other names for the same images; change `STEPTHROUGH_TAG=stable-ocr` to `stable` when convenient. The settings
`STEPTHROUGH_WITH_OCR` and `STEPTHROUGH_OCR_MODEL_SOURCE` are not used any more, and the old engine's models, the folder
`ocr-models/paddleocr3` in the data volume, can be deleted.

## Build the image yourself

```bash
git clone https://github.com/j-nivekk/Stepthrough.git && cd Stepthrough
docker compose up -d --build --wait                                  # build and run this checkout
docker build -f docker/Dockerfile --target test -t stepthrough:test . && docker run --rm stepthrough:test   # backend tests
```

The build uses only what the image needs (see `.dockerignore`), so recordings in a local `data/` folder never end up
in it. It downloads the text recognition models (23 MB) from Hugging Face.
