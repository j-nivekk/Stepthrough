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
  /** When someone last changed something in it, and who; no name for older changes or the app without logins. */
  modified_at: string;
  modified_by_name?: string | null;
  /** When it is deleted, for a project only visitor accounts own (backend/app/visitors.py). */
  deletes_at?: string | null;
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
  /** Its number among the runs of its recording; it stays when the run is renamed or another run is deleted. */
  run_number?: number | null;
  name?: string | null;
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
  rejected_count?: number;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at: string;
  /** When someone last changed it, and who; the analysis at work changes `updated_at` only. */
  modified_at?: string | null;
  modified_by_name?: string | null;
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
  /** Since engine 1.2.0: how much of the step before is still there (0 to 1), the areas whose content moved up or down
   *  (dy, negative is up), and where something opened over the screen or went away. */
  likeness?: number | null;
  moved_regions?: Array<{ x: number; y: number; width: number; height: number; dy: number; agreement: number }>;
  overlay_region?: { x: number; y: number; width: number; height: number } | null;
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
  /** What the engine found (since 1.2.0): the earlier step that shows the same screen, and why. */
  same_screen_as?: string | null;
  same_screen_reason?: string | null;
  /** The reviewer's say for the pathway: `new` (a screen of its own) or the id of an earlier step that shows
   *  the same screen. Empty leaves it to the automatic grouping. */
  screen_link?: string | null;
  /** The reviewer's say on whether the step is a pop-up. Empty leaves it to the label. */
  screen_kind?: 'screen' | 'popup' | null;
  /** Where the step's box goes in the pathway figure: on the row of the box it was reached from, or on a row of
   *  its own below. Empty leaves it to the layout; the box's first step with a say decides. */
  pathway_row?: PathwayRowChoice | null;
  /** The reviewer's say that after this step the user went back to an earlier screen: the id of a step on it. */
  returns_to?: string | null;
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
  pathway_row?: 'auto' | PathwayRowChoice;
  /** `auto` (no say), or the id of an earlier step of the run. */
  returns_to?: string;
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
  | { kind: 'uploading'; project_id: string; name: string; progress: number | null; since?: number }
  | { kind: 'importing_project'; name: string; progress: number | null; since?: number };

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
  | { kind: 'comparison_opened' }
  | { kind: 'boxes_switched'; to: 'screens' | 'steps' }
  | { kind: 'guide_opened'; from: 'tutorial' | 'about' };

export interface UsageAccountRow {
  id: string;
  name: string;
  shared: boolean;
  visitor?: boolean;
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
  /** Runs duplicated (copies of a finished run). */
  duplicates?: number;
  /** Whole projects downloaded as a file, and brought in from one. */
  project_downloads?: number;
  project_imports?: number;
  merges: number;
  exports: number;
  figures: number;
  tutorial_browsers: number;
  tutorial_finished: number;
  corrections: number;
  comparisons: number;
  /** Days with changes made. */
  active_days: number;
  /** Minutes in the app at each stage, by the page open (the step review is part of analysis). */
  stage_minutes: Record<UsageStage, number>;
  /** Minutes making changes on each day of `days_list`, in its order. */
  worked: number[];
}

export type UsageStage = 'projects' | 'import' | 'analysis' | 'pathway';

/** The period of a report: the last so many whole days (0: everything kept), or from one local date to another. */
export type ReportPeriod = { days: number } | { start: string; end: string };

export interface ReportFilter {
  period: ReportPeriod;
  /** Only the accounts with this tag; empty for all. */
  tag: string;
}

/** What every report says about its period (backend/app/report_window.py). */
interface ReportWindow {
  since: string;
  until: string;
  /** The first and last local date, YYYY-MM-DD. */
  start: string;
  end: string;
  days: number;
  tag: string | null;
  /** Days usage and traffic are kept; null: for ever. */
  keep_days: number | null;
}

/** The usage report of the last `days` days, in the reader's local time. */
export interface UsageReport extends ReportWindow {
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
    corrections: number;
    corrections_by_choice: Partial<Record<'same_screen' | 'new_screen' | 'automatic' | 'popup' | 'not_popup' | 'popup_automatic' | 'return' | 'no_return', number>>;
    comparisons: number;
    boxes_switched: number;
    guide_opened: number;
    stage_minutes: Record<UsageStage, number>;
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
  /** With `long`: account, local date, measure and amount. */
  long?: Array<[string, string, string, number]>;
}

export type TrafficKind = 'uploads' | 'media' | 'exports' | 'live' | 'data' | 'app';

