"""Reading the text of a screenshot. The tests marked ``models`` read with the real models, where they are: in the
folder STEPTHROUGH_OCR_MODELS names or the data folder (`python -m app.services.text_models` fetches them)."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.services import text_engine, text_models, text_queue
from app.services.text_engine import Line, _in_pieces, _unchanged, reading_order
from app.services.text_queue import Reader, Screen

onnxruntime = pytest.importorskip("onnxruntime", reason="text recognition is not installed (uv sync --group ocr)")
HERE = text_models.folder()  # before any test changes where the data is
models = pytest.mark.models
needs_models = pytest.mark.skipif(not text_models.present(HERE), reason="the models are not here")


def _line(text: str, left: int, top: int, right: int, bottom: int) -> Line:
    return Line(text, (left, top, right, bottom), 0.99)


def _picture(words: list[tuple[str, int, int]], size: tuple[int, int] = (760, 420), scale: float = 1.1) -> np.ndarray:
    image = np.full((size[1], size[0], 3), 255, np.uint8)
    for word, x, y in words:
        cv2.putText(image, word, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (20, 20, 20), 2, cv2.LINE_AA)
    return image


def test_lines_are_in_reading_order() -> None:
    title, left, right, below = _line("title", 300, 10, 420, 40), _line("left", 10, 60, 90, 80), _line("right", 500, 56, 600, 84), _line("below", 10, 95, 90, 115)
    assert [line.text for line in reading_order([below, right, left, title])] == ["title", "left", "right", "below"]
    assert reading_order([]) == []


def test_a_line_too_wide_to_be_read_in_one_go_is_cut_between_words() -> None:
    line = np.full((20, 2400, 3), 255, np.uint8)
    for start in range(10, 2390, 60):  # words of 45 pixels, 15 apart
        line[4:16, start:start + 45] = 0
    pieces = _in_pieces(line)
    assert len(pieces) == 3 and sum(piece.shape[1] for piece, _ in pieces) == 2400
    for piece, _ in pieces[:-1]:
        assert (piece[:, -1] == 255).all()  # cut in a gap
    assert [separator for _, separator in pieces] == [" ", " ", ""]
    assert all(piece.shape[1] * text_engine.LINE_HEIGHT / 20 <= text_engine.WIDEST * 1.25 for piece, _ in pieces)
    assert _in_pieces(line[:, :900])[0][1] == "" and len(_in_pieces(line[:, :900])) == 1


def test_letters_without_gaps_are_joined_again_without_a_space() -> None:
    line = np.full((20, 2400, 3), 255, np.uint8)
    line[2:18, ::2] = 0
    assert [separator for _, separator in _in_pieces(line)] == ["", "", ""]


def test_what_looks_the_same_in_the_same_place_is_known() -> None:
    before = _picture([("Settings", 40, 80), ("Wi-Fi", 40, 200)])
    after = _picture([("Settings", 40, 80), ("Wi-Fe", 40, 200)])
    lines = [_line("Settings", 36, 50, 200, 90), _line("Wi-Fi", 36, 170, 140, 210)]
    boxes = [(38, 51, 202, 91), (36, 170, 140, 210), (400, 300, 500, 330)]
    assert _unchanged(after, boxes, (before, lines)) == {0: ("Settings", 0.99)}
    assert _unchanged(after, boxes, None) == {}
    assert _unchanged(after[:, :-2], boxes, (before, lines)) == {}  # another size: another screen


def test_a_line_is_stored_with_its_place() -> None:
    assert Line("Wi-Fi", (36, 170, 140, 210), 0.98765).packed() == ["Wi-Fi", 36, 170, 104, 40, 0.988]


def test_the_server_can_tell_whether_text_can_be_read() -> None:
    assert text_queue.check() == {"ok": True, "onnxruntime": onnxruntime.__version__}


def test_a_package_that_is_missing_is_named(tmp_path: Path) -> None:
    program = "import sys; sys.modules['onnxruntime'] = None; sys.argv = ['x', '--check']; from app.text_reader import main; main()"
    answer = subprocess.run([sys.executable, "-c", program], cwd=text_queue.BACKEND, capture_output=True, text=True, check=True)
    assert json.loads(answer.stdout)["ok"] is False and json.loads(answer.stdout)["missing"] == "onnxruntime"


# ── with the models ───────────────────────────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def engine() -> text_engine.TextEngine:
    return text_engine.TextEngine(HERE, threads=2)


@models
@needs_models
def test_text_is_read_with_its_place(engine: text_engine.TextEngine) -> None:
    image = _picture([("Notifications", 40, 90), ("Language", 40, 200), ("English", 480, 200)])
    lines = engine.read(image)
    assert [line.text for line in lines] == ["Notifications", "Language", "English"]
    left, top, right, bottom = lines[2].box
    assert left < 490 and right > 590 and top < 180 and bottom > 200 and all(line.score > 0.8 for line in lines)


@models
@needs_models
def test_a_screen_without_text_gives_none(engine: text_engine.TextEngine) -> None:
    assert engine.read(np.full((360, 640, 3), 128, np.uint8)) == []
    assert engine.read(np.full((8, 6, 3), 255, np.uint8)) == []


@models
@needs_models
def test_unchanged_lines_are_not_read_again(engine: text_engine.TextEngine) -> None:
    before = _picture([("Notifications", 40, 90), ("Language", 40, 200)])
    after = _picture([("Notifications", 40, 90), ("Password", 40, 200)])
    lines = engine.read(before)
    assert engine.reused == 0
    assert [line.text for line in engine.read(after, (before, lines))] == ["Notifications", "Password"]
    assert engine.reused == 1


@models
@needs_models
def test_a_very_wide_line_is_read_whole(engine: text_engine.TextEngine) -> None:
    words = " ".join(["walkthrough", "settings", "account", "privacy", "security"] * 5)
    image = _picture([(words, 20, 60)], size=(3400, 120), scale=0.75)
    read = " ".join(line.text for line in engine.read(image)).split()
    assert len(set(read) & set(words.split())) == 5 and sum(word in words.split() for word in read) >= 24


# ── the process ───────────────────────────────────────────────────────────────────────────────────────────────


@pytest.fixture()
def reader():
    reader = Reader(HERE, threads=2)
    yield reader
    reader.stop()


def _saved(folder: Path, name: str, image: np.ndarray) -> Screen:
    # not through OpenCV: a path with letters outside ASCII must work everywhere
    path = folder / name
    path.write_bytes(cv2.imencode(".png", image)[1].tobytes())
    return Screen("run", name, str(path))


@models
@needs_models
def test_the_process_reads_one_screenshot_after_another(reader: Reader, tmp_path: Path) -> None:
    first = reader.read(_saved(tmp_path, "eerste schérm.png", _picture([("Inbox", 40, 90), ("Drafts", 40, 200)])))
    assert first is not None and [line[0] for line in first["lines"]] == ["Inbox", "Drafts"]
    assert (first["width"], first["height"], first["reused"]) == (760, 420, 0)
    second = reader.read(_saved(tmp_path, "tweede.png", _picture([("Inbox", 40, 90), ("Archive", 40, 200)])))
    assert second is not None and [line[0] for line in second["lines"]] == ["Inbox", "Archive"] and second["reused"] == 1
    other_run = Screen("other", "x", str(tmp_path / "tweede.png"))
    again = reader.read(other_run)
    assert again is not None and again["reused"] == 0  # nothing of another run is taken over


@models
@needs_models
def test_the_process_goes_on_after_a_screenshot_it_cannot_open(reader: Reader, tmp_path: Path) -> None:
    (tmp_path / "broken.png").write_bytes(b"\x89PNG not really")
    answer = reader.read(Screen("run", "broken", str(tmp_path / "broken.png")))
    assert answer is not None and "not an image" in answer["error"]
    gone = reader.read(Screen("run", "gone", str(tmp_path / "gone.png")))
    assert gone is not None and "error" in gone
    good = reader.read(_saved(tmp_path, "good.png", _picture([("Inbox", 40, 90)])))
    assert good is not None and [line[0] for line in good["lines"]] == ["Inbox"]


@models
@needs_models
def test_a_process_that_died_gives_no_answer(reader: Reader, tmp_path: Path) -> None:
    screen = _saved(tmp_path, "good.png", _picture([("Inbox", 40, 90)]))
    reader._process.kill()
    reader._process.wait()
    assert reader.read(screen) is None


@models
@needs_models
def test_the_process_ends_with_the_server(tmp_path: Path) -> None:
    reader = Reader(HERE, threads=1)
    reader._process.stdin.close()  # what happens when the server ends
    for _ in range(100):
        if reader._process.poll() is not None:
            break
        time.sleep(0.05)
    assert reader._process.poll() == 0


def test_damaged_models_are_said_to_be(tmp_path: Path) -> None:
    for file in text_models.FILES:
        (tmp_path / file.name).write_bytes(b"not a model")
    with pytest.raises(text_queue.Unavailable) as why:
        Reader(tmp_path, threads=1)
    assert why.value.message == text_queue.NOT_STARTED and why.value.detail
