from __future__ import annotations

from collections import defaultdict
from threading import Lock, Thread
from typing import Any


class JobManager:
    def __init__(self) -> None:
        self._lock = Lock()
        self._events: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._cancelled: set[str] = set()
        self._threads: dict[str, Thread] = {}

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

    def request_cancel(self, run_id: str) -> None:
        with self._lock:
            self._cancelled.add(run_id)

    def is_cancelled(self, run_id: str) -> bool:
        with self._lock:
            return run_id in self._cancelled

    def finish(self, run_id: str) -> None:
        with self._lock:
            self._threads.pop(run_id, None)
            self._cancelled.discard(run_id)
