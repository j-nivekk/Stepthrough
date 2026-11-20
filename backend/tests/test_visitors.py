"""Visitor accounts: shared accounts with limits, whose projects go after a while (see app/visitors.py)."""

from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import app.storage as storage
from app import account_routes, accounts, main, project_file, server_settings, visitors
from app.repository import get_project, list_usage_accounts, set_project_member
from app.user_admin import AccountError, account_tags, create_account, import_accounts

PASSWORD = "test visitor account password"


def ok(response):
    assert response.status_code in (200, 204), response.text
    return response.json() if response.status_code == 200 else None


@pytest.fixture()
def logins(client, monkeypatch):
    monkeypatch.setattr(main.app.state, "auth_mode", "password")
    monkeypatch.setattr(accounts, "PASSWORD_ITERATIONS", 1000)
    monkeypatch.setattr(account_routes, "login_limiter", accounts.LoginLimiter())
    opened: list[TestClient] = []

    def log_in(name: str, *, first: bool = False) -> TestClient:
        tab = client if first else TestClient(main.app)
        if not first:
            opened.append(tab)
        ok(tab.post("/auth/login", json={"name": name, "password": PASSWORD}))
        return tab

    try:
        yield log_in
    finally:
        for tab in opened:
            tab.close()


@pytest.fixture()
def visitor(logins):
    create_account("guest", tags=["visitor"], password=PASSWORD)
    return logins("guest", first=True)


def setting(monkeypatch, **values):
    for key, value in values.items():
        monkeypatch.setitem(server_settings._changed, key, value)


def upload(tab: TestClient, project_id: str, name: str, data: bytes):
    return tab.post("/recordings/import", data={"project_id": project_id}, files={"file": (name, data, "video/mp4")})


def test_visitor_and_shared_never_go_together():
    for tags in (["visitor", "shared"], ["visitor", "admin"], ["shared", "admin"]):
        with pytest.raises(AccountError):
            account_tags(tags)
    assert account_tags(["visitor", "group-a"]) == ["group-a", "visitor"]


def test_a_list_of_people_cannot_make_an_account_both(client):
    listed = b"name,tags\nann,visitor\nbob,shared visitor\ncarl,shared\n"
    result = import_accounts(listed)
    assert sorted(account["name"] for account, _link in result.created) == ["ann", "carl"]
    assert [(row, name) for row, name, _why in result.errors] == [(3, "bob")]
    assert "shared or a visitor" in result.errors[0][2]
    # tags for everyone on the list count too
    result = import_accounts(b"name,tags\ndora,visitor\n", tags=["shared"])
    assert not result.created and result.errors[0][1] == "dora"


def test_the_admin_panel_refuses_both(logins):
    create_account("admin", tags=["admin"], password=PASSWORD)
    guest, _link = create_account("guest", tags=["visitor"], password=PASSWORD)
    tab = logins("admin", first=True)
    assert tab.post("/admin/users", json={"name": "mixed", "tags": ["shared", "visitor"]}).status_code == 422
    assert tab.patch(f"/admin/users/{guest['id']}", json={"tags": ["visitor", "shared"]}).status_code == 422


def test_a_visitor_account_works_as_a_shared_one(visitor):
    assert visitor.get("/me/live").status_code == 200
    refused = visitor.post("/me/password", json={"current_password": PASSWORD, "new_password": "a brand new passphrase"})
    assert refused.status_code == 403
    me = ok(visitor.get("/me"))
    assert me["visitor"]["keep_hours"] == 72
    assert me["visitor"]["storage_limit_bytes"] == 2000 * 1024 * 1024


def test_a_visitors_project_says_when_it_goes_and_then_goes(visitor, logins, video_factory, monkeypatch):
    setting(monkeypatch, visitor_keep_hours=10)
    project = ok(visitor.post("/projects", json={"name": "Trying it"}))
    made = datetime.fromisoformat(project["created_at"])
    assert datetime.fromisoformat(project["deletes_at"]) == made + timedelta(hours=10)
    video = video_factory("walkthrough.mp4", ["red", "blue"])
    ok(upload(visitor, project["id"], video.name, video.read_bytes()))
    folder = storage.project_dir(project["slug"], project["id"])
    assert folder.exists()

    # a project a regular account owns as well stays
    teacher, _link = create_account("teacher", password=PASSWORD)
    kept = ok(visitor.post("/projects", json={"name": "With a teacher"}))
    set_project_member(kept["id"], teacher["id"], "owner")
    assert {entry["name"]: entry["deletes_at"] for entry in ok(visitor.get("/projects"))}["With a teacher"] is None

    assert main.delete_due_visitor_projects(made + timedelta(hours=9)) == []
    assert main.delete_due_visitor_projects(made + timedelta(hours=10, minutes=1)) == ["Trying it"]
    assert not folder.exists()
    assert [entry["name"] for entry in ok(visitor.get("/projects"))] == ["With a teacher"]


def test_regular_projects_have_no_deletion_time(logins):
    create_account("ordinary", password=PASSWORD)
    tab = logins("ordinary", first=True)
    assert ok(tab.post("/projects", json={"name": "Mine"}))["deletes_at"] is None
    assert main.delete_due_visitor_projects(datetime.now(timezone.utc) + timedelta(days=3650)) == []
    assert ok(tab.get("/me"))["visitor"] is None


def test_a_visitor_uploads_within_its_limits(visitor, video_factory, monkeypatch):
    project_id = ok(visitor.post("/projects", json={"name": "Limits"}))["id"]
    setting(monkeypatch, visitor_upload_mb=1)
    refused = upload(visitor, project_id, "big.mp4", b"\0" * (1024 * 1024 + 10))
    assert refused.status_code == 413 and "of this account" in refused.json()["detail"]

    setting(monkeypatch, visitor_upload_mb=None, visitor_storage_mb=1)
    video = video_factory("small.mp4", ["red"])
    ok(upload(visitor, project_id, video.name, video.read_bytes()))
    refused = upload(visitor, project_id, "more.mp4", b"\0" * (1024 * 1024))
    assert refused.status_code == 413 and "of 1 MB left" in refused.json()["detail"]


def test_a_project_file_counts_against_a_visitors_room(visitor, video_factory, monkeypatch):
    project_id = ok(visitor.post("/projects", json={"name": "Room"}))["id"]
    video = video_factory("walkthrough.mp4", ["red", "blue", "green"])
    ok(upload(visitor, project_id, video.name, video.read_bytes()))
    data = visitor.get(f"/projects/{project_id}/project-file").content
    other = ok(visitor.post("/projects", json={"name": "Second"}))
    # refused before the upload is taken in, when the request says how large it is
    monkeypatch.setattr(visitors, "room_left", lambda user: len(data) // 2)
    refused = visitor.post(f"/projects/{other['id']}/project-file", files={"file": ("p.stepthrough.zip", data, "application/zip")})
    assert refused.status_code == 413 and "does not fit" in refused.json()["detail"]
    # and by the import itself, from what the file holds
    with pytest.raises(project_file.ProjectFileError, match="no room"):
        project_file.import_into(io.BytesIO(data), get_project(other["id"]), room_bytes=10, too_full=lambda needed: "no room")
    assert ok(visitor.get(f"/projects/{other['id']}"))["recordings"] == []


def test_reports_mark_visitors(client):
    create_account("guest", tags=["visitor", "group-a"], password=PASSWORD)
    create_account("group", tags=["shared"], password=PASSWORD)
    marks = {account["name"]: (account["shared"], account["visitor"]) for account in list_usage_accounts().values()}
    assert marks["guest"] == (False, True) and marks["group"] == (True, False)
