"""Visitor accounts: for people from elsewhere who try Stepthrough for a short while.

An account tagged ``visitor`` works as a shared account does (``accounts.User.is_shared``): the live changes
between its browsers, each browser's own undo, the confirmation before deleting a project, and a password that only
an administrator changes. It never has the shared tag as well, and is never an administrator
(``user_admin.account_tags``). On top of that, with the settings administrators choose (``server_settings.py``):

- Its projects are deleted ``visitor_keep_hours`` after they were made, each counted from when it was made. A
  project is a visitor's when every owner of it is a visitor account; one that a regular account also owns stays.
  Every page of such a project says when it goes, and offers the project file (``project_file.py``), which brings
  the work back in a new project, here or on another server.
- A video it uploads, also one inside a project file, is at most ``visitor_upload_mb`` large (or the server's own
  limit, when that is smaller).
- All it keeps at once, videos and screenshots together, is at most ``visitor_storage_mb``. It is checked when a
  video or a project file comes in; the screenshots of an analysis can take it a little over.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import server_settings
from .accounts import User
from .config import DEFAULT_MAX_UPLOAD_MB
from .repository import projects_owned_by, visitor_projects
from .storage import project_dir

MB = 1024 * 1024
# The server's own upload limit (STEPTHROUGH_MAX_UPLOAD_MB), set when it starts (main.py).
_server_upload_limit = DEFAULT_MAX_UPLOAD_MB * MB


def configure(server_upload_limit: int) -> None:
    global _server_upload_limit
    _server_upload_limit = server_upload_limit


def keep_hours() -> int:
    return int(server_settings.value("visitor_keep_hours"))


def deletes_at(created_at: str) -> str:
    """When a visitor's project made at ``created_at`` is deleted."""
    return (datetime.fromisoformat(created_at) + timedelta(hours=keep_hours())).isoformat()


def deadlines() -> dict[str, str]:
    """When each visitor's project is deleted, by project id."""
    return {project["id"]: deletes_at(project["created_at"]) for project in visitor_projects()}


def due(now: datetime) -> list[dict[str, Any]]:
    """The visitors' projects whose time is up."""
    return [project for project in visitor_projects() if datetime.fromisoformat(deletes_at(project["created_at"])) <= now]


def upload_limit(user: User) -> int:
    """The largest video this account may upload, in bytes."""
    limit = _server_upload_limit
    visitor_mb = server_settings.value("visitor_upload_mb") if user.is_visitor else None
    return min(limit, int(visitor_mb * MB)) if visitor_mb else limit


def _folder_size(path: Path) -> int:
    total = 0
    for folder, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(folder, name))
            except OSError:
                pass
    return total


def storage_used(user: User) -> int:
    """What this account keeps, in bytes: everything in the projects it owns."""
    return sum(_folder_size(project_dir(project["slug"], project["id"])) for project in projects_owned_by(user.id))


def storage_limit(user: User) -> int | None:
    """How much this account may keep at once, in bytes; None for no limit."""
    if not user.is_visitor:
        return None
    limit_mb = server_settings.value("visitor_storage_mb")
    return int(limit_mb * MB) if limit_mb else None


def room_left(user: User) -> int | None:
    """How much more this account may keep, in bytes; None for no limit."""
    limit = storage_limit(user)
    return None if limit is None else max(0, limit - storage_used(user))


def full_message(user: User, needed: int) -> str:
    limit = storage_limit(user) or 0
    used = storage_used(user)
    left = max(0, limit - used)
    return f"This does not fit: {needed // MB} MB, and this account has {left // MB} MB of {limit // MB} MB left."


def limits(user: User) -> dict[str, Any]:
    """What the app shows a visitor about their account (``/me``)."""
    if not user.is_visitor:
        return {}
    limit = storage_limit(user)
    return {
        "keep_hours": keep_hours(),
        "upload_limit_bytes": upload_limit(user),
        "storage_limit_bytes": limit,
        "storage_used_bytes": storage_used(user) if limit is not None else None,
    }
