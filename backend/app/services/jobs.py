from __future__ import annotations

from collections import defaultdict, deque
from threading import Condition, Lock, Thread
from typing import Any


class JobManager:
    """Run threads, their progress events and cancel signals, all in this process's memory.

    With `max_concurrent_runs` set, at most that many runs hold a slot at once. The rest wait in the order they were
    started (`wait_for_slot`), so a whole group's runs started together cannot saturate a shared server.
    """

    def __init__(self, max_concurrent_runs: int | None = None) -> None:
        self._lock = Lock()
        self._slot_changed = Condition(self._lock)
        self._events: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._cancelled: set[str] = set()
        self._threads: dict[str, Thread] = {}
        self._max_concurrent_runs = max_concurrent_runs
        self._waiting: deque[str] = deque()
        self._holding: set[str] = set()

    @property
    def max_concurrent_runs(self) -> int | None:
        return self._max_concurrent_runs

    def publish(self, run_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            self._events[run_id].append(event)

    def get_events_since(self, run_id: str, offset: int) -> tuple[list[dict[str, Any]], int]:
        with self._lock:
            events = self._events.get(run_id, [])
            next_offset = len(events)
            return events[offset:next_offset], next_offset

    def start(self, run_id: str, target: Any) -> None:
        thread = Thread(target=target, name=f"stepthrough-run-{run_id}", daemon=True)
        with self._lock:
            self._threads[run_id] = thread
        thread.start()

    def runs_ahead(self, run_id: str) -> int:
        """Runs that will get a slot before this one: those still waiting in front of it."""
        with self._lock:
            try:
                return self._waiting.index(run_id)
            except ValueError:
                return len(self._waiting)

    def has_free_slot(self) -> bool:
        with self._lock:
            return self._max_concurrent_runs is None or (not self._waiting and len(self._holding) < self._max_concurrent_runs)

    def wait_for_slot(self, run_id: str) -> bool:
        """Block until this run may start. False means it was cancelled while it waited."""
        with self._slot_changed:
            if self._max_concurrent_runs is None:
                return run_id not in self._cancelled
            self._waiting.append(run_id)
            try:
                while True:
                    if run_id in self._cancelled:
                        return False
                    if self._waiting[0] == run_id and len(self._holding) < self._max_concurrent_runs:
                        self._holding.add(run_id)
                        return True
                    self._slot_changed.wait()
            finally:
                self._waiting.remove(run_id)
                # The next run in line may now be at the front.
                self._slot_changed.notify_all()

    def request_cancel(self, run_id: str) -> None:
        with self._slot_changed:
            self._cancelled.add(run_id)
            self._slot_changed.notify_all()

    def is_cancelled(self, run_id: str) -> bool:
        with self._lock:
            return run_id in self._cancelled

    def finish(self, run_id: str) -> None:
        with self._slot_changed:
            self._threads.pop(run_id, None)
            self._cancelled.discard(run_id)
            if run_id in self._holding:
                self._holding.discard(run_id)
                self._slot_changed.notify_all()
