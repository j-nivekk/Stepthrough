import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  API_BASE,
  absoluteApiUrl,
  abortRun,
  createManualCandidate,
  createProject,
  createRun,
  deleteRecording,
  deleteRun,
  exportRun,
  getProject,
  getRecording,
  getRun,
  health,
  importRecording,
  listProjects,
  updateCandidate,
  updateProject,
  updateRecording,
} from './api';
import type {
  CandidateFrame,
  CandidateStatus,
  ExportMode,
  ExportBundle,
  GlobalRunPreset,
  HybridAdvancedSettings,
  Project,
  ProjectRunPreset,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunPhase,
  RunSettings,
  RunSummary,
} from './types';

const defaultRunSettings: RunSettings = {
  analysis_engine: 'hybrid_v2',
  analysis_preset: 'balanced',
  advanced: null,
  tolerance: 50,
  min_scene_gap_ms: 900,
  sample_fps: 4,
  allow_high_fps_sampling: false,
  detector_mode: 'content',
  extract_offset_ms: 200,
};

const defaultHybridAdvancedSettings: HybridAdvancedSettings = {
  sample_fps_override: null,
  min_dwell_ms: null,
  settle_window_ms: null,
  enable_ocr: true,
  ocr_backend: 'paddleocr',
};

const contentThresholdRange: [number, number] = [8, 48];
const adaptiveThresholdRange: [number, number] = [1, 7];
const analysisPresetDefaults = {
  subtle_ui: { minDwellMs: 250, sampleFps: 8, settleWindowMs: 250 },
  balanced: { minDwellMs: 400, sampleFps: 6, settleWindowMs: 400 },
  noise_resistant: { minDwellMs: 700, sampleFps: 4, settleWindowMs: 700 },
} as const;

const PRESET_STORAGE_VERSION = 1;
const GLOBAL_PRESET_STORAGE_KEY = 'stepthrough.run-preset.global.v1';
const PROJECT_PRESET_STORAGE_KEY_PREFIX = 'stepthrough.run-preset.project.v1';
const APP_IDENTITY = 'stepthrough, v 0.1.0';
const workflowViewportMinimums: Record<WorkflowStage, { height: number; width: number }> = {
  projects: { width: 720, height: 640 },
  import: { width: 720, height: 640 },
  analysis: { width: 1120, height: 760 },
};

type SimilarLink = { targetId: string; label: string };
type WorkflowStage = 'projects' | 'import' | 'analysis';
type ProjectEntryTarget = Exclude<WorkflowStage, 'projects'>;
type ImportQueueStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

interface ImportQueueItem {
  localId: string;
  filename: string;
  file: File | null;
  status: ImportQueueStatus;
  recordingId: string | null;
  error: string | null;
  signature: string | null;
}

interface AnalysisTaskItem {
  recording: RecordingSummary;
  run: RunSummary;
}

interface AnalysisTaskGroup {
  recording: RecordingSummary;
  runs: AnalysisTaskItem[];
}

interface PendingManualMark {
  id: string;
  timestampMs: number;
}

type AnalysisHintKey =
  | 'analysis_engine'
  | 'analysis_preset'
  | 'allow_high_fps_sampling'
  | 'hybrid_advanced'
  | 'hybrid_min_dwell_ms'
  | 'hybrid_ocr_confirmation'
  | 'hybrid_sample_fps_override'
  | 'hybrid_settle_window_ms'
  | 'detector_mode'
  | 'extract_offset_ms'
  | 'load'
  | 'min_scene_gap_ms'
  | 'reset'
  | 'run'
  | 'sample_fps'
  | 'save'
  | 'tolerance';
type AnalysisPopoverKey = 'export' | 'load' | 'preset' | 'reset' | 'save';
type AnalysisTaskFilter = 'all' | 'active' | 'completed' | 'failed';
type CandidateFilter = CandidateStatus | 'all';

const workflowStages: WorkflowStage[] = ['projects', 'import', 'analysis'];
const activeRunStatuses: RunSummary['status'][] = ['queued', 'running'];
const candidateFilters: CandidateFilter[] = ['all', 'pending', 'accepted', 'rejected'];
const analysisTaskFilters: AnalysisTaskFilter[] = ['all', 'active', 'completed', 'failed'];
const commonAspectRatios = [
  { height: 9, label: '16:9', width: 16 },
  { height: 16, label: '9:16', width: 9 },
  { height: 3, label: '4:3', width: 4 },
  { height: 4, label: '3:4', width: 3 },
  { height: 2, label: '3:2', width: 3 },
  { height: 3, label: '2:3', width: 2 },
  { height: 1, label: '1:1', width: 1 },
  { height: 9, label: '19.5:9', width: 19.5 },
  { height: 19.5, label: '9:19.5', width: 9 },
  { height: 9, label: '18:9', width: 18 },
  { height: 18, label: '9:18', width: 9 },
  { height: 4, label: '5:4', width: 5 },
  { height: 5, label: '4:5', width: 4 },
];
const analysisResetStarPoints = Array.from({ length: 34 }, (_value, index) => {
  const angle = -Math.PI / 2 + (Math.PI * index) / 17;
  const radiusX = index % 2 === 0 ? 43 : 35;
  const radiusY = index % 2 === 0 ? 16 : 12;
  const x = 46 + Math.cos(angle) * radiusX;
  const y = 16 + Math.sin(angle) * radiusY;
  return `${x.toFixed(2)},${y.toFixed(2)}`;
}).join(' ');

const phaseLabels: Record<RunPhase, string> = {
  queued: 'Queued',
  probing: 'Preparing',
  primary_scan: 'Scanning scene changes',
  primary_extract: 'Extracting candidate screenshots',
  awaiting_fallback: 'Awaiting fallback',
  fallback_scan: 'Fallback scan',
  fallback_extract: 'Fallback extract',
  exporting: 'Exporting assets',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Aborted',
};

function sanitizeRunSettings(settings?: Partial<RunSettings> | null): RunSettings {
  const analysisEngine = settings?.analysis_engine === 'hybrid_v2' ? 'hybrid_v2' : 'scene_v1';
  const analysisPreset =
    settings?.analysis_preset === 'subtle_ui' || settings?.analysis_preset === 'noise_resistant' || settings?.analysis_preset === 'balanced'
      ? settings.analysis_preset
      : defaultRunSettings.analysis_preset;
  const advanced: HybridAdvancedSettings | null = settings?.advanced
    ? {
        sample_fps_override:
          typeof settings.advanced.sample_fps_override === 'number' && Number.isFinite(settings.advanced.sample_fps_override)
            ? Math.max(1, Math.round(settings.advanced.sample_fps_override))
            : null,
        min_dwell_ms:
          typeof settings.advanced.min_dwell_ms === 'number' && Number.isFinite(settings.advanced.min_dwell_ms)
            ? Math.max(0, Math.round(settings.advanced.min_dwell_ms))
            : null,
        settle_window_ms:
          typeof settings.advanced.settle_window_ms === 'number' && Number.isFinite(settings.advanced.settle_window_ms)
            ? Math.max(0, Math.round(settings.advanced.settle_window_ms))
            : null,
        enable_ocr: settings.advanced.enable_ocr !== false,
        ocr_backend: settings.advanced.enable_ocr === false ? null : 'paddleocr',
      }
    : null;
  const tolerance = typeof settings?.tolerance === 'number' ? Math.min(100, Math.max(1, Math.round(settings.tolerance))) : defaultRunSettings.tolerance;
  const minSceneGap = typeof settings?.min_scene_gap_ms === 'number' ? Math.max(0, Math.round(settings.min_scene_gap_ms)) : defaultRunSettings.min_scene_gap_ms;
  const sampleFps =
    typeof settings?.sample_fps === 'number' && Number.isFinite(settings.sample_fps) && settings.sample_fps > 0
      ? Math.max(1, Math.round(settings.sample_fps))
      : null;
  const allowHighFpsSampling = settings?.allow_high_fps_sampling === true;
  const detectorMode = settings?.detector_mode === 'adaptive' ? 'adaptive' : 'content';
  const extractOffset =
    typeof settings?.extract_offset_ms === 'number' ? Math.max(0, Math.round(settings.extract_offset_ms)) : defaultRunSettings.extract_offset_ms;

  return {
    analysis_engine: analysisEngine,
    analysis_preset: analysisPreset,
    advanced: analysisEngine === 'hybrid_v2' ? advanced ?? { ...defaultHybridAdvancedSettings } : null,
    tolerance,
    min_scene_gap_ms: minSceneGap,
    sample_fps: sampleFps,
    allow_high_fps_sampling: allowHighFpsSampling,
    detector_mode: detectorMode,
    extract_offset_ms: extractOffset,
  };
}

function getProjectPresetStorageKey(projectId: string): string {
  return `${PROJECT_PRESET_STORAGE_KEY_PREFIX}.${projectId}`;
}

function readStoredJson<T>(key: string): T | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const rawValue = window.localStorage.getItem(key);
    if (!rawValue) {
      return null;
    }
    return JSON.parse(rawValue) as T;
  } catch {
    return null;
  }
}

function loadGlobalRunPreset(): GlobalRunPreset | null {
  const stored = readStoredJson<GlobalRunPreset>(GLOBAL_PRESET_STORAGE_KEY);
  if (!stored || stored.version !== PRESET_STORAGE_VERSION) {
    return null;
  }
  return {
    ...stored,
    settings: sanitizeRunSettings(stored.settings),
  };
}

function loadProjectRunPreset(projectId: string): ProjectRunPreset | null {
  const stored = readStoredJson<ProjectRunPreset>(getProjectPresetStorageKey(projectId));
  if (!stored || stored.version !== PRESET_STORAGE_VERSION || stored.project_id !== projectId) {
    return null;
  }
  return {
    ...stored,
    settings: sanitizeRunSettings(stored.settings),
  };
}

function persistGlobalRunPreset(settings: RunSettings): GlobalRunPreset {
  const preset: GlobalRunPreset = {
    version: PRESET_STORAGE_VERSION,
    settings: sanitizeRunSettings(settings),
    saved_at: new Date().toISOString(),
  };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(GLOBAL_PRESET_STORAGE_KEY, JSON.stringify(preset));
  }
  return preset;
}

function persistProjectRunPreset(projectId: string, settings: RunSettings): ProjectRunPreset {
  const preset: ProjectRunPreset = {
    version: PRESET_STORAGE_VERSION,
    project_id: projectId,
    settings: sanitizeRunSettings(settings),
    saved_at: new Date().toISOString(),
  };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(getProjectPresetStorageKey(projectId), JSON.stringify(preset));
  }
  return preset;
}

function formatDetectorModeLabel(mode: RunSettings['detector_mode']): string {
  return mode === 'adaptive' ? 'Adaptive' : 'Content';
}

function formatAnalysisEngineLabel(engine: RunSettings['analysis_engine']): string {
  return engine === 'hybrid_v2' ? 'Hybrid v2' : 'Current v1';
}

function formatAnalysisPresetLabel(preset: RunSettings['analysis_preset']): string {
  if (preset === 'subtle_ui') return 'Subtle UI';
  if (preset === 'noise_resistant') return 'Ignore noise';
  return 'Balanced';
}

function mapToleranceToDetectorThreshold(tolerance: number, detectorMode: RunSettings['detector_mode']): number {
  const [floor, ceiling] = detectorMode === 'adaptive' ? adaptiveThresholdRange : contentThresholdRange;
  const normalized = (Math.min(100, Math.max(1, tolerance)) - 1) / 99;
  return Number((floor + ((ceiling - floor) * normalized)).toFixed(2));
}

function describeTolerance(tolerance: number, detectorMode: RunSettings['detector_mode']): string {
  const threshold = mapToleranceToDetectorThreshold(tolerance, detectorMode);
  const thresholdLabel = detectorMode === 'adaptive' ? `Adaptive threshold ${threshold}.` : `Content threshold ${threshold}.`;

  if (tolerance <= 25) {
    return `${thresholdLabel} Very sensitive. Lower it when keyboard states, small badges, or brief sheets are being missed. Raise sample fps first if very short screens are slipping through.`;
  }
  if (tolerance <= 60) {
    return `${thresholdLabel} Balanced for most walkthrough recordings. Lower it to catch subtler screens, or raise it if typing, scrolling, or background shimmer creates noise.`;
  }
  return `${thresholdLabel} Conservative. Raise it when scrolling or tiny motion creates too many candidates, and lower it if real screens are being missed.`;
}

function describeSampleFps(sampleFps: number | null, sourceFps: number | null): string {
  if (!sampleFps) {
    return 'Sampling every available frame from the source video. Use this only when you need maximum sensitivity or source-fps coverage.';
  }
  let skipText = '';
  if (sourceFps) {
    const skip = Math.max(1, Math.round(sourceFps / sampleFps));
    skipText = skip > 1 ? ` (~every ${ordinal(skip)} frame)` : ' (~every frame)';
  }
  return `Sampling ~${sampleFps} fps from the source video${skipText}. Raise this when brief overlays, menus, or quick transitions are being missed.`;
}

function describeDetectorMode(mode: RunSettings['detector_mode']): string {
  if (mode === 'adaptive') {
    return 'Compares against a rolling average of recent frames. Better for fades, overlays, and softer UI changes. Adaptive threshold scales from 1 to 7.';
  }
  return 'Strictly compares against the immediately previous sampled frame. Better for cuts and hard screen swaps. Content threshold scales from 8 to 48.';
}

function describeAnalysisPreset(settings: RunSettings): string {
  const presetDefaults = analysisPresetDefaults[settings.analysis_preset];
  const overrideFps = settings.advanced?.sample_fps_override;
  const overrideDwell = settings.advanced?.min_dwell_ms;
  const overrideSettle = settings.advanced?.settle_window_ms;
  const sampleFps = overrideFps ?? presetDefaults.sampleFps;
  const dwell = overrideDwell ?? presetDefaults.minDwellMs;
  const settle = overrideSettle ?? presetDefaults.settleWindowMs;
  const ocrCopy = settings.advanced?.enable_ocr === false ? 'OCR confirmation disabled.' : 'OCR confirmation enabled when visual change is strong.';
  return `${formatAnalysisPresetLabel(settings.analysis_preset)} samples around ${sampleFps} fps, waits ~${dwell}ms for dwell and ~${settle}ms for settle windows. ${ocrCopy}`;
}

function describeMinSceneGap(minSceneGapMs: number): string {
  if (minSceneGapMs === 0) {
    return '0ms removes the hard time gap between candidates and lets sampled changes cluster tightly on the timeline.';
  }
  const seconds = (minSceneGapMs / 1000).toFixed(1).replace(/\.0$/, '');
  return `${minSceneGapMs}ms (~${seconds}s) on the original timeline. This is the minimum spacing allowed between detected scene candidates.`;
}

function describeExtractOffset(offsetMs: number): string {
  if (offsetMs === 0) {
    return 'Captures exactly on the first detected frame of a new scene candidate.';
  }
  const seconds = (offsetMs / 1000).toFixed(1).replace(/\.0$/, '');
  return `Captures ${offsetMs}ms (${seconds}s) after the detection cut to avoid grabbing a frame mid-animation or during a transition.`;
}

function formatHybridOcrState(enableOcr: boolean | undefined, ocrBackend: HybridAdvancedSettings['ocr_backend'] | null | undefined): string {
  if (enableOcr === false) {
    return 'off';
  }
  return `on (${ocrBackend === 'paddleocr' || !ocrBackend ? 'PaddleOCR' : ocrBackend})`;
}

function describeHybridSampleFpsOverrideHint(settings: RunSettings): string {
  const presetSampleFps = analysisPresetDefaults[settings.analysis_preset].sampleFps;
  return `Overrides the preset sampling rate. Raise it when brief overlays or menu states are being missed, and leave it on auto to keep the preset baseline of ${presetSampleFps} fps.`;
}

function describeHybridMinDwellHint(settings: RunSettings): string {
  const presetMinDwellMs = analysisPresetDefaults[settings.analysis_preset].minDwellMs;
  return `Overrides how long a visual change must persist before it becomes a candidate. Lower it for brief states, or raise it to ignore flicker and transient motion. Preset baseline: ${presetMinDwellMs}ms.`;
}

function describeHybridSettleWindowHint(settings: RunSettings): string {
  const presetSettleWindowMs = analysisPresetDefaults[settings.analysis_preset].settleWindowMs;
  return `Overrides how long the detector waits for motion to settle before capturing the representative frame. Raise it for longer animations or loading states, and lower it when captures land too late. Preset baseline: ${presetSettleWindowMs}ms.`;
}

function describeHybridOcrConfirmationHint(): string {
  return 'Keeps OCR confirmation aligned with strong visual changes. Leave it on for text-heavy interfaces, and turn it off only when you want pure visual-diff behavior. Preset baseline: on (PaddleOCR).';
}

function formatHybridSampleFpsAnnotation(settings: RunSettings): string {
  const presetSampleFps = analysisPresetDefaults[settings.analysis_preset].sampleFps;
  const overrideSampleFps = settings.advanced?.sample_fps_override;
  return overrideSampleFps == null
    ? `Preset: ${presetSampleFps} fps. Current: auto, using the preset value.`
    : `Preset: ${presetSampleFps} fps. Current override: ${overrideSampleFps} fps.`;
}

function formatHybridMinDwellAnnotation(settings: RunSettings): string {
  const presetMinDwellMs = analysisPresetDefaults[settings.analysis_preset].minDwellMs;
  const overrideMinDwellMs = settings.advanced?.min_dwell_ms;
  return overrideMinDwellMs == null
    ? `Preset: ${presetMinDwellMs}ms. Current: auto, using the preset value.`
    : `Preset: ${presetMinDwellMs}ms. Current override: ${overrideMinDwellMs}ms.`;
}

function formatHybridSettleWindowAnnotation(settings: RunSettings): string {
  const presetSettleWindowMs = analysisPresetDefaults[settings.analysis_preset].settleWindowMs;
  const overrideSettleWindowMs = settings.advanced?.settle_window_ms;
  return overrideSettleWindowMs == null
    ? `Preset: ${presetSettleWindowMs}ms. Current: auto, using the preset value.`
    : `Preset: ${presetSettleWindowMs}ms. Current override: ${overrideSettleWindowMs}ms.`;
}

function formatHybridOcrAnnotation(settings: RunSettings): string {
  const currentOcrState = formatHybridOcrState(settings.advanced?.enable_ocr, settings.advanced?.ocr_backend);
  return `Preset: on (PaddleOCR). Current: ${currentOcrState}.`;
}

function getSampleFpsGuardrail(recordingFps: number | null | undefined, allowHighFpsSampling: boolean) {
  const sourceCeiling = Math.max(1, Math.ceil(recordingFps && Number.isFinite(recordingFps) ? recordingFps : 30));
  const cappedMax = Math.min(30, sourceCeiling);
  return {
    isHighFpsRecording: sourceCeiling > 30,
    maxSampleFps: allowHighFpsSampling ? sourceCeiling : cappedMax,
    sourceFpsAvailable: sourceCeiling <= 30 || allowHighFpsSampling,
    sourceFpsCeiling: sourceCeiling,
  };
}

function clampRunSettingsForRecording(settings: RunSettings, recordingFps: number | null | undefined): RunSettings {
  const sanitized = sanitizeRunSettings(settings);
  if (sanitized.analysis_engine === 'hybrid_v2') {
    const sourceFps = Math.max(1, Math.ceil(recordingFps && Number.isFinite(recordingFps) ? recordingFps : 30));
    const override = sanitized.advanced?.sample_fps_override;
    return {
      ...sanitized,
      advanced: sanitized.advanced
        ? {
            ...sanitized.advanced,
            sample_fps_override: typeof override === 'number' ? clampInteger(override, 1, sourceFps) : null,
          }
        : { ...defaultHybridAdvancedSettings },
    };
  }
  const guardrail = getSampleFpsGuardrail(recordingFps, sanitized.allow_high_fps_sampling);
  let nextSampleFps = sanitized.sample_fps;
  if (typeof nextSampleFps === 'number') {
    nextSampleFps = clampInteger(nextSampleFps, 1, guardrail.maxSampleFps);
  } else if (!guardrail.sourceFpsAvailable) {
    nextSampleFps = guardrail.maxSampleFps;
  }

  return {
    ...sanitized,
    sample_fps: nextSampleFps,
  };
}

function areRunSettingsEqual(left: RunSettings, right: RunSettings): boolean {
  return (
    left.analysis_engine === right.analysis_engine &&
    left.analysis_preset === right.analysis_preset &&
    (left.advanced?.sample_fps_override ?? null) === (right.advanced?.sample_fps_override ?? null) &&
    (left.advanced?.min_dwell_ms ?? null) === (right.advanced?.min_dwell_ms ?? null) &&
    (left.advanced?.settle_window_ms ?? null) === (right.advanced?.settle_window_ms ?? null) &&
    (left.advanced?.enable_ocr ?? true) === (right.advanced?.enable_ocr ?? true) &&
    (left.advanced?.ocr_backend ?? null) === (right.advanced?.ocr_backend ?? null) &&
    left.tolerance === right.tolerance &&
    left.min_scene_gap_ms === right.min_scene_gap_ms &&
    left.sample_fps === right.sample_fps &&
    left.allow_high_fps_sampling === right.allow_high_fps_sampling &&
    left.detector_mode === right.detector_mode &&
    left.extract_offset_ms === right.extract_offset_ms
  );
}



