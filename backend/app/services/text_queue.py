"""The screenshots whose text is still to be read, of every run, and the reader processes that read them.

Reading never delays an analysis or the app: it happens after the analysis, in processes of their own at low priority
(``app/text_reader.py``), one screenshot at a time each. However many runs wait, the readers stay as few as they are
set to be, and the runs take turns: ``TURN`` screenshots of one, then the next. So a run of 300 screens does not keep
one of 10 waiting. A run is read by one reader at a time, in order: the lines a screen has in common with the one
before it are not read again.

A reader that takes too long, dies or grows too large is replaced, and the screenshot it was on is tried once more. One
that cannot be read either time is marked and left. A reader without work ends after a while, and gives its memory back.

How long a run still has to wait is worked out from the same turns (``seconds_left``): before its last screenshot is
read, every other run has at most as many read, at the time a screenshot of it takes. That time is measured: the run's
own, once a few of its screenshots are read, or else what screenshots of its size took lately.
"""

from __future__ import annotations

import json
import logging
import math
import os
import statistics
import subprocess
import sys
import time
from collections import OrderedDict, deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Queue
from threading import Condition, Thread
from typing import Any

from . import text_models

logger = logging.getLogger("stepthrough")

TURN = 4  # screenshots of one run before the next run has its turn
SCREEN_TIMEOUT_S = 120  # a screenshot that takes longer is given up, and its reader replaced
START_TIMEOUT_S = 120
IDLE_S = 60  # a reader without work ends after this
MEMORY_LIMIT_MB = 2500  # a reader that used more is replaced after its screenshot
TRIES = 2
BACKEND = Path(__file__).resolve().parents[2]
LATELY = 50  # screenshots whose reading time stands for what screenshots take now
KNOWN_AFTER = 3  # screenshots of a run, or lately of any, before their time is believed


class Unavailable(Exception):
    """Why text cannot be read here at all: ``message`` for the person who asked for it, ``detail`` for the log and for
    administrators."""

    def __init__(self, message: str, detail: str) -> None:
        super().__init__(f"{message} {detail}")
        self.message, self.detail = message, detail


NOT_STARTED = "Text recognition could not be started."
NO_MODELS = f"The models for text recognition ({text_models.TOTAL_MB} MB, needed once) could not be fetched."


@dataclass(frozen=True)
class Screen:
    run_id: str
    step_id: str
    image: str
    pixels: int = 0  # of the screenshot, where it is known beforehand: for how long it will take


def seconds_left(
    waiting: dict[str, tuple[int, float | None]],
    run_id: str,
    readers: int,
    joining: list[tuple[int, float, float | None]] = (),
) -> float | None:
    """How long until the last screenshot of ``run_id`` is read. ``waiting`` has, for every run in the queue, how many of
    its screenshots are left and how long one takes (None: not known). Runs take turns, so before the last of this run
    every other run has at most as many read as this one has left; a run is read by one reader at a time.

    ``joining`` are runs that will join the queue (their analysis is still going): how many screenshots they are expected
    to have, in how many seconds they join, and how long one takes. One that joins in time takes turns from then on,
    while this run has fewer left."""
    left, each = waiting.get(run_id, (0, None))
    if not left or each is None or readers < 1:
        return None
    total = sum(min(count, left) * (seconds if seconds is not None else each) for count, seconds in waiting.values())
    eta = max(left * each, total / readers)
    for count, join_in, seconds in sorted(joining, key=lambda joiner: joiner[1]):
        if join_in >= eta:
            continue
        still = math.ceil(left * (1 - join_in / eta))
        total += min(count, still) * (seconds if seconds is not None else each)
        eta = max(left * each, total / readers)
    return eta


@dataclass(frozen=True)
class Reading:
    """What was read on a screenshot: its lines as ``Line.packed`` gives them, and its size. ``lines`` is None when it
    could not be read."""

    lines: list[list[Any]] | None
    width: int = 0
    height: int = 0


