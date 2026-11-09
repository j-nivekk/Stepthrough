"""Endpoints for logging in and out, setting a password from a link, and the administrators' user management."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile

from .accounts import (
    SESSION_COOKIE,
    CurrentUser,
    LoginLimiter,
    MaybeUser,
    User,
    UserLink,
    auth_mode,
    clear_session_cookie,
    client_address,
    end_session,
    find_link,
    new_user_link,
    password_matches,
    password_problem,
    require_admin,
    set_password,
    set_session_cookie,
    start_session,
)
from .database import LOCAL_USER_ID
from .models import (
    AdminUserCreate,
    AdminUserCreated,
    AdminUserResponse,
    AdminUserUpdate,
    LinkDetailsResponse,
    LinkPasswordRequest,
    LinkRequest,
    LoginRequest,
    PasswordChangeRequest,
    ProjectTransferRequest,
    ProjectTransferResponse,
    SessionResponse,
    UserDeletedResponse,
    UserImportCreated,
    UserImportProblem,
    UserImportResponse,
    UserLinkResponse,
    UserResponse,
)
from .repository import (
    any_password_set,
    find_user_by_name,
    get_password_hash,
    get_user,
    list_users,
    transfer_projects,
    update_user,
)
from .user_admin import (
    AccountBusy,
    AccountError,
    clean_date,
    clean_display_name,
    clean_tags,
    create_account,
    delete_account,
    import_accounts,
    split_tags,
)

router = APIRouter()
login_limiter = LoginLimiter()
# Failed and refused attempts go to the server log, so administrators can see guessing as it happens.
logger = logging.getLogger("stepthrough.accounts")

WRONG_LOGIN = "That name and password do not match."
TOO_MANY = "Too many attempts. Wait a few minutes and try again."
REFUSAL_REASONS = {
    "pair": "too many wrong passwords for this name from this address",
    "name": "too many wrong passwords for this name",
    "address": "too many wrong passwords from this address",
}
EXPIRED_LINK = "This link has expired or was already used. Ask for a new one."


def user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        name=user.name,
        display_name=user.display_name,
        tags=list(user.tags),
        is_admin=user.is_admin,
        delete_after=user.delete_after,
    )


def _session_response(request: Request, user: User | None) -> SessionResponse:
    mode = auth_mode(request)
    setup_needed = mode == "password" and user is None and not any_password_set()
    return SessionResponse(mode=mode, user=user_response(user) if user else None, setup_needed=setup_needed)


def _require_passwords(request: Request) -> None:
    if auth_mode(request) != "password":
        raise HTTPException(status_code=400, detail="This server has no logins: everyone uses the built-in account.")


def _account_error(error: AccountError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(error))


# ── logging in ───────────────────────────────────────────────────────────────────────────────────────────────


@router.get("/auth/session", response_model=SessionResponse)
def auth_session(request: Request, user: MaybeUser) -> SessionResponse:
    return _session_response(request, user)


@router.post("/auth/login", response_model=SessionResponse)
def auth_login(payload: LoginRequest, request: Request, response: Response) -> SessionResponse:
    _require_passwords(request)
    name = payload.name.strip()
    address = client_address(request)
    if refusal := login_limiter.refusal(name, address):
        logger.warning("Refused a login as %r from %s: %s.", name, address, REFUSAL_REASONS[refusal])
        raise HTTPException(status_code=429, detail=TOO_MANY)
    row = find_user_by_name(name) if name else None
    stored = get_password_hash(row["id"]) if row and row["id"] != LOCAL_USER_ID else None
    if not password_matches(payload.password, stored):
        login_limiter.failed(name, address)
        logger.warning("Wrong password for %r from %s%s.", name, address, "" if row else " (no such account)")
        raise HTTPException(status_code=401, detail=WRONG_LOGIN)
    if row["is_disabled"]:
        logger.warning("Login as %r from %s refused: the account is switched off.", name, address)
        raise HTTPException(status_code=403, detail="This account is switched off. Ask an administrator.")
    login_limiter.succeeded(name, address)
    logger.info("%r logged in from %s.", row["name"], address)
    end_session(request.cookies.get(SESSION_COOKIE))
    set_session_cookie(response, request, start_session(row["id"]))
    return _session_response(request, User.from_row(row))


@router.post("/auth/logout", status_code=204)
def auth_logout(request: Request) -> Response:
    end_session(request.cookies.get(SESSION_COOKIE))
    response = Response(status_code=204)
    clear_session_cookie(response, request)
    return response


@router.post("/auth/link", response_model=LinkDetailsResponse)
def auth_link_details(payload: LinkRequest, request: Request) -> LinkDetailsResponse:
    """Who a link is for, so the page can say whose password is being set. The token travels in the body, not
    the address, so it stays out of logs."""
    _require_passwords(request)
    link = find_link(payload.token)
    if link is None:
        raise HTTPException(status_code=404, detail=EXPIRED_LINK)
    return LinkDetailsResponse(name=link["name"], display_name=link["display_name"], purpose=link["purpose"])


@router.post("/auth/link/password", response_model=SessionResponse)
def auth_link_password(payload: LinkPasswordRequest, request: Request, response: Response) -> SessionResponse:
    """Set a password with a one-time link, and log in. Other browsers logged in to the account are logged out."""
    _require_passwords(request)
    link = find_link(payload.token)
    if link is None:
        raise HTTPException(status_code=404, detail=EXPIRED_LINK)
    if problem := password_problem(payload.password, link["name"]):
        raise HTTPException(status_code=422, detail=problem)
    set_password(link["user_id"], payload.password)
    logger.info("%r set a password with a %s link from %s.", link["name"], link["purpose"], client_address(request))
    end_session(request.cookies.get(SESSION_COOKIE))
    set_session_cookie(response, request, start_session(link["user_id"]))
    return _session_response(request, User.from_row(link))


@router.post("/me/password", status_code=204)
def me_change_password(payload: PasswordChangeRequest, request: Request, user: CurrentUser) -> Response:
    """Change your own password. Other browsers logged in to the account are logged out; this one stays in."""
    _require_passwords(request)
    # Someone holding a stolen session must not be able to guess the password at leisure.
    address = client_address(request)
    if refusal := login_limiter.refusal(user.name, address):
        logger.warning("Refused a password change for %r from %s: %s.", user.name, address, REFUSAL_REASONS[refusal])
        raise HTTPException(status_code=429, detail=TOO_MANY)
    if not password_matches(payload.current_password, get_password_hash(user.id)):
        login_limiter.failed(user.name, address)
        logger.warning("Wrong current password in a password change for %r from %s.", user.name, address)
        raise HTTPException(status_code=403, detail="That is not your current password.")
    if problem := password_problem(payload.new_password, user.name):
        raise HTTPException(status_code=422, detail=problem)
    set_password(user.id, payload.new_password, keep_session_token=request.cookies.get(SESSION_COOKIE))
    return Response(status_code=204)


# ── user management (administrators) ─────────────────────────────────────────────────────────────────────────


def _admin_user_response(row: dict[str, Any]) -> AdminUserResponse:
    user = User.from_row(row)
    return AdminUserResponse(
        **user_response(user).model_dump(),
        is_builtin=user.is_builtin,
        is_disabled=bool(row["is_disabled"]),
        has_password=bool(row["has_password"]),
        open_link=row.get("open_link"),
        notes=row.get("notes"),
        project_count=row.get("project_count") or 0,
        created_at=row["created_at"],
        last_seen_at=row.get("last_seen_at"),
    )


def _link_response(link: UserLink) -> UserLinkResponse:
    return UserLinkResponse(token=link.token, purpose=link.purpose, expires_at=link.expires_at)


def _listed_user(user_id: str) -> AdminUserResponse:
    row = next((row for row in list_users() if row["id"] == user_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="User not found")
    return _admin_user_response(row)


def _changeable_user(user_id: str) -> dict[str, Any]:
    if user_id == LOCAL_USER_ID:
        raise HTTPException(status_code=400, detail="The built-in account cannot be changed.")
    row = get_user(user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="User not found")
    return row


@router.get("/admin/users", response_model=list[AdminUserResponse])
def admin_users(user: CurrentUser) -> list[AdminUserResponse]:
    require_admin(user)
    return [_admin_user_response(row) for row in list_users()]


@router.post("/admin/users", response_model=AdminUserCreated)
def admin_users_create(payload: AdminUserCreate, request: Request, user: CurrentUser) -> AdminUserCreated:
    require_admin(user)
    _require_passwords(request)
    try:
        row, link = create_account(
            payload.name,
            display_name=payload.display_name,
            tags=payload.tags,
            delete_after=payload.delete_after,
            notes=payload.notes,
        )
    except AccountError as error:
        raise _account_error(error) from None
    assert link is not None  # no password given, so it gets an invitation
    return AdminUserCreated(user=_listed_user(row["id"]), link=_link_response(link))


@router.post("/admin/users/import", response_model=UserImportResponse)
def admin_users_import(
    user: CurrentUser,
    request: Request,
    file: UploadFile = File(...),
    tags: str = Form(default=""),
    delete_after: str = Form(default=""),
) -> UserImportResponse:
    require_admin(user)
    _require_passwords(request)
    try:
        result = import_accounts(file.file.read(), tags=split_tags(tags), delete_after=delete_after)
    except AccountError as error:
        raise _account_error(error) from None
    return UserImportResponse(
        created=[
            UserImportCreated(name=row["name"], link=_link_response(link) if link else None)
            for row, link in result.created
        ],
        existing=result.existing,
        errors=[UserImportProblem(row=row, name=name, message=message) for row, name, message in result.errors],
        weak_passwords=result.weak_passwords,
    )


@router.patch("/admin/users/{user_id}", response_model=AdminUserResponse)
def admin_users_update(user_id: str, payload: AdminUserUpdate, user: CurrentUser) -> AdminUserResponse:
    require_admin(user)
    row = _changeable_user(user_id)
    sent = payload.model_fields_set
    changes: dict[str, Any] = {}
    try:
        if "display_name" in sent:
            changes["display_name"] = clean_display_name(payload.display_name)
        if "tags" in sent:
            changes["tags"] = clean_tags(payload.tags or [])
        if "delete_after" in sent:
            changes["delete_after"] = clean_date(payload.delete_after)
        if "notes" in sent:
            changes["notes"] = (payload.notes or "").strip() or None
    except AccountError as error:
        raise _account_error(error) from None
    if "is_disabled" in sent and payload.is_disabled is not None:
        changes["is_disabled"] = payload.is_disabled
    if user_id == user.id:
        # Administrators cannot lock themselves out; another administrator has to.
        if changes.get("is_disabled") or ("tags" in changes and "admin" not in changes["tags"]):
            raise HTTPException(status_code=400, detail="You cannot switch off your own account or remove your own admin tag.")
    update_user(row["id"], **changes)
    return _listed_user(row["id"])


@router.post("/admin/users/{user_id}/link", response_model=UserLinkResponse)
def admin_users_link(user_id: str, request: Request, user: CurrentUser) -> UserLinkResponse:
    """A new link to set a password (an invitation, or a reset if they have one). Earlier links stop working."""
    require_admin(user)
    _require_passwords(request)
    row = _changeable_user(user_id)
    return _link_response(new_user_link(row["id"]))


@router.delete("/admin/users/{user_id}", response_model=UserDeletedResponse)
def admin_users_delete(user_id: str, user: CurrentUser) -> UserDeletedResponse:
    """Delete an account and the projects only it owns."""
    require_admin(user)
    row = _changeable_user(user_id)
    if row["id"] == user.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    try:
        return UserDeletedResponse(deleted_projects=delete_account(row["id"]))
    except AccountBusy as busy:
        raise HTTPException(
            status_code=409, detail=f"Analyses are still running in {busy}. End them first, then delete the account."
        ) from None


@router.post("/admin/users/{user_id}/transfer-projects", response_model=ProjectTransferResponse)
def admin_users_transfer_projects(
    user_id: str, payload: ProjectTransferRequest, user: CurrentUser
) -> ProjectTransferResponse:
    """Hand someone's projects to someone else, for example the built-in account's projects (made before there
    were logins) to an administrator, or those of someone who leaves to a colleague."""
    require_admin(user)
    if get_user(user_id) is None:
        raise HTTPException(status_code=404, detail="User not found")
    target = get_user(payload.to_user_id)
    if target is None or target["id"] == LOCAL_USER_ID or target["id"] == user_id:
        raise HTTPException(status_code=422, detail="Choose another account to hand the projects to.")
    return ProjectTransferResponse(moved=transfer_projects(user_id, target["id"]))
