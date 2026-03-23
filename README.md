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
   git clone https://github.com/yourusername/stepthrough.git
   cd stepthrough
   ```

2. **Install Backend Dependencies:**
   Stepthrough uses `uv` for backend package management.
   ```bash
   cd backend
   uv sync
   
   # Note: To enable the advanced Hybrid OCR detection engine, sync the hybrid group:
   # uv sync --group hybrid
   ```

3. **Install Frontend Dependencies:**
   ```bash
   cd ../frontend
   npm install
   ```

---

## 🕹 Running Locally

You can spin up both the frontend and backend servers easily.

**Terminal 1 (Backend):**
```bash
cd backend
uv run uvicorn app.main:app --reload
# Runs on http://127.0.0.1:8000
```

**Terminal 2 (Frontend):**
```bash
cd frontend
npm run dev
# Runs on http://127.0.0.1:5173
```

By default, the application stores all databases, recordings, and exports in `./data` at the project root. You can specify a custom data path by prefixing your backend process with `STEPTHROUGH_DATA_ROOT=/path/to/my/data`.

Alternatively, you can use the provided `Makefile` in the project root:
```bash
make backend-install
make frontend-install
make backend-dev
make frontend-dev
```

---

## 🛠 Project Structure

- `/backend`: The FastAPI application. Handles SQLite database operations, PySceneDetect execution, manual screenshot extraction, FFmpeg bindings, and the export pipeline.
- `/frontend`: The Vite + React user interface. Handles video importing, review boards, step annotation, and configuration forms.
- `/data`: Auto-generated on launch. Contains the `stepthrough.sqlite3` manifest alongside imported MP4 videos and extracted screenshots.

---

## 🎓 Credits

Created and maintained by **H. "Kevin" Jin** at the **University of Amsterdam**.

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).

---

> *Note: FFmpeg is invoked directly via CLI subprocess. It is not bundled or statically linked within the codebase.*
