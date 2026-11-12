from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from typing import Any
from uuid import uuid4

from .database import LOCAL_USER_ID, connect
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


def _placeholders(values: Sequence[Any]) -> str:
    return ", ".join("?" for _ in values)


def create_project(name: str, owner_id: str = LOCAL_USER_ID) -> dict[str, Any]:
    project_id = uuid4().hex
    payload = {
        "id": project_id,
        "name": name.strip(),
        "slug": slugify(name),
        "created_at": utc_now(),
        "owner": owner_id,
    }
    with connect() as conn:
        conn.execute(
            "INSERT INTO projects (id, name, slug, created_at) VALUES (:id, :name, :slug, :created_at)",
            payload,
        )
        conn.execute(
            "INSERT INTO project_members (project_id, member, role, created_at) VALUES (:id, :owner, 'owner', :created_at)",
            payload,
        )
    return get_project(project_id)


def list_projects(members: Sequence[str] | None = None) -> list[dict[str, Any]]:
    """Projects any of ``members`` (user ids and ``tag:`` entries) belongs to; every project when ``None``."""
    where, params = "", ()
    if members is not None:
        if not members:
            return []
        where = f"WHERE p.id IN (SELECT project_id FROM project_members WHERE member IN ({_placeholders(members)}))"
        params = tuple(members)
    with connect() as conn:
        rows = conn.execute(
            f"""
            {PROJECT_SUMMARY_SELECT}
            {where}
            ORDER BY last_activity_at DESC, p.created_at DESC
            """,
            params,
        ).fetchall()
    return [dict(row) for row in rows]


def find_projects_by_folder(slug: str, id_prefix: str) -> list[dict[str, Any]]:
    """Projects whose folder under ``projects/`` is ``{slug}-{id_prefix}`` (see ``storage.project_dir``)."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, name, slug FROM projects WHERE slug = ? AND substr(id, 1, ?) = ?",
            (slug, len(id_prefix), id_prefix),
        ).fetchall()
    return [dict(row) for row in rows]


def project_member_roles(project_id: str, members: Sequence[str]) -> set[str]:
    if not members:
        return set()
    with connect() as conn:
        rows = conn.execute(
            f"SELECT role FROM project_members WHERE project_id = ? AND member IN ({_placeholders(members)})",
            (project_id, *members),
        ).fetchall()
    return {row["role"] for row in rows}


def set_project_member(project_id: str, member: str, role: str = "owner") -> None:
    """Give ``member`` (a user id or ``tag:<name>``) a role on a project, replacing any role it had."""
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO project_members (project_id, member, role, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (project_id, member) DO UPDATE SET role = excluded.role
            """,
            (project_id, member, role, utc_now()),
        )


def list_project_members(project_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT member, role, created_at FROM project_members WHERE project_id = ? ORDER BY created_at, member",
            (project_id,),
        ).fetchall()
    return [dict(row) for row in rows]


# Users. The password hash is only ever read by `get_password_hash`; every other query leaves it out.
USER_COLUMNS = (
    "u.id, u.name, u.display_name, u.tags, u.is_disabled, u.delete_after, u.notes, u.created_at, u.last_seen_at, "
    "u.password_hash IS NOT NULL AS has_password"
)


def create_user(
    name: str,
    *,
    display_name: str | None = None,
    tags: Iterable[str] = (),
    user_id: str | None = None,
    delete_after: str | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    payload = {
        "id": user_id or uuid4().hex,
        "name": name.strip(),
        "display_name": display_name,
        "tags": json.dumps(sorted(set(tags))),
        "delete_after": delete_after,
        "notes": notes,
        "created_at": utc_now(),
    }
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO users (id, name, display_name, tags, delete_after, notes, created_at)
            VALUES (:id, :name, :display_name, :tags, :delete_after, :notes, :created_at)
            """,
            payload,
        )
    return get_user(payload["id"])


def get_user(user_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(f"SELECT {USER_COLUMNS} FROM users u WHERE u.id = ?", (user_id,)).fetchone()
    return _row_to_dict(row)


def find_user_by_name(name: str) -> dict[str, Any] | None:
    """The user who logs in as ``name``, in any case."""
    with connect() as conn:
        row = conn.execute(
            f"SELECT {USER_COLUMNS} FROM users u WHERE u.name = ? COLLATE NOCASE", (name.strip(),)
        ).fetchone()
    return _row_to_dict(row)


def list_users() -> list[dict[str, Any]]:
    """Every user, with how many projects they own themselves and whether an unused link is waiting for them."""
    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT {USER_COLUMNS},
                (SELECT COUNT(*) FROM project_members m WHERE m.member = u.id AND m.role = 'owner') AS project_count,
                (SELECT l.purpose FROM user_links l WHERE l.user_id = u.id) AS open_link
            FROM users u
            ORDER BY u.name COLLATE NOCASE
            """
        ).fetchall()
    return [dict(row) for row in rows]


