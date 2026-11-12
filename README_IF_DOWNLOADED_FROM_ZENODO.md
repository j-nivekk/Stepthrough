# Downloaded Stepthrough from Zenodo?

**This is an archival copy of Stepthrough 1.1.0. For the latest versions, fixes, documentation and support, visit [Stepthrough on GitHub](https://github.com/j-nivekk/Stepthrough).**

- [Latest release](https://github.com/j-nivekk/Stepthrough/releases/latest)
- [All releases and release notes](https://github.com/j-nivekk/Stepthrough/releases)
- [Report a bug or ask for help](https://github.com/j-nivekk/Stepthrough/issues)

The files in this download preserve one version of the software. They do not update when the GitHub project
changes. Use this copy when you need the archived version for citation, inspection or reproduction; use GitHub
when you want the maintained version.

## What is included

Stepthrough turns screen recordings into reviewable walkthrough steps and interface pathways. It detects stable
screens, supports manual review and annotation, and exports screenshots, step data and pathway diagrams.

This source archive includes:

- the FastAPI backend and React/Vite frontend, including Pathways;
- Python and JavaScript dependency lockfiles;
- tests and code for generating synthetic evaluation recordings;
- Docker build files, local launch scripts and deployment examples;
- the user guide, evaluation documentation, citation metadata and licences;
- `ARCHIVE_INFO.json`, describing the source snapshot and its provenance;
- `SHA256SUMS`, containing a SHA-256 checksum for every other file in the archive.

Recordings, research data, databases, accounts, deployment credentials, installed dependencies, OCR model weights,
build output and Git history are not included. The evaluation code generates its own synthetic recordings.

## Run this archived version

Extract the ZIP and open a terminal in its `Stepthrough-1.1.0` directory. The commands below use the source in
this download. The main README also describes getting the current code or a published container image; those
routes can select a different version.

### With Docker

With Docker running, build the image from the extracted files:

```bash
docker build -f docker/Dockerfile --build-arg VERSION=1.1.0 -t stepthrough-archive:1.1.0 .
docker volume create stepthrough-archive-1-1-0-data
docker run --rm --name stepthrough-archive-1-1-0 -p 127.0.0.1:8080:8000 -e STEPTHROUGH_AUTH=none -v stepthrough-archive-1-1-0-data:/data stepthrough-archive:1.1.0
```

Open <http://localhost:8080>. These settings are for one person's local computer. For a shared server with
accounts, follow [DEPLOY.md](DEPLOY.md). Data remains in the named Docker volume after the container stops.

### From source

Install Node.js 20.19+ (or 22.12+), FFmpeg/FFprobe 5.1+, and [uv](https://docs.astral.sh/uv/). `uv` can install
the required Python version if needed. Use the included lockfiles:

```bash
cd backend
uv sync --frozen
cd ../frontend
npm ci
```

From the extracted archive directory, start the backend in one terminal:

```bash
cd backend
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Start the frontend in another terminal:

```bash
cd frontend
npm run dev
```

Open <http://localhost:5173>. See [GUIDE.md](GUIDE.md) for the workflow and optional text recognition.

Installation and Docker builds require access to package registries. The lockfiles preserve application
dependency versions; this is a source archive, not a self-contained offline environment. Operating-system
packages, Docker base-image tags and optional OCR model downloads can change independently of the archived code.

## Check the archive and run tests

From the extracted archive directory, verify file checksums on macOS with:

```bash
shasum -a 256 -c SHA256SUMS
```

On Linux, use `sha256sum -c SHA256SUMS` instead. The manifest excludes itself.

After installing dependencies, run the backend tests from `backend/` with `uv run pytest -q`, and the frontend
regression tests from `frontend/` with `npm test`. `npm run build` checks the frontend types and builds it.
The optional PaddleOCR smoke tests need the model setup documented in [backend/README.md](backend/README.md).

## Cite this version

Use the citation and DOI on the Zenodo record associated with this download. [CITATION.cff](CITATION.cff) also
contains the software's author, version and citation metadata. For reproducible work, cite the specific archived
version and record your analysis settings; a link to the latest GitHub branch does not identify a fixed version.

## Licences

Stepthrough's code is distributed under the [MIT licence](LICENSE). The bundled Inter fonts retain their
[SIL Open Font License](frontend/src/assets/fonts/OFL.txt). Dependencies and external tools, including FFmpeg,
retain their own licences.
