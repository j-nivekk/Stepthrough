"""Stress matrix: generated scenarios re-encoded the way real uploads arrive, plus interface noise.

Each scenario is rendered once (the MJPEG file doubles as the visual reference), then turned into "uploads":

    encodings : raw (the generated file itself), h264_cfr (a compressed upload), h264_vfr (phone-style: a
                frame is written only when the screen changes, at least once a second), and for the wider
                evaluation (``wide.py``) hevc_vfr (iPhone-style HEVC), webm (VP9), rotated (stored sideways
                with rotation metadata), h264_bt709 and h264_full_range (tagged colour), hdr_pq and hdr_hlg
                (10-bit HEVC, BT.2020)
    overlays  : cursor (blinking caret), spinner (looping activity indicator), pointer (a desktop mouse
                pointer that keeps moving), clock (a status-bar clock ticking every second)

Uploads go through the same pipeline as the app (ingest working copy, ffprobe metadata, detection).
Besides precision/recall it reports *screenshot fidelity*: for each matched event, whether the exported
PNG shows the settled post-event state rather than the pre-event one.

The stable-screen engine also returns the opening screen as step 0. Ground truth lists changes only, so
that candidate is scored separately ("opening": present and showing frame 0) and left out of
precision/recall. The ``step_scenarios`` (typing, toggles) run with ``--set all`` or ``steps``.

Frames are streamed from the rendered file, never held at full size, so phone-native and Retina-sized
scenarios fit in memory. The comparisons use a copy of every frame scaled to at most 480 pixels.

Usage (from backend/)::

    python -m tests.eval.stress --set all               # full matrix
    python -m tests.eval.stress --no-ingest             # detect on the upload directly (pre-ingest behaviour)
    python -m tests.eval.stress --only nav_basic --variants h264_vfr,h264_vfr+spinner
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Iterator

import cv2
import numpy as np

from app.models import RunSettings, StableSettings
from app.services.ingest import build_working_copy
from app.services.stable_detection import detect_candidates_stable
from app.services.video import probe_video

from .evaluator import evaluate
from .scenarios import BASELINE_SCENARIOS
from .step_scenarios import STEP_SCENARIOS
from .types import EvalMetrics, GroundTruthEvent

SCENARIO_SETS = {
    "baseline": BASELINE_SCENARIOS,
    "steps": STEP_SCENARIOS,
    "all": [*BASELINE_SCENARIOS, *STEP_SCENARIOS],
}

ENCODINGS = (
    "raw", "h264_cfr", "h264_vfr", "hevc_vfr", "webm", "rotated", "h264_bt709", "h264_full_range", "hdr_pq", "hdr_hlg",
)
OVERLAYS = ("cursor", "spinner", "pointer", "clock")
VARIANTS = (
    ("raw", None),
    ("h264_cfr", None),
    ("h264_vfr", None),
    *(("h264_vfr", overlay) for overlay in OVERLAYS),
)

REFERENCE_LONG_EDGE = 480  # comparison frames are scaled to this when the video is larger than 640 px


def variant_label(encoding: str, overlay: str | None) -> str:
    return encoding + (f"+{overlay}" if overlay else "")


def parse_variant(label: str) -> tuple[str, str | None]:
    encoding, _, overlay = label.partition("+")
    return encoding, overlay or None


# --- Reference frames ------------------------------------------------------------------------------


@dataclass
class Reference:
    """A rendered scenario: the full-size file, its frame rate and size, and small copies of every frame."""

    path: Path
    fps: float
    size: tuple[int, int]  # width, height of the rendered file
    frames: list[np.ndarray]  # every frame, at most 480 px on the long edge when the file is larger than 640 px


def iter_frames(path: Path) -> Iterator[np.ndarray]:
    capture = cv2.VideoCapture(str(path))
    try:
        while (frame := capture.read()[1]) is not None:
            yield frame
    finally:
        capture.release()


def _shrink(frame: np.ndarray) -> np.ndarray:
    height, width = frame.shape[:2]
    if max(width, height) <= 640:
        return frame
    scale = REFERENCE_LONG_EDGE / max(width, height)
    return cv2.resize(frame, (max(2, round(width * scale)), max(2, round(height * scale))), interpolation=cv2.INTER_AREA)


def load_reference(path: Path) -> Reference:
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    return Reference(path, fps, (width, height), [_shrink(frame) for frame in iter_frames(path)])


def read_frames(path: Path) -> tuple[list[np.ndarray], float]:
    """Every frame at full size (small scenarios only); prefer ``load_reference``."""
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS)
    capture.release()
    return list(iter_frames(path)), fps


# --- Interface noise -------------------------------------------------------------------------------


def draw_overlay(frame: np.ndarray, t: float, kind: str) -> np.ndarray:
    """Draw one kind of interface noise on a copy of ``frame`` at time ``t`` (seconds).

    Sizes are given for a 360 px short edge and scaled up for larger frames, so a pointer on a Retina
    recording is the size a pointer really is there."""
    frame = frame.copy()
    height, width = frame.shape[:2]
    s = max(1.0, min(width, height) / 360)
    line = max(1, round(s))
    if kind == "cursor":  # 530 ms caret blink in a text-field-sized spot
        if int(t / 0.53) % 2 == 0:
            x, y = int(width * 0.30), int(height * 0.55)
            cv2.line(frame, (x, y), (x, y + max(10, height // 30)), (20, 20, 20), 2 * line)
    elif kind == "spinner":  # activity indicator rotating continuously in a corner
        cx, cy, radius = int(width * 0.88), int(height * 0.80), max(8, height // 28)
        for k in range(8):
            angle = (k / 8) * 2 * math.pi + t * 2 * math.pi
            shade = int(60 + 190 * (((k + int(t * 8)) % 8) / 7))
            centre = (int(cx + radius * math.cos(angle)), int(cy + radius * math.sin(angle)))
            cv2.circle(frame, centre, max(2, radius // 4), (shade, shade, shade), -1)
    elif kind == "pointer":  # desktop mouse pointer wandering on a Lissajous path
        x = int(width * (0.5 + 0.4 * math.sin(t * 1.3)))
        y = int(height * (0.5 + 0.35 * math.sin(t * 0.9 + 1.0)))
        shape = np.array([[0, 0], [0, 18], [5, 14], [12, 14]], np.float64) * s
        arrow = (shape + [x, y]).astype(np.int32)
        cv2.fillPoly(frame, [arrow], (0, 0, 0))
        cv2.polylines(frame, [arrow], True, (255, 255, 255), line)
    elif kind == "clock":  # status-bar clock text changing every second
        cv2.rectangle(frame, (round(8 * s), round(2 * s)), (round(90 * s), round(18 * s)), (245, 245, 245), -1)
        label = f"9:{41 + int(t):02d}:{int(t * 10) % 10}"
        cv2.putText(frame, label, (round(10 * s), round(15 * s)), cv2.FONT_HERSHEY_SIMPLEX, 0.42 * s, (10, 10, 10), line)
    else:
        raise ValueError(f"Unknown overlay: {kind}")
    return frame


def apply_overlay(frames: list[np.ndarray], fps: float, kind: str) -> list[np.ndarray]:
    return [draw_overlay(frame, index / fps, kind) for index, frame in enumerate(frames)]


def source_frames(reference: Reference, overlay: str | None) -> Iterator[np.ndarray]:
    for index, frame in enumerate(iter_frames(reference.path)):
        yield draw_overlay(frame, index / reference.fps, overlay) if overlay else frame


# --- Uploads ---------------------------------------------------------------------------------------


def write_mjpeg(frames: Iterable[np.ndarray], fps: float, path: Path) -> None:
    writer = None
    for frame in frames:
        if writer is None:
            height, width = frame.shape[:2]
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (width, height))
        writer.write(frame)
    if writer is not None:
        writer.release()


def _pipe(
    frames: Iterable[np.ndarray],
    size: tuple[int, int],
    fps: float,
    output_args: list[str],
    destination: Path,
    *,
    pix_fmt: str = "bgr24",
    convert: Callable[[np.ndarray], bytes] | None = None,
    input_args: tuple[str, ...] = (),
) -> None:
    """Feed raw frames to an ffmpeg encoder."""
    width, height = size
    command = [
        "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{width}x{height}",
        "-r", f"{fps:.6g}", *input_args, "-i", "-", *output_args, str(destination),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame in frames:
            process.stdin.write(convert(frame) if convert else frame.tobytes())
    finally:
        process.stdin.close()
    if process.wait() != 0:
        raise subprocess.CalledProcessError(process.returncode, command)


def _vfr_concat(frames: Iterable[np.ndarray], fps: float, work: Path) -> Path:
    """ReplayKit-style timing: only exact duplicates are dropped (at least one frame per second is kept), and
    presentation times keep real time. Returns a concat-demuxer listing of the kept frames."""
    work.mkdir(parents=True, exist_ok=True)
    kept: list[int] = []
    previous: np.ndarray | None = None
    last_kept_t = 0.0
    count = 0
    pending: tuple[int, np.ndarray] | None = None  # the last frame, written on stop even if it is a duplicate
    for index, frame in enumerate(frames):
        count = index + 1
        t = index / fps
        if previous is None or not np.array_equal(frame, previous) or t - last_kept_t >= 1.0:
            kept.append(index)
            last_kept_t = t
            cv2.imwrite(str(work / f"{index:05d}.png"), frame, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            pending = None
        else:
            pending = (index, frame)
        previous = frame
    if pending is not None:  # recorders write a final frame on stop, which fixes the duration
        index, frame = pending
        kept.append(index)
        cv2.imwrite(str(work / f"{index:05d}.png"), frame, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    lines = []
    for position, index in enumerate(kept):
        following = kept[position + 1] if position + 1 < len(kept) else count
        lines += [f"file '{work / f'{index:05d}.png'}'", f"duration {(following - index) / fps:.6f}"]
    lines.append(f"file '{work / f'{kept[-1]:05d}.png'}'")
    listing = work / "list.txt"
    listing.write_text("\n".join(lines) + "\n")
    return listing


# BT.709 -> BT.2020 primaries, BT.2100 constants, for the HDR uploads.
_BT709_TO_BT2020 = np.array([[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]])
_BT2020_LUMA = np.array([0.2627, 0.6780, 0.0593])
HDR_WHITE_NITS = 203.0  # BT.2408 reference white: where SDR white sits in an HDR recording


def hdr_yuv420p10(frame: np.ndarray, kind: str) -> bytes:
    """An SDR frame as a 10-bit BT.2020 HDR frame (PQ or HLG), with SDR white at 203 nits, as yuv420p10le.

    HLG is encoded through the inverse of the BT.2100 OOTF for a 1000-nit display, so a decoder that applies
    that OOTF (as the app's tone mapping does) gets SDR white back at 203 nits."""
    rgb = frame[..., ::-1].astype(np.float32) / 255.0
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    linear = np.clip(linear @ _BT709_TO_BT2020.T.astype(np.float32), 0.0, None)
    if kind == "pq":
        m1, m2 = 2610 / 16384, 2523 / 4096 * 128
        c1, c2, c3 = 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
        power = np.power(linear * (HDR_WHITE_NITS / 10000.0), m1)
        signal = np.power((c1 + c2 * power) / (1 + c3 * power), m2)
    elif kind == "hlg":
        a, b, c = 0.17883277, 0.28466892, 0.55991073
        white_scene = (HDR_WHITE_NITS / 1000.0) ** (1 / 1.2)
        luma = np.clip(linear @ _BT2020_LUMA.astype(np.float32), 1e-6, None)[..., None]
        scene = np.clip(white_scene * linear * np.power(luma, -1 / 6), 0.0, 1.0)
        signal = np.where(scene <= 1 / 12, np.sqrt(3 * scene), a * np.log(np.maximum(12 * scene - b, 1e-6)) + c)
    else:
        raise ValueError(kind)
    y = signal @ _BT2020_LUMA.astype(np.float32)
    cb = (signal[..., 2] - y) / 1.8814
    cr = (signal[..., 0] - y) / 1.4746
    height, width = y.shape

    def chroma(plane: np.ndarray) -> np.ndarray:
        return plane.reshape(height // 2, 2, width // 2, 2).mean(axis=(1, 3))

    planes = (
        np.round(64 + 876 * np.clip(y, 0, 1)),
        np.round(512 + 896 * np.clip(chroma(cb), -0.5, 0.5)),
        np.round(512 + 896 * np.clip(chroma(cr), -0.5, 0.5)),
    )
    return b"".join(plane.astype("<u2").tobytes() for plane in planes)


def upload_suffix(encoding: str) -> str:
    """The file extension ``encode_upload`` gives an upload in ``encoding``."""
    return ".webm" if encoding == "webm" else ".mp4"


def encode_upload(
    frames: Iterable[np.ndarray], fps: float, destination: Path, encoding: str, size: tuple[int, int] | None = None
) -> Path:
    """Encode ``frames`` as ``encoding``; returns the upload path (its suffix depends on the encoding)."""
    frames = iter(frames)
    if size is None:
        first = next(frames)
        size = (first.shape[1], first.shape[0])
        frames = _chain(first, frames)
    x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
    x265 = ["-c:v", "libx265", "-preset", "superfast", "-crf", "26", "-x265-params", "log-level=error", "-tag:v", "hvc1"]
    destination = destination.with_suffix(upload_suffix(encoding))
    if encoding == "h264_cfr":
        source = destination.with_suffix(".avi")
        write_mjpeg(frames, fps, source)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(source), *x264, str(destination)], check=True)
    elif encoding in ("h264_vfr", "hevc_vfr"):
        # No B-frames: with B-frames and the long gaps of a phone recording, ffmpeg's MP4 muxer writes a
        # duration that ends before the last frame (about 0.9 s short after a one-second still), which real
        # recorders do not, and the app would then cut the end off the working copy.
        listing = _vfr_concat(frames, fps, destination.parent / "vfr_frames")
        codec = [*x264, "-bf", "0"] if encoding == "h264_vfr" else [
            "-c:v", "libx265", "-preset", "superfast", "-crf", "26", "-x265-params", "log-level=error:bframes=0",
            "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
        ]
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-fps_mode", "vfr",
             *codec, str(destination)],
            check=True,
        )
    elif encoding == "webm":
        _pipe(frames, size, fps, ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1",
                                  "-b:v", "0", "-crf", "34", "-pix_fmt", "yuv420p"], destination)
    elif encoding == "rotated":
        # Stored sideways with rotation metadata, as phones write landscape-held recordings.
        sideways = destination.with_name("sideways.mp4")
        rotated = (cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE) for frame in frames)
        _pipe(rotated, (size[1], size[0]), fps, x264, sideways)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-display_rotation:v:0", "90", "-i", str(sideways), "-c", "copy",
             str(destination)],
            check=True,
        )
    elif encoding in ("h264_bt709", "h264_full_range"):
        out_range = "pc" if encoding == "h264_full_range" else "tv"
        _pipe(frames, size, fps, [
            "-vf", f"scale=out_color_matrix=bt709:out_range={out_range}:flags=accurate_rnd+full_chroma_int,format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", out_range,
        ], destination)
    elif encoding in ("hdr_pq", "hdr_hlg"):
        kind = encoding.removeprefix("hdr_")
        transfer = "smpte2084" if kind == "pq" else "arib-std-b67"
        tags = ["-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc", "-color_range", "tv"]
        _pipe(
            frames, size, fps,
            ["-c:v", "libx265", "-preset", "superfast", "-crf", "24", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
             "-x265-params", f"log-level=error:colorprim=bt2020:transfer={transfer}:colormatrix=bt2020nc:range=limited",
             *tags],
            destination,
            pix_fmt="yuv420p10le",
            convert=lambda frame: hdr_yuv420p10(frame, kind),
            input_args=tuple(tags),
        )
    else:
        raise ValueError(f"Unknown encoding: {encoding}")
    return destination


