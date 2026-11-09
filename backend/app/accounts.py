"""Who is making a request, and what they may do with a project.

Every project lists its members in ``project_members``: a user, or everyone with a tag (``tag:<name>``), as an
``owner`` (may change it) or a ``viewer`` (may only look). Recordings, runs, steps and exports follow their
project. Users with the ``admin`` tag may open and change every project.

There is no login yet: every request comes from the built-in local user, an administrator, which is how the
standalone app works. Accounts with passwords will replace ``current_user`` without changing the checks.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from fastapi import Depends

from .database import ADMIN_TAG, LOCAL_USER_ID
from .repository import get_user, project_member_roles

ProjectRole = Literal["viewer", "owner"]
TAG_PREFIX = "tag:"


@dataclass(frozen=True)
class User:
    id: str
    name: str
    display_name: str | None = None
    tags: tuple[str, ...] = ()

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> User:
        tags = row.get("tags") or "[]"
        return cls(
            id=row["id"],
            name=row["name"],
            display_name=row.get("display_name"),
            tags=tuple(json.loads(tags) if isinstance(tags, str) else tags),
        )

    @property
    def is_admin(self) -> bool:
        return ADMIN_TAG in self.tags

    @property
    def memberships(self) -> tuple[str, ...]:
        """The ``project_members.member`` values that stand for this user: their id and each of their tags."""
        return (self.id, *(f"{TAG_PREFIX}{tag}" for tag in self.tags))


def current_user() -> User:
    """The user making the request (a FastAPI dependency). For now always the built-in local user."""
    row = get_user(LOCAL_USER_ID)
    if row is None:  # pragma: no cover - init_db creates it on every start
        raise RuntimeError("The built-in local user is missing; restart the backend to recreate it.")
    return User.from_row(row)


# Use as a parameter type in endpoints: ``def show(..., user: CurrentUser)``.
CurrentUser = Annotated[User, Depends(current_user)]


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
