"""Stress matrix: the baseline scenarios re-encoded the way real uploads arrive, plus interface noise.

Each baseline scenario is rendered once (the clean MJPEG doubles as the visual reference), then turned
into "uploads":

    encodings : raw (the generated file, as the baseline suite uses it), h264_cfr (a compressed upload),
                h264_vfr (phone-style: a frame is written only when the screen changes, at least once a second)
    overlays  : cursor (blinking caret), spinner (looping activity indicator), pointer (a desktop mouse
                pointer that keeps moving), clock (a status-bar clock ticking every second)

Uploads go through the same pipeline as the app (ingest working copy, ffprobe metadata, detection).
Besides precision/recall it reports *screenshot fidelity*: for each matched event, whether the exported
PNG shows the settled post-event state rather than the pre-event one.

The stable-screen engine (``--engine stable_v3``) also returns the opening screen as step 0. Ground truth
lists changes only, so that candidate is scored separately ("opening": present and showing frame 0) and
left out of precision/recall. The ``step_scenarios`` (typing, toggles) run with ``--set all`` or ``steps``.

Usage (from backend/)::

    python -m tests.eval.stress                         # full matrix, hybrid v2, balanced preset
    python -m tests.eval.stress --engine stable_v3 --set all
    python -m tests.eval.stress --preset subtle_ui
    python -m tests.eval.stress --no-ingest             # detect on the upload directly (pre-ingest behaviour)
    python -m tests.eval.stress --only nav_basic --variants h264_vfr,h264_vfr+spinner
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from app.models import HybridAdvancedSettings, RunSettings, StableSettings
from app.services.hybrid_detection import detect_candidates_hybrid
from app.services.ingest import build_working_copy
from app.services.stable_detection import detect_candidates_stable
from app.services.video import probe_video

from .evaluator import evaluate
from .scenarios import BASELINE_SCENARIOS
from .step_scenarios import STEP_SCENARIOS
from .types import EvalMetrics, GroundTruthEvent

SCENARIO_SETS = {
    "baseline": BASELINE_SCENARIOS,
    "steps": STEP_SCENARIOS,
    "all": [*BASELINE_SCENARIOS, *STEP_SCENARIOS],
}

ENCODINGS = ("raw", "h264_cfr", "h264_vfr")
OVERLAYS = ("cursor", "spinner", "pointer", "clock")
VARIANTS = (
    ("raw", None),
    ("h264_cfr", None),
    ("h264_vfr", None),
    *(("h264_vfr", overlay) for overlay in OVERLAYS),
)


def variant_label(encoding: str, overlay: str | None) -> str:
    return encoding + (f"+{overlay}" if overlay else "")


def read_frames(path: Path) -> tuple[list[np.ndarray], float]:
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS)
    frames = []
    while (frame := capture.read()[1]) is not None:
        frames.append(frame)
    capture.release()
    return frames, fps


def write_mjpeg(frames: list[np.ndarray], fps: float, path: Path) -> None:
    height, width = frames[0].shape[:2]
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (width, height))
    for frame in frames:
        writer.write(frame)
    writer.release()


def apply_overlay(frames: list[np.ndarray], fps: float, kind: str) -> list[np.ndarray]:
    out = []
    for index, source in enumerate(frames):
        frame = source.copy()
        height, width = frame.shape[:2]
        t = index / fps
        if kind == "cursor":  # 530 ms caret blink in a text-field-sized spot
            if int(t / 0.53) % 2 == 0:
                x, y = int(width * 0.30), int(height * 0.55)
                cv2.line(frame, (x, y), (x, y + max(10, height // 30)), (20, 20, 20), 2)
        elif kind == "spinner":  # activity indicator rotating continuously in a corner
            cx, cy, radius = int(width * 0.88), int(height * 0.80), max(8, height // 28)
            for k in range(8):
                angle = (k / 8) * 2 * math.pi + t * 2 * math.pi
                shade = int(60 + 190 * (((k + int(t * 8)) % 8) / 7))
                centre = (int(cx + radius * math.cos(angle)), int(cy + radius * math.sin(angle)))
                cv2.circle(frame, centre, max(2, radius // 4), (shade, shade, shade), -1)
        elif kind == "pointer":  # desktop mouse pointer wandering on a Lissajous path
            x = int(width * (0.5 + 0.4 * math.sin(t * 1.3)))
            y = int(height * (0.5 + 0.35 * math.sin(t * 0.9 + 1.0)))
            arrow = np.array([[x, y], [x, y + 18], [x + 5, y + 14], [x + 12, y + 14]], np.int32)
            cv2.fillPoly(frame, [arrow], (0, 0, 0))
            cv2.polylines(frame, [arrow], True, (255, 255, 255), 1)
        elif kind == "clock":  # status-bar clock text changing every second
            cv2.rectangle(frame, (8, 2), (90, 18), (245, 245, 245), -1)
            label = f"9:{41 + int(t):02d}:{int(t * 10) % 10}"
            cv2.putText(frame, label, (10, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (10, 10, 10), 1)
        else:
            raise ValueError(f"Unknown overlay: {kind}")
        out.append(frame)
    return out


def encode_upload(frames: list[np.ndarray], fps: float, destination: Path, encoding: str) -> None:
    x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
    if encoding == "h264_cfr":
        source = destination.with_suffix(".avi")
        write_mjpeg(frames, fps, source)
        command = ["ffmpeg", "-v", "error", "-y", "-i", str(source), *x264, str(destination)]
    elif encoding == "h264_vfr":
        # ReplayKit-style: only exact duplicates are dropped (at least one frame per second is kept),
        # presentation timestamps keep real time. Built with the concat demuxer and per-frame durations.
        work = destination.parent / "vfr_frames"
        work.mkdir(exist_ok=True)
        kept, last_kept_t = [0], 0.0
        for index in range(1, len(frames)):
            t = index / fps
            if not np.array_equal(frames[index], frames[index - 1]) or t - last_kept_t >= 1.0:
                kept.append(index)
                last_kept_t = t
        if kept[-1] != len(frames) - 1:
            kept.append(len(frames) - 1)  # recorders write a final frame on stop, which fixes the duration
        lines = []
        for position, index in enumerate(kept):
            png = work / f"{index:05d}.png"
            cv2.imwrite(str(png), frames[index])
            following = kept[position + 1] if position + 1 < len(kept) else len(frames)
            lines += [f"file '{png}'", f"duration {(following - index) / fps:.6f}"]
        lines.append(f"file '{work / f'{kept[-1]:05d}.png'}'")
        listing = work / "list.txt"
        listing.write_text("\n".join(lines) + "\n")
        command = ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
                   "-fps_mode", "vfr", *x264, str(destination)]
    else:
        raise ValueError(f"Unknown encoding: {encoding}")
    subprocess.run(command, check=True)


def _small_gray(image: np.ndarray) -> np.ndarray:
    size = (160, 90) if image.shape[1] > image.shape[0] else (90, 160)
    return cv2.resize(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), size).astype(np.float32)


def screenshot_fidelity(
    candidates: list[dict],
    ground_truth: list[GroundTruthEvent],
    metrics: EvalMetrics,
    reference_frames: list[np.ndarray],
    reference_fps: float,
) -> tuple[int, int]:
    """(correct, matched): a matched screenshot is correct when it is at least twice as close to the
    settled post-event frame as to the pre-event frame (or near-identical to the post-event frame).

    Distances are measured where the pre- and post-event frames differ, so a small change (a toggle, a
    typed word) is judged on that change rather than drowned in compression noise across the frame."""
    ordered = sorted(ground_truth, key=lambda event: event.start_ms)
    count = len(reference_frames)
    correct = matched = 0
    for position, result in enumerate(metrics.per_event_results):
        if result.matched_candidate_index is None:
            continue
        event = result.ground_truth
        next_start = ordered[position + 1].start_ms if position + 1 < len(ordered) else 10**9
        post = reference_frames[min(count - 1, int(min(event.end_ms + 400, next_start - 60) / 1000 * reference_fps))]
        pre = reference_frames[min(count - 1, int(max(0, event.start_ms - 150) / 1000 * reference_fps))]
        shot = cv2.imread(candidates[result.matched_candidate_index]["image_path"])
        shot = _small_gray(cv2.resize(shot, (post.shape[1], post.shape[0])))
        pre_g, post_g = _small_gray(pre), _small_gray(post)
        region = np.abs(pre_g - post_g) > 10.0
        if region.sum() < 4:
            region = np.ones_like(region)
        d_pre = float(np.mean(np.abs(shot - pre_g)[region]))
        d_post = float(np.mean(np.abs(shot - post_g)[region]))
        matched += 1
        correct += int(d_post <= d_pre * 0.5 or d_post < 1.0)
    return correct, matched


@dataclass
class VariantResult:
    scenario: str
    variant: str
    metrics: EvalMetrics
    screenshots_correct: int
    screenshots_matched: int
    candidates: list[dict] = field(repr=False, default_factory=list)
    opening_ok: bool | None = None  # stable engine only: step 0 present and showing the first frame
    seconds: float = 0.0
    labels_agree: int = 0
    labels_checked: int = 0


# Ground-truth event types and the transition labels that describe them correctly.
LABEL_MATCHES = {
    "navigation": {"navigation"},
    "scroll": {"scroll"},
    "card_swap": {"feed_card_swap"},
    "modal": {"modal"},
    "content_update": {"content_update", "text_entry"},
    "small_ui_change": {"small_ui_change", "content_update"},
    "loading": {"content_update", "navigation"},
}


def label_agreement(candidates: list[dict], metrics: EvalMetrics) -> tuple[int, int]:
    agree = checked = 0
    for result in metrics.per_event_results:
        if result.matched_candidate_index is None:
            continue
        wanted = LABEL_MATCHES.get(result.ground_truth.event_type)
        if wanted is None:
            continue
        label = (candidates[result.matched_candidate_index].get("score_breakdown") or {}).get("transition_type")
        checked += 1
        agree += int(label in wanted)
    return agree, checked


def run_variant(
    scenario_name: str,
    scenario_dir: Path,
    reference: tuple[list[np.ndarray], float, Path],
    ground_truth: list[GroundTruthEvent],
    encoding: str,
    overlay: str | None,
    *,
    preset: str = "balanced",
    ingest: bool = True,
    engine: str = "hybrid_v2",
    stable: StableSettings | None = None,
) -> VariantResult:
    frames, fps, raw_path = reference
    label = variant_label(encoding, overlay)
    work = scenario_dir / label.replace("+", "_")
    work.mkdir(parents=True, exist_ok=True)
    source_frames = apply_overlay(frames, fps, overlay) if overlay else frames
    if encoding == "raw":
        upload = raw_path
        if overlay:
            upload = work / "upload.avi"
            write_mjpeg(source_frames, fps, upload)
    else:
        upload = work / "upload.mp4"
        encode_upload(source_frames, fps, upload, encoding)

    video = upload
    if ingest:
        video = work / "working" / "working.mp4"
        build_working_copy(upload, video)
    metadata = probe_video(video)
    started = time.perf_counter()
    opening_ok = None
    if engine == "stable_v3":
        if stable is None:
            # A wandering mouse pointer is what the "computer" recording type is for.
            stable = StableSettings(recording_type="desktop" if overlay == "pointer" else "phone")
        settings = RunSettings(analysis_engine="stable_v3", stable=stable)
        candidates = detect_candidates_stable(
            video_path=video,
            frames_dir=work / "frames",
            duration_ms=metadata.duration_ms,
            fps=metadata.fps,
            settings=settings,
            width=metadata.width,
            height=metadata.height,
        )
        opening = [c for c in candidates if (c.get("score_breakdown") or {}).get("transition_type") == "opening_screen"]
        if stable.include_opening_screen:
            opening_ok = len(opening) == 1 and _shows_frame(opening[0], frames[0], frames)
        candidates = [c for c in candidates if c not in opening]
    else:
        settings = RunSettings(
            analysis_engine="hybrid_v2",
            analysis_preset=preset,
            advanced=HybridAdvancedSettings(enable_ocr=False),
            min_scene_gap_ms=900,
        )
        candidates = detect_candidates_hybrid(
            video_path=video,
            frames_dir=work / "frames",
            duration_ms=metadata.duration_ms,
            fps=metadata.fps,
            settings=settings,
        )
    seconds = time.perf_counter() - started
    metrics = evaluate(candidates, ground_truth)
    correct, matched = screenshot_fidelity(candidates, ground_truth, metrics, frames, fps)
    agree, checked = label_agreement(candidates, metrics)
    return VariantResult(scenario_name, label, metrics, correct, matched, candidates, opening_ok, seconds, agree, checked)


def _shows_frame(candidate: dict, expected: np.ndarray, frames: list[np.ndarray]) -> bool:
    """The screenshot is closer to ``expected`` than to any visibly different frame of the clip."""
    shot = cv2.imread(candidate["image_path"])
    if shot is None:
        return False
    shot = _small_gray(cv2.resize(shot, (expected.shape[1], expected.shape[0])))
    target = _small_gray(expected)
    d_target = float(np.mean(np.abs(shot - target)))
    others = [float(np.mean(np.abs(shot - _small_gray(f)))) for f in frames[:: max(1, len(frames) // 60)]
              if float(np.mean(np.abs(_small_gray(f) - target))) > 4.0]
    return d_target < 2.0 or all(d_target * 2 <= d for d in others)


def run_matrix(
    *,
    preset: str = "balanced",
    ingest: bool = True,
    scenarios: set[str] | None = None,
    variants: set[str] | None = None,
    work_dir: Path,
    echo: bool = False,
    engine: str = "hybrid_v2",
    scenario_set: str = "baseline",
    stable: StableSettings | None = None,
) -> list[VariantResult]:
    results = []
    for name, factory in SCENARIO_SETS[scenario_set]:
        if scenarios and name not in scenarios:
            continue
        scenario_dir = work_dir / name
        scenario_dir.mkdir(parents=True, exist_ok=True)
        scenario = factory(scenario_dir, 30)
        frames, fps = read_frames(scenario.video_path)
        for encoding, overlay in VARIANTS:
            if variants and variant_label(encoding, overlay) not in variants:
                continue
            result = run_variant(
                name, scenario_dir, (frames, fps, scenario.video_path), scenario.ground_truth,
                encoding, overlay, preset=preset, ingest=ingest, engine=engine, stable=stable,
            )
            results.append(result)
            if echo:
                m = result.metrics
                print(
                    f"  {name:28s} {result.variant:18s} cand={m.total_candidates:2d} "
                    f"TP={m.total_ground_truth - m.missed_events} FP={m.false_positives} miss={m.missed_events} "
                    f"shots={result.screenshots_correct}/{result.screenshots_matched}"
                    + ("" if result.opening_ok is None else f" opening={'ok' if result.opening_ok else 'WRONG'}")
                    + f" labels={result.labels_agree}/{result.labels_checked} {result.seconds:.1f}s",
                    flush=True,
                )
    return results


def summarise(results: list[VariantResult]) -> dict[str, dict[str, float | int]]:
    summary: dict[str, dict[str, float | int]] = {}
    for result in results:
        row = summary.setdefault(
            result.variant,
            {"tp": 0, "fp": 0, "gt": 0, "shots_correct": 0, "shots_matched": 0, "opening_ok": 0, "opening_checked": 0,
             "seconds": 0.0, "labels_agree": 0, "labels_checked": 0},
        )
        row["labels_agree"] += result.labels_agree
        row["labels_checked"] += result.labels_checked
        m = result.metrics
        row["tp"] += m.total_ground_truth - m.missed_events
        row["fp"] += m.false_positives
        row["gt"] += m.total_ground_truth
        row["shots_correct"] += result.screenshots_correct
        row["shots_matched"] += result.screenshots_matched
        row["seconds"] = round(row["seconds"] + result.seconds, 2)
        if result.opening_ok is not None:
            row["opening_checked"] += 1
            row["opening_ok"] += int(result.opening_ok)
    for row in summary.values():
        precision = row["tp"] / max(1, row["tp"] + row["fp"])
        recall = row["tp"] / max(1, row["gt"])
        row["precision"] = round(precision, 3)
        row["recall"] = round(recall, 3)
        row["f1"] = round(2 * precision * recall / max(1e-9, precision + recall), 3)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", default="hybrid_v2", choices=("hybrid_v2", "stable_v3"))
    parser.add_argument("--set", default="baseline", choices=tuple(SCENARIO_SETS), help="scenario set")
    parser.add_argument("--preset", default="balanced", choices=("subtle_ui", "balanced", "noise_resistant"))
    parser.add_argument("--no-ingest", action="store_true", help="detect on the upload itself (pre-ingest behaviour)")
    parser.add_argument("--only", default="", help="comma-separated scenario names")
    parser.add_argument("--variants", default="", help="comma-separated variant labels, e.g. h264_vfr,h264_vfr+clock")
    parser.add_argument("--json", default="", help="write the per-variant summary to this file")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        results = run_matrix(
            preset=args.preset,
            ingest=not args.no_ingest,
            scenarios={name for name in args.only.split(",") if name} or None,
            variants={name for name in args.variants.split(",") if name} or None,
            work_dir=Path(tmp),
            echo=True,
            engine=args.engine,
            scenario_set=args.set,
        )
    summary = summarise(results)
    pipeline = "upload only" if args.no_ingest else "working copy"
    setting = f"preset={args.preset}" if args.engine == "hybrid_v2" else "recording type by variant"
    print(f"\n{'variant':18s}  P     R     F1    screenshots   opening  labels  time   ({args.engine}, {setting}, {pipeline})")
    for variant, row in summary.items():
        share = row["shots_correct"] / max(1, row["shots_matched"])
        opening = f"{row['opening_ok']}/{row['opening_checked']}" if row["opening_checked"] else "-"
        print(
            f"{variant:18s} {row['precision']:.2f}  {row['recall']:.2f}  {row['f1']:.2f}   "
            f"{row['shots_correct']}/{row['shots_matched']} ({share:.0%})   {opening:7s}  "
            f"{row['labels_agree'] / max(1, row['labels_checked']):.0%}    {row['seconds']:.0f}s"
        )
    if args.json:
        Path(args.json).write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    sys.exit(main())
