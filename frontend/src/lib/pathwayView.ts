/** How the pathway of a run is shown; kept per browser. */
import { defaultPathwayFigureOptions, type PathwayFigureOptions, type PathwayNotesPlacement } from './pathwayFigure';
import type { PathwayDetail } from '../types';

export interface PathwayView extends PathwayFigureOptions {
  detail: PathwayDetail;
  /** Scale of the figure on the page; `null` (the default) fits it to the width of the page. */
  zoom: number | null;
}

export const PATHWAY_ZOOM_MIN = 0.25;
export const PATHWAY_ZOOM_MAX = 1.5;

const STORAGE_KEY = 'stepthrough.pathway-view.v1';
const NOTES: PathwayNotesPlacement[] = ['under', 'key', 'hidden'];

export const defaultPathwayView: PathwayView = { ...defaultPathwayFigureOptions, detail: 'screens', zoom: null };

export function clampPathwayZoom(value: number): number {
  return Math.min(PATHWAY_ZOOM_MAX, Math.max(PATHWAY_ZOOM_MIN, Math.round(value * 100) / 100));
}

export function loadPathwayView(): PathwayView {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as Partial<PathwayView> | null) : null;
    if (!stored) return { ...defaultPathwayView };
    return {
      detail: stored.detail === 'steps' ? 'steps' : 'screens',
      notes: NOTES.includes(stored.notes as PathwayNotesPlacement) ? (stored.notes as PathwayNotesPlacement) : 'under',
      times: stored.times !== false,
      caption: stored.caption !== false,
      zoom: typeof stored.zoom === 'number' && Number.isFinite(stored.zoom) ? clampPathwayZoom(stored.zoom) : null,
    };
  } catch {
    return { ...defaultPathwayView };
  }
}

export function savePathwayView(view: PathwayView): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // storage can be unavailable (private window, blocked site data); the view still works for this visit
  }
}