def _chain(first: np.ndarray, rest: Iterator[np.ndarray]) -> Iterator[np.ndarray]:
    yield first
    yield from rest


# --- Scoring ---------------------------------------------------------------------------------------


def _small_gray(image: np.ndarray) -> np.ndarray:
    size = (160, 90) if image.shape[1] > image.shape[0] else (90, 160)
    return cv2.resize(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), size).astype(np.float32)


def screenshot_fidelity(
    candidates: list[dict],
    ground_truth: list[GroundTruthEvent],
    metrics: EvalMetrics,
    reference_frames: list[np.ndarray],
    reference_fps: float,
) -> tuple[int, int]:
    """(correct, matched): a matched screenshot is correct when it is at least twice as close to the
    settled post-event frame as to the pre-event frame (or near-identical to the post-event frame).

    Distances are measured where the pre- and post-event frames differ, so a small change (a toggle, a
    typed word) is judged on that change rather than drowned in compression noise across the frame."""
    ordered = sorted(ground_truth, key=lambda event: event.start_ms)
    count = len(reference_frames)
    correct = matched = 0
    for position, result in enumerate(metrics.per_event_results):
        if result.matched_candidate_index is None:
            continue
        event = result.ground_truth
        next_start = ordered[position + 1].start_ms if position + 1 < len(ordered) else 10**9
        post = reference_frames[min(count - 1, int(min(event.end_ms + 400, next_start - 60) / 1000 * reference_fps))]
        pre = reference_frames[min(count - 1, int(max(0, event.start_ms - 150) / 1000 * reference_fps))]
        shot = cv2.imread(candidates[result.matched_candidate_index]["image_path"])
        shot = _small_gray(cv2.resize(shot, (post.shape[1], post.shape[0])))
        pre_g, post_g = _small_gray(pre), _small_gray(post)
        region = np.abs(pre_g - post_g) > 10.0
        if region.sum() < 4:
            region = np.ones_like(region)
        d_pre = float(np.mean(np.abs(shot - pre_g)[region]))
        d_post = float(np.mean(np.abs(shot - post_g)[region]))
        matched += 1
        correct += int(d_post <= d_pre * 0.5 or d_post < 1.0)
    return correct, matched


