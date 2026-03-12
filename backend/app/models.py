from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

CandidateStatus = Literal["pending", "accepted", "rejected"]
RunStatus = Literal["queued", "running", "awaiting_fallback", "completed", "failed", "cancelled"]
DetectorMode = Literal["content", "adaptive"]
RunPhase = Literal[
    "queued",
    "probing",
    "primary_scan",
    "primary_extract",
    "awaiting_fallback",
    "fallback_scan",
    "fallback_extract",
    "exporting",
    "completed",
    "failed",
    "cancelled",
]
RunEventLevel = Literal["info", "warning", "error", "success"]


class HealthResponse(BaseModel):
    ffmpeg_available: bool
    ffprobe_available: bool
    missing_tools: list[str]
    message: str


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ProjectResponse(BaseModel):
    id: str
    name: str
    slug: str
    created_at: str
    recording_count: int = 0
    run_count: int = 0
    last_activity_at: str


class RunSettings(BaseModel):
    tolerance: float = Field(default=50, ge=0, le=100)
    min_scene_gap_ms: int = Field(default=900, ge=0, le=60_000)
    sample_fps: float | None = Field(default=4.0, gt=0, le=30)
    detector_mode: DetectorMode = "content"
    extract_offset_ms: int = Field(default=200, ge=0, le=10_000)


class RecordingImportResponse(BaseModel):
    id: str
    project_id: str
    filename: str
    slug: str
    source_url: str
    duration_ms: int
    duration_tc: str
    width: int
    height: int
    fps: float
    created_at: str


class DetectionRunSummary(BaseModel):
    id: str
    recording_id: str
    status: RunStatus
    phase: RunPhase
    detector_mode: DetectorMode
    tolerance: float
    min_scene_gap_ms: int
    sample_fps: float | None
    extract_offset_ms: int
    progress: float
    message: str | None = None
    candidate_count: int = 0
    accepted_count: int = 0
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None
    updated_at: str
    export_bundle_id: str | None = None
    is_abortable: bool
    is_deletable: bool
    needs_fallback_decision: bool


class CandidateFrameResponse(BaseModel):
    id: str
    run_id: str
    recording_id: str
    detector_index: int
    timestamp_ms: int
    timestamp_tc: str
    image_path: str
    image_url: str
    scene_score: float
    status: CandidateStatus
    title: str | None = None
    notes: str | None = None
    revisit_group_id: str | None = None
    similar_to_candidate_id: str | None = None
    similarity_distance: float | None = None
    created_at: str
    updated_at: str


class AcceptedStepResponse(BaseModel):
    step_id: str
    step_index: int
    timestamp_ms: int
    timestamp_tc: str
    image_path: str
    image_url: str
    status: CandidateStatus
    title: str
    notes: str | None = None
    scene_score: float
    revisit_group_id: str | None = None
    similar_to_step_id: str | None = None
    source_candidate_id: str
    export_filename: str


class ExportBundleResponse(BaseModel):
    id: str
    run_id: str
    output_dir: str
    zip_path: str
    zip_url: str
    item_count: int
    created_at: str


class RunEventResponse(BaseModel):
    id: str
    run_id: str
    phase: RunPhase
    level: RunEventLevel
    message: str
    progress: float | None = None
    created_at: str


class DetectionRunDetail(BaseModel):
    summary: DetectionRunSummary
    candidates: list[CandidateFrameResponse]
    accepted_steps: list[AcceptedStepResponse]
    events: list[RunEventResponse]
    export_bundle: ExportBundleResponse | None = None


class RecordingDetailResponse(BaseModel):
    id: str
    project_id: str
    filename: str
    slug: str
    source_url: str
    duration_ms: int
    duration_tc: str
    width: int
    height: int
    fps: float
    created_at: str
    runs: list[DetectionRunSummary]


class CandidateUpdate(BaseModel):
    status: CandidateStatus | None = None
    title: str | None = Field(default=None, max_length=240)
    notes: str | None = Field(default=None, max_length=2_000)