function formatRunSettingsSummary(settings: RunSettings): string {
  if (settings.analysis_engine === 'hybrid_v2') {
    const sampleFps = settings.advanced?.sample_fps_override ?? analysisPresetDefaults[settings.analysis_preset].sampleFps;
    return [
      formatAnalysisEngineLabel(settings.analysis_engine),
      formatAnalysisPresetLabel(settings.analysis_preset),
      `${sampleFps} fps`,
      settings.advanced?.enable_ocr === false ? 'ocr off' : 'ocr on',
    ].join(' · ');
  }
  return [
    formatAnalysisEngineLabel(settings.analysis_engine),
    formatDetectorModeLabel(settings.detector_mode),
    `tol ${settings.tolerance}`,
    settings.sample_fps ? `${settings.sample_fps} fps` : 'source fps',
    settings.allow_high_fps_sampling ? 'high fps on' : null,
    `gap ${settings.min_scene_gap_ms} ms`,
    `offset ${settings.extract_offset_ms} ms`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function serializeRunPresetText(settings: RunSettings): string {
  return [
    'Stepthrough Detection Preset',
    `Engine: ${settings.analysis_engine}`,
    `Preset: ${settings.analysis_preset}`,
    `Hybrid sample fps override: ${settings.advanced?.sample_fps_override ?? 'Auto'}`,
    `Hybrid min dwell: ${settings.advanced?.min_dwell_ms ?? 'Auto'} ms`,
    `Hybrid settle window: ${settings.advanced?.settle_window_ms ?? 'Auto'} ms`,
    `Hybrid OCR: ${settings.advanced?.enable_ocr === false ? 'Disabled' : 'Enabled'}`,
    `Mode: ${formatDetectorModeLabel(settings.detector_mode)}`,
    `Tolerance: ${settings.tolerance}`,
    `Min scene gap: ${settings.min_scene_gap_ms} ms`,
    `Sample fps: ${settings.sample_fps ?? 'Source stream'}`,
    `High-fps sampling: ${settings.allow_high_fps_sampling ? 'Enabled' : 'Disabled'}`,
    `Extract offset: ${settings.extract_offset_ms} ms`,
  ].join('\n');
}

function parseRunPresetText(rawText: string): { error: string } | { settings: RunSettings } {
  const normalizedLines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!normalizedLines.length) {
    return { error: 'Paste a Stepthrough preset block to apply it.' };
  }

  const lines =
    normalizedLines[0]?.toLowerCase() === 'stepthrough detection preset'
      ? normalizedLines.slice(1)
      : normalizedLines;

  const fieldValues = new Map<string, string>();
  const supportedFields = new Set([
    'engine',
    'preset',
    'hybrid sample fps override',
    'hybrid min dwell',
    'hybrid settle window',
    'hybrid ocr',
    'mode',
    'tolerance',
    'min scene gap',
    'sample fps',
    'high-fps sampling',
    'extract offset',
  ]);

  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      return { error: `Couldn't parse "${line}". Use "Label: Value" lines.` };
    }

    const label = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (!supportedFields.has(label)) {
      return { error: `Couldn't parse "${line}".` };
    }
    if (!value) {
      return { error: `Add a value for "${label}".` };
    }
    if (fieldValues.has(label)) {
      return { error: `"${label}" is listed more than once.` };
    }

    fieldValues.set(label, value);
  }

  const missingFields = [...supportedFields].filter((label) => !fieldValues.has(label));
  if (missingFields.length) {
    return { error: `Preset text is missing ${missingFields.join(', ')}.` };
  }

  const engineValue = fieldValues.get('engine')!.toLowerCase();
  if (engineValue !== 'scene_v1' && engineValue !== 'hybrid_v2') {
    return { error: 'Engine must be scene_v1 or hybrid_v2.' };
  }

  const presetValue = fieldValues.get('preset')!.toLowerCase();
  if (presetValue !== 'subtle_ui' && presetValue !== 'balanced' && presetValue !== 'noise_resistant') {
    return { error: 'Preset must be subtle_ui, balanced, or noise_resistant.' };
  }

  const hybridSampleFpsValue = fieldValues.get('hybrid sample fps override')!;
  if (!/^auto$/i.test(hybridSampleFpsValue) && !/^-?\d+$/.test(hybridSampleFpsValue)) {
    return { error: 'Hybrid sample fps override must be a whole number or "Auto".' };
  }

  const hybridMinDwellValue = fieldValues.get('hybrid min dwell')!;
  if (!/^auto\s*ms$/i.test(hybridMinDwellValue) && !/^-?\d+\s*ms$/i.test(hybridMinDwellValue)) {
    return { error: 'Hybrid min dwell must end with "ms" or be "Auto ms".' };
  }

  const hybridSettleValue = fieldValues.get('hybrid settle window')!;
  if (!/^auto\s*ms$/i.test(hybridSettleValue) && !/^-?\d+\s*ms$/i.test(hybridSettleValue)) {
    return { error: 'Hybrid settle window must end with "ms" or be "Auto ms".' };
  }

  const hybridOcrValue = fieldValues.get('hybrid ocr')!.toLowerCase();
  if (hybridOcrValue !== 'enabled' && hybridOcrValue !== 'disabled') {
    return { error: 'Hybrid OCR must be Enabled or Disabled.' };
  }

  const modeValue = fieldValues.get('mode')!.toLowerCase();
  if (modeValue !== 'content' && modeValue !== 'adaptive') {
    return { error: 'Mode must be Content or Adaptive.' };
  }

  const toleranceValue = fieldValues.get('tolerance')!;
  if (!/^-?\d+$/.test(toleranceValue)) {
    return { error: 'Tolerance must be a whole number.' };
  }

  const minSceneGapValue = fieldValues.get('min scene gap')!;
  if (!/^-?\d+\s*ms$/i.test(minSceneGapValue)) {
    return { error: 'Min scene gap must end with "ms".' };
  }

  const sampleFpsValue = fieldValues.get('sample fps')!;
  if (!/^source stream$/i.test(sampleFpsValue) && !/^-?\d+$/.test(sampleFpsValue)) {
    return { error: 'Sample fps must be a whole number or "Source stream".' };
  }

  const highFpsValue = fieldValues.get('high-fps sampling')!.toLowerCase();
  if (highFpsValue !== 'enabled' && highFpsValue !== 'disabled') {
    return { error: 'High-fps sampling must be Enabled or Disabled.' };
  }

  const extractOffsetValue = fieldValues.get('extract offset')!;
  if (!/^-?\d+\s*ms$/i.test(extractOffsetValue)) {
    return { error: 'Extract offset must end with "ms".' };
  }

  return {
    settings: sanitizeRunSettings({
      analysis_engine: engineValue,
      analysis_preset: presetValue,
      advanced:
        engineValue === 'hybrid_v2'
          ? {
              sample_fps_override: /^auto$/i.test(hybridSampleFpsValue) ? null : Number.parseInt(hybridSampleFpsValue, 10),
              min_dwell_ms: /^auto\s*ms$/i.test(hybridMinDwellValue) ? null : Number.parseInt(hybridMinDwellValue, 10),
              settle_window_ms: /^auto\s*ms$/i.test(hybridSettleValue) ? null : Number.parseInt(hybridSettleValue, 10),
              enable_ocr: hybridOcrValue === 'enabled',
              ocr_backend: hybridOcrValue === 'enabled' ? 'paddleocr' : null,
            }
          : null,
      detector_mode: modeValue,
      tolerance: Number.parseInt(toleranceValue, 10),
      min_scene_gap_ms: Number.parseInt(minSceneGapValue, 10),
      sample_fps: /^source stream$/i.test(sampleFpsValue) ? null : Number.parseInt(sampleFpsValue, 10),
      allow_high_fps_sampling: highFpsValue === 'enabled',
      extract_offset_ms: Number.parseInt(extractOffsetValue, 10),
    }),
  };
}

function formatPercent(progress: number): string {
  return `${Math.round(progress * 100)}%`;
}

function formatPhase(phase: RunPhase): string {
  return phaseLabels[phase] ?? phase;
}

function formatRunTiming(run: RunSummary): string {
  if (run.status === 'completed' && run.completed_at) {
    return `Finished ${new Date(run.completed_at).toLocaleString()}`;
  }
  if (run.status === 'cancelled' && run.completed_at) {
    return `Aborted ${new Date(run.completed_at).toLocaleString()}`;
  }
  if (run.status === 'failed' && run.completed_at) {
    return `Failed ${new Date(run.completed_at).toLocaleString()}`;
  }
  if (run.started_at) {
    return `Started ${new Date(run.started_at).toLocaleString()}`;
  }
  return `Created ${new Date(run.created_at).toLocaleString()}`;
}