def _command(*options: str) -> dict[str, Any]:
    """How a reader process is started, as arguments for subprocess."""
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW
    return {
        "args": [sys.executable, "-m", "app.text_reader", *options],
        "cwd": BACKEND,
        "env": {**os.environ, "PYTHONIOENCODING": "utf-8"},
        "text": True,
        "encoding": "utf-8",
        "creationflags": flags,
    }


def check() -> dict[str, Any]:
    """Whether text can be read here: what ``python -m app.text_reader --check`` says."""
    try:
        answer = subprocess.run(
            **_command("--check"), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=START_TIMEOUT_S
        )
        return json.loads(answer.stdout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "it did not start in time"}
    except (OSError, ValueError):
        return {"ok": False, "error": "its process could not be started"}


class Reader:
    """One reader process."""

    def __init__(self, models: Path, threads: int) -> None:
        self.threads = threads
        self._answers: Queue[dict[str, Any] | None] = Queue()
        self._process = subprocess.Popen(
            **_command("--models", str(models), "--threads", str(threads)),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=1,
        )
        Thread(target=self._listen, name="stepthrough-text-answers", daemon=True).start()
        started = self._next(START_TIMEOUT_S)
        if started is None or not started.get("ready"):
            self.stop()
            raise Unavailable(NOT_STARTED, (started or {}).get("error") or "Its process did not answer.")

    def _listen(self) -> None:
        assert self._process.stdout is not None
        try:
            for line in self._process.stdout:
                self._answers.put(json.loads(line))
        except ValueError:
            pass  # half an answer: it ended while writing it
        finally:
            self._answers.put(None)
            self._process.stdout.close()

    def _next(self, timeout: float) -> dict[str, Any] | None:
        try:
            return self._answers.get(timeout=timeout)
        except Empty:
            return None

    def read(self, screen: Screen) -> dict[str, Any] | None:
        """What the process answers about a screenshot; None when it died or hung."""
        assert self._process.stdin is not None
        try:
            self._process.stdin.write(json.dumps({"id": screen.step_id, "run": screen.run_id, "image": screen.image}) + "\n")
            self._process.stdin.flush()
        except (OSError, ValueError):  # its input is closed
            return None
        return self._next(SCREEN_TIMEOUT_S)

    def stop(self) -> None:
        self._process.kill()
        self._process.wait()
        try:
            if self._process.stdin is not None:
                self._process.stdin.close()
        except (OSError, ValueError):
            pass  # what was still to be written to it is lost, as it should be


