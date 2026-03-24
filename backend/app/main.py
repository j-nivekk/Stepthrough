from __future__ import annotations

import asyncio
import json
import math
import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import DATA_ROOT, build_tool_diagnostics, ensure_app_dirs
from .database import init_db
from .models import (
    CandidateFrameResponse,
    CandidateUpdate,
    ExportRequest,
    DetectionRunDetail,
    DetectionRunSummary,
    HealthResponse,
    ManualCandidateCreate,
    ProjectCreate,
    ProjectResponse,
    ProjectUpdate,
    RecordingDetailResponse,
    RecordingImportResponse,
    RecordingUpdate,
    RunEventResponse,
    RunSettings,
)
from .repository import (
    ACTIVE_RUN_STATUSES,
    clear_export_bundle_for_run,
    create_export_bundle as create_export_bundle_record,
    create_project,
    create_recording,
    create_run,
    create_run_event,
    delete_project_record,
    delete_recording_record,
    delete_run_record,
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
    list_runs,
    project_has_active_runs,
    recording_has_active_runs,
    replace_candidates,
    update_candidate,
    update_project_name,
    update_recording_filename,
    update_run,
)
from .services.detection import (
    CancellationRequested,
    detect_candidates,
)
from .services.export import build_accepted_steps, create_export_bundle
from .services.hybrid_detection import detect_candidates_hybrid, probe_paddleocr_availability, resolve_hybrid_config
from .services.jobs import JobManager
from .services.similarity import annotate_candidate_similarity, fingerprint_image, hash_to_hex, histogram_to_string
from .services.video import (
    VideoToolError,
    display_timecode,
    extract_frame,
    probe_video,
    recording_slug_from_filename,
    save_upload_file,
    slug_timecode,
)
from .storage import (
    absolute_data_path,
    asset_url,
    project_dir,
    recording_dir,
    recording_source_path,
    relative_data_path,
    run_dir,
)
from .utils import sanitize_filename, utc_now

TERMINAL_WEBSOCKET_STATES = {"completed", "failed", "cancelled"}

