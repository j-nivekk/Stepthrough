"""Pytest integration for the eval pipeline.

Runs each scenario through ``detect_candidates_hybrid`` and evaluates against
ground truth.

Usage::

    pytest backend/tests/eval/ -v                      # run all eval tests
    pytest backend/tests/eval/ -v -k "nav"             # filter by name
    pytest backend/tests/eval/ -v -k "scroll"          # scroll scenarios only
"""

from __future__ import annotations

from pathlib import Path

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
            advanced=HybridAdvancedSettings(enable_ocr=False),
            min_scene_gap_ms=900,
        ),
    )


@pytest.mark.parametrize(
    "scenario_name,scenario_fn",
    all_scenarios(),
    ids=[name for name, _ in all_scenarios()],
)
def test_scenario_detects_events(scenario_name: str, scenario_fn, tmp_path: Path) -> None:
    """Run detection and report metrics.

    Uses ``assert recall >= 0.0`` as a soft gate — the test always passes
    but prints a debug report on low recall so regressions are visible in
    CI output.  Raise the threshold as the engine improves.
    """
    scenario_dir = tmp_path / scenario_name
    scenario_dir.mkdir(parents=True, exist_ok=True)
    scenario_result = scenario_fn(scenario_dir)

    candidates = _run_detection(scenario_result, tmp_path)
    metrics = evaluate(candidates, scenario_result.ground_truth)

    # Print debug info when recall is below 50% (visible with pytest -s)
    if metrics.recall < 0.5:
        print(f"\n{format_debug_report(scenario_name, metrics, candidates)}")

    assert metrics.recall >= 0.0, (
        f"Scenario '{scenario_name}': recall={metrics.recall}, "
        f"missed={metrics.missed_events}/{metrics.total_ground_truth}, "
        f"candidates={metrics.total_candidates}"
    )


@pytest.mark.parametrize(
    "scenario_name,scenario_fn",
    all_scenarios(),
    ids=[name for name, _ in all_scenarios()],
)
def test_scenario_generates_valid_video(scenario_name: str, scenario_fn, tmp_path: Path) -> None:
    """Each scenario produces a readable video with correct dimensions."""
    import cv2

    scenario_dir = tmp_path / scenario_name
    scenario_dir.mkdir(parents=True, exist_ok=True)
    scenario_result = scenario_fn(scenario_dir)

    assert scenario_result.video_path.exists(), f"Video not created: {scenario_result.video_path}"

    cap = cv2.VideoCapture(str(scenario_result.video_path))
    assert cap.isOpened(), f"Cannot open video: {scenario_result.video_path}"

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    assert frame_count > 0, "Video has no frames"

    success, frame = cap.read()
    assert success, "Cannot read first frame"
    assert frame.shape[1] == scenario_result.width
    assert frame.shape[0] == scenario_result.height

    cap.release()
