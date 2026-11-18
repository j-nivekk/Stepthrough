"""The routes of ``app/usage.py``: browsers report a few things about themselves, administrators read the report."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from . import server_settings, traffic, usage
from .accounts import CurrentUser, require_admin

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


@router.get("/admin/usage")
def usage_report(user: CurrentUser, days: int = 7, tz: int = 0) -> dict[str, Any]:
    """The report of the last ``days`` days, in local time ``tz`` minutes east of UTC."""
    require_admin(user)
    keep = server_settings.value("usage_keep_days")
    if keep <= 0:
        raise HTTPException(status_code=409, detail="Usage is not recorded: it is kept for 0 days (under server).")
    if not -14 * 60 <= tz <= 14 * 60:
        raise HTTPException(status_code=422, detail="tz is the minutes east of UTC, from -840 to 840.")
    return {**usage.report(max(1, min(days, keep)), tz), "keep_days": keep}


@router.get("/admin/traffic")
def traffic_report(user: CurrentUser, days: int = 7, tz: int = 0) -> dict[str, Any]:
    """Bytes in and out of the last ``days`` days, per kind, account, hour of the day and day, in local time."""
    require_admin(user)
    keep = server_settings.value("usage_keep_days")
    if keep <= 0:
        raise HTTPException(status_code=409, detail="Traffic is not recorded: it is kept for 0 days (under server).")
    if not -14 * 60 <= tz <= 14 * 60:
        raise HTTPException(status_code=422, detail="tz is the minutes east of UTC, from -840 to 840.")
    return {**traffic.report(max(1, min(days, keep)), tz), "keep_days": keep}
