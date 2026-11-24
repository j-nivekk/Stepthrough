"""The project file: a whole project as one file, and back (see app/project_file.py)."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest

import app.storage as storage
from app import project_file

SAMPLES = Path(__file__).with_name("project_files")


def ok(response):
    assert response.status_code in (200, 204), response.text
    return response.json() if response.status_code == 200 else None


def a_project(client, video_factory) -> tuple[str, str, list[str]]:
    """A project with one video and a run with three steps, each with something to keep: titles, notes, a
    decision, a pop-up, a box they share, a row, a name and a phase."""
    project_id = ok(client.post("/projects", json={"name": "Sign up flow"}))["id"]
    video = video_factory("walkthrough.mp4", ["red", "blue", "green"], 0.6)
    recording_id = ok(client.post(
        "/recordings/import", data={"project_id": project_id}, files={"file": (video.name, video.read_bytes(), "video/mp4")}
    ))["id"]
    run_id = ok(client.post(f"/recordings/{recording_id}/runs/manual"))["id"]
    steps = [ok(client.post(f"/runs/{run_id}/candidates/manual", json={"timestamp_ms": 300 + 600 * i}))["id"] for i in range(3)]
    ok(client.post(f"/runs/{run_id}/candidates/status", json={"candidate_ids": steps, "status": "accepted"}))
    ok(client.patch(f"/candidates/{steps[0]}", json={"title": "home", "notes": "first screen"}))
    ok(client.patch(f"/candidates/{steps[1]}", json={"screen_kind": "popup", "pathway_row": "below"}))
    ok(client.patch(f"/candidates/{steps[2]}", json={"screen_link": steps[0]}))
    ok(client.patch(f"/candidates/{steps[1]}", json={"returns_to": steps[0]}))
    ok(client.patch(f"/runs/{run_id}", json={"name": "first try"}))
    ok(client.put(f"/runs/{run_id}/phases", json={"name": "sign up", "first_step": steps[0], "last_step": steps[1]}))
    return project_id, run_id, steps


def download(client, project_id: str) -> bytes:
    response = client.get(f"/projects/{project_id}/project-file")
    assert response.status_code == 200, response.text
    assert response.headers["content-disposition"].endswith('.stepthrough.zip"')
    return response.content


def bring_in(client, project_id: str, data: bytes, name: str = "project.stepthrough.zip"):
    return client.post(f"/projects/{project_id}/project-file", files={"file": (name, data, "application/zip")})


def the_run(client, project_id: str) -> dict:
    recordings = ok(client.get(f"/projects/{project_id}"))["recordings"]
    assert len(recordings) == 1
    runs = ok(client.get(f"/recordings/{recordings[0]['id']}"))["runs"]
    assert len(runs) == 1
    return ok(client.get(f"/runs/{runs[0]['id']}"))


def test_a_project_comes_back_as_it_was(client, video_factory):
    project_id, run_id, _steps = a_project(client, video_factory)
    before = ok(client.get(f"/runs/{run_id}"))
    data = download(client, project_id)

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        manifest = json.loads(archive.read("project.json"))
        assert manifest["format"] == "stepthrough-project" and manifest["format_version"] == project_file.FORMAT_VERSION
        assert set(manifest["files"]) == {name for name in archive.namelist() if name != "project.json"}
        assert sum(name.startswith("videos/") for name in archive.namelist()) == 1
        assert sum(name.startswith("frames/") for name in archive.namelist()) == 3

    other = ok(client.post("/projects", json={"name": "Brought back"}))["id"]
    added = ok(bring_in(client, other, data))
    assert [recording["filename"] for recording in added] == ["walkthrough.mp4"]
    after = the_run(client, other)

    assert after["summary"]["id"] != run_id
    assert after["summary"]["name"] == "first try" and after["summary"]["run_number"] == before["summary"]["run_number"]
    assert after["phases"] == before["phases"]
    old = {step["detector_index"]: step for step in before["candidates"]}
    new = {step["detector_index"]: step for step in after["candidates"]}
    assert new.keys() == old.keys()
    old_ids = {step["id"]: index for index, step in old.items()}
    new_ids = {step["id"]: index for index, step in new.items()}
    assert not set(old_ids) & set(new_ids)  # new ids throughout
    for index, step in new.items():
        for field in ("status", "title", "notes", "timestamp_ms", "screen_kind", "pathway_row", "candidate_origin"):
            assert step[field] == old[index][field], field
        # links between steps point at the new steps
        if old[index]["screen_link"] in old_ids:
            assert new_ids[step["screen_link"]] == old_ids[old[index]["screen_link"]]
        assert new_ids.get(step["returns_to"]) == old_ids.get(old[index]["returns_to"])
        assert storage.absolute_data_path(step["image_path"]).is_file()

    # the same file can come in twice
    ok(bring_in(client, other, data))
    assert len(ok(client.get(f"/projects/{other}"))["recordings"]) == 2


def test_the_pathway_is_the_same_after_the_trip(client, video_factory):
    project_id, run_id, _steps = a_project(client, video_factory)
    other = ok(client.post("/projects", json={"name": "Again"}))["id"]
    ok(bring_in(client, other, download(client, project_id)))
    new_run = the_run(client, other)["summary"]["id"]

    def shape(run: str) -> list:
        pathway = ok(client.get(f"/runs/{run}/pathway"))
        return [(screen["kind"], screen["title"], len(screen["visits"]), screen["row_choice"]) for screen in pathway["screens"]]

    assert shape(new_run) == shape(run_id)


def damaged(data: bytes, name_part: str) -> bytes:
    """The file with one byte changed in the first member whose name has ``name_part``."""
    source = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as target:
        changed = False
        for info in source.infolist():
            content = source.read(info)
            if not changed and name_part in info.filename:
                content = bytes([content[0] ^ 0xFF]) + content[1:]
                changed = True
            target.writestr(info, content)
    return out.getvalue()


def test_a_damaged_file_is_refused_and_leaves_nothing_behind(client, video_factory):
    project_id, _run, _steps = a_project(client, video_factory)
    data = download(client, project_id)
    other = ok(client.post("/projects", json={"name": "Target"}))["id"]
    project = ok(client.get(f"/projects/{other}"))["project"]
    folder = storage.project_dir(project["slug"], project["id"])

    refused = bring_in(client, other, damaged(data, "frames/"))
    assert refused.status_code == 400 and "damaged" in refused.json()["detail"]
    assert ok(client.get(f"/projects/{other}"))["recordings"] == []
    assert not (folder / "recordings").exists() or not any((folder / "recordings").iterdir())


def rewritten(data: bytes, change) -> bytes:
    source = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as target:
        for info in source.infolist():
            content = source.read(info)
            if info.filename == "project.json":
                manifest = json.loads(content)
                change(manifest)
                content = json.dumps(manifest).encode()
            target.writestr(info, content)
    return out.getvalue()


def test_a_file_from_a_newer_version_is_refused(client, video_factory):
    project_id, _run, _steps = a_project(client, video_factory)
    newer = rewritten(download(client, project_id), lambda manifest: manifest.update(format_version=99, made_with="Stepthrough 9.0"))
    refused = bring_in(client, project_id, newer)
    assert refused.status_code == 400
    assert "Stepthrough 9.0" in refused.json()["detail"] and "Update the server" in refused.json()["detail"]


def test_an_export_of_one_run_is_not_taken_for_a_project_file(client, video_factory):
    project_id, run_id, _steps = a_project(client, video_factory)
    bundle = ok(client.post(f"/runs/{run_id}/export", json={"mode": "accepted"}))
    export = client.get(bundle["zip_url"]).content
    refused = bring_in(client, project_id, export)
    assert refused.status_code == 400 and "export of one run" in refused.json()["detail"]
    refused = bring_in(client, project_id, b"not a zip at all")
    assert refused.status_code == 400 and "not a Stepthrough project file" in refused.json()["detail"]


def test_an_upgrade_step_runs_for_older_files(monkeypatch):
    """When the format changes, a file of the version before passes through the step from it."""
    monkeypatch.setattr(project_file, "FORMAT_VERSION", 2)
    monkeypatch.setitem(project_file.UPGRADES, 1, lambda manifest: {**manifest, "upgraded": True})
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("project.json", json.dumps({"format": "stepthrough-project", "format_version": 1, "recordings": []}))
    manifest = project_file.read_manifest(zipfile.ZipFile(io.BytesIO(out.getvalue())))
    assert manifest["upgraded"] is True and manifest["format_version"] == 2


def test_every_version_has_a_sample_file():
    versions = set()
    for sample in SAMPLES.glob("*.stepthrough.zip"):
        with zipfile.ZipFile(sample) as archive:
            versions.add(json.loads(archive.read("project.json"))["format_version"])
    assert versions == set(range(1, project_file.FORMAT_VERSION + 1))


@pytest.mark.parametrize("sample", sorted(SAMPLES.glob("*.stepthrough.zip")), ids=lambda path: path.name)
def test_sample_files_of_every_version_still_open(client, sample):
    project_id = ok(client.post("/projects", json={"name": "Sample"}))["id"]
    added = ok(bring_in(client, project_id, sample.read_bytes(), sample.name))
    assert added
    run = the_run(client, project_id)
    assert run["candidates"] and all(storage.absolute_data_path(step["image_path"]).is_file() for step in run["candidates"])
    assert any(step["title"] for step in run["candidates"])
    assert run["phases"]


def test_a_project_file_becomes_a_project_of_its_own(client, video_factory):
    project_id, run_id, _steps = a_project(client, video_factory)
    data = download(client, project_id)
    response = client.post("/projects/project-file", files={"file": ("sign-up.stepthrough.zip", data, "application/zip")})
    made = ok(response)
    assert made["id"] != project_id and made["name"] == "Sign up flow"
    assert made["recording_count"] == 1 and made["run_count"] == 1
    assert the_run(client, made["id"])["summary"]["name"] == "first try"


def test_a_refused_file_leaves_no_project_behind(client, video_factory):
    project_id, _run, _steps = a_project(client, video_factory)
    before = [project["id"] for project in ok(client.get("/projects"))]
    for data in (b"not a zip", damaged(download(client, project_id), "videos/")):
        refused = client.post("/projects/project-file", files={"file": ("p.stepthrough.zip", data, "application/zip")})
        assert refused.status_code == 400
    assert [project["id"] for project in ok(client.get("/projects"))] == before
    folders = list((storage.DATA_ROOT / "projects").iterdir())
    assert len(folders) == 1


def test_a_project_file_larger_than_the_server_takes_is_refused(client, video_factory, monkeypatch):
    from app import visitors

    project_id, _run, _steps = a_project(client, video_factory)
    data = download(client, project_id)
    size = ok(client.get(f"/projects/{project_id}/project-file/size"))
    # the estimate is close to the real file
    assert abs(size["bytes"] - len(data)) < 2048 and size["limit_bytes"] == visitors.project_file_limit()

    monkeypatch.setattr(visitors, "_server_project_file_limit", len(data) // 2)
    refused = client.post("/projects/project-file", files={"file": ("p.stepthrough.zip", data, "application/zip")})
    assert refused.status_code == 413 and "this server takes in" in refused.json()["detail"]
    # and by the import itself, from what the file holds
    with pytest.raises(project_file.ProjectFileError, match="this server takes in"):
        project_file.import_into(io.BytesIO(data), ok(client.get(f"/projects/{project_id}"))["project"], max_total_bytes=10)


def test_the_session_says_how_large_a_file_may_be(client):
    me = ok(client.get("/me"))
    assert me["upload_limit_bytes"] > 0 and me["project_file_limit_bytes"] >= me["upload_limit_bytes"]
