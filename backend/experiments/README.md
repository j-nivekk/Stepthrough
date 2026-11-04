# Experiments (not part of the app)

Scripts behind `docs/robustness-review-2026-11.md`. Run them from `backend/` with the project venv.

| script | what it does |
|---|---|
| `vfr_drift.py` | estimates, from ffprobe timestamps, how far a constant-frame-rate frame mapping drifts on each recording |
| `reader_check.py` | runs the engine's own `_SequentialReader` and compares each sample's nominal time with the real timestamp of the frame it decoded; saves the worst analysed/exported pair |
| `stress.py` | superseded by `tests/eval/stress.py` (which runs uploads through the working copy); kept to reproduce the review's numbers. Re-encodes every synthetic eval scenario (H.264 CFR, phone-style VFR) and adds overlays (caret, spinner, pointer, clock); scores P/R/F1 plus whether each screenshot shows the settled post-event state. `--engine hybrid|plateau`, `--preset`, `--only`, `--variants`, `--min-area` |
| `plateau.py` | prototype stable-interval detector (timestamp-accurate decode, measured noise floor, dynamic-region masking, one screenshot per settled interval) |
| `real_compare.py` | runs both engines on real recordings, times them and writes contact sheets: `real_compare.py <out_dir> <videos...>` |
