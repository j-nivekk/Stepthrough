/**
 * The pathway of a run as a figure: where each screen sits, how the moves between screens are drawn, and the
 * SVG for it. The same code draws the figure on the page and in the downloaded file.
 *
 * Layout: a screen sits one column to the right of the screen it was first reached from. The first screen
 * reached from somewhere continues that row; further ones start a new row below (a branch). A row that
 * reaches the last column continues on a new row at the left (a wrap). Moves along those links are drawn
 * between the sides of the screenshots; every other move runs over the top of the row.
 */
import type { Pathway, PathwayScreen, PathwayStep, PathwayTransition } from '../types';
import { BADGE_HEIGHT, BADGE_WIDTH, buildPathwayBadge } from './pathwayBadge';

export type PathwayNotesPlacement = 'under' | 'key' | 'hidden';

export interface PathwayFigureOptions {
  /** Notes under each screen, in a key at the foot of the figure, or left out. */
  notes: PathwayNotesPlacement;
  /** The time of each visit, next to its step number. */
  times: boolean;
  /** The title above the chart and the legend below it. */
  caption: boolean;
}

export const defaultPathwayFigureOptions: PathwayFigureOptions = { notes: 'under', times: true, caption: true };

export type TextMeasurer = (text: string, size: number, bold?: boolean) => number;

export interface PathwayFigureInput {
  pathway: Pathway;
  options: PathwayFigureOptions;
  /** Width / height of the recording. */
  aspect: number;
  title: string;
  subtitle: string;
  /** For the badge: the day the figure was made (YYYY-MM-DD) and the version of Stepthrough that made it. */
  date: string;
  version: string;
  /** A screen to mark as selected on the page; left out of files. */
  highlight?: string | null;
  /** Address of a step's screenshot: a URL on the page, a data URI in a file that has to stand alone. */
  imageFor: (step: PathwayStep) => string;
  measure?: TextMeasurer;
}

export interface PathwayFigure {
  svg: string;
  width: number;
  height: number;
  /** Notes that did not fit under their screen and were cut. */
  clippedNotes: number;
}

const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const INK = '#111';
const SUB = '#6b6b66';
const NOTE = '#333';
const MARGIN = 48;
const GAP_X = 140;
const ROW_GAP = 30;
/** Screenshot size: the side of a square with the same area, as for the step cards. */
const FRAME_SIZE = 220;
const FRAME_MIN_WIDTH = 120;
/** Columns are added until the figure would be wider than this. */
const TARGET_WIDTH = 1700;
const NOTE_MAX_LINES = 4;
const TRACK = 9;
const STACK = 5;
const MAX_PILLS = 4;

let canvasContext: CanvasRenderingContext2D | null | undefined;

/** Text width in the figure's font; an estimate where there is no canvas. */
export const measureText: TextMeasurer = (text, size, bold) => {
  if (canvasContext === undefined) {
    canvasContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!canvasContext) return text.length * size * (bold ? 0.6 : 0.55);
  canvasContext.font = `${bold ? 700 : 400} ${size}px ${FONT}`;
  return canvasContext.measureText(text).width;
};

const esc = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n1 = (value: number): number => Math.round(value * 10) / 10;

/** `0:04`, or `1:02:03` from an hour on. */
export function formatPathwayTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

interface TextStyle {
  size?: number;
  bold?: boolean;
  fill?: string;
  anchor?: 'middle' | 'end';
  italic?: boolean;
  /** A white edge around the letters, so a line that passes behind them is interrupted. */
  halo?: boolean;
  /** `content` is already markup. */
  raw?: boolean;
}

