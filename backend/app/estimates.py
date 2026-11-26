"""About how long analyses still take, and how long the waiting ones wait, from what this server's analyses took before.

An analysis takes roughly so long per minute of recording, more for larger recordings: in proportion to its minutes times
the square root of its megapixels. The rate is the median of this server's last ``HISTORY`` finished analyses, so it
follows the server and how it is used. On a server's history of 132 analyses, an estimate made so before each one was
within half again of what it took for two in three of them, and within double for four in five. Progress is no better a
guide: it moves fast at first, so it would have promised too little.

An analysis that waits for a slot gets one when the analyses before it are done: the slots are filled in turn, each with
the next in line, from when those that hold one are expected to end. Fewer than ``LEAST`` finished analyses: no estimate.
"""

from __future__ import annotations

import json
import math
import statistics
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .database import connect

HISTORY = 20
LEAST = 5
FRESH_S = 1.0  # how long one look at the queue is used for, as every run in a list asks
SOON_S = 5.0  # what is left of an analysis that took longer than expected, as far as the ones behind it are concerned


@dataclass(frozen=True)
class Estimate:
    seconds_to_start: float | None = None  # while it waits for a slot
    seconds_left: float | None = None  # until it is done; None where there is nothing to go by
    # For an analysis that reads text afterwards: how many screenshots it is expected to have, and their pixels.
    screens: int = 0
    pixels: int = 0


def _size(minutes: float, width: int, height: int) -> float:
    return minutes * math.sqrt(max(width * height, 1) / 1e6)


def rate(history: list[tuple[float, float, int, int]]) -> float | None:
    """Seconds per unit of size from finished analyses: (seconds taken, minutes of recording, width, height)."""
    rates = [seconds / _size(minutes, width, height) for seconds, minutes, width, height in history if seconds > 0 and minutes > 0]
    return statistics.median(rates) if len(rates) >= LEAST else None


def plan(
    per_size: float | None,
    holding: list[tuple[str, float, float]],
    waiting: list[tuple[str, float]],
    slots: int | None,
) -> dict[str, Estimate]:
    """Estimates for the analyses that hold a slot ((run, expected seconds, seconds gone)) and those waiting for one, in
    line ((run, expected seconds)); ``slots`` None for no limit. Expected seconds come from ``rate`` and the size."""
    if per_size is None:
        return {}
    found: dict[str, Estimate] = {}
    free_at = []
    for run_id, expected, gone in holding:
        left = expected - gone
        found[run_id] = Estimate(seconds_left=left if left > 0 else None)
        free_at.append(max(left, SOON_S))
    room = len(waiting) if slots is None else max(0, slots - len(holding))
    free_at += [0.0] * room
    for run_id, expected in waiting:
        free_at.sort()
        start = free_at.pop(0) if free_at else 0.0
        found[run_id] = Estimate(seconds_to_start=start, seconds_left=start + expected)
        free_at.append(start + expected)
    return found


class AnalysisEstimates:
    """Estimates for every analysis that waits or runs, worked out once for all who ask within ``FRESH_S``."""

    def __init__(self, line) -> None:  # line: () -> (holding, waiting, slots), as JobManager.line gives them
        self._line = line
        self._lock = threading.Lock()
        self._made = -math.inf
        self._found: dict[str, Estimate] = {}

    def get(self, run_id: str) -> Estimate | None:
        with self._lock:
            self._refresh()
            return self._found.get(run_id)

    def text_joining(self) -> list[tuple[int, float, int]]:
        """Analyses whose text will be read once they are done: (screenshots expected, seconds until then, pixels)."""
        with self._lock:
            self._refresh()
            return [(found.screens, found.seconds_left, found.pixels) for found in self._found.values() if found.screens and found.seconds_left is not None]

    def _refresh(self) -> None:
        if time.monotonic() - self._made > FRESH_S:
            self._found = self._make()
            self._made = time.monotonic()

    def _make(self) -> dict[str, Estimate]:
        holding, waiting, slots = self._line()
        with connect() as conn:
            # Analyses that read text in the past also read it while they ran (before 1.5.0), and copies keep the
            # times of the run they were copied from: neither says how long an analysis takes.
            finished = conn.execute(
                """
                SELECT dr.started_at, dr.completed_at, dr.analysis_stable, dr.candidate_count, r.duration_ms, r.width, r.height
                FROM detection_runs dr JOIN recordings r ON r.id = dr.recording_id
                WHERE dr.status = 'completed' AND dr.analysis_engine = 'stable_v3' AND dr.started_at IS NOT NULL
                  AND dr.completed_at IS NOT NULL AND COALESCE(dr.message, '') NOT LIKE 'Duplicated from%'
                ORDER BY dr.completed_at DESC LIMIT ?
                """,
                (HISTORY * 2,),
            ).fetchall()
            active = {
                row["id"]: row
                for row in conn.execute(
                    """
                    SELECT dr.id, dr.status, dr.started_at, dr.created_at, dr.analysis_stable, r.duration_ms, r.width, r.height
                    FROM detection_runs dr JOIN recordings r ON r.id = dr.recording_id
                    WHERE dr.status IN ('queued', 'running')
                    ORDER BY dr.created_at
                    """
                ).fetchall()
            }
        history, steps_per_minute = [], []
        for row in finished:
            minutes = (row["duration_ms"] or 0) / 60000
            if minutes > 0:
                steps_per_minute.append((row["candidate_count"] or 0) / minutes)
            if (json.loads(row["analysis_stable"] or "{}") or {}).get("enable_ocr"):
                continue
            seconds = (_moment(row["completed_at"]) - _moment(row["started_at"])).total_seconds()
            history.append((seconds, minutes, row["width"] or 0, row["height"] or 0))
        per_size = rate(history[:HISTORY])
        if per_size is None:
            return {}
        steps_rate = statistics.median(steps_per_minute[:HISTORY]) if steps_per_minute else 0.0

        def expected(row: Any) -> float:
            return per_size * _size((row["duration_ms"] or 0) / 60000, row["width"] or 0, row["height"] or 0)

        now = datetime.now(timezone.utc)
        holding = [*holding, *(run_id for run_id, row in active.items() if row["status"] == "running" and run_id not in holding)]
        held = [
            (run_id, expected(active[run_id]), (now - _moment(active[run_id]["started_at"] or active[run_id]["created_at"])).total_seconds())
            for run_id in holding
            if run_id in active
        ]
        # those in line, then any that have not joined it yet (just started), in the order they were made
        line = [run_id for run_id in waiting if run_id in active]
        line += [run_id for run_id, row in active.items() if row["status"] == "queued" and run_id not in line and run_id not in holding]
        found = plan(per_size, held, [(run_id, expected(active[run_id])) for run_id in line], slots)
        for run_id, estimate in found.items():
            row = active.get(run_id)
            if row is not None and (json.loads(row["analysis_stable"] or "{}") or {}).get("enable_ocr"):
                screens = max(1, round(steps_rate * (row["duration_ms"] or 0) / 60000))
                found[run_id] = Estimate(estimate.seconds_to_start, estimate.seconds_left, screens, (row["width"] or 0) * (row["height"] or 0))
        return found


def _moment(value: str) -> datetime:
    moment = datetime.fromisoformat(value)
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
