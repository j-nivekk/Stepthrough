# Stepthrough

Stepthrough is a local-first research tool for turning screen recordings into chronological walkthrough screenshots.

## Quick Start (New!)

To get started quickly, run the setup and start scripts:

1. **Setup**: Install all dependencies and check for prerequisites:
   ```bash
   ./setup.sh
   ```
2. **Start**: Run both the background and frontend in one command:
   ```bash
   ./start.sh
   ```

Visit the app at [localhost:5173](http://localhost:5173).

---

## Prerequisites

Ensure you have the following installed:
- [Node.js & npm](https://nodejs.org/en/download/) (for the frontend)
- [FFmpeg](https://ffmpeg.org/download.html) (for video processing)
- [uv](https://github.com/astral-sh/uv) (for the backend environment)

## Stack
- **Frontend**: React + TypeScript + Vite
- **Backend**: FastAPI + SQLite + FFmpeg + PySceneDetect

## Features
- Creates local research projects and imports existing recordings.
- Runs scene detection with tunable parameters (tolerance, sampling rate, etc.).
- Extracts candidate screenshots, flags loops, and keeps chronology.
- Rename steps, add notes, and export `PNG + CSV + JSON` bundles.

## Project Layout
- [`backend`](./backend): FastAPI API, SQLite storage, scene detection
- [`frontend`](./frontend): React review UI and local workflow
- `data/`: Local project database, recordings, and exports (auto-created on start)

## Manual Development

If you prefer to run things manually:

1. **Backend**:
   ```bash
   cd backend
   uv sync
   uv run uvicorn app.main:app --reload
   ```
2. **Frontend**:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

The backend runs at `localhost:8000` and the frontend at `localhost:5173`.

The app stores all local data in `./data` by default. You can override that with `STEPTHROUGH_DATA_ROOT=/path/to/data`.

