"""Ingest normalisation: every recording is analysed, previewed and screenshotted from one working copy.

Screen recordings from phones and desktops are variable frame rate: a frame is only written when the
screen changes. Seeking such a file by time returns the *next* frame rather than the one on screen, and
mapping time to a frame number drifts by seconds. The working copy fixes that once, at ingest:

- constant frame rate (held frames are repeated, so the frame at time t is the frame on screen at t)
- SDR BT.709 (HDR10 / HLG recordings are tone-mapped with a generated 3D LUT)
- upright (rotation metadata is applied)
- H.264 + AAC with faststart, so the same file plays in every browser
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from threading import BoundedSemaphore, Lock
from typing import Callable

import numpy as np

from .run_control import CancellationRequested
from .video import VideoToolError, _parse_fraction, run_command

WORKING_COPY_DIRNAME = "working"
WORKING_COPY_FILENAME = "working.mp4"
WORKING_FPS_CAP = 30
WORKING_CRF = 18
HDR_TRANSFERS = {"smpte2084": "pq", "arib-std-b67": "hlg"}
LUT_SIZE = 33
LUT_FILENAME = "hdr_to_sdr.cube"

IngestProgressCallback = Callable[[float], None]
CancellationCallback = Callable[[], bool]

# One transcode per recording at a time, and a small cap overall (each ffmpeg is multi-threaded).
_global_slots = BoundedSemaphore(2)
_recording_locks: dict[str, Lock] = {}
_recording_locks_guard = Lock()


@dataclass(frozen=True)
class SourceInfo:
    codec: str
    pix_fmt: str
    width: int
    height: int
    r_fps: float
    avg_fps: float
    duration_ms: int
    color_transfer: str | None
    color_range: str | None
    rotation: int
    has_audio: bool

    @property
    def hdr_kind(self) -> str | None:
        return HDR_TRANSFERS.get(self.color_transfer or "")

    @property
    def is_variable_frame_rate(self) -> bool:
        if self.r_fps <= 0 or self.avg_fps <= 0:
            return True
        return abs(self.r_fps - self.avg_fps) / self.r_fps > 0.001


def inspect_source(path: Path) -> SourceInfo:
    result = run_command(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)]
    )
    payload = json.loads(result.stdout)
    streams = payload.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if video is None:
        raise VideoToolError("No video stream detected in uploaded file.")
    rotation = 0
    for side_data in video.get("side_data_list") or []:
        if "rotation" in side_data:
            rotation = int(round(float(side_data["rotation"])))
    if not rotation and (video.get("tags") or {}).get("rotate"):
        rotation = int(video["tags"]["rotate"])
    duration_seconds = float(video.get("duration") or payload.get("format", {}).get("duration") or 0)
    return SourceInfo(
        codec=video.get("codec_name") or "unknown",
        pix_fmt=video.get("pix_fmt") or "unknown",
        width=int(video.get("width") or 0),
        height=int(video.get("height") or 0),
        r_fps=_parse_fraction(video.get("r_frame_rate")),
        avg_fps=_parse_fraction(video.get("avg_frame_rate")),
        duration_ms=max(1, int(duration_seconds * 1000)),
        color_transfer=video.get("color_transfer"),
        color_range=video.get("color_range"),
        rotation=rotation,
        has_audio=any(stream.get("codec_type") == "audio" for stream in streams),
    )


def working_copy_path(recording_dir: Path) -> Path:
    return recording_dir / WORKING_COPY_DIRNAME / WORKING_COPY_FILENAME


def working_fps(info: SourceInfo) -> str:
    """Constant output rate: the source rate when it is already low and constant, otherwise the cap."""
    if not info.is_variable_frame_rate and 0 < info.r_fps < WORKING_FPS_CAP:
        return f"{info.r_fps:.6g}"
    return str(WORKING_FPS_CAP)


# --- HDR to SDR -------------------------------------------------------------------------------------

_BT2020_TO_BT709 = np.array(
    [
        [1.6605, -0.5876, -0.0728],
        [-0.1246, 1.1329, -0.0083],
        [-0.0182, -0.1006, 1.1187],
    ]
)
_BT2020_LUMA = np.array([0.2627, 0.6780, 0.0593])


def _pq_to_nits(signal: np.ndarray) -> np.ndarray:
    m1, m2 = 2610 / 16384, 2523 / 4096 * 128
    c1, c2, c3 = 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
    power = np.power(np.clip(signal, 0.0, 1.0), 1 / m2)
    return 10000.0 * np.power(np.maximum(power - c1, 0.0) / (c2 - c3 * power), 1 / m1)


def _hlg_to_nits(rgb_signal: np.ndarray, peak_nits: float = 1000.0) -> np.ndarray:
    a, b, c = 0.17883277, 0.28466892, 0.55991073
    signal = np.clip(rgb_signal, 0.0, 1.0)
    scene = np.where(signal <= 0.5, (signal**2) / 3.0, (np.exp((signal - c) / a) + b) / 12.0)
    luminance = np.clip(scene @ _BT2020_LUMA, 1e-6, None)[..., None]
    return peak_nits * np.power(luminance, 0.2) * scene  # BT.2100 OOTF, system gamma 1.2


def _tone_map_to_sdr(linear_bt2020_nits: np.ndarray, reference_white_nits: float) -> np.ndarray:
    """Linear BT.2020 light in nits -> gamma-encoded BT.709 RGB in [0, 1]."""
    relative = np.clip((linear_bt2020_nits / reference_white_nits) @ _BT2020_TO_BT709.T, 0.0, None)
    # Highlights above the knee roll off smoothly towards 1.0 (applied to the max channel to keep hue).
    # Reference white lands at 0.96 linear (about 250 of 255).
    knee = 0.9
    peak = relative.max(axis=-1, keepdims=True)
    rolled = np.where(peak <= knee, peak, knee + (1 - knee) * (1 - np.exp(-(peak - knee) / (1 - knee))))
    scaled = np.where(peak > 0, relative * (rolled / np.maximum(peak, 1e-9)), 0.0)
    scaled = np.clip(scaled, 0.0, 1.0)
    return np.where(scaled <= 0.0031308, 12.92 * scaled, 1.055 * np.power(scaled, 1 / 2.4) - 0.055)


def hdr_signal_to_sdr(rgb_signal: np.ndarray, hdr_kind: str, reference_white_nits: float) -> np.ndarray:
    nits = _pq_to_nits(rgb_signal) if hdr_kind == "pq" else _hlg_to_nits(rgb_signal)
    return _tone_map_to_sdr(nits, reference_white_nits)


def write_hdr_lut(path: Path, hdr_kind: str, reference_white_nits: float, size: int = LUT_SIZE) -> Path:
    grid = np.linspace(0.0, 1.0, size)
    blue, green, red = np.meshgrid(grid, grid, grid, indexing="ij")  # .cube order: red varies fastest
    signal = np.stack([red, green, blue], axis=-1).reshape(-1, 3)
    sdr = hdr_signal_to_sdr(signal, hdr_kind, reference_white_nits)
    lines = [
        f'TITLE "Stepthrough {hdr_kind.upper()} BT.2020 to SDR BT.709, white {reference_white_nits:.0f} nits"',
        f"LUT_3D_SIZE {size}",
        "DOMAIN_MIN 0 0 0",
        "DOMAIN_MAX 1 1 1",
    ]
    lines.extend(f"{r:.6f} {g:.6f} {b:.6f}" for r, g, b in sdr)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")
    return path


# swscale's default fast rounding converts colours differently from one ffmpeg release to the next: ffmpeg 7.1 (the
# Docker image's Debian) made working copies up to two levels darker than 8 and later (the Mac). With these flags
# every version gives the same pixels, so a run on the server matches the same run on the desktop.
ACCURATE_SCALE = "flags=accurate_rnd+full_chroma_int"


def _yuv_to_rgb48(info: SourceInfo) -> str:
    in_range = "pc" if info.color_range == "pc" else "tv"
    return f"scale=in_color_matrix=bt2020:in_range={in_range}:out_range=pc:{ACCURATE_SCALE},format=rgb48le"


def estimate_reference_white(source: Path, info: SourceInfo) -> float:
    """PQ: the brightness of interface white varies by device, so measure it (99th percentile luminance)."""
    if info.hdr_kind != "pq":
        return 203.0  # BT.2408 reference white; HLG is defined relative to it
    duration_s = max(0.5, info.duration_ms / 1000)
    command = [
        "ffmpeg", "-v", "error", "-i", str(source),
        "-vf", f"fps={8 / duration_s:.6f},{_yuv_to_rgb48(info)},scale=240:-2",
        "-frames:v", "8", "-f", "rawvideo", "-pix_fmt", "rgb48le", "-",
    ]
    raw = subprocess.run(command, capture_output=True, check=False).stdout
    if not raw:
        return 203.0
    pixels = np.frombuffer(raw, dtype="<u2").reshape(-1, 3).astype(np.float64) / 65535.0
    luminance = _pq_to_nits(pixels) @ _BT2020_LUMA
    return float(np.clip(np.percentile(luminance, 99), 80.0, 400.0))


# --- Working copy -------------------------------------------------------------------------------------


def _video_filter(info: SourceInfo, lut_name: str | None, fps: str) -> str:
    # `fps` resamples by presentation time (each output frame is the one on screen at that instant).
    # Output-side `-fps_mode cfr -r` was measured to shift changes by up to 0.5 s on VFR input.
    # The scale directly before `format` performs the final conversion, so it carries the BT.709 matrix.
    to_bt709 = (
        f"scale=out_color_matrix=bt709:out_range=tv:{ACCURATE_SCALE},format=yuv420p,"
        "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
    )
    even = f"fps={fps},scale=trunc(iw/2)*2:trunc(ih/2)*2"
    if lut_name is None:
        return f"{even},{to_bt709}"
    return f"{even},{_yuv_to_rgb48(info)},lut3d=file={lut_name}:interp=tetrahedral,{to_bt709}"


def _recording_lock(key: str) -> Lock:
    with _recording_locks_guard:
        return _recording_locks.setdefault(key, Lock())


def build_working_copy(
    source: Path,
    destination: Path,
    *,
    info: SourceInfo | None = None,
    progress_callback: IngestProgressCallback | None = None,
    cancellation_callback: CancellationCallback | None = None,
) -> SourceInfo:
    """Transcode `source` into the working copy at `destination` (written atomically)."""
    info = info or inspect_source(source)
    progress_callback = progress_callback or (lambda fraction: None)
    cancellation_callback = cancellation_callback or (lambda: False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.stem + ".partial.mp4")

    lut_name = None
    if info.hdr_kind is not None:
        write_hdr_lut(destination.parent / LUT_FILENAME, info.hdr_kind, estimate_reference_white(source, info))
        lut_name = LUT_FILENAME

    fps = working_fps(info)
    keyframe_interval = max(1, round(float(fps) * 2))
    command = [
        "ffmpeg", "-hide_banner", "-v", "error", "-nostats", "-progress", "pipe:1", "-y",
        "-i", str(source.resolve()),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", _video_filter(info, lut_name, fps),
        "-fps_mode", "passthrough", "-t", f"{info.duration_ms / 1000:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", str(WORKING_CRF), "-g", str(keyframe_interval),
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(partial.resolve()),
    ]
    with _global_slots, tempfile.TemporaryFile() as stderr:
        # cwd lets the filter graph name the LUT without escaping an arbitrary absolute path.
        process = subprocess.Popen(
            command, cwd=destination.parent, stdout=subprocess.PIPE, stderr=stderr, text=True
        )
        try:
            assert process.stdout is not None
            for line in process.stdout:
                if cancellation_callback():
                    process.terminate()
                    process.wait(timeout=10)
                    raise CancellationRequested("Run cancelled while preparing the recording.")
                key, _, value = line.strip().partition("=")
                if key == "out_time_us" and value.isdigit():
                    progress_callback(min(1.0, (int(value) / 1000) / max(1, info.duration_ms)))
            return_code = process.wait()
        except BaseException:
            if process.poll() is None:
                process.kill()
            partial.unlink(missing_ok=True)
            raise
        if return_code != 0:
            stderr.seek(0)
            partial.unlink(missing_ok=True)
            message = stderr.read().decode(errors="replace").strip()
            raise VideoToolError(message or "Could not prepare a working copy of the recording.")
    os.replace(partial, destination)
    progress_callback(1.0)
    return info


def ensure_working_copy(
    source: Path,
    destination: Path,
    *,
    key: str,
    progress_callback: IngestProgressCallback | None = None,
    cancellation_callback: CancellationCallback | None = None,
) -> bool:
    """Build the working copy unless it exists. Returns True when it was built by this call."""
    with _recording_lock(key):
        if destination.exists() and destination.stat().st_size > 0:
            return False
        build_working_copy(
            source,
            destination,
            progress_callback=progress_callback,
            cancellation_callback=cancellation_callback,
        )
        return True
