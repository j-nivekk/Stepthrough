"""Duplicating a completed run: default naming, deep copy of steps/images/phases, and guards."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main
from app.accounts import User, current_user
from app.repository import MAX_RUN_NAME_LENGTH, create_user, duplicate_run_name, update_run
from app.storage import absolute_data_path


@pytest.mark.parametrize(
    ("source_name", "source_number", "existing", "expected"),
    [
        ("baseline", 1, ["baseline"], "baseline copy"),
        ("baseline", 1, ["baseline", "baseline copy"], "baseline copy 2"),
        ("baseline", 1, ["baseline", "baseline copy", "baseline copy 2"], "baseline copy 3"),
        ("baseline copy", 2, ["baseline", "baseline copy"], "baseline copy 2"),
        ("baseline copy 2", 3, ["baseline", "baseline copy", "baseline copy 2"], "baseline copy 3"),
        ("baseline copy 2", 3, ["baseline", "baseline copy 2"], "baseline copy"),
        ("Baseline", 1, ["Baseline", "baseline copy"], "Baseline copy 2"),
        (None, 2, [None], "run #2 copy"),
        (None, 2, [None, "run #2 copy"], "run #2 copy 2"),
        ("run #2 copy", 3, [None, "run #2 copy"], "run #2 copy 2"),
        ("   ", 4, [None], "run #4 copy"),
        ("copy", 1, ["copy"], "copy copy"),
    ],
)
def test_duplicate_run_name_rules(
    source_name: str | None,
    source_number: int | None,
    existing: list[str | None],
    expected: str,
) -> None:
    assert duplicate_run_name(source_name, source_number, existing) == expected


def test_duplicate_run_name_respects_max_length() -> None:
    long_name = "a" * MAX_RUN_NAME_LENGTH
    first = duplicate_run_name(long_name, 1, [long_name])
    assert len(first) == MAX_RUN_NAME_LENGTH
    assert first.endswith(" copy")

    second = duplicate_run_name(long_name, 1, [long_name, first])
    assert len(second) == MAX_RUN_NAME_LENGTH
    assert second.endswith(" copy 2")


def _seed_recording(client: TestClient, video_factory) -> tuple[dict, dict]:
    project = client.post("/projects", json={"name": "Duplicate test"}).json()
    video = video_factory("flow.mp4", ["red", "green", "blue"])
    with video.open("rb") as handle:
        recording = client.post(
            "/recordings/import",
            files={"file": (video.name, handle, "video/mp4")},
            data={"project_id": project["id"]},
        ).json()
    return project, recording


def test_duplicate_completed_run_copies_steps_images_links_and_phases(client: TestClient, video_factory) -> None:
    _project, recording = _seed_recording(client, video_factory)
    run = client.post(f"/recordings/{recording['id']}/runs/manual").json()
    first = client.post(f"/runs/{run['id']}/candidates/manual", json={"timestamp_ms": 500}).json()
    second = client.post(f"/runs/{run['id']}/candidates/manual", json={"timestamp_ms": 1500}).json()

    client.patch(
        f"/candidates/{first['id']}",
        json={"status": "accepted", "title": "Home", "notes": "Landing screen", "screen_kind": "screen", "pathway_row": "below"},
    )
    client.patch(
        f"/candidates/{second['id']}",
        json={"status": "accepted", "title": "Detail", "screen_link": first["id"], "screen_kind": "popup", "returns_to": first["id"]},
    )
    client.put(
        f"/runs/{run['id']}/phases",
        json={"name": "Onboarding", "first_step": first["id"], "last_step": second["id"]},
    )
    client.post(f"/runs/{run['id']}/export", json={"mode": "accepted"})

    # Unnamed run #1 -> "run #1 copy" (run #2)
    dup1_resp = client.post(f"/runs/{run['id']}/duplicate")
    assert dup1_resp.status_code == 200
    dup1 = dup1_resp.json()
    assert dup1["id"] != run["id"]
    assert dup1["run_number"] == 2
    assert dup1["name"] == "run #1 copy"
    assert dup1["status"] == "completed"
    assert dup1["candidate_count"] == 2
    assert dup1["accepted_count"] == 2
    assert dup1["export_bundle_id"] is None

    # Duplicating the unnamed run again increments to "run #1 copy 2" (run #3)
    dup2 = client.post(f"/runs/{run['id']}/duplicate").json()
    assert dup2["run_number"] == 3
    assert dup2["name"] == "run #1 copy 2"

    # Duplicating a copy produces "run #1 copy 3" (run #4), not "... copy copy"
    dup3 = client.post(f"/runs/{dup1['id']}/duplicate").json()
    assert dup3["run_number"] == 4
    assert dup3["name"] == "run #1 copy 3"

    detail = client.get(f"/runs/{dup1['id']}").json()
    assert len(detail["candidates"]) == 2
    c1, c2 = detail["candidates"]
    assert c1["id"] != first["id"]
    assert c2["id"] != second["id"]
    assert c1["title"] == "Home"
    assert c1["notes"] == "Landing screen"
    assert c1["status"] == "accepted"
    assert c1["screen_kind"] == "screen"
    assert c1["pathway_row"] == "below"
    # screen_link is remapped to the new candidate ID, not the original run's candidate ID
    assert c2["screen_link"] == c1["id"] and c2["returns_to"] == c1["id"]
    assert c2["screen_kind"] == "popup"
    assert detail["phases"] == [{"start_ms": 500, "name": "Onboarding"}]

    # Copied frames live in their own folder and survive deleting the original run
    orig_frame = absolute_data_path(first["image_path"])
    dup_frame = absolute_data_path(c1["image_path"])
    assert dup_frame != orig_frame
    assert dup_frame.is_file()
    assert client.get(c1["image_url"]).status_code == 200

    assert client.delete(f"/runs/{run['id']}").status_code == 204
    assert dup_frame.is_file()
    assert client.get(c1["image_url"]).status_code == 200


def test_duplicate_named_run_uses_name(client: TestClient, video_factory) -> None:
    _project, recording = _seed_recording(client, video_factory)
    run = client.post(f"/recordings/{recording['id']}/runs/manual").json()
    client.patch(f"/runs/{run['id']}", json={"name": "Baseline"})

    dup1 = client.post(f"/runs/{run['id']}/duplicate").json()
    assert dup1["name"] == "Baseline copy"
    dup2 = client.post(f"/runs/{dup1['id']}/duplicate").json()
    assert dup2["name"] == "Baseline copy 2"


@pytest.mark.parametrize("status", ["queued", "running", "failed", "cancelled"])
def test_duplicate_refuses_non_completed_runs(client: TestClient, video_factory, status: str) -> None:
    _project, recording = _seed_recording(client, video_factory)
    run = client.post(f"/recordings/{recording['id']}/runs/manual").json()
    update_run(run["id"], status=status, phase=status)

    resp = client.post(f"/runs/{run['id']}/duplicate")
    assert resp.status_code == 409


def test_duplicate_respects_visitor_storage_limit(
    client: TestClient,
    video_factory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    visitor = User.from_row(create_user("guest", tags=["visitor"]))
    main.app.dependency_overrides[current_user] = lambda: visitor
    try:
        _project, recording = _seed_recording(client, video_factory)
        run = client.post(f"/recordings/{recording['id']}/runs/manual").json()
        client.post(f"/runs/{run['id']}/candidates/manual", json={"timestamp_ms": 500})

        monkeypatch.setattr(main.visitors, "storage_limit", lambda _user: 100)
        resp = client.post(f"/runs/{run['id']}/duplicate")
        assert resp.status_code == 413
    finally:
        main.app.dependency_overrides.pop(current_user, None)


def test_duplicate_keeps_the_analysis_times_and_every_step_column(client: TestClient, video_factory) -> None:
    from app.database import connect

    _project, recording = _seed_recording(client, video_factory)
    run = client.post(f"/recordings/{recording['id']}/runs/manual").json()
    step = client.post(f"/runs/{run['id']}/candidates/manual", json={"timestamp_ms": 500}).json()
    update_run(run["id"], started_at="2026-01-02T10:00:00+00:00", completed_at="2026-01-02T10:03:00+00:00")
    # a column a later version adds to the steps comes along without the copy knowing of it
    with connect() as conn:
        conn.execute("ALTER TABLE candidate_frames ADD COLUMN later_field TEXT")
        conn.execute("UPDATE candidate_frames SET later_field = 'kept' WHERE id = ?", (step["id"],))

    copy = client.post(f"/runs/{run['id']}/duplicate").json()
    assert copy["started_at"] == "2026-01-02T10:00:00+00:00"
    assert copy["completed_at"] == "2026-01-02T10:03:00+00:00"
    assert copy["created_at"] > copy["completed_at"]
    with connect() as conn:
        copied = conn.execute("SELECT later_field FROM candidate_frames WHERE run_id = ?", (copy["id"],)).fetchone()
    assert copied["later_field"] == "kept"


def test_run_summary_reports_accepted_and_rejected_counts(client: TestClient, video_factory) -> None:
    _project, recording = _seed_recording(client, video_factory)
    run = client.post(f"/recordings/{recording['id']}/runs/manual").json()
    s1 = client.post(f"/runs/{run['id']}/candidates/manual", json={"timestamp_ms": 300}).json()
    s2 = client.post(f"/runs/{run['id']}/candidates/manual", json={"timestamp_ms": 800}).json()
    s3 = client.post(f"/runs/{run['id']}/candidates/manual", json={"timestamp_ms": 1400}).json()

    client.patch(f"/candidates/{s1['id']}", json={"status": "accepted"})
    client.patch(f"/candidates/{s2['id']}", json={"status": "rejected"})
    client.patch(f"/candidates/{s3['id']}", json={"status": "pending"})

    detail = client.get(f"/runs/{run['id']}").json()
    assert detail["summary"]["candidate_count"] == 3
    assert detail["summary"]["accepted_count"] == 1
    assert detail["summary"]["rejected_count"] == 1

    rec = client.get(f"/recordings/{recording['id']}").json()
    summary = next(item for item in rec["runs"] if item["id"] == run["id"])
    assert summary["candidate_count"] == 3
    assert summary["accepted_count"] == 1
    assert summary["rejected_count"] == 1

    dup = client.post(f"/runs/{run['id']}/duplicate").json()
    assert dup["candidate_count"] == 3
    assert dup["accepted_count"] == 1
    assert dup["rejected_count"] == 1

    # Resetting a rejected step back to pending lowers rejected_count.
    client.patch(f"/candidates/{s2['id']}", json={"status": "pending"})
    after_reset = client.get(f"/runs/{run['id']}").json()["summary"]
    assert after_reset["accepted_count"] == 1
    assert after_reset["rejected_count"] == 0
