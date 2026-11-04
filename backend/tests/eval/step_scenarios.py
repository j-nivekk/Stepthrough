"""Scenarios for how steps are *grouped*, added for the stable-screen engine (phase 1).

The baseline scenarios check whether a change is found. These check what a walkthrough step should be:

    chat_typing_pauses  a message typed word by word with reading pauses, then sent. Every pause is longer
                        than the minimum time on screen, so without typing groups each word is a step.
                        Wanted: one step for the typed message, one for the sent message.
    form_two_fields     two form fields filled one after the other, with pauses. Wanted: one step per field.
    settings_toggles    three toggles in a column switched one after the other. Small, close together and
                        quick, like typing, but each is a step of its own and must not be grouped.

They are kept out of ``BASELINE_SCENARIOS`` so the baseline set, and the hybrid v2 comparison recorded
with it, stays comparable.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import numpy as np

from . import rendering as r
from .scenarios import _result
from .types import GroundTruthEvent, ScenarioResult

CARET_PERIOD_S = 0.53
CHARS_PER_SECOND = 8


def _caret(frame: np.ndarray, x: int, y: int, height: int, t: float) -> np.ndarray:
    if int(t / CARET_PERIOD_S) % 2 == 0:
        frame = frame.copy()
        r.rect(frame, x, y, 2, height, r.BLUE_500, radius=0)
    return frame


def _settled_until_ms(last_char_t: float, pause_end_t: float) -> int:
    """End of a typing event for matching: the finished text is on screen for the whole final pause, so
    any screenshot from it is right. The evaluator adds 500 ms, which then ends at the pause's end."""
    return max(round(last_char_t * 1000) + 200, round((pause_end_t - 0.5) * 1000))


def _type_words(
    writer,
    fps: float,
    t: float,
    words: list[str],
    pause_s: list[float],
    render: Callable[[str], tuple[np.ndarray, int, int, int]],
) -> tuple[float, float, str, float]:
    """Type ``words`` with ``pause_s[i]`` after word i. Returns (first char, last char, text, end) times."""
    typed = ""
    first_char_t: float | None = None
    last_char_t = t
    for index, word in enumerate(words):
        for char in (" " if typed else "") + word:
            typed += char
            if first_char_t is None:
                first_char_t = t
            last_char_t = t
            frame, cx, cy, ch = render(typed)
            for _ in range(r.frames_for_duration(fps, 1.0 / CHARS_PER_SECOND)):
                writer.write(_caret(frame, cx, cy, ch, t))
                t += 1.0 / fps
        frame, cx, cy, ch = render(typed)
        for _ in range(r.frames_for_duration(fps, pause_s[index])):
            writer.write(_caret(frame, cx, cy, ch, t))
            t += 1.0 / fps
    return first_char_t or t, last_char_t, typed, t


