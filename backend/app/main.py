from __future__ import annotations

import asyncio
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
    DetectionRunDetail,
    DetectionRunSummary,
    HealthResponse,
    ProjectCreate,
    ProjectResponse,
    RecordingDetailResponse,
    RecordingImportResponse,
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
    recording_has_active_runs,
    replace_candidates,
    update_candidate,
    update_run,
)
from .services.detection import (
    CancellationRequested,
    build_sensitive_fallback_settings,
    detect_candidates,
    should_request_fallback,
)
from .services.export import build_accepted_steps, create_export_bundle
from .services.jobs import JobManager
from .services.video import (
    VideoToolError,
    display_timecode,
    probe_video,
    recording_slug_from_filename,
    save_upload_file,
)
from .storage import (
    absolute_data_path,
    asset_url,
    recording_dir,
    recording_source_path,
    relative_data_path,
    run_dir,
)
from .utils import sanitize_filename, utc_now

TERMINAL_WEBSOCKET_STATES = {"completed", "failed", "cancelled", "awaiting_fallback"}

app = FastAPI(title="Stepthrough API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    ensure_app_dirs()
    init_db()
    app.state.tool_diagnostics = build_tool_diagnostics()
    app.state.job_manager = JobManager()


app.mount("/assets", StaticFiles(directory=str(DATA_ROOT), check_dir=False), name="assets")


def _job_manager() -> JobManager:
    return app.state.job_manager


def _require_tools() -> None:
    diagnostics = app.state.tool_diagnostics
    if diagnostics.missing_tools:
        raise HTTPException(status_code=503, detail=diagnostics.message)


def _run_is_abortable(run: dict[str, Any]) -> bool:
    return run["status"] in ACTIVE_RUN_STATUSES


def _run_is_deletable(run: dict[str, Any]) -> bool:
    return run["status"] not in ACTIVE_RUN_STATUSES


def _run_needs_fallback(run: dict[str, Any]) -> bool:
    return run["status"] == "awaiting_fallback"


def _serialize_project(row: dict) -> ProjectResponse:
    return ProjectResponse(**row)


def _serialize_run_summary(row: dict) -> DetectionRunSummary:
    return DetectionRunSummary(
        id=row["id"],
        recording_id=row["recording_id"],
        status=row["status"],
        phase=row.get("phase") or "queued",
        detector_mode=row["detector_mode"],
        tolerance=row["tolerance"],
        min_scene_gap_ms=row["min_scene_gap_ms"],
        sample_fps=row["sample_fps"],
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
        needs_fallback_decision=_run_needs_fallback(row),
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
    return CandidateFrameResponse(
        id=row["id"],
        run_id=row["run_id"],
        recording_id=row["recording_id"],
        detector_index=row["detector_index"],
        timestamp_ms=row["timestamp_ms"],
        timestamp_tc=row["timestamp_tc"],
        image_path=row["image_path"],
        image_url=asset_url(row["image_path"]),
        scene_score=row["scene_score"],
        status=row["status"],
        title=row.get("title"),
        notes=row.get("notes"),
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


def _run_artifact_paths(project: dict, recording: dict, run_id: str) -> tuple[Path, Path]:
    current_run_dir = run_dir(project["slug"], project["id"], recording["slug"], recording["id"], run_id)
    return current_run_dir, current_run_dir / "frames"


def _run_detection_job(run_id: str, *, stage: str = "primary") -> None:
    manager = _job_manager()
    temp_root: Path | None = None
    try:
        project, recording, run = _run_context(run_id)
        base_settings = RunSettings(
            tolerance=run["tolerance"],
            min_scene_gap_ms=run["min_scene_gap_ms"],
            sample_fps=run["sample_fps"],
            detector_mode=run["detector_mode"],
            extract_offset_ms=run["extract_offset_ms"],
        )
        settings = build_sensitive_fallback_settings(base_settings) if stage == "fallback" else base_settings
        current_run_dir, target_frames_dir = _run_artifact_paths(project, recording, run_id)
        current_run_dir.mkdir(parents=True, exist_ok=True)

        if stage == "fallback":
            temp_root = current_run_dir / "_fallback_work"
            shutil.rmtree(temp_root, ignore_errors=True)
            frames_path = temp_root / "frames"
            frames_path.mkdir(parents=True, exist_ok=True)
            _set_run_state(
                run_id,
                status="running",
                phase="probing",
                progress=0.68,
                message="Starting sensitive fallback detection",
                level="warning",
                completed_at=None,
            )
        else:
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

        video_path = absolute_data_path(recording["source_path"])

        def publish_progress(phase: str, message: str, progress: float, level: str) -> None:
            _set_run_state(run_id, status="running", phase=phase, progress=progress, message=message, level=level)

        candidates = detect_candidates(
            video_path=video_path,
            frames_dir=frames_path,
            duration_ms=recording["duration_ms"],
            fps=recording["fps"],
            settings=settings,
            stage="fallback" if stage == "fallback" else "primary",
            progress_callback=publish_progress,
            cancellation_callback=lambda: manager.is_cancelled(run_id),
        )
        if manager.is_cancelled(run_id):
            raise CancellationRequested("Run cancelled")

        if stage == "fallback":
            shutil.rmtree(target_frames_dir, ignore_errors=True)
            shutil.move(str(frames_path), str(target_frames_dir))
            normalized_candidates = _apply_candidate_paths(candidates, target_frames_dir)
        else:
            normalized_candidates = _apply_candidate_paths(candidates, target_frames_dir)

        replace_candidates(run_id, recording["id"], normalized_candidates)
        clear_export_bundle_for_run(run_id)

        candidate_count = len(normalized_candidates)
        if stage == "primary" and should_request_fallback(candidate_count):
            _set_run_state(
                run_id,
                status="awaiting_fallback",
                phase="awaiting_fallback",
                progress=0.66,
                message="Primary detection found only the opening frame. Review it or run a sensitive fallback.",
                level="warning",
                candidate_count=candidate_count,
            )
        else:
            completion_message = (
                f"Sensitive fallback prepared {candidate_count} screenshot candidates"
                if stage == "fallback"
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
        missing_tools=list(diagnostics.missing_tools),
        message=diagnostics.message,
    )


@app.get("/projects", response_model=list[ProjectResponse])
def projects_index() -> list[ProjectResponse]:
    return [_serialize_project(project) for project in list_projects()]


@app.post("/projects", response_model=ProjectResponse)
def projects_create(payload: ProjectCreate) -> ProjectResponse:
    project = create_project(payload.name)
    return _serialize_project(project)


@app.get("/projects/{project_id}")
def projects_show(project_id: str) -> dict:
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "project": _serialize_project(project),
        "recordings": [_serialize_recording(recording) for recording in list_recordings(project_id)],
    }


@app.post("/recordings/import", response_model=RecordingImportResponse)
async def recordings_import(project_id: str = Form(...), file: UploadFile = File(...)) -> RecordingImportResponse:
    _require_tools()
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    sanitized_name = sanitize_filename(file.filename or "recording.mp4")
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
    run = create_run(recording_id, settings)
    _emit_run_event(run["id"], phase="queued", level="info", message="Run queued", progress=0.0)
    _job_manager().start(run["id"], lambda: _run_detection_job(run["id"], stage="primary"))
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


@app.post("/runs/{run_id}/fallback", response_model=DetectionRunSummary)
def runs_start_fallback(run_id: str) -> DetectionRunSummary:
    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] != "awaiting_fallback":
        raise HTTPException(status_code=409, detail="Sensitive fallback is only available while awaiting fallback")
    _set_run_state(
        run_id,
        status="running",
        phase="probing",
        progress=0.68,
        message="Queued sensitive fallback pass",
        level="warning",
        completed_at=None,
    )
    _job_manager().start(run_id, lambda: _run_detection_job(run_id, stage="fallback"))
    return _serialize_run_summary(get_run(run_id))


@app.post("/runs/{run_id}/fallback/dismiss", response_model=DetectionRunSummary)
def runs_dismiss_fallback(run_id: str) -> DetectionRunSummary:
    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] != "awaiting_fallback":
        raise HTTPException(status_code=409, detail="Fallback can only be dismissed while awaiting fallback")
    _set_run_state(
        run_id,
        status="completed",
        phase="completed",
        progress=1.0,
        message="Kept the primary detection result without running sensitive fallback.",
        level="success",
        completed_at=utc_now(),
    )
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


@app.post("/runs/{run_id}/export")
def runs_export(run_id: str) -> dict:
    project, recording, run = _run_context(run_id)
    if run["status"] != "completed":
        raise HTTPException(status_code=409, detail="Only completed runs can be exported")
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
        message=f"Exported {item_count} accepted walkthrough steps",
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
