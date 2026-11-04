import type {
  AnalysisEngine,
  AnalysisMetadata,
  AnalysisPreset,
  GlobalRunPreset,
  ProjectRunPreset,
  RunSettings,
  RunSummary,
} from '../types';
import {
  areStableSettingsEqual,
  defaultStableSettings,
  formatStableSummary,
  parseStablePresetFields,
  sanitizeStableSettings,
  serializeStablePresetLines,
  STABLE_PRESET_FIELDS,
} from './stableSettings';

const PRESET_STORAGE_VERSION = 1;
const GLOBAL_PRESET_STORAGE_KEY = 'stepthrough.run-preset.global.v1';
const PROJECT_PRESET_STORAGE_KEY_PREFIX = 'stepthrough.run-preset.project.v1';

// Engines whose earlier runs can still be opened, reviewed and exported, but not started again.
const RETIRED_ENGINES: Partial<Record<AnalysisEngine, string>> = { hybrid_v2: 'hybrid v2', scene_v1: 'v1' };

export const defaultRunSettings: RunSettings = {
  analysis_engine: 'stable_v3',
  stable: defaultStableSettings,
};

/** Settings for a new run. Presets saved for a retired engine fall back to the stable-screen defaults. */
export function sanitizeRunSettings(settings?: { analysis_engine?: string; stable?: unknown } | null): RunSettings {
  const stable = settings?.analysis_engine === 'stable_v3' ? settings.stable : null;
  return {
    analysis_engine: 'stable_v3',
    stable: sanitizeStableSettings(stable as Parameters<typeof sanitizeStableSettings>[0]),
  };
}

export function enforceLocalOcrAvailability(
  settings: RunSettings,
  ocrAvailable: boolean | null | undefined,
): RunSettings {
  if (ocrAvailable !== false || !settings.stable.enable_ocr) {
    return settings;
  }
  return { ...settings, stable: { ...settings.stable, enable_ocr: false } };
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

function writeStoredJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage can be unavailable (private window, blocked site data); the preset still applies for this visit
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
  writeStoredJson(GLOBAL_PRESET_STORAGE_KEY, preset);
  return preset;
}

export function persistProjectRunPreset(projectId: string, settings: RunSettings): ProjectRunPreset {
  const preset: ProjectRunPreset = {
    version: PRESET_STORAGE_VERSION,
    project_id: projectId,
    settings: sanitizeRunSettings(settings),
    saved_at: new Date().toISOString(),
  };
  writeStoredJson(getProjectPresetStorageKey(projectId), preset);
  return preset;
}

export function formatAnalysisEngineLabel(engine: AnalysisEngine): string {
  const retired = RETIRED_ENGINES[engine];
  return retired ? `${retired} (retired)` : 'stable screens';
}

/** Preset names of the retired hybrid v2 engine, shown on its earlier runs. */
export function formatAnalysisPresetLabel(preset: AnalysisPreset): string {
  if (preset === 'subtle_ui') return 'subtle ui';
  if (preset === 'noise_resistant') return 'ignore noise';
  return 'balanced';
}

export function areRunSettingsEqual(left: RunSettings, right: RunSettings): boolean {
  return areStableSettingsEqual(left.stable, right.stable);
}

export function formatRunSettingsSummary(settings: RunSettings, analysisMetadata?: AnalysisMetadata | null): string {
  return [formatAnalysisEngineLabel(settings.analysis_engine), ...formatStableSummary(settings.stable, analysisMetadata)].join(
    ' · ',
  );
}

/** One line describing how any run was made, including runs of the retired engines. */
export function formatRunSummaryLabel(
  run: Pick<RunSummary, 'analysis_engine' | 'analysis_preset' | 'stable' | 'detector_mode' | 'tolerance'> & {
    engine_version?: string | null;
  },
  analysisMetadata?: AnalysisMetadata | null,
  { withVersion = false }: { withVersion?: boolean } = {},
): string {
  const engine = formatAnalysisEngineLabel(run.analysis_engine);
  if (run.analysis_engine === 'stable_v3') {
    return [engine, ...formatStableSummary(run.stable ?? defaultStableSettings, analysisMetadata), withVersion ? run.engine_version : null]
      .filter(Boolean)
      .join(' · ');
  }
  if (run.analysis_engine === 'hybrid_v2') {
    return `${engine} · ${formatAnalysisPresetLabel(run.analysis_preset)}`;
  }
  return `${engine} · ${run.detector_mode} · tolerance ${run.tolerance}`;
}

export function serializeRunPresetText(settings: RunSettings): string {
  return ['stepthrough detection preset', 'engine: stable_v3', ...serializeStablePresetLines(settings.stable ?? defaultStableSettings)].join(
    '\n',
  );
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
    normalizedLines[0]?.toLowerCase() === 'stepthrough detection preset' ? normalizedLines.slice(1) : normalizedLines;

  const engineLine = lines.find((line) => /^engine\s*:/i.test(line));
  const engineValue = engineLine?.slice(engineLine.indexOf(':') + 1).trim().toLowerCase();
  if (engineValue && engineValue !== 'stable_v3') {
    const retired = RETIRED_ENGINES[engineValue as AnalysisEngine];
    return {
      error: retired
        ? `This preset is for the ${retired} engine, which has been retired. Set the stable-screen values here instead.`
        : 'Engine must be stable_v3.',
    };
  }

  const stableFields = new Map<string, string>();
  const allowed = new Set<string>(['engine', ...STABLE_PRESET_FIELDS]);
  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      return { error: `Couldn't parse "${line}". Use "Label: Value" lines.` };
    }
    const label = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!allowed.has(label)) {
      return { error: `Couldn't parse "${line}".` };
    }
    if (!value) {
      return { error: `Add a value for "${label}".` };
    }
    stableFields.set(label, value);
  }
  const parsed = parseStablePresetFields(stableFields);
  if ('error' in parsed) {
    return parsed;
  }
  return { settings: { analysis_engine: 'stable_v3', stable: sanitizeStableSettings(parsed.stable) } };
}
