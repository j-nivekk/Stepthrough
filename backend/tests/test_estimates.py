"""Estimates of how long analyses and the reading of text still take."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from app import estimates
from app.database import connect
from app.estimates import Estimate, plan, rate
from app.services.text_queue import seconds_left


def test_the_rate_is_per_minute_and_square_root_of_megapixels() -> None:
    # 30 s for a minute of a 4-megapixel recording, 15 s for a minute of a 1-megapixel one: 15 s for each unit
    history = [(30.0, 1.0, 2000, 2000), (15.0, 1.0, 1000, 1000), (30.0, 2.0, 1000, 1000), (15.0, 0.5, 2000, 2000), (16.0, 1.0, 1000, 1000)]
    assert rate(history) == 15.0
    assert rate(history[:4]) is None  # too little to go by
    assert rate([(0.0, 1.0, 10, 10)] * 9) is None


def test_running_analyses_have_what_is_left_and_nothing_once_they_took_longer() -> None:
    found = plan(10.0, [("a", 30.0, 12.0), ("b", 20.0, 25.0)], [], 2)
    assert found == {"a": Estimate(seconds_left=18.0), "b": Estimate(seconds_left=None)}


def test_waiting_analyses_get_the_slots_in_turn() -> None:
    # two slots: a ends in 10 s and b in 40; c gets a's slot, d c's, e b's
    found = plan(1.0, [("a", 20.0, 10.0), ("b", 50.0, 10.0)], [("c", 20.0), ("d", 30.0), ("e", 5.0)], 2)
    assert found["c"] == Estimate(seconds_to_start=10.0, seconds_left=30.0)
    assert found["d"] == Estimate(seconds_to_start=30.0, seconds_left=60.0)
    assert found["e"] == Estimate(seconds_to_start=40.0, seconds_left=45.0)


def test_an_analysis_that_took_longer_holds_its_slot_a_little_longer() -> None:
    found = plan(1.0, [("a", 10.0, 30.0)], [("b", 20.0)], 1)
    assert found["b"] == Estimate(seconds_to_start=estimates.SOON_S, seconds_left=estimates.SOON_S + 20.0)


def test_without_a_limit_or_with_room_nobody_waits() -> None:
    assert plan(1.0, [("a", 20.0, 5.0)], [("b", 7.0), ("c", 9.0)], None)["c"] == Estimate(seconds_to_start=0.0, seconds_left=9.0)
    assert plan(1.0, [], [("b", 7.0)], 3)["b"] == Estimate(seconds_to_start=0.0, seconds_left=7.0)
    assert plan(None, [("a", 1.0, 0.0)], [("b", 1.0)], 1) == {}


def test_text_waits_its_turns() -> None:
    # a has 10 left at 1 s, b 2 at 3 s, c 30 at 0.5 s: before a's last, b reads 2 and c 10
    waiting = {"a": (10, 1.0), "b": (2, 3.0), "c": (30, 0.5)}
    assert seconds_left(waiting, "a", 1) == 10 + 6 + 5
    assert seconds_left(waiting, "b", 1) == 2 + 6 + 1
    assert seconds_left(waiting, "a", 2) == pytest.approx(10.5)
    assert seconds_left(waiting, "a", 8) == 10  # one run is read by one reader at a time
    assert seconds_left({"a": (4, 1.0), "b": (4, None)}, "a", 1) == 8  # a run of unknown speed counts as this one's
    assert seconds_left({"a": (4, None)}, "a", 1) is None
    assert seconds_left(waiting, "gone", 1) is None
    assert seconds_left(waiting, "a", 0) is None


def _run(client, recording: str, status: str, started: datetime | None, completed: datetime | None, **extra) -> str:
    from uuid import uuid4

    run_id = uuid4().hex
    with connect() as conn:
        conn.execute(
            """INSERT INTO detection_runs (id, recording_id, status, phase, analysis_engine, analysis_stable, detector_mode, tolerance,
               min_scene_gap_ms, extract_offset_ms, progress, candidate_count, created_at, started_at, completed_at, updated_at, message)
               VALUES (?, ?, ?, ?, 'stable_v3', ?, 'content', 50, 900, 200, 0, 0, ?, ?, ?, ?, ?)""",
            (run_id, recording, status, "primary_scan" if status == "running" else status, json.dumps({"enable_ocr": extra.get("ocr", False)}),
             (started or datetime.now(timezone.utc)).isoformat(), started.isoformat() if started else None,
             completed.isoformat() if completed else None, datetime.now(timezone.utc).isoformat(), extra.get("message")),
        )
    return run_id


def test_the_server_says_how_long_an_analysis_still_takes(client, video_factory) -> None:
    project = client.post("/projects", json={"name": "Estimates"}).json()
    with video_factory("estimate.mp4", ["black", "white"]).open("rb") as file:
        recording = client.post("/recordings/import", data={"project_id": project["id"]}, files={"file": ("e.mp4", file, "video/mp4")}).json()
    minutes = recording["duration_ms"] / 60000
    now = datetime.now(timezone.utc)
    for index in range(4):  # 12 s each, too few to go by
        _run(client, recording["id"], "completed", now - timedelta(minutes=10 + index), now - timedelta(minutes=10 + index) + timedelta(seconds=12))
    running = _run(client, recording["id"], "running", now - timedelta(seconds=5), None)
    assert client.get(f"/runs/{running}/summary").json()["seconds_left"] is None
    _run(client, recording["id"], "completed", now - timedelta(minutes=5), now - timedelta(minutes=5) + timedelta(seconds=12))
    # copies and analyses that read text before 1.5.0 do not count
    _run(client, recording["id"], "completed", now - timedelta(minutes=4), now, ocr=True)
    _run(client, recording["id"], "completed", now - timedelta(minutes=3), now, message="Duplicated from run #1")
    estimates.FRESH_S = 0
    try:
        summary = client.get(f"/runs/{running}/summary").json()
        assert summary["seconds_left"] == pytest.approx(7, abs=1.5) and summary["seconds_to_start"] is None
        finished = client.get(f"/recordings/{recording['id']}").json()["runs"]
        assert all(run["seconds_left"] is None for run in finished if run["status"] == "completed")
    finally:
        estimates.FRESH_S = 1.0
    assert minutes > 0


def test_runs_that_join_later_take_turns_too() -> None:
    waiting = {"a": (10, 1.0)}
    assert seconds_left(waiting, "a", 1) == 10
    # joins after 4 s, when a has 6 left: takes 6 turns of 2 s before a's last
    assert seconds_left(waiting, "a", 1, [(20, 4.0, 2.0)]) == pytest.approx(22)
    assert seconds_left(waiting, "a", 1, [(3, 4.0, 2.0)]) == pytest.approx(16)  # it has only 3
    assert seconds_left(waiting, "a", 1, [(20, 15.0, 2.0)]) == 10  # joins after a is done
    assert seconds_left(waiting, "a", 1, [(20, 4.0, None)]) == pytest.approx(16)  # unknown speed: as a's