def update_user(user_id: str, **fields: Any) -> dict[str, Any] | None:
    """Change any of ``display_name``, ``tags`` (a list), ``is_disabled``, ``delete_after`` and ``notes``."""
    allowed = {"display_name", "tags", "is_disabled", "delete_after", "notes"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Cannot update user fields: {', '.join(sorted(unknown))}")
    if "tags" in fields:
        fields["tags"] = json.dumps(sorted(set(fields["tags"])))
    if "is_disabled" in fields:
        fields["is_disabled"] = int(bool(fields["is_disabled"]))
    if fields:
        assignments = ", ".join(f"{key} = :{key}" for key in fields)
        with connect() as conn:
            conn.execute(f"UPDATE users SET {assignments} WHERE id = :id", {**fields, "id": user_id})
    return get_user(user_id)


def delete_user_record(user_id: str) -> None:
    """Remove a user, their sessions and link, and their project memberships (not the projects themselves)."""
    with connect() as conn:
        conn.execute("DELETE FROM project_members WHERE member = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def get_password_hash(user_id: str) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
    return row["password_hash"] if row else None


def any_password_set() -> bool:
    """Whether anyone can log in at all: some account has a password."""
    with connect() as conn:
        return conn.execute("SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1").fetchone() is not None


def set_password_hash(user_id: str, password_hash: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


def projects_owned_only_by(user_id: str) -> list[dict[str, Any]]:
    """Projects this user owns and nobody else does (no other user, and no tag, has the owner role)."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT p.id, p.name, p.slug FROM projects p
            JOIN project_members mine ON mine.project_id = p.id AND mine.member = ? AND mine.role = 'owner'
            WHERE NOT EXISTS (
                SELECT 1 FROM project_members other
                WHERE other.project_id = p.id AND other.role = 'owner' AND other.member != ?
            )
            ORDER BY p.created_at
            """,
            (user_id, user_id),
        ).fetchall()
    return [dict(row) for row in rows]


def transfer_projects(from_member: str, to_member: str) -> int:
    """Hand every project ``from_member`` belongs to over to ``to_member``, with the same role (an owner role is
    never lowered); ``from_member`` leaves them. Returns how many projects were handed over."""
    now = utc_now()
    with connect() as conn:
        moved = conn.execute("SELECT COUNT(*) FROM project_members WHERE member = ?", (from_member,)).fetchone()[0]
        conn.execute(
            """
            INSERT INTO project_members (project_id, member, role, created_at)
            SELECT project_id, ?, role, ? FROM project_members WHERE member = ?
            ON CONFLICT (project_id, member) DO UPDATE
            SET role = CASE WHEN excluded.role = 'owner' THEN 'owner' ELSE project_members.role END
            """,
            (to_member, now, from_member),
        )
        conn.execute("DELETE FROM project_members WHERE member = ?", (from_member,))
    return moved


def list_saved_run_settings(user_id: str) -> list[dict[str, Any]]:
    """The settings this user saved: their own defaults (``project_id`` None) first, then those for projects."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT project_id, settings, saved_at FROM saved_run_settings
            WHERE user_id = ?
            ORDER BY project_id IS NOT NULL, saved_at
            """,
            (user_id,),
        ).fetchall()
    return [{**dict(row), "settings": json.loads(row["settings"])} for row in rows]


def save_run_settings(user_id: str, project_id: str | None, settings: RunSettings) -> dict[str, Any]:
    """Keep ``settings`` as this user's defaults (``project_id`` None) or as theirs for one project, in place of
    what was saved there before."""
    saved = {"project_id": project_id, "settings": settings.model_dump(mode="json"), "saved_at": utc_now()}
    with connect() as conn:
        conn.execute(
            "DELETE FROM saved_run_settings WHERE user_id = ? AND IFNULL(project_id, '') = IFNULL(?, '')",
            (user_id, project_id),
        )
        conn.execute(
            "INSERT INTO saved_run_settings (user_id, project_id, settings, saved_at) VALUES (?, ?, ?, ?)",
            (user_id, project_id, json.dumps(saved["settings"]), saved["saved_at"]),
        )
    return saved


def users_due_for_deletion(today: str) -> list[dict[str, Any]]:
    """Users whose ``delete_after`` date (YYYY-MM-DD) is ``today`` or earlier."""
    with connect() as conn:
        rows = conn.execute(
            f"SELECT {USER_COLUMNS} FROM users u WHERE u.delete_after IS NOT NULL AND u.delete_after <= ?",
            (today,),
        ).fetchall()
    return [dict(row) for row in rows]


# Sessions and one-time links store only the SHA-256 of their token (see accounts.token_hash).


def create_session(token_hash: str, user_id: str, expires_at: str) -> None:
    now = utc_now()
    with connect() as conn:
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            (token_hash, user_id, now, now, expires_at),
        )
        conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now, user_id))


