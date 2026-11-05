/**
 * The scripted 14-second phone recording behind the "how it works" demo, and what Stepthrough finds in it.
 * The numbers follow the real defaults for phones: a screen must stay still for 450 ms, screenshots are
 * taken 200 ms after a screen settles, and the working copy is analysed at 15 frames per second.
 */

export const DURATION = 14;
export const MIN_DWELL = 0.45;
export const SHOT_OFFSET = 0.2;

export type DemoLabel = 'opening_screen' | 'navigation' | 'text_entry' | 'content_update' | 'scroll' | 'modal';

export const LABEL_TEXT: Record<DemoLabel, string> = {
  opening_screen: 'opening',
  navigation: 'navigation',
  text_entry: 'typing',
  content_update: 'update',
  scroll: 'scroll',
  modal: 'modal',
};

// ── what happens on screen ────────────────────────────────────────────────────────────────────────

export const TAP = { at: 1.85, until: 2.25 };
export const SLIDE = { from: 2.2, to: 2.6 };
export const KEYBOARD = { from: 4.2, to: 4.4 };
export const TYPING: { from: number; to: number; text: string }[] = [
  { from: 4.4, to: 4.9, text: 'see you' },
  { from: 5.5, to: 5.9, text: ' at' },
  { from: 6.5, to: 6.8, text: ' six' },
];
export const SEND = { from: 7.6, to: 7.8 };
export const CLOCK_TICK = 8.0;
export const TOAST = { from: 9.0, to: 9.33 };
export const SCROLL = { from: 9.8, to: 10.6 };
export const MODAL = { from: 12.0, to: 12.3 };
export const CARET = { from: 4.2, to: 7.6, period: 1.0 };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function ease(value: number): number {
  const v = clamp01(value);
  return v * v * (3 - 2 * v);
}

function progress(t: number, span: { from: number; to: number }): number {
  return ease((t - span.from) / (span.to - span.from));
}

export interface PhoneState {
  clock: string;
  tapping: boolean;
  slide: number; // 0 inbox, 1 chat
  keyboard: number; // 0 hidden, 1 shown
  typed: string;
  caretOn: boolean;
  sent: number; // 0 not sent, 1 sent bubble shown
  toast: number; // opacity
  scroll: number; // 0 bottom, 1 scrolled up to older messages
  modal: number; // 0 hidden, 1 shown
}

export function phoneState(t: number): PhoneState {
  let typed = '';
  for (const burst of TYPING) {
    if (t >= burst.to) typed += burst.text;
    else if (t > burst.from) typed += burst.text.slice(0, Math.ceil(((t - burst.from) / (burst.to - burst.from)) * burst.text.length));
  }
  if (t >= SEND.from) typed = '';
  const caretVisible = t >= CARET.from && t < CARET.to;
  const toastIn = clamp01((t - TOAST.from) / 0.08);
  const toastOut = clamp01((t - (TOAST.to - 0.08)) / 0.08);
  return {
    clock: t < CLOCK_TICK ? '9:41' : '9:42',
    tapping: t >= TAP.at && t < TAP.until,
    slide: progress(t, SLIDE),
    keyboard: progress(t, KEYBOARD),
    typed,
    caretOn: caretVisible && (t - CARET.from) % CARET.period < CARET.period / 2,
    sent: progress(t, SEND),
    toast: toastIn * (1 - toastOut),
    scroll: progress(t, SCROLL),
    modal: progress(t, MODAL),
  };
}

// ── what the analysis sees ────────────────────────────────────────────────────────────────────────

/** Windows in which the screen changes, with how much of it changes (as drawn in the demo). */
export const CHANGES: { from: number; to: number; amount: number }[] = [
  { from: 1.85, to: 2.6, amount: 0.92 },
  { from: 4.2, to: 4.9, amount: 0.46 },
  { from: 5.5, to: 5.9, amount: 0.12 },
  { from: 6.5, to: 6.8, amount: 0.12 },
  { from: 7.6, to: 7.8, amount: 0.3 },
  { from: 9.0, to: 9.08, amount: 0.16 },
  { from: 9.25, to: 9.33, amount: 0.16 },
  { from: 9.8, to: 10.6, amount: 0.72 },
  { from: 12.0, to: 12.3, amount: 0.62 },
];

