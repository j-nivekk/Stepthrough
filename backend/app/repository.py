from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from .database import connect
from .models import RunSettings
from .utils import slugify, utc_now

ACTIVE_RUN_STATUSES = {"queued", "running"}

PROJECT_SUMMARY_SELECT = """
SELECT
    p.id,
    p.name,
    p.slug,
    p.created_at,
    (
        SELECT COUNT(*)
        FROM recordings r
        WHERE r.project_id = p.id
    ) AS recording_count,
    (
        SELECT COUNT(*)
        FROM detection_runs dr
        JOIN recordings r ON r.id = dr.recording_id
        WHERE r.project_id = p.id
    ) AS run_count,
    COALESCE(
        (
            SELECT MAX(activity_at)
            FROM (
                SELECT p.created_at AS activity_at
                UNION ALL
                SELECT r.created_at
                FROM recordings r
                WHERE r.project_id = p.id
                UNION ALL
                SELECT dr.updated_at
                FROM detection_runs dr
                JOIN recordings r ON r.id = dr.recording_id
                WHERE r.project_id = p.id
                UNION ALL
                SELECT c.updated_at
                FROM candidate_frames c
                JOIN detection_runs dr ON dr.id = c.run_id
                JOIN recordings r ON r.id = dr.recording_id
                WHERE r.project_id = p.id
                UNION ALL
                SELECT eb.created_at
                FROM export_bundles eb
                JOIN detection_runs dr ON dr.id = eb.run_id
                JOIN recordings r ON r.id = dr.recording_id
                WHERE r.project_id = p.id
            )
        ),
        p.created_at
    ) AS last_activity_at
FROM projects p
"""


def _row_to_dict(row: Any) -> dict[str, Any]:
    return dict(row) if row is not None else None


def create_project(name: str) -> dict[str, Any]:
    project_id = uuid4().hex
    payload = {
        "id": project_id,
        "name": name.strip(),
        "slug": slugify(name),
        "created_at": utc_now(),
    }
    with connect() as conn:
        conn.execute(
            "INSERT INTO projects (id, name, slug, created_at) VALUES (:id, :name, :slug, :created_at)",
            payload,
        )
    return get_project(project_id)


def list_projects() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            f"""
            {PROJECT_SUMMARY_SELECT}
            ORDER BY last_activity_at DESC, p.created_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def get_project(project_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            f"""
            {PROJECT_SUMMARY_SELECT}
            WHERE p.id = ?
            """,
            (project_id,),
        ).fetchone()
    return _row_to_dict(row)


def update_project_name(project_id: str, name: str) -> dict[str, Any] | None:
    payload = {
        "id": project_id,
        "name": name.strip(),
    }
    with connect() as conn:
        conn.execute("UPDATE projects SET name = :name WHERE id = :id", payload)
    return get_project(project_id)


def create_recording(
    *,
    recording_id: str | None = None,
    project_id: str,
    filename: str,
    slug: str,
    source_path: str,
    duration_ms: int,
    width: int,
    height: int,
    fps: float,
) -> dict[str, Any]:
    recording_id = recording_id or uuid4().hex
    payload = {
        "id": recording_id,
        "project_id": project_id,
        "filename": filename,
        "slug": slug,
        "source_path": source_path,
        "duration_ms": duration_ms,
        "width": width,
        "height": height,
        "fps": fps,
        "created_at": utc_now(),
    }
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO recordings (
                id, project_id, filename, slug, source_path, duration_ms, width, height, fps, created_at
            ) VALUES (
                :id, :project_id, :filename, :slug, :source_path, :duration_ms, :width, :height, :fps, :created_at
            )
            """,
            payload,
        )
    return get_recording(recording_id)


def get_recording(recording_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM recordings WHERE id = ?",
            (recording_id,),
        ).fetchone()
    return _row_to_dict(row)


