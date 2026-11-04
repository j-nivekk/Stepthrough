"""Run the stable-screen engine (and hybrid v2 for comparison) on real recordings, through working copies.

    uv run python experiments/real_stable.py OUT_DIR CACHE_DIR VIDEO [VIDEO ...] [--hybrid] [--type desktop]

Contact sheets go to OUT_DIR (keep it out of git: real recordings show real people). Working copies are
cached in CACHE_DIR so reruns only time the detection.
"""
from __future__ import annotations

import argparse
import hashlib
import resource
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, ".")
from app.models import HybridAdvancedSettings, RunSettings, StableSettings  # noqa: E402
from app.services.hybrid_detection import detect_candidates_hybrid  # noqa: E402
from app.services.ingest import build_working_copy  # noqa: E402
from app.services.stable_detection import detect_candidates_stable  # noqa: E402
from app.services.video import probe_video  # noqa: E402


def sheet(candidates: list[dict], label: str, path: Path) -> None:
    tiles = []
    for c in candidates:
        image = cv2.imread(c["image_path"])
        if image is None:
            continue
        b = c.get("score_breakdown") or {}
        tile = cv2.resize(image, (180, int(180 * image.shape[0] / image.shape[1])))
        cv2.rectangle(tile, (0, 0), (180, 44), (0, 0, 0), -1)
        cv2.putText(tile, f"{c['timestamp_ms'] / 1000:.2f}s  {(b.get('dwell_after_ms') or 0) / 1000:.1f}s on",
                    (5, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
        kind = str(b.get("transition_type") or "")
        if (b.get("grouped_states") or 1) > 1:
            kind += f" x{b['grouped_states']}"
        if c.get("revisit_group_id"):
            kind += " (revisit)"
        cv2.putText(tile, kind, (5, 37), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (120, 220, 255), 1)
        tiles.append(tile)
    if not tiles:
        return
    per_row = 8
    height = max(t.shape[0] for t in tiles)
    rows = []
    for i in range(0, len(tiles), per_row):
        row = [np.pad(t, ((0, height - t.shape[0]), (4, 4), (0, 0)), constant_values=255) for t in tiles[i:i + per_row]]
        while len(row) < per_row:
            row.append(np.full((height, 188, 3), 255, np.uint8))
        rows.append(np.hstack(row))
    image = np.vstack(rows)
    header = np.full((40, image.shape[1], 3), 255, np.uint8)
    cv2.putText(header, label, (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
    cv2.imwrite(str(path), np.vstack([header, image]), [cv2.IMWRITE_JPEG_QUALITY, 80])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=Path)
    parser.add_argument("cache", type=Path)
    parser.add_argument("videos", nargs="+", type=Path)
    parser.add_argument("--hybrid", action="store_true", help="also run hybrid v2 (balanced, OCR off)")
    parser.add_argument("--type", default="phone", choices=("phone", "desktop"))
    parser.add_argument("--no-typing", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)

    for source in args.videos:
        name = source.stem[-22:]
        key = hashlib.sha1(str(source.resolve()).encode()).hexdigest()[:10]
        working = args.cache / f"{key}.mp4"
        if not working.exists():
            build_working_copy(source, working)
        meta = probe_video(working)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            settings = RunSettings(
                analysis_engine="stable_v3",
                stable=StableSettings(recording_type=args.type, group_typing=not args.no_typing),
            )
            report: dict = {}
            started = time.perf_counter()
            stable = detect_candidates_stable(
                video_path=working, frames_dir=tmp / "s", duration_ms=meta.duration_ms, fps=meta.fps,
                settings=settings, width=meta.width, height=meta.height, report=report,
            )
            seconds = time.perf_counter() - started
            rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6
            print(f"{name}: {meta.duration_ms / 1000:.0f}s {meta.width}x{meta.height} | stable {len(stable)} steps in "
                  f"{seconds:.1f}s | {report} | peak RSS {rss:.0f} MB", flush=True)
            sheet(stable, f"stable_v3 ({args.type}): {len(stable)} steps, {seconds:.1f}s", args.out / f"{name}__stable.jpg")
            if args.hybrid:
                hybrid_settings = RunSettings(analysis_engine="hybrid_v2", analysis_preset="balanced",
                                              advanced=HybridAdvancedSettings(enable_ocr=False))
                started = time.perf_counter()
                hybrid = detect_candidates_hybrid(video_path=working, frames_dir=tmp / "h", duration_ms=meta.duration_ms,
                                                  fps=meta.fps, settings=hybrid_settings)
                seconds = time.perf_counter() - started
                print(f"{name}: hybrid {len(hybrid)} candidates in {seconds:.1f}s", flush=True)
                sheet(hybrid, f"hybrid v2 (balanced): {len(hybrid)} candidates, {seconds:.1f}s",
                      args.out / f"{name}__hybrid_working.jpg")


if __name__ == "__main__":
    main()
