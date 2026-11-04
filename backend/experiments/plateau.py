"""Prototype: stable-interval ("plateau") keyframe detector for UI screen recordings.

Formulation: a walkthrough step is a period where the screen stops changing for at least
`min_dwell_ms`. We find those periods and take one screenshot from inside each, so every
screenshot is a settled frame by construction. Changes are judged against a noise floor
measured from the recording itself, persistently animated regions (caret, spinner, clock,
embedded video) are masked, and every timestamp is the decoder's real PTS (VFR-safe).

Knobs (all in physical units):
  min_dwell_ms     how long a screen must stay still to count as a step
  min_change_area  smallest change that counts, as a fraction of the screen
  sensitivity      pixel threshold in multiples of the measured noise
  sample_fps       analysis rate cap (by real time, not frame index)
"""
from __future__ import annotations

import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np

ANALYSIS_LONG_EDGE = 480
GRID = 24


@dataclass
class PlateauConfig:
    min_dwell_ms: int = 450
    min_change_area: float = 0.001
    sensitivity: float = 4.0
    sample_fps: float = 15.0
    include_initial: bool = True


def decode(video: Path, sample_fps: float) -> tuple[np.ndarray, np.ndarray]:
    """Grey analysis frames on a constant real-time grid + their presentation times (ms)."""
    info = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                           "stream=width,height", "-of", "csv=p=0", str(video)],
                          capture_output=True, text=True, check=True).stdout.strip().split(",")
    sw, sh = int(info[0]), int(info[1])
    scale = ANALYSIS_LONG_EDGE / max(sw, sh)
    w, h = max(2, round(sw * scale / 2) * 2), max(2, round(sh * scale / 2) * 2)
    # Resample by real time: each output frame is whatever was on screen at that instant, so a frame
    # held for a second on a VFR recording is seen for that whole second (never skipped).
    vf = f"fps={sample_fps:g},scale={w}:{h}:flags=area,format=gray,showinfo"
    with tempfile.TemporaryFile() as err:
        raw = subprocess.run(["ffmpeg", "-v", "info", "-nostats", "-i", str(video), "-vf", vf, "-fps_mode", "passthrough",
                              "-f", "rawvideo", "-"], stdout=subprocess.PIPE, stderr=err, check=True).stdout
        err.seek(0)
        log = err.read().decode(errors="replace")
    pts = np.array([float(m) * 1000 for m in re.findall(r"pts_time:\s*([0-9.]+)", log)])
    frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w)
    n = min(len(frames), len(pts))
    return frames[:n], pts[:n]


def detect(video: Path, frames_dir: Path, cfg: PlateauConfig | None = None, duration_ms: int | None = None) -> list[dict]:
    cfg = cfg or PlateauConfig()
    frames, pts = decode(video, cfg.sample_fps)
    n, h, w = frames.shape
    if n < 2:
        return []
    f16 = frames.astype(np.int16)
    # diffs[i] = change from frame i to i+1, box-filtered so pixel noise averages out but strokes survive
    diffs = np.stack([cv2.blur(np.abs(f16[i + 1] - f16[i]).astype(np.uint8), (3, 3)) for i in range(n - 1)])

    # Noise floor from the recording itself. VFR files drop duplicate frames, so many pairs are real
    # changes: take a low percentile across pairs and cap it, rather than the median.
    per_pair = [float(np.median(d)) for d in diffs[:: max(1, len(diffs) // 300)]]
    sigma = min(8.0, max(1.0, float(np.percentile(per_pair, 20)) * 1.4826))
    tau = max(10.0, cfg.sensitivity * sigma)
    changed = diffs > tau
    kernel = np.ones((3, 3), np.uint8)

    # Persistent-animation mask: grid cells active in >=3 of the 4 one-second bins around t.
    ch, cw = h / GRID, w / GRID
    cell_active = np.zeros((n - 1, GRID, GRID), bool)
    for i, m in enumerate(changed):
        if m.any():
            ys, xs = np.nonzero(m)
            cell_active[i, np.minimum(GRID - 1, (ys / ch).astype(int)), np.minimum(GRID - 1, (xs / cw).astype(int))] = True
    sec = (pts[1:] / 1000).astype(int)
    bins = {s: cell_active[sec == s].any(axis=0) for s in np.unique(sec)}

    row_cell = np.minimum(GRID - 1, (np.arange(h) / ch).astype(int))
    col_cell = np.minimum(GRID - 1, (np.arange(w) / cw).astype(int))
    area_min = cfg.min_change_area * h * w
    still = np.zeros(n - 1, bool)
    for i in range(n - 1):
        s = sec[i]
        window = [bins[k] for k in range(s - 2, s + 3) if k in bins]
        dyn = (np.mean(window, axis=0) >= 0.75) if len(window) >= 2 else np.zeros((GRID, GRID), bool)
        m = changed[i]
        if dyn.mean() < 0.25 and dyn.any():  # never mask a global motion such as a long scroll
            m = m & ~dyn[row_cell][:, col_cell]
        m = cv2.dilate(m.astype(np.uint8), kernel)
        num, _lab, stats, _c = cv2.connectedComponentsWithStats(m, connectivity=8)
        still[i] = not any(stats[k, cv2.CC_STAT_AREA] >= area_min for k in range(1, num))

    # Stable intervals: frame j is settled if the step into it (j-1 -> j) was still.
    end_ms = max(float(pts[-1]) + 1000.0 / cfg.sample_fps, duration_ms or 0)
    intervals, start = [], 0
    for j in range(1, n):
        if not still[j - 1]:
            if pts[j] - pts[start] >= cfg.min_dwell_ms:
                intervals.append((start, j - 1))
            start = j
    if end_ms - pts[start] >= min(cfg.min_dwell_ms, 300):
        intervals.append((start, n - 1))

    # Merge consecutive intervals that show the same state (a flicker between them).
    def same_state(a: int, b: int) -> bool:
        m = (cv2.blur(np.abs(f16[a] - f16[b]).astype(np.uint8), (3, 3)) > tau).astype(np.uint8)
        m = cv2.dilate(m, kernel)
        num, _l, stats, _c = cv2.connectedComponentsWithStats(m, connectivity=8)
        return not any(stats[k, cv2.CC_STAT_AREA] >= area_min for k in range(1, num))

    merged: list[tuple[int, int]] = []
    for s, e in intervals:
        if merged and same_state(merged[-1][1], s):
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    if not cfg.include_initial and merged and merged[0][0] == 0:
        merged = merged[1:]

    out = []
    for idx, (s, e) in enumerate(merged, 1):
        settle_ms = int(pts[s])
        shot_ms = int(min(pts[s] + 200, (pts[s] + pts[e]) / 2))
        shot_frame = int(np.searchsorted(pts, shot_ms))
        image = frames_dir / f"plateau-{idx:03d}.png"
        frames_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(0.0, pts[min(shot_frame, e)] / 1000 - 0.010):.3f}", "-i", str(video),
                        "-frames:v", "1", str(image)], check=True)
        out.append({"id": uuid4().hex, "timestamp_ms": settle_ms, "image_path": str(image),
                    "dwell_ms": int((pts[e + 1] if e + 1 < n else end_ms) - pts[s]), "is_initial": s == 0})
    return out
