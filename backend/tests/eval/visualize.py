"""Eval visualization pipeline.

Generates per-scenario visual reports:
  - **Timeline image**: horizontal bar showing ground truth events and detected
    candidates, with hit/miss/FP annotations.
  - **Filmstrip**: key frames extracted at ground truth and candidate timestamps.
  - **Annotated video**: original video with a timeline overlay bar at the bottom
    showing events in real time.
  - **HTML report**: single-page summary of all scenarios with embedded images.
"""

from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .types import EvalMetrics, EventMatchResult, GroundTruthEvent, ScenarioResult

# ---------------------------------------------------------------------------
# Colors (BGR)
# ---------------------------------------------------------------------------

_HIT_COLOR = (80, 175, 76)       # green
_MISS_COLOR = (68, 68, 244)      # red
_FP_COLOR = (0, 165, 255)        # orange
_GT_BAR_COLOR = (219, 152, 33)   # blue
_CAND_MARKER = (0, 200, 255)     # yellow
_BG = (255, 255, 255)
_DARK_TEXT = (30, 30, 30)
_LIGHT_TEXT = (160, 160, 160)
_GRID_COLOR = (230, 230, 230)
_TIMELINE_BG = (245, 245, 245)


# ---------------------------------------------------------------------------
# Timeline image
# ---------------------------------------------------------------------------