function text(x: number, y: number, content: string, style: TextStyle = {}): string {
  const attrs = [`x="${n1(x)}"`, `y="${n1(y)}"`, `font-size="${style.size ?? 11}"`];
  if (style.bold) attrs.push('font-weight="700"');
  if (style.fill) attrs.push(`fill="${style.fill}"`);
  if (style.anchor) attrs.push(`text-anchor="${style.anchor}"`);
  if (style.italic) attrs.push('font-style="italic"');
  if (style.halo) attrs.push('stroke="#fff" stroke-width="3" stroke-linejoin="round" paint-order="stroke"');
  return `<text ${attrs.join(' ')}>${style.raw ? content : esc(content)}</text>`;
}

function wrapText(content: string, width: number, size: number, bold: boolean, measure: TextMeasurer): string[] {
  const lines: string[] = [];
  for (const paragraph of content.split(/\r?\n/)) {
    let line = '';
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      // A word wider than the line (a URL) is cut into pieces that fit.
      while (measure(word, size, bold) > width && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && measure(word.slice(0, cut), size, bold) > width) cut -= 1;
        if (line) lines.push(line);
        lines.push(word.slice(0, cut));
        line = '';
        word = word.slice(cut);
      }
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next, size, bold) > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** At most `max` lines; the last one ends in an ellipsis when lines were dropped. */
function clampLines(lines: string[], max: number, width: number, size: number, bold: boolean, measure: TextMeasurer): { lines: string[]; clipped: boolean } {
  if (lines.length <= max) return { lines, clipped: false };
  const kept = lines.slice(0, max);
  let last = kept[max - 1] ?? '';
  while (last && measure(`${last} …`, size, bold) > width) last = last.replace(/\s*\S+$/, '');
  kept[max - 1] = `${last} …`.trim();
  return { lines: kept, clipped: true };
}

const pillWidth = (label: string): number => (label.length === 1 ? 15 : label.length * 6.2 + 10);

function pill(x: number, cy: number, label: string): string {
  const width = pillWidth(label);
  return (
    `<rect x="${n1(x)}" y="${n1(cy - 7.5)}" width="${n1(width)}" height="15" rx="7.5" fill="${INK}"/>` +
    text(x + width / 2, cy + 3.3, label, { size: 9.5, bold: true, fill: '#fff', anchor: 'middle' })
  );
}

/** Step numbers side by side, centred on a point of a line. */
function pillRow(cx: number, cy: number, labels: string[]): string {
  const shown = labels.length > MAX_PILLS ? [...labels.slice(0, MAX_PILLS - 1), `+${labels.length - MAX_PILLS + 1}`] : labels;
  const total = shown.reduce((sum, label) => sum + pillWidth(label), 0) + 2 * (shown.length - 1);
  let x = cx - total / 2;
  let out = '';
  for (const label of shown) {
    out += pill(x, cy, label);
    x += pillWidth(label) + 2;
  }
  return out;
}

// ── where the screens sit ──────────────────────────────────────────────────────────────────────

interface Placed {
  screen: PathwayScreen;
  col: number;
  row: number;
  /** Starts a row at the left because the row it continues was full. */
  wrapped: boolean;
}

function placeScreens(screens: PathwayScreen[], maxCols: number): { placed: Map<string, Placed>; rows: number; cols: number } {
  const kids = new Map<string, PathwayScreen[]>();
  for (const screen of screens) {
    if (!screen.reached_from) continue;
    const list = kids.get(screen.reached_from) ?? [];
    list.push(screen);
    kids.set(screen.reached_from, list);
  }
  const placed = new Map<string, Placed>();
  let nextRow = 0;
  let cols = 1;
  const placeRow = (start: PathwayScreen, startCol: number, row: number, wrapped: boolean): void => {
    const inRow: PathwayScreen[] = [];
    const wraps: PathwayScreen[] = [];
    let screen: PathwayScreen | undefined = start;
    let col = startCol;
    let isWrapped = wrapped;
    while (screen) {
      placed.set(screen.id, { screen, col, row, wrapped: isWrapped });
      cols = Math.max(cols, col + 1);
      isWrapped = false;
      inRow.push(screen);
      const first: PathwayScreen | undefined = kids.get(screen.id)?.[0];
      if (!first) break;
      if (col + 1 >= maxCols) {
        wraps.push(first);
        break;
      }
      screen = first;
      col += 1;
    }
    // Branches of this row come directly below it, before the row it wraps onto.
    for (const parent of inRow) {
      const at = placed.get(parent.id);
      if (!at) continue;
      for (const child of (kids.get(parent.id) ?? []).slice(1)) {
        if (at.col + 1 >= maxCols) {
          wraps.push(child);
        } else {
          nextRow += 1;
          placeRow(child, at.col + 1, nextRow, false);
        }
      }
    }
    for (const child of wraps) {
      nextRow += 1;
      placeRow(child, 0, nextRow, true);
    }
  };
  const root = screens.find((screen) => !screen.reached_from) ?? screens[0];
  if (root) placeRow(root, 0, 0, false);
  return { placed, rows: nextRow + 1, cols };
}

