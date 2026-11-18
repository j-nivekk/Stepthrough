"""The routes of ``app/usage.py``, ``app/traffic.py`` and ``app/progress.py``: browsers report a few things about
themselves; administrators read the reports for a period (``app/report_window.py``) and, if they like, for one class
(a tag)."""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from . import progress, server_settings, traffic, usage
from .accounts import CurrentUser, require_admin
from .report_window import Window, WindowError, make_window, parse_moment
from .repository import first_traffic_hour, first_usage_event

router = APIRouter()


class ClientEvents(BaseModel):
    events: list[dict[str, Any]] = Field(max_length=50)


@router.post("/me/usage", status_code=204)
def usage_from_browser(payload: ClientEvents, user: CurrentUser) -> Response:
    """What a browser reports about itself: pages opened, the pathway tutorial, figures downloaded."""
    for raw in payload.events:
        if isinstance(raw, dict) and (event := usage.clean_client_event(raw)):
            usage.record(event[0], user, **event[1])
    return Response(status_code=204)


def _window(what: str, earliest: Any, days: int | None, start: date | None, end: date | None, tz: int) -> Window:
    keep = server_settings.keep_days()
    if keep == 0:
        raise HTTPException(status_code=409, detail=f"{what} is not recorded: it is kept for 0 days (under server).")
    try:
        return make_window(
            days=days, start=start, end=end, tz_minutes=tz, keep_days=keep, earliest=lambda: parse_moment(earliest())
        )
    except WindowError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None


@router.get("/admin/usage")
def usage_report(
    user: CurrentUser,
    days: int | None = None,
    start: date | None = None,
    end: date | None = None,
    tz: int = 0,
    tag: str | None = None,
    long: bool = False,
) -> dict[str, Any]:
    """The last ``days`` days (0: everything kept), or ``start`` to ``end``, in local time ``tz`` minutes east of
    UTC; only accounts tagged ``tag``, when given; ``long`` adds a row per account, day and measure."""
    require_admin(user)
    window = _window("Usage", first_usage_event, days, start, end, tz)
    return {**usage.report(window, tag or None, long), "keep_days": server_settings.keep_days()}


@router.get("/admin/traffic")
def traffic_report(
    user: CurrentUser,
    days: int | None = None,
    start: date | None = None,
    end: date | None = None,
    tz: int = 0,
    tag: str | None = None,
) -> dict[str, Any]:
    """Bytes in and out per kind, account, hour of the day and day, for a period as for the usage report."""
    require_admin(user)
    window = _window("Traffic", first_traffic_hour, days, start, end, tz)
    return {**traffic.report(window, tag or None), "keep_days": server_settings.keep_days()}


@router.get("/admin/progress")
def progress_report(user: CurrentUser, tag: str | None = None) -> dict[str, Any]:
    """How far each account has got with its projects, read from the projects (not affected by the keeping time)."""
    require_admin(user)
    return progress.report(tag or None)
