/**
 * The practice recording of the pathways tutorial, and how its steps fold into a pathway.
 *
 * The grouping follows the rules of backend/app/services/pathway.py, on eight made-up steps, so what the
 * tutorial shows is what the app does: the reviewer's choice first, then a revisit, a pop-up closing, and a
 * label that stays on the screen. The automatic result has two mistakes on purpose, of the kinds the app
 * really makes: the same screen split in two (it changed a little), and two screens in one box (they look
 * alike).
 */

export type MockLabel = 'opening' | 'navigation' | 'scroll' | 'modal' | 'modal closed' | 'update';
export type MockArt = 'home' | 'homeBadge' | 'settings' | 'settingsScrolled' | 'dialog' | 'settingsOn' | 'articleA' | 'articleB';

export interface MockStep {
  n: number;
  label: MockLabel;
  art: MockArt;
  /** What happened, for the walk through the journey. */
  story: string;
  time: string;
  title?: string;
  note?: string;
  /** The detector found the same screen state again (none here: step 6 has a badge the first visit lacked). */
  revisitOf?: number;
}

export const MOCK_STEPS: MockStep[] = [
  { n: 1, label: 'opening', art: 'home', time: '0:00', title: 'Home', note: 'Opening screen.', story: 'the app opens on home' },
  { n: 2, label: 'navigation', art: 'settings', time: '0:04', title: 'Settings', story: 'the participant opens settings' },
  { n: 3, label: 'scroll', art: 'settingsScrolled', time: '0:07', story: 'they scroll down the settings' },
  {
    n: 4,
    label: 'modal',
    art: 'dialog',
    time: '0:11',
    title: 'Permission',
    note: 'Only "allow" stands out.',
    story: 'a pop-up asks to allow notifications',
  },
  { n: 5, label: 'modal closed', art: 'settingsOn', time: '0:15', story: 'they allow; back on settings, notifications now on' },
  { n: 6, label: 'navigation', art: 'homeBadge', time: '0:19', story: 'back to home, which now shows a badge' },
  { n: 7, label: 'navigation', art: 'articleA', time: '0:24', title: 'Article', note: 'Opened from the feed.', story: 'they open an article' },
  { n: 8, label: 'update', art: 'articleB', time: '0:31', story: 'they swipe to the next article' },
];

const STAYS: MockLabel[] = ['scroll', 'update'];

export type BoxMode = 'screens' | 'steps';
/** The reviewer's say on a step: `new` (a screen of its own), or the number of a step with the same screen. */
export type ScreenLink = 'new' | number;
export type Choices = Record<number, { link?: ScreenLink; popup?: boolean }>;
export type Reason = 'researcher' | 'revisit' | 'modal closed' | 'scroll' | 'update';

export interface MockScreen {
  /** The number of the screen's first step: it stays the same while boxes are renumbered. */
  id: number;
  index: number;
  title: string;
  popup: boolean;
  steps: number[];
  reachedFrom: number | null;
  col: number;
  row: number;
}

export interface MockMove {
  from: number;
  to: number;
  passes: number[];
  kind: 'forward' | 'return';
}

export interface MockPathway {
  screens: MockScreen[];
  moves: MockMove[];
  screenOf: Map<number, number>;
  /** Why a step shares the box of an earlier one; missing for the step that starts a box. */
  reasons: Map<number, Reason>;
  /** The step each joined step was put with. */
  joinedTo: Map<number, number>;
  rows: number;
  cols: number;
}

export function isPopup(step: MockStep, choices: Choices): boolean {
  return choices[step.n]?.popup ?? step.label === 'modal';
}

