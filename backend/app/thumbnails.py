"""Smaller copies of a project's screenshots, for the page.

A screenshot is kept at the size of the recording (a desktop recording's is about 3248 × 2122 and 1.2 MB), but the
pathway's boxes, the step cards and the gallery's filmstrip show it a few hundred pixels wide. The asset route
(main.py) hands out a copy of a set width instead when the page asks for one (``?w=640``): made the first time
it is asked for, kept in a ``.thumbs`` folder beside the image (so it goes when its run or project does), and made
again when the image is newer. Downloads, project files and close-ups keep the screenshots themselves.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from PIL import Image

#: The widths the page can ask for: a few, so each screenshot has at most this many copies.
WIDTHS = (320, 640, 1280)
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
FOLDER = ".thumbs"
# WebP of screenshots: about 25 KB at 640 wide, made in about 10 ms (method 2 is close to the smallest for a
# fraction of the time).
_QUALITY = 80
_METHOD = 2


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_SUFFIXES


def thumbnail(path: Path, width: int) -> Path:
    """The copy of the image at ``path`` ``width`` pixels wide (one of WIDTHS), made now if it is missing or older
    than the image; the image itself when it is no wider than that."""
    if width not in WIDTHS:
        raise ValueError(f"width must be one of {WIDTHS}")
    target = path.parent / FOLDER / f"{path.stem}.w{width}.webp"
    source_time = path.stat().st_mtime
    try:
        if target.stat().st_mtime >= source_time:
            return target
    except FileNotFoundError:
        pass
    with Image.open(path) as image:
        if image.width <= width:
            return path
        image.draft("RGB", (width, width))  # lets JPEG decode at a smaller size; PNG ignores it
        clear = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
        copy = image.convert("RGBA" if clear else "RGB")
    height = max(1, round(copy.height * width / copy.width))
    copy = copy.resize((width, height), Image.Resampling.LANCZOS, reducing_gap=3.0)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Written beside and then moved into place: two requests making the same copy at once each finish whole.
    handle, temporary = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "wb") as out:
            copy.save(out, "WEBP", quality=_QUALITY, method=_METHOD)
        os.replace(temporary, target)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return target
