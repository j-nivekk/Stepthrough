from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import logging
import shutil
import time
from contextlib import contextmanager
from pathlib import Path
from threading import Thread
from typing import Annotated, Any, Callable, Literal
from uuid import uuid4

from fastapi import (
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from .account_routes import router as account_router, user_response
from .accounts import (
    SESSION_COOKIE,
    CurrentUser,
    MaybeUser,
    ProjectRole,
    User,
    auth_mode,
    is_cross_site,
    project_role,
    require_admin,
)
from .analysis_metadata import serialize_analysis_metadata
from . import __version__
from .config import DATA_ROOT, build_label, build_server_config, build_tool_diagnostics, ensure_app_dirs
from .database import LOCAL_USER_ID, init_db, reset_db
from .models import (
    AnalysisMetadataResponse,
    CandidateFrameResponse,
    CandidateStatusUpdate,
    CandidateUpdate,
    ExportRequest,
    DetectionRunDetail,
    DetectionRunSummary,
    HealthResponse,
    ManualCandidateCreate,
    ReviewCarryOver,
    ReviewCarryOverResult,
    PathwayDetail,
    PathwayFigureDownload,
    PhaseBoundariesUpdate,
    PathwayMerge,
    PhaseUpdate,
    PresenceUpdate,
    PathwayResponse,
    ProjectCreate,
    ProjectResponse,
    ProjectUpdate,
    RecordingDetailResponse,
    RecordingImportResponse,
    RecordingUpdate,
    RunEventResponse,
    RunSettings,
    RunUpdate,
    SavedRunSettingsResponse,
    UserResponse,
)
from .repository import (
    ACTIVE_RUN_STATUSES,
    any_password_set,
    create_export_bundle as create_export_bundle_record,
    create_project,
    create_recording,
    create_run,
    create_run_event,
    delete_project_record,
    delete_recording_record,
    delete_run_record,
    fail_interrupted_runs,
    find_projects_by_folder,
    get_candidate,
    get_export_bundle,
    get_export_bundle_for_run,
    get_project,
    get_recording,
    get_run,
    list_candidates,
    list_projects,
    list_recordings,
    list_run_events,
    list_run_phases,
    list_runs,
    forget_run_settings,
    list_saved_run_settings,
    project_has_active_runs,
    record_change,
    recording_has_active_runs,
    rename_run,
    replace_run_phases,
    replace_candidates,
    save_run_settings,
    set_candidate_screen_links,
    mark_figure_downloaded,
    set_candidate_statuses,
    shared_accounts_for_project,
    update_candidate,
    update_project_name,
    update_recording_filename,
    update_recording_media,
    update_run,
)
from .services.export import build_accepted_steps, create_export_bundle
from .services.ocr import probe_paddleocr_availability
from .services.pathway import build_pathway, pathway_screen_members, set_phase, tidy_phases
from .services.run_control import CancellationRequested
from .services.stable_detection import detect_candidates_stable, resolve_stable_config
from .services.ingest import ensure_working_copy, stop_working_copy, working_copy_path
from .services.jobs import JobManager
from .services.similarity import annotate_candidate_similarity, fingerprint_image, hash_to_hex, histogram_to_string
from .services.video import (
    UploadTooLargeError,
    VideoToolError,
    display_timecode,
    extract_frame,
    probe_video,
    recording_slug_from_filename,
    save_upload_file,
    slug_timecode,
)
from .compression import CompressMiddleware
from .export_cleanup import clear_old_exports
from .live import CLIENT_HEADER, LiveHub, TaskWrites, clean_targets
from . import server_settings, traffic, usage, usage_routes
from .storage import (
    absolute_data_path,
    asset_url,
    project_dir,
    recording_dir,
    recording_source_path,
    relative_data_path,
    run_dir,
)
from .user_admin import delete_expired_accounts
from .utils import sanitize_filename, utc_now

TERMINAL_WEBSOCKET_STATES = {"completed", "failed", "cancelled"}
INTERRUPTED_RUN_MESSAGE = "Interrupted: the backend restarted while this run was active. Start a new run."
ADMIN_CONFIRM_HEADER = "X-Stepthrough-Confirm"
SharedClient = Annotated[str | None, Header(alias=CLIENT_HEADER, max_length=100)]
logger = logging.getLogger("stepthrough")
if not logger.handlers:
    # uvicorn sets up only its own loggers; give ours a time and a source, so failed logins read well in the log.
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
server_config = build_server_config()


@dataclass(frozen=True)
class OcrHealthState:
    status: Literal["checking", "available", "unavailable"]
    available: bool | None
    message: str
    warnings: tuple[str, ...] = ()

# A server does not publish its API description: it is no secret (the code is public), but nobody needs it there.
_api_docs = server_config.deployment != "server"
app = FastAPI(
    title="Stepthrough API",
    version=__version__,
    docs_url="/docs" if _api_docs else None,
    redoc_url="/redoc" if _api_docs else None,
    openapi_url="/openapi.json" if _api_docs else None,
)
# Read through accounts.auth_mode, so tests can switch it on a running app.
app.state.auth_mode = server_config.auth
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(server_config.cors_origins),
    # The development frontend runs on another port and sends the session cookie along.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(account_router)
app.include_router(server_settings.router)
app.include_router(usage_routes.router)
# Usage is recorded on a server with logins, while it is kept for a day or more, or for ever (app/usage.py).
def _recording() -> bool:
    keep = server_settings.keep_days()
    return getattr(app.state, "auth_mode", "none") == "password" and (keep is None or keep > 0)


usage.configure(_recording)
traffic.configure(_recording, SESSION_COOKIE)
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


SECURITY_HEADERS = {
    # Browsers must not guess another type for a file than the one it is served as.
    "X-Content-Type-Options": "nosniff",
    # Other websites must not show these pages inside a frame, where clicks could be steered.
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    # Leaving for another site tells it nothing about the page that was open.
    "Referrer-Policy": "no-referrer",
}


@app.middleware("http")
async def reject_cross_site_changes(request: Request, call_next):
    # Another website open in the same browser must not change anything with the visitor's login (or, in the
    # desktop app, at all: anything on the computer can reach the local backend). Reading is left to CORS.
    if request.method in UNSAFE_METHODS and is_cross_site(request, server_config.cors_origins):
        return JSONResponse(status_code=403, content={"detail": "Requests from other websites are not accepted."})
    return await call_next(request)


@app.middleware("http")
async def reject_oversized_uploads(request: Request, call_next):
    # Refuse before the multipart body is spooled to disk; save_upload_file re-checks chunked uploads.
    content_length = request.headers.get("content-length")
    if request.url.path == "/recordings/import" and content_length and content_length.isdigit():
        if int(content_length) > server_config.max_upload_bytes:
            limit_mb = server_config.max_upload_bytes // (1024 * 1024)
            return JSONResponse(status_code=413, content={"detail": f"Recording is larger than the {limit_mb} MB upload limit."})
    return await call_next(request)


# Added last, so it is the outermost middleware: refusals from the ones above carry the headers too.
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    return response


# Outermost of all: what the others send is compressed when it is worth it and an administrator has not switched it off.
app.add_middleware(CompressMiddleware, enabled=server_settings.compression_enabled)
# Around that, so it counts the bytes as they go over the network (app/traffic.py).
app.add_middleware(traffic.TrafficMiddleware, enabled=lambda: _recording())


def _checking_ocr_state() -> OcrHealthState:
    return OcrHealthState(
        status="checking",
        available=None,
        message="Checking PaddleOCR availability in the background.",
    )


def _get_ocr_state() -> OcrHealthState:
    return getattr(app.state, "ocr_state", _checking_ocr_state())


def _set_ocr_state(state: OcrHealthState) -> None:
    app.state.ocr_state = state


def _refresh_ocr_state() -> None:
    clear_probe_cache = getattr(probe_paddleocr_availability, "cache_clear", None)
    if callable(clear_probe_cache):
        clear_probe_cache()
    try:
        result = probe_paddleocr_availability()
    except Exception as exc:  # pragma: no cover - defensive fallback
        details = " ".join(str(exc).split()) or exc.__class__.__name__
        _set_ocr_state(
            OcrHealthState(
                status="unavailable",
                available=False,
                message=f"PaddleOCR availability check failed in the backend environment: {details}",
            )
        )
        return

    _set_ocr_state(
        OcrHealthState(
            status="available" if result.available else "unavailable",
            available=result.available,
            message=result.message,
            warnings=result.warnings,
        )
    )


def _start_background_ocr_probe() -> None:
    worker = Thread(target=_refresh_ocr_state, name="stepthrough-ocr-probe", daemon=True)
    app.state.ocr_probe_thread = worker
    worker.start()


def _delete_expired_accounts_hourly() -> None:
    while True:
        try:
            for name in delete_expired_accounts():
                logger.info("Deleted the account %s and the projects only it owned: its deletion date has come.", name)
        except Exception:  # pragma: no cover - keep trying every hour
            logger.exception("Could not delete expired accounts.")
        try:
            usage.purge(server_settings.keep_days())
            traffic.purge(server_settings.keep_days())
        except Exception:  # pragma: no cover - keep trying every hour
            logger.exception("Could not delete old usage events.")
        try:
            removed, freed = clear_old_exports()
            if removed:
                exports = "export" if removed == 1 else "exports"
                logger.info("Removed %d %s that newer ones replaced (%.1f MB).", removed, exports, freed / 1_000_000)
        except Exception:  # pragma: no cover - keep trying every hour
            logger.exception("Could not remove replaced exports.")
        time.sleep(3600)


@app.on_event("shutdown")
def shutdown() -> None:
    usage.flush()
    traffic.flush()


def _start_account_cleanup() -> None:
    Thread(target=_delete_expired_accounts_hourly, name="stepthrough-account-cleanup", daemon=True).start()


@app.on_event("startup")
def startup() -> None:
    ensure_app_dirs()
    init_db()
    if server_config.auth == "password" and not any_password_set():
        logger.warning(
            "Nobody can log in yet. Make the first administrator with `python -m app.users add NAME --admin` "
            "(in Docker: `docker compose exec stepthrough python -m app.users add NAME --admin`)."
        )
    _start_account_cleanup()
    app.state.tool_diagnostics = build_tool_diagnostics()
    _set_ocr_state(_checking_ocr_state())
    server_settings.load(server_config.max_concurrent_runs)
    app.state.job_manager = JobManager(max_concurrent_runs=server_settings.analyses_limit())
    app.state.live = LiveHub()
    app.state.task_writes = TaskWrites()
    fail_interrupted_runs(INTERRUPTED_RUN_MESSAGE)
    _start_background_ocr_probe()


def _job_manager() -> JobManager:
    return app.state.job_manager


def _live() -> LiveHub:
    return app.state.live


def _one_at_a_time(run_id: str):
    """Changes to the steps of one task, one after the other (see live.TaskWrites)."""
    return app.state.task_writes.one_at_a_time(run_id)


def _audience(project_id: str | None, user: User | None = None) -> set[str]:
    """The shared accounts to tell about a change: those that can open the project, and the one making it."""
    accounts = set(shared_accounts_for_project(project_id)) if project_id else set()
    if user is not None and user.is_shared:
        accounts.add(user.id)
    return accounts


def _announce(
    kind: str,
    *,
    project_id: str | None = None,
    recording_id: str | None = None,
    run_id: str | None = None,
    user: User | None = None,
    client: str | None = None,
    accounts: set[str] | None = None,
    changed: bool = True,
    **extra: Any,
) -> None:
    """Tell the browsers of the shared accounts concerned what changed, so that they show it at once. ``client`` is
    the browser that made the change, which has shown it already.

    A change ``user`` made is also recorded on the project and the run as their last change, unless ``changed`` is
    false: for what leaves both as they were (an export), or is the person's own (their saved settings)."""
    if user is not None and changed:
        try:
            record_change(user.id, project_id=project_id, run_id=run_id)
        except Exception:  # nor must recording who made it
            logger.exception("Could not record a %s change", kind)
    try:
        audience = accounts if accounts is not None else _audience(project_id, user)
        if audience:
            event = {"kind": kind, "project_id": project_id, "recording_id": recording_id, "run_id": run_id, "by": client}
            _live().publish(audience, {**event, **extra})
    except Exception:  # telling the others must never undo the change itself
        logger.exception("Could not announce a %s change", kind)


@contextmanager
def _busy(user: User, client: str | None, project_id: str, run_id: str, label: str):
    """While a change rewrites a task, show the other browsers of a shared account what is happening to it."""
    accounts = _audience(project_id, user) if user.is_shared else set()
    with _live().busy(accounts, {"project_id": project_id, "run_id": run_id, "label": label, "by": client}):
        yield


def _require_tools() -> None:
    diagnostics = app.state.tool_diagnostics
    if diagnostics.missing_tools:
        raise HTTPException(status_code=503, detail=diagnostics.message)


def _lock_unavailable_ocr(settings: RunSettings) -> RunSettings:
    if _get_ocr_state().available is not False or settings.stable is None or not settings.stable.enable_ocr:
        return settings
    return settings.model_copy(update={"stable": settings.stable.model_copy(update={"enable_ocr": False})})


def _run_is_abortable(run: dict[str, Any]) -> bool:
    return run["status"] in ACTIVE_RUN_STATUSES


def _run_is_deletable(run: dict[str, Any]) -> bool:
    return run["status"] not in ACTIVE_RUN_STATUSES


def _modifier_name(row: dict) -> str | None:
    """Who last changed it, to show; nobody in the app without logins, where every change is the one built-in user's."""
    return None if row.get("modified_by") == LOCAL_USER_ID else row.get("modified_by_name")


def _serialize_project(row: dict) -> ProjectResponse:
    return ProjectResponse(
        **{**row, "modified_at": row.get("modified_at") or row["last_activity_at"], "modified_by_name": _modifier_name(row)}
    )


def _json_column(row: dict, key: str) -> Any:
    value = row.get(key)
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return value or None


def _serialize_run_summary(row: dict) -> DetectionRunSummary:
    advanced = _json_column(row, "analysis_advanced")
    analysis_config = _json_column(row, "analysis_config")
    return DetectionRunSummary(
        id=row["id"],
        recording_id=row["recording_id"],
        run_number=row.get("run_number"),
        name=row.get("name"),
        status=row["status"],
        phase=row.get("phase") or "queued",
        analysis_engine=row.get("analysis_engine") or "scene_v1",
        analysis_preset=row.get("analysis_preset") or "balanced",
        advanced=advanced,
        stable=_json_column(row, "analysis_stable"),
        analysis_config=analysis_config,
        engine_version=(analysis_config or {}).get("engine_version") if isinstance(analysis_config, dict) else None,
        detector_mode=row["detector_mode"],
        tolerance=row["tolerance"],
        min_scene_gap_ms=row["min_scene_gap_ms"],
        sample_fps=row["sample_fps"],
        allow_high_fps_sampling=bool(row.get("allow_high_fps_sampling")),
        extract_offset_ms=row["extract_offset_ms"],
        progress=row["progress"],
        message=row.get("message"),
        candidate_count=row.get("candidate_count", 0),
        accepted_count=row.get("accepted_count", 0),
        created_at=row["created_at"],
        started_at=row.get("started_at"),
        completed_at=row.get("completed_at"),
        updated_at=row["updated_at"],
        modified_at=row.get("last_modified_at") or row.get("modified_at"),
        modified_by_name=_modifier_name(row),
        export_bundle_id=row.get("export_bundle_id"),
        is_abortable=_run_is_abortable(row),
        is_deletable=_run_is_deletable(row),
    )


def _serialize_recording(row: dict) -> RecordingImportResponse:
    return RecordingImportResponse(
        id=row["id"],
        project_id=row["project_id"],
        filename=row["filename"],
        slug=row["slug"],
        source_url=asset_url(row.get("working_path") or row["source_path"]),
        duration_ms=row["duration_ms"],
        duration_tc=display_timecode(row["duration_ms"]),
        width=row["width"],
        height=row["height"],
        fps=row["fps"],
        created_at=row["created_at"],
    )


def _serialize_candidate(row: dict) -> CandidateFrameResponse:
    score_breakdown = row.get("score_breakdown")
    if isinstance(score_breakdown, str):
        try:
            score_breakdown = json.loads(score_breakdown)
        except json.JSONDecodeError:
            score_breakdown = None
    return CandidateFrameResponse(
        id=row["id"],
        run_id=row["run_id"],
        recording_id=row["recording_id"],
        detector_index=row["detector_index"],
        candidate_origin=row.get("candidate_origin") or "detected",
        timestamp_ms=row["timestamp_ms"],
        timestamp_tc=row["timestamp_tc"],
        image_path=row["image_path"],
        image_url=asset_url(row["image_path"]),
        scene_score=row["scene_score"],
        status=row["status"],
        title=row.get("title"),
        notes=row.get("notes"),
        score_breakdown=score_breakdown,
        revisit_group_id=row.get("revisit_group_id"),
        similar_to_candidate_id=row.get("similar_to_candidate_id"),
        similarity_distance=row.get("similarity_distance"),
        screen_link=row.get("screen_link"),
        screen_kind=row.get("screen_kind"),
        pathway_row=row.get("pathway_row"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _serialize_run_event(row: dict) -> RunEventResponse:
    return RunEventResponse(
        id=row["id"],
        run_id=row["run_id"],
        phase=row["phase"],
        level=row["level"],
        message=row["message"],
        progress=row.get("progress"),
        created_at=row["created_at"],
    )


def _serialize_export_bundle(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "run_id": row["run_id"],
        "output_dir": row["output_dir"],
        "zip_path": row["zip_path"],
        "zip_url": f"/exports/{row['id']}/download",
        "item_count": row["item_count"],
        "created_at": row["created_at"],
    }


def _emit_run_event(
    run_id: str,
    *,
    phase: str,
    level: str,
    message: str,
    progress: float | None = None,
) -> dict[str, Any]:
    event = create_run_event(run_id, phase=phase, level=level, message=message, progress=progress)
    _job_manager().publish(run_id, event)
    return event


def _set_run_state(
    run_id: str,
    *,
    status: str | None = None,
    phase: str | None = None,
    progress: float | None = None,
    message: str | None = None,
    level: str = "info",
    emit_event: bool = True,
    **extra: Any,
) -> dict[str, Any]:
    updates: dict[str, Any] = {**extra}
    if status is not None:
        updates["status"] = status
    if phase is not None:
        updates["phase"] = phase
    if progress is not None:
        updates["progress"] = progress
    if message is not None:
        updates["message"] = message
    if emit_event and message is not None and phase is not None:
        event = create_run_event(run_id, phase=phase, level=level, message=message, progress=progress, run_updates=updates)
        _job_manager().publish(run_id, event)
        return get_run(run_id)
    return update_run(run_id, **updates)


def _recording_context(recording_id: str) -> tuple[dict, dict]:
    recording = get_recording(recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    project = get_project(recording["project_id"])
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project, recording


def _run_context(run_id: str) -> tuple[dict, dict, dict]:
    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    project, recording = _recording_context(run["recording_id"])
    return project, recording, run


# The checked lookups below are for requests; the *_context ones above are for the app's own background work.
# Someone who may not open a project gets the same 404 as for one that does not exist, so they cannot tell
# which projects there are.


def _check_project_role(project_id: str, user: User, need: ProjectRole, not_found: str) -> None:
    role = project_role(project_id, user)
    if role is None:
        raise HTTPException(status_code=404, detail=not_found)
    if need == "owner" and role != "owner":
        raise HTTPException(status_code=403, detail="You can view this project but not change it.")


def _project_for(project_id: str, user: User, need: ProjectRole) -> dict:
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_project_role(project_id, user, need, "Project not found")
    return project


def _recording_for(recording_id: str, user: User, need: ProjectRole) -> tuple[dict, dict]:
    project, recording = _recording_context(recording_id)
    _check_project_role(project["id"], user, need, "Recording not found")
    return project, recording


def _run_for(run_id: str, user: User, need: ProjectRole, not_found: str = "Run not found") -> tuple[dict, dict, dict]:
    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail=not_found)
    project, recording = _recording_context(run["recording_id"])
    _check_project_role(project["id"], user, need, not_found)
    return project, recording, run


def _build_run_detail(run_id: str) -> DetectionRunDetail:
    _project, recording, run = _run_context(run_id)
    candidates = list_candidates(run_id)
    accepted_steps = build_accepted_steps(recording["slug"], candidates)
    return DetectionRunDetail(
        summary=_serialize_run_summary(run),
        candidates=[_serialize_candidate(candidate) for candidate in candidates],
        accepted_steps=accepted_steps,
        events=[_serialize_run_event(event) for event in list_run_events(run_id)],
        export_bundle=_serialize_export_bundle(get_export_bundle_for_run(run_id)),
        phases=[{"start_ms": start, "name": name} for start, name in list_run_phases(run_id)],
    )


def _apply_candidate_paths(candidates: list[dict[str, Any]], frames_path: Path) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for candidate in candidates:
        image_name = Path(candidate["image_path"]).name
        normalized.append({**candidate, "image_path": relative_data_path(frames_path / image_name)})
    return normalized


# Engines whose runs can still be opened, reviewed and exported, but not started. Their code lives at the
# git tag last-with-hybrid-v2.
RETIRED_ENGINES = {"scene_v1", "hybrid_v2"}


def _refuse_retired_engine(settings: RunSettings) -> None:
    if settings.analysis_engine in RETIRED_ENGINES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"The {settings.analysis_engine} engine has been retired. New runs use stable screens (stable_v3); "
                "earlier runs stay available to review and export."
            ),
        )


def _validate_run_settings_for_recording(recording: dict[str, Any], settings: RunSettings) -> None:
    _refuse_retired_engine(settings)
    resolve_stable_config(settings, fps=recording["fps"], width=recording["width"], height=recording["height"])


def _resequence_candidates(candidates: list[dict[str, Any]], added_ids: frozenset[str] = frozenset()) -> list[dict[str, Any]]:
    """Number the candidates of a run in time order again after steps were added by hand (``added_ids``).

    Only the added steps are linked to an earlier look-alike. The others keep the revisit links they have:
    the detector's test for a revisit is stricter than the image hashes compared here, and comparing every
    step again would link screens that only look alike.
    """
    kept_links = {
        candidate["id"]: (candidate.get("revisit_group_id"), candidate.get("similar_to_candidate_id"))
        for candidate in candidates
        if candidate["id"] not in added_ids
    }
    ordered_candidates = sorted(
        candidates,
        key=lambda candidate: (
            candidate["timestamp_ms"],
            candidate.get("detector_index", 0),
            1 if candidate.get("candidate_origin") == "manual" else 0,
            candidate["id"],
        ),
    )
    updated_at = utc_now()
    normalized: list[dict[str, Any]] = []
    for index, candidate in enumerate(ordered_candidates, start=1):
        normalized.append(
            {
                **candidate,
                "detector_index": index,
                "candidate_origin": candidate.get("candidate_origin") or "detected",
                "timestamp_tc": display_timecode(candidate["timestamp_ms"]),
                "scene_score": candidate.get("scene_score") or 0.0,
                "revisit_group_id": None,
                "similar_to_candidate_id": None,
                "similarity_distance": None,
                "score_breakdown": candidate.get("score_breakdown"),
                "updated_at": updated_at,
            }
        )
    annotated = annotate_candidate_similarity(normalized)
    by_id = {candidate["id"]: candidate for candidate in annotated}
    for candidate in annotated:
        if candidate["id"] in kept_links:
            candidate["revisit_group_id"], candidate["similar_to_candidate_id"] = kept_links[candidate["id"]]
    for candidate in annotated:
        earlier = by_id.get(candidate.get("similar_to_candidate_id") or "")
        if candidate["id"] in added_ids and earlier is not None:
            group = earlier.get("revisit_group_id") or f"revisit-{earlier['id'][:8]}"
            earlier["revisit_group_id"] = group
            candidate["revisit_group_id"] = group
    return annotated


def _run_artifact_paths(project: dict, recording: dict, run_id: str) -> tuple[Path, Path]:
    current_run_dir = run_dir(project["slug"], project["id"], recording["slug"], recording["id"], run_id)
    return current_run_dir, current_run_dir / "frames"


def _recording_video_path(recording: dict[str, Any]) -> Path:
    """The file every analysis, preview and screenshot uses: the working copy once it exists."""
    if recording.get("working_path"):
        working = absolute_data_path(recording["working_path"])
        if working.exists():
            return working
    return absolute_data_path(recording["source_path"])


def _ensure_recording_working_copy(
    project: dict[str, Any],
    recording: dict[str, Any],
    *,
    progress_callback: Callable[[float], None] | None = None,
    cancellation_callback: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    if recording.get("working_path") and absolute_data_path(recording["working_path"]).exists():
        return recording
    destination = working_copy_path(recording_dir(project["slug"], project["id"], recording["slug"], recording["id"]))
    ensure_working_copy(
        absolute_data_path(recording["source_path"]),
        destination,
        key=recording["id"],
        progress_callback=progress_callback,
        cancellation_callback=cancellation_callback,
    )
    metadata = probe_video(destination)
    return update_recording_media(
        recording["id"],
        working_path=relative_data_path(destination),
        duration_ms=metadata.duration_ms,
        width=metadata.width,
        height=metadata.height,
        fps=metadata.fps,
    ) or recording


def _announce_run(run_id: str) -> None:
    """Tell the shared accounts that a run changed by itself (an analysis ended), whoever started it."""
    try:
        project, recording, _run = _run_context(run_id)
    except HTTPException:
        return  # deleted meanwhile
    _announce("run", project_id=project["id"], recording_id=recording["id"], run_id=run_id)


def _prepare_recording_in_background(recording_id: str) -> None:
    try:
        project, recording = _recording_context(recording_id)
        _ensure_recording_working_copy(project, recording)
        _announce("project", project_id=project["id"], recording_id=recording_id)
    except (CancellationRequested, HTTPException):
        # deleted before or while its working copy was made
        logger.info("Stopped preparing recording %s: it was deleted", recording_id)
    except Exception:  # pragma: no cover - the first run retries and reports the error
        logger.exception("Background preparation failed for recording %s", recording_id)


def _start_background_ingest(recording_id: str) -> None:
    Thread(
        target=_prepare_recording_in_background,
        args=(recording_id,),
        name=f"stepthrough-ingest-{recording_id[:8]}",
        daemon=True,
    ).start()


def _run_detection_job(run_id: str) -> None:
    manager = _job_manager()
    temp_root: Path | None = None
    try:
        if not manager.has_free_slot():
            ahead = manager.runs_ahead(run_id)
            _set_run_state(
                run_id,
                status="queued",
                phase="queued",
                progress=0.0,
                message="Waiting for a free analysis slot" + (f" ({ahead} queued ahead)" if ahead else ""),
                level="info",
            )
        if not manager.wait_for_slot(run_id):
            raise CancellationRequested("Run ended before it started")
        project, recording, run = _run_context(run_id)
        settings = RunSettings(
            analysis_engine=run.get("analysis_engine") or "scene_v1",
            analysis_preset=run.get("analysis_preset") or "balanced",
            advanced=json.loads(run["analysis_advanced"]) if run.get("analysis_advanced") else None,
            stable=json.loads(run["analysis_stable"]) if run.get("analysis_stable") else None,
            tolerance=run["tolerance"],
            min_scene_gap_ms=run["min_scene_gap_ms"],
            sample_fps=run["sample_fps"],
            allow_high_fps_sampling=bool(run.get("allow_high_fps_sampling")),
            detector_mode=run["detector_mode"],
            extract_offset_ms=run["extract_offset_ms"],
        )
        if settings.analysis_engine in RETIRED_ENGINES:
            raise RuntimeError(f"The {settings.analysis_engine} engine has been retired and cannot run.")
        current_run_dir, target_frames_dir = _run_artifact_paths(project, recording, run_id)
        current_run_dir.mkdir(parents=True, exist_ok=True)

        frames_path = target_frames_dir
        frames_path.mkdir(parents=True, exist_ok=True)
        _set_run_state(
            run_id,
            status="running",
            phase="probing",
            progress=0.04,
            message="Preparing detection job",
            level="info",
            started_at=run.get("started_at") or utc_now(),
            completed_at=None,
        )

        last_ingest_bucket = -1

        def publish_ingest_progress(fraction: float) -> None:
            nonlocal last_ingest_bucket
            bucket = int(fraction * 10)
            if bucket == last_ingest_bucket:
                return
            last_ingest_bucket = bucket
            _set_run_state(
                run_id,
                status="running",
                phase="probing",
                progress=0.04 + (0.05 * fraction),
                message=f"Preparing a constant-frame-rate working copy ({round(fraction * 100)}%)",
                level="info",
            )

        recording = _ensure_recording_working_copy(
            project,
            recording,
            progress_callback=publish_ingest_progress,
            cancellation_callback=lambda: manager.is_cancelled(run_id),
        )

        # Store the fully resolved settings and the engine version with the run, so it can be reproduced.
        resolved = resolve_stable_config(
            settings, fps=recording["fps"], width=recording["width"], height=recording["height"]
        ).as_dict()
        update_run(run_id, analysis_config=json.dumps(resolved))

        video_path = _recording_video_path(recording)

        def publish_progress(phase: str, message: str, progress: float, level: str) -> None:
            _set_run_state(run_id, status="running", phase=phase, progress=progress, message=message, level=level)

        measured: dict[str, Any] = {}
        candidates = detect_candidates_stable(
            video_path=video_path,
            frames_dir=frames_path,
            duration_ms=recording["duration_ms"],
            fps=recording["fps"],
            settings=settings,
            width=recording["width"],
            height=recording["height"],
            report=measured,
            progress_callback=publish_progress,
            cancellation_callback=lambda: manager.is_cancelled(run_id),
        )
        if measured:
            update_run(run_id, analysis_config=json.dumps({**resolved, "measured": measured}))
        if manager.is_cancelled(run_id):
            raise CancellationRequested("Run cancelled")

        normalized_candidates = _apply_candidate_paths(candidates, target_frames_dir)

        replace_candidates(run_id, recording["id"], normalized_candidates)

        candidate_count = len(normalized_candidates)
        completion_message = f"Prepared {candidate_count} screenshot candidates, one per stable screen"

        _set_run_state(
            run_id,
            status="completed",
            phase="completed",
            progress=1.0,
            message=completion_message,
            level="success",
            candidate_count=candidate_count,
            completed_at=utc_now(),
        )
    except CancellationRequested as exc:
        _set_run_state(
            run_id,
            status="cancelled",
            phase="cancelled",
            message=str(exc),
            level="warning",
            completed_at=utc_now(),
        )
    except Exception as exc:  # pragma: no cover - exercised in runtime
        _set_run_state(
            run_id,
            status="failed",
            phase="failed",
            message=str(exc),
            level="error",
            completed_at=utc_now(),
        )
    finally:
        if temp_root is not None:
            shutil.rmtree(temp_root, ignore_errors=True)
        manager.finish(run_id)
        _announce_run(run_id)
        usage.analysis_finished(run_id, get_run(run_id))


@app.get("/", include_in_schema=False, response_model=None)
def root() -> dict[str, str] | FileResponse:
    if server_config.frontend_dir is not None:
        return FileResponse(server_config.frontend_dir / "index.html", headers={"Cache-Control": "no-cache"})
    return {"app": "stepthrough", "status": "ok"}


PUBLIC_OCR_MESSAGES = {
    "checking": "Checking whether text recognition is available.",
    "available": "Text recognition is available.",
    "unavailable": "Text recognition is not available on this server.",
}


@app.get("/health", response_model=HealthResponse)
def health(request: Request, user: MaybeUser) -> HealthResponse:
    """Whether the server can work. Anyone may ask (the login page and container health checks do), but on a
    server with logins only administrators get the details, which name folders and library versions."""
    diagnostics = app.state.tool_diagnostics
    ocr_state = _get_ocr_state()
    detailed = auth_mode(request) == "none" or (user is not None and user.is_admin)
    return HealthResponse(
        version=__version__,
        build=build_label(),
        ffmpeg_available=diagnostics.ffmpeg_available,
        ffprobe_available=diagnostics.ffprobe_available,
        ocr_status=ocr_state.status,
        ocr_available=ocr_state.available,
        missing_tools=list(diagnostics.missing_tools),
        message=diagnostics.message,
        ocr_message=ocr_state.message if detailed else PUBLIC_OCR_MESSAGES[ocr_state.status],
        ocr_warnings=list(ocr_state.warnings) if detailed else [],
    )


@app.get("/analysis/metadata", response_model=AnalysisMetadataResponse)
def analysis_metadata() -> AnalysisMetadataResponse:
    return AnalysisMetadataResponse(**serialize_analysis_metadata())


@app.post("/admin/reset-db", status_code=204)
def admin_reset_db(
    user: CurrentUser, confirm: str | None = Header(default=None, alias=ADMIN_CONFIRM_HEADER)
) -> Response:
    require_admin(user)
    if not server_config.allow_admin_reset:
        raise HTTPException(status_code=403, detail="Database reset is disabled on this server.")
    # A custom header forces a CORS preflight, so other websites cannot trigger this from a browser.
    if confirm != "reset-database":
        raise HTTPException(status_code=400, detail=f"Send the `{ADMIN_CONFIRM_HEADER}: reset-database` header to confirm.")
    reset_db()
    server_settings.load(server_config.max_concurrent_runs)
    app.state.job_manager = JobManager(max_concurrent_runs=server_settings.analyses_limit())
    return Response(status_code=204)


@app.post("/admin/recheck-ocr", status_code=204)
def admin_recheck_ocr(user: CurrentUser) -> Response:
    require_admin(user)
    _set_ocr_state(_checking_ocr_state())
    _start_background_ocr_probe()
    return Response(status_code=204)


@app.get("/me", response_model=UserResponse)
def me(user: CurrentUser) -> UserResponse:
    return user_response(user)


@app.get("/me/live")
async def live_changes(user: CurrentUser, after: int | None = None, epoch: str | None = None, wait: float = 25.0) -> dict:
    """What changed in a shared account after change number ``after``, and what its browsers are doing now. Waits up
    to ``wait`` seconds for a change before answering (a long poll), so a browser that asks again at once hears of
    each change within a moment, through any proxy."""
    if not user.is_shared:
        raise HTTPException(status_code=403, detail="Live changes are for shared accounts.")
    hub = _live()
    known = after if epoch == hub.epoch else None
    if known is not None:
        deadline = time.monotonic() + max(0.0, min(wait, 25.0))
        while hub.seq(user.id) <= known and time.monotonic() < deadline:
            await asyncio.sleep(0.25)
    answer = hub.snapshot(user.id, known)
    answer["pace"] = {"spread_ms": round(server_settings.value("live_spread_seconds") * 1000)}
    return answer


@app.put("/me/presence", status_code=204)
def live_presence(payload: PresenceUpdate, user: CurrentUser, client: SharedClient = None) -> Response:
    """What this browser is doing that the other browsers of its shared account should see, such as editing a
    step's notes; repeated while it lasts, an empty list when it ends."""
    if not user.is_shared:
        raise HTTPException(status_code=403, detail="Presence is for shared accounts.")
    if not client:
        raise HTTPException(status_code=400, detail=f"Send the {CLIENT_HEADER} header.")
    _live().set_presence(user.id, client, clean_targets(payload.targets))
    return Response(status_code=204)


@app.get("/me/run-settings", response_model=list[SavedRunSettingsResponse])
def my_run_settings(user: CurrentUser) -> list[SavedRunSettingsResponse]:
    """The settings this person saved for new runs, whichever computer they saved them on: their own defaults
    (no project) and theirs per project."""
    saved = []
    for row in list_saved_run_settings(user.id):
        try:
            saved.append(SavedRunSettingsResponse(**row))
        except ValidationError:
            continue  # saved by a version that allowed what this one does not; the defaults apply instead
    return saved


@app.put("/me/run-settings/default", response_model=SavedRunSettingsResponse)
def my_run_settings_save_default(
    settings: RunSettings, user: CurrentUser, client: SharedClient = None
) -> SavedRunSettingsResponse:
    _refuse_retired_engine(settings)
    saved = save_run_settings(user.id, None, settings)
    _announce("settings", user=user, client=client, accounts=_audience(None, user), changed=False)
    return SavedRunSettingsResponse(**saved)


@app.put("/me/run-settings/projects/{project_id}", response_model=SavedRunSettingsResponse)
def my_run_settings_save_for_project(
    project_id: str, settings: RunSettings, user: CurrentUser, client: SharedClient = None
) -> SavedRunSettingsResponse:
    # Viewers may keep their own settings for a project too: nobody else sees them.
    _project_for(project_id, user, "viewer")
    _refuse_retired_engine(settings)
    saved = save_run_settings(user.id, project_id, settings)
    # saved settings belong to the account, so only its own browsers need to hear of them
    _announce("settings", project_id=project_id, user=user, client=client, accounts=_audience(None, user), changed=False)
    return SavedRunSettingsResponse(**saved)


@app.delete("/me/run-settings/default", status_code=204)
def my_run_settings_forget_default(user: CurrentUser, client: SharedClient = None) -> Response:
    """Back to the factory settings for new runs: forget this person's own defaults."""
    forget_run_settings(user.id, None)
    _announce("settings", user=user, client=client, accounts=_audience(None, user), changed=False)
    return Response(status_code=204)


@app.delete("/me/run-settings/projects/{project_id}", status_code=204)
def my_run_settings_forget_for_project(project_id: str, user: CurrentUser, client: SharedClient = None) -> Response:
    """Forget what this person saved for a project: new runs there start from their own defaults again."""
    _project_for(project_id, user, "viewer")
    forget_run_settings(user.id, project_id)
    _announce("settings", project_id=project_id, user=user, client=client, accounts=_audience(None, user), changed=False)
    return Response(status_code=204)


@app.get("/projects", response_model=list[ProjectResponse])
def projects_index(user: CurrentUser) -> list[ProjectResponse]:
    # Administrators may open every project, but their list shows only the ones they belong to.
    return [_serialize_project(project) for project in list_projects(user.memberships)]


@app.post("/projects", response_model=ProjectResponse)
def projects_create(payload: ProjectCreate, user: CurrentUser, client: SharedClient = None) -> ProjectResponse:
    project = create_project(payload.name, owner_id=user.id)
    _announce("projects", project_id=project["id"], user=user, client=client)
    usage.record("project_created", user)
    return _serialize_project(get_project(project["id"]))


@app.patch("/projects/{project_id}", response_model=ProjectResponse)
def projects_update(
    project_id: str, payload: ProjectUpdate, user: CurrentUser, client: SharedClient = None
) -> ProjectResponse:
    project = _project_for(project_id, user, "owner")
    # In a shared account, a rename made from a name that someone else has changed since would undo theirs.
    if user.is_shared and payload.previous_name is not None and payload.previous_name != project["name"]:
        raise HTTPException(409, f"This project was renamed to “{project['name']}” in another browser meanwhile.")
    update_project_name(project_id, payload.name)
    _announce("projects", project_id=project_id, user=user, client=client)
    return _serialize_project(get_project(project_id))


@app.get("/projects/{project_id}")
def projects_show(project_id: str, user: CurrentUser) -> dict:
    project = _project_for(project_id, user, "viewer")
    return {
        "project": _serialize_project(project),
        "recordings": [_serialize_recording(recording) for recording in list_recordings(project_id)],
    }


@app.delete("/projects/{project_id}", status_code=204)
def projects_delete(project_id: str, user: CurrentUser, client: SharedClient = None) -> Response:
    project = _project_for(project_id, user, "owner")
    if project_has_active_runs(project_id):
        raise HTTPException(status_code=409, detail="Abort active runs before deleting this project")
    accounts = _audience(project_id, user)  # before its members go with it
    project_path = project_dir(project["slug"], project["id"])
    for recording in list_recordings(project_id):
        stop_working_copy(recording["id"])
    delete_project_record(project_id)
    shutil.rmtree(project_path, ignore_errors=True)
    _announce("project_deleted", project_id=project_id, client=client, accounts=accounts)
    return Response(status_code=204)


@app.post("/recordings/import", response_model=RecordingImportResponse)
async def recordings_import(
    user: CurrentUser,
    project_id: str = Form(...),
    filename: str | None = Form(default=None),
    file: UploadFile = File(...),
    client: SharedClient = None,
) -> RecordingImportResponse:
    _require_tools()
    project = _project_for(project_id, user, "owner")
    recording_id = uuid4().hex
    preferred_name = filename.strip() if filename else file.filename or "recording.mp4"
    sanitized_name = sanitize_filename(preferred_name)
    recording_slug = recording_slug_from_filename(sanitized_name)
    destination = recording_source_path(project["slug"], project_id, recording_slug, recording_id, sanitized_name)
    recording = None
    try:
        await save_upload_file(file, destination, max_bytes=server_config.max_upload_bytes)
        metadata = await run_in_threadpool(probe_video, destination)
        recording = create_recording(
            recording_id=recording_id,
            project_id=project_id,
            filename=destination.name,
            slug=recording_slug,
            source_path=relative_data_path(destination),
            duration_ms=metadata.duration_ms,
            width=metadata.width,
            height=metadata.height,
            fps=metadata.fps,
        )
    except UploadTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except VideoToolError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if recording is None:
            # nothing half-uploaded stays behind, whatever went wrong (a cancelled upload included)
            shutil.rmtree(destination.parent.parent, ignore_errors=True)
    _start_background_ingest(recording["id"])
    _announce("project", project_id=project_id, recording_id=recording_id, user=user, client=client)
    usage.record("recording_uploaded", user, minutes=round((metadata.duration_ms or 0) / 60000, 2))
    return _serialize_recording(recording)


@app.get("/recordings/{recording_id}", response_model=RecordingDetailResponse)
def recordings_show(recording_id: str, user: CurrentUser) -> RecordingDetailResponse:
    _project, recording = _recording_for(recording_id, user, "viewer")
    return RecordingDetailResponse(
        **_serialize_recording(recording).model_dump(),
        runs=[_serialize_run_summary(run) for run in list_runs(recording_id)],
    )


@app.patch("/recordings/{recording_id}", response_model=RecordingImportResponse)
def recordings_update(
    recording_id: str, payload: RecordingUpdate, user: CurrentUser, client: SharedClient = None
) -> RecordingImportResponse:
    project, recording = _recording_for(recording_id, user, "owner")
    if user.is_shared and payload.previous_filename is not None and payload.previous_filename != recording["filename"]:
        raise HTTPException(409, f"This video was renamed to “{recording['filename']}” in another browser meanwhile.")
    renamed = update_recording_filename(recording_id, sanitize_filename(payload.filename))
    _announce("project", project_id=project["id"], recording_id=recording_id, user=user, client=client)
    return _serialize_recording(renamed)


@app.delete("/recordings/{recording_id}", status_code=204)
def recordings_delete(recording_id: str, user: CurrentUser, client: SharedClient = None) -> Response:
    project, recording = _recording_for(recording_id, user, "owner")
    if recording_has_active_runs(recording_id):
        raise HTTPException(status_code=409, detail="Abort active runs before deleting this recording")
    recording_path = recording_dir(project["slug"], project["id"], recording["slug"], recording["id"])
    delete_recording_record(recording_id)
    # The working copy may still be in the making (it starts right after upload): stop it first, or it would
    # write into the folder after it is gone.
    if not stop_working_copy(recording_id):
        logger.warning("Preparation of deleted recording %s did not stop in time", recording_id)
    shutil.rmtree(recording_path, ignore_errors=True)
    _announce("project", project_id=project["id"], recording_id=recording_id, user=user, client=client)
    return Response(status_code=204)


@app.post("/recordings/{recording_id}/runs/manual", response_model=DetectionRunSummary)
def runs_create_manual(recording_id: str, user: CurrentUser, client: SharedClient = None) -> DetectionRunSummary:
    project, _recording = _recording_for(recording_id, user, "owner")
    run = create_run(recording_id, RunSettings())
    update_run(run["id"], status="completed", phase="completed", progress=1.0, message="Manual run")
    _emit_run_event(run["id"], phase="completed", level="info", message="Manual run created", progress=1.0)
    _announce("recording", project_id=project["id"], recording_id=recording_id, run_id=run["id"], user=user, client=client)
    return _serialize_run_summary(get_run(run["id"]))


@app.post("/recordings/{recording_id}/runs", response_model=DetectionRunSummary)
def runs_create(recording_id: str, settings: RunSettings, user: CurrentUser, client: SharedClient = None) -> DetectionRunSummary:
    _require_tools()
    project, recording = _recording_for(recording_id, user, "owner")
    settings = _lock_unavailable_ocr(settings)
    _validate_run_settings_for_recording(recording, settings)
    run = create_run(recording_id, settings)
    _emit_run_event(run["id"], phase="queued", level="info", message="Run queued", progress=0.0)
    usage.analysis_started(run["id"], user)
    _job_manager().start(run["id"], lambda: _run_detection_job(run["id"]))
    _announce("recording", project_id=project["id"], recording_id=recording_id, run_id=run["id"], user=user, client=client)
    return _serialize_run_summary(get_run(run["id"]))


@app.get("/runs/{run_id}", response_model=DetectionRunDetail)
def runs_show(run_id: str, user: CurrentUser) -> DetectionRunDetail:
    _run_for(run_id, user, "viewer")
    return _build_run_detail(run_id)


@app.patch("/runs/{run_id}", response_model=DetectionRunSummary)
def runs_update(run_id: str, payload: RunUpdate, user: CurrentUser, client: SharedClient = None) -> DetectionRunSummary:
    """Name a run, or take its name away; its number stays."""
    project, recording, run = _run_for(run_id, user, "owner")
    current = run.get("name") or ""
    # In a shared account, a rename made from a name that someone else has changed since would undo theirs.
    if user.is_shared and payload.previous_name is not None and payload.previous_name.strip() != current:
        shown = f"“{current}”" if current else f"run #{run.get('run_number')} again"
        raise HTTPException(409, f"This run was renamed to {shown} in another browser meanwhile.")
    rename_run(run_id, payload.name.strip() or None)
    _announce("run", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client)
    return _serialize_run_summary(get_run(run_id))


@app.get("/runs/{run_id}/pathway", response_model=PathwayResponse)
def runs_pathway(run_id: str, user: CurrentUser, detail: PathwayDetail = "screens") -> PathwayResponse:
    """The accepted steps of a run as the screens they show and the moves between them."""
    _project, recording, _run = _run_for(run_id, user, "viewer")
    candidates = list_candidates(run_id)
    pathway = build_pathway(build_accepted_steps(recording["slug"], candidates), candidates, detail, list_run_phases(run_id))
    for step in pathway["steps"]:
        step["image_url"] = asset_url(step["image_path"])
    return PathwayResponse(**pathway)


@app.post("/runs/{run_id}/pathway/merge")
def runs_pathway_merge(run_id: str, payload: PathwayMerge, user: CurrentUser, client: SharedClient = None) -> dict[str, list[str]]:
    """Stack the box of ``source_candidate_id`` onto the box of ``target_candidate_id``: every step of the source
    box, rejected ones included (they take part in the grouping), is linked to the target. Says which steps it
    changed, so a browser can take it back step by step (its undo)."""
    project, recording, _run = _run_for(run_id, user, "owner")
    changed: list[str] = []
    with _one_at_a_time(run_id), _busy(user, client, project["id"], run_id, "merging two screens in this task"):
        candidates = list_candidates(run_id)
        ids = {candidate["id"] for candidate in candidates}
        if payload.source_candidate_id not in ids or payload.target_candidate_id not in ids:
            raise HTTPException(status_code=422, detail="Choose two screens of the same run.")
        members = pathway_screen_members(candidates, payload.source_candidate_id, payload.detail)
        if payload.target_candidate_id not in members:
            set_candidate_screen_links(run_id, members, payload.target_candidate_id)
            changed = list(members)
    _announce("run", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client)
    usage.record("screens_merged", user)
    return {"changed": changed}


def _phases_answer(boundaries: list[tuple[int, str]]) -> dict[str, list[dict[str, Any]]]:
    return {"phases": [{"start_ms": start, "name": name} for start, name in boundaries]}


@app.put("/runs/{run_id}/phases")
def runs_set_phase(run_id: str, payload: PhaseUpdate, user: CurrentUser, client: SharedClient = None) -> dict[str, list[dict[str, Any]]]:
    """Name a stretch of steps as a phase of the walkthrough, or take it out of every phase (an empty name).
    Answers with every phase of the run after the change, so that a browser can take it back."""
    project, recording, _run = _run_for(run_id, user, "owner")
    with _one_at_a_time(run_id):
        steps = sorted(
            (candidate for candidate in list_candidates(run_id) if candidate["status"] == "accepted"),
            key=lambda candidate: (candidate["timestamp_ms"], candidate["detector_index"]),
        )
        position = {candidate["id"]: index for index, candidate in enumerate(steps)}

        def stretch(first_id: str, last_id: str) -> tuple[int, int | None]:
            """From the first step's moment up to the moment of the step after the last one (or the end)."""
            if first_id not in position or last_id not in position:
                raise HTTPException(status_code=422, detail="A phase runs from one accepted step of this run to another.")
            first, last = position[first_id], position[last_id]
            if first > last:
                raise HTTPException(status_code=422, detail="A phase cannot end before it starts.")
            following = steps[last + 1] if last + 1 < len(steps) else None
            return steps[first]["timestamp_ms"], following["timestamp_ms"] if following else None

        boundaries = list_run_phases(run_id)
        if payload.replacing is not None:
            boundaries = set_phase(boundaries, "", *stretch(payload.replacing.first_step, payload.replacing.last_step))
        boundaries = set_phase(boundaries, payload.name.strip(), *stretch(payload.first_step, payload.last_step))
        replace_run_phases(run_id, boundaries)
    _announce("run", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client)
    return _phases_answer(boundaries)


@app.put("/runs/{run_id}/phases/all")
def runs_restore_phases(run_id: str, payload: PhaseBoundariesUpdate, user: CurrentUser, client: SharedClient = None) -> dict[str, list[dict[str, Any]]]:
    """Put every phase of the run back as it was (a browser's undo). With ``expected``, only while the phases are
    still as that browser left them: in a shared account, a change someone else made since is not undone."""
    project, recording, _run = _run_for(run_id, user, "owner")
    with _one_at_a_time(run_id):
        current = list_run_phases(run_id)
        if payload.expected is not None and [(item.start_ms, item.name) for item in payload.expected] != current:
            raise HTTPException(status_code=409, detail="The phases were changed in another browser meanwhile, so they were left as they are.")
        boundaries = tidy_phases([(item.start_ms, item.name.strip()) for item in payload.phases])
        replace_run_phases(run_id, boundaries)
    _announce("run", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client)
    return _phases_answer(boundaries)


@app.post("/runs/{run_id}/pathway/figure", status_code=204)
def runs_pathway_figure(run_id: str, payload: PathwayFigureDownload, user: CurrentUser) -> Response:
    """A pathway figure was downloaded, for the usage report and, the first time, the progress report."""
    _run_for(run_id, user, "viewer")
    if usage.counts(user):
        mark_figure_downloaded(run_id)
        usage.record("figure_downloaded", user, format=payload.format)
    return Response(status_code=204)


@app.post("/runs/{run_id}/cancel", response_model=DetectionRunSummary)
def runs_cancel(run_id: str, user: CurrentUser, client: SharedClient = None) -> DetectionRunSummary:
    project, recording, run = _run_for(run_id, user, "owner")
    if run["status"] not in ACTIVE_RUN_STATUSES:
        raise HTTPException(status_code=409, detail="Only queued or running jobs can be aborted")
    # Record the request before signalling it: a queued run ends at once, and its final message must not be
    # overwritten by this one afterwards.
    update_run(run_id, message="Abort requested")
    _emit_run_event(
        run_id,
        phase=run.get("phase") or "queued",
        level="warning",
        message="Abort requested",
        progress=run.get("progress"),
    )
    _job_manager().request_cancel(run_id)
    _announce("run", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client)
    return _serialize_run_summary(get_run(run_id))


@app.delete("/runs/{run_id}", status_code=204)
def runs_delete(run_id: str, user: CurrentUser, client: SharedClient = None) -> Response:
    project, recording, run = _run_for(run_id, user, "owner")
    if run["status"] in ACTIVE_RUN_STATUSES:
        raise HTTPException(status_code=409, detail="Abort the run before deleting it")
    # after any change to its steps that is under way, so that nothing writes into it once it is gone
    with _one_at_a_time(run_id):
        run_path, _frames_path = _run_artifact_paths(project, recording, run_id)
        delete_run_record(run_id)
        shutil.rmtree(run_path, ignore_errors=True)
    _announce("recording", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client)
    return Response(status_code=204)


@app.websocket("/runs/{run_id}/events")
async def runs_events(run_id: str, websocket: WebSocket, user: MaybeUser) -> None:
    try:
        if user is None or is_cross_site(websocket, server_config.cors_origins):
            raise HTTPException(status_code=403)
        _run_for(run_id, user, "viewer")
    except HTTPException:
        # Closing before accepting refuses the handshake (HTTP 403), whether or not the run exists.
        await websocket.close(code=1008)
        return
    await websocket.accept()
    offset = 0
    try:
        while True:
            events, offset = _job_manager().get_events_since(run_id, offset)
            for event in events:
                await websocket.send_json(event)
            run = get_run(run_id)
            if run and run["status"] in TERMINAL_WEBSOCKET_STATES and not events:
                break
            await asyncio.sleep(0.4)
    except WebSocketDisconnect:
        return


@app.patch("/candidates/{candidate_id}", response_model=CandidateFrameResponse)
def candidates_update(
    candidate_id: str, payload: CandidateUpdate, user: CurrentUser, client: SharedClient = None
) -> CandidateFrameResponse:
    candidate = get_candidate(candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    run_id = candidate["run_id"]
    project, recording, _run = _run_for(run_id, user, "owner", not_found="Candidate not found")
    updates = payload.model_dump(exclude_none=True)
    expected = {field: updates.pop(f"previous_{field}", None) for field in ("title", "notes")}
    # for the usage report: which correction of the pathway this is, before "auto" becomes None below
    corrections = [
        *([{"auto": "automatic", "new": "new_screen"}.get(updates["screen_link"], "same_screen")] if "screen_link" in updates else []),
        *([{"auto": "popup_automatic", "screen": "not_popup", "popup": "popup"}[updates["screen_kind"]]] if "screen_kind" in updates else []),
    ]
    if "title" in updates:
        updates["title"] = updates["title"].strip() or None
    if "notes" in updates:
        updates["notes"] = updates["notes"].strip() or None
    with _one_at_a_time(run_id):
        candidate = get_candidate(candidate_id)
        if not candidate:
            raise HTTPException(status_code=404, detail="Candidate not found")
        if user.is_shared:
            # Text is not merged: someone else's title or notes, saved after this browser began, stay.
            for field, before in expected.items():
                if field in updates and before is not None and before.strip() != (candidate.get(field) or ""):
                    were = "was" if field == "title" else "were"
                    raise HTTPException(
                        status_code=409,
                        detail=f"The {field} of this step {were} changed in another browser meanwhile, so yours {were} not saved.",
                    )
        if "screen_link" in updates:
            link = updates["screen_link"]
            if link == "auto":
                updates["screen_link"] = None
            elif link != "new":
                other = get_candidate(link)
                if not other or other["run_id"] != candidate["run_id"] or other["id"] == candidate_id:
                    raise HTTPException(status_code=422, detail="Choose another step of the same run.")
        if updates.get("screen_kind") == "auto":
            updates["screen_kind"] = None
        if updates.get("pathway_row") == "auto":
            updates["pathway_row"] = None
        serialized = _serialize_candidate(update_candidate(candidate_id, **updates))
        if updates.get("status") in ("accepted", "rejected"):
            usage.record("step_decided", user, status=updates["status"])
        for choice in corrections:
            usage.record("screen_corrected", user, choice=choice)
        for field in ("title", "notes"):
            if updates.get(field):
                usage.record("step_annotated", user, field=field)
        # still in turn, so that the browsers hear of changes to one step in the order they were made
        _announce(
            "candidate",
            project_id=project["id"],
            recording_id=recording["id"],
            run_id=run_id,
            user=user,
            client=client,
            candidate=serialized.model_dump(mode="json"),
        )
    return serialized


@app.post("/runs/{run_id}/candidates/status", status_code=204)
def runs_set_candidate_status(
    run_id: str, payload: CandidateStatusUpdate, user: CurrentUser, client: SharedClient = None
) -> Response:
    """Accept, reject or reset several steps of a task at once: one change instead of one per step."""
    project, recording, _run = _run_for(run_id, user, "owner")
    with _one_at_a_time(run_id):
        known = {candidate["id"] for candidate in list_candidates(run_id)}
        wanted = list(dict.fromkeys(payload.candidate_ids))
        if any(candidate_id not in known for candidate_id in wanted):
            raise HTTPException(status_code=422, detail="Some of these steps are not in this task (any more).")
        set_candidate_statuses(run_id, wanted, payload.status)
        usage.record("steps_decided", user, status=payload.status, count=len(wanted))
        _announce("run", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client)
    return Response(status_code=204)


def _insert_manual_candidate(project: dict, recording: dict, run: dict, timestamp_ms: int) -> str:
    """Add a step by hand to a finished run at ``timestamp_ms``: a screenshot of that moment, pending review.
    Returns the new candidate's id."""
    run_id = run["id"]
    current_run_dir, frames_path = _run_artifact_paths(project, recording, run_id)
    current_run_dir.mkdir(parents=True, exist_ok=True)
    frames_path.mkdir(parents=True, exist_ok=True)

    candidate_id = uuid4().hex
    timestamp_tc = display_timecode(timestamp_ms)
    image_path = frames_path / f"manual-{candidate_id}__{slug_timecode(timestamp_ms)}.png"

    try:
        extract_frame(_recording_video_path(recording), image_path, timestamp_ms)
        fingerprint = fingerprint_image(image_path)
    except (VideoToolError, FileNotFoundError, OSError) as exc:
        image_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Could not add a manual step at {timestamp_tc}. Try seeking to a nearby frame.") from exc
    now = utc_now()
    manual_candidate = {
        "id": candidate_id,
        "run_id": run_id,
        "recording_id": recording["id"],
        "detector_index": 0,
        "candidate_origin": "manual",
        "timestamp_ms": timestamp_ms,
        "timestamp_tc": timestamp_tc,
        "image_path": relative_data_path(image_path),
        "scene_score": 0.0,
        "status": "pending",
        "title": None,
        "notes": None,
        "image_hash": hash_to_hex(fingerprint.average_hash),
        "perceptual_hash": hash_to_hex(fingerprint.perceptual_hash),
        "histogram_signature": histogram_to_string(fingerprint.histogram),
        "ocr_text": None,
        "score_breakdown": None,
        "revisit_group_id": None,
        "similar_to_candidate_id": None,
        "similarity_distance": None,
        "created_at": now,
        "updated_at": now,
    }

    try:
        updated_candidates = _resequence_candidates([*list_candidates(run_id), manual_candidate], frozenset({candidate_id}))
        replace_candidates(run_id, recording["id"], updated_candidates)
    except Exception:
        image_path.unlink(missing_ok=True)
        raise
    _emit_run_event(
        run_id,
        phase=run.get("phase") or "completed",
        level="info",
        message=f"Added manual step at {timestamp_tc}",
        progress=run.get("progress"),
    )
    return candidate_id


@app.post("/runs/{run_id}/candidates/manual", response_model=CandidateFrameResponse)
def runs_add_manual_candidate(
    run_id: str, payload: ManualCandidateCreate, user: CurrentUser, client: SharedClient = None
) -> CandidateFrameResponse:
    project, recording, run = _run_for(run_id, user, "owner")
    if run["status"] not in {"completed", "failed", "cancelled"}:
        raise HTTPException(status_code=409, detail="Manual steps can only be added to completed, failed, or cancelled runs")
    if payload.timestamp_ms >= recording["duration_ms"]:
        raise HTTPException(status_code=422, detail="Manual step timestamp must be inside the recording duration")
    # Adding a step renumbers every step: one change at a time, so no decision made meanwhile is written back.
    with _one_at_a_time(run_id), _busy(user, client, project["id"], run_id, "adding a step by hand to this task"):
        candidate_id = _insert_manual_candidate(project, recording, get_run(run_id) or run, payload.timestamp_ms)
        manual_row = next(candidate for candidate in list_candidates(run_id) if candidate["id"] == candidate_id)
    _announce("run", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client)
    usage.record("step_added", user)
    return _serialize_candidate(manual_row)


def _is_reviewed(candidate: dict) -> bool:
    return candidate["status"] != "pending" or bool(candidate.get("title")) or bool(candidate.get("notes"))


@app.post("/runs/{run_id}/review-from", response_model=ReviewCarryOverResult)
def runs_carry_over_review(run_id: str, payload: ReviewCarryOver, user: CurrentUser, client: SharedClient = None) -> ReviewCarryOverResult:
    """Bring the review of an earlier run of the same recording over to this one, after a run with other
    settings: decisions, titles, notes and screen choices go to the steps they were paired with (the pairs the
    comparison showed), and steps added by hand are added again. Only what is still empty here is filled in, so
    nothing done on this run is overwritten."""
    project, recording, run = _run_for(run_id, user, "owner")
    _source_project, source_recording, source_run = _run_for(payload.source_run_id, user, "owner")
    if source_run["id"] == run["id"]:
        raise HTTPException(status_code=422, detail="Choose another run to bring the review from.")
    if source_recording["id"] != recording["id"]:
        raise HTTPException(status_code=422, detail="Both runs must be of the same recording.")
    with _one_at_a_time(run_id), _busy(user, client, project["id"], run_id, "bringing the review of another run over to this task"):
        run = get_run(run_id) or run
        source_run = get_run(source_run["id"]) or source_run
        if run["status"] != "completed" or source_run["status"] != "completed":
            raise HTTPException(status_code=409, detail="Both runs must be completed.")

        source = {candidate["id"]: candidate for candidate in list_candidates(source_run["id"])}
        target_ids = {candidate["id"] for candidate in list_candidates(run_id)}
        pairs: dict[str, str] = {}
        used_targets: set[str] = set()
        for pair in payload.pairs:
            if pair.source_candidate_id not in source or pair.target_candidate_id not in target_ids:
                raise HTTPException(status_code=422, detail="A pair names a step that is not in these runs.")
            if pair.source_candidate_id in pairs or pair.target_candidate_id in used_targets:
                raise HTTPException(status_code=422, detail="Each step can be paired once.")
            pairs[pair.source_candidate_id] = pair.target_candidate_id
            used_targets.add(pair.target_candidate_id)

        # Steps added by hand have no counterpart among the detected ones: add them again at the same moment.
        added_manual = 0
        for candidate in sorted(source.values(), key=lambda item: item["timestamp_ms"]):
            if candidate["id"] in pairs or (candidate.get("candidate_origin") or "detected") != "manual":
                continue
            if candidate["timestamp_ms"] >= recording["duration_ms"]:
                continue
            pairs[candidate["id"]] = _insert_manual_candidate(project, recording, get_run(run_id) or run, candidate["timestamp_ms"])
            added_manual += 1

        targets = {candidate["id"]: candidate for candidate in list_candidates(run_id)}
        counts = {"decisions": 0, "titles": 0, "notes": 0, "screen_choices": 0}
        for source_id, target_id in pairs.items():
            before, after = source[source_id], targets[target_id]
            updates: dict[str, Any] = {}
            if after["status"] == "pending" and before["status"] in {"accepted", "rejected"}:
                updates["status"] = before["status"]
                counts["decisions"] += 1
            for field, counter in (("title", "titles"), ("notes", "notes")):
                if not after.get(field) and before.get(field):
                    updates[field] = before[field]
                    counts[counter] += 1
            choice = False
            if after.get("screen_kind") is None and before.get("screen_kind"):
                updates["screen_kind"] = before["screen_kind"]
                choice = True
            link = before.get("screen_link")
            if after.get("screen_link") is None and link:
                mapped = "new" if link == "new" else pairs.get(link)
                if mapped and mapped != target_id:
                    updates["screen_link"] = mapped
                    choice = True
            if after.get("pathway_row") is None and before.get("pathway_row"):
                updates["pathway_row"] = before["pathway_row"]
                choice = True
            counts["screen_choices"] += int(choice)
            if updates:
                update_candidate(target_id, **updates)

        # Phases go by the time in the recording, which both runs share; only to a run that has none of its own.
        phases = list_run_phases(source_run["id"])
        brought_phases = bool(phases) and not list_run_phases(run_id)
        if brought_phases:
            replace_run_phases(run_id, phases)

        unmatched = sum(1 for candidate in source.values() if candidate["id"] not in pairs and _is_reviewed(candidate))
        _emit_run_event(
            run_id,
            phase=run.get("phase") or "completed",
            level="info",
            message=f"Brought over the review of an earlier run ({counts['decisions']} decisions)",
            progress=run.get("progress"),
        )
        result = ReviewCarryOverResult(**counts, added_manual=added_manual, unmatched=unmatched, phases=brought_phases)
    _announce("run", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client)
    usage.record("review_carried_over", user)
    return result


@app.post("/runs/{run_id}/export")
def runs_export(run_id: str, payload: ExportRequest, user: CurrentUser, client: SharedClient = None) -> dict:
    project, recording, run = _run_for(run_id, user, "owner")
    # In a shared account every export stays downloadable for a while (app/export_cleanup.py), so that two people
    # exporting the same task at once each get their own.
    with _busy(user, client, project["id"], run_id, "exporting this task"):
        bundle = _export_run(project, recording, run, payload, retain=user.is_shared)
    _announce(
        "run", project_id=project["id"], recording_id=recording["id"], run_id=run_id, user=user, client=client, changed=False
    )
    usage.record("exported", user, mode=payload.mode, steps=bundle.get("item_count"))
    return bundle


def _export_run(project: dict, recording: dict, run: dict, payload: ExportRequest, *, retain: bool) -> dict:
    run_id = run["id"]
    if run["status"] != "completed":
        raise HTTPException(status_code=409, detail="Only completed runs can be exported")
    export_mode = payload.mode
    candidates = list_candidates(run_id)
    if export_mode == "auto":
        export_mode = "accepted" if any(candidate["status"] != "pending" for candidate in candidates) else "all"
        if export_mode == "accepted" and not any(candidate["status"] == "accepted" for candidate in candidates):
            raise HTTPException(400, "This reviewed task has no accepted candidates to export.")
    _set_run_state(
        run_id,
        status="completed",
        phase="exporting",
        progress=min(0.98, run.get("progress") or 0.98),
        message="Preparing export bundle",
        level="info",
    )
    bundle_id = uuid4().hex
    try:
        output_dir, zip_path, item_count = create_export_bundle(
            bundle_id=bundle_id,
            project=project,
            recording=recording,
            run=run,
            candidates=candidates,
            mode=export_mode,
            phases=list_run_phases(run_id),
        )
        bundle = create_export_bundle_record(run_id, output_dir, zip_path, item_count, bundle_id=bundle_id, retain=retain)
    except Exception as exc:
        run_path, _frames = _run_artifact_paths(project, recording, run_id)
        partial = run_path / "exports" / bundle_id
        shutil.rmtree(partial, ignore_errors=True)
        partial.with_suffix(".zip").unlink(missing_ok=True)
        _set_run_state(
            run_id,
            status="completed",
            phase="completed",
            progress=1.0,
            message=run.get("message") or "Export not created",
            level="info",
            emit_event=False,
        )
        if isinstance(exc, ValueError):
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        raise
    _set_run_state(
        run_id,
        status="completed",
        phase="completed",
        progress=1.0,
        message=(
            f"Exported {item_count} accepted walkthrough steps"
            if export_mode == "accepted"
            else f"Exported {item_count} screenshot candidates"
        ),
        level="success",
    )
    try:
        clear_old_exports(run_id, (DATA_ROOT / output_dir).parent)
    except Exception:  # the export itself is done; the hourly clean-up tries again
        logger.exception("Could not remove the replaced exports of run %s.", run_id)
    return _serialize_export_bundle(bundle)


@app.get("/exports/{bundle_id}/download")
def exports_download(bundle_id: str, user: CurrentUser) -> FileResponse:
    bundle = get_export_bundle(bundle_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Export bundle not found")
    _run_for(bundle["run_id"], user, "viewer", not_found="Export bundle not found")
    zip_path = DATA_ROOT / bundle["zip_path"]
    if not zip_path.exists():
        raise HTTPException(status_code=404, detail="Export archive missing on disk")
    return FileResponse(zip_path, media_type="application/zip", filename=zip_path.name)


@app.api_route("/assets/projects/{asset_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
def project_asset(asset_path: str, request: Request, user: CurrentUser) -> Response:
    """A project's media (recordings, previews, screenshots, exports), only for people who may open the project.

    The URL is the file's place under ``projects/``, whose first folder is ``{slug}-{id[:8]}``. Range requests
    work, so videos can be scrubbed. Browsers must check back each time (the answer depends on who asks), and
    get a short "not modified" when their copy is current."""
    folder, _, inside = asset_path.partition("/")
    slug, _, id_prefix = folder.rpartition("-")
    if inside and slug and id_prefix:
        for project in find_projects_by_folder(slug, id_prefix):
            if project_role(project["id"], user) is None:
                continue
            root = project_dir(project["slug"], project["id"]).resolve()
            path = (root / inside).resolve()
            if path.is_relative_to(root) and path.is_file():
                headers = {"Cache-Control": "private, no-cache"}
                response = FileResponse(path, headers=headers, stat_result=path.stat())
                if request.headers.get("if-none-match") == response.headers["etag"]:
                    return Response(status_code=304, headers={**headers, "ETag": response.headers["etag"]})
                return response
    raise HTTPException(status_code=404, detail="Not found")


class FrontendFiles(StaticFiles):
    """The built frontend. Vite puts a content hash in every asset name, so those can be cached for good;
    everything else (index.html, the icon) is revalidated so a new release shows up on the next load."""

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        immutable = path.startswith("assets/") and response.status_code == 200
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
        return response


def mount_frontend(target: FastAPI, directory: Path) -> None:
    # Mounted last, so every API route, `/assets/projects` media included, takes precedence.
    target.mount("/", FrontendFiles(directory=str(directory), html=True), name="frontend")


if server_config.frontend_dir is not None:
    mount_frontend(app, server_config.frontend_dir)
