# Stepthrough

Stepthrough is a local-first research tool for turning screen recordings into chronological walkthrough screenshots.

## Stack
- Frontend: React + TypeScript + Vite
- Backend: FastAPI + SQLite + FFmpeg + PySceneDetect

## What It Does
- Creates local research projects and imports existing phone or desktop recordings.
- Runs scene detection with a tunable tolerance, minimum scene gap, sampling rate, and detector mode.
- Extracts candidate screenshots, flags likely revisit loops, and keeps chronology intact.
- Lets you accept/reject screenshots, rename steps, add notes, and export `PNG + CSV + JSON` bundles.

## Project Layout
- [`backend`](/Users/kevin/Dev/Stepthrough/backend): FastAPI API, SQLite storage, scene detection, export pipeline
- [`frontend`](/Users/kevin/Dev/Stepthrough/frontend): React review UI and local workflow
- `data/`: Local project database, imported recordings, extracted frames, and exports

## Development
1. Install backend dependencies:
   - `cd backend && uv sync`
2. Install frontend dependencies:
   - `cd frontend && npm install`
3. Start the backend:
   - `cd backend && uv run uvicorn app.main:app --reload`
4. Start the frontend:
   - `cd frontend && npm run dev`

The backend runs at `http://127.0.0.1:8000` and the frontend at `http://127.0.0.1:5173`.

The app stores all local data in `./data` by default. You can override that with `STEPTHROUGH_DATA_ROOT=/path/to/data`.
