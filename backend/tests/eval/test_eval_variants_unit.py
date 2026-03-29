from __future__ import annotations

from pathlib import Path

import cv2

from app.services.hybrid_detection import _prepare_frame

from tests.eval.rendering import ViewportSpec, default_viewport, pt, px, use_viewport
from tests.eval.runner import _aggregate_dimensions
from tests.eval.scenarios import all_scenarios
from tests.eval.types import GroundTruthEvent, ScenarioResult


def test_viewport_spec_scales_geometry() -> None:
    phone = default_viewport(logical_width=390, logical_height=844, shell="mobile_app")
    laptop = default_viewport(logical_width=1280, logical_height=800, shell="desktop_browser")
    fullscreen = default_viewport(logical_width=960, logical_height=540, shell="fullscreen")

    assert phone.content_height == phone.logical_height - phone.header_height - phone.footer_height
    assert laptop.content_height == laptop.logical_height - laptop.header_height
    assert fullscreen.content_height == fullscreen.logical_height

    with use_viewport(laptop):
        assert px(56) > 56
        assert pt(0.5) > 0.5


def test_scenario_result_defaults_fill_variant_metadata(tmp_path: Path) -> None:
    result = ScenarioResult(
        video_path=tmp_path / "demo.avi",
        ground_truth=[GroundTruthEvent("navigation", 0, 0)],
        duration_ms=1000,
        fps=30,
        width=640,
        height=360,
        description="baseline scenario",
    )

    assert result.logical_width == 640
    assert result.logical_height == 360
    assert result.encoded_width == 640
    assert result.encoded_height == 360
    assert result.source_fps == 30
    assert result.orientation == "landscape"


def test_realistic_smoke_registry_matches_expected_variants() -> None:
    names = [name for name, _ in all_scenarios(matrix="realistic-smoke")]

    assert len(names) == 8
    assert names == [
        "nav_with_fade__phone_portrait__390x844__src30__sample6",
        "scroll_list__phone_portrait__390x844__src30__sample6",
        "overlay_bottom_sheet__phone_portrait__390x844__src30__sample6",
        "content_typing__phone_portrait__390x844__src30__sample6",
        "nav_with_fade__laptop_landscape__1280x800__src30__sample6",
        "overlay_modal__laptop_landscape__1280x800__src30__sample6",
        "feed_fullscreen_swipe__fullscreen_vertical__540x960__src60__sample12",
        "feed_fullscreen_swipe__fullscreen_horizontal__960x540__src60__sample12",
    ]


def test_realistic_full_registry_filters_profile_resolution_and_fps() -> None:
    scenarios = all_scenarios(
        matrix="realistic-full",
        profile="fullscreen_vertical",
        resolution_tier="1080x1920",
        source_fps=60,
        sample_fps=12,
    )

    names = [name for name, _ in scenarios]
    assert names == ["feed_fullscreen_swipe__fullscreen_vertical__1080x1920__src60__sample12"]


def test_aggregate_dimensions_groups_by_variant_metadata() -> None:
    dimensions = _aggregate_dimensions(
        {
            "a": {
                "precision": 1.0,
                "recall": 0.5,
                "f1": 0.66,
                "profile_id": "phone_portrait",
                "orientation": "portrait",
                "encoded_width": 390,
                "encoded_height": 844,
                "source_fps": 30,
                "sample_fps": 6,
            },
            "b": {
                "precision": 0.5,
                "recall": 1.0,
                "f1": 0.66,
                "profile_id": "phone_portrait",
                "orientation": "portrait",
                "encoded_width": 390,
                "encoded_height": 844,
                "source_fps": 30,
                "sample_fps": 6,
            },
        }
    )

    assert dimensions["profile_id"]["phone_portrait"]["count"] == 2
    assert dimensions["encoded_size"]["390x844"]["mean_f1"] == 0.66
    assert dimensions["sample_fps"]["6"]["mean_precision"] == 0.75


def test_high_res_vertical_variant_crosses_resize_threshold(tmp_path: Path) -> None:
    _, factory = all_scenarios(
        matrix="realistic-full",
        profile="fullscreen_vertical",
        resolution_tier="1080x1920",
        source_fps=60,
        sample_fps=12,
    )[0]

    scenario_dir = tmp_path / "hires"
    scenario_dir.mkdir()
    scenario_result = factory(scenario_dir)

    cap = cv2.VideoCapture(str(scenario_result.video_path))
    success, frame = cap.read()
    cap.release()

    assert success
    assert max(frame.shape[0], frame.shape[1]) > 960

    sample = _prepare_frame(frame, timestamp_ms=0, max_frame_edge=960)
    assert max(sample.bgr.shape[0], sample.bgr.shape[1]) == 960
