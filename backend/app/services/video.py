from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile

from ..utils import sanitize_filename, slugify, timecode_from_ms


class VideoToolError(RuntimeError):
    pass


FRAME_EXTRACTION_FALLBACK_OFFSETS_MS = (0, 33, 80, 160, 320, 640, 1000, 2000, 4000)


@dataclass(frozen=True)
class VideoMetadata:
    duration_ms: int
    width: int
    height: int
    fps: float


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise VideoToolError(result.stderr.strip() or "Command failed")
    return result


def _parse_fraction(value: str | None) -> float:
    if not value or value == "0/0":
        return 0.0
    if "/" in value:
        left, right = value.split("/", 1)
        denominator = float(right or 1)
        return float(left) / denominator if denominator else 0.0
    return float(value)


def probe_video(path: Path) -> VideoMetadata:
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(path),
        ]
    )
    payload = json.loads(result.stdout)
    video_stream = next(
        (stream for stream in payload.get("streams", []) if stream.get("codec_type") == "video"),
        None,
    )
    if video_stream is None:
        raise VideoToolError("No video stream detected in uploaded file.")

    duration_seconds = float(video_stream.get("duration") or payload.get("format", {}).get("duration") or 0)
    return VideoMetadata(
        duration_ms=max(1, int(duration_seconds * 1000)),
        width=int(video_stream.get("width") or 0),
        height=int(video_stream.get("height") or 0),
        fps=round(_parse_fraction(video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate")), 3),
    )


async def save_upload_file(upload: UploadFile, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            output.write(chunk)
    await upload.close()


def _frame_extract_timestamps(timestamp_ms: int) -> list[int]:
    attempts: list[int] = []
    seen: set[int] = set()
    for offset_ms in FRAME_EXTRACTION_FALLBACK_OFFSETS_MS:
        candidate_ms = max(0, timestamp_ms - offset_ms)
        if candidate_ms in seen:
            continue
        attempts.append(candidate_ms)
        seen.add(candidate_ms)
    if 0 not in seen:
        attempts.append(0)
    return attempts


def extract_frame(video_path: Path, output_path: Path, timestamp_ms: int) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    last_command_error: VideoToolError | None = None
    saw_empty_output = False

    for candidate_ms in _frame_extract_timestamps(timestamp_ms):
        if output_path.exists():
            output_path.unlink()
        seconds = max(0.0, candidate_ms / 1000)
        try:
            run_command(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{seconds:.3f}",
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    "-y",
                    str(output_path),
                ]
            )
        except VideoToolError as exc:
            last_command_error = exc
            continue

        if output_path.exists() and output_path.stat().st_size > 0:
            return

        saw_empty_output = True

    if output_path.exists():
        output_path.unlink(missing_ok=True)
    if saw_empty_output:
        raise VideoToolError("Could not extract a frame at the requested timestamp.")
    if last_command_error is not None:
        raise last_command_error
    raise VideoToolError("Could not extract a frame at the requested timestamp.")


def recording_slug_from_filename(filename: str) -> str:
    return slugify(Path(sanitize_filename(filename)).stem)


def display_timecode(timestamp_ms: int) -> str:
    return timecode_from_ms(timestamp_ms, slug_style=False)


def slug_timecode(timestamp_ms: int) -> str:
    return timecode_from_ms(timestamp_ms, slug_style=True)


def export_filename(recording_slug: str, step_index: int, timestamp_ms: int) -> str:
    return f"{recording_slug}__step-{step_index:03d}__{slug_timecode(timestamp_ms)}.png"
