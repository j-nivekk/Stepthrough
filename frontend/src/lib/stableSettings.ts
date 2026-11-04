import type {
  AnalysisMetadata,
  IgnoreRegion,
  RecordingType,
  ScrollMode,
  StableRecordingTypeMetadata,
  StableSettings,
} from '../types';

/** Fallbacks when the backend metadata has not loaded yet; the backend values win once it has. */
const FALLBACK_RECORDING_TYPES: Record<RecordingType, StableRecordingTypeMetadata> = {
  phone: {
    label: 'phone or tablet',
    description: 'Touch-screen recordings. The status bar (clock, battery, recording indicator) is ignored.',
    min_dwell_ms: 450,
    min_change_percent: 0.1,
    ignore_status_bar: true,
  },
  desktop: {
    label: 'computer',
    description:
      'Desktop or browser recordings with a visible mouse pointer. Small changes such as the moving pointer are ignored.',
    min_dwell_ms: 600,
    min_change_percent: 0.25,
    ignore_status_bar: false,
  },
};

export const defaultStableSettings: StableSettings = {
  recording_type: 'phone',
  min_dwell_ms: null,
  min_change_percent: null,
  ignore_regions: [],
  ignore_status_bar: null,
  scroll_mode: 'each_stop',
  group_typing: true,
  include_opening_screen: true,
  enable_ocr: false,
  sensitivity: null,
  sample_fps: null,
};

export const STABLE_DEFAULT_SENSITIVITY = 4;
export const STABLE_DEFAULT_SAMPLE_FPS = 15;
export const STABLE_MAX_IGNORE_REGIONS = 16;

function finiteOrNull(value: unknown, min: number, max: number, digits = 0): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.min(max, Math.max(min, value));
  return digits ? Number(clamped.toFixed(digits)) : Math.round(clamped);
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

export function sanitizeIgnoreRegion(region: Partial<IgnoreRegion> | null | undefined): IgnoreRegion | null {
  if (!region) {
    return null;
  }
  const x = finiteOrNull(region.x, 0, 0.999, 4);
  const y = finiteOrNull(region.y, 0, 0.999, 4);
  const width = finiteOrNull(region.width, 0, 1, 4);
  const height = finiteOrNull(region.height, 0, 1, 4);
  if (x == null || y == null || !width || !height) {
    return null;
  }
  const clippedWidth = round4(Math.min(width, 1 - x));
  const clippedHeight = round4(Math.min(height, 1 - y));
  if (clippedWidth < 0.005 || clippedHeight < 0.005) {
    return null;
  }
  return { x, y, width: clippedWidth, height: clippedHeight };
}

export function sanitizeStableSettings(settings?: Partial<StableSettings> | null): StableSettings {
  const recordingType: RecordingType = settings?.recording_type === 'desktop' ? 'desktop' : 'phone';
  const scrollMode: ScrollMode = settings?.scroll_mode === 'merge' ? 'merge' : 'each_stop';
  const regions = Array.isArray(settings?.ignore_regions)
    ? settings.ignore_regions
        .map((region) => sanitizeIgnoreRegion(region))
        .filter((region): region is IgnoreRegion => region !== null)
        .slice(0, STABLE_MAX_IGNORE_REGIONS)
    : [];
  return {
    recording_type: recordingType,
    min_dwell_ms: finiteOrNull(settings?.min_dwell_ms, 100, 10_000),
    min_change_percent: finiteOrNull(settings?.min_change_percent, 0.01, 25, 2),
    ignore_regions: regions,
    ignore_status_bar: typeof settings?.ignore_status_bar === 'boolean' ? settings.ignore_status_bar : null,
    scroll_mode: scrollMode,
    group_typing: settings?.group_typing !== false,
    include_opening_screen: settings?.include_opening_screen !== false,
    enable_ocr: settings?.enable_ocr === true,
    sensitivity: finiteOrNull(settings?.sensitivity, 1, 20, 1),
    sample_fps: finiteOrNull(settings?.sample_fps, 2, 30),
  };
}

