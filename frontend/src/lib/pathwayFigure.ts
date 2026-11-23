/**
 * The pathway of a run as a figure: where each screen sits, how the moves between screens are drawn, and the
 * SVG for it. The same code draws the figure on the page and in the downloaded file.
 *
 * Layout: a screen sits one column to the right of the screen it was first reached from. The first screen
 * reached from somewhere continues that row; further ones start a new row below (a branch). The reviewer can say
 * otherwise for a box (its row choice): continue the row, or start a row below. A row that reaches the last column
 * continues on a new row at the left (a wrap).
 *
 * Routing:
 * - Main flow along row links runs horizontally in dark ink; branches and forward detours use muted terracotta;
 *   returns to earlier screens are dashed in muted slate-blue.
 * - Every routed path carries a white under-stroke halo so crossings read cleanly as over/under.
 * - Branch elbows allocate separate vertical gutter tracks and staggered exits so parallel branches never stack.
 * - Adjacent-row non-tree moves route directly through the shared inter-row bus instead of detouring to the page
 *   margin; long moves label both ends so context stays readable when part of the chart is out of view.
 * - Distant multi-row jumps (2+ rows apart) render as paired portal chips (`[step] → S#` at departure,
 *   `S# → [step]` at arrival) that stay readable when scrolled/zoomed and can be clicked on the page to jump.
 *
 * Phases (named stretches of steps) are drawn as a bracket over the boxes they reach first, with the phase's
 * name and how many steps and screens it takes.
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
  /**
   * On the page: mark the step numbers under each screen, moves, and jump chips so the browser can preview steps,
   * spotlight connected paths, and click to jump across rows (see PathwayPanel / PathwayCanvas). Left out of files.
   */
  peek?: boolean;
  /** Address of a step's screenshot: a URL on the page, a data URI in a file that has to stand alone. */
  imageFor: (step: PathwayStep) => string;
  measure?: TextMeasurer;
}

export interface PathwayFigure {
  svg: string;
  width: number;
  height: number;
  /** Summary of visual encodings present in this figure, for the interactive sticky key. */
  encodings: {
    hasBranch: boolean;
    hasReturn: boolean;
    hasPortal: boolean;
    hasPopup: boolean;
  };
}

type MoveRole = 'main' | 'branch' | 'return';

const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const INK = '#111';
const SUB = '#6b6b66';
const NOTE = '#333';
/** Semantic path colours: dark ink for main flow, muted terracotta for branches/detours, slate-blue for returns. */
const BRANCH_COLOR = '#a44d10';
const RETURN_COLOR = '#2c5f8a';
const MARGIN = 48;
const GAP_X = 148;
const ROW_GAP = 34;
/** Screenshot size: the side of a square with the same area, as for the step cards. */
const FRAME_SIZE = 220;
const FRAME_MIN_WIDTH = 120;
/** Columns are added until the figure would be wider than this. */
const TARGET_WIDTH = 1700;
/** Horizontal bus track pitch (> 19px portal chip & 15px step pill height so parallel tracks never collide). */
const BUS_TRACK = 22;
/** Vertical margin corridor pitch (wires only, no pills). */
const SIDE_TRACK = 14;
/** Spacing between parallel vertical branch trunks inside a column gutter. */
const GUTTER_TRACK = 12;
/** Line height of a phase's name and counts above its bracket. */
const PHASE_LINE = 13;
const STACK = 5;
const MAX_PILLS = 4;

const ROLE_COLOR: Record<MoveRole, string> = {
  main: INK,
  branch: BRANCH_COLOR,
  return: RETURN_COLOR,
};

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