def render_timeline(
    scenario_result: ScenarioResult,
    metrics: EvalMetrics,
    candidates: list[dict[str, Any]],
    *,
    width: int = 800,
    height: int = 200,
) -> np.ndarray:
    """Render a timeline image showing ground truth events vs detected candidates.

    Layout (top to bottom):
      - Title and summary text
      - Ground truth event bars (colored by hit/miss)
      - Candidate markers (triangles, colored by matched/FP)
      - Time axis with tick marks
    """
    img = np.full((height, width, 3), 255, dtype=np.uint8)
    duration_ms = max(1, scenario_result.duration_ms)
    margin_left = 80
    margin_right = 20
    track_width = width - margin_left - margin_right

    def ms_to_x(ms: int) -> int:
        return margin_left + round((ms / duration_ms) * track_width)

    # Title
    cv2.putText(img, "Ground Truth", (8, 64), cv2.FONT_HERSHEY_SIMPLEX, 0.35, _DARK_TEXT, 1, cv2.LINE_AA)
    cv2.putText(img, "Candidates", (8, 108), cv2.FONT_HERSHEY_SIMPLEX, 0.35, _DARK_TEXT, 1, cv2.LINE_AA)

    # Ground truth track background
    gt_y = 50
    gt_h = 24
    cv2.rectangle(img, (margin_left, gt_y), (margin_left + track_width, gt_y + gt_h), _TIMELINE_BG, -1)

    # Matched indices
    matched_cand_indices = {r.matched_candidate_index for r in metrics.per_event_results if r.matched_candidate_index is not None}

    # Draw ground truth events
    for r in metrics.per_event_results:
        gt = r.ground_truth
        x1 = ms_to_x(gt.start_ms)
        x2 = max(x1 + 4, ms_to_x(gt.end_ms))
        color = _HIT_COLOR if r.matched_candidate_index is not None else _MISS_COLOR
        cv2.rectangle(img, (x1, gt_y + 2), (x2, gt_y + gt_h - 2), color, -1)
        # Label
        label = gt.event_type[:8]
        cv2.putText(img, label, (x1, gt_y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.28, color, 1, cv2.LINE_AA)

    # Candidate track background
    cand_y = 94
    cand_h = 24
    cv2.rectangle(img, (margin_left, cand_y), (margin_left + track_width, cand_y + cand_h), _TIMELINE_BG, -1)

    # Draw candidate markers
    for i, c in enumerate(candidates):
        x = ms_to_x(int(c["timestamp_ms"]))
        color = _HIT_COLOR if i in matched_cand_indices else _FP_COLOR
        # Triangle marker
        pts = np.array([[x, cand_y + 2], [x - 5, cand_y + cand_h - 2], [x + 5, cand_y + cand_h - 2]], np.int32)
        cv2.fillPoly(img, [pts], color)
        # Score label
        score = c.get("scene_score", 0)
        cv2.putText(img, f"{score:.2f}", (x - 10, cand_y + cand_h + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.25, _DARK_TEXT, 1, cv2.LINE_AA)

    # Time axis
    axis_y = 140
    cv2.line(img, (margin_left, axis_y), (margin_left + track_width, axis_y), _GRID_COLOR, 1)
    # Tick marks every 500ms or 1000ms
    tick_interval = 1000 if duration_ms > 5000 else 500
    t = 0
    while t <= duration_ms:
        x = ms_to_x(t)
        cv2.line(img, (x, axis_y - 4), (x, axis_y + 4), _LIGHT_TEXT, 1)
        label = f"{t / 1000:.1f}s"
        cv2.putText(img, label, (x - 12, axis_y + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.28, _LIGHT_TEXT, 1, cv2.LINE_AA)
        t += tick_interval

    # Summary text
    summary = f"P={metrics.precision:.2f}  R={metrics.recall:.2f}  F1={metrics.f1:.2f}  " \
              f"miss={metrics.missed_events}  fp={metrics.false_positives}"
    cv2.putText(img, summary, (margin_left, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.35, _DARK_TEXT, 1, cv2.LINE_AA)

    # Legend
    legend_y = height - 20
    cv2.rectangle(img, (margin_left, legend_y - 8), (margin_left + 10, legend_y), _HIT_COLOR, -1)
    cv2.putText(img, "Hit", (margin_left + 14, legend_y), cv2.FONT_HERSHEY_SIMPLEX, 0.28, _DARK_TEXT, 1, cv2.LINE_AA)
    cv2.rectangle(img, (margin_left + 50, legend_y - 8), (margin_left + 60, legend_y), _MISS_COLOR, -1)
    cv2.putText(img, "Miss", (margin_left + 64, legend_y), cv2.FONT_HERSHEY_SIMPLEX, 0.28, _DARK_TEXT, 1, cv2.LINE_AA)
    cv2.rectangle(img, (margin_left + 110, legend_y - 8), (margin_left + 120, legend_y), _FP_COLOR, -1)
    cv2.putText(img, "FP", (margin_left + 124, legend_y), cv2.FONT_HERSHEY_SIMPLEX, 0.28, _DARK_TEXT, 1, cv2.LINE_AA)

    difficulty = scenario_result.difficulty
    cv2.putText(img, f"[{difficulty}]", (width - 60, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.35, _LIGHT_TEXT, 1, cv2.LINE_AA)

    return img


# ---------------------------------------------------------------------------
# Filmstrip
# ---------------------------------------------------------------------------

def render_filmstrip(
    scenario_result: ScenarioResult,
    metrics: EvalMetrics,
    candidates: list[dict[str, Any]],
    *,
    thumb_width: int = 160,
    thumb_height: int = 90,
    max_frames: int = 10,
) -> np.ndarray | None:
    """Extract key frames at ground truth and candidate timestamps, render as filmstrip.

    Returns a horizontal strip of thumbnails with timestamp and status labels,
    or None if the video cannot be opened.
    """
    cap = cv2.VideoCapture(str(scenario_result.video_path))
    if not cap.isOpened():
        return None

    # Collect timestamps to extract
    timestamps: list[tuple[int, str, tuple[int, ...]]] = []  # (ms, label, color)

    matched_cand_indices = {r.matched_candidate_index for r in metrics.per_event_results if r.matched_candidate_index is not None}

    for r in metrics.per_event_results:
        gt = r.ground_truth
        color = _HIT_COLOR if r.matched_candidate_index is not None else _MISS_COLOR
        status = "HIT" if r.matched_candidate_index is not None else "MISS"
        timestamps.append((gt.start_ms, f"GT:{gt.event_type[:6]} [{status}]", color))

    for i, c in enumerate(candidates):
        if i not in matched_cand_indices:
            timestamps.append((int(c["timestamp_ms"]), "FP", _FP_COLOR))

    # Sort and limit
    timestamps.sort(key=lambda t: t[0])
    timestamps = timestamps[:max_frames]

    if not timestamps:
        cap.release()
        return None

    # Extract frames
    label_height = 32
    frame_h = thumb_height + label_height
    strip_w = len(timestamps) * (thumb_width + 4) + 4
    strip = np.full((frame_h, strip_w, 3), 255, dtype=np.uint8)

    for idx, (ts_ms, label, color) in enumerate(timestamps):
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts_ms))
        success, frame = cap.read()
        if not success:
            continue

        thumb = cv2.resize(frame, (thumb_width, thumb_height))
        x = 4 + idx * (thumb_width + 4)

        # Draw border in status color
        cv2.rectangle(strip, (x - 1, 0), (x + thumb_width, thumb_height + 1), color, 2)
        strip[1:thumb_height + 1, x:x + thumb_width] = thumb

        # Label below
        time_str = f"{ts_ms / 1000:.1f}s"
        cv2.putText(strip, time_str, (x + 2, thumb_height + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.3, _DARK_TEXT, 1, cv2.LINE_AA)
        cv2.putText(strip, label, (x + 2, thumb_height + 26), cv2.FONT_HERSHEY_SIMPLEX, 0.25, color, 1, cv2.LINE_AA)

    cap.release()
    return strip


# ---------------------------------------------------------------------------
# Annotated video
# ---------------------------------------------------------------------------

def render_annotated_video(
    scenario_result: ScenarioResult,
    metrics: EvalMetrics,
    candidates: list[dict[str, Any]],
    output_path: Path,
    *,
    overlay_height: int = 40,
) -> Path | None:
    """Re-encode the video with a timeline overlay bar at the bottom.

    The overlay shows:
      - Ground truth event spans as colored bars (green=hit, red=miss)
      - Candidate timestamps as yellow triangles
      - Current time indicator (white vertical line)

    Returns the output path, or None on failure.
    """
    cap = cv2.VideoCapture(str(scenario_result.video_path))
    if not cap.isOpened():
        return None

    fps = cap.get(cv2.CAP_PROP_FPS) or scenario_result.fps
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_h = frame_h + overlay_height
    duration_ms = max(1, scenario_result.duration_ms)

    fourcc = cv2.VideoWriter_fourcc(*"MJPG")
    writer = cv2.VideoWriter(str(output_path), fourcc, fps, (frame_w, total_h))
    if not writer.isOpened():
        cap.release()
        return None

    matched_cand_indices = {r.matched_candidate_index for r in metrics.per_event_results if r.matched_candidate_index is not None}

    # Pre-build the static overlay (without playhead)
    def build_overlay(current_ms: int) -> np.ndarray:
        overlay = np.full((overlay_height, frame_w, 3), 40, dtype=np.uint8)

        def ms_to_x(ms: int) -> int:
            return round((ms / duration_ms) * frame_w)

        # Ground truth bars
        for r in metrics.per_event_results:
            gt = r.ground_truth
            x1 = ms_to_x(gt.start_ms)
            x2 = max(x1 + 3, ms_to_x(gt.end_ms))
            color = _HIT_COLOR if r.matched_candidate_index is not None else _MISS_COLOR
            cv2.rectangle(overlay, (x1, 4), (x2, overlay_height // 2 - 2), color, -1)

        # Candidate markers
        for i, c in enumerate(candidates):
            x = ms_to_x(int(c["timestamp_ms"]))
            color = _HIT_COLOR if i in matched_cand_indices else _FP_COLOR
            cv2.line(overlay, (x, overlay_height // 2), (x, overlay_height - 4), color, 2)
            cv2.circle(overlay, (x, overlay_height - 4), 3, color, -1)

        # Playhead
        px = ms_to_x(current_ms)
        cv2.line(overlay, (px, 0), (px, overlay_height), (255, 255, 255), 1)

        return overlay

    frame_idx = 0
    while True:
        success, frame = cap.read()
        if not success:
            break
        current_ms = round((frame_idx / max(1, fps)) * 1000)
        overlay = build_overlay(current_ms)
        combined = np.vstack([frame, overlay])
        writer.write(combined)
        frame_idx += 1

    cap.release()
    writer.release()
    return output_path


# ---------------------------------------------------------------------------
# HTML report
# ---------------------------------------------------------------------------

def _img_to_data_uri(img: np.ndarray) -> str:
    """Encode a BGR numpy image as a base64 PNG data URI."""
    success, buf = cv2.imencode(".png", img)
    if not success:
        return ""
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def generate_html_report(
    results: list[dict[str, Any]],
    output_path: Path,
    *,
    aggregate: dict[str, Any] | None = None,
) -> Path:
    """Generate a single-page HTML report with embedded timeline and filmstrip images.

    Args:
        results: List of dicts, each with keys:
            name, scenario_result, metrics, candidates, timeline_img, filmstrip_img
        output_path: Where to write the HTML file.
        aggregate: Optional aggregate metrics dict.
    """
    html_parts: list[str] = []
    html_parts.append(_HTML_HEAD)

    # Aggregate summary
    if aggregate:
        html_parts.append(f"""
        <div class="aggregate">
            <h2>Aggregate Results</h2>
            <div class="metrics-row">
                <div class="metric">
                    <span class="metric-value">{aggregate.get('precision', 0):.2f}</span>
                    <span class="metric-label">Precision</span>
                </div>
                <div class="metric">
                    <span class="metric-value">{aggregate.get('recall', 0):.2f}</span>
                    <span class="metric-label">Recall</span>
                </div>
                <div class="metric">
                    <span class="metric-value">{aggregate.get('f1', 0):.2f}</span>
                    <span class="metric-label">F1</span>
                </div>
                <div class="metric">
                    <span class="metric-value">{aggregate.get('true_positives', 0)}</span>
                    <span class="metric-label">TP</span>
                </div>
                <div class="metric">
                    <span class="metric-value">{aggregate.get('missed_events', 0)}</span>
                    <span class="metric-label">Missed</span>
                </div>
                <div class="metric">
                    <span class="metric-value">{aggregate.get('false_positives', 0)}</span>
                    <span class="metric-label">FP</span>
                </div>
            </div>
        </div>
        """)
        for dimension, groups in (aggregate.get("dimensions") or {}).items():
            html_parts.append(f"""
            <div class="aggregate aggregate-dimension">
                <h2>{dimension.replace('_', ' ').title()}</h2>
                <table class="dimension-table">
                    <thead><tr><th>Bucket</th><th>Count</th><th>Mean P</th><th>Mean R</th><th>Mean F1</th></tr></thead>
                    <tbody>
            """)
            for bucket, values in groups.items():
                html_parts.append(
                    f"<tr><td>{bucket}</td><td>{values.get('count', 0)}</td>"
                    f"<td>{values.get('mean_precision', 0):.2f}</td>"
                    f"<td>{values.get('mean_recall', 0):.2f}</td>"
                    f"<td>{values.get('mean_f1', 0):.2f}</td></tr>"
                )
            html_parts.append("</tbody></table></div>")

    # Per-scenario sections
    for entry in results:
        name = entry["name"]
        sr: ScenarioResult = entry["scenario_result"]
        metrics: EvalMetrics = entry["metrics"]
        timeline_img = entry.get("timeline_img")
        filmstrip_img = entry.get("filmstrip_img")
        annotated_video_path = entry.get("annotated_video_path")

        status_class = "pass" if metrics.recall >= 0.5 else "fail"
        status_label = "PASS" if metrics.recall >= 0.5 else "FAIL"
        encoded_size = f"{sr.encoded_width}x{sr.encoded_height}"
        logical_size = f"{sr.logical_width}x{sr.logical_height}"
        sample_label = "default" if sr.sample_fps is None else sr.sample_fps

        html_parts.append(f"""
        <div class="scenario">
            <div class="scenario-header">
                <div class="scenario-title">
                    {name}
                    <span class="badge {status_class}">{status_label}</span>
                    <span class="badge difficulty">{sr.difficulty}</span>
                    <span class="badge category">{sr.category}</span>
                    <span class="badge meta">{sr.profile_id}</span>
                    <span class="badge meta">{sr.orientation}</span>
                    <span class="badge meta">{sr.shell}</span>
                    <span class="badge meta">logical {logical_size}</span>
                    <span class="badge meta">encoded {encoded_size}</span>
                    <span class="badge meta">src {sr.source_fps}fps</span>
                    <span class="badge meta">sample {sample_label}fps</span>
                </div>
                <p class="description">{sr.description}</p>
                <p class="metrics-summary">
                    P={metrics.precision:.2f}&nbsp; R={metrics.recall:.2f}&nbsp; F1={metrics.f1:.2f}
                    &nbsp;&mdash;&nbsp; {metrics.total_candidates} candidates &middot; {metrics.total_ground_truth} ground truth &middot;
                    {metrics.missed_events} missed &middot; {metrics.false_positives} FP &middot;
                    err={metrics.mean_timing_error_ms:.0f}ms
                </p>
            </div>
        """)

        if timeline_img is not None:
            uri = _img_to_data_uri(timeline_img)
            html_parts.append(f'<img class="timeline" src="{uri}" alt="Timeline for {name}">')

        if filmstrip_img is not None:
            uri = _img_to_data_uri(filmstrip_img)
            html_parts.append(f'<img class="filmstrip" src="{uri}" alt="Filmstrip for {name}">')

        if annotated_video_path and Path(annotated_video_path).exists():
            rel_path = Path(annotated_video_path).name
            html_parts.append(f'<p class="video-link">Annotated video: <a href="videos/{rel_path}">{rel_path}</a></p>')

        # Event detail table
        html_parts.append("""
            <table class="events-table">
                <thead><tr><th>Status</th><th>Type</th><th>Difficulty</th><th>GT Time</th><th>Candidate</th><th>Timing Error</th></tr></thead>
                <tbody>
        """)
        for r in metrics.per_event_results:
            gt = r.ground_truth
            if r.matched_candidate_index is not None:
                status = '<span class="hit">HIT</span>'
                cand = f"cand[{r.matched_candidate_index}] @{r.matched_candidate_timestamp_ms}ms"
                terr = f"{r.timing_error_ms}ms"
            else:
                status = '<span class="miss">MISS</span>'
                cand = "&mdash;"
                terr = "&mdash;"
            html_parts.append(
                f"<tr><td>{status}</td><td>{gt.event_type}</td><td>{gt.difficulty}</td>"
                f"<td>{gt.start_ms}&ndash;{gt.end_ms}ms</td><td>{cand}</td><td>{terr}</td></tr>"
            )
        html_parts.append("</tbody></table></div>")

    html_parts.append("</body></html>")
    output_path.write_text("\n".join(html_parts))
    return output_path


_HTML_HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Stepthrough Eval Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

  :root {
    --bg: #f4f4f4;
    --panel: #fff8ef;
    --panel-border: rgba(55, 48, 37, 0.12);
    --text: #251f18;
    --muted: #6f665a;
    --accent: #d16d38;
    --accent-strong: #9d4d26;
    --success: #2d7a5a;
    --success-bg: rgba(45, 122, 90, 0.08);
    --danger: #b1453c;
    --danger-bg: rgba(177, 69, 60, 0.08);
    --warning: #a2691b;
    --info: #2f6482;
    --divider: rgba(55, 48, 37, 0.10);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: "Inter", "Avenir Next", "Helvetica Neue", sans-serif;
    font-size: 13px;
    line-height: 1.5;
    background: var(--bg);
    color: var(--text);
    padding: 28px 32px;
  }

  h1 {
    font-size: 1.35em;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
    margin-bottom: 4px;
  }

  .subtitle {
    font-size: 0.8em;
    color: var(--muted);
    margin-bottom: 24px;
  }

  /* ── Aggregate block ── */
  .aggregate {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    padding: 18px 24px 20px;
    margin-bottom: 20px;
  }

  .aggregate h2 {
    font-size: 0.7em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 14px;
  }

  .metrics-row { display: flex; gap: 0; }

  .metric {
    flex: 1;
    text-align: center;
    padding: 0 8px;
    border-right: 1px solid var(--divider);
  }
  .metric:last-child { border-right: none; }

  .metric-value {
    display: block;
    font-size: 1.9em;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.02em;
    line-height: 1.1;
  }

  .metric-label {
    display: block;
    font-size: 0.68em;
    font-weight: 500;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 3px;
  }

  /* ── Scenario cards ── */
  .scenario {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    padding: 16px 20px 18px;
    margin-bottom: 10px;
  }

  .scenario-header { margin-bottom: 10px; }

  .scenario-title {
    font-size: 0.95em;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .description {
    font-size: 0.78em;
    color: var(--muted);
    margin: 4px 0 6px;
  }

  .metrics-summary {
    font-family: 'Menlo', 'Consolas', monospace;
    font-size: 0.75em;
    color: var(--muted);
  }

  /* ── Badges ── */
  .badge {
    display: inline-block;
    padding: 1px 7px;
    font-size: 0.65em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-radius: 3px;
  }

  .badge.pass { background: var(--success-bg); color: var(--success); }
  .badge.fail { background: var(--danger-bg); color: var(--danger); }

  .badge.difficulty {
    background: rgba(209, 109, 56, 0.10);
    color: var(--accent-strong);
  }

  .badge.category {
    background: rgba(47, 100, 130, 0.10);
    color: var(--info);
  }

  .badge.meta {
    background: rgba(55, 48, 37, 0.06);
    color: var(--muted);
  }

  /* ── Visuals ── */
  .timeline, .filmstrip {
    display: block;
    margin: 8px 0 4px;
    max-width: 100%;
    border: 1px solid var(--panel-border);
  }

  .video-link {
    font-size: 0.78em;
    color: var(--accent);
    text-decoration: none;
    margin: 4px 0 8px;
    display: inline-block;
  }
  .video-link:hover { text-decoration: underline; }

  .dimension-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.74em;
  }

  .dimension-table th,
  .dimension-table td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--divider);
    text-align: left;
  }

  .dimension-table th {
    font-size: 0.68em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }

  /* ── Event table ── */
  .events-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75em;
    margin-top: 10px;
  }

  .events-table th {
    text-align: left;
    padding: 5px 8px;
    font-weight: 600;
    font-size: 0.68em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    background: rgba(55, 48, 37, 0.04);
    border-bottom: 1px solid var(--divider);
  }

  .events-table td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--divider);
    vertical-align: middle;
  }

  .events-table tr:last-child td { border-bottom: none; }

  .hit { color: var(--success); font-weight: 600; }
  .miss { color: var(--danger); font-weight: 600; }
</style>
</head>
<body>
<h1>Stepthrough &mdash; Hybrid v2 Eval Report</h1>
<p class="subtitle">Scene detection evaluation pipeline &middot; synthetic UI scenarios with ground truth</p>
"""