export function areStableSettingsEqual(
  left: StableSettings | null | undefined,
  right: StableSettings | null | undefined,
): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return JSON.stringify(sanitizeStableSettings(left)) === JSON.stringify(sanitizeStableSettings(right));
}

export function getRecordingTypeMetadata(
  analysisMetadata: AnalysisMetadata | null | undefined,
  recordingType: RecordingType,
): StableRecordingTypeMetadata {
  return analysisMetadata?.stable_recording_types?.[recordingType] ?? FALLBACK_RECORDING_TYPES[recordingType];
}

export interface EffectiveStableValues {
  minDwellMs: number;
  minChangePercent: number;
  ignoreStatusBar: boolean;
  sensitivity: number;
  sampleFps: number;
}

/** The values a run will use: the student's overrides, else the recording type's defaults. */
export function getEffectiveStableValues(
  stable: StableSettings,
  analysisMetadata: AnalysisMetadata | null | undefined,
): EffectiveStableValues {
  const defaults = getRecordingTypeMetadata(analysisMetadata, stable.recording_type);
  return {
    minDwellMs: stable.min_dwell_ms ?? defaults.min_dwell_ms,
    minChangePercent: stable.min_change_percent ?? defaults.min_change_percent,
    ignoreStatusBar: stable.ignore_status_bar ?? defaults.ignore_status_bar,
    sensitivity: stable.sensitivity ?? STABLE_DEFAULT_SENSITIVITY,
    sampleFps: stable.sample_fps ?? STABLE_DEFAULT_SAMPLE_FPS,
  };
}

/** Side of a square patch with the given share of the frame, in source pixels ("about 45 x 45 px"). */
export function describeChangeSize(percent: number, width?: number | null, height?: number | null): string {
  if (!width || !height) {
    return `${percent.toFixed(2)} % of the screen`;
  }
  const side = Math.max(1, Math.round(Math.sqrt((percent / 100) * width * height)));
  return `${percent.toFixed(2)} % of the screen, about a ${side} × ${side} px patch on this ${width} × ${height} recording`;
}

export function formatRecordingTypeLabel(recordingType: RecordingType): string {
  return recordingType === 'desktop' ? 'computer' : 'phone';
}

export function formatStableSummary(
  stable: StableSettings,
  analysisMetadata?: AnalysisMetadata | null,
): string[] {
  const values = getEffectiveStableValues(stable, analysisMetadata);
  return [
    formatRecordingTypeLabel(stable.recording_type),
    `${values.minDwellMs} ms`,
    `${values.minChangePercent.toFixed(2)} %`,
    stable.ignore_regions.length ? `${stable.ignore_regions.length} ignored` : null,
    stable.group_typing ? null : 'typing ungrouped',
    stable.scroll_mode === 'merge' ? 'scrolls merged' : null,
    stable.enable_ocr ? 'ocr on' : null,
  ].filter((part): part is string => Boolean(part));
}

function formatRegion(region: IgnoreRegion): string {
  return [region.x, region.y, region.width, region.height].map((value) => value.toFixed(3)).join(' ');
}

export function serializeStablePresetLines(stable: StableSettings): string[] {
  return [
    `recording type: ${stable.recording_type}`,
    `minimum time on screen: ${stable.min_dwell_ms ?? 'auto'} ms`,
    `smallest change: ${stable.min_change_percent ?? 'auto'} %`,
    `status bar: ${stable.ignore_status_bar == null ? 'auto' : stable.ignore_status_bar ? 'ignored' : 'included'}`,
    `ignore areas: ${stable.ignore_regions.length ? stable.ignore_regions.map(formatRegion).join('; ') : 'none'}`,
    `scrolling: ${stable.scroll_mode === 'merge' ? 'merge stops' : 'each stop'}`,
    `group typing: ${stable.group_typing ? 'on' : 'off'}`,
    `opening screen: ${stable.include_opening_screen ? 'on' : 'off'}`,
    `ocr: ${stable.enable_ocr ? 'on' : 'off'}`,
    `sensitivity: ${stable.sensitivity ?? 'auto'}`,
    `analysis fps: ${stable.sample_fps ?? 'auto'}`,
  ];
}

