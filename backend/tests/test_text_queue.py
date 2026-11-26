"""The queue of screenshots to read: turns, trying again, ending, and giving up."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from app.services import text_models, text_queue
from app.services.text_queue import Reading, Screen, TextQueue, Unavailable


class World:
    """A queue whose reader is a function here, and what it told."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *, readers: int = 1, answer=None) -> None:
        self.read: list[str] = []
        self.kept: list[tuple[str, Reading]] = []
        self.over: list[str] = []
        self.given_up: list[tuple[list[str], Unavailable]] = []
        self.readers: list = []
        self.gate = threading.Event()
        self.gate.set()
        self.answer = answer or (lambda screen, reader: {"lines": [[screen.step_id, 0, 0, 1, 1, 1.0]], "width": 2, "height": 3})
        self.still_there = lambda screen: True
        world = self

        class FakeReader:
            def __init__(self, models: Path, threads: int) -> None:
                self.threads, self.stopped = threads, False
                world.readers.append(self)

            def read(self, screen: Screen):
                world.gate.wait(5)
                world.read.append(screen.step_id)
                return world.answer(screen, self)

            def stop(self) -> None:
                self.stopped = True

        monkeypatch.setattr(text_queue, "Reader", FakeReader)
        monkeypatch.setattr(text_models, "ensure", lambda: Path("."))
        self.queue = TextQueue(keep=self._keep, turn_over=self.over.append, give_up=lambda runs, why: self.given_up.append((runs, why)),
                               readers=readers, threads=2)

    def _keep(self, screen: Screen, reading: Reading) -> bool:
        self.kept.append((screen.step_id, reading))
        return self.still_there(screen)

    def add(self, run: str, count: int, start: int = 0) -> None:
        self.queue.add(run, [Screen(run, f"{run}{number}", f"/{run}{number}.png") for number in range(start, start + count)])

    def wait(self, condition) -> None:
        for _ in range(500):
            if condition():
                return
            time.sleep(0.01)
        raise AssertionError("it did not happen in time")

    def finish(self, *runs: str) -> None:
        self.wait(lambda: not any(self.queue.has(run) for run in runs) and set(runs) <= set(self.over))


@pytest.fixture()
def world(monkeypatch: pytest.MonkeyPatch):
    made: list[World] = []

    def make(**options) -> World:
        made.append(World(monkeypatch, **options))
        return made[-1]

    yield make
    for one in made:
        one.gate.set()
        one.queue.close()


def test_runs_take_turns(world) -> None:
    w = world()
    w.gate.clear()
    w.add("a", 10)
    w.add("b", 3)
    w.add("c", 5)
    w.gate.set()
    w.finish("a", "b", "c")
    assert w.read == [*(f"a{n}" for n in range(4)), *(f"b{n}" for n in range(3)), *(f"c{n}" for n in range(4)),
                      *(f"a{n}" for n in range(4, 8)), "c4", "a8", "a9"]
    assert w.over == ["a", "b", "c", "a", "c", "a"] and len(w.readers) == 1
    assert w.kept[0] == ("a0", Reading([["a0", 0, 0, 1, 1, 1.0]], 2, 3))


def test_two_readers_read_two_runs_but_never_one_run_together(world) -> None:
    w = world(readers=2)
    busy: list[str] = []
    together: list[set[str]] = []
    lock = threading.Lock()

    def answer(screen: Screen, _reader):
        with lock:
            assert screen.run_id not in busy
            busy.append(screen.run_id)
            together.append(set(busy))
        time.sleep(0.01)
        with lock:
            busy.remove(screen.run_id)
        return {"lines": [], "width": 1, "height": 1}

    w.answer = answer
    w.add("a", 12)
    w.add("b", 12)
    w.finish("a", "b")
    assert {"a", "b"} in together and len(w.readers) == 2
    assert [step for step in w.read if step[0] == "a"] == [f"a{n}" for n in range(12)]  # each run in its order


def test_a_screenshot_whose_reader_died_is_tried_once_more(world) -> None:
    died: list[str] = []

    def answer(screen: Screen, _reader):
        if screen.step_id == "a1" and not died:
            died.append(screen.step_id)
            return None
        return {"lines": [], "width": 1, "height": 1}

    w = world(answer=answer)
    w.add("a", 3)
    w.finish("a")
    assert w.read == ["a0", "a1", "a1", "a2"] and [reading.lines for _, reading in w.kept] == [[], [], []]
    assert len(w.readers) == 2 and w.readers[0].stopped


