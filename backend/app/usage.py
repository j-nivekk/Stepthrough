"""How Stepthrough is used, for the people who teach with it: when people work, how many, what they do and how far
they get with the pathway tutorial. Administrators read it in the admin panel under **usage**.

What is recorded, and what is not:

- Only on a server with logins, and only for accounts that are not administrators (staff showing the app do not
  count). Stepthrough on one's own computer records nothing.
- Each event has its time, the account, a browser key and what happened (an analysis's length, a lesson's number),
  never names of people, addresses, file names or anything written in the app. The browser key is derived from the
  login's session, so the people working under one shared account can be counted apart without being identified;
  it changes when they log in again.
- Being in the app is kept in five-minute slots: ``open`` for any request, ``working`` for a change.
- Events are kept ``usage_keep_days`` days (14 unless an administrator changes it under **server**; 0 records
  nothing, null keeps them for ever), then deleted every hour.

Events are queued in memory and written in batches, so recording costs a request nothing noticeable.
"""

from __future__ import annotations

import hashlib
import json
import statistics
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .report_window import Window
from .repository import delete_usage_before, insert_usage_events, list_usage_accounts, list_usage_events

SLOT_MINUTES = 5
FLUSH_SECONDS = 10
FLUSH_EVENTS = 200
TUTORIAL_LESSONS = 7

PAGES = {"projects", "import", "analysis", "review", "pathway"}
# Time in the app goes to the stage of the page open: the step review is part of the analysis page.
STAGE_OF_PAGE = {"projects": "projects", "import": "import", "analysis": "analysis", "review": "analysis", "pathway": "pathway"}
STAGES = ("projects", "import", "analysis", "pathway")
TUTORIAL_FROM = {"invitation", "pathway", "about"}
FIGURE_FORMATS = {"svg", "png"}
GUIDE_FROM = {"tutorial", "about"}  # the guide links in the pathway tutorial and in how it works

# What a browser may report about itself, and the details each may carry (validated, the rest dropped).
CLIENT_EVENTS: dict[str, dict[str, Any]] = {
    "page": {"name": PAGES},
    "tutorial_invited": {},
    "tutorial_opened": {"from": TUTORIAL_FROM},
    "tutorial_lesson": {"lesson": range(1, TUTORIAL_LESSONS + 1)},
    "tutorial_solved": {"lesson": range(1, TUTORIAL_LESSONS + 1)},
    "tutorial_show_me": {"lesson": range(1, TUTORIAL_LESSONS + 1)},
    "tutorial_closed": {"solved": range(0, TUTORIAL_LESSONS + 1), "minutes": range(0, 600)},
    "figure_downloaded": {"format": FIGURE_FORMATS},  # sent by browsers before 1.3; now by the server
    "comparison_opened": {},
    "boxes_switched": {"to": {"screens", "steps"}},
    "guide_opened": {"from": GUIDE_FROM},
}


def browser_key(token_hash: str) -> str:
    """A key for one login in one browser, from its session; it cannot be used to find or use the session."""
    return hashlib.sha256(f"stepthrough-usage:{token_hash}".encode()).hexdigest()[:16]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _slot(moment: datetime) -> datetime:
    return moment.replace(minute=moment.minute - moment.minute % SLOT_MINUTES, second=0, microsecond=0)


class _Log:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.queue: list[tuple[str, str | None, str | None, str, str | None]] = []
        self.seen: set[tuple[str, str, str]] = set()
        self.seen_slot: datetime | None = None
        self.last_flush = time.monotonic()
        self.runs: dict[str, tuple[str, str | None]] = {}  # analysis -> who started it


_log = _Log()
_enabled: Callable[[], bool] = lambda: False  # noqa: E731 - set by configure()


def configure(enabled: Callable[[], bool]) -> None:
    """Whether to record at all (a server with logins, and a keeping time above zero); asked at every event."""
    global _enabled
    _enabled = enabled


def _counts(user: Any) -> bool:
    return user is not None and not getattr(user, "is_admin", True) and _enabled()


def counts(user: Any) -> bool:
    """Whether what this user does is recorded: on a server with logins, while usage is kept, not administrators."""
    return _counts(user)


def _add(kind: str, account_id: str | None, browser: str | None, detail: dict[str, Any] | None, at: datetime) -> None:
    row = (at.isoformat(), account_id, browser, kind, json.dumps(detail, separators=(",", ":")) if detail else None)
    with _log.lock:
        _log.queue.append(row)
        due = len(_log.queue) >= FLUSH_EVENTS or time.monotonic() - _log.last_flush >= FLUSH_SECONDS
    if due:
        flush()


