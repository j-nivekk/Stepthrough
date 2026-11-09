export type AnalysisEngine = 'scene_v1' | 'hybrid_v2' | 'stable_v3';
export type RecordingType = 'phone' | 'desktop';
export type ScrollMode = 'each_stop' | 'merge';
export type AnalysisPreset = 'subtle_ui' | 'balanced' | 'noise_resistant';
export type OcrBackend = 'paddleocr';
export type OcrStatus = 'checking' | 'available' | 'unavailable';
export type TransitionType =
  | 'navigation'
  | 'scroll'
  | 'feed_card_swap'
  | 'modal'
  | 'content_update'
  | 'small_ui_change'
  | 'text_entry'
  | 'opening_screen'
  | 'unknown';
export type DetectorMode = 'content' | 'adaptive';
export type CandidateStatus = 'pending' | 'accepted' | 'rejected';
export type CandidateOrigin = 'detected' | 'manual';
export type ExportMode = 'accepted' | 'all';
export type RunStatus = 'queued' | 'running' | 'awaiting_fallback' | 'completed' | 'failed' | 'cancelled';
export type RunPhase =
  | 'queued'
  | 'probing'
  | 'primary_scan'
  | 'primary_extract'
  | 'awaiting_fallback'
  | 'fallback_scan'
  | 'fallback_extract'
  | 'exporting'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type RunEventLevel = 'info' | 'warning' | 'error' | 'success';

export interface HealthResponse {
  ocr_status: OcrStatus;
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
  ocr_available: boolean | null;
  missing_tools: string[];
  message: string;
  ocr_message: string;
  ocr_warnings: string[];
}

export interface AnalysisControlMetadata {
  supported: boolean;
  reason?: string | null;
  note?: string | null;
}

export interface StableRecordingTypeMetadata {
  label: string;
  description: string;
  min_dwell_ms: number;
  min_change_percent: number;
  ignore_status_bar: boolean;
}

export interface AnalysisMetadata {
  stable_recording_types?: Partial<Record<RecordingType, StableRecordingTypeMetadata>>;
  stable_engine_version?: string | null;
  controls_by_engine: Partial<Record<AnalysisEngine, Record<string, AnalysisControlMetadata>>>;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  recording_count: number;
  run_count: number;
  last_activity_at: string;
}

export interface RecordingSummary {
  id: string;
  project_id: string;
  filename: string;
  slug: string;
  source_url: string;
  duration_ms: number;
  duration_tc: string;
  width: number;
  height: number;
  fps: number;
  created_at: string;
}

export interface ProjectDetail {
  project: Project;
  recordings: RecordingSummary[];
}

export interface HybridAdvancedSettings {
  sample_fps_override?: number | null;
  min_dwell_ms?: number | null;
  settle_window_ms?: number | null;
  proposal_threshold?: number | null;
  settle_threshold?: number | null;
  ocr_trigger_threshold?: number | null;
  enable_ocr: boolean;
  ocr_backend?: OcrBackend | null;
}

/** A box the stable engine ignores, as shares (0 to 1) of the frame's width and height. */
export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Settings of the stable-screen engine. `null` means "use the recording type's default". */
export interface StableSettings {
  recording_type: RecordingType;
  min_dwell_ms: number | null;
  min_change_percent: number | null;
  ignore_regions: IgnoreRegion[];
  ignore_status_bar: boolean | null;
  scroll_mode: ScrollMode;
  group_typing: boolean;
  include_opening_screen: boolean;
  enable_ocr: boolean;
  sensitivity: number | null;
  sample_fps: number | null;
}

export interface RunSummary {
  id: string;
  recording_id: string;
  status: RunStatus;
  phase: RunPhase;
  analysis_engine: AnalysisEngine;
  analysis_preset: AnalysisPreset;
  advanced?: HybridAdvancedSettings | null;
  stable?: StableSettings | null;
  analysis_config?: Record<string, unknown> | null;
  engine_version?: string | null;
  detector_mode: DetectorMode;
  tolerance: number;
  min_scene_gap_ms: number;
  sample_fps: number | null;
  allow_high_fps_sampling: boolean;
  extract_offset_ms: number;
  progress: number;
  message?: string | null;
  candidate_count: number;
  accepted_count: number;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at: string;
  export_bundle_id?: string | null;
  is_abortable: boolean;
  is_deletable: boolean;
}