export const STABLE_PRESET_FIELDS = [
  'recording type',
  'minimum time on screen',
  'smallest change',
  'status bar',
  'ignore areas',
  'scrolling',
  'group typing',
  'opening screen',
  'ocr',
  'sensitivity',
  'analysis fps',
] as const;

function parseAutoNumber(value: string, unit: string): number | null | 'invalid' {
  const trimmed = value.replace(new RegExp(`\\s*${unit}$`, 'i'), '').trim();
  if (/^auto$/i.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 'invalid';
}

function parseOnOff(value: string): boolean | 'invalid' {
  if (/^on$/i.test(value)) return true;
  if (/^off$/i.test(value)) return false;
  return 'invalid';
}

/** Parse the stable engine's lines of preset text. Missing lines keep their defaults. */
export function parseStablePresetFields(fields: Map<string, string>): { error: string } | { stable: StableSettings } {
  const get = (label: string) => fields.get(label);
  const recordingType = get('recording type')?.toLowerCase() ?? 'phone';
  if (recordingType !== 'phone' && recordingType !== 'desktop') {
    return { error: 'Recording type must be phone or desktop.' };
  }
  const minDwell = parseAutoNumber(get('minimum time on screen') ?? 'auto', 'ms');
  if (minDwell === 'invalid') return { error: 'Minimum time on screen must be a number of ms or "auto".' };
  const minChange = parseAutoNumber(get('smallest change') ?? 'auto', '%');
  if (minChange === 'invalid') return { error: 'Smallest change must be a percentage or "auto".' };
  const statusBar = (get('status bar') ?? 'auto').toLowerCase();
  if (!['auto', 'ignored', 'included'].includes(statusBar)) {
    return { error: 'Status bar must be auto, ignored or included.' };
  }
  const areasValue = get('ignore areas') ?? 'none';
  const regions: IgnoreRegion[] = [];
  if (!/^none$/i.test(areasValue)) {
    for (const chunk of areasValue.split(';')) {
      const numbers = chunk.trim().split(/\s+/).map(Number);
      const region = numbers.length === 4 && numbers.every(Number.isFinite)
        ? sanitizeIgnoreRegion({ x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] })
        : null;
      if (!region) {
        return { error: 'Each ignore area needs four numbers between 0 and 1: x y width height.' };
      }
      regions.push(region);
    }
  }
  const scrolling = (get('scrolling') ?? 'each stop').toLowerCase();
  if (scrolling !== 'each stop' && scrolling !== 'merge stops') {
    return { error: 'Scrolling must be "each stop" or "merge stops".' };
  }
  const switches: Record<string, boolean> = {};
  for (const [label, fallback] of [['group typing', 'on'], ['opening screen', 'on'], ['ocr', 'off']] as const) {
    const parsed = parseOnOff(get(label) ?? fallback);
    if (parsed === 'invalid') return { error: `${label} must be on or off.` };
    switches[label] = parsed;
  }
  const sensitivity = parseAutoNumber(get('sensitivity') ?? 'auto', '');
  if (sensitivity === 'invalid') return { error: 'Sensitivity must be a number or "auto".' };
  const sampleFps = parseAutoNumber(get('analysis fps') ?? 'auto', '');
  if (sampleFps === 'invalid') return { error: 'Analysis fps must be a number or "auto".' };

  return {
    stable: sanitizeStableSettings({
      recording_type: recordingType,
      min_dwell_ms: minDwell,
      min_change_percent: minChange,
      ignore_status_bar: statusBar === 'auto' ? null : statusBar === 'ignored',
      ignore_regions: regions,
      scroll_mode: scrolling === 'merge stops' ? 'merge' : 'each_stop',
      group_typing: switches['group typing'],
      include_opening_screen: switches['opening screen'],
      enable_ocr: switches.ocr,
      sensitivity,
      sample_fps: sampleFps,
    }),
  };
}

/** Same rule as the backend: the share of the frame a phone or tablet status bar covers. */
export function statusBarShare(width: number | null | undefined, height: number | null | undefined): number {
  if (!width || !height) return 0;
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (height > width) return aspect >= 1.7 ? 0.06 : 0.025;
  return aspect >= 1.7 ? 0 : 0.032;
}
