"""The models that read the text of screenshots: which files they are, where they are kept, and getting them once.

They are PP-OCRv6 by PaddlePaddle (Apache License 2.0), made for ONNX Runtime: a small one that finds the lines of text
and one that reads them, 23 MB together. Every file is pinned by its SHA-256, so each installation reads with exactly
the same models, wherever the files came from.

They are fetched the first time text is read, and kept in the data folder (``ocr-models/ppocrv6``) or in the folder
``STEPTHROUGH_OCR_MODELS`` names. The Docker image has them in it. To get them beforehand, for a computer that will be
offline later, run from ``backend/``::

    uv run python -m app.services.text_models

``STEPTHROUGH_OCR_MODEL_URL`` names another server with the same files, where Hugging Face cannot be reached.
"""

from __future__ import annotations

import hashlib
import os
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from .. import config

DEFAULT_URL = "https://huggingface.co"
TIMEOUT_S = 60
CHUNK = 256 * 1024
NOTICE = """\
These files are PP-OCRv6 models by the PaddlePaddle authors, unchanged, licensed under the Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0; on Debian also /usr/share/common-licenses/Apache-2.0):

  detection    https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx
  recognition  https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx

Stepthrough reads the text of screenshots with them.
"""


@dataclass(frozen=True)
class ModelFile:
    name: str
    path: str
    size: int
    sha256: str


DETECTION = ModelFile(
    "detection.onnx",
    "PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/2ba1506c0380b8f0b03dd142459aac66d4421f6c/inference.onnx",
    1_780_590,
    "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8",
)
RECOGNITION = ModelFile(
    "recognition.onnx",
    "PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513/inference.onnx",
    21_159_378,
    "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
)
CHARACTERS = ModelFile(
    "recognition.yml",
    "PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513/inference.yml",
    150_579,
    "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1",
)
FILES = (DETECTION, RECOGNITION, CHARACTERS)
TOTAL_MB = round(sum(file.size for file in FILES) / 1_000_000)


_fetching = threading.Lock()  # one at a time, when several readers start together


class ModelsUnavailable(Exception):
    """Why the models are not there, in words for the person who asked for the text."""


def folder() -> Path:
    named = (os.environ.get("STEPTHROUGH_OCR_MODELS") or "").strip()
    return Path(named).expanduser().resolve() if named else config.DATA_ROOT / "ocr-models" / "ppocrv6"


def present(directory: Path | None = None) -> bool:
    """Whether every file is there. Their content was checked when they were fetched; a file cut short is noticed by
    its size."""
    directory = directory or folder()
    try:
        return all((directory / file.name).stat().st_size == file.size for file in FILES)
    except OSError:
        return False


def _checksum(path: Path) -> str:
    with path.open("rb") as reader:
        return hashlib.file_digest(reader, "sha256").hexdigest()


def _fetch(file: ModelFile, directory: Path, base: str) -> None:
    url = f"{base}/{file.path}"
    partial = directory / f"{file.name}.{os.getpid()}.part"
    try:
        digest, size = hashlib.sha256(), 0
        with urlopen(Request(url, headers={"User-Agent": "Stepthrough"}), timeout=TIMEOUT_S) as answer, partial.open("wb") as out:
            while chunk := answer.read(CHUNK):
                size += len(chunk)
                if size > file.size:
                    break
                digest.update(chunk)
                out.write(chunk)
        if size != file.size or digest.hexdigest() != file.sha256:
            raise ModelsUnavailable(f"The text recognition model from {url} is not the expected file.")
        os.replace(partial, directory / file.name)
    except (URLError, OSError) as error:
        reason = getattr(error, "reason", None) or error
        raise ModelsUnavailable(f"The text recognition models could not be fetched from {base}: {reason}") from error
    finally:
        partial.unlink(missing_ok=True)


def ensure(directory: Path | None = None, *, say: Callable[[str], None] | None = None) -> Path:
    """The folder with the models, after fetching what is missing in it. Raises ``ModelsUnavailable``."""
    directory = directory or folder()
    base = (os.environ.get("STEPTHROUGH_OCR_MODEL_URL") or DEFAULT_URL).strip().rstrip("/")
    with _fetching:
        if present(directory):
            return directory
        try:
            directory.mkdir(parents=True, exist_ok=True)
            for file in FILES:
                path = directory / file.name
                if path.is_file() and path.stat().st_size == file.size and _checksum(path) == file.sha256:
                    continue
                if say is not None:
                    say(f"Fetching {file.name} ({file.size / 1_000_000:.1f} MB)")
                _fetch(file, directory, base)
            (directory / "NOTICE.txt").write_text(NOTICE, encoding="utf-8")
        except OSError as error:
            raise ModelsUnavailable(f"The text recognition models could not be kept in {directory}: {error}") from error
    return directory


def main() -> int:
    directory = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else folder()
    started = time.monotonic()
    try:
        ensure(directory, say=print)
    except ModelsUnavailable as error:
        print(error, file=sys.stderr)
        return 1
    damaged = [file.name for file in FILES if _checksum(directory / file.name) != file.sha256]
    if damaged:
        print(f"Damaged in {directory}: {', '.join(damaged)}. Delete them and run this again.", file=sys.stderr)
        return 1
    print(f"The text recognition models are in {directory} ({TOTAL_MB} MB, {time.monotonic() - started:.1f} s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
