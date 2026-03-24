from __future__ import annotations

import os

import cv2
import numpy as np
import pytest

from app.services.hybrid_detection import (
    PADDLEOCR_SUPPORTED_VERSION,
    PADDLEPADDLE_SUPPORTED_VERSION,
    PaddleOcrEngine,
    _installed_package_version,
)
from app.config import build_ocr_runtime_config


pytestmark = [
    pytest.mark.smoke,
    pytest.mark.skipif(
        os.environ.get("STEPTHROUGH_RUN_PADDLEOCR_SMOKE") != "1",
        reason="Set STEPTHROUGH_RUN_PADDLEOCR_SMOKE=1 to run real PaddleOCR smoke tests.",
    ),
]


def _require_local_model_env() -> tuple[str, str]:
    det_model_dir = os.environ.get("STEPTHROUGH_OCR_DET_MODEL_DIR")
    rec_model_dir = os.environ.get("STEPTHROUGH_OCR_REC_MODEL_DIR")
    if not det_model_dir or not rec_model_dir:
        pytest.skip("Local PaddleOCR smoke tests require STEPTHROUGH_OCR_DET_MODEL_DIR and STEPTHROUGH_OCR_REC_MODEL_DIR.")
    return det_model_dir, rec_model_dir


def test_smoke_versions_match_supported_pair() -> None:
    assert _installed_package_version("paddlepaddle") == PADDLEPADDLE_SUPPORTED_VERSION
    assert _installed_package_version("paddleocr") == PADDLEOCR_SUPPORTED_VERSION


def test_smoke_engine_initializes_with_local_model_dirs(monkeypatch) -> None:
    det_model_dir, rec_model_dir = _require_local_model_env()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_SOURCE", "local")
    monkeypatch.setenv("STEPTHROUGH_OCR_DET_MODEL_DIR", det_model_dir)
    monkeypatch.setenv("STEPTHROUGH_OCR_REC_MODEL_DIR", rec_model_dir)

    engine = PaddleOcrEngine(build_ocr_runtime_config())

    assert engine is not None


def test_smoke_extract_text_returns_non_empty_for_fixture(monkeypatch) -> None:
    det_model_dir, rec_model_dir = _require_local_model_env()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_SOURCE", "local")
    monkeypatch.setenv("STEPTHROUGH_OCR_DET_MODEL_DIR", det_model_dir)
    monkeypatch.setenv("STEPTHROUGH_OCR_REC_MODEL_DIR", rec_model_dir)

    image = np.full((220, 760, 3), 255, dtype=np.uint8)
    cv2.putText(image, "Stepthrough OCR", (30, 130), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 0), 4, cv2.LINE_AA)

    engine = PaddleOcrEngine(build_ocr_runtime_config())
    text = engine.extract_text(image)

    assert text
