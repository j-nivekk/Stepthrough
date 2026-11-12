from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

CandidateStatus = Literal["pending", "accepted", "rejected"]
CandidateOrigin = Literal["detected", "manual"]
RunStatus = Literal["queued", "running", "awaiting_fallback", "completed", "failed", "cancelled"]
DetectorMode = Literal["content", "adaptive"]
ExportMode = Literal["accepted", "all"]
PathwayDetail = Literal["screens", "steps"]
# scene_v1 and hybrid_v2 are retired: their stored runs still load, review and export, but only stable_v3 runs.
AnalysisEngine = Literal["scene_v1", "hybrid_v2", "stable_v3"]
RecordingType = Literal["phone", "desktop"]
ScrollMode = Literal["each_stop", "merge"]
AnalysisPreset = Literal["subtle_ui", "balanced", "noise_resistant"]
OcrBackend = Literal["paddleocr"]
OcrStatus = Literal["checking", "available", "unavailable"]
TransitionType = Literal[
    "navigation",
    "scroll",
    "feed_card_swap",
    "modal",
    "modal_close",
    "content_update",
    "small_ui_change",
    "text_entry",
    "opening_screen",
    "unknown",
]
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
    # The app's version, and for builds of the main branch which one (`edge 80892ff`); None for releases.
    version: str
    build: str | None = None
    ffmpeg_available: bool
    ffprobe_available: bool
    ocr_status: OcrStatus
    ocr_available: bool | None
    missing_tools: list[str]
    message: str
    ocr_message: str
    ocr_warnings: list[str]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class UserResponse(BaseModel):
    id: str
    name: str
    display_name: str | None = None
    tags: list[str] = []
    is_admin: bool = False
    # The date (YYYY-MM-DD) from which this account and the projects only it owns are deleted.
    delete_after: str | None = None


AuthModeName = Literal["none", "password"]
LinkPurpose = Literal["invite", "reset"]


class SessionResponse(BaseModel):
    """How this server recognises people, and who is logged in (``None``: nobody, so show the login page)."""

    mode: AuthModeName
    user: UserResponse | None = None
    # Logins are on but no account has a password yet, so nobody can log in: the login page explains what to do.
    setup_needed: bool = False


class LoginRequest(BaseModel):
    name: str = Field(max_length=200)
    password: str = Field(max_length=1024)


class LinkRequest(BaseModel):
    token: str = Field(max_length=200)


class LinkDetailsResponse(BaseModel):
    name: str
    display_name: str | None = None
    purpose: LinkPurpose


class LinkPasswordRequest(BaseModel):
    token: str = Field(max_length=200)
    password: str = Field(max_length=1024)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(max_length=1024)
    new_password: str = Field(max_length=1024)


class UserLinkResponse(BaseModel):
    """A one-time link to set a password. The page builds the address as ``<its own origin>/#link=<token>``."""

    token: str
    purpose: LinkPurpose
    expires_at: str


class AdminUserResponse(UserResponse):
    is_builtin: bool = False
    is_disabled: bool = False
    has_password: bool = False
    # An unused link is waiting for this person (``invite`` or ``reset``), or ``None``.
    open_link: LinkPurpose | None = None
    notes: str | None = None
    project_count: int = 0
    created_at: str
    last_seen_at: str | None = None


class AdminUserCreate(BaseModel):
    name: str = Field(max_length=200)
    display_name: str | None = Field(default=None, max_length=200)
    tags: list[str] = []
    delete_after: str | None = None
    notes: str | None = Field(default=None, max_length=2000)


class AdminUserCreated(BaseModel):
    user: AdminUserResponse
    link: UserLinkResponse


class AdminUserUpdate(BaseModel):
    """Only the fields that are sent change; send ``delete_after: null`` to keep an account for good."""

    display_name: str | None = Field(default=None, max_length=200)
    tags: list[str] | None = None
    is_disabled: bool | None = None
    delete_after: str | None = None
    notes: str | None = Field(default=None, max_length=2000)


