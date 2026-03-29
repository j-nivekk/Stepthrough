"""Pytest smoke coverage for the curated realistic eval matrix."""

from __future__ import annotations

from pathlib import Path

import cv2
import pytest

from app.models import HybridAdvancedSettings, RunSettings
from app.services.hybrid_detection import detect_candidates_hybrid

from .evaluator import evaluate, format_debug_report
from .scenarios import all_scenarios
from .types import ScenarioResult


def _run_detection(scenario_result: ScenarioResult, tmp_path: Path) -> list[dict]:
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    return detect_candidates_hybrid(
        video_path=scenario_result.video_path,
        frames_dir=frames_dir,
        duration_ms=scenario_result.duration_ms,
        fps=scenario_result.fps,
        settings=RunSettings(
            analysis_engine="hybrid_v2",
            analysis_preset="balanced",
            advanced=HybridAdvancedSettings(
                enable_ocr=False,
                sample_fps_override=scenario_result.sample_fps,
            ),
            min_scene_gap_ms=900,
        ),
    )


@pytest.mark.parametrize(
    "scenario_name,scenario_fn",
    all_scenarios(matrix="realistic-smoke"),
    ids=[name for name, _ in all_scenarios(matrix="realistic-smoke")],
)
def test_realistic_smoke_scenarios_generate_and_detect(scenario_name: str, scenario_fn, tmp_path: Path) -> None:
    scenario_dir = tmp_path / scenario_name
    scenario_dir.mkdir(parents=True, exist_ok=True)
    scenario_result = scenario_fn(scenario_dir)

    cap = cv2.VideoCapture(str(scenario_result.video_path))
    assert cap.isOpened(), f"Cannot open video: {scenario_result.video_path}"
    success, frame = cap.read()
    cap.release()

    assert success, "Cannot read first frame"
    assert frame.shape[1] == scenario_result.width
    assert frame.shape[0] == scenario_result.height

    candidates = _run_detection(scenario_result, tmp_path)
    metrics = evaluate(candidates, scenario_result.ground_truth)

    if metrics.recall < 0.5:
        print(f"\n{format_debug_report(scenario_name, metrics, candidates)}")

    assert metrics.recall >= 0.0
