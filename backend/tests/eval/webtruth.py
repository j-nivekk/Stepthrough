"""What a recording of the web tester should give, worked out from the app's own log (``webrec.py``).

The rule is the one Stepthrough states: a step is a screen that stays still for at least the minimum time on screen.
Whether it stays still is asked of the log and not of the picture: the same screen, with the same things over it, every
pane scrolled as far, the same text in the fields, and nothing under way. A pointer that moves, a row that lights up
under it, a clip that plays, a scroll bar that fades and a caret that blinks change none of that, so they are no steps.

So there is nothing to mark by hand, and the same recording gives its steps for any minimum time on screen.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

NEAR_MS = 130  # a screen this close to the minimum time on screen may be a step or not
TYPING_PAUSE_MS = 6000  # a longer pause ends a burst of typing
CREEP_PX = 2  # a scroll's last few pixels (of the app's own) take long, and nobody sees them move
PASSING = ("toast", "tooltip")  # come and go by themselves: a step or not, as one likes
POPUPS = ("menu", "submenu", "popover", "dialog", "sheet", "drawer", "panel")

# What a change is called when several things happened at once: the first of these.
ORDER = ("feed_swap", "navigation", "overlay_open", "overlay_close", "typing", "scroll", "theme", "keyboard", "stream",
         "sent", "load", "expand", "shift", "update", "moved", "small", "toast")


@dataclass
class State:
    """A stretch of the recording in which nothing the app shows changed."""

    start: int
    end: int
    shown: dict[str, Any]
    kind: str = "step"  # step, near, short, typing, streaming
    kinds: tuple[str, ...] = ()  # what happened between the step before and this one
    hovers: list[tuple[int, str | None]] = field(default_factory=list)
    loops: set[str] = field(default_factory=set)
    noises: list[tuple[int, str]] = field(default_factory=list)  # a scroll bar that fades, a pointer that moves
    areas: dict[str, list[int]] = field(default_factory=dict)
    passing: bool = False  # only a toast or a tooltip tells it apart from the step before
    returns: bool = False  # the box was shown before, with another in between
    change_share: float | None = None  # how much of the picture differs from the step before (webscore.py)
    page: str = ""  # the screen it is on: the cards of one feed are one screen, as they are in a pathway

    @property
    def ms(self) -> int:
        return self.end - self.start

    @property
    def screen(self) -> str:
        return self.shown["screen"]

    @property
    def box(self) -> str:
        """What the step shows in a pathway: the screen, and what lies over it."""
        over = [overlay["id"] for overlay in self.shown["overlays"] if overlay["kind"] in POPUPS]
        return " | ".join([self.page or self.screen, *over])

    @property
    def primary(self) -> str:
        return next((kind for kind in ORDER if kind in self.kinds), "none")

    @property
    def optional(self) -> bool:
        return self.kind == "near" or self.passing


@dataclass
class Truth:
    meta: dict[str, Any]
    states: list[State]  # every stretch, also those that are no steps
    steps: list[State]  # those that are, in order; the first is the opening screen
    segments: list[dict[str, Any]]
    entries: list[dict[str, Any]]

    def state_at(self, ms: float) -> State | None:
        return next((state for state in self.states if state.start <= ms < state.end), None)


def shown(snapshot: dict[str, Any], *, passing: bool = True) -> dict[str, Any]:
    """What the app shows, without what only looks different (pointer, highlight, clips)."""
    overlays = [overlay for overlay in snapshot["overlays"] if passing or overlay["kind"] not in PASSING]
    return {key: snapshot[key] for key in ("screen", "panes", "fields", "marks", "content")} | {"overlays": overlays}


def _plain(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True)


def _field_that_differs(a: dict[str, Any], b: dict[str, Any]) -> str | None:
    """The one field whose text is all that differs (a list that follows what is typed counts as that)."""
    if _plain({**a, "fields": {}}) != _plain({**b, "fields": {}}):
        return None
    names = [name for name in {*a["fields"], *b["fields"]} if a["fields"].get(name) != b["fields"].get(name)]
    return names[0] if len(names) == 1 else None


def load(folder: Path) -> dict[str, Any]:
    return json.loads((folder / "log.json").read_text())


def settle(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The log with the end of every scroll brought forward to where it all but stands still."""
    settled = list(entries)
    for position in range(len(settled) - 2, -1, -1):
        now, following = settled[position]["snapshot"], settled[position + 1]["snapshot"]
        if now["moving"] != ["scroll"] or following["moving"] or now["screen"] != following["screen"]:
            continue
        if now["panes"].keys() != following["panes"].keys():
            continue
        if all(abs(a - b) <= CREEP_PX for name in now["panes"] for a, b in zip(now["panes"][name], following["panes"][name])):
            settled[position] = {**settled[position], "snapshot": {**now, "panes": following["panes"], "moving": []}}
    return settled