class UserImportCreated(BaseModel):
    name: str
    link: UserLinkResponse | None = None


class UserImportProblem(BaseModel):
    row: int
    name: str | None = None
    message: str


class UserImportResponse(BaseModel):
    created: list[UserImportCreated] = []
    existing: list[str] = []
    errors: list[UserImportProblem] = []
    # Passwords from the list are kept as given; these would be refused as new passwords.
    weak_passwords: list[str] = []


class UserDeletedResponse(BaseModel):
    deleted_projects: list[str] = []


class ProjectTransferRequest(BaseModel):
    to_user_id: str


class ProjectTransferResponse(BaseModel):
    moved: int


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
    proposal_threshold: float | None = Field(default=None, ge=0.0, le=1.0, allow_inf_nan=False)
    settle_threshold: float | None = Field(default=None, ge=0.0, le=1.0, allow_inf_nan=False)
    ocr_trigger_threshold: float | None = Field(default=None, ge=0.0, le=1.0, allow_inf_nan=False)
    enable_ocr: bool = True
    ocr_backend: OcrBackend | None = "paddleocr"

    @model_validator(mode="after")
    def normalize(self) -> "HybridAdvancedSettings":
        if not self.enable_ocr:
            self.ocr_backend = None
        elif self.ocr_backend is None:
            self.ocr_backend = "paddleocr"
        return self


class IgnoreRegion(BaseModel):
    """A box the stable engine ignores, as shares (0 to 1) of the working copy's width and height."""

    x: float = Field(ge=0.0, lt=1.0, allow_inf_nan=False)
    y: float = Field(ge=0.0, lt=1.0, allow_inf_nan=False)
    width: float = Field(gt=0.0, le=1.0, allow_inf_nan=False)
    height: float = Field(gt=0.0, le=1.0, allow_inf_nan=False)

    @model_validator(mode="after")
    def clip(self) -> "IgnoreRegion":
        self.width = round(min(self.width, 1.0 - self.x), 4)
        self.height = round(min(self.height, 1.0 - self.y), 4)
        self.x, self.y = round(self.x, 4), round(self.y, 4)
        return self


class StableSettings(BaseModel):
    """Settings of the stable-screen engine. ``None`` means "use the recording type's default"."""

    recording_type: RecordingType = "phone"
    min_dwell_ms: int | None = Field(default=None, ge=100, le=10_000)
    min_change_percent: float | None = Field(default=None, ge=0.01, le=25.0, allow_inf_nan=False)
    ignore_regions: list[IgnoreRegion] = Field(default_factory=list, max_length=16)
    ignore_status_bar: bool | None = None
    scroll_mode: ScrollMode = "each_stop"
    group_typing: bool = True
    include_opening_screen: bool = True
    enable_ocr: bool = False
    sensitivity: float | None = Field(default=None, ge=1.0, le=20.0, allow_inf_nan=False)
    sample_fps: float | None = Field(default=None, ge=2.0, le=30.0, allow_inf_nan=False)


class RunSettings(BaseModel):
    analysis_engine: AnalysisEngine = "stable_v3"
    analysis_preset: AnalysisPreset = "balanced"
    advanced: HybridAdvancedSettings | None = None
    stable: StableSettings | None = None
    tolerance: float = Field(default=50, ge=1, le=100)
    min_scene_gap_ms: int = Field(default=900, ge=0, le=60_000)
    sample_fps: float | None = Field(default=4.0, gt=0)
    allow_high_fps_sampling: bool = False
    detector_mode: DetectorMode = "content"
    extract_offset_ms: int = Field(default=200, ge=0, le=10_000)

    @model_validator(mode="after")
    def normalize(self) -> "RunSettings":
        if self.analysis_engine == "stable_v3":
            self.advanced = None
            if self.stable is None:
                self.stable = StableSettings()
            return self
        self.stable = None
        if self.analysis_engine == "scene_v1":
            self.advanced = None
        elif self.advanced is None:
            self.advanced = HybridAdvancedSettings()
        return self