/** Bytes in (uploads, request bodies) and out (answers, as sent), of the last `days` days in local time. */
export interface TrafficReport extends ReportWindow {
  totals: { bytes_in: number; bytes_out: number; requests: number };
  busiest_hour: { start: string; bytes: number } | null;
  categories: Array<{ category: TrafficKind; bytes_in: number; bytes_out: number; requests: number }>;
  accounts: Array<{
    id: string | null;
    name: string;
    shared: boolean;
    visitor?: boolean;
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
  /** Days usage and traffic are kept; 0 records nothing, null keeps them for ever. */
  usage_keep_days: { value: number | null; default: number };
  /** How long visitor accounts' projects are kept, from when each was made. */
  visitor_keep_hours: { value: number; default: number };
  /** The largest video a visitor account may upload; null: the server's own limit. */
  visitor_upload_mb: { value: number | null; default: number };
  /** How much a visitor account may keep at once; null: no limit. */
  visitor_storage_mb: { value: number | null; default: number };
  /** The deletion date, so many days on, that an account gets with the visitor tag when it has none; null: none. */
  visitor_account_days: { value: number | null; default: number };
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

/** Where a box goes in the pathway figure: `continue` the row of the box it was reached from, or start a row
 *  `below` it. Without a say, the first box reached from a box continues its row and the others go below. */
export type PathwayRowChoice = 'continue' | 'below';

export interface PathwayStep {
  step_id: string;
  /** 0 for the opening screen, which is where the steps start and none of them; see lib/stepNumbers.ts. */
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
  /** The phase of the walkthrough the step is in; empty outside every phase. */
  phase?: string | null;
  /**
   * Part of an optional detour: a trip off the main way through that comes back to it, with the step that comes
   * back (services/pathway.py).
   */
  detour?: boolean;
  /** The number along the main way: "13", or "13a" for the first step of a detour taken after step 13. */
  path_step?: string;
  /** The screen the user went back to after this step, as the reviewer said (its id). */
  returns_to?: string | null;
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
  row_choice?: 'automatic' | PathwayRowChoice;
  /**
   * The screen that carries this one's row on in the figure (services/pathway.py): the one the reviewer put on the
   * row, or else the one with the most screens reached after it; null where the row ends. Left out by pathways made
   * on the page (the tutorial, tests), which work it out the same way (pathwayFigure.ts).
   */
  continues_with?: string | null;
  /** On the main way through: the chain of screens that carry the rows on, from the first screen. */
  main?: boolean;
}

/** A named stretch of consecutive steps, such as "sign up", with how many steps and screens it takes. */
export interface PathwayPhase {
  name: string;
  first_step_id: string;
  last_step_id: string;
  first_step_index: number;
  last_step_index: number;
  /** Without the opening screen, which no step led to. */
  step_count: number;
  screen_count: number;
  /** The same without the steps of optional detours (from the server). */
  main_step_count?: number;
  main_screen_count?: number;
  screen_ids: string[];
  start_ms: number;
  end_ms?: number | null;
  duration_ms?: number | null;
}

export interface PathwayPass {
  /** The step the move arrives at; none for a return the reviewer added (`origin`: researcher). */
  step_id: string | null;
  step_index: number | null;
  from_step_id: string;
  at_ms: number | null;
  transition_type?: string | null;
  origin?: 'recorded' | 'researcher';
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
  /** Without the opening screen, which no step led to (it is in `steps`). */
  step_count: number;
  screen_count: number;
  /** The steps without the optional detours, and on how many screens they are (from the server). */
  main_step_count?: number;
  main_screen_count?: number;
  steps: PathwayStep[];
  screens: PathwayScreen[];
  transitions: PathwayTransition[];
  phases?: PathwayPhase[];
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
  /** Where each phase of the walkthrough starts (an empty name: outside every phase), in order. */
  phases?: Array<{ start_ms: number; name: string }>;
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
  /** For a visitor account: its limits (backend/app/visitors.py). */
  visitor?: VisitorLimits | null;
  /** The largest video and the largest project file this account may bring in. */
  upload_limit_bytes?: number | null;
  project_file_limit_bytes?: number | null;
}

/** A visitor's project in the admin panel: whose it is and when it is deleted. */
export interface VisitorProject {
  id: string;
  name: string;
  owners: string;
  created_at: string;
  deletes_at: string;
}

export interface VisitorLimits {
  /** How long its projects are kept, counted from when each was made. */
  keep_hours: number;
  upload_limit_bytes: number;
  storage_limit_bytes: number | null;
  storage_used_bytes: number | null;
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

/** How far each account has got with its projects (backend/app/progress.py), read from the projects themselves. */
export type ProgressStage = 'videos' | 'analysed' | 'reviewed' | 'described' | 'pathway' | 'exported';

export interface ProgressProject {
  id: string;
  name: string;
  created_at: string;
  last_change: string | null;
  videos: number;
  video_minutes: number;
  videos_analysed: number;
  runs: number;
  runs_failed: number;
  runs_active: number;
  /** Videos whose latest analysis failed. */
  failed_unretried: number;
  /** Settings of the analysis changed from their defaults, in any analysis of the project. */
  settings_changed: string[];
  found: number;
  added: number;
  accepted: number;
  rejected: number;
  pending: number;
  /** Accepted steps with a title or notes. */
  described: number;
  /** Accepted steps whose screen was corrected for the pathway. */
  corrections: number;
  /** When each stage was reached; null when not (yet). */
  reached: Record<ProgressStage, string | null>;
}

export interface ProgressAccount {
  id: string;
  name: string;
  shared: boolean;
  visitor?: boolean;
  tags: string[];
  created_at: string;
  last_seen_at: string | null;
  projects: ProgressProject[];
}

export interface ProgressReport {
  generated_at: string;
  tag: string | null;
  stages: ProgressStage[];
  accounts: ProgressAccount[];
}
