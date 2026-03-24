from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

CandidateStatus = Literal["pending", "accepted", "rejected"]
CandidateOrigin = Literal["detected", "manual"]
RunStatus = Literal["queued", "running", "awaiting_fallback", "completed", "failed", "cancelled"]
DetectorMode = Literal["content", "adaptive"]
ExportMode = Literal["accepted", "all"]
AnalysisEngine = Literal["scene_v1", "hybrid_v2"]
AnalysisPreset = Literal["subtle_ui", "balanced", "noise_resistant"]
OcrBackend = Literal["paddleocr"]
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
    ocr_available: bool
    missing_tools: list[str]
    message: str
    ocr_message: str


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ProjectResponse(BaseModel):
    id: str
    name: str
    slug: str
    created_at: str
    recording_count: int = 0
    run_count: int = 0
    last_activity_at: str


class HybridAdvancedSettings(BaseModel):
    sample_fps_override: float | None = Field(default=None, gt=0)
    min_dwell_ms: int | None = Field(default=None, ge=0, le=60_000)
    settle_window_ms: int | None = Field(default=None, ge=0, le=60_000)
    enable_ocr: bool = True
    ocr_backend: OcrBackend | None = "paddleocr"

    @model_validator(mode="after")
    def normalize(self) -> "HybridAdvancedSettings":
        if not self.enable_ocr:
            self.ocr_backend = None
        elif self.ocr_backend is None:
            self.ocr_backend = "paddleocr"
        return self


class RunSettings(BaseModel):
    analysis_engine: AnalysisEngine = "hybrid_v2"
    analysis_preset: AnalysisPreset = "balanced"
    advanced: HybridAdvancedSettings | None = None
    tolerance: float = Field(default=50, ge=1, le=100)
    min_scene_gap_ms: int = Field(default=900, ge=0, le=60_000)
    sample_fps: float | None = Field(default=4.0, gt=0)
    allow_high_fps_sampling: bool = False
    detector_mode: DetectorMode = "content"
    extract_offset_ms: int = Field(default=200, ge=0, le=10_000)

    @model_validator(mode="after")
    def normalize(self) -> "RunSettings":
        if self.analysis_engine == "scene_v1":
            self.advanced = None
        elif self.advanced is None:
            self.advanced = HybridAdvancedSettings()
        return self


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


class RecordingUpdate(BaseModel):
    filename: str = Field(min_length=1, max_length=240)


class ExportRequest(BaseModel):
    mode: ExportMode = "accepted"


class DetectionRunSummary(BaseModel):
    id: str
    recording_id: str
    status: RunStatus
    phase: RunPhase
    analysis_engine: AnalysisEngine = "scene_v1"
    analysis_preset: AnalysisPreset = "balanced"
    advanced: HybridAdvancedSettings | None = None
    detector_mode: DetectorMode
    tolerance: float
    min_scene_gap_ms: int
    sample_fps: float | None
    allow_high_fps_sampling: bool
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


class ChangedRegion(BaseModel):
    x: int
    y: int
    width: int
    height: int
    score: float


class CandidateScoreBreakdown(BaseModel):
    visual: float
    text: float
    motion: float
    changed_regions: list[ChangedRegion] = Field(default_factory=list)


class CandidateFrameResponse(BaseModel):
    id: str
    run_id: str
    recording_id: str
    detector_index: int
    candidate_origin: CandidateOrigin
    timestamp_ms: int
    timestamp_tc: str
    image_path: str
    image_url: str
    scene_score: float
    status: CandidateStatus
    title: str | None = None
    notes: str | None = None
    score_breakdown: CandidateScoreBreakdown | None = None
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
    score_breakdown: CandidateScoreBreakdown | None = None
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


class ManualCandidateCreate(BaseModel):
    timestamp_ms: int = Field(ge=0)