class SavedRunSettingsResponse(BaseModel):
    """Settings someone saved to start new runs from: their own defaults (``project_id`` None) or theirs for one
    project."""

    project_id: str | None
    settings: RunSettings
    saved_at: str


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
    stable: StableSettings | None = None
    analysis_config: dict[str, Any] | None = None
    engine_version: str | None = None
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
    scroll_dx: float | None = None
    scroll_dy: float | None = None
    scroll_confidence: float | None = None
    chrome_change: float | None = None
    content_change: float | None = None
    transition_type: TransitionType | None = None
    dwell_before_ms: int | None = None
    dwell_after_ms: int | None = None
    event_start_ms: int | None = None
    event_end_ms: int | None = None
    grouped_states: int | None = None


class AnalysisControlMetadataResponse(BaseModel):
    supported: bool
    reason: str | None = None
    note: str | None = None


class StableRecordingTypeMetadataResponse(BaseModel):
    label: str
    description: str
    min_dwell_ms: int
    min_change_percent: float
    ignore_status_bar: bool


class AnalysisMetadataResponse(BaseModel):
    stable_recording_types: dict[RecordingType, StableRecordingTypeMetadataResponse] = Field(default_factory=dict)
    stable_engine_version: str | None = None
    controls_by_engine: dict[AnalysisEngine, dict[str, AnalysisControlMetadataResponse]]


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
    # The reviewer's say for the pathway; None leaves it to the automatic grouping.
    screen_link: str | None = None  # "new", or the id of another step that shows the same screen
    screen_kind: Literal["screen", "popup"] | None = None
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


class PathwayStepResponse(BaseModel):
    step_id: str
    step_index: int
    screen_id: str
    visit: int
    timestamp_ms: int
    timestamp_tc: str
    title: str
    notes: str | None = None
    transition_type: str | None = None
    time_on_screen_ms: int | None = None
    image_path: str
    image_url: str
    grouped_by: str | None = None
    screen_choice: Literal["automatic", "new_screen", "same_screen"] = "automatic"
    kind_choice: Literal["automatic", "screen", "popup"] = "automatic"
    source_candidate_id: str


class PathwayVisitResponse(BaseModel):
    visit: int
    step_ids: list[str]
    arrived_ms: int
    time_on_screen_ms: int | None = None


class PathwayScreenResponse(BaseModel):
    id: str
    index: int
    title: str
    title_step_id: str | None = None
    kind: Literal["screen", "popup"]
    reached_from: str | None = None
    image_step_id: str
    visits: list[PathwayVisitResponse]
    time_on_screen_ms: int | None = None


class PathwayPassResponse(BaseModel):
    step_id: str
    step_index: int
    from_step_id: str
    at_ms: int
    transition_type: str | None = None


class PathwayTransitionResponse(BaseModel):
    from_screen: str
    to_screen: str
    kind: Literal["forward", "return"]
    passes: list[PathwayPassResponse]


class PathwayResponse(BaseModel):
    """The accepted steps of a run as screens and the moves between them; see services/pathway.py."""

    format: str
    detail: PathwayDetail
    step_count: int
    screen_count: int
    steps: list[PathwayStepResponse]
    screens: list[PathwayScreenResponse]
    transitions: list[PathwayTransitionResponse]
    field_notes: dict[str, str]


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
    # Which screen the step shows, for the pathway: "auto", "new", or the id of another step of the run.
    screen_link: str | None = Field(default=None, min_length=1, max_length=64)
    screen_kind: Literal["auto", "screen", "popup"] | None = None


class ManualCandidateCreate(BaseModel):
    timestamp_ms: int = Field(ge=0)