/** Lines that would overlap get different tracks: the lowest track where `[from, to]` is free. */
function takeTrack(tracks: Array<Array<[number, number]>>, from: number, to: number): number {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let index = 0; ; index += 1) {
    const used = (tracks[index] ??= []);
    if (used.every(([a, b]) => hi < a || lo > b)) {
      used.push([lo, hi]);
      return index;
    }
  }
}

// ── one screen ─────────────────────────────────────────────────────────────────────────────────

interface Card {
  svg: string;
  /** Height of the title above the screenshot. */
  above: number;
  /** Height of everything from the top of the screenshot down. */
  below: number;
  stack: number;
  clipped: number;
}

function buildCard(
  screen: PathwayScreen,
  steps: Map<string, PathwayStep>,
  width: number,
  height: number,
  options: PathwayFigureOptions,
  imageFor: (step: PathwayStep) => string,
  measure: TextMeasurer,
): Card {
  const screenSteps = screen.visits.flatMap((visit) => visit.step_ids).map((id) => steps.get(id)).filter((step): step is PathwayStep => Boolean(step));
  const stack = screen.visits.some((visit) => visit.step_ids.length > 1) ? STACK : 0;
  const many = screenSteps.length > 1;
  let svg = '';
  let clipped = 0;

  const titleLines = clampLines(wrapText(screen.title, width, 12, true, measure), 2, width, 12, true, measure).lines;
  titleLines.forEach((line, index) => {
    svg += text(0, -9 - (titleLines.length - 1 - index) * 15, line, { size: 12, bold: true, halo: true });
  });
  const above = 6 + titleLines.length * 15;

  if (stack) svg += `<rect x="${stack}" y="${stack}" width="${width}" height="${height}" fill="#fff" stroke="${INK}" stroke-width="0.75"/>`;
  svg += `<rect width="${width}" height="${height}" fill="#f3f3f0"/>`;
  const image = steps.get(screen.image_step_id);
  if (image) {
    svg += `<image xlink:href="${esc(imageFor(image))}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`;
  }
  svg += `<rect width="${width}" height="${height}" fill="none" stroke="${INK}" stroke-width="0.75"${screen.kind === 'popup' ? ' stroke-dasharray="4 3"' : ''}/>`;

  // Step numbers, one pill per visit, each with the time the visit began.
  let x = 0;
  let cy = height + stack + 16.5;
  for (const visit of screen.visits) {
    const first = steps.get(visit.step_ids[0] ?? '');
    const last = steps.get(visit.step_ids[visit.step_ids.length - 1] ?? '');
    if (!first || !last) continue;
    const label = first === last ? String(first.step_index) : `${first.step_index}–${last.step_index}`;
    const time = options.times ? formatPathwayTime(first.timestamp_ms) : '';
    const timeWidth = time ? 4 + measure(time, 10) : 0;
    const pillW = pillWidth(label);
    if (x > 0 && x + pillW + timeWidth > width) {
      x = 0;
      cy += 20;
    }
    svg += pill(x, cy, label);
    if (time) svg += text(x + pillW + 4, cy + 3.5, time, { size: 10, fill: SUB });
    x += pillW + timeWidth + (time ? 9 : 3);
  }
  if (screen.kind === 'popup') {
    if (x > 0 && x + measure('pop-up', 10) > width) {
      x = 0;
      cy += 20;
    }
    svg += text(x + (options.times || x === 0 ? 0 : 4), cy + 3.5, 'pop-up', { size: 10, fill: SUB, italic: true });
  }
  let y = cy + 11.5;

  if (options.notes === 'under') {
    for (const step of screenSteps) {
      const note = (step.notes ?? '').trim();
      if (!note) continue;
      const number = String(step.step_index);
      const wrapped = wrapText(many ? `${number} ${note}` : note, width, 10.5, false, measure);
      const { lines, clipped: cut } = clampLines(wrapped, NOTE_MAX_LINES, width, 10.5, false, measure);
      if (cut) clipped += 1;
      y += 4;
      lines.forEach((line, index) => {
        y += 13.5;
        const numbered = many && index === 0 && line.startsWith(number);
        const content = numbered
          ? `<tspan font-weight="700" fill="${INK}">${esc(number)}</tspan>${esc(line.slice(number.length))}`
          : esc(line);
        svg += text(0, y, content, { size: 10.5, fill: NOTE, raw: true });
      });
    }
  }
  return { svg, above, below: y + 4, stack, clipped };
}

