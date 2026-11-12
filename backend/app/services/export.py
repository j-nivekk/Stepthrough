from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

from ..models import ExportMode
from ..storage import absolute_data_path, asset_url, relative_data_path, run_exports_dir
from ..utils import utc_now
from .pathway import build_pathway
from .video import export_filename


def _normalized_score_breakdown(candidate: dict) -> dict | None:
    value = candidate.get("score_breakdown")
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return value


def _json_value(value: object) -> dict | None:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return value if isinstance(value, dict) else None


def _run_settings(run: dict) -> dict:
    """The settings the run was started with, as stored (engine-specific parts only when present)."""
    settings: dict = {"analysis_engine": run.get("analysis_engine")}
    if run.get("analysis_engine") == "hybrid_v2":
        settings["analysis_preset"] = run.get("analysis_preset")
        settings["advanced"] = _json_value(run.get("analysis_advanced"))
        settings["min_scene_gap_ms"] = run.get("min_scene_gap_ms")
    elif run.get("analysis_engine") == "stable_v3":
        settings["stable"] = _json_value(run.get("analysis_stable"))
    else:
        for key in ("detector_mode", "tolerance", "min_scene_gap_ms", "sample_fps", "allow_high_fps_sampling",
                    "extract_offset_ms"):
            settings[key] = run.get(key)
    return settings


def _regions_in_recording_pixels(breakdown: dict | None, run: dict, recording: dict) -> dict | None:
    """Hybrid v2 measures changed regions on a frame scaled to at most 960 px on its long edge; exports give
    every engine's regions in pixels of the recording. (stable_v3 already stores them that way.)"""
    if not breakdown or run.get("analysis_engine") != "hybrid_v2" or not breakdown.get("changed_regions"):
        return breakdown
    long_edge = max(int(recording.get("width") or 0), int(recording.get("height") or 0))
    max_edge = int((_json_value(run.get("analysis_config")) or {}).get("max_frame_edge") or 960)
    if long_edge <= max_edge:
        return breakdown
    scale = long_edge / max_edge
    regions = [
        {**region, **{key: round(float(region[key]) * scale) for key in ("x", "y", "width", "height")}}
        for region in breakdown["changed_regions"]
    ]
    return {**breakdown, "changed_regions": regions}


_COMMON_NOTES = {
    "timestamp_ms": "time of the screenshot, in ms from the start of the recording",
    "image_path": "the screenshot, inside this bundle",
    "status, title, notes": "the reviewer's decision and annotations",
    "ocr_text": "text read from the screenshot by OCR; null when OCR was off or found no text",
    "score_breakdown.changed_regions": (
        "up to 6 changed areas as boxes (x, y, width, height) in pixels of the recording "
        "(recording.width x recording.height)"
    ),
    "revisit_group_id, similar_to_step_id": "steps showing a screen seen earlier share a revisit group",
}

_ENGINE_NOTES = {
    "stable_v3": {
        "step": "a screen that stayed still for at least resolved_settings.min_dwell_ms",
        "scene_score": "share of the screen that changed into this step (share of a 24 x 24 grid of regions); 1 for the opening screen",
        "transition_type": (
            "how the step was reached: opening_screen, navigation, scroll, feed_card_swap, modal, modal_close "
            "(a pop-up went away and the screen under it was still there), content_update, small_ui_change or "
            "text_entry (a typing burst grouped into one step); a description, not used to find steps"
        ),
        "change_started_ms": "when the screen started changing away from the previous step",
        "settled_ms": "when this step's screen stopped changing",
        "time_on_screen_ms": "how long this step's screen stayed on screen",
        "grouped_states": "number of stable screens merged into this step (typing burst or merged scroll stops)",
        "score_breakdown.changed_regions.score": "share of the box that changed, 0 to 1",
        "revisit_group_id, similar_to_step_id": (
            "a revisit is the same screen state again: no change larger than the smallest change"
        ),
    },
    "hybrid_v2": {
        "step": "the settled screen after a detected change event",
        "scene_score": "the event's strongest weighted change score, 0 to 1",
        "transition_type": "how the step was reached, estimated from the change signals",
        "change_started_ms, settled_ms": "start and end of the change event",
        "time_on_screen_ms": "time from the end of this change to the start of the next",
        "score_breakdown.changed_regions.score": "how strongly the area changed (mean difference), 0 to 1",
        "revisit_group_id, similar_to_step_id": "a revisit is a screenshot with similar image hashes and OCR text",
    },
    "scene_v1": {
        "step": "a scene cut found by PySceneDetect; the screenshot is taken extract_offset_ms after the cut",
        "scene_score": "the detector's cut score",
    },
}


