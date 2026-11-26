"""Reading the text of a run's screenshots: asked for with the analysis or afterwards, stored with the steps, exported."""

from __future__ import annotations

import csv
import io
import json
import threading
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app import project_file, server_settings
from app.database import connect
from app.repository import list_candidates, update_candidate
from app.services import page_xml, text_models, text_queue
from app.services.step_text import parse_reading
from app.services.text_engine import ENGINE

TEXTS = ["Inbox 3 unread", "Settings Language"]


def ok(response):
    assert response.status_code in (200, 204), response.text
    return response.json() if response.status_code == 200 else None


@pytest.fixture()
def recording(client: TestClient, video_factory) -> str:
    project = ok(client.post("/projects", json={"name": "Text"}))
    video = video_factory("text.mp4", ["black", "white"])
    with video.open("rb") as file:
        return ok(client.post("/recordings/import", data={"project_id": project["id"]}, files={"file": ("text.mp4", file, "video/mp4")}))["id"]


def analyse(client: TestClient, recording: str, wait_for_run, *, read: bool) -> str:
    run = ok(client.post(f"/recordings/{recording}/runs", json={"stable": {"enable_ocr": read}}))
    assert wait_for_run(client, run["id"])["summary"]["status"] == "completed"
    return run["id"]


def answering(fake_reader, *texts: str) -> None:
    """Each screenshot is answered with the next of these texts, word by word as lines."""
    waiting = list(texts)

    def answer(_screen) -> dict:
        words = waiting.pop(0).split()
        return {"lines": [[word, 10, 20 + 30 * row, 90, 18, 0.98] for row, word in enumerate(words)], "width": 640, "height": 360}

    fake_reader.answer = staticmethod(answer)


