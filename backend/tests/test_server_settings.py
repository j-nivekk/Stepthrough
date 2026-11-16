"""What administrators change while the server runs (app/server_settings.py), and compressed answers
(app/compression.py)."""

from __future__ import annotations

import threading

from fastapi.testclient import TestClient

from app import account_routes, accounts, main, server_settings
from app.services.jobs import JobManager
from app.user_admin import create_account

GZIP = {"Accept-Encoding": "gzip"}
PASSWORD = "test server settings password"


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def a_recording(client: TestClient, video_factory) -> dict:
    project_id = ok(client.post("/projects", json={"name": "Settings"}))["id"]
    video = video_factory("walkthrough.mp4", ["red", "blue"])
    return ok(client.post(
        "/recordings/import", data={"project_id": project_id}, files={"file": (video.name, video.read_bytes(), "video/mp4")}
    ))


def test_answers_worth_it_are_compressed(client: TestClient, video_factory) -> None:
    big = client.get("/openapi.json", headers=GZIP)
    assert big.headers["content-encoding"] == "gzip" and "accept-encoding" in big.headers["vary"].lower()
    assert big.json()["info"]["title"] == "Stepthrough API"  # decoded on the way in
    assert "content-encoding" not in client.get("/openapi.json", headers={"Accept-Encoding": "identity"}).headers
    assert "content-encoding" not in client.get("/auth/session", headers=GZIP).headers  # too small to bother

    video_url = a_recording(client, video_factory)["source_url"]
    whole = client.get(video_url, headers=GZIP)
    assert whole.headers["content-type"].startswith("video/") and "content-encoding" not in whole.headers
    part = client.get(video_url, headers={**GZIP, "Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100 and "content-encoding" not in part.headers


def test_an_administrator_changes_settings_that_apply_at_once(client: TestClient) -> None:
    settings = ok(client.get("/admin/server-settings"))
    assert settings["compression"] == {"value": True, "default": True}
    assert settings["live_spread_seconds"]["value"] == server_settings.DEFAULT_LIVE_SPREAD_SECONDS

    changed = ok(client.patch("/admin/server-settings", json={"compression": False, "analyses_at_a_time": 3}))
    assert changed["compression"]["value"] is False and changed["analyses_at_a_time"]["value"] == 3
    assert "content-encoding" not in client.get("/openapi.json", headers=GZIP).headers
    assert main._job_manager().max_concurrent_runs == 3

    server_settings.load(None)  # as after a restart: what was changed is kept
    assert server_settings.value("analyses_at_a_time") == 3 and not server_settings.compression_enabled()

    back = ok(client.patch("/admin/server-settings", json={"compression": True, "analyses_at_a_time": 0}))
    assert back["compression"]["value"] is True and back["analyses_at_a_time"]["value"] == 0
    assert main._job_manager().max_concurrent_runs is None
    assert client.patch("/admin/server-settings", json={"live_spread_seconds": 60}).status_code == 422


def test_only_administrators_see_or_change_them(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(main.app.state, "auth_mode", "password")
    monkeypatch.setattr(accounts, "PASSWORD_ITERATIONS", 1000)
    monkeypatch.setattr(account_routes, "login_limiter", accounts.LoginLimiter())
    create_account("ordinary", password=PASSWORD)
    ok(client.post("/auth/login", json={"name": "ordinary", "password": PASSWORD}))
    assert client.get("/admin/server-settings").status_code == 403
    assert client.patch("/admin/server-settings", json={"compression": False}).status_code == 403


def test_a_higher_limit_starts_waiting_analyses_at_once() -> None:
    jobs = JobManager(max_concurrent_runs=1)
    assert jobs.wait_for_slot("first")
    started = threading.Event()

    def second() -> None:
        if jobs.wait_for_slot("second"):
            started.set()

    threading.Thread(target=second, daemon=True).start()
    assert not started.wait(0.2)  # waits its turn
    jobs.set_max_concurrent_runs(None)  # no limit: no longer waits
    assert started.wait(2)
    jobs.set_max_concurrent_runs(1)
    jobs.finish("first")
    jobs.finish("second")
    assert jobs.has_free_slot()
