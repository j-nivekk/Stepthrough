"""Making, importing and deleting accounts: shared by the administrators' web page and ``python -m app.users``.

A list of people can be imported from a CSV file in the same layout as 4CAT's bulk user import: a ``name``
column, and optionally ``expires`` (the date the account is deleted), ``tags`` (separated by commas), ``password``
and ``notes``. Commas, semicolons or tabs may separate the columns. People without a password in the list get a
one-time link with which they set one.
"""

from __future__ import annotations

import csv
import io
import re
import shutil
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

from .accounts import UserLink, new_user_link, password_problem, set_password
from .database import LOCAL_USER_ID
from .repository import (
    create_user,
    delete_expired_sessions_and_links,
    delete_project_record,
    delete_user_record,
    find_user_by_name,
    project_has_active_runs,
    projects_owned_only_by,
    users_due_for_deletion,
)
from .storage import project_dir
from .utils import utc_now

NAME_RE = re.compile(r"^[^\s\x00-\x1f\x7f]{1,200}$")
TAG_RE = re.compile(r"^[\w.-]{1,60}$")
MAX_IMPORT_BYTES = 2 * 1024 * 1024
MAX_IMPORT_ROWS = 5000


class AccountError(ValueError):
    """Input that cannot be used for an account; the message is meant for the person who typed it."""


class AccountBusy(Exception):
    """The user still has analyses running in a project that would be deleted with them."""


def clean_name(raw: str | None) -> str:
    name = (raw or "").strip()
    if not name:
        raise AccountError("Give the name the person will log in with.")
    if not NAME_RE.match(name):
        raise AccountError("A name has no spaces and at most 200 characters.")
    return name


def clean_display_name(raw: str | None) -> str | None:
    text = " ".join((raw or "").split())
    if len(text) > 200:
        raise AccountError("A display name has at most 200 characters.")
    return text or None


def clean_tags(raw: Iterable[str]) -> list[str]:
    tags = set()
    for item in raw:
        tag = item.strip()
        if not tag:
            continue
        if not TAG_RE.match(tag):
            raise AccountError(f"The tag `{tag}` can only use letters, digits, `-`, `_` and `.`.")
        tags.add(tag)
    return sorted(tags)


def split_tags(text: str | None) -> list[str]:
    """Tags typed as one piece of text, separated by commas or spaces."""
    return clean_tags(re.split(r"[,\s]+", text or ""))


def clean_date(raw: str | date | None) -> str | None:
    """A deletion date as YYYY-MM-DD, from a date or text such as ``2027-02-01`` (a time after it is ignored)."""
    if raw is None or isinstance(raw, date):
        return raw.isoformat() if raw else None
    text = raw.strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        raise AccountError(f"`{text}` is not a date. Write dates as YYYY-MM-DD, for example 2027-02-01.") from None


def create_account(
    name: str,
    *,
    display_name: str | None = None,
    tags: Iterable[str] = (),
    delete_after: str | date | None = None,
    notes: str | None = None,
    password: str | None = None,
) -> tuple[dict[str, Any], UserLink | None]:
    """Make an account. Without a password it gets an invitation link, which is returned with it."""
    name = clean_name(name)
    if find_user_by_name(name):
        raise AccountError(f"There is already an account called {name}.")
    if password is not None and (problem := password_problem(password)):
        raise AccountError(f"Password for {name}: {problem}")
    row = create_user(
        name,
        display_name=clean_display_name(display_name),
        tags=clean_tags(tags),
        delete_after=clean_date(delete_after),
        notes=(notes or "").strip() or None,
    )
    if password is not None:
        set_password(row["id"], password)
        return row, None
    return row, new_user_link(row["id"])


@dataclass
class ImportResult:
    created: list[tuple[dict[str, Any], UserLink | None]] = field(default_factory=list)
    existing: list[str] = field(default_factory=list)
    # (row number counting the header as 1, name if there was one, what was wrong)
    errors: list[tuple[int, str | None, str]] = field(default_factory=list)


def read_user_list(data: bytes) -> list[dict[str, str]]:
    """The rows of a CSV list of people, with lower-case column names."""
    if len(data) > MAX_IMPORT_BYTES:
        raise AccountError(f"The list is larger than {MAX_IMPORT_BYTES // (1024 * 1024)} MB.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")  # Excel on Windows
    if not text.strip():
        raise AccountError("The list is empty.")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel  # one column, so nothing to sniff
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    reader.fieldnames = [(column or "").strip().lower() for column in reader.fieldnames or []]
    if "name" not in reader.fieldnames:
        raise AccountError("The list needs a `name` column (and may have `expires`, `tags`, `password` and `notes`).")
    rows = [{key: (value or "").strip() for key, value in row.items() if key} for row in reader]
    if len(rows) > MAX_IMPORT_ROWS:
        raise AccountError(f"The list has more than {MAX_IMPORT_ROWS} people; split it up.")
    return rows


def import_accounts(data: bytes, *, tags: Iterable[str] = (), delete_after: str | date | None = None) -> ImportResult:
    """Make an account for every new name in a CSV list. ``tags`` are added to everyone's, and ``delete_after``
    applies to rows without their own ``expires`` date. Names that already have an account are left as they are."""
    extra_tags = clean_tags(tags)
    default_delete_after = clean_date(delete_after)
    result = ImportResult()
    for number, row in enumerate(read_user_list(data), start=2):
        name = row.get("name") or None
        try:
            if name and find_user_by_name(name):
                result.existing.append(name)
                continue
            account = create_account(
                name or "",
                tags=[*extra_tags, *split_tags(row.get("tags"))],
                delete_after=clean_date(row.get("expires")) or default_delete_after,
                notes=row.get("notes"),
                password=row.get("password") or None,
            )
        except AccountError as error:
            result.errors.append((number, name, str(error)))
            continue
        result.created.append(account)
    return result


def delete_account(user_id: str) -> list[str]:
    """Delete a user and the projects only they own (with every file in them). Projects they share as an owner
    with someone else, or with a tag, stay. Returns the names of the deleted projects."""
    if user_id == LOCAL_USER_ID:
        raise AccountError("The built-in user cannot be deleted.")
    projects = projects_owned_only_by(user_id)
    busy = [project["name"] for project in projects if project_has_active_runs(project["id"])]
    if busy:
        raise AccountBusy(", ".join(busy))
    for project in projects:
        delete_project_record(project["id"])
        shutil.rmtree(project_dir(project["slug"], project["id"]), ignore_errors=True)
    delete_user_record(user_id)
    return [project["name"] for project in projects]


def delete_expired_accounts(today: date | None = None) -> list[str]:
    """Delete every account whose ``delete_after`` date has come (skipping, until next time, any whose analyses
    are still running), and forget expired sessions and links. Returns the deleted names."""
    delete_expired_sessions_and_links(utc_now())
    deleted = []
    for row in users_due_for_deletion((today or datetime.now(timezone.utc).date()).isoformat()):
        if row["id"] == LOCAL_USER_ID:
            continue
        try:
            delete_account(row["id"])
        except AccountBusy:
            continue
        deleted.append(row["name"])
    return deleted
