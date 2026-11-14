import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

import { APP_VERSION } from '../../lib/buildInfo';
import { ART_HEIGHT as H, ART_WIDTH as W, MockArt } from './MockArt';
import { MOCK_STEPS, mockStep, type MockPathway as Pathway, type MockScreen } from './tutorialModel';

export type MockNotes = 'under' | 'key' | 'hidden';
export type ScreenMark = 'good' | 'bad';

export interface MockPathwayProps {
  pathway: Pathway;
  /** `line`: the steps in time order, as the recording has them; `chart`: folded into the pathway. */
  view: 'line' | 'chart';
  notes?: MockNotes;
  times?: boolean;
  caption?: boolean;
  /** The step the walk through the journey is at. */
  current?: number | null;
  /** The box, or boxes, outlined as selected. */
  selected?: number | number[] | null;
  marks?: Record<number, ScreenMark>;
  /** A short explanation next to a step's number. */
  bubble?: { step: number; text: string } | null;
  /** A step whose screenshot is brought to the front of its box. */
  spotlight?: number | null;
  /** What "show me" is about to use, shaded green: `pill:<step>` or `box:<box>`. */
  demo?: string | null;
  /** What can be clicked: the boxes, the step numbers, or nothing. */
  clickable?: 'screens' | 'steps' | null;
  onScreen?: (screenId: number) => void;
  onStep?: (step: number) => void;
}

export const DESIGN_WIDTH = 760;
const LEFT = 22;
const PITCH = 92;
const PILL = 15;
const INK = '#111';
const ORANGE = '#cd6d1e';
const GREEN = '#48af7c';

const stackOf = (screen: MockScreen) => Math.min(2, screen.steps.length - 1) * 3;

function wrap(text: string, chars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && `${line} ${word}`.length > chars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function Pill({ n, active = false }: { n: number | string; active?: boolean }) {
  const label = String(n);
  const width = label.length > 1 ? label.length * 6.2 + 9 : PILL;
  return (
    <g>
      <rect fill={active ? ORANGE : INK} height={PILL} rx={7.5} width={width} />
      <text fill="#fff" fontSize={9.5} fontWeight={700} textAnchor="middle" x={width / 2} y={10.8}>
        {label}
      </text>
    </g>
  );
}

function activate(handler: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: handler,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handler();
      }
    },
  } as const;
}

/**
 * The practice pathway, drawn like the app's figure. Every step is one card that glides between its place in
 * time (the line) and its place in the chart, so folding and regrouping can be watched; arrows are drawn
 * again once the cards have arrived.
 */
