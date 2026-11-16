"""Shared accounts: many browsers signed in to one account at once (see app/live.py)."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Event
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient

from app import account_routes, accounts, live, main
from app.user_admin import create_account

PASSWORD = "test shared account password"


def browser_headers(name: str) -> dict[str, str]:
    return {live.CLIENT_HEADER: name}


def ok(response):
    assert response.status_code in (200, 204), response.text
    return response.json() if response.status_code == 200 else None


@pytest.fixture()
def logins(client, monkeypatch):
    monkeypatch.setattr(main.app.state, "auth_mode", "password")
    monkeypatch.setattr(accounts, "PASSWORD_ITERATIONS", 1000)
    monkeypatch.setattr(account_routes, "login_limiter", accounts.LoginLimiter())
    opened: list[TestClient] = []

    def log_in(name: str, browser: str, *, first: bool = False) -> TestClient:
        tab = client if first else TestClient(main.app)
        if not first:
            opened.append(tab)
        tab.headers.update(browser_headers(browser))
        ok(tab.post("/auth/login", json={"name": name, "password": PASSWORD}))
        return tab

    try:
        yield log_in
    finally:
        for tab in opened:
            tab.close()


@pytest.fixture()
def group(logins):
    """Two browsers, A and B, both signed in to the shared account ``group``."""
    create_account("group", tags=["shared"], password=PASSWORD)
    return logins("group", "browser-a", first=True), logins("group", "browser-b")


def start(tab: TestClient) -> dict:
    """Where a browser begins: the current change number and epoch."""
    return ok(tab.get("/me/live"))


def changes(tab: TestClient, since: dict, wait: float = 0) -> dict:
    return ok(tab.get("/me/live", params={"after": since["seq"], "epoch": since["epoch"], "wait": wait}))


def kinds(feed: dict) -> list[str]:
    return [event["kind"] for event in feed["events"] if event["kind"] != "state"]


def a_task(tab: TestClient, video_factory, steps: int = 2) -> tuple[str, str, str, list[str]]:
    """A project with one recording and a task with ``steps`` steps added by hand."""
    project_id = ok(tab.post("/projects", json={"name": "Group project"}))["id"]
    video = video_factory("walkthrough.mp4", ["red", "blue", "green"])
    recording_id = ok(tab.post(
        "/recordings/import", data={"project_id": project_id}, files={"file": (video.name, video.read_bytes(), "video/mp4")}
    ))["id"]
    run_id = ok(tab.post(f"/recordings/{recording_id}/runs/manual"))["id"]
    step_ids = [ok(tab.post(f"/runs/{run_id}/candidates/manual", json={"timestamp_ms": 400 + 900 * i}))["id"] for i in range(steps)]
    return project_id, recording_id, run_id, step_ids


def test_every_change_reaches_the_other_browsers(group, video_factory):
    a, b = group
    since = start(b)
    assert since["reset"] and since["events"] == []

    project_id = ok(a.post("/projects", json={"name": "Shared project"}))["id"]
    feed = changes(b, since)
    assert kinds(feed) == ["projects"]
    assert feed["events"][0]["project_id"] == project_id and feed["events"][0]["by"] == "browser-a"
    assert project_id in {project["id"] for project in ok(b.get("/projects"))}

    since = feed
    video = video_factory("walkthrough.mp4", ["red", "blue"])
    recording_id = ok(a.post(
        "/recordings/import", data={"project_id": project_id}, files={"file": (video.name, video.read_bytes(), "video/mp4")}
    ))["id"]
    run_id = ok(b.post(f"/recordings/{recording_id}/runs/manual"))["id"]
    step = ok(a.post(f"/runs/{run_id}/candidates/manual", json={"timestamp_ms": 500}))
    ok(b.patch(f"/candidates/{step['id']}", json={"status": "accepted", "title": "Home"}))
    feed = changes(a, since)
    assert kinds(feed) == ["project", "recording", "run", "candidate"]
    candidate_event = feed["events"][-1]
    assert candidate_event["by"] == "browser-b" and candidate_event["run_id"] == run_id
    assert candidate_event["candidate"]["status"] == "accepted" and candidate_event["candidate"]["title"] == "Home"

    since = feed
    ok(a.patch(f"/projects/{project_id}", json={"name": "Renamed", "previous_name": "Shared project"}))
    ok(a.post(f"/runs/{run_id}/export", json={"mode": "auto"}))
    ok(b.delete(f"/projects/{project_id}"))
    assert kinds(changes(a, since)) == ["projects", "run", "project_deleted"]


def test_a_waiting_browser_hears_of_a_change_at_once(group):
    a, b = group
    since = start(b)
    with ThreadPoolExecutor(1) as pool:
        began = time.monotonic()
        waiting = pool.submit(changes, b, since, 10)
        time.sleep(0.5)
        assert not waiting.done(), "the long poll answered without a change"
        ok(a.post("/projects", json={"name": "Now"}))
        feed = waiting.result(timeout=5)
    assert kinds(feed) == ["projects"]
    assert time.monotonic() - began < 3


def test_a_browser_that_missed_too_much_loads_everything_again(group, monkeypatch):
    a, b = group
    since = start(b)
    monkeypatch.setattr(live, "KEEP_EVENTS", 3)
    main._live()._feeds.clear()  # feeds made from now on keep 3 events
    since = start(b)
    for number in range(5):
        ok(a.post("/projects", json={"name": f"Project {number}"}))
    assert changes(b, since)["reset"]
    assert changes(b, {**since, "epoch": "an earlier server"})["reset"]


def test_text_saved_meanwhile_is_not_written_over(group, video_factory):
    a, b = group
    _project, _recording, _run, (step_id, _other) = a_task(a, video_factory)
    ok(a.patch(f"/candidates/{step_id}", json={"notes": "A's notes", "previous_notes": ""}))
    refused = b.patch(f"/candidates/{step_id}", json={"notes": "B's notes", "previous_notes": ""})
    assert refused.status_code == 409 and "another browser" in refused.json()["detail"]
    assert ok(b.get(f"/runs/{_run}"))["candidates"][0]["notes"] == "A's notes"
    # from the text it was given, B's change goes through; decisions and screen choices are simply the latest
    ok(b.patch(f"/candidates/{step_id}", json={"notes": "B's notes", "previous_notes": "A's notes"}))
    ok(a.patch(f"/candidates/{step_id}", json={"status": "rejected"}))
    ok(b.patch(f"/candidates/{step_id}", json={"status": "accepted"}))
    step = ok(b.get(f"/runs/{_run}"))["candidates"][0]
    assert (step["notes"], step["status"]) == ("B's notes", "accepted")


def test_a_step_added_by_hand_does_not_undo_a_decision_made_meanwhile(group, video_factory, monkeypatch):
    a, b = group
    _project, _recording, run_id, (first, _second) = a_task(a, video_factory)
    extracting, finish = Event(), Event()
    extract = main.extract_frame

    def slow_extract(*args, **kwargs):
        extracting.set()
        assert finish.wait(10), "the test did not let the step be added"
        return extract(*args, **kwargs)

    monkeypatch.setattr(main, "extract_frame", slow_extract)
    with ThreadPoolExecutor(2) as pool:
        adding = pool.submit(a.post, f"/runs/{run_id}/candidates/manual", json={"timestamp_ms": 1800})
        assert extracting.wait(10)
        since = start(b)
        busy = changes(b, {**since, "seq": since["seq"] - 1})["busy"]
        assert [entry["label"] for entry in busy] == ["adding a step by hand to this task"] and busy[0]["run_id"] == run_id
        deciding = pool.submit(b.patch, f"/candidates/{first}", json={"status": "accepted"})
        time.sleep(0.4)
        assert not deciding.done(), "the decision did not wait for the step being added"
        finish.set()
        ok(adding.result(timeout=10))
        ok(deciding.result(timeout=10))
    steps = ok(b.get(f"/runs/{run_id}"))["candidates"]
    assert len(steps) == 3
    assert next(step for step in steps if step["id"] == first)["status"] == "accepted"
    assert start(b)["busy"] == []


def test_presence_shows_what_another_browser_is_doing_until_it_goes(group, monkeypatch):
    a, b = group
    clock = [1000.0]
    monkeypatch.setattr(live, "monotonic", lambda: clock[0])
    editing = {"kind": "editing", "run_id": "run-1", "candidate_id": "step-1"}
    ok(a.put("/me/presence", json={"targets": [editing, {"kind": "made up"}]}))
    seen = start(b)["presence"]
    assert [entry["client"] for entry in seen] == ["browser-a"]
    assert seen[0]["targets"][0] == {**editing, "since": seen[0]["targets"][0]["since"]}
    # a second browser on the same step comes later: the first keeps it
    clock[0] += 5
    ok(b.put("/me/presence", json={"targets": [editing]}))
    claims = {entry["client"]: entry["targets"][0]["since"] for entry in start(a)["presence"]}
    assert claims["browser-a"] < claims["browser-b"]
    # browser A stops saying so (a closed tab): gone after the time presence lasts
    clock[0] += live.PRESENCE_SECONDS + 1
    ok(b.put("/me/presence", json={"targets": [editing]}))
    assert [entry["client"] for entry in start(b)["presence"]] == ["browser-b"]
    ok(b.put("/me/presence", json={"targets": []}))
    assert start(a)["presence"] == []


def test_several_steps_change_in_one_go(group, video_factory):
    a, b = group
    _project, _recording, run_id, steps = a_task(a, video_factory, steps=3)
    since = start(b)
    ok(a.post(f"/runs/{run_id}/candidates/status", json={"candidate_ids": steps, "status": "accepted"}))
    assert kinds(changes(b, since)) == ["run"]
    assert {step["status"] for step in ok(b.get(f"/runs/{run_id}"))["candidates"]} == {"accepted"}
    assert a.post(f"/runs/{run_id}/candidates/status", json={"candidate_ids": ["not-a-step"], "status": "rejected"}).status_code == 422


def test_two_exports_at_once_are_both_downloadable(group, video_factory):
    a, b = group
    _project, _recording, run_id, _steps = a_task(a, video_factory)
    with ThreadPoolExecutor(2) as pool:
        first, second = pool.map(lambda tab: ok(tab.post(f"/runs/{run_id}/export", json={"mode": "all"})), (a, b))
    assert first["id"] != second["id"]
    for bundle in (first, second):
        download = b.get(bundle["zip_url"])
        assert download.status_code == 200
        with ZipFile(BytesIO(download.content)) as archive:
            assert "steps.json" in archive.namelist()


def test_renaming_from_a_name_changed_meanwhile_is_refused(group, video_factory):
    a, b = group
    project_id, recording_id, _run, _steps = a_task(a, video_factory)
    ok(a.patch(f"/projects/{project_id}", json={"name": "A's name", "previous_name": "Group project"}))
    stale = b.patch(f"/projects/{project_id}", json={"name": "B's name", "previous_name": "Group project"})
    assert stale.status_code == 409 and "A's name" in stale.json()["detail"]
    ok(a.patch(f"/recordings/{recording_id}", json={"filename": "renamed.mp4", "previous_filename": "walkthrough.mp4"}))
    assert b.patch(f"/recordings/{recording_id}", json={"filename": "b.mp4", "previous_filename": "walkthrough.mp4"}).status_code == 409


def test_regular_accounts_keep_working_as_before(logins, video_factory):
    create_account("ordinary", password=PASSWORD)
    tab = logins("ordinary", "browser-a", first=True)
    assert tab.get("/me/live").status_code == 403
    assert tab.put("/me/presence", json={"targets": []}).status_code == 403
    project_id, _recording, run_id, (step_id, _other) = a_task(tab, video_factory)
    ok(tab.patch(f"/candidates/{step_id}", json={"notes": "mine", "previous_notes": "something else"}))
    assert ok(tab.patch(f"/projects/{project_id}", json={"name": "Changed", "previous_name": "stale"}))["name"] == "Changed"
    assert main._live()._feeds == {}  # nothing is announced for accounts that are not shared
    ok(tab.post(f"/runs/{run_id}/candidates/status", json={"candidate_ids": [step_id], "status": "rejected"}))


def test_an_administrator_cannot_be_shared(logins):
    admin, _link = create_account("admin", tags=["admin"], password=PASSWORD)
    ordinary, _link = create_account("ordinary", password=PASSWORD)
    tab = logins("admin", "browser-a", first=True)
    forbidden = {"tags": ["shared", "admin"]}
    assert tab.post("/admin/users", json={"name": "mixed", **forbidden}).status_code == 422
    assert tab.patch(f"/admin/users/{admin['id']}", json=forbidden).status_code == 422
    assert tab.patch(f"/admin/users/{ordinary['id']}", json=forbidden).status_code == 422
    assert tab.get("/me/live").status_code == 403


def test_nobody_changes_the_password_for_the_whole_group(group, logins):
    a, b = group
    refused = a.post("/me/password", json={"current_password": PASSWORD, "new_password": "a brand new passphrase"})
    assert refused.status_code == 403
    assert "administrator" in refused.json()["detail"]
    assert b.get("/me").status_code == 200  # nobody was logged out
    logins("group", "browser-c")  # and the password is the same


def test_the_hub_shows_busy_work_only_while_it_runs():
    hub = live.LiveHub()
    with hub.busy({"group"}, {"run_id": "run-1", "label": "merging two screens"}):
        assert [entry["label"] for entry in hub.snapshot("group", None)["busy"]] == ["merging two screens"]
    assert hub.snapshot("group", None)["busy"] == []
    with hub.busy(set(), {"run_id": "run-1", "label": "nobody to tell"}):
        assert hub._feeds == {"group": hub._feeds["group"]}


def test_presence_keeps_to_what_the_app_shows():
    targets = live.clean_targets([
        {"kind": "uploading", "project_id": "p", "name": "a.mp4", "progress": 3},
        {"kind": "editing", "run_id": "r"},
        "nonsense",
    ])
    assert targets == [{"kind": "uploading", "project_id": "p", "name": "a.mp4", "progress": 1.0}]
