"""The period a usage, traffic or progress report covers, in the reader's local time.

A report covers the last so many days (whole days, today the last of them), everything still kept, or the days from
one date to another (both included). Days start at midnight in the reader's time zone, which the browser sends as minutes east of UTC.
Nothing reaches back further than the keeping time (``usage_keep_days``): older records are gone already.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable

MAX_DAYS = 3650


class WindowError(ValueError):
    """A period that cannot be reported, with a message for the reader."""


@dataclass(frozen=True)
class Window:
    since: datetime  # UTC, included
    until: datetime  # UTC, not included
    shift: timedelta  # local time is UTC plus this

    def local(self, moment: datetime) -> datetime:
        return moment + self.shift

    def dates(self) -> list[str]:
        """Every local date the period touches, oldest first."""
        first = self.local(self.since).date()
        last = self.local(max(self.since, self.until - timedelta(microseconds=1))).date()
        return [(first + timedelta(days=offset)).isoformat() for offset in range((last - first).days + 1)]

    def describe(self) -> dict[str, str | int]:
        dates = self.dates()
        return {
            "since": self.since.isoformat(),
            "until": self.until.isoformat(),
            "start": dates[0],
            "end": dates[-1],
            "days": len(dates),
        }


def make_window(
    *,
    days: int | None,
    start: date | None,
    end: date | None,
    tz_minutes: int,
    keep_days: int | None,
    earliest: Callable[[], datetime | None],
    now: datetime | None = None,
) -> Window:
    """``days``: the last so many days (0: everything kept); or ``start`` to ``end`` (local dates, both included;
    ``end`` defaults to today). ``keep_days`` None keeps everything; ``earliest`` finds the oldest record kept."""
    if not -14 * 60 <= tz_minutes <= 14 * 60:
        raise WindowError("tz is the minutes east of UTC, from -840 to 840.")
    now = now or datetime.now(timezone.utc)
    shift = timedelta(minutes=tz_minutes)
    floor = now - timedelta(days=keep_days) if keep_days is not None else None
    until = now
    if start is not None:
        last = end or (now + shift).date()
        if last < start:
            raise WindowError("The period ends before it starts.")
        if (last - start).days >= MAX_DAYS:
            raise WindowError(f"A period is at most {MAX_DAYS} days.")
        since = datetime.combine(start, time.min, tzinfo=timezone.utc) - shift
        until = min(now, datetime.combine(last + timedelta(days=1), time.min, tzinfo=timezone.utc) - shift)
    elif days == 0:
        since = earliest() or floor or now
    else:
        wanted = days if days is not None else 7
        if not 1 <= wanted <= MAX_DAYS:
            raise WindowError(f"days is from 1 to {MAX_DAYS}, or 0 for everything kept.")
        # whole local days, today the last of them
        first = (now + shift).date() - timedelta(days=wanted - 1)
        since = datetime.combine(first, time.min, tzinfo=timezone.utc) - shift
    if floor is not None and since < floor:
        since = floor
    return Window(since=min(since, until), until=until, shift=shift)


def parse_moment(text: str | None) -> datetime | None:
    if not text:
        return None
    moment = datetime.fromisoformat(text)
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
