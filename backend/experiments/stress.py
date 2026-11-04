"""Stress harness: re-run the baseline eval scenarios under real-world encodings and overlays.

Usage (from backend/):  .venv/bin/python <this file> [--preset balanced] [--only nav_basic,...]

For every baseline scenario it renders the clean MJPEG ground truth, then derives variants:
  encodings  : mjpeg_cfr (as the suite does today), h264_cfr, h264_vfr (iOS-style duplicate-frame drop)
  overlays   : cursor (blinking caret), spinner (looping activity indicator),
               pointer (desktop mouse drifting), clock (status-bar clock ticking each second)
Detection is run exactly like the app: metadata from ffprobe, frames from the encoded file.

Besides the suite's timing-window P/R/F1 it reports *screenshot fidelity*: for each matched event,
is the exported PNG closer to the settled post-event frame than to the pre-event frame?
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, ".")
from app.models import HybridAdvancedSettings, RunSettings  # noqa: E402
from app.services.hybrid_detection import detect_candidates_hybrid  # noqa: E402
from app.services.video import probe_video  # noqa: E402
from tests.eval.evaluator import evaluate  # noqa: E402
from tests.eval.scenarios import BASELINE_SCENARIOS  # noqa: E402


def read_frames(path: Path) -> tuple[list[np.ndarray], float]:
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    return frames, fps


def write_mjpeg(frames: list[np.ndarray], fps: float, path: Path) -> None:
    h, w = frames[0].shape[:2]
    wr = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (w, h))
    for f in frames:
        wr.write(f)
    wr.release()


def overlay(frames: list[np.ndarray], fps: float, kind: str) -> list[np.ndarray]:
    out = []
    for i, f in enumerate(frames):
        g = f.copy()
        h, w = g.shape[:2]
        t = i / fps
        if kind == "cursor":  # 530 ms caret blink inside a text-field-sized area
            if int(t / 0.53) % 2 == 0:
                cv2.line(g, (int(w * 0.30), int(h * 0.55)), (int(w * 0.30), int(h * 0.55) + max(10, h // 30)), (20, 20, 20), 2)
        elif kind == "spinner":  # activity indicator rotating continuously in a corner
            cx, cy, r = int(w * 0.88), int(h * 0.80), max(8, h // 28)
            for k in range(8):
                a = (k / 8) * 2 * math.pi + t * 2 * math.pi
                shade = int(60 + 190 * (((k + int(t * 8)) % 8) / 7))
                cv2.circle(g, (int(cx + r * math.cos(a)), int(cy + r * math.sin(a))), max(2, r // 4), (shade, shade, shade), -1)
        elif kind == "pointer":  # desktop mouse pointer wandering (Lissajous path)
            x = int(w * (0.5 + 0.4 * math.sin(t * 1.3)))
            y = int(h * (0.5 + 0.35 * math.sin(t * 0.9 + 1.0)))
            pts = np.array([[x, y], [x, y + 18], [x + 5, y + 14], [x + 12, y + 14]], np.int32)
            cv2.fillPoly(g, [pts], (0, 0, 0))
            cv2.polylines(g, [pts], True, (255, 255, 255), 1)
        elif kind == "clock":  # status-bar clock text changing every second
            cv2.rectangle(g, (8, 2), (90, 18), (245, 245, 245), -1)
            cv2.putText(g, f"9:{41 + int(t):02d}:{int(t * 10) % 10}", (10, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (10, 10, 10), 1)
        out.append(g)
    return out


def encode(src: Path, dst: Path, mode: str) -> None:
    base = ["ffmpeg", "-v", "error", "-y", "-i", str(src)]
    if mode == "h264_cfr":
        cmd = base + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", str(dst)]
    elif mode == "h264_vfr":
        # ReplayKit-style: a frame is emitted only when the screen content changed (or after 1 s
        # without one); presentation timestamps keep real time. Built with the concat demuxer so
        # that only exact duplicates are dropped.
        frames, fps = read_frames(src)
        work = dst.parent / "vfr_frames"
        work.mkdir(exist_ok=True)
        kept, last_t = [0], 0.0
        for i in range(1, len(frames)):
            t = i / fps
            if not np.array_equal(frames[i], frames[i - 1]) or t - last_t >= 1.0:
                kept.append(i); last_t = t
        lines = []
        for k, i in enumerate(kept):
            png = work / f"{i:05d}.png"
            cv2.imwrite(str(png), frames[i])
            nxt = kept[k + 1] if k + 1 < len(kept) else len(frames)
            lines += [f"file '{png}'", f"duration {(nxt - i) / fps:.6f}"]
        lines.append(f"file '{work / f'{kept[-1]:05d}.png'}'")
        (work / "list.txt").write_text("\n".join(lines) + "\n")
        cmd = ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(work / "list.txt"),
               "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", str(dst)]
    else:
        raise ValueError(mode)
    subprocess.run(cmd, check=True)


def small_gray(img: np.ndarray) -> np.ndarray:
    return cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (160, 90 if img.shape[1] > img.shape[0] else 284)).astype(np.float32)


def fidelity(candidates, gt, clean_frames, fps, tolerance_ms=500):
    """Fraction of matched events whose exported screenshot shows the post-event state."""
    metrics = evaluate(candidates, gt, tolerance_ms=tolerance_ms)
    gt_sorted = sorted(gt, key=lambda e: e.start_ms)
    good = total = 0
    n = len(clean_frames)
    for idx, res in enumerate(metrics.per_event_results):
        if res.matched_candidate_index is None:
            continue
        ev = res.ground_truth
        nxt = gt_sorted[idx + 1].start_ms if idx + 1 < len(gt_sorted) else 10**9
        post_ms = min(ev.end_ms + 400, nxt - 60)
        pre_ms = max(0, ev.start_ms - 150)
        post = clean_frames[min(n - 1, int(post_ms / 1000 * fps))]
        pre = clean_frames[min(n - 1, int(pre_ms / 1000 * fps))]
        shot = cv2.imread(candidates[res.matched_candidate_index]["image_path"])
        shot = cv2.resize(shot, (post.shape[1], post.shape[0]))
        s, a, b = small_gray(shot), small_gray(pre), small_gray(post)
        d_pre, d_post = float(np.mean(np.abs(s - a))), float(np.mean(np.abs(s - b)))
        total += 1
        good += int(d_post <= d_pre * 0.5 or d_post < 1.0)
    return metrics, good, total


def run_detection(video: Path, frames_dir: Path, preset: str):
    meta = probe_video(video)
    if ENGINE == "plateau":
        sys.path.insert(0, str(Path(__file__).parent))
        import plateau
        t0 = time.perf_counter()
        cands = plateau.detect(video, frames_dir, plateau.PlateauConfig(min_change_area=MIN_AREA), duration_ms=meta.duration_ms)
        # The suite's ground truth never lists the opening screen, so leave it out of scoring.
        return [c for c in cands if not c["is_initial"]], time.perf_counter() - t0, meta
    settings = RunSettings(analysis_engine="hybrid_v2", analysis_preset=preset,
                           advanced=HybridAdvancedSettings(enable_ocr=False), min_scene_gap_ms=900)
    t0 = time.perf_counter()
    cands = detect_candidates_hybrid(video_path=video, frames_dir=frames_dir, duration_ms=meta.duration_ms,
                                     fps=meta.fps, settings=settings)
    return cands, time.perf_counter() - t0, meta


ENGINE = "hybrid"
MIN_AREA = 0.001
VARIANTS = [("mjpeg_cfr", None), ("h264_cfr", None), ("h264_vfr", None),
            ("h264_vfr", "cursor"), ("h264_vfr", "spinner"), ("h264_vfr", "pointer"), ("h264_vfr", "clock")]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", default="balanced")
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--engine", default="hybrid")
    ap.add_argument("--min-area", type=float, default=0.001)
    ap.add_argument("--variants", default="")
    args = ap.parse_args()
    global ENGINE, MIN_AREA
    ENGINE = args.engine
    MIN_AREA = args.min_area
    wanted = {v for v in args.variants.split(",") if v}
    only = {s for s in args.only.split(",") if s}
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for name, factory in BASELINE_SCENARIOS:
            if only and name not in only:
                continue
            sdir = tmp / name
            sdir.mkdir()
            scen = factory(sdir, 30)
            clean, fps = read_frames(scen.video_path)
            for enc, ov in VARIANTS:
                label = enc + (f"+{ov}" if ov else "")
                if wanted and label not in wanted:
                    continue
                vdir = sdir / label.replace("+", "_")
                vdir.mkdir()
                src = scen.video_path
                if ov:
                    src = vdir / "overlay.avi"
                    write_mjpeg(overlay(clean, fps, ov), fps, src)
                video = src if enc == "mjpeg_cfr" else vdir / "enc.mp4"
                if enc != "mjpeg_cfr":
                    encode(src, video, enc)
                cands, secs, meta = run_detection(video, vdir / "frames", args.preset)
                m, good, total = fidelity(cands, scen.ground_truth, clean, fps)
                rows.append(dict(scenario=name, variant=label, tp=m.total_ground_truth - m.missed_events, fp=m.false_positives,
                                 missed=m.missed_events, gt=len(scen.ground_truth), cand=len(cands),
                                 shot_ok=good, shot_total=total, secs=round(secs, 2), fps_meta=meta.fps))
                print(f"{name:28s} {label:18s} cand={len(cands):2d} TP={m.total_ground_truth - m.missed_events} FP={m.false_positives} "
                      f"miss={m.missed_events} shot_ok={good}/{total} fps={meta.fps}", flush=True)
    by = {}
    for r in rows:
        a = by.setdefault(r["variant"], dict(tp=0, fp=0, missed=0, gt=0, ok=0, tot=0))
        a["tp"] += r["tp"]; a["fp"] += r["fp"]; a["missed"] += r["missed"]; a["gt"] += r["gt"]
        a["ok"] += r["shot_ok"]; a["tot"] += r["shot_total"]
    print(f"\n{'variant':18s}  P     R     F1    screenshot-correct  (engine={args.engine} preset={args.preset})")
    for v, a in by.items():
        p = a["tp"] / max(1, a["tp"] + a["fp"]); r = a["tp"] / max(1, a["gt"]); f = 2 * p * r / max(1e-9, p + r)
        print(f"{v:18s} {p:.2f}  {r:.2f}  {f:.2f}   {a['ok']}/{a['tot']} ({a['ok'] / max(1, a['tot']):.0%})")
    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
