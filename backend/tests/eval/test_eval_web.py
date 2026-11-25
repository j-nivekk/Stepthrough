"""The ground truth of the web tester: what follows from an app's log. (Recording needs Chrome and is not tested here.)"""

from __future__ import annotations

from typing import Any

from .webtruth import derive


def moment(t: int, screen: str = "home", **more: Any) -> dict[str, Any]:
    events = more.pop("events", None)
    snapshot = {"t": t, "screen": screen, "overlays": [], "panes": {}, "fields": {}, "marks": {}, "content": {}, "hover": None,
                "pointer": None, "loops": [], "streams": [], "moving": [], "noise": False, "areas": {}, **more}
    return {"snapshot": snapshot, **({"events": events} if events else {})}


def truth(log: list[dict[str, Any]], duration: int, dwell: int = 450):
    return derive({"scenario": "x", "device": "phone", "duration_ms": duration, "log": log}, dwell)


def test_a_step_is_a_screen_that_stays_still_long_enough():
    found = truth([
        moment(0), moment(2000, moving=["navigation"], screen="page"), moment(2300, "page"), moment(2500, "other"),
        moment(5000, "last"),
    ], 6000)
    assert [(step.start, step.end, step.screen) for step in found.steps] == [(0, 2000, "home"), (2500, 5000, "other"), (5000, 6000, "last")]
    assert [state.kind for state in found.states] == ["step", "short", "step", "step"]
    assert found.steps[1].kinds == ("navigation",)


def test_a_screen_close_to_the_minimum_may_be_a_step_or_not():
    log = [moment(0), moment(1000, "menu"), moment(1500, "page")]
    assert [step.optional for step in truth(log, 4000).steps] == [False, True, False]
    assert [step.screen for step in truth(log, 4000, dwell=700).steps] == ["home", "page"]


def test_what_only_looks_different_is_no_step():
    found = truth([moment(0), moment(1000, hover="row 1"), moment(2000, hover="row 2", loops=["clip"]), moment(3000, noise=True)], 4000)
    assert len(found.steps) == 1
    assert [name for _when, name in found.steps[0].hovers] == [None, "row 1", "row 2", None]
    assert found.steps[0].loops == {"clip"} and found.steps[0].noises == [(3000, "scroll bar")]


def test_a_burst_of_typing_is_one_step_with_the_finished_text():
    texts = ["", "a", "ab", "ab c", "ab cd"]
    times = [0, 1500, 2300, 3200, 4100]
    found = truth([moment(t, fields={"name": text}) for t, text in zip(times, texts)], 7000)
    assert [(step.start, step.shown["fields"]["name"]) for step in found.steps] == [(0, ""), (4100, "ab cd")]
    assert found.steps[1].kinds == ("typing",)
    assert [state.kind for state in found.states] == ["step", "typing", "typing", "typing", "step"]
    segment = next(segment for segment in found.segments if segment["kind"] == "typing")
    assert (segment["start"], segment["end"], segment["to"]) == (1500, 4100, "ab cd")

    # two fields are two bursts, and a pause long enough to read the text ends one
    two = truth([moment(0, fields={"a": "", "b": ""}), moment(1000, fields={"a": "x", "b": ""}), moment(2000, fields={"a": "x", "b": "y"})], 4000)
    assert len(two.steps) == 3
    slow = truth([moment(0, fields={"a": ""}), moment(1000, fields={"a": "x"}), moment(9000, fields={"a": "xy"})], 11000)
    assert len(slow.steps) == 3


def test_every_stop_of_a_scroll_is_a_step_and_content_that_moves_by_itself_is_not_a_scroll():
    found = truth([
        moment(0, panes={"list": [0, 0]}), moment(1000, panes={"list": [0, 50]}, moving=["scroll"]), moment(1100, panes={"list": [0, 300]}),
        moment(2600, panes={"list": [0, 340]}),
    ], 4000)
    assert [step.primary for step in found.steps] == ["none", "scroll", "moved"]
    assert [(s["kind"], s["from"], s["to"]) for s in found.segments] == [("scroll", [0, 0], [0, 300]), ("moved", [0, 300], [0, 340])]


def test_the_last_pixels_of_a_scroll_count_as_still():
    places = [(0, 0, []), (1000, 80, ["scroll"]), (1100, 290, ["scroll"]), (1200, 298, ["scroll"]), (1300, 299, ["scroll"]), (1400, 300, [])]
    log = [moment(t, panes={"list": [0, y]}, moving=moving) for t, y, moving in places] + [moment(1800, "page")]
    found = truth(log, 3000)
    assert [(step.start, step.end, step.shown["panes"]) for step in found.steps[:2]] == [(0, 1000, {"list": [0, 0]}), (1200, 1800, {"list": [0, 300]})]
    # a slow scroll is a scroll to its end
    slow = [moment(1000 + 100 * i, panes={"list": [0, 2 * i]}, moving=["scroll"]) for i in range(1, 12)] + [moment(2200, panes={"list": [0, 24]})]
    assert truth([moment(0, panes={"list": [0, 0]}), *slow], 4000).steps[1].start == 2100


def test_overlays_make_boxes_of_their_own_and_closing_one_is_a_return():
    menu = [{"id": "menu", "kind": "menu", "dim": False}]
    found = truth([moment(0), moment(1000, overlays=menu), moment(2000), moment(3000, "page"), moment(4000)], 5000)
    assert [step.box for step in found.steps] == ["home", "home | menu", "home", "page", "home"]
    assert [step.primary for step in found.steps] == ["none", "overlay_open", "overlay_close", "navigation", "navigation"]
    assert [step.returns for step in found.steps] == [False, False, True, False, True]


def test_the_cards_of_a_feed_are_one_screen():
    swap = lambda a, b: [{"t": 0, "kind": "feed_swap", "from": a, "to": b}]  # noqa: E731
    found = truth([moment(0, "feed/0"), moment(1000, "feed/1", events=swap("feed/0", "feed/1")), moment(2000, "feed/2", events=swap("feed/1", "feed/2")), moment(3000, "you")], 4000)
    assert [(step.primary, step.box) for step in found.steps] == [("none", "feed/0"), ("feed_swap", "feed/0"), ("feed_swap", "feed/0"), ("navigation", "you")]


def test_a_toast_may_be_a_step_or_not():
    toast = [{"id": "toast 1", "kind": "toast", "dim": False}]
    found = truth([moment(0), moment(1000, overlays=toast), moment(3000)], 5000)
    assert [(step.primary, step.optional) for step in found.steps] == [("none", False), ("toast", True), ("toast", True)]


def test_an_answer_that_streams_is_no_step_until_it_is_done():
    found = truth([moment(0), *[moment(1000 + 700 * i, streams=["answer"], content={"answer": i}) for i in range(5)], moment(4500, content={"answer": 4})], 6500)
    assert [(step.start, step.primary) for step in found.steps] == [(0, "none"), (4500, "stream")]
    assert [state.kind for state in found.states].count("streaming") == 5


def test_the_same_screen_after_something_too_short_is_one_step():
    found = truth([moment(0), moment(1000, "flash"), moment(1200), moment(3000, "page")], 4000)
    assert [(step.start, step.end, step.screen) for step in found.steps] == [(0, 3000, "home"), (3000, 4000, "page")]
