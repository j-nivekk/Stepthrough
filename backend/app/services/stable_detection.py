"""Stable-screen detection (engine ``stable_v3``).

A walkthrough step is a *settled interface state*: a stretch of the recording in which the screen stops
changing for at least ``min_dwell_ms``. This engine finds those stretches and takes one screenshot from
inside each, so every screenshot shows a settled screen by construction. It follows the steady-state
keyframe location of GIFdroid (Feng and Chen, ICSE 2022); see ``docs/robustness-review-2026-11.md``.

Pipeline:

1. Decode the working copy on a fixed real-time grid (ffmpeg ``fps`` filter), small and grey.
2. Pass 1, frame to frame: per-cell activity, a noise floor measured on the recording itself, and the
   vertical/horizontal motion of the content (phase correlation).
3. Ignore regions that keep moving (caret, spinner, clock, a small embedded video), the student's own
   ignore areas and, on phones, the status bar.
4. Pass 2: a stable interval is a run of frames that all match its *first* frame, meaning no connected
   change larger than ``min_change_percent`` of the screen outside the ignored regions. Comparing with
   the first frame rather than the previous one also catches slow accumulating change (slow typing).
   Intervals shorter than ``min_dwell_ms`` are transitions, not steps.
5. Merge neighbouring intervals that show the same state, describe the change into each step
   (navigation, scroll, modal, ...), collapse typing bursts and, optionally, scroll stops.
6. Extract one screenshot per step from the working copy.

Every student-facing setting is in physical units. The fully resolved values and the engine version are
stored with each run (``resolve_stable_config``), so results can be reproduced and cited.
"""

from __future__ import annotations

import subprocess
import tempfile
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator
from uuid import uuid4

import cv2
import numpy as np

from ..analysis_metadata import STABLE_RECORDING_TYPES
from ..models import RunSettings, StableSettings
from ..utils import timecode_from_ms, utc_now
from .detection import CancellationCallback, CancellationRequested, ProgressCallback
from .similarity import annotate_candidate_similarity, fingerprint_image, hash_to_hex, histogram_to_string, text_distance
from .video import extract_frame

ENGINE_VERSION = "stable_v3/1.0.0"

ANALYSIS_LONG_EDGE = 480
TARGET_SAMPLE_FPS = 15.0
GRID = 24
PIXEL_THRESHOLD_FLOOR = 10.0  # grey levels, after a 3x3 box blur
NOISE_CAP = 8.0
DYNAMIC_BIN_MS = 1000
DYNAMIC_HALF_WINDOW = 2  # one-second bins either side
DYNAMIC_ACTIVITY_SHARE = 0.75  # a cell is "always moving" when active in this share of nearby bins ...
DYNAMIC_DENSITY = 0.25  # ... and changing in at least this share of frames (a spinner, not typing or a caret)
DYNAMIC_MAX_SCREEN_SHARE = 0.25  # never ignore a motion this large (a long scroll)
END_OF_CLIP_MIN_DWELL_MS = 300  # recordings often stop soon after the last change
SCREENSHOT_OFFSET_MS = 200
REGION_SPECK_SHARE = 0.0002
BLOCK = 8  # changed share is measured in 8x8 px blocks of the analysis frame
TYPING_MAX_CHANGE_SHARE = 0.06  # one burst of keystrokes, including the field growing by a line
TYPING_MAX_PAUSE_MS = 6000  # a longer pause ends the burst: that state was meant to be read
TYPING_MARGIN_SHARE = 0.015
KEYBOARD_TOP_SHARE = 0.55  # an on-screen keyboard sits in the bottom 45 % of a phone screen
KEYBOARD_MAX_CHANGE_SHARE = 0.12  # switching between letter and number/symbol layouts
MOTION_MIN_CONFIDENCE = 0.3
MOTION_FLOOR = 0.05
REVISIT_LOOKBACK = 60  # steps compared when looking for an earlier visit of the same screen
FRAME_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024
SCAN_RANGE = (0.10, 0.46)
EXTRACT_RANGE = (0.48, 0.92)

_KERNEL = np.ones((3, 3), np.uint8)


@dataclass(frozen=True)
class StableDetectorConfig:
    engine_version: str
    recording_type: str
    min_dwell_ms: int
    min_change_percent: float
    ignore_status_bar: bool
    status_bar_share: float
    ignore_regions: tuple[tuple[float, float, float, float], ...]
    scroll_mode: str
    group_typing: bool
    include_opening_screen: bool
    enable_ocr: bool
    sensitivity: float
    sample_fps: float
    analysis_long_edge: int = ANALYSIS_LONG_EDGE
    pixel_threshold_floor: float = PIXEL_THRESHOLD_FLOOR
    dynamic_activity_share: float = DYNAMIC_ACTIVITY_SHARE
    dynamic_density: float = DYNAMIC_DENSITY
    typing_max_change_share: float = TYPING_MAX_CHANGE_SHARE
    typing_max_pause_ms: int = TYPING_MAX_PAUSE_MS

    def as_dict(self) -> dict[str, Any]:
        values = asdict(self)
        values["ignore_regions"] = [
            {"x": x, "y": y, "width": width, "height": height} for x, y, width, height in self.ignore_regions
        ]
        return values


def status_bar_share(width: int, height: int) -> float:
    """Height of the phone/tablet status bar as a share of the frame (0 when there usually is none)."""
    if width <= 0 or height <= 0:
        return 0.0
    aspect = max(width, height) / min(width, height)
    if height > width:
        return 0.06 if aspect >= 1.7 else 0.025
    return 0.0 if aspect >= 1.7 else 0.032  # landscape phones hide the status bar, tablets keep it


