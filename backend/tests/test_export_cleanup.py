"""Exports that a newer one of the same task has replaced are removed (app/export_cleanup.py)."""

from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app import storage
from app.export_cleanup import EXPORT_GRACE, clear_old_exports


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def a_task(client: TestClient, video_factory) -> str:
    project_id = ok(client.post("/projects", json={"name": "Exports"}))["id"]
    video = video_factory("walkthrough.mp4", ["red", "blue"])
    recording_id = ok(client.post(
        "/recordings/import", data={"project_id": project_id}, files={"file": (video.name, video.read_bytes(), "video/mp4")}
    ))["id"]
    run_id = ok(client.post(f"/recordings/{recording_id}/runs/manual"))["id"]
    ok(client.post(f"/runs/{run_id}/candidates/manual", json={"timestamp_ms": 500}))
    return run_id


def export(client: TestClient, run_id: str) -> dict:
    return ok(client.post(f"/runs/{run_id}/export", json={"mode": "all"}))


def names(folder: Path) -> list[str]:
    return sorted(entry.name for entry in folder.iterdir())


def made_long_ago(folder: Path) -> None:
    """As if everything in the folder had been written before the grace period."""
    then = time.time() - EXPORT_GRACE.total_seconds() - 60
    for entry in folder.iterdir():
        os.utime(entry, (then, then))


def test_a_newer_export_replaces_the_older_one(client: TestClient, video_factory) -> None:
    run_id = a_task(client, video_factory)
    first, second = export(client, run_id), export(client, run_id)
    folder = (storage.DATA_ROOT / second["output_dir"]).parent
    assert client.get(first["zip_url"]).status_code == 404  # only the latest is offered, as before
    both = sorted([first["id"], f"{first['id']}.zip", second["id"], f"{second['id']}.zip"])
    assert names(folder) == both  # just written: the files of the first wait out the grace period

    made_long_ago(folder)
    removed, freed = clear_old_exports()
    assert (removed, freed > 0) == (1, True)
    assert names(folder) == sorted([second["id"], f"{second['id']}.zip"])
    assert client.get(second["zip_url"]).status_code == 200
    assert ok(client.get(f"/runs/{run_id}"))["export_bundle"]["id"] == second["id"]


def test_an_exports_folder_keeps_what_is_not_an_old_export(client: TestClient, video_factory) -> None:
    run_id = a_task(client, video_factory)
    latest = export(client, run_id)
    folder = (storage.DATA_ROOT / latest["output_dir"]).parent
    (folder / "notes.txt").write_text("kept")
    (folder / "0123456789abcdef0123456789abcdef").mkdir()  # left from an earlier version: no record
    (folder / "0123456789abcdef0123456789abcdef.zip").write_bytes(b"old")
    made_long_ago(folder)
    (folder / "fedcba9876543210fedcba9876543210").mkdir()  # an export still being written: no record yet

    assert clear_old_exports(run_id, folder)[0] == 1
    assert names(folder) == sorted(
        [latest["id"], f"{latest['id']}.zip", "fedcba9876543210fedcba9876543210", "notes.txt"]
    )