export interface RecordingDetail extends RecordingSummary {
  runs: RunSummary[];
}

export interface ChangedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

export interface CandidateScoreBreakdown {
  visual: number;
  text: number;
  motion: number;
  changed_regions: ChangedRegion[];
  scroll_dx?: number | null;
  scroll_dy?: number | null;
  scroll_confidence?: number | null;
  chrome_change?: number | null;
  content_change?: number | null;
  transition_type?: TransitionType | null;
  dwell_before_ms?: number | null;
  dwell_after_ms?: number | null;
  event_start_ms?: number | null;
  event_end_ms?: number | null;
  grouped_states?: number | null;
}

export interface CandidateFrame {
  id: string;
  run_id: string;
  recording_id: string;
  detector_index: number;
  candidate_origin: CandidateOrigin;
  timestamp_ms: number;
  timestamp_tc: string;
  image_path: string;
  image_url: string;
  scene_score: number;
  status: CandidateStatus;
  title?: string | null;
  notes?: string | null;
  score_breakdown?: CandidateScoreBreakdown | null;
  revisit_group_id?: string | null;
  similar_to_candidate_id?: string | null;
  similarity_distance?: number | null;
  created_at: string;
  updated_at: string;
}

export interface AcceptedStep {
  step_id: string;
  step_index: number;
  timestamp_ms: number;
  timestamp_tc: string;
  image_path: string;
  image_url: string;
  status: CandidateStatus;
  title: string;
  notes?: string | null;
  scene_score: number;
  score_breakdown?: CandidateScoreBreakdown | null;
  revisit_group_id?: string | null;
  similar_to_step_id?: string | null;
  source_candidate_id: string;
  export_filename: string;
}

export interface ExportBundle {
  id: string;
  run_id: string;
  output_dir: string;
  zip_path: string;
  zip_url: string;
  item_count: number;
  created_at: string;
}

export interface RunEvent {
  id: string;
  run_id: string;
  phase: RunPhase;
  level: RunEventLevel;
  message: string;
  progress?: number | null;
  created_at: string;
}

export interface RunDetail {
  summary: RunSummary;
  candidates: CandidateFrame[];
  accepted_steps: AcceptedStep[];
  events: RunEvent[];
  export_bundle?: ExportBundle | null;
}

/** Settings for a new run. Only the stable-screen engine starts runs; RunSummary still describes runs of
 * the retired engines. */
export interface RunSettings {
  analysis_engine: 'stable_v3';
  stable: StableSettings;
}

export interface GlobalRunPreset {
  version: number;
  settings: RunSettings;
  saved_at: string;
}

export interface ProjectRunPreset {
  version: number;
  project_id: string;
  settings: RunSettings;
  saved_at: string;
}

export type AuthMode = 'none' | 'password';
export type LinkPurpose = 'invite' | 'reset';

export interface SessionUser {
  id: string;
  name: string;
  display_name: string | null;
  tags: string[];
  is_admin: boolean;
  /** The date (YYYY-MM-DD) from which this account and the projects only it owns are deleted. */
  delete_after: string | null;
}

/** How the server recognises people. `user` is null when logins are on and nobody is logged in. */
export interface SessionInfo {
  mode: AuthMode;
  user: SessionUser | null;
}

export interface LinkDetails {
  name: string;
  display_name: string | null;
  purpose: LinkPurpose;
}

export interface UserLink {
  token: string;
  purpose: LinkPurpose;
  expires_at: string;
}

export interface AdminUser extends SessionUser {
  is_builtin: boolean;
  is_disabled: boolean;
  has_password: boolean;
  open_link: LinkPurpose | null;
  notes: string | null;
  project_count: number;
  created_at: string;
  last_seen_at: string | null;
}

export interface AdminUserChanges {
  display_name?: string | null;
  tags?: string[];
  is_disabled?: boolean;
  delete_after?: string | null;
  notes?: string | null;
}

export interface UserImportResult {
  created: { name: string; link: UserLink | null }[];
  existing: string[];
  errors: { row: number; name: string | null; message: string }[];
  /** People whose password from the list was kept although it would be refused as a new one. */
  weak_passwords: string[];
}
