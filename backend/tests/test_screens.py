"""What led to a step and which steps show the same screen, on drawn pages (services/screens.py)."""

from __future__ import annotations

import random

import cv2
import numpy as np
import pytest

from app.services import screens

WIDTH, HEIGHT = 960, 600
WORDS = "account change notes market summer paper river window answer garden morning letter travel signal bridge corner".split()


def _text(image: np.ndarray, x: int, y: int, text: str, scale: float = 0.5, colour: int = 40) -> None:
    cv2.putText(image, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (colour,) * 3, 1, cv2.LINE_AA)


def _column(seed: int, width: int, height: int = 2400, background: int = 250) -> np.ndarray:
    """A long page: headings, lines of text, and a box now and then."""
    rng = random.Random(seed)
    page = np.full((height, width, 3), background, np.uint8)
    y = 30
    while y < height - 30:
        if rng.random() < 0.12:
            cv2.rectangle(page, (16, y - 14), (width - 30, y + 40), (225,) * 3, -1)
            _text(page, 26, y + 18, rng.choice(WORDS) + str(rng.randint(10, 99)))
            y += 66
        else:
            _text(page, 18, y, " ".join(rng.choice(WORDS) for _ in range(max(2, width // 90))) + f" {rng.randint(100, 999)}", 0.45)
            y += 22
    return page


def _screen(content: int = 1, scroll: int = 0, side: int = 100, side_scroll: int = 0, title: str = "Inbox") -> np.ndarray:
    """A window with a bar, a side pane and a page in it."""
    image = np.full((HEIGHT, WIDTH, 3), 250, np.uint8)
    image[40:, :300] = _column(side, 300, background=238)[side_scroll : side_scroll + HEIGHT - 40]
    image[40:, 301:] = _column(content, WIDTH - 301)[scroll : scroll + HEIGHT - 40]
    cv2.rectangle(image, (0, 0), (WIDTH, 39), (60, 60, 60), -1)
    _text(image, 16, 26, title, 0.6, 240)
    for k, name in enumerate(("File", "Edit", "View", "Help")):
        _text(image, 600 + 80 * k, 26, name, 0.5, 220)
    return image


def _menu(image: np.ndarray, x: int = 420, y: int = 150, rows: int = 8) -> np.ndarray:
    image = image.copy()
    cv2.rectangle(image, (x, y), (x + 170, y + 26 * rows + 8), (255,) * 3, -1)
    cv2.rectangle(image, (x, y), (x + 170, y + 26 * rows + 8), (205,) * 3, 1)
    for row in range(rows):
        _text(image, x + 14, y + 24 + 26 * row, f"{WORDS[-row - 1]} {row * 7}", 0.45)
    return image


def _dialog(image: np.ndarray, strength: float = 0.5) -> np.ndarray:
    image = (image * strength).astype(np.uint8)
    cv2.rectangle(image, (300, 190), (660, 410), (252,) * 3, -1)
    _text(image, 330, 240, "Delete this letter?", 0.7)
    for row in range(3):
        _text(image, 330, 280 + 24 * row, " ".join(WORDS[row * 3 : row * 3 + 4]), 0.45)
    return image


def _describe(images: list[np.ndarray], labels: list[str], revisits: dict[int, int] | None = None, travelled: list[float] | None = None):
    views = [screens.view(image) for image in images]
    return screens.describe(views, labels, revisits or {}, travelled or [0.0] * len(images))


def test_a_pane_that_scrolls_beside_one_that_does_not_is_found() -> None:
    a, b = screens.view(_screen(scroll=0)), screens.view(_screen(scroll=140))
    found, share = screens.moves(a, b)
    assert share > 0.9
    assert {move.dy for move in found} <= {-141, -140, -139}
    assert min(move.x for move in found) >= 280  # nothing in the side pane
    back, _share = screens.moves(b, a)
    assert {move.dy for move in back} <= {139, 140, 141}

    side, _share = screens.moves(a, screens.view(_screen(side_scroll=90)))
    assert {move.dy for move in side} <= {-91, -90, -89} and max(move.x + move.width for move in side) <= 320


def test_another_page_has_not_moved() -> None:
    found, share = screens.moves(screens.view(_screen(content=1)), screens.view(_screen(content=2)))
    assert found == [] and share == 0.0


def test_a_menu_over_the_screen_is_found_and_so_is_its_going() -> None:
    page = _screen()
    a, b = screens.view(page), screens.view(_menu(page))
    opened = screens.overlay(a, b)
    assert opened is not None and opened.hides and not opened.dims and opened.sides == 4
    x, y, width, height = opened.box
    assert abs(x - 420) <= 4 and abs(y - 150) <= 4 and abs(width - 170) <= 8 and abs(height - 216) <= 8
    steps = _describe([page, _menu(page), page], ["opening_screen", "content_update", "content_update"])
    assert [step.label for step in steps] == ["opening_screen", "modal", "modal_close"]
    assert (steps[2].same_as, steps[2].reason) == (0, "overlay_closed")


@pytest.mark.parametrize("strength", [0.4, 0.6, 0.75])
def test_a_dialog_that_dims_the_screen_is_found(strength: float) -> None:
    page = _screen()
    opened = screens.overlay(screens.view(page), screens.view(_dialog(page, strength)))
    assert opened is not None and opened.dims
    x, y, width, height = opened.box
    assert abs(x - 300) <= 4 and abs(y - 190) <= 4 and abs(width - 360) <= 8 and abs(height - 220) <= 8


def test_what_is_no_overlay() -> None:
    page = _screen()
    lit = page.copy()
    lit[150:200, 320:900] = np.clip(lit[150:200, 320:900].astype(int) - 22, 0, 255).astype(np.uint8)  # a row lights up
    other_pane = _screen(content=2)
    toggled = page.copy()
    cv2.circle(toggled, (860, 300), 14, (60, 160, 60), -1)
    for image in (lit, other_pane, toggled, _screen(scroll=140)):
        assert screens.overlay(screens.view(page), screens.view(image)) is None

    # a picture that comes in over an empty part of the page is no menu, for it stays
    empty = page.copy()
    empty[150:420, 340:700] = 250
    picture = empty.copy()
    rng = np.random.default_rng(3)
    picture[150:420, 340:700] = cv2.resize(rng.integers(0, 255, (9, 12, 3), dtype=np.uint8), (360, 270), interpolation=cv2.INTER_CUBIC)
    steps = _describe([empty, picture, picture], ["opening_screen", "content_update", "small_ui_change"])
    assert [step.label for step in steps] == ["opening_screen", "content_update", "small_ui_change"]


def test_another_page_with_a_card_in_one_pane_is_no_overlay(monkeypatch: pytest.MonkeyPatch) -> None:
    # most of the window stays as it was, and the page that changes has a card with edges all round, as a menu has
    def window(seed: int, card: bool) -> np.ndarray:
        image = np.full((HEIGHT, WIDTH, 3), 250, np.uint8)
        image[:, :640] = _column(7, 640)[:HEIGHT]
        image[:, 641:] = _column(seed, WIDTH - 641)[:HEIGHT]
        if card:
            cv2.rectangle(image, (700, 230), (900, 420), (255,) * 3, -1)
            cv2.rectangle(image, (700, 230), (900, 420), (205,) * 3, 1)
            for row in range(6):
                _text(image, 714, 260 + 26 * row, f"{WORDS[row]} {row * 7}", 0.45)
        return image

    before, after = screens.view(window(2, False)), screens.view(window(3, True))
    assert screens.overlay(before, after) is None
    opened = screens.overlay(screens.view(window(3, False)), after)  # the same card over the page as it was
    assert opened is not None and abs(opened.box[0] - 700) <= 4 and abs(opened.box[1] - 230) <= 4
    monkeypatch.setattr(screens, "COLUMN_SAME", 0.0)
    assert screens.overlay(before, after) is not None  # nothing but what is above and below tells them apart


def test_details_that_many_screens_share_count_for_less() -> None:
    images = [_screen(content=k, title=f"Page {k}") for k in range(1, 6)]
    views = [screens.view(image) for image in images] + [screens.view(_screen(content=2, scroll=60, title="Page 2"))]
    likeness = screens.Likeness(views)
    plain = likeness.of(0, 1)  # two pages in one window: the side pane is the same
    same = likeness.of(1, 5)
    likeness.weigh([0, 1, 2, 3, 4, 1])
    assert plain > screens.LIKE_OTHER > 2 * likeness.of(0, 1)
    assert same > 0.5 and likeness.of(1, 5) > screens.LIKE_SAME
    assert likeness.of(1, 5) == likeness.of(1, 5) and likeness.plain(0, 1) == pytest.approx(plain)


def test_a_walk_through_an_app() -> None:
    first, scrolled = _screen(1), _screen(1, scroll=160)
    second = _screen(2, title="Letter")
    changed = _screen(1, scroll=150)  # back on the first page, not quite where it was, with something new on it
    cv2.circle(changed, (900, 20), 9, (80, 80, 220), -1)
    images = [first, scrolled, _menu(scrolled), scrolled, second, _dialog(second), second, changed]
    labels = ["opening_screen", "navigation", "content_update", "content_update", "content_update", "navigation", "navigation", "navigation"]
    steps = _describe(images, labels, revisits={3: 1, 6: 4})
    assert [step.label for step in steps] == [
        "opening_screen", "scroll", "modal", "modal_close", "navigation", "modal", "modal_close", "navigation",
    ]
    assert [step.same_as for step in steps] == [None, 0, None, 1, None, None, 4, 3]
    assert [step.reason for step in steps] == ["", "scroll", "overlay", "overlay_closed", "new", "overlay", "overlay_closed", "same_page"]
    assert steps[1].relation.moves and steps[2].relation.opened and steps[6].relation.closed


def test_a_page_that_shows_part_of_the_one_before_is_still_another_page() -> None:
    # the label says the content moved, but it moved far less than would leave nothing of it, and nothing is left
    steps = _describe([_screen(1, side=100), _screen(2, side=200, title="Else")], ["opening_screen", "scroll"], travelled=[0.0, 0.3])
    assert steps[1].label == "navigation" and steps[1].reason == "new"
    # and a long scroll is a scroll though nothing is left but the window
    steps = _describe([_screen(1), _screen(1, scroll=560)], ["opening_screen", "scroll"], travelled=[0.0, 0.93])
    assert steps[1].label == "scroll" and steps[1].same_as == 0


def test_ignored_areas_are_not_looked_at() -> None:
    page, menu = _screen(), _menu(_screen())
    keep = np.ones((HEIGHT, WIDTH), np.uint8)
    keep[140:380, 400:620] = 0
    assert screens.overlay(screens.view(page, keep), screens.view(menu, keep)) is None
    assert not screens.changed_mask(screens.view(page, keep), screens.view(menu, keep)).any()


def test_the_same_screenshots_give_the_same_answer_and_none_gives_none() -> None:
    images = [_screen(1), _screen(1, scroll=120), _screen(3)]
    labels = ["opening_screen", "scroll", "navigation"]
    assert _describe(images, labels) == _describe(images, labels)
    assert screens.describe([], [], {}, []) == []
    blank = np.full((HEIGHT, WIDTH, 3), 255, np.uint8)  # nothing to tell by
    assert [step.reason for step in _describe([blank, blank], ["opening_screen", "small_ui_change"])] == ["", "update"]


# ── what the pathway tutorial says ──────────────────────────────────────────────────────────────────
# frontend/src/components/pathwayTutorial/tutorialModel.ts tells what the engine finds in this story. It teaches two
# mistakes that the engine really makes, so they are checked here as well: when one is gone, the lesson has to change.


def _line(rng: random.Random, words: int) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(words)) + f" {rng.randint(100, 999)}"


def _picture(image: np.ndarray, seed: int, x: int, y: int, width: int, height: int) -> None:
    noise = np.random.default_rng(seed).integers(0, 255, (7, 9, 3), dtype=np.uint8)
    image[y : y + height, x : x + width] = cv2.resize(noise, (width, height), interpolation=cv2.INTER_CUBIC)


def _phone(tab: int, title: str) -> np.ndarray:
    image = np.full((960, 444, 3), 250, np.uint8)
    cv2.rectangle(image, (0, 0), (444, 70), (225,) * 3, -1)
    _text(image, 20, 45, title, 0.8)
    cv2.rectangle(image, (0, 884), (444, 960), (232,) * 3, -1)
    for k, name in enumerate(("Home", "Find", "Saved", "You")):
        _text(image, 24 + 110 * k, 926, name, 0.5, 0 if k == tab else 130)
    return image


def _home(posts: int, badge: bool = False) -> np.ndarray:
    image, rng = _phone(0, "Daily"), random.Random(posts)
    _picture(image, posts, 20, 90, 404, 180)
    for k in range(7):
        _picture(image, posts * 50 + k, 20, 300 + 82 * k, 60, 60)
        _text(image, 96, 324 + 82 * k, _line(rng, 2), 0.55)
        _text(image, 96, 350 + 82 * k, _line(rng, 2), 0.42, 110)
    if badge:
        cv2.circle(image, (424, 22), 11, (43, 57, 192), -1)
    return image


def _settings(scroll: int = 0, on: bool = False) -> np.ndarray:
    image, rng = _phone(3, "Settings"), random.Random(900)
    page = np.full((1500, 444, 3), 250, np.uint8)
    for k in range(20):
        _text(page, 24, 44 + 70 * k, _line(rng, 2), 0.55)
        cv2.rectangle(page, (350, 26 + 70 * k), (404, 52 + 70 * k), (124, 175, 72) if on and k == 0 else (200,) * 3, -1)
    image[70:884] = page[scroll : scroll + 814]
    return image


def _permission(under: np.ndarray) -> np.ndarray:
    image = (under * 0.6).astype(np.uint8)
    cv2.rectangle(image, (50, 360), (394, 560), (252,) * 3, -1)
    _text(image, 80, 410, "Allow notifications?", 0.7)
    _text(image, 80, 450, "so that nothing is missed")
    _text(image, 90, 520, "Not now", 0.6)
    cv2.rectangle(image, (250, 490), (370, 540), (95, 58, 31), -1)
    _text(image, 280, 522, "Allow", 0.6, 250)
    return image


def _product(number: int) -> np.ndarray:
    image, own, shared = _phone(1, "Find"), random.Random(300 + number), random.Random(5)
    _picture(image, 700 + number, 20, 90, 404, 230)
    _text(image, 24, 360, _line(own, 2), 0.75)
    _text(image, 24, 395, f"EUR {own.randint(10, 99)}.95", 0.6)
    for k, size in enumerate(("S", "M", "L", "XL")):
        cv2.rectangle(image, (24 + 92 * k, 420), (100 + 92 * k, 460), (90,) * 3, 1)
        _text(image, 54 + 92 * k, 446, size, 0.6)
    cv2.rectangle(image, (24, 480), (420, 530), (60,) * 3, -1)
    _text(image, 150, 512, "Add to basket", 0.65, 250)
    for k in range(10):
        _text(image, 24, 570 + 31 * k, _line(shared, 4))
    return image


def _story(home_again: np.ndarray) -> list[tuple[str, int | None, str]]:
    pages = [_home(1), _settings(), _settings(90), _permission(_settings(90)), _settings(on=True), home_again, _product(1), _product(2)]
    labels = ["opening_screen", "navigation", "scroll", "modal", "modal_close", "navigation", "navigation", "content_update"]
    return [(step.label, step.same_as, step.reason) for step in _describe(pages, labels)]


def test_the_story_of_the_pathway_tutorial() -> None:
    assert _story(_home(2)) == [
        ("opening_screen", None, ""),
        ("navigation", None, "new"),
        ("scroll", 1, "scroll"),
        ("modal", None, "overlay"),
        ("modal_close", 1, "overlay_closed"),
        ("navigation", None, "new"),  # home, but its feed has other posts: one screen, split in two
        ("navigation", None, "new"),
        ("content_update", 6, "same_page"),  # the next product, most of which is the same: two screens in one box
    ]
    # a small change on home is no reason to split it
    assert _story(_home(1, badge=True))[5] == ("navigation", 0, "same_page")
