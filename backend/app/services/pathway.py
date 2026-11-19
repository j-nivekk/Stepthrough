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
    "detail": "screens: steps reached by scrolling, typing or a small change share a box with the step before; "
              "steps: every step has its own box. In both, a step that shows an earlier screen again shares its box",
    "steps": "the steps of steps.json in order; screen_id and visit say where each one sits in the pathway",
    "steps.grouped_by": "why the step shares a screen with an earlier step: researcher (the reviewer said so), "
                        "revisit (the same screen state again), modal_close (the pop-up over that screen went "
                        "away) or the label of the change that stayed on the screen (scroll, text_entry, ...); "
                        "null for the step that starts a screen",
    "steps.screen_choice": "what the reviewer chose for the step: automatic (nothing), new_screen (a screen of its "
                           "own) or same_screen (the screen of another step they picked)",
    "steps.kind_choice": "automatic, or what the reviewer set: screen or popup",
    "screens": "one box of the pathway, in order of first visit",
    "screens.kind": "popup when the reviewer marked its first step as one or, without their say, when that step "
                    "was reached by a change labelled modal; otherwise screen",
    "screens.title": "the title of the first step on the screen that has one (title_step_id), otherwise Screen N",
    "screens.reached_from": "the screen the user was on when they first arrived; null for the first screen",
    "screens.visits": "each stay on the screen: the steps taken there before moving to another screen",
    "screens.row_choice": "where the reviewer put the box in the figure: automatic, continue (on the row of the "
                          "screen it was reached from) or below (on a row of its own under it)",
    "steps.phase": "the phase of the walkthrough the step is in, as the reviewer named it; null outside every phase",
    "phases": "stretches of consecutive steps that the reviewer named, such as sign up or verify identity, in order",
    "phases.screen_count": "how many different screens the steps of the phase are on",
    "phases.duration_ms": "from the phase's first step to the step after its last one (for the last phase: to the "
                          "end of its last step's time on screen); null when that is not known",
    "time_on_screen_ms": "the time the screens of these steps stayed still, added up; null when a step has no timing",
    "transitions": "moves between two different screens, in order of the first move",
    "transitions.kind": "return when the move goes to a screen that was first visited earlier than the one it leaves",
    "transitions.passes": "each time the move was made; step_id is the step it arrives at",
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
    3. a pop-up closing, which leads back to the screen the pop-up opened over;
    4. a change that stays on the screen (scroll, typing, ...), which joins the step before.

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
        popup = _popup(candidate)
        revisit = candidate.get("similar_to_candidate_id")
        if target is None and link != "new":
            if revisit in parent and revisit != candidate["id"]:
                target, reason = revisit, "revisit"
            elif popup or detail != "screens":
                pass  # a pop-up starts a box of its own; by step, only the same screen state shares a box
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
        phases.append({
            "name": stretch["name"],
            "first_step_id": first["step_id"],
            "last_step_id": last["step_id"],
            "first_step_index": first["step_index"],
            "last_step_index": last["step_index"],
            "step_count": len(members),
            "screen_count": len(screen_ids),
            "screen_ids": screen_ids,
            "start_ms": first["timestamp_ms"],
            "end_ms": end_ms,
            "duration_ms": None if end_ms is None else end_ms - first["timestamp_ms"],
        })
    return phases


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
    transitions: dict[tuple[str, str], dict[str, Any]] = {}
    previous: dict[str, Any] | None = None

    for row in rows:
        candidate = by_id.get(row["source_candidate_id"], {})
        breakdown = _breakdown(candidate)
        label = breakdown.get("transition_type")
        group = group_of.get(row["source_candidate_id"], row["source_candidate_id"])
        screen = screen_of_group.get(group)
        starts_screen = screen is None
        if screen is None:
            screen = {
                "id": f"screen-{len(screens) + 1:02d}",
                "index": len(screens) + 1,
                "title": f"Screen {len(screens) + 1}",
                "title_step_id": None,
                "kind": "popup" if _popup(candidate) else "screen",
                "reached_from": previous["screen_id"] if previous else None,
                "image_step_id": row["step_id"],
                "visits": [],
                "time_on_screen_ms": None,
                "row_choice": "automatic",
            }
            screens.append(screen)
            screen_of_group[group] = screen
        # the first of the box's steps with a say about its row has it
        if screen["row_choice"] == "automatic" and candidate.get("pathway_row") in ROW_CHOICES:
            screen["row_choice"] = candidate["pathway_row"]
        if screen["title_step_id"] is None and (candidate.get("title") or "").strip():
            screen["title"] = candidate["title"].strip()
            screen["title_step_id"] = row["step_id"]

        if previous is None or previous["screen_id"] != screen["id"]:
            screen["visits"].append({"visit": len(screen["visits"]) + 1, "step_ids": [], "arrived_ms": row["timestamp_ms"],
                                     "time_on_screen_ms": None})
            if previous is not None:
                key = (previous["screen_id"], screen["id"])
                source = next(item for item in screens if item["id"] == previous["screen_id"])
                transition = transitions.setdefault(key, {
                    "from_screen": key[0],
                    "to_screen": key[1],
                    "kind": "return" if screen["index"] < source["index"] else "forward",
                    "passes": [],
                })
                transition["passes"].append({
                    "step_id": row["step_id"],
                    "step_index": row["step_index"],
                    "from_step_id": previous["step_id"],
                    "at_ms": row["timestamp_ms"],
                    "transition_type": label,
                })
        visit = screen["visits"][-1]
        visit["step_ids"].append(row["step_id"])

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
            "source_candidate_id": row["source_candidate_id"],
        }
        steps.append(step)
        previous = step

    time_of = {step["step_id"]: step["time_on_screen_ms"] for step in steps}
    for screen in screens:
        for visit in screen["visits"]:
            visit["time_on_screen_ms"] = _total([time_of[step_id] for step_id in visit["step_ids"]])
        screen["time_on_screen_ms"] = _total([visit["time_on_screen_ms"] for visit in screen["visits"]])

    return {
        "format": PATHWAY_FORMAT,
        "detail": detail,
        "step_count": len(steps),
        "screen_count": len(screens),
        "steps": steps,
        "screens": screens,
        "transitions": list(transitions.values()),
        "phases": _phase_stretches(steps),
        "field_notes": FIELD_NOTES,
    }