export const THRESHOLD = 0.07;

function noise(t: number): number {
  return 0.018 + 0.008 * Math.sin(t * 37.1) + 0.006 * Math.sin(t * 91.7 + 1.3) + 0.004 * Math.sin(t * 13.3);
}

/**
 * How different frame t is from the first frame of the screen it belongs to. It rises while the screen
 * changes and drops back to the noise level when the next screen starts, because that screen's first
 * frame becomes the new reference.
 */
export function changeAt(t: number): number {
  for (const change of CHANGES) {
    if (t >= change.from && t <= change.to) {
      const p = (t - change.from) / (change.to - change.from);
      return Math.max(noise(t), change.amount * ease(Math.min(1, p / 0.45)));
    }
  }
  return noise(t);
}

/** Changes that are seen but do not count: the status bar clock and the blinking text cursor. */
export const IGNORED: { at: number; what: 'status bar' | 'cursor' }[] = [
  { at: CLOCK_TICK, what: 'status bar' },
  ...Array.from({ length: Math.floor((CARET.to - CARET.from) / (CARET.period / 2)) }, (_, index) => ({
    at: CARET.from + (index + 1) * (CARET.period / 2),
    what: 'cursor' as const,
  })).filter((event) => event.at < CARET.to),
];

/** Frames as a phone records them: many while something moves, about one a second when still. */
export function recordedFrames(): number[] {
  const times = new Set<number>();
  for (let t = 0; t <= DURATION; t += 1) times.add(Math.round(t * 100) / 100);
  for (const change of CHANGES) {
    for (let t = change.from; t <= change.to; t += 1 / 30) times.add(Math.round(t * 100) / 100);
  }
  for (const event of IGNORED) times.add(event.at);
  return [...times].sort((a, b) => a - b);
}

/** Frames of the working copy, analysed at 15 per second. */
export function workingFrames(): number[] {
  return Array.from({ length: DURATION * 15 + 1 }, (_, index) => index / 15);
}

/** Stretches in which the screen stayed still, before typing is grouped or returns are merged. */
export const STILL: { from: number; to: number; note?: 'too short' | 'same screen' }[] = [
  { from: 0, to: 1.85 },
  { from: 2.6, to: 4.2 },
  { from: 4.9, to: 5.5 },
  { from: 5.9, to: 6.5 },
  { from: 6.8, to: 7.6 },
  { from: 7.8, to: 9.0 },
  { from: 9.08, to: 9.25, note: 'too short' },
  { from: 9.33, to: 9.8, note: 'same screen' },
  { from: 10.6, to: 12.0 },
  { from: 12.3, to: DURATION },
];

export interface DemoStep {
  index: number;
  label: DemoLabel;
  from: number; // settled
  to: number; // next change
  groupFrom?: number; // where a grouped burst began
  grouped?: number;
  shot: number;
  title: string;
  accepted: boolean;
}

export const STEPS: DemoStep[] = [
  { index: 1, label: 'opening_screen', from: 0, to: 1.85, shot: SHOT_OFFSET, title: 'inbox', accepted: true },
  { index: 2, label: 'navigation', from: 2.6, to: 4.2, shot: 2.6 + SHOT_OFFSET, title: 'open the chat', accepted: true },
  {
    index: 3,
    label: 'text_entry',
    from: 6.8,
    to: 7.6,
    groupFrom: 4.2,
    grouped: 3,
    shot: 6.8 + SHOT_OFFSET,
    title: 'type a reply',
    accepted: true,
  },
  { index: 4, label: 'content_update', from: 7.8, to: 9.8, shot: 7.8 + SHOT_OFFSET, title: 'reply sent', accepted: true },
  { index: 5, label: 'scroll', from: 10.6, to: 12.0, shot: 10.6 + SHOT_OFFSET, title: 'older messages', accepted: false },
  { index: 6, label: 'modal', from: 12.3, to: DURATION, shot: 12.3 + SHOT_OFFSET, title: 'delete dialog', accepted: true },
];