export function buildMockPathway(choices: Choices, mode: BoxMode = 'screens', steps: MockStep[] = MOCK_STEPS): MockPathway {
  const parent = new Map(steps.map((step) => [step.n, step.n]));
  const find = (n: number): number => {
    let root = n;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: number, b: number) => {
    const [first, second] = [find(a), find(b)].sort((x, y) => x - y);
    parent.set(second, first);
  };

  const reasons = new Map<number, Reason>();
  const joinedTo = new Map<number, number>();
  const openPopups: number[] = []; // the steps showing the screens under the pop-ups that are open
  let previous: MockStep | null = null;
  for (const step of steps) {
    const link = choices[step.n]?.link;
    let target: number | null = null;
    let reason: Reason | null = null;
    if (typeof link === 'number' && link !== step.n && parent.has(link)) {
      target = link;
      reason = 'researcher';
    }
    const popup = isPopup(step, choices);
    if (target === null && link !== 'new') {
      if (step.revisitOf) {
        target = step.revisitOf;
        reason = 'revisit';
      } else if (popup || mode !== 'screens') {
        // a pop-up starts a box of its own; by step, only the same screen state shares a box
      } else if (step.label === 'modal closed' && openPopups.length) {
        target = openPopups[openPopups.length - 1] ?? null;
        reason = 'modal closed';
      } else if (STAYS.includes(step.label) && previous) {
        target = previous.n;
        reason = step.label as Reason;
      }
    }
    if (target !== null && reason) {
      union(target, step.n);
      reasons.set(step.n, reason);
      joinedTo.set(step.n, target);
    }
    if (popup) {
      if (previous) openPopups.push(previous.n);
    } else if (step.label === 'modal closed') {
      openPopups.pop();
    } else if (openPopups.length && target !== null && find(target) === find(openPopups[openPopups.length - 1] ?? 0)) {
      openPopups.pop();
    } else if (!STAYS.includes(step.label)) {
      openPopups.length = 0;
    }
    previous = step;
  }

  // Boxes in order of first visit; moves between different boxes, in order of the first time they were made.
  const screens: MockScreen[] = [];
  const byRoot = new Map<number, MockScreen>();
  const screenOf = new Map<number, number>();
  const moves = new Map<string, MockMove>();
  let last: MockScreen | null = null;
  for (const step of steps) {
    const root = find(step.n);
    let screen = byRoot.get(root);
    if (!screen) {
      screen = {
        id: step.n,
        index: screens.length + 1,
        title: '',
        popup: isPopup(step, choices),
        steps: [],
        reachedFrom: last ? last.id : null,
        col: 0,
        row: 0,
      };
      screens.push(screen);
      byRoot.set(root, screen);
    }
    screen.steps.push(step.n);
    if (!screen.title && step.title) screen.title = step.title;
    screenOf.set(step.n, screen.id);
    if (last && last.id !== screen.id) {
      const key = `${last.id}>${screen.id}`;
      const move = moves.get(key) ?? { from: last.id, to: screen.id, passes: [], kind: screen.index < last.index ? 'return' : 'forward' };
      move.passes.push(step.n);
      moves.set(key, move);
    }
    last = screen;
  }
  for (const screen of screens) if (!screen.title) screen.title = `Screen ${screen.index}`;

  // Where the boxes sit: one column right of the box first reached from; the first box reached from a box
  // continues its row, the others start a row below (as in the app's figure).
  const children = new Map<number, MockScreen[]>();
  for (const screen of screens) {
    if (screen.reachedFrom === null) continue;
    children.set(screen.reachedFrom, [...(children.get(screen.reachedFrom) ?? []), screen]);
  }
  let nextRow = 0;
  let cols = 1;
  const place = (start: MockScreen, col: number, row: number) => {
    const inRow: MockScreen[] = [];
    let screen: MockScreen | undefined = start;
    let at = col;
    while (screen) {
      screen.col = at;
      screen.row = row;
      cols = Math.max(cols, at + 1);
      inRow.push(screen);
      screen = children.get(screen.id)?.[0];
      at += 1;
    }
    for (const parentScreen of inRow) {
      for (const child of (children.get(parentScreen.id) ?? []).slice(1)) {
        nextRow += 1;
        place(child, parentScreen.col + 1, nextRow);
      }
    }
  };
  if (screens[0]) place(screens[0], 0, 0);

  return { screens, moves: [...moves.values()], screenOf, reasons, joinedTo, rows: nextRow + 1, cols };
}

const STEP_BY_N = new Map(MOCK_STEPS.map((step) => [step.n, step]));

export function mockStep(n: number): MockStep {
  const step = STEP_BY_N.get(n);
  if (!step) throw new Error(`no step ${n}`);
  return step;
}

/** Why step n is in its box, in a sentence. */
export function reasonText(pathway: MockPathway, n: number, choices: Choices): string {
  const step = mockStep(n);
  const reason = pathway.reasons.get(n);
  const with_ = pathway.joinedTo.get(n);
  if (reason === 'researcher') return `you put it here: the same screen as ${with_}.`;
  if (reason === 'revisit') return `a revisit: the same picture as ${with_} again.`;
  if (reason === 'modal closed') return 'modal closed: the pop-up went away, so it goes back to the screen under it.';
  if (reason === 'scroll') return `scroll: the screen moved, so it stays with ${with_}.`;
  if (reason === 'update') return `update: only part of the screen changed (text and picture), so it stays with ${with_}.`;
  if (choices[n]?.link === 'new') return 'you gave it a screen of its own.';
  if (isPopup(step, choices)) return 'a pop-up: it always starts a box of its own.';
  if (step.label === 'opening') return 'the opening screen starts the first box.';
  if (n === 6) return 'navigation, and not the same picture as 1 (a badge appeared), so a new box.';
  return 'navigation: most of the screen changed, so a new box.';
}

/** How `pathway.json` describes a step, for the lesson on reporting. */
export function jsonStep(pathway: MockPathway, n: number, choices: Choices) {
  const screen = pathway.screens.find((item) => item.id === pathway.screenOf.get(n));
  const link = choices[n]?.link;
  const reason = pathway.reasons.get(n);
  return {
    step_index: n,
    screen_id: `screen-${String(screen?.index ?? 0).padStart(2, '0')}`,
    grouped_by: reason === 'modal closed' ? 'modal_close' : reason ?? null,
    screen_choice: link === 'new' ? 'new_screen' : typeof link === 'number' ? 'same_screen' : 'automatic',
  };
}
