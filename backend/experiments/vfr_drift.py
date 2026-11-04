"""Measure how far the detector's CFR timestamp->frame mapping drifts from real PTS on VFR recordings."""
import json, subprocess, sys
import cv2

for path in sys.argv[1:]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "frame=best_effort_timestamp_time", "-of", "json", path],
                         capture_output=True, text=True).stdout
    pts = [float(f["best_effort_timestamp_time"]) for f in json.loads(out)["frames"] if "best_effort_timestamp_time" in f]
    cap = cv2.VideoCapture(path)
    cv_fps = cap.get(cv2.CAP_PROP_FPS); cv_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    probe = json.loads(subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=avg_frame_rate","-of","json",path],capture_output=True,text=True).stdout)
    n, d = probe["streams"][0]["avg_frame_rate"].split("/"); avg = float(n)/float(d)
    gaps = [b - a for a, b in zip(pts, pts[1:])]
    # Detector: frame_index = round(t * avg_fps); actual time of that frame = pts[index]
    worst = 0.0; worst_t = 0
    t = 0.0
    while t < pts[-1]:
        idx = min(len(pts) - 1, int(round(t * avg)))
        err = pts[idx] - pts[0] - t
        if abs(err) > abs(worst): worst, worst_t = err, t
        t += 1/6
    longest = max(gaps)
    print(f"{path.split('/')[-1]}: frames={len(pts)} cv_count={cv_count} cv_fps={cv_fps:.2f} avg_fps={avg:.2f} "
          f"min_gap={min(gaps)*1000:.1f}ms max_gap={longest*1000:.0f}ms "
          f"gaps>200ms={sum(g>0.2 for g in gaps)} worst_drift={worst*1000:+.0f}ms at t={worst_t:.1f}s")