def test_text_follows_an_analysis_that_asked_for_it(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    answering(fake_reader, *TEXTS)
    run = analyse(client, recording, wait_for_run, read=True)
    summary = wait_for_text(client, run)
    assert summary["text"] == {"waiting": 0, "read": 2, "failed": 0, "earlier": 0, "problem": None, "seconds_left": None}
    steps = list_candidates(run)
    assert [step["ocr_text"] for step in steps] == TEXTS
    assert [Path(screen.image).name for screen in fake_reader.asked] == [Path(step["image_path"]).name for step in steps]
    assert all(Path(screen.image).is_file() for screen in fake_reader.asked)
    reading = parse_reading(steps[0]["text_reading"])
    assert reading == {"engine": ENGINE, "width": 640, "height": 360,
                       "lines": [["Inbox", 10, 20, 90, 18, 0.98], ["3", 10, 50, 90, 18, 0.98], ["unread", 10, 80, 90, 18, 0.98]]}
    # how much of the text changed is known now
    breakdowns = [json.loads(step["score_breakdown"]) for step in steps]
    assert [breakdown["text"] for breakdown in breakdowns] == [0.0, 1.0]
    events = ok(client.get(f"/runs/{run}"))["events"]
    assert events[-1]["message"] == "Text read on 2 of 2 screenshots" and events[-1]["level"] == "success"


def test_an_analysis_is_done_before_its_text_is_read(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    gate = threading.Event()
    fake_reader.answer = staticmethod(lambda screen: gate.wait(10) and {"lines": [], "width": 1, "height": 1})
    run = analyse(client, recording, wait_for_run, read=True)
    detail = ok(client.get(f"/runs/{run}"))
    assert detail["summary"]["text"]["waiting"] == 2 and [step["text_state"] for step in detail["candidates"]] == ["waiting", "waiting"]
    assert detail["summary"]["text"]["seconds_left"] is None  # nothing has been read here yet to go by
    gate.set()
    assert wait_for_text(client, run)["text"]["read"] == 2
    assert [step["text_state"] for step in ok(client.get(f"/runs/{run}"))["candidates"]] == ["read", "read"]


def test_text_is_not_read_unless_asked_for(client, recording, wait_for_run, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=False)
    assert ok(client.get(f"/runs/{run}"))["summary"]["text"] == {"waiting": 0, "read": 0, "failed": 0, "earlier": 0, "problem": None, "seconds_left": None}
    assert fake_reader.asked == []


def test_text_can_be_read_afterwards(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=False)
    answering(fake_reader, *TEXTS)
    assert ok(client.post(f"/runs/{run}/text"))["text"]["waiting"] + len(fake_reader.asked) >= 2
    wait_for_text(client, run)
    assert [step["text"] for step in ok(client.get(f"/runs/{run}/text"))["steps"]] == TEXTS
    # asked for again: nothing is left to read
    assert ok(client.post(f"/runs/{run}/text"))["text"] == {"waiting": 0, "read": 2, "failed": 0, "earlier": 0, "problem": None, "seconds_left": None}
    assert len(fake_reader.asked) == 2


def test_the_text_of_one_step_comes_with_its_places(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    answering(fake_reader, *TEXTS)
    run = analyse(client, recording, wait_for_run, read=True)
    wait_for_text(client, run)
    step = ok(client.get(f"/runs/{run}"))["candidates"][1]
    detail = ok(client.get(f"/candidates/{step['id']}/text"))
    assert (detail["state"], detail["text"], detail["engine"], detail["width"], detail["height"]) == ("read", TEXTS[1], ENGINE, 640, 360)
    assert detail["lines"][1] == {"text": "Language", "x": 10, "y": 50, "width": 90, "height": 18, "score": 0.98}
    assert client.get("/candidates/none/text").status_code == 404


def test_text_read_by_an_earlier_version_is_known_and_read_again(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=False)
    first, second = list_candidates(run)
    update_candidate(first["id"], ocr_text="text of another screen")
    detail = ok(client.get(f"/runs/{run}"))
    assert detail["summary"]["text"]["earlier"] == 1
    assert [step["text_state"] for step in detail["candidates"]] == ["earlier", None]
    answering(fake_reader, *TEXTS)
    ok(client.post(f"/runs/{run}/text"))
    wait_for_text(client, run)
    assert [step["ocr_text"] for step in list_candidates(run)] == TEXTS


def test_what_another_version_of_the_engine_read_is_read_again(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    answering(fake_reader, *TEXTS, "read again")
    run = analyse(client, recording, wait_for_run, read=True)
    wait_for_text(client, run)
    first = list_candidates(run)[0]
    update_candidate(first["id"], text_reading=first["text_reading"].replace(ENGINE, "ppocrv5/9"))
    ok(client.post(f"/runs/{run}/text"))
    wait_for_text(client, run)
    assert [step["ocr_text"] for step in list_candidates(run)] == ["read again", TEXTS[1]]


def test_a_screenshot_that_cannot_be_read_is_said_to_be(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    fake_reader.answer = staticmethod(lambda screen: None if len(fake_reader.asked) <= 2 else {"lines": [], "width": 1, "height": 1})
    run = analyse(client, recording, wait_for_run, read=True)
    assert wait_for_text(client, run)["text"] == {"waiting": 0, "read": 1, "failed": 1, "earlier": 0, "problem": None, "seconds_left": None}
    assert ok(client.get(f"/runs/{run}"))["events"][-1]["message"] == "Text read on 1 of 2 screenshots; 1 could not be read"
    assert len(fake_reader.started) >= 3 or fake_reader.started[0].stopped
    ok(client.post(f"/runs/{run}/text"))  # it can be tried again
    assert wait_for_text(client, run)["text"]["read"] == 2


def test_reading_can_be_stopped(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    gate, asked = threading.Event(), threading.Event()

    def answer(_screen) -> dict:
        asked.set()
        gate.wait(10)
        return {"lines": [["late", 0, 0, 1, 1, 1.0]], "width": 1, "height": 1}

    fake_reader.answer = staticmethod(answer)
    run = analyse(client, recording, wait_for_run, read=True)
    assert asked.wait(5)
    assert ok(client.delete(f"/runs/{run}/text"))["text"]["waiting"] == 0
    gate.set()
    assert wait_for_text(client, run)["text"] == {"waiting": 0, "read": 0, "failed": 0, "earlier": 0, "problem": None, "seconds_left": None}
    assert [step["ocr_text"] for step in list_candidates(run)] == [None, None]  # what came late is not kept
    ok(client.delete(f"/runs/{run}/text"))  # nothing to stop any more


def test_why_text_was_not_read_is_shown(client, recording, wait_for_run, wait_for_text, fake_reader, monkeypatch) -> None:
    def missing() -> Path:
        raise text_models.ModelsUnavailable("from https://example.org/secret/path: no route to host")

    monkeypatch.setattr(text_models, "ensure", missing)
    run = analyse(client, recording, wait_for_run, read=True)
    summary = wait_for_text(client, run)
    assert summary["status"] == "completed" and summary["text"]["problem"] == text_queue.NO_MODELS
    event = ok(client.get(f"/runs/{run}"))["events"][-1]
    assert event["level"] == "warning" and text_queue.NO_MODELS in event["message"] and "secret" not in event["message"]
    assert [step["text_state"] for step in list_candidates(run)] == [None, None]
    monkeypatch.setattr(text_models, "ensure", lambda: Path("."))
    answering(fake_reader, *TEXTS)
    ok(client.post(f"/runs/{run}/text"))
    assert wait_for_text(client, run)["text"] == {"waiting": 0, "read": 2, "failed": 0, "earlier": 0, "problem": None, "seconds_left": None}


def test_text_is_refused_where_it_cannot_be_read(client, recording, wait_for_run, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=False)
    main._set_ocr_state(main.OcrHealthState(status="unavailable", available=False, message="Text recognition does not work here."))
    refused = client.post(f"/runs/{run}/text")
    assert refused.status_code == 503 and refused.json()["detail"] == "Text recognition does not work here."


def test_text_recognition_turned_off_while_it_reads(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    gate = threading.Event()
    fake_reader.answer = staticmethod(lambda screen: gate.wait(10) and {"lines": [], "width": 1, "height": 1})
    run = analyse(client, recording, wait_for_run, read=True)
    ok(client.patch("/admin/server-settings", json={"text_readers": 0}))
    health = ok(client.get("/health"))
    assert (health["ocr_status"], health["ocr_available"]) == ("off", False) and "turned off" in health["ocr_message"]
    gate.set()
    assert wait_for_text(client, run)["text"] == {"waiting": 0, "read": 0, "failed": 0, "earlier": 0, "problem": None, "seconds_left": None}
    assert client.post(f"/runs/{run}/text").status_code == 503
    again = ok(client.post(f"/recordings/{recording}/runs", json={"stable": {"enable_ocr": True}}))
    assert again["stable"]["enable_ocr"] is False
    wait_for_run(client, again["id"])
    ok(client.patch("/admin/server-settings", json={"text_readers": 2, "text_threads": 1}))
    ok(client.post(f"/runs/{run}/text"))
    assert wait_for_text(client, run)["text"]["read"] == 2 and fake_reader.started[-1].threads == 1


def test_settings_of_text_recognition_are_checked(client) -> None:
    settings = ok(client.get("/admin/server-settings"))
    assert settings["text_readers"] == {"value": 1, "default": 1} and 1 <= settings["text_threads"]["default"] <= 4
    for wrong in ({"text_readers": -1}, {"text_readers": 9}, {"text_threads": 0}, {"text_threads": 33}):
        assert client.patch("/admin/server-settings", json=wrong).status_code == 422
    assert server_settings.value("text_readers") == 1


def test_a_step_added_by_hand_is_read_too(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=False)
    ok(client.post(f"/runs/{run}/candidates/manual", json={"timestamp_ms": 600}))
    wait_for_text(client, run)
    assert fake_reader.asked == []  # nobody asked for the text of this run
    ok(client.post(f"/runs/{run}/text"))
    wait_for_text(client, run)
    added = ok(client.post(f"/runs/{run}/candidates/manual", json={"timestamp_ms": 1500}))
    wait_for_text(client, run)
    stored = {step["id"]: step for step in list_candidates(run)}
    assert len(stored) == 4 and all(step["text_state"] == "read" for step in stored.values())
    assert stored[added["id"]]["ocr_text"] == "sample text" and len(fake_reader.asked) == 4


def test_adding_a_step_keeps_what_was_read(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    answering(fake_reader, *TEXTS, "new step")
    run = analyse(client, recording, wait_for_run, read=True)
    wait_for_text(client, run)
    before = {step["id"]: step["text_reading"] for step in list_candidates(run)}
    ok(client.post(f"/runs/{run}/candidates/manual", json={"timestamp_ms": 600}))
    wait_for_text(client, run)
    after = {step["id"]: step["text_reading"] for step in list_candidates(run)}
    assert {step_id: after[step_id] for step_id in before} == before and len(after) == 3


def test_reading_does_not_count_as_a_change(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=False)
    before = {step["id"]: step["updated_at"] for step in list_candidates(run)}
    ok(client.post(f"/runs/{run}/text"))
    wait_for_text(client, run)
    assert {step["id"]: step["updated_at"] for step in list_candidates(run)} == before


def test_reading_goes_on_after_a_restart(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=False)
    with connect() as conn:
        conn.execute("UPDATE candidate_frames SET text_state = 'waiting' WHERE run_id = ?", (run,))
    main._text_reading().close()
    main.app.state.text_reading = main._new_text_reading()
    main._text_reading().resume()
    assert wait_for_text(client, run)["text"]["read"] == 2


def test_a_copy_of_a_run_has_its_text_and_reads_what_is_left(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    answering(fake_reader, *TEXTS, "the rest")
    run = analyse(client, recording, wait_for_run, read=True)
    wait_for_text(client, run)
    with connect() as conn:
        conn.execute("UPDATE candidate_frames SET text_state = 'waiting', text_reading = NULL WHERE run_id = ? AND detector_index = 2", (run,))
    copy = ok(client.post(f"/runs/{run}/duplicate"))["id"]
    assert wait_for_text(client, copy)["text"]["read"] == 2
    assert [step["ocr_text"] for step in list_candidates(copy)] == [TEXTS[0], "the rest"]


def test_deleting_a_run_takes_it_out_of_the_queue(client, recording, wait_for_run, fake_reader) -> None:
    gate, asked = threading.Event(), threading.Event()

    def answer(_screen) -> dict:
        asked.set()
        gate.wait(10)
        return {"lines": [], "width": 1, "height": 1}

    fake_reader.answer = staticmethod(answer)
    run = analyse(client, recording, wait_for_run, read=True)
    assert asked.wait(5)
    assert client.delete(f"/runs/{run}").status_code == 204
    gate.set()
    queue = main._text_reading()._queue
    for _ in range(200):
        if not queue.has(run):
            break
        threading.Event().wait(0.02)
    assert not queue.has(run) and queue.waiting() == 0 and len(fake_reader.asked) == 1


def test_an_export_has_the_text_with_its_places(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    answering(fake_reader, *TEXTS)
    run = analyse(client, recording, wait_for_run, read=True)
    wait_for_text(client, run)
    bundle = ok(client.post(f"/runs/{run}/export", json={"mode": "all"}))
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/exports/{bundle['id']}/download").content))
    manifest = json.loads(archive.read("steps.json"))
    assert manifest["run"]["text_recognition"] == {
        "engines": [ENGINE], "steps_read": 2, "steps_waiting": 0, "steps_failed": 0, "steps_read_by_an_earlier_version": 0, "steps_not_read": 0,
        "page_xml": "images/page",
    }
    step = manifest["steps"][0]
    assert (step["ocr_text"], step["text_state"]) == (TEXTS[0], "read")
    assert step["text_lines"][0] == {"text": "Inbox", "x": 10, "y": 20, "width": 90, "height": 18, "score": 0.98}
    assert {"ocr_text", "text_state", "text_lines"} <= set(manifest["field_notes"])
    rows = list(csv.DictReader(io.StringIO(archive.read("steps.csv").decode())))
    assert [(row["ocr_text"], row["text_state"]) for row in rows] == [(text, "read") for text in TEXTS]


def test_an_export_says_what_was_not_read_or_by_an_earlier_version(client, recording, wait_for_run, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=False)

    def exported() -> dict:
        bundle = ok(client.post(f"/runs/{run}/export", json={"mode": "all"}))
        return json.loads(zipfile.ZipFile(io.BytesIO(client.get(f"/exports/{bundle['id']}/download").content)).read("steps.json"))

    manifest = exported()
    assert manifest["run"]["text_recognition"] is None
    assert manifest["steps"][0]["text_state"] is None and manifest["steps"][0]["text_lines"] is None
    update_candidate(list_candidates(run)[0]["id"], ocr_text="old")
    manifest = exported()
    assert manifest["run"]["text_recognition"]["steps_read_by_an_earlier_version"] == 1
    assert [step["text_state"] for step in manifest["steps"]] == ["earlier", None]


def test_a_project_file_carries_the_text(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    answering(fake_reader, *TEXTS)
    run = analyse(client, recording, wait_for_run, read=True)
    wait_for_text(client, run)
    with connect() as conn:  # one is still to be read when the file is made
        conn.execute("UPDATE candidate_frames SET text_state = 'waiting', text_reading = NULL, ocr_text = NULL WHERE run_id = ? AND detector_index = 2", (run,))
    project = ok(client.get(f"/recordings/{recording}"))["project_id"]
    content = client.get(f"/projects/{project}/project-file").content
    target = ok(client.post("/projects", json={"name": "Elsewhere"}))["id"]
    new, = project_file.import_into(io.BytesIO(content), {"id": target, "slug": "elsewhere", "name": "Elsewhere"})
    copied = list_candidates(ok(client.get(f"/recordings/{new}"))["runs"][0]["id"])
    assert [(step["ocr_text"], step["text_state"]) for step in copied] == [(TEXTS[0], "read"), (None, None)]
    assert copied[0]["text_reading"] == list_candidates(run)[0]["text_reading"]


@pytest.mark.parametrize("reading", [
    "not json", "[]", "{}", '{"lines": 3}', '{"lines": [["a", 1, 2]], "width": 1, "height": 1}',
    '{"lines": [["a", 1, 2, 3, "4", 0.5]], "width": 1, "height": 1}', '{"lines": [["a", 1.5, 2, 3, 4, 0.5]], "width": 1, "height": 1}',
    '{"lines": [["a", 1, 2, 3, 4, true]], "width": 1, "height": 1}', '{"lines": [], "width": true, "height": 1}', '{"lines": [], "width": "1", "height": 1}', None, 7,
])
def test_a_reading_that_is_none_is_not_used(reading) -> None:
    assert parse_reading(reading) is None


def test_a_project_file_with_a_damaged_reading_still_opens(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=True)
    wait_for_text(client, run)
    first, second = list_candidates(run)
    update_candidate(first["id"], text_reading='{"lines": [["a"]]}')
    update_candidate(second["id"], text_state="nonsense")
    project = ok(client.get(f"/recordings/{recording}"))["project_id"]
    content = client.get(f"/projects/{project}/project-file").content
    target = ok(client.post("/projects", json={"name": "Elsewhere"}))["id"]
    new, = project_file.import_into(io.BytesIO(content), {"id": target, "slug": "elsewhere", "name": "Elsewhere"})
    copied = ok(client.get(f"/recordings/{new}"))["runs"][0]["id"]
    assert [step["text_state"] for step in ok(client.get(f"/runs/{copied}"))["candidates"]] == ["earlier", "earlier"]


def test_viewers_may_see_the_text_but_not_ask_for_it(client, recording, wait_for_run, wait_for_text, fake_reader, monkeypatch) -> None:
    run = analyse(client, recording, wait_for_run, read=True)
    wait_for_text(client, run)
    step = list_candidates(run)[0]["id"]
    real = main._check_project_role

    def as_viewer(project_id, user, need, not_found):
        if need == "owner":
            raise main.HTTPException(status_code=403, detail="You can view this project but not change it.")
        real(project_id, user, need, not_found)

    monkeypatch.setattr(main, "_check_project_role", as_viewer)
    assert client.post(f"/runs/{run}/text").status_code == 403 and client.delete(f"/runs/{run}/text").status_code == 403
    for path in (f"/runs/{run}/text", f"/candidates/{step}/text", f"/runs/{run}/summary"):
        assert client.get(path).status_code == 200


def test_an_analysis_goes_on_without_text_when_it_was_turned_off_meanwhile(client, recording, wait_for_run, fake_reader, monkeypatch) -> None:
    real = main.detect_candidates_stable

    def turned_off_while_analysing(**options):
        server_settings.set_server_settings({"text_readers": "0"})
        server_settings.load(None)
        return real(**options)

    monkeypatch.setattr(main, "detect_candidates_stable", turned_off_while_analysing)
    run = analyse(client, recording, wait_for_run, read=True)
    assert [step["text_state"] for step in list_candidates(run)] == [None, None] and fake_reader.asked == []


def test_an_export_has_the_text_as_page_xml_beside_the_screenshots(client, recording, wait_for_run, wait_for_text, fake_reader) -> None:
    answering(fake_reader, *TEXTS, "added by hand")
    run = analyse(client, recording, wait_for_run, read=True)
    wait_for_text(client, run)
    ok(client.post(f"/runs/{run}/candidates/manual", json={"timestamp_ms": 600}))  # its text is read too
    wait_for_text(client, run)
    with connect() as conn:  # and one that is not read
        conn.execute("UPDATE candidate_frames SET text_state = NULL, text_reading = NULL, ocr_text = NULL WHERE run_id = ? AND detector_index = 3", (run,))
    bundle = ok(client.post(f"/runs/{run}/export", json={"mode": "all"}))
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/exports/{bundle['id']}/download").content))
    manifest = json.loads(archive.read("steps.json"))
    steps = manifest["steps"]
    assert [step["text_page_xml"] is not None for step in steps] == [True, True, False]
    assert manifest["run"]["text_recognition"]["page_xml"] == "images/page"
    assert "text_page_xml" in manifest["field_notes"]
    names = set(archive.namelist())
    for step in steps[:2]:
        assert step["text_page_xml"] == f"images/page/{Path(step['image_path']).stem}.xml" and step["text_page_xml"] in names
        page = ET.fromstring(archive.read(step["text_page_xml"])).find("pc:Page", {"pc": page_xml.NAMESPACE})
        assert page.get("imageFilename") == Path(step["image_path"]).name
        words = [unicode.text for unicode in page.iter(f"{{{page_xml.NAMESPACE}}}Unicode")][:-1]
        assert " ".join(words) == step["ocr_text"]
    assert not any(name.endswith(".xml") and Path(steps[2]["image_path"]).stem in name for name in names)


def test_an_export_without_text_has_no_page_xml(client, recording, wait_for_run, fake_reader) -> None:
    run = analyse(client, recording, wait_for_run, read=False)
    bundle = ok(client.post(f"/runs/{run}/export", json={"mode": "all"}))
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/exports/{bundle['id']}/download").content))
    assert not any("/page/" in name or name.startswith("images/page") for name in archive.namelist())
    assert all(step["text_page_xml"] is None for step in json.loads(archive.read("steps.json"))["steps"])