export function MockPathway({
  pathway,
  view,
  notes = 'under',
  times = false,
  caption = false,
  current = null,
  selected = null,
  marks = {},
  bubble = null,
  spotlight = null,
  demo = null,
  clickable = null,
  onScreen,
  onStep,
}: MockPathwayProps) {
  const markerId = `pt-arrow-${useId().replace(/:/g, '')}`;
  const chart = view === 'chart';
  // Resting the pointer on a step's number brings its screenshot to the front of its box: a box shows the
  // first step only, so this is how the others in a stack can be seen.
  const [hovered, setHovered] = useState<number | null>(null);
  const front = chart && hovered !== null ? hovered : spotlight;
  const selectedIds = new Set(selected === null ? [] : Array.isArray(selected) ? selected : [selected]);
  const top = caption && chart ? 76 : 40;
  const pillsBlock = times ? 3 * 15 + 2 : 18;
  const notesBlock = notes === 'under' ? 36 : 0;
  const rowPitch = H + 12 + pillsBlock + notesBlock + 34;
  const rowTop = (row: number) => top + row * rowPitch;
  const screens = new Map(pathway.screens.map((screen) => [screen.id, screen]));
  const screenOfStep = (n: number) => screens.get(pathway.screenOf.get(n) ?? 0);
  // The chart spreads its columns over the width (the recording keeps its steps close together).
  const chartPitch = pathway.cols > 1 ? Math.min(168, (DESIGN_WIDTH - 2 * LEFT - W - 8) / (pathway.cols - 1)) : 168;
  const chartWidth = (pathway.cols - 1) * chartPitch + W + 8;
  const chartLeft = caption ? LEFT : Math.max(LEFT, (DESIGN_WIDTH - chartWidth) / 2);
  const boxX = (screen: MockScreen) => chartLeft + screen.col * chartPitch;

  // Where every step's card and number go.
  const card = (n: number) => {
    if (!chart) return { x: LEFT + (n - 1) * PITCH, y: rowTop(0) };
    const screen = screenOfStep(n);
    if (!screen) return { x: 0, y: 0 };
    const k = Math.min(2, screen.steps.indexOf(n));
    return { x: boxX(screen) + k * 3, y: rowTop(screen.row) + k * 3 };
  };
  const pill = (n: number) => {
    if (!chart) return { x: LEFT + (n - 1) * PITCH, y: rowTop(0) + H + 10 };
    const screen = screenOfStep(n);
    if (!screen) return { x: 0, y: 0 };
    const k = screen.steps.indexOf(n);
    const y = rowTop(screen.row) + H + 12;
    return times ? { x: boxX(screen), y: y + k * 15 } : { x: boxX(screen) + k * 18, y };
  };

  // The moves, routed like the app's figure: along the tree between the sides of the boxes, everything else
  // over the top of the row.
  let track = 0;
  const routes = chart
    ? pathway.moves.map((move) => {
        const from = screens.get(move.from);
        const to = screens.get(move.to);
        if (!from || !to) return null;
        const box = (screen: MockScreen) => {
          const x = boxX(screen);
          const y = rowTop(screen.row);
          return { x, y, r: x + W + stackOf(screen) };
        };
        const a = box(from);
        const b = box(to);
        const forward = to.reachedFrom === from.id;
        const back = from.reachedFrom === to.id;
        let d: string;
        let px: number;
        let py: number;
        if ((forward || back) && from.row === to.row) {
          const y = forward ? a.y + H * 0.3 : b.y + H * 0.62;
          d = forward ? `M${a.r} ${y}H${b.x - 2}` : `M${a.x} ${y}H${b.r + 2}`;
          px = forward ? (a.r + b.x) / 2 : (a.x + b.r) / 2;
          py = y;
        } else if (forward) {
          const y1 = a.y + H * 0.8;
          const trunk = a.r + 14;
          const y2 = b.y + H * 0.3;
          d = `M${a.r} ${y1}H${trunk - 6}Q${trunk} ${y1} ${trunk} ${y1 + 6}V${y2 - 6}Q${trunk} ${y2} ${trunk + 6} ${y2}H${b.x - 2}`;
          px = (trunk + b.x) / 2;
          py = y2;
        } else if (back) {
          const y1 = a.y + H * 0.62;
          const trunk = b.r + 24;
          const y2 = b.y + H * 0.92;
          d = `M${a.x} ${y1}H${trunk + 6}Q${trunk} ${y1} ${trunk} ${y1 - 6}V${y2 + 6}Q${trunk} ${y2} ${trunk - 6} ${y2}H${b.r + 2}`;
          px = (trunk + a.x) / 2;
          py = y1;
        } else {
          const lane = track++;
          // Down into the right of the box, clear of the start of its title.
          const sx = a.x + W - 9 - lane * 5;
          const tx = b.x + W - 9 - lane * 5;
          const busTo = rowTop(to.row) - 20 - lane * 7;
          if (from.row === to.row) {
            d = `M${sx} ${a.y}V${busTo}H${tx}V${b.y - 2}`;
          } else {
            const busFrom = rowTop(from.row) - 20 - lane * 7;
            const corridor = 8 + lane * 5;
            d = `M${sx} ${a.y}V${busFrom}H${corridor}V${busTo}H${tx}V${b.y - 2}`;
          }
          px = tx + (sx > tx ? 26 : -26);
          py = busTo;
        }
        return { move, d, px, py };
      })
    : [];

  // As tall as the chart in both views, so the panel does not jump when the recording folds into it.
  const chartBottom = rowTop(pathway.rows - 1) + H + 12 + pillsBlock + notesBlock;
  const noted = MOCK_STEPS.filter((step) => step.note);
  const keyTop = chartBottom + 14;
  const keyHeight = chart && notes === 'key' ? 18 + noted.length * 16 : 0;
  const legendTop = chartBottom + 14 + keyHeight + (keyHeight ? 8 : 0);
  const height = Math.max(caption && chart ? legendTop + 60 : chartBottom + keyHeight + 24, rowTop(0) + H + 66);

  const lineArrows: ReactNode[] = [];
  if (!chart) {
    for (let n = 1; n < MOCK_STEPS.length; n += 1) {
      const y = rowTop(0) + H * 0.45;
      lineArrows.push(
        <path d={`M${LEFT + (n - 1) * PITCH + W + 4} ${y}H${LEFT + n * PITCH - 6}`} key={n} markerEnd={`url(#${markerId})`} stroke="#9a9a93" strokeWidth={1} />,
      );
    }
  }

  // The explanation opens below the step's number, or above it when the number is near the bottom.
  const bubbleAt = bubble ? pill(bubble.step) : null;
  const bubbleUp = bubbleAt ? bubbleAt.y + 22 + 80 > height : false;

  return (
    <div className="pt-mock-wrap">
    <svg className="pt-mock" role="img" viewBox={`0 0 ${DESIGN_WIDTH} ${height}`} aria-label={chart ? 'the practice pathway' : 'the practice recording, step by step'}>
      <defs>
        <marker id={markerId} markerHeight={7} markerWidth={7} orient="auto-start-reverse" refX={9} refY={5} viewBox="0 0 10 10">
          <path d="M1 1.5 L9 5 L1 8.5 Z" fill="context-stroke" />
        </marker>
      </defs>

      {caption && chart ? (
        <g className="pt-fade">
          <text fontSize={15} fontWeight={700} x={LEFT} y={26}>
            practice recording: turning on notifications
          </text>
          <text fill="#6b6b66" fontSize={10} x={LEFT} y={44}>
            8 steps on {pathway.screens.length} screens · 0:34
          </text>
        </g>
      ) : null}

      {/* the line in time */}
      <g className={`pt-fade ${chart ? 'out' : ''}`} fill="none">
        {lineArrows}
      </g>
      {!chart ? (
        <g className="pt-fade">
          <line stroke="#c9c9c3" x1={LEFT} x2={LEFT + (MOCK_STEPS.length - 1) * PITCH + W} y1={rowTop(0) + H + 44} y2={rowTop(0) + H + 44} />
          {MOCK_STEPS.map((step) => (
            <g key={step.n}>
              <line stroke="#c9c9c3" x1={LEFT + (step.n - 1) * PITCH + W / 2} x2={LEFT + (step.n - 1) * PITCH + W / 2} y1={rowTop(0) + H + 40} y2={rowTop(0) + H + 48} />
              <text fill="#6b6b66" fontSize={9.5} textAnchor="middle" x={LEFT + (step.n - 1) * PITCH + W / 2} y={rowTop(0) + H + 60}>
                {step.time}
              </text>
            </g>
          ))}
        </g>
      ) : null}

      {/* the moves */}
      <g fill="none">
        {routes.map((route) => {
          if (!route) return null;
          const hot = current !== null && route.move.passes.includes(current);
          return (
            <g className="pt-arrow" key={`${route.move.from}>${route.move.to}|${route.d}`}>
              <path
                d={route.d}
                markerEnd={`url(#${markerId})`}
                stroke={hot ? ORANGE : INK}
                strokeDasharray={route.move.kind === 'return' ? '5 4' : undefined}
                strokeWidth={hot ? 2 : 1.1}
              />
              <g transform={`translate(${route.px - (route.move.passes.length * 17 - 2) / 2} ${route.py - 7.5})`}>
                {route.move.passes.map((n, index) => (
                  <g key={n} transform={`translate(${index * 17} 0)`}>
                    <Pill active={n === current} n={n} />
                  </g>
                ))}
              </g>
            </g>
          );
        })}
      </g>

      {/* titles above the boxes */}
      {pathway.screens.map((screen) => (
        <text
          className={`pt-move pt-fade ${chart ? '' : 'out'}`}
          fontSize={11}
          fontWeight={700}
          key={`title${screen.id}`}
          paintOrder="stroke"
          stroke="#fff"
          strokeLinejoin="round"
          strokeWidth={4}
          style={{ transform: `translate(${boxX(screen)}px, ${rowTop(screen.row) - 7}px)` }}
        >
          {screen.title}
        </text>
      ))}

      {/* the cards: later steps first, so the first step of a box lies on top */}
      {[...MOCK_STEPS].reverse().map((step) => {
        const at = card(step.n);
        const screen = screenOfStep(step.n);
        const popup = chart && screen?.popup;
        return (
          <g className="pt-move" key={`card${step.n}`} style={{ transform: `translate(${at.x}px, ${at.y}px)` }}>
            <MockArt art={step.art} />
            <rect fill="none" height={H} stroke={INK} strokeDasharray={popup ? '4 3' : undefined} strokeWidth={0.8} width={W} />
          </g>
        );
      })}

      {/* the step being looked at, on top of its box */}
      {front !== null && chart && screenOfStep(front) ? (() => {
        const screen = screenOfStep(front);
        if (!screen) return null;
        return (
          <g className="pt-spotlight" key={`spot${front}`} transform={`translate(${boxX(screen)} ${rowTop(screen.row)})`}>
            <MockArt art={mockStep(front).art} />
            <rect fill="none" height={H} stroke={INK} strokeDasharray={screen.popup ? '4 3' : undefined} strokeWidth={0.8} width={W} />
          </g>
        );
      })() : null}

      {/* the step numbers, with the label (line) or the time (chart) */}
      {MOCK_STEPS.map((step) => {
        const at = pill(step.n);
        const handler = clickable === 'steps' && onStep ? activate(() => onStep(step.n)) : {};
        return (
          <g
            className={`pt-move ${clickable === 'steps' ? 'pt-clickable' : chart ? 'pt-peek' : ''}`}
            key={`pill${step.n}`}
            onBlur={() => setHovered(null)}
            onFocus={() => setHovered(step.n)}
            onMouseEnter={() => setHovered(step.n)}
            onMouseLeave={() => setHovered((shown) => (shown === step.n ? null : shown))}
            style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
            {...handler}
          >
            {demo === `pill:${step.n}` ? <rect className="pt-demo-halo" height={PILL + 14} rx={(PILL + 14) / 2} width={PILL + 14} x={-7} y={-7} /> : null}
            <Pill active={step.n === current || bubble?.step === step.n || (chart && step.n === hovered)} n={step.n} />
            {!chart ? (
              <text fill="#444" fontSize={9.5} x={PILL + 4} y={10.8}>
                {step.label}
              </text>
            ) : times ? (
              <text fill="#6b6b66" fontSize={9.5} x={PILL + 4} y={10.8}>
                {step.time}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* notes under the boxes */}
      {chart && notes === 'under'
        ? pathway.screens.map((screen) => {
            const lines = screen.steps
              .filter((n) => mockStep(n).note)
              .flatMap((n) => wrap(`${screen.steps.length > 1 ? `${n} ` : ''}${mockStep(n).note}`, 20));
            if (!lines.length) return null;
            const y = rowTop(screen.row) + H + 12 + pillsBlock + 12;
            return (
              <g className="pt-move" key={`notes${screen.id}`} style={{ transform: `translate(${boxX(screen)}px, ${y}px)` }}>
                {lines.slice(0, 3).map((line, index) => (
                  <text fill="#333" fontSize={9.5} key={index} y={index * 11.5}>
                    {line}
                  </text>
                ))}
              </g>
            );
          })
        : null}

      {/* the key to the notes */}
      {chart && notes === 'key' ? (
        <g className="pt-fade">
          <text fontSize={10.5} fontWeight={700} x={LEFT} y={keyTop + 10}>
            notes
          </text>
          {noted.map((step, index) => (
            <g key={step.n} transform={`translate(${LEFT} ${keyTop + 18 + index * 16})`}>
              <Pill n={step.n} />
              <text fontSize={10} x={PILL + 6} y={10.8}>
                <tspan fontWeight={700}>{screenOfStep(step.n)?.title}</tspan>
                <tspan fill="#333">{`  ${step.note}`}</tspan>
              </text>
            </g>
          ))}
        </g>
      ) : null}

      {/* the selected box, the boxes found wrong or right, the box the walk is at; and what can be clicked */}
      {chart
        ? pathway.screens.map((screen) => {
            const mark = marks[screen.id];
            const isCurrent = current !== null && screen.steps.includes(current);
            const shown = demo === `box:${screen.id}`;
            const colour = shown ? GREEN : selectedIds.has(screen.id) || isCurrent ? ORANGE : mark === 'good' ? '#2f8f5f' : mark === 'bad' ? '#bf2725' : null;
            const stack = stackOf(screen);
            const handler = clickable === 'screens' && onScreen ? activate(() => onScreen(screen.id)) : {};
            return (
              <g
                aria-label={clickable === 'screens' ? `box ${screen.index}: ${screen.title}` : undefined}
                className={`pt-move ${clickable === 'screens' ? 'pt-clickable pt-box' : ''}`}
                key={`frame${screen.id}`}
                style={{ transform: `translate(${boxX(screen) - 5}px, ${rowTop(screen.row) - 5}px)` }}
                {...handler}
              >
                <rect
                  className={shown ? 'pt-demo-box' : undefined}
                  fill={shown ? 'rgba(72, 175, 124, 0.2)' : 'transparent'}
                  height={H + stack + 10}
                  stroke={colour ?? 'transparent'}
                  strokeWidth={2.5}
                  width={W + stack + 10}
                />
                {mark ? (
                  <g transform={`translate(${W + stack + 6} ${H + stack + 4})`}>
                    <circle fill={mark === 'good' ? '#2f8f5f' : '#bf2725'} r={8} />
                    <path d={mark === 'good' ? 'M-3.5 0.5 L-1 3 L3.8 -2.6' : 'M-3 -3 L3 3 M3 -3 L-3 3'} fill="none" stroke="#fff" strokeLinecap="round" strokeWidth={1.8} />
                  </g>
                ) : null}
              </g>
            );
          })
        : null}

      {/* the legend and the badge, as in the downloaded figure */}
      {caption && chart ? (
        <g className="pt-fade" transform={`translate(0 ${legendTop})`}>
          <line stroke="#d6d6d1" x1={LEFT} x2={DESIGN_WIDTH - LEFT} y1={0} y2={0} />
          <g transform={`translate(${LEFT} 16)`}>
            <Pill n={2} />
            <text fill="#444" fontSize={9.5} x={21} y={10.8}>
              step number
            </text>
            <path d="M100 7.5h24" markerEnd={`url(#${markerId})`} stroke={INK} strokeWidth={1.1} />
            <text fill="#444" fontSize={9.5} x={130} y={10.8}>
              move to the step's screen
            </text>
            <path d="M262 7.5h24" markerEnd={`url(#${markerId})`} stroke={INK} strokeDasharray="5 4" strokeWidth={1.1} />
            <text fill="#444" fontSize={9.5} x={292} y={10.8}>
              return
            </text>
            <rect fill="none" height={13} stroke={INK} strokeDasharray="3 2" strokeWidth={0.8} width={9} x={340} y={1} />
            <text fill="#444" fontSize={9.5} x={354} y={10.8}>
              pop-up
            </text>
          </g>
          <g transform={`translate(${DESIGN_WIDTH - LEFT - 150} 8)`}>
            <rect fill="#fff" height={38} rx={6} stroke="#3c3c3c" width={150} />
            <g fill={INK} transform="translate(6 6)">
              {[0, 1, 2, 3, 4, 5].flatMap((row) =>
                [0, 1, 2, 3, 4, 5].map((col) =>
                  (row * 7 + col * 3 + row * col) % 3 !== 1 || (row < 2 && col < 2) || (row < 2 && col > 3) || (row > 3 && col < 2) ? (
                    <rect height={4.3} key={`${row}${col}`} width={4.3} x={col * 4.3} y={row * 4.3} />
                  ) : null,
                ),
              )}
            </g>
            <text fontSize={7.5} x={40} y={15}>
              generated with <tspan fontStyle="italic">Stepthrough</tspan>
            </text>
            <text fontSize={7.5} x={40} y={25}>
              using version {APP_VERSION}
            </text>
            <text fill="#555" fontSize={6.5} x={40} y={33}>
              github.com/j-nivekk/Stepthrough
            </text>
          </g>
        </g>
      ) : null}
    </svg>
    {bubble && bubbleAt ? (
      <div
        className={`pt-bubble ${bubbleUp ? 'up' : ''}`}
        key={bubble.step}
        role="status"
        style={{
          left: `min(${((bubbleAt.x - 6) / DESIGN_WIDTH) * 100}%, calc(100% - 236px))`,
          top: `${((bubbleUp ? bubbleAt.y - 6 : bubbleAt.y + PILL + 8) / height) * 100}%`,
        }}
      >
        {bubble.text}
      </div>
    ) : null}
    </div>
  );
}
