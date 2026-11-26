Stepthrough also runs straight from a checkout, for servers where Docker is not an option, such as a Linux container
(LXC). With `STEPTHROUGH_DEPLOYMENT=server` it behaves as the image does: people log in, the database reset is
off and analyses wait their turn. Everything under [Web server](Server-Deployment-Docker.md#web-server) and
[Managing accounts](Managing-Accounts.md) applies too.

## Install and build

You need Git, [uv](https://docs.astral.sh/uv/) (which brings the right Python), Node.js 20.19 or later to build the
interface, and FFmpeg 5.1 or later. Give Stepthrough an account of its own that owns the checkout; the commands
below run as that account, from its home folder. Data goes to `data/` in the checkout (`STEPTHROUGH_DATA_ROOT`
moves it).

```bash
git clone https://github.com/j-nivekk/Stepthrough.git && cd Stepthrough
git checkout v1.5.1                                           # the latest release
(cd backend && uv sync)                                       # leave text recognition out with --no-group ocr
(cd frontend && npm ci && VITE_API_BASE_URL= npm run build)
```

The empty `VITE_API_BASE_URL` makes the interface talk to the address it was loaded from, which is right when
Stepthrough serves it itself. Keep it empty even if `frontend/.env` sets it.

## Running as a systemd service

[`docker/stepthrough.service`](https://github.com/j-nivekk/Stepthrough/blob/main/docker/stepthrough.service) runs
Stepthrough as a systemd service of that account: it starts at boot, restarts after a crash and logs to the journal.
Install it once:

```bash
sudo loginctl enable-linger stepthrough                       # as root: start this account's services at boot
mkdir -p ~/.config/systemd/user
cp docker/stepthrough.service ~/.config/systemd/user/         # then set your address and paths in the copy
systemctl --user daemon-reload
systemctl --user enable --now stepthrough
curl -fsS http://127.0.0.1:8080/health
```

It listens on `127.0.0.1:8080`, where
[`docker/nginx.conf.example`](https://github.com/j-nivekk/Stepthrough/blob/main/docker/nginx.conf.example) expects it.
If the web server runs on another machine, the comments in the service file say what to change. In that case, let only
the web server reach the port: Stepthrough takes the visitor's address from the web server's `X-Forwarded-For`
header, which anyone reaching the port directly could write. Set `STEPTHROUGH_PUBLIC_URL` to the `https` address
in the service file, so the login cookie stays on HTTPS even when the web server does not pass on the scheme.

From then on the account looks after it, without root:

```bash
systemctl --user restart stepthrough
systemctl --user status stepthrough
journalctl --user -u stepthrough -f                           # the log, with logins and refused attempts
```

The account commands run from `backend/`, for example `uv run python -m app.users add yourname --admin --password`
for the first administrator. For whole links in what they print, set the address in that account's shell too:
`echo 'export STEPTHROUGH_PUBLIC_URL=https://stepthrough.example.org' >> ~/.profile`.

## Text recognition models

Text recognition downloads its models (23 MB) from Hugging Face the first time text is read, into
`data/ocr-models/ppocrv6`. For a server without access to it, `uv run python -m app.services.text_models FOLDER` (from
`backend/`) gets them on another computer; copy them to that folder of the data. `STEPTHROUGH_OCR_MODELS` names another
folder, and `STEPTHROUGH_OCR_MODEL_URL` another server with the same files.

## Upgrade and backups

To upgrade, check out the new release, update both parts and restart:

```bash
git fetch --tags && git checkout v1.5.2                       # the new release
(cd backend && uv sync)                                       # with the same options as before
(cd frontend && npm ci && VITE_API_BASE_URL= npm run build)
systemctl --user restart stepthrough
```

As with Docker, a restart ends running analyses, and database changes are applied at start-up. For backups,
`uv run python -m app.backup` (from `backend/`) copies the database into `data/backups/` while Stepthrough runs;
for everything, stop the service and archive `data/`.

## How the Docker image differs from running from source

With `STEPTHROUGH_DEPLOYMENT=server`, running from source behaves the same as the Docker image in all but the last
point:

- It serves the interface and the API from one address, so no cross-origin settings are needed.
- People log in (`STEPTHROUGH_AUTH=password`); from source, the app has no logins unless that is set.
- The database reset in **settings** is switched off.
- At most `STEPTHROUGH_MAX_CONCURRENT_RUNS` analyses run at once (or what an administrator set under **server**); later
  ones show as `queued` and start in order.
- It runs as one process, because live progress and the run queue are kept in memory. Restarting ends active runs.
- The container runs as an unprivileged user with no extra Linux capabilities. Logs go to Docker
  (`docker compose logs -f`), rotated at 5 × 10 MB.

Still to come: sharing a project with other people from the app, and analysis in a separate worker that survives
restarts.