def record(kind: str, user: Any, **detail: Any) -> None:
    """Something a person did (``user`` is the logged-in User). Never fails the request it is part of."""
    try:
        if _counts(user):
            _add(kind, user.id, getattr(user, "browser", None), detail or None, _now())
    except Exception:  # pragma: no cover - usage is never worth an error
        pass


def record_login_failure() -> None:
    try:
        if _enabled():
            _add("login_failed", None, None, None, _now())
    except Exception:  # pragma: no cover
        pass


def note_activity(user: Any, working: bool) -> None:
    """A request from a logged-in browser: at most one ``open`` (and one ``working``) per five-minute slot."""
    try:
        if not _counts(user) or not getattr(user, "browser", None):
            return
        slot = _slot(_now())
        kinds = ("open", "working") if working else ("open",)
        fresh = []
        with _log.lock:
            if _log.seen_slot != slot:
                _log.seen = set()
                _log.seen_slot = slot
            for kind in kinds:
                key = (user.browser, kind, slot.isoformat())
                if key not in _log.seen:
                    _log.seen.add(key)
                    fresh.append(kind)
        for kind in fresh:
            _add(kind, user.id, user.browser, None, slot)
    except Exception:  # pragma: no cover
        pass


def analysis_started(run_id: str, user: Any) -> None:
    if _counts(user):
        with _log.lock:
            _log.runs[run_id] = (user.id, getattr(user, "browser", None))
        record("analysis_started", user)


def analysis_finished(run_id: str, run: dict[str, Any] | None) -> None:
    """At the end of an analysis, whoever started it: how it ended, how long it waited and took, steps found."""
    try:
        with _log.lock:
            started_by = _log.runs.pop(run_id, None)
        if started_by is None or run is None or not _enabled():
            return

        def seconds(start: str | None, end: str | None) -> int | None:
            if not start or not end:
                return None
            return max(0, round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()))

        detail = {
            "status": run.get("status"),
            "waited": seconds(run.get("created_at"), run.get("started_at")),
            "took": seconds(run.get("started_at"), run.get("completed_at")),
            "steps": run.get("candidate_count"),
        }
        _add("analysis_finished", started_by[0], started_by[1], detail, _now())
    except Exception:  # pragma: no cover
        pass


def flush() -> None:
    with _log.lock:
        rows, _log.queue = _log.queue, []
        _log.last_flush = time.monotonic()
    if rows:
        insert_usage_events(rows)


def purge(keep_days: int | None) -> int:
    """Delete what is older than the keeping time (everything, with 0; nothing, with None: kept for ever)."""
    flush()
    if keep_days is None:
        return 0
    return delete_usage_before((_now() - timedelta(days=keep_days)).isoformat())


