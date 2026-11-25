"""How well the engine does on the recordings of the web tester (``webrec.py``), by what the app's log says happened
(``webtruth.py``).

For every recording it asks:

    steps       which of the expected steps were found, and what the others it found were
                (a row lighting up, a clip, half-typed text, something under way, ...)
    labels      whether a step's label fits what led to it
    boxes       whether steps of one screen share a box in the pathway, and steps of different screens do not
    returns     whether a screen that is come back to is known again

Usage (from backend/, after ``python -m tests.eval.webrec``)::

    python -m tests.eval.webscore                  # both sets; the one kept apart only as totals
    python -m tests.eval.webscore --set dev --steps --only console_a
    python -m tests.eval.webscore --json results.json

The set that is kept apart ("held") is there to check on: look at its totals, not at its single recordings, or it is no
longer kept apart.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.analysis_metadata import STABLE_RECORDING_TYPES
from app.models import RunSettings, StableSettings
from app.services import stable_detection
from app.services.ingest import build_working_copy
from app.services.pathway import _group_candidates
from app.services.video import probe_video

from .webrec import OUT
from .webtruth import State, Truth, derive, load

RECORDING_TYPE = {"computer": "desktop", "phone": "phone"}
EDGE_MS = 70  # frames are 33 to 67 ms apart

# Which of the engine's labels fit what happened.
SMALL = {"content_update", "small_ui_change"}
FITS: dict[str, set[str]] = {
    "feed_swap": {"feed_card_swap"},
    "navigation": {"navigation"},
    "overlay_open": {"modal"},
    "overlay_close": {"modal_close"},
    "typing": {"text_entry"},
    "scroll": {"scroll"},
    "moved": SMALL | {"scroll"},
    "stream": SMALL | {"scroll"},
    "sent": SMALL | {"scroll"},
    "theme": SMALL | {"navigation"},
    "keyboard": SMALL | {"navigation"},
    "load": SMALL | {"navigation"},
    "expand": SMALL | {"scroll"},
    "shift": SMALL | {"scroll"},
    "update": SMALL | {"navigation"},
    "small": SMALL,
    "toast": SMALL | {"modal", "modal_close"},  # a note over the screen, whatever one calls it
    "none": set(),
}
KIND_NAMES = {"overlay_open": "overlay opens", "overlay_close": "overlay closes", "feed_swap": "feed swipe"}


@dataclass
class Score:
    name: str
    group: str
    device: str
    expected: int = 0
    found: int = 0
    tiny: int = 0  # missed, but the change was below the smallest change that is set
    steps: int = 0  # the engine's
    optional: int = 0  # of those, on something that may be a step or not
    extra: Counter = field(default_factory=Counter)
    missed: Counter = field(default_factory=Counter)  # by what led to the step
    wanted: Counter = field(default_factory=Counter)
    labelled: Counter = field(default_factory=Counter)  # (what happened, the engine's label)
    labels_right: int = 0
    labels_checked: int = 0
    pairs: Counter = field(default_factory=Counter)  # same box: true, found, both
    boxes: tuple[int, int] = (0, 0)  # as it should be, as it is
    returns: int = 0
    returns_found: int = 0
    lines: list[str] = field(default_factory=list)

    @property
    def extras(self) -> int:
        return sum(self.extra.values())


def detect(video: Path, kind: str, **settings: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    info = probe_video(video)
    report: dict[str, Any] = {}
    with tempfile.TemporaryDirectory() as frames:
        candidates = stable_detection.detect_candidates_stable(
            video_path=video, frames_dir=Path(frames), duration_ms=info.duration_ms, fps=info.fps,
            settings=RunSettings(stable=StableSettings(recording_type=kind, **settings)), width=info.width, height=info.height, report=report,
        )
    return candidates, report


def working_copy(folder: Path) -> Path:
    working = folder / "working.mp4"
    source = folder / "video.mp4"
    if not working.exists() or working.stat().st_mtime < source.stat().st_mtime:
        build_working_copy(source, working)
    return working


def measure_changes(truth: Truth, video: Path) -> None:
    """How much of the picture each step differs from the one before, as the engine would see it."""
    info = probe_video(video)
    size = stable_detection._analysis_size(info.width, info.height)
    wanted = {min(state.end - 40, state.start + min(250, state.ms // 2)): state for state in truth.steps}
    pictures: dict[int, np.ndarray] = {}
    marks = sorted(wanted)
    position = 0
    for index, frame in enumerate(stable_detection._decode(video, 15.0, size, lambda: False)):
        at = index * 1000 / 15
        while position < len(marks) and marks[position] <= at + 34:
            pictures[marks[position]] = frame
            position += 1
        if position == len(marks):
            break
    previous = None
    for mark in marks:
        picture = pictures.get(mark)
        if previous is not None and picture is not None:
            changed = (cv2.blur(cv2.absdiff(previous, picture), (3, 3)) > stable_detection.PIXEL_THRESHOLD_FLOOR).astype(np.uint8)
            count, _labels, stats, _centres = cv2.connectedComponentsWithStats(cv2.dilate(changed, np.ones((3, 3), np.uint8)))
            wanted[mark].change_share = float(stats[1:, cv2.CC_STAT_AREA].max() / changed.size) if count > 1 else 0.0
        previous = picture if picture is not None else previous


def cause(truth: Truth, state: State | None, at: int, before: int) -> str:
    """What made the engine see a step here that is none."""
    if state is None:
        return "something under way"
    if state.kind in ("typing", "streaming"):
        return {"typing": "half-typed text", "streaming": "answer streaming"}[state.kind]
    if state.kind == "short":
        previous = [other for other in truth.states if other.end <= state.start]
        if previous and previous[-1].shown["fields"] != state.shown["fields"]:
            return "half-typed text"
        return "too short a screen"
    if any(before < when <= at for when, _name in state.hovers[1:]):
        return "row or button lighting up"
    if state.loops:
        return "clip or spinner"
    lately = {what for when, what in state.noises if at - 700 < when <= at}
    if "scroll bar" in lately:
        return "scroll bar fading"
    if "pointer" in lately:
        return "pointer moving"
    return "nothing the app did"


def score_recording(folder: Path, **settings: Any) -> Score:
    data = load(folder)
    video = working_copy(folder)
    candidates, _report = detect(video, RECORDING_TYPE[data["device"]], **settings)
    return score_candidates(data, video, candidates, **settings)


def score_candidates(data: dict[str, Any], video: Path, candidates: list[dict[str, Any]], **settings: Any) -> Score:
    kind = RECORDING_TYPE[data["device"]]
    dwell = settings.get("min_dwell_ms") or STABLE_RECORDING_TYPES[kind].min_dwell_ms
    smallest = (settings.get("min_change_percent") or STABLE_RECORDING_TYPES[kind].min_change_percent) / 100
    truth = derive(data, dwell)
    measure_changes(truth, video)
    groups, reasons = _group_candidates([{**candidate, "screen_link": None, "screen_kind": None} for candidate in candidates], "screens")

    score = Score(f"{data['scenario']} {data['device']}", data["group"], data["device"])
    score.steps = len(candidates)
    taken: dict[int, dict[str, Any]] = {}  # which step of the truth a candidate is
    before = 0
    for candidate in candidates:
        at = candidate["timestamp_ms"]
        if not data.get("from_ms", 0) <= at <= data["duration_ms"]:
            score.steps -= 1  # before the first flash, or after the last, of a recording made elsewhere
            continue
        label = candidate["score_breakdown"]["transition_type"]
        place = next((k for k, state in enumerate(truth.steps) if state.start - EDGE_MS <= at < state.end + EDGE_MS), None)
        here = truth.state_at(at) or truth.state_at(at - EDGE_MS)
        if place is not None and place not in taken:
            taken[place] = candidate
            state = truth.steps[place]
            score.optional += state.optional
            score.lines.append(f"{at / 1000:7.2f}  {label:16} found   {state.primary:13} {state.box}{'  (return)' if state.returns else ''}")
        else:
            why = cause(truth, truth.steps[place] if place is not None else here, at, before)
            score.extra[why] += 1
            score.lines.append(f"{at / 1000:7.2f}  {label:16} extra   {why}")
        before = at

    for k, state in enumerate(truth.steps):
        if state.optional:
            continue
        score.expected += 1
        what = "opening" if k == 0 else state.primary
        score.wanted[what] += 1
        if k in taken:
            score.found += 1
        else:
            score.missed[what] += 1
            if state.change_share is not None and state.change_share < smallest:
                score.tiny += 1
            share = f"{100 * state.change_share:.2f} % of the screen" if state.change_share is not None else ""
            score.lines.append(f"{state.start / 1000:7.2f}  {'':16} MISSED  {state.primary:13} {state.box} ({state.ms} ms, {share})")

    order = sorted(taken)
    for previous, k in zip(order, order[1:]):
        state = truth.steps[k]
        label = taken[k]["score_breakdown"]["transition_type"]
        # with steps missed in between, the label describes all that happened since the one before
        kinds = {kind for step in truth.steps[previous + 1 : k + 1] for kind in step.kinds}
        score.labels_checked += 1
        right = any(label in FITS[kind] for kind in kinds)
        score.labels_right += right
        score.labelled[(state.primary, label if not right else "right")] += 1

    boxes = {k: truth.steps[k].box for k in order}
    found_group = {k: groups[taken[k]["id"]] for k in order}
    for position, a in enumerate(order):
        for b in order[position + 1 :]:
            same, together = boxes[a] == boxes[b], found_group[a] == found_group[b]
            score.pairs["same"] += same
            score.pairs["together"] += together
            score.pairs["both"] += same and together
    score.boxes = (len(set(boxes.values())), len(set(found_group.values())))
    for position, k in enumerate(order):
        earlier = [other for other in order[:position] if boxes[other] == boxes[k]]
        if not earlier or all(boxes[other] == boxes[k] for other in order[order.index(earlier[-1]) : position]):
            continue
        score.returns += 1
        score.returns_found += any(found_group[other] == found_group[k] for other in earlier)
    score.lines.sort(key=lambda line: float(line.split()[0]))
    return score


def add_up(scores: list[Score], name: str) -> Score:
    total = Score(name, "", "")
    for score in scores:
        for number in ("expected", "found", "tiny", "steps", "optional", "labels_right", "labels_checked", "returns", "returns_found"):
            setattr(total, number, getattr(total, number) + getattr(score, number))
        for counter in ("extra", "missed", "wanted", "labelled", "pairs"):
            getattr(total, counter).update(getattr(score, counter))
        total.boxes = (total.boxes[0] + score.boxes[0], total.boxes[1] + score.boxes[1])
    return total


def ratio(part: float, whole: float) -> str:
    return f"{100 * part / whole:3.0f} %" if whole else "  -  "


def row(score: Score) -> str:
    sure = score.steps - score.optional
    recall, precision = score.found / max(1, score.expected), score.found / max(1, sure)
    f1 = 2 * recall * precision / max(1e-9, recall + precision)
    pairs = score.pairs
    pair_precision, pair_recall = pairs["both"] / max(1, pairs["together"]), pairs["both"] / max(1, pairs["same"])
    pair_f1 = 2 * pair_precision * pair_recall / max(1e-9, pair_precision + pair_recall)
    return (f"{score.name:24} {score.found:4}/{score.expected:<4} {score.extras:5}   {f1:4.2f}   {ratio(score.labels_right, score.labels_checked)}  "
            f"{score.boxes[1]:4} for {score.boxes[0]:<4} {pair_f1:4.2f}    {score.returns_found:3}/{score.returns:<3}")


HEADER = f"{'':24} {'found':>9} {'extra':>5}   {'F1':>4}   {'labels':>5}  {'boxes':>13} {'':4}    {'returns':>7}"


def report(scores: list[Score], *, steps: bool, held: bool) -> None:
    for group in ("dev", "held", "real"):
        mine = [score for score in scores if score.group == group]
        if not mine:
            continue
        print(f"\n{ {'dev': 'to develop with', 'held': 'kept apart', 'real': 'recorded elsewhere'}[group] }\n{HEADER}")
        if group != "held" or held:
            for score in mine:
                print(row(score))
                if steps:
                    print("\n".join(f"      {line}" for line in score.lines))
        for device in ("computer", "phone"):
            those = [score for score in mine if score.device == device]
            if those:
                print(row(add_up(those, f"all on a {device}")))
        total = add_up(mine, "all")
        print(row(total))
        print("\n  what the steps were that are none: " + (", ".join(f"{why} {count}" for why, count in total.extra.most_common()) or "none"))
        print("  missed: " + (", ".join(f"{KIND_NAMES.get(kind, kind)} {count} of {total.wanted[kind]}" for kind, count in total.missed.most_common()) or "none")
              + (f" ({total.tiny} of them a change below the smallest change)" if total.tiny else ""))
        by_kind: dict[str, Counter] = defaultdict(Counter)
        for (kind, label), count in total.labelled.items():
            by_kind[kind][label] += count
        print("  labels: " + "; ".join(
            f"{KIND_NAMES.get(kind, kind)} {found['right']} of {sum(found.values())}"
            + (f" ({', '.join(f'{label} {count}' for label, count in found.most_common() if label != 'right')})" if found.total() > found["right"] else "")
            for kind, found in sorted(by_kind.items(), key=lambda item: -item[1].total())))


def recordings(out: Path, group: str, only: str | None) -> list[Path]:
    names = set(only.split(",")) if only else None
    found = []
    for folder in sorted(out.glob("*/*")):
        if (folder / "log.json").exists() and group in ("all", folder.parent.name) and (names is None or folder.name.split("__")[0] in names):
            found.append(folder)
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--set", choices=("dev", "held", "real", "all"), default="all")
    parser.add_argument("--only")
    parser.add_argument("--steps", action="store_true", help="every step and what it was (of the set to develop with)")
    parser.add_argument("--show-held", action="store_true", help="also the single recordings of the set kept apart")
    parser.add_argument("--json", type=Path)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    args = parser.parse_args()
    folders = recordings(args.out, args.set, args.only)
    if not folders:
        parser.error("no recordings: run python -m tests.eval.webrec first")
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        scores = list(pool.map(score_recording, folders))
    print(f"engine {stable_detection.ENGINE_VERSION}, {len(scores)} recordings")
    report(scores, steps=args.steps, held=args.show_held)
    if args.json:
        args.json.write_text(json.dumps([{**score.__dict__, "labelled": {f"{a} > {b}": n for (a, b), n in score.labelled.items()}} for score in scores], indent=1, default=dict))


if __name__ == "__main__":
    main()
