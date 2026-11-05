import type { AnalysisMetadata, GlobalRunPreset, ProjectRunPreset, RunSettings, RunSummary } from '../types';
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

export const defaultRunSettings: RunSettings = {
  analysis_engine: 'stable_v3',
  stable: defaultStableSettings,
};

/** Settings for a new run; anything missing or unreadable falls back to the defaults. */
export function sanitizeRunSettings(settings?: { stable?: unknown } | null): RunSettings {
  return {
    analysis_engine: 'stable_v3',
    stable: sanitizeStableSettings((settings?.stable ?? null) as Parameters<typeof sanitizeStableSettings>[0]),
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

export function areRunSettingsEqual(left: RunSettings, right: RunSettings): boolean {
  return areStableSettingsEqual(left.stable, right.stable);
}

/** One line describing the settings a run was made with. */
export function formatRunSummaryLabel(run: Pick<RunSummary, 'stable'>, analysisMetadata?: AnalysisMetadata | null): string {
  return formatStableSummary(run.stable ?? defaultStableSettings, analysisMetadata).join(' · ');
}

export function serializeRunPresetText(settings: RunSettings): string {
  return ['stepthrough detection preset', ...serializeStablePresetLines(settings.stable ?? defaultStableSettings)].join('\n');
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

  const stableFields = new Map<string, string>();
  const allowed = new Set<string>(STABLE_PRESET_FIELDS);
  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      return { error: `Couldn't parse "${line}". Use "Label: Value" lines.` };
    }
    const label = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (label === 'engine') {
      continue; // preset text copied before the engine line was dropped
    }
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
