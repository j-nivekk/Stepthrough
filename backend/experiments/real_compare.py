"""Run the current hybrid engine and the plateau prototype on real recordings; time them and build contact sheets."""
from __future__ import annotations

import resource
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, ".")
sys.path.insert(0, str(Path(__file__).parent))
from app.models import HybridAdvancedSettings, RunSettings  # noqa: E402
from app.services.hybrid_detection import detect_candidates_hybrid  # noqa: E402
from app.services.video import probe_video  # noqa: E402
import plateau  # noqa: E402

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)


def sheet(cands: list[dict], label: str, path: Path) -> None:
    tiles = []
    for c in cands:
        im = cv2.imread(c["image_path"])
        if im is None:
            continue
        th = cv2.resize(im, (180, int(180 * im.shape[0] / im.shape[1])))
        cv2.rectangle(th, (0, 0), (180, 26), (0, 0, 0), -1)
        cv2.putText(th, f"{c['timestamp_ms'] / 1000:.2f}s", (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
        tiles.append(th)
    if not tiles:
        return
    per_row = 8
    h = max(t.shape[0] for t in tiles)
    rows = []
    for i in range(0, len(tiles), per_row):
        row = [np.pad(t, ((0, h - t.shape[0]), (4, 4), (0, 0)), constant_values=255) for t in tiles[i:i + per_row]]
        while len(row) < per_row:
            row.append(np.full((h, 188, 3), 255, np.uint8))
        rows.append(np.hstack(row))
    img = np.vstack(rows)
    header = np.full((40, img.shape[1], 3), 255, np.uint8)
    cv2.putText(header, label, (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
    cv2.imwrite(str(path), np.vstack([header, img]), [cv2.IMWRITE_JPEG_QUALITY, 80])


for video in sys.argv[2:]:
    video = Path(video)
    meta = probe_video(video)
    name = video.stem[-22:]
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        settings = RunSettings(analysis_engine="hybrid_v2", analysis_preset="balanced",
                               advanced=HybridAdvancedSettings(enable_ocr=False))
        t0 = time.perf_counter()
        hy = detect_candidates_hybrid(video_path=video, frames_dir=tmp / "h", duration_ms=meta.duration_ms,
                                      fps=meta.fps, settings=settings)
        t_h = time.perf_counter() - t0
        t0 = time.perf_counter()
        pl = plateau.detect(video, tmp / "p", duration_ms=meta.duration_ms)
        t_p = time.perf_counter() - t0
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6
        print(f"{name}: {meta.duration_ms / 1000:.0f}s {meta.width}x{meta.height} | hybrid {len(hy)} cand in {t_h:.1f}s "
              f"| plateau {len(pl)} cand in {t_p:.1f}s | peak RSS so far {rss:.0f} MB", flush=True)
        sheet(hy, f"current hybrid v2 (balanced): {len(hy)} candidates", OUT / f"{name}__hybrid.jpg")
        sheet(pl, f"plateau prototype: {len(pl)} candidates", OUT / f"{name}__plateau.jpg")