def derive(data: dict[str, Any], min_dwell_ms: int) -> Truth:
    entries = settle(data["log"])
    meta = {key: value for key, value in data.items() if key != "log"}
    duration = meta["duration_ms"]
    times = [entry["snapshot"]["t"] for entry in entries] + [duration]

    states: list[State] = []
    current: State | None = None
    key = ""
    pointer = None
    for position, entry in enumerate(entries):
        snapshot = entry["snapshot"]
        pointer, pointed = None if meta["device"] == "phone" else snapshot["pointer"], pointer
        start, end = times[position], times[position + 1]
        now = _plain(shown(snapshot)) + (" streaming" if snapshot["streams"] else "")
        if snapshot["moving"]:
            current = None
            continue
        if current is None or now != key:
            current = State(start, end, shown(snapshot), areas=snapshot["areas"])
            if snapshot["streams"]:
                current.kind = "streaming"
            current.hovers.append((start, snapshot["hover"]))
            states.append(current)
            key = now
        else:
            current.end = end
            if snapshot["streams"]:
                current.kind = "streaming"
            if snapshot["hover"] != current.hovers[-1][1]:
                current.hovers.append((start, snapshot["hover"]))
        current.loops.update(snapshot["loops"])
        if snapshot["noise"]:
            current.noises.append((start, "pointer" if pointer != pointed else "scroll bar"))

    for state in states:
        if state.kind == "streaming":
            continue
        if state.ms < min_dwell_ms - NEAR_MS:
            state.kind = "short"
        elif state.ms < min_dwell_ms + NEAR_MS:
            state.kind = "near"

    # A burst of typing is one step, showing the finished text: what comes before that is part of it.
    for before, state, after in zip(states, states[1:], states[2:]):
        if state.kind in ("step", "near") and state.ms <= TYPING_PAUSE_MS:
            typed = _field_that_differs(before.shown, state.shown)
            if typed and typed == _field_that_differs(state.shown, after.shown):
                state.kind = "typing"

    steps: list[State] = []
    for state in states:
        if state.kind not in ("step", "near"):
            continue
        if steps and _plain(steps[-1].shown) == _plain(state.shown):
            # the same again after something too short to be a step
            steps[-1].end = state.end
            steps[-1].hovers += state.hovers
            steps[-1].loops |= state.loops
            steps[-1].noises += state.noises
            if state.kind == "step":
                steps[-1].kind = "step"
            continue
        steps.append(state)

    for before, state in zip(steps, steps[1:]):
        state.kinds = _kinds(before, state, entries)
        state.passing = _plain(_without_passing(before.shown)) == _plain(_without_passing(state.shown))
    feeds: dict[str, str] = {}
    for entry in entries:
        for event in entry.get("events", []):
            if event["kind"] == "feed_swap":
                feeds[event["to"]] = feeds.setdefault(event["from"], event["from"])
    for state in states:
        state.page = feeds.get(state.screen, state.screen)
    seen: dict[str, int] = {}
    for position, state in enumerate(steps):
        state.returns = state.box in seen and any(steps[k].box != state.box for k in range(seen[state.box] + 1, position))
        seen[state.box] = position
    return Truth(meta, states, steps, _segments(entries, times), entries)


def _without_passing(value: dict[str, Any]) -> dict[str, Any]:
    return {**value, "overlays": [overlay for overlay in value["overlays"] if overlay["kind"] not in PASSING]}


