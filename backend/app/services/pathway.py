"""A pathway: the steps of a run folded into the screens they show and the moves between those screens.

A recording is a straight line in time. Branches, loops and detours appear only once two steps count as
the same screen, so a pathway is the ordered steps plus that grouping. Every move keeps the number of the
step it arrives at, so the journey can be read back from the chart.
"""

from __future__ import annotations

import json
from bisect import bisect_right
from collections.abc import Sequence
from typing import Any

from ..models import PathwayDetail

PATHWAY_FORMAT = "stepthrough.pathway/1"

# Changes that leave the user on the same screen in a new state. A step reached by one of these joins the
# screen of the step before it; any other change starts a new screen.
SAME_SCREEN_LABELS = frozenset({"scroll", "text_entry", "feed_card_swap", "content_update", "small_ui_change"})
POPUP_LABEL = "modal"
POPUP_CLOSED_LABEL = "modal_close"
_SCREEN_CHOICES = {None: "automatic", "new": "new_screen"}  # any other value is the step chosen as the same screen
# Where a box goes in the figure, as the reviewer chose on one of its steps (`pathway_row`): on the row of the box
# it was reached from, or on a row of its own below. Without a choice, the first box reached from a box continues
# its row and any others start rows below.
ROW_CHOICES = ("continue", "below")

FIELD_NOTES = {
    "detail": "screens: steps that show the same screen share a box, also scrolled, or with something changed on it; "
              "steps: every step has its own box. In both, the same picture again shares its box",
    "steps": "the steps of steps.json in order; screen_id and visit say where each one sits in the pathway",
    "steps.grouped_by": "why the step shares a screen with an earlier step: researcher (the reviewer said so), "
                        "revisit (the same screen state again); in runs of engine stable_v3/1.2.0 and later, what the "
                        "engine found: overlay_closed (what lay over that screen went away), scroll, text_entry, "
                        "feed_card_swap, same_page (it looks like that screen, perhaps scrolled or with something "
                        "changed), overlay (the same pop-up again) or update (a small change); in older runs "
                        "modal_close (a pop-up went away) or the label of the change that stayed on the screen; null "
                        "for the step that starts a screen",
    "steps.screen_choice": "what the reviewer chose for the step: automatic (nothing), new_screen (a screen of its "
                           "own) or same_screen (the screen of another step they picked)",
    "steps.kind_choice": "automatic, or what the reviewer set: screen or popup",
    "screens": "one box of the pathway, in order of first visit",
    "screens.kind": "popup when the reviewer marked its first step as one or, without their say, when that step "
                    "was reached by a change labelled modal; otherwise screen",
    "screens.title": "the title of the first step on the screen that has one (title_step_id), otherwise Screen N",
    "screens.reached_from": "the screen the user was on when they first arrived, also when they had gone back to it "
                            "without a step of its own (steps.returns_to); null for the first screen",
    "screens.visits": "each stay on the screen: the steps taken there before moving to another screen",
    "screens.row_choice": "where the reviewer put the box in the figure: automatic, continue (on the row of the "
                          "screen it was reached from) or below (on a row of its own under it)",
    "screens.main": "the screen is on the main way through: the chain of screens that carry the rows on, from the "
                    "first screen (continues_with)",
    "steps.step_index": "the step's number: 0 for the opening screen, which is where the walkthrough starts and no "
                        "step of it, then 1, 2 and so on; without the opening screen, from 1",
    "steps.path_step": "the step's number along the main way through, leaving out optional detours: 13, or 13a, 13b "
                       "and so on for the steps of a detour taken after step 13, with the step that comes back",
    "steps.detour": "the step is part of an optional detour: a trip off the main way through that comes back to it "
                    "(with the step that comes back, when there is one; see steps.returns_to); a trip that never "
                    "comes back, or that only shows pop-ups, is not optional",
    "steps.returns_to": "the reviewer's say that after this step the user went back to an earlier screen (the screen's "
                        "id): when no step shows the return, it is drawn and counted as a move all the same, and the "
                        "next step leaves from that screen; null without one",
    "step_count": "how many steps were taken: the opening screen (step 0) is where they start and not counted, here "
                  "and in phases",
    "main_step_count": "how many steps there are without the optional detours (main_screen_count: on how many screens)",
    "screens.continues_with": "the screen that carries this one's row on in the figure: the one the reviewer put on "
                              "the row, or else the one with the most screens reached after it (the long way on "
                              "stays on the row, side trips go below, and a trip the reviewer said returns here "
                              "comes last); null where the row ends",
    "steps.phase": "the phase of the walkthrough the step is in, as the reviewer named it; null outside every phase",
    "phases": "stretches of consecutive steps that the reviewer named, such as sign up or verify identity, in order",
    "phases.screen_count": "how many different screens the steps of the phase are on",
    "phases.duration_ms": "from the phase's first step to the step after its last one (for the last phase: to the "
                          "end of its last step's time on screen); null when that is not known",
    "time_on_screen_ms": "the time the screens of these steps stayed still, added up; null when a step has no timing",
    "transitions": "moves between two different screens, in order of the first move",
    "transitions.kind": "return when the move goes to a screen that was first visited earlier than the one it leaves",
    "transitions.passes": "each time the move was made; step_id is the step it arrives at. origin is recorded, or "
                          "researcher for a return the reviewer added (steps.returns_to of from_step_id), which no "
                          "step arrives at: its step_id, step_index and at_ms are null",
}


