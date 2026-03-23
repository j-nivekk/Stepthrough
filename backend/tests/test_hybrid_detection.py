from __future__ import annotations

from pathlib import Path

import numpy as np

from app.models import HybridAdvancedSettings, RunSettings
from app.services.hybrid_detection import (
    _maybe_load_ocr_engine,
    _prepare_frame,
    _transition_signal,
    detect_candidates_hybrid,
    resolve_hybrid_config,
)


def test_resolve_hybrid_config_uses_preset_defaults() -> None:
    config = resolve_hybrid_config(RunSettings(analysis_engine="hybrid_v2", analysis_preset="subtle_ui"), fps=30)

    assert config.sample_fps == 8
    assert config.min_dwell_ms == 250
    assert config.settle_window_ms == 250
    assert config.enable_ocr is True
    assert config.ocr_backend == "paddleocr"


def test_resolve_hybrid_config_applies_overrides_and_clamps_to_source_fps() -> None:
    settings = RunSettings(
        analysis_engine="hybrid_v2",
        analysis_preset="balanced",
        advanced=HybridAdvancedSettings(sample_fps_override=120, min_dwell_ms=150, settle_window_ms=500, enable_ocr=False),
    )

    config = resolve_hybrid_config(settings, fps=24)

    assert config.sample_fps == 24
    assert config.min_dwell_ms == 150
    assert config.settle_window_ms == 500
    assert config.enable_ocr is False
    assert config.ocr_backend is None


def test_transition_signal_detects_local_interface_change() -> None:
    baseline = np.zeros((360, 640, 3), dtype=np.uint8)
    changed = baseline.copy()
    changed[60:180, 420:580] = 255

    previous = _prepare_frame(baseline, 0, 960)
    current = _prepare_frame(changed, 200, 960)

    visual, motion, regions = _transition_signal(previous, current)

    assert visual > 0.1
    assert motion > 0.05
    assert regions


def test_ocr_engine_warning_is_emitted_when_backend_is_missing(monkeypatch) -> None:
    import app.services.hybrid_detection as hybrid_detection

    def fail_constructor():
        raise RuntimeError("missing paddleocr")

    monkeypatch.setattr(hybrid_detection, "PaddleOcrEngine", fail_constructor)
    settings = RunSettings(analysis_engine="hybrid_v2", analysis_preset="balanced")
    config = resolve_hybrid_config(settings, fps=30)

    engine, warning = _maybe_load_ocr_engine(config)

    assert engine is None
    assert warning == "missing paddleocr"


def test_detect_candidates_hybrid_creates_score_breakdowns(
    tmp_path: Path,
    video_factory,
) -> None:
    video_path = video_factory("hybrid-two-state.mp4", ["black", "white"], segment_duration=1)
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    candidates = detect_candidates_hybrid(
        video_path=video_path,
        frames_dir=frames_dir,
        duration_ms=2_000,
        fps=30,
        settings=RunSettings(
            analysis_engine="hybrid_v2",
            analysis_preset="balanced",
            advanced=HybridAdvancedSettings(enable_ocr=False),
        ),
    )

    assert candidates
    assert all(candidate["score_breakdown"] is not None for candidate in candidates)
    assert all("perceptual_hash" in candidate for candidate in candidates)
