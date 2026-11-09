"""Who is making a request, and what they may do with a project.

Every project lists its members in ``project_members``: a user, or everyone with a tag (``tag:<name>``), as an
``owner`` (may change it) or a ``viewer`` (may only look). Recordings, runs, steps and exports follow their
project. Users with the ``admin`` tag may open and change every project.

How people are recognised depends on the server's ``auth`` setting (``STEPTHROUGH_AUTH``):

- ``none``, the standalone app: every request comes from the built-in local user, an administrator.
- ``password``, a shared server: people log in with their name and password, and the browser keeps a session
  cookie. Accounts are made by an administrator, who hands out a one-time link with which each person sets their
  own password. Nobody can sign themselves up.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import cache
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException
from starlette.requests import HTTPConnection

from .config import AuthMode
from .database import ADMIN_TAG, LOCAL_USER_ID
from .repository import (
    create_session,
    delete_session,
    delete_user_links,
    delete_user_sessions,
    get_password_hash,
    get_session,
    get_user,
    get_user_link,
    project_member_roles,
    replace_user_link,
    set_password_hash,
    touch_session,
)
from .utils import utc_now

ProjectRole = Literal["viewer", "owner"]
LinkPurpose = Literal["invite", "reset"]
TAG_PREFIX = "tag:"

SESSION_COOKIE = "stepthrough_session"
SESSION_LIFETIME = timedelta(days=30)
# A session not used for this long ends early, for browsers left logged in on shared computers.
SESSION_IDLE_LIMIT = timedelta(days=7)
# Invitations wait for people to get round to them; a reset is asked for and used straight away.
LINK_LIFETIME = timedelta(days=14)
RESET_LINK_LIFETIME = timedelta(days=3)
# The web page reads the token from the part after `#`, which browsers never send to the server, so links do not
# end up in the web server's logs.
LINK_FRAGMENT = "#link="
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 1024
# PBKDF2-SHA256 at OWASP's recommended work factor: in the standard library, and light on memory when a whole
# lot of people log in at once. The count is stored with each hash, so it can be raised later.
PASSWORD_ITERATIONS = 600_000
# How often a session's (and its user's) "last seen" time is written while it is in use.
SEEN_INTERVAL = timedelta(hours=1)


@dataclass(frozen=True)
class User:
    id: str
    name: str
    display_name: str | None = None
    tags: tuple[str, ...] = ()
    delete_after: str | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> User:
        tags = row.get("tags") or "[]"
        return cls(
            id=row.get("user_id") or row["id"],
            name=row["name"],
            display_name=row.get("display_name"),
            tags=tuple(json.loads(tags) if isinstance(tags, str) else tags),
            delete_after=row.get("delete_after"),
        )

    @property
    def is_admin(self) -> bool:
        return ADMIN_TAG in self.tags

    @property
    def is_builtin(self) -> bool:
        return self.id == LOCAL_USER_ID

    @property
    def memberships(self) -> tuple[str, ...]:
        """The ``project_members.member`` values that stand for this user: their id and each of their tags."""
        return (self.id, *(f"{TAG_PREFIX}{tag}" for tag in self.tags))


# ── passwords and tokens ─────────────────────────────────────────────────────────────────────────────────────


COMMON_PASSWORDS_FILE = Path(__file__).with_name("wordlists") / "common-passwords.txt"


@cache
def common_passwords() -> frozenset[str]:
    lines = COMMON_PASSWORDS_FILE.read_text(encoding="utf-8").splitlines()
    return frozenset(line for line in lines if line and not line.startswith("#"))


def password_problem(password: str, name: str | None = None) -> str | None:
    """Why a new password cannot be used, or ``None``. As NIST SP 800-63B advises: a minimum length and no
    composition rules, but no password from breaches, and nothing built from the service or the person's name."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Use at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Use at most {MAX_PASSWORD_LENGTH} characters."
    lowered = password.lower()
    if len(set(lowered)) == 1 or lowered in common_passwords():
        return "That password is one of the most common ones, so it is easy to guess. Choose another."
    names = {"stepthrough"}
    if name:
        names |= {name.lower(), name.lower().split("@")[0]}
    if any(len(part) >= 3 and part in lowered for part in names):
        return "A password cannot contain your name or the name of this app."
    return None


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    iterations = PASSWORD_ITERATIONS
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${_b64(salt)}${_b64(digest)}"


