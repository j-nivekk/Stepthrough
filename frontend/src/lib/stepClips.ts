import type { CandidateFrame } from '../types';

/** How long the pointer must rest on a screenshot before its clip plays and "play from here" appears. */
export const HOVER_INTENT_MS = 400;

const LEAD_IN_MS = 300;
const MIN_CLIP_MS = 600;
const FALLBACK_CLIP_MS = 1000;
const TARGET_CLIP_MS = 3000;
const MAX_CLIP_RATE = 4;

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface StepClip {
  startMs: number;
  endMs: number;
  /** Long changes (a typing burst) play faster so the clip lasts about three seconds. */
  rate: number;
}

/**
 * The stretch of the recording that leads into a step: from just before its change started to the
 * moment its screenshot was taken, so the clip ends on the frame the card shows. Steps that do not
 * store when their change started (manual steps, runs of the retired engines) get the second before.
 */
export function stepClip(candidate: CandidateFrame): StepClip {
  const endMs = Math.max(0, candidate.timestamp_ms);
  const breakdown = candidate.score_breakdown;
  let startMs = endMs - FALLBACK_CLIP_MS;
  if (breakdown?.transition_type === 'opening_screen') {
    startMs = 0;
  } else if (finite(breakdown?.event_start_ms) && breakdown.event_start_ms > 0 && breakdown.event_start_ms < endMs) {
    startMs = breakdown.event_start_ms - LEAD_IN_MS;
  }
  startMs = Math.max(0, Math.min(startMs, endMs - MIN_CLIP_MS));
  const lengthMs = endMs - startMs;
  const rate = lengthMs > TARGET_CLIP_MS ? Math.min(MAX_CLIP_RATE, lengthMs / TARGET_CLIP_MS) : 1;
  return { startMs, endMs, rate };
}

export interface PlaybackWindow {
  id: string;
  /** When the step's screen is on screen. */
  startMs: number;
  endMs: number;
  /** Fade in before and out after, in ms. */
  marginMs: number;
}

/**
 * When each step is on screen during playback. A stable-screen step is on screen from the moment it
 * settled until the next change; other steps get half a second either side of their screenshot. The
 * fade margin scales with the recording's length (1 %, between 0.3 and 1.5 s) and shrinks to half the
 * gap to the neighbouring steps, so close steps hand over quickly and isolated ones fade gently.
 */
export function playbackWindows(candidates: CandidateFrame[], durationMs: number): PlaybackWindow[] {
  const intervals = candidates
    .map((candidate) => {
      const breakdown = candidate.score_breakdown;
      const settled = breakdown?.event_end_ms;
      const onScreen = breakdown?.dwell_after_ms;
      if (finite(settled) && finite(onScreen) && breakdown?.grouped_states != null) {
        return { id: candidate.id, startMs: settled, endMs: settled + Math.max(0, onScreen) };
      }
      return { id: candidate.id, startMs: candidate.timestamp_ms - 500, endMs: candidate.timestamp_ms + 500 };
    })
    .sort((left, right) => left.startMs - right.startMs);

  const baseMargin = Math.min(1500, Math.max(300, durationMs * 0.01));
  return intervals.map((interval, index) => {
    const previous = intervals[index - 1];
    const next = intervals[index + 1];
    const gapBefore = previous ? Math.max(0, interval.startMs - previous.endMs) : Infinity;
    const gapAfter = next ? Math.max(0, next.startMs - interval.endMs) : Infinity;
    const marginMs = Math.max(120, Math.min(baseMargin, gapBefore / 2, gapAfter / 2));
    return { ...interval, marginMs };
  });
}

/** 0 (not on screen) to 1 (on screen), with a linear fade across the margins. */
export function playbackIntensity(window: PlaybackWindow, timeMs: number): number {
  if (timeMs >= window.startMs && timeMs <= window.endMs) return 1;
  if (timeMs < window.startMs) return Math.max(0, 1 - (window.startMs - timeMs) / window.marginMs);
  return Math.max(0, 1 - (timeMs - window.endMs) / window.marginMs);
}
