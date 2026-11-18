"""The progress report for the teaching team (app/progress.py): how far each group has got, read from its projects."""

from __future__ import annotations

import json
from uuid import uuid4

from app import progress
from app.database import connect
from app.user_admin import create_account
from tests.test_usage import PASSWORD, ok, server  # noqa: F401 - the fixture

NOW = "2026-11-10T10:00:00+00:00"


def _project(account_id: str, name: str) -> str:
    project_id = uuid4().hex
    with connect() as conn:
        conn.execute("INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)", (project_id, name, name.lower(), NOW))
        conn.execute(
            "INSERT INTO project_members (project_id, member, role, created_at) VALUES (?, ?, 'owner', ?)",
            (project_id, account_id, NOW),
        )
    return project_id


def _video(project_id: str, created_at: str = NOW) -> str:
    recording_id = uuid4().hex
    with connect() as conn:
        conn.execute(
            "INSERT INTO recordings (id, project_id, filename, slug, source_path, duration_ms, width, height, fps, created_at)"
            " VALUES (?, ?, 'a.mp4', 'a', 'a.mp4', 120000, 390, 844, 30, ?)",
            (recording_id, project_id, created_at),
        )
    return recording_id


def _run(recording_id: str, status: str, created_at: str, stable: dict | None = None, steps: list[dict] = ()) -> str:
    run_id = uuid4().hex
    with connect() as conn:
        conn.execute(
            "INSERT INTO detection_runs (id, recording_id, status, analysis_engine, analysis_stable, detector_mode, tolerance,"
            " min_scene_gap_ms, extract_offset_ms, created_at, completed_at, updated_at)"
            " VALUES (?, ?, ?, 'stable_v3', ?, 'content', 50, 900, 200, ?, ?, ?)",
            (run_id, recording_id, status, json.dumps(stable) if stable else None, created_at,
             created_at if status == "completed" else None, created_at),
        )
        for index, step in enumerate(steps):
            conn.execute(
                "INSERT INTO candidate_frames (id, run_id, recording_id, detector_index, candidate_origin, timestamp_ms,"
                " timestamp_tc, image_path, status, title, notes, screen_link, screen_kind, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, '00:00', 'x.png', ?, ?, ?, ?, ?, ?, ?)",
                (uuid4().hex, run_id, recording_id, index, step.get("origin", "detected"), index * 1000,
                 step.get("status", "pending"), step.get("title"), step.get("notes"), step.get("link"), step.get("kind"),
                 created_at, step.get("at", created_at)),
            )
    return run_id


def test_progress_follows_each_video_by_its_working_analysis(client) -> None:  # client: a database of its own
    group, _ = create_account("group", tags=["shared", "group-a"], password=PASSWORD)
    create_account("idle", tags=["shared", "group-b"], password=PASSWORD)
    create_account("teacher", tags=["admin"], password=PASSWORD)
    project = _project(group["id"], "Interview app")

    first = _video(project, "2026-11-02T09:00:00+00:00")
    _run(first, "failed", "2026-11-02T09:05:00+00:00")
    # Two analyses: the second has more decisions, so it is the working one; its settings differ from the defaults.
    _run(first, "completed", "2026-11-02T09:10:00+00:00", steps=[{"status": "accepted"}, {"status": "pending"}])
    working = _run(
        first,
        "completed",
        "2026-11-03T09:00:00+00:00",
        stable={"recording_type": "phone", "min_dwell_ms": 800, "ignore_regions": [], "scroll_mode": "each_stop"},
        steps=[
            {"status": "accepted", "title": "Home", "at": "2026-11-04T10:00:00+00:00"},
            {"status": "accepted", "notes": "  ", "kind": "popup"},  # blank notes describe nothing
            {"status": "rejected"},
            {"status": "accepted", "origin": "manual", "title": "Added", "link": "new"},
        ],
    )
    second = _video(project, "2026-11-05T09:00:00+00:00")
    _run(second, "completed", "2026-11-05T09:30:00+00:00", steps=[{"status": "pending"}])
    _run(second, "failed", "2026-11-06T09:00:00+00:00")  # its latest analysis failed and was not run again

    report = progress.report()
    assert [account["name"] for account in report["accounts"]] == ["group", "idle"]  # administrators are left out
    (row,) = report["accounts"][0]["projects"]
    assert report["accounts"][0]["tags"] == ["group-a"] and report["accounts"][1]["projects"] == []
    assert (row["videos"], row["videos_analysed"], row["runs"], row["runs_failed"], row["failed_unretried"]) == (2, 2, 5, 2, 1)
    assert row["settings_changed"] == ["min_dwell_ms"]
    assert (row["found"], row["added"], row["accepted"], row["rejected"], row["pending"]) == (3 + 1, 1, 3, 1, 1)
    assert (row["described"], row["corrections"]) == (2, 2)
    reached = row["reached"]
    assert reached["videos"] == "2026-11-02T09:00:00+00:00" and reached["analysed"] == "2026-11-02T09:10:00+00:00"
    assert reached["reviewed"] is None and reached["pathway"] is None  # the second video still has an undecided step

    with connect() as conn:
        conn.execute("UPDATE candidate_frames SET status = 'accepted', title = 'Feed' WHERE status = 'pending'")
        conn.execute("UPDATE candidate_frames SET notes = 'menu' WHERE run_id = ? AND screen_kind = 'popup'", (working,))
        conn.execute("UPDATE detection_runs SET figure_downloaded_at = ? WHERE id = ?", ("2026-11-07T11:00:00+00:00", working))
        conn.execute(
            "INSERT INTO export_bundles (id, run_id, output_dir, zip_path, item_count, created_at) VALUES ('e1', ?, 'o', 'z', 3, ?)",
            (working, "2026-11-07T12:00:00+00:00"),
        )
    (row,) = progress.report()["accounts"][0]["projects"]
    assert row["reached"]["reviewed"] and row["reached"]["described"]
    assert row["reached"]["pathway"] == "2026-11-07T11:00:00+00:00" and row["reached"]["exported"] == "2026-11-07T12:00:00+00:00"
    assert [account["name"] for account in progress.report("group-b")["accounts"]] == ["idle"]


