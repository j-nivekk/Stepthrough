/** How the steps of a run are laid out for review; kept per browser. */

export type StepView = 'grid' | 'list';

export interface StepLayout {
  view: StepView;
  /**
   * Image size: the side of a square with the same area as a step's screenshot, in px. `null` (the default) fits
   * the cards to the width of the page instead: as many columns as fit at about the default size, stretched to fill.
   */
  size: number | null;
  /** The strip of accepted steps above the timeline is folded away. */
  hideAccepted: boolean;
}

export const STEP_SIZE_MIN = 120;
export const STEP_SIZE_MAX = 420;
export const STEP_SIZE_DEFAULT = 240;
/** Space between cards in the grid; the same as `.candidate-grid`'s gap. */
const GRID_GAP = 16;
/** Narrowest card that still fits the time, the select box and the accept / reject buttons. */
const CARD_MIN_WIDTH = 124;
/** List thumbnails are this share of the grid size, so one slider sets both. */
const LIST_THUMB_SCALE = 0.3;

const STORAGE_KEY = 'stepthrough.step-layout.v2';
/** Earlier versions always stored a size, so only the grid / list choice carries over: everyone starts fitted. */
const LEGACY_STORAGE_KEY = 'stepthrough.step-layout.v1';

export const defaultStepLayout: StepLayout = { view: 'grid', size: null, hideAccepted: false };

export function clampStepSize(value: number): number {
  return Math.min(STEP_SIZE_MAX, Math.max(STEP_SIZE_MIN, Math.round(value)));
}

function readStored(key: string): Partial<StepLayout> | null {
  const raw = window.localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as Partial<StepLayout> | null) : null;
}

export function loadStepLayout(): StepLayout {
  try {
    const stored = readStored(STORAGE_KEY);
    const view = (stored ?? readStored(LEGACY_STORAGE_KEY))?.view === 'list' ? 'list' : 'grid';
    const size = typeof stored?.size === 'number' && Number.isFinite(stored.size) ? clampStepSize(stored.size) : null;
    return { view, size, hideAccepted: stored?.hideAccepted === true };
  } catch {
    return { ...defaultStepLayout };
  }
}

export function saveStepLayout(layout: StepLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
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

export interface FittedStepGrid {
  columns: number;
  /** Width of each card, px. */
  cardWidth: number;
  /** The size (as on the slider) that gives cards this wide. */
  size: number;
}

/**
 * Cards that fill `availableWidth` exactly: the number of columns closest to what fits at the default size, so
 * cards come out a little larger or smaller than the default rather than leaving a gap at the right.
 */
export function fitStepGrid(availableWidth: number, aspect: number): FittedStepGrid {
  const target = stepImageBox(STEP_SIZE_DEFAULT, aspect).width;
  let columns = Math.max(1, Math.round((availableWidth + GRID_GAP) / (target + GRID_GAP)));
  const widthFor = (count: number) => (availableWidth - GRID_GAP * (count - 1)) / count;
  while (columns > 1 && widthFor(columns) < CARD_MIN_WIDTH) columns -= 1;
  const cardWidth = Math.max(CARD_MIN_WIDTH, widthFor(columns));
  return { columns, cardWidth, size: cardWidth / Math.sqrt(aspect) };
}