function formatProjectActivity(lastActivityAt: string): string {
  const timestamp = new Date(lastActivityAt).getTime();
  if (Number.isNaN(timestamp)) {
    return lastActivityAt;
  }

  const diffMs = Date.now() - timestamp;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const monthMs = 30 * dayMs;

  if (diffMs <= 0) {
    return 'now';
  }
  if (diffMs < dayMs) {
    return `${Math.max(1, Math.floor(diffMs / hourMs))}h`;
  }
  if (diffMs < monthMs) {
    return `${Math.max(1, Math.floor(diffMs / dayMs))}d`;
  }
  if (diffMs < 6 * monthMs) {
    return `${Math.max(1, Math.floor(diffMs / monthMs))}mo`;
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatProjectSummary(project: Project): string {
  const videoLabel = `${project.recording_count} ${project.recording_count === 1 ? 'video' : 'videos'}`;
  const runLabel = `${project.run_count} ${project.run_count === 1 ? 'run' : 'runs'}`;
  return `${videoLabel} • ${runLabel} • ${formatProjectActivity(project.last_activity_at)}`;
}

function formatProjectCounts(project: Project): string {
  const videoLabel = `${project.recording_count} ${project.recording_count === 1 ? 'video' : 'videos'}`;
  const runLabel = `${project.run_count} ${project.run_count === 1 ? 'run' : 'runs'}`;
  return `${videoLabel} • ${runLabel}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

function formatAspectRatio(width: number, height: number): string {
  if (!width || !height) {
    return 'unknown';
  }

  const normalizedRatio = width / height;
  const closestCommonRatio = commonAspectRatios.find((ratio) => Math.abs(normalizedRatio - ratio.width / ratio.height) <= 0.03);
  if (closestCommonRatio) {
    return closestCommonRatio.label;
  }

  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function formatRecordingContextBadge(recording: RecordingSummary): string {
  return `${recording.width}×${recording.height} · ${formatAspectRatio(recording.width, recording.height)}`;
}

function formatRunShortTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  const now = new Date();
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleString([], {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    ...(includeYear ? { year: 'numeric' as const } : {}),
  });
}

function formatRelativeTime(timestamp: string, nowMs: number): string {
  const parsedTimestamp = new Date(timestamp).getTime();
  if (Number.isNaN(parsedTimestamp)) {
    return timestamp;
  }

  const deltaMs = Math.max(0, nowMs - parsedTimestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (deltaMs < minuteMs) {
    return 'just now';
  }
  if (deltaMs < hourMs) {
    return `${Math.floor(deltaMs / minuteMs)}m ago`;
  }
  if (deltaMs < dayMs) {
    return `${Math.floor(deltaMs / hourMs)}h ago`;
  }
  if (deltaMs < 7 * dayMs) {
    return `${Math.floor(deltaMs / dayMs)}d ago`;
  }
  return formatRunShortTimestamp(timestamp);
}

function jumpToAnchor(anchorId: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const target = document.getElementById(anchorId);
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  target.focus({ preventScroll: true });
}

function createLocalId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

function clampInteger(value: number, min?: number, max?: number): number {
  let nextValue = Math.round(value);
  if (typeof min === 'number') {
    nextValue = Math.max(min, nextValue);
  }
  if (typeof max === 'number') {
    nextValue = Math.min(max, nextValue);
  }
  return nextValue;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function triggerDownload(url: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function getFilenameStem(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return 'stepthrough';
  }
  return trimmed.replace(/\.[^./\\]+$/, '');
}

function buildReviewExportName(filename: string): string {
  return `${getFilenameStem(filename)}-review-export`;
}

function normalizeZipFilename(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const sanitized = trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.zip$/i, '');
  return sanitized ? `${sanitized}.zip` : null;
}

function formatPlaybackTimestamp(timestampMs: number): string {
  const safeTimestamp = Math.max(0, Math.round(timestampMs));
  const totalSeconds = Math.floor(safeTimestamp / 1000);
  const milliseconds = safeTimestamp % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
  return `${clock}.${String(milliseconds).padStart(3, '0')}`;
}

async function triggerNamedDownload(url: string, filename: string): Promise<void> {
  if (typeof document === 'undefined') {
    return;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Could not download the export bundle.');
  }

  const blob = await response.blob();
  const objectUrl = globalThis.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => {
    globalThis.URL.revokeObjectURL(objectUrl);
  }, 0);
}

async function downloadExportBundle(bundle: ExportBundle, downloadName?: string): Promise<void> {
  const bundleUrl = absoluteApiUrl(bundle.zip_url);
  const normalizedDownloadName = typeof downloadName === 'string' ? normalizeZipFilename(downloadName) : null;

  if (normalizedDownloadName) {
    await triggerNamedDownload(bundleUrl, normalizedDownloadName);
    return;
  }

  triggerDownload(bundleUrl);
}

function buildImportFileSignature(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function createImportQueueItemFromFile(file: File): ImportQueueItem {
  return {
    localId: createLocalId('upload'),
    filename: file.name,
    file,
    status: 'pending',
    recordingId: null,
    error: null,
    signature: buildImportFileSignature(file),
  };
}

function splitFilename(value: string): { base: string; extension: string } {
  const lastDotIndex = value.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex === value.length - 1) {
    return { base: value, extension: '' };
  }
  return {
    base: value.slice(0, lastDotIndex),
    extension: value.slice(lastDotIndex),
  };
}

function joinFilename(base: string, extension: string): string {
  const normalizedBase = base.trim();
  return `${normalizedBase}${extension}`;
}

function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function createImportQueueItemFromRecording(recording: RecordingSummary): ImportQueueItem {
  return {
    localId: `recording-${recording.id}`,
    filename: recording.filename,
    file: null,
    status: 'uploaded',
    recordingId: recording.id,
    error: null,
    signature: null,
  };
}

function syncImportQueueWithRecordings(current: ImportQueueItem[], recordings: RecordingSummary[]): ImportQueueItem[] {
  const recordingsById = new Map(recordings.map((recording) => [recording.id, recording]));
  const seenRecordingIds = new Set<string>();
  const nextQueue: ImportQueueItem[] = [];

  current.forEach((item) => {
    if (!item.recordingId) {
      nextQueue.push(item);
      return;
    }

    const recording = recordingsById.get(item.recordingId);
    if (!recording) {
      return;
    }

    seenRecordingIds.add(recording.id);
    nextQueue.push({
      ...createImportQueueItemFromRecording(recording),
      localId: item.localId,
    });
  });

  recordings.forEach((recording) => {
    if (!seenRecordingIds.has(recording.id)) {
      nextQueue.push(createImportQueueItemFromRecording(recording));
    }
  });

  return nextQueue;
}

function getUploadedImportItems(queue: ImportQueueItem[]): ImportQueueItem[] {
  return queue.filter((item) => item.status === 'uploaded' && Boolean(item.recordingId));
}

function getAnalysisTaskStatusRank(status: RunSummary['status']): number {
  if (status === 'running') {
    return 0;
  }
  if (status === 'queued') {
    return 1;
  }
  if (status === 'completed') {
    return 2;
  }
  if (status === 'failed') {
    return 3;
  }
  return 4;
}

function candidateMatchesFilter(candidate: CandidateFrame, filter: CandidateFilter): boolean {
  return filter === 'all' ? true : candidate.status === filter;
}

function getNextCandidateFocusId(candidates: CandidateFrame[], currentCandidateId: string, filter: CandidateFilter): string | null {
  const currentIndex = candidates.findIndex((candidate) => candidate.id === currentCandidateId);
  if (currentIndex === -1) {
    return null;
  }

  const remainingCandidates = candidates.slice(currentIndex + 1);
  if (filter === 'all' || filter === 'pending') {
    return remainingCandidates.find((candidate) => candidate.status === 'pending')?.id ?? null;
  }

  return remainingCandidates.find((candidate) => candidateMatchesFilter(candidate, filter))?.id ?? null;
}

type ComparisonBadge = 'both' | 'timing_shifted' | 'left_only' | 'right_only';

interface ComparisonRow {
  badge: ComparisonBadge;
  left: CandidateFrame | null;
  right: CandidateFrame | null;
  timeDeltaMs: number | null;
}

function ComparisonMetrics({ candidate }: { candidate: CandidateFrame }) {
  return (
    <div className="analysis-compare-metrics">
      <span>overall {candidate.scene_score.toFixed(2)}</span>
      {candidate.score_breakdown ? (
        <>
          <span>visual {candidate.score_breakdown.visual.toFixed(2)}</span>
          <span>text {candidate.score_breakdown.text.toFixed(2)}</span>
          <span>motion {candidate.score_breakdown.motion.toFixed(2)}</span>
          <span>{candidate.score_breakdown.changed_regions.length} regions</span>
        </>
      ) : null}
    </div>
  );
}

function buildCandidateComparison(leftCandidates: CandidateFrame[], rightCandidates: CandidateFrame[]): ComparisonRow[] {
  const left = [...leftCandidates].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const right = [...rightCandidates].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const usedRightIds = new Set<string>();
  const rows: ComparisonRow[] = [];

  left.forEach((leftCandidate) => {
    let bestMatch: CandidateFrame | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    right.forEach((rightCandidate) => {
      if (usedRightIds.has(rightCandidate.id)) {
        return;
      }
      const delta = Math.abs(rightCandidate.timestamp_ms - leftCandidate.timestamp_ms);
      if (delta <= 750 && delta < bestDelta) {
        bestMatch = rightCandidate;
        bestDelta = delta;
      }
    });

    if (bestMatch) {
      const matchedCandidate = bestMatch;
      usedRightIds.add(matchedCandidate.id);
      rows.push({
        badge: bestDelta > 250 ? 'timing_shifted' : 'both',
        left: leftCandidate,
        right: matchedCandidate,
        timeDeltaMs: bestDelta,
      });
      return;
    }

    rows.push({ badge: 'left_only', left: leftCandidate, right: null, timeDeltaMs: null });
  });

  right.forEach((rightCandidate) => {
    if (!usedRightIds.has(rightCandidate.id)) {
      rows.push({ badge: 'right_only', left: null, right: rightCandidate, timeDeltaMs: null });
    }
  });

  return rows;
}

function App() {
  const queryClient = useQueryClient();
  const [projectName, setProjectName] = useState('');
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>('projects');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [pendingAnalysisProjectId, setPendingAnalysisProjectId] = useState<string | null>(null);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runSettings, setRunSettings] = useState<RunSettings>(defaultRunSettings);
  const [settingsFeedback, setSettingsFeedback] = useState('');
  const [globalPreset, setGlobalPreset] = useState<GlobalRunPreset | null>(() => loadGlobalRunPreset());
  const [projectDefaultSettings, setProjectDefaultSettings] = useState<RunSettings>(defaultRunSettings);
  const [importQueue, setImportQueue] = useState<ImportQueueItem[]>([]);
  const [importSelectionFeedback, setImportSelectionFeedback] = useState('');
  const [previewRecordingId, setPreviewRecordingId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState<string>('');
  const [analysisActionMessage, setAnalysisActionMessage] = useState<string>('');
  const [appError, setAppError] = useState<string>('');
  const [bulkDeletePending, setBulkDeletePending] = useState(false);
  const [bulkExportPending, setBulkExportPending] = useState(false);
  const [viewportSize, setViewportSize] = useState(() => ({
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
  }));
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: health, refetchInterval: 30_000 });
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const projectDetailQuery = useQuery({
    queryKey: ['project', selectedProjectId],
    queryFn: () => getProject(selectedProjectId as string),
    enabled: Boolean(selectedProjectId),
  });
  const recordingDetailQuery = useQuery({
    queryKey: ['recording', selectedRecordingId],
    queryFn: () => getRecording(selectedRecordingId as string),
    enabled: Boolean(selectedRecordingId),
    refetchInterval: (query) => {
      const recording = query.state.data;
      return recording?.runs.some((run) => activeRunStatuses.includes(run.status)) ? 1500 : false;
    },
  });
  const runDetailQuery = useQuery({
    queryKey: ['run', selectedRunId],
    queryFn: () => getRun(selectedRunId as string),
    enabled: Boolean(selectedRunId),
    refetchInterval: (query) => {
      const run = query.state.data as RunDetail | undefined;
      return run && activeRunStatuses.includes(run.summary.status) ? 2000 : false;
    },
  });
  const projectRecordings = projectDetailQuery.data?.recordings ?? [];
  const analysisRecordingQueries = useQueries({
    queries: projectRecordings.map((recording) => ({
      queryKey: ['recording', recording.id, 'analysis'],
      queryFn: () => getRecording(recording.id),
      enabled: workflowStage === 'analysis' && Boolean(selectedProjectId),
      refetchInterval: (query: { state: { data: RecordingDetail | undefined } }) =>
        query.state.data?.runs.some((run) => activeRunStatuses.includes(run.status)) ? 1500 : false,
    })),
  });

  useEffect(() => {
    if (!selectedProjectId) {
      setRunSettings(defaultRunSettings);
      setProjectDefaultSettings(defaultRunSettings);
      setSettingsFeedback('');
      setImportQueue([]);
      setImportSelectionFeedback('');
      setPendingAnalysisProjectId(null);
      setPreviewRecordingId(null);
      setWorkflowStage('projects');
      return;
    }

    const projectPreset = loadProjectRunPreset(selectedProjectId);
    const nextSettings = projectPreset?.settings ?? globalPreset?.settings ?? defaultRunSettings;
    setProjectDefaultSettings(nextSettings);
    setRunSettings(nextSettings);
    setSettingsFeedback('');
  }, [selectedProjectId]);

  useEffect(() => {
    function syncViewportSize() {
      setViewportSize({
        height: window.innerHeight,
        width: window.innerWidth,
      });
    }

    syncViewportSize();
    window.addEventListener('resize', syncViewportSize);
    return () => window.removeEventListener('resize', syncViewportSize);
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    setImportQueue((current) => syncImportQueueWithRecordings(current, projectDetailQuery.data?.recordings ?? []));
  }, [projectDetailQuery.data?.recordings, selectedProjectId]);

  useEffect(() => {
    if (!pendingAnalysisProjectId || pendingAnalysisProjectId !== selectedProjectId) {
      return;
    }

    const recordings = projectDetailQuery.data?.recordings ?? [];
    if (recordings.length > 0) {
      setSelectedRecordingId(recordings[0].id);
      setSelectedRunId(null);
      setPendingAnalysisProjectId(null);
      return;
    }

    if (projectDetailQuery.isFetched && !projectDetailQuery.isFetching) {
      setWorkflowStage('import');
      setPendingAnalysisProjectId(null);
    }
  }, [
    pendingAnalysisProjectId,
    projectDetailQuery.data?.recordings,
    projectDetailQuery.isFetched,
    projectDetailQuery.isFetching,
    selectedProjectId,
  ]);

  useEffect(() => {
    if (!importSelectionFeedback) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => setImportSelectionFeedback(''), 2400);
    return () => globalThis.clearTimeout(timeoutId);
  }, [importSelectionFeedback]);

  useEffect(() => {
    const recordings = projectDetailQuery.data?.recordings ?? [];
    const stillSelected = recordings.some((recording) => recording.id === selectedRecordingId);
    if (!stillSelected) {
      setSelectedRecordingId(null);
      setSelectedRunId(null);
    }
  }, [projectDetailQuery.data, selectedRecordingId]);

  useEffect(() => {
    if (!previewRecordingId) {
      return;
    }
    if (!projectRecordings.some((recording) => recording.id === previewRecordingId)) {
      setPreviewRecordingId(null);
    }
  }, [previewRecordingId, projectRecordings]);

  useEffect(() => {
    const runs = recordingDetailQuery.data?.runs ?? [];
    const stillSelected = runs.some((run) => run.id === selectedRunId);
    if (!stillSelected) {
      setSelectedRunId(null);
    }
  }, [recordingDetailQuery.data, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || !runDetailQuery.data) {
      return;
    }
    if (!activeRunStatuses.includes(runDetailQuery.data.summary.status)) {
      return;
    }

    const socketUrl = new URL(`/runs/${selectedRunId}/events`, API_BASE).toString().replace(/^http/, 'ws');
    const socket = new WebSocket(socketUrl);

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { message?: string };
      if (payload.message) {
        setLiveMessage(payload.message);
      }
      queryClient.invalidateQueries({ queryKey: ['run', selectedRunId] });
      queryClient.invalidateQueries({ queryKey: ['recording', selectedRecordingId] });
    };

    socket.onerror = () => {
      setLiveMessage('Live progress connection dropped. Polling will continue.');
    };

    return () => socket.close();
  }, [queryClient, runDetailQuery.data, selectedRecordingId, selectedRunId]);

  const createProjectMutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      setProjectName('');
      openProject(project.id, 'import');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const updateProjectMutation = useMutation({
    mutationFn: ({ name, projectId }: { name: string; projectId: string }) => updateProject(projectId, name),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const importRecordingMutation = useMutation({
    mutationFn: ({ file, filename, projectId }: { file: File; filename?: string; localId?: string; projectId: string }) =>
      importRecording(projectId, file, filename),
    onSuccess: (recording, variables) => {
      if (variables.localId) {
        setImportQueue((current) =>
          current.map((item) =>
            item.localId === variables.localId
              ? {
                  ...item,
                  filename: recording.filename,
                  file: null,
                  status: 'uploaded',
                  recordingId: recording.id,
                  error: null,
                  signature: null,
                }
              : item,
          ),
        );
      }
      setSelectedRecordingId(recording.id);
      setSelectedRunId(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', recording.project_id] });
      queryClient.invalidateQueries({ queryKey: ['recording', recording.id] });
    },
    onError: (error: Error, variables) => {
      setAppError(error.message);
      if (variables.localId) {
        setImportQueue((current) =>
          current.map((item) =>
            item.localId === variables.localId
              ? {
                  ...item,
                  status: 'error',
                  error: error.message,
                }
              : item,
          ),
        );
      }
    },
  });

  const updateRecordingMutation = useMutation({
    mutationFn: ({ filename, recordingId }: { filename: string; recordingId: string }) => updateRecording(recordingId, filename),
    onSuccess: (recording) => {
      setImportQueue((current) =>
        current.map((item) =>
          item.recordingId === recording.id
            ? {
                ...item,
                filename: recording.filename,
              }
            : item,
        ),
      );
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', recording.project_id] });
      queryClient.invalidateQueries({ queryKey: ['recording', recording.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const deleteRecordingMutation = useMutation({
    mutationFn: ({ recordingId }: { localId?: string; recordingId: string }) => deleteRecording(recordingId),
    onSuccess: (_result, variables) => {
      setImportQueue((current) => current.filter((item) => item.localId !== variables.localId && item.recordingId !== variables.recordingId));
      if (selectedRecordingId === variables.recordingId) {
        setSelectedRecordingId(null);
        setSelectedRunId(null);
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] });
      queryClient.removeQueries({ queryKey: ['recording', variables.recordingId] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const createRunMutation = useMutation({
    mutationFn: ({ recordingId, settings }: { recordingId: string; settings: RunSettings }) => createRun(recordingId, settings),
    onSuccess: (run) => {
      setSelectedRunId(run.id);
      setLiveMessage('Queued detection job.');
      queryClient.invalidateQueries({ queryKey: ['recording', run.recording_id] });
      queryClient.invalidateQueries({ queryKey: ['run', run.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const abortRunMutation = useMutation({
    mutationFn: abortRun,
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['run', run.id] });
      queryClient.invalidateQueries({ queryKey: ['recording', run.recording_id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const updateCandidateMutation = useMutation({
    mutationFn: ({ candidateId, payload }: { candidateId: string; payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>> }) =>
      updateCandidate(candidateId, payload),
    onSuccess: (candidate) => {
      queryClient.invalidateQueries({ queryKey: ['run', candidate.run_id] });
      queryClient.invalidateQueries({ queryKey: ['recording', candidate.recording_id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const createManualCandidateMutation = useMutation({
    mutationFn: ({ runId, timestampMs }: { runId: string; timestampMs: number }) => createManualCandidate(runId, timestampMs),
    onSuccess: async (candidate) => {
      setAnalysisActionMessage(`Added manual step at ${candidate.timestamp_tc}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        selectedProjectId
          ? queryClient.fetchQuery({
              queryKey: ['project', selectedProjectId],
              queryFn: () => getProject(selectedProjectId),
            })
          : Promise.resolve(),
        queryClient.fetchQuery({
          queryKey: ['run', candidate.run_id],
          queryFn: () => getRun(candidate.run_id),
        }),
        queryClient.fetchQuery({
          queryKey: ['recording', candidate.recording_id],
          queryFn: () => getRecording(candidate.recording_id),
        }),
        queryClient.fetchQuery({
          queryKey: ['recording', candidate.recording_id, 'analysis'],
          queryFn: () => getRecording(candidate.recording_id),
        }),
      ]);
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const exportRunMutation = useMutation({
    mutationFn: async ({ downloadName, mode, runId }: { downloadName?: string; mode: ExportMode; runId: string }) => {
      const bundle = await exportRun(runId, mode);
      await downloadExportBundle(bundle, downloadName);
      return { runId };
    },
    onSuccess: ({ runId }) => {
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
      const task = analysisTaskItemByRunId.get(runId);
      if (task) {
        queryClient.invalidateQueries({ queryKey: ['recording', task.run.recording_id] });
        queryClient.invalidateQueries({ queryKey: ['recording', task.run.recording_id, 'analysis'] });
      }
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const selectedProject = useMemo(() => {
    return projectsQuery.data?.find((project) => project.id === selectedProjectId) ?? null;
  }, [projectsQuery.data, selectedProjectId]);
  const activeProject = projectDetailQuery.data?.project ?? selectedProject;
  const selectedProjectSummary = activeProject?.id === selectedProjectId ? activeProject : selectedProject;
  const selectedProjectCanJumpToAnalysis = Boolean(selectedProjectSummary?.recording_count);
  const hasSelectedProject = Boolean(selectedProjectId);
  const activeViewportStage: WorkflowStage = workflowStage === 'projects' || !hasSelectedProject ? 'projects' : workflowStage;
  const viewportMinimum = workflowViewportMinimums[activeViewportStage];
  const isViewportTooSmall = viewportSize.width < viewportMinimum.width || viewportSize.height < viewportMinimum.height;
  const viewportWarning = isViewportTooSmall ? (
    <ViewportWarning
      currentHeight={viewportSize.height}
      currentWidth={viewportSize.width}
      minimumHeight={viewportMinimum.height}
      minimumWidth={viewportMinimum.width}
    />
  ) : null;

  const selectedRecording = recordingDetailQuery.data ?? null;
  const selectedRun = runDetailQuery.data ?? null;
  const selectedRecordingSummary = projectRecordings.find((recording) => recording.id === selectedRecordingId) ?? null;
  const previewRecording = projectRecordings.find((recording) => recording.id === previewRecordingId) ?? null;
  const effectiveProjectDefaultSettings = useMemo(
    () => clampRunSettingsForRecording(projectDefaultSettings, selectedRecordingSummary?.fps ?? null),
    [projectDefaultSettings, selectedRecordingSummary?.fps],
  );
  const healthWarning = healthQuery.data && healthQuery.data.missing_tools.length > 0;
  const presetText = useMemo(() => serializeRunPresetText(runSettings), [runSettings]);
  const uploadedImportItems = useMemo(() => getUploadedImportItems(importQueue), [importQueue]);
  const canCompleteImport = uploadedImportItems.length > 0;
  const analysisRecordingsLoading =
    workflowStage === 'analysis' &&
    pendingAnalysisProjectId === selectedProjectId &&
    (!projectDetailQuery.data || projectDetailQuery.data.recordings.length === 0);
  const analysisTaskItems = useMemo<AnalysisTaskItem[]>(() => {
    return projectRecordings
      .flatMap((recording, index) => {
      const detail = analysisRecordingQueries[index]?.data;
        return (detail?.runs ?? []).map((run) => ({ recording, run }));
      })
      .sort((left, right) => {
        const statusRankDelta = getAnalysisTaskStatusRank(left.run.status) - getAnalysisTaskStatusRank(right.run.status);
        if (statusRankDelta !== 0) {
          return statusRankDelta;
        }
        return new Date(right.run.created_at).getTime() - new Date(left.run.created_at).getTime();
      });
  }, [analysisRecordingQueries, projectRecordings]);

  useEffect(() => {
    setRunSettings((current) => {
      const nextSettings = clampRunSettingsForRecording(current, selectedRecordingSummary?.fps ?? null);
      return areRunSettingsEqual(current, nextSettings) ? current : nextSettings;
    });
  }, [selectedRecordingSummary?.fps, runSettings.allow_high_fps_sampling]);

  const latestRunByRecordingId = useMemo(() => {
    const nextMap = new Map<string, RunSummary>();
    analysisTaskItems.forEach((item) => {
      const existing = nextMap.get(item.recording.id);
      if (!existing || new Date(item.run.created_at).getTime() > new Date(existing.created_at).getTime()) {
        nextMap.set(item.recording.id, item.run);
      }
    });
    return nextMap;
  }, [analysisTaskItems]);
  const analysisTaskItemByRunId = useMemo(() => {
    return new Map(analysisTaskItems.map((item) => [item.run.id, item]));
  }, [analysisTaskItems]);
  const candidateSimilarityLinks = useMemo(() => {
    const links = new Map<string, SimilarLink>();
    if (!selectedRun) {
      return links;
    }

    const candidatesById = new Map(selectedRun.candidates.map((candidate) => [candidate.id, candidate]));
    const firstCandidateByGroup = new Map<string, CandidateFrame>();

    selectedRun.candidates.forEach((candidate) => {
      const directTarget = candidate.similar_to_candidate_id ? candidatesById.get(candidate.similar_to_candidate_id) : null;
      const groupedTarget = !directTarget && candidate.revisit_group_id ? firstCandidateByGroup.get(candidate.revisit_group_id) : null;
      const target = directTarget ?? groupedTarget;

      if (target && target.id !== candidate.id) {
        links.set(candidate.id, {
          targetId: `candidate-${target.id}`,
          label: `similar to candidate ${target.detector_index}`,
        });
      }

      if (candidate.revisit_group_id && !firstCandidateByGroup.has(candidate.revisit_group_id)) {
        firstCandidateByGroup.set(candidate.revisit_group_id, candidate);
      }
    });

    return links;
  }, [selectedRun]);
  const acceptedStepSimilarityLinks = useMemo(() => {
    const links = new Map<string, SimilarLink>();
    if (!selectedRun) {
      return links;
    }

    const acceptedStepsById = new Map(selectedRun.accepted_steps.map((step) => [step.step_id, step]));
    selectedRun.accepted_steps.forEach((step) => {
      if (!step.similar_to_step_id) {
        return;
      }
      const target = acceptedStepsById.get(step.similar_to_step_id);
      if (!target || target.step_id === step.step_id) {
        return;
      }
      links.set(step.step_id, {
        targetId: `accepted-step-${target.step_id}`,
        label: `Returns to ${target.step_id}`,
      });
    });

    return links;
  }, [selectedRun]);

  async function waitForRunToLeaveActiveState(runId: string): Promise<RunDetail> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const run = await getRun(runId);
      if (!activeRunStatuses.includes(run.summary.status)) {
        return run;
      }
      await sleep(1000);
    }
    throw new Error('Timed out while waiting for the task to stop.');
  }

  function clearAnalysisMessages() {
    setAppError('');
    setAnalysisActionMessage('');
  }

  function openProject(projectId: string, targetStage: ProjectEntryTarget) {
    setSelectedProjectId(projectId);
    setPendingAnalysisProjectId(targetStage === 'analysis' ? projectId : null);
    setSelectedRecordingId(null);
    setSelectedRunId(null);
    setPreviewRecordingId(null);
    setWorkflowStage(targetStage);
    clearAnalysisMessages();
  }

  function handleCreateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim()) {
      return;
    }
    clearAnalysisMessages();
    createProjectMutation.mutate(projectName.trim());
  }

  function setAnalysisSelection(recordingId: string, jumpToRunDetail: boolean) {
    const latestRun = latestRunByRecordingId.get(recordingId) ?? null;
    setSelectedRecordingId(recordingId);
    setSelectedRunId(latestRun?.id ?? null);
    if (latestRun && jumpToRunDetail) {
      jumpToAnalysisAnchor('analysis-run-detail');
    }
  }

  function handleSelectRecording(recordingId: string) {
    setAnalysisSelection(recordingId, true);
  }

  function handlePreviewRecording(recordingId: string) {
    setPreviewRecordingId((current) => {
      const nextRecordingId = current === recordingId ? null : recordingId;
      if (nextRecordingId) {
        jumpToAnalysisAnchor('analysis-video-preview');
      }
      return nextRecordingId;
    });
  }

  function handleStartAnalysisRun() {
    if (!selectedRecordingId) {
      return;
    }
    clearAnalysisMessages();
    createRunMutation.mutate({ recordingId: selectedRecordingId, settings: runSettings });
  }

  function handleSaveProjectDefault() {
    if (!selectedProjectId) {
      return;
    }
    const savedPreset = persistProjectRunPreset(selectedProjectId, runSettings);
    setProjectDefaultSettings(savedPreset.settings);
    setSettingsFeedback('Saved the current settings for this project.');
  }

  function handleSaveBrowserDefault() {
    const savedPreset = persistGlobalRunPreset(runSettings);
    setGlobalPreset(savedPreset);
    setSettingsFeedback('Saved the current settings as universal defaults.');
  }

  function applyAnalysisSettings(nextSettings: RunSettings, feedback: string) {
    setRunSettings(clampRunSettingsForRecording(sanitizeRunSettings(nextSettings), selectedRecordingSummary?.fps ?? null));
    setSettingsFeedback(feedback);
  }

  function handleResetToProjectDefaults() {
    applyAnalysisSettings(effectiveProjectDefaultSettings, "Reset the current settings to this project's defaults.");
  }

  function handleResetToUniversalDefaults() {
    applyAnalysisSettings(globalPreset?.settings ?? defaultRunSettings, 'Reset the current settings to the universal defaults.');
  }

  function handleApplyImportedPreset(settings: RunSettings) {
    applyAnalysisSettings(settings, 'Applied preset text to the active analysis parameters.');
  }

  async function handleCreateManualRunCandidate(runId: string, timestampMs: number) {
    clearAnalysisMessages();
    return createManualCandidateMutation.mutateAsync({ runId, timestampMs });
  }

  function confirmDeleteRecording(recordingId: string, filename: string) {
    if (!window.confirm(`Delete ${filename} and every run, screenshot, and export created from it?`)) {
      return;
    }
    deleteRecordingMutation.mutate({ recordingId });
  }

  async function handleRenameProject(projectId: string, name: string) {
    clearAnalysisMessages();
    await updateProjectMutation.mutateAsync({ name, projectId });
  }

  async function handleRenameRecording(recordingId: string, filename: string) {
    clearAnalysisMessages();
    await updateRecordingMutation.mutateAsync({ filename, recordingId });
  }

  async function handleRenameImportItem(localId: string, filename: string) {
    const queueItem = importQueue.find((item) => item.localId === localId);
    if (!queueItem) {
      return;
    }

    if (queueItem.recordingId) {
      await handleRenameRecording(queueItem.recordingId, filename);
      return;
    }

    setImportQueue((current) =>
      current.map((item) =>
        item.localId === localId
          ? {
              ...item,
              filename,
            }
          : item,
      ),
    );
  }

  function setProjectStage(stage: WorkflowStage) {
    if (stage === 'projects') {
      setPendingAnalysisProjectId(null);
      setWorkflowStage('projects');
      return;
    }
    if (!selectedProjectId) {
      return;
    }

    if (workflowStage === 'projects') {
      if (stage === 'analysis' && !selectedProjectCanJumpToAnalysis) {
        return;
      }
      openProject(selectedProjectId, stage);
      return;
    }

    if (stage === 'import') {
      setPendingAnalysisProjectId(null);
      setWorkflowStage('import');
      return;
    }

    handleNavigateToAnalysis(true);
  }

  function jumpToAnalysisAnchor(anchorId: string) {
    if (typeof window === 'undefined') {
      return;
    }
    window.setTimeout(() => jumpToAnchor(anchorId), 0);
  }

  function handleJumpToAnalysisSelection() {
    if (selectedRun) {
      jumpToAnchor('analysis-run-detail');
      return;
    }
    if (previewRecordingId) {
      jumpToAnchor('analysis-video-preview');
      return;
    }
    jumpToAnchor('analysis-parameters');
  }

  function handleSelectTaskRun(recordingId: string, runId: string, anchorId = 'analysis-run-detail') {
    setSelectedRecordingId(recordingId);
    setSelectedRunId(runId);
    jumpToAnalysisAnchor(anchorId);
  }

  function handleImportFileSelection(files: FileList | File[]) {
    const incomingFiles = Array.from(files);
    if (!incomingFiles.length) {
      return;
    }
    let ignoredCount = 0;
    setImportQueue((current) => {
      const knownSignatures = new Set(current.map((item) => item.signature).filter((value): value is string => Boolean(value)));
      const additions = incomingFiles.flatMap((file) => {
        const signature = buildImportFileSignature(file);
        if (knownSignatures.has(signature)) {
          ignoredCount += 1;
          return [];
        }
        knownSignatures.add(signature);
        return [createImportQueueItemFromFile(file)];
      });
      return additions.length ? [...current, ...additions] : current;
    });
    if (ignoredCount > 0) {
      setImportSelectionFeedback(`${ignoredCount} duplicate ${ignoredCount === 1 ? 'video was' : 'videos were'} ignored.`);
    } else {
      setImportSelectionFeedback('');
    }
  }

  function handleUploadImportItem(localId: string) {
    if (!selectedProjectId) {
      return;
    }
    const queueItem = importQueue.find((item) => item.localId === localId);
    if (!queueItem?.file || queueItem.status === 'uploading') {
      return;
    }

    clearAnalysisMessages();
    setImportQueue((current) =>
      current.map((item) =>
        item.localId === localId
          ? {
              ...item,
              status: 'uploading',
              error: null,
            }
          : item,
      ),
    );
    importRecordingMutation.mutate({
      projectId: selectedProjectId,
      file: queueItem.file,
      filename: queueItem.filename,
      localId,
    });
  }

  function handleDeleteImportItem(localId: string) {
    const queueItem = importQueue.find((item) => item.localId === localId);
    if (!queueItem || queueItem.status === 'uploading') {
      return;
    }
    if (queueItem.recordingId) {
      if (!window.confirm(`Delete ${queueItem.filename} and every run, screenshot, and export created from it?`)) {
        return;
      }
      deleteRecordingMutation.mutate({ localId, recordingId: queueItem.recordingId });
      return;
    }
    setImportQueue((current) => current.filter((item) => item.localId !== localId));
  }

  function handleNavigateToAnalysis(promptWhenEmpty: boolean) {
    if (!selectedProjectId) {
      return;
    }
    const uploadedRows = getUploadedImportItems(importQueue);
    if (!uploadedRows.length) {
      if (!promptWhenEmpty) {
        return;
      }
      const confirmed = window.confirm('Analysis is usually most useful after at least one uploaded video. Continue without any uploaded videos?');
      if (!confirmed) {
        return;
      }
    }

    const persistedRows = uploadedRows;
    const nextRecordingId = persistedRows[persistedRows.length - 1]?.recordingId ?? projectDetailQuery.data?.recordings[0]?.id ?? null;
    setPendingAnalysisProjectId(null);
    setImportQueue(persistedRows);
    setSelectedRecordingId(nextRecordingId);
    setSelectedRunId(null);
    setWorkflowStage('analysis');
  }

  async function handleExportRun(runId: string, mode: ExportMode, downloadName?: string): Promise<void> {
    clearAnalysisMessages();
    await exportRunMutation.mutateAsync({ downloadName, mode, runId });
    setAnalysisActionMessage(mode === 'accepted' ? 'Exported accepted steps.' : 'Exported all steps.');
  }

  async function handleBulkUpdateCandidates(
    runId: string,
    recordingId: string,
    candidateIds: string[],
    status: CandidateStatus,
  ): Promise<string[]> {
    const uniqueCandidateIds = Array.from(new Set(candidateIds));
    if (!uniqueCandidateIds.length) {
      return [];
    }

    clearAnalysisMessages();

    const results = await Promise.allSettled(uniqueCandidateIds.map((candidateId) => updateCandidate(candidateId, { status })));
    const failedCandidateIds: string[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        return;
      }
      failedCandidateIds.push(uniqueCandidateIds[index]);
    });

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['run', runId] }),
      queryClient.invalidateQueries({ queryKey: ['recording', recordingId] }),
      queryClient.invalidateQueries({ queryKey: ['recording', recordingId, 'analysis'] }),
    ]);

    const successCount = uniqueCandidateIds.length - failedCandidateIds.length;
    if (successCount > 0) {
      setAnalysisActionMessage(
        `${status === 'accepted' ? 'Accepted' : status === 'rejected' ? 'Rejected' : 'Updated'} ${successCount} ${
          successCount === 1 ? 'candidate' : 'candidates'
        }.`,
      );
    }
    if (failedCandidateIds.length > 0) {
      setAppError(
        `Could not update ${failedCandidateIds.length === 1 ? '1 selected candidate' : `${failedCandidateIds.length} selected candidates`}.`,
      );
    }

    return failedCandidateIds;
  }

  async function handleExportTaskRuns(runIds: string[]): Promise<void> {
    const uniqueRunIds = Array.from(new Set(runIds));
    const tasks = uniqueRunIds
      .map((runId) => analysisTaskItemByRunId.get(runId))
      .filter((item): item is AnalysisTaskItem => Boolean(item));
    const completedTasks = tasks.filter((item) => item.run.status === 'completed');
    const skippedCount = tasks.length - completedTasks.length;

    clearAnalysisMessages();
    if (!completedTasks.length) {
      setAppError('Only completed tasks can be exported.');
      return;
    }

    setBulkExportPending(true);
    try {
      const results = await Promise.allSettled(
        completedTasks.map(async (item) => {
          const runDetail = await getRun(item.run.id);
          const hasReviewedItems = runDetail.candidates.some((candidate) => candidate.status !== 'pending');
          const hasAcceptedItems = runDetail.candidates.some((candidate) => candidate.status === 'accepted');

          if (hasReviewedItems && !hasAcceptedItems) {
            throw new Error('This reviewed task has no accepted candidates to export.');
          }

          const exportMode: ExportMode = hasReviewedItems ? 'accepted' : 'all';
          const bundle = await exportRun(item.run.id, exportMode);
          await queryClient.invalidateQueries({ queryKey: ['run', item.run.id] });
          await queryClient.invalidateQueries({ queryKey: ['recording', item.run.recording_id] });
          triggerDownload(absoluteApiUrl(bundle.zip_url));
          return item.run.id;
        }),
      );

      let successCount = 0;
      const failures: string[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          successCount += 1;
          return;
        }
        failures.push(
          `${completedTasks[index].recording.filename}: ${result.reason instanceof Error ? result.reason.message : 'Export failed.'}`,
        );
      });

      if (successCount > 0) {
        const skipSuffix = skippedCount ? ` Skipped ${skippedCount} non-completed ${skippedCount === 1 ? 'task' : 'tasks'}.` : '';
        setAnalysisActionMessage(`Exported ${successCount} ${successCount === 1 ? 'task' : 'tasks'}.${skipSuffix}`);
      }
      if (failures.length > 0) {
        setAppError(`Could not export ${failures.length === 1 ? 'a task' : `${failures.length} tasks`}: ${failures.join(' · ')}`);
      }
    } finally {
      setBulkExportPending(false);
    }
  }

  async function handleDeleteSelectedRuns(runIds: string[]): Promise<string[] | null> {
    const uniqueRunIds = Array.from(new Set(runIds));
    const tasks = uniqueRunIds
      .map((runId) => analysisTaskItemByRunId.get(runId))
      .filter((item): item is AnalysisTaskItem => Boolean(item));

    if (!tasks.length) {
      return [];
    }

    const activeTasks = tasks.filter((item) => activeRunStatuses.includes(item.run.status));
    const confirmCopy = activeTasks.length
      ? `Delete ${tasks.length} selected ${tasks.length === 1 ? 'task' : 'tasks'}? ${activeTasks.length} active ${
          activeTasks.length === 1 ? 'task will' : 'tasks will'
        } be ended first, then deleted.`
      : `Delete ${tasks.length} selected ${tasks.length === 1 ? 'task' : 'tasks'}?`;
    if (!window.confirm(confirmCopy)) {
      return null;
    }

    clearAnalysisMessages();
    setBulkDeletePending(true);

    const failedRunIds = new Set<string>();
    const failures: string[] = [];
    let deletedCount = 0;

    try {
      if (activeTasks.length > 0) {
        const abortResults = await Promise.allSettled(
          activeTasks.map(async (item) => {
            const run = await abortRun(item.run.id);
            await queryClient.invalidateQueries({ queryKey: ['run', run.id] });
            await queryClient.invalidateQueries({ queryKey: ['recording', run.recording_id] });
            return run.id;
          }),
        );

        abortResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            return;
          }
          failedRunIds.add(activeTasks[index].run.id);
          failures.push(
            `${activeTasks[index].recording.filename}: ${
              result.reason instanceof Error ? result.reason.message : 'Could not end the task before deleting it.'
            }`,
          );
        });

        const waitingTasks = activeTasks.filter((item) => !failedRunIds.has(item.run.id));
        const waitResults = await Promise.allSettled(
          waitingTasks.map(async (item) => {
            const run = await waitForRunToLeaveActiveState(item.run.id);
            await queryClient.invalidateQueries({ queryKey: ['run', run.summary.id] });
            await queryClient.invalidateQueries({ queryKey: ['recording', run.summary.recording_id] });
            return run.summary.id;
          }),
        );

        waitResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            return;
          }
          failedRunIds.add(waitingTasks[index].run.id);
          failures.push(
            `${waitingTasks[index].recording.filename}: ${
              result.reason instanceof Error ? result.reason.message : 'Timed out waiting for the task to stop.'
            }`,
          );
        });
      }

      const deletableTasks = tasks.filter((item) => !failedRunIds.has(item.run.id));
      const deleteResults = await Promise.allSettled(
        deletableTasks.map(async (item) => {
          await deleteRun(item.run.id);
          if (selectedRunId === item.run.id) {
            setSelectedRunId(null);
          }
          await queryClient.invalidateQueries({ queryKey: ['recording', item.run.recording_id] });
          queryClient.removeQueries({ queryKey: ['run', item.run.id] });
          return item.run.id;
        }),
      );

      deleteResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          deletedCount += 1;
          return;
        }
        failedRunIds.add(deletableTasks[index].run.id);
        failures.push(
          `${deletableTasks[index].recording.filename}: ${
            result.reason instanceof Error ? result.reason.message : 'Delete failed.'
          }`,
        );
      });

      if (selectedProjectId) {
        await queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] });
      }
      await queryClient.invalidateQueries({ queryKey: ['projects'] });

      if (deletedCount > 0) {
        setAnalysisActionMessage(`Deleted ${deletedCount} ${deletedCount === 1 ? 'task' : 'tasks'}.`);
      }
      if (failures.length > 0) {
        setAppError(`Could not delete ${failures.length === 1 ? 'a task' : `${failures.length} tasks`}: ${failures.join(' · ')}`);
      }

      return tasks.filter((item) => failedRunIds.has(item.run.id)).map((item) => item.run.id);
    } finally {
      setBulkDeletePending(false);
    }
  }

  if (workflowStage === 'projects' || !hasSelectedProject) {
    return (
      <>
        <EntryScreen
          appError={appError}
          healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
          isCreating={createProjectMutation.isPending}
          onCreate={handleCreateProject}
          onNavigateStage={setProjectStage}
          onOpenProject={openProject}
          onProjectNameChange={setProjectName}
          onRenameProject={handleRenameProject}
          projectName={projectName}
          projects={projectsQuery.data ?? []}
          projectsLoading={projectsQuery.isLoading}
          selectedProjectCanJumpToAnalysis={selectedProjectCanJumpToAnalysis}
          selectedProjectId={selectedProjectId}
        />
        <AppWatermark />
        {viewportWarning}
      </>
    );
  }

  if (workflowStage === 'import') {
    return (
      <>
        <ImportScreen
          appError={appError}
          canComplete={canCompleteImport}
          healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
          isDeleting={deleteRecordingMutation.isPending}
          isUploadBlocked={Boolean(healthWarning)}
          onDeleteRow={handleDeleteImportItem}
          onDone={() => void handleNavigateToAnalysis(false)}
          onFilesSelected={handleImportFileSelection}
          onNavigateStage={setProjectStage}
          onRenameProject={handleRenameProject}
          onRenameRow={handleRenameImportItem}
          onUploadRow={handleUploadImportItem}
          project={activeProject}
          rows={importQueue}
          selectionFeedback={importSelectionFeedback}
        />
        <AppWatermark />
        {viewportWarning}
      </>
    );
  }

  return (
    <>
      <AnalysisScreen
        acceptedStepSimilarityLinks={acceptedStepSimilarityLinks}
        abortRunPending={abortRunMutation.isPending}
        activeProject={activeProject}
        analysisActionMessage={analysisActionMessage}
        analysisTaskItems={analysisTaskItems}
        appError={appError}
        bulkDeletePending={bulkDeletePending}
        bulkExportPending={bulkExportPending}
        candidateSimilarityLinks={candidateSimilarityLinks}
        createManualCandidatePending={createManualCandidateMutation.isPending}
        createRunPending={createRunMutation.isPending}
        exportRunPending={exportRunMutation.isPending}
        healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
        healthWarning={Boolean(healthWarning)}
        liveMessage={liveMessage}
        onAbortRun={(runId) => abortRunMutation.mutate(runId)}
        onBulkUpdateCandidates={handleBulkUpdateCandidates}
        onDeleteRecording={confirmDeleteRecording}
        onDeleteSelectedRuns={handleDeleteSelectedRuns}
        onCreateManualCandidate={handleCreateManualRunCandidate}
        onApplyImportedPreset={handleApplyImportedPreset}
        onExportRun={handleExportRun}
        onExportTaskRuns={handleExportTaskRuns}
        onJumpToSelection={handleJumpToAnalysisSelection}
        onNavigateStage={setProjectStage}
        onPreviewRecording={handlePreviewRecording}
        onRenameProject={handleRenameProject}
        onRenameRecording={handleRenameRecording}
        onResetToProjectDefaults={handleResetToProjectDefaults}
        onResetToUniversalDefaults={handleResetToUniversalDefaults}
        onSaveProjectPreset={handleSaveProjectDefault}
        onSaveUniversalPreset={handleSaveBrowserDefault}
        onSelectRecording={handleSelectRecording}
        onSelectRun={handleSelectTaskRun}
        onStartRun={handleStartAnalysisRun}
        onUpdateCandidate={(candidateId, payload) => updateCandidateMutation.mutate({ candidateId, payload })}
        previewRecording={previewRecording}
        projectDefaultSettings={effectiveProjectDefaultSettings}
        recordings={projectRecordings}
        recordingsLoading={analysisRecordingsLoading}
        selectedRecording={selectedRecording}
        selectedRecordingId={selectedRecordingId}
        selectedRecordingSummary={selectedRecordingSummary}
        selectedRun={selectedRun}
        settingsFeedback={settingsFeedback}
        runSettings={runSettings}
        setRunSettings={setRunSettings}
        showPresetText={presetText}
      />
      <AppWatermark />
      {viewportWarning}
    </>
  );
}

