from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

from ..storage import absolute_data_path, asset_url, relative_data_path, run_exports_dir
from ..utils import utc_now
from .video import export_filename


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


def create_export_bundle(
    *,
    bundle_id: str,
    project: dict,
    recording: dict,
    run: dict,
    candidates: list[dict],
) -> tuple[str, str, int]:
    accepted_steps = build_accepted_steps(recording["slug"], candidates)
    if not accepted_steps:
        raise ValueError("Mark at least one screenshot as accepted before exporting.")

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

    export_rows = []
    for step in accepted_steps:
        source_path = absolute_data_path(step["image_path"])
        target_path = images_dir / step["export_filename"]
        shutil.copy2(source_path, target_path)
        export_rows.append({**step, "image_path": f"images/{step['export_filename']}"})

    manifest = {
        "bundle_id": bundle_id,
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
        },
        "run": {
            "id": run["id"],
            "detector_mode": run["detector_mode"],
            "tolerance": run["tolerance"],
        },
        "steps": export_rows,
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
                "revisit_group_id",
                "similar_to_step_id",
                "source_candidate_id",
                "export_filename",
            ],
            extrasaction="ignore",
        )
        writer.writeheader()
        writer.writerows(export_rows)

    archive_path = shutil.make_archive(str(bundle_dir), "zip", root_dir=bundle_dir)
    return relative_data_path(bundle_dir), relative_data_path(Path(archive_path)), len(export_rows)
