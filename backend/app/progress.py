"""How far each group has got with its projects, for the people who teach with Stepthrough. Administrators read it in
the admin panel under **progress**.

It is read from the projects themselves (videos, analyses, decisions, titles and notes, screen corrections, pathway
figures and exports), not from the usage log, so it covers a whole course whatever the keeping time of usage. It
holds counts and dates, never what anyone wrote.

Each video is judged by its *working* analysis: of its completed analyses, the one with the most decisions (the
latest, when several have as many). A project reaches, in turn:

- ``videos``: a video is uploaded;
- ``analysed``: an analysis of a video is complete;
- ``reviewed``: every video has a working analysis without undecided steps, and some steps are accepted;
- ``described``: every accepted step has a title or notes;
- ``pathway``: a pathway figure was downloaded (``figure_downloaded_at`` on the analysis);
- ``exported``: the steps were exported.

Each stage comes with the date it was reached, as well as the projects can tell: the first video, analysis, figure
and export; for reviewed and described, the last change to the steps once they were done.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from .database import ADMIN_TAG, SHARED_TAG, VISITOR_TAG, connect
from .models import StableSettings

STAGES = ("videos", "analysed", "reviewed", "described", "pathway", "exported")
ACTIVE = ("queued", "running", "awaiting_fallback")
_STABLE_DEFAULTS = StableSettings().model_dump()


def settings_changed(stable_json: str | None) -> set[str]:
    """The names of the settings of the stable-screen engine that an analysis changed from their defaults."""
    if not stable_json:
        return set()
    try:
        stable = json.loads(stable_json)
    except ValueError:
        return set()
    changed = set()
    for key, default in _STABLE_DEFAULTS.items():
        value = stable.get(key, default)
        if key == "ignore_regions":
            if value:
                changed.add(key)
        elif value != default:
            changed.add(key)
    return changed


def _rows(conn: Any, sql: str) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(sql).fetchall()]


def report(tag: str | None = None) -> dict[str, Any]:
    with connect() as conn:
        users = _rows(conn, "SELECT id, name, tags, created_at, last_seen_at FROM users")
        projects = _rows(
            conn,
            "SELECT p.id, p.name, p.created_at, m.member FROM projects p"
            " JOIN project_members m ON m.project_id = p.id AND m.role = 'owner'",
        )
        recordings = _rows(conn, "SELECT id, project_id, duration_ms, created_at FROM recordings")
        runs = _rows(
            conn,
            "SELECT id, recording_id, status, analysis_stable, created_at, completed_at, updated_at,"
            " figure_downloaded_at FROM detection_runs",
        )
        steps = {
            row["run_id"]: row
            for row in _rows(
                conn,
                """
                SELECT run_id,
                    SUM(candidate_origin != 'manual') AS found,
                    SUM(candidate_origin = 'manual') AS added,
                    SUM(status = 'accepted') AS accepted,
                    SUM(status = 'rejected') AS rejected,
                    SUM(status = 'pending') AS pending,
                    SUM(status = 'accepted' AND (TRIM(COALESCE(title, '')) != '' OR TRIM(COALESCE(notes, '')) != ''))
                        AS described,
                    SUM(status = 'accepted' AND (screen_link IS NOT NULL OR screen_kind IS NOT NULL)) AS corrections,
                    MAX(updated_at) AS last_change
                FROM candidate_frames GROUP BY run_id
                """,
            )
        }
        exports = {
            row["run_id"]: row
            for row in _rows(
                conn, "SELECT run_id, MIN(created_at) AS first, MAX(created_at) AS last FROM export_bundles GROUP BY run_id"
            )
        }

    runs_of: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        runs_of[run["recording_id"]].append(run)
    recordings_of: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for recording in recordings:
        recordings_of[recording["project_id"]].append(recording)
    projects_of: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for project in projects:
        projects_of[project["member"]].append(project)

    accounts = []
    for user in users:
        tags = json.loads(user["tags"] or "[]")
        if ADMIN_TAG in tags or (tag and tag not in tags):
            continue
        accounts.append({
            "id": user["id"],
            "name": user["name"],
            "shared": SHARED_TAG in tags,
            "visitor": VISITOR_TAG in tags,
            "tags": [item for item in tags if item not in (SHARED_TAG, VISITOR_TAG)],
            "created_at": user["created_at"],
            "last_seen_at": user["last_seen_at"],
            "projects": sorted(
                (_project(project, recordings_of[project["id"]], runs_of, steps, exports) for project in projects_of[user["id"]]),
                key=lambda entry: entry["last_change"] or "",
                reverse=True,
            ),
        })
    accounts.sort(key=lambda entry: entry["name"].lower())
    return {"generated_at": datetime.now(timezone.utc).isoformat(), "tag": tag, "stages": list(STAGES), "accounts": accounts}


def _project(
    project: dict[str, Any],
    recordings: list[dict[str, Any]],
    runs_of: dict[str, list[dict[str, Any]]],
    steps: dict[str, dict[str, Any]],
    exports: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    counts = {key: 0 for key in ("found", "added", "accepted", "rejected", "pending", "described", "corrections")}
    changes = [project["created_at"]]
    changed_settings: set[str] = set()
    analysed_at: list[str] = []
    figure_at: list[str] = []
    exported_at: list[str] = []
    step_changes: list[str] = []
    runs = failed = active = failed_unretried = analysed = 0
    every_video_reviewed = bool(recordings)

    for recording in recordings:
        changes.append(recording["created_at"])
        own = sorted(runs_of.get(recording["id"], []), key=lambda run: run["created_at"])
        runs += len(own)
        failed += sum(run["status"] == "failed" for run in own)
        active += sum(run["status"] in ACTIVE for run in own)
        if own and own[-1]["status"] == "failed":
            failed_unretried += 1
        for run in own:
            changes.append(run["updated_at"])
            changed_settings |= settings_changed(run["analysis_stable"])
            if run["figure_downloaded_at"]:
                figure_at.append(run["figure_downloaded_at"])
            if run["id"] in exports:
                exported_at.append(exports[run["id"]]["first"])
                changes.append(exports[run["id"]]["last"])
            if run["id"] in steps and steps[run["id"]]["last_change"]:
                changes.append(steps[run["id"]]["last_change"])
        completed = [run for run in own if run["status"] == "completed"]
        if not completed:
            every_video_reviewed = False
            continue
        analysed += 1
        analysed_at.append(min(run["completed_at"] or run["updated_at"] for run in completed))
        working = max(
            completed,
            key=lambda run: (
                (steps.get(run["id"]) or {}).get("accepted", 0) + (steps.get(run["id"]) or {}).get("rejected", 0),
                run["created_at"],
            ),
        )
        own_steps = steps.get(working["id"]) or {}
        for key in counts:
            counts[key] += int(own_steps.get(key) or 0)
        if own_steps.get("pending"):
            every_video_reviewed = False
        if own_steps.get("last_change"):
            step_changes.append(own_steps["last_change"])

    reviewed = every_video_reviewed and counts["accepted"] > 0
    described = reviewed and counts["described"] >= counts["accepted"]
    reached = {
        "videos": min((recording["created_at"] for recording in recordings), default=None),
        "analysed": min(analysed_at, default=None),
        "reviewed": max(step_changes, default=None) if reviewed else None,
        "described": max(step_changes, default=None) if described else None,
        "pathway": min(figure_at, default=None),
        "exported": min(exported_at, default=None),
    }
    return {
        "id": project["id"],
        "name": project["name"],
        "created_at": project["created_at"],
        "last_change": max((change for change in changes if change), default=None),
        "videos": len(recordings),
        "video_minutes": round(sum(recording["duration_ms"] or 0 for recording in recordings) / 60000, 1),
        "videos_analysed": analysed,
        "runs": runs,
        "runs_failed": failed,
        "runs_active": active,
        "failed_unretried": failed_unretried,
        "settings_changed": sorted(changed_settings),
        **counts,
        "reached": reached,
    }