interface EntryScreenProps {
  appError: string;
  healthMessage: string | null;
  isCreating: boolean;
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onOpenProject: (projectId: string, targetStage: ProjectEntryTarget) => void;
  onProjectNameChange: (value: string) => void;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  projectName: string;
  projects: Project[];
  projectsLoading: boolean;
  selectedProjectCanJumpToAnalysis: boolean;
  selectedProjectId: string | null;
}

interface StageNavigatorProps {
  activeStage: WorkflowStage;
  className?: string;
  disabledStages?: Partial<Record<WorkflowStage, boolean>>;
  onNavigate: (stage: WorkflowStage) => void;
}

interface ImportScreenProps {
  appError: string;
  canComplete: boolean;
  healthMessage: string | null;
  isDeleting: boolean;
  isUploadBlocked: boolean;
  onDeleteRow: (localId: string) => void;
  onDone: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onRenameRow: (localId: string, filename: string) => Promise<void>;
  onUploadRow: (localId: string) => void;
  project: Project | null;
  rows: ImportQueueItem[];
  selectionFeedback: string;
}

interface AnalysisScreenProps {
  acceptedStepSimilarityLinks: Map<string, SimilarLink>;
  abortRunPending: boolean;
  activeProject: Project | null;
  analysisActionMessage: string;
  analysisTaskItems: AnalysisTaskItem[];
  appError: string;
  bulkDeletePending: boolean;
  bulkExportPending: boolean;
  candidateSimilarityLinks: Map<string, SimilarLink>;
  createManualCandidatePending: boolean;
  createRunPending: boolean;
  exportRunPending: boolean;
  healthMessage: string | null;
  healthWarning: boolean;
  liveMessage: string;
  onAbortRun: (runId: string) => void;
  onBulkUpdateCandidates: (runId: string, recordingId: string, candidateIds: string[], status: CandidateStatus) => Promise<string[]>;
  onCreateManualCandidate: (runId: string, timestampMs: number) => Promise<CandidateFrame>;
  onDeleteRecording: (recordingId: string, filename: string) => void;
  onDeleteSelectedRuns: (runIds: string[]) => Promise<string[] | null>;
  onApplyImportedPreset: (settings: RunSettings) => void;
  onExportRun: (runId: string, mode: ExportMode, downloadName?: string) => Promise<void>;
  onExportTaskRuns: (runIds: string[]) => Promise<void>;
  onJumpToSelection: () => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onPreviewRecording: (recordingId: string) => void;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onRenameRecording: (recordingId: string, filename: string) => Promise<void>;
  onResetToProjectDefaults: () => void;
  onResetToUniversalDefaults: () => void;
  onSaveProjectPreset: () => void;
  onSaveUniversalPreset: () => void;
  onSelectRecording: (recordingId: string) => void;
  onSelectRun: (recordingId: string, runId: string, anchorId?: string) => void;
  onStartRun: () => void;
  onUpdateCandidate: (candidateId: string, payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>>) => void;
  previewRecording: RecordingSummary | null;
  projectDefaultSettings: RunSettings;
  recordings: RecordingSummary[];
  recordingsLoading: boolean;
  runSettings: RunSettings;
  selectedRecording: RecordingDetail | null;
  selectedRecordingId: string | null;
  selectedRecordingSummary: RecordingSummary | null;
  selectedRun: RunDetail | null;
  setRunSettings: React.Dispatch<React.SetStateAction<RunSettings>>;
  settingsFeedback: string;
  showPresetText: string;
}

function StageNavigator({ activeStage, className, disabledStages, onNavigate }: StageNavigatorProps) {
  return (
    <div className={className ? `stage-nav ${className}` : 'stage-nav'}>
      {workflowStages.map((stage) => (
        <button
          aria-current={stage === activeStage ? 'step' : undefined}
          className={`stage-nav-button ${stage === activeStage ? 'active' : ''}`}
          disabled={stage === activeStage || Boolean(disabledStages?.[stage])}
          key={stage}
          onClick={() => onNavigate(stage)}
          type="button"
        >
          {stage}
        </button>
      ))}
    </div>
  );
}

interface AnalysisResetDiamondButtonProps {
  className?: string;
  label: string;
  onClick: () => void;
}

function AnalysisResetDiamondButton({ className, label, onClick }: AnalysisResetDiamondButtonProps) {
  return (
    <button
      aria-label={`Reset ${label} to default`}
      className={className ? `analysis-dirty-reset ${className}` : 'analysis-dirty-reset'}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      title={`Reset ${label} to default`}
      type="button"
    >
      <span className="analysis-dirty-reset-glyph" />
    </button>
  );
}

interface AnalysisStarResetButtonProps {
  expanded?: boolean;
  onClick: () => void;
}

function AnalysisStarResetButton({ expanded = false, onClick }: AnalysisStarResetButtonProps) {
  return (
    <button
      aria-label="Open reset defaults menu"
      aria-expanded={expanded}
      className="analysis-star-reset"
      onClick={onClick}
      title="Open reset defaults menu"
      type="button"
    >
      <svg aria-hidden="true" className="analysis-star-reset-shape" viewBox="0 0 92 32">
        <polygon points={analysisResetStarPoints} />
      </svg>
      <span className="analysis-star-reset-label">reset</span>
    </button>
  );
}

interface AnalysisStepperInputProps {
  ariaLabel: string;
  className: string;
  max?: number;
  min?: number;
  onChange: (rawValue: string) => void;
  onStep: (direction: -1 | 1) => void;
  value: number | string;
}

function AnalysisStepperInput({ ariaLabel, className, max, min, onChange, onStep, value }: AnalysisStepperInputProps) {
  return (
    <div className="analysis-stepper-input">
      <div className="analysis-stepper-controls">
        <button
          aria-label={`Increase ${ariaLabel}`}
          className="analysis-stepper-button"
          onClick={() => onStep(1)}
          type="button"
        >
          <span aria-hidden="true" className="analysis-stepper-glyph up" />
        </button>
        <button
          aria-label={`Decrease ${ariaLabel}`}
          className="analysis-stepper-button"
          onClick={() => onStep(-1)}
          type="button"
        >
          <span aria-hidden="true" className="analysis-stepper-glyph down" />
        </button>
      </div>
      <input
        aria-label={ariaLabel}
        className={className}
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        type="number"
        value={value}
      />
    </div>
  );
}

function AppWatermark() {
  const [showAbout, setShowAbout] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showAbout) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (shellRef.current?.contains(event.target as Node)) {
        return;
      }
      setShowAbout(false);
    }

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [showAbout]);

  return (
    <div className="app-watermark-shell" ref={shellRef}>
      <span className="app-watermark-text">{APP_IDENTITY}</span>
      <button
        aria-expanded={showAbout}
        className={`app-watermark-about ${showAbout ? 'active' : ''}`}
        onClick={() => setShowAbout((current) => !current)}
        type="button"
      >
        about
      </button>
      {showAbout ? (
        <div className="app-watermark-popover">
          <p>Stepthrough helps researchers turn screen recordings into reviewable scene candidates for step-by-step analysis.</p>
          <p>version 0.1.0</p>
        </div>
      ) : null}
    </div>
  );
}

interface ViewportWarningProps {
  currentHeight: number;
  currentWidth: number;
  minimumHeight: number;
  minimumWidth: number;
}

function ViewportWarning({ currentHeight, currentWidth, minimumHeight, minimumWidth }: ViewportWarningProps) {
  return (
    <div className="viewport-warning-overlay" role="alert" aria-live="polite">
      <div className="viewport-warning-card">
        <h1>stepthrough works best with a larger window.</h1>
        <p>Try making your browser window wider/taller.</p>
        <p className="viewport-warning-meta">
          current window {currentWidth} × {currentHeight} · recommended minimum {minimumWidth} × {minimumHeight}
        </p>
      </div>
    </div>
  );
}

interface EditableNameProps {
  buttonClassName?: string;
  containerClassName?: string;
  disabled?: boolean;
  displayButtonClassName?: string;
  editRequestToken?: number | string | null;
  inputClassName?: string;
  lockedExtension?: boolean;
  onDisplayClick?: () => void;
  onSave: (nextValue: string) => Promise<void> | void;
  renameLabel: string;
  showRenameButton?: boolean;
  textClassName?: string;
  value: string;
}

function EditableName({
  buttonClassName,
  containerClassName,
  disabled = false,
  displayButtonClassName,
  editRequestToken,
  inputClassName,
  lockedExtension = false,
  onDisplayClick,
  onSave,
  renameLabel,
  showRenameButton = true,
  textClassName,
  value,
}: EditableNameProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { base, extension } = useMemo(() => (lockedExtension ? splitFilename(value) : { base: value, extension: '' }), [lockedExtension, value]);

  useEffect(() => {
    if (!isEditing) {
      setDraft(base);
      setError('');
      return;
    }
    setDraft(base);
    setError('');
  }, [base, isEditing]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [isEditing]);

  useEffect(() => {
    if (editRequestToken == null || disabled) {
      return;
    }
    setIsEditing(true);
  }, [disabled, editRequestToken]);

  async function commitRename() {
    const nextBase = draft.trim();
    if (!nextBase) {
      setError('name required');
      return false;
    }

    const nextValue = lockedExtension ? joinFilename(nextBase, extension) : nextBase;
    if (nextValue === value) {
      setIsEditing(false);
      setError('');
      return true;
    }

    setIsSaving(true);
    try {
      await onSave(nextValue);
      setIsEditing(false);
      setError('');
      return true;
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : 'Could not rename.');
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className={containerClassName ? `editable-name ${containerClassName}` : 'editable-name'}>
      {isEditing ? (
        <div className="editable-name-edit">
          <input
            aria-label={renameLabel}
            className={inputClassName ? `editable-name-input ${inputClassName}` : 'editable-name-input'}
            disabled={isSaving}
            onBlur={() => {
              void commitRename();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) {
                setError('');
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commitRename();
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(base);
                setError('');
                setIsEditing(false);
              }
            }}
            ref={inputRef}
            type="text"
            value={draft}
          />
          {lockedExtension && extension ? <span className="editable-name-suffix">{extension}</span> : null}
        </div>
      ) : (
        <>
          {onDisplayClick ? (
            <button
              className={displayButtonClassName ? `editable-name-display-button ${displayButtonClassName}` : 'editable-name-display-button'}
              onClick={onDisplayClick}
              type="button"
            >
              <span className={textClassName ? `editable-name-text ${textClassName}` : 'editable-name-text'} title={value}>
                {value}
              </span>
            </button>
          ) : (
            <span className={textClassName ? `editable-name-text ${textClassName}` : 'editable-name-text'} title={value}>
              {value}
            </span>
          )}
          {showRenameButton ? (
            <button
              className={buttonClassName ? `editable-name-button ${buttonClassName}` : 'editable-name-button'}
              disabled={disabled}
              onClick={() => setIsEditing(true)}
              type="button"
            >
              rename
            </button>
          ) : null}
        </>
      )}
      {error ? <span className="editable-name-error">{error}</span> : null}
    </div>
  );
}

