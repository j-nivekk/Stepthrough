from __future__ import annotations

from pathlib import Path



from tests.eval.rendering import default_viewport, pt, px, use_viewport
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
