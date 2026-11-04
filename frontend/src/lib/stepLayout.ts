/** How the steps of a run are laid out for review; kept per browser. */

export type StepView = 'grid' | 'list';

export interface StepLayout {
  view: StepView;
  /** Image size: the side of a square with the same area as a step's screenshot, in px. */
  size: number;
}

export const STEP_SIZE_MIN = 120;
export const STEP_SIZE_MAX = 420;
export const STEP_SIZE_DEFAULT = 240;
/** Narrowest card that still fits the time, the select box and the accept / reject buttons. */
const CARD_MIN_WIDTH = 124;
/** List thumbnails are this share of the grid size, so one slider sets both. */
const LIST_THUMB_SCALE = 0.3;

const STORAGE_KEY = 'stepthrough.step-layout.v1';

export const defaultStepLayout: StepLayout = { view: 'grid', size: STEP_SIZE_DEFAULT };

function clampSize(value: number): number {
  return Math.min(STEP_SIZE_MAX, Math.max(STEP_SIZE_MIN, Math.round(value)));
}

export function loadStepLayout(): StepLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultStepLayout };
    const parsed = JSON.parse(raw) as Partial<StepLayout> | null;
    return {
      view: parsed?.view === 'list' ? 'list' : 'grid',
      size: typeof parsed?.size === 'number' && Number.isFinite(parsed.size) ? clampSize(parsed.size) : STEP_SIZE_DEFAULT,
    };
  } catch {
    return { ...defaultStepLayout };
  }
}

export function saveStepLayout(layout: StepLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // storage can be unavailable (private window, blocked site data); the layout still works for this visit
  }
}

export function recordingAspect(width?: number | null, height?: number | null): number {
  return width && height && width > 0 && height > 0 ? width / height : 16 / 10;
}

/**
 * Screenshot box for a size. Sizing by area rather than width keeps portrait and landscape recordings
 * equally readable at the same slider position: a phone screen gets a narrow, tall box, a desktop a wide one.
 */
export function stepImageBox(size: number, aspect: number): { width: number; height: number } {
  const width = Math.max(CARD_MIN_WIDTH, Math.round(size * Math.sqrt(aspect)));
  return { width, height: Math.round(width / aspect) };
}

export function stepThumbBox(size: number, aspect: number): { width: number; height: number } {
  const side = size * LIST_THUMB_SCALE;
  const width = Math.round(side * Math.sqrt(aspect));
  return { width, height: Math.round(width / aspect) };
}
