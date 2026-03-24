from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_ROOT = Path(os.environ.get("STEPTHROUGH_DATA_ROOT", ROOT_DIR / "data")).resolve()
DB_PATH = DATA_ROOT / "stepthrough.sqlite3"
OcrModelSource = Literal["auto", "huggingface", "bos", "local"]
VALID_OCR_MODEL_SOURCES = ("auto", "huggingface", "bos", "local")


@dataclass(frozen=True)
class ToolDiagnostics:
    ffmpeg_available: bool
    ffprobe_available: bool
    missing_tools: tuple[str, ...]
    message: str


@dataclass(frozen=True)
class OcrRuntimeConfig:
    model_source: OcrModelSource | str
    det_model_dir: Path | None
    rec_model_dir: Path | None
    cache_dir: Path

    @property
    def resolved_det_model_dir(self) -> Path:
        if self.det_model_dir is not None:
            return self.det_model_dir
        return self.cache_dir / "text_detection"

    @property
    def resolved_rec_model_dir(self) -> Path:
        if self.rec_model_dir is not None:
            return self.rec_model_dir
        return self.cache_dir / "text_recognition"


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


def build_ocr_runtime_config() -> OcrRuntimeConfig:
    model_source = os.environ.get("STEPTHROUGH_OCR_MODEL_SOURCE", "auto").strip().lower() or "auto"
    det_model_dir = os.environ.get("STEPTHROUGH_OCR_DET_MODEL_DIR")
    rec_model_dir = os.environ.get("STEPTHROUGH_OCR_REC_MODEL_DIR")
    cache_dir = os.environ.get("STEPTHROUGH_OCR_CACHE_DIR")
    return OcrRuntimeConfig(
        model_source=model_source,
        det_model_dir=Path(det_model_dir).expanduser().resolve() if det_model_dir else None,
        rec_model_dir=Path(rec_model_dir).expanduser().resolve() if rec_model_dir else None,
        cache_dir=(
            Path(cache_dir).expanduser().resolve()
            if cache_dir
            else (DATA_ROOT / "ocr-models" / "paddleocr3").resolve()
        ),
    )


def validate_ocr_runtime_config(config: OcrRuntimeConfig) -> tuple[bool, str | None]:
    if config.model_source not in VALID_OCR_MODEL_SOURCES:
        allowed = ", ".join(VALID_OCR_MODEL_SOURCES)
        return (
            False,
            f"Invalid STEPTHROUGH_OCR_MODEL_SOURCE `{config.model_source}`. Use one of: {allowed}.",
        )

    if config.model_source == "local":
        if config.det_model_dir is None or config.rec_model_dir is None:
            return (
                False,
                "Local OCR mode requires both STEPTHROUGH_OCR_DET_MODEL_DIR and STEPTHROUGH_OCR_REC_MODEL_DIR.",
            )
        for label, path in (
            ("STEPTHROUGH_OCR_DET_MODEL_DIR", config.det_model_dir),
            ("STEPTHROUGH_OCR_REC_MODEL_DIR", config.rec_model_dir),
        ):
            if not path.exists():
                return False, f"Local OCR model path `{path}` from {label} does not exist."
            if not path.is_dir():
                return False, f"Local OCR model path `{path}` from {label} is not a directory."
        return True, None

    try:
        config.cache_dir.mkdir(parents=True, exist_ok=True)
        config.resolved_det_model_dir.mkdir(parents=True, exist_ok=True)
        config.resolved_rec_model_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return False, f"Configured OCR cache directory could not be prepared: {exc}"
    return True, None