def _field_notes(engine: str | None) -> dict:
    """What the per-step fields mean for this run's engine, so a bundle can be read without the app."""
    return {**_COMMON_NOTES, **_ENGINE_NOTES.get(engine or "", {})}


def _timing_columns(row: dict) -> dict:
    """Flat timing columns for spreadsheets: when the change began and settled, and how long it stayed."""
    breakdown = row.get("score_breakdown") or {}
    return {
        "transition_type": breakdown.get("transition_type"),
        "change_started_ms": breakdown.get("event_start_ms"),
        "settled_ms": breakdown.get("event_end_ms"),
        "time_on_screen_ms": breakdown.get("dwell_after_ms"),
        "grouped_states": breakdown.get("grouped_states"),
    }


def build_accepted_steps(recording_slug: str, candidates: list[dict]) -> list[dict]:
    accepted = [candidate for candidate in candidates if candidate["status"] == "accepted"]
    accepted_steps: list[dict] = []
    candidate_to_step: dict[str, str] = {}
    group_to_step: dict[str, str] = {}

    for step_index, candidate in enumerate(accepted, start=1):
        step_id = f"step-{step_index:03d}"
        revisit_group_id = candidate.get("revisit_group_id")
        similar_to_step_id = None
        similar_candidate_id = candidate.get("similar_to_candidate_id")
        if similar_candidate_id and similar_candidate_id in candidate_to_step:
            similar_to_step_id = candidate_to_step[similar_candidate_id]
        elif revisit_group_id and revisit_group_id in group_to_step:
            similar_to_step_id = group_to_step[revisit_group_id]

        title = (candidate.get("title") or "").strip() or f"Step {step_index}"
        step = {
            "step_id": step_id,
            "step_index": step_index,
            "timestamp_ms": candidate["timestamp_ms"],
            "timestamp_tc": candidate["timestamp_tc"],
            "image_path": candidate["image_path"],
            "image_url": asset_url(candidate["image_path"]),
            "status": candidate["status"],
            "title": title,
            "notes": candidate.get("notes"),
            "scene_score": candidate["scene_score"],
            "score_breakdown": _normalized_score_breakdown(candidate),
            "ocr_text": candidate.get("ocr_text"),
            "revisit_group_id": revisit_group_id,
            "similar_to_step_id": similar_to_step_id,
            "source_candidate_id": candidate["id"],
            "export_filename": export_filename(recording_slug, step_index, candidate["timestamp_ms"]),
        }
        accepted_steps.append(step)
        candidate_to_step[candidate["id"]] = step_id
        if revisit_group_id:
            group_to_step[revisit_group_id] = step_id

    return accepted_steps


def build_all_candidate_rows(recording_slug: str, candidates: list[dict]) -> list[dict]:
    ordered_candidates = sorted(candidates, key=lambda candidate: (candidate["detector_index"], candidate["timestamp_ms"]))
    export_rows: list[dict] = []

    for row_index, candidate in enumerate(ordered_candidates, start=1):
        export_rows.append(
            {
                "step_id": f"candidate-{row_index:03d}",
                "step_index": row_index,
                "timestamp_ms": candidate["timestamp_ms"],
                "timestamp_tc": candidate["timestamp_tc"],
                "image_path": candidate["image_path"],
                "image_url": asset_url(candidate["image_path"]),
                "status": candidate["status"],
                "title": (candidate.get("title") or "").strip() or f"Candidate {row_index}",
                "notes": candidate.get("notes"),
                "scene_score": candidate["scene_score"],
                "score_breakdown": _normalized_score_breakdown(candidate),
                "ocr_text": candidate.get("ocr_text"),
                "revisit_group_id": candidate.get("revisit_group_id"),
                "similar_to_step_id": None,
                "similar_to_source_candidate_id": candidate.get("similar_to_candidate_id"),
                "source_candidate_id": candidate["id"],
                "export_filename": export_filename(recording_slug, row_index, candidate["timestamp_ms"]),
            }
        )

    return export_rows


