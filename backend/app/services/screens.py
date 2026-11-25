"""What led to each step, and which steps show the same screen.

The steps are found first (``stable_detection.py``) and stay as they are: this only looks at their screenshots, to say
what happened between them and which of them show one screen of the app. It compares two screenshots in three ways:

- **Moved** (``moves``): an area whose content is the same a little higher or lower. Strips of the one screenshot are
  looked for in the other, column by column, so a pane that scrolls beside one that does not is found as well.
- **Over it** (``overlay``): an area with new edges all round it, with new content in it that hides what was there,
  while the rest of the screen is as it was, or dimmed evenly: a menu, a dialog, a sheet. The same question the other
  way round says whether one went away.
- **Alike** (``Likeness``): how many of the details (ORB features) of one screenshot are found on the other, in the same
  place or all moved by as much. Details that many different screens of the recording have, such as a window frame, a
  side panel or a tab bar, count for less (as common words do in a search).

Everything here is plain measurement: no model is trained and nothing is random, so the same recording gives the same
answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

VIEW_LONG_EDGE = 960
CHANGED = 12  # grey levels, after a 3x3 box blur
CELL = 12  # px; changes are measured in squares of this size

# moves
STRIP = 36
STRIP_STEP = 18
BAND = 150  # px; a changed area is looked at in columns about this wide
STRIP_TEXTURE = 8.0
STRIP_MATCH = 0.80
MOVE_SMALLEST = 4
MOVE_AGREE = 0.7  # of the strips that should still be on the screen, this many moved by as much
MOVE_STRIPS = 3

# overlays
EDGE_NEW = 5  # grey levels from one pixel to the next
EDGE_MORE = 4  # ... and this much more than before
EDGE_RUN = 36  # px; a side is at least about this long
EDGE_LINES = 14  # sides looked at in each direction
EDGE_COVER = 0.55  # of a side
OVERLAY_HEIGHT = 0.075  # of the screen: lower ones are notes that come and go by themselves
OVERLAY_WIDTH = 0.08
OVERLAY_LARGEST = 0.92
OVERLAY_FREE = 0.22  # the largest that does not dim the screen (a pane with another page in it is larger)
OVERLAY_OVER_NOTHING = 0.12  # the largest that dims nothing and hides nothing
BLOCK = 24
BLOCK_TEXTURE = 4.0
BLOCK_SAME = 0.75  # correlation of a block with what was there, whatever the brightness
INSIDE_SAME = 0.15  # at most this share of the blocks under it is as it was ...
OUTSIDE_SAME = 0.85  # ... and at least this share of the others
OUTSIDE_DIMMED = 0.5  # ... or this, when the screen is clearly dimmed: nothing else looks like that
OVERLAY_DOMINANT = 0.6  # of the blocks that show something else, at least this share is under it
DOMINANT_DIMMED = 0.4
COLUMN_SAME = 0.7  # of the blocks above and below it, this share is as it was: a pane with another page in it is not
COLUMN_FEW = 20  # blocks
OVERLAY_DENSE = 0.35  # of the blocks under it, this share shows something, before or now
OVERLAY_EVEN = 0.45  # of it, this share is about as bright as its background (a picture has none)
DIM = 0.8  # clearly dimmed
DIMMER = 0.93  # the rest of the screen is dimmed when this dark or darker, and not dimmed but lit when ...
BRIGHTER = 1.08
KEYBOARD = (0.26, 0.46)  # height of a phone's keyboard, as a share of the screen
BACK = 0.5  # with this share of it as it was, an area is what it was before ...
COVERED = 0.2  # ... when at most this much of it was to be seen meanwhile
GONE = 0.3  # with less than this share of it left, what lay over the screen is gone (or shows something else)
OVER_STEPS = 14  # steps in which something that was opened is looked for to be gone again

# likeness
DETAILS = 1200
DETAIL_DISTANCE = 40
DETAIL_PLACE = 3.0  # px
DETAILS_FEW = 12
LIKE_CERTAIN = 0.75  # before it is known what is common
LIKE_SAME = 0.28  # the same screen
LIKE_OTHER = 0.10  # another screen
LIKE_BACK = 0.45  # back on another screen than the one before, though the content may look as if it had moved
LIKE_BACK_MORE = 0.15  # ... and this much more alike than the step before
TRAVEL_LEFT = 0.3  # of the height of what changed: so much should still be there after a scroll
NOTHING_LEFT = 0.03
LOOKBACK = 60

_CLOSE = np.ones((5, 3), np.uint8)
_orb = cv2.ORB_create(nfeatures=DETAILS, fastThreshold=8)
_matcher = cv2.BFMatcher(cv2.NORM_HAMMING)


@dataclass
class View:
    """A screenshot as it is compared."""

    grey: np.ndarray
    keep: np.ndarray | None  # uint8, 1 = look at it, 0 = ignored (the status bar, what keeps moving)
    points: np.ndarray = field(default_factory=lambda: np.zeros((0, 2), np.float32))
    details: np.ndarray | None = None

    @property
    def size(self) -> tuple[int, int]:
        return self.grey.shape[1], self.grey.shape[0]


@dataclass
class Move:
    x: int
    y: int
    width: int
    height: int
    dy: int
    agree: float


@dataclass
class Relation:
    """What one screenshot is to the one before it."""

    changed: float = 0.0  # share of the screen that differs
    height: float = 0.0  # of the part of it that differs, as a share of the screen's
    moves: list[Move] = field(default_factory=list)
    moved: float = 0.0  # share of what differs that is in areas that moved
    opened: tuple[int, int, int, int] | None = None
    closed: tuple[int, int, int, int] | None = None


def view(image: np.ndarray, keep: np.ndarray | None = None) -> View:
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    scale = min(1.0, VIEW_LONG_EDGE / max(grey.shape))
    size = (max(16, round(grey.shape[1] * scale)), max(16, round(grey.shape[0] * scale)))
    if (grey.shape[1], grey.shape[0]) != size:
        grey = cv2.resize(grey, size, interpolation=cv2.INTER_AREA)
    if keep is not None and keep.shape != grey.shape:
        keep = cv2.resize(keep, size, interpolation=cv2.INTER_NEAREST)
    points, details = _orb.detectAndCompute(grey, None if keep is None else keep * 255)
    places = np.array([point.pt for point in points], np.float32).reshape(-1, 2)
    return View(grey, keep, places, details)


def _keep(a: View, b: View) -> np.ndarray | None:
    if a.keep is None or b.keep is None:
        return a.keep if b.keep is None else b.keep
    return a.keep & b.keep


def changed_mask(a: View, b: View) -> np.ndarray:
    mask = cv2.blur(cv2.absdiff(a.grey, b.grey), (3, 3)) > CHANGED
    keep = _keep(a, b)
    return mask if keep is None else mask & (keep > 0)


def _cells(mask: np.ndarray, size: int = CELL) -> np.ndarray:
    height, width = mask.shape
    rows, columns = height // size, width // size
    return mask[: rows * size, : columns * size].reshape(rows, size, columns, size).any(axis=(1, 3)).astype(np.uint8)


# ── moved ───────────────────────────────────────────────────────────────────────────────────────────


def _columns(cells: np.ndarray) -> list[tuple[int, int, int, int]]:
    """The areas that changed, side by side: x, y, width, height in cells."""
    busy = cells.mean(axis=0) > 0.12
    found = []
    x = 0
    while x < len(busy):
        if not busy[x]:
            x += 1
            continue
        start, gap = x, 0
        while x < len(busy) and (busy[x] or gap < 1):
            gap = 0 if busy[x] else gap + 1
            x += 1
        end = x - gap
        rows = np.where(cells[:, start:end].any(axis=1))[0]
        if end - start >= 4 and len(rows) and rows[-1] - rows[0] >= 4:
            found.append((start, int(rows[0]), end - start, int(rows[-1] - rows[0] + 1)))
    return found


def _move_in(a: np.ndarray, b: np.ndarray) -> tuple[int, float] | None:
    """By how much the content of a column moved up or down, and how surely."""
    height = a.shape[0]
    found: list[tuple[int, int]] = []  # where a strip was, and how far it went
    textured = 0
    for top in range(0, height - STRIP + 1, STRIP_STEP):
        strip = a[top : top + STRIP]
        if float(strip.std()) < STRIP_TEXTURE:
            continue
        textured += 1
        scores = cv2.matchTemplate(b, strip, cv2.TM_CCOEFF_NORMED)[:, 0]
        best = int(scores.argmax())
        if scores[best] >= STRIP_MATCH:
            found.append((top, best - top))
    if textured < MOVE_STRIPS or len(found) < MOVE_STRIPS:
        return None
    ways = np.array([way for _top, way in found])
    moved = ways[np.abs(ways) >= MOVE_SMALLEST]
    if not len(moved):
        return None
    way = max({int(each) for each in moved}, key=lambda each: int((np.abs(ways - each) <= 2).sum()))
    agreeing = int((np.abs(ways - way) <= 2).sum())
    # Strips that went off the screen cannot be found again, and those that did not move are a header or a foot.
    still = sum(1 for _top, each in found if abs(each) <= 1)
    expected = 0
    for top in range(0, height - STRIP + 1, STRIP_STEP):
        if 0 <= top + way <= height - STRIP and float(a[top : top + STRIP].std()) >= STRIP_TEXTURE:
            expected += 1
    expected = max(1, expected - still)
    return (way, min(1.0, agreeing / expected)) if agreeing >= MOVE_STRIPS else None


def moves(a: View, b: View, changed: np.ndarray | None = None) -> tuple[list[Move], float]:
    """The areas in which the content moved up or down, and the share of what changed that lies in them."""
    if a.grey.shape != b.grey.shape:
        return [], 0.0
    mask = changed_mask(a, b) if changed is None else changed
    plain = _cells(mask)
    if plain.mean() < 0.01:
        return [], 0.0
    cells = cv2.morphologyEx(plain, cv2.MORPH_CLOSE, _CLOSE)
    found: list[Move] = []
    inside = 0
    for cx, cy, cw, ch in _columns(cells):
        x, y, width, height = cx * CELL, cy * CELL, cw * CELL, ch * CELL
        bands = max(1, min(5, round(width / BAND)))
        edges = np.linspace(x, x + width, bands + 1).astype(int)
        for left, right in zip(edges, edges[1:]):
            part_a, part_b = a.grey[y : y + height, left:right], b.grey[y : y + height, left:right]
            if part_a.shape[0] < STRIP * 3:
                continue
            answer = _move_in(part_a, part_b)
            if answer is None or answer[1] < MOVE_AGREE:
                continue
            found.append(Move(int(left), y, int(right - left), height, answer[0], round(answer[1], 3)))
            inside += int(plain[cy : cy + ch, left // CELL : max(left // CELL + 1, right // CELL)].sum())
    return found, float(min(1.0, inside / max(1, int(plain.sum()))))


# ── over it ─────────────────────────────────────────────────────────────────────────────────────────


@dataclass
class Overlay:
    """The area of something that lies over the screen: x, y, width, height."""

    box: tuple[int, int, int, int]
    hides: bool  # what was there before; if not, it may be a picture that came in
    dims: bool  # the rest of the screen
    sides: int  # with an edge (the others are sides of the screen)
    keyboard: bool = False


def _block_likeness(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """How much every block of the screen is like it was, whatever the brightness, and which of them show anything."""
    rows, columns = a.shape[0] // BLOCK, a.shape[1] // BLOCK
    shape = (rows, BLOCK, columns, BLOCK)
    of_a = a[: rows * BLOCK, : columns * BLOCK].astype(np.float32).reshape(shape)
    of_b = b[: rows * BLOCK, : columns * BLOCK].astype(np.float32).reshape(shape)
    mean_a, mean_b = of_a.mean(axis=(1, 3), keepdims=True), of_b.mean(axis=(1, 3), keepdims=True)
    part_a, part_b = of_a - mean_a, of_b - mean_b
    std_a, std_b = np.sqrt((part_a**2).mean(axis=(1, 3))), np.sqrt((part_b**2).mean(axis=(1, 3)))
    like = (part_a * part_b).mean(axis=(1, 3)) / np.maximum(std_a * std_b, 1e-3)
    flat = (std_a < BLOCK_TEXTURE) & (std_b < BLOCK_TEXTURE)
    return np.where(np.minimum(std_a, std_b) < 1.0, 0.0, like), ~flat


def _new_lines(a: np.ndarray, b: np.ndarray, keep: np.ndarray | None) -> np.ndarray:
    """Where ``b`` has an edge from one row to the next that ``a`` does not have there, or a row above or below."""
    was = np.abs(np.diff(a.astype(np.int16), axis=0)).astype(np.uint8)
    now = np.abs(np.diff(b.astype(np.int16), axis=0)).astype(np.uint8)
    was = cv2.dilate(was, np.ones((3, 1), np.uint8))
    new = (now >= EDGE_NEW) & (now.astype(np.int16) > was.astype(np.int16) + EDGE_MORE)
    if keep is not None:
        new &= keep[1:] > 0
    return new


def _sides(new: np.ndarray) -> tuple[list[int], np.ndarray]:
    """The rows with the longest new edges, and how much edge there is up to each column of every row."""
    thick = new | np.pad(new, ((0, 1), (0, 0)))[1:] | np.pad(new, ((1, 0), (0, 0)))[:-1]
    whole = cv2.morphologyEx(thick.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((1, 7), np.uint8))
    runs = cv2.morphologyEx(whole, cv2.MORPH_OPEN, np.ones((1, EDGE_RUN), np.uint8)).sum(axis=1).astype(int)
    rows: list[int] = []
    for row in np.argsort(-runs):
        if runs[row] < EDGE_RUN or len(rows) >= EDGE_LINES:
            break
        if all(abs(int(row) - other) > 3 for other in rows):
            rows.append(int(row))
    return sorted(rows), np.pad(np.cumsum(whole, axis=1, dtype=np.int32), ((0, 0), (1, 0)))


def overlay(a: View, b: View) -> Overlay | None:
    """What lies over the screen in ``b`` and not in ``a``: an area with new edges all round (but where it meets the side
    of the screen), with something else in it than before, while the rest of the screen is as it was, or dimmed."""
    if a.grey.shape != b.grey.shape:
        return None
    height, width = a.grey.shape
    keep = _keep(a, b)
    rows, along_rows = _sides(_new_lines(a.grey, b.grey, keep))
    columns, along_columns = _sides(_new_lines(a.grey.T, b.grey.T, None if keep is None else keep.T))
    if not rows and not columns:
        return None
    top = 0 if keep is None else int(np.argmax(keep.any(axis=1)))
    ys = sorted({top, *rows, height - 1})
    xs = sorted({0, *columns, width - 1})
    # (a side of the area that is a side of the screen has no edge to look for)
    found: list[tuple[float, tuple[int, int, int, int], int]] = []

    def cover(sums: np.ndarray, at: int, low: int, high: int) -> float:
        line = min(at, len(sums) - 1)
        return float(sums[line, high] - sums[line, low]) / (high - low)

    for i, y0 in enumerate(ys):
        for y1 in ys[i + 1 :]:
            if y1 - y0 < OVERLAY_HEIGHT * height:
                continue
            up = {x: cover(along_columns, x, y0, y1) for x in xs if 2 < x < width - 3}
            for j, x0 in enumerate(xs):
                for x1 in xs[j + 1 :]:
                    if x1 - x0 < OVERLAY_WIDTH * width:
                        continue
                    if (x1 - x0) * (y1 - y0) > OVERLAY_LARGEST * width * height:
                        continue
                    sides = [up[x] for x in (x0, x1) if x in up]
                    if y0 > top + 2:
                        sides.append(cover(along_rows, y0, x0, x1))
                    if y1 < height - 3:
                        sides.append(cover(along_rows, y1, x0, x1))
                    # one side of four may be one that was there (a submenu against its menu)
                    if not sides or sorted(sides)[1 if len(sides) == 4 else 0] < EDGE_COVER:
                        continue
                    found.append((float(np.mean(sides)) * len(sides), (x0, y0, x1 - x0, y1 - y0), len(sides)))
    if not found:
        return None
    like, textured = _block_likeness(a.grey, b.grey)
    if keep is not None:
        seen = keep[: like.shape[0] * BLOCK, : like.shape[1] * BLOCK].reshape(like.shape[0], BLOCK, like.shape[1], BLOCK).all(axis=(1, 3))
        textured &= seen
    before = cv2.resize(a.grey, (like.shape[1], like.shape[0]), interpolation=cv2.INTER_AREA).astype(np.float32)
    after = cv2.resize(b.grey, (like.shape[1], like.shape[0]), interpolation=cv2.INTER_AREA).astype(np.float32)
    best: tuple[float, Overlay] | None = None
    likely = [each for count in (4, 3, 2, 1) for each in sorted((one for one in found if one[2] == count), key=lambda one: -one[0])[:20]]
    for score, (x, y, w, h), sides in likely:
        inside = np.zeros(like.shape, bool)
        inside[int(np.ceil(y / BLOCK)) : (y + h) // BLOCK, int(np.ceil(x / BLOCK)) : (x + w) // BLOCK] = True
        near = np.zeros(like.shape, bool)
        near[max(0, y // BLOCK - 1) : (y + h) // BLOCK + 2, max(0, x // BLOCK - 1) : (x + w) // BLOCK + 2] = True
        under, rest = inside & textured, ~near & textured
        if under.sum() < 2:
            continue
        same_inside = float((like[under] >= BLOCK_SAME).mean())
        same_outside = float((like[rest] >= BLOCK_SAME).mean()) if rest.sum() >= 6 else 0.0
        lit = rest & (before >= 30) & (like >= BLOCK_SAME)
        light = float(np.median(after[lit] / before[lit])) if lit.any() else 1.0
        if light >= BRIGHTER:
            continue  # something went away, and the screen is lit again
        dims, clearly = light <= DIMMER, light <= DIM
        if same_inside > INSIDE_SAME or same_outside < (OUTSIDE_DIMMED if clearly else OUTSIDE_SAME):
            continue
        other = textured & (like < BLOCK_SAME)
        if (other & near).sum() < (DOMINANT_DIMMED if clearly else OVERLAY_DOMINANT) * other.sum():
            continue
        share = w * h / (width * height)
        keyboard = height > width and not dims and w >= 0.97 * width and y + h >= height - 3 and KEYBOARD[0] * height <= h <= KEYBOARD[1] * height
        if not dims and not keyboard and share > OVERLAY_FREE:
            continue
        if not dims and not keyboard:
            column = np.zeros(like.shape, bool)
            column[:, x // BLOCK : (x + w) // BLOCK + 1] = True
            above_below = rest & column
            if above_below.sum() >= COLUMN_FEW and (like[above_below] >= BLOCK_SAME).mean() < COLUMN_SAME:
                continue
        was_there = a.grey[y + 4 : y + h - 4, x + 4 : x + w - 4]
        hides = float((cv2.morphologyEx(was_there, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) >= 20).mean()) >= 0.01 if was_there.size else False
        patch = b.grey[y + 4 : y + h - 4, x + 4 : x + w - 4]
        levels = np.bincount(patch.ravel(), minlength=256)
        even = float(np.convolve(levels, np.ones(13, int), "same").max() / max(1, patch.size))
        if under.sum() < OVERLAY_DENSE * inside.sum() or even < OVERLAY_EVEN:
            continue
        if not hides and not dims and share > OVERLAY_OVER_NOTHING:
            continue
        value = score + 0.5 * (1 - same_inside) + 0.5 * same_outside
        if best is None or value > best[0]:
            best = (value, Overlay((x, y, w, h), hides, dims, sides, keyboard))
    return best[1] if best else None


# ── alike ───────────────────────────────────────────────────────────────────────────────────────────


class Likeness:
    """How much alike the screenshots of a recording are, by their details."""

    def __init__(self, views: list[View], lookback: int = LOOKBACK) -> None:
        self.views = views
        self.matched: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}
        for k in range(len(views)):
            for m in range(max(0, k - lookback), k):
                self.matched[(m, k)] = self._match(views[m], views[k])
        self.weights = [np.ones(len(each.points), np.float64) for each in views]

    @staticmethod
    def _match(a: View, b: View) -> tuple[np.ndarray, np.ndarray]:
        """The details of a that are on b, unmoved or all moved up or down by as much, and which those are on b."""
        nothing = (np.zeros(0, int), np.zeros(0, int))
        if a.details is None or b.details is None:
            return nothing
        pairs = [(match.queryIdx, match.trainIdx) for match in _matcher.match(a.details, b.details) if match.distance <= DETAIL_DISTANCE]
        if not pairs:
            return nothing
        of_a, of_b = np.array(pairs).T
        way = b.points[of_b] - a.points[of_a]
        straight = np.abs(way[:, 0]) <= DETAIL_PLACE
        good = straight & (np.abs(way[:, 1]) <= DETAIL_PLACE)
        moved = np.round(way[straight & ~good][:, 1])
        if len(moved):
            ways, counts = np.unique(moved, return_counts=True)
            good |= straight & (np.abs(way[:, 1] - ways[counts.argmax()]) <= DETAIL_PLACE)
        return np.unique(of_a[good]), np.unique(of_b[good])

    def of(self, m: int, k: int) -> float:
        """0 (nothing in common) to 1."""
        if (m, k) not in self.matched:
            return 0.0
        of_m, of_k = self.matched[(m, k)]
        whole_m, whole_k = float(self.weights[m].sum()), float(self.weights[k].sum())
        if min(len(self.weights[m]), len(self.weights[k])) < DETAILS_FEW or min(whole_m, whole_k) <= 0:
            return 0.0
        return min(float(self.weights[m][of_m].sum()) / whole_m, float(self.weights[k][of_k].sum()) / whole_k)

    def plain(self, m: int, k: int) -> float:
        """The same, with every detail counting as much."""
        if (m, k) not in self.matched:
            return 0.0
        of_m, of_k = self.matched[(m, k)]
        return min(len(of_m) / max(1, len(self.weights[m])), len(of_k) / max(1, len(self.weights[k])))

    def weigh(self, groups: list[int]) -> None:
        """Details that are on many of the screens (``groups``: which screen every step shows, as far as known) count
        for less: with n screens, one that is on s of them counts log((n + 1) / s) / log(n + 1). With few screens there
        is little to tell what is common by, and all count for something."""
        screens = len(set(groups))
        if screens < 2:
            self.weights = [np.ones(len(each.points), np.float64) for each in self.views]
            return
        on: list[list[set[int]]] = [[{groups[k]} for _ in range(len(each.points))] for k, each in enumerate(self.views)]
        for (m, k), (of_m, of_k) in self.matched.items():
            for detail in of_m:
                on[m][detail].add(groups[k])
            for detail in of_k:
                on[k][detail].add(groups[m])
        self.weights = [np.array([np.log((screens + 1) / len(each)) / np.log(screens + 1) for each in of], np.float64) for of in on]


# ── the recording ───────────────────────────────────────────────────────────────────────────────────


@dataclass
class Screen:
    """What is found out about a step."""

    label: str
    same_as: int | None = None  # an earlier step that shows the same screen
    reason: str = ""  # revisit, overlay_closed, scroll, same_page, typing, update; new when it is another screen
    likeness: float | None = None
    relation: Relation = field(default_factory=Relation)


def relate(a: View, b: View) -> Relation:
    changed = changed_mask(a, b)
    cells = _cells(changed)
    rows = np.where(cells.any(axis=1))[0]
    found = Relation(changed=float(cells.mean()), height=float(rows[-1] - rows[0] + 1) / len(cells) if len(rows) else 0.0)
    found.moves, found.moved = moves(a, b, changed)
    return found


def describe(views: list[View], labels: list[str], revisits: dict[int, int], travelled: list[float]) -> list[Screen]:
    """Labels and screens for every step. ``labels`` are those the changes themselves gave (``stable_detection``),
    ``revisits`` the steps whose picture is the same again, ``travelled`` how far the content was seen to move up or
    down on the way there (of the height of the screen; 0 when it was not)."""
    count = len(views)
    if not count:
        return []
    steps = [Screen(label) for label in labels]
    likeness = Likeness(views)
    for k in range(1, count):
        steps[k].relation = relate(views[k - 1], views[k])

    # First what is certain, to see which details are common to several screens.
    groups = list(range(count))

    def join(k: int, m: int) -> None:
        old, new = groups[k], groups[m]
        for each in range(count):
            if groups[each] == old:
                groups[each] = new

    for k in range(1, count):
        relation = steps[k].relation
        if k in revisits:
            join(k, revisits[k])
        elif relation.moved >= 0.7 or likeness.of(k - 1, k) >= LIKE_CERTAIN:
            join(k, k - 1)
        for m in range(max(0, k - LOOKBACK), k - 1):
            if groups[m] != groups[k] and likeness.of(m, k) >= LIKE_CERTAIN:
                join(k, m)
    likeness.weigh(groups)

    over: list[tuple[int, tuple[int, int, int, int]]] = []  # what lies over the screen: since which step, and where
    screen_of = list(range(count))  # which screen a step shows, as the first step that shows it

    def shows(k: int, m: int | None, reason: str) -> None:
        steps[k].same_as, steps[k].reason = m, reason
        screen_of[k] = screen_of[m] if m is not None else k

    for k in range(1, count):
        step, relation = steps[k], steps[k].relation
        a, b = views[k - 1], views[k]
        alike = likeness.of(k - 1, k)
        told = min(len(a.points), len(b.points)) >= 2 * DETAILS_FEW  # enough to tell by
        step.likeness = round(alike, 3)

        opened = closed = None
        if relation.moved < 0.5:
            opened, closed = overlay(a, b), overlay(b, a)
        if (opened and opened.keyboard) or (closed and closed.keyboard):
            shows(k, *((revisits[k], "revisit") if k in revisits else (k - 1, "update")))
            if step.label in ("navigation", "scroll", "modal", "modal_close"):
                step.label = "content_update"
            continue
        under = _seen_before(views, k, closed.box) if closed else None
        if under is not None and not closed.hides and not any(_overlap(box, closed.box) >= 0.4 for _since, box in over):
            under = None  # an empty area: that it is as it was says nothing
        if under is not None and told and likeness.of(under, k) < LIKE_OTHER:
            under = None  # another page, with an area that looks the same
        sure = opened and opened.hides and (opened.dims or opened.sides >= 3)
        if opened and not sure and not _shown_again(views, k, opened.box):
            opened = None
        # Something went away when what was under it is back, or the screen is lit again; not when another screen came.
        back = over[-1][0] - 1 if over else None
        if closed and (under is None and not closed.dims or (back is not None and under is None and likeness.of(back, k) < LIKE_OTHER)):
            closed = None
        if step.label == "modal_close" and back is not None and under is None and likeness.of(back, k) < LIKE_OTHER:
            step.label = "navigation"
        if step.label in ("modal", "modal_close") and relation.moved >= 0.5:
            step.label = "content_update"
        if closed and (over or not opened or (closed.dims and not opened.dims)):
            relation.closed = closed.box
        elif opened:
            relation.opened = opened.box

        if relation.closed or (step.label == "modal_close" and not relation.opened):
            step.label = "modal_close"
            since = next((position for position in range(len(over) - 1, -1, -1) if relation.closed and _overlap(over[position][1], relation.closed) >= 0.4), None)
            if since is not None:
                shows(k, over[since][0] - 1, "overlay_closed")
                del over[since:]
            elif over or not relation.closed or k < 2:
                shows(k, under if under is not None else _most_alike(likeness, steps, k), "overlay_closed")
                if over:
                    over.pop()
            else:
                # It was opened along with something else (a scroll before it), and is only seen now.
                before = steps[k - 1]
                shows(k, under if under is not None else _most_alike(likeness, steps, k - 1, k), "overlay_closed")
                if before.label != "modal":
                    before.label = "modal"
                    shows(k - 1, None, "overlay")
            continue
        if relation.opened or step.label == "modal":
            step.label = "modal"
            again = next((m for m in range(k - 2, max(-1, k - LOOKBACK), -1) if steps[m].label == "modal" and (revisits.get(k) == m or likeness.of(m, k) >= 2 * LIKE_SAME)), None)
            shows(k, again, "overlay")
            over.append((k, relation.opened or (0, 0, 0, 0)))
            continue

        # Was something closed along with another change (a message that came, a scroll)?
        gone = None
        while over and over[-1][1][2]:
            since, box = over[-1]
            if likeness.of(since - 1, k) < LIKE_OTHER or (gone is None and _same_under(a, b, box) >= GONE):
                break
            still = overlay(views[since - 1], b)
            if still is not None and _overlap(still.box, box) >= 0.4:
                break
            gone = since - 1
            over.pop()
        if gone is not None:
            shows(k, gone, "overlay_closed")
            if relation.moved < 0.5 or likeness.of(gone, k) >= LIKE_SAME:
                step.label = "modal_close"
            continue

        # Back on a screen seen before the one before?
        seen = revisits.get(k)
        if seen is not None and steps[seen].label == "modal":
            seen = None
        best = seen if seen is not None else _most_alike(likeness, steps, k - 1, k)
        if best is not None and screen_of[best] != screen_of[k - 1] and (seen is not None or likeness.of(best, k) >= max(LIKE_BACK, alike + LIKE_BACK_MORE)):
            shows(k, best, "revisit" if seen is not None else "same_page")
            if step.label != "feed_card_swap" and (alike < LIKE_SAME or relation.moved >= 0.5):
                step.label = "navigation" if told else step.label
            over.clear()
            continue

        if relation.moved >= 0.5:
            if step.label not in ("feed_card_swap", "text_entry"):
                step.label = "scroll"
            shows(k, *((seen, "revisit") if seen is not None else (k - 1, "scroll")))
            continue
        if step.label == "scroll" and alike < LIKE_SAME:
            # Either it was not seen to move at all, or not so far that nothing would be left of what was there, and
            # nothing is (not even a bar at the top): it is something else.
            left = 1.0 - travelled[k] / max(0.2, relation.height)
            if travelled[k] <= 0 or (left >= TRAVEL_LEFT and likeness.plain(k - 1, k) < NOTHING_LEFT):
                step.label = "navigation" if relation.changed >= 0.2 else "content_update"
        if seen is not None:
            shows(k, seen, "revisit")
        elif step.label in ("scroll", "feed_card_swap", "text_entry"):
            shows(k, k - 1, step.label)
        elif alike >= LIKE_SAME:
            shows(k, k - 1, "same_page")
            if step.label == "navigation":
                step.label = "content_update"
        elif best is not None:
            shows(k, best, "same_page")
            if step.label in ("content_update", "small_ui_change") and alike < LIKE_OTHER:
                step.label = "navigation"
            over.clear()
        elif step.label in ("content_update", "small_ui_change") and (alike >= LIKE_OTHER or not told or relation.changed < 0.02):
            shows(k, k - 1, "update")
        else:
            shows(k, None, "new")
            over.clear()
            if step.label in ("content_update", "small_ui_change"):
                step.label = "navigation"
    return steps


def _most_alike(likeness: Likeness, steps: list[Screen], before: int, k: int | None = None) -> int | None:
    """The step before ``before`` that is most like step ``k`` (which is the same, when left out), if any is alike."""
    k = before if k is None else k
    best, found = LIKE_SAME, None
    for m in range(max(0, k - LOOKBACK), before):
        if steps[m].label == "modal":
            continue
        alike = likeness.of(m, k)
        if alike >= best:
            best, found = alike, m
    return found


def _shown_again(views: list[View], opened: int, box: tuple[int, int, int, int]) -> bool:
    """Does the area show again, within a few steps, what it showed before something was opened over it?"""
    return any(_same_in(views[opened - 1], views[opened], views[later], box) for later in range(opened + 1, min(len(views), opened + 1 + OVER_STEPS)))


def _seen_before(views: list[View], closed: int, box: tuple[int, int, int, int]) -> int | None:
    """The last step before something lay over the area, when the area now shows the same as then."""
    for earlier in range(closed - 2, max(-1, closed - 2 - OVER_STEPS), -1):
        if _same_in(views[closed], views[closed - 1], views[earlier], box):
            return earlier
    return None


def _same_in(plain: View, covered: View, other: View, box: tuple[int, int, int, int]) -> bool:
    """Does an area of ``other`` show what it shows in ``plain``, and something else than in ``covered``?"""
    return _same_under(plain, other, box) >= BACK and _same_under(plain, covered, box) <= COVERED


def _same_under(a: View, b: View, box: tuple[int, int, int, int]) -> float:
    """The share of the blocks of an area that are as they were."""
    like, textured = _block_likeness(a.grey, b.grey)
    x, y, w, h = box
    part = (slice(int(np.ceil(y / BLOCK)), (y + h) // BLOCK), slice(int(np.ceil(x / BLOCK)), (x + w) // BLOCK))
    shown = textured[part]
    return float((like[part][shown] >= BLOCK_SAME).mean()) if shown.any() else 1.0


def _overlap(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    width = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    height = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    if width <= 0 or height <= 0:
        return 0.0
    return width * height / (a[2] * a[3] + b[2] * b[3] - width * height)
