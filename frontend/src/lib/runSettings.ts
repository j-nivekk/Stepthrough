import type { GlobalRunPreset, HybridAdvancedSettings, ProjectRunPreset, RunSettings } from '../types';
import { clampInteger } from './utils';

export const defaultRunSettings: RunSettings = {
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

export const defaultHybridAdvancedSettings: HybridAdvancedSettings = {
  sample_fps_override: null,
  min_dwell_ms: null,
  settle_window_ms: null,
  enable_ocr: true,
  ocr_backend: 'paddleocr',
};

const contentThresholdRange: [number, number] = [8, 48];
const adaptiveThresholdRange: [number, number] = [1, 7];
const PRESET_STORAGE_VERSION = 1;
const GLOBAL_PRESET_STORAGE_KEY = 'stepthrough.run-preset.global.v1';
const PROJECT_PRESET_STORAGE_KEY_PREFIX = 'stepthrough.run-preset.project.v1';

export const analysisPresetDefaults = {
  subtle_ui: { minDwellMs: 250, sampleFps: 8, settleWindowMs: 250 },
  balanced: { minDwellMs: 400, sampleFps: 6, settleWindowMs: 400 },
  noise_resistant: { minDwellMs: 700, sampleFps: 4, settleWindowMs: 700 },
} as const;

export function sanitizeRunSettings(settings?: Partial<RunSettings> | null): RunSettings {
  const analysisEngine = settings?.analysis_engine === 'hybrid_v2' ? 'hybrid_v2' : 'scene_v1';
  const analysisPreset =
    settings?.analysis_preset === 'subtle_ui' ||
    settings?.analysis_preset === 'noise_resistant' ||
    settings?.analysis_preset === 'balanced'
      ? settings.analysis_preset
      : defaultRunSettings.analysis_preset;
  const advanced: HybridAdvancedSettings | null = settings?.advanced
    ? {
        sample_fps_override:
          typeof settings.advanced.sample_fps_override === 'number' &&
          Number.isFinite(settings.advanced.sample_fps_override)
            ? Math.max(1, Math.round(settings.advanced.sample_fps_override))
            : null,
        min_dwell_ms:
          typeof settings.advanced.min_dwell_ms === 'number' && Number.isFinite(settings.advanced.min_dwell_ms)
            ? Math.max(0, Math.round(settings.advanced.min_dwell_ms))
            : null,
        settle_window_ms:
          typeof settings.advanced.settle_window_ms === 'number' &&
          Number.isFinite(settings.advanced.settle_window_ms)
            ? Math.max(0, Math.round(settings.advanced.settle_window_ms))
            : null,
        enable_ocr: settings.advanced.enable_ocr !== false,
        ocr_backend: settings.advanced.enable_ocr === false ? null : 'paddleocr',
      }
    : null;
  const tolerance =
    typeof settings?.tolerance === 'number'
      ? Math.min(100, Math.max(1, Math.round(settings.tolerance)))
      : defaultRunSettings.tolerance;
  const minSceneGap =
    typeof settings?.min_scene_gap_ms === 'number'
      ? Math.max(0, Math.round(settings.min_scene_gap_ms))
      : defaultRunSettings.min_scene_gap_ms;
  const sampleFps =
    typeof settings?.sample_fps === 'number' && Number.isFinite(settings.sample_fps) && settings.sample_fps > 0
      ? Math.max(1, Math.round(settings.sample_fps))
      : null;
  const allowHighFpsSampling = settings?.allow_high_fps_sampling === true;
  const detectorMode = settings?.detector_mode === 'adaptive' ? 'adaptive' : 'content';
  const extractOffset =
    typeof settings?.extract_offset_ms === 'number'
      ? Math.max(0, Math.round(settings.extract_offset_ms))
      : defaultRunSettings.extract_offset_ms;

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

export function enforceLocalOcrAvailability(
  settings: RunSettings,
  ocrAvailable: boolean | null | undefined,
): RunSettings {
  if (ocrAvailable !== false || settings.analysis_engine !== 'hybrid_v2') {
    return settings;
  }
  const advanced = settings.advanced ?? { ...defaultHybridAdvancedSettings };
  if (advanced.enable_ocr === false && advanced.ocr_backend === null) {
    return settings;
  }
  return {
    ...settings,
    advanced: {
      ...advanced,
      enable_ocr: false,
      ocr_backend: null,
    },
  };
}

export function getProjectPresetStorageKey(projectId: string): string {
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

export function loadGlobalRunPreset(): GlobalRunPreset | null {
  const stored = readStoredJson<GlobalRunPreset>(GLOBAL_PRESET_STORAGE_KEY);
  if (!stored || stored.version !== PRESET_STORAGE_VERSION) {
    return null;
  }
  return {
    ...stored,
    settings: sanitizeRunSettings(stored.settings),
  };
}

export function loadProjectRunPreset(projectId: string): ProjectRunPreset | null {
  const stored = readStoredJson<ProjectRunPreset>(getProjectPresetStorageKey(projectId));
  if (!stored || stored.version !== PRESET_STORAGE_VERSION || stored.project_id !== projectId) {
    return null;
  }
  return {
    ...stored,
    settings: sanitizeRunSettings(stored.settings),
  };
}

export function persistGlobalRunPreset(settings: RunSettings): GlobalRunPreset {
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

export function persistProjectRunPreset(projectId: string, settings: RunSettings): ProjectRunPreset {
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

export function formatDetectorModeLabel(mode: RunSettings['detector_mode']): string {
  return mode === 'adaptive' ? 'adaptive' : 'content';
}

export function formatAnalysisEngineLabel(engine: RunSettings['analysis_engine']): string {
  return engine === 'hybrid_v2' ? 'hybrid v2' : 'current v1';
}

export function formatAnalysisPresetLabel(preset: RunSettings['analysis_preset']): string {
  if (preset === 'subtle_ui') return 'subtle ui';
  if (preset === 'noise_resistant') return 'ignore noise';
  return 'balanced';
}

export function mapToleranceToDetectorThreshold(
  tolerance: number,
  detectorMode: RunSettings['detector_mode'],
): number {
  const [floor, ceiling] = detectorMode === 'adaptive' ? adaptiveThresholdRange : contentThresholdRange;
  const normalized = (Math.min(100, Math.max(1, tolerance)) - 1) / 99;
  return Number((floor + (ceiling - floor) * normalized).toFixed(2));
}

export function describeTolerance(
  tolerance: number,
  detectorMode: RunSettings['detector_mode'],
): string {
  const threshold = mapToleranceToDetectorThreshold(tolerance, detectorMode);
  const thresholdLabel =
    detectorMode === 'adaptive' ? `adaptive threshold ${threshold}.` : `content threshold ${threshold}.`;

  if (tolerance <= 25) {
    return `${thresholdLabel} very sensitive. lower it when keyboard states, small badges, or brief sheets are being missed. raise sample fps first if very short screens are slipping through.`;
  }
  if (tolerance <= 60) {
    return `${thresholdLabel} balanced for most walkthrough recordings. lower it to catch subtler screens, or raise it if typing, scrolling, or background shimmer creates noise.`;
  }
  return `${thresholdLabel} conservative. raise it when scrolling or tiny motion creates too many candidates, and lower it if real screens are being missed.`;
}

export function describeSampleFps(sampleFps: number | null, sourceFps: number | null): string {
  if (!sampleFps) {
    return 'sampling every available frame from the source video. use this only when you need maximum sensitivity or source-fps coverage.';
  }
  let skipText = '';
  if (sourceFps) {
    const skip = Math.max(1, Math.round(sourceFps / sampleFps));
    skipText = skip > 1 ? ` (~every ${skip}th frame)` : ' (~every frame)';
  }
  return `sampling ~${sampleFps} fps from the source video${skipText}. raise this when brief overlays, menus, or quick transitions are being missed.`;
}

export function describeDetectorMode(mode: RunSettings['detector_mode']): string {
  if (mode === 'adaptive') {
    return 'compares against a rolling average of recent frames. better for fades, overlays, and softer ui changes. adaptive threshold scales from 1 to 7.';
  }
  return 'strictly compares against the immediately previous sampled frame. better for cuts and hard screen swaps. content threshold scales from 8 to 48.';
}

export function describeAnalysisPreset(settings: RunSettings): string {
  const presetDefaults = analysisPresetDefaults[settings.analysis_preset];
  const overrideFps = settings.advanced?.sample_fps_override;
  const overrideDwell = settings.advanced?.min_dwell_ms;
  const overrideSettle = settings.advanced?.settle_window_ms;
  const sampleFps = overrideFps ?? presetDefaults.sampleFps;
  const dwell = overrideDwell ?? presetDefaults.minDwellMs;
  const settle = overrideSettle ?? presetDefaults.settleWindowMs;
  const ocrCopy =
    settings.advanced?.enable_ocr === false
      ? 'ocr confirmation disabled.'
      : 'ocr confirmation enabled, with backend-configured paddleocr for strong visual changes and bounded probes on localized changed regions.';
  return `${formatAnalysisPresetLabel(settings.analysis_preset)} samples around ${sampleFps} fps, waits ~${dwell}ms for dwell and ~${settle}ms for settle windows. ${ocrCopy}`;
}

export function describeMinSceneGap(minSceneGapMs: number): string {
  if (minSceneGapMs === 0) {
    return '0ms removes the hard time gap between emitted candidates and lets hybrid detections cluster tightly on the timeline.';
  }
  const seconds = (minSceneGapMs / 1000).toFixed(1).replace(/\.0$/, '');
  return `${minSceneGapMs}ms (~${seconds}s) on the original timeline. this is the minimum spacing allowed between emitted candidates; in hybrid v2 it is enforced after event windows finalize, not by freezing detection.`;
}

export function describeExtractOffset(offsetMs: number): string {
  if (offsetMs === 0) {
    return 'captures exactly on the first detected frame of a new scene candidate.';
  }
  const seconds = (offsetMs / 1000).toFixed(1).replace(/\.0$/, '');
  return `captures ${offsetMs}ms (${seconds}s) after the detection cut to avoid grabbing a frame mid-animation or during a transition.`;
}

function formatHybridOcrState(
  enableOcr: boolean | undefined,
  ocrBackend: HybridAdvancedSettings['ocr_backend'] | null | undefined,
): string {
  if (enableOcr === false) {
    return 'off';
  }
  return `on (${ocrBackend === 'paddleocr' || !ocrBackend ? 'paddleocr' : ocrBackend})`;
}

export function describeHybridSampleFpsOverrideHint(settings: RunSettings): string {
  const presetSampleFps = analysisPresetDefaults[settings.analysis_preset].sampleFps;
  return `overrides the preset sampling rate. raise it when brief overlays or menu states are being missed, and leave it on auto to keep the preset baseline of ${presetSampleFps} fps.`;
}

export function describeHybridMinDwellHint(settings: RunSettings): string {
  const presetMinDwellMs = analysisPresetDefaults[settings.analysis_preset].minDwellMs;
  return `overrides how long a visual change must persist before it becomes a candidate. lower it for brief states, or raise it to ignore flicker and transient motion. preset baseline: ${presetMinDwellMs}ms.`;
}

export function describeHybridSettleWindowHint(settings: RunSettings): string {
  const presetSettleWindowMs = analysisPresetDefaults[settings.analysis_preset].settleWindowMs;
  return `overrides how long the detector waits for motion to settle before capturing the representative frame. raise it for longer animations or loading states, and lower it when captures land too late. preset baseline: ${presetSettleWindowMs}ms.`;
}

export function describeHybridOcrConfirmationHint(): string {
  return 'ocr is configured by the backend environment. when available, hybrid uses paddleocr for strong visual changes and bounded probes on localized changed regions. first use may initialize models in the backend cache, or rely on backend-provided local model directories. preset baseline: on (paddleocr).';
}

export function formatHybridSampleFpsAnnotation(settings: RunSettings): string {
  const presetSampleFps = analysisPresetDefaults[settings.analysis_preset].sampleFps;
  const overrideSampleFps = settings.advanced?.sample_fps_override;
  return overrideSampleFps == null
    ? `preset: ${presetSampleFps} fps. current: auto, using the preset value.`
    : `preset: ${presetSampleFps} fps. current override: ${overrideSampleFps} fps.`;
}

export function formatHybridMinDwellAnnotation(settings: RunSettings): string {
  const presetMinDwellMs = analysisPresetDefaults[settings.analysis_preset].minDwellMs;
  const overrideMinDwellMs = settings.advanced?.min_dwell_ms;
  return overrideMinDwellMs == null
    ? `preset: ${presetMinDwellMs}ms. current: auto, using the preset value.`
    : `preset: ${presetMinDwellMs}ms. current override: ${overrideMinDwellMs}ms.`;
}

export function formatHybridSettleWindowAnnotation(settings: RunSettings): string {
  const presetSettleWindowMs = analysisPresetDefaults[settings.analysis_preset].settleWindowMs;
  const overrideSettleWindowMs = settings.advanced?.settle_window_ms;
  return overrideSettleWindowMs == null
    ? `preset: ${presetSettleWindowMs}ms. current: auto, using the preset value.`
    : `preset: ${presetSettleWindowMs}ms. current override: ${overrideSettleWindowMs}ms.`;
}

export function formatHybridOcrAnnotation(settings: RunSettings): string {
  const currentOcrState = formatHybridOcrState(settings.advanced?.enable_ocr, settings.advanced?.ocr_backend);
  return `preset: on (paddleocr). current: ${currentOcrState}. availability, model source, and local model paths are controlled by the backend.`;
}

export function getSampleFpsGuardrail(
  recordingFps: number | null | undefined,
  allowHighFpsSampling: boolean,
) {
  const sourceCeiling = Math.max(1, Math.ceil(recordingFps && Number.isFinite(recordingFps) ? recordingFps : 30));
  const cappedMax = Math.min(30, sourceCeiling);
  return {
    isHighFpsRecording: sourceCeiling > 30,
    maxSampleFps: allowHighFpsSampling ? sourceCeiling : cappedMax,
    sourceFpsAvailable: sourceCeiling <= 30 || allowHighFpsSampling,
    sourceFpsCeiling: sourceCeiling,
  };
}

export function clampRunSettingsForRecording(
  settings: RunSettings,
  recordingFps: number | null | undefined,
): RunSettings {
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

export function areRunSettingsEqual(left: RunSettings, right: RunSettings): boolean {
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

export function formatRunSettingsSummary(settings: RunSettings): string {
  if (settings.analysis_engine === 'hybrid_v2') {
    const sampleFps =
      settings.advanced?.sample_fps_override ?? analysisPresetDefaults[settings.analysis_preset].sampleFps;
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

export function serializeRunPresetText(settings: RunSettings): string {
  return [
    'stepthrough detection preset',
    `engine: ${settings.analysis_engine}`,
    `preset: ${settings.analysis_preset}`,
    `hybrid sample fps override: ${settings.advanced?.sample_fps_override ?? 'auto'}`,
    `hybrid min dwell: ${settings.advanced?.min_dwell_ms ?? 'auto'} ms`,
    `hybrid settle window: ${settings.advanced?.settle_window_ms ?? 'auto'} ms`,
    `hybrid ocr: ${settings.advanced?.enable_ocr === false ? 'disabled' : 'enabled'}`,
    `mode: ${formatDetectorModeLabel(settings.detector_mode)}`,
    `tolerance: ${settings.tolerance}`,
    `min scene gap: ${settings.min_scene_gap_ms} ms`,
    `sample fps: ${settings.sample_fps ?? 'source stream'}`,
    `high-fps sampling: ${settings.allow_high_fps_sampling ? 'enabled' : 'disabled'}`,
    `extract offset: ${settings.extract_offset_ms} ms`,
  ].join('\n');
}

export function parseRunPresetText(rawText: string): { error: string } | { settings: RunSettings } {
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
              sample_fps_override: /^auto$/i.test(hybridSampleFpsValue)
                ? null
                : Number.parseInt(hybridSampleFpsValue, 10),
              min_dwell_ms: /^auto\s*ms$/i.test(hybridMinDwellValue)
                ? null
                : Number.parseInt(hybridMinDwellValue, 10),
              settle_window_ms: /^auto\s*ms$/i.test(hybridSettleValue)
                ? null
                : Number.parseInt(hybridSettleValue, 10),
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