@dataclass
class VariantResult:
    scenario: str
    variant: str
    metrics: EvalMetrics
    screenshots_correct: int
    screenshots_matched: int
    candidates: list[dict] = field(repr=False, default_factory=list)
    opening_ok: bool | None = None  # stable engine only: step 0 present and showing the first frame
    seconds: float = 0.0
    labels_agree: int = 0
    labels_checked: int = 0
    upload: Path | None = field(repr=False, default=None)  # the file the app was given


# Ground-truth event types and the transition labels that describe them correctly.
LABEL_MATCHES = {
    "navigation": {"navigation"},
    "scroll": {"scroll"},
    "card_swap": {"feed_card_swap"},
    "modal": {"modal"},
    "content_update": {"content_update", "text_entry"},
    "small_ui_change": {"small_ui_change", "content_update"},
    "loading": {"content_update", "navigation"},
}


def label_agreement(candidates: list[dict], metrics: EvalMetrics) -> tuple[int, int]:
    agree = checked = 0
    for result in metrics.per_event_results:
        if result.matched_candidate_index is None:
            continue
        wanted = LABEL_MATCHES.get(result.ground_truth.event_type)
        if wanted is None:
            continue
        label = (candidates[result.matched_candidate_index].get("score_breakdown") or {}).get("transition_type")
        checked += 1
        agree += int(label in wanted)
    return agree, checked