def get_session(token_hash: str) -> dict[str, Any] | None:
    """The session and its user's columns (``user_id``, ``name``, ``tags``, ``is_disabled``, ...)."""
    with connect() as conn:
        row = conn.execute(
            f"""
            SELECT s.token_hash, s.user_id, s.last_seen_at AS session_seen_at, s.expires_at, {USER_COLUMNS}
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
    return _row_to_dict(row)


def touch_session(token_hash: str, user_id: str, now: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", (now, token_hash))
        conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now, user_id))


def delete_session(token_hash: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))


def delete_user_sessions(user_id: str, keep_token_hash: str | None = None) -> None:
    """Log a user out everywhere, except (optionally) in the browser with ``keep_token_hash``."""
    with connect() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user_id, keep_token_hash or "")
        )


def replace_user_link(token_hash: str, user_id: str, purpose: str, expires_at: str) -> None:
    """Make this the user's only link; an earlier one stops working."""
    with connect() as conn:
        conn.execute("DELETE FROM user_links WHERE user_id = ?", (user_id,))
        conn.execute(
            "INSERT INTO user_links (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            (token_hash, user_id, purpose, utc_now(), expires_at),
        )


def get_user_link(token_hash: str) -> dict[str, Any] | None:
    """The link and its user's columns (``user_id``, ``purpose``, ``expires_at``, ``name``, ...)."""
    with connect() as conn:
        row = conn.execute(
            f"""
            SELECT l.token_hash, l.user_id, l.purpose, l.expires_at, {USER_COLUMNS}
            FROM user_links l JOIN users u ON u.id = l.user_id
            WHERE l.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
    return _row_to_dict(row)


def delete_user_links(user_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM user_links WHERE user_id = ?", (user_id,))


def delete_expired_sessions_and_links(now: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        conn.execute("DELETE FROM user_links WHERE expires_at <= ?", (now,))


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


def delete_project_record(project_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))


def project_has_active_runs(project_id: str) -> bool:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT COUNT(1)
            FROM detection_runs dr
            JOIN recordings r ON r.id = dr.recording_id
            WHERE r.project_id = ? AND dr.status IN ('queued', 'running')
            """,
            (project_id,),
        ).fetchone()
    return bool(row[0])


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


def update_recording_media(
    recording_id: str,
    *,
    working_path: str,
    duration_ms: int,
    width: int,
    height: int,
    fps: float,
) -> dict[str, Any] | None:
    payload = {
        "id": recording_id,
        "working_path": working_path,
        "duration_ms": duration_ms,
        "width": width,
        "height": height,
        "fps": fps,
    }
    with connect() as conn:
        conn.execute(
            """
            UPDATE recordings
            SET working_path = :working_path, duration_ms = :duration_ms, width = :width, height = :height, fps = :fps
            WHERE id = :id
            """,
            payload,
        )
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
        "analysis_stable": settings.stable.model_dump_json() if settings.stable is not None else None,
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
                id, recording_id, status, phase, analysis_engine, analysis_preset, analysis_advanced, analysis_stable,
                analysis_config,
                detector_mode, tolerance, min_scene_gap_ms, sample_fps, allow_high_fps_sampling,
                extract_offset_ms, progress, message, candidate_count, created_at, updated_at
            ) VALUES (
                :id, :recording_id, :status, :phase, :analysis_engine, :analysis_preset, :analysis_advanced, :analysis_stable,
                :analysis_config,
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
                    revisit_group_id, similar_to_candidate_id, similarity_distance, score_breakdown, screen_link, screen_kind,
                    created_at, updated_at
                ) VALUES (
                    :id, :run_id, :recording_id, :detector_index, :candidate_origin, :timestamp_ms, :timestamp_tc, :image_path,
                    :scene_score, :status, :title, :notes, :image_hash, :perceptual_hash, :histogram_signature, :ocr_text,
                    :revisit_group_id, :similar_to_candidate_id, :similarity_distance, :score_breakdown, :screen_link, :screen_kind,
                    :created_at, :updated_at
                )
                """,
                [
                    {
                        **candidate,
                        "run_id": run_id,
                        "recording_id": recording_id,
                        "candidate_origin": candidate.get("candidate_origin", "detected"),
                        "screen_link": candidate.get("screen_link"),
                        "screen_kind": candidate.get("screen_kind"),
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


def fail_interrupted_runs(message: str) -> list[str]:
    """Runs left queued or running by a previous process can never finish: mark them failed."""
    now = utc_now()
    with connect() as conn:
        run_ids = [
            row["id"]
            for row in conn.execute("SELECT id FROM detection_runs WHERE status IN ('queued', 'running')").fetchall()
        ]
        conn.executemany(
            """
            UPDATE detection_runs
            SET status = 'failed', phase = 'failed', message = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
            """,
            [(message, now, now, run_id) for run_id in run_ids],
        )
    for run_id in run_ids:
        create_run_event(run_id, phase="failed", level="error", message=message, progress=None)
    return run_ids


def list_run_events(run_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC, rowid ASC",
            (run_id,),
        ).fetchall()
    return [dict(row) for row in rows]
