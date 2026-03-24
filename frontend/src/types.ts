export type AnalysisEngine = 'scene_v1' | 'hybrid_v2';
export type AnalysisPreset = 'subtle_ui' | 'balanced' | 'noise_resistant';
export type OcrBackend = 'paddleocr';
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
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
  ocr_available: boolean;
  missing_tools: string[];
  message: string;
  ocr_message: string;
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
  enable_ocr: boolean;
  ocr_backend?: OcrBackend | null;
}

export interface RunSummary {
  id: string;
  recording_id: string;
  status: RunStatus;
  phase: RunPhase;
  analysis_engine: AnalysisEngine;
  analysis_preset: AnalysisPreset;
  advanced?: HybridAdvancedSettings | null;
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

export interface RunSettings {
  analysis_engine: AnalysisEngine;
  analysis_preset: AnalysisPreset;
  advanced?: HybridAdvancedSettings | null;
  tolerance: number;
  min_scene_gap_ms: number;
  sample_fps: number | null;
  allow_high_fps_sampling: boolean;
  detector_mode: DetectorMode;
  extract_offset_ms: number;
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
