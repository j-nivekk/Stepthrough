"""Test cards: generated screens that check one property exactly, for the wider evaluation (``wide.py``).

Unlike the interface scenarios, these are not meant to look like an app. Each one isolates something the
engine or the working copy must get right:

- ``countdown``: colour bars and a grey ramp that never change, and a digit that changes every second.
  Every change is a step at a known time; nothing else may become one.
- ``countdown_sweep``: the same, plus a dial whose hand turns once a second, the way a countdown leader or
  a progress ring keeps moving. The engine has to ignore the dial and still find every digit.
- ``equal_luma``: a full-screen colour changes to another of the same brightness (a known blind spot:
  frames are compared in grey), then to a clearly darker one.
- ``size_sweep``: dark squares of growing size appear one by one on a plain screen, to find where the
  "smallest change" setting really draws the line.
- ``colour_accuracy``: bars, a ramp, white and black, encoded as an upload and turned into a working copy;
  the colour of every patch is compared with the original.
- ``long_recording``: a recording longer than the analysis keeps in memory (about five minutes), so the
  engine has to decode it twice.

The builders take a ``ScenarioContext`` like the device-aware scenarios, so they run at any device size.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import cv2
import numpy as np

from app.models import StableSettings
from app.services.ingest import build_working_copy
from app.services.stable_detection import ANALYSIS_LONG_EDGE, FRAME_MEMORY_BUDGET_BYTES, TARGET_SAMPLE_FPS
from app.services.video import extract_frame

from . import rendering as r
from .evaluator import evaluate
from .types import GroundTruthEvent, ScenarioContext, ScenarioResult

# 75 % colour bars, as on a broadcast test card (RGB).
BARS = ((191, 191, 191), (191, 191, 0), (0, 191, 191), (0, 191, 0), (191, 0, 191), (191, 0, 0), (0, 0, 191))
RAMP_STEPS = 11


def _bgr(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    return rgb[2], rgb[1], rgb[0]


def card_patches(width: int, height: int) -> list[tuple[str, tuple[int, int, int, int], tuple[int, int, int]]]:
    """(name, (x, y, w, h), RGB) for every flat patch of the test card background."""
    patches = []
    bar_h = round(height * 0.40)
    for index, colour in enumerate(BARS):
        x0, x1 = round(width * index / len(BARS)), round(width * (index + 1) / len(BARS))
        patches.append((f"bar {index}", (x0, 0, x1 - x0, bar_h), colour))
    ramp_y, ramp_h = bar_h, round(height * 0.12)
    for index in range(RAMP_STEPS):
        level = round(255 * index / (RAMP_STEPS - 1))
        x0, x1 = round(width * index / RAMP_STEPS), round(width * (index + 1) / RAMP_STEPS)
        patches.append((f"grey {level}", (x0, ramp_y, x1 - x0, ramp_h), (level, level, level)))
    return patches


def card_background(width: int, height: int) -> np.ndarray:
    frame = np.full((height, width, 3), 24, np.uint8)
    for _, (x, y, w, h), colour in card_patches(width, height):
        frame[y : y + h, x : x + w] = _bgr(colour)
    return frame


def _digit_frame(background: np.ndarray, digit: int) -> np.ndarray:
    frame = background.copy()
    height, width = frame.shape[:2]
    short = min(width, height)
    centre = (width // 2, round(height * 0.76))
    radius = round(short * 0.17)
    cv2.circle(frame, centre, radius, (235, 235, 235), -1, cv2.LINE_AA)
    scale = radius / 28
    text = str(digit)
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, scale, max(2, round(scale * 2)))
    cv2.putText(frame, text, (centre[0] - tw // 2, centre[1] + th // 2), cv2.FONT_HERSHEY_DUPLEX, scale, (20, 20, 20),
                max(2, round(scale * 2)), cv2.LINE_AA)
    return frame


def _sweep(frame: np.ndarray, t: float) -> np.ndarray:
    """A dial in the lower right corner whose hand turns once a second."""
    frame = frame.copy()
    height, width = frame.shape[:2]
    short = min(width, height)
    centre = (round(width * 0.88), round(height * 0.92))
    radius = round(short * 0.06)
    cv2.circle(frame, centre, radius, (200, 200, 200), max(1, radius // 10), cv2.LINE_AA)
    angle = 2 * math.pi * t - math.pi / 2
    tip = (round(centre[0] + radius * 0.9 * math.cos(angle)), round(centre[1] + radius * 0.9 * math.sin(angle)))
    cv2.line(frame, centre, tip, (240, 240, 240), max(2, radius // 8), cv2.LINE_AA)
    return frame


def _result(path: Path, context: ScenarioContext, events: list[GroundTruthEvent], duration_s: float, description: str) -> ScenarioResult:
    return ScenarioResult(
        video_path=path,
        ground_truth=events,
        duration_ms=round(duration_s * 1000),
        fps=context.source_fps,
        width=context.encoded_width,
        height=context.encoded_height,
        description=description,
        category="content",
        difficulty="medium",
        variant_id=context.variant_id,
        profile_id=context.profile_id,
        shell=context.shell,
        logical_width=context.logical_width,
        logical_height=context.logical_height,
        encoded_width=context.encoded_width,
        encoded_height=context.encoded_height,
        source_fps=context.source_fps,
    )


def _countdown(output_dir: Path, context: ScenarioContext, *, sweep: bool) -> ScenarioResult:
    width, height, fps = context.encoded_width, context.encoded_height, context.source_fps
    path = output_dir / f"{context.variant_id}.avi"
    writer = r.create_writer(path, width, height, fps)
    background = card_background(width, height)
    digits = list(range(9, 0, -1))  # 9 .. 1, one second each
    frames_per_digit = r.frames_for_duration(fps, 1.0)
    tail = r.frames_for_duration(fps, 0.5)
    index = 0
    for position, digit in enumerate(digits):
        still = _digit_frame(background, digit)
        for _ in range(frames_per_digit + (tail if position == len(digits) - 1 else 0)):
            writer.write(_sweep(still, index / fps) if sweep else still)
            index += 1
    writer.release()
    events = [GroundTruthEvent("content_update", 1000 * k, 1000 * k, {"digit": digits[k]}, "easy") for k in range(1, len(digits))]
    return _result(Path(str(path)), context, events, index / fps,
                   "Countdown over colour bars" + (", with a dial that keeps turning" if sweep else ""))


def countdown(output_dir: Path, context: ScenarioContext) -> ScenarioResult:
    return _countdown(output_dir, context, sweep=False)


def countdown_sweep(output_dir: Path, context: ScenarioContext) -> ScenarioResult:
    return _countdown(output_dir, context, sweep=True)


def equal_luma_colours() -> tuple[tuple[int, int, int], tuple[int, int, int], tuple[int, int, int]]:
    """Three RGB colours: a blue and a brown of the same brightness, then a clearly darker one.

    The first two have the same luma under both the BT.601 and the BT.709 weights (the step between them is
    perpendicular to both), so they look equally bright to the engine whichever colour matrix an upload uses."""
    w601, w709 = np.array([0.299, 0.587, 0.114]), np.array([0.2126, 0.7152, 0.0722])
    direction = np.cross(w601, w709)
    direction /= -direction[2]  # blue goes down by one per step
    first = np.array([90.0, 120.0, 200.0])
    second = np.round(first + 100 * direction)
    return tuple(int(v) for v in first), tuple(int(v) for v in second), (40, 40, 90)


def equal_luma(output_dir: Path, context: ScenarioContext) -> ScenarioResult:
    width, height, fps = context.encoded_width, context.encoded_height, context.source_fps
    path = output_dir / f"{context.variant_id}.avi"
    writer = r.create_writer(path, width, height, fps)
    colours = equal_luma_colours()
    hold = r.frames_for_duration(fps, 1.5)
    for colour in colours:
        r.write_n(writer, np.full((height, width, 3), _bgr(colour), np.uint8), hold)
    writer.release()
    events = [
        GroundTruthEvent("navigation", 1500, 1500, {"change": "colour only, same brightness"}, "hard"),
        GroundTruthEvent("navigation", 3000, 3000, {"change": "brightness"}, "easy"),
    ]
    return _result(Path(str(path)), context, events, 4.5, "Full-screen colour: same brightness, then darker")


PHONE_SWEEP_PERCENT = (0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20, 0.30)
DESKTOP_SWEEP_PERCENT = (0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.60, 0.80)
# Grid cells (3 columns x 4 rows), visited out of order so that no two squares line up like text.
_SWEEP_ORDER = (0, 5, 10, 3, 8, 1, 6, 11, 4, 9, 2, 7)


def sweep_percents(context: ScenarioContext) -> tuple[float, ...]:
    return DESKTOP_SWEEP_PERCENT if context.shell == "desktop_browser" else PHONE_SWEEP_PERCENT


def size_sweep(output_dir: Path, context: ScenarioContext) -> ScenarioResult:
    width, height, fps = context.encoded_width, context.encoded_height, context.source_fps
    path = output_dir / f"{context.variant_id}.avi"
    writer = r.create_writer(path, width, height, fps)
    frame = np.full((height, width, 3), 235, np.uint8)
    percents = sweep_percents(context)
    r.write_n(writer, frame, r.frames_for_duration(fps, 1.0))
    top, bottom = 0.10, 0.92  # clear of a phone status bar
    events = []
    for position, percent in enumerate(percents):
        cell = _SWEEP_ORDER[position]
        column, row = cell % 3, cell // 3
        cx = round(width * (column + 0.5) / 3)
        cy = round(height * (top + (bottom - top) * (row + 0.5) / 4))
        side = max(1, round(math.sqrt(percent / 100 * width * height)))
        frame = frame.copy()
        frame[cy - side // 2 : cy - side // 2 + side, cx - side // 2 : cx - side // 2 + side] = 40
        r.write_n(writer, frame, r.frames_for_duration(fps, 1.0))
        events.append(GroundTruthEvent("small_ui_change", 1000 * (position + 1), 1000 * (position + 1),
                                       {"share_percent": percent, "side_px": side}, "hard"))
    r.write_n(writer, frame, r.frames_for_duration(fps, 0.5))
    writer.release()
    return _result(Path(str(path)), context, events, len(percents) + 1.5, "Squares of growing size on a plain screen")


CARD_BUILDERS = {
    "countdown": countdown,
    "countdown_sweep": countdown_sweep,
    "equal_luma": equal_luma,
    "size_sweep": size_sweep,
}


def sweep_settings(context: ScenarioContext) -> StableSettings:
    """The size sweep measures the smallest-change line on its own, so typing groups are off."""
    return StableSettings(recording_type="desktop" if context.shell == "desktop_browser" else "phone", group_typing=False)


def found_per_event(candidates: list[dict], ground_truth: list[GroundTruthEvent]) -> list[bool]:
    metrics = evaluate(candidates, ground_truth)
    return [result.matched_candidate_index is not None for result in metrics.per_event_results]


# --- Colour accuracy of the working copy -----------------------------------------------------------


def colour_accuracy(work: Path, encoding: str, size: tuple[int, int] = (1280, 720)) -> dict[str, object]:
    """Encode a still test card as ``encoding``, make a working copy, and compare every patch with the original.

    Returns the mean and largest difference over all patches, in 8-bit levels averaged over R, G and B, and the
    patch that differs most."""
    from .stress import encode_upload  # here to avoid a circular import

    work.mkdir(parents=True, exist_ok=True)
    width, height = size
    card = card_background(width, height)
    upload = encode_upload((card for _ in range(60)), 30.0, work / "upload", encoding, size)
    working = work / "working" / "working.mp4"
    build_working_copy(upload, working)
    still = work / "frame.png"
    extract_frame(working, still, 1000)
    shot = cv2.imread(str(still))
    if shot.shape[:2] != (height, width):
        shot = cv2.resize(shot, (width, height), interpolation=cv2.INTER_AREA)
    errors = []
    for name, (x, y, w, h), colour in card_patches(width, height):
        inset_x, inset_y = w // 4, h // 4
        patch = shot[y + inset_y : y + h - inset_y, x + inset_x : x + w - inset_x].reshape(-1, 3).mean(axis=0)
        errors.append((float(np.abs(patch[::-1] - np.array(colour)).mean()), name))
    worst = max(errors)
    return {
        "encoding": encoding,
        "mean_error": round(float(np.mean([e for e, _ in errors])), 2),
        "max_error": round(worst[0], 2),
        "worst_patch": worst[1],
    }


# --- A recording longer than the analysis keeps in memory -----------------------------------------


LONG_SEGMENT_S = 20
LONG_COLOURS = ("0x1E1E1E", "0xF2F2F2", "0x2E7DCB", "0xE8C547", "0x3A3A3A", "0x9AD1A5", "0xD9534F", "0xFAFAFA",
                "0x6F42C1", "0x20C997", "0x101010", "0xADB5BD", "0x0D6EFD", "0xFD7E14", "0x495057", "0xDEE2E6", "0x198754")


def long_recording(work: Path, size: tuple[int, int] = (360, 640)) -> dict[str, object]:
    """17 screens of 20 s each (5 min 40 s), each a different colour, at a small size so it is quick to make."""
    from .stress import detect  # here to avoid a circular import

    work.mkdir(parents=True, exist_ok=True)
    width, height = size
    inputs: list[str] = []
    for colour in LONG_COLOURS:
        inputs += ["-f", "lavfi", "-i", f"color=c={colour}:s={width}x{height}:r=30:d={LONG_SEGMENT_S}"]
    upload = work / "upload.mp4"
    chain = "".join(f"[{index}:v]" for index in range(len(LONG_COLOURS)))
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", f"{chain}concat=n={len(LONG_COLOURS)}:v=1:a=0",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(upload)],
        check=True,
    )
    working = work / "working" / "working.mp4"
    build_working_copy(upload, working)
    candidates = detect(working, work, StableSettings(recording_type="phone"))
    steps = [c for c in candidates if (c.get("score_breakdown") or {}).get("transition_type") != "opening_screen"]
    events = [GroundTruthEvent("navigation", 1000 * LONG_SEGMENT_S * k, 1000 * LONG_SEGMENT_S * k)
              for k in range(1, len(LONG_COLOURS))]
    metrics = evaluate(steps, events)
    right_colour = 0
    for result in metrics.per_event_results:
        if result.matched_candidate_index is None:
            continue
        shot = cv2.imread(steps[result.matched_candidate_index]["image_path"])
        k = result.ground_truth.start_ms // (1000 * LONG_SEGMENT_S)
        expected = np.array([int(LONG_COLOURS[k][i : i + 2], 16) for i in (2, 4, 6)])[::-1]  # BGR
        right_colour += int(np.abs(shot.reshape(-1, 3).mean(axis=0) - expected).max() < 8)
    scale = min(1.0, ANALYSIS_LONG_EDGE / max(width, height))
    frames = len(LONG_COLOURS) * LONG_SEGMENT_S * TARGET_SAMPLE_FPS
    return {
        "duration_s": len(LONG_COLOURS) * LONG_SEGMENT_S,
        "changes": len(events),
        "found": len(events) - metrics.missed_events,
        "extra": metrics.false_positives,
        "right_screenshot": right_colour,
        "decoded_twice": frames * round(width * scale) * round(height * scale) > FRAME_MEMORY_BUDGET_BYTES,
    }
