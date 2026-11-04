"""The stable-screen engine (stable_v3): settings resolution and behaviour on small synthetic recordings."""

from __future__ import annotations

import shutil
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.models import IgnoreRegion, RunSettings, StableSettings
from app.services.ingest import build_working_copy
from app.services.stable_detection import ENGINE_VERSION, detect_candidates_stable, resolve_stable_config
from app.services.video import probe_video
from tests.eval import rendering as r
from tests.eval.step_scenarios import chat_typing_pauses, settings_toggles

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")


def _settings(**stable: object) -> RunSettings:
    return RunSettings(analysis_engine="stable_v3", stable=StableSettings(**stable))


def _detect(video: Path, tmp_path: Path, settings: RunSettings, report: dict | None = None) -> list[dict]:
    working = tmp_path / "working.mp4"
    build_working_copy(video, working)
    meta = probe_video(working)
    return detect_candidates_stable(
        video_path=working,
        frames_dir=tmp_path / "frames",
        duration_ms=meta.duration_ms,
        fps=meta.fps,
        settings=settings,
        width=meta.width,
        height=meta.height,
        report=report,
    )


def _write(path: Path, frames: list[np.ndarray], fps: float = 30) -> Path:
    writer = r.create_writer(path, frames[0].shape[1], frames[0].shape[0], fps)
    for frame in frames:
        writer.write(frame)
    writer.release()
    return path.with_suffix(".avi")


def _labels(candidates: list[dict]) -> list[str]:
    return [c["score_breakdown"]["transition_type"] for c in candidates]


# ── settings ────────────────────────────────────────────────────────────────────────────────────────


def test_recording_type_sets_defaults_and_phone_status_bar() -> None:
    phone = resolve_stable_config(_settings(), fps=30, width=1179, height=2556)
    assert (phone.min_dwell_ms, phone.min_change_percent, phone.ignore_status_bar) == (450, 0.1, True)
    assert phone.status_bar_share == 0.06
    assert phone.engine_version == ENGINE_VERSION

    desktop = resolve_stable_config(_settings(recording_type="desktop"), fps=30, width=1920, height=1080)
    assert (desktop.min_dwell_ms, desktop.min_change_percent, desktop.status_bar_share) == (600, 0.25, 0.0)

    landscape_phone = resolve_stable_config(_settings(), fps=30, width=2556, height=1179)
    assert landscape_phone.status_bar_share == 0.0  # landscape phones hide the status bar

    overridden = resolve_stable_config(
        _settings(min_dwell_ms=800, min_change_percent=0.5, ignore_status_bar=False), fps=30, width=1179, height=2556
    )
    assert (overridden.min_dwell_ms, overridden.min_change_percent, overridden.status_bar_share) == (800, 0.5, 0.0)


@pytest.mark.parametrize(("fps", "expected"), [(30, 15.0), (25, 12.5), (24, 12.0), (12, 12.0)])
def test_analysis_rate_is_a_whole_frame_stride(fps: float, expected: float) -> None:
    assert resolve_stable_config(_settings(), fps=fps, width=640, height=360).sample_fps == expected


def test_ignore_regions_are_clipped_to_the_frame() -> None:
    region = IgnoreRegion(x=0.9, y=0.5, width=0.5, height=0.8)
    assert (region.width, region.height) == (pytest.approx(0.1), pytest.approx(0.5))
    config = resolve_stable_config(_settings(ignore_regions=[region]), fps=30, width=640, height=360)
    assert config.as_dict()["ignore_regions"] == [{"x": 0.9, "y": 0.5, "width": 0.1, "height": 0.5}]


def test_run_settings_keep_only_the_chosen_engines_options() -> None:
    assert RunSettings().analysis_engine == "stable_v3"
    assert RunSettings().stable is not None and RunSettings().advanced is None
    hybrid = RunSettings(analysis_engine="hybrid_v2", stable=StableSettings())
    assert hybrid.stable is None and hybrid.advanced is not None


# ── behaviour ───────────────────────────────────────────────────────────────────────────────────────


def test_typing_burst_becomes_one_step_and_report_is_filled(tmp_path: Path) -> None:
    scenario = chat_typing_pauses(tmp_path, 30)
    report: dict = {}
    candidates = _detect(scenario.video_path, tmp_path, _settings(), report)

    assert _labels(candidates) == ["opening_screen", "text_entry", "content_update"]
    typed = candidates[1]
    assert typed["score_breakdown"]["grouped_states"] >= 5
    typing_end = scenario.ground_truth[0].end_ms + 500
    assert scenario.ground_truth[0].start_ms <= typed["timestamp_ms"] <= typing_end
    assert report["engine_version"] == ENGINE_VERSION
    assert report["typing_groups"] == 1
    assert report["pixel_threshold"] >= 10

    ungrouped = _detect(scenario.video_path, tmp_path / "ungrouped", _settings(group_typing=False))
    assert len(ungrouped) > len(candidates) + 3


