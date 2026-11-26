"""The text read on a step's screenshot, as it is stored with the step (``app/text_reading.py`` has it read).

``text_reading`` is JSON: ``engine`` (what read it), ``width`` and ``height`` of the screenshot, and ``lines``, each as
its text, x, y, width, height and how sure the engine was (0 to 1). ``ocr_text`` is the same text in one piece, and
``text_state`` says how far it is. Steps that a version before 1.5.0 read have ``ocr_text`` only. That text can be wrong:
those versions gave a screen the text of an earlier one that looked much like it.
"""

from __future__ import annotations

import json
from typing import Any

from .similarity import text_distance


def parse_reading(value: Any) -> dict[str, Any] | None:
    """A step's ``text_reading`` as it is used; None when there is none, or it is not one (it can come from a project
    file made elsewhere)."""
    try:
        reading = json.loads(value) if isinstance(value, str) else None
    except ValueError:
        return None
    if not isinstance(reading, dict) or not isinstance(reading.get("lines"), list):
        return None
    lines = []
    for line in reading["lines"]:
        if not (isinstance(line, list) and len(line) == 6 and isinstance(line[0], str)):
            return None
        if not all(type(number) is int for number in line[1:5]) or type(line[5]) not in (int, float):
            return None
        lines.append(line)
    width, height = reading.get("width"), reading.get("height")
    if type(width) is not int or type(height) is not int:
        return None
    return {"engine": str(reading.get("engine") or ""), "width": width, "height": height, "lines": lines}


def text_state(candidate: dict[str, Any]) -> str | None:
    """How far the text of a step is: None (not read), ``waiting``, ``read``, ``failed``, or ``earlier`` (read by a
    version before 1.5.0)."""
    return candidate.get("text_state") or ("earlier" if candidate.get("ocr_text") else None)


def text_changes(steps: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Each step's score breakdown with how much of the text changed into it, where that is known now and was not."""
    changes = []
    before: dict[str, Any] | None = None
    for step in steps:
        breakdown = step["score_breakdown"]
        breakdown = json.loads(breakdown) if isinstance(breakdown, str) else breakdown
        if breakdown and before is not None and step["text_state"] == before["text_state"] == "read":
            either = step["ocr_text"] or before["ocr_text"]
            change = round(text_distance(before["ocr_text"], step["ocr_text"]), 4) if either else 0.0
            if breakdown.get("text") != change:
                changes.append((step["id"], json.dumps({**breakdown, "text": change})))
        before = step
    return changes