// ── the figure ─────────────────────────────────────────────────────────────────────────────────

interface Route {
  transition: PathwayTransition;
  path: string;
  pillX: number;
  pillY: number;
}

/** A path through points, with the corners rounded. Consecutive points share an x or a y. */
function roundedPath(points: Array<[number, number]>, radius = 8): string {
  const first = points[0];
  if (!first) return '';
  let d = `M${n1(first[0])} ${n1(first[1])}`;
  for (let index = 1; index < points.length; index += 1) {
    const [x, y] = points[index] as [number, number];
    const [px, py] = points[index - 1] as [number, number];
    const next = points[index + 1];
    if (!next) {
      d += ` L${n1(x)} ${n1(y)}`;
      break;
    }
    const before = Math.min(radius, Math.hypot(x - px, y - py) / 2);
    const after = Math.min(radius, Math.hypot(next[0] - x, next[1] - y) / 2);
    const bx = x - Math.sign(x - px) * before;
    const by = y - Math.sign(y - py) * before;
    const ax = x + Math.sign(next[0] - x) * after;
    const ay = y + Math.sign(next[1] - y) * after;
    d += ` L${n1(bx)} ${n1(by)} Q${n1(x)} ${n1(y)} ${n1(ax)} ${n1(ay)}`;
  }
  return d;
}

