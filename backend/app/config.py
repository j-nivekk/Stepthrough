from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_ROOT = Path(os.environ.get("STEPTHROUGH_DATA_ROOT", ROOT_DIR / "data")).resolve()
DB_PATH = DATA_ROOT / "stepthrough.sqlite3"


@dataclass(frozen=True)
class ToolDiagnostics:
    ffmpeg_available: bool
    ffprobe_available: bool
    missing_tools: tuple[str, ...]
    message: str


def ensure_app_dirs() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    (DATA_ROOT / "projects").mkdir(parents=True, exist_ok=True)


def build_tool_diagnostics() -> ToolDiagnostics:
    ffmpeg_available = shutil.which("ffmpeg") is not None
    ffprobe_available = shutil.which("ffprobe") is not None
    missing = tuple(
        tool
        for tool, available in (("ffmpeg", ffmpeg_available), ("ffprobe", ffprobe_available))
        if not available
    )
    if missing:
        message = (
            "Missing required video tools: "
            + ", ".join(missing)
            + ". Install FFmpeg and ensure ffmpeg/ffprobe are on PATH."
        )
    else:
        message = "Video tools ready."
    return ToolDiagnostics(
        ffmpeg_available=ffmpeg_available,
        ffprobe_available=ffprobe_available,
        missing_tools=missing,
        message=message,
    )