def _kinds(before: State, after: State, entries: list[dict[str, Any]]) -> tuple[str, ...]:
    kinds: set[str] = set()
    moving: set[str] = set()
    for entry in entries:
        at = entry["snapshot"]["t"]
        if not before.end - 40 <= at <= after.start + 5:
            continue
        moving.update(entry["snapshot"]["moving"])
        kinds.update(event["kind"] for event in entry.get("events", []))
        if entry["snapshot"]["streams"]:
            kinds.add("stream")
    a, b = before.shown, after.shown
    if a["screen"] != b["screen"]:
        kinds.add("feed_swap" if "feed_swap" in kinds else "navigation")
    else:
        kinds -= {"navigation", "feed_swap"}
        panes = [name for name in {*a["panes"]} & {*b["panes"]} if a["panes"][name] != b["panes"][name]]
        if panes:
            kinds.add("scroll" if "scroll" in moving else "moved")
    over_a = {overlay["id"] for overlay in a["overlays"] if overlay["kind"] in POPUPS}
    over_b = {overlay["id"] for overlay in b["overlays"] if overlay["kind"] in POPUPS}
    kinds -= {"overlay_open", "overlay_close"}
    if over_b - over_a:
        kinds.add("overlay_open")
    if over_a - over_b:
        kinds.add("overlay_close")
    if any(a["fields"].get(name) != value for name, value in b["fields"].items() if name in a["fields"]):
        kinds.add("typing")
    toasts = [[overlay["id"] for overlay in each["overlays"] if overlay["kind"] in PASSING] for each in (a, b)]
    kinds -= {"toast", "tooltip"}
    if toasts[0] != toasts[1]:
        kinds.add("toast")
    return tuple(kind for kind in ORDER if kind in kinds)


def _segments(entries: list[dict[str, Any]], times: list[int]) -> list[dict[str, Any]]:
    """Scrolling, typing, overlays, answers that stream and clips: from when to when, and where."""
    found: list[dict[str, Any]] = []
    running: dict[tuple[str, str], dict[str, Any]] = {}

    def go_on(kind: str, name: str, at: int, gap: int, **more: Any) -> None:
        segment = running.get((kind, name))
        if segment and at - segment["end"] <= gap:
            segment["end"] = at
            segment.update({key: value for key, value in more.items() if key in ("to", "area")})
        else:
            segment = {"kind": kind, "name": name, "start": at, "end": at, **more}
            running[(kind, name)] = segment
            found.append(segment)

    for position, (before, entry) in enumerate(zip(entries, entries[1:]), start=1):
        a, b = before["snapshot"], entry["snapshot"]
        at = b["t"]
        for name, scrolled in b["panes"].items():
            if name in a["panes"] and a["panes"][name] != scrolled and a["screen"] == b["screen"]:
                kind = "scroll" if "scroll" in b["moving"] or "scroll" in a["moving"] else "moved"
                go_on(kind, name, at, 400, area=b["areas"].get(f"pane {name}"), **{"from": a["panes"][name]}, to=scrolled)
        for name, text in b["fields"].items():
            if name in a["fields"] and a["fields"][name] != text:
                go_on("typing", name, at, TYPING_PAUSE_MS, area=b["areas"].get(f"field {name}"), to=text)
        for overlay in b["overlays"]:
            go_on("overlay", overlay["id"], at, 60, overlay=overlay["kind"], dim=overlay["dim"], area=b["areas"].get(f"overlay {overlay['id']}"))
        for name in b["streams"]:
            go_on("stream", name, at, 60)
        for name in b["loops"]:
            go_on("loop", name, at, 60, area=b["areas"].get(f"loop {name}"))
        if b["hover"]:
            go_on("hover", b["hover"], at, 60)
        # what is there at one moment of the log is there until the next
        following = times[position + 1]
        for kind, names in (("overlay", [o["id"] for o in b["overlays"]]), ("stream", b["streams"]), ("loop", b["loops"]), ("hover", [b["hover"]] if b["hover"] else [])):
            for name in names:
                running[(kind, name)]["end"] = following
    return found