def test_toggles_in_a_column_stay_separate_steps(tmp_path: Path) -> None:
    scenario = settings_toggles(tmp_path, 30)
    candidates = _detect(scenario.video_path, tmp_path, _settings())
    assert _labels(candidates) == ["opening_screen", "small_ui_change", "small_ui_change", "small_ui_change"]


def _counter_clip(path: Path, *, portrait: bool = False) -> Path:
    """Screen A with a counter that changes every 0.6 s, then screen B. The counter sits where a phone
    status bar would be (portrait) or at the top right of the content (landscape)."""
    width, height = (360, 640) if portrait else (640, 360)
    frames = []
    for index in range(int(30 * 4.0)):
        t = index / 30
        frame = np.full((height, width, 3), 245 if t < 2.0 else 60, np.uint8)
        cv2.putText(frame, "Inbox" if t < 2.0 else "Dashboard", (20, height // 2), cv2.FONT_HERSHEY_SIMPLEX, 1.2,
                    (20, 20, 20) if t < 2.0 else (230, 230, 230), 2)
        box = (width - 110, 4, 100, 26) if portrait else (width - 130, 60, 110, 40)
        cv2.rectangle(frame, box[:2], (box[0] + box[2], box[1] + box[3]), (255, 255, 255), -1)
        cv2.putText(frame, f"9:4{int(t / 0.6)}", (box[0] + 8, box[1] + box[3] - 7), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                    (0, 0, 0), 2)
        frames.append(frame)
    return _write(path, frames)


def test_ignore_area_hides_a_changing_region(tmp_path: Path) -> None:
    clip = _counter_clip(tmp_path / "counter")
    noisy = _detect(clip, tmp_path / "a", _settings())
    assert len(noisy) >= 4  # every counter change is a new screen

    ignored = _detect(clip, tmp_path / "b", _settings(ignore_regions=[IgnoreRegion(x=0.75, y=0.12, width=0.25, height=0.2)]))
    assert _labels(ignored) == ["opening_screen", "navigation"]
    assert 2000 <= ignored[1]["timestamp_ms"] <= 2600


def test_phone_status_bar_is_ignored_unless_switched_off(tmp_path: Path) -> None:
    clip = _counter_clip(tmp_path / "status", portrait=True)
    assert len(_detect(clip, tmp_path / "a", _settings())) == 2
    assert len(_detect(clip, tmp_path / "b", _settings(ignore_status_bar=False))) >= 4


def test_opening_screen_can_be_left_out(tmp_path: Path) -> None:
    scenario = settings_toggles(tmp_path, 30)
    candidates = _detect(scenario.video_path, tmp_path, _settings(include_opening_screen=False))
    assert "opening_screen" not in _labels(candidates)
    assert len(candidates) == 3


def test_revisit_means_the_same_screen_state(tmp_path: Path) -> None:
    a = r.app_chrome(r.list_screen(), header_text="Inbox")
    b = r.app_chrome(r.dashboard_screen(), header_text="Dashboard")
    clip = _write(tmp_path / "revisit", [a] * 30 + [b] * 30 + [a] * 30)
    candidates = _detect(clip, tmp_path, _settings())
    assert len(candidates) == 3
    assert candidates[2]["similar_to_candidate_id"] == candidates[0]["id"]
    assert candidates[2]["revisit_group_id"] == candidates[0]["revisit_group_id"] is not None
    assert candidates[1]["revisit_group_id"] is None


def test_screenshot_is_taken_inside_the_stable_screen(tmp_path: Path) -> None:
    a = r.app_chrome(r.list_screen(), header_text="Inbox")
    b = r.app_chrome(r.dashboard_screen(), header_text="Dashboard")
    fade = [cv2.addWeighted(a, 1 - k / 9, b, k / 9, 0) for k in range(10)]  # 330 ms cross-fade
    clip = _write(tmp_path / "fade", [a] * 30 + fade + [b] * 30)
    candidates = _detect(clip, tmp_path, _settings())
    assert len(candidates) == 2
    shot = cv2.imread(candidates[1]["image_path"]).astype(np.float32)
    assert float(np.mean(np.abs(shot - b))) < 3.0  # the settled screen, not a cross-fade frame
    breakdown = candidates[1]["score_breakdown"]
    assert breakdown["event_start_ms"] <= 1100 <= breakdown["event_end_ms"] + 400
    assert breakdown["dwell_after_ms"] >= 600
