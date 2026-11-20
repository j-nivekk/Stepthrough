"""Many people at once: live changes for shared accounts, and one change at a time per task for everyone.

A shared account (tagged ``shared``, never an administrator) is used by many people at the same time, each in their
own browser. Every change in its projects is told to all of them through a feed they wait on (``GET /me/live``), so
each browser shows what the others did within a moment instead of after a reload. The feed also carries:

- presence: what a browser is doing that others should see, such as editing a step's notes or uploading a video.
  It lasts while the browser keeps saying so, and ends PRESENCE_SECONDS after it stops (a closed tab, a sleeping
  laptop);
- busy entries: a change that rewrites a whole task (adding a step by hand renumbers every step, for instance)
  while it runs, so the others see why the task is about to change.

Everything is kept in memory: the app runs as one process, as the analysis queue already requires, and after a
restart the browsers simply load everything again.

``TaskWrites`` is for every account: changes to the steps of one task are made one after the other, so a step added
by hand cannot write back a decision someone else changed a moment before.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from threading import Lock, RLock
from time import monotonic
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

CLIENT_HEADER = "X-Stepthrough-Client"
PRESENCE_SECONDS = 25
KEEP_EVENTS = 1000
MAX_TARGETS = 20
TASK_WAIT_SECONDS = 30
TASK_BUSY = "This task is busy with another change. Try again in a moment."


@dataclass
class _Presence:
    expires: float
    # each target with `since`: when this browser began it, so that of two browsers on one step the first keeps it
    targets: list[dict[str, Any]]


@dataclass
class _Feed:
    seq: int = 0
    events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=KEEP_EVENTS))
    presence: dict[str, _Presence] = field(default_factory=dict)
    busy: dict[str, dict[str, Any]] = field(default_factory=dict)


class LiveHub:
    """The feeds of the shared accounts. Thread-safe: requests and background work publish from their threads."""

    def __init__(self) -> None:
        # A new epoch after a restart tells the browsers that the numbering began again.
        self.epoch = uuid4().hex
        self._feeds: dict[str, _Feed] = {}
        self._lock = Lock()
        self._started = monotonic()

    def _feed(self, account_id: str) -> _Feed:
        return self._feeds.setdefault(account_id, _Feed())

    @staticmethod
    def _add(feed: _Feed, event: dict[str, Any]) -> None:
        feed.seq += 1
        feed.events.append({**event, "seq": feed.seq})

    def publish(self, account_ids: Iterable[str], event: dict[str, Any]) -> None:
        with self._lock:
            for account_id in set(account_ids):
                self._add(self._feed(account_id), event)

    def _expire(self, feed: _Feed, now: float) -> None:
        gone = [client for client, presence in feed.presence.items() if presence.expires <= now]
        for client in gone:
            del feed.presence[client]
        if gone:
            self._add(feed, {"kind": "state"})

    def seq(self, account_id: str) -> int:
        """The number of the latest change; also lets presence that has run out go."""
        with self._lock:
            feed = self._feed(account_id)
            self._expire(feed, monotonic())
            return feed.seq

    def snapshot(self, account_id: str, after: int | None) -> dict[str, Any]:
        """The changes after ``after`` and the state now. ``reset`` when the browser cannot catch up from the list
        (a restart, or more changes than are kept): it then loads everything again."""
        with self._lock:
            feed = self._feed(account_id)
            now = monotonic()
            self._expire(feed, now)
            oldest = feed.events[0]["seq"] if feed.events else feed.seq + 1
            reset = after is None or after > feed.seq or (after < oldest - 1 and after < feed.seq)
            events = [] if reset else [event for event in feed.events if event["seq"] > after]
            return {
                "epoch": self.epoch,
                "seq": feed.seq,
                "reset": reset,
                "events": events,
                "presence": [
                    {
                        "client": client,
                        "targets": [{**target, "since": round(target["since"] - self._started, 3)} for target in presence.targets],
                    }
                    for client, presence in feed.presence.items()
                ],
                "busy": list(feed.busy.values()),
            }

    def set_presence(self, account_id: str, client: str, targets: list[dict[str, Any]]) -> None:
        """What a browser is doing now; an empty list when it stops. Repeated to stay present."""
        with self._lock:
            feed = self._feed(account_id)
            now = monotonic()
            current = feed.presence.get(client)
            if not targets:
                if current is not None:
                    del feed.presence[client]
                    self._add(feed, {"kind": "state"})
                return
            began = {_target_key(t): t["since"] for t in current.targets} if current is not None else {}
            dated = [{**target, "since": began.get(_target_key(target), now)} for target in targets]
            changed = current is None or current.targets != dated
            feed.presence[client] = _Presence(expires=now + PRESENCE_SECONDS, targets=dated)
            if changed:
                self._add(feed, {"kind": "state"})

    @contextmanager
    def busy(self, account_ids: Iterable[str], entry: dict[str, Any]) -> Iterator[None]:
        """Show ``entry`` (a task and what is happening to it) to the browsers of these accounts while it runs."""
        accounts = set(account_ids)
        if not accounts:
            yield
            return
        token = uuid4().hex
        with self._lock:
            for account_id in accounts:
                feed = self._feed(account_id)
                feed.busy[token] = {**entry, "id": token}
                self._add(feed, {"kind": "state"})
        try:
            yield
        finally:
            with self._lock:
                for account_id in accounts:
                    feed = self._feed(account_id)
                    feed.busy.pop(token, None)
                    self._add(feed, {"kind": "state"})


def _target_key(target: dict[str, Any]) -> tuple:
    return tuple(sorted((key, str(value)) for key, value in target.items() if key not in ("progress", "since")))


def clean_targets(raw: Any) -> list[dict[str, Any]]:
    """Presence from a browser, kept to the shapes the app shows: editing a step, uploading a video, or bringing in a
    project file from the list of projects (not in a project yet)."""
    if not isinstance(raw, list):
        raise HTTPException(422, "Presence is a list.")
    targets: list[dict[str, Any]] = []
    for item in raw[:MAX_TARGETS]:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        if kind == "editing" and all(isinstance(item.get(key), str) for key in ("run_id", "candidate_id")):
            targets.append({"kind": "editing", "run_id": item["run_id"][:64], "candidate_id": item["candidate_id"][:64]})
        elif kind == "uploading" and isinstance(item.get("project_id"), str) and isinstance(item.get("name"), str):
            progress = item.get("progress")
            targets.append({
                "kind": "uploading",
                "project_id": item["project_id"][:64],
                "name": item["name"][:240],
                "progress": round(min(1.0, max(0.0, float(progress))), 2) if isinstance(progress, (int, float)) else None,
            })
        elif kind == "importing_project" and isinstance(item.get("name"), str):
            progress = item.get("progress")
            targets.append({
                "kind": "importing_project",
                "name": item["name"][:240],
                "progress": round(min(1.0, max(0.0, float(progress))), 2) if isinstance(progress, (int, float)) else None,
            })
    return targets


class TaskWrites:
    """One change at a time to the steps of a task. A change waits for the one before it (they take moments)
    instead of failing; only one that waits TASK_WAIT_SECONDS gives up."""

    def __init__(self) -> None:
        self._locks: dict[str, RLock] = {}
        self._guard = Lock()

    @contextmanager
    def one_at_a_time(self, run_id: str) -> Iterator[None]:
        with self._guard:
            lock = self._locks.setdefault(run_id, RLock())
        if not lock.acquire(timeout=TASK_WAIT_SECONDS):
            raise HTTPException(409, TASK_BUSY)
        try:
            yield
        finally:
            lock.release()
