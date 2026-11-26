"""Reads the text of a screenshot with ONNX Runtime and the PP-OCRv6 models (``text_models.py``).

Made for interfaces: text that stands upright, in lines. One model marks where text is, on the screenshot made smaller
(which is what keeps it cheap); each line is then cut out of the full screenshot and read by the other. Lines of like
width are read together, so that little is padded and memory stays level.

What it reads: the Latin alphabet with the accents of European languages, Chinese and Japanese. Not Cyrillic, Greek,
Arabic, Hebrew, Korean or the scripts of India and South-East Asia.

Used in a process of its own (``app/text_reader.py``), never in the web server's.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from . import text_models

# Goes up whenever the same screenshot could be read differently (other models, sizes or limits). It is stored with
# what was read, so a run can say with which version, and offer to read again what an earlier one read.
ENGINE = "ppocrv6/1"

# Text is looked for on the screenshot at half its size, as phones and most computers draw a point with two pixels or
# more, but with its longest side no shorter than this (the text would become too small) and no longer (it costs memory).
SHORTEST_SEARCHED, LONGEST_SEARCHED = 1280, 1920
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
# How the detection model's map becomes lines (its own settings): what counts as text, how sure a line must be, and
# how far it is grown, as the model marks the core of a line only.
MARKED, SURE, GROWN = 0.2, 0.4, 1.4
MOST_LINES = 3000
LINE_HEIGHT = 48  # the height at which the recognition model reads
WIDEST = 2400  # a line wider than this, at that height, is read in pieces
BATCH_WIDTH = 2880  # lines read together, as their widths added up
NARROWEST = 160
LEGIBLE = 0.5  # what is read with less certainty is left out
# A line of the screen before that is in the same place (within so many pixels) and looks the same (no spot that
# differs by so many grey levels) is not read again.
SAME_PLACE, SAME_LOOK = 12, 14

Box = tuple[int, int, int, int]  # left, top, right, bottom, in pixels of the screenshot


@dataclass(frozen=True)
class Line:
    text: str
    box: Box
    score: float

    def packed(self) -> list[Any]:
        """As it is stored: the text, x, y, width, height and how sure the model was (0 to 1)."""
        left, top, right, bottom = self.box
        return [self.text, left, top, right - left, bottom - top, round(self.score, 3)]


def reading_order(lines: list[Line]) -> list[Line]:
    """Top to bottom, and left to right among those on one row."""
    rows: list[list[Line]] = []
    for line in sorted(lines, key=lambda line: (line.box[1] + line.box[3], line.box[0])):
        middle = (line.box[1] + line.box[3]) / 2
        if rows and rows[-1][0].box[1] <= middle <= rows[-1][0].box[3] and line.box[1] <= (rows[-1][0].box[1] + rows[-1][0].box[3]) / 2:
            rows[-1].append(line)
        else:
            rows.append([line])
    return [line for row in rows for line in sorted(row, key=lambda line: line.box[0])]


class TextEngine:
    def __init__(self, models: Path, threads: int = 4) -> None:
        import onnxruntime
        import yaml

        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        # Threads that wait for work must sleep: spinning would keep cores busy that analyses and the app need.
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")

        def session(file: text_models.ModelFile) -> Any:
            return onnxruntime.InferenceSession(str(models / file.name), options, providers=["CPUExecutionProvider"])

        self._detection, self._recognition = session(text_models.DETECTION), session(text_models.RECOGNITION)
        loader = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
        with (models / text_models.CHARACTERS.name).open(encoding="utf-8") as described:
            characters = yaml.load(described, Loader=loader)["PostProcess"]["character_dict"]
        # 0 stands for "nothing here", and after the characters comes the space
        self._characters = ["", *(str(character) for character in characters), " "]
        self.reused = 0  # lines of the last screenshot that were taken from the one before

    def read(self, image: np.ndarray, before: tuple[np.ndarray, list[Line]] | None = None) -> list[Line]:
        """The lines of text on a screenshot (BGR). ``before`` is the run's screen before it, with its lines: what
        looks the same in the same place is taken from there."""
        boxes = self._find(image)
        known = _unchanged(image, boxes, before)
        self.reused = len(known)
        unknown = [position for position in range(len(boxes)) if position not in known]
        fresh = dict(zip(unknown, self._recognise(image, [boxes[position] for position in unknown])))
        lines = []
        for position, box in enumerate(boxes):
            text, score = known.get(position) or fresh[position]
            if text.strip() and score >= LEGIBLE:
                lines.append(Line(" ".join(text.split()), box, score))
        return reading_order(lines)

    def _find(self, image: np.ndarray) -> list[Box]:
        """Where the lines of text are."""
        height, width = image.shape[:2]
        longest = max(height, width)
        scale = min(1.0, min(LONGEST_SEARCHED, max(SHORTEST_SEARCHED, longest / 2)) / longest)
        small_height, small_width = (max(32, round(side * scale / 32) * 32) for side in (height, width))
        small = cv2.resize(image, (small_width, small_height), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        data = ((small.astype(np.float32) / 255 - MEAN) / STD).transpose(2, 0, 1)[None]
        marked = self._detection.run(None, {self._detection.get_inputs()[0].name: data})[0][0, 0]
        contours, _ = cv2.findContours((marked > MARKED).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        boxes: list[Box] = []
        for contour in contours[:MOST_LINES]:
            x, y, w, h = cv2.boundingRect(contour)
            if min(w, h) < 3:
                continue
            inside = np.zeros((h, w), np.uint8)
            cv2.drawContours(inside, [contour - [x, y]], -1, 1, -1)
            if cv2.mean(marked[y:y + h, x:x + w], inside)[0] < SURE:
                continue
            grow = max(cv2.contourArea(contour), 1) * GROWN / max(cv2.arcLength(contour, True), 1)
            left, right = ((x - grow) * width / small_width, (x + w + grow) * width / small_width)
            top, bottom = ((y - grow) * height / small_height, (y + h + grow) * height / small_height)
            boxes.append((max(0, int(left)), max(0, int(top)), min(width, int(np.ceil(right))), min(height, int(np.ceil(bottom)))))
        return boxes

    def _recognise(self, image: np.ndarray, boxes: list[Box]) -> list[tuple[str, float]]:
        """The text in each box, and how sure the model is of it."""
        pieces: list[np.ndarray] = []
        parts: list[list[tuple[int, str]]] = []  # of each box: its pieces, and what stands between one and the next
        for left, top, right, bottom in boxes:
            cut = image[top:bottom, left:right]
            parts.append([])
            for piece, separator in _in_pieces(cut):
                parts[-1].append((len(pieces), separator))
                pieces.append(piece)
        read = self._recognise_pieces(pieces)
        found = []
        for part in parts:
            text = "".join(read[index][0] + separator for index, separator in part)
            letters = [max(1, len(read[index][0])) for index, _ in part]
            score = sum(read[index][1] * count for (index, _), count in zip(part, letters)) / sum(letters)
            found.append((text, score))
        return found

    def _recognise_pieces(self, pieces: list[np.ndarray]) -> list[tuple[str, float]]:
        widths = [min(WIDEST, max(8, int(np.ceil(LINE_HEIGHT * piece.shape[1] / max(1, piece.shape[0]))))) for piece in pieces]
        found: list[tuple[str, float]] = [("", 0.0)] * len(pieces)
        waiting = list(np.argsort(widths)) if pieces else []
        while waiting:
            together, padded = [], NARROWEST
            while waiting:
                wider = max(NARROWEST, -(-widths[waiting[0]] // 32) * 32)
                if together and wider * (len(together) + 1) > BATCH_WIDTH:
                    break
                together.append(waiting.pop(0))
                padded = wider
            data = np.zeros((len(together), 3, LINE_HEIGHT, padded), np.float32)
            for row, position in enumerate(together):
                piece = pieces[position]
                shrinks = piece.shape[0] > LINE_HEIGHT
                line = cv2.resize(piece, (widths[position], LINE_HEIGHT), interpolation=cv2.INTER_AREA if shrinks else cv2.INTER_LINEAR)
                data[row, :, :, : widths[position]] = ((line.astype(np.float32) / 255 - 0.5) / 0.5).transpose(2, 0, 1)
            likely = self._recognition.run(None, {self._recognition.get_inputs()[0].name: data})[0]
            best, certainty = likely.argmax(2), likely.max(2)
            for row, position in enumerate(together):
                # one character per run of the same one, without the "nothing here" between them
                kept = (best[row] != 0) & np.concatenate([[True], best[row][1:] != best[row][:-1]])
                text = "".join(self._characters[index] for index in best[row][kept] if index < len(self._characters))
                found[position] = (text, float(certainty[row][kept].mean()) if kept.any() else 0.0)
        return found


def _in_pieces(cut: np.ndarray) -> list[tuple[np.ndarray, str]]:
    """A line as it is, or when it is too wide to be read in one go, in pieces cut where it is emptiest: between words,
    where there are words. With each, what stands between it and the next: a space, or nothing between letters."""
    height, width = cut.shape[:2]
    count = int(np.ceil(LINE_HEIGHT * width / max(1, height) / WIDEST))
    if count < 2:
        return [(cut, "")]
    grey = cut.max(axis=2)
    ink = (grey.max(axis=0).astype(np.int16) - grey.min(axis=0)).astype(np.float32)
    gap = max(1, round(height * 0.2))
    around = cv2.blur(ink[None], (gap, 1))[0]
    pieces, start = [], 0
    for number in range(1, count):
        wanted, reach = round(number * width / count), round(min(4 * height, width / count / 4))
        split = wanted - reach + int(np.argmin(around[wanted - reach:wanted + reach]))
        pieces.append((cut[:, start:split], " " if around[split] < 0.25 * ink.max() else ""))
        start = split
    return [*pieces, (cut[:, start:], "")]


def _unchanged(
    image: np.ndarray, boxes: list[Box], before: tuple[np.ndarray, list[Line]] | None
) -> dict[int, tuple[str, float]]:
    """Which boxes hold what a line of the screen before held, and what that was."""
    if before is None or before[0].shape != image.shape:
        return {}
    earlier, lines = before
    known: dict[int, tuple[str, float]] = {}
    for position, box in enumerate(boxes):
        for line in lines:
            if all(abs(one - other) < SAME_PLACE for one, other in zip(line.box, box)):
                left, top, right, bottom = box
                difference = cv2.absdiff(image[top:bottom, left:right], earlier[top:bottom, left:right]).max(2)
                if cv2.blur(difference, (5, 5)).max() < SAME_LOOK:
                    known[position] = (line.text, line.score)
                break
    return known