def clean_client_event(raw: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    kind = raw.get("kind")
    if not isinstance(kind, str) or kind not in CLIENT_EVENTS:
        return None
    detail = {}
    for key, allowed in CLIENT_EVENTS[kind].items():
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(allowed, range) and isinstance(value, (int, float)) and int(value) in allowed:
            detail[key] = int(value)
        elif isinstance(allowed, set) and value in allowed:
            detail[key] = value
    return kind, detail


# ── the report ──────────────────────────────────────────────────────────────────────────────────────────────────


def _median(values: list[int]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def accounts_tagged(names: dict[str, dict[str, Any]], tag: str | None) -> set[str] | None:
    """The accounts with ``tag``, for a report of one class; None for every account."""
    return None if not tag else {account_id for account_id, info in names.items() if tag in info.get("tags", ())}


# What the long table (``long=True``) counts per account and day; most events count once, slots their minutes.
LONG_MEASURES = {
    "open": "minutes in the app", "working": "minutes making changes", "login": "logins", "project_created": "projects",
    "recording_uploaded": "videos uploaded", "analysis_started": "analyses", "step_decided": "steps decided",
    "steps_decided": "steps decided", "step_annotated": "titles and notes", "step_added": "steps added",
    "screen_corrected": "pathway corrections", "screens_merged": "screens merged", "exported": "exports",
    "figure_downloaded": "pathway figures", "comparison_opened": "comparisons", "tutorial_opened": "tutorial opened",
}


def report(window: Window, tag: str | None = None, long: bool = False) -> dict[str, Any]:
    """Everything in ``window``, in the reader's local time; only the accounts with ``tag``, when given. ``long``
    adds a table of every account, day and measure (``LONG_MEASURES``), for analysis elsewhere."""
    flush()
    names = list_usage_accounts()
    only = accounts_tagged(names, tag)

    browsers: set[str] = set()
    accounts: dict[str, dict[str, Any]] = {}
    hour_open: dict[int, set] = defaultdict(set)
    hour_working: dict[int, set] = defaultdict(set)
    day: dict[str, dict[str, Any]] = {}
    totals: Counter = Counter()
    took: list[int] = []
    waited: list[int] = []
    pages: Counter = Counter()
    tutorial: dict[str, dict[str, Any]] = defaultdict(lambda: {"reached": set(), "solved": set(), "opened": False})
    tutorial_from: Counter = Counter()
    show_me: Counter = Counter()
    page_of: dict[str, str] = {}  # the stage each browser is at, from the last page it opened
    per_day: dict[tuple[str, str, str], float] = defaultdict(float)  # (account, date, measure) for the long table
    worked: dict[str, Counter] = defaultdict(Counter)  # minutes making changes, per account and local date
    invited: set[str] = set()
    closed_minutes: list[int] = []

    for date in window.dates():
        day[date] = {"date": date, "open": set(), "working": set(), "accounts": set(), "logins": 0, "analyses": 0, "decisions": 0}

    for row in list_usage_events(window.since.isoformat(), window.until.isoformat()):
        at = window.local(datetime.fromisoformat(row["at"]))
        kind, account_id, browser = row["kind"], row["account_id"], row["browser"]
        if only is not None and account_id not in only:
            continue
        detail = json.loads(row["detail"]) if row["detail"] else {}
        date = at.date().isoformat()
        today = day.get(date)
        if kind == "login_failed":
            totals["login_failures"] += 1
            continue
        if account_id is None:
            continue
        if browser:
            browsers.add(browser)
        info = names.get(account_id, {"name": "a deleted account", "shared": False})
        stats = accounts.setdefault(account_id, {
            "name": info["name"], "shared": info["shared"], "browsers": set(), "open_minutes": 0, "working_minutes": 0,
            "logins": 0, "projects": 0, "uploads": 0, "upload_minutes": 0.0, "analyses": 0, "analyses_failed": 0,
            "accepted": 0, "rejected": 0, "annotations": 0, "steps_added": 0, "carried_over": 0, "merges": 0,
            "exports": 0, "figures": 0, "tutorial_browsers": set(), "tutorial_finished": set(),
            "corrections": 0, "comparisons": 0, "active_days": set(), "stage_minutes": dict.fromkeys(STAGES, 0),
        })
        if browser:
            stats["browsers"].add(browser)
        if today is not None:
            today["accounts"].add(account_id)
        if long and kind in LONG_MEASURES:
            amount = SLOT_MINUTES if kind in ("open", "working") else int(detail.get("count") or 1)
            per_day[(account_id, date, LONG_MEASURES[kind])] += amount
        if kind in ("open", "working"):
            stats[f"{kind}_minutes"] += SLOT_MINUTES
            (hour_open if kind == "open" else hour_working)[at.hour].add((date, browser))
            if today is not None:
                today[kind].add(browser)
            if kind == "open":
                stage = page_of.get(browser or "", "projects")
                stats["stage_minutes"][stage] += SLOT_MINUTES
                totals[f"stage:{stage}"] += SLOT_MINUTES
            else:
                stats["active_days"].add(date)
                worked[account_id][date] += SLOT_MINUTES
        elif kind == "login":
            stats["logins"] += 1
            totals["logins"] += 1
            if today is not None:
                today["logins"] += 1
        elif kind == "project_created":
            stats["projects"] += 1
        elif kind == "recording_uploaded":
            stats["uploads"] += 1
            stats["upload_minutes"] += float(detail.get("minutes") or 0)
        elif kind == "analysis_started":
            stats["analyses"] += 1
            totals["analyses"] += 1
            if today is not None:
                today["analyses"] += 1
        elif kind == "analysis_finished":
            if detail.get("status") == "completed":
                totals["analyses_completed"] += 1
                if detail.get("took") is not None:
                    took.append(detail["took"])
                if detail.get("waited") is not None:
                    waited.append(detail["waited"])
            elif detail.get("status") == "failed":
                stats["analyses_failed"] += 1
                totals["analyses_failed"] += 1
        elif kind in ("step_decided", "steps_decided"):
            count = int(detail.get("count") or 1)
            if detail.get("status") in ("accepted", "rejected"):
                stats[detail["status"]] += count
                totals[detail["status"]] += count
                if today is not None:
                    today["decisions"] += count
        elif kind == "step_annotated":
            stats["annotations"] += 1
        elif kind == "step_added":
            stats["steps_added"] += 1
        elif kind == "review_carried_over":
            stats["carried_over"] += 1
        elif kind == "screens_merged":
            stats["merges"] += 1
        elif kind == "exported":
            stats["exports"] += 1
            totals["exports"] += 1
        elif kind == "figure_downloaded":
            stats["figures"] += 1
            totals["figures"] += 1
        elif kind == "page":
            pages[detail.get("name", "?")] += 1
            if browser and detail.get("name") in STAGE_OF_PAGE:
                page_of[browser] = STAGE_OF_PAGE[detail["name"]]
        elif kind == "screen_corrected":
            stats["corrections"] += 1
            totals["corrections"] += 1
            totals[f"correction:{detail.get('choice', '?')}"] += 1
        elif kind == "comparison_opened":
            stats["comparisons"] += 1
            totals["comparisons"] += 1
        elif kind == "boxes_switched":
            totals["boxes_switched"] += 1
        elif kind == "guide_opened":
            totals["guide_opened"] += 1
        elif kind == "tutorial_invited" and browser:
            invited.add(browser)
        elif kind.startswith("tutorial_") and browser:
            progress = tutorial[browser]
            if kind == "tutorial_opened":
                progress["opened"] = True
                tutorial_from[detail.get("from", "?")] += 1
                stats["tutorial_browsers"].add(browser)
            elif kind == "tutorial_lesson":
                progress["reached"].add(detail.get("lesson"))
            elif kind == "tutorial_solved":
                progress["solved"].add(detail.get("lesson"))
                if len(progress["solved"]) >= TUTORIAL_LESSONS:
                    stats["tutorial_finished"].add(browser)
            elif kind == "tutorial_show_me":
                show_me[detail.get("lesson")] += 1
            elif kind == "tutorial_closed" and detail.get("minutes") is not None:
                closed_minutes.append(detail["minutes"])

    def account_row(account_id: str, stats: dict[str, Any]) -> dict[str, Any]:
        return {
            **{key: value for key, value in stats.items() if not isinstance(value, set)},
            "id": account_id,
            "browsers": len(stats["browsers"]),
            "upload_minutes": round(stats["upload_minutes"], 1),
            "tutorial_browsers": len(stats["tutorial_browsers"]),
            "tutorial_finished": len(stats["tutorial_finished"]),
            "active_days": len(stats["active_days"]),
            "stage_minutes": dict(stats["stage_minutes"]),
            "worked": [worked[account_id].get(date, 0) for date in day],
        }

    lessons = []
    for lesson in range(1, TUTORIAL_LESSONS + 1):
        lessons.append({
            "lesson": lesson,
            "reached": sum(1 for progress in tutorial.values() if lesson in progress["reached"]),
            "solved": sum(1 for progress in tutorial.values() if lesson in progress["solved"]),
            "show_me": show_me.get(lesson, 0),
        })

    return {
        **window.describe(),
        "tag": tag,
        "slot_minutes": SLOT_MINUTES,
        "totals": {
            "browsers": len(browsers),
            "accounts": len(accounts),
            "logins": totals["logins"],
            "login_failures": totals["login_failures"],
            "analyses": totals["analyses"],
            "analyses_completed": totals["analyses_completed"],
            "analyses_failed": totals["analyses_failed"],
            "analysis_median_seconds": _median(took),
            "analysis_wait_median_seconds": _median(waited),
            "accepted": totals["accepted"],
            "rejected": totals["rejected"],
            "exports": totals["exports"],
            "figures": totals["figures"],
            "corrections": totals["corrections"],
            "corrections_by_choice": {
                key.split(":", 1)[1]: value for key, value in totals.items() if key.startswith("correction:")
            },
            "comparisons": totals["comparisons"],
            "boxes_switched": totals["boxes_switched"],
            "guide_opened": totals["guide_opened"],
            "stage_minutes": {stage: totals[f"stage:{stage}"] for stage in STAGES},
        },
        "hours": [
            {"hour": hour, "open": len(hour_open[hour]), "working": len(hour_working[hour])} for hour in range(24)
        ],
        "days_list": [
            {**{k: v for k, v in entry.items() if not isinstance(v, set)},
             "open": len(entry["open"]), "working": len(entry["working"]), "accounts": len(entry["accounts"])}
            for entry in day.values()
        ],
        "accounts": sorted(
            (account_row(account_id, stats) for account_id, stats in accounts.items()), key=lambda row: row["name"].lower()
        ),
        "tutorial": {
            "invited": len(invited),
            "opened": sum(1 for progress in tutorial.values() if progress["opened"]),
            "opened_from": dict(tutorial_from),
            "finished": sum(1 for progress in tutorial.values() if len(progress["solved"]) >= TUTORIAL_LESSONS),
            "median_minutes": _median(closed_minutes),
            "lessons": lessons,
        },
        "pages": dict(pages),
        **(
            {"long": [
                [accounts[account_id]["name"], date, measure, round(value, 2)]
                for (account_id, date, measure), value in sorted(per_day.items(), key=lambda item: (accounts[item[0][0]]["name"], item[0][1], item[0][2]))
            ]}
            if long
            else {}
        ),
    }
