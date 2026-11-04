import type { CSSProperties } from 'react';

/** Inline style that lets the shared slider style colour the part of the track before the thumb. */
export function rangeFillStyle(value: number, min: number, max: number): CSSProperties {
  const ratio = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return { '--range-fill': ratio.toFixed(4) } as CSSProperties;
}