def resolve_stable_config(settings: RunSettings, *, fps: float, width: int, height: int) -> StableDetectorConfig:
    stable = settings.stable or StableSettings()
    defaults = STABLE_RECORDING_TYPES[stable.recording_type]
    ignore_status_bar = defaults.ignore_status_bar if stable.ignore_status_bar is None else stable.ignore_status_bar
    # Analyse every n-th frame of the (constant frame rate) working copy, so each analysed frame is a real
    # frame at an exact time. 30 fps -> 15, 25 fps -> 12.5, 24 fps -> 12.
    source_fps = fps if fps and fps > 0 else 30.0
    target = float(stable.sample_fps or TARGET_SAMPLE_FPS)
    stride = max(1, round(source_fps / target))
    sample_fps = round(source_fps / stride, 4)
    return StableDetectorConfig(
        engine_version=ENGINE_VERSION,
        recording_type=stable.recording_type,
        min_dwell_ms=int(stable.min_dwell_ms if stable.min_dwell_ms is not None else defaults.min_dwell_ms),
        min_change_percent=float(
            stable.min_change_percent if stable.min_change_percent is not None else defaults.min_change_percent
        ),
        ignore_status_bar=ignore_status_bar,
        status_bar_share=status_bar_share(width, height) if ignore_status_bar else 0.0,
        ignore_regions=tuple((r.x, r.y, r.width, r.height) for r in stable.ignore_regions),
        scroll_mode=stable.scroll_mode,
        group_typing=stable.group_typing,
        include_opening_screen=stable.include_opening_screen,
        enable_ocr=stable.enable_ocr,
        sensitivity=float(stable.sensitivity if stable.sensitivity is not None else 4.0),
        sample_fps=sample_fps,
    )


# ── decoding ────────────────────────────────────────────────────────────────────────────────────────


def _analysis_size(width: int, height: int) -> tuple[int, int]:
    scale = min(1.0, ANALYSIS_LONG_EDGE / max(1, width, height))
    return max(16, round(width * scale / 2) * 2), max(16, round(height * scale / 2) * 2)


def _decode(video_path: Path, sample_fps: float, size: tuple[int, int], cancelled: CancellationCallback) -> Iterator[np.ndarray]:
    """Grey frames on a real-time grid: frame k is whatever was on screen at k / sample_fps seconds."""
    width, height = size
    frame_bytes = width * height
    command = [
        "ffmpeg", "-v", "error", "-nostdin", "-i", str(video_path), "-an", "-sn",
        "-vf", f"fps={sample_fps:.6g},scale={width}:{height}:flags=area,format=gray",
        "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
    ]
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        assert process.stdout is not None
        try:
            while True:
                if cancelled():
                    raise CancellationRequested("Run cancelled while scanning the video.")
                chunk = process.stdout.read(frame_bytes)
                if len(chunk) < frame_bytes:
                    break
                yield np.frombuffer(chunk, np.uint8).reshape(height, width)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
        if process.returncode not in (0, None) and process.returncode > 0:
            errors.seek(0)
            message = errors.read().decode(errors="replace").strip().splitlines()
            raise RuntimeError(f"Could not decode the recording: {message[-1] if message else 'ffmpeg failed'}")


# ── frame comparison ────────────────────────────────────────────────────────────────────────────────


@lru_cache(maxsize=8)
def _hann(width: int, height: int) -> np.ndarray:
    return cv2.createHanningWindow((width, height), cv2.CV_32F)


def _translation(previous: np.ndarray, current: np.ndarray) -> tuple[float, float, float]:
    """Content shift between two frames (dx, dy in px) and a confidence, from the central 60 % band."""
    height, width = previous.shape
    top, left = round(height * 0.2), round(width * 0.2)
    a = previous[top : height - top, left : width - left].astype(np.float32)
    b = current[top : height - top, left : width - left].astype(np.float32)
    if a.size == 0 or float(a.std()) < 1.0 or float(b.std()) < 1.0:
        return 0.0, 0.0, 0.0
    baseline = float(np.mean(np.abs(a - b)))
    if baseline <= 1e-3:
        return 0.0, 0.0, 0.0
    # phaseCorrelate applies the window to its inputs in place when no padding is needed: pass copies.
    (dx, dy), response = cv2.phaseCorrelate(a.copy(), b.copy(), _hann(a.shape[1], a.shape[0]))
    # Verify the shift on the overlapping parts: b(y, x) should equal a(y - dy, x - dx).
    sx, sy = int(round(dx)), int(round(dy))
    h, w = a.shape
    if abs(sx) >= w // 2 or abs(sy) >= h // 2:
        return float(dx), float(dy), 0.0
    a_part = a[max(0, -sy) : h - max(0, sy), max(0, -sx) : w - max(0, sx)]
    b_part = b[max(0, sy) : h - max(0, -sy), max(0, sx) : w - max(0, -sx)]
    gain = max(0.0, (baseline - float(np.mean(np.abs(a_part - b_part)))) / baseline)
    return float(dx), float(dy), float(max(0.0, min(1.0, response * min(1.0, gain * 1.5))))


def _caret_like(widths: Any, heights: Any, frame_width: int, frame_height: int) -> Any:
    """Thin vertical marks the size of a text caret (works on scalars and numpy arrays)."""
    return (widths <= max(4, 0.015 * frame_width)) & (heights >= 2.0 * widths) & (heights <= 0.12 * frame_height)


