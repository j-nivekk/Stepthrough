from app.services.video import export_filename
from app.utils import timecode_from_ms


def test_timecode_formats_for_display_and_slug() -> None:
    assert timecode_from_ms(134_480) == '00:02:14.480'
    assert timecode_from_ms(134_480, slug_style=True) == '00-02-14-480'


def test_export_filename_is_stable_and_timestamped() -> None:
    assert export_filename('study-run', 3, 134_480) == 'study-run__step-003__00-02-14-480.png'