def make_upload(reference: Reference, encoding: str, overlay: str | None, work: Path) -> Path:
    if encoding == "raw":
        if not overlay:
            return reference.path
        upload = work / "upload.avi"
        write_mjpeg(source_frames(reference, overlay), reference.fps, upload)
        return upload
    return encode_upload(source_frames(reference, overlay), reference.fps, work / "upload", encoding, reference.size)


def detect(video: Path, work: Path, stable: StableSettings) -> list[dict]:
    metadata = probe_video(video)
    return detect_candidates_stable(
        video_path=video,
        frames_dir=work / "frames",
        duration_ms=metadata.duration_ms,
        fps=metadata.fps,
        settings=RunSettings(analysis_engine="stable_v3", stable=stable),
        width=metadata.width,
        height=metadata.height,
    )


def run_variant(
    scenario_name: str,
    scenario_dir: Path,
    reference: Reference,
    ground_truth: list[GroundTruthEvent],
    encoding: str,
    overlay: str | None,
    *,
    ingest: bool = True,
    stable: StableSettings | None = None,
    recording_type: str | None = None,
) -> VariantResult:
    label = variant_label(encoding, overlay)
    work = scenario_dir / label.replace("+", "_")
    work.mkdir(parents=True, exist_ok=True)
    upload = make_upload(reference, encoding, overlay, work)
    video = upload
    if ingest:
        video = work / "working" / "working.mp4"
        build_working_copy(upload, video)
    if stable is None:
        # A wandering mouse pointer is what the "computer" recording type is for.
        stable = StableSettings(recording_type=recording_type or ("desktop" if overlay == "pointer" else "phone"))
    started = time.perf_counter()
    candidates = detect(video, work, stable)
    opening_ok = None
    opening = [c for c in candidates if (c.get("score_breakdown") or {}).get("transition_type") == "opening_screen"]
    if stable.include_opening_screen:
        opening_ok = len(opening) == 1 and _shows_frame(opening[0], reference.frames[0], reference.frames)
    candidates = [c for c in candidates if c not in opening]
    seconds = time.perf_counter() - started
    metrics = evaluate(candidates, ground_truth)
    correct, matched = screenshot_fidelity(candidates, ground_truth, metrics, reference.frames, reference.fps)
    agree, checked = label_agreement(candidates, metrics)
    return VariantResult(scenario_name, label, metrics, correct, matched, candidates, opening_ok, seconds, agree, checked,
                         upload)