def password_matches(password: str, stored: str | None) -> bool:
    """Whether ``password`` is the one ``stored`` was made from. Takes as long when there is no stored hash, so
    the answer's timing does not tell whether a name exists."""
    try:
        scheme, iterations, salt, expected = (stored or _missing_hash()).split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), _unb64(salt), int(iterations))
    except (ValueError, TypeError):
        return False
    return stored is not None and hmac.compare_digest(digest, _unb64(expected))


_MISSING_HASH: str | None = None


def _missing_hash() -> str:
    global _MISSING_HASH
    if _MISSING_HASH is None:
        _MISSING_HASH = hash_password(secrets.token_urlsafe(16))
    return _MISSING_HASH


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _later(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).isoformat()


# ── sessions ─────────────────────────────────────────────────────────────────────────────────────────────────


def start_session(user_id: str) -> str:
    """Log a user in; returns the token for the cookie."""
    token = new_token()
    create_session(token_hash(token), user_id, _later(SESSION_LIFETIME))
    return token


def end_session(token: str | None) -> None:
    if token:
        delete_session(token_hash(token))


def session_user(token: str) -> User | None:
    """The user a session cookie belongs to, if the session is still valid and the account is switched on."""
    session = get_session(token_hash(token))
    if session is None or session["is_disabled"]:
        return None
    now = utc_now()
    seen = datetime.fromisoformat(session["session_seen_at"])
    if session["expires_at"] <= now or seen + SESSION_IDLE_LIMIT <= datetime.fromisoformat(now):
        delete_session(session["token_hash"])
        return None
    if seen + SEEN_INTERVAL <= datetime.fromisoformat(now):
        touch_session(session["token_hash"], session["user_id"], now)
    return User.from_row(session)


def set_session_cookie(response: Any, conn: HTTPConnection, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        samesite="lax",
        # Behind the web server, uvicorn's --proxy-headers makes the scheme the one the browser used.
        secure=conn.url.scheme == "https",
        path="/",
    )


def clear_session_cookie(response: Any, conn: HTTPConnection) -> None:
    response.delete_cookie(SESSION_COOKIE, httponly=True, samesite="lax", secure=conn.url.scheme == "https", path="/")


# ── who is asking (FastAPI dependencies) ─────────────────────────────────────────────────────────────────────


def auth_mode(conn: HTTPConnection) -> AuthMode:
    return getattr(conn.app.state, "auth_mode", "none")


def builtin_user() -> User:
    row = get_user(LOCAL_USER_ID)
    if row is None:  # pragma: no cover - init_db creates it on every start
        raise RuntimeError("The built-in local user is missing; restart the backend to recreate it.")
    return User.from_row(row)


def current_user(conn: HTTPConnection) -> User | None:
    """Who is making the request, or ``None`` if nobody is logged in (only possible with password logins)."""
    if auth_mode(conn) == "none":
        return builtin_user()
    token = conn.cookies.get(SESSION_COOKIE)
    return session_user(token) if token else None


def logged_in_user(user: Annotated[User | None, Depends(current_user)]) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="Log in to continue.")
    return user


# Use as a parameter type in endpoints: ``def show(..., user: CurrentUser)``. Answers 401 if nobody is logged in.
CurrentUser = Annotated[User, Depends(logged_in_user)]
# The same, but ``None`` instead of 401 (for the session check and the progress socket).
MaybeUser = Annotated[User | None, Depends(current_user)]


def require_admin(user: User) -> None:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Only administrators can do this.")


def project_role(project_id: str, user: User) -> ProjectRole | None:
    """The most a user may do with a project: ``owner``, ``viewer``, or ``None`` if they may not open it."""
    if user.is_admin:
        return "owner"
    roles = project_member_roles(project_id, user.memberships)
    if "owner" in roles:
        return "owner"
    if "viewer" in roles:
        return "viewer"
    return None


# ── requests from other websites ─────────────────────────────────────────────────────────────────────────────


def is_cross_site(conn: HTTPConnection, allowed_origins: tuple[str, ...]) -> bool:
    """Whether a browser sent this request from another website (which must not act with the visitor's login).

    Browsers say where a request comes from in ``Sec-Fetch-Site`` and ``Origin``. Origins in
    ``STEPTHROUGH_CORS_ORIGINS`` (the development frontend) are trusted; programs that send neither header, such
    as scripts and the smoke test, are not browsers and carry no one else's cookie."""
    origin = conn.headers.get("origin")
    if origin and origin.rstrip("/") in allowed_origins:
        return False
    site = conn.headers.get("sec-fetch-site")
    if site is not None:
        return site not in ("same-origin", "none")
    if origin is None:
        return False
    host = conn.headers.get("x-forwarded-host") or conn.headers.get("host")
    return urlsplit(origin).netloc != host


