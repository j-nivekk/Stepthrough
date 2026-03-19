from app.models import RunSettings
from app.services.detection import map_run_settings


def test_tolerance_mapping_gets_more_strict_with_higher_tolerance() -> None:
    low_tolerance = map_run_settings(RunSettings(tolerance=10, detector_mode='content'), fps=30)
    high_tolerance = map_run_settings(RunSettings(tolerance=90, detector_mode='content'), fps=30)

    assert low_tolerance.content_threshold < high_tolerance.content_threshold
    assert low_tolerance.adaptive_threshold < high_tolerance.adaptive_threshold


def test_sample_fps_creates_frame_skip() -> None:
    config = map_run_settings(RunSettings(sample_fps=5), fps=30)
    assert config.frame_skip == 5