def _shows_frame(candidate: dict, expected: np.ndarray, frames: list[np.ndarray]) -> bool:
    """The screenshot is closer to ``expected`` than to any visibly different frame of the clip, judged where
    that frame differs from ``expected`` (as in ``screenshot_fidelity``), so screens that share most of their
    layout are told apart by what actually changed. Frames in the middle of a transition are not compared."""
    shot = cv2.imread(candidate["image_path"])
    if shot is None:
        return False
    shot = _small_gray(cv2.resize(shot, (expected.shape[1], expected.shape[0])))
    target = _small_gray(expected)
    if float(np.mean(np.abs(shot - target))) < 2.0:
        return True
    small = [_small_gray(frame) for frame in frames]
    # Only settled frames count as other screens: a frame half-way through a fade is not one.
    settled = [small[i] for i in range(1, len(small) - 1)
               if float(np.mean(np.abs(small[i] - small[i - 1]))) < 0.5 and float(np.mean(np.abs(small[i + 1] - small[i]))) < 0.5]
    for other in settled[:: max(1, len(settled) // 60)]:
        region = np.abs(other - target) > 10.0
        if region.sum() < 4:
            continue
        if float(np.mean(np.abs(shot - target)[region])) * 2 > float(np.mean(np.abs(shot - other)[region])):
            return False
    return True


def echo_result(name: str, result: VariantResult) -> None:
    m = result.metrics
    print(
        f"  {name:28s} {result.variant:18s} cand={m.total_candidates:2d} "
        f"TP={m.total_ground_truth - m.missed_events} FP={m.false_positives} miss={m.missed_events} "
        f"shots={result.screenshots_correct}/{result.screenshots_matched}"
        + ("" if result.opening_ok is None else f" opening={'ok' if result.opening_ok else 'WRONG'}")
        + f" labels={result.labels_agree}/{result.labels_checked} {result.seconds:.1f}s",
        flush=True,
    )


def run_matrix(
    *,
    ingest: bool = True,
    scenarios: set[str] | None = None,
    variants: set[str] | None = None,
    work_dir: Path,
    echo: bool = False,
    scenario_set: str = "baseline",
    stable: StableSettings | None = None,
) -> list[VariantResult]:
    results = []
    for name, factory in SCENARIO_SETS[scenario_set]:
        if scenarios and name not in scenarios:
            continue
        scenario_dir = work_dir / name
        scenario_dir.mkdir(parents=True, exist_ok=True)
        scenario = factory(scenario_dir, 30)
        reference = load_reference(scenario.video_path)
        for encoding, overlay in VARIANTS:
            if variants and variant_label(encoding, overlay) not in variants:
                continue
            result = run_variant(
                name, scenario_dir, reference, scenario.ground_truth, encoding, overlay, ingest=ingest, stable=stable,
            )
            results.append(result)
            if echo:
                echo_result(name, result)
    return results


def summarise(results: list[VariantResult], key: Callable[[VariantResult], str] = lambda r: r.variant) -> dict[str, dict[str, float | int]]:
    summary: dict[str, dict[str, float | int]] = {}
    for result in results:
        row = summary.setdefault(
            key(result),
            {"tp": 0, "fp": 0, "gt": 0, "shots_correct": 0, "shots_matched": 0, "opening_ok": 0, "opening_checked": 0,
             "seconds": 0.0, "labels_agree": 0, "labels_checked": 0},
        )
        row["labels_agree"] += result.labels_agree
        row["labels_checked"] += result.labels_checked
        m = result.metrics
        row["tp"] += m.total_ground_truth - m.missed_events
        row["fp"] += m.false_positives
        row["gt"] += m.total_ground_truth
        row["shots_correct"] += result.screenshots_correct
        row["shots_matched"] += result.screenshots_matched
        row["seconds"] = round(row["seconds"] + result.seconds, 2)
        if result.opening_ok is not None:
            row["opening_checked"] += 1
            row["opening_ok"] += int(result.opening_ok)
    for row in summary.values():
        precision = row["tp"] / max(1, row["tp"] + row["fp"])
        recall = row["tp"] / max(1, row["gt"])
        row["precision"] = round(precision, 3)
        row["recall"] = round(recall, 3)
        row["f1"] = round(2 * precision * recall / max(1e-9, precision + recall), 3)
    return summary


def print_summary(summary: dict[str, dict[str, float | int]], heading: str, title: str = "variant") -> None:
    print(f"\n{title:18s}  P     R     F1    screenshots   opening  labels  time   ({heading})")
    for variant, row in summary.items():
        share = row["shots_correct"] / max(1, row["shots_matched"])
        opening = f"{row['opening_ok']}/{row['opening_checked']}" if row["opening_checked"] else "-"
        print(
            f"{variant:18s} {row['precision']:.2f}  {row['recall']:.2f}  {row['f1']:.2f}   "
            f"{row['shots_correct']}/{row['shots_matched']} ({share:.0%})   {opening:7s}  "
            f"{row['labels_agree'] / max(1, row['labels_checked']):.0%}    {row['seconds']:.0f}s"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--set", default="baseline", choices=tuple(SCENARIO_SETS), help="scenario set")
    parser.add_argument("--no-ingest", action="store_true", help="detect on the upload itself (pre-ingest behaviour)")
    parser.add_argument("--only", default="", help="comma-separated scenario names")
    parser.add_argument("--variants", default="", help="comma-separated variant labels, e.g. h264_vfr,h264_vfr+clock")
    parser.add_argument("--json", default="", help="write the per-variant summary to this file")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        results = run_matrix(
            ingest=not args.no_ingest,
            scenarios={name for name in args.only.split(",") if name} or None,
            variants={name for name in args.variants.split(",") if name} or None,
            work_dir=Path(tmp),
            echo=True,
            scenario_set=args.set,
        )
    summary = summarise(results)
    print_summary(summary, f"stable_v3, {'upload only' if args.no_ingest else 'working copy'}")
    if args.json:
        Path(args.json).write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    sys.exit(main())
