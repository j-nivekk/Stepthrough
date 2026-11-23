import { absoluteApiUrl } from '../api';

// The page shows screenshots far smaller than they were taken (a desktop recording's are about 3248 pixels wide
// and 1.2 MB): the pathway's boxes, the step cards, the gallery's filmstrip, menus. The server hands out copies of
// a few set widths (backend/app/thumbnails.py, `?w=`), so the page asks for the smallest that is still sharp at the
// size it draws the screenshot, on this screen. Close-ups use the screenshot itself.

/** The widths the server makes copies at, as in backend/app/thumbnails.py. */
export const SCREENSHOT_WIDTHS = [320, 640, 1280] as const;

function pixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

/**
 * The width of copy to ask for, to draw a screenshot `width` CSS pixels wide (or `ratio` times that many device
 * pixels; the screen's own ratio, at least 1, when left out); null when only the screenshot itself is wide enough.
 */
export function screenshotWidth(width: number, ratio = pixelRatio()): number | null {
  const needed = width * Math.max(1, ratio);
  return SCREENSHOT_WIDTHS.find((copy) => copy >= needed) ?? null;
}

/** The address of a screenshot (its `image_url`) to draw `width` CSS pixels wide; the screenshot itself without a width. */
export function screenshotUrl(imageUrl: string, width?: number | null, ratio?: number): string {
  const url = absoluteApiUrl(imageUrl);
  const copy = width ? screenshotWidth(width, ratio) : null;
  return copy ? `${url}${url.includes('?') ? '&' : '?'}w=${copy}` : url;
}