function ImportScreen({
  appError,
  canComplete,
  healthMessage,
  isDeleting,
  isUploadBlocked,
  onDeleteRow,
  onDone,
  onFilesSelected,
  onNavigateStage,
  onRenameProject,
  onRenameRow,
  onUploadRow,
  project,
  rows,
  selectionFeedback,
}: ImportScreenProps) {
  const [isDropzoneActive, setIsDropzoneActive] = useState(false);
  const uploadedCount = rows.filter((row) => row.status === 'uploaded').length;
  const queuedCount = rows.filter((row) => row.status !== 'uploaded').length;

  return (
    <div className="entry-screen import-screen">
      <div className="entry-shell import-shell">
        <StageNavigator activeStage="import" className="entry-stage-nav" onNavigate={onNavigateStage} />

        {(healthMessage || appError) && (
          <div className="entry-notices">
            {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
            {appError && <p className="entry-notice error">{appError}</p>}
          </div>
        )}

        <div className="import-stage">
          <div className="import-header">
            <div className="import-project-copy">
              {project ? (
                <EditableName
                  buttonClassName="entry-rename-button"
                  containerClassName="import-project-name"
                  onSave={(nextValue) => onRenameProject(project.id, nextValue)}
                  renameLabel={`Rename project ${project.name}`}
                  textClassName="import-project-title"
                  value={project.name}
                />
              ) : (
                <p className="import-project-title">Loading project…</p>
              )}
              <p className="import-project-meta">{project ? formatProjectSummary(project) : 'Loading project details…'}</p>
            </div>
            <div className="import-header-actions">
              <button className="entry-enter-button import-done-button" disabled={!canComplete} onClick={onDone} type="button">
                done
              </button>
            </div>
          </div>

          <div className="import-section-head">
            <p className="import-section-title">import videos</p>
            <p className="import-status-copy">
              {uploadedCount} {uploadedCount === 1 ? 'video' : 'videos'} imported
              {queuedCount ? ` • ${queuedCount} queued` : ''}
            </p>
          </div>

          <label
            className={`import-dropzone ${isUploadBlocked ? 'disabled' : ''} ${isDropzoneActive ? 'dragging' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDropzoneActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                return;
              }
              setIsDropzoneActive(false);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDropzoneActive(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDropzoneActive(false);
              onFilesSelected(event.dataTransfer.files);
            }}
          >
            <input
              accept="video/*"
              disabled={isUploadBlocked}
              multiple
              onChange={(event) => {
                if (event.target.files) {
                  onFilesSelected(event.target.files);
                }
                event.target.value = '';
              }}
              type="file"
            />
            <span>drag-and-drop your videos here,</span>
            <span>or click it to select your videos.</span>
          </label>
          {selectionFeedback ? <p className="import-feedback-copy">{selectionFeedback}</p> : null}
          <p className="import-format-copy">supports .mp4, .mov, .m4v, .webm, and .mkv uploads</p>

          <div className="import-queue">
            {rows.map((row) => (
              <div className="import-row" key={row.localId}>
                <div className="import-row-copy">
                  <EditableName
                    buttonClassName="entry-rename-button"
                    containerClassName="import-row-name"
                    inputClassName="import-row-input"
                    lockedExtension
                    onSave={(nextValue) => onRenameRow(row.localId, nextValue)}
                    renameLabel={`Rename video ${row.filename}`}
                    textClassName="import-row-title"
                    value={row.filename}
                  />
                  {row.error && <p className="import-row-note error">{row.error}</p>}
                </div>
                <div className="import-row-actions">
                  {row.status === 'uploaded' ? (
                    <span className="import-pill neutral">uploaded</span>
                  ) : row.status === 'uploading' ? (
                    <span className="import-pill neutral muted">uploading...</span>
                  ) : (
                    <button
                      className="import-pill success"
                      disabled={isUploadBlocked}
                      onClick={() => onUploadRow(row.localId)}
                      type="button"
                    >
                      upload
                    </button>
                  )}
                  <button
                    className="import-pill danger import-delete-button"
                    disabled={isDeleting || row.status === 'uploading'}
                    onClick={() => onDeleteRow(row.localId)}
                    type="button"
                  >
                    delete
                  </button>
                </div>
              </div>
            ))}
            {!rows.length && <p className="entry-empty-copy import-empty-copy">Selected and uploaded videos will appear here.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function AnalysisScreen({
  acceptedStepSimilarityLinks,
  abortRunPending,
  activeProject,
  analysisActionMessage,
  analysisTaskItems,
  appError,
  bulkDeletePending,
  bulkExportPending,
  candidateSimilarityLinks,
  createManualCandidatePending,
  createRunPending,
  exportRunPending,
  healthMessage,
  healthWarning,
  liveMessage,
  onApplyImportedPreset,
  onAbortRun,
  onBulkUpdateCandidates,
  onCreateManualCandidate,
  onDeleteRecording,
  onDeleteSelectedRuns,
  onExportRun,
  onExportTaskRuns,
  onJumpToSelection,
  onNavigateStage,
  onPreviewRecording,
  onRenameProject,
  onRenameRecording,
  onResetToProjectDefaults,
  onResetToUniversalDefaults,
  onSaveProjectPreset,
  onSaveUniversalPreset,
  onSelectRecording,
  onSelectRun,
  onStartRun,
  onUpdateCandidate,
  previewRecording,
  projectDefaultSettings,
  recordings,
  recordingsLoading,
  runSettings,
  selectedRecording,
  selectedRecordingId,
  selectedRecordingSummary,
  selectedRun,
  setRunSettings,
  settingsFeedback,
  showPresetText,
}: AnalysisScreenProps) {
  const [expandedTaskRunId, setExpandedTaskRunId] = useState<string | null>(null);
  const [selectedTaskRunIds, setSelectedTaskRunIds] = useState<string[]>([]);
  const [taskFilter, setTaskFilter] = useState<AnalysisTaskFilter>('all');
  const [taskSelectMode, setTaskSelectMode] = useState(false);
  const [videoRenameRequest, setVideoRenameRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [openPopover, setOpenPopover] = useState<AnalysisPopoverKey | null>(null);
  const [activeCandidateFilter, setActiveCandidateFilter] = useState<CandidateFilter>('all');
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [bulkCandidatePending, setBulkCandidatePending] = useState(false);
  const [queuedManualMarkItems, setQueuedManualMarkItems] = useState<PendingManualMark[]>([]);
  const [manualCapturePulseToken, setManualCapturePulseToken] = useState(0);
  const [expandedAnnotationCandidateId, setExpandedAnnotationCandidateId] = useState<string | null>(null);
  const [exportNameDraft, setExportNameDraft] = useState('');
  const [presetImportDraft, setPresetImportDraft] = useState('');
  const [presetImportError, setPresetImportError] = useState('');
  const [previewPlaybackMs, setPreviewPlaybackMs] = useState(0);
  const [showRunLogs, setShowRunLogs] = useState(false);
  const [compareRunId, setCompareRunId] = useState<string | null>(null);
  const [presetCopyFeedback, setPresetCopyFeedback] = useState('');
  const [showHints, setShowHints] = useState(false);
  const [taskClockMs, setTaskClockMs] = useState(() => Date.now());
  const [focusedHintKey, setFocusedHintKey] = useState<AnalysisHintKey | null>(null);
  const [hoveredHintKey, setHoveredHintKey] = useState<AnalysisHintKey | null>(null);
  const [hintCardPosition, setHintCardPosition] = useState<{ left: number; top: number } | null>(null);
  const parameterColumnRef = useRef<HTMLElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const saveMenuRef = useRef<HTMLDivElement | null>(null);
  const loadMenuRef = useRef<HTMLDivElement | null>(null);
  const resetMenuRef = useRef<HTMLDivElement | null>(null);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const activeManualMarkIdRef = useRef<string | null>(null);
  const compareRunDetailQuery = useQuery({
    queryKey: ['run', compareRunId, 'compare'],
    queryFn: () => getRun(compareRunId as string),
    enabled: Boolean(compareRunId),
  });

  const previewVideoUrl = previewRecording ? absoluteApiUrl(previewRecording.source_url) : null;
  const comparedRun = compareRunDetailQuery.data ?? null;
  const sampleFpsGuardrail = getSampleFpsGuardrail(selectedRecordingSummary?.fps ?? null, runSettings.allow_high_fps_sampling);
  const hintCopy: Record<AnalysisHintKey, string> = {
    analysis_engine:
      'Choose the classic scene detector for continuity, or the hybrid detector to prioritize interface-level changes such as menus, buttons, and content shifts.',
    analysis_preset:
      runSettings.analysis_engine === 'hybrid_v2'
        ? describeAnalysisPreset(runSettings)
        : 'Hybrid presets only affect the v2 detector. Switch engines to use the UI-change pipeline.',
    allow_high_fps_sampling: sampleFpsGuardrail.isHighFpsRecording
      ? `Turn this on to sample above 30 fps or use source fps for this ~${sampleFpsGuardrail.sourceFpsCeiling} fps recording.`
      : 'Use this only when you need denser sampling on recordings above 30 fps.',
    detector_mode: describeDetectorMode(runSettings.detector_mode),
    extract_offset_ms: describeExtractOffset(runSettings.extract_offset_ms),
    hybrid_advanced:
      runSettings.analysis_engine === 'hybrid_v2'
        ? 'Start with the preset. Use overrides only when a specific recording still misses or overfires on interface changes.'
        : 'Hybrid advanced controls are only used by the v2 detector.',
    hybrid_min_dwell_ms: describeHybridMinDwellHint(runSettings),
    hybrid_ocr_confirmation: describeHybridOcrConfirmationHint(),
    hybrid_sample_fps_override: describeHybridSampleFpsOverrideHint(runSettings),
    hybrid_settle_window_ms: describeHybridSettleWindowHint(runSettings),
    load: 'Paste Stepthrough preset text to load a saved parameter set into the active analysis controls.',
    min_scene_gap_ms: describeMinSceneGap(runSettings.min_scene_gap_ms),
    reset: 'Reset the current analysis parameters to this project or universal defaults.',
    run: 'Start a new analysis task for the selected video using the current parameter set.',
    sample_fps: describeSampleFps(runSettings.sample_fps, selectedRecordingSummary?.fps ?? null),
    save: 'Save the current analysis parameters for this project or as universal defaults.',
    tolerance: describeTolerance(runSettings.tolerance, runSettings.detector_mode),
  };
  const activeHintKey = focusedHintKey ?? hoveredHintKey;
  const hintText = showHints && activeHintKey ? hintCopy[activeHintKey] : null;
  const isCompletedReview = selectedRun?.summary.status === 'completed';
  const canReviewCandidates = Boolean(
    selectedRun &&
      selectedRun.candidates.length > 0 &&
      ['completed', 'failed', 'cancelled'].includes(selectedRun.summary.status),
  );
  const previewMatchesSelectedRun = Boolean(previewRecording && selectedRun && previewRecording.id === selectedRun.summary.recording_id);
  const isEngineDirty = runSettings.analysis_engine !== projectDefaultSettings.analysis_engine;
  const isPresetDirty = runSettings.analysis_preset !== projectDefaultSettings.analysis_preset;
  const isHybridAdvancedDirty =
    (runSettings.advanced?.sample_fps_override ?? null) !== (projectDefaultSettings.advanced?.sample_fps_override ?? null) ||
    (runSettings.advanced?.min_dwell_ms ?? null) !== (projectDefaultSettings.advanced?.min_dwell_ms ?? null) ||
    (runSettings.advanced?.settle_window_ms ?? null) !== (projectDefaultSettings.advanced?.settle_window_ms ?? null) ||
    (runSettings.advanced?.enable_ocr ?? true) !== (projectDefaultSettings.advanced?.enable_ocr ?? true);
  const isToleranceDirty = runSettings.tolerance !== projectDefaultSettings.tolerance;
  const isMinSceneGapDirty = runSettings.min_scene_gap_ms !== projectDefaultSettings.min_scene_gap_ms;
  const isSampleFpsDirty = runSettings.sample_fps !== projectDefaultSettings.sample_fps;
  const isHighFpsDirty = runSettings.allow_high_fps_sampling !== projectDefaultSettings.allow_high_fps_sampling;
  const isExtractOffsetDirty = runSettings.extract_offset_ms !== projectDefaultSettings.extract_offset_ms;
  const isDetectorModeDirty = runSettings.detector_mode !== projectDefaultSettings.detector_mode;
  const canAddManualCandidate = Boolean(
    previewMatchesSelectedRun && selectedRun && ['completed', 'failed', 'cancelled'].includes(selectedRun.summary.status),
  );
  const showHighFpsWarning = Boolean(
    runSettings.analysis_engine === 'scene_v1' &&
      selectedRecordingSummary &&
      sampleFpsGuardrail.isHighFpsRecording &&
      !runSettings.allow_high_fps_sampling,
  );
  const showLowCandidateHint = Boolean(
    selectedRun &&
      (selectedRun.summary.status === 'completed' || selectedRun.summary.status === 'failed' || selectedRun.summary.status === 'cancelled') &&
      selectedRun.candidates.length <= 2,
  );
  const filteredAnalysisTaskItems = useMemo(() => {
    if (taskFilter === 'all') {
      return analysisTaskItems;
    }
    if (taskFilter === 'active') {
      return analysisTaskItems.filter((item) => ['queued', 'running'].includes(item.run.status));
    }
    if (taskFilter === 'completed') {
      return analysisTaskItems.filter((item) => item.run.status === 'completed');
    }
    return analysisTaskItems.filter((item) => ['failed', 'cancelled'].includes(item.run.status));
  }, [analysisTaskItems, taskFilter]);
  const runNumberById = useMemo(() => {
    const nextMap = new Map<string, number>();
    const itemsByRecordingId = new Map<string, AnalysisTaskItem[]>();

    analysisTaskItems.forEach((item) => {
      const bucket = itemsByRecordingId.get(item.recording.id);
      if (bucket) {
        bucket.push(item);
        return;
      }
      itemsByRecordingId.set(item.recording.id, [item]);
    });

    itemsByRecordingId.forEach((items) => {
      items
        .slice()
        .sort((left, right) => new Date(left.run.created_at).getTime() - new Date(right.run.created_at).getTime())
        .forEach((item, index) => {
          nextMap.set(item.run.id, index + 1);
        });
    });

    return nextMap;
  }, [analysisTaskItems]);
  const groupedTaskItems = useMemo<AnalysisTaskGroup[]>(() => {
    const groups = new Map<string, AnalysisTaskGroup>();

    filteredAnalysisTaskItems.forEach((item) => {
      const existingGroup = groups.get(item.recording.id);
      if (existingGroup) {
        existingGroup.runs.push(item);
        return;
      }

      groups.set(item.recording.id, {
        recording: item.recording,
        runs: [item],
      });
    });

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        runs: group.runs
          .slice()
          .sort((left, right) => new Date(right.run.created_at).getTime() - new Date(left.run.created_at).getTime()),
      }))
      .sort((left, right) => {
        const leftTimestamp = new Date(left.runs[0]?.run.created_at ?? 0).getTime();
        const rightTimestamp = new Date(right.runs[0]?.run.created_at ?? 0).getTime();
        return rightTimestamp - leftTimestamp;
      });
  }, [filteredAnalysisTaskItems]);
  const candidateCounts = useMemo(() => {
    const candidates = selectedRun?.candidates ?? [];
    return {
      pending: candidates.filter((candidate) => candidate.status === 'pending').length,
      accepted: candidates.filter((candidate) => candidate.status === 'accepted').length,
      rejected: candidates.filter((candidate) => candidate.status === 'rejected').length,
      all: candidates.length,
    };
  }, [selectedRun]);
  const filteredCandidates = useMemo(() => {
    if (!selectedRun || !canReviewCandidates) {
      return [];
    }
    return selectedRun.candidates.filter((candidate) => candidateMatchesFilter(candidate, activeCandidateFilter));
  }, [activeCandidateFilter, canReviewCandidates, selectedRun]);
  const timelineCandidates = useMemo(() => {
    if (!selectedRun) {
      return [];
    }
    return [...selectedRun.candidates].sort((left, right) => left.timestamp_ms - right.timestamp_ms);
  }, [selectedRun]);
  const activeCandidate = useMemo(() => {
    if (!selectedRun || !activeCandidateId) {
      return null;
    }
    return selectedRun.candidates.find((candidate) => candidate.id === activeCandidateId) ?? null;
  }, [activeCandidateId, selectedRun]);
  const selectablePendingCandidateIds = useMemo(() => {
    return new Set(filteredCandidates.filter((candidate) => candidate.status === 'pending').map((candidate) => candidate.id));
  }, [filteredCandidates]);
  const selectedPendingCandidateIds = useMemo(() => {
    return selectedCandidateIds.filter((candidateId) => selectablePendingCandidateIds.has(candidateId));
  }, [selectedCandidateIds, selectablePendingCandidateIds]);
  const canShowTimeline =
    Boolean(
      isCompletedReview &&
        selectedRecordingSummary &&
        selectedRecordingSummary.duration_ms > 0 &&
        timelineCandidates.length > 0,
    );
  const canExportAccepted = Boolean(selectedRun && selectedRun.summary.status === 'completed' && selectedRun.accepted_steps.length > 0);
  const canExportAll = Boolean(selectedRun && selectedRun.summary.status === 'completed' && selectedRun.candidates.length > 0);
  const selectedRunExportLabel = useMemo(() => {
    if (!selectedRun?.summary.export_bundle_id) {
      return null;
    }
    if (selectedRun.export_bundle?.created_at) {
      return `last exported ${formatRelativeTime(selectedRun.export_bundle.created_at, taskClockMs)}`;
    }
    return 'exported';
  }, [selectedRun, taskClockMs]);
  const resolvedExportFilenamePreview = normalizeZipFilename(exportNameDraft);
  const comparableRuns = useMemo(
    () =>
      (selectedRecording?.runs ?? []).filter(
        (run) => run.id !== selectedRun?.summary.id && run.status === 'completed',
      ),
    [selectedRecording?.runs, selectedRun?.summary.id],
  );
  const comparisonRows = useMemo(
    () => (selectedRun && comparedRun ? buildCandidateComparison(selectedRun.candidates, comparedRun.candidates) : []),
    [comparedRun, selectedRun],
  );

  useEffect(() => {
    if (!expandedTaskRunId) {
      return;
    }
    if (!analysisTaskItems.some((item) => item.run.id === expandedTaskRunId)) {
      setExpandedTaskRunId(null);
    }
  }, [analysisTaskItems, expandedTaskRunId]);

  useEffect(() => {
    setSelectedTaskRunIds((current) => current.filter((runId) => analysisTaskItems.some((item) => item.run.id === runId)));
  }, [analysisTaskItems]);

  useEffect(() => {
    setSelectedCandidateIds((current) => current.filter((candidateId) => selectablePendingCandidateIds.has(candidateId)));
  }, [selectablePendingCandidateIds]);

  useEffect(() => {
    if (!showHints) {
      setFocusedHintKey(null);
      setHoveredHintKey(null);
      setHintCardPosition(null);
    }
  }, [showHints]);

  useEffect(() => {
    if (!focusedHintKey && !hoveredHintKey) {
      setHintCardPosition(null);
    }
  }, [focusedHintKey, hoveredHintKey]);

  useEffect(() => {
    setActiveCandidateFilter(canReviewCandidates ? 'all' : 'pending');
    setExpandedAnnotationCandidateId(null);
    setSelectedCandidateIds([]);
    setBulkCandidatePending(false);
  }, [canReviewCandidates, selectedRun?.summary.id]);

  useEffect(() => {
    setShowRunLogs(false);
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    if (!compareRunId) {
      return;
    }
    if (compareRunId === selectedRun?.summary.id || !comparableRuns.some((run) => run.id === compareRunId)) {
      setCompareRunId(null);
    }
  }, [compareRunId, comparableRuns, selectedRun?.summary.id]);

  useEffect(() => {
    setOpenPopover((current) => (current === 'export' ? null : current));
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    setQueuedManualMarkItems([]);
    activeManualMarkIdRef.current = null;
    setManualCapturePulseToken(0);
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    if (!openPopover) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        saveMenuRef.current?.contains(target) ||
        loadMenuRef.current?.contains(target) ||
        resetMenuRef.current?.contains(target) ||
        presetMenuRef.current?.contains(target) ||
        exportMenuRef.current?.contains(target)
      ) {
        return;
      }
      setOpenPopover(null);
    }

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [openPopover]);

  useEffect(() => {
    setPreviewPlaybackMs(0);
  }, [previewRecording?.id]);

  useEffect(() => {
    if (!selectedRun?.candidates.length) {
      setActiveCandidateId(null);
      return;
    }
    setActiveCandidateId(selectedRun.candidates[0].id);
  }, [selectedRun?.summary.id, selectedRun?.candidates.length]);

  useEffect(() => {
    if (!filteredCandidates.length) {
      return;
    }
    if (activeCandidateId && filteredCandidates.some((candidate) => candidate.id === activeCandidateId)) {
      return;
    }
    setActiveCandidateId(filteredCandidates[0].id);
  }, [activeCandidateId, filteredCandidates]);

  useEffect(() => {
    if (!selectedRun || !queuedManualMarkItems.length) {
      return;
    }
    if (activeManualMarkIdRef.current) {
      return;
    }

    const nextMark = queuedManualMarkItems[0];
    activeManualMarkIdRef.current = nextMark.id;

    void (async () => {
      try {
        await onCreateManualCandidate(selectedRun.summary.id, nextMark.timestampMs);
      } finally {
        activeManualMarkIdRef.current = null;
        setQueuedManualMarkItems((current) => current.filter((item) => item.id !== nextMark.id));
      }
    })();
  }, [onCreateManualCandidate, queuedManualMarkItems, selectedRun]);

  useEffect(() => {
    if (!selectedRun || selectedRun.summary.status !== 'completed') {
      setExportNameDraft('');
      return;
    }

    setExportNameDraft(buildReviewExportName(selectedRecordingSummary?.filename ?? selectedRun.summary.recording_id));
  }, [selectedRecordingSummary?.filename, selectedRun?.summary.id, selectedRun?.summary.recording_id, selectedRun?.summary.status]);

  useEffect(() => {
    if (!presetCopyFeedback) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => setPresetCopyFeedback(''), 1800);
    return () => globalThis.clearTimeout(timeoutId);
  }, [presetCopyFeedback]);

  useEffect(() => {
    if (openPopover !== 'load' && presetImportError) {
      setPresetImportError('');
    }
    if (openPopover !== 'preset' && presetCopyFeedback) {
      setPresetCopyFeedback('');
    }
  }, [openPopover, presetCopyFeedback, presetImportError]);

  useEffect(() => {
    const intervalId = globalThis.setInterval(() => setTaskClockMs(Date.now()), 1000);
    return () => globalThis.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!canReviewCandidates) {
      return;
    }

    function handleReviewKeydown(event: KeyboardEvent) {
      if (isEditableElement(event.target)) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (!activeCandidate && filteredCandidates.length > 0) {
        setActiveCandidateId(filteredCandidates[0].id);
        return;
      }

      if (!activeCandidate) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handleStepCandidate(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleStepCandidate(1);
        return;
      }

      const lowerKey = event.key.toLowerCase();
      if (lowerKey === 'a') {
        event.preventDefault();
        handleCandidateStatusChange(activeCandidate, 'accepted');
      } else if (lowerKey === 'r') {
        event.preventDefault();
        handleCandidateStatusChange(activeCandidate, 'rejected');
      } else if (lowerKey === 'u') {
        event.preventDefault();
        handleCandidateStatusChange(activeCandidate, 'pending');
      }
    }

    window.addEventListener('keydown', handleReviewKeydown);
    return () => window.removeEventListener('keydown', handleReviewKeydown);
  }, [activeCandidate, canReviewCandidates, filteredCandidates]);

  useEffect(() => {
    if (!canAddManualCandidate) {
      return;
    }

    function handleManualTagKeydown(event: KeyboardEvent) {
      if (isEditableElement(event.target) || event.metaKey || event.ctrlKey || event.altKey || event.repeat) {
        return;
      }
      if (event.key.toLowerCase() !== 'k') {
        return;
      }
      event.preventDefault();
      void handleCreateManualCandidate();
    }

    window.addEventListener('keydown', handleManualTagKeydown);
    return () => window.removeEventListener('keydown', handleManualTagKeydown);
  }, [canAddManualCandidate, previewPlaybackMs, selectedRun?.summary.id]);

  function updateHintCardPosition(element: HTMLElement) {
    const container = parameterColumnRef.current;
    if (!container) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const maxLeft = Math.max(0, containerRect.width - 220);
    const left = Math.min(Math.max(0, elementRect.left - containerRect.left), maxLeft);
    const maxTop = Math.max(0, containerRect.height - 88);
    const top = Math.min(Math.max(0, elementRect.bottom - containerRect.top + 10), maxTop);
    setHintCardPosition({ left, top });
  }

  function bindHint(key: AnalysisHintKey) {
    if (!showHints) {
      return {};
    }
    return {
      onBlur: () => {
        setFocusedHintKey((current) => (current === key ? null : current));
      },
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        updateHintCardPosition(event.currentTarget);
        setFocusedHintKey(key);
      },
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
        updateHintCardPosition(event.currentTarget);
        setFocusedHintKey(null);
        setHoveredHintKey(key);
      },
      onMouseLeave: () => {
        setHoveredHintKey((current) => (current === key ? null : current));
      },
    };
  }

  function togglePopover(key: AnalysisPopoverKey) {
    setOpenPopover((current) => (current === key ? null : key));
  }

  function closePopover() {
    setOpenPopover(null);
  }

  function handlePresetImportDraftChange(nextValue: string) {
    setPresetImportDraft(nextValue);
    if (presetImportError) {
      setPresetImportError('');
    }
  }

  function handleApplyImportedPreset() {
    const parseResult = parseRunPresetText(presetImportDraft);
    if ('error' in parseResult) {
      setPresetImportError(parseResult.error);
      return;
    }

    onApplyImportedPreset(parseResult.settings);
    setPresetImportDraft('');
    setPresetImportError('');
    closePopover();
  }

  function toggleTaskSelection(runId: string) {
    setSelectedTaskRunIds((current) => (current.includes(runId) ? current.filter((value) => value !== runId) : [...current, runId]));
  }

  async function handleDeleteSelectedTasks() {
    const failedRunIds = await onDeleteSelectedRuns(selectedTaskRunIds);
    if (failedRunIds === null) {
      return;
    }
    setSelectedTaskRunIds(failedRunIds);
  }

  async function handleExportSelectedTasks() {
    await onExportTaskRuns(selectedTaskRunIds);
  }

  async function handleExportAllCompletedTasks() {
    await onExportTaskRuns(
      analysisTaskItems.filter((item) => item.run.status === 'completed').map((item) => item.run.id),
    );
  }

  async function handleSelectedRunExport(mode: ExportMode) {
    if (!selectedRun) {
      return;
    }
    await onExportRun(selectedRun.summary.id, mode, exportNameDraft);
    closePopover();
  }

  async function handleCopyPresetText() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setPresetCopyFeedback('copy unavailable');
      return;
    }
    try {
      await navigator.clipboard.writeText(showPresetText);
      setPresetCopyFeedback('copied');
    } catch {
      setPresetCopyFeedback('copy failed');
    }
  }

  function toggleCandidateSelection(candidateId: string) {
    setSelectedCandidateIds((current) =>
      current.includes(candidateId) ? current.filter((value) => value !== candidateId) : [...current, candidateId],
    );
  }

  async function handleBulkCandidateStatusChange(status: Extract<CandidateStatus, 'accepted' | 'rejected'>) {
    if (!selectedRun || !selectedPendingCandidateIds.length) {
      return;
    }

    setBulkCandidatePending(true);
    try {
      const failedCandidateIds = await onBulkUpdateCandidates(
        selectedRun.summary.id,
        selectedRun.summary.recording_id,
        selectedPendingCandidateIds,
        status,
      );
      setSelectedCandidateIds(failedCandidateIds);
    } finally {
      setBulkCandidatePending(false);
    }
  }

  function getCurrentPreviewTimestampMs() {
    const previewDurationMs = previewRecording?.duration_ms ?? selectedRecordingSummary?.duration_ms ?? null;
    const directSeconds = previewVideoRef.current?.currentTime;
    const fallbackSeconds = previewPlaybackMs / 1000;
    const rawSeconds =
      typeof directSeconds === 'number' && Number.isFinite(directSeconds)
        ? directSeconds
        : Number.isFinite(fallbackSeconds)
          ? fallbackSeconds
          : null;
    if (rawSeconds === null) {
      return null;
    }

    const clampedSeconds =
      previewDurationMs && previewDurationMs > 0
        ? Math.min(rawSeconds, Math.max(0, (previewDurationMs - 1) / 1000))
        : Math.max(0, rawSeconds);
    return Math.max(0, Math.round(clampedSeconds * 1000));
  }

  function handleCreateManualCandidate(timestampOverrideMs?: number) {
    if (!selectedRun || !canAddManualCandidate) {
      return;
    }

    const timestampMs = timestampOverrideMs ?? getCurrentPreviewTimestampMs();
    if (timestampMs === null) {
      return;
    }
    setManualCapturePulseToken((current) => current + 1);
    setQueuedManualMarkItems((current) => [...current, { id: createLocalId('manual-mark'), timestampMs }]);
  }

  function handleToggleCandidateAnnotation(candidateId: string) {
    setExpandedAnnotationCandidateId((current) => (current === candidateId ? null : candidateId));
  }

  function activateCandidate(candidateId: string, options?: { reveal?: boolean; seekPreview?: boolean }) {
    const candidate = selectedRun?.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) {
      return;
    }

    if (options?.reveal && !candidateMatchesFilter(candidate, activeCandidateFilter)) {
      setActiveCandidateFilter('all');
    }
    setActiveCandidateId(candidate.id);

    if (options?.seekPreview && previewMatchesSelectedRun && previewVideoRef.current) {
      previewVideoRef.current.currentTime = candidate.timestamp_ms / 1000;
      setPreviewPlaybackMs(candidate.timestamp_ms);
    }

    window.setTimeout(() => jumpToAnchor(`candidate-${candidate.id}`), 0);
  }

  function handleCandidateStatusChange(candidate: CandidateFrame, status: CandidateStatus) {
    setActiveCandidateId(candidate.id);
    if (status !== 'pending') {
      setSelectedCandidateIds((current) => current.filter((candidateId) => candidateId !== candidate.id));
    }
    onUpdateCandidate(candidate.id, { status });
    if (status === 'pending') {
      return;
    }
    const nextCandidateId = getNextCandidateFocusId(selectedRun?.candidates ?? [], candidate.id, activeCandidateFilter);
    if (!nextCandidateId) {
      return;
    }
    setActiveCandidateId(nextCandidateId);
    window.setTimeout(() => jumpToAnchor(`candidate-${nextCandidateId}`), 0);
  }

  function handleStepCandidate(direction: -1 | 1) {
    if (!filteredCandidates.length) {
      return;
    }

    const currentIndex = activeCandidateId ? filteredCandidates.findIndex((candidate) => candidate.id === activeCandidateId) : -1;
    const nextIndex =
      currentIndex === -1 ? (direction > 0 ? 0 : filteredCandidates.length - 1) : clampInteger(currentIndex + direction, 0, filteredCandidates.length - 1);
    activateCandidate(filteredCandidates[nextIndex].id);
  }

  function renderTaskRow(item: AnalysisTaskItem) {
    const run = item.run;
    const runNumber = runNumberById.get(run.id) ?? 1;
    const isExpanded = expandedTaskRunId === run.id;
    const isSelected = selectedRun?.summary.id === run.id;
    const isMarked = selectedTaskRunIds.includes(run.id);
    const isError = run.status === 'failed';
    const isDone = run.status === 'completed';
    const hasCandidates = run.candidate_count > 0;
    const hasExported = Boolean(run.export_bundle_id);
    const runTimestampLabel = formatRunShortTimestamp(run.started_at ?? run.created_at);
    const actionButtons: Array<{ anchorId?: string; label: string; tone?: 'danger' | 'subtle' }> = [];
    const taskSettings =
      run.analysis_engine === 'hybrid_v2'
        ? [
            {
              key: 'engine',
              label: 'engine',
              value: formatAnalysisEngineLabel(run.analysis_engine),
              valueClassName: 'mode',
              isDirty: run.analysis_engine !== projectDefaultSettings.analysis_engine,
            },
            {
              key: 'preset',
              label: 'preset',
              value: formatAnalysisPresetLabel(run.analysis_preset),
              valueClassName: 'mode',
              isDirty: run.analysis_preset !== projectDefaultSettings.analysis_preset,
            },
            {
              key: 'hybrid-fps',
              label: 'fps',
              value: String(run.advanced?.sample_fps_override ?? analysisPresetDefaults[run.analysis_preset].sampleFps),
              valueClassName: 'sample-fps',
              isDirty: (run.advanced?.sample_fps_override ?? null) !== (projectDefaultSettings.advanced?.sample_fps_override ?? null),
            },
            {
              key: 'ocr',
              label: 'ocr',
              value: run.advanced?.enable_ocr === false ? 'off' : 'on',
              isDirty: (run.advanced?.enable_ocr ?? true) !== (projectDefaultSettings.advanced?.enable_ocr ?? true),
            },
          ]
        : [
            {
              key: 'tolerance',
              label: 'tolerance',
              value: String(run.tolerance),
              isDirty: run.tolerance !== projectDefaultSettings.tolerance,
            },
            {
              key: 'gaps',
              label: 'gaps',
              value: String(run.min_scene_gap_ms),
              isDirty: run.min_scene_gap_ms !== projectDefaultSettings.min_scene_gap_ms,
            },
            {
              key: 'fps',
              label: 'fps',
              value: run.sample_fps ? String(run.sample_fps) : 'src',
              valueClassName: 'sample-fps',
              isDirty: run.sample_fps !== projectDefaultSettings.sample_fps,
            },
            {
              key: 'offset',
              label: 'offset',
              value: String(run.extract_offset_ms),
              isDirty: run.extract_offset_ms !== projectDefaultSettings.extract_offset_ms,
            },
            {
              key: 'mode',
              label: 'mode',
              value: run.detector_mode,
              valueClassName: 'mode',
              isDirty: run.detector_mode !== projectDefaultSettings.detector_mode,
            },
          ];
    const progressLabel = isDone
      ? `${run.candidate_count} scenes`
      : isError
        ? 'error'
        : run.status === 'cancelled'
          ? 'ended'
          : formatPercent(run.progress);
    const elapsedSource = activeRunStatuses.includes(run.status) ? run.started_at ?? run.created_at : null;
    const elapsedLabel = elapsedSource ? formatElapsedDuration(taskClockMs - new Date(elapsedSource).getTime()) : null;
    if (run.is_abortable) {
      actionButtons.push({ label: 'end', tone: 'danger' });
    } else {
      if (hasCandidates && ['completed', 'failed', 'cancelled'].includes(run.status)) {
        actionButtons.push({ anchorId: 'analysis-candidate-review', label: 'review outputs', tone: 'subtle' });
      } else if (!hasCandidates) {
        actionButtons.push({ anchorId: 'analysis-run-detail', label: 'view task', tone: 'subtle' });
      }
    }

    return (
      <div className={`analysis-task-row ${isSelected ? 'selected' : ''}`} key={run.id}>
        <div className="analysis-task-head">
          <div className="analysis-task-head-primary">
            {taskSelectMode && (
              <label className="analysis-task-select-toggle">
                <input checked={isMarked} onChange={() => toggleTaskSelection(run.id)} type="checkbox" />
                <span className="analysis-task-select-copy">select task</span>
              </label>
            )}
            <div className="analysis-task-title-wrap">
              <button
                className={`analysis-task-title ${isError ? 'error' : ''}`}
                onClick={() => onSelectRun(item.recording.id, run.id, 'analysis-run-detail')}
                type="button"
              >
                {`run #${runNumber}`}
              </button>
              <span className="analysis-task-subtitle">{runTimestampLabel}</span>
            </div>
          </div>
          <div className="analysis-task-meta">
            {hasExported ? <span className="analysis-task-export-badge">exported</span> : null}
            <span className={`analysis-task-progress ${isError ? 'error' : isDone ? 'success' : ''}`}>{progressLabel}</span>
            {elapsedLabel ? <span className="analysis-task-elapsed">{elapsedLabel}</span> : null}
            <button
              className={`analysis-task-link ${isExpanded ? 'plain' : ''}`}
              onClick={() => setExpandedTaskRunId((current) => (current === run.id ? null : run.id))}
              type="button"
            >
              details
            </button>
            {actionButtons.map((action) =>
              action.label === 'end' ? (
                <button className="analysis-task-link danger" key={action.label} onClick={() => onAbortRun(run.id)} type="button">
                  {action.label}
                </button>
              ) : (
                <button
                  className="analysis-task-link subtle"
                  key={action.label}
                  onClick={() => {
                    if (action.label === 'review outputs') {
                      setActiveCandidateFilter('all');
                    }
                    onSelectRun(item.recording.id, run.id, action.anchorId ?? 'analysis-run-detail');
                  }}
                  type="button"
                >
                  {action.label}
                </button>
              ),
            )}
          </div>
        </div>

        {isExpanded && (
          <>
            <div className="analysis-task-bar" aria-hidden="true">
              <div className="analysis-task-bar-fill" style={{ width: isDone ? '100%' : formatPercent(run.progress) }} />
            </div>
            <div className="analysis-task-settings">
              {taskSettings.map((setting) => (
                <div className={`analysis-task-setting ${setting.key === 'mode' ? 'mode' : ''}`} key={setting.key}>
                  <span className="analysis-task-setting-label">{setting.label}</span>
                  <span
                    className={[
                      'analysis-task-setting-value',
                      setting.valueClassName,
                      setting.isDirty ? 'dirty' : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {setting.value}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  function renderTaskGroup(group: AnalysisTaskGroup) {
    const visibleRunCountLabel = `${group.runs.length} ${group.runs.length === 1 ? 'run' : 'runs'}`;
    return (
      <div className="analysis-task-group" key={group.recording.id}>
        <div className="analysis-task-group-header">
          <span className="analysis-task-group-title" title={group.recording.filename}>
            {group.recording.filename}
          </span>
          <span className="analysis-task-group-count">{visibleRunCountLabel}</span>
        </div>
        <div className="analysis-task-group-rows">{group.runs.map((item) => renderTaskRow(item))}</div>
      </div>
    );
  }

  return (
    <div className="entry-screen analysis-screen">
      <div className="analysis-stage-shell">
        <div className="analysis-stage-nav">
          <div className="analysis-stage-nav-cell">
            <div className="analysis-project-path">
              <button className="analysis-nav-button" onClick={() => onNavigateStage('projects')} type="button">
                projects/
              </button>
              {activeProject ? (
                <EditableName
                  buttonClassName="entry-rename-button"
                  containerClassName="analysis-project-name"
                  onSave={(nextValue) => onRenameProject(activeProject.id, nextValue)}
                  renameLabel={`Rename project ${activeProject.name}`}
                  textClassName="analysis-project-name-text"
                  value={activeProject.name}
                />
              ) : (
                <span className="analysis-project-name-text">Project</span>
              )}
            </div>
            <p className="analysis-project-counts">{activeProject ? formatProjectCounts(activeProject) : ''}</p>
          </div>
          <div className="analysis-stage-nav-cell">
            <button className="analysis-nav-button" onClick={() => onNavigateStage('import')} type="button">
              import
            </button>
          </div>
          <div className="analysis-stage-nav-cell">
            <span className="analysis-nav-button active">analysis</span>
          </div>
        </div>

        {(healthMessage || appError || liveMessage || settingsFeedback || analysisActionMessage) && (
          <div aria-atomic="true" aria-live="polite" className="analysis-notices" role="status">
            {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
            {appError && <p className="entry-notice error">{appError}</p>}
            {liveMessage && <p className="entry-notice">{liveMessage}</p>}
            {settingsFeedback && <p className="entry-notice">{settingsFeedback}</p>}
            {analysisActionMessage && <p className="entry-notice">{analysisActionMessage}</p>}
          </div>
        )}

        <div className="analysis-grid">
          <section className="analysis-column">
            <div className="analysis-column-head">
              <p>videos</p>
              <button className="analysis-pill analysis-pill-accent" onClick={onJumpToSelection} type="button">
                jump to selection
              </button>
            </div>
            <div className="analysis-divider" />
            <div className="analysis-videos">
              {recordings.map((recording) => {
                const isSelected = recording.id === selectedRecordingId;
                const isPreviewing = previewRecording?.id === recording.id;
                return (
                  <div className={`analysis-video-row ${isSelected ? 'selected' : ''} ${isPreviewing ? 'previewing' : ''}`} key={recording.id}>
                    <div className="analysis-video-row-button">
                      <EditableName
                        containerClassName="analysis-video-name"
                        displayButtonClassName="analysis-video-select-button"
                        editRequestToken={videoRenameRequest?.id === recording.id ? videoRenameRequest.nonce : null}
                        lockedExtension
                        onDisplayClick={() => onSelectRecording(recording.id)}
                        onSave={(nextValue) => onRenameRecording(recording.id, nextValue)}
                        renameLabel={`Rename video ${recording.filename}`}
                        showRenameButton={false}
                        textClassName="analysis-video-name-text"
                        value={recording.filename}
                      />
                      <div className="analysis-video-meta">
                        <span className="analysis-video-duration">{recording.duration_tc}</span>
                        <span className="analysis-video-context-badge">{formatRecordingContextBadge(recording)}</span>
                      </div>
                    </div>
                    <div className="analysis-video-actions">
                      <button
                        className="analysis-task-link subtle analysis-video-hover-link"
                        onClick={() =>
                          setVideoRenameRequest((current) => ({
                            id: recording.id,
                            nonce: current?.id === recording.id ? current.nonce + 1 : 1,
                          }))
                        }
                        type="button"
                      >
                        rename
                      </button>
                      <button
                        className="analysis-task-link subtle analysis-video-hover-link analysis-video-preview-link"
                        onClick={() => onPreviewRecording(recording.id)}
                        type="button"
                      >
                        {isPreviewing ? 'hide preview' : 'preview'}
                      </button>
                      <button
                        className="analysis-task-link danger analysis-video-hover-link"
                        onClick={() => onDeleteRecording(recording.id, recording.filename)}
                        type="button"
                      >
                        delete
                      </button>
                    </div>
                  </div>
                );
              })}
              {!recordings.length && <p className="entry-empty-copy">{recordingsLoading ? 'Loading videos…' : 'Uploaded videos will appear here.'}</p>}
            </div>
          </section>

          <section className="analysis-column analysis-parameter-column" ref={parameterColumnRef}>
            <div className="analysis-column-head">
              <p>parameters</p>
              <button
                className={`analysis-task-link subtle ${showHints ? 'active' : ''}`}
                onClick={() => {
                  setShowHints((current) => !current);
                  setFocusedHintKey(null);
                  setHoveredHintKey(null);
                  setHintCardPosition(null);
                }}
                type="button"
              >
                {showHints ? 'hide hints' : 'show hints'}
              </button>
            </div>
            <div className="analysis-divider" />

            <div className="analysis-param-actions">
              <div className="analysis-param-actions-left">
                <div className="analysis-toolbar-shell" ref={loadMenuRef}>
                  <button
                    aria-expanded={openPopover === 'load'}
                    className="analysis-pill success"
                    {...bindHint('load')}
                    onClick={() => togglePopover('load')}
                    type="button"
                  >
                    load
                  </button>
                  {openPopover === 'load' ? (
                    <div className="analysis-toolbar-popover analysis-toolbar-popover-wide">
                      <div className="analysis-toolbar-popover-head">
                        <span>load preset text</span>
                      </div>
                      <p className="analysis-toolbar-copy">
                        Paste preset text from Stepthrough to apply it to the active analysis controls.
                      </p>
                      <textarea
                        aria-label="Load preset text"
                        className="analysis-preset-import-field"
                        onChange={(event) => handlePresetImportDraftChange(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault();
                            handleApplyImportedPreset();
                          }
                        }}
                        placeholder={showPresetText}
                        rows={8}
                        value={presetImportDraft}
                      />
                      {presetImportError ? <p className="analysis-toolbar-feedback error">{presetImportError}</p> : null}
                      <div className="analysis-toolbar-action-row">
                        <button className="analysis-pill success" onClick={handleApplyImportedPreset} type="button">
                          apply
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="analysis-toolbar-shell" ref={saveMenuRef}>
                  <button
                    aria-expanded={openPopover === 'save'}
                    className="analysis-pill analysis-pill-accent"
                    {...bindHint('save')}
                    onClick={() => togglePopover('save')}
                    type="button"
                  >
                    save...
                  </button>
                  {openPopover === 'save' ? (
                    <div className="analysis-toolbar-popover">
                      <div className="analysis-toolbar-option-list">
                        <button
                          className="analysis-task-link subtle"
                          onClick={() => {
                            onSaveProjectPreset();
                            closePopover();
                          }}
                          type="button"
                        >
                          save for this project
                        </button>
                        <button
                          className="analysis-task-link subtle"
                          onClick={() => {
                            onSaveUniversalPreset();
                            closePopover();
                          }}
                          type="button"
                        >
                          save as universal defaults
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="analysis-toolbar-shell" ref={presetMenuRef}>
                  <button
                    aria-expanded={openPopover === 'preset'}
                    className={`analysis-task-link subtle ${openPopover === 'preset' ? 'active' : ''}`}
                    onClick={() => togglePopover('preset')}
                    type="button"
                  >
                    preset text
                  </button>
                  {openPopover === 'preset' ? (
                    <div className="analysis-toolbar-popover analysis-toolbar-popover-wide">
                      <div className="analysis-toolbar-popover-head">
                        <span>preset text</span>
                        <button className="analysis-task-link subtle" onClick={() => void handleCopyPresetText()} type="button">
                          copy
                        </button>
                      </div>
                      <pre className="analysis-preset-preview">{showPresetText}</pre>
                      {presetCopyFeedback ? <p className="analysis-toolbar-feedback">{presetCopyFeedback}</p> : null}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="analysis-toolbar-shell analysis-toolbar-shell-right" ref={resetMenuRef} {...bindHint('reset')}>
                <AnalysisStarResetButton expanded={openPopover === 'reset'} onClick={() => togglePopover('reset')} />
                {openPopover === 'reset' ? (
                  <div className="analysis-toolbar-popover analysis-toolbar-popover-purple analysis-toolbar-popover-right">
                    <div className="analysis-toolbar-popover-head">
                      <span>reset</span>
                    </div>
                    <p className="analysis-toolbar-copy">Choose which defaults should replace the active analysis parameters.</p>
                    <div className="analysis-toolbar-option-list">
                      <button
                        className="analysis-task-link subtle"
                        onClick={() => {
                          onResetToProjectDefaults();
                          closePopover();
                        }}
                        type="button"
                      >
                        reset to project defaults
                      </button>
                      <button
                        className="analysis-task-link subtle"
                        onClick={() => {
                          onResetToUniversalDefaults();
                          closePopover();
                        }}
                        type="button"
                      >
                        reset to universal defaults
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="analysis-parameter-box" id="analysis-parameters">
              <div className="analysis-parameter-group">
                <div className="analysis-mode-row" {...bindHint('analysis_engine')}>
                  <span>analysis engine</span>
                  <div className="analysis-parameter-control">
                    <div className="analysis-mode-toggle">
                      <button
                        className={`analysis-mode-button ${runSettings.analysis_engine === 'scene_v1' ? 'active' : ''}`}
                        onClick={() =>
                          setRunSettings((current) =>
                            sanitizeRunSettings({
                              ...current,
                              analysis_engine: 'scene_v1',
                              advanced: null,
                            }),
                          )
                        }
                        type="button"
                      >
                        current v1
                      </button>
                      <button
                        className={`analysis-mode-button ${runSettings.analysis_engine === 'hybrid_v2' ? 'active' : ''}`}
                        onClick={() =>
                          setRunSettings((current) =>
                            sanitizeRunSettings({
                              ...current,
                              analysis_engine: 'hybrid_v2',
                              advanced: current.advanced ?? { ...defaultHybridAdvancedSettings },
                            }),
                          )
                        }
                        type="button"
                      >
                        hybrid v2
                      </button>
                    </div>
                  </div>
                  {isEngineDirty && (
                    <AnalysisResetDiamondButton
                      className="outside"
                      label="analysis engine"
                      onClick={() => setRunSettings((current) => ({ ...current, analysis_engine: projectDefaultSettings.analysis_engine }))}
                    />
                  )}
                </div>
                <span className="analysis-parameter-annotation">
                  {runSettings.analysis_engine === 'hybrid_v2'
                    ? 'visual diff + selective OCR for interface-level changes'
                    : 'classic scene boundary detector for continuity and fast reruns'}
                </span>
              </div>

              {runSettings.analysis_engine === 'hybrid_v2' ? (
                <>
                  <div className="analysis-parameter-group">
                    <div className="analysis-mode-row" {...bindHint('analysis_preset')}>
                      <span>preset</span>
                      <div className="analysis-parameter-control">
                        <div className="analysis-mode-toggle">
                          <button
                            className={`analysis-mode-button ${runSettings.analysis_preset === 'subtle_ui' ? 'active' : ''}`}
                            onClick={() => setRunSettings((current) => ({ ...current, analysis_preset: 'subtle_ui' }))}
                            type="button"
                          >
                            subtle ui
                          </button>
                          <button
                            className={`analysis-mode-button ${runSettings.analysis_preset === 'balanced' ? 'active' : ''}`}
                            onClick={() => setRunSettings((current) => ({ ...current, analysis_preset: 'balanced' }))}
                            type="button"
                          >
                            balanced
                          </button>
                          <button
                            className={`analysis-mode-button ${runSettings.analysis_preset === 'noise_resistant' ? 'active' : ''}`}
                            onClick={() => setRunSettings((current) => ({ ...current, analysis_preset: 'noise_resistant' }))}
                            type="button"
                          >
                            ignore noise
                          </button>
                        </div>
                      </div>
                      {isPresetDirty && (
                        <AnalysisResetDiamondButton
                          className="outside"
                          label="analysis preset"
                          onClick={() => setRunSettings((current) => ({ ...current, analysis_preset: projectDefaultSettings.analysis_preset }))}
                        />
                      )}
                    </div>
                    <span className="analysis-parameter-annotation">{describeAnalysisPreset(runSettings)}</span>
                  </div>

                  <details className="analysis-tuning-section">
                    <summary className="analysis-tuning-summary" {...bindHint('hybrid_advanced')}>
                      <span>advanced hybrid tuning</span>
                      <span className="analysis-tuning-summary-actions">
                        {isHybridAdvancedDirty ? (
                          <AnalysisResetDiamondButton
                            label="advanced hybrid tuning"
                            onClick={() => {
                              setRunSettings((current) => ({
                                ...current,
                                advanced: projectDefaultSettings.advanced ?? { ...defaultHybridAdvancedSettings },
                              }));
                            }}
                          />
                        ) : null}
                        <span aria-hidden="true" className="analysis-tuning-summary-chevron" />
                      </span>
                    </summary>
                    <div className="analysis-tuning-section-body">
                      <div className="analysis-parameter-group">
                        <label className="analysis-parameter-row" {...bindHint('hybrid_sample_fps_override')}>
                          <span>sample fps override</span>
                          <div className="analysis-parameter-control">
                            <AnalysisStepperInput
                              ariaLabel="hybrid sample fps override"
                              className="analysis-parameter-input short"
                              max={Math.max(1, Math.ceil(selectedRecordingSummary?.fps ?? 30))}
                              min={1}
                              onChange={(rawValue) =>
                                setRunSettings((current) =>
                                  clampRunSettingsForRecording(
                                    {
                                      ...current,
                                      advanced: {
                                        ...(current.advanced ?? defaultHybridAdvancedSettings),
                                        sample_fps_override: rawValue ? Number(rawValue) : null,
                                      },
                                    },
                                    selectedRecordingSummary?.fps ?? null,
                                  ),
                                )
                              }
                              onStep={(direction) =>
                                setRunSettings((current) => {
                                  const fallback = analysisPresetDefaults[current.analysis_preset].sampleFps;
                                  const currentValue = current.advanced?.sample_fps_override ?? fallback;
                                  return clampRunSettingsForRecording(
                                    {
                                      ...current,
                                      advanced: {
                                        ...(current.advanced ?? defaultHybridAdvancedSettings),
                                        sample_fps_override: clampInteger(
                                          currentValue + direction,
                                          1,
                                          Math.max(1, Math.ceil(selectedRecordingSummary?.fps ?? 30)),
                                        ),
                                      },
                                    },
                                    selectedRecordingSummary?.fps ?? null,
                                  );
                                })
                              }
                              value={runSettings.advanced?.sample_fps_override ?? ''}
                            />
                          </div>
                        </label>
                        <span className="analysis-parameter-annotation">{formatHybridSampleFpsAnnotation(runSettings)}</span>
                      </div>

                      <div className="analysis-parameter-group">
                        <label className="analysis-parameter-row" {...bindHint('hybrid_min_dwell_ms')}>
                          <span>minimum dwell</span>
                          <div className="analysis-parameter-control">
                            <div className="analysis-parameter-input-group">
                              <AnalysisStepperInput
                                ariaLabel="hybrid minimum dwell"
                                className="analysis-parameter-input long"
                                min={0}
                                onChange={(rawValue) =>
                                  setRunSettings((current) => ({
                                    ...current,
                                    advanced: {
                                      ...(current.advanced ?? defaultHybridAdvancedSettings),
                                      min_dwell_ms: rawValue ? Math.max(0, Number(rawValue)) : null,
                                    },
                                  }))
                                }
                                onStep={(direction) =>
                                  setRunSettings((current) => {
                                    const fallback = analysisPresetDefaults[current.analysis_preset].minDwellMs;
                                    const currentValue = current.advanced?.min_dwell_ms ?? fallback;
                                    return {
                                      ...current,
                                      advanced: {
                                        ...(current.advanced ?? defaultHybridAdvancedSettings),
                                        min_dwell_ms: Math.max(0, currentValue + direction * 25),
                                      },
                                    };
                                  })
                                }
                                value={runSettings.advanced?.min_dwell_ms ?? ''}
                              />
                              <span className="analysis-parameter-suffix">ms</span>
                            </div>
                          </div>
                        </label>
                        <span className="analysis-parameter-annotation">{formatHybridMinDwellAnnotation(runSettings)}</span>
                      </div>

                      <div className="analysis-parameter-group">
                        <label className="analysis-parameter-row" {...bindHint('hybrid_settle_window_ms')}>
                          <span>settle window</span>
                          <div className="analysis-parameter-control">
                            <div className="analysis-parameter-input-group">
                              <AnalysisStepperInput
                                ariaLabel="hybrid settle window"
                                className="analysis-parameter-input long"
                                min={0}
                                onChange={(rawValue) =>
                                  setRunSettings((current) => ({
                                    ...current,
                                    advanced: {
                                      ...(current.advanced ?? defaultHybridAdvancedSettings),
                                      settle_window_ms: rawValue ? Math.max(0, Number(rawValue)) : null,
                                    },
                                  }))
                                }
                                onStep={(direction) =>
                                  setRunSettings((current) => {
                                    const fallback = analysisPresetDefaults[current.analysis_preset].settleWindowMs;
                                    const currentValue = current.advanced?.settle_window_ms ?? fallback;
                                    return {
                                      ...current,
                                      advanced: {
                                        ...(current.advanced ?? defaultHybridAdvancedSettings),
                                        settle_window_ms: Math.max(0, currentValue + direction * 25),
                                      },
                                    };
                                  })
                                }
                                value={runSettings.advanced?.settle_window_ms ?? ''}
                              />
                              <span className="analysis-parameter-suffix">ms</span>
                            </div>
                          </div>
                        </label>
                        <span className="analysis-parameter-annotation">{formatHybridSettleWindowAnnotation(runSettings)}</span>
                      </div>

                      <div className="analysis-parameter-group">
                        <div className="analysis-mode-row" {...bindHint('hybrid_ocr_confirmation')}>
                          <span>ocr confirmation</span>
                          <div className="analysis-parameter-control">
                            <div className="analysis-mode-toggle">
                              <button
                                className={`analysis-mode-button ${runSettings.advanced?.enable_ocr === false ? 'active' : ''}`}
                                onClick={() =>
                                  setRunSettings((current) => ({
                                    ...current,
                                    advanced: {
                                      ...(current.advanced ?? defaultHybridAdvancedSettings),
                                      enable_ocr: false,
                                      ocr_backend: null,
                                    },
                                  }))
                                }
                                type="button"
                              >
                                off
                              </button>
                              <button
                                className={`analysis-mode-button ${runSettings.advanced?.enable_ocr === false ? '' : 'active'}`}
                                onClick={() =>
                                  setRunSettings((current) => ({
                                    ...current,
                                    advanced: {
                                      ...(current.advanced ?? defaultHybridAdvancedSettings),
                                      enable_ocr: true,
                                      ocr_backend: 'paddleocr',
                                    },
                                  }))
                                }
                                type="button"
                              >
                                on
                              </button>
                            </div>
                          </div>
                        </div>
                        <span className="analysis-parameter-annotation">{formatHybridOcrAnnotation(runSettings)}</span>
                      </div>
                    </div>
                  </details>
                </>
              ) : (
                <details className="analysis-tuning-section" open>
                  <summary className="analysis-tuning-summary">
                    <span>scene v1 tuning</span>
                    <span className="analysis-tuning-summary-actions">
                      <span aria-hidden="true" className="analysis-tuning-summary-chevron" />
                    </span>
                  </summary>
                  <div className="analysis-tuning-section-body">
                    <div className="analysis-parameter-group">
                      <label className="analysis-parameter-row" {...bindHint('tolerance')}>
                        <span>tolerance</span>
                        <div className="analysis-parameter-control">
                          <AnalysisStepperInput
                            ariaLabel="tolerance"
                            className="analysis-parameter-input short"
                            max={100}
                            min={1}
                            onChange={(rawValue) =>
                              setRunSettings((current) => ({
                                ...current,
                                tolerance: clampInteger(rawValue === '' ? 1 : Number(rawValue), 1, 100),
                              }))
                            }
                            onStep={(direction) =>
                              setRunSettings((current) => ({
                                ...current,
                                tolerance: clampInteger(current.tolerance + direction, 1, 100),
                              }))
                            }
                            value={runSettings.tolerance}
                          />
                        </div>
                        {isToleranceDirty && (
                          <AnalysisResetDiamondButton
                            className="outside"
                            label="tolerance"
                            onClick={() => setRunSettings((current) => ({ ...current, tolerance: projectDefaultSettings.tolerance }))}
                          />
                        )}
                      </label>
                      <span className="analysis-parameter-annotation">
                        {runSettings.detector_mode === 'adaptive' ? 'adaptive' : 'content'} threshold: {mapToleranceToDetectorThreshold(runSettings.tolerance, runSettings.detector_mode)}
                      </span>
                    </div>
                    <div className="analysis-parameter-group">
                      <label className="analysis-parameter-row" {...bindHint('min_scene_gap_ms')}>
                        <span>minimum scene gap</span>
                        <div className="analysis-parameter-control">
                          <div className="analysis-parameter-input-group">
                            <AnalysisStepperInput
                              ariaLabel="minimum scene gap"
                              className="analysis-parameter-input long"
                              min={0}
                              onChange={(rawValue) =>
                                setRunSettings((current) => ({
                                  ...current,
                                  min_scene_gap_ms: clampInteger(rawValue === '' ? 0 : Number(rawValue), 0),
                                }))
                              }
                              onStep={(direction) =>
                                setRunSettings((current) => ({
                                  ...current,
                                  min_scene_gap_ms: clampInteger(current.min_scene_gap_ms + direction, 0),
                                }))
                              }
                              value={runSettings.min_scene_gap_ms}
                            />
                            <span className="analysis-parameter-suffix">ms</span>
                          </div>
                        </div>
                        {isMinSceneGapDirty && (
                          <AnalysisResetDiamondButton
                            className="outside"
                            label="minimum scene gap"
                            onClick={() => setRunSettings((current) => ({ ...current, min_scene_gap_ms: projectDefaultSettings.min_scene_gap_ms }))}
                          />
                        )}
                      </label>
                      <span className="analysis-parameter-annotation">
                        {(runSettings.min_scene_gap_ms / 1000).toFixed(1).replace(/\.0$/, '')}s on original timeline
                      </span>
                    </div>
                    <div className="analysis-parameter-group">
                      <label className="analysis-parameter-row" {...bindHint('sample_fps')}>
                        <span>sample fps</span>
                        <div className="analysis-parameter-control">
                          <AnalysisStepperInput
                            ariaLabel="sample fps"
                            className="analysis-parameter-input short"
                            max={sampleFpsGuardrail.maxSampleFps}
                            min={1}
                            onChange={(rawValue) =>
                              setRunSettings((current) =>
                                clampRunSettingsForRecording(
                                  {
                                    ...current,
                                    sample_fps: rawValue
                                      ? clampInteger(Number(rawValue), 1, sampleFpsGuardrail.maxSampleFps)
                                      : sampleFpsGuardrail.sourceFpsAvailable
                                        ? null
                                        : sampleFpsGuardrail.maxSampleFps,
                                  },
                                  selectedRecordingSummary?.fps ?? null,
                                ),
                              )
                            }
                            onStep={(direction) =>
                              setRunSettings((current) =>
                                clampRunSettingsForRecording(
                                  {
                                    ...current,
                                    sample_fps: clampInteger((current.sample_fps ?? 1) + direction, 1, sampleFpsGuardrail.maxSampleFps),
                                  },
                                  selectedRecordingSummary?.fps ?? null,
                                ),
                              )
                            }
                            value={runSettings.sample_fps ?? ''}
                          />
                        </div>
                        {isSampleFpsDirty && (
                          <AnalysisResetDiamondButton
                            className="outside"
                            label="sample fps"
                            onClick={() => setRunSettings((current) => ({ ...current, sample_fps: projectDefaultSettings.sample_fps }))}
                          />
                        )}
                      </label>
                      <span className="analysis-parameter-annotation">
                        {(() => {
                          const sourceFps = selectedRecordingSummary?.fps ?? null;
                          const sampleFps = runSettings.sample_fps;
                          if (!sampleFps || !sourceFps) return sourceFps ? `every frame (~${Math.round(sourceFps)} fps source)` : null;
                          const skip = Math.max(1, Math.round(sourceFps / sampleFps));
                          return skip > 1 ? `~every ${ordinal(skip)} frame (~${Math.round(sourceFps)} fps source)` : `every frame (~${Math.round(sourceFps)} fps source)`;
                        })()}
                      </span>
                    </div>
                    <label className="analysis-parameter-row" {...bindHint('extract_offset_ms')}>
                      <span>extract offset</span>
                      <div className="analysis-parameter-control">
                        <div className="analysis-parameter-input-group">
                          <AnalysisStepperInput
                            ariaLabel="extract offset"
                            className="analysis-parameter-input long"
                            min={0}
                            onChange={(rawValue) =>
                              setRunSettings((current) => ({
                                ...current,
                                extract_offset_ms: clampInteger(rawValue === '' ? 0 : Number(rawValue), 0),
                              }))
                            }
                            onStep={(direction) =>
                              setRunSettings((current) => ({
                                ...current,
                                extract_offset_ms: clampInteger(current.extract_offset_ms + direction, 0),
                              }))
                            }
                            value={runSettings.extract_offset_ms}
                          />
                          <span className="analysis-parameter-suffix">ms</span>
                        </div>
                      </div>
                      {isExtractOffsetDirty && (
                        <AnalysisResetDiamondButton
                          className="outside"
                          label="extract offset"
                          onClick={() => setRunSettings((current) => ({ ...current, extract_offset_ms: projectDefaultSettings.extract_offset_ms }))}
                        />
                      )}
                    </label>

                    <div className="analysis-mode-row" {...bindHint('allow_high_fps_sampling')}>
                      <span>high-fps sampling</span>
                      <div className="analysis-parameter-control">
                        <div className="analysis-mode-toggle">
                          <button
                            className={`analysis-mode-button ${runSettings.allow_high_fps_sampling ? '' : 'active'}`}
                            onClick={() =>
                              setRunSettings((current) =>
                                clampRunSettingsForRecording(
                                  {
                                    ...current,
                                    allow_high_fps_sampling: false,
                                  },
                                  selectedRecordingSummary?.fps ?? null,
                                ),
                              )
                            }
                            type="button"
                          >
                            off
                          </button>
                          <button
                            className={`analysis-mode-button ${runSettings.allow_high_fps_sampling ? 'active' : ''}`}
                            onClick={() =>
                              setRunSettings((current) =>
                                clampRunSettingsForRecording(
                                  {
                                    ...current,
                                    allow_high_fps_sampling: true,
                                  },
                                  selectedRecordingSummary?.fps ?? null,
                                ),
                              )
                            }
                            type="button"
                          >
                            on
                          </button>
                        </div>
                      </div>
                      {isHighFpsDirty && (
                        <AnalysisResetDiamondButton
                          className="outside"
                          label="high-fps sampling"
                          onClick={() =>
                            setRunSettings((current) =>
                              clampRunSettingsForRecording(
                                {
                                  ...current,
                                  allow_high_fps_sampling: projectDefaultSettings.allow_high_fps_sampling,
                                },
                                selectedRecordingSummary?.fps ?? null,
                              ),
                            )
                          }
                        />
                      )}
                    </div>

                    <div className="analysis-parameter-group">
                      <div className="analysis-mode-row" {...bindHint('detector_mode')}>
                        <span>detector mode</span>
                        <div className="analysis-parameter-control">
                          <div className="analysis-mode-toggle">
                            <button
                              className={`analysis-mode-button ${runSettings.detector_mode === 'content' ? 'active' : ''}`}
                              onClick={() => setRunSettings((current) => ({ ...current, detector_mode: 'content' }))}
                              type="button"
                            >
                              content
                            </button>
                            <button
                              className={`analysis-mode-button ${runSettings.detector_mode === 'adaptive' ? 'active' : ''}`}
                              onClick={() => setRunSettings((current) => ({ ...current, detector_mode: 'adaptive' }))}
                              type="button"
                            >
                              adaptive
                            </button>
                          </div>
                        </div>
                        {isDetectorModeDirty && (
                          <AnalysisResetDiamondButton
                            className="outside"
                            label="detector mode"
                            onClick={() => setRunSettings((current) => ({ ...current, detector_mode: projectDefaultSettings.detector_mode }))}
                          />
                        )}
                      </div>
                      <span className="analysis-parameter-annotation">
                        {runSettings.detector_mode === 'adaptive'
                          ? 'compares against recent frames · threshold range 1–7'
                          : 'compares to previous frame · threshold range 8–48'}
                      </span>
                    </div>
                  </div>
                </details>
              )}
            </div>

            <div className="analysis-guidance-block">
              {runSettings.analysis_engine === 'hybrid_v2' ? (
                <p className="analysis-guidance-copy">
                  Hybrid v2 is tuned for interface changes first. Start with the preset that matches your tolerance for noise, then only use advanced controls if a specific recording still over- or under-fires.
                </p>
              ) : (
                <p className="analysis-guidance-copy">
                  If steps are missing, raise sample fps first, then lower tolerance, then lower minimum scene gaps. Use extract offset only to improve screenshot timing.
                </p>
              )}
              {showHighFpsWarning ? (
                <p className="analysis-guidance-copy warning">
                  This video is {sampleFpsGuardrail.sourceFpsCeiling} fps. Turn on high-fps sampling to use source fps or go above 30 fps.
                </p>
              ) : null}
              {showLowCandidateHint ? (
                <p className="analysis-guidance-copy warning">
                  {runSettings.analysis_engine === 'hybrid_v2'
                    ? 'This run found very few interface changes. Try the Subtle UI preset or lower the hybrid dwell/settle timing.'
                    : 'This run found very few scenes. Try higher sample fps first, then lower tolerance or minimum scene gaps.'}
                </p>
              ) : null}
              {runSettings.analysis_engine === 'scene_v1' && runSettings.tolerance <= 15 ? (
                <p className="analysis-guidance-copy warning">
                  Note: A very low tolerance makes the detector highly sensitive. You may get many false positives from video compression noise or subtle background changes.
                </p>
              ) : null}
            </div>

            <div className="analysis-param-footer">
              <button
                className="analysis-pill success analysis-run-button"
                disabled={!selectedRecordingId || createRunPending || healthWarning}
                {...bindHint('run')}
                onClick={onStartRun}
                type="button"
              >
                {createRunPending ? 'running...' : 'run analysis'}
              </button>
            </div>

            {hintText && hintCardPosition ? (
              <div
                className="analysis-hint-float"
                style={{
                  left: `${hintCardPosition.left}px`,
                  top: `${hintCardPosition.top}px`,
                }}
              >
                <p className="analysis-hint-float-copy">{hintText}</p>
              </div>
            ) : null}
          </section>

          <section className="analysis-column">
            <div className="analysis-column-head">
              <p>tasks</p>
              <div className="analysis-task-head-tools">
                <div className="analysis-task-filter-tabs">
                  {analysisTaskFilters.map((filter) => (
                    <button
                      className={`analysis-task-filter-button ${taskFilter === filter ? 'active' : ''}`}
                      key={filter}
                      onClick={() => setTaskFilter(filter)}
                      type="button"
                    >
                      {filter}
                    </button>
                  ))}
                </div>
                <div className="analysis-task-toolbar">
                  {taskSelectMode ? (
                    <>
                      <span className="analysis-task-selection-count">{selectedTaskRunIds.length} selected</span>
                      <button
                        className="analysis-task-link danger"
                        disabled={!selectedTaskRunIds.length || bulkDeletePending}
                        onClick={() => void handleDeleteSelectedTasks()}
                        type="button"
                      >
                        {bulkDeletePending ? 'deleting...' : 'delete selected'}
                      </button>
                      <button
                        className="analysis-task-link subtle"
                        disabled={!selectedTaskRunIds.length || bulkExportPending}
                        onClick={() => void handleExportSelectedTasks()}
                        type="button"
                      >
                        {bulkExportPending ? 'exporting...' : 'export selected'}
                      </button>
                      <button
                        className="analysis-task-link subtle"
                        disabled={!analysisTaskItems.some((item) => item.run.status === 'completed') || bulkExportPending}
                        onClick={() => void handleExportAllCompletedTasks()}
                        type="button"
                      >
                        export all completed
                      </button>
                      <button
                        className="analysis-task-link subtle"
                        onClick={() => {
                          setTaskSelectMode(false);
                          setSelectedTaskRunIds([]);
                        }}
                        type="button"
                      >
                        done
                      </button>
                    </>
                  ) : (
                    <button
                      className="analysis-task-link subtle"
                      onClick={() => {
                        setTaskSelectMode(true);
                        setSelectedTaskRunIds([]);
                      }}
                      type="button"
                    >
                      select
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="analysis-divider" />
            <div className="analysis-tasks">
              {groupedTaskItems.map((group) => renderTaskGroup(group))}
              {!analysisTaskItems.length && <p className="entry-empty-copy">Run summaries will appear here once analysis starts.</p>}
              {Boolean(analysisTaskItems.length) && !groupedTaskItems.length && (
                <p className="entry-empty-copy">No tasks in this filter yet.</p>
              )}
            </div>
          </section>
        </div>

        {previewVideoUrl && (
          <div className="analysis-lower-grid">
            <div className="analysis-lower-column">
              {previewVideoUrl ? (
                <section className="analysis-panel analysis-preview-panel" id="analysis-video-preview">
                  <div className="analysis-preview-head">
                    <div className="analysis-preview-meta-wrap">
                      <span className="analysis-preview-meta">
                        {previewRecording?.filename} · {formatPlaybackTimestamp(previewPlaybackMs)}
                      </span>
                      {canAddManualCandidate ? (
                        <span className="analysis-preview-mark-copy">click anywhere in the button or press K to mark the current frame</span>
                      ) : null}
                    </div>
                    {canAddManualCandidate ? (
                      <button
                        className="analysis-preview-mark-button"
                        aria-busy={createManualCandidatePending || queuedManualMarkItems.length > 0}
                        onClick={(event) => {
                          if (event.detail !== 0) {
                            return;
                          }
                          handleCreateManualCandidate();
                        }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) {
                            return;
                          }
                          event.preventDefault();
                          const timestampMs = getCurrentPreviewTimestampMs();
                          if (timestampMs === null) {
                            return;
                          }
                          handleCreateManualCandidate(timestampMs);
                        }}
                        title="Mark the current preview frame as a new step."
                        type="button"
                      >
                        {manualCapturePulseToken > 0 ? (
                          <span aria-hidden="true" className="analysis-preview-mark-pulse" key={manualCapturePulseToken} />
                        ) : null}
                        <span className="analysis-preview-mark-main">
                          <span className="analysis-preview-mark-title">mark step</span>
                          <span className="analysis-preview-mark-subtitle">captures this moment immediately while the video plays</span>
                        </span>
                        <span className="analysis-preview-mark-shortcut">K</span>
                        {queuedManualMarkItems.length > 0 ? (
                          <span className="analysis-preview-mark-queue">{queuedManualMarkItems.length}</span>
                        ) : null}
                      </button>
                    ) : null}
                  </div>
                  <video
                    className="analysis-preview-video"
                    controls
                    onLoadedMetadata={(event) => setPreviewPlaybackMs(event.currentTarget.currentTime * 1000)}
                    onSeeked={(event) => setPreviewPlaybackMs(event.currentTarget.currentTime * 1000)}
                    onTimeUpdate={(event) => setPreviewPlaybackMs(event.currentTarget.currentTime * 1000)}
                    playsInline
                    ref={previewVideoRef}
                    src={previewVideoUrl}
                  />
                </section>
              ) : null}
            </div>
            <div className="analysis-lower-column" />
            <div className="analysis-lower-column" />
          </div>
        )}

        {selectedRun ? (
          <section className="analysis-detail-section stack-gap" id="analysis-run-detail">
            <div className="analysis-detail-header">
              <div className="analysis-detail-copy">
                <p className="analysis-section-eyebrow">selected task</p>
                {isCompletedReview ? (
                  <h2>{selectedRecordingSummary?.filename ?? selectedRun.summary.recording_id}</h2>
                ) : (
                  <div className="run-title-row">
                    <h2>{selectedRecordingSummary?.filename ?? selectedRun.summary.recording_id}</h2>
                    <span className={`status-pill ${selectedRun.summary.status}`}>{selectedRun.summary.status.replace('_', ' ')}</span>
                  </div>
                )}
                <p className="analysis-detail-meta">
                  {formatAnalysisEngineLabel(selectedRun.summary.analysis_engine)} · {formatAnalysisPresetLabel(selectedRun.summary.analysis_preset)}
                </p>
                {!isCompletedReview && selectedRun.summary.message ? <p className="muted">{selectedRun.summary.message}</p> : null}
                <div className="analysis-detail-meta-row">
                  <p className="analysis-detail-meta">{formatRunTiming(selectedRun.summary)}</p>
                  <div className="analysis-log-popover-shell">
                    <button
                      className="analysis-task-link subtle analysis-log-toggle"
                      id="analysis-run-logs"
                      onClick={() => setShowRunLogs((current) => !current)}
                      type="button"
                    >
                      {showRunLogs ? 'hide logs' : 'view logs'}
                    </button>
                    {showRunLogs ? (
                      <div className="analysis-log-popover">
                        <div className="analysis-log-lines">
                          {selectedRun.events.map((event) => (
                            <p className={`analysis-log-line ${event.level}`} key={event.id}>
                              <span className="analysis-log-line-meta">
                                {new Date(event.created_at).toLocaleTimeString()} · {formatPhase(event.phase)}
                              </span>
                              <span>{event.message}</span>
                              {typeof event.progress === 'number' ? (
                                <span className="analysis-log-line-progress">{formatPercent(event.progress)}</span>
                              ) : null}
                            </p>
                          ))}
                          {!selectedRun.events.length && <p className="empty-copy">Progress messages will appear here once the run starts.</p>}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              {selectedRun.summary.is_abortable ? (
                <div className="action-row">
                  {selectedRun.summary.is_abortable && (
                    <button className="analysis-pill danger" disabled={abortRunPending} onClick={() => onAbortRun(selectedRun.summary.id)} type="button">
                      end
                    </button>
                  )}
                </div>
              ) : null}
            </div>

            {!isCompletedReview ? (
              <div className="analysis-task-bar" aria-hidden="true">
                <div className="analysis-task-bar-fill" style={{ width: formatPercent(selectedRun.summary.progress) }} />
              </div>
            ) : null}



            {selectedRun.summary.status === 'completed' ? (
              <div className="analysis-compare-shell">
                <div className="analysis-compare-head">
                  <div>
                    <p className="analysis-section-eyebrow">comparison</p>
                    <h3>Compare completed runs</h3>
                  </div>
                  <label className="analysis-compare-select-wrap">
                    <span className="sr-only">Compare with another completed run</span>
                    <select className="analysis-compare-select" onChange={(event) => setCompareRunId(event.target.value || null)} value={compareRunId ?? ''}>
                      <option value="">select another completed run</option>
                      {comparableRuns.map((run) => (
                        <option key={run.id} value={run.id}>
                          {formatRunSettingsSummary(run)} · {new Date(run.created_at).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {comparedRun ? (
                  <>
                    <div className="analysis-compare-summary">
                      <span>{comparisonRows.filter((row) => row.badge === 'both').length} matched</span>
                      <span>{comparisonRows.filter((row) => row.badge === 'timing_shifted').length} timing shifted</span>
                      <span>{comparisonRows.filter((row) => row.badge === 'left_only').length} only in selected</span>
                      <span>{comparisonRows.filter((row) => row.badge === 'right_only').length} only in comparison</span>
                    </div>
                    <div className="analysis-compare-grid">
                      {comparisonRows.map((row, index) => {
                        const badgeLabel =
                          row.badge === 'both'
                            ? 'both'
                            : row.badge === 'timing_shifted'
                              ? 'timing shifted'
                              : row.badge === 'left_only'
                                ? selectedRun.summary.analysis_engine === 'scene_v1'
                                  ? 'v1 only'
                                  : 'v2 only'
                                : comparedRun.summary.analysis_engine === 'scene_v1'
                                  ? 'v1 only'
                                  : 'v2 only';
                        return (
                          <article className="analysis-compare-card" key={`${row.left?.id ?? 'left-none'}-${row.right?.id ?? 'right-none'}-${index}`}>
                            <div className="analysis-compare-card-head">
                              <span className={`analysis-compare-badge ${row.badge}`}>{badgeLabel}</span>
                              {typeof row.timeDeltaMs === 'number' ? <small>{row.timeDeltaMs}ms apart</small> : null}
                            </div>
                            <div className="analysis-compare-card-columns">
                              <div className="analysis-compare-column">
                                <p className="analysis-compare-column-label">selected</p>
                                {row.left ? (
                                  <>
                                    <img alt={`Selected run candidate at ${row.left.timestamp_tc}`} className="analysis-compare-image" src={absoluteApiUrl(row.left.image_url)} />
                                    <small>{row.left.timestamp_tc}</small>
                                    <ComparisonMetrics candidate={row.left} />
                                  </>
                                ) : (
                                  <p className="analysis-compare-empty">No matching candidate</p>
                                )}
                              </div>
                              <div className="analysis-compare-column">
                                <p className="analysis-compare-column-label">comparison</p>
                                {row.right ? (
                                  <>
                                    <img alt={`Comparison run candidate at ${row.right.timestamp_tc}`} className="analysis-compare-image" src={absoluteApiUrl(row.right.image_url)} />
                                    <small>{row.right.timestamp_tc}</small>
                                    <ComparisonMetrics candidate={row.right} />
                                  </>
                                ) : (
                                  <p className="analysis-compare-empty">No matching candidate</p>
                                )}
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </>
                ) : compareRunId ? (
                  <p className="analysis-guidance-copy">Loading comparison run…</p>
                ) : (
                  <p className="analysis-guidance-copy">Select another completed run from this recording to compare outputs side by side.</p>
                )}
              </div>
            ) : null}

            {canReviewCandidates ? (
              <>
                {selectedRun.accepted_steps.length > 0 && (
                  <div className="accepted-strip-shell" id="analysis-accepted-steps">
                    <div className="candidate-review-head">
                      <p className="candidate-review-title">accepted steps</p>
                    </div>
                    <div className="accepted-strip">
                      {selectedRun.accepted_steps.map((step) => {
                        const similarityLink = acceptedStepSimilarityLinks.get(step.step_id);
                        return (
                          <div
                            className="accepted-step-chip"
                            id={`accepted-step-${step.step_id}`}
                            key={step.step_id}
                            onClick={() => activateCandidate(step.source_candidate_id, { reveal: true })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                activateCandidate(step.source_candidate_id, { reveal: true });
                              }
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            <div className="accepted-step-topline">
                              <span className="accepted-step-id">{step.step_id}</span>
                              <small>{step.timestamp_tc}</small>
                            </div>
                            <strong className="accepted-step-title" title={step.title}>
                              {step.title}
                            </strong>
                            {similarityLink ? (
                              <div className="linked-scene-row">
                                <span className="accepted-step-link-label">returning scene</span>
                                <button
                                  className="inline-link-button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    jumpToAnchor(similarityLink.targetId);
                                  }}
                                  type="button"
                                >
                                  {similarityLink.label}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {canShowTimeline ? (
                  <div className="candidate-timeline-shell">
                    <div className="candidate-timeline-rail" aria-label="Candidate timeline">
                      {previewMatchesSelectedRun ? (
                        <span
                          aria-hidden="true"
                          className="candidate-timeline-playhead"
                          style={{
                            left: `${Math.min(100, Math.max(0, (previewPlaybackMs / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100))}%`,
                          }}
                        />
                      ) : null}
                      {timelineCandidates.map((candidate) => {
                        const tooltip = `${candidate.candidate_origin === 'manual' ? 'manual' : 'candidate'} ${candidate.detector_index} • ${candidate.timestamp_tc} • ${candidate.status}`;
                        return (
                          <button
                            aria-label={tooltip}
                            className={`candidate-timeline-pin ${candidate.status} ${activeCandidateId === candidate.id ? 'active' : ''}`}
                            data-tooltip={tooltip}
                            key={candidate.id}
                            onClick={() => activateCandidate(candidate.id, { reveal: true, seekPreview: true })}
                            style={{
                              left: `${Math.min(100, Math.max(0, (candidate.timestamp_ms / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100))}%`,
                            }}
                            title={tooltip}
                            type="button"
                          />
                        );
                      })}
                      {queuedManualMarkItems.map((item) => (
                        <span
                          aria-hidden="true"
                          className="candidate-timeline-pin pending manual-pending active"
                          data-tooltip={`manual mark • ${formatPlaybackTimestamp(item.timestampMs)}`}
                          key={item.id}
                          style={{
                            left: `${Math.min(100, Math.max(0, (item.timestampMs / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100))}%`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="candidate-review-toolbar" id="analysis-review-toolbar">
                  <div className="candidate-review-nav-group">
                    <div aria-label="Candidate review filters" className="candidate-filter-tabs" role="tablist">
                      {candidateFilters.map((filter) => (
                        <button
                          aria-selected={activeCandidateFilter === filter}
                          className={`candidate-filter-tab ${activeCandidateFilter === filter ? 'active' : ''}`}
                          key={filter}
                          onClick={() => setActiveCandidateFilter(filter)}
                          role="tab"
                          type="button"
                        >
                          <span>{filter}</span>
                          <small>{candidateCounts[filter]}</small>
                        </button>
                      ))}
                    </div>
                    <div className="candidate-review-stepper">
                      <button
                        className="analysis-task-link subtle"
                        disabled={filteredCandidates.length <= 1}
                        onClick={() => handleStepCandidate(-1)}
                        type="button"
                      >
                        prev
                      </button>
                      <button
                        className="analysis-task-link subtle"
                        disabled={filteredCandidates.length <= 1}
                        onClick={() => handleStepCandidate(1)}
                        type="button"
                      >
                        next
                      </button>
                    </div>
                  </div>
                  {selectedPendingCandidateIds.length > 0 || isCompletedReview ? (
                    <div className="candidate-review-actions">
                      {selectedPendingCandidateIds.length > 0 ? (
                        <div className="candidate-bulk-actions">
                          <span className="candidate-bulk-count">
                            {selectedPendingCandidateIds.length} {selectedPendingCandidateIds.length === 1 ? 'candidate selected' : 'candidates selected'}
                          </span>
                          <button
                            className="analysis-task-link subtle"
                            disabled={bulkCandidatePending}
                            onClick={() => void handleBulkCandidateStatusChange('accepted')}
                            type="button"
                          >
                            {bulkCandidatePending ? 'working...' : 'accept selected'}
                          </button>
                          <button
                            className="analysis-task-link subtle"
                            disabled={bulkCandidatePending}
                            onClick={() => void handleBulkCandidateStatusChange('rejected')}
                            type="button"
                          >
                            {bulkCandidatePending ? 'working...' : 'reject selected'}
                          </button>
                          <button
                            className="analysis-task-link subtle"
                            disabled={bulkCandidatePending}
                            onClick={() => setSelectedCandidateIds([])}
                            type="button"
                          >
                            clear selection
                          </button>
                        </div>
                      ) : null}
                      {isCompletedReview ? (
                        <>
                          <div className="candidate-export-name-stack">
                            <label className="candidate-export-name-wrap">
                              <span className="sr-only">Export zip name</span>
                              <input
                                aria-label="Export zip name"
                                className="candidate-export-name-field"
                                onChange={(event) => setExportNameDraft(event.target.value)}
                                placeholder="Use server filename"
                                value={exportNameDraft}
                              />
                              <span className="candidate-export-name-suffix">.zip</span>
                            </label>
                            <span className="candidate-export-name-preview">
                              {resolvedExportFilenamePreview ? `→ ${resolvedExportFilenamePreview}` : '→ server-generated filename'}
                            </span>
                          </div>
                          {selectedRunExportLabel ? <span className="analysis-export-status">{selectedRunExportLabel}</span> : null}
                          <div className="candidate-export-shell" ref={exportMenuRef}>
                            <button
                              aria-expanded={openPopover === 'export'}
                              className="analysis-pill success"
                              disabled={!canExportAll || exportRunPending}
                              onClick={() => togglePopover('export')}
                              type="button"
                            >
                              {exportRunPending ? 'exporting...' : 'export'}
                            </button>
                            {openPopover === 'export' ? (
                              <div className="candidate-export-popover">
                                <div className="candidate-export-option-list">
                                  <button
                                    className="analysis-task-link subtle"
                                    disabled={!canExportAccepted || exportRunPending}
                                    onClick={() => void handleSelectedRunExport('accepted')}
                                    type="button"
                                  >
                                    export accepted
                                  </button>
                                  <button
                                    className="analysis-task-link subtle"
                                    disabled={!canExportAll || exportRunPending}
                                    onClick={() => void handleSelectedRunExport('all')}
                                    type="button"
                                  >
                                    export all
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {filteredCandidates.length ? (
                  <div className={`candidate-grid ${filteredCandidates.length < 3 ? 'sparse' : ''}`} id="analysis-candidate-review">
                    {filteredCandidates.map((candidate) => {
                      const similarityLink = candidateSimilarityLinks.get(candidate.id);
                      return (
                        <CandidateCard
                          candidate={candidate}
                          isActive={activeCandidateId === candidate.id}
                          isAnnotationExpanded={expandedAnnotationCandidateId === candidate.id}
                          isSelected={selectedPendingCandidateIds.includes(candidate.id)}
                          isSelectable={candidate.status === 'pending'}
                          key={candidate.id}
                          onActivate={() => setActiveCandidateId(candidate.id)}
                          onJumpToSimilar={similarityLink ? () => jumpToAnchor(similarityLink.targetId) : undefined}
                          onSetStatus={(status) => handleCandidateStatusChange(candidate, status)}
                          onToggleSelection={() => toggleCandidateSelection(candidate.id)}
                          onToggleAnnotation={() => handleToggleCandidateAnnotation(candidate.id)}
                          onUpdate={(payload) => onUpdateCandidate(candidate.id, payload)}
                          similarLink={similarityLink}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <p className="entry-empty-copy candidate-empty-copy">
                    {activeCandidateFilter === 'all'
                      ? 'No scenes in this run.'
                      : activeCandidateFilter === 'pending'
                        ? 'No pending scenes left in this run.'
                        : `No ${activeCandidateFilter} scenes in this view.`}
                  </p>
                )}
              </>
            ) : null}
          </section>
        ) : selectedRecording ? (
          <section className="analysis-detail-section empty-state">
            <h2>{selectedRecording.filename}</h2>
            <p>Select a video name or a task link to review candidates, logs, and exports here.</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function EntryScreen({
  appError,
  healthMessage,
  isCreating,
  onCreate,
  onNavigateStage,
  onOpenProject,
  onProjectNameChange,
  onRenameProject,
  projectName,
  projects,
  projectsLoading,
  selectedProjectCanJumpToAnalysis,
  selectedProjectId,
}: EntryScreenProps) {
  const [projectSearch, setProjectSearch] = useState('');
  const [projectSort, setProjectSort] = useState<'name' | 'recent'>('recent');
  const visibleProjects = useMemo(() => {
    const searchValue = projectSearch.trim().toLowerCase();
    const filteredProjects = projects.filter((project) => project.name.toLowerCase().includes(searchValue));

    return filteredProjects.sort((left, right) => {
      if (projectSort === 'name') {
        return left.name.localeCompare(right.name);
      }
      const activityDelta = new Date(right.last_activity_at).getTime() - new Date(left.last_activity_at).getTime();
      if (activityDelta !== 0) {
        return activityDelta;
      }
      return left.name.localeCompare(right.name);
    });
  }, [projectSearch, projectSort, projects]);

  return (
    <div className="entry-screen">
      <div className="entry-shell">
        <StageNavigator
          activeStage="projects"
          className="entry-stage-nav"
          disabledStages={{ analysis: !selectedProjectId || !selectedProjectCanJumpToAnalysis, import: !selectedProjectId }}
          onNavigate={onNavigateStage}
        />

        <div className="entry-stage">
          {(healthMessage || appError) && (
            <div className="entry-notices">
              {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
              {appError && <p className="entry-notice error">{appError}</p>}
            </div>
          )}

          <form className="entry-create-form" onSubmit={onCreate}>
            <input
              className="entry-project-input"
              onChange={(event) => onProjectNameChange(event.target.value)}
              placeholder="create a project"
              value={projectName}
            />
            <button className="entry-enter-button" disabled={!projectName.trim() || isCreating} type="submit">
              {isCreating ? 'entering…' : 'enter'}
            </button>
          </form>

          <p className="entry-helper-copy">or select an existing project...</p>

          <div className="entry-project-browser">
            <div className="entry-project-tools">
              <input
                className="entry-project-search"
                onChange={(event) => setProjectSearch(event.target.value)}
                placeholder="search projects"
                value={projectSearch}
              />
              <div className="entry-project-sort">
                <button
                  className={`entry-project-sort-button ${projectSort === 'recent' ? 'active' : ''}`}
                  onClick={() => setProjectSort('recent')}
                  type="button"
                >
                  recent
                </button>
                <button
                  className={`entry-project-sort-button ${projectSort === 'name' ? 'active' : ''}`}
                  onClick={() => setProjectSort('name')}
                  type="button"
                >
                  a-z
                </button>
              </div>
            </div>

            <div className="entry-project-list">
              {visibleProjects.map((project) => (
                <div className={`entry-project-row-shell ${project.id === selectedProjectId ? 'selected' : ''}`} key={project.id}>
                  <div className="entry-project-row">
                    <div className="entry-project-row-copy">
                      <EditableName
                        buttonClassName="entry-rename-button"
                        containerClassName="entry-project-name"
                        displayButtonClassName="entry-project-select-button"
                        onDisplayClick={() => onOpenProject(project.id, 'import')}
                        onSave={(nextValue) => onRenameProject(project.id, nextValue)}
                        renameLabel={`Rename project ${project.name}`}
                        textClassName="entry-project-name-text"
                        value={project.name}
                      />
                      <button className="entry-project-summary-button" onClick={() => onOpenProject(project.id, 'import')} type="button">
                        <small>{formatProjectSummary(project)}</small>
                      </button>
                    </div>
                    <div className="entry-project-actions">
                      <button className="analysis-pill success entry-project-action-pill" onClick={() => onOpenProject(project.id, 'import')} type="button">
                        import
                      </button>
                      {project.recording_count > 0 ? (
                        <button
                          className="analysis-pill analysis-pill-accent entry-project-action-pill"
                          onClick={() => onOpenProject(project.id, 'analysis')}
                          type="button"
                        >
                          analysis
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
              {!projects.length && !projectsLoading && <p className="entry-empty-copy">No existing projects yet.</p>}
              {Boolean(projects.length) && !visibleProjects.length && !projectsLoading && (
                <p className="entry-empty-copy">No projects match that search.</p>
              )}
              {projectsLoading && <p className="entry-empty-copy">Loading projects…</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RunListItemProps {
  run: RunSummary;
  isSelected: boolean;
  onAbort: () => void;
  onDelete: () => void;
  onSelect: () => void;
}

function RunListItem({ run, isSelected, onAbort, onDelete, onSelect }: RunListItemProps) {
  return (
    <div className={`management-row ${isSelected ? 'selected-shell' : ''}`}>
      <button className={`run-row ${isSelected ? 'selected' : ''}`} onClick={onSelect} type="button">
        <span className="run-row-copy">
          <strong>{formatPhase(run.phase)}</strong>
          <small>{formatPercent(run.progress)} · {run.candidate_count} candidates · {run.accepted_count} accepted</small>
          <small className="run-settings-summary">{formatRunSettingsSummary(run)}</small>
        </span>
        <span className="run-row-status">
          <small>{formatRunTiming(run)}</small>
          <span className={`status-pill small ${run.status}`}>{run.status.replace('_', ' ')}</span>
        </span>
      </button>
      <div className="row-actions">
        {run.is_abortable && (
          <button className="secondary-button small-button" onClick={onAbort} type="button">
            Abort
          </button>
        )}
        {run.is_deletable && (
          <button className="danger-button small-button" onClick={onDelete} type="button">
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

interface CandidateCardProps {
  candidate: CandidateFrame;
  isActive: boolean;
  isAnnotationExpanded: boolean;
  isSelected: boolean;
  isSelectable: boolean;
  onActivate: () => void;
  onJumpToSimilar?: (() => void) | undefined;
  onSetStatus: (status: CandidateStatus) => void;
  onToggleSelection: () => void;
  onToggleAnnotation: () => void;
  similarLink?: SimilarLink | undefined;
  onUpdate: (payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>>) => void;
}

interface CandidateDecisionButtonProps {
  intent: CandidateStatus;
  isActive: boolean;
  label: string;
  onClick: () => void;
}

function CandidateDecisionButton({ intent, isActive, label, onClick }: CandidateDecisionButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={isActive}
      className={`candidate-decision-button ${intent} ${isActive ? 'active' : ''}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      <svg aria-hidden="true" className="candidate-decision-icon" viewBox="0 0 16 16">
        {intent === 'accepted' ? (
          <path d="M3.5 8.5 6.4 11.4 12.5 4.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
        ) : intent === 'rejected' ? (
          <path d="M4.3 4.3 11.7 11.7M11.7 4.3 4.3 11.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" />
        ) : (
          <path d="M11.6 6.2A4.4 4.4 0 1 0 12 8m0-3.8V7.6H8.6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
        )}
      </svg>
    </button>
  );
}

function CandidateCard({
  candidate,
  isActive,
  isAnnotationExpanded,
  isSelected,
  isSelectable,
  onActivate,
  onJumpToSimilar,
  onSetStatus,
  onToggleSelection,
  onToggleAnnotation,
  similarLink,
  onUpdate,
}: CandidateCardProps) {
  const [title, setTitle] = useState(candidate.title ?? '');
  const [notes, setNotes] = useState(candidate.notes ?? '');
  const annotationToggleLabel = isAnnotationExpanded ? 'hide notes' : candidate.title || candidate.notes ? 'edit notes' : 'annotate';

  useEffect(() => {
    setTitle(candidate.title ?? '');
    setNotes(candidate.notes ?? '');
  }, [candidate.id, candidate.title, candidate.notes]);

  function commitTextField(field: 'title' | 'notes', value: string) {
    const trimmed = value.trim();
    const currentValue = field === 'title' ? candidate.title ?? '' : candidate.notes ?? '';
    if (trimmed === currentValue.trim()) {
      return;
    }
    onUpdate({ [field]: trimmed } as Partial<Pick<CandidateFrame, 'title' | 'notes'>>);
  }

  return (
    <article
      className={`candidate-card ${candidate.status} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
      id={`candidate-${candidate.id}`}
      onClick={onActivate}
      onFocus={onActivate}
      tabIndex={-1}
    >
      <div className="candidate-image-wrap">
        <img alt={`Candidate screenshot at ${candidate.timestamp_tc}`} src={absoluteApiUrl(candidate.image_url)} />
        <div className="candidate-overlay">
          <span className="candidate-timecode">{candidate.timestamp_tc}</span>
          {isSelectable ? (
            <label
              className="candidate-select-toggle"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <input
                aria-label={`Select candidate ${candidate.detector_index}`}
                checked={isSelected}
                onChange={onToggleSelection}
                type="checkbox"
              />
            </label>
          ) : null}
        </div>
      </div>
      <div className="candidate-body">
        <div className="candidate-headline">
          <div className="candidate-heading-copy">
            <strong className="candidate-title">{candidate.candidate_origin === 'manual' ? 'manual step' : 'candidate'} {candidate.detector_index}</strong>
            <div className="candidate-heading-meta">
              <span className={`candidate-status-copy ${candidate.status}`}>{candidate.status}</span>
              {candidate.candidate_origin === 'manual' ? <span className="candidate-origin-copy">manual</span> : null}
            </div>
          </div>
          <div className="candidate-decision-row">
            <CandidateDecisionButton
              intent="accepted"
              isActive={candidate.status === 'accepted'}
              label="Accept candidate"
              onClick={() => onSetStatus('accepted')}
            />
            <CandidateDecisionButton
              intent="rejected"
              isActive={candidate.status === 'rejected'}
              label="Reject candidate"
              onClick={() => onSetStatus('rejected')}
            />
            <CandidateDecisionButton
              intent="pending"
              isActive={candidate.status === 'pending'}
              label="Reset candidate to pending"
              onClick={() => onSetStatus('pending')}
            />
          </div>
        </div>

        <div className="candidate-meta-row">
          <details className="candidate-scores">
            <summary>scores</summary>
            <div className="candidate-scores-body">
              <span>
                change <strong className="info-text">{candidate.scene_score.toFixed(2)}</strong>
              </span>
              {candidate.score_breakdown ? (
                <>
                  <span>
                    visual <strong className="info-text">{candidate.score_breakdown.visual.toFixed(2)}</strong>
                  </span>
                  <span>
                    text <strong className="info-text">{candidate.score_breakdown.text.toFixed(2)}</strong>
                  </span>
                  <span>
                    motion <strong className="warning-text">{candidate.score_breakdown.motion.toFixed(2)}</strong>
                  </span>
                  <span>{candidate.score_breakdown.changed_regions.length} changed regions</span>
                </>
              ) : null}
              {typeof candidate.similarity_distance === 'number' && (
                <span>
                  similarity <strong className="warning-text">{candidate.similarity_distance.toFixed(2)}</strong>
                </span>
              )}
            </div>
          </details>
          <button className="candidate-annotation-toggle" onClick={onToggleAnnotation} type="button">
            {annotationToggleLabel}
          </button>
        </div>

        {similarLink && onJumpToSimilar && (
          <div className="candidate-secondary-row">
            <button
              className="inline-link-button candidate-similarity-link"
              onClick={onJumpToSimilar}
              title="Jump to the earlier matching scene."
              type="button"
            >
              {similarLink.label}
            </button>
          </div>
        )}

        {isAnnotationExpanded && (
          <div className="candidate-annotation-panel">
            <label className="candidate-field-group">
              <span>step title</span>
              <input
                className="candidate-field"
                onBlur={(event) => commitTextField('title', event.target.value)}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Optional custom label"
                value={title}
              />
            </label>

            <label className="candidate-field-group">
              <span>notes</span>
              <textarea
                className="candidate-field candidate-notes-field"
                onBlur={(event) => commitTextField('notes', event.target.value)}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Add observation, annotation note, or coding hint"
                value={notes}
              />
            </label>
          </div>
        )}
      </div>
    </article>
  );
}

export default App;
