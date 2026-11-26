"""Reading the text of a run's screenshots: what is asked for, what comes back, and how it is stored.

Text is read after an analysis, not during it: the steps are there at once, and their text follows. It can be asked for
afterwards too, for any run. What is still to be read is marked on the steps (``text_state``), so a reading that a
restart interrupts goes on when the server is back. The reading itself is in ``services/text_queue.py``.

What is stored with a step is in ``services/step_text.py``.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Collection
from contextlib import AbstractContextManager
from threading import RLock
from typing import Any

from fastapi import HTTPException

from . import server_settings
from .repository import (
    forget_text_waiting,
    list_candidates,
    list_text_waiting,
    mark_text_waiting,
    set_score_breakdowns,
    set_text_reading,
)
from .services.step_text import parse_reading, text_changes
from .services.text_engine import ENGINE
from .services.text_queue import Reading, Screen, TextQueue, Unavailable
from .storage import absolute_data_path

LOCK_TRIES = 10


def _to_read(candidate: dict[str, Any]) -> bool:
    """Whether a step is still to be read by this version of the engine."""
    if not candidate.get("image_path") or candidate.get("text_state") == "waiting":
        return False
    reading = parse_reading(candidate.get("text_reading")) if candidate.get("text_state") == "read" else None
    return reading is None or reading["engine"] != ENGINE


class TextReading:
    """``one_at_a_time`` is the lock on a run's steps; ``say`` puts a line in a run's log, and ``announce`` tells the
    browsers of shared accounts that a run changed."""

    def __init__(
        self,
        *,
        one_at_a_time: Callable[[str], AbstractContextManager[Any]],
        say: Callable[[str, str, str], None],
        announce: Callable[[str], None],
    ) -> None:
        self._one_at_a_time, self._say, self._announce = one_at_a_time, say, announce
        # What is marked as waiting on the steps and what the queue holds change together.
        self._lock = RLock()
        self._problems: dict[str, str] = {}  # run -> why its text was not read, until it is asked for again
        self._limits = (server_settings.value("text_readers"), server_settings.value("text_threads"))
        self._queue = TextQueue(
            keep=self._keep, turn_over=self._turn_over, give_up=self._give_up, readers=self._limits[0], threads=self._limits[1]
        )

    # ── asking ────────────────────────────────────────────────────────────────────────────────────────────────

    def resume(self, run_id: str | None = None) -> None:
        """Read what is marked as waiting: after a restart, or in one run."""
        with self._lock:
            if not self._limits[0]:
                forget_text_waiting(run_id)
                return
            waiting: dict[str, list[Screen]] = {}
            for step in list_text_waiting(run_id):
                waiting.setdefault(step["run_id"], []).append(self._screen(step["run_id"], step))
            for run, screens in waiting.items():
                self._queue.add(run, screens)

    def ask(self, run_id: str, only: Collection[str] | None = None) -> int:
        """Read the text of the run's steps that this version has not read yet, or of these steps. Returns how many."""
        with self._lock:
            asked = self.prepare(run_id, only)
            self.resume(run_id)
        return asked

    def prepare(self, run_id: str, only: Collection[str] | None = None) -> int:
        """Mark them as waiting, for ``resume`` to read."""
        with self._lock:
            self._problems.pop(run_id, None)
            steps = [step for step in list_candidates(run_id) if _to_read(step) and (only is None or step["id"] in only)]
            mark_text_waiting(run_id, [step["id"] for step in steps])
        return len(steps)

    def stop(self, run_id: str) -> int:
        """Leave what is not read yet. Returns how many steps that was."""
        with self._lock:
            self._queue.remove(run_id)
            return forget_text_waiting(run_id)

    def forget(self, run_id: str) -> None:
        """The run is gone."""
        with self._lock:
            self._queue.remove(run_id)
            self._problems.pop(run_id, None)

    def problem(self, run_id: str) -> str | None:
        return self._problems.get(run_id)

    def waiting(self) -> int:
        return self._queue.waiting()

    def apply_limits(self) -> None:
        """An administrator changed how many readers there may be, or how many threads each has."""
        with self._lock:
            self._limits = (server_settings.value("text_readers"), server_settings.value("text_threads"))
            self._queue.set_limits(*self._limits)
            if self._limits[0]:
                return
            stopped = {step["run_id"] for step in list_text_waiting()}
            for run_id in stopped:
                self._queue.remove(run_id)
            forget_text_waiting()
        for run_id in stopped:
            self._announce(run_id)

    def close(self) -> None:
        self._queue.close()

    # ── what comes back ───────────────────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _screen(run_id: str, step: dict[str, Any]) -> Screen:
        return Screen(run_id, step["id"], str(absolute_data_path(step["image_path"])))

    def _keep(self, screen: Screen, reading: Reading) -> bool:
        text = stored = None
        if reading.lines is not None:
            text = " ".join(line[0] for line in reading.lines) or None
            stored = json.dumps(
                {"engine": ENGINE, "width": reading.width, "height": reading.height, "lines": reading.lines},
                ensure_ascii=False, separators=(",", ":"),
            )
        for _ in range(LOCK_TRIES):
            try:
                with self._one_at_a_time(screen.run_id):
                    return set_text_reading(screen.step_id, text, stored)
            except HTTPException:  # something else changes the run's steps for long
                continue
        return True

    def _turn_over(self, run_id: str) -> None:
        with self._lock:
            if self._queue.has(run_id):
                return
            forget_text_waiting(run_id)  # nothing should be left; if something is, it is not going to be read
        with self._one_at_a_time(run_id):
            steps = list_candidates(run_id)
            set_score_breakdowns(text_changes(steps))
        if not steps:
            return  # deleted meanwhile
        read = sum(step["text_state"] == "read" for step in steps)
        failed = sum(step["text_state"] == "failed" for step in steps)
        message = f"Text read on {read} of {len(steps)} screenshots" + (f"; {failed} could not be read" if failed else "")
        self._say(run_id, "warning" if failed else "success", message)
        self._announce(run_id)

    def _give_up(self, run_ids: list[str], why: Unavailable) -> None:
        for run_id in run_ids:
            with self._lock:
                if not forget_text_waiting(run_id):
                    continue
                self._problems[run_id] = why.message
            self._say(run_id, "warning", f"Text was not read: {why.message}")
            self._announce(run_id)