def _breakdown(candidate: dict[str, Any]) -> dict[str, Any]:
    value = candidate.get("score_breakdown")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {}
    return value if isinstance(value, dict) else {}


def _ms(value: Any) -> int | None:
    return int(round(value)) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _total(values: list[int | None]) -> int | None:
    return None if any(value is None for value in values) else sum(values)  # type: ignore[arg-type]


def _popup(candidate: dict[str, Any]) -> bool:
    """Is the step a pop-up: the reviewer's say, or else the detector's label."""
    kind = candidate.get("screen_kind")
    if kind in ("screen", "popup"):
        return kind == "popup"
    return _breakdown(candidate).get("transition_type") == POPUP_LABEL


def _group_candidates(candidates: list[dict[str, Any]], detail: PathwayDetail) -> tuple[dict[str, str], dict[str, str]]:
    """Which candidates show the same screen. Returns each candidate's group (the id of its earliest member)
    and, per candidate that joined an earlier one, why.

    A step joins at most one earlier step, by the first of these that applies:

    1. the reviewer's choice (``screen_link``): the same screen as a step they picked (earlier or later), or a
       screen of its own;
    2. a revisit: the detector found the same screen state again;
    3. what the engine found when it compared the screenshots (``same_screen_as``, ``screens.py``): the same screen,
       also scrolled, with something changed on it, or after what lay over it went away;
    4. in runs of engines that did not compare them: a pop-up closing, which leads back to the screen it opened over,
       and a change that stays on the screen (scroll, typing, ...), which joins the step before.

    With ``detail="steps"`` only 1 and 2 apply. Every candidate of the run takes part, also rejected ones: a
    label describes the change from the detector's previous step, so the chain must not skip steps the
    reviewer left out.
    """
    ordered = sorted(candidates, key=lambda candidate: (candidate.get("detector_index") or 0, candidate["timestamp_ms"]))
    parent = {candidate["id"]: candidate["id"] for candidate in ordered}
    position = {candidate["id"]: index for index, candidate in enumerate(ordered)}

    def find(candidate_id: str) -> str:
        while parent[candidate_id] != candidate_id:
            parent[candidate_id] = parent[parent[candidate_id]]
            candidate_id = parent[candidate_id]
        return candidate_id

    def union(left: str, right: str) -> None:
        first, second = sorted((find(left), find(right)), key=position.__getitem__)
        parent[second] = first

    reasons: dict[str, str] = {}
    popups = {candidate["id"]: _popup(candidate) for candidate in ordered}
    previous_detected: dict[str, Any] | None = None
    open_popups: list[str] = []  # the steps showing the screens under the pop-ups that are open, innermost last
    for candidate in ordered:
        link = candidate.get("screen_link")
        chosen = link if link in parent and link != candidate["id"] else None
        target: str | None = None
        reason: str | None = None
        if chosen:
            target, reason = chosen, "researcher"

        # A step added by hand has no label (the label of the next detected step describes the change from
        # the detected step before it), and its link to an earlier step is a look-alike by image hash, which
        # is looser than the detector's test for a revisit. So it stands alone unless the reviewer says more.
        if candidate.get("candidate_origin") == "manual":
            if target:
                union(target, candidate["id"])
                reasons[candidate["id"]] = "researcher"
            continue

        label = _breakdown(candidate).get("transition_type")
        popup = popups[candidate["id"]]
        revisit = candidate.get("similar_to_candidate_id")
        found, why = candidate.get("same_screen_as"), candidate.get("same_screen_reason")  # since engine 1.2.0
        if target is None and link != "new":
            if revisit in parent and revisit != candidate["id"]:
                target, reason = revisit, "revisit"
            elif detail != "screens":
                pass  # by step, only the same screen state shares a box
            elif found in parent and found != candidate["id"] and (popups.get(found, False) or not popup):
                target, reason = found, why or label  # what the engine found (a pop-up only joins the same pop-up again)
            elif popup or why:
                pass  # a pop-up starts a box of its own, and so does a screen the engine found to be another one
            elif label == POPUP_CLOSED_LABEL and open_popups:
                # The screen under the pop-up is back. Something on it may have changed meanwhile (a switch
                # that is now on), so it need not be a revisit; it is still that screen.
                target, reason = open_popups[-1], label
            elif label in SAME_SCREEN_LABELS and previous_detected is not None:
                target, reason = previous_detected["id"], label
        if target:
            union(target, candidate["id"])
            reasons[candidate["id"]] = reason or "researcher"

        # Keep track of the pop-ups that are open.
        if popup:
            if previous_detected is not None:
                open_popups.append(previous_detected["id"])
        elif label == POPUP_CLOSED_LABEL:
            if open_popups:
                open_popups.pop()
        elif open_popups and target is not None and find(target) == find(open_popups[-1]):
            open_popups.pop()  # back on the screen under the pop-up, by a revisit or by the reviewer's choice
        elif label not in SAME_SCREEN_LABELS:
            open_popups.clear()  # a new screen: whatever was open went with the old one
        previous_detected = candidate
    return {candidate_id: find(candidate_id) for candidate_id in parent}, reasons


