from app.models import RunSettings
from app.services.detection import build_sensitive_fallback_settings, map_run_settings, should_request_fallback


def test_tolerance_mapping_gets_more_strict_with_higher_tolerance() -> None:
    low_tolerance = map_run_settings(RunSettings(tolerance=10, detector_mode='content'), fps=30)
    high_tolerance = map_run_settings(RunSettings(tolerance=90, detector_mode='content'), fps=30)

    assert low_tolerance.content_threshold < high_tolerance.content_threshold
    assert low_tolerance.adaptive_threshold < high_tolerance.adaptive_threshold


def test_sample_fps_creates_frame_skip() -> None:
    config = map_run_settings(RunSettings(sample_fps=5), fps=30)
    assert config.frame_skip == 5


def test_fallback_is_requested_for_zero_or_one_candidate() -> None:
    assert should_request_fallback(0) is True
    assert should_request_fallback(1) is True
    assert should_request_fallback(2) is False



def test_sensitive_fallback_preset_is_deterministic_and_keeps_extract_offset() -> None:
    base = RunSettings(tolerance=72, detector_mode='content', min_scene_gap_ms=1_500, sample_fps=3, extract_offset_ms=480)
    fallback = build_sensitive_fallback_settings(base)

    assert fallback.detector_mode == 'adaptive'
    assert fallback.tolerance == 20
    assert fallback.min_scene_gap_ms == 300
    assert fallback.sample_fps == 8
    assert fallback.extract_offset_ms == 480
