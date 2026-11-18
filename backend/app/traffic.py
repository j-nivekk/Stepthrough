"""How much goes in and out of the server, per account and hour, by kind: for administrators watching the load (admin
panel, **traffic**).

Every request is counted where it enters the app, outside everything else: the bytes it brings (a video upload,
the data of a change) and the bytes its answer sends, as they go over the network (after compression). It is put
down to the account logged in (``current_user`` notes it), administrators included, or to nobody before a login.
Kept, like the usage report, on a server with logins for ``usage_keep_days`` days, as totals per hour: no single
request, address or file is stored.
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict, defaultdict
from http.cookies import CookieError, SimpleCookie
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .report_window import Window
from .repository import add_traffic, delete_traffic_before, list_traffic, list_usage_accounts

# In the order the report shows them.
CATEGORIES = ("uploads", "media", "exports", "live", "data", "app")
FLUSH_SECONDS = 10
ACCOUNT_KEY = "traffic_account"  # where current_user leaves the account in the request's state
REMEMBERED_SESSIONS = 20_000


def category(path: str) -> str:
    """What kind of traffic a request is, from its path."""
    if path == "/recordings/import":
        return "uploads"
    if path.startswith("/assets/projects/"):
        return "media"  # videos and screenshots
    if path.startswith("/exports/"):
        return "exports"
    if path == "/me/live":
        return "live"
    if path == "/" or path.startswith("/assets/") or "." in path.rsplit("/", 1)[-1]:
        return "app"  # the app's own page, scripts, styles, fonts and icons
    return "data"


class _Counts:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pending: dict[tuple[str, str, str], list[int]] = defaultdict(lambda: [0, 0, 0])
        self.last_flush = time.monotonic()


_counts = _Counts()
_enabled: Callable[[], bool] = lambda: False  # noqa: E731 - set by configure()
_cookie_name = "stepthrough_session"
# Which account a session belongs to (keyed by a hash of its token, in memory only), so that requests that do not
# check the login themselves, such as the app's own scripts, still count for the account whose browser asks.
_sessions: OrderedDict[str, str] = OrderedDict()
_sessions_lock = threading.Lock()


def configure(enabled: Callable[[], bool], cookie_name: str) -> None:
    global _enabled, _cookie_name
    _enabled = enabled
    _cookie_name = cookie_name


def _session_key(token: str) -> str:
    return hashlib.sha256(f"stepthrough-traffic:{token}".encode()).hexdigest()[:24]


def remember(token: str | None, account_id: str) -> None:
    if not token:
        return
    key = _session_key(token)
    with _sessions_lock:
        _sessions[key] = account_id
        _sessions.move_to_end(key)
        while len(_sessions) > REMEMBERED_SESSIONS:
            _sessions.popitem(last=False)


def _account_from_cookie(scope: Scope) -> str | None:
    for name, value in scope.get("headers") or ():
        if name == b"cookie":
            try:
                morsel = SimpleCookie(value.decode("latin-1")).get(_cookie_name)
            except CookieError:
                return None
            if morsel is None:
                return None
            with _sessions_lock:
                return _sessions.get(_session_key(morsel.value))
    return None


def note(account_id: str | None, kind: str, bytes_in: int, bytes_out: int) -> None:
    hour = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0).isoformat()
    with _counts.lock:
        counts = _counts.pending[(hour, account_id or "", kind)]
        counts[0] += 1
        counts[1] += bytes_in
        counts[2] += bytes_out
        due = time.monotonic() - _counts.last_flush >= FLUSH_SECONDS
    if due:
        flush()


def flush() -> None:
    with _counts.lock:
        pending, _counts.pending = _counts.pending, defaultdict(lambda: [0, 0, 0])
        _counts.last_flush = time.monotonic()
    if pending:
        add_traffic([(hour, account, kind, *counts) for (hour, account, kind), counts in pending.items()])


def purge(keep_days: int | None) -> int:
    """Delete what is older than the keeping time (everything, with 0; nothing, with None: kept for ever)."""
    flush()
    if keep_days is None:
        return 0
    return delete_traffic_before((datetime.now(timezone.utc) - timedelta(days=keep_days)).isoformat())


class TrafficMiddleware:
    def __init__(self, app: ASGIApp, enabled: Callable[[], bool]) -> None:
        self.app = app
        self.enabled = enabled

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self.enabled():
            await self.app(scope, receive, send)
            return
        received = 0
        sent = 0

        async def counting_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
            return message

        async def counting_send(message: Message) -> None:
            nonlocal sent
            if message["type"] == "http.response.body":
                sent += len(message.get("body", b""))
            await send(message)

        try:
            await self.app(scope, counting_receive, counting_send)
        finally:
            try:
                account = (scope.get("state") or {}).get(ACCOUNT_KEY) or _account_from_cookie(scope)
                note(account, category(scope["path"]), received, sent)
            except Exception:  # pragma: no cover - counting is never worth an error
                pass


def report(window: Window, tag: str | None = None) -> dict[str, Any]:
    """Everything in ``window``, in the reader's local time; only the accounts with ``tag``, when given (requests
    before a login then count for no one in the report)."""
    flush()
    names = list_usage_accounts()
    only = None if not tag else {account_id for account_id, info in names.items() if tag in info.get("tags", ())}
    since = window.since.replace(minute=0, second=0, microsecond=0)  # the hour it falls in

    totals = {"bytes_in": 0, "bytes_out": 0, "requests": 0}
    kinds = {kind: {"category": kind, "bytes_in": 0, "bytes_out": 0, "requests": 0} for kind in CATEGORIES}
    accounts: dict[str, dict[str, Any]] = {}
    hours = [{"hour": hour, "bytes_in": 0, "bytes_out": 0} for hour in range(24)]
    days_list = {date: {"date": date, "bytes_in": 0, "bytes_out": 0, "requests": 0} for date in window.dates()}
    busiest: dict[str, int] = defaultdict(int)

    for row in list_traffic(since.isoformat(), window.until.isoformat()):
        at = window.local(datetime.fromisoformat(row["hour"]))
        account_id = row["account_id"] or None
        if only is not None and account_id not in only:
            continue
        bytes_in, bytes_out, requests = row["bytes_in"], row["bytes_out"], row["requests"]
        for target in (totals, kinds.setdefault(row["category"], {"category": row["category"], "bytes_in": 0, "bytes_out": 0, "requests": 0})):
            target["bytes_in"] += bytes_in
            target["bytes_out"] += bytes_out
            target["requests"] += requests
        info = names.get(account_id or "", {"name": "a deleted account", "shared": False, "admin": False})
        entry = accounts.setdefault(account_id or "", {
            "id": account_id,
            "name": info["name"] if account_id else "not logged in",
            "shared": bool(account_id) and info["shared"],
            "admin": bool(account_id) and info.get("admin", False),
            "bytes_in": 0, "bytes_out": 0, "requests": 0,
            "categories": {kind: 0 for kind in CATEGORIES},
        })
        entry["bytes_in"] += bytes_in
        entry["bytes_out"] += bytes_out
        entry["requests"] += requests
        entry["categories"][row["category"]] = entry["categories"].get(row["category"], 0) + bytes_in + bytes_out
        hours[at.hour]["bytes_in"] += bytes_in
        hours[at.hour]["bytes_out"] += bytes_out
        day = days_list.get(at.date().isoformat())
        if day is not None:
            day["bytes_in"] += bytes_in
            day["bytes_out"] += bytes_out
            day["requests"] += requests
        busiest[at.replace(minute=0).isoformat(timespec="minutes")] += bytes_in + bytes_out

    peak = max(busiest.items(), key=lambda item: item[1]) if busiest else None
    return {
        **window.describe(),
        "tag": tag,
        "totals": totals,
        "busiest_hour": {"start": peak[0][:16], "bytes": peak[1]} if peak else None,
        "categories": list(kinds.values()),
        "accounts": sorted(accounts.values(), key=lambda entry: -(entry["bytes_in"] + entry["bytes_out"])),
        "hours": hours,
        "days_list": list(days_list.values()),
    }
