const PREFS_KEY = 'stepthrough.app-prefs.v1';
const PREFS_VERSION = 1;

export interface AppPreferences {
  enableV1Engine: boolean;
  showPerfMonitor: boolean;
}

export const defaultAppPreferences: AppPreferences = {
  enableV1Engine: true,
  showPerfMonitor: false,
};

export function loadAppPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...defaultAppPreferences };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed['version'] !== PREFS_VERSION) {
      return { ...defaultAppPreferences };
    }
    return {
      enableV1Engine: parsed['enableV1Engine'] !== false,
      showPerfMonitor: parsed['showPerfMonitor'] === true,
    };
  } catch {
    return { ...defaultAppPreferences };
  }
}

export function saveAppPreferences(prefs: AppPreferences): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ version: PREFS_VERSION, ...prefs }));
  } catch {
    // ignore storage errors
  }
}
