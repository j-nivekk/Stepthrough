"""Getting the models that read text: pinned by checksum, fetched once, from wherever they are said to be."""

from __future__ import annotations

import hashlib
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app.services import text_models
from app.services.text_models import ModelFile, ModelsUnavailable


class _Quiet(SimpleHTTPRequestHandler):
    requests: list[str] = []

    def log_message(self, *_args) -> None:
        _Quiet.requests.append(self.path)


@pytest.fixture()
def mirror(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A server with two small files in place of the models, and a folder to fetch them into."""
    served = tmp_path / "served"
    (served / "some" / "model").mkdir(parents=True)
    files = []
    for name in ("one", "two"):
        content = name.encode() * 1000
        (served / "some" / "model" / name).write_bytes(content)
        files.append(ModelFile(name, f"some/model/{name}", len(content), hashlib.sha256(content).hexdigest()))
    monkeypatch.setattr(text_models, "FILES", tuple(files))
    _Quiet.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(_Quiet, directory=str(served)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_URL", f"http://127.0.0.1:{server.server_port}/")
    monkeypatch.setenv("STEPTHROUGH_OCR_MODELS", str(tmp_path / "models"))
    yield served / "some" / "model"
    server.shutdown()


def test_models_are_fetched_once(mirror: Path, tmp_path: Path) -> None:
    assert not text_models.present()
    folder = text_models.ensure()
    assert folder == (tmp_path / "models").resolve() and text_models.present()
    assert (folder / "two").read_bytes() == b"two" * 1000
    assert "Apache License 2.0" in (folder / "NOTICE.txt").read_text()
    assert len(_Quiet.requests) == 2 and not list(folder.glob("*.part"))
    text_models.ensure()
    assert len(_Quiet.requests) == 2  # nothing was asked for again


def test_only_what_is_missing_or_cut_short_is_fetched(mirror: Path) -> None:
    folder = text_models.ensure()
    (folder / "two").write_bytes(b"tw")
    assert not text_models.present()
    text_models.ensure()
    assert (folder / "two").read_bytes() == b"two" * 1000
    assert [request.rsplit("/", 1)[1] for request in _Quiet.requests] == ["one", "two", "two"]


@pytest.mark.parametrize("content", [b"TWO" * 1000, b"two", b"two" * 5000])
def test_a_file_that_is_not_the_expected_one_is_refused(mirror: Path, content: bytes) -> None:
    (mirror / "two").write_bytes(content)
    with pytest.raises(ModelsUnavailable, match="not the expected file"):
        text_models.ensure()
    assert not (text_models.folder() / "two").exists() and not list(text_models.folder().glob("*.part"))


def test_what_went_wrong_is_said(mirror: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (mirror / "one").unlink()
    with pytest.raises(ModelsUnavailable, match="could not be fetched"):
        text_models.ensure()
    monkeypatch.setenv("STEPTHROUGH_OCR_MODEL_URL", "http://127.0.0.1:9")
    with pytest.raises(ModelsUnavailable, match="could not be fetched from http://127.0.0.1:9"):
        text_models.ensure()
    (text_models.folder().parent / "a file").write_text("in the way")
    monkeypatch.setenv("STEPTHROUGH_OCR_MODELS", str(text_models.folder().parent / "a file" / "models"))
    with pytest.raises(ModelsUnavailable, match="could not be kept"):
        text_models.ensure()


def test_several_readers_starting_together_fetch_them_once(mirror: Path) -> None:
    threads = [threading.Thread(target=text_models.ensure) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert text_models.present() and len(_Quiet.requests) == 2


def test_they_are_kept_in_the_data_folder_unless_told_otherwise(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("STEPTHROUGH_OCR_MODELS", raising=False)
    monkeypatch.setattr(text_models.config, "DATA_ROOT", tmp_path)
    assert text_models.folder() == tmp_path / "ocr-models" / "ppocrv6"


def test_every_model_is_pinned_to_a_commit_and_a_checksum() -> None:
    for file in text_models.FILES:
        commit = file.path.split("/resolve/")[1].split("/")[0]
        assert len(commit) == 40 and len(file.sha256) == 64 and int(file.sha256, 16) and file.size > 0


def test_the_command_fetches_and_checks(mirror: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys) -> None:
    monkeypatch.setattr("sys.argv", ["text_models", str(tmp_path / "elsewhere")])
    assert text_models.main() == 0
    assert str(tmp_path / "elsewhere") in capsys.readouterr().out
    (tmp_path / "elsewhere" / "one").write_bytes(b"eno" * 1000)  # the right size, but damaged
    assert text_models.main() == 1
    assert "Damaged" in capsys.readouterr().err
