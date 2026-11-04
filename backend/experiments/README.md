# Experiments (not part of the app)

Scripts behind `docs/robustness-review-2026-11.md`. Run them from `backend/` with the project venv.

| script | what it does |
|---|---|
| `vfr_drift.py` | estimates, from ffprobe timestamps, how far a constant-frame-rate frame mapping drifts on each recording |
| `plateau.py` | prototype stable-interval detector (timestamp-accurate decode, measured noise floor, dynamic-region masking, one screenshot per settled interval) |
| `real_stable.py` | phase 1: runs `stable_v3` on real recordings through cached working copies, prints the measured values and writes labelled contact sheets: `real_stable.py <out_dir> <cache_dir> <videos...> [--type desktop] [--no-typing]` |

`out/` is ignored by git: contact sheets of real recordings show real people.

The scripts that ran the retired hybrid v2 engine (`stress.py`, `reader_check.py`, `real_compare.py`, and
`real_stable.py --hybrid`) are at the git tag `last-with-hybrid-v2`.
