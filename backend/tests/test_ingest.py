from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.services.detection import CancellationRequested
from app.services.hybrid_detection import _SequentialReader
from app.services.ingest import (
    LUT_FILENAME,
    _pq_to_nits,
    build_working_copy,
    hdr_signal_to_sdr,
    inspect_source,
)
from app.services.video import extract_frame, probe_video


def _ffmpeg(*args: str) -> None:
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True)


def _held_frame_vfr(tmp_path: Path) -> Path:
    """Phone-style VFR file: three frames at 0 s, 1 s and 2 s, each held until the next one."""
    lines = []
    for index, color in enumerate(('red', 'lime', 'blue')):
        png = tmp_path / f'{color}.png'
        _ffmpeg('-f', 'lavfi', '-i', f'color=c={color}:s=320x240', '-frames:v', '1', str(png))
        lines += [f"file '{png}'", 'duration 1.0']
    lines.append(f"file '{tmp_path / 'blue.png'}'")
    listing = tmp_path / 'list.txt'
    listing.write_text('\n'.join(lines) + '\n')
    video = tmp_path / 'vfr.mp4'
    _ffmpeg('-f', 'concat', '-safe', '0', '-i', str(listing), '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video))
    return video


def _dominant_channel(image_path: Path) -> str:
    blue, green, red = cv2.imread(str(image_path)).reshape(-1, 3).mean(axis=0)
    return ('blue', 'green', 'red')[int(np.argmax([blue, green, red]))]


def test_vfr_source_is_seeked_to_the_next_frame_but_the_working_copy_holds(tmp_path: Path) -> None:
    source = _held_frame_vfr(tmp_path)
    assert inspect_source(source).is_variable_frame_rate

    # The problem being fixed: seeking the original lands on the frame after the hold.
    extract_frame(source, tmp_path / 'from-source.png', 1500)
    assert _dominant_channel(tmp_path / 'from-source.png') == 'blue'

    working = tmp_path / 'working' / 'working.mp4'
    build_working_copy(source, working)
    info = inspect_source(working)
    assert (info.codec, info.r_fps, info.avg_fps) == ('h264', 30.0, 30.0)
    extract_frame(working, tmp_path / 'from-working.png', 1500)
    assert _dominant_channel(tmp_path / 'from-working.png') == 'green'


def test_working_copy_applies_rotation(tmp_path: Path) -> None:
    plain = tmp_path / 'plain.mp4'
    rotated = tmp_path / 'rotated.mp4'
    _ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(plain))
    _ffmpeg('-display_rotation:v:0', '90', '-i', str(plain), '-c', 'copy', str(rotated))
    assert inspect_source(rotated).rotation in (90, -90)

    working = tmp_path / 'working.mp4'
    build_working_copy(rotated, working)
    metadata = probe_video(working)
    assert (metadata.width, metadata.height) == (360, 640)
    assert inspect_source(working).rotation == 0


def test_hdr_tone_map_puts_reference_white_near_white_and_keeps_black() -> None:
    m1, m2 = 2610 / 16384, 2523 / 4096 * 128
    c1, c2, c3 = 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32

    def pq_signal(nits: float) -> float:
        y = (nits / 10000) ** m1
        return ((c1 + c2 * y) / (1 + c3 * y)) ** m2

    assert _pq_to_nits(np.array([pq_signal(203.0)]))[0] == pytest.approx(203.0, rel=1e-3)
    grey_levels = np.array([[pq_signal(nits)] * 3 for nits in (0.0, 10.0, 50.0, 203.0, 1000.0)])
    sdr = hdr_signal_to_sdr(grey_levels, 'pq', reference_white_nits=203.0)
    assert sdr[0] == pytest.approx([0.0, 0.0, 0.0], abs=1e-6)
    assert np.all(np.diff(sdr[:, 0]) > 0)
    assert 0.97 <= sdr[3, 0] <= 0.995
    assert sdr[4, 0] <= 1.0


def test_hdr_working_copy_is_tone_mapped_and_tagged_sdr(tmp_path: Path) -> None:
    source = tmp_path / 'hdr10.mp4'
    _ffmpeg(
        '-f', 'lavfi', '-i', 'color=c=0x808080:s=320x240:d=1',
        '-vf', 'setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc:range=tv,format=yuv420p10le',
        '-c:v', 'libx264', str(source),
    )
    assert inspect_source(source).hdr_kind == 'pq'

    working = tmp_path / 'working' / 'working.mp4'
    build_working_copy(source, working)
    info = inspect_source(working)
    assert (info.pix_fmt, info.color_transfer, info.hdr_kind) == ('yuv420p', 'bt709', None)
    assert (working.parent / LUT_FILENAME).read_text().startswith('TITLE "Stepthrough PQ')


def test_analysed_frame_is_the_exported_frame(tmp_path: Path) -> None:
    source = tmp_path / 'moving.mp4'
    _ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=60:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source))
    working = tmp_path / 'working.mp4'
    build_working_copy(source, working)

    # Every frame of the working copy, in order (OpenCV and ffmpeg use different YUV matrices, so compare luma).
    capture = cv2.VideoCapture(str(working))
    all_frames = []
    while (frame := capture.read()[1]) is not None:
        all_frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(int))
    capture.release()

    capture = cv2.VideoCapture(str(working))
    reader = _SequentialReader(capture, probe_video(working).fps)
    for sample_ms in (0, 333, 1000, 1500, 2600):
        reader.next(sample_ms)
        timestamp_ms = reader.frame_timestamp_ms()
        exported_path = tmp_path / f'shot-{sample_ms}.png'
        extract_frame(working, exported_path, timestamp_ms)
        exported = cv2.cvtColor(cv2.imread(str(exported_path)), cv2.COLOR_BGR2GRAY).astype(int)
        distances = [float(np.mean(np.abs(frame - exported))) for frame in all_frames]
        assert int(np.argmin(distances)) == reader.last_frame_index, sample_ms
    capture.release()


def test_cancelled_working_copy_leaves_no_partial_file(tmp_path: Path) -> None:
    source = tmp_path / 'long.mp4'
    _ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source))
    working = tmp_path / 'working' / 'working.mp4'
    with pytest.raises(CancellationRequested):
        build_working_copy(source, working, cancellation_callback=lambda: True)
    assert not working.exists()
    assert not list(working.parent.glob('*.partial.mp4'))