def test_a_downloaded_figure_counts_for_groups_only(server) -> None:  # noqa: F811
    create_account("group", tags=["shared"], password=PASSWORD)
    create_account("teacher", tags=["admin"], password=PASSWORD)
    teacher = server("teacher", first=True)
    group = server("group")
    project_id = ok(group.post("/projects", json={"name": "One"}))["id"]
    run_id = _run(_video(project_id), "completed", NOW, steps=[{"status": "accepted"}])

    ok(teacher.post(f"/runs/{run_id}/pathway/figure", json={"format": "svg"}))  # administrators are not counted
    assert progress.report()["accounts"][0]["projects"][0]["reached"]["pathway"] is None
    ok(group.post(f"/runs/{run_id}/pathway/figure", json={"format": "png"}))
    first = progress.report()["accounts"][0]["projects"][0]["reached"]["pathway"]
    ok(group.post(f"/runs/{run_id}/pathway/figure", json={"format": "svg"}))  # the first time is kept
    assert first and progress.report()["accounts"][0]["projects"][0]["reached"]["pathway"] == first
    assert group.post(f"/runs/{run_id}/pathway/figure", json={"format": "gif"}).status_code == 422
    assert ok(teacher.get("/admin/progress"))["accounts"][0]["name"] == "group"
    assert group.get("/admin/progress").status_code == 403


def test_corrections_and_time_per_stage_reach_the_usage_report(server) -> None:  # noqa: F811
    from datetime import datetime, timedelta, timezone

    from app.repository import insert_usage_events, list_usage_events

    group, _ = create_account("group", tags=["shared"], password=PASSWORD)
    create_account("teacher", tags=["admin"], password=PASSWORD)
    teacher = server("teacher", first=True)
    member = server("group")
    project_id = ok(member.post("/projects", json={"name": "One"}))["id"]
    run_id = _run(_video(project_id), "completed", NOW, steps=[{"status": "accepted"}, {"status": "accepted"}])
    first, second = (row["id"] for row in ok(member.get(f"/runs/{run_id}"))["candidates"])

    ok(member.patch(f"/candidates/{second}", json={"screen_link": first}))
    ok(member.patch(f"/candidates/{second}", json={"screen_link": "new", "screen_kind": "popup"}))
    ok(member.patch(f"/candidates/{second}", json={"screen_link": "auto"}))
    for event in ({"kind": "comparison_opened"}, {"kind": "boxes_switched", "to": "steps"}, {"kind": "guide_opened", "from": "tutorial"},
                  {"kind": "guide_opened", "from": "elsewhere"}):  # counted, without the place it is not linked from
        ok(member.post("/me/usage", json={"events": [event]}))

    # Twenty minutes in one browser: ten on the projects, then the pathway; five of them making changes.
    start = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(hours=2)
    start -= timedelta(minutes=start.minute % 5)
    rows = [((start + timedelta(minutes=minute)).isoformat(), group["id"], "b9", "open", None) for minute in range(0, 20, 5)]
    rows.append(((start + timedelta(minutes=9)).isoformat(), group["id"], "b9", "page", '{"name":"pathway"}'))
    rows.append(((start + timedelta(minutes=10)).isoformat(), group["id"], "b9", "working", None))
    insert_usage_events(rows)

    report = ok(teacher.get("/admin/usage", params={"days": 1}))
    totals = report["totals"]
    assert totals["corrections"] == 4
    assert totals["corrections_by_choice"] == {"same_screen": 1, "new_screen": 1, "popup": 1, "automatic": 1}
    assert (totals["comparisons"], totals["boxes_switched"], totals["guide_opened"]) == (1, 1, 2)
    assert [json.loads(row["detail"] or "{}") for row in list_usage_events("2000") if row["kind"] == "guide_opened"] == [
        {"from": "tutorial"}, {}]
    (row,) = report["accounts"]
    assert row["corrections"] == 4 and row["comparisons"] == 1 and row["active_days"] == 1
    assert row["stage_minutes"]["pathway"] == 10 and row["stage_minutes"]["projects"] >= 10
    # five minutes from the inserted browser, and the slot(s) of the corrections made above
    assert sum(row["worked"]) >= 10 and len(row["worked"]) == len(report["days_list"])
    assert "long" not in report
    long = ok(teacher.get("/admin/usage", params={"days": 1, "long": True}))["long"]
    measures = {measure: value for name, _date, measure, value in long if name == "group"}
    assert measures["pathway corrections"] == 4 and measures["minutes in the app"] >= 20 and measures["comparisons"] == 1