@dataclass
class _Comparer:
    """Compares two analysis frames while ignoring masked regions."""

    width: int
    height: int
    pixel_threshold: float
    area_min: float
    static_keep: np.ndarray | None  # uint8, 1 = compare, 0 = ignore
    dynamic_cells: np.ndarray  # (bins, rows, cols) bool
    row_cell: np.ndarray
    col_cell: np.ndarray
    _cache: OrderedDict = field(default_factory=OrderedDict)

    def keep_mask(self, bin_a: int, bin_b: int) -> np.ndarray | None:
        key = (min(bin_a, bin_b), max(bin_a, bin_b))
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        cells = self.dynamic_cells[key[0]] | self.dynamic_cells[key[1]]
        if cells.any():
            keep = (~cells[self.row_cell][:, self.col_cell]).astype(np.uint8)
            if self.static_keep is not None:
                keep &= self.static_keep
        else:
            keep = self.static_keep
        self._cache[key] = keep
        if len(self._cache) > 16:
            self._cache.popitem(last=False)
        return keep

    def raw_change(self, a: np.ndarray, b: np.ndarray, keep: np.ndarray | None) -> np.ndarray:
        diff = cv2.blur(cv2.absdiff(a, b), (3, 3))
        if keep is not None:
            np.multiply(diff, keep, out=diff)
        return (diff > self.pixel_threshold).astype(np.uint8)

    def differs(self, a: np.ndarray, b: np.ndarray, keep: np.ndarray | None) -> bool:
        mask = cv2.dilate(self.raw_change(a, b, keep), _KERNEL)
        if cv2.countNonZero(mask) < self.area_min:
            return False
        _count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
        large = stats[1:][stats[1:, cv2.CC_STAT_AREA] >= self.area_min]
        if not len(large):
            return False
        # A thin vertical blip on its own is a text caret blinking or moving, not a new screen.
        caret = _caret_like(large[:, cv2.CC_STAT_WIDTH], large[:, cv2.CC_STAT_HEIGHT], self.width, self.height)
        return bool((~caret).any())


# ── steps ───────────────────────────────────────────────────────────────────────────────────────────


@dataclass
class _Transition:
    changed_share: float  # share of the 24 x 24 regions that changed (labels, "how much of the screen")
    row_coverage: float
    changed_area: float  # changed pixels (after dilation) as a share of the frame (size limits for typing)
    boxes: list[tuple[int, int, int, int, int]]  # x, y, width, height, pixel area (analysis px), largest first
    travel_dx: float
    travel_dy: float
    motion_confidence: float
    vertical_moves: int
    vertical_consistency: float
    direct_dy: float
    direct_confidence: float
    overlay: bool  # a sheet or dialog over an unchanged or uniformly dimmed screen
    label: str = "unknown"


@dataclass
class _Step:
    start: int
    end: int
    anchor: np.ndarray = field(repr=False)
    transition: _Transition | None = None
    change_start: int | None = None  # first frame of the change into this step
    grouped_states: int = 1
    label: str = "unknown"