export function buildPathwayFigure(input: PathwayFigureInput): PathwayFigure {
  const { pathway, options, imageFor } = input;
  const measure = input.measure ?? measureText;
  const aspect = input.aspect > 0 ? input.aspect : 16 / 10;
  const width = Math.max(FRAME_MIN_WIDTH, Math.round(FRAME_SIZE * Math.sqrt(aspect)));
  const height = Math.round(width / aspect);
  const pitch = width + GAP_X;
  const maxCols = Math.max(2, Math.floor((TARGET_WIDTH - 2 * MARGIN + GAP_X) / pitch));

  const steps = new Map(pathway.steps.map((step) => [step.step_id, step]));
  const { placed, rows, cols } = placeScreens(pathway.screens, maxCols);
  const cards = new Map<string, Card>();
  for (const screen of pathway.screens) cards.set(screen.id, buildCard(screen, steps, width, height, options, imageFor, measure));

  // Moves that do not follow the tree run over the top of a row, and between rows through a margin. Their
  // tracks are found first, in columns and rows, because the tracks decide how much room the figure needs.
  type Kind = 'straight' | 'elbow' | 'wrap' | 'over';
  interface Plan {
    transition: PathwayTransition;
    from: Placed;
    to: Placed;
    kind: Kind;
    /** Drawn against the direction of the tree link it follows (a move back to the screen it came from). */
    reversed: boolean;
    busFrom?: number;
    busTo?: number;
    side?: 'left' | 'right';
    sideTrack?: number;
    /** For a wrap: the track in the other margin. */
    otherTrack?: number;
    slotFrom?: number;
    slotTo?: number;
  }
  const busTracks: Array<Array<Array<[number, number]>>> = Array.from({ length: rows }, () => []);
  const sideTracks: Record<'left' | 'right', Array<Array<[number, number]>>> = { left: [], right: [] };
  const slots = new Map<string, number>();
  const takeSlot = (id: string): number => {
    const slot = slots.get(id) ?? 0;
    slots.set(id, slot + 1);
    return slot;
  };
  const LEFT = -1;
  const RIGHT = cols;
  const plans: Plan[] = [];
  for (const transition of pathway.transitions) {
    const from = placed.get(transition.from_screen);
    const to = placed.get(transition.to_screen);
    if (!from || !to) continue;
    const forward = to.screen.reached_from === from.screen.id;
    const back = from.screen.reached_from === to.screen.id;
    const parent = forward ? from : to;
    const child = forward ? to : from;
    const plan: Plan = { transition, from, to, kind: 'over', reversed: back };
    if (forward || back) {
      if (child.wrapped) {
        plan.kind = 'wrap';
        plan.busTo = takeTrack(busTracks[child.row] ?? [], LEFT, RIGHT);
        plan.sideTrack = takeTrack(sideTracks.right, parent.row, child.row);
        plan.otherTrack = takeTrack(sideTracks.left, child.row - 0.5, child.row);
      } else {
        plan.kind = child.row === parent.row ? 'straight' : 'elbow';
      }
    } else {
      plan.slotFrom = takeSlot(from.screen.id);
      plan.slotTo = takeSlot(to.screen.id);
      if (from.row === to.row) {
        plan.busTo = takeTrack(busTracks[to.row] ?? [], from.col, to.col);
      } else {
        plan.side = from.col + to.col + 1 < cols ? 'left' : 'right';
        const edge = plan.side === 'left' ? LEFT : RIGHT;
        plan.busFrom = takeTrack(busTracks[from.row] ?? [], from.col, edge);
        plan.busTo = takeTrack(busTracks[to.row] ?? [], to.col, edge);
        plan.sideTrack = takeTrack(sideTracks[plan.side], from.row, to.row);
      }
    }
    plans.push(plan);
  }

  const leftMargin = MARGIN + (sideTracks.left.length ? 12 + sideTracks.left.length * TRACK : 0);
  const rightMargin = MARGIN + (sideTracks.right.length ? 12 + sideTracks.right.length * TRACK : 0);
  const figureWidth = Math.max(520, leftMargin + cols * width + (cols - 1) * GAP_X + STACK + rightMargin);
  const titleLines = wrapText(input.title, figureWidth - 2 * MARGIN, 17, true, measure);
  const subtitleLines = wrapText(input.subtitle, figureWidth - 2 * MARGIN, 10.5, false, measure);
  const subtitleY = 46 + Math.max(0, titleLines.length - 1) * 22 + 18;
  const headerBottom = subtitleY + Math.max(0, subtitleLines.length - 1) * 14;
  const inRow = (row: number): Card[] => [...placed.values()].filter((item) => item.row === row).map((item) => cards.get(item.screen.id)).filter((card): card is Card => Boolean(card));

  const rowTop: number[] = [];
  const busBase: number[] = [];
  let y = options.caption ? headerBottom + 28 : MARGIN;
  for (let row = 0; row < rows; row += 1) {
    const tracks = busTracks[row]?.length ?? 0;
    if (tracks) y += 10 + tracks * TRACK;
    busBase[row] = y - 6;
    y += Math.max(0, ...inRow(row).map((card) => card.above));
    rowTop[row] = y;
    y += Math.max(0, ...inRow(row).map((card) => card.below)) + ROW_GAP;
  }
  const chartBottom = y - ROW_GAP;

  const left = (item: Placed): number => leftMargin + item.col * pitch;
  const right = (item: Placed): number => left(item) + width + (cards.get(item.screen.id)?.stack ?? 0);
  const top = (item: Placed): number => rowTop[item.row] ?? 0;
  const busY = (row: number, track: number): number => (busBase[row] ?? 0) - track * TRACK;
  const sideX = (side: 'left' | 'right', track: number): number =>
    side === 'left' ? leftMargin - 14 - track * TRACK : figureWidth - rightMargin + 14 + track * TRACK;
  const slotX = (item: Placed, slot: number): number => left(item) + width - 14 - (slot % Math.max(1, Math.floor((width - 28) / 10))) * 10;

  const routes: Route[] = [];
  for (const plan of plans) {
    const { from, to, transition } = plan;
    let points: Array<[number, number]> = [];
    let pillX = 0;
    let pillY = 0;
    if (plan.kind === 'straight') {
      const parent = plan.reversed ? to : from;
      const child = plan.reversed ? from : to;
      const lineY = top(parent) + height * (plan.reversed ? 0.52 : 0.32);
      points = plan.reversed ? [[left(child), lineY], [right(parent) + 2, lineY]] : [[right(parent), lineY], [left(child) - 2, lineY]];
      pillX = (right(parent) + left(child)) / 2;
      pillY = lineY;
    } else if (plan.kind === 'elbow') {
      const parent = plan.reversed ? to : from;
      const child = plan.reversed ? from : to;
      if (plan.reversed) {
        const trunk = right(parent) + 17;
        const childY = top(child) + height * 0.52;
        const parentY = top(parent) + height * 0.76 + 12;
        points = [[left(child), childY], [trunk, childY], [trunk, parentY], [right(parent) + 2, parentY]];
        pillX = (trunk + left(child)) / 2;
        pillY = childY;
      } else {
        const trunk = right(parent) + 26;
        const childY = top(child) + height * 0.32;
        const parentY = top(parent) + height * 0.76;
        points = [[right(parent), parentY], [trunk, parentY], [trunk, childY], [left(child) - 2, childY]];
        pillX = (trunk + left(child)) / 2;
        pillY = childY;
      }
    } else if (plan.kind === 'wrap') {
      const parent = plan.reversed ? to : from;
      const child = plan.reversed ? from : to;
      const offset = plan.reversed ? 0.52 : 0.32;
      const rightX = sideX('right', plan.sideTrack ?? 0);
      const leftX = sideX('left', plan.otherTrack ?? 0);
      const channel = busY(child.row, plan.busTo ?? 0);
      const forward: Array<[number, number]> = [
        [right(parent), top(parent) + height * offset],
        [rightX, top(parent) + height * offset],
        [rightX, channel],
        [leftX, channel],
        [leftX, top(child) + height * offset],
        [left(child), top(child) + height * offset],
      ];
      points = plan.reversed ? forward.reverse() : forward;
      const end = points[points.length - 1] as [number, number];
      points[points.length - 1] = [end[0] + (plan.reversed ? 2 : -2), end[1]];
      // On the long run between the rows, above the screen the move arrives at (or leaves, going back).
      pillX = plan.reversed ? Math.min(rightX - 40, left(parent) + width / 2) : left(child) + width / 2;
      pillY = channel;
    } else {
      const fromX = slotX(from, plan.slotFrom ?? 0);
      const toX = slotX(to, plan.slotTo ?? 0);
      const toBus = busY(to.row, plan.busTo ?? 0);
      let comesFrom = fromX;
      if (from.row === to.row) {
        points = [[fromX, top(from)], [fromX, toBus], [toX, toBus], [toX, top(to) - 2]];
      } else {
        const corridor = sideX(plan.side ?? 'left', plan.sideTrack ?? 0);
        const fromBus = busY(from.row, plan.busFrom ?? 0);
        points = [[fromX, top(from)], [fromX, fromBus], [corridor, fromBus], [corridor, toBus], [toX, toBus], [toX, top(to) - 2]];
        comesFrom = corridor;
      }
      const run = Math.abs(comesFrom - toX);
      pillX = run < 60 ? (comesFrom + toX) / 2 : toX + Math.sign(comesFrom - toX) * 30;
      pillY = toBus;
    }
    routes.push({ transition, path: roundedPath(points), pillX, pillY });
  }

  // ── markup ──
  let body = '';
  if (options.caption) {
    body += '<g id="header">';
    titleLines.forEach((line, index) => { body += text(MARGIN, 46 + index * 22, line, { size: 17, bold: true }); });
    subtitleLines.forEach((line, index) => { body += text(MARGIN, subtitleY + index * 14, line, { size: 10.5, fill: SUB }); });
    body += '</g>';
  }
  body += '<g id="moves">';
  for (const route of routes) {
    const { transition } = route;
    body +=
      `<g id="move-${esc(transition.from_screen)}-${esc(transition.to_screen)}">` +
      `<path d="${route.path}" fill="none" stroke="${INK}" stroke-width="1.1"${transition.kind === 'return' ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#pathway-arrow)"/>` +
      pillRow(route.pillX, route.pillY, transition.passes.map((pass) => String(pass.step_index))) +
      '</g>';
  }
  body += '</g><g id="screens">';
  let clippedNotes = 0;
  for (const item of placed.values()) {
    const card = cards.get(item.screen.id);
    if (!card) continue;
    clippedNotes += card.clipped;
    const selected =
      input.highlight === item.screen.id
        ? `<rect x="-5" y="-5" width="${width + card.stack + 10}" height="${height + card.stack + 10}" fill="none" stroke="#cd6d1e" stroke-width="2.5"/>`
        : '';
    body += `<g id="${esc(item.screen.id)}" data-screen="${esc(item.screen.id)}" transform="translate(${n1(left(item))} ${n1(top(item))})">${card.svg}${selected}</g>`;
  }
  body += '</g>';

  // Under the chart: the key to the notes and the legend on the left, the badge on the right. A figure too
  // narrow for both side by side gets the badge below them.
  const badgeLeft = figureWidth - MARGIN - BADGE_WIDTH;
  const beside = badgeLeft - 28 - MARGIN >= 330;
  const leftEnd = beside ? badgeLeft - 28 : figureWidth - MARGIN;
  let leftBottom = chartBottom;
  if (options.caption) {
    body += `<line id="rule" x1="${MARGIN}" y1="${n1(chartBottom + 16)}" x2="${n1(figureWidth - MARGIN)}" y2="${n1(chartBottom + 16)}" stroke="#d6d6d1" stroke-width="0.75"/>`;
  }
  if (options.notes === 'key') {
    const noted = pathway.steps.filter((step) => (step.notes ?? '').trim());
    if (noted.length) {
      const keyWidth = Math.min(560, leftEnd - MARGIN);
      const titles = new Map(pathway.screens.map((screen) => [screen.id, screen.title]));
      let keyY = chartBottom + 40;
      let key = text(MARGIN, keyY, 'Notes', { size: 11, bold: true });
      keyY += 8;
      for (const step of noted) {
        const number = String(step.step_index);
        const time = options.times ? formatPathwayTime(step.timestamp_ms) : '';
        keyY += 18;
        let x = MARGIN + pillWidth(number) + 6;
        key += pill(MARGIN, keyY - 3.5, number);
        if (time) {
          key += text(x, keyY, time, { size: 10.5, fill: SUB });
          x += measure(time, 10.5) + 6;
        }
        const titleLines = wrapText(titles.get(step.screen_id) ?? '', keyWidth - (x - MARGIN), 10.5, true, measure);
        titleLines.forEach((line, index) => {
          if (index) keyY += 13.5;
          key += text(x, keyY, line, { size: 10.5, bold: true });
        });
        for (const line of wrapText((step.notes ?? '').trim(), keyWidth, 10.5, false, measure)) {
          keyY += 13.5;
          key += text(MARGIN, keyY, line, { size: 10.5, fill: NOTE });
        }
        keyY += 3;
      }
      body += `<g id="notes">${key}</g>`;
      leftBottom = keyY;
    }
  }

  if (options.caption) {
    const arrow = (dashed: boolean) => (x: number, cy: number): string =>
      `<line x1="${n1(x)}" y1="${n1(cy)}" x2="${n1(x + 26)}" y2="${n1(cy)}" stroke="${INK}" stroke-width="1.1"${dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#pathway-arrow)"/>`;
    const items: Array<[(x: number, cy: number) => string, number, string]> = [
      [(x, cy) => pill(x, cy, '2'), 15, 'step number, as in steps.csv'],
      [arrow(false), 28, 'move to another screen, numbered by the step it leads to'],
    ];
    if (pathway.transitions.some((transition) => transition.kind === 'return')) items.push([arrow(true), 28, 'return to an earlier screen']);
    if (pathway.screens.some((screen) => screen.kind === 'popup')) {
      items.push([(x, cy) => `<rect x="${n1(x)}" y="${n1(cy - 7)}" width="10" height="14" fill="none" stroke="${INK}" stroke-width="0.75" stroke-dasharray="3 2"/>`, 10, 'pop-up']);
    }
    if ([...cards.values()].some((card) => card.stack)) {
      items.push([
        (x, cy) =>
          `<rect x="${n1(x + 3)}" y="${n1(cy - 4)}" width="10" height="14" fill="#fff" stroke="${INK}" stroke-width="0.75"/>` +
          `<rect x="${n1(x)}" y="${n1(cy - 7)}" width="10" height="14" fill="#fff" stroke="${INK}" stroke-width="0.75"/>`,
        13,
        'several steps on one screen',
      ]);
    }
    let legend = '';
    let x = MARGIN;
    let cy = leftBottom + (leftBottom > chartBottom ? 28 : 38);
    let rowBottom = cy + 8;
    for (const [draw, iconWidth, label] of items) {
      const labelWidth = leftEnd - MARGIN - iconWidth - 6;
      const lines = wrapText(label, labelWidth, 10, false, measure);
      const itemWidth = iconWidth + 6 + Math.max(...lines.map((line) => measure(line, 10)));
      if (x > MARGIN && x + itemWidth > leftEnd) {
        x = MARGIN;
        cy = rowBottom + 14;
      }
      legend += draw(x, cy);
      lines.forEach((line, index) => {
        legend += text(x + iconWidth + 6, cy + 3.5 + index * 13.5, line, { size: 10, fill: '#444' });
      });
      rowBottom = Math.max(rowBottom, cy + 8 + (lines.length - 1) * 13.5);
      x += itemWidth + 20;
    }
    body += `<g id="legend">${legend}</g>`;
    leftBottom = rowBottom;
  }

  // Made as a group of its own, like the title and the legend, so it is easy to move in a drawing program.
  const badgeTop = beside || leftBottom === chartBottom ? chartBottom + (options.caption ? 28 : 22) : leftBottom + 14;
  body += `<g transform="translate(${n1(badgeLeft)} ${n1(badgeTop)})">${buildPathwayBadge({ date: input.date, version: input.version })}</g>`;
  const figureHeight = Math.max(leftBottom, badgeTop + BADGE_HEIGHT) + 30;

  const w = Math.ceil(figureWidth);
  const h = Math.ceil(figureHeight);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${esc(FONT)}" fill="${INK}">` +
    `<title>${esc(input.title)}</title>` +
    `<defs><marker id="pathway-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1.5 L9 5 L1 8.5 Z" fill="${INK}"/></marker></defs>` +
    `<rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
  return { svg, width: w, height: h, clippedNotes };
}
