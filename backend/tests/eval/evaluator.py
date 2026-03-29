"""Evaluate engine output candidates against ground truth events.

The evaluator uses greedy closest-match to pair engine candidates with ground
truth events and computes precision, recall, F1, timing error, and per-category
breakdowns.

Matching rules:
    - A candidate matches a ground truth event if its ``timestamp_ms`` falls
      within ``[start_ms - tolerance_ms, end_ms + tolerance_ms]``.
    - Each candidate and ground truth event can match at most once.
    - Ground truth events are processed chronologically; each picks the
      closest available candidate.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from .types import EvalMetrics, EventMatchResult, GroundTruthEvent


def evaluate(
    candidates: list[dict[str, Any]],
    ground_truth: list[GroundTruthEvent],
    *,
    tolerance_ms: int = 500,
) -> EvalMetrics:
    """Compare engine candidates against ground truth."""
    candidate_timestamps = sorted(
        [(i, int(c["timestamp_ms"])) for i, c in enumerate(candidates)],
        key=lambda pair: pair[1],
    )
    gt_sorted = sorted(ground_truth, key=lambda e: e.start_ms)
    used_candidates: set[int] = set()
    per_event: list[EventMatchResult] = []

    for gt_event in gt_sorted:
        window_start = gt_event.start_ms - tolerance_ms
        window_end = gt_event.end_ms + tolerance_ms
        best_idx: int | None = None
        best_ts: int | None = None
        best_distance = float("inf")

        for cand_idx, cand_ts in candidate_timestamps:
            if cand_idx in used_candidates:
                continue
            if window_start <= cand_ts <= window_end:
                gt_midpoint = (gt_event.start_ms + gt_event.end_ms) // 2
                distance = abs(cand_ts - gt_midpoint)
                if distance < best_distance:
                    best_distance = distance
                    best_idx = cand_idx
                    best_ts = cand_ts

        if best_idx is not None:
            used_candidates.add(best_idx)
            gt_midpoint = (gt_event.start_ms + gt_event.end_ms) // 2
            timing_error = abs(best_ts - gt_midpoint)
            per_event.append(
                EventMatchResult(
                    ground_truth=gt_event,
                    matched_candidate_index=best_idx,
                    matched_candidate_timestamp_ms=best_ts,
                    timing_error_ms=timing_error,
                )
            )
        else:
            per_event.append(EventMatchResult(ground_truth=gt_event))

    tp = sum(1 for r in per_event if r.matched_candidate_index is not None)
    missed = sum(1 for r in per_event if r.matched_candidate_index is None)
    fp = len(candidates) - len(used_candidates)

    precision = tp / max(1, tp + fp)
    recall = tp / max(1, len(gt_sorted))
    f1 = (2 * precision * recall / max(1e-9, precision + recall)) if (precision + recall) > 0 else 0.0

    timing_errors = [r.timing_error_ms for r in per_event if r.timing_error_ms is not None]
    mean_timing = sum(timing_errors) / max(1, len(timing_errors)) if timing_errors else 0.0

    return EvalMetrics(
        precision=round(precision, 4),
        recall=round(recall, 4),
        f1=round(f1, 4),
        mean_timing_error_ms=round(mean_timing, 1),
        false_positives=fp,
        missed_events=missed,
        total_ground_truth=len(gt_sorted),
        total_candidates=len(candidates),
        per_event_results=per_event,
    )


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def metrics_to_dict(metrics: EvalMetrics) -> dict[str, Any]:
    """Serialize EvalMetrics to a JSON-compatible dict."""
    return {
        "precision": metrics.precision,
        "recall": metrics.recall,
        "f1": metrics.f1,
        "mean_timing_error_ms": metrics.mean_timing_error_ms,
        "false_positives": metrics.false_positives,
        "missed_events": metrics.missed_events,
        "total_ground_truth": metrics.total_ground_truth,
        "total_candidates": metrics.total_candidates,
        "per_event_results": [
            {
                "event_type": r.ground_truth.event_type,
                "difficulty": r.ground_truth.difficulty,
                "gt_start_ms": r.ground_truth.start_ms,
                "gt_end_ms": r.ground_truth.end_ms,
                "matched": r.matched_candidate_index is not None,
                "candidate_index": r.matched_candidate_index,
                "candidate_timestamp_ms": r.matched_candidate_timestamp_ms,
                "timing_error_ms": r.timing_error_ms,
            }
            for r in metrics.per_event_results
        ],
    }


def compare_runs(baseline: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Compute deltas between two serialized metric dicts."""
    deltas: dict[str, Any] = {}
    for key in ("precision", "recall", "f1", "mean_timing_error_ms", "false_positives", "missed_events"):
        b_val = baseline.get(key, 0)
        c_val = current.get(key, 0)
        if isinstance(b_val, (int, float)) and isinstance(c_val, (int, float)):
            deltas[key] = {"baseline": b_val, "current": c_val, "delta": round(c_val - b_val, 4)}
    return deltas