def _any_in_blocks(mask: np.ndarray) -> np.ndarray:
    """1 for every BLOCK x BLOCK cell of a 0/1 mask that contains any set pixel."""
    height, width = mask.shape
    rows, cols = max(1, height // BLOCK), max(1, width // BLOCK)
    trimmed = mask[: rows * BLOCK, : cols * BLOCK] if height >= BLOCK and width >= BLOCK else mask
    if trimmed.shape == (rows * BLOCK, cols * BLOCK):
        return (trimmed.reshape(rows, BLOCK, cols, BLOCK).max(axis=(1, 3)) > 0).astype(np.uint8)
    return (cv2.resize(mask * 255, (cols, rows), interpolation=cv2.INTER_AREA) > 0).astype(np.uint8)


def _boxes_and_share(raw: np.ndarray, speck: float) -> tuple[list[tuple[int, int, int, int, int]], float, float]:
    """Changed regions, and the share of the screen that changed: the share of the 24 x 24 grid of regions
    that contain any change. Flat backgrounds shared by two screens do not count as "unchanged screen"."""
    height, width = raw.shape
    rows, cols = min(GRID, height // 2), min(GRID, width // 2)
    row_edges = np.searchsorted((np.arange(height) * rows) // height, np.arange(rows))
    col_edges = np.searchsorted((np.arange(width) * cols) // width, np.arange(cols))
    cells = np.maximum.reduceat(np.maximum.reduceat(raw, row_edges, axis=0), col_edges, axis=1)
    share = float(np.count_nonzero(cells)) / cells.size
    row_coverage = float(np.count_nonzero(cells.any(axis=1))) / rows
    count, _labels, stats, _c = cv2.connectedComponentsWithStats(cv2.dilate(raw, _KERNEL), connectivity=8)
    boxes = [
        (int(s[cv2.CC_STAT_LEFT]), int(s[cv2.CC_STAT_TOP]), int(s[cv2.CC_STAT_WIDTH]), int(s[cv2.CC_STAT_HEIGHT]),
         int(s[cv2.CC_STAT_AREA]))
        for s in stats[1:count]
        if s[cv2.CC_STAT_AREA] >= speck
    ]
    boxes.sort(key=lambda box: -box[4])
    return boxes, share, row_coverage


def _is_overlay(a: np.ndarray, b: np.ndarray, raw: np.ndarray) -> bool:
    """Did a sheet or dialog appear over a dimmed copy of the previous screen?

    Changed pixels that a single dimming factor explains (new = k * old) are the backdrop; at least 15 % of
    the screen must be dimmed like that. What is left is the overlay's content. It counts when that content
    is one block, centred or anchored to the bottom edge. Sheets that do not dim the screen are labelled by
    the size of the change instead, because new content on the page looks the same.
    """
    height, width = raw.shape
    changed = raw.astype(bool)
    if changed.mean() < 0.05:
        return False
    before = a.astype(np.float32) - 16.0
    after = b.astype(np.float32) - 16.0
    lit = before >= 24.0
    candidates = changed & lit
    if candidates.sum() < 0.15 * raw.size:
        return False
    ratio = np.where(lit, after / np.maximum(before, 1.0), 0.0)
    factor = float(np.median(ratio[candidates]))
    if not 0.25 <= factor <= 0.92:
        return False
    backdrop = lit & (np.abs(ratio - factor) <= 0.1)
    if (changed & backdrop).mean() < 0.15:
        return False  # without a dimmed backdrop, new content on the page is not told apart from a dialog
    # Dimming keeps the old screen's edges and text, only darker. Smooth images (two video frames) can match
    # one factor by accident, so the factor must also hold on the old screen's edges.
    edges = cv2.morphologyEx(a, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) >= 24
    edge_pixels = changed & lit & edges
    if edge_pixels.sum() < 0.01 * raw.size or float(backdrop[edge_pixels].mean()) < 0.5:
        return False
    content = changed & ~backdrop
    blocks = cv2.morphologyEx(_any_in_blocks(content.astype(np.uint8)), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, _labels, stats, _c = cv2.connectedComponentsWithStats(blocks, connectivity=8)
    if count < 2:
        return False
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    bw, bh = blocks.shape[1], blocks.shape[0]
    x, y = stats[largest, cv2.CC_STAT_LEFT], stats[largest, cv2.CC_STAT_TOP]
    w, h = stats[largest, cv2.CC_STAT_WIDTH], stats[largest, cv2.CC_STAT_HEIGHT]
    if w * h < 0.06 * bw * bh or h > 0.85 * bh:
        return False
    centre_x, centre_y = x + w / 2, y + h / 2
    centred = 0.3 * bw <= centre_x <= 0.7 * bw and 0.25 * bh <= centre_y <= 0.75 * bh and w < 0.95 * bw
    bottom_sheet = y + h >= 0.9 * bh and w >= 0.6 * bw
    if not (centred or bottom_sheet):
        return False
    outside = np.ones_like(blocks, bool)
    outside[y : y + h, x : x + w] = False
    return float(blocks[outside].mean()) < 0.08  # the rest is unchanged once the dimming is explained


def _describe(
    previous: _Step,
    current: _Step,
    comparer: _Comparer,
    frame_bins: np.ndarray,
    motion: np.ndarray,
) -> _Transition:
    keep = comparer.keep_mask(int(frame_bins[previous.start]), int(frame_bins[current.start]))
    raw = comparer.raw_change(previous.anchor, current.anchor, keep)
    boxes, share, row_coverage = _boxes_and_share(raw, REGION_SPECK_SHARE * raw.size)
    # Motion during the change (pair p covers frames p -> p+1). Smooth content such as full-screen video
    # correlates weakly, so a low confidence floor is used and direction consistency checked in _classify.
    span = motion[previous.end : current.start]
    moving = span[(span[:, 2] >= MOTION_FLOOR) & (np.abs(span[:, :2]).max(axis=1) >= 1.0)] if len(span) else span
    travel_dx = float(moving[:, 0].sum()) if len(moving) else 0.0
    travel_dy = float(moving[:, 1].sum()) if len(moving) else 0.0
    motion_confidence = float(moving[:, 2].mean()) if len(moving) else 0.0
    consistency = abs(travel_dy) / max(1e-6, float(np.abs(moving[:, 1]).sum())) if len(moving) else 0.0
    direct_dx, direct_dy, direct_confidence = _translation(previous.anchor, current.anchor)
    transition = _Transition(
        changed_share=share,
        row_coverage=row_coverage,
        changed_area=sum(box[4] for box in boxes) / raw.size,
        boxes=boxes,
        travel_dx=travel_dx,
        travel_dy=travel_dy,
        motion_confidence=motion_confidence,
        vertical_moves=int(len(moving)),
        vertical_consistency=consistency,
        direct_dy=direct_dy,
        direct_confidence=direct_confidence,
        overlay=_is_overlay(previous.anchor, current.anchor, raw),
    )
    transition.label = _classify(transition, comparer.width, comparer.height)
    return transition


def _classify(t: _Transition, width: int, height: int) -> str:
    """Describe the change into a step. Labels annotate steps; they never decide whether a step exists."""
    if t.overlay:
        return "modal"  # checked first: a sheet sliding up also moves vertically
    travel = abs(t.travel_dy)
    swiped = t.vertical_moves >= 2 and t.vertical_consistency >= 0.8 and travel > 2 * abs(t.travel_dx)
    if swiped and 0.8 * height <= travel <= 1.25 * height and t.changed_share >= 0.8:
        return "feed_card_swap"  # one full-screen swipe that replaces the screen (short video feeds)
    direct_shift = abs(t.direct_dy) >= 0.03 * height and t.direct_confidence >= MOTION_MIN_CONFIDENCE
    if direct_shift or (swiped and travel >= 0.08 * height):
        return "scroll"
    if t.changed_share >= 0.45 or (t.changed_share >= 0.2 and t.row_coverage >= 0.6):
        return "navigation"  # most of the screen redrawn, or changes spread over most of its height
    if t.changed_share >= 0.02:
        return "content_update"
    return "small_ui_change"


Box = tuple[int, int, int, int, int]  # x, y, width, height, pixel area


def _links(a: Box, b: Box, margin: float) -> str | None:
    """How two changed regions belong to one edit: "overlap" (the same place redrawn, or the field growing
    by a line), "extends" (further along the same line, or the start of the next line), or not at all."""
    ax, ay, aw, ah, _ = a
    bx, by, bw, bh, _ = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    if ix > 0 and iy > 0:
        return "overlap"
    gap_x = max(0, max(ax, bx) - min(ax + aw, bx + bw))
    if iy >= 0.5 * min(ah, bh) and gap_x <= max(margin, 0.8 * min(ah, bh)):
        return "extends"  # further along the same line (the gap scales with the text size)
    below = by >= ay + 0.5 * ah and by - (ay + ah) <= max(ah, bh)
    if below and ix <= 0.3 * min(aw, bw) and bx < ax:
        return "extends"  # wrapped onto the next line
    return None


def _continues_edit(zone: list[Box], current: _Transition, margin: float, frame_width: int, frame_height: int,
                    area_min: float) -> str | None:
    """Is ``current`` the next keystroke burst of the edit whose changes so far are ``zone``?

    Every part of the new change must connect to the edit, directly or through other new parts (two words
    typed in one burst). A change elsewhere, such as the next form field, starts a new edit, and a vertical
    stack of separate controls (a column of toggles) is never an edit, however close together. Caret marks
    in the new change need not connect (the caret leaves one field for the next, but the new field's text
    still has to), and neither do parts smaller than the smallest change (a mouse pointer that moved).

    Returns None, "overlap" (only redrawn in place) or "extends" (text grew along a line).
    """
    pending = [
        box for box in current.boxes[:12]
        if box[4] >= area_min and not _caret_like(box[2], box[3], frame_width, frame_height)
    ]
    if not zone or not pending:
        return None

    def overlaps(a: Box, b: Box) -> bool:
        return min(a[0] + a[2], b[0] + b[2]) > max(a[0], b[0]) and min(a[1] + a[3], b[1] + b[3]) > max(a[1], b[1])

    # Growth only counts from earlier text that this change leaves alone: typed words stay put while the
    # next one appears, whereas a moving highlight (tab bar) redraws the place it came from.
    untouched = [not any(overlaps(a, b) for b in pending) for a in zone]  # pending: no caret marks or specks
    reached: list[tuple[Box, bool]] = [(box, keep) for box, keep in zip(zone, untouched)]
    grew_text = False
    grew = True
    while pending and grew:
        grew = False
        for box in list(pending):
            for other, may_grow in reached:
                kind = _links(other, box, margin)
                if kind:
                    grew_text = grew_text or (kind == "extends" and may_grow)
                    reached.append((box, False))
                    pending.remove(box)
                    grew = True
                    break
    if pending:
        return None
    return "extends" if grew_text else "overlap"


def _is_small_edit(transition: _Transition | None) -> bool:
    return (
        transition is not None
        and bool(transition.boxes)
        and transition.changed_area <= TYPING_MAX_CHANGE_SHARE
        and transition.label not in ("scroll", "feed_card_swap", "modal")
    )


def _is_keyboard_change(transition: _Transition | None, frame_height: int, area_min: float) -> bool:
    """A change only inside the on-screen keyboard (layout switch, shift key) while typing on a phone."""
    if transition is None or transition.changed_area > KEYBOARD_MAX_CHANGE_SHARE:
        return False
    if transition.label in ("scroll", "feed_card_swap", "modal"):
        return False
    parts = [box for box in transition.boxes if box[4] >= area_min]
    return bool(parts) and all(box[1] >= KEYBOARD_TOP_SHARE * frame_height for box in parts)


def _group_typing(
    steps: list[_Step],
    *,
    phone: bool,
    max_pause_ms: int,
    duration_ms: Any,
    same_state: Any,
    margin: float,
    frame_width: int,
    frame_height: int,
    area_min: float,
) -> list[tuple[int, int]]:
    """Runs of steps (first, last) entered by one typing burst; each run becomes one step.

    A run counts as typing only if text grew along a line somewhere in it: changes that only redraw the
    same place (tab titles switching, a toast coming and going) are not typing. A run never ends on the
    screen from before it (an edit that was undone, a toast that disappeared).
    """
    runs: list[tuple[int, int]] = []
    i = 1
    while i < len(steps):
        j = i
        typed = False
        if _is_small_edit(steps[i].transition):
            zone = list(steps[i].transition.boxes[:12])  # type: ignore[union-attr]
            while j + 1 < len(steps) and duration_ms(steps[j]) <= max_pause_ms:
                following = steps[j + 1].transition
                link = (
                    _continues_edit(zone, following, margin, frame_width, frame_height, area_min)  # type: ignore[arg-type]
                    if _is_small_edit(following)
                    else None
                )
                if link is None and not (phone and typed and _is_keyboard_change(following, frame_height, area_min)):
                    break
                if same_state(steps[i - 1], steps[j + 1]):
                    break
                typed = typed or link == "extends"
                zone.extend(following.boxes[:12])  # type: ignore[union-attr]
                j += 1
        if j > i and typed:
            runs.append((i, j))
            i = j + 1
        else:
            i += 1
    return runs


# ── entry point ─────────────────────────────────────────────────────────────────────────────────────


def detect_candidates_stable(
    *,
    video_path: Path,
    frames_dir: Path,
    duration_ms: int,
    fps: float,
    settings: RunSettings,
    width: int | None = None,
    height: int | None = None,
    progress_callback: ProgressCallback | None = None,
    cancellation_callback: CancellationCallback | None = None,
    report: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    progress = progress_callback or (lambda phase, message, value, level: None)
    cancelled = cancellation_callback or (lambda: False)
    if width is None or height is None:
        from .video import probe_video

        metadata = probe_video(video_path)
        width, height = metadata.width, metadata.height
    config = resolve_stable_config(settings, fps=fps, width=width, height=height)
    size = _analysis_size(width, height)
    aw, ah = size
    frame_ms = 1000.0 / config.sample_fps
    expected_frames = int(duration_ms / frame_ms) + 2
    keep_frames = expected_frames * aw * ah <= FRAME_MEMORY_BUDGET_BYTES

    static = np.zeros((ah, aw), bool)
    if config.status_bar_share > 0:
        static[: round(ah * config.status_bar_share)] = True
    for x, y, w, h in config.ignore_regions:
        static[int(y * ah) : int(np.ceil((y + h) * ah)), int(x * aw) : int(np.ceil((x + w) * aw))] = True
    static_keep = (~static).astype(np.uint8) if static.any() else None

    rows, cols = min(GRID, ah // 2), min(GRID, aw // 2)
    row_cell = (np.arange(ah) * rows) // ah
    col_cell = (np.arange(aw) * cols) // aw
    row_edges = np.searchsorted(row_cell, np.arange(rows))
    col_edges = np.searchsorted(col_cell, np.arange(cols))

    # Pass 1: frame-to-frame activity, noise and motion.
    progress("primary_scan", "Scanning video for stable screens", SCAN_RANGE[0], "info")
    frames: list[np.ndarray] = []
    first_frame: np.ndarray | None = None
    cell_max: list[np.ndarray] = []
    noise: list[float] = []
    motion: list[tuple[float, float, float]] = []
    previous: np.ndarray | None = None
    count = 0
    for frame in _decode(video_path, config.sample_fps, size, cancelled):
        if keep_frames:
            frames.append(frame)
        if previous is None:
            first_frame = frame
        else:
            diff = cv2.blur(cv2.absdiff(previous, frame), (3, 3))
            if static_keep is not None:
                np.multiply(diff, static_keep, out=diff)
            cells = np.maximum.reduceat(np.maximum.reduceat(diff, row_edges, axis=0), col_edges, axis=1)
            cell_max.append(cells)
            noise.append(float(np.median(diff[::4, ::4])))
            motion.append(_translation(previous, frame) if cells.max() > PIXEL_THRESHOLD_FLOOR else (0.0, 0.0, 0.0))
        previous = frame
        count += 1
        if count % 30 == 0:
            ratio = min(1.0, count / expected_frames)
            progress("primary_scan", f"Scanning video for stable screens ({round(ratio * 50)}%)",
                     SCAN_RANGE[0] + (SCAN_RANGE[1] - SCAN_RANGE[0]) * ratio * 0.5, "info")
    if first_frame is None:
        raise RuntimeError("The recording contains no decodable video frames.")

    n = count
    pts = np.arange(n) * frame_ms
    end_ms = float(pts[-1] + frame_ms)
    sigma = min(NOISE_CAP, max(1.0, float(np.percentile(noise, 20)) * 1.4826)) if noise else 1.0
    pixel_threshold = max(config.pixel_threshold_floor, config.sensitivity * sigma)
    area_min = config.min_change_percent / 100.0 * aw * ah

    # Regions that keep moving: cells active in most one-second bins around each moment.
    frame_bins = (pts // DYNAMIC_BIN_MS).astype(int)
    bin_count = int(frame_bins[-1]) + 1
    dynamic = np.zeros((bin_count, rows, cols), bool)
    if cell_max:
        active = np.stack(cell_max) > pixel_threshold
        pair_bins = frame_bins[1:]
        density = np.zeros((bin_count, rows, cols), np.float32)  # share of frame pairs in which a cell changed
        for b in range(bin_count):
            segment = active[pair_bins == b]
            if len(segment):
                density[b] = segment.mean(axis=0)
        for b in range(bin_count):
            lo, hi = max(0, b - DYNAMIC_HALF_WINDOW), min(bin_count, b + DYNAMIC_HALF_WINDOW + 1)
            if hi - lo < 2:
                continue
            window = density[lo:hi]
            cells = ((window > 0).mean(axis=0) >= config.dynamic_activity_share) & (
                window.mean(axis=0) >= config.dynamic_density
            )
            if cells.any() and cells.mean() < DYNAMIC_MAX_SCREEN_SHARE:
                dynamic[b] = cells
    motion_array = np.array(motion, np.float32).reshape(-1, 3)
    comparer = _Comparer(aw, ah, pixel_threshold, area_min, static_keep, dynamic, row_cell, col_cell)

    # Pass 2: stable intervals, each a run of frames matching its first frame.
    def interval_ms(start: int, end: int) -> float:
        return float((pts[end + 1] if end + 1 < n else end_ms) - pts[start])

    def accept(start: int, end: int, final: bool) -> bool:
        needed = min(config.min_dwell_ms, END_OF_CLIP_MIN_DWELL_MS) if final else config.min_dwell_ms
        return interval_ms(start, end) >= needed

    source = iter(frames) if keep_frames else _decode(video_path, config.sample_fps, size, cancelled)
    intervals: list[_Step] = []
    anchor_index, anchor = 0, first_frame
    for index, frame in enumerate(source):
        if index >= n:
            break
        if index == 0:
            continue
        if comparer.differs(anchor, frame, comparer.keep_mask(int(frame_bins[anchor_index]), int(frame_bins[index]))):
            if accept(anchor_index, index - 1, final=False):
                intervals.append(_Step(anchor_index, index - 1, anchor))
            anchor_index, anchor = index, frame
        if index % 30 == 0:
            if cancelled():
                raise CancellationRequested("Run cancelled while scanning the video.")
            ratio = index / n
            progress("primary_scan", f"Scanning video for stable screens ({50 + round(ratio * 50)}%)",
                     SCAN_RANGE[0] + (SCAN_RANGE[1] - SCAN_RANGE[0]) * (0.5 + ratio * 0.5), "info")
    if accept(anchor_index, n - 1, final=True):
        intervals.append(_Step(anchor_index, n - 1, anchor))
    frames.clear()

    found_intervals = len(intervals)
    if not intervals:
        progress("primary_scan", "No stable screen found: the recording never stays still for "
                 f"{config.min_dwell_ms} ms. Showing the first frame instead; try a shorter minimum time on "
                 "screen or ignore the moving area.", SCAN_RANGE[1], "warning")
        intervals = [_Step(0, n - 1, first_frame)]

    # Neighbouring intervals that show the same state (a flicker in between) are one step.
    steps: list[_Step] = []
    for interval in intervals:
        if steps and not comparer.differs(
            steps[-1].anchor, interval.anchor,
            comparer.keep_mask(int(frame_bins[steps[-1].start]), int(frame_bins[interval.start])),
        ):
            steps[-1].end = interval.end
        else:
            steps.append(interval)

    steps[0].label = "opening_screen"
    for previous_step, step in zip(steps, steps[1:]):
        step.transition = _describe(previous_step, step, comparer, frame_bins, motion_array)
        step.label = step.transition.label
        step.change_start = previous_step.end + 1

    merged_scroll_stops = 0
    if config.scroll_mode == "merge":
        kept = [steps[0]]
        for step in steps[1:]:
            if step.label == "scroll":
                kept[-1].end = step.end
                kept[-1].grouped_states += step.grouped_states
                merged_scroll_stops += 1
            else:
                kept.append(step)
        steps = kept

    typing_groups = 0
    if config.group_typing and len(steps) > 2:
        runs = _group_typing(
            steps,
            phone=config.recording_type == "phone",
            max_pause_ms=config.typing_max_pause_ms,
            duration_ms=lambda step: interval_ms(step.start, step.end),
            same_state=lambda a, b: not comparer.differs(
                a.anchor, b.anchor, comparer.keep_mask(int(frame_bins[a.start]), int(frame_bins[b.start]))
            ),
            margin=TYPING_MARGIN_SHARE * max(aw, ah),
            frame_width=aw,
            frame_height=ah,
            area_min=area_min,
        )
        collapsed = {index for first, last in runs for index in range(first, last)}
        grouped = []
        for index, step in enumerate(steps):
            if index in collapsed:
                continue
            run = next((r for r in runs if r[1] == index), None)
            if run is not None:
                before = grouped[-1]
                step.transition = _describe(before, step, comparer, frame_bins, motion_array)
                step.transition.label = "text_entry"
                step.label = "text_entry"
                step.change_start = before.end + 1
                step.grouped_states = run[1] - run[0] + 1
                typing_groups += 1
            grouped.append(step)
        steps = grouped

    if not config.include_opening_screen and len(steps) > 1:
        steps = steps[1:]

    # A revisit is the same screen state again: no change larger than the smallest change, by the same
    # test that defines a stable screen (stricter than comparing image hashes, which call two typing
    # states or two similar list pages "the same").
    revisit_of: dict[int, int] = {}
    for k in range(1, len(steps)):
        for m in range(max(0, k - REVISIT_LOOKBACK), k - 1):
            keep = comparer.keep_mask(int(frame_bins[steps[m].start]), int(frame_bins[steps[k].start]))
            if not comparer.differs(steps[m].anchor, steps[k].anchor, keep):
                revisit_of[k] = m
                break

    if report is not None:
        report.update(
            {
                "engine_version": ENGINE_VERSION,
                "analysed_frames": n,
                "analysis_width": aw,
                "analysis_height": ah,
                "noise_sigma": round(sigma, 3),
                "pixel_threshold": round(pixel_threshold, 2),
                "min_change_pixels": round(area_min, 1),
                "moving_area_max_share": round(float(dynamic.mean(axis=(1, 2)).max()) if bin_count else 0.0, 4),
                "stable_intervals": found_intervals,
                "steps": len(steps),
                "typing_groups": typing_groups,
                "merged_scroll_stops": merged_scroll_stops,
            }
        )
    progress(
        "primary_scan",
        f"Found {len(steps)} stable screen(s) (noise {sigma:.1f} grey levels, pixel threshold {pixel_threshold:.0f}"
        + (f", {typing_groups} typing burst(s) grouped" if typing_groups else "")
        + ")",
        SCAN_RANGE[1],
        "info",
    )

    ocr = _load_ocr(config, progress)
    return _extract_candidates(steps, config, ocr, pts, end_ms, n, (width / aw, height / ah), (aw, ah),
                               video_path, frames_dir, duration_ms, progress, cancelled, revisit_of)


def _load_ocr(config: StableDetectorConfig, progress: ProgressCallback) -> tuple[Any, Any, Any] | None:
    if not config.enable_ocr:
        return None
    from .hybrid_detection import _OcrCache, _OcrUsageStats, _maybe_load_ocr_engine

    engine, warning = _maybe_load_ocr_engine(SimpleNamespace(enable_ocr=True, ocr_backend="paddleocr"))  # type: ignore[arg-type]
    if warning or engine is None:
        progress("primary_scan", f"OCR disabled: {warning or 'PaddleOCR is not available.'}", SCAN_RANGE[1], "warning")
        return None
    return engine, _OcrCache(), _OcrUsageStats()


def _extract_candidates(
    steps: list[_Step],
    config: StableDetectorConfig,
    ocr: tuple[Any, Any, Any] | None,
    pts: np.ndarray,
    end_ms: float,
    n: int,
    scale: tuple[float, float],
    analysis_size: tuple[int, int],
    video_path: Path,
    frames_dir: Path,
    duration_ms: int,
    progress: ProgressCallback,
    cancelled: CancellationCallback,
    revisit_of: dict[int, int],
) -> list[dict[str, Any]]:
    aw, ah = analysis_size
    sx, sy = scale

    def at(index: int) -> int:
        return int(pts[index]) if index < n else int(end_ms)

    progress("primary_extract", f"Extracting {len(steps)} candidate screenshots", EXTRACT_RANGE[0], "info")
    candidates: list[dict[str, Any]] = []
    previous_text: str | None = None
    previous_dwell = 0
    for position, step in enumerate(steps, start=1):
        if cancelled():
            raise CancellationRequested("Run cancelled while extracting screenshots.")
        settled_ms = at(step.start)
        dwell_ms = at(step.end + 1) - settled_ms
        offset_frames = round(min(SCREENSHOT_OFFSET_MS, dwell_ms / 2) * config.sample_fps / 1000)
        shot = min(step.end, step.start + offset_frames)
        timestamp_ms = min(max(0, at(shot)), max(0, duration_ms - 1))
        image_path = frames_dir / f"candidate-{position:03d}__{timecode_from_ms(timestamp_ms, slug_style=True)}.png"
        extract_frame(video_path, image_path, timestamp_ms)

        ocr_text = None
        if ocr is not None:
            from .hybrid_detection import _extract_text_from_image

            screenshot = cv2.imread(str(image_path))
            if screenshot is not None:
                ocr_text = _extract_text_from_image(screenshot, *ocr)

        t = step.transition
        breakdown = {
            "visual": round(t.changed_share, 4) if t else 1.0,
            "text": round(text_distance(previous_text, ocr_text), 4) if (ocr is not None and t) else 0.0,
            "motion": round(min(1.0, abs(t.travel_dy) / ah), 4) if t else 0.0,
            "changed_regions": [
                {"x": round(x * sx), "y": round(y * sy), "width": round(w * sx), "height": round(h * sy),
                 "score": round(min(1.0, area / max(1, w * h)), 4)}
                for x, y, w, h, area in (t.boxes[:6] if t else [])
            ],
            "scroll_dx": round(t.travel_dx * sx, 1) if t else 0.0,
            "scroll_dy": round(t.travel_dy * sy, 1) if t else 0.0,
            "scroll_confidence": round(t.motion_confidence, 4) if t else 0.0,
            "chrome_change": None,
            "content_change": None,
            "transition_type": step.label,
            "dwell_before_ms": previous_dwell,
            "dwell_after_ms": dwell_ms,
            "event_start_ms": at(step.change_start) if step.change_start is not None else 0,
            "event_end_ms": settled_ms,
            "grouped_states": step.grouped_states,
        }
        fingerprint = fingerprint_image(image_path)
        now = utc_now()
        candidates.append(
            {
                "id": uuid4().hex,
                "detector_index": position,
                "candidate_origin": "detected",
                "timestamp_ms": timestamp_ms,
                "timestamp_tc": timecode_from_ms(timestamp_ms),
                "image_path": image_path.as_posix(),
                "scene_score": breakdown["visual"],
                "status": "pending",
                "title": None,
                "notes": None,
                "image_hash": hash_to_hex(fingerprint.average_hash),
                "perceptual_hash": hash_to_hex(fingerprint.perceptual_hash),
                "histogram_signature": histogram_to_string(fingerprint.histogram),
                "ocr_text": ocr_text,
                "score_breakdown": breakdown,
                "revisit_group_id": None,
                "similar_to_candidate_id": None,
                "similarity_distance": None,
                "created_at": now,
                "updated_at": now,
            }
        )
        previous_text = ocr_text
        previous_dwell = dwell_ms
        value = EXTRACT_RANGE[0] + (position / max(1, len(steps))) * (EXTRACT_RANGE[1] - EXTRACT_RANGE[0])
        progress("primary_extract", f"Processed screenshot {position} of {len(steps)}", value, "info")

    if ocr is not None and ocr[2].model_invocations:
        progress("primary_extract", f"OCR read {ocr[2].model_invocations} screenshot(s).", EXTRACT_RANGE[1], "info")
    annotate_candidate_similarity(candidates)  # similarity distances (and scene score fallbacks)
    for candidate in candidates:
        candidate["revisit_group_id"] = None
        candidate["similar_to_candidate_id"] = None
    for k, m in sorted(revisit_of.items()):
        first = candidates[m]
        group = first["revisit_group_id"] or f"revisit-{first['id'][:8]}"
        first["revisit_group_id"] = group
        candidates[k]["revisit_group_id"] = group
        candidates[k]["similar_to_candidate_id"] = first["id"]
    return candidates
