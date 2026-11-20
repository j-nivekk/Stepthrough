"""Settings an administrator changes while the server runs, in the admin panel under **server**.

Each starts as the server's configuration has it (``app/config.py``, from environment variables) and is stored in the
database once an administrator changes it, so it outlasts restarts. Changes take effect at once:

- ``analyses_at_a_time``: how many analyses run together (0: no limit); the rest wait their turn. Analyses share
  the server's one process, so more than two or three mostly slows everything else down.
- ``compression``: send JSON, pages, scripts and styles compressed (``app/compression.py``).
- ``live_spread_seconds``: in shared accounts, browsers showing a task reload it after a change at a random moment
  within this many seconds (after a short pause), so that they do not all ask at once.
- ``usage_keep_days``: how many days usage and traffic are kept (``app/usage.py``, ``app/traffic.py``); 0 records
  nothing, null keeps them for ever.
- ``visitor_keep_hours``: how long the projects of visitor accounts are kept, counted from when each was made
  (``app/visitors.py``).
- ``visitor_upload_mb``: the largest video a visitor account may upload; null: the server's own limit.
- ``visitor_storage_mb``: how much a visitor account may keep at once, videos and screenshots together; null: no
  limit.
- ``visitor_account_days``: the deletion date an account gets, so many days on, when it is given the visitor tag
  without one; null: none.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from . import traffic, usage
from .report_window import MAX_DAYS
from .accounts import CurrentUser, require_admin
from .repository import get_server_settings, set_server_settings

DEFAULT_LIVE_SPREAD_SECONDS = 1.5
DEFAULT_USAGE_KEEP_DAYS = 14
DEFAULT_VISITOR_KEEP_HOURS = 72
DEFAULT_VISITOR_UPLOAD_MB = 500
DEFAULT_VISITOR_STORAGE_MB = 2000
DEFAULT_VISITOR_ACCOUNT_DAYS = 14
# Settings that may be null on purpose (sent as null, unlike one left out, which stays as it is).
NULLABLE = {"usage_keep_days", "visitor_upload_mb", "visitor_storage_mb", "visitor_account_days"}

_changed: dict[str, Any] = {}
_configured_analyses: int | None = None


def defaults() -> dict[str, Any]:
    return {
        "analyses_at_a_time": _configured_analyses or 0,
        "compression": True,
        "live_spread_seconds": DEFAULT_LIVE_SPREAD_SECONDS,
        "usage_keep_days": DEFAULT_USAGE_KEEP_DAYS,
        "visitor_keep_hours": DEFAULT_VISITOR_KEEP_HOURS,
        "visitor_upload_mb": DEFAULT_VISITOR_UPLOAD_MB,
        "visitor_storage_mb": DEFAULT_VISITOR_STORAGE_MB,
        "visitor_account_days": DEFAULT_VISITOR_ACCOUNT_DAYS,
    }


def load(configured_analyses: int | None) -> None:
    """Read what administrators changed; at startup, and after a factory reset. ``configured_analyses`` is the
    configuration's limit (``STEPTHROUGH_MAX_CONCURRENT_RUNS``)."""
    global _configured_analyses
    _configured_analyses = configured_analyses
    _changed.clear()
    known = defaults()
    for key, raw in get_server_settings().items():
        if key in known:
            _changed[key] = json.loads(raw)


def value(key: str) -> Any:
    return _changed.get(key, defaults()[key])


def analyses_limit() -> int | None:
    """The limit for the job manager: None for no limit."""
    return value("analyses_at_a_time") or None


def compression_enabled() -> bool:
    return bool(value("compression"))


def keep_days() -> int | None:
    """How many days usage and traffic are kept: 0 records nothing, None keeps them for ever."""
    return value("usage_keep_days")


class ServerSettingsUpdate(BaseModel):
    analyses_at_a_time: int | None = Field(default=None, ge=0, le=64)
    compression: bool | None = None
    live_spread_seconds: float | None = Field(default=None, ge=0, le=10)
    usage_keep_days: int | None = Field(default=None, ge=0, le=MAX_DAYS)  # null: for ever
    visitor_keep_hours: int | None = Field(default=None, ge=1, le=24 * 365)
    visitor_upload_mb: int | None = Field(default=None, ge=1, le=1_000_000)  # null: the server's limit
    visitor_storage_mb: int | None = Field(default=None, ge=1, le=10_000_000)  # null: no limit
    visitor_account_days: int | None = Field(default=None, ge=1, le=3650)  # null: no date


def _describe() -> dict[str, dict[str, Any]]:
    return {key: {"value": value(key), "default": default} for key, default in defaults().items()}


router = APIRouter()


@router.get("/admin/server-settings")
def read_server_settings(user: CurrentUser) -> dict[str, dict[str, Any]]:
    require_admin(user)
    return _describe()


@router.patch("/admin/server-settings")
def change_server_settings(payload: ServerSettingsUpdate, request: Request, user: CurrentUser) -> dict[str, dict[str, Any]]:
    require_admin(user)
    known = defaults()
    sent = payload.model_dump(exclude_unset=True)
    changes = {key: new for key, new in sent.items() if new is not None or key in NULLABLE}
    # A value equal to the configuration's is not stored, so a later change of the configuration applies again.
    set_server_settings({key: None if new == known[key] else json.dumps(new) for key, new in changes.items()})
    load(_configured_analyses)
    if "analyses_at_a_time" in changes:
        request.app.state.job_manager.set_max_concurrent_runs(analyses_limit())
    if "usage_keep_days" in changes:
        usage.purge(keep_days())  # a shorter time applies to what is kept already
        traffic.purge(keep_days())
    return _describe()
