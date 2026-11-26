# Stepthrough

**Stepthrough** is a local-first research tool designed to automatically turn video screen recordings into clean, chronological walkthrough screenshots. It is built to help researchers, designers, and developers quickly extract key navigational steps from app runs or usability tests.

[![Latest release](https://img.shields.io/github/v/release/j-nivekk/Stepthrough)](https://github.com/j-nivekk/Stepthrough/releases/latest)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.24159849.svg)](https://doi.org/10.5281/zenodo.24159849)
[![Docker image build](https://github.com/j-nivekk/Stepthrough/actions/workflows/docker.yml/badge.svg?branch=main)](https://github.com/j-nivekk/Stepthrough/actions/workflows/docker.yml)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python Backend](https://img.shields.io/badge/backend-FastAPI%20%2B%20OpenCV-3776AB.svg)
![React Frontend](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61DAFB.svg)


## Features

- **Stable-Screen Detection**: Every screen that stays still for a moment becomes a step, with one settled screenshot each. Settings are in milliseconds and screen share, so they can be reported in a methods section.
- **Local-First & Private**: Everything stays on your machine. Data, recordings, and extracted frames process and save directly to your local `./data` folder.
- **Optional Text Recognition**: Reads the text on every screenshot on your own machine, to show, search and export it.
- **Chronological Review Board**: An intuitive GUI to accept, reject, rename, and add notes to candidate screenshots while preserving original chronology.
- **Pathways**: The accepted steps drawn as a chart of screens and the moves between them, ready to finish as an SVG figure or to use as a PNG image, with a hands-on tutorial in the app.
- **Run Comparison**: Run a recording again with other settings, see side by side what changed, and carry your review over to the new run.
- **Rich Exports**: Bundle your accepted walkthrough steps seamlessly into `PNG`s + `CSV` + `JSON` manifests.

---

## Why Use Screen Recordings Instead Of Taking Screenshots Live?

For walkthrough-driven research, screen recordings are often a better capture medium than trying to take screenshots manually during a session.

Why:

- **They preserve the whole interaction**: You are not limited to the moments you remembered to capture.
- **They capture dynamic interfaces**: Scrolling, fading, flashing, loading, overlays, and other transient states remain available for later review.
- **They reduce interruption**: Researchers do not need to awkwardly stop and reach for screenshot buttons or shortcuts while observing a task.
- **They support backtracking**: If you missed a moment during the session, you can revisit the recording later.
- **They fit informal, fast-moving interfaces**: Feeds, threads, short-form video apps, and prototypes often contain meaningful states that do not exist as one stable screen.

Stepthrough is built around that workflow: record first, then review and curate the meaningful steps afterward.

---

## Quickest start: Docker

With [Docker Desktop](https://www.docker.com/products/docker-desktop/) running, on Windows or Mac:

```bash
mkdir Stepthrough
cd Stepthrough
curl -fsSLO https://raw.githubusercontent.com/j-nivekk/Stepthrough/main/compose.yaml
echo STEPTHROUGH_AUTH=none>>.env
docker compose up -d
```

Then open `http://localhost:8080`. The `.env` line tells Stepthrough it runs for you alone, so it opens without a
login. The [Installing and starting](https://github.com/j-nivekk/Stepthrough/wiki/Installing-and-Starting) wiki page
(also in [`docs/wiki/Installing-and-Starting.md`](docs/wiki/Installing-and-Starting.md)) explains every step,
including updates, text recognition and what to do if something goes wrong. To run Stepthrough from the source code
instead, read on.

---

## Requirements

To run Stepthrough from source, you must have the following installed on your system:
- **Node.js 20.19+** (or 22.12+)
- **FFmpeg & FFprobe 5.1+**: Required for video frame extraction.
  - *Mac:* `brew install ffmpeg`
  - *Ubuntu/Debian:* `sudo apt install ffmpeg` (Ubuntu 22.04's FFmpeg 4.4 is too old)
  - *Windows:* `winget install --id Gyan.FFmpeg -e`
- **[uv](https://github.com/astral-sh/uv)**: Manages the Python dependencies, and installs Python 3.11+ if you do not have it.

On Windows, `setup.sh` and `start.sh` do not run; the
[From the source code](https://github.com/j-nivekk/Stepthrough/wiki/Installing-and-Starting#from-the-source-code)
wiki section gives the commands to type instead.

---

## Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/j-nivekk/stepthrough.git
   cd stepthrough
   ```

2. **One-Command Setup:**
   Run the included setup script to automatically install both frontend and backend dependencies using `npm` and `uv` respectively:
   ```bash
   chmod +x setup.sh start.sh
   ./setup.sh
   ```
   *(To install manually instead: `cd backend && uv sync`, then `cd frontend && npm install`.)*

---

## Running Locally

You can spin up both the frontend and backend servers easily with the provided start script.

**Quick Start:**
```bash
./start.sh
```

By default, the backend runs at `http://127.0.0.1:8000` and the frontend at `http://127.0.0.1:5173`. The application stores all local data in `./data` at the project root. You can specify a custom data path by prefixing the backend process with `STEPTHROUGH_DATA_ROOT=/path/to/my/data`.

*(To run them manually in separate terminal windows, you can simply use: `cd backend && uv run uvicorn app.main:app --reload` and `cd frontend && npm run dev`)*

### On a server

A Docker image runs Stepthrough for a group, behind a web server such as nginx. The
[Server deployment (Docker)](https://github.com/j-nivekk/Stepthrough/wiki/Server-Deployment-Docker) wiki page
(also in [`DEPLOY.md`](DEPLOY.md)) covers installing, configuring, upgrading and backing it up.

---

## Releases and builds

Each release is listed on the [releases page](https://github.com/j-nivekk/Stepthrough/releases), with what changed
and how to upgrade. The Docker images are at `ghcr.io/j-nivekk/stepthrough`:

| tag | what it is |
|---|---|
| `stable` | the latest release |
| `1.5.1`, `1.5` | a release, or the latest of a series, to stay on a known version |
| `edge` | the latest build of `main`; the app shows `edge` at the bottom right and its commit under **about** |

Text recognition came in an image of its own, with `-ocr` behind the tag, up to 1.4.5. Every image has it now, and the
`-ocr` tags are other names for the same images.

The [Docker image workflow](.github/workflows/docker.yml) builds the image, runs the backend tests and an end-to-end
smoke test in it, and only then publishes. It runs for:

- a push to `main` that changes the app, its tests or the image (it publishes `edge`). Changes to documentation and
  other files outside the image skip it, and so does any commit with `[skip ci]` in its message;
- a version tag such as `v1.5.1` (it publishes the release images and moves `stable`);
- pull requests that change the app (tests only).

**To release:** set the new version in `backend/app/__init__.py`, `backend/pyproject.toml` and
`frontend/package.json` (a test checks they match), commit, push a tag such as `v1.5.1`, and write the release notes
on GitHub. `docs/wiki/Server-Deployment-Without-Docker.md` names the latest release in its checkout commands, and
`README_IF_DOWNLOADED_FROM_ZENODO.md` the archived version: update both.

---

## Project Structure

- `/backend`: The FastAPI application. Handles SQLite database operations, step detection, manual screenshot extraction, FFmpeg calls, and the export pipeline.
- `/frontend`: The Vite + React user interface. Handles video importing, review boards, step annotation, and configuration forms.
- `/data`: Auto-generated on launch. Contains the `stepthrough.sqlite3` manifest alongside imported MP4 videos and extracted screenshots.

---

## Documentation

- **[Stepthrough Wiki](https://github.com/j-nivekk/Stepthrough/wiki)** (source in [`docs/wiki/`](docs/wiki/), indexed
  in [`GUIDE.md`](GUIDE.md) and [`DEPLOY.md`](DEPLOY.md)): installation, first walkthrough tutorial, settings, review,
  command bar, text recognition, pathways, exports, server deployment, evaluation and internals.
- In the app, **about → how it works** shows the analysis of a sample recording, step by step, and **about → how
  to work with pathways** is a hands-on tutorial on the pathway chart.
- [`docs/evaluation.md`](docs/evaluation.md): how well the detection works, how it was tested, and where it
  fails.
- [`backend/README.md`](backend/README.md): the detection engine, its settings, the export format and parts of the
  API, for developers.
- [`DEPLOY.md`](DEPLOY.md): running the Docker image on a server.

---

## Credits

Created and maintained by **H. "Kevin" Jin** at the **University of Amsterdam**.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

> *Note: Stepthrough runs FFmpeg as a separate program and does not link it into its own code. Run from source, it uses
> the FFmpeg you install; the Docker image includes Debian's FFmpeg package, which keeps its own licence (LGPL/GPL).*