def chat_typing_pauses(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "chat_typing_pauses.avi"
    writer = r.create_writer(path, w, h, fps)
    history = [
        ("Alice", "Are you coming tomorrow?", False),
        ("You", "Probably, let me check", True),
    ]
    field_x, field_y, field_w, field_h = r.px(16), r.CONTENT_HEIGHT - r.px(52), w - r.px(32), r.px(40)

    def render(typed: str, messages=history) -> tuple[np.ndarray, int, int, int]:
        content = r.chat_screen(w, r.CONTENT_HEIGHT, messages=messages)
        r.rect(content, field_x, field_y, field_w, field_h, r.WHITE, radius=r.px(18))
        r.rect(content, field_x, field_y, field_w, field_h, r.GRAY_300, filled=False, thickness=1)
        if typed:
            r.text(content, typed, field_x + r.px(14), field_y + r.px(26), color=r.NEAR_BLACK, scale=0.42)
        width_px = int(len(typed) * r.px(8.4))
        frame = r.app_chrome(content, header_text="Alice")
        return frame, field_x + r.px(14) + width_px + 2, r.HEADER_HEIGHT + field_y + r.px(10), r.px(20)

    t = 0.0
    frame, cx, cy, ch = render("")
    for _ in range(r.frames_for_duration(fps, 1.5)):
        writer.write(_caret(frame, cx, cy, ch, t))
        t += 1.0 / fps
    words = ["See", "you", "at", "the", "station", "at", "nine"]
    pauses = [0.8, 0.7, 0.9, 0.6, 1.1, 0.7, 1.2]
    first_t, last_t, typed, sent_t = _type_words(writer, fps, t, words, pauses, render)
    sent, _cx, _cy, _ch = render("", messages=[*history, ("You", typed, True)])
    r.write_n(writer, sent, r.frames_for_duration(fps, 1.5))
    writer.release()
    return _result(
        Path(str(path)), category="content", difficulty="hard", fps=fps,
        duration_ms=round((sent_t + 1.5) * 1000),
        description="Message typed word by word with 0.6-1.2 s pauses and a blinking caret, then sent",
        ground_truth=[
            GroundTruthEvent("content_update", round(first_t * 1000), _settled_until_ms(last_t, sent_t),
                             {"type": "typing", "words": len(words)}, "hard"),
            GroundTruthEvent("content_update", round(sent_t * 1000), round(sent_t * 1000), {"type": "send"}, "medium"),
        ],
    )


def form_two_fields(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "form_two_fields.avi"
    writer = r.create_writer(path, w, h, fps)
    values = {"Name": "", "Email": ""}

    def render_for(field: str) -> Callable[[str], tuple[np.ndarray, int, int, int]]:
        index = list(values).index(field)

        def render(typed: str) -> tuple[np.ndarray, int, int, int]:
            current = {**values, field: typed}
            content = r.form_screen(w, r.CONTENT_HEIGHT, fields=list(current.items()))
            frame = r.app_chrome(content, header_text="Sign up")
            y = r.HEADER_HEIGHT + r.px(24) + index * (r.px(40) + r.px(28))
            return frame, r.px(24) + r.px(8) + int(len(typed) * r.px(8.4)) + 2, y + r.px(8), r.px(24)

        return render

    frame, *_ = render_for("Name")("")
    r.write_n(writer, frame, r.frames_for_duration(fps, 1.5))
    t = r.frames_for_duration(fps, 1.5) / fps
    events = []
    for field, words, pauses in (
        ("Name", ["Jane", "van", "Dijk"], [0.8, 0.7, 1.2]),
        ("Email", ["jane@", "example", ".org"], [0.9, 0.8, 1.5]),
    ):
        first_t, last_t, typed, t = _type_words(writer, fps, t, words, pauses, render_for(field))
        values[field] = typed
        events.append(GroundTruthEvent("content_update", round(first_t * 1000), _settled_until_ms(last_t, t),
                                       {"type": "typing", "field": field}, "hard"))
    writer.release()
    return _result(
        Path(str(path)), category="content", difficulty="hard", fps=fps,
        duration_ms=round(t * 1000),
        description="Two form fields filled word by word with pauses; one step per field",
        ground_truth=events,
    )


def settings_toggles(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "settings_toggles.avi"
    writer = r.create_writer(path, w, h, fps)
    items = [("Notifications", False), ("Dark Mode", False), ("Auto-Save", False), ("Analytics", False), ("Location", False)]
    hold = 1.0
    events = []
    for step in range(4):
        state = [(label, index < step) for index, (label, _) in enumerate(items)]
        screen = r.app_chrome(r.settings_screen(w, r.CONTENT_HEIGHT, items=state), header_text="Settings")
        r.write_n(writer, screen, r.frames_for_duration(fps, 1.5 if step == 0 else hold))
        if step:
            at = round((1.5 + (step - 1) * hold) * 1000)
            events.append(GroundTruthEvent("small_ui_change", at, at, {"toggle": items[step - 1][0]}, "medium"))
    writer.release()
    return _result(
        Path(str(path)), category="content", difficulty="medium", fps=fps,
        duration_ms=round((1.5 + 3 * hold) * 1000),
        description="Three toggles in a column switched 1 s apart; each is its own step",
        ground_truth=events,
    )


STEP_SCENARIOS: list[tuple[str, Callable[[Path, float], ScenarioResult]]] = [
    ("chat_typing_pauses", chat_typing_pauses),
    ("form_two_fields", form_two_fields),
    ("settings_toggles", settings_toggles),
]
