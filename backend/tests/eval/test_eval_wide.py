"""Regression gates for the wider evaluation (see ``wide.py`` for the full run).

A small, fast part of each section: upload formats on a small phone, one native-size phone and one desktop
with a moving pointer, the countdown cards, the size sweep, and the colour accuracy of the working copy.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from app.models import StableSettings

from . import cards
from .scenarios import device_scenario
from .stress import load_reference, run_variant

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")


def _check(result) -> None:
    assert result.metrics.missed_events == 0, f"missed {result.metrics.missed_events} change(s)"
    assert result.screenshots_correct == result.screenshots_matched, (
        f"{result.screenshots_matched - result.screenshots_correct} screenshot(s) show the wrong state"
    )
    assert result.opening_ok, "the opening screen is missing or wrong"


@pytest.mark.parametrize("encoding", ["hevc_vfr", "webm", "rotated", "h264_bt709", "h264_full_range", "hdr_pq", "hdr_hlg"])
def test_upload_formats(encoding: str, tmp_path: Path) -> None:
    name, factory = device_scenario("nav_with_fade", "phone_portrait", "390x844")
    scenario = factory(tmp_path)
    result = run_variant(name, tmp_path, load_reference(scenario.video_path), scenario.ground_truth, encoding, None)
    _check(result)
    assert result.metrics.false_positives == 0


@pytest.mark.parametrize(
    ("builder", "profile", "size", "variant", "recording_type"),
    [
        ("composite_browse_session", "iphone", "1180x2556", "h264_vfr", "phone"),
        ("nav_with_fade", "desktop_1080p", "1920x1080", "h264_vfr+pointer", "desktop"),
    ],
)
def test_device_sizes(builder: str, profile: str, size: str, variant: str, recording_type: str, tmp_path: Path) -> None:
    name, factory = device_scenario(builder, profile, size)
    scenario = factory(tmp_path)
    encoding, _, overlay = variant.partition("+")
    result = run_variant(name, tmp_path, load_reference(scenario.video_path), scenario.ground_truth, encoding,
                         overlay or None, recording_type=recording_type)
    _check(result)


@pytest.mark.parametrize("card", ["countdown", "countdown_sweep"])
def test_countdown(card: str, tmp_path: Path) -> None:
    """Every digit is a step at its time; the bars, and the turning dial, are not."""
    name, factory = device_scenario(cards.CARD_BUILDERS[card], "phone_portrait", "390x844", base_name=card)
    scenario = factory(tmp_path)
    result = run_variant(name, tmp_path, load_reference(scenario.video_path), scenario.ground_truth, "h264_vfr", None)
    _check(result)
    assert result.metrics.false_positives == 0


@pytest.mark.parametrize(("profile", "size"), [("phone_portrait", "390x844"), ("laptop_landscape", "1280x800")])
def test_size_sweep(profile: str, size: str, tmp_path: Path) -> None:
    """Every square at least as large as the smallest-change setting is found; the smallest square is not."""
    name, factory = device_scenario(cards.size_sweep, profile, size, base_name="size_sweep")
    scenario = factory(tmp_path)
    recording_type = "desktop" if scenario.shell == "desktop_browser" else "phone"
    settings = StableSettings(recording_type=recording_type, group_typing=False)
    setting_percent = 0.25 if recording_type == "desktop" else 0.10
    result = run_variant(name, tmp_path, load_reference(scenario.video_path), scenario.ground_truth, "h264_vfr", None,
                         stable=settings)
    found = cards.found_per_event(result.candidates, scenario.ground_truth)
    percents = [event.metadata["share_percent"] for event in scenario.ground_truth]
    assert all(f for p, f in zip(percents, found) if p >= setting_percent), dict(zip(percents, found))
    assert not found[0], f"a {percents[0]} % square counted as a change"
    assert result.metrics.false_positives == 0


def test_known_limit_same_brightness_colour_change(tmp_path: Path) -> None:
    """Frames are compared in grey, so a change to another colour of the same brightness is not seen.

    This documents a limit described in docs/evaluation.md. If it starts failing because the engine sees such
    changes, update that page."""
    name, factory = device_scenario(cards.equal_luma, "phone_portrait", "390x844", base_name="equal_luma")
    scenario = factory(tmp_path)
    result = run_variant(name, tmp_path, load_reference(scenario.video_path), scenario.ground_truth, "h264_bt709", None)
    same_brightness, darker = cards.found_per_event(result.candidates, scenario.ground_truth)
    assert not same_brightness
    assert darker


# Largest acceptable difference of any test-card patch, in 8-bit levels (mean of R, G and B). The HDR limits
# hold today's error, most of it from interpolating the 33-point tone-mapping table on saturated colours
# (75 % green is the worst patch); lower them when the conversion improves.
COLOUR_LIMITS = {
    "h264_bt709": 3.0,
    "h264_full_range": 3.0,
    "hdr_pq": 16.0,
    "hdr_hlg": 13.0,
}


@pytest.mark.parametrize("encoding", sorted(COLOUR_LIMITS))
def test_colour_accuracy(encoding: str, tmp_path: Path) -> None:
    report = cards.colour_accuracy(tmp_path, encoding, size=(640, 360))
    assert report["max_error"] <= COLOUR_LIMITS[encoding], report
