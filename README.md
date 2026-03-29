# Stepthrough 🔎

**Stepthrough** is a local-first research tool designed to automatically turn video screen recordings into clean, chronological walkthrough screenshots. It is built to help researchers, designers, and developers quickly extract key navigational steps from app runs or usability tests.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python Backend](https://img.shields.io/badge/backend-FastAPI%20%2B%20PySceneDetect-3776AB.svg)
![React Frontend](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61DAFB.svg)

## 📌 Features

- **Automated Scene Detection**: Define tunable tolerance, sampling rates, and minimum scene gaps to intelligently find UI shifts.
- **Local-First & Private**: Everything stays on your machine. Data, recordings, and extracted frames process and save directly to your local `./data` folder.
- **Hybrid UI-Change Detection**: Optional advanced engine utilizing local OCR (PaddleOCR) and structural similarity comparisons. 
- **Chronological Review Board**: An intuitive GUI to accept, reject, rename, and add notes to candidate screenshots while preserving original chronology.
- **Rich Exports**: Bundle your accepted walkthrough steps seamlessly into `PNG`s + `CSV` + `JSON` manifests.

---

## 🎯 Why Use Screen Recordings Instead Of Taking Screenshots Live?

For walkthrough-driven research, screen recordings are often a better capture medium than trying to take screenshots manually during a session.

Why:

- **They preserve the whole interaction**: You are not limited to the moments you remembered to capture.
- **They capture dynamic interfaces**: Scrolling, fading, flashing, loading, overlays, and other transient states remain available for later review.
- **They reduce interruption**: Researchers do not need to awkwardly stop and reach for screenshot buttons or shortcuts while observing a task.
- **They support backtracking**: If you missed a moment during the session, you can revisit the recording later.
- **They fit informal, fast-moving interfaces**: Feeds, threads, short-form video apps, and prototypes often contain meaningful states that do not exist as one stable screen.

Stepthrough is built around that workflow: record first, then review and curate the meaningful steps afterward.

---

## 🏗 Requirements

To run Stepthrough locally, you must have the following installed on your system:
- **Python 3.11+**
- **Node.js 18+**
- **FFmpeg & FFprobe**: Required for video frame extraction. 
  - *Mac:* `brew install ffmpeg` (or download the static build directly from [FFmpeg for Mac](https://evermeet.cx/ffmpeg/))
  - *Ubuntu/Debian:* `sudo apt install ffmpeg`
  - *Windows:* Available via `winget install ffmpeg` or [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
- **[uv](https://github.com/astral-sh/uv)**: Used to manage Python dependencies blazingly fast.

---

## 🚀 Installation & Setup

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
   *(To install manually instead: `cd backend && uv sync`, then `cd frontend && npm install`)*

---

## 🕹 Running Locally

You can spin up both the frontend and backend servers easily with the provided start script.

**Quick Start:**
```bash
./start.sh
```

By default, the backend runs at `http://127.0.0.1:8000` and the frontend at `http://127.0.0.1:5173`. The application stores all local data in `./data` at the project root. You can specify a custom data path by prefixing the backend process with `STEPTHROUGH_DATA_ROOT=/path/to/my/data`.

*(To run them manually in separate terminal windows, you can simply use: `cd backend && uv run uvicorn app.main:app --reload` and `cd frontend && npm run dev`)*

---

## 🛠 Project Structure

- `/backend`: The FastAPI application. Handles SQLite database operations, PySceneDetect execution, manual screenshot extraction, FFmpeg bindings, and the export pipeline.
- `/frontend`: The Vite + React user interface. Handles video importing, review boards, step annotation, and configuration forms.
- `/data`: Auto-generated on launch. Contains the `stepthrough.sqlite3` manifest alongside imported MP4 videos and extracted screenshots.

---

## 📚 Documentation

For onboarding and tutorials aimed at new researchers, start with:

- [`docs/wiki/Home.md`](docs/wiki/Home.md)
- [`docs/wiki/Researcher-Onboarding.md`](docs/wiki/Researcher-Onboarding.md)
- [`docs/wiki/First-Tutorial.md`](docs/wiki/First-Tutorial.md)
- [`docs/wiki/Choosing-Settings.md`](docs/wiki/Choosing-Settings.md)
- [`manual.md`](manual.md)

---

## 🎓 Credits

Created and maintained by **H. "Kevin" Jin** at the **University of Amsterdam**.

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).

---

> *Note: FFmpeg is invoked directly via CLI subprocess. It is not bundled or statically linked within the codebase.*
