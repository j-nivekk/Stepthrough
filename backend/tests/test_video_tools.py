from __future__ import annotations

from app.services.video import extract_frame


def test_extract_frame_retries_with_earlier_timestamps(video_factory, tmp_path) -> None:
    video = video_factory('frame-fallback.mp4', ['red'])
    output_path = tmp_path / 'fallback-frame.png'

    extract_frame(video, output_path, 2500)

    assert output_path.exists()
    assert output_path.stat().st_size > 0
