"""Removing exports that a newer one of the same task has replaced.

An export is a folder and a zip of it under the task's ``exports/``, both named by the export's id, made from the
task as it is at that moment; it can be made again at any time. The app shows and offers each task's latest export
only, so the others are removed: their record once it is ``EXPORT_GRACE`` old (a shared account keeps every export
that long, for whoever is still downloading theirs), and then the folder and zip that no record points to. Files
younger than ``EXPORT_GRACE`` stay, as they may belong to an export that is still being written.
"""

from __future__ import annotations

import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import storage
from .repository import export_bundle_ids, forget_replaced_export_bundles

EXPORT_GRACE = timedelta(minutes=10)
_EXPORT_NAME = re.compile(r"[0-9a-f]{32}")


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def clear_old_exports(run_id: str | None = None, exports_dir: Path | None = None) -> tuple[int, int]:
    """Remove the replaced exports of one task (``run_id`` and its ``exports_dir``) or, without them, of all tasks.
    Returns how many exports were removed from the disk and how many bytes that freed."""
    cutoff = datetime.now(timezone.utc) - EXPORT_GRACE
    forget_replaced_export_bundles(cutoff.isoformat(), run_id)
    known = export_bundle_ids(run_id)
    if exports_dir is not None:
        folders = [exports_dir]
    else:
        folders = list(storage.DATA_ROOT.glob("projects/*/recordings/*/runs/*/exports"))
    removed: set[tuple[Path, str]] = set()
    freed = 0
    for folder in folders:
        if not folder.is_dir():
            continue
        for entry in folder.iterdir():
            export_id = entry.name.removesuffix(".zip") if entry.suffix == ".zip" else entry.name
            if not _EXPORT_NAME.fullmatch(export_id) or export_id in known:
                continue
            try:
                if entry.stat().st_mtime > cutoff.timestamp():
                    continue
                size = _size(entry)
                if entry.is_dir():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()
            except FileNotFoundError:
                continue
            freed += size
            removed.add((folder, export_id))
    return len(removed), freed
