"""Run the detector's own _SequentialReader and compare each sample's nominal time with the real PTS of the frame it decoded."""
import sys, cv2, subprocess, numpy as np, tempfile, os
sys.path.insert(0, ".")
from app.services.hybrid_detection import _SequentialReader, _sample_timestamps
from app.services.video import probe_video

path = sys.argv[1]
meta = probe_video(__import__("pathlib").Path(path))
cap = cv2.VideoCapture(path)
reader = _SequentialReader(cap, meta.fps)
tmp = tempfile.mkdtemp()
worst = []
for t in _sample_timestamps(meta.duration_ms, 6.0):
    frame = reader.next(t)
    if frame is None: continue
    real_ms = cap.get(cv2.CAP_PROP_POS_MSEC)  # pts of the frame just decoded
    small = cv2.resize(frame, (frame.shape[1]//4, frame.shape[0]//4))
    worst.append((real_ms - t, t))
    if abs(real_ms - t) >= max(abs(e) for e, _ in worst): keep = (t, small)
t, frame = keep
# What the user actually gets: ffmpeg -ss at the nominal timestamp
out = os.path.join(tmp, "x.png")
subprocess.run(["ffmpeg","-v","error","-ss",f"{t/1000:.3f}","-i",path,"-frames:v","1","-y",out])
shot = cv2.imread(out)
a = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (120, 260)).astype(float)
shot = cv2.resize(shot, (frame.shape[1], frame.shape[0]))
b = cv2.resize(cv2.cvtColor(shot, cv2.COLOR_BGR2GRAY), (120, 260)).astype(float)
errs = np.array([abs(e) for e, _ in worst])
print(f"{os.path.basename(path)}: samples={len(worst)} median|drift|={np.median(errs):.0f}ms p90={np.percentile(errs,90):.0f}ms max={errs.max():.0f}ms "
      f"| at nominal t={t/1000:.1f}s analysed frame vs exported screenshot mean abs diff={np.mean(np.abs(a-b)):.1f}/255")
cv2.imwrite(sys.argv[2] + "_analysed.png", frame); cv2.imwrite(sys.argv[2] + "_exported.png", shot)
