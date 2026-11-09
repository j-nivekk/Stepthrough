"""Regression gates for real-world uploads (see ``stress.py`` for the full matrix).

Phone and desktop screen recordings are variable frame rate. Through the ingest working copy, such an
upload must give the same detections as a constant-frame-rate upload of the same content, and every
matched screenshot must show the settled screen rather than the one before it.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from .scenarios import BASELINE_SCENARIOS
from .step_scenarios import STEP_SCENARIOS
from .stress import load_reference, run_variant

GATED_SCENARIOS = (
    "nav_basic",
    "nav_with_fade",
    "overlay_modal",
    "overlay_bottom_sheet",
    "feed_card_swap",
    "content_loading_to_data",
    "composite_back_and_forth",
)

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")


@pytest.mark.parametrize("scenario_name", GATED_SCENARIOS)
def test_vfr_upload_matches_cfr_upload(scenario_name: str, tmp_path: Path) -> None:
    factory = dict(BASELINE_SCENARIOS)[scenario_name]
    scenario = factory(tmp_path, 30)
    reference = load_reference(scenario.video_path)

    cfr = run_variant(scenario_name, tmp_path, reference, scenario.ground_truth, "h264_cfr", None)
    vfr = run_variant(scenario_name, tmp_path, reference, scenario.ground_truth, "h264_vfr", None)

    assert vfr.metrics.recall >= cfr.metrics.recall, (
        f"VFR recall {vfr.metrics.recall:.2f} < CFR recall {cfr.metrics.recall:.2f}"
    )
    assert vfr.screenshots_correct == vfr.screenshots_matched, (
        f"{vfr.screenshots_matched - vfr.screenshots_correct} of {vfr.screenshots_matched} screenshots "
        "show the wrong state"
    )


STABLE_GATED = (
    *GATED_SCENARIOS,
    "nav_rapid",
    "scroll_list",
    "overlay_toast",
    "content_typing",
    "chat_typing_pauses",
    "form_two_fields",
    "settings_toggles",
)


@pytest.mark.parametrize("scenario_name", STABLE_GATED)
def test_stable_engine_on_phone_style_upload(scenario_name: str, tmp_path: Path) -> None:
    """stable_v3 on a variable-frame-rate upload: every event found, every screenshot settled, step 0 shown,
    and typing bursts grouped (one step per typed message or field)."""
    factory = dict([*BASELINE_SCENARIOS, *STEP_SCENARIOS])[scenario_name]
    scenario = factory(tmp_path, 30)
    result = run_variant(
        scenario_name, tmp_path, load_reference(scenario.video_path), scenario.ground_truth, "h264_vfr", None
    )
    assert result.metrics.missed_events == 0, f"missed {result.metrics.missed_events} event(s)"
    assert result.screenshots_correct == result.screenshots_matched
    assert result.opening_ok
    # The only extra step allowed is a return to an earlier screen (a toast or dialog going away).
    extras = result.metrics.false_positives
    revisits = sum(1 for c in result.candidates if c.get("similar_to_candidate_id"))
    assert extras <= revisits, f"{extras} extra step(s), {revisits} of them revisits"
