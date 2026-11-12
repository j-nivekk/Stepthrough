import type { AnalysisMetadata, RunSettings, RunSummary, SavedRunSettings } from '../types';
import {
  areStableSettingsEqual,
  defaultStableSettings,
  formatStableSummary,
  parseStablePresetFields,
  sanitizeStableSettings,
  serializeStablePresetLines,
  STABLE_PRESET_FIELDS,
} from './stableSettings';

// Where earlier versions kept saved settings in the browser; now they are saved with the account.
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

/** Settings saved in this browser by earlier versions, which kept them per browser rather than per account. */
export interface BrowserRunPresets {
  defaults: RunSettings | null;
  projects: { projectId: string; settings: RunSettings }[];
  keys: string[];
}

type StoredBrowserPreset = { version?: number; project_id?: string; settings?: RunSettings };

function readStoredPreset(key: string): StoredBrowserPreset | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as StoredBrowserPreset | null;
    return parsed && parsed.version === PRESET_STORAGE_VERSION && parsed.settings ? parsed : null;
  } catch {
    return null;
  }
}

/** What earlier versions saved in this browser, to move to the account; null if there is nothing. */
export function readBrowserRunPresets(): BrowserRunPresets | null {
  let keys: string[];
  try {
    keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index) ?? '');
  } catch {
    return null; // storage can be unavailable (private window, blocked site data)
  }
  keys = keys.filter((key) => key === GLOBAL_PRESET_STORAGE_KEY || key.startsWith(`${PROJECT_PRESET_STORAGE_KEY_PREFIX}.`));
  if (keys.length === 0) {
    return null;
  }
  const defaults = readStoredPreset(GLOBAL_PRESET_STORAGE_KEY)?.settings;
  const projects = keys.flatMap((key) => {
    const projectId = key.slice(PROJECT_PRESET_STORAGE_KEY_PREFIX.length + 1);
    const stored = key === GLOBAL_PRESET_STORAGE_KEY ? null : readStoredPreset(key);
    return stored?.settings && stored.project_id === projectId
      ? [{ projectId, settings: sanitizeRunSettings(stored.settings) }]
      : [];
  });
  return { defaults: defaults ? sanitizeRunSettings(defaults) : null, projects, keys };
}

export function forgetBrowserRunPresets(presets: BrowserRunPresets): void {
  try {
    presets.keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // nothing to forget when storage is unavailable
  }
}

/** The settings someone saved for a project, or as their own defaults (`projectId` null); null if none. */
export function findSavedRunSettings(saved: SavedRunSettings[], projectId: string | null): RunSettings | null {
  const match = saved.find((item) => item.project_id === projectId);
  return match ? sanitizeRunSettings(match.settings) : null;
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
