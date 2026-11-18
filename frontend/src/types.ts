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
  | 'modal_close'
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
  /** The reviewer's say for the pathway: `new` (a screen of its own) or the id of an earlier step that shows
   *  the same screen. Empty leaves it to the automatic grouping. */
  screen_link?: string | null;
  /** The reviewer's say on whether the step is a pop-up. Empty leaves it to the label. */
  screen_kind?: 'screen' | 'popup' | null;
  created_at: string;
  updated_at: string;
}

/** What a reviewer can change about a step. */
export interface CandidateChanges {
  status?: CandidateStatus;
  title?: string;
  notes?: string;
  /** `auto`, `new`, or the id of an earlier step of the run. */
  screen_link?: string;
  screen_kind?: 'auto' | 'screen' | 'popup';
  /** In a shared account, the text this browser began from: if someone else saved other text meanwhile, the
   *  change is refused instead of written over theirs. */
  previous_title?: string;
  previous_notes?: string;
}

/** A change in a shared account, from the live feed (backend/app/live.py). `by` is the browser that made it. */
export interface LiveEvent {
  seq: number;
  kind: 'projects' | 'project' | 'project_deleted' | 'recording' | 'run' | 'candidate' | 'settings' | 'state';
  project_id: string | null;
  recording_id: string | null;
  run_id: string | null;
  by: string | null;
  candidate?: CandidateFrame;
}

/** What a browser of the account is doing: editing a step's title and notes, or uploading a video. `since` (in
 *  seconds, the server's clock) settles who came first. */
export type LivePresenceTarget =
  | { kind: 'editing'; run_id: string; candidate_id: string; since?: number }
  | { kind: 'uploading'; project_id: string; name: string; progress: number | null; since?: number };

export interface LivePresence {
  client: string;
  targets: LivePresenceTarget[];
}

/** A change rewriting a whole task while it runs (adding a step by hand, merging screens, ...). */
export interface LiveBusy {
  id: string;
  project_id: string;
  run_id: string;
  label: string;
  by: string | null;
}

export interface LiveState {
  epoch: string;
  seq: number;
  /** The browser could not catch up from the list of changes and loads everything again. */
  reset: boolean;
  events: LiveEvent[];
  presence: LivePresence[];
  busy: LiveBusy[];
  /** How the server asks browsers to pace their reloads: at a random moment within `spread_ms`, so that the
   *  browsers of a shared account do not all load a task at once. */
  pace?: { spread_ms: number };
}

/** Something a browser reports about itself for the usage report (backend/app/usage.py lists what is allowed). */
export type UsageEvent =
  | { kind: 'page'; name: 'projects' | 'import' | 'analysis' | 'review' | 'pathway' }
  | { kind: 'tutorial_invited' }
  | { kind: 'tutorial_opened'; from: 'invitation' | 'pathway' | 'about' }
  | { kind: 'tutorial_lesson' | 'tutorial_solved' | 'tutorial_show_me'; lesson: number }
  | { kind: 'tutorial_closed'; solved: number; minutes: number }
  | { kind: 'figure_downloaded'; format: 'svg' | 'png' };

export interface UsageAccountRow {
  id: string;
  name: string;
  shared: boolean;
  browsers: number;
  open_minutes: number;
  working_minutes: number;
  logins: number;
  projects: number;
  uploads: number;
  upload_minutes: number;
  analyses: number;
  analyses_failed: number;
  accepted: number;
  rejected: number;
  annotations: number;
  steps_added: number;
  carried_over: number;
  merges: number;
  exports: number;
  figures: number;
  tutorial_browsers: number;
  tutorial_finished: number;
}

/** The usage report of the last `days` days, in the reader's local time. */
export interface UsageReport {
  since: string;
  until: string;
  days: number;
  keep_days: number;
  slot_minutes: number;
  totals: {
    browsers: number;
    accounts: number;
    logins: number;
    login_failures: number;
    analyses: number;
    analyses_completed: number;
    analyses_failed: number;
    analysis_median_seconds: number | null;
    analysis_wait_median_seconds: number | null;
    accepted: number;
    rejected: number;
    exports: number;
    figures: number;
  };
  /** Per hour of the day: browsers in the app (open) and making changes (working), each counted once a day. */
  hours: Array<{ hour: number; open: number; working: number }>;
  days_list: Array<{ date: string; open: number; working: number; accounts: number; logins: number; analyses: number; decisions: number }>;
  accounts: UsageAccountRow[];
  tutorial: {
    invited: number;
    opened: number;
    opened_from: Record<string, number>;
    finished: number;
    median_minutes: number | null;
    lessons: Array<{ lesson: number; reached: number; solved: number; show_me: number }>;
  };
  pages: Record<string, number>;
}