# ---------------------------------------------------------------------------
# Per-category / per-difficulty breakdown
# ---------------------------------------------------------------------------


def category_breakdown(metrics: EvalMetrics) -> dict[str, dict[str, Any]]:
    """Break down metrics by ground truth event_type."""
    by_type: dict[str, list[EventMatchResult]] = defaultdict(list)
    for r in metrics.per_event_results:
        by_type[r.ground_truth.event_type].append(r)

    result: dict[str, dict[str, Any]] = {}
    for event_type, results in sorted(by_type.items()):
        tp = sum(1 for r in results if r.matched_candidate_index is not None)
        total = len(results)
        missed = total - tp
        timing_errors = [r.timing_error_ms for r in results if r.timing_error_ms is not None]
        result[event_type] = {
            "total": total,
            "matched": tp,
            "missed": missed,
            "recall": round(tp / max(1, total), 4),
            "mean_timing_error_ms": round(sum(timing_errors) / max(1, len(timing_errors)), 1) if timing_errors else 0.0,
        }
    return result


def difficulty_breakdown(metrics: EvalMetrics) -> dict[str, dict[str, Any]]:
    """Break down metrics by ground truth difficulty level."""
    by_diff: dict[str, list[EventMatchResult]] = defaultdict(list)
    for r in metrics.per_event_results:
        by_diff[r.ground_truth.difficulty].append(r)

    result: dict[str, dict[str, Any]] = {}
    for diff, results in sorted(by_diff.items()):
        tp = sum(1 for r in results if r.matched_candidate_index is not None)
        total = len(results)
        result[diff] = {
            "total": total,
            "matched": tp,
            "recall": round(tp / max(1, total), 4),
        }
    return result


# ---------------------------------------------------------------------------
# Debug dump
# ---------------------------------------------------------------------------


def format_debug_report(
    scenario_name: str,
    metrics: EvalMetrics,
    candidates: list[dict[str, Any]],
) -> str:
    """Build a human-readable debug report for a single scenario."""
    lines: list[str] = []
    lines.append(f"=== {scenario_name} ===")
    lines.append(f"  P={metrics.precision:.2f}  R={metrics.recall:.2f}  F1={metrics.f1:.2f}")
    lines.append(f"  candidates={metrics.total_candidates}  gt={metrics.total_ground_truth}  "
                 f"missed={metrics.missed_events}  fp={metrics.false_positives}")
    lines.append("")

    # Ground truth matching detail
    lines.append("  Ground truth events:")
    for r in metrics.per_event_results:
        gt = r.ground_truth
        status = "HIT" if r.matched_candidate_index is not None else "MISS"
        timing = f"  err={r.timing_error_ms}ms" if r.timing_error_ms is not None else ""
        cand_info = f"  -> cand[{r.matched_candidate_index}] @{r.matched_candidate_timestamp_ms}ms" if r.matched_candidate_index is not None else ""
        lines.append(
            f"    [{status}] {gt.event_type} ({gt.difficulty}) "
            f"@{gt.start_ms}-{gt.end_ms}ms{cand_info}{timing}"
        )

    # Candidate detail
    lines.append("")
    lines.append("  Engine candidates:")
    matched_indices = {r.matched_candidate_index for r in metrics.per_event_results if r.matched_candidate_index is not None}
    for i, c in enumerate(candidates):
        status = "matched" if i in matched_indices else "unmatched (FP)"
        score = c.get("scene_score", 0)
        breakdown = c.get("score_breakdown", {}) or {}
        vis = breakdown.get("visual", 0)
        mot = breakdown.get("motion", 0)
        txt = breakdown.get("text", 0)
        lines.append(
            f"    [{i}] @{c['timestamp_ms']}ms  score={score:.3f}  "
            f"V={vis:.3f} M={mot:.3f} T={txt:.3f}  ({status})"
        )

    lines.append("")
    return "\n".join(lines)