class TextQueue:
    """``keep`` is told what was read on each screen, and answers whether its run is still to be read; ``turn_over`` that
    a run's turn ended; ``give_up`` that the text of these runs cannot be read, and why."""

    def __init__(
        self,
        *,
        keep: Callable[[Screen, Reading], bool],
        turn_over: Callable[[str], None],
        give_up: Callable[[list[str], Unavailable], None],
        readers: int = 1,
        threads: int = 1,
    ) -> None:
        self._keep, self._turn_over, self._give_up = keep, turn_over, give_up
        self._readers, self._threads = readers, threads
        self._changed = Condition()
        self._waiting: OrderedDict[str, list[Screen]] = OrderedDict()  # run by run, the next to have its turn first
        self._reading: set[str] = set()  # runs whose turn it is
        self._serving: dict[int, Thread] = {}
        self._live: dict[int, Reader] = {}
        self._closed = False
        # How long reading took: each run's own (seconds, screenshots), and lately of any (seconds per megapixel, and
        # per screenshot)
        self._took: dict[str, tuple[float, int]] = {}
        self._per_megapixel: deque[float] = deque(maxlen=LATELY)
        self._per_screen: deque[float] = deque(maxlen=LATELY)
        self._in_turn: dict[str, int] = {}  # screenshots of the turn being read, not read yet
        self._pixels: dict[str, int] = {}

    # ── asking ────────────────────────────────────────────────────────────────────────────────────────────────

    def add(self, run_id: str, screens: Iterable[Screen]) -> None:
        with self._changed:
            waiting = self._waiting.get(run_id, [])
            there = {screen.step_id for screen in waiting}
            waiting = [*waiting, *(screen for screen in screens if screen.step_id not in there)]
            if waiting and not self._closed:
                self._waiting[run_id] = waiting
                self._pixels[run_id] = waiting[-1].pixels or self._pixels.get(run_id, 0)
                self._start_serving()
                self._changed.notify_all()

    def seconds_left(self, run_id: str, joining: list[tuple[int, float, int]] = ()) -> float | None:
        """About how long until the text of the run is read; None when there is nothing to go by yet. ``joining``: runs
        still being analysed that will join, as (screenshots expected, seconds until they join, pixels)."""
        with self._changed:
            runs = set(self._waiting) | set(self._reading)
            waiting = {run: (len(self._waiting.get(run, [])) + self._in_turn.get(run, 0), self._each(run)) for run in runs}
            later = [(count, join_in, self._each_of_size(pixels)) for count, join_in, pixels in joining]
            return seconds_left(waiting, run_id, self._readers, later)

    def _each_of_size(self, pixels: int) -> float | None:
        if pixels and len(self._per_megapixel) >= KNOWN_AFTER:
            return statistics.median(self._per_megapixel) * pixels / 1e6
        return statistics.median(self._per_screen) if len(self._per_screen) >= KNOWN_AFTER else None

    def _each(self, run_id: str) -> float | None:
        """How long a screenshot of the run takes to read, as far as is known."""
        seconds, count = self._took.get(run_id, (0.0, 0))
        if count >= KNOWN_AFTER:
            return seconds / count
        return self._each_of_size(self._pixels.get(run_id, 0))

    def _measured(self, screen: Screen, seconds: float, pixels: int) -> None:
        with self._changed:
            total, count = self._took.get(screen.run_id, (0.0, 0))
            self._took[screen.run_id] = (total + seconds, count + 1)
            self._per_screen.append(seconds)
            if pixels:
                self._per_megapixel.append(seconds / (pixels / 1e6))

    def remove(self, run_id: str) -> None:
        """Leave what is still waiting of a run unread. A screen being read right now is still answered."""
        with self._changed:
            self._waiting.pop(run_id, None)
            self._took.pop(run_id, None)

    def set_limits(self, readers: int, threads: int) -> None:
        """How many readers there may be (0: none, nothing is read), and how many threads each has."""
        with self._changed:
            self._readers, self._threads = readers, threads
            if self._waiting:
                self._start_serving()
            self._changed.notify_all()

    def has(self, run_id: str) -> bool:
        """Whether something of the run waits or is being read."""
        with self._changed:
            return run_id in self._waiting or run_id in self._reading

    def waiting(self) -> int:
        with self._changed:
            return sum(len(screens) for screens in self._waiting.values())

    def close(self, timeout: float = 10) -> None:
        """End, at once: what is being read is left too."""
        with self._changed:
            self._closed = True
            self._waiting.clear()
            self._changed.notify_all()
            threads, readers = list(self._serving.values()), list(self._live.values())
        for reader in readers:
            reader.stop()
        for thread in threads:
            thread.join(timeout)

    # ── reading ───────────────────────────────────────────────────────────────────────────────────────────────

    def _start_serving(self) -> None:
        for number in range(self._readers):
            thread = self._serving.get(number)
            if thread is None or not thread.is_alive():
                thread = Thread(target=self._serve, args=(number,), name=f"stepthrough-text-{number}", daemon=True)
                self._serving[number] = thread
                thread.start()

    def _next_turn(self, number: int) -> list[Screen] | None:
        """The next few screens of the run whose turn it is; None when there is nothing to read for a while, or this
        reader is one too many."""
        end = time.monotonic() + IDLE_S
        with self._changed:
            while not self._closed and number < self._readers:
                for run_id in self._waiting:
                    if run_id not in self._reading:
                        waiting = self._waiting[run_id]
                        if rest := waiting[TURN:]:
                            self._waiting[run_id] = rest
                        else:
                            del self._waiting[run_id]
                        self._reading.add(run_id)
                        self._in_turn[run_id] = len(waiting[:TURN])
                        return waiting[:TURN]
                left = end - time.monotonic()
                if left <= 0:
                    break
                self._changed.wait(left)
            # Under the lock, so that nothing is added between this reader's last look and its end.
            del self._serving[number]
            reader = self._live.pop(number, None)
            if reader is not None:
                reader.stop()
            return None

    def _serve(self, number: int) -> None:
        while turn := self._next_turn(number):
            run_id = turn[0].run_id
            given_up = False
            try:
                self._read_turn(turn, number)
            except Unavailable as why:
                given_up = True
                self._everything_given_up(run_id, why)
            except Exception:  # pragma: no cover - whatever went wrong, the other runs go on
                logger.exception("Reading the text of run %s stopped", run_id)
                self._stop_reader(number)
            finally:
                with self._changed:
                    self._reading.discard(run_id)
                    self._in_turn.pop(run_id, None)
                    if run_id not in self._waiting:
                        self._took.pop(run_id, None)
                        self._pixels.pop(run_id, None)
                    if run_id in self._waiting:
                        self._waiting.move_to_end(run_id)  # behind those that came during its turn
                    self._changed.notify_all()
            if not given_up:
                self._tell(self._turn_over, run_id)

    def _read_turn(self, turn: list[Screen], number: int) -> None:
        for screen in turn:
            reading = Reading(None)
            for _ in range(TRIES):
                if self._closed:
                    return
                answer = self._reader(number).read(screen)
                if answer is None:
                    if not self._closed:
                        logger.warning("A text recognition process ended or took too long on a screenshot, and was replaced.")
                    self._stop_reader(number)
                    continue
                if "error" in answer:
                    logger.warning("The text of a screenshot could not be read: %s", answer["error"])
                else:
                    reading = Reading(answer["lines"], answer["width"], answer["height"])
                    if isinstance(answer.get("seconds"), (int, float)):
                        self._measured(screen, float(answer["seconds"]), answer["width"] * answer["height"])
                if (answer.get("memory_mb") or 0) > MEMORY_LIMIT_MB:
                    self._stop_reader(number)
                break
            if self._closed:
                return
            with self._changed:
                self._in_turn[screen.run_id] = max(0, self._in_turn.get(screen.run_id, 1) - 1)
            if not self._keep(screen, reading):
                self.remove(screen.run_id)
                return

    def _reader(self, number: int) -> Reader:
        reader = self._live.get(number)
        if reader is not None and reader.threads != self._threads:
            self._stop_reader(number)
            reader = None
        if reader is None:
            try:
                reader = Reader(text_models.ensure(), self._threads)
            except text_models.ModelsUnavailable as error:
                raise Unavailable(NO_MODELS, str(error)) from error
            except OSError as error:
                raise Unavailable(NOT_STARTED, str(error)) from error
            with self._changed:
                self._live[number] = reader
        return reader

    def _stop_reader(self, number: int) -> None:
        with self._changed:
            reader = self._live.pop(number, None)
        if reader is not None:
            reader.stop()

    def _everything_given_up(self, run_id: str, why: Unavailable) -> None:
        logger.warning("Text cannot be read: %s", why)
        with self._changed:
            runs = [run_id, *(other for other in self._waiting if other != run_id)]
            self._waiting.clear()
        self._tell(self._give_up, runs, why)

    def _tell(self, told: Callable[..., None], *what: Any) -> None:
        try:
            told(*what)
        except Exception:  # pragma: no cover - a listener's trouble must not stop the reading
            logger.exception("Could not pass on what became of a text reading")
