from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(value: str) -> str:
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug or "item"


def sanitize_filename(filename: str) -> str:
    path = Path(filename)
    stem = _SLUG_RE.sub("-", path.stem.lower()).strip("-") or "recording"
    suffix = path.suffix.lower() or ".mp4"
    return f"{stem}{suffix}"


def timecode_from_ms(value: int, slug_style: bool = False) -> str:
    total_ms = max(0, int(value))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1_000)
    if slug_style:
        return f"{hours:02d}-{minutes:02d}-{seconds:02d}-{milliseconds:03d}"
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(value, maximum))