def pathway_screen_members(candidates: list[dict[str, Any]], candidate_id: str, detail: PathwayDetail) -> list[str]:
    """All members of a box, including rejected steps that could be accepted again later."""
    groups, _reasons = _group_candidates(candidates, detail)
    group = groups[candidate_id]
    return [member for member, member_group in groups.items() if member_group == group]


# ── phases ───────────────────────────────────────────────────────────────────────────────────────────────────────
# A phase is a named stretch of the recording. It is kept as where it starts: a list of (start_ms, name), in order,
# where each name holds until the next start, and "" ends the phase before it. Going by time rather than by step,
# a step added by hand inside a phase belongs to it, and a step that is rejected leaves the phase as it was.


def phase_at(boundaries: Sequence[tuple[int, str]], ms: int) -> str | None:
    """The phase a moment of the recording is in, or None."""
    index = bisect_right([start for start, _name in boundaries], ms) - 1
    return (boundaries[index][1] or None) if index >= 0 else None


def tidy_phases(boundaries: Sequence[tuple[int, str]]) -> list[tuple[int, str]]:
    """In order, without starts that change nothing (the same name again, or an end where no phase is)."""
    tidy: list[tuple[int, str]] = []
    for start, name in sorted(boundaries):
        if name != (tidy[-1][1] if tidy else ""):
            tidy.append((start, name))
    return tidy


def set_phase(boundaries: Sequence[tuple[int, str]], name: str, start_ms: int, end_ms: int | None) -> list[tuple[int, str]]:
    """Name the stretch from ``start_ms`` up to ``end_ms`` (or to the end of the recording); "" takes it out of
    every phase. What comes after the stretch stays in the phase it was in."""
    after = phase_at(boundaries, end_ms) if end_ms is not None else None
    kept = [(start, phase) for start, phase in boundaries if start < start_ms or (end_ms is not None and start > end_ms)]
    kept.append((start_ms, name))
    if end_ms is not None:
        kept.append((end_ms, after or ""))
    return tidy_phases(kept)


def _steps_taken(steps: list[dict[str, Any]]) -> int:
    """How many of these are steps: the opening screen (number 0) is where they start from."""
    return sum(1 for step in steps if step["step_index"] > 0)


