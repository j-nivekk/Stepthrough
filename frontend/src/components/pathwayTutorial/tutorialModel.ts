/**
 * The practice recording of the pathways tutorial, and how its steps fold into a pathway.
 *
 * The grouping follows the rules of backend/app/services/pathway.py, on a made-up opening screen and seven
 * steps, so what the tutorial shows is what the app does: the reviewer's choice first, then a revisit, then what the
 * engine found when it compared the screenshots. The automatic result has two mistakes on purpose, of the kinds the
 * app really makes: the same screen split in two (what is on it was replaced), and two screens in one box (most of
 * what they show is the same). backend/tests/test_screens.py has the engine look at this story, so that it stays true.
 */

import { START, stepName, stepsPhrase } from '../../lib/stepNumbers';

export type MockLabel = 'opening' | 'navigation' | 'scroll' | 'modal' | 'modal closed' | 'update';
export type MockArt = 'home' | 'homeNew' | 'settings' | 'settingsScrolled' | 'dialog' | 'settingsOn' | 'productA' | 'productB';

export interface MockStep {
  /** Its place in the recording. What it is called is mockNumber(n): the first is the opening screen, so no step. */
  n: number;
  label: MockLabel;
  art: MockArt;
  /** What happened, for the walk through the journey. */
  story: string;
  time: string;
  title?: string;
  note?: string;
  /** The detector found the same picture again (none here). */
  revisitOf?: number;
  /** The earlier step that the engine found to show the same screen, and by what. */
  found?: { as: number; by: Found };
}

export const MOCK_STEPS: MockStep[] = [
  { n: 1, label: 'opening', art: 'home', time: '0:00', title: 'Home', note: 'Opening screen.', story: 'the app opens on home' },
  { n: 2, label: 'navigation', art: 'settings', time: '0:04', title: 'Settings', story: 'the participant opens settings' },
  { n: 3, label: 'scroll', art: 'settingsScrolled', time: '0:07', story: 'they scroll down the settings', found: { as: 2, by: 'scroll' } },
  {
    n: 4,
    label: 'modal',
    art: 'dialog',
    time: '0:11',
    title: 'Permission',
    note: 'Only "allow" stands out.',
    story: 'a pop-up asks to allow notifications',
  },
  {
    n: 5,
    label: 'modal closed',
    art: 'settingsOn',
    time: '0:15',
    story: 'they allow; back on settings, notifications now on',
    found: { as: 2, by: 'overlay closed' },
  },
  { n: 6, label: 'navigation', art: 'homeNew', time: '0:19', story: 'back to home, where the feed now has other posts' },
  { n: 7, label: 'navigation', art: 'productA', time: '0:24', title: 'Product', note: 'Opened from the feed.', story: 'they open a product' },
  { n: 8, label: 'update', art: 'productB', time: '0:31', story: 'they go to the next product', found: { as: 7, by: 'same page' } },
];

/** Its number, as the app counts: the opening screen is the start, and the first step the change that leaves it. */
export const mockNumber = (n: number): string => (n === 1 ? START : String(n - 1));
/** "step 5", or "start". */
export const mockName = (n: number): string => stepName(mockNumber(n));
/** In a sentence: "5", or "the start". */
const mockRef = (n: number): string => (n === 1 ? `the ${START}` : mockNumber(n));
/** "steps 1–2 and 4". */
export const mockNames = (steps: number[]): string => stepsPhrase(steps.map((n) => ({ step_index: n - 1 })));

export type BoxMode = 'screens' | 'steps';
/** The reviewer's say on a step: `new` (a screen of its own), or the number of a step with the same screen. */
export type ScreenLink = 'new' | number;
export type Choices = Record<number, { link?: ScreenLink; popup?: boolean }>;
/** What the engine goes by, as far as it happens here (the app also has typing, swipes and small updates). */
export type Found = 'overlay closed' | 'scroll' | 'same page';
export type Reason = 'researcher' | 'revisit' | Found;

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
  for (const step of steps) {
    const link = choices[step.n]?.link;
    let target: number | null = null;
    let reason: Reason | null = null;
    if (typeof link === 'number' && link !== step.n && parent.has(link)) {
      target = link;
      reason = 'researcher';
    }
    if (target === null && link !== 'new') {
      if (step.revisitOf) {
        target = step.revisitOf;
        reason = 'revisit';
      } else if (mode !== 'screens') {
        // by step, only the same picture again shares a box
      } else if (step.found && !isPopup(step, choices)) {
        target = step.found.as; // (a pop-up starts a box of its own)
        reason = step.found.by;
      }
    }
    if (target !== null && reason) {
      union(target, step.n);
      reasons.set(step.n, reason);
      joinedTo.set(step.n, target);
    }
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
  const with_ = mockRef(pathway.joinedTo.get(n) ?? 1);
  if (reason === 'researcher') return `you put it here: the same screen as ${with_}.`;
  if (reason === 'revisit') return `a revisit: the same picture as ${with_} again.`;
  if (reason === 'overlay closed') return 'modal closed: the pop-up went away, so it goes back to the screen under it.';
  if (reason === 'scroll') return `scroll: the content moved, so it stays with ${with_}.`;
  if (reason === 'same page') return `update: most of what it shows is on ${with_} as well, so it counts as the same screen.`;
  if (choices[n]?.link === 'new') return 'you gave it a screen of its own.';
  if (isPopup(step, choices)) return 'a pop-up: it starts a box of its own.';
  if (step.label === 'opening') return 'the opening screen starts the first box.';
  if (n === 6) return 'navigation: hardly anything it shows was seen before (the feed has other posts), so a new box.';
  return 'navigation: hardly anything it shows was seen before, so a new box.';
}

/** How `pathway.json` describes a step, for the lesson on reporting. */
export function jsonStep(pathway: MockPathway, n: number, choices: Choices) {
  const screen = pathway.screens.find((item) => item.id === pathway.screenOf.get(n));
  const link = choices[n]?.link;
  const reason = pathway.reasons.get(n);
  return {
    step_index: n - 1,
    screen_id: `screen-${String(screen?.index ?? 0).padStart(2, '0')}`,
    grouped_by: reason?.replace(' ', '_') ?? null,
    screen_choice: link === 'new' ? 'new_screen' : typeof link === 'number' ? 'same_screen' : 'automatic',
  };
}