def client_address(conn: HTTPConnection) -> str:
    """The address a request came from. Behind the web server this is the last ``X-Forwarded-For`` entry: the
    one the web server added itself, whatever the client put before it. (uvicorn's own choice, the first entry,
    can be written by the client.) Without a web server in front, it is the connection's address."""
    forwarded = [part.strip() for part in conn.headers.get("x-forwarded-for", "").split(",") if part.strip()]
    if forwarded:
        return forwarded[-1]
    return conn.client.host if conn.client else "unknown"


class LoginLimiter:
    """Slows down password guessing. Wrong passwords are counted for each name from each address, for each name
    from anywhere, and for each address, over a moving window; once any count is full, further attempts are
    refused until old ones age out.

    - per name and address (10): one guesser stops quickly, but does not lock the real person out elsewhere;
    - per name (100): guessing one account from many addresses also stops;
    - per address (100): one address trying many names stops. Generous, as a class may share one address.

    Kept in memory, as the API runs as one process (a restart forgets it), and at most ``max_keys`` counts at a
    time, so a flood of made-up names cannot fill the memory."""

    def __init__(
        self,
        per_pair: int = 10,
        per_name: int = 100,
        per_address: int = 100,
        window_seconds: float = 15 * 60,
        max_keys: int = 100_000,
    ) -> None:
        self.limits = {"pair": per_pair, "name": per_name, "address": per_address}
        self.window = window_seconds
        self.max_keys = max_keys
        self._failures: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    @staticmethod
    def _keys(name: str, address: str) -> dict[str, str]:
        name = name.lower()
        return {"pair": f"pair:{name}|{address}", "name": f"name:{name}", "address": f"address:{address}"}

    def _recent(self, key: str, now: float) -> int:
        failures = self._failures.get(key)
        if failures is None:
            return 0
        while failures and failures[0] <= now - self.window:
            failures.popleft()
        if not failures:
            del self._failures[key]
            return 0
        return len(failures)

    def refusal(self, name: str, address: str) -> str | None:
        """Which count is full (``pair``, ``name`` or ``address``), or ``None`` if the attempt may go ahead."""
        now = time.monotonic()
        with self._lock:
            for kind, key in self._keys(name, address).items():
                if self._recent(key, now) >= self.limits[kind]:
                    return kind
        return None

    def allowed(self, name: str, address: str) -> bool:
        return self.refusal(name, address) is None

    def failed(self, name: str, address: str) -> None:
        now = time.monotonic()
        with self._lock:
            for key in self._keys(name, address).values():
                self._failures[key].append(now)
            if len(self._failures) > self.max_keys:
                self._prune(now)

    def _prune(self, now: float) -> None:
        for key in list(self._failures):
            self._recent(key, now)
        # Still too many (a flood within one window): forget the oldest counts first.
        while len(self._failures) > self.max_keys:
            del self._failures[next(iter(self._failures))]

    def succeeded(self, name: str, address: str) -> None:
        with self._lock:
            self._failures.pop(self._keys(name, address)["pair"], None)

    def __len__(self) -> int:
        return len(self._failures)


# ── one-time links ───────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class UserLink:
    token: str
    purpose: LinkPurpose
    expires_at: str


def new_user_link(user_id: str) -> UserLink:
    """A link with which the user sets a password: an invitation if they have none yet, else a reset. It replaces
    any earlier link."""
    purpose: LinkPurpose = "reset" if get_password_hash(user_id) else "invite"
    token = new_token()
    expires_at = _later(RESET_LINK_LIFETIME if purpose == "reset" else LINK_LIFETIME)
    replace_user_link(token_hash(token), user_id, purpose, expires_at)
    return UserLink(token=token, purpose=purpose, expires_at=expires_at)


def link_url(token: str, base_url: str | None) -> str:
    return f"{base_url or ''}/{LINK_FRAGMENT}{token}"


def find_link(token: str) -> dict[str, Any] | None:
    """The link's details and its user's columns, if it exists, has not expired and the account is switched on."""
    link = get_user_link(token_hash(token))
    if link is None or link["is_disabled"] or link["expires_at"] <= utc_now():
        return None
    return link


def set_password(user_id: str, password: str, *, keep_session_token: str | None = None) -> None:
    """Store a new password and log the user out everywhere else; any open link stops working."""
    set_password_hash(user_id, hash_password(password))
    delete_user_links(user_id)
    delete_user_sessions(user_id, token_hash(keep_session_token) if keep_session_token else None)