function wrapText(content: string, width: number, size: number, bold: boolean, measure: TextMeasurer, firstWidth = width): string[] {
  const lines: string[] = [];
  const limit = () => (lines.length === 0 ? firstWidth : width);
  for (const paragraph of content.split(/\r?\n/)) {
    let line = '';
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      // A word wider than the line (a URL) is cut into pieces that fit.
      while (measure(word, size, bold) > limit() && word.length > 1) {
        const cap = limit();
        let cut = word.length - 1;
        while (cut > 1 && measure(word.slice(0, cut), size, bold) > cap) cut -= 1;
        if (line) lines.push(line);
        lines.push(word.slice(0, cut));
        line = '';
        word = word.slice(cut);
      }
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next, size, bold) > limit()) {
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

const pillWidth = (label: string): number => (label.length === 1 ? 15 : label.length * 6.2 + 10);

function pill(x: number, cy: number, label: string, fill = INK): string {
  const width = pillWidth(label);
  return (
    `<rect x="${n1(x)}" y="${n1(cy - 7.5)}" width="${n1(width)}" height="15" rx="7.5" fill="${fill}"/>` +
    text(x + width / 2, cy + 3.3, label, { size: 9.5, bold: true, fill: '#fff', anchor: 'middle' })
  );
}

function compactPasses(labels: string[]): string[] {
  return labels.length > MAX_PILLS ? [...labels.slice(0, MAX_PILLS - 1), `+${labels.length - MAX_PILLS + 1}`] : labels;
}

/** Step numbers side by side, centred on a point of a line. */
function pillRow(cx: number, cy: number, labels: string[], fill = INK): string {
  const shown = compactPasses(labels);
  const total = shown.reduce((sum, label) => sum + pillWidth(label), 0) + 2 * (shown.length - 1);
  let x = cx - total / 2;
  let out = '';
  for (const label of shown) {
    out += pill(x, cy, label, fill);
    x += pillWidth(label) + 2;
  }
  return out;
}

function miniPillWidth(label: string): number {
  return label.length === 1 ? 13 : label.length * 5.6 + 8;
}

function measurePortalChip(
  labels: string[],
  tagText: string,
  measure: TextMeasurer,
): { width: number; pillsWidth: number; tagWidth: number; shown: string[] } {
  const shown = compactPasses(labels);
  const pillsWidth = shown.reduce((sum, label) => sum + miniPillWidth(label), 0) + Math.max(0, shown.length - 1) * 2;
  const tagWidth = measure(tagText, 9.5, true);
  // 4px outer padding + pills + 5px gap + tagText + 6px outer padding
  const width = 4 + pillsWidth + 5 + tagWidth + 6;
  return { width, pillsWidth, tagWidth, shown };
}

/**
 * Compact rounded chip drawn at one end of a distant jump, wrap, or long cross-row move.
 * - `side === 'departure'`: `[pills] → S7` (shows where the move goes)
 * - `side === 'arrival'`: `S2 → [pills]` (shows where the move came from)
 * On the page (`peek: true`), carries `data-jump-to` so clicking scrolls directly to the other screen.
 */
function renderPortalChip(params: {
  x: number;
  cy: number;
  labels: string[];
  tagText: string;
  side: 'departure' | 'arrival';
  role: MoveRole;
  measure: TextMeasurer;
  targetScreen: PathwayScreen;
  peek: boolean;
}): { svg: string; width: number } {
  const { x, cy, labels, tagText, side, role, measure, targetScreen, peek } = params;
  const color = ROLE_COLOR[role];
  const { width, pillsWidth, shown } = measurePortalChip(labels, tagText, measure);
  const dashed = role === 'return' ? ' stroke-dasharray="3.5 2.5"' : '';
  const height = 19;
  let inner =
    `<rect x="${n1(x)}" y="${n1(cy - height / 2)}" width="${n1(width)}" height="${height}" rx="9.5" fill="#fff" stroke="${color}" stroke-width="1.1"${dashed}/>`;

  const drawPills = (startX: number): void => {
    let px = startX;
    for (const label of shown) {
      const pw = miniPillWidth(label);
      inner +=
        `<rect x="${n1(px)}" y="${n1(cy - 6.5)}" width="${n1(pw)}" height="13" rx="6.5" fill="${color}"/>` +
        text(px + pw / 2, cy + 3.1, label, { size: 8.8, bold: true, fill: '#fff', anchor: 'middle' });
      px += pw + 2;
    }
  };

  if (side === 'departure') {
    drawPills(x + 3.5);
    inner += text(x + 3.5 + pillsWidth + 4.5, cy + 3.2, tagText, { size: 9.5, bold: true, fill: color });
  } else {
    const tagStart = x + 6;
    inner += text(tagStart, cy + 3.2, tagText, { size: 9.5, bold: true, fill: color });
    drawPills(x + width - 3.5 - pillsWidth);
  }

  if (!peek) {
    return { svg: inner, width };
  }
  const targetLabel =
    targetScreen.title === `Screen ${targetScreen.index}`
      ? `Screen ${targetScreen.index}`
      : `Screen ${targetScreen.index}, ${targetScreen.title}`;
  const titleText = side === 'departure' ? `Jump to ${targetLabel}` : `Jump back to ${targetLabel}`;
  const svg =
    `<g class="pathway-jump-chip" data-jump-to="${esc(targetScreen.id)}" role="button" tabindex="0" aria-label="${esc(titleText)}">` +
    `<title>${esc(titleText)}</title>${inner}</g>`;
  return { svg, width };
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
  // A box the reviewer put on the row comes first, one they put below comes last; the rest keep their order.
  const rank = (screen: PathwayScreen): number => (screen.row_choice === 'continue' ? 0 : screen.row_choice === 'below' ? 2 : 1);
  for (const list of kids.values()) list.sort((a, b) => rank(a) - rank(b));
  /** The box that continues the row of `parent`, if any. */
  const onRow = (parent: PathwayScreen): PathwayScreen | undefined => {
    const first = kids.get(parent.id)?.[0];
    return first && first.row_choice !== 'below' ? first : undefined;
  };
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
      const next = onRow(screen);
      if (!next) break;
      if (col + 1 >= maxCols) {
        wraps.push(next);
        break;
      }
      screen = next;
      col += 1;
    }
    // Branches of this row come directly below it, before the row it wraps onto.
    for (const parent of inRow) {
      const at = placed.get(parent.id);
      if (!at) continue;
      const next = onRow(parent);
      for (const child of (kids.get(parent.id) ?? []).filter((kid) => kid !== next)) {
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

/** Lines that would overlap get different tracks: the lowest track where `[from, to]` (with optional padding) is free. */
function takeTrack(tracks: Array<Array<[number, number]>>, from: number, to: number, pad = 0): number {
  const lo = Math.min(from, to) - pad;
  const hi = Math.max(from, to) + pad;
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
}

function buildCard(
  screen: PathwayScreen,
  steps: Map<string, PathwayStep>,
  width: number,
  height: number,
  options: PathwayFigureOptions,
  imageFor: (step: PathwayStep) => string,
  measure: TextMeasurer,
  peek: boolean,
): Card {
  const screenSteps = screen.visits.flatMap((visit) => visit.step_ids).map((id) => steps.get(id)).filter((step): step is PathwayStep => Boolean(step));
  const stack = screen.visits.some((visit) => visit.step_ids.length > 1) ? STACK : 0;
  const many = screenSteps.length > 1;
  let svg = '';

  // The title and the notes are shown in full, however long: the row grows to fit them (see buildPathwayFigure).
  // When a screen has a custom title (so "Screen N" is no longer the title), pair it with a compact `S#` badge
  // so every box stays traceable to jump chips (`→ S#`), menus, and the status bar.
  const trimmedTitle = screen.title.trim();
  const screenBadge = `S${screen.index}`;
  const showScreenBadge = !new RegExp(`^screen\\s+${screen.index}\\b`, 'i').test(trimmedTitle);
  const badgeW = showScreenBadge ? Math.max(22, Math.ceil(measure(screenBadge, 9, true) + 10)) : 0;
  const firstWord = trimmedTitle.split(/\s+/)[0] ?? '';
  const inlineGap = 5;
  const inlineFirstWidth = width - badgeW - inlineGap;
  const badgeInline =
    showScreenBadge &&
    inlineFirstWidth >= 48 &&
    (measure(firstWord, 12, true) <= inlineFirstWidth || measure(firstWord, 12, true) > width);
  const titleLines = wrapText(screen.title, width, 12, true, measure, badgeInline ? inlineFirstWidth : width);
  const firstLineY = -9 - (titleLines.length - 1) * 15;
  if (showScreenBadge) {
    const badgeCy = badgeInline ? firstLineY - 4 : firstLineY - 19;
    svg +=
      `<rect x="0" y="${n1(badgeCy - 7)}" width="${n1(badgeW)}" height="14" rx="7" fill="#f3f3ef" stroke="#c8c8c2" stroke-width="0.9"/>` +
      text(badgeW / 2, badgeCy + 3, screenBadge, { size: 9, bold: true, fill: '#444', anchor: 'middle' });
  }
  titleLines.forEach((line, index) => {
    const lineX = badgeInline && index === 0 ? badgeW + inlineGap : 0;
    svg += text(lineX, -9 - (titleLines.length - 1 - index) * 15, line, { size: 12, bold: true, halo: true });
  });
  const above = 6 + titleLines.length * 15 + (showScreenBadge && !badgeInline ? 17 : 0);

  if (stack) svg += `<rect x="${stack}" y="${stack}" width="${width}" height="${height}" fill="#fff" stroke="${INK}" stroke-width="0.75"/>`;
  svg += `<rect width="${width}" height="${height}" fill="#f3f3f0"/>`;
  const image = steps.get(screen.image_step_id);
  if (image) {
    svg += `<image${peek ? ' data-screenshot=""' : ''} xlink:href="${esc(imageFor(image))}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`;
  }
  svg += `<rect width="${width}" height="${height}" fill="none" stroke="${INK}" stroke-width="0.75"${screen.kind === 'popup' ? ' stroke-dasharray="4 3"' : ''}/>`;
  // Which step the box shows while the pointer rests on a step number; hidden until then.
  if (peek) {
    svg +=
      '<g class="pathway-peek-tag" visibility="hidden">' +
      `<rect x="5" y="5" width="44" height="16" rx="8" fill="${INK}"/>` +
      text(27, 16, '', { size: 9.5, bold: true, fill: '#fff', anchor: 'middle' }) +
      '</g>';
  }

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
    const number = pill(x, cy, label) + (time ? text(x + pillW + 4, cy + 3.5, time, { size: 10, fill: SUB }) : '');
    // The steps of the visit, for the pointer preview. A transparent rect makes the gaps between the pill and its
    // time part of the target.
    svg += peek
      ? `<g data-peek="${esc(visit.step_ids.join(' '))}"><rect x="${n1(x - 2)}" y="${n1(cy - 9.5)}" width="${n1(pillW + timeWidth + 4)}" height="19" fill="transparent"/>${number}</g>`
      : number;
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
      const lines = wrapText(many ? `${number} ${note}` : note, width, 10.5, false, measure);
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
  return { svg, above, below: y + 4, stack };
}

// ── the figure ─────────────────────────────────────────────────────────────────────────────────

interface RenderedMove {
  transition: PathwayTransition;
  role: MoveRole;
  /** Painter's order: lower layers render first so main flow and branches sit cleanly on top of background buses. */
  layer: number;
  /** SVG fragments inside `<g id="move-...">`. */
  svg: string;
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

/** Draws a routed line with a white crossing halo underneath (and a wider transparent hit path on screen). */
function strokePath(d: string, role: MoveRole, peek: boolean, withArrow = true): string {
  const color = ROLE_COLOR[role];
  const width = role === 'return' ? 1.15 : 1.25;
  const dash = role === 'return' ? ' stroke-dasharray="5 3.5"' : '';
  const marker = withArrow ? ` marker-end="url(#pathway-arrow-${role})"` : '';
  const hit = peek ? `<path class="pathway-move-hit" d="${d}" fill="none" stroke="transparent" stroke-width="12"/>` : '';
  const halo = `<path class="pathway-move-halo" d="${d}" fill="none" stroke="#fff" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>`;
  const line = `<path class="pathway-move-line" d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dash}${marker}/>`;
  return hit + halo + line;
}

export function buildPathwayFigure(input: PathwayFigureInput): PathwayFigure {
  const { pathway, options, imageFor } = input;
  const measure = input.measure ?? measureText;
  const peek = Boolean(input.peek);
  const aspect = input.aspect > 0 ? input.aspect : 16 / 10;
  const width = Math.max(FRAME_MIN_WIDTH, Math.round(FRAME_SIZE * Math.sqrt(aspect)));
  const height = Math.round(width / aspect);
  const pitch = width + GAP_X;
  const maxCols = Math.max(2, Math.floor((TARGET_WIDTH - 2 * MARGIN + GAP_X) / pitch));

  const steps = new Map(pathway.steps.map((step) => [step.step_id, step]));
  const { placed, rows, cols } = placeScreens(pathway.screens, maxCols);
  const cards = new Map<string, Card>();
  for (const screen of pathway.screens) cards.set(screen.id, buildCard(screen, steps, width, height, options, imageFor, measure, peek));

  // Route planning: allocate horizontal bus tracks, vertical gutter tracks, and portal slots first,
  // because the allocated tracks decide row heights and outer margins.
  type Kind = 'straight' | 'elbow' | 'wrap' | 'wrap-portal' | 'over' | 'adjacent' | 'portal';
  interface Plan {
    transition: PathwayTransition;
    from: Placed;
    to: Placed;
    kind: Kind;
    role: MoveRole;
    /** Drawn against the direction of the tree link it follows (a move back to the screen it came from). */
    reversed: boolean;
    busFrom?: number;
    busTo?: number;
    sideTrack?: number;
    otherTrack?: number;
    /** Gutter column index (`0..cols-2` between cols, `-1` left of col 0, `cols-1` right of last col). */
    gutterCol?: number;
    gutterTrack?: number;
    /** Stagger index for side attachments on a screen. */
    sideExitIndex?: number;
    slotFrom?: number;
    slotTo?: number;
  }

  const busTracks: Array<Array<Array<[number, number]>>> = Array.from({ length: rows }, () => []);
  const sideTracks: Record<'left' | 'right', Array<Array<[number, number]>>> = { left: [], right: [] };
  const gutterTracks = new Map<number, Array<Array<[number, number]>>>();
  const takeGutter = (col: number, r1: number, r2: number): number => {
    let tracks = gutterTracks.get(col);
    if (!tracks) {
      tracks = [];
      gutterTracks.set(col, tracks);
    }
    return takeTrack(tracks, r1, r2, 0.05);
  };
  const topSlots = new Map<string, number>();
  const takeTopSlot = (id: string): number => {
    const slot = topSlots.get(id) ?? 0;
    topSlots.set(id, slot + 1);
    return slot;
  };
  const sideExits = new Map<string, number>();
  const takeSideExit = (key: string): number => {
    const slot = sideExits.get(key) ?? 0;
    sideExits.set(key, slot + 1);
    return slot;
  };

  let wrapLeftExtra = 0;
  let wrapRightExtra = 0;
  let wrapRightChipMax = 0;
  let hasBranch = false;
  let hasReturn = false;
  let hasPortal = false;
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
    const isReturn = transition.kind === 'return' || back;
    const passLabels = transition.passes.map((pass) => String(pass.step_index));
    const rowDelta = Math.abs(from.row - to.row);

    const plan: Plan = {
      transition,
      from,
      to,
      kind: 'over',
      role: isReturn ? 'return' : 'main',
      reversed: back,
    };

    if (forward || back) {
      if (child.wrapped) {
        if (child.row - parent.row >= 2) {
          plan.kind = 'wrap-portal';
          plan.role = isReturn ? 'return' : 'main';
          hasPortal = true;
          const depW = measurePortalChip(passLabels, `→ S${to.screen.index}`, measure).width;
          const arrW = measurePortalChip(passLabels, `S${from.screen.index} →`, measure).width;
          if (back) {
            wrapLeftExtra = Math.max(wrapLeftExtra, depW + 24);
            wrapRightExtra = Math.max(wrapRightExtra, arrW + 24);
          } else {
            wrapRightExtra = Math.max(wrapRightExtra, depW + 24);
            wrapLeftExtra = Math.max(wrapLeftExtra, arrW + 24);
          }
        } else {
          plan.kind = 'wrap';
          plan.role = isReturn ? 'return' : 'main';
          plan.busTo = takeTrack(busTracks[child.row] ?? [], LEFT, RIGHT);
          plan.sideTrack = takeTrack(sideTracks.right, parent.row, child.row);
          plan.otherTrack = takeTrack(sideTracks.left, child.row - 0.5, child.row);
          const rightTag = back ? `S${from.screen.index} →` : `→ S${to.screen.index}`;
          const rightChipW = measurePortalChip(passLabels, rightTag, measure).width;
          wrapRightChipMax = Math.max(wrapRightChipMax, rightChipW);
        }
      } else if (child.row === parent.row) {
        plan.kind = 'straight';
        plan.role = isReturn ? 'return' : 'main';
      } else {
        plan.kind = 'elbow';
        plan.role = isReturn ? 'return' : 'branch';
        plan.gutterCol = parent.col;
        plan.gutterTrack = takeGutter(parent.col, parent.row, child.row);
        plan.sideExitIndex = takeSideExit(`${parent.screen.id}:right:${back ? 'back' : 'fwd'}`);
      }
    } else if (rowDelta === 0) {
      plan.kind = 'over';
      plan.role = isReturn ? 'return' : 'branch';
      plan.slotFrom = takeTopSlot(from.screen.id);
      plan.slotTo = takeTopSlot(to.screen.id);
      plan.busTo = takeTrack(busTracks[to.row] ?? [], from.col, to.col, 0.08);
    } else if (rowDelta === 1) {
      // Adjacent-row non-tree move: route directly through the shared inter-row bus instead of the outer margin.
      plan.kind = 'adjacent';
      plan.role = isReturn ? 'return' : 'branch';
      const lowerRow = Math.max(from.row, to.row);
      const goingDown = to.row > from.row;
      const sideScreen = goingDown ? from : to;
      const otherScreen = goingDown ? to : from;
      // Pick the gutter on the side facing the other screen (falling back when at the outer edge).
      const useRightGutter =
        otherScreen.col > sideScreen.col
          ? true
          : otherScreen.col < sideScreen.col
            ? false
            : sideScreen.col < cols - 1;
      const gCol = useRightGutter ? sideScreen.col : sideScreen.col - 1;
      plan.gutterCol = gCol;
      plan.gutterTrack = takeGutter(gCol, from.row, to.row);
      plan.sideExitIndex = takeSideExit(`${sideScreen.screen.id}:${useRightGutter ? 'right' : 'left'}:adj`);
      if (goingDown) {
        plan.slotTo = takeTopSlot(to.screen.id);
        plan.busTo = takeTrack(busTracks[lowerRow] ?? [], gCol + 0.5, to.col, 0.12);
      } else {
        plan.slotFrom = takeTopSlot(from.screen.id);
        plan.busFrom = takeTrack(busTracks[lowerRow] ?? [], from.col, gCol + 0.5, 0.12);
      }
      if (gCol < 0) {
        sideTracks.left[0] ??= [];
      } else if (gCol >= cols - 1) {
        sideTracks.right[0] ??= [];
      }
    } else {
      // Distant multi-row jump (2+ rows apart): paired portal chips directly above departure & arrival cards.
      plan.kind = 'portal';
      plan.role = isReturn ? 'return' : 'branch';
      hasPortal = true;
      plan.slotFrom = takeTopSlot(from.screen.id);
      plan.slotTo = takeTopSlot(to.screen.id);
      const depSpan = Math.max(0.45, (measurePortalChip(passLabels, `→ S${to.screen.index}`, measure).width + 20) / pitch);
      const arrSpan = Math.max(0.45, (measurePortalChip(passLabels, `S${from.screen.index} →`, measure).width + 20) / pitch);
      plan.busFrom = takeTrack(busTracks[from.row] ?? [], from.col - 0.05, from.col + depSpan, 0.04);
      plan.busTo = takeTrack(busTracks[to.row] ?? [], to.col - 0.05, to.col + arrSpan, 0.04);
    }

    if (plan.role === 'branch') hasBranch = true;
    if (plan.role === 'return') hasReturn = true;
    plans.push(plan);
  }

  const leftSideSpace = sideTracks.left.length ? 16 + sideTracks.left.length * SIDE_TRACK : 0;
  const rightSidePad = wrapRightChipMax > 0 ? wrapRightChipMax + 24 : 16;
  const rightSideSpace = sideTracks.right.length ? rightSidePad + sideTracks.right.length * SIDE_TRACK : 0;
  const leftMargin = MARGIN + Math.max(leftSideSpace, wrapLeftExtra);
  const rightMargin = MARGIN + Math.max(rightSideSpace, wrapRightExtra);
  const figureWidth = Math.max(520, leftMargin + cols * width + (cols - 1) * GAP_X + STACK + rightMargin);
  const titleLines = wrapText(input.title, figureWidth - 2 * MARGIN, 17, true, measure);
  const subtitleLines = wrapText(input.subtitle, figureWidth - 2 * MARGIN, 10.5, false, measure);
  const subtitleY = 46 + Math.max(0, titleLines.length - 1) * 22 + 18;
  const headerBottom = subtitleY + Math.max(0, subtitleLines.length - 1) * 14;
  const inRow = (row: number): Card[] => [...placed.values()].filter((item) => item.row === row).map((item) => cards.get(item.screen.id)).filter((card): card is Card => Boolean(card));

  // Phases: each box goes with the phase of the step it was first reached with, and the boxes of one phase that sit
  // next to each other in a row get one bracket. The first bracket of a phase says how much it takes.
  const phases = pathway.phases ?? [];
  const phaseOf = new Map<string, number>();
  for (const screen of pathway.screens) {
    const first = steps.get(screen.visits[0]?.step_ids[0] ?? '');
    const index = first ? phases.findIndex((phase) => first.step_index >= phase.first_step_index && first.step_index <= phase.last_step_index) : -1;
    if (index >= 0) phaseOf.set(screen.id, index);
  }
  interface Bracket {
    phase: number;
    row: number;
    first: Placed;
    last: Placed;
    lines: Array<{ text: string; bold: boolean }>;
    /** The phase began before this bracket (on an earlier row, or before a box of another phase). */
    continues: boolean;
    /** The phase goes on after this bracket. */
    goesOn: boolean;
  }
  const brackets: Bracket[] = [];
  const labelled = new Set<number>();
  for (let row = 0; row < rows; row += 1) {
    const items = [...placed.values()].filter((item) => item.row === row).sort((a, b) => a.col - b.col);
    let open: { phase: number; first: Placed; last: Placed } | null = null;
    const close = () => {
      if (!open) return;
      const phase = phases[open.phase];
      if (!phase) return;
      const span = (open.last.col - open.first.col) * pitch + width + (cards.get(open.last.screen.id)?.stack ?? 0);
      const continues = labelled.has(open.phase);
      // A phase that goes on from an earlier bracket says so in grey, without its counts again.
      const lines = continues
        ? wrapText(`${phase.name}, continued`, span, 10, false, measure).map((text) => ({ text, bold: false }))
        : wrapText(phase.name, span, 10.5, true, measure).map((text) => ({ text, bold: true }));
      if (!continues) {
        labelled.add(open.phase);
        const counts =
          `${phase.step_count} ${phase.step_count === 1 ? 'step' : 'steps'} on ` +
          `${phase.screen_count} ${phase.screen_count === 1 ? 'screen' : 'screens'}` +
          (options.times && phase.duration_ms != null ? `, ${formatPathwayTime(phase.duration_ms)}` : '');
        lines.push(...wrapText(counts, span, 10, false, measure).map((text) => ({ text, bold: false })));
      }
      brackets.push({ phase: open.phase, row, first: open.first, last: open.last, lines, continues, goesOn: false });
      open = null;
    };
    for (const item of items) {
      const phase = phaseOf.get(item.screen.id);
      if (open && phase === open.phase && item.col === open.last.col + 1) {
        open.last = item;
        continue;
      }
      close();
      if (phase !== undefined) open = { phase, first: item, last: item };
    }
    close();
  }
  // Every bracket but a phase's last is left open on the right, as the phase goes on after it.
  brackets.forEach((bracket, index) => {
    bracket.goesOn = brackets.slice(index + 1).some((later) => later.phase === bracket.phase);
  });
  const bracketHeight = (bracket: Bracket): number => bracket.lines.length * PHASE_LINE + 15;

  const rowTop: number[] = [];
  const busBase: number[] = [];
  const phaseTop: number[] = [];
  let y = options.caption ? headerBottom + 28 : MARGIN;
  for (let row = 0; row < rows; row += 1) {
    const tracks = busTracks[row]?.length ?? 0;
    if (tracks) y += 22 + tracks * BUS_TRACK;
    busBase[row] = y - 18;
    phaseTop[row] = y;
    y += Math.max(0, ...brackets.filter((bracket) => bracket.row === row).map(bracketHeight));
    y += Math.max(0, ...inRow(row).map((card) => card.above));
    rowTop[row] = y;
    y += Math.max(0, ...inRow(row).map((card) => card.below)) + ROW_GAP;
  }
  const chartBottom = y - ROW_GAP;

  const left = (item: Placed): number => leftMargin + item.col * pitch;
  const right = (item: Placed): number => left(item) + width + (cards.get(item.screen.id)?.stack ?? 0);
  const top = (item: Placed): number => rowTop[item.row] ?? 0;
  const busY = (row: number, track: number): number => (busBase[row] ?? 0) - track * BUS_TRACK;
  const sideX = (side: 'left' | 'right', track: number): number =>
    side === 'left' ? leftMargin - 16 - track * SIDE_TRACK : figureWidth - rightMargin + rightSidePad + track * SIDE_TRACK;
  const gutterX = (col: number, track: number): number => {
    if (col < 0) return leftMargin - 18 - track * GUTTER_TRACK;
    const base = leftMargin + col * pitch + width + STACK + 20;
    const maxInGap = col < cols - 1 ? leftMargin + (col + 1) * pitch - 18 : figureWidth - 16;
    return Math.min(maxInGap, base + track * GUTTER_TRACK);
  };
  const slotX = (item: Placed, slot: number): number =>
    left(item) + width - 16 - (slot % Math.max(1, Math.floor((width - 32) / 14))) * 14;

  const renderedMoves: RenderedMove[] = [];
  for (const plan of plans) {
    const { from, to, transition, role } = plan;
    const color = ROLE_COLOR[role];
    const passLabels = transition.passes.map((pass) => String(pass.step_index));
    let svg = '';
    let layer = 1;

    if (plan.kind === 'straight') {
      layer = 4;
      const parent = plan.reversed ? to : from;
      const child = plan.reversed ? from : to;
      const lineY = top(parent) + height * (plan.reversed ? 0.52 : 0.32);
      const pts: Array<[number, number]> = plan.reversed
        ? [[left(child), lineY], [right(parent) + 2, lineY]]
        : [[right(parent), lineY], [left(child) - 2, lineY]];
      svg += strokePath(roundedPath(pts), role, peek);
      svg += pillRow((right(parent) + left(child)) / 2, lineY, passLabels, color);
    } else if (plan.kind === 'elbow') {
      layer = 3;
      const parent = plan.reversed ? to : from;
      const child = plan.reversed ? from : to;
      const trunk = gutterX(plan.gutterCol ?? parent.col, plan.gutterTrack ?? 0);
      const stagger = (plan.sideExitIndex ?? 0) * 14;
      if (plan.reversed) {
        const childY = top(child) + height * 0.52;
        const parentY = Math.min(top(parent) + height - 10, top(parent) + height * 0.72 + stagger);
        const pts: Array<[number, number]> = [[left(child), childY], [trunk, childY], [trunk, parentY], [right(parent) + 2, parentY]];
        svg += strokePath(roundedPath(pts), role, peek);
        const pillX = Math.max(trunk + 20, (trunk + left(child)) / 2);
        svg += pillRow(pillX, childY, passLabels, color);
      } else {
        const childY = top(child) + height * 0.32;
        const parentY = Math.min(top(parent) + height - 14, top(parent) + height * 0.64 + stagger);
        const pts: Array<[number, number]> = [[right(parent), parentY], [trunk, parentY], [trunk, childY], [left(child) - 2, childY]];
        svg += strokePath(roundedPath(pts), role, peek);
        const pillX = Math.max(trunk + 20, (trunk + left(child)) / 2);
        svg += pillRow(pillX, childY, passLabels, color);
      }
    } else if (plan.kind === 'wrap') {
      layer = 1;
      const parent = plan.reversed ? to : from;
      const child = plan.reversed ? from : to;
      const offset = plan.reversed ? 0.52 : 0.32;
      const rightX = sideX('right', plan.sideTrack ?? 0);
      const leftX = sideX('left', plan.otherTrack ?? 0);
      const channel = busY(child.row, plan.busTo ?? 0);
      const forwardPts: Array<[number, number]> = [
        [right(parent), top(parent) + height * offset],
        [rightX, top(parent) + height * offset],
        [rightX, channel],
        [leftX, channel],
        [leftX, top(child) + height * offset],
        [left(child), top(child) + height * offset],
      ];
      const pts = plan.reversed ? forwardPts.reverse() : forwardPts;
      const end = pts[pts.length - 1] as [number, number];
      pts[pts.length - 1] = [end[0] + (plan.reversed ? 2 : -2), end[1]];
      svg += strokePath(roundedPath(pts), role, peek);

      // Label BOTH ends of a wrap: parent-side chip sits directly on parent's right edge (never hovering over
      // the unrelated screen on the next row); child-side chip sits on the inter-row channel above child.
      const arrTag = `S${from.screen.index} →`;
      const depTag = `→ S${to.screen.index}`;
      const parentY = top(parent) + height * offset;
      const rightChipX = right(parent) + 12;
      const leftChipX = left(child) + 4;
      if (plan.reversed) {
        svg += renderPortalChip({
          x: leftChipX,
          cy: channel,
          labels: passLabels,
          tagText: depTag,
          side: 'departure',
          role,
          measure,
          targetScreen: to.screen,
          peek,
        }).svg;
        svg += renderPortalChip({
          x: rightChipX,
          cy: parentY,
          labels: passLabels,
          tagText: arrTag,
          side: 'arrival',
          role,
          measure,
          targetScreen: from.screen,
          peek,
        }).svg;
      } else {
        svg += renderPortalChip({
          x: leftChipX,
          cy: channel,
          labels: passLabels,
          tagText: arrTag,
          side: 'arrival',
          role,
          measure,
          targetScreen: from.screen,
          peek,
        }).svg;
        svg += renderPortalChip({
          x: rightChipX,
          cy: parentY,
          labels: passLabels,
          tagText: depTag,
          side: 'departure',
          role,
          measure,
          targetScreen: to.screen,
          peek,
        }).svg;
      }
    } else if (plan.kind === 'wrap-portal') {
      layer = 2;
      const parent = plan.reversed ? to : from;
      const child = plan.reversed ? from : to;
      const offset = plan.reversed ? 0.52 : 0.32;
      const depTag = `→ S${to.screen.index}`;
      const arrTag = `S${from.screen.index} →`;
      const depW = measurePortalChip(passLabels, depTag, measure).width;
      const arrW = measurePortalChip(passLabels, arrTag, measure).width;
      const parentY = top(parent) + height * offset;
      const childY = top(child) + height * offset;

      if (plan.reversed) {
        // Departing left edge of child -> arriving right edge of parent
        const depChipX = left(child) - 16 - depW;
        svg += strokePath(roundedPath([[left(child), childY], [depChipX + depW + 2, childY]]), role, peek);
        svg += renderPortalChip({
          x: depChipX,
          cy: childY,
          labels: passLabels,
          tagText: depTag,
          side: 'departure',
          role,
          measure,
          targetScreen: to.screen,
          peek,
        }).svg;

        const arrChipX = right(parent) + 16;
        svg += strokePath(roundedPath([[arrChipX, parentY], [right(parent) + 2, parentY]]), role, peek);
        svg += renderPortalChip({
          x: arrChipX,
          cy: parentY,
          labels: passLabels,
          tagText: arrTag,
          side: 'arrival',
          role,
          measure,
          targetScreen: from.screen,
          peek,
        }).svg;
      } else {
        // Departing right edge of parent -> arriving left edge of child
        const depChipX = right(parent) + 16;
        svg += strokePath(roundedPath([[right(parent), parentY], [depChipX - 2, parentY]]), role, peek);
        svg += renderPortalChip({
          x: depChipX,
          cy: parentY,
          labels: passLabels,
          tagText: depTag,
          side: 'departure',
          role,
          measure,
          targetScreen: to.screen,
          peek,
        }).svg;

        const arrChipX = left(child) - 16 - arrW;
        svg += strokePath(roundedPath([[arrChipX + arrW, childY], [left(child) - 2, childY]]), role, peek);
        svg += renderPortalChip({
          x: arrChipX,
          cy: childY,
          labels: passLabels,
          tagText: arrTag,
          side: 'arrival',
          role,
          measure,
          targetScreen: from.screen,
          peek,
        }).svg;
      }
    } else if (plan.kind === 'over') {
      layer = 2;
      const fromX = slotX(from, plan.slotFrom ?? 0);
      const toX = slotX(to, plan.slotTo ?? 0);
      const toBus = busY(to.row, plan.busTo ?? 0);
      const pts: Array<[number, number]> = [[fromX, top(from)], [fromX, toBus], [toX, toBus], [toX, top(to) - 2]];
      svg += strokePath(roundedPath(pts), role, peek);

      const span = Math.abs(fromX - toX);
      if (Math.abs(from.col - to.col) >= 3 && span >= 260) {
        // Long horizontal jump: label both ends so scrolling horizontally never loses the source/target.
        const depTag = `→ S${to.screen.index}`;
        const arrTag = `S${from.screen.index} →`;
        const depW = measurePortalChip(passLabels, depTag, measure).width;
        const arrW = measurePortalChip(passLabels, arrTag, measure).width;
        const goingRight = toX > fromX;
        const depX = goingRight ? fromX + 12 : fromX - 12 - depW;
        const arrX = goingRight ? toX - 12 - arrW : toX + 12;
        svg += renderPortalChip({
          x: depX,
          cy: toBus,
          labels: passLabels,
          tagText: depTag,
          side: 'departure',
          role,
          measure,
          targetScreen: to.screen,
          peek,
        }).svg;
        svg += renderPortalChip({
          x: arrX,
          cy: toBus,
          labels: passLabels,
          tagText: arrTag,
          side: 'arrival',
          role,
          measure,
          targetScreen: from.screen,
          peek,
        }).svg;
      } else {
        const pillX = span < 60 ? (fromX + toX) / 2 : toX + Math.sign(fromX - toX) * 32;
        svg += pillRow(pillX, toBus, passLabels, color);
      }
    } else if (plan.kind === 'adjacent') {
      layer = 1;
      const goingDown = to.row > from.row;
      const gCol = plan.gutterCol ?? from.col;
      const gX = gutterX(gCol, plan.gutterTrack ?? 0);
      const stagger = (plan.sideExitIndex ?? 0) * 14;
      let channelY = 0;
      let startX = 0;
      let endX = 0;

      if (goingDown) {
        const useRight = gCol === from.col;
        const fromEdge = useRight ? right(from) : left(from);
        const sideY = Math.min(top(from) + height - 12, top(from) + height * 0.62 + stagger);
        const toX = slotX(to, plan.slotTo ?? 0);
        channelY = busY(to.row, plan.busTo ?? 0);
        const pts: Array<[number, number]> = [
          [fromEdge, sideY],
          [gX, sideY],
          [gX, channelY],
          [toX, channelY],
          [toX, top(to) - 2],
        ];
        svg += strokePath(roundedPath(pts), role, peek);
        startX = gX;
        endX = toX;
      } else {
        const useRight = gCol === to.col;
        const toEdge = useRight ? right(to) + 2 : left(to) - 2;
        const sideY = Math.min(top(to) + height - 12, top(to) + height * 0.56 + stagger);
        const fromX = slotX(from, plan.slotFrom ?? 0);
        channelY = busY(from.row, plan.busFrom ?? 0);
        const pts: Array<[number, number]> = [
          [fromX, top(from)],
          [fromX, channelY],
          [gX, channelY],
          [gX, sideY],
          [toEdge, sideY],
        ];
        svg += strokePath(roundedPath(pts), role, peek);
        startX = fromX;
        endX = gX;
      }

      const span = Math.abs(endX - startX);
      const depTag = `→ S${to.screen.index}`;
      const arrTag = `S${from.screen.index} →`;
      const depW = measurePortalChip(passLabels, depTag, measure).width;
      const arrW = measurePortalChip(passLabels, arrTag, measure).width;
      if (span >= depW + arrW + 36) {
        const goingRight = endX > startX;
        const depX = goingRight ? startX + 10 : startX - 10 - depW;
        const arrX = goingRight ? endX - 10 - arrW : endX + 10;
        svg += renderPortalChip({
          x: depX,
          cy: channelY,
          labels: passLabels,
          tagText: depTag,
          side: 'departure',
          role,
          measure,
          targetScreen: to.screen,
          peek,
        }).svg;
        svg += renderPortalChip({
          x: arrX,
          cy: channelY,
          labels: passLabels,
          tagText: arrTag,
          side: 'arrival',
          role,
          measure,
          targetScreen: from.screen,
          peek,
        }).svg;
      } else {
        const midX = (startX + endX) / 2;
        svg += renderPortalChip({
          x: Math.max(8, Math.min(figureWidth - depW - 8, midX - depW / 2)),
          cy: channelY,
          labels: passLabels,
          tagText: depTag,
          side: 'departure',
          role,
          measure,
          targetScreen: to.screen,
          peek,
        }).svg;
      }
    } else {
      // Distant multi-row jump (`portal`): paired departure & arrival chips right above each screen.
      layer = 2;
      const fromX = slotX(from, plan.slotFrom ?? 0);
      const toX = slotX(to, plan.slotTo ?? 0);
      const depY = busY(from.row, plan.busFrom ?? 0);
      const arrY = busY(to.row, plan.busTo ?? 0);
      const depTag = `→ S${to.screen.index}`;
      const arrTag = `S${from.screen.index} →`;
      const depW = measurePortalChip(passLabels, depTag, measure).width;
      const arrW = measurePortalChip(passLabels, arrTag, measure).width;

      // Departure stem rising from `from` into departure chip
      const depChipX = Math.max(8, Math.min(figureWidth - depW - 8, left(from)));
      const depTargetX = fromX >= depChipX + depW ? depChipX + depW + 2 : fromX <= depChipX ? depChipX - 2 : fromX;
      const depPts: Array<[number, number]> =
        depTargetX === fromX
          ? [[fromX, top(from)], [fromX, depY + 9.5]]
          : [[fromX, top(from)], [fromX, depY], [depTargetX, depY]];
      svg += strokePath(roundedPath(depPts), role, peek, false);
      svg += renderPortalChip({
        x: depChipX,
        cy: depY,
        labels: passLabels,
        tagText: depTag,
        side: 'departure',
        role,
        measure,
        targetScreen: to.screen,
        peek,
      }).svg;

      // Arrival chip dropping straight down into `to`
      const arrChipX = Math.max(8, Math.min(figureWidth - arrW - 8, left(to)));
      const arrStartX = toX >= arrChipX + arrW ? arrChipX + arrW : toX <= arrChipX ? arrChipX : toX;
      const arrPts: Array<[number, number]> =
        arrStartX === toX
          ? [[toX, arrY + 9.5], [toX, top(to) - 2]]
          : [[arrStartX, arrY], [toX, arrY], [toX, top(to) - 2]];
      svg += strokePath(roundedPath(arrPts), role, peek, true);
      svg += renderPortalChip({
        x: arrChipX,
        cy: arrY,
        labels: passLabels,
        tagText: arrTag,
        side: 'arrival',
        role,
        measure,
        targetScreen: from.screen,
        peek,
      }).svg;
    }

    renderedMoves.push({ transition, role, layer, svg });
  }

  // Paint background routes before foreground branches and main flow so white crossing halos layer cleanly.
  renderedMoves.sort((a, b) => a.layer - b.layer);

  // ── markup ──
  let body = '';
  if (options.caption) {
    body += '<g id="header">';
    titleLines.forEach((line, index) => { body += text(MARGIN, 46 + index * 22, line, { size: 17, bold: true }); });
    subtitleLines.forEach((line, index) => { body += text(MARGIN, subtitleY + index * 14, line, { size: 10.5, fill: SUB }); });
    body += '</g>';
  }
  body += '<g id="moves">';
  const seenMoveIds = new Map<string, number>();
  for (const move of renderedMoves) {
    const { transition, role } = move;
    const baseId = `move-${transition.from_screen}-${transition.to_screen}${role === 'return' ? '-ret' : ''}`;
    const count = seenMoveIds.get(baseId) ?? 0;
    seenMoveIds.set(baseId, count + 1);
    const moveId = count === 0 ? baseId : `${baseId}-${count + 1}`;
    const stepList = transition.passes.map((pass) => pass.step_index).join(', ');
    const interactive = peek
      ? ` data-move="" data-from="${esc(transition.from_screen)}" data-to="${esc(transition.to_screen)}" data-role="${role}" data-steps="${esc(stepList)}"`
      : '';
    body += `<g id="${esc(moveId)}"${interactive}>${move.svg}</g>`;
  }
  body += '</g>';
  if (brackets.length) {
    body += '<g id="phases">';
    for (const bracket of brackets) {
      const x1 = left(bracket.first);
      const x2 = right(bracket.last);
      const topY = phaseTop[bracket.row] ?? 0;
      bracket.lines.forEach((line, index) => {
        body += text(x1, topY + 10 + index * PHASE_LINE, line.text, line.bold
          ? { size: 10.5, bold: true, halo: true }
          : { size: 10, fill: SUB, halo: true });
      });
      const lineY = topY + bracket.lines.length * PHASE_LINE + 4;
      // A closed end turns down; an open end runs on as a short dashed line, where the phase continues.
      const start = bracket.continues ? `M${n1(x1)} ${n1(lineY)}` : `M${n1(x1)} ${n1(lineY + 5)} V${n1(lineY)}`;
      const end = bracket.goesOn ? '' : ` V${n1(lineY + 5)}`;
      body += `<path d="${start} H${n1(x2)}${end}" fill="none" stroke="${INK}" stroke-width="0.9"/>`;
      if (bracket.continues) body += `<path d="M${n1(x1 - 12)} ${n1(lineY)} H${n1(x1 - 2)}" fill="none" stroke="${INK}" stroke-width="0.9" stroke-dasharray="2 2"/>`;
      if (bracket.goesOn) body += `<path d="M${n1(x2 + 2)} ${n1(lineY)} H${n1(x2 + 12)}" fill="none" stroke="${INK}" stroke-width="0.9" stroke-dasharray="2 2"/>`;
      if (peek) {
        // on the page, the bracket can be clicked to change its phase
        body += `<rect data-phase="${bracket.phase}" x="${n1(x1)}" y="${n1(topY)}" width="${n1(Math.max(1, x2 - x1))}" height="${n1(lineY + 6 - topY)}" fill="transparent"/>`;
      }
    }
    body += '</g>';
  }
  body += '<g id="screens">';
  for (const item of placed.values()) {
    const card = cards.get(item.screen.id);
    if (!card) continue;
    const selected =
      input.highlight === item.screen.id
        ? `<rect x="-5" y="-5" width="${width + card.stack + 10}" height="${height + card.stack + 10}" fill="none" stroke="#cd6d1e" stroke-width="2.5"/>`
        : '';
    // On the page a box can be reached with the keyboard: Enter selects it, the menu key opens its actions.
    const reachable = peek
      ? ` tabindex="0" role="button" aria-label="${esc(`Screen ${item.screen.index}${item.screen.title !== `Screen ${item.screen.index}` ? `, ${item.screen.title}` : ''}`)}"`
      : '';
    body += `<g id="${esc(item.screen.id)}" data-screen="${esc(item.screen.id)}"${reachable} transform="translate(${n1(left(item))} ${n1(top(item))})">${card.svg}${selected}</g>`;
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

  const hasPopup = pathway.screens.some((screen) => screen.kind === 'popup');
  if (options.caption) {
    const arrow = (role: MoveRole) => (x: number, cy: number): string =>
      `<line x1="${n1(x)}" y1="${n1(cy)}" x2="${n1(x + 26)}" y2="${n1(cy)}" stroke="${ROLE_COLOR[role]}" stroke-width="${role === 'return' ? 1.15 : 1.25}"${role === 'return' ? ' stroke-dasharray="5 3.5"' : ''} marker-end="url(#pathway-arrow-${role})"/>`;
    const items: Array<[(x: number, cy: number) => string, number, string]> = [
      [(x, cy) => pill(x, cy, '2'), 15, 'step number, as in steps.csv'],
      [arrow('main'), 28, 'move to another screen, numbered by the step it leads to'],
    ];
    if (hasBranch) items.push([arrow('branch'), 28, 'branch or detour to another path']);
    if (hasReturn) items.push([arrow('return'), 28, 'return to an earlier screen']);
    if (hasPortal) {
      items.push([
        (x, cy) =>
          `<rect x="${n1(x)}" y="${n1(cy - 8)}" width="34" height="16" rx="8" fill="#fff" stroke="${BRANCH_COLOR}" stroke-width="1.1"/>` +
          text(x + 17, cy + 3, '→ S7', { size: 8.5, bold: true, fill: BRANCH_COLOR, anchor: 'middle' }),
        34,
        'jump across rows (screen number at each end)',
      ]);
    }
    if (brackets.length) {
      items.push([
        (x, cy) => `<path d="M${n1(x)} ${n1(cy + 4)} V${n1(cy - 2)} H${n1(x + 24)} V${n1(cy + 4)}" fill="none" stroke="${INK}" stroke-width="0.9"/>`,
        24,
        'phase of the walkthrough, with how many steps and screens it takes',
      ]);
    }
    if (hasPopup) {
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

  const arrowDef = (role: MoveRole) =>
    `<marker id="pathway-arrow-${role}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1.5 L9 5 L1 8.5 Z" fill="${ROLE_COLOR[role]}"/></marker>`;
  const w = Math.ceil(figureWidth);
  const h = Math.ceil(figureHeight);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${esc(FONT)}" fill="${INK}">` +
    `<title>${esc(input.title)}</title>` +
    `<defs>${arrowDef('main')}${arrowDef('branch')}${arrowDef('return')}</defs>` +
    `<rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
  return {
    svg,
    width: w,
    height: h,
    encodings: { hasBranch, hasReturn, hasPortal, hasPopup },
  };
}