def build_export_rows(recording_slug: str, candidates: list[dict], mode: ExportMode) -> list[dict]:
    if mode == "all":
        export_rows = build_all_candidate_rows(recording_slug, candidates)
        if not export_rows:
            raise ValueError("No screenshot candidates are available to export.")
        return export_rows

    accepted_steps = build_accepted_steps(recording_slug, candidates)
    if not accepted_steps:
        raise ValueError("Mark at least one screenshot as accepted before exporting.")
    return accepted_steps


def create_export_bundle(
    *,
    bundle_id: str,
    project: dict,
    recording: dict,
    run: dict,
    candidates: list[dict],
    mode: ExportMode = "accepted",
) -> tuple[str, str, int]:
    export_rows = build_export_rows(recording["slug"], candidates, mode)

    exports_root = run_exports_dir(
        project["slug"],
        project["id"],
        recording["slug"],
        recording["id"],
        run["id"],
    )
    bundle_dir = exports_root / bundle_id
    images_dir = bundle_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    exported_manifest_rows = []
    for row in export_rows:
        source_path = absolute_data_path(row["image_path"])
        target_path = images_dir / row["export_filename"]
        shutil.copy2(source_path, target_path)
        exported = {key: value for key, value in row.items() if key != "image_url"}  # server-only URL
        exported["score_breakdown"] = _regions_in_recording_pixels(row.get("score_breakdown"), run, recording)
        exported_manifest_rows.append({**exported, "image_path": f"images/{row['export_filename']}", **_timing_columns(row)})

    manifest = {
        "bundle_id": bundle_id,
        "export_mode": mode,
        "created_at": utc_now(),
        "project": {
            "id": project["id"],
            "name": project["name"],
            "slug": project["slug"],
        },
        "recording": {
            "id": recording["id"],
            "filename": recording["filename"],
            "slug": recording["slug"],
            "duration_ms": recording["duration_ms"],
            "width": recording.get("width"),
            "height": recording.get("height"),
            "fps": recording.get("fps"),
        },
        "run": {
            "id": run["id"],
            "analysis_engine": run.get("analysis_engine"),
            "engine_version": (_json_value(run.get("analysis_config")) or {}).get("engine_version"),
            "settings": _run_settings(run),
            "resolved_settings": _json_value(run.get("analysis_config")),
        },
        "field_notes": _field_notes(run.get("analysis_engine")),
        "steps": exported_manifest_rows,
    }

    with (bundle_dir / "steps.json").open("w", encoding="utf-8") as output:
        json.dump(manifest, output, indent=2)

    with (bundle_dir / "steps.csv").open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(
            output,
            fieldnames=[
                "step_id",
                "step_index",
                "timestamp_ms",
                "timestamp_tc",
                "image_path",
                "status",
                "title",
                "notes",
                "scene_score",
                "transition_type",
                "change_started_ms",
                "settled_ms",
                "time_on_screen_ms",
                "grouped_states",
                "ocr_text",
                "revisit_group_id",
                "similar_to_step_id",
                "similar_to_source_candidate_id",
                "source_candidate_id",
                "export_filename",
            ],
            extrasaction="ignore",
        )
        writer.writeheader()
        writer.writerows(exported_manifest_rows)

    # The same steps as a pathway: the screens they show and the moves between them.
    pathway = build_pathway(export_rows, candidates)
    for step in pathway["steps"]:
        step["image_path"] = f"images/{step.pop('export_filename')}"
    pathway = {"bundle_id": bundle_id, "created_at": manifest["created_at"], "steps_file": "steps.json", **pathway}
    with (bundle_dir / "pathway.json").open("w", encoding="utf-8") as output:
        json.dump(pathway, output, indent=2)

    archive_path = shutil.make_archive(str(bundle_dir), "zip", root_dir=bundle_dir)
    return relative_data_path(bundle_dir), relative_data_path(Path(archive_path)), len(exported_manifest_rows)