export type TrafficKind = 'uploads' | 'media' | 'exports' | 'live' | 'data' | 'app';

/** Bytes in (uploads, request bodies) and out (answers, as sent), of the last `days` days in local time. */
export interface TrafficReport {
  since: string;
  until: string;
  days: number;
  keep_days: number;
  totals: { bytes_in: number; bytes_out: number; requests: number };
  busiest_hour: { start: string; bytes: number } | null;
  categories: Array<{ category: TrafficKind; bytes_in: number; bytes_out: number; requests: number }>;
  accounts: Array<{
    id: string | null;
    name: string;
    shared: boolean;
    admin: boolean;
    bytes_in: number;
    bytes_out: number;
    requests: number;
    categories: Record<TrafficKind, number>;
  }>;
  hours: Array<{ hour: number; bytes_in: number; bytes_out: number }>;
  days_list: Array<{ date: string; bytes_in: number; bytes_out: number; requests: number }>;
}

/** What an administrator can change while the server runs, each with the server's own configuration as default. */
export interface ServerSettings {
  /** How many analyses run together; 0 is no limit. */
  analyses_at_a_time: { value: number; default: number };
  compression: { value: boolean; default: boolean };
  live_spread_seconds: { value: number; default: number };
  /** Days the usage report's events are kept; 0 records nothing. */
  usage_keep_days: { value: number; default: number };
}

export type ServerSettingsChanges = Partial<{ [K in keyof ServerSettings]: ServerSettings[K]['value'] }>;

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

/** `screens`: scrolling, typing and small changes stay on one screen; `steps`: every step is its own box, except a
 * revisit or the reviewer's choice. */
export type PathwayDetail = 'screens' | 'steps';

export interface PathwayStep {
  step_id: string;
  step_index: number;
  screen_id: string;
  visit: number;
  timestamp_ms: number;
  timestamp_tc: string;
  title: string;
  notes?: string | null;
  transition_type?: string | null;
  time_on_screen_ms?: number | null;
  image_path: string;
  image_url: string;
  /** Why the step shares a screen with an earlier one: `researcher`, `revisit`, `modal_close`, or the label of
   *  a change that stayed on the screen. Empty for the step that starts a screen. */
  grouped_by?: string | null;
  screen_choice: 'automatic' | 'new_screen' | 'same_screen';
  kind_choice: 'automatic' | 'screen' | 'popup';
  source_candidate_id: string;
}

export interface PathwayVisit {
  visit: number;
  step_ids: string[];
  arrived_ms: number;
  time_on_screen_ms?: number | null;
}

export interface PathwayScreen {
  id: string;
  index: number;
  title: string;
  title_step_id?: string | null;
  kind: 'screen' | 'popup';
  /** The screen the user was on when they first arrived here; null for the first screen. */
  reached_from?: string | null;
  image_step_id: string;
  visits: PathwayVisit[];
  time_on_screen_ms?: number | null;
}

export interface PathwayPass {
  /** The step the move arrives at. */
  step_id: string;
  step_index: number;
  from_step_id: string;
  at_ms: number;
  transition_type?: string | null;
}

export interface PathwayTransition {
  from_screen: string;
  to_screen: string;
  kind: 'forward' | 'return';
  passes: PathwayPass[];
}

/** The accepted steps of a run as the screens they show and the moves between them. */
export interface Pathway {
  format: string;
  detail: PathwayDetail;
  step_count: number;
  screen_count: number;
  steps: PathwayStep[];
  screens: PathwayScreen[];
  transitions: PathwayTransition[];
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

/** Settings someone saved to start new runs from: their own defaults (`project_id` null) or theirs for one
 * project. They are kept with the account, so they follow it to any computer. */
export interface SavedRunSettings {
  project_id: string | null;
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
  /** Logins are on, but no account has a password yet, so nobody can log in. */
  setup_needed?: boolean;
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
