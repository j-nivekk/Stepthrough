"""Write a consistent copy of the database while the app keeps running.

    python -m app.backup                  # into <data root>/backups/
    python -m app.backup /some/folder     # or a folder of your choice

Copying `stepthrough.sqlite3` directly can miss recent writes, which may still sit in the `-wal` file next to it.
Recordings, screenshots and exports are plain files under `<data root>/projects/` and can be copied as they are.
"""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from .config import DATA_ROOT, DB_PATH


def backup_database(destination_dir: Path) -> Path:
    if not DB_PATH.exists():
        raise FileNotFoundError(f"No database at {DB_PATH}")
    destination_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    destination = destination_dir / f"stepthrough-{stamp}.sqlite3"
    source = sqlite3.connect(DB_PATH)
    target = sqlite3.connect(destination)
    try:
        with target:
            source.backup(target)
    finally:
        target.close()
        source.close()
    return destination


def main(argv: list[str]) -> int:
    destination_dir = Path(argv[0]).expanduser().resolve() if argv else DATA_ROOT / "backups"
    print(backup_database(destination_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
