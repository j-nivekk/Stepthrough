"""Visitor accounts: for people from elsewhere who try Stepthrough for a short while.

An account tagged ``visitor`` works as a shared account does (``accounts.User.is_shared``): the live changes
between its browsers, each browser's own undo, the confirmation before deleting a project, and a password that only
an administrator changes. It never has the shared tag as well, and is never an administrator
(``user_admin.account_tags``). On top of that, with the settings administrators choose (``server_settings.py``):

- Its projects are deleted ``visitor_keep_hours`` after they were made, each counted from when it was made, or
  later when an administrator gave one more time (``keep_until``, from the list of visitor projects in the admin
  panel). A project is a visitor's when every owner of it is a visitor account; one that a regular account also
  owns stays.
  Every page of such a project says when it goes, and offers the project file (``project_file.py``), which brings
  the work back in a new project, here or on another server.
- A video it uploads, also one inside a project file, is at most ``visitor_upload_mb`` large (or the server's own
  limit, when that is smaller).
- All it keeps at once, videos and screenshots together, is at most ``visitor_storage_mb``. It is checked when a
  video or a project file comes in; the screenshots of an analysis can take it a little over.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from . import server_settings
from .accounts import User
from .config import DEFAULT_MAX_PROJECT_FILE_MB, DEFAULT_MAX_UPLOAD_MB
from .repository import projects_owned_by, set_project_keep_until, visitor_projects
from .storage import project_dir

MB = 1024 * 1024
# The server's own limits (STEPTHROUGH_MAX_UPLOAD_MB and STEPTHROUGH_MAX_PROJECT_FILE_MB), set when it starts (main.py).
_server_upload_limit = DEFAULT_MAX_UPLOAD_MB * MB
_server_project_file_limit = DEFAULT_MAX_PROJECT_FILE_MB * MB


def configure(server_upload_limit: int, server_project_file_limit: int | None = None) -> None:
    global _server_upload_limit, _server_project_file_limit
    _server_upload_limit = server_upload_limit
    _server_project_file_limit = max(server_upload_limit, server_project_file_limit or _server_project_file_limit)


def project_file_limit() -> int:
    """The largest project file the server takes in, in bytes (for everyone; a visitor's room applies as well)."""
    return _server_project_file_limit


def project_file_too_large() -> str:
    return f"This project file is larger than the {_server_project_file_limit // MB} MB this server takes in at once."


def account_deletion_date(today: date | None = None) -> str | None:
    """The deletion date a new visitor account gets when it has none (``visitor_account_days`` on), or None."""
    days = server_settings.value("visitor_account_days")
    return ((today or date.today()) + timedelta(days=int(days))).isoformat() if days else None


def keep_hours() -> int:
    return int(server_settings.value("visitor_keep_hours"))


def deletes_at(created_at: str, keep_until: str | None = None) -> str:
    """When a visitor's project made at ``created_at`` is deleted: after the keeping time, or at ``keep_until`` when
    an administrator gave it more time."""
    due_at = datetime.fromisoformat(created_at) + timedelta(hours=keep_hours())
    if keep_until:
        due_at = max(due_at, datetime.fromisoformat(keep_until))
    return due_at.isoformat()


def _deletes_at(project: dict[str, Any]) -> str:
    return deletes_at(project["created_at"], project.get("keep_until"))


def deadlines() -> dict[str, str]:
    """When each visitor's project is deleted, by project id."""
    return {project["id"]: _deletes_at(project) for project in visitor_projects()}


def due(now: datetime) -> list[dict[str, Any]]:
    """The visitors' projects whose time is up."""
    return [project for project in visitor_projects() if datetime.fromisoformat(_deletes_at(project)) <= now]


def overview() -> list[dict[str, Any]]:
    """Every visitor's project for the administrators, the one deleted first first."""
    rows = [
        {"id": project["id"], "name": project["name"], "owners": project.get("owners") or "", "created_at": project["created_at"], "deletes_at": _deletes_at(project)}
        for project in visitor_projects()
    ]
    return sorted(rows, key=lambda row: row["deletes_at"])


def extend(project_id: str, hours: int, now: datetime) -> str | None:
    """Give a visitor's project ``hours`` more, counted from when it would be deleted (or from now, when that has
    passed already). Returns the new deletion time, or None when it is not a visitor's project."""
    project = next((item for item in visitor_projects() if item["id"] == project_id), None)
    if project is None:
        return None
    start = max(datetime.fromisoformat(_deletes_at(project)), now)
    keep_until = (start + timedelta(hours=hours)).isoformat()
    set_project_keep_until(project_id, keep_until)
    return keep_until


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