app = FastAPI(title="Stepthrough API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    ensure_app_dirs()
    init_db()
    app.state.tool_diagnostics = build_tool_diagnostics()
    probe_paddleocr_availability.cache_clear()
    app.state.ocr_available, app.state.ocr_message = probe_paddleocr_availability()
    app.state.job_manager = JobManager()


app.mount("/assets", StaticFiles(directory=str(DATA_ROOT), check_dir=False), name="assets")


def _job_manager() -> JobManager:
    return app.state.job_manager


def _require_tools() -> None:
    diagnostics = app.state.tool_diagnostics
    if diagnostics.missing_tools:
        raise HTTPException(status_code=503, detail=diagnostics.message)


def _lock_unavailable_ocr(settings: RunSettings) -> RunSettings:
    if settings.analysis_engine != "hybrid_v2" or settings.advanced is None:
        return settings
    if getattr(app.state, "ocr_available", True):
        return settings
    if settings.advanced.enable_ocr is False and settings.advanced.ocr_backend is None:
        return settings
    return settings.model_copy(
        update={
            "advanced": settings.advanced.model_copy(
                update={
                    "enable_ocr": False,
                    "ocr_backend": None,
                }
            )
        }
    )


def _run_is_abortable(run: dict[str, Any]) -> bool:
    return run["status"] in ACTIVE_RUN_STATUSES


def _run_is_deletable(run: dict[str, Any]) -> bool:
    return run["status"] not in ACTIVE_RUN_STATUSES


def _serialize_project(row: dict) -> ProjectResponse:
    return ProjectResponse(**row)


def _serialize_run_summary(row: dict) -> DetectionRunSummary:
    advanced = None
    if isinstance(row.get("analysis_advanced"), str):
        advanced = json.loads(row["analysis_advanced"])
    elif row.get("analysis_advanced"):
        advanced = row["analysis_advanced"]
    return DetectionRunSummary(
        id=row["id"],
        recording_id=row["recording_id"],
        status=row["status"],
        phase=row.get("phase") or "queued",
        analysis_engine=row.get("analysis_engine") or "scene_v1",
        analysis_preset=row.get("analysis_preset") or "balanced",
        advanced=advanced,
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
        source_url=asset_url(row["source_path"]),
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
    run = update_run(run_id, **updates)
    if emit_event and message is not None and phase is not None:
        _emit_run_event(run_id, phase=phase, level=level, message=message, progress=progress)
    return run


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
    )


def _apply_candidate_paths(candidates: list[dict[str, Any]], frames_path: Path) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for candidate in candidates:
        image_name = Path(candidate["image_path"]).name
        normalized.append({**candidate, "image_path": relative_data_path(frames_path / image_name)})
    return normalized


def _sample_fps_guardrail(recording_fps: float, allow_high_fps_sampling: bool) -> tuple[int, bool]:
    source_ceiling = max(1, math.ceil(recording_fps or 30))
    if allow_high_fps_sampling:
        return source_ceiling, True
    return min(30, source_ceiling), source_ceiling <= 30


def _validate_run_settings_for_recording(recording: dict[str, Any], settings: RunSettings) -> None:
    if settings.analysis_engine == "hybrid_v2":
        resolve_hybrid_config(settings, recording["fps"])
        return

    max_sample_fps, source_allowed = _sample_fps_guardrail(recording["fps"], settings.allow_high_fps_sampling)
    if settings.sample_fps is None:
        if not source_allowed:
            raise HTTPException(
                status_code=422,
                detail="Source-fps sampling for recordings above 30 fps requires high-fps sampling to be enabled.",
            )
        return

    if settings.sample_fps > max_sample_fps:
        raise HTTPException(
            status_code=422,
            detail=f"Sample fps must be {max_sample_fps} or lower for this recording.",
        )


def _resequence_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
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
    return annotate_candidate_similarity(normalized)


def _run_artifact_paths(project: dict, recording: dict, run_id: str) -> tuple[Path, Path]:
    current_run_dir = run_dir(project["slug"], project["id"], recording["slug"], recording["id"], run_id)
    return current_run_dir, current_run_dir / "frames"


def _run_detection_job(run_id: str) -> None:
    manager = _job_manager()
    temp_root: Path | None = None
    try:
        detect_fn = detect_candidates
        project, recording, run = _run_context(run_id)
        settings = RunSettings(
            analysis_engine=run.get("analysis_engine") or "scene_v1",
            analysis_preset=run.get("analysis_preset") or "balanced",
            advanced=json.loads(run["analysis_advanced"]) if run.get("analysis_advanced") else None,
            tolerance=run["tolerance"],
            min_scene_gap_ms=run["min_scene_gap_ms"],
            sample_fps=run["sample_fps"],
            allow_high_fps_sampling=bool(run.get("allow_high_fps_sampling")),
            detector_mode=run["detector_mode"],
            extract_offset_ms=run["extract_offset_ms"],
        )
        if settings.analysis_engine == "hybrid_v2":
            detect_fn = detect_candidates_hybrid
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

        if settings.analysis_engine == "hybrid_v2":
            resolved_config = resolve_hybrid_config(settings, recording["fps"])
            update_run(run_id, analysis_config=json.dumps(resolved_config.__dict__))

        video_path = absolute_data_path(recording["source_path"])

        def publish_progress(phase: str, message: str, progress: float, level: str) -> None:
            _set_run_state(run_id, status="running", phase=phase, progress=progress, message=message, level=level)

        candidates = detect_fn(
            video_path=video_path,
            frames_dir=frames_path,
            duration_ms=recording["duration_ms"],
            fps=recording["fps"],
            settings=settings,
            progress_callback=publish_progress,
            cancellation_callback=lambda: manager.is_cancelled(run_id),
        )
        if manager.is_cancelled(run_id):
            raise CancellationRequested("Run cancelled")

        normalized_candidates = _apply_candidate_paths(candidates, target_frames_dir)

        replace_candidates(run_id, recording["id"], normalized_candidates)
        clear_export_bundle_for_run(run_id)

        candidate_count = len(normalized_candidates)
        completion_message = (
            f"Prepared {candidate_count} screenshot candidates with hybrid ui-change detection"
            if settings.analysis_engine == "hybrid_v2"
            else f"Prepared {candidate_count} screenshot candidates"
        )
        
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


@app.get("/")
def root() -> dict[str, str]:
    return {"app": "stepthrough", "status": "ok"}


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    diagnostics = app.state.tool_diagnostics
    return HealthResponse(
        ffmpeg_available=diagnostics.ffmpeg_available,
        ffprobe_available=diagnostics.ffprobe_available,
        ocr_available=getattr(app.state, "ocr_available", True),
        missing_tools=list(diagnostics.missing_tools),
        message=diagnostics.message,
        ocr_message=getattr(app.state, "ocr_message", "PaddleOCR availability has not been checked yet."),
    )


@app.get("/projects", response_model=list[ProjectResponse])
def projects_index() -> list[ProjectResponse]:
    return [_serialize_project(project) for project in list_projects()]


@app.post("/projects", response_model=ProjectResponse)
def projects_create(payload: ProjectCreate) -> ProjectResponse:
    project = create_project(payload.name)
    return _serialize_project(project)


@app.patch("/projects/{project_id}", response_model=ProjectResponse)
def projects_update(project_id: str, payload: ProjectUpdate) -> ProjectResponse:
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return _serialize_project(update_project_name(project_id, payload.name))


@app.get("/projects/{project_id}")
def projects_show(project_id: str) -> dict:
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "project": _serialize_project(project),
        "recordings": [_serialize_recording(recording) for recording in list_recordings(project_id)],
    }


