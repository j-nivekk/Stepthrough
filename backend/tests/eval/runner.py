"""Standalone eval runner for the hybrid v2 detection engine.

Usage::

    cd backend
    python -m tests.eval.runner                         # run all scenarios
    python -m tests.eval.runner --scenario nav          # filter by name
    python -m tests.eval.runner --category scrolling    # filter by category
    python -m tests.eval.runner --preset subtle_ui      # change analysis preset
    python -m tests.eval.runner --compare               # compare last two runs
    python -m tests.eval.runner --debug                 # detailed per-candidate output
    python -m tests.eval.runner --report                # generate HTML report with visuals
    python -m tests.eval.runner --save-videos           # persist generated videos

Results are saved to ``tests/eval/results/`` as timestamped JSON files.
Use ``--compare`` to see deltas between the two most recent runs.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from app.models import HybridAdvancedSettings, RunSettings
from app.services.hybrid_detection import detect_candidates_hybrid

from .evaluator import (
    category_breakdown,
    compare_runs,
    difficulty_breakdown,
    evaluate,
    format_debug_report,
    metrics_to_dict,
)
from .rendering import DEFAULT_FPS
from .scenarios import all_scenarios
from .types import ScenarioResult
from .visualize import (
    generate_html_report,
    render_annotated_video,
    render_filmstrip,
    render_timeline,
)

RESULTS_DIR = Path(__file__).parent / "results"
DEMOS_DIR = RESULTS_DIR / "demos"


def _run_detection(
    scenario_result: ScenarioResult,
    tmp_dir: Path,
    *,
    preset: str = "balanced",
    enable_ocr: bool = False,
) -> list[dict]:
    """Run hybrid detection on a generated eval video."""
    frames_dir = tmp_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    settings = RunSettings(
        analysis_engine="hybrid_v2",
        analysis_preset=preset,
        advanced=HybridAdvancedSettings(enable_ocr=enable_ocr),
        min_scene_gap_ms=900,
    )

    return detect_candidates_hybrid(
        video_path=scenario_result.video_path,
        frames_dir=frames_dir,
        duration_ms=scenario_result.duration_ms,
        fps=scenario_result.fps,
        settings=settings,
    )


def run_eval(
    *,
    scenario_filter: str | None = None,
    category_filter: str | None = None,
    fps: float = DEFAULT_FPS,
    preset: str = "balanced",
    enable_ocr: bool = False,
    save: bool = True,
    debug: bool = False,
    report: bool = False,
    save_videos: bool = False,
) -> dict:
    """Run all (or filtered) scenarios and return results dict."""
    scenarios = all_scenarios()
    if scenario_filter:
        scenarios = [(n, f) for n, f in scenarios if scenario_filter in n]
    if category_filter:
        scenarios = [(n, f) for n, f in scenarios if n.startswith(category_filter)]
    if not scenarios:
        print(f"No scenarios matched the filter.")
        sys.exit(1)

    all_results: dict[str, dict] = {}
    debug_lines: list[str] = []
    summary_lines: list[str] = []
    report_entries: list[dict] = []

    # Set up persistent directories for videos/report
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    if save_videos or report:
        run_demos_dir = DEMOS_DIR / f"run_{ts}"
        videos_dir = run_demos_dir / "videos"
        videos_dir.mkdir(parents=True, exist_ok=True)
    else:
        run_demos_dir = None
        videos_dir = None

    with tempfile.TemporaryDirectory(prefix="stepthrough_eval_") as tmpdir:
        tmp_path = Path(tmpdir)

        for name, factory in scenarios:
            scenario_dir = tmp_path / name
            scenario_dir.mkdir(parents=True, exist_ok=True)

            print(f"  [{name}] generating...", end=" ", flush=True)
            t0 = time.monotonic()
            scenario_result = factory(scenario_dir, fps)
            gen_time = time.monotonic() - t0

            print(f"({gen_time:.1f}s) detecting...", end=" ", flush=True)
            t1 = time.monotonic()
            candidates = _run_detection(scenario_result, scenario_dir, preset=preset, enable_ocr=enable_ocr)
            detect_time = time.monotonic() - t1

            metrics = evaluate(candidates, scenario_result.ground_truth)
            metrics_dict = metrics_to_dict(metrics)
            metrics_dict["timings"] = {"generation_s": round(gen_time, 2), "detection_s": round(detect_time, 2)}
            metrics_dict["description"] = scenario_result.description
            metrics_dict["category"] = scenario_result.category
            metrics_dict["difficulty"] = scenario_result.difficulty
            metrics_dict["by_event_type"] = category_breakdown(metrics)
            metrics_dict["by_difficulty"] = difficulty_breakdown(metrics)
            all_results[name] = metrics_dict

            status = "PASS" if metrics.recall >= 0.5 else "FAIL"
            line = (
                f"  [{name:<30}] {status}  "
                f"P={metrics.precision:.2f} R={metrics.recall:.2f} F1={metrics.f1:.2f}  "
                f"cand={metrics.total_candidates} gt={metrics.total_ground_truth}  "
                f"miss={metrics.missed_events} fp={metrics.false_positives}  "
                f"err={metrics.mean_timing_error_ms:.0f}ms  "
                f"[{scenario_result.difficulty}]"
            )
            summary_lines.append(line)

            if debug:
                debug_lines.append(format_debug_report(name, metrics, candidates))

            # Visualization: save videos and build report data
            if save_videos and videos_dir:
                import shutil
                dest = videos_dir / f"{name}.avi"
                shutil.copy2(scenario_result.video_path, dest)

            if report or save_videos:
                timeline_img = render_timeline(scenario_result, metrics, candidates)
                filmstrip_img = render_filmstrip(scenario_result, metrics, candidates)
                annotated_path = None
                if save_videos and videos_dir:
                    annotated_path = videos_dir / f"{name}_annotated.avi"
                    render_annotated_video(scenario_result, metrics, candidates, annotated_path)

                report_entries.append({
                    "name": name,
                    "scenario_result": scenario_result,
                    "metrics": metrics,
                    "candidates": candidates,
                    "timeline_img": timeline_img,
                    "filmstrip_img": filmstrip_img,
                    "annotated_video_path": str(annotated_path) if annotated_path else None,
                })

            print(f"({detect_time:.1f}s) done")

    # Summary
    print()
    print("=" * 100)
    print(f"EVAL RESULTS — preset={preset}, ocr={'on' if enable_ocr else 'off'}, {len(scenarios)} scenarios")
    print("=" * 100)
    for line in summary_lines:
        print(line)
    print("-" * 100)

    # Aggregate
    total_gt = sum(r["total_ground_truth"] for r in all_results.values())
    total_missed = sum(r["missed_events"] for r in all_results.values())
    total_fp = sum(r["false_positives"] for r in all_results.values())
    total_tp = total_gt - total_missed
    agg_p = total_tp / max(1, total_tp + total_fp)
    agg_r = total_tp / max(1, total_gt)
    agg_f1 = (2 * agg_p * agg_r / max(1e-9, agg_p + agg_r)) if (agg_p + agg_r) > 0 else 0.0

    print(f"  AGGREGATE: P={agg_p:.2f} R={agg_r:.2f} F1={agg_f1:.2f}  TP={total_tp} missed={total_missed} FP={total_fp}")

    # Per-difficulty aggregate
    for diff in ("easy", "medium", "hard"):
        diff_gt = sum(
            sum(1 for e in r["per_event_results"] if e.get("difficulty") == diff)
            for r in all_results.values()
        )
        diff_hits = sum(
            sum(1 for e in r["per_event_results"] if e.get("difficulty") == diff and e.get("matched"))
            for r in all_results.values()
        )
        if diff_gt > 0:
            print(f"    {diff:>6}: {diff_hits}/{diff_gt} detected ({diff_hits / diff_gt:.0%})")

    print("=" * 100)

    if debug and debug_lines:
        print("\nDETAILED DEBUG OUTPUT")
        print("=" * 100)
        for block in debug_lines:
            print(block)

    output = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "config": {"preset": preset, "enable_ocr": enable_ocr, "fps": fps},
        "scenarios": all_results,
        "aggregate": {
            "precision": round(agg_p, 4),
            "recall": round(agg_r, 4),
            "f1": round(agg_f1, 4),
            "true_positives": total_tp,
            "missed_events": total_missed,
            "false_positives": total_fp,
        },
    }

    if save:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        results_file = RESULTS_DIR / f"eval_{ts}.json"
        results_file.write_text(json.dumps(output, indent=2))
        print(f"\n  Results saved to {results_file}")

    if report and report_entries and run_demos_dir:
        report_path = run_demos_dir / "report.html"
        generate_html_report(report_entries, report_path, aggregate=output["aggregate"])
        print(f"  HTML report saved to {report_path}")

    if save_videos and run_demos_dir:
        print(f"  Demo videos saved to {run_demos_dir / 'videos'}")

    return output


def run_comparison() -> None:
    """Compare the two most recent eval runs."""
    if not RESULTS_DIR.exists():
        print("No results directory found. Run eval first.")
        return
    files = sorted(RESULTS_DIR.glob("eval_*.json"), reverse=True)
    if len(files) < 2:
        print(f"Need at least 2 result files to compare, found {len(files)}.")
        return

    current = json.loads(files[0].read_text())
    baseline = json.loads(files[1].read_text())

    print(f"Comparing:")
    print(f"  Baseline: {files[1].name} ({baseline.get('timestamp', '?')})")
    print(f"  Current:  {files[0].name} ({current.get('timestamp', '?')})")
    print()

    if "aggregate" in baseline and "aggregate" in current:
        deltas = compare_runs(baseline["aggregate"], current["aggregate"])
        print("AGGREGATE DELTAS:")
        for key, vals in deltas.items():
            delta = vals["delta"]
            direction = "+" if delta > 0 else ""
            indicator = ""
            if key in ("precision", "recall", "f1") and delta > 0:
                indicator = " improved"
            elif key in ("precision", "recall", "f1") and delta < 0:
                indicator = " regressed"
            elif key in ("false_positives", "missed_events") and delta < 0:
                indicator = " improved"
            elif key in ("false_positives", "missed_events") and delta > 0:
                indicator = " regressed"
            print(f"  {key}: {vals['baseline']} -> {vals['current']} ({direction}{delta}){indicator}")

    print()
    print("PER-SCENARIO:")
    all_names = sorted(set(list(baseline.get("scenarios", {}).keys()) + list(current.get("scenarios", {}).keys())))
    for name in all_names:
        b = baseline.get("scenarios", {}).get(name)
        c = current.get("scenarios", {}).get(name)
        if b and c:
            f1_b, f1_c = b["f1"], c["f1"]
            delta = round(f1_c - f1_b, 4)
            direction = "+" if delta > 0 else ""
            diff = c.get("difficulty", "?")
            print(f"  {name:<30} F1 {f1_b:.2f} -> {f1_c:.2f} ({direction}{delta})  [{diff}]")
        elif c and not b:
            print(f"  {name:<30} NEW (F1={c['f1']:.2f})")
        elif b and not c:
            print(f"  {name:<30} REMOVED")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stepthrough Hybrid v2 Eval Pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m tests.eval.runner                           Run all scenarios
  python -m tests.eval.runner --scenario scroll         Filter by name
  python -m tests.eval.runner --category feed           Filter by category
  python -m tests.eval.runner --preset subtle_ui        Use different preset
  python -m tests.eval.runner --debug                   Show per-candidate detail
  python -m tests.eval.runner --report                  Generate HTML report with visuals
  python -m tests.eval.runner --save-videos             Persist demo + annotated videos
  python -m tests.eval.runner --report --save-videos    Full visual report with videos
  python -m tests.eval.runner --compare                 Compare last two runs
""",
    )
    parser.add_argument("--scenario", type=str, default=None, help="Filter scenarios by name substring")
    parser.add_argument("--category", type=str, default=None, help="Filter by category prefix (nav, scroll, feed, overlay, content, composite)")
    parser.add_argument("--preset", type=str, default="balanced", choices=["subtle_ui", "balanced", "noise_resistant"],
                        help="Analysis preset (default: balanced)")
    parser.add_argument("--ocr", action="store_true", help="Enable OCR during detection")
    parser.add_argument("--compare", action="store_true", help="Compare two most recent runs")
    parser.add_argument("--debug", action="store_true", help="Print detailed per-candidate debug output")
    parser.add_argument("--no-save", action="store_true", help="Do not save results to disk")
    parser.add_argument("--report", action="store_true", help="Generate HTML report with timeline and filmstrip visuals")
    parser.add_argument("--save-videos", action="store_true", help="Persist generated and annotated videos to results/demos/")
    parser.add_argument("--fps", type=float, default=DEFAULT_FPS, help="FPS for generated videos")
    args = parser.parse_args()

    if args.compare:
        run_comparison()
    else:
        print("Stepthrough Hybrid v2 Eval Pipeline")
        print("-" * 50)
        run_eval(
            scenario_filter=args.scenario,
            category_filter=args.category,
            fps=args.fps,
            preset=args.preset,
            enable_ocr=args.ocr,
            save=not args.no_save,
            debug=args.debug,
            report=args.report,
            save_videos=args.save_videos,
        )


if __name__ == "__main__":
    main()