def test_a_screenshot_that_cannot_be_read_is_marked_and_left(world) -> None:
    def answer(screen: Screen, _reader):
        return {"error": "damaged"} if screen.step_id == "a0" else None if screen.step_id == "a1" else {"lines": [], "width": 1, "height": 1}

    w = world(answer=answer)
    w.add("a", 3)
    w.finish("a")
    assert w.read == ["a0", "a1", "a1", "a2"]  # an answer, also a bad one, is not asked for again
    assert [reading.lines for _, reading in w.kept] == [None, None, []]


def test_a_reader_that_grew_too_large_is_replaced(world) -> None:
    w = world(answer=lambda screen, reader: {"lines": [], "width": 1, "height": 1, "memory_mb": 9000 if screen.step_id == "a0" else 500})
    w.add("a", 3)
    w.finish("a")
    assert len(w.readers) == 2 and w.readers[0].stopped and w.read == ["a0", "a1", "a2"]


def test_a_reader_without_work_ends_and_the_next_asked_for_starts_again(world, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(text_queue, "IDLE_S", 0.05)
    w = world()
    w.add("a", 1)
    w.finish("a")
    w.wait(lambda: w.readers[0].stopped and not w.queue._serving)
    w.add("b", 1)
    w.finish("b")
    assert len(w.readers) == 2 and w.read == ["a0", "b0"]


def test_what_is_taken_back_is_not_read(world) -> None:
    w = world()
    w.gate.clear()
    w.add("a", 10)
    w.add("b", 2)
    w.wait(lambda: "a" in w.queue._reading)
    w.queue.remove("a")
    w.gate.set()
    w.finish("a", "b")
    assert w.read == ["a0", "a1", "a2", "a3", "b0", "b1"]  # the turn it was in is finished


def test_a_run_that_is_gone_is_left_at_once(world) -> None:
    w = world()
    w.still_there = lambda screen: screen.run_id != "a"
    w.gate.clear()
    w.add("a", 10)
    w.add("b", 1)
    w.gate.set()
    w.finish("a", "b")
    assert w.read == ["a0", "b0"]


def test_the_same_screenshot_is_not_queued_twice(world) -> None:
    w = world()
    w.gate.clear()
    w.add("b", 1)
    w.wait(lambda: "b" in w.queue._reading)
    w.add("a", 3)
    w.add("a", 4)
    assert w.queue.waiting() == 4
    w.gate.set()
    w.finish("a", "b")
    assert w.read == ["b0", "a0", "a1", "a2", "a3"]


def test_it_gives_up_when_text_cannot_be_read_here(world, monkeypatch: pytest.MonkeyPatch) -> None:
    w = world()

    def missing() -> Path:
        raise text_models.ModelsUnavailable("could not be fetched from https://example.org: no route to host")

    monkeypatch.setattr(text_models, "ensure", missing)
    with w.queue._changed:  # both there before the reader starts
        w.add("a", 2)
        w.add("b", 2)
    w.wait(lambda: w.given_up)
    (runs, why), = w.given_up
    assert sorted(runs) == ["a", "b"] and why.message == text_queue.NO_MODELS and "no route to host" in why.detail
    assert w.queue.waiting() == 0 and w.read == []
    monkeypatch.setattr(text_models, "ensure", lambda: Path("."))
    w.add("a", 2)  # asked for again, when it can be
    w.finish("a")
    assert w.read == ["a0", "a1"]


def test_limits_change_while_it_runs(world) -> None:
    w = world(readers=0)
    w.add("a", 2)
    time.sleep(0.05)
    assert w.read == [] and w.queue.waiting() == 2
    w.queue.set_limits(1, 3)
    w.finish("a")
    assert w.read == ["a0", "a1"] and w.readers[-1].threads == 3
    w.queue.set_limits(1, 5)
    w.add("b", 1)
    w.finish("b")
    assert w.readers[-1].threads == 5 and w.readers[-2].stopped
    w.queue.set_limits(0, 5)
    w.wait(lambda: not w.queue._serving and w.readers[-1].stopped)


def test_closing_ends_it_at_once(world) -> None:
    w = world()
    w.gate.clear()
    w.add("a", 10)
    w.wait(lambda: w.readers)
    w.gate.set()
    w.queue.close()
    assert not any(thread.is_alive() for thread in w.queue._serving.values())
    assert len(w.kept) < 10
    w.add("a", 1)
    assert w.queue.waiting() == 0