@app.delete("/projects/{project_id}", status_code=204)
def projects_delete(project_id: str) -> Response:
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project_has_active_runs(project_id):
        raise HTTPException(status_code=409, detail="Abort active runs before deleting this project")
    project_path = project_dir(project["slug"], project["id"])
    delete_project_record(project_id)
    shutil.rmtree(project_path, ignore_errors=True)
    return Response(status_code=204)


@app.post("/recordings/import", response_model=RecordingImportResponse)
async def recordings_import(
    project_id: str = Form(...),
    filename: str | None = Form(default=None),
    file: UploadFile = File(...),
) -> RecordingImportResponse:
    _require_tools()
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    preferred_name = filename.strip() if filename else file.filename or "recording.mp4"
    sanitized_name = sanitize_filename(preferred_name)
    recording_slug = recording_slug_from_filename(sanitized_name)
    recording_id = uuid4().hex
    destination = recording_source_path(
        project["slug"],
        project["id"],
        recording_slug,
        recording_id,
        sanitized_name,
    )
    try:
        await save_upload_file(file, destination)
        metadata = probe_video(destination)
    except VideoToolError as exc:
        if destination.exists():
            destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

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
    return _serialize_recording(recording)


@app.get("/recordings/{recording_id}", response_model=RecordingDetailResponse)
def recordings_show(recording_id: str) -> RecordingDetailResponse:
    recording = get_recording(recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    return RecordingDetailResponse(
        **_serialize_recording(recording).model_dump(),
        runs=[_serialize_run_summary(run) for run in list_runs(recording_id)],
    )


@app.patch("/recordings/{recording_id}", response_model=RecordingImportResponse)
def recordings_update(recording_id: str, payload: RecordingUpdate) -> RecordingImportResponse:
    recording = get_recording(recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    return _serialize_recording(update_recording_filename(recording_id, sanitize_filename(payload.filename)))


@app.delete("/recordings/{recording_id}", status_code=204)
def recordings_delete(recording_id: str) -> Response:
    project, recording = _recording_context(recording_id)
    if recording_has_active_runs(recording_id):
        raise HTTPException(status_code=409, detail="Abort active runs before deleting this recording")
    recording_path = recording_dir(project["slug"], project["id"], recording["slug"], recording["id"])
    delete_recording_record(recording_id)
    shutil.rmtree(recording_path, ignore_errors=True)
    return Response(status_code=204)


@app.post("/recordings/{recording_id}/runs", response_model=DetectionRunSummary)
def runs_create(recording_id: str, settings: RunSettings) -> DetectionRunSummary:
    _require_tools()
    recording = get_recording(recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    settings = _lock_unavailable_ocr(settings)
    _validate_run_settings_for_recording(recording, settings)
    run = create_run(recording_id, settings)
    _emit_run_event(run["id"], phase="queued", level="info", message="Run queued", progress=0.0)
    _job_manager().start(run["id"], lambda: _run_detection_job(run["id"]))
    return _serialize_run_summary(get_run(run["id"]))


@app.get("/runs/{run_id}", response_model=DetectionRunDetail)
def runs_show(run_id: str) -> DetectionRunDetail:
    return _build_run_detail(run_id)


@app.post("/runs/{run_id}/cancel", response_model=DetectionRunSummary)
def runs_cancel(run_id: str) -> DetectionRunSummary:
    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] not in ACTIVE_RUN_STATUSES:
        raise HTTPException(status_code=409, detail="Only queued or running jobs can be aborted")
    _job_manager().request_cancel(run_id)
    _emit_run_event(
        run_id,
        phase=run.get("phase") or "queued",
        level="warning",
        message="Abort requested",
        progress=run.get("progress"),
    )
    update_run(run_id, message="Abort requested")
    return _serialize_run_summary(get_run(run_id))





@app.delete("/runs/{run_id}", status_code=204)
def runs_delete(run_id: str) -> Response:
    project, recording, run = _run_context(run_id)
    if run["status"] in ACTIVE_RUN_STATUSES:
        raise HTTPException(status_code=409, detail="Abort the run before deleting it")
    run_path, _frames_path = _run_artifact_paths(project, recording, run_id)
    delete_run_record(run_id)
    shutil.rmtree(run_path, ignore_errors=True)
    return Response(status_code=204)


@app.websocket("/runs/{run_id}/events")
async def runs_events(run_id: str, websocket: WebSocket) -> None:
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
def candidates_update(candidate_id: str, payload: CandidateUpdate) -> CandidateFrameResponse:
    candidate = get_candidate(candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    updates = payload.model_dump(exclude_none=True)
    if "title" in updates:
        updates["title"] = updates["title"].strip() or None
    if "notes" in updates:
        updates["notes"] = updates["notes"].strip() or None
    candidate = update_candidate(candidate_id, **updates)
    return _serialize_candidate(candidate)


@app.post("/runs/{run_id}/candidates/manual", response_model=CandidateFrameResponse)
def runs_add_manual_candidate(run_id: str, payload: ManualCandidateCreate) -> CandidateFrameResponse:
    project, recording, run = _run_context(run_id)
    if run["status"] not in {"completed", "failed", "cancelled"}:
        raise HTTPException(status_code=409, detail="Manual steps can only be added to completed, failed, or cancelled runs")
    if payload.timestamp_ms >= recording["duration_ms"]:
        raise HTTPException(status_code=422, detail="Manual step timestamp must be inside the recording duration")

    current_run_dir, frames_path = _run_artifact_paths(project, recording, run_id)
    current_run_dir.mkdir(parents=True, exist_ok=True)
    frames_path.mkdir(parents=True, exist_ok=True)

    candidate_id = uuid4().hex
    timestamp_ms = payload.timestamp_ms
    timestamp_tc = display_timecode(timestamp_ms)
    image_path = frames_path / f"manual-{candidate_id[:8]}__{slug_timecode(timestamp_ms)}.png"

    try:
        extract_frame(absolute_data_path(recording["source_path"]), image_path, timestamp_ms)
        fingerprint = fingerprint_image(image_path)
    except (VideoToolError, FileNotFoundError, OSError) as exc:
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

    updated_candidates = _resequence_candidates([*list_candidates(run_id), manual_candidate])
    replace_candidates(run_id, recording["id"], updated_candidates)
    clear_export_bundle_for_run(run_id)
    update_run(run_id, candidate_count=len(updated_candidates))
    _emit_run_event(
        run_id,
        phase=run.get("phase") or "completed",
        level="info",
        message=f"Added manual step at {timestamp_tc}",
        progress=run.get("progress"),
    )
    manual_row = next(candidate for candidate in list_candidates(run_id) if candidate["id"] == candidate_id)
    return _serialize_candidate(manual_row)


@app.post("/runs/{run_id}/export")
def runs_export(run_id: str, payload: ExportRequest) -> dict:
    project, recording, run = _run_context(run_id)
    if run["status"] != "completed":
        raise HTTPException(status_code=409, detail="Only completed runs can be exported")
    export_mode = payload.mode
    _set_run_state(
        run_id,
        status="completed",
        phase="exporting",
        progress=min(0.98, run.get("progress") or 0.98),
        message="Preparing export bundle",
        level="info",
    )
    candidates = list_candidates(run_id)
    bundle_id = uuid4().hex
    try:
        output_dir, zip_path, item_count = create_export_bundle(
            bundle_id=bundle_id,
            project=project,
            recording=recording,
            run=run,
            candidates=candidates,
            mode=export_mode,
        )
    except ValueError as exc:
        _set_run_state(
            run_id,
            status="completed",
            phase="completed",
            progress=1.0,
            message=run.get("message") or "Export not created",
            level="info",
            emit_event=False,
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    bundle = create_export_bundle_record(run_id, output_dir, zip_path, item_count)
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
    return _serialize_export_bundle(bundle)


@app.get("/exports/{bundle_id}/download")
def exports_download(bundle_id: str) -> FileResponse:
    bundle = get_export_bundle(bundle_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Export bundle not found")
    zip_path = DATA_ROOT / bundle["zip_path"]
    if not zip_path.exists():
        raise HTTPException(status_code=404, detail="Export archive missing on disk")
    return FileResponse(zip_path, media_type="application/zip", filename=zip_path.name)
