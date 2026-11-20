"""The usage report for the teaching team (app/usage.py): what is recorded, what is not, and what it adds up to."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import account_routes, accounts, main, usage
from app.repository import insert_usage_events, list_usage_events
from app.user_admin import create_account

PASSWORD = "test usage password"


def ok(response):
    assert response.status_code in (200, 204), response.text
    return response.json() if response.status_code == 200 else None


@pytest.fixture()
def server(client, monkeypatch):
    """A server with logins; returns a function that logs a new browser in to an account."""
    monkeypatch.setattr(main.app.state, "auth_mode", "password")
    monkeypatch.setattr(accounts, "PASSWORD_ITERATIONS", 1000)
    monkeypatch.setattr(account_routes, "login_limiter", accounts.LoginLimiter())
    usage._log.queue.clear()  # nothing left over from another test's database
    opened: list[TestClient] = []

    def browser(name: str, *, first: bool = False) -> TestClient:
        tab = client if first else TestClient(main.app)
        if not first:
            opened.append(tab)
        ok(tab.post("/auth/login", json={"name": name, "password": PASSWORD}))
        return tab

    try:
        yield browser
    finally:
        for tab in opened:
            tab.close()


def events(kind: str | None = None) -> list[dict]:
    usage.flush()
    rows = list_usage_events("2000-01-01")
    return [row for row in rows if kind is None or row["kind"] == kind]


def a_task(tab: TestClient, video_factory) -> tuple[str, list[str]]:
    project_id = ok(tab.post("/projects", json={"name": "Usage"}))["id"]
    video = video_factory("walkthrough.mp4", ["red", "blue", "green"])
    recording_id = ok(tab.post(
        "/recordings/import", data={"project_id": project_id}, files={"file": (video.name, video.read_bytes(), "video/mp4")}
    ))["id"]
    run_id = ok(tab.post(f"/recordings/{recording_id}/runs", json={"stable": {"recording_type": "phone"}}))["id"]
    for _ in range(200):
        detail = ok(tab.get(f"/runs/{run_id}"))
        if detail["summary"]["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert detail["summary"]["status"] == "completed"
    return run_id, [step["id"] for step in detail["candidates"]]


def test_what_people_do_is_recorded_without_what_they_write(server, video_factory) -> None:
    create_account("group", tags=["shared"], password=PASSWORD)
    a = server("group", first=True)
    b = server("group")
    run_id, steps = a_task(a, video_factory)
    ok(a.patch(f"/candidates/{steps[0]}", json={"status": "accepted", "title": "a private title"}))
    ok(b.post(f"/runs/{run_id}/candidates/status", json={"candidate_ids": steps[1:], "status": "rejected"}))
    ok(b.post(f"/runs/{run_id}/export", json={"mode": "all"}))

    kinds = [row["kind"] for row in events()]
    for kind in ("login", "open", "working", "project_created", "recording_uploaded", "analysis_started",
                 "analysis_finished", "step_decided", "step_annotated", "steps_decided", "exported"):
        assert kind in kinds, kind
    everything = repr(events())
    assert "private title" not in everything and "walkthrough" not in everything and "Usage" not in everything
    # two logins in two browsers: two browser keys, and each browser has one "open" per five minutes at most
    assert len({row["browser"] for row in events("login")}) == 2
    opens = [(row["browser"], row["at"]) for row in events("open")]
    assert len(opens) == len(set(opens)) and len(opens) <= 4
    finished = events("analysis_finished")[0]
    assert '"status":"completed"' in finished["detail"] and '"steps":' in finished["detail"]


def test_administrators_and_computers_without_logins_are_not_counted(server, client, monkeypatch) -> None:
    create_account("teacher", tags=["admin"], password=PASSWORD)
    tab = server("teacher", first=True)
    ok(tab.post("/projects", json={"name": "Demo"}))
    assert events() == []
    monkeypatch.setattr(main.app.state, "auth_mode", "none")  # Stepthrough on one's own computer
    ok(client.post("/projects", json={"name": "Mine"}))
    ok(client.post("/me/usage", json={"events": [{"kind": "page", "name": "projects"}]}))
    assert events() == []


def test_browsers_report_only_what_is_allowed(server) -> None:
    create_account("ordinary", password=PASSWORD)
    tab = server("ordinary", first=True)
    ok(tab.post("/me/usage", json={"events": [
        {"kind": "page", "name": "pathway"},
        {"kind": "page", "name": "somewhere else"},
        {"kind": "tutorial_lesson", "lesson": 3},
        {"kind": "tutorial_lesson", "lesson": 99},
        {"kind": "tutorial_closed", "solved": 2, "minutes": 7, "comment": "free text is dropped"},
        {"kind": "anything", "name": "projects"},
    ]}))
    rows = [(row["kind"], row["detail"]) for row in events() if row["kind"] not in ("login", "open", "working")]
    assert rows == [
        ("page", '{"name":"pathway"}'),
        ("page", None),
        ("tutorial_lesson", '{"lesson":3}'),
        ("tutorial_lesson", None),
        ("tutorial_closed", '{"solved":2,"minutes":7}'),
    ]
    assert tab.post("/me/usage", json={"events": [{"kind": "page"}] * 51}).status_code == 422


def test_the_report_adds_it_up_in_local_time(server) -> None:
    create_account("group", tags=["shared"], password=PASSWORD)
    create_account("teacher", tags=["admin"], password=PASSWORD)
    member = server("group", first=True)
    for event in (
        {"kind": "tutorial_invited"},
        {"kind": "tutorial_opened", "from": "invitation"},
        {"kind": "tutorial_lesson", "lesson": 1},
        {"kind": "tutorial_solved", "lesson": 1},
        {"kind": "tutorial_show_me", "lesson": 2},
        {"kind": "tutorial_lesson", "lesson": 2},
        {"kind": "figure_downloaded", "format": "png"},
    ):
        ok(member.post("/me/usage", json={"events": [event]}))
    ok(member.post("/projects", json={"name": "One"}))
    teacher = server("teacher")

    report = ok(teacher.get("/admin/usage", params={"days": 7}))
    assert report["keep_days"] == 14 and report["days"] == 7
    assert report["totals"]["browsers"] == 1 and report["totals"]["logins"] == 1 and report["totals"]["figures"] == 1
    (group,) = report["accounts"]
    assert group["name"] == "group" and group["shared"] and group["projects"] == 1 and group["tutorial_browsers"] == 1
    tutorial = report["tutorial"]
    assert (tutorial["invited"], tutorial["opened"], tutorial["opened_from"]) == (1, 1, {"invitation": 1})
    assert tutorial["lessons"][0] == {"lesson": 1, "reached": 1, "solved": 1, "show_me": 0}
    assert tutorial["lessons"][1] == {"lesson": 2, "reached": 1, "solved": 0, "show_me": 1}

    hour_utc = datetime.now(timezone.utc).hour
    by_hour = {row["hour"]: row["open"] for row in report["hours"]}
    assert by_hour[hour_utc] == 1
    shifted = ok(teacher.get("/admin/usage", params={"days": 7, "tz": 120}))
    assert {row["hour"]: row["open"] for row in shifted["hours"]}[(hour_utc + 2) % 24] == 1
    assert sum(day["open"] for day in shifted["days_list"]) == 1
    assert member.get("/admin/usage").status_code == 403


def test_events_go_after_the_keeping_time(server) -> None:
    create_account("teacher", tags=["admin"], password=PASSWORD)
    teacher = server("teacher", first=True)
    old = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
    recent = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    insert_usage_events([(old, "x", "b1", "open", None), (recent, "x", "b2", "open", None)])
    assert usage.purge(14) == 1
    assert [row["browser"] for row in events()] == ["b2"]

    ok(teacher.patch("/admin/server-settings", json={"usage_keep_days": 2}))  # shorter: applies at once
    assert events() == []
    ok(teacher.patch("/admin/server-settings", json={"usage_keep_days": 0}))  # 0: nothing is recorded
    assert teacher.get("/admin/usage").status_code == 409
    ok(teacher.post("/auth/logout"))
    assert events() == []


def test_usage_can_be_kept_for_ever_or_for_a_chosen_number_of_days(server) -> None:
    create_account("teacher", tags=["admin"], password=PASSWORD)
    teacher = server("teacher", first=True)
    long_ago = (datetime.now(timezone.utc) - timedelta(days=200)).isoformat()
    insert_usage_events([(long_ago, "x", "b1", "open", None)])

    settings = ok(teacher.patch("/admin/server-settings", json={"usage_keep_days": None}))  # null: for ever
    assert settings["usage_keep_days"] == {"value": None, "default": 14}
    assert usage.purge(None) == 0 and [row["browser"] for row in events()] == ["b1"]
    ok(teacher.patch("/admin/server-settings", json={"compression": False}))  # left out: unchanged
    assert ok(teacher.get("/admin/server-settings"))["usage_keep_days"]["value"] is None

    everything = ok(teacher.get("/admin/usage", params={"days": 0}))  # everything kept, from the oldest event
    assert everything["keep_days"] is None and everything["days"] >= 200

    ok(teacher.patch("/admin/server-settings", json={"usage_keep_days": 365}))  # longer than the old 90 days
    assert [row["browser"] for row in events()] == ["b1"]
    ok(teacher.patch("/admin/server-settings", json={"usage_keep_days": 56}))  # shorter: applies at once
    assert events() == []
    assert teacher.patch("/admin/server-settings", json={"usage_keep_days": 5000}).status_code == 422


def test_a_report_covers_whole_local_days_or_the_dates_chosen(server) -> None:
    create_account("group", tags=["shared", "group-a"], password=PASSWORD)
    create_account("other", tags=["shared", "group-b"], password=PASSWORD)
    create_account("teacher", tags=["admin"], password=PASSWORD)
    teacher = server("teacher", first=True)
    group, other = (server(name) for name in ("group", "other"))
    ok(group.post("/projects", json={"name": "One"}))
    ok(other.post("/projects", json={"name": "Two"}))
    today = datetime.now(timezone.utc).date()

    week = ok(teacher.get("/admin/usage", params={"days": 7}))
    assert week["days"] == 7 and len(week["days_list"]) == 7 and week["end"] == today.isoformat()
    chosen = ok(teacher.get("/admin/usage", params={"start": (today - timedelta(days=2)).isoformat()}))
    assert (chosen["start"], chosen["end"], chosen["days"]) == ((today - timedelta(days=2)).isoformat(), today.isoformat(), 3)
    past = ok(teacher.get("/admin/usage", params={"start": "2020-01-01", "end": "2020-01-31"}))
    assert past["accounts"] == [] and past["totals"]["logins"] == 0  # nothing kept from then
    assert teacher.get("/admin/usage", params={"start": "2026-02-01", "end": "2026-01-01"}).status_code == 422

    one_class = ok(teacher.get("/admin/usage", params={"days": 7, "tag": "group-a"}))
    assert [row["name"] for row in one_class["accounts"]] == ["group"] and one_class["tag"] == "group-a"
    assert [row["name"] for row in ok(teacher.get("/admin/usage", params={"days": 7}))["accounts"]] == ["group", "other"]
    traffic_names = {row["name"] for row in ok(teacher.get("/admin/traffic", params={"days": 7, "tag": "group-b"}))["accounts"]}
    assert traffic_names == {"other"}


# ── traffic (app/traffic.py) ────────────────────────────────────────────────────────────────────────────────────


def test_traffic_is_counted_per_account_and_kind_as_it_goes_over_the_network(server, video_factory) -> None:
    from app import traffic
    from app.repository import list_traffic

    traffic.flush()
    create_account("group", tags=["shared"], password=PASSWORD)
    create_account("teacher", tags=["admin"], password=PASSWORD)
    member = server("group", first=True)
    project_id = ok(member.post("/projects", json={"name": "Traffic"}))["id"]
    video = video_factory("walkthrough.mp4", ["red", "blue"])
    upload = video.read_bytes()
    ok(member.post("/recordings/import", data={"project_id": project_id}, files={"file": (video.name, upload, "video/mp4")}))
    teacher = server("teacher")
    plain_size = len(teacher.get("/openapi.json", headers={"Accept-Encoding": "identity"}).content)
    traffic.flush()
    before = sum(row["bytes_out"] for row in list_traffic("2000-01-01"))
    teacher.get("/openapi.json", headers={"Accept-Encoding": "gzip"})
    traffic.flush()
    compressed_sent = sum(row["bytes_out"] for row in list_traffic("2000-01-01")) - before
    TestClient(main.app).get("/auth/session")  # nobody logged in

    traffic.flush()
    by: dict[tuple[str, str], list[int]] = {}
    for row in list_traffic("2000-01-01"):
        key = (row["account_id"], row["category"])
        by[key] = [a + b for a, b in zip(by.get(key, [0, 0, 0]), (row["requests"], row["bytes_in"], row["bytes_out"]))]
    group_id = ok(member.get("/me"))["id"]
    teacher_id = ok(teacher.get("/me"))["id"]
    assert by[(group_id, "uploads")][1] >= len(upload)  # the video and the form around it
    assert by[(group_id, "data")][0] >= 1
    assert by[(teacher_id, "app")][0] == 2  # the API description ends in a file name, like the app's own files
    assert 0 < compressed_sent < plain_size / 4  # counted as sent over the network: compressed
    assert by[("", "data")][0] >= 1  # before a login: nobody's

    report = ok(teacher.get("/admin/traffic", params={"days": 1, "tz": 60}))
    assert report["totals"]["bytes_in"] >= len(upload)
    assert [kind["category"] for kind in report["categories"]][:3] == ["uploads", "media", "exports"]
    accounts = {entry["name"]: entry for entry in report["accounts"]}
    assert accounts["group"]["shared"] and accounts["teacher"]["admin"] and "not logged in" in accounts
    assert max(report["accounts"], key=lambda entry: entry["bytes_in"])["name"] == "group"  # the upload
    assert accounts["group"]["categories"]["uploads"] >= len(upload)
    assert sum(hour["bytes_in"] for hour in report["hours"]) == report["totals"]["bytes_in"]
    assert sum(day["bytes_in"] for day in report["days_list"]) == report["totals"]["bytes_in"]
    assert report["busiest_hour"]["bytes"] > 0
    assert member.get("/admin/traffic").status_code == 403


def test_traffic_goes_after_the_keeping_time(server) -> None:
    from app import traffic
    from app.repository import add_traffic, list_traffic

    old = (datetime.now(timezone.utc) - timedelta(days=20)).replace(minute=0, second=0, microsecond=0).isoformat()
    add_traffic([(old, "x", "data", 1, 10, 20)])
    add_traffic([(old, "x", "data", 2, 5, 5)])  # the same hour adds up
    assert [(row["requests"], row["bytes_in"], row["bytes_out"]) for row in list_traffic("2000-01-01")] == [(3, 15, 25)]
    traffic.purge(14)
    assert list_traffic("2000-01-01") == []


def test_whole_projects_downloaded_and_brought_in_are_counted(server, video_factory) -> None:
    create_account("group", tags=["shared"], password=PASSWORD)
    create_account("teacher", tags=["admin"], password=PASSWORD)
    member = server("group", first=True)
    run_id, _steps = a_task(member, video_factory)
    recording_id = ok(member.get(f"/runs/{run_id}"))["summary"]["recording_id"]
    project_id = ok(member.get(f"/recordings/{recording_id}"))["project_id"]
    data = member.get(f"/projects/{project_id}/project-file").content
    ok(member.post("/projects/project-file", files={"file": ("p.stepthrough.zip", data, "application/zip")}))
    teacher = server("teacher")
    (group,) = ok(teacher.get("/admin/usage", params={"days": 7}))["accounts"]
    assert (group["project_downloads"], group["project_imports"]) == (1, 1)