def list_recordings(project_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM recordings WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def update_recording_filename(recording_id: str, filename: str) -> dict[str, Any] | None:
    payload = {
        "id": recording_id,
        "filename": filename.strip(),
    }
    with connect() as conn:
        conn.execute("UPDATE recordings SET filename = :filename WHERE id = :id", payload)
    return get_recording(recording_id)


def delete_recording_record(recording_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM recordings WHERE id = ?", (recording_id,))


def recording_has_active_runs(recording_id: str) -> bool:
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(1) FROM detection_runs WHERE recording_id = ? AND status IN ('queued', 'running')",
            (recording_id,),
        ).fetchone()
    return bool(row[0])


def create_run(recording_id: str, settings: RunSettings) -> dict[str, Any]:
    run_id = uuid4().hex
    now = utc_now()
    payload = {
        "id": run_id,
        "recording_id": recording_id,
        "status": "queued",
        "phase": "queued",
        "analysis_engine": settings.analysis_engine,
        "analysis_preset": settings.analysis_preset,
        "analysis_advanced": settings.advanced.model_dump_json() if settings.advanced is not None else None,
        "analysis_config": None,
        "detector_mode": settings.detector_mode,
        "tolerance": settings.tolerance,
        "min_scene_gap_ms": settings.min_scene_gap_ms,
        "sample_fps": settings.sample_fps,
        "allow_high_fps_sampling": settings.allow_high_fps_sampling,
        "extract_offset_ms": settings.extract_offset_ms,
        "progress": 0.0,
        "message": "Queued",
        "candidate_count": 0,
        "created_at": now,
        "updated_at": now,
    }
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO detection_runs (
                id, recording_id, status, phase, analysis_engine, analysis_preset, analysis_advanced, analysis_config,
                detector_mode, tolerance, min_scene_gap_ms, sample_fps, allow_high_fps_sampling,
                extract_offset_ms, progress, message, candidate_count, created_at, updated_at
            ) VALUES (
                :id, :recording_id, :status, :phase, :analysis_engine, :analysis_preset, :analysis_advanced, :analysis_config,
                :detector_mode, :tolerance, :min_scene_gap_ms, :sample_fps, :allow_high_fps_sampling,
                :extract_offset_ms, :progress, :message, :candidate_count, :created_at, :updated_at
            )
            """,
            payload,
        )
    return get_run(run_id)


def list_runs(recording_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT dr.*, COALESCE(SUM(CASE WHEN c.status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted_count
            FROM detection_runs dr
            LEFT JOIN candidate_frames c ON c.run_id = dr.id
            WHERE dr.recording_id = ?
            GROUP BY dr.id
            ORDER BY dr.created_at DESC
            """,
            (recording_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_run(run_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT dr.*, COALESCE(SUM(CASE WHEN c.status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted_count
            FROM detection_runs dr
            LEFT JOIN candidate_frames c ON c.run_id = dr.id
            WHERE dr.id = ?
            GROUP BY dr.id
            """,
            (run_id,),
        ).fetchone()
    return _row_to_dict(row)


def update_run(run_id: str, **fields: Any) -> dict[str, Any] | None:
    if not fields:
        return get_run(run_id)
    fields["updated_at"] = utc_now()
    assignments = ", ".join(f"{key} = :{key}" for key in fields)
    fields["id"] = run_id
    with connect() as conn:
        conn.execute(f"UPDATE detection_runs SET {assignments} WHERE id = :id", fields)
    return get_run(run_id)


def delete_run_record(run_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM detection_runs WHERE id = ?", (run_id,))


def replace_candidates(run_id: str, recording_id: str, candidates: list[dict[str, Any]]) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM candidate_frames WHERE run_id = ?", (run_id,))
        if candidates:
            conn.executemany(
                """
                INSERT INTO candidate_frames (
                    id, run_id, recording_id, detector_index, candidate_origin, timestamp_ms, timestamp_tc, image_path,
                    scene_score, status, title, notes, image_hash, perceptual_hash, histogram_signature, ocr_text,
                    revisit_group_id, similar_to_candidate_id, similarity_distance, score_breakdown, created_at, updated_at
                ) VALUES (
                    :id, :run_id, :recording_id, :detector_index, :candidate_origin, :timestamp_ms, :timestamp_tc, :image_path,
                    :scene_score, :status, :title, :notes, :image_hash, :perceptual_hash, :histogram_signature, :ocr_text,
                    :revisit_group_id, :similar_to_candidate_id, :similarity_distance, :score_breakdown, :created_at, :updated_at
                )
                """,
                [
                    {
                        **candidate,
                        "run_id": run_id,
                        "recording_id": recording_id,
                        "candidate_origin": candidate.get("candidate_origin", "detected"),
                        "score_breakdown": (
                            candidate.get("score_breakdown")
                            if isinstance(candidate.get("score_breakdown"), str)
                            else json.dumps(candidate.get("score_breakdown"))
                            if candidate.get("score_breakdown") is not None
                            else None
                        ),
                    }
                    for candidate in candidates
                ],
            )


def list_candidates(run_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM candidate_frames WHERE run_id = ? ORDER BY detector_index ASC",
            (run_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_candidate(candidate_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM candidate_frames WHERE id = ?",
            (candidate_id,),
        ).fetchone()
    return _row_to_dict(row)


def update_candidate(candidate_id: str, **fields: Any) -> dict[str, Any] | None:
    if not fields:
        return get_candidate(candidate_id)
    fields["updated_at"] = utc_now()
    fields["id"] = candidate_id
    assignments = ", ".join(f"{key} = :{key}" for key in fields if key != "id")
    with connect() as conn:
        conn.execute(f"UPDATE candidate_frames SET {assignments} WHERE id = :id", fields)
    return get_candidate(candidate_id)


def create_export_bundle(run_id: str, output_dir: str, zip_path: str, item_count: int) -> dict[str, Any]:
    bundle_id = uuid4().hex
    payload = {
        "id": bundle_id,
        "run_id": run_id,
        "output_dir": output_dir,
        "zip_path": zip_path,
        "item_count": item_count,
        "created_at": utc_now(),
    }
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO export_bundles (id, run_id, output_dir, zip_path, item_count, created_at)
            VALUES (:id, :run_id, :output_dir, :zip_path, :item_count, :created_at)
            ON CONFLICT(run_id) DO UPDATE SET
                id = excluded.id,
                output_dir = excluded.output_dir,
                zip_path = excluded.zip_path,
                item_count = excluded.item_count,
                created_at = excluded.created_at
            """,
            payload,
        )
    update_run(run_id, export_bundle_id=bundle_id)
    return get_export_bundle(bundle_id)


def clear_export_bundle_for_run(run_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM export_bundles WHERE run_id = ?", (run_id,))
    update_run(run_id, export_bundle_id=None)


def get_export_bundle(bundle_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM export_bundles WHERE id = ?",
            (bundle_id,),
        ).fetchone()
    return _row_to_dict(row)


def get_export_bundle_for_run(run_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM export_bundles WHERE run_id = ?",
            (run_id,),
        ).fetchone()
    return _row_to_dict(row)


def create_run_event(run_id: str, phase: str, level: str, message: str, progress: float | None) -> dict[str, Any]:
    event_id = uuid4().hex
    payload = {
        "id": event_id,
        "run_id": run_id,
        "phase": phase,
        "level": level,
        "message": message,
        "progress": progress,
        "created_at": utc_now(),
    }
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO run_events (id, run_id, phase, level, message, progress, created_at)
            VALUES (:id, :run_id, :phase, :level, :message, :progress, :created_at)
            """,
            payload,
        )
    return payload


def list_run_events(run_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC, rowid ASC",
            (run_id,),
        ).fetchall()
    return [dict(row) for row in rows]