def _phase_stretches(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Consecutive steps in the same phase, with how many steps and screens and how long."""
    stretches: list[dict[str, Any]] = []
    for index, step in enumerate(steps):
        name = step.get("phase")
        if not name:
            continue
        if stretches and stretches[-1]["name"] == name and stretches[-1]["_end"] == index - 1:
            stretch = stretches[-1]
        else:
            stretch = {"name": name, "_start": index, "steps": []}
            stretches.append(stretch)
        stretch["_end"] = index
        stretch["steps"].append(step)

    phases = []
    for stretch in stretches:
        members = stretch["steps"]
        first, last = members[0], members[-1]
        following = steps[stretch["_end"] + 1] if stretch["_end"] + 1 < len(steps) else None
        if following is not None:
            end_ms = following["timestamp_ms"]
        elif last["time_on_screen_ms"] is not None:
            end_ms = last["timestamp_ms"] + last["time_on_screen_ms"]
        else:
            end_ms = None
        screen_ids = list(dict.fromkeys(step["screen_id"] for step in members))
        main_members = [step for step in members if not step["detour"]]
        phases.append({
            "name": stretch["name"],
            "first_step_id": first["step_id"],
            "last_step_id": last["step_id"],
            "first_step_index": first["step_index"],
            "last_step_index": last["step_index"],
            "step_count": _steps_taken(members),
            "screen_count": len(screen_ids),
            "main_step_count": _steps_taken(main_members),
            "main_screen_count": len({step["screen_id"] for step in main_members}),
            "screen_ids": screen_ids,
            "start_ms": first["timestamp_ms"],
            "end_ms": end_ms,
            "duration_ms": None if end_ms is None else end_ms - first["timestamp_ms"],
        })
    return phases


def _closed_trips(steps: list[dict[str, Any]], screens: list[dict[str, Any]]) -> set[str]:
    """The screens a trip begins with that the reviewer said comes back: on the way from the screen returned to
    (``returns_to``) down to the screen it is left from, the first one after it."""
    parent = {screen["id"]: screen["reached_from"] for screen in screens}
    closed: set[str] = set()
    for step in steps:
        at = step["screen_id"]
        while step.get("returns_to") and at is not None:
            if parent.get(at) == step["returns_to"]:
                closed.add(at)
                break
            at = parent.get(at)
    return closed


def _set_continuations(screens: list[dict[str, Any]], closed: set[str] | frozenset[str] = frozenset()) -> None:
    """Give every screen the one that carries its row on in the figure (``continues_with``), or None where the row
    ends: the screen the reviewer put on the row, or else the one with the most screens reached after it, so the
    long way on stays on the row and a side trip goes below (ties: the first reached). A screen the reviewer put
    below never carries a row on, and one that begins a trip they said comes back (``closed``) only where no other
    does."""
    kids: dict[str, list[dict[str, Any]]] = {}
    for screen in screens:  # in the order they were first reached
        if screen["reached_from"]:
            kids.setdefault(screen["reached_from"], []).append(screen)
    sizes: dict[str, int] = {}
    for screen in reversed(screens):  # a screen is always reached after the one it is reached from
        sizes[screen["id"]] = 1 + sum(sizes.get(kid["id"], 1) for kid in kids.get(screen["id"], []))
    for screen in screens:
        candidates = [kid for kid in kids.get(screen["id"], []) if kid["row_choice"] != "below"]
        chosen = next((kid for kid in candidates if kid["row_choice"] == "continue"), None)
        if chosen is None and candidates:
            chosen = max(candidates, key=lambda kid: (kid["id"] not in closed, sizes[kid["id"]]))  # the first of equals
        screen["continues_with"] = chosen["id"] if chosen else None


def _letters(count: int) -> str:
    """1 is a, 26 is z, 27 is aa, as the columns of a spreadsheet go."""
    letters = ""
    while count > 0:
        count, rest = divmod(count - 1, 26)
        letters = chr(ord("a") + rest) + letters
    return letters


def _mark_detours(
    steps: list[dict[str, Any]], screens: list[dict[str, Any]], closed: set[str] | frozenset[str] = frozenset(),
) -> None:
    """Mark the main way through and the optional detours from it.

    The main way through is the chain of screens that carry the rows on (``continues_with``) from the first screen:
    the long way on, or what the reviewer put on the rows. It does not go on into a trip they said comes back
    (``closed``), unless they put that on the row themselves. A detour is a run of steps on screens off that way that
    comes back to it; its steps, and the step that comes back, are optional (``detour``): without the trip the user
    would still be where they left. It may also come back without a step, where the reviewer said so (``returns_to``).
    A run that never comes back (the recording ends there) is part of what was done, and so is a trip that only shows
    pop-ups, which the app puts in the way rather than the user choosing them.
    Every step gets its number along the main way (``path_step``), so that the numbers add up without the detours: the
    other steps count on from the first one's number, and the steps of a detour have a letter after the number of the
    step they leave from (13a, 13b), up to the next step of the main way."""
    by_id = {screen["id"]: screen for screen in screens}
    main: set[str] = set()
    screen = screens[0] if screens else None
    while screen is not None and screen["id"] not in main:
        main.add(screen["id"])
        screen = by_id.get(screen["continues_with"] or "")
        if screen is not None and screen["id"] in closed and screen["row_choice"] != "continue":
            break
    for screen in screens:
        screen["main"] = screen["id"] in main
    for step in steps:
        step["detour"] = False

    def mark(trip: list[dict[str, Any]], back: list[dict[str, Any]]) -> None:
        if any(by_id[each["screen_id"]]["kind"] != "popup" for each in trip):
            for each in [*trip, *back]:
                each["detour"] = True

    start: int | None = None
    for index, step in enumerate(steps):
        if step["screen_id"] in main:
            if start is not None:
                mark(steps[start:index], [step])  # with the step that comes back
            start = None
            continue
        if start is None:
            start = index
        arrives = steps[index + 1]["screen_id"] if index + 1 < len(steps) else None
        if step.get("returns_to") in main and arrives != step["returns_to"]:
            mark(steps[start:index + 1], [])  # comes back, and no step shows it
            start = None
    number = steps[0]["step_index"] - 1 if steps else 0
    aside = 0
    for step in steps:  # the first is on the first screen, so always on the main way
        if step["detour"]:
            aside += 1
            step["path_step"] = f"{number}{_letters(aside)}"
        else:
            number, aside = number + 1, 0
            step["path_step"] = str(number)


def build_pathway(
    rows: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    detail: PathwayDetail = "screens",
    phases: Sequence[tuple[int, str]] = (),
) -> dict[str, Any]:
    """The pathway of ``rows`` (the steps of a run as exported: accepted steps, or every candidate).

    ``candidates`` are all candidates of the run, which decide which steps show the same screen; ``phases`` are the
    starts of the run's phases (see ``set_phase``).
    """
    group_of, reasons = _group_candidates(candidates, detail)
    by_id = {candidate["id"]: candidate for candidate in candidates}
    # A step the reviewer pointed another step at shares its screen for that reason too.
    pointed_at = {candidate.get("screen_link") for candidate in candidates} & by_id.keys()

    steps: list[dict[str, Any]] = []
    screens: list[dict[str, Any]] = []
    screen_of_group: dict[str, dict[str, Any]] = {}
    index_of: dict[str, int] = {}  # each screen's, by its id
    transitions: dict[tuple[str, str], dict[str, Any]] = {}
    previous: dict[str, Any] | None = None

    def move(source: str, target: str, made: dict[str, Any]) -> None:
        transition = transitions.setdefault((source, target), {
            "from_screen": source,
            "to_screen": target,
            "kind": "return" if index_of[target] < index_of[source] else "forward",
            "passes": [],
        })
        transition["passes"].append(made)

    def go_back(step: dict[str, Any]) -> None:
        """The return the reviewer added after ``step``: a move that no step arrives at."""
        move(step["screen_id"], step["returns_to"], {
            "step_id": None, "step_index": None, "from_step_id": step["step_id"], "at_ms": None, "transition_type": None,
            "origin": "researcher",
        })

    for row in rows:
        candidate = by_id.get(row["source_candidate_id"], {})
        breakdown = _breakdown(candidate)
        label = breakdown.get("transition_type")
        group = group_of.get(row["source_candidate_id"], row["source_candidate_id"])
        screen = screen_of_group.get(group)
        # The screen the user was on before this step: the one of the step before, or the one the reviewer said they
        # went back to from there (unless this step shows it, so that the return was recorded).
        came_from = previous["screen_id"] if previous else None
        if previous is not None and previous["returns_to"] and (screen is None or screen["id"] != previous["returns_to"]):
            go_back(previous)
            came_from = previous["returns_to"]
        starts_screen = screen is None
        if screen is None:
            screen = {
                "id": f"screen-{len(screens) + 1:02d}",
                "index": len(screens) + 1,
                "title": f"Screen {len(screens) + 1}",
                "title_step_id": None,
                "kind": "popup" if _popup(candidate) else "screen",
                "reached_from": came_from,
                "image_step_id": row["step_id"],
                "visits": [],
                "time_on_screen_ms": None,
                "row_choice": "automatic",
            }
            screens.append(screen)
            index_of[screen["id"]] = screen["index"]
            screen_of_group[group] = screen
        # the first of the box's steps with a say about its row has it
        if screen["row_choice"] == "automatic" and candidate.get("pathway_row") in ROW_CHOICES:
            screen["row_choice"] = candidate["pathway_row"]
        if screen["title_step_id"] is None and (candidate.get("title") or "").strip():
            screen["title"] = candidate["title"].strip()
            screen["title_step_id"] = row["step_id"]

        if came_from != screen["id"]:
            screen["visits"].append({"visit": len(screen["visits"]) + 1, "step_ids": [], "arrived_ms": row["timestamp_ms"],
                                     "time_on_screen_ms": None})
            if previous is not None and came_from is not None:
                move(came_from, screen["id"], {
                    "step_id": row["step_id"],
                    "step_index": row["step_index"],
                    "from_step_id": previous["step_id"],
                    "at_ms": row["timestamp_ms"],
                    "transition_type": label,
                    "origin": "recorded",
                })
        visit = screen["visits"][-1]
        visit["step_ids"].append(row["step_id"])
        back_at = screen_of_group.get(group_of.get(candidate.get("returns_to") or "", ""))  # only one seen before

        step = {
            "step_id": row["step_id"],
            "step_index": row["step_index"],
            "screen_id": screen["id"],
            "visit": visit["visit"],
            "timestamp_ms": row["timestamp_ms"],
            "timestamp_tc": row["timestamp_tc"],
            "title": row["title"],
            "notes": row.get("notes"),
            "transition_type": label,
            "time_on_screen_ms": _ms(breakdown.get("dwell_after_ms")),
            "image_path": row["image_path"],
            "export_filename": row.get("export_filename"),
            "grouped_by": None if starts_screen else (
                reasons.get(row["source_candidate_id"])
                or ("researcher" if row["source_candidate_id"] in pointed_at else None)
            ),
            "screen_choice": _SCREEN_CHOICES.get(candidate.get("screen_link"), "same_screen"),
            "kind_choice": candidate.get("screen_kind") or "automatic",
            "phase": phase_at(phases, row["timestamp_ms"]),
            "returns_to": back_at["id"] if back_at and back_at["id"] != screen["id"] else None,
            "source_candidate_id": row["source_candidate_id"],
        }
        steps.append(step)
        previous = step
    if previous is not None and previous["returns_to"]:
        go_back(previous)

    time_of = {step["step_id"]: step["time_on_screen_ms"] for step in steps}
    for screen in screens:
        for visit in screen["visits"]:
            visit["time_on_screen_ms"] = _total([time_of[step_id] for step_id in visit["step_ids"]])
        screen["time_on_screen_ms"] = _total([visit["time_on_screen_ms"] for visit in screen["visits"]])
    closed = _closed_trips(steps, screens)
    _set_continuations(screens, closed)
    _mark_detours(steps, screens, closed)
    main_steps = [step for step in steps if not step["detour"]]

    return {
        "format": PATHWAY_FORMAT,
        "detail": detail,
        "step_count": _steps_taken(steps),
        "screen_count": len(screens),
        "main_step_count": _steps_taken(main_steps),
        "main_screen_count": len({step["screen_id"] for step in main_steps}),
        "steps": steps,
        "screens": screens,
        "transitions": list(transitions.values()),
        "phases": _phase_stretches(steps),
        "field_notes": FIELD_NOTES,
    }
