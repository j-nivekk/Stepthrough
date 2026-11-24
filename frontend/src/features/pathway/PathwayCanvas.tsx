import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';

import { type PhaseBoundary, type PhaseSteps } from '../../api';
import { isPopupStep, popupChange } from '../../components/ScreenChoice';
import { formatPathwayTime, type PathwayFigure } from '../../lib/pathwayFigure';
import { record, undoChanges, type HistoryEntry } from '../../lib/pathwayHistory';
import { unstackAllChanges, unstackByVisitChanges, unstackStepsChanges } from '../../lib/pathwayUnstack';
import { screenshotUrl } from '../../lib/screenshots';
import { pathwayNumber, stepName, stepsPhrase } from '../../lib/stepNumbers';
import type { CandidateChanges, CandidateFrame, Pathway, PathwayPhase, PathwayRowChoice, PathwayScreen, PathwayStep } from '../../types';
import { translateOf } from './holdPlace';
import { PathwayPhases } from './PathwayPhases';

/** What the phases panel opens with (a stretch of steps for a new phase, a phase to change, or the list), and where
 *  in the window. */
export type PhaseRequest = ({ from: number; to: number } | { phase: PathwayPhase } | { list: true }) & {
  at?: { x: number; y: number };
  /** Opened from the toolbox, under which it stays when the toolbox moves (a phase added above the box moves both). */
  underToolbox?: boolean;
};

/** A phase change, remembered as every phase before and after it: phases are the run's, not a step's. */
interface PhaseEntry {
  label: string;
  phases: { before: PhaseBoundary[]; after: PhaseBoundary[] };
}
type Undoable = HistoryEntry | PhaseEntry;

interface PathwayCanvasProps {
  /** The run shown: the selection and the history start afresh with another. */
  runId: string;
  pathway: Pathway;
  /** Every step of the run, with what the reviewer chose for it. */
  candidates: CandidateFrame[];
  markup: { __html: string };
  /** On the page, in pixels. */
  width: number;
  ariaLabel: string;
  /** While the pathway is being saved or loaded again: nothing can be moved meanwhile. */
  busy: boolean;
  onUpdateCandidate: (candidateId: string, changes: CandidateChanges) => void;
  /** Stack a box onto another; resolves to the steps the server linked (rejected ones included). */
  onMerge: (sourceId: string, targetId: string) => Promise<string[]>;
  /** The phases panel, when open, and how to open or close it. */
  phaseRequest: PhaseRequest | null;
  onPhaseRequest: (request: PhaseRequest | null) => void;
  /** Where the run's phases start, as they are now. */
  phaseBoundaries: PhaseBoundary[] | undefined;
  /** Name a stretch of steps as a phase; resolves to every phase after the change. */
  onSetPhase: (phase: PhaseSteps & { name: string; replacing?: PhaseSteps | null }) => Promise<PhaseBoundary[]>;
  /** Put every phase back, as long as they are still `expected`; rejects when someone else changed them since. */
  onRestorePhases: (phases: PhaseBoundary[], expected: PhaseBoundary[]) => Promise<void>;
  /** Controls rendered at the top of the sticky bar so zoom, view and download stay reachable on tall charts. */
  stickyHeader?: ReactNode;
  /** Which route encodings appear in this chart, shown as a compact inline key in the sticky status strip. */
  encodings?: PathwayFigure['encodings'];
  onPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
  /** The optional detours are left out of the numbers (PathwayFigureOptions.countDetours). */
  leaveOut: boolean;
}

/** What is selected, kept as steps (candidate ids): boxes are numbered again whenever the grouping changes. */
type Selection = { kind: 'boxes'; ids: string[] } | { kind: 'step'; ids: string[] } | null;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b || Boolean(a && b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

interface Drag {
  kind: 'box' | 'step';
  /** The box's first step, or the steps under the number. */
  ids: string[];
  label: string;
  x: number;
  y: number;
  target: { kind: 'box'; screen: PathwayScreen } | { kind: 'empty' } | null;
}

type MenuKind = 'context' | 'overflow' | 'stacking' | 'put';

interface MenuState {
  x: number;
  y: number;
  flipY?: number;
  kind: MenuKind;
}

interface MenuBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface MenuItem {
  label: string;
  hint?: string;
  /** Optional small screenshot thumbnail shown to the left of screen or step titles. */
  thumb?: string;
  run?: () => void;
  items?: MenuItem[];
  danger?: boolean;
  /** Draws a thin rule above this item to separate groups in a menu or submenu. */
  divider?: boolean;
}

interface HoveredMove {
  id: string;
  from: string;
  to: string;
  role: string;
  steps: string;
  hasJump: boolean;
}

const DRAG_START = 5;
/** How wide the menus draw a screen's thumbnail, in CSS pixels (styles.css .pathway-menu-thumb). */
const MENU_THUMB = 34;
const HISTORY = 30;

function prefersStill(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** A key pressed on a box, a jump chip, a button or a panel of the figure's tools is theirs: Enter there presses it. */
function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-screen], [data-jump-to], button, a, select, .pathway-toolbox, .pathway-menu, .pathway-phases'));
}

/** How much of a title the status line, the menus and the labels show; the box itself shows all of it. */
const TITLE_IN_LABELS = 40;

function shorten(text: string, length = TITLE_IN_LABELS): string {
  const trimmed = text.trim();
  return trimmed.length > length ? `${trimmed.slice(0, length - 1).trimEnd()}…` : trimmed;
}

/**
 * The pathway figure on the page, and everything done to it with the pointer and the keyboard. What is selected is
 * what changes: a box (click it), several boxes (shift-click), or the steps under one number (click the number).
 * The selection gets a toolbox beside it, and a right click the same actions as a menu. A box dragged onto another
 * is stacked onto it; a step number dragged onto a box goes there, and dragged off the boxes gets a screen of its
 * own. Every change can be taken back (⌘Z), and the status line says what is selected, what a drop would do, and
 * what was done last.
 */
export function PathwayCanvas({
  runId,
  pathway,
  candidates,
  markup,
  width,
  ariaLabel,
  busy,
  onUpdateCandidate,
  onMerge,
  phaseRequest,
  onPhaseRequest,
  phaseBoundaries,
  onSetPhase,
  onRestorePhases,
  stickyHeader,
  encodings,
  onPointerOver,
  onPointerLeave,
  leaveOut,
}: PathwayCanvasProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const figureRef = useRef<HTMLDivElement | null>(null);
  const toolboxRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const focusTitleRef = useRef(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ startX: number; startY: number; scrollLeft: number; scrollTop: number; winY: number } | null>(null);
  const [hoveredMove, setHoveredMove] = useState<HoveredMove | null>(null);
  const [jumpPulse, setJumpPulse] = useState<{ screenId: string; key: number } | null>(null);
  const [history, setHistory] = useState<Undoable[]>([]);
  /** Where the pointer last chose something, for placing the phases panel near it. */
  const lastPoint = useRef<{ x: number; y: number }>({ x: 24, y: 120 });
  const [message, setMessage] = useState<{ text: string; key: number } | null>(null);
  const [rects, setRects] = useState<{ selected: Rect[]; target: Rect | null; source: Rect | null; pulse: Rect | null }>({
    selected: [],
    target: null,
    source: null,
    pulse: null,
  });
  const [toolboxLayout, setToolboxLayout] = useState<{ shift: number; maxWidth: number | null }>({ shift: 0, maxWidth: null });
  const down = useRef<{
    x: number;
    y: number;
    screen: PathwayScreen | null;
    stepIds: string[] | null;
    phase: number | null;
    jumpTo: PathwayScreen | null;
    shift: boolean;
  } | null>(null);

  // ── what is where ──
  const stepById = useMemo(() => new Map(pathway.steps.map((step) => [step.step_id, step])), [pathway]);
  const stepByCandidate = useMemo(() => new Map(pathway.steps.map((step) => [step.source_candidate_id, step])), [pathway]);
  const screenById = useMemo(() => new Map(pathway.screens.map((screen) => [screen.id, screen])), [pathway]);
  const candidateById = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates]);
  const firstOf = useCallback((screen: PathwayScreen): string => stepById.get(screen.image_step_id)?.source_candidate_id ?? '', [stepById]);
  const screenOf = useCallback(
    (candidateId: string): PathwayScreen | undefined => {
      const step = stepByCandidate.get(candidateId);
      return step ? screenById.get(step.screen_id) : undefined;
    },
    [stepByCandidate, screenById],
  );
  const name = (screen: PathwayScreen): string =>
    screen.title === `Screen ${screen.index}` ? `Screen ${screen.index}` : `Screen ${screen.index}, ${shorten(screen.title)}`;
  const stepsOf = (screen: PathwayScreen): PathwayStep[] =>
    screen.visits.flatMap((visit) => visit.step_ids).map((id) => stepById.get(id)).filter((step): step is PathwayStep => Boolean(step));
  const numberOfStep = (step: PathwayStep): string => pathwayNumber(step, leaveOut);
  const numbersOf = (steps: PathwayStep[]): string => stepsPhrase(steps, leaveOut);

  // The selection as boxes and steps of the pathway now; a step that left the pathway lets it go.
  const selectedBoxes = useMemo(
    () => (selection?.kind === 'boxes' ? selection.ids.map(screenOf).filter((screen): screen is PathwayScreen => Boolean(screen)) : []),
    [selection, screenOf],
  );
  const selectedSteps = useMemo(
    () => (selection?.kind === 'step' ? selection.ids.map((id) => stepByCandidate.get(id)).filter((step): step is PathwayStep => Boolean(step)) : []),
    [selection, stepByCandidate],
  );
  useEffect(() => {
    if (selection && !selectedBoxes.length && !selectedSteps.length) setSelection(null);
  }, [selection, selectedBoxes, selectedSteps]);

  // ── changes, each of which can be taken back ──
  // The history is this browser's own, in memory: in a shared account everyone has theirs, and an undo takes back
  // only what this browser did (lib/pathwayHistory.ts). Another run starts it afresh.
  useEffect(() => {
    setHistory([]);
    setSelection(null);
    setHoveredMove(null);
    setJumpPulse(null);
    setMessage(null);
  }, [runId]);

  useEffect(() => {
    setHoveredMove(null);
  }, [markup]);

  useEffect(() => {
    if (!jumpPulse) return;
    const timer = window.setTimeout(() => setJumpPulse((current) => (current?.key === jumpPulse.key ? null : current)), 950);
    return () => window.clearTimeout(timer);
  }, [jumpPulse]);

  function say(text: string) {
    setMessage({ text, key: Date.now() });
  }

  /** Make a change and remember it. `changes` is what it does to each step; `perform` does it, when that is not
   *  simply sending those changes: a merge, which the server does, and which then says which steps it changed. */
  async function act(
    label: string,
    changes: Array<[string, CandidateChanges]>,
    perform?: () => Promise<Array<[string, CandidateChanges]> | void>,
  ) {
    if (busy || !changes.length) return;
    const before = candidates;
    const entry = record(label, before, changes);
    setHistory((current) => [...current.slice(-(HISTORY - 1)), entry]);
    try {
      if (perform) {
        const done = await perform();
        if (done) {
          const actual = record(label, before, done);
          setHistory((current) => current.map((item) => (item === entry ? actual : item)));
        }
      } else for (const [id, change] of changes) onUpdateCandidate(id, change);
      say(label);
    } catch (error) {
      setHistory((current) => current.filter((item) => item !== entry));
      say(`could not do that: ${error instanceof Error ? error.message.toLocaleLowerCase() : 'unknown error'}`);
    }
  }

  function undo() {
    const entry = history[history.length - 1];
    if (!entry || busy) return;
    setHistory((current) => current.slice(0, -1));
    if ('phases' in entry) {
      onRestorePhases(entry.phases.before, entry.phases.after).then(
        () => say(`undone: ${entry.label}`),
        () => say(`not undone (${entry.label}): someone else has changed the phases since, so they stay as they are`),
      );
      return;
    }
    const { changes, kept } = undoChanges(entry, candidates);
    for (const [id, change] of changes) onUpdateCandidate(id, change);
    const others = kept ? `; ${kept === 1 ? 'one change' : `${kept} changes`} someone else made since stayed` : '';
    say(changes.length ? `undone: ${entry.label}${others}` : `nothing to undo of: ${entry.label}${others}`);
  }

  async function setPhase(phase: PhaseSteps & { name: string; replacing?: PhaseSteps | null }, label: string) {
    const before = phaseBoundaries ?? [];
    const after = await onSetPhase(phase);
    setHistory((current) => [...current.slice(-(HISTORY - 1)), { label, phases: { before, after } }]);
    say(label);
  }

  /** The phases panel, beside what asked for it: the toolbox, or where the pointer chose. */
  function openPhases(request: PhaseRequest) {
    const toolbox = toolboxRef.current?.getBoundingClientRect();
    const underToolbox = !request.at && Boolean(toolbox);
    onPhaseRequest({ ...request, underToolbox, at: request.at ?? (toolbox ? { x: toolbox.left, y: toolbox.bottom + 8 } : lastPoint.current) });
  }
  /** Where the phases panel opened from the toolbox is now: under the toolbox, wherever that has moved to. */
  const [underToolbox, setUnderToolbox] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!phaseRequest?.underToolbox) return;
    const toolbox = toolboxRef.current?.getBoundingClientRect();
    if (!toolbox) return;
    const at = { x: toolbox.left, y: toolbox.bottom + 8 };
    setUnderToolbox((was) => (was && Math.abs(was.x - at.x) < 0.5 && Math.abs(was.y - at.y) < 0.5 ? was : at));
  });

  const togglePopup = (candidateId: string, label: string) => {
    const candidate = candidateById.get(candidateId);
    if (!candidate) return;
    const popup = !isPopupStep(candidate);
    void act(`${popup ? 'marked' : 'unmarked'} ${label} as a pop-up`, [[candidate.id, popupChange(candidate, popup)]]);
  };
  const boxLinks = (source: PathwayScreen, target: PathwayScreen): Array<[string, CandidateChanges]> =>
    stepsOf(source).map((step) => [step.source_candidate_id, { screen_link: firstOf(target) }]);
  const stackBox = (source: PathwayScreen, target: PathwayScreen) =>
    void act(`stacked ${name(source)} onto ${name(target)}`, boxLinks(source, target), async () => {
      const link = firstOf(target);
      const changed = await onMerge(firstOf(source), link);
      setSelection({ kind: 'boxes', ids: [link] });
      return changed.map((id): [string, CandidateChanges] => [id, { screen_link: link }]);
    });
  const stackTogether = (boxes: PathwayScreen[]) => {
    const [target, ...rest] = [...boxes].sort((a, b) => a.index - b.index);
    void act(`stacked ${boxes.length} boxes together`, rest.flatMap((source) => boxLinks(source, target)), async () => {
      const link = firstOf(target);
      const changed: string[] = [];
      for (const source of rest) changed.push(...(await onMerge(firstOf(source), link)));
      setSelection({ kind: 'boxes', ids: [link] });
      return changed.map((id): [string, CandidateChanges] => [id, { screen_link: link }]);
    });
  };
  const moveStep = (steps: PathwayStep[], target: PathwayScreen | 'own' | 'auto') => {
    const first = steps[0];
    if (!first) return;
    if (target === 'own') {
      const own = screenOf(first.source_candidate_id);
      const allSteps = own ? stepsOf(own) : [];
      if (own && allSteps.length > 1 && steps.length < allSteps.length) {
        const changes = unstackStepsChanges(steps, allSteps, candidateById);
        if (!changes.length) return;
        void act(`gave ${numbersOf(steps)} a screen of its own`, changes);
        setSelection({ kind: 'boxes', ids: [first.source_candidate_id] });
        return;
      }
    }
    const label =
      target === 'own' ? `gave ${numbersOf(steps)} a screen of its own` : target === 'auto' ? `stacked ${numbersOf(steps)} automatically` : `put ${numbersOf(steps)} on ${name(target)}`;
    const link = target === 'own' ? 'new' : target === 'auto' ? 'auto' : firstOf(target);
    void act(label, [[first.source_candidate_id, { screen_link: link }]]);
  };
  const stepMenuLabel = (step: PathwayStep): string => {
    const customTitle = candidateById.get(step.source_candidate_id)?.title?.trim();
    const called = stepName(numberOfStep(step));
    return customTitle ? `${called}: ${shorten(customTitle)}` : `${called}, at ${formatPathwayTime(step.timestamp_ms)}`;
  };
  /** The steps of a box whose screen was chosen (stacked, unstacked or given a screen of its own), not left automatic. */
  const chosenScreens = (screen: PathwayScreen): PathwayStep[] =>
    stepsOf(screen).filter((step) => Boolean(candidateById.get(step.source_candidate_id)?.screen_link));
  const stackAutomatically = (screen: PathwayScreen) => {
    const changes = chosenScreens(screen).map((step): [string, CandidateChanges] => [step.source_candidate_id, { screen_link: 'auto' }]);
    if (!changes.length) return;
    void act(`stacked ${name(screen)} automatically`, changes);
  };
  const unstackAll = (screen: PathwayScreen) => {
    const steps = stepsOf(screen);
    const changes = unstackAllChanges(steps, candidateById);
    if (!changes.length) return;
    void act(`unstacked all ${steps.length} steps of ${name(screen)}`, changes);
  };
  const unstackByVisit = (screen: PathwayScreen) => {
    const changes = unstackByVisitChanges(screen, stepById, candidateById);
    if (!changes.length) return;
    void act(`unstacked ${name(screen)} by visit`, changes);
  };
  const unstackOneStep = (screen: PathwayScreen, step: PathwayStep) => {
    const changes = unstackStepsChanges([step], stepsOf(screen), candidateById);
    if (!changes.length) return;
    void act(`gave ${numbersOf([step])} a screen of its own`, changes);
    setSelection({ kind: 'boxes', ids: [step.source_candidate_id] });
  };
  const editStepsOf = (screen: PathwayScreen) => {
    const steps = stepsOf(screen);
    if (!steps.length) return;
    setSelection({ kind: 'step', ids: [steps[0].source_candidate_id] });
  };
  const chooseRow = (screen: PathwayScreen, value: 'auto' | PathwayRowChoice) => {
    const first = firstOf(screen);
    // a say left on another step of the box would still count after this one's
    const leftOver = stepsOf(screen)
      .filter((step) => step.source_candidate_id !== first && candidateById.get(step.source_candidate_id)?.pathway_row)
      .map((step): [string, CandidateChanges] => [step.source_candidate_id, { pathway_row: 'auto' }]);
    void act(
      `moved ${name(screen)} ${value === 'below' ? 'to a row below' : value === 'continue' ? 'onto its row' : 'back to its automatic row'}`,
      [[first, { pathway_row: value }], ...leftOver],
    );
  };
  const rename = (screen: PathwayScreen, value: string) => {
    const next = value.trim();
    const titleStep = stepById.get(screen.title_step_id ?? screen.image_step_id);
    const saved = screen.title_step_id ? screen.title : '';
    if (!titleStep || next === saved) return;
    void act(next ? `renamed ${name(screen)} to ${shorten(next)}` : `took the title of ${name(screen)} away`, [[titleStep.source_candidate_id, { title: next }]]);
  };
  const phaseOfStep = (step: PathwayStep | undefined): PathwayPhase | undefined =>
    step && (pathway.phases ?? []).find((phase) => step.step_index >= phase.first_step_index && step.step_index <= phase.last_step_index);
  const phaseFor = (steps: PathwayStep[]) => {
    const numbers = steps.map((step) => step.step_index);
    if (!numbers.length) return;
    openPhases({ from: Math.min(...numbers), to: Math.max(...numbers) });
  };

  /** Every stacking & unstacking action for a single box in one unified menu. On a plain 1-step box with no
   *  overrides, lists the destination screens directly; otherwise groups stack onto, unstack, stack automatically,
   *  and edit steps cleanly under dividers. */
  function stackingMenuItems(box: PathwayScreen, otherBoxes: Array<{ label: string; thumb?: string; screen: PathwayScreen }>): MenuItem[] {
    const steps = stepsOf(box);
    const hasOverrides = chosenScreens(box).length > 0;
    const isStacked = steps.length > 1;
    if (!isStacked && !hasOverrides) {
      return otherBoxes.map(({ label, thumb, screen }) => ({ label, thumb, run: () => stackBox(box, screen) }));
    }
    const list: MenuItem[] = [];
    if (otherBoxes.length) {
      list.push({
        label: 'stack onto',
        items: otherBoxes.map(({ label, thumb, screen }) => ({ label, thumb, run: () => stackBox(box, screen) })),
      });
    }
    if (isStacked) {
      const startDivider = list.length > 0;
      list.push({ label: `unstack all (${steps.length} steps)`, divider: startDivider, run: () => unstackAll(box) });
      if (box.visits.length > 1 && steps.length > box.visits.length) {
        list.push({ label: `by visit (${box.visits.length} visits)`, run: () => unstackByVisit(box) });
      }
      steps.forEach((step, index) => {
        list.push({
          label: stepMenuLabel(step),
          thumb: step.image_url ? screenshotUrl(step.image_url, MENU_THUMB) : undefined,
          divider: index === 0,
          run: () => unstackOneStep(box, step),
        });
      });
    }
    const tail: MenuItem[] = [];
    if (hasOverrides) tail.push({ label: 'stack automatically', run: () => stackAutomatically(box) });
    if (isStacked) tail.push({ label: 'edit steps…', run: () => editStepsOf(box) });
    tail.forEach((item, index) => list.push({ ...item, divider: index === 0 && list.length > 0 }));
    return list;
  }

  /** Unstack-only items for the right-click context menu (where stack onto, stack automatically, and edit steps sit
   *  directly beside unstack). */
  function unstackSubmenuItems(box: PathwayScreen): MenuItem[] {
    const steps = stepsOf(box);
    if (steps.length <= 1) return [];
    const list: MenuItem[] = [{ label: `unstack all (${steps.length} steps)`, run: () => unstackAll(box) }];
    if (box.visits.length > 1 && steps.length > box.visits.length) {
      list.push({ label: `by visit (${box.visits.length} visits)`, run: () => unstackByVisit(box) });
    }
    steps.forEach((step, index) => {
      list.push({
        label: stepMenuLabel(step),
        thumb: step.image_url ? screenshotUrl(step.image_url, MENU_THUMB) : undefined,
        divider: index === 0,
        run: () => unstackOneStep(box, step),
      });
    });
    return list;
  }

  function rowChoiceItems(box: PathwayScreen, parent: PathwayScreen, withPrefix = false): MenuItem[] {
    const choice = box.row_choice ?? 'automatic';
    const prefix = withPrefix ? 'row: ' : '';
    return [
      { label: `${prefix}automatic`, hint: choice === 'automatic' ? '✓' : undefined, run: () => chooseRow(box, 'auto') },
      { label: `${prefix}next to Screen ${parent.index}`, hint: choice === 'continue' ? '✓' : undefined, run: () => chooseRow(box, 'continue') },
      { label: `${prefix}on a row below`, hint: choice === 'below' ? '✓' : undefined, run: () => chooseRow(box, 'below') },
    ];
  }

  /** Secondary actions shown in the toolbox's `⋯` overflow menu — strictly items NOT already on the floating bar. */
  function overflowMenuItems(): MenuItem[] {
    if (selectedBoxes.length === 1) {
      const box = selectedBoxes[0];
      const parent = pathway.screens.find((screen) => screen.id === box.reached_from);
      return parent ? rowChoiceItems(box, parent, true) : [];
    }
    if (selectedBoxes.length > 1) return [];
    if (selectedSteps.length) {
      const own = screenOf(selectedSteps[0].source_candidate_id);
      const first = candidateById.get(selectedSteps[0].source_candidate_id);
      const items: MenuItem[] = [];
      if (own && stepsOf(own).length > 1) {
        items.push({ label: `unstack all (${stepsOf(own).length} steps)`, run: () => unstackAll(own) });
      }
      if (first?.screen_link) {
        items.push({ label: 'stack automatically', run: () => moveStep(selectedSteps, 'auto') });
      }
      const phase = phaseOfStep(selectedSteps[0]);
      items.push(
        phase
          ? { label: `change the phase ${phase.name}…`, divider: items.length > 0, run: () => openPhases({ phase }) }
          : { label: 'make a phase from here…', divider: items.length > 0, run: () => phaseFor(selectedSteps) },
      );
      return items;
    }
    return [];
  }

  // ── the actions for what is selected: toolbox triggers open focused menus; right-click opens the full menu ──
  function menuItems(): MenuItem[] {
    const thumbOf = (screen: PathwayScreen): string | undefined => {
      const url = stepById.get(screen.image_step_id)?.image_url;
      return url ? screenshotUrl(url, MENU_THUMB) : undefined;
    };
    const others = (except: PathwayScreen[]) =>
      pathway.screens
        .filter((screen) => !except.includes(screen))
        .map((screen) => ({ label: `${name(screen)} (${numbersOf(stepsOf(screen))})`, thumb: thumbOf(screen), screen }));
    if (menu?.kind === 'overflow') {
      return overflowMenuItems();
    }
    if (menu?.kind === 'stacking' && selectedBoxes.length === 1) {
      const box = selectedBoxes[0];
      return stackingMenuItems(box, others([box]));
    }
    if (menu?.kind === 'put' && selectedSteps.length) {
      const own = screenOf(selectedSteps[0].source_candidate_id);
      return others(own ? [own] : []).map(({ label, thumb, screen }) => ({ label, thumb, run: () => moveStep(selectedSteps, screen) }));
    }
    const items: MenuItem[] = [];
    if (selectedBoxes.length === 1) {
      const box = selectedBoxes[0];
      const steps = stepsOf(box);
      const first = candidateById.get(firstOf(box));
      const parent = pathway.screens.find((screen) => screen.id === box.reached_from);
      const otherBoxes = others([box]);
      items.push({
        label: 'rename',
        hint: 'Enter',
        run: () => {
          if (titleRef.current) {
            titleRef.current.focus();
            titleRef.current.select();
          } else {
            focusTitleRef.current = true;
          }
        },
      });
      if (first) items.push({ label: isPopupStep(first) ? 'not a pop-up' : 'a pop-up', hint: 'P', run: () => togglePopup(first.id, name(box)) });
      if (otherBoxes.length) {
        items.push({ label: 'stack onto', divider: true, items: otherBoxes.map(({ label, thumb, screen }) => ({ label, thumb, run: () => stackBox(box, screen) })) });
      }
      if (steps.length > 1) items.push({ label: 'unstack', items: unstackSubmenuItems(box) });
      if (chosenScreens(box).length) items.push({ label: 'stack automatically', run: () => stackAutomatically(box) });
      if (steps.length > 1) items.push({ label: 'edit steps…', run: () => editStepsOf(box) });
      if (parent) {
        items.push({ label: 'row', divider: true, items: rowChoiceItems(box, parent) });
      }
      const phase = phaseOfStep(steps[0]);
      items.push(
        phase
          ? { label: `change the phase ${phase.name}…`, divider: !parent, run: () => openPhases({ phase }) }
          : { label: 'make a phase from here…', divider: !parent, run: () => phaseFor(steps) },
      );
    } else if (selectedBoxes.length > 1) {
      items.push({ label: `stack these ${selectedBoxes.length} together`, run: () => stackTogether(selectedBoxes) });
      items.push({ label: 'make a phase of these…', run: () => phaseFor(selectedBoxes.flatMap(stepsOf)) });
    } else if (selectedSteps.length) {
      const own = screenOf(selectedSteps[0].source_candidate_id);
      const first = candidateById.get(selectedSteps[0].source_candidate_id);
      const otherBoxes = others(own ? [own] : []);
      const boxStepCount = own ? stepsOf(own).length : 0;
      if (boxStepCount > 1) items.push({ label: 'a screen of its own', run: () => moveStep(selectedSteps, 'own') });
      if (otherBoxes.length) {
        items.push({ label: 'put it on', items: otherBoxes.map(({ label, thumb, screen }) => ({ label, thumb, run: () => moveStep(selectedSteps, screen) })) });
      }
      if (own && boxStepCount > 1) {
        items.push({ label: `unstack all (${boxStepCount} steps)`, run: () => unstackAll(own) });
      }
      if (first?.screen_link) items.push({ label: 'stack automatically', run: () => moveStep(selectedSteps, 'auto') });
      if (first) items.push({ label: isPopupStep(first) ? 'not a pop-up' : 'a pop-up', hint: 'P', divider: true, run: () => togglePopup(first.id, numbersOf(selectedSteps)) });
      const phase = phaseOfStep(selectedSteps[0]);
      items.push(phase ? { label: `change the phase ${phase.name}…`, run: () => openPhases({ phase }) } : { label: 'make a phase from here…', run: () => phaseFor(selectedSteps) });
    } else {
      items.push({ label: 'add a phase…', run: () => phaseFor(pathway.steps.slice(0, 1)) });
    }
    return items;
  }

  // ── where things are on the page ──
  const rectOf = useCallback((element: Element | null | undefined): Rect | null => {
    const stage = stageRef.current;
    if (!element || !stage) return null;
    const box = element.getBoundingClientRect();
    const base = stage.getBoundingClientRect();
    return { left: box.left - base.left, top: box.top - base.top, width: box.width, height: box.height };
  }, []);
  const imageOf = useCallback(
    (screen: PathwayScreen) => figureRef.current?.querySelector(`[data-screen="${CSS.escape(screen.id)}"] image`) ?? figureRef.current?.querySelector(`[data-screen="${CSS.escape(screen.id)}"]`),
    [],
  );
  const numberOf = useCallback(
    (steps: PathwayStep[]) =>
      [...(figureRef.current?.querySelectorAll('[data-peek]') ?? [])].find((element) =>
        (element.getAttribute('data-peek') ?? '').split(' ').includes(steps[0]?.step_id ?? ''),
      ),
    [],
  );

  const measure = useCallback(() => {
    const selected = selectedBoxes.length
      ? selectedBoxes.map((screen) => rectOf(imageOf(screen))).filter((rect): rect is Rect => Boolean(rect))
      : selectedSteps.length
        ? [
            rectOf(
              numberOf(selectedSteps) ??
                (() => {
                  const own = screenOf(selectedSteps[0].source_candidate_id);
                  return own ? imageOf(own) : null;
                })(),
            ),
          ].filter((rect): rect is Rect => Boolean(rect))
        : [];
    const target = drag?.target?.kind === 'box' ? rectOf(imageOf(drag.target.screen)) : null;
    const sourceScreen = drag ? screenOf(drag.ids[0]) : undefined;
    const source = drag ? (drag.kind === 'box' && sourceScreen ? rectOf(imageOf(sourceScreen)) : rectOf(numberOf(drag.ids.map((id) => stepByCandidate.get(id)).filter((step): step is PathwayStep => Boolean(step))))) : null;
    const pulseScreen = jumpPulse ? screenById.get(jumpPulse.screenId) : undefined;
    const pulse = pulseScreen ? rectOf(imageOf(pulseScreen)) : null;
    // Only a change is drawn: with nothing selected, or everything where it was, there is none.
    setRects((was) =>
      was.selected.length === selected.length &&
      selected.every((rect, index) => sameRect(rect, was.selected[index] ?? null)) &&
      sameRect(target, was.target) &&
      sameRect(source, was.source) &&
      sameRect(pulse, was.pulse)
        ? was
        : { selected, target, source, pulse },
    );
  }, [selectedBoxes, selectedSteps, drag, jumpPulse, rectOf, imageOf, numberOf, screenOf, screenById, stepByCandidate]);
  useLayoutEffect(measure, [measure, markup, width]);
  // While boxes glide to a new place (below), what is measured is where they are on the way, not where they land: a
  // phase added above them makes the figure taller, and the outline was left where the box set off. So the outline
  // is measured when they have landed.
  const glidingRef = useRef(0);
  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  }, [measure]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!glidingRef.current) measure();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [measure]);

  // Boxes that moved in a new layout glide to their new place; nothing moves for those who asked for less motion.
  const placesRef = useRef<Map<string, [number, number]>>(new Map());
  useLayoutEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;
    const previous = placesRef.current;
    const next = new Map<string, [number, number]>();
    const still = prefersStill();
    for (const group of figure.querySelectorAll('[data-screen]')) {
      const screen = screenById.get(group.getAttribute('data-screen') ?? '');
      const at = translateOf(group);
      if (!screen || !at) continue;
      const key = firstOf(screen);
      next.set(key, at);
      const was = previous.get(key);
      if (!still && was && (was[0] !== at[0] || was[1] !== at[1]) && typeof (group as SVGGElement).animate === 'function') {
        const glide = (group as SVGGElement).animate(
          [{ transform: `translate(${was[0]}px, ${was[1]}px)` }, { transform: `translate(${at[0]}px, ${at[1]}px)` }],
          { duration: 200, easing: 'ease-out' },
        );
        glidingRef.current += 1;
        glide.finished
          .catch(() => undefined)
          .then(() => {
            glidingRef.current -= 1;
            if (!glidingRef.current) measureRef.current();
          });
      }
    }
    placesRef.current = next;
  }, [markup, screenById, firstOf]);

  // The toolbox always stays completely visible inside the pathway canvas (even when `.pathway-stage` is centered
  // inside a wider `.pathway-scroll`, scrolled horizontally, or resized). Uses the exact unshifted `toolboxBaseLeft`
  // from `rects.selected` so rounding never creates a feedback loop.
  const toolboxBaseLeft =
    !drag && rects.selected.length && (selectedBoxes.length || selectedSteps.length)
      ? Math.min(...rects.selected.map((rect) => rect.left))
      : null;

  const clampToolbox = useCallback(() => {
    const toolbox = toolboxRef.current;
    const stage = stageRef.current;
    const scroller = stage?.parentElement;
    if (!toolbox || !stage || !scroller || toolboxBaseLeft === null) {
      setToolboxLayout((current) => (current.shift === 0 && current.maxWidth === null ? current : { shift: 0, maxWidth: null }));
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const visLeft = Math.max(scrollerRect.left, 8) + 8;
    const visRight = Math.min(scrollerRect.right, window.innerWidth - 8) - 8;
    const maxWidth = Math.max(180, Math.floor(visRight - visLeft));
    const baseLeftViewport = stageRect.left + toolboxBaseLeft;
    const boxWidth = Math.min(toolbox.offsetWidth, maxWidth);
    let shift = 0;
    if (baseLeftViewport + boxWidth > visRight) shift = visRight - (baseLeftViewport + boxWidth);
    if (baseLeftViewport + shift < visLeft) shift = visLeft - baseLeftViewport;
    shift = Math.round(shift);
    setToolboxLayout((current) => (current.shift === shift && current.maxWidth === maxWidth ? current : { shift, maxWidth }));
  }, [toolboxBaseLeft]);

  useLayoutEffect(clampToolbox, [clampToolbox, selection, markup, width]);

  useEffect(() => {
    const scroller = stageRef.current?.parentElement;
    const toolbox = toolboxRef.current;
    if (!scroller) return;
    scroller.addEventListener('scroll', clampToolbox, { passive: true });
    window.addEventListener('resize', clampToolbox);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(clampToolbox) : null;
    observer?.observe(scroller);
    if (toolbox) observer?.observe(toolbox);
    return () => {
      scroller.removeEventListener('scroll', clampToolbox);
      window.removeEventListener('resize', clampToolbox);
      observer?.disconnect();
    };
  }, [clampToolbox, selection, markup, width]);

  // Spotlight a hovered route (and its endpoints) or the routes connected to the selected box(es).
  useEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;
    figure.classList.remove('is-spotlighting-move', 'is-spotlighting-box');
    for (const lit of figure.querySelectorAll('.is-lit')) lit.classList.remove('is-lit');
    if (drag) return;
    if (hoveredMove) {
      figure.classList.add('is-spotlighting-move');
      figure.querySelector(`#${CSS.escape(hoveredMove.id)}`)?.classList.add('is-lit');
      figure.querySelector(`[data-screen="${CSS.escape(hoveredMove.from)}"]`)?.classList.add('is-lit');
      figure.querySelector(`[data-screen="${CSS.escape(hoveredMove.to)}"]`)?.classList.add('is-lit');
      return;
    }
    if (selectedBoxes.length) {
      const ids = new Set(selectedBoxes.map((screen) => screen.id));
      let connected = 0;
      for (const move of figure.querySelectorAll('[data-move]')) {
        const from = move.getAttribute('data-from') ?? '';
        const to = move.getAttribute('data-to') ?? '';
        if (ids.has(from) || ids.has(to)) {
          move.classList.add('is-lit');
          connected += 1;
        }
      }
      if (connected > 0) figure.classList.add('is-spotlighting-box');
    }
  }, [hoveredMove, selectedBoxes, drag, markup]);

  // ── the pointer ──
  function hit(target: EventTarget | null) {
    const element = target instanceof Element ? target : null;
    const jump = element?.closest('[data-jump-to]');
    const number = element?.closest('[data-peek]');
    const box = element?.closest('[data-screen]');
    const phase = element?.closest('[data-phase]');
    const screen = box ? screenById.get(box.getAttribute('data-screen') ?? '') ?? null : null;
    const stepIds = number ? (number.getAttribute('data-peek') ?? '').split(' ').filter((id) => stepById.has(id)) : null;
    const jumpTo = jump ? screenById.get(jump.getAttribute('data-jump-to') ?? '') ?? null : null;
    return {
      screen,
      stepIds: stepIds?.length ? stepIds : null,
      phase: phase ? Number(phase.getAttribute('data-phase')) : null,
      jumpTo,
    };
  }

  function jumpToScreen(target: PathwayScreen) {
    setHoveredMove(null);
    setSelection({ kind: 'boxes', ids: [firstOf(target)] });
    setJumpPulse({ screenId: target.id, key: Date.now() });
    const element = figureRef.current?.querySelector(`[data-screen="${CSS.escape(target.id)}"]`);
    if (element) {
      element.scrollIntoView({ behavior: prefersStill() ? 'auto' : 'smooth', block: 'center', inline: 'center' });
    }
    say(`jumped to ${name(target)}`);
  }

  function selectAt(at: ReturnType<typeof hit>, shift: boolean) {
    setMessage(null); // a choice made by hand: the line says what is selected again
    if (at.jumpTo && !at.screen) {
      jumpToScreen(at.jumpTo);
      return;
    }
    if (at.phase !== null && !at.screen) {
      const phase = (pathway.phases ?? [])[at.phase];
      if (phase) openPhases({ phase });
      return;
    }
    if (at.stepIds) {
      const ids = at.stepIds.map((id) => stepById.get(id)?.source_candidate_id).filter((id): id is string => Boolean(id));
      setSelection({ kind: 'step', ids });
      return;
    }
    if (at.screen) {
      const id = firstOf(at.screen);
      if (shift && selection?.kind === 'boxes') {
        const ids = selection.ids.includes(id) ? selection.ids.filter((item) => item !== id) : [...selection.ids, id];
        setSelection(ids.length ? { kind: 'boxes', ids } : null);
      } else {
        setSelection({ kind: 'boxes', ids: [id] });
      }
      return;
    }
    setSelection(null);
  }

  function handleFigurePointerOver(event: PointerEvent<HTMLDivElement>) {
    onPointerOver(event);
    if (drag) return;
    const moveEl = event.target instanceof Element ? event.target.closest('[data-move]') : null;
    if (!moveEl) {
      if (hoveredMove) setHoveredMove(null);
      return;
    }
    const id = moveEl.getAttribute('id') ?? '';
    if (!id || hoveredMove?.id === id) return;
    setHoveredMove({
      id,
      from: moveEl.getAttribute('data-from') ?? '',
      to: moveEl.getAttribute('data-to') ?? '',
      role: moveEl.getAttribute('data-role') ?? 'main',
      steps: moveEl.getAttribute('data-steps') ?? '',
      hasJump: Boolean(moveEl.querySelector('[data-jump-to]')),
    });
  }

  function handleFigurePointerLeave() {
    onPointerLeave();
    setHoveredMove(null);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    lastPoint.current = { x: event.clientX + 8, y: event.clientY + 8 };
    setMenu(null);
    const at = hit(event.target);
    down.current = { x: event.clientX, y: event.clientY, ...at, shift: event.shiftKey };
  }

  useEffect(() => {
    function move(event: globalThis.PointerEvent) {
      if (panRef.current) {
        const pan = panRef.current;
        const scroller = stageRef.current?.parentElement;
        if (scroller) {
          scroller.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
          if (scroller.scrollHeight > scroller.clientHeight + 2) {
            scroller.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
          } else {
            window.scrollTo({ top: Math.max(0, pan.winY - (event.clientY - pan.startY)) });
          }
        }
        return;
      }
      const start = down.current;
      if (!start) return;
      if (!drag) {
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_START || busy) return;
        if (start.stepIds) {
          const steps = start.stepIds.map((id) => stepById.get(id)).filter((step): step is PathwayStep => Boolean(step));
          setSelection({ kind: 'step', ids: steps.map((step) => step.source_candidate_id) });
          setDrag({ kind: 'step', ids: steps.map((step) => step.source_candidate_id), label: numbersOf(steps), x: event.clientX, y: event.clientY, target: null });
        } else if (start.screen) {
          setSelection({ kind: 'boxes', ids: [firstOf(start.screen)] });
          setDrag({ kind: 'box', ids: [firstOf(start.screen)], label: name(start.screen), x: event.clientX, y: event.clientY, target: null });
        } else if (!start.jumpTo && start.phase === null) {
          // Dragging empty pathway canvas pans the zoomed figure smoothly.
          const scroller = stageRef.current?.parentElement;
          if (scroller) {
            panRef.current = {
              startX: start.x,
              startY: start.y,
              scrollLeft: scroller.scrollLeft,
              scrollTop: scroller.scrollTop,
              winY: window.scrollY,
            };
            down.current = null;
            setPanning(true);
            return;
          }
          down.current = null;
        } else {
          down.current = null;
        }
        return;
      }
      // what is under the pointer, and the figure scrolled along near its edges
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const inFigure = Boolean(under && figureRef.current?.contains(under));
      const box = inFigure ? under?.closest('[data-screen]') : null;
      const screen = box ? screenById.get(box.getAttribute('data-screen') ?? '') : undefined;
      const own = screenOf(drag.ids[0]);
      const target: Drag['target'] = screen && screen !== own ? { kind: 'box', screen } : inFigure && !screen ? { kind: 'empty' } : null;
      setDrag({ ...drag, x: event.clientX, y: event.clientY, target });
      const scroller = stageRef.current?.parentElement;
      if (scroller) {
        const edge = scroller.getBoundingClientRect();
        if (event.clientX > edge.right - 40) scroller.scrollLeft += 14;
        else if (event.clientX < edge.left + 40) scroller.scrollLeft -= 14;
      }
    }
    function up(event: globalThis.PointerEvent) {
      if (panRef.current) {
        panRef.current = null;
        setPanning(false);
        return;
      }
      const start = down.current;
      down.current = null;
      if (drag) {
        const target = drag.target;
        const source = screenOf(drag.ids[0]);
        setDrag(null);
        if (drag.kind === 'box' && source && target?.kind === 'box') stackBox(source, target.screen);
        if (drag.kind === 'step') {
          const steps = drag.ids.map((id) => stepByCandidate.get(id)).filter((step): step is PathwayStep => Boolean(step));
          if (target?.kind === 'box') moveStep(steps, target.screen);
          else if (target?.kind === 'empty') moveStep(steps, 'own');
        }
        return;
      }
      if (start && figureRef.current?.contains(event.target as Node)) {
        selectAt({ screen: start.screen, stepIds: start.stepIds, phase: start.phase, jumpTo: start.jumpTo }, start.shift);
      }
    }
    function cancel() {
      panRef.current = null;
      setPanning(false);
      down.current = null;
      setDrag(null);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  });

  /** The menu is placed in the window (the figure's frame would cut it off at its edge), so an outside scroll closes it. */
  function openMenuAt(x: number, y: number, kind: MenuKind = 'context', flipY?: number) {
    setMenu({ x, y, flipY, kind });
  }
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      // Scrolling inside a tall menu or submenu keeps it open.
      if (event.target instanceof Element && event.target.closest('.pathway-menu')) return;
      setMenu(null);
    };
    const closeResize = () => setMenu(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', closeResize);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', closeResize);
    };
  }, [menu]);

  function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const at = hit(event.target);
    const id = at.screen ? firstOf(at.screen) : null;
    const inSelection =
      (selection?.kind === 'boxes' && id && selection.ids.includes(id) && !at.stepIds) ||
      (selection?.kind === 'step' && at.stepIds && at.stepIds.some((stepId) => selection.ids.includes(stepById.get(stepId)?.source_candidate_id ?? '')));
    if (!inSelection) selectAt({ ...at, phase: null, jumpTo: null }, false);
    lastPoint.current = { x: event.clientX, y: event.clientY };
    openMenuAt(event.clientX, event.clientY);
  }

  // Keys: on a box (reached with Tab) Enter selects it and the menu key opens its actions; with something selected,
  // P marks a pop-up, Enter renames, the arrows go to the box before or after, Escape lets go; ⌘Z takes back.
  function handleFigureKey(event: KeyboardEvent<HTMLDivElement>) {
    const at = hit(event.target);
    if (at.jumpTo && !at.screen && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      jumpToScreen(at.jumpTo);
      return;
    }
    if (!at.screen) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectAt({ ...at, stepIds: null, phase: null, jumpTo: null }, event.shiftKey);
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      selectAt({ ...at, stepIds: null, phase: null, jumpTo: null }, false);
      const image = imageOf(at.screen)?.getBoundingClientRect();
      if (image) openMenuAt(image.left + 12, image.top + 12);
    }
  }
  useEffect(() => {
    function key(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey && !typing(event.target)) {
        if (!history.length) return;
        event.preventDefault();
        undo();
        return;
      }
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') {
        if (drag) {
          down.current = null;
          setDrag(null);
        } else if (menu) setMenu(null);
        else setSelection(null);
        return;
      }
      if (!selection || (event.target instanceof Element && event.target.closest('.pathway-phases'))) return;
      if (event.key.toLowerCase() === 'p') {
        const first = selectedBoxes.length === 1 ? firstOf(selectedBoxes[0]) : selectedSteps[0]?.source_candidate_id;
        if (first) togglePopup(first, selectedBoxes.length === 1 ? name(selectedBoxes[0]) : numbersOf(selectedSteps));
      } else if (event.key === 'Enter' && selectedBoxes.length === 1 && !onControl(event.target)) {
        event.preventDefault();
        titleRef.current?.focus();
      } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && selectedBoxes.length === 1) {
        const index = selectedBoxes[0].index + (event.key === 'ArrowRight' ? 1 : -1);
        const next = pathway.screens.find((screen) => screen.index === index);
        if (next) {
          event.preventDefault();
          setSelection({ kind: 'boxes', ids: [firstOf(next)] });
        }
      }
    }
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  });

  // A click outside the figure and its tools lets the menu go.
  useEffect(() => {
    if (!menu) return;
    function away(event: globalThis.PointerEvent) {
      if (
        !(event.target instanceof Element) ||
        (!event.target.closest('.pathway-menu') && !event.target.closest('[data-pathway-menu-trigger]'))
      ) {
        setMenu(null);
      }
    }
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [menu]);

  // ── what the status line says ──
  let status: ReactNode;
  if (drag) {
    const what = drag.label;
    status =
      drag.target?.kind === 'box'
        ? `let go to ${drag.kind === 'box' ? `stack ${what} onto` : `put ${what} on`} ${name(drag.target.screen)}`
        : drag.target?.kind === 'empty'
          ? drag.kind === 'step'
            ? `let go to give ${what} a screen of its own`
            : `drop ${what} on another box to stack it there`
          : 'let go outside the figure, or press Escape, to leave it as it is';
  } else if (busy) {
    status = 'saving…';
  } else if (message) {
    status = (
      <>
        {message.text}.{' '}
        {history.length && message.text === history[history.length - 1]?.label ? (
          <button className="analysis-task-link" onClick={undo} type="button">
            undo
          </button>
        ) : null}
      </>
    );
  } else if (hoveredMove) {
    const fromScreen = screenById.get(hoveredMove.from);
    const toScreen = screenById.get(hoveredMove.to);
    const roleLabel = hoveredMove.role === 'return' ? 'return' : hoveredMove.role === 'branch' ? 'branch / detour' : 'main flow';
    const stepPrefix = hoveredMove.steps ? (hoveredMove.steps.includes(',') ? `steps ${hoveredMove.steps}: ` : `step ${hoveredMove.steps}: `) : '';
    const route = fromScreen && toScreen ? `${name(fromScreen)} → ${name(toScreen)}` : 'move';
    const jumpHint = hoveredMove.hasJump ? ' · click a jump tag to scroll there' : '';
    status = `${stepPrefix}${route} (${roleLabel})${jumpHint}`;
  } else if (selectedBoxes.length === 1) {
    const box = selectedBoxes[0];
    const boxSteps = stepsOf(box);
    status =
      boxSteps.length > 1
        ? `${name(box)}: ${numbersOf(boxSteps)}. drag onto another box to stack, or use stacking to separate steps.`
        : `${name(box)}: ${numbersOf(boxSteps)}. drag it onto another box to stack it, or right-click for more.`;
  } else if (selectedBoxes.length > 1) {
    status = `${selectedBoxes.length} boxes selected: stack them together, or make them a phase.`;
  } else if (selectedSteps.length) {
    status = `${numbersOf(selectedSteps)}: drag it onto another box, or off the boxes for a screen of its own.`;
  } else {
    status = 'click a box to change it, or a step number for one step. drag a box onto another to stack them. right-click for more.';
  }
  // A new message is said once, then the line goes back to what is selected.
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage((current) => (current?.key === message.key ? null : current)), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);

  // ── the toolbox, beside the selection (hidden while a right-click context menu is open so both never stack) ──
  const hasOverflow = overflowMenuItems().length > 0;
  let toolbox: ReactNode = null;
  if (!drag && menu?.kind !== 'context' && rects.selected.length && (selectedBoxes.length || selectedSteps.length)) {
    const top = Math.min(...rects.selected.map((rect) => rect.top));
    const bottom = Math.max(...rects.selected.map((rect) => rect.top + rect.height));
    const left = Math.min(...rects.selected.map((rect) => rect.left));
    const above = selectedBoxes.length ? top > 76 : top > 52;
    const aboveOffset = selectedBoxes.length ? 28 : 10;
    const style = {
      left: `${left + toolboxLayout.shift}px`,
      top: `${above ? top - aboveOffset : bottom + 10}px`,
      ...(toolboxLayout.maxWidth !== null ? { maxWidth: `${toolboxLayout.maxWidth}px` } : {}),
    };
    const others = (except: PathwayScreen[]) => pathway.screens.filter((screen) => !except.includes(screen));
    const more = hasOverflow ? (
      <button
        aria-expanded={menu?.kind === 'overflow'}
        aria-haspopup="menu"
        aria-label="more"
        className={`pathway-tool ${menu?.kind === 'overflow' ? 'is-on' : ''}`}
        data-pathway-menu-trigger="overflow"
        onClick={(event) => {
          if (menu?.kind === 'overflow') {
            setMenu(null);
            return;
          }
          const button = event.currentTarget.getBoundingClientRect();
          openMenuAt(button.left, button.bottom + 4, 'overflow', button.top - 4);
        }}
        title="more actions"
        type="button"
      >
        ⋯
      </button>
    ) : null;
    let tools: ReactNode;
    if (selectedBoxes.length === 1) {
      const box = selectedBoxes[0];
      const first = candidateById.get(firstOf(box));
      const steps = stepsOf(box);
      const phase = phaseOfStep(steps[0]);
      const otherBoxes = others([box]);
      const hasStacking = otherBoxes.length > 0 || steps.length > 1 || chosenScreens(box).length > 0;
      tools = (
        <>
          <input
            aria-label={`title of ${name(box)}`}
            className="pathway-tool-title"
            defaultValue={box.title_step_id ? box.title : ''}
            key={`${box.id}-${box.title}`}
            maxLength={240}
            onBlur={(event) => rename(box, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.currentTarget.value = box.title_step_id ? box.title : '';
                event.currentTarget.blur();
              }
            }}
            placeholder={`Screen ${box.index}`}
            ref={(node) => {
              titleRef.current = node;
              if (node && focusTitleRef.current) {
                focusTitleRef.current = false;
                node.focus();
                node.select();
              }
            }}
          />
          {first ? (
            <button
              aria-pressed={isPopupStep(first)}
              className={`pathway-tool ${isPopupStep(first) ? 'is-on' : ''}`}
              onClick={() => togglePopup(first.id, name(box))}
              title="a pop-up is drawn with a dashed frame (P)"
              type="button"
            >
              pop-up
            </button>
          ) : null}
          {hasStacking ? (
            <button
              aria-expanded={menu?.kind === 'stacking'}
              aria-haspopup="menu"
              className={`pathway-tool ${menu?.kind === 'stacking' ? 'is-on' : ''}`}
              data-pathway-menu-trigger="stacking"
              onClick={(event) => {
                if (menu?.kind === 'stacking') {
                  setMenu(null);
                  return;
                }
                const button = event.currentTarget.getBoundingClientRect();
                openMenuAt(button.left, button.bottom + 4, 'stacking', button.top - 4);
              }}
              title={
                steps.length > 1
                  ? 'stack onto another box, unstack steps, or edit steps'
                  : 'stack this box onto another, or reset automatic stacking'
              }
              type="button"
            >
              stacking…
            </button>
          ) : null}
          <button
            className="pathway-tool pathway-tool-phase"
            onClick={() => (phase ? openPhases({ phase }) : phaseFor(steps))}
            title={phase ? `the phase ${phase.name}` : 'make a phase from this box'}
            type="button"
          >
            {phase ? `phase: ${phase.name}` : 'phase…'}
          </button>
          {more}
        </>
      );
    } else if (selectedBoxes.length > 1) {
      tools = (
        <>
          <span className="pathway-tool-label">{selectedBoxes.length} boxes</span>
          <button className="pathway-tool" onClick={() => stackTogether(selectedBoxes)} type="button">
            stack together
          </button>
          <button className="pathway-tool" onClick={() => phaseFor(selectedBoxes.flatMap(stepsOf))} type="button">
            phase…
          </button>
        </>
      );
    } else {
      const own = screenOf(selectedSteps[0].source_candidate_id);
      const first = candidateById.get(selectedSteps[0].source_candidate_id);
      // Every step stacked on this box can be picked on its own from the step toolbar.
      const boxSteps = own ? stepsOf(own) : selectedSteps;
      const picked = new Set(selectedSteps.map((step) => step.step_id));
      const otherBoxes = others(own ? [own] : []);
      tools = (
        <>
          {boxSteps.length > 1 ? (
            <span aria-label="which step" className="pathway-tool-steps" role="group">
              <span className="pathway-tool-label">step</span>
              {boxSteps.map((step) => (
                <button
                  aria-pressed={picked.has(step.step_id) && picked.size === 1}
                  className={`pathway-tool ${picked.has(step.step_id) && picked.size === 1 ? 'is-on' : ''}`}
                  key={step.step_id}
                  onClick={() => setSelection({ kind: 'step', ids: [step.source_candidate_id] })}
                  title={`select ${stepMenuLabel(step)}`}
                  type="button"
                >
                  {numberOfStep(step)}
                </button>
              ))}
            </span>
          ) : (
            <span className="pathway-tool-label">{numbersOf(selectedSteps)}</span>
          )}
          {boxSteps.length > 1 ? (
            <button className="pathway-tool" onClick={() => moveStep(selectedSteps, 'own')} title="pop this step out into a box of its own" type="button">
              own screen
            </button>
          ) : null}
          {otherBoxes.length ? (
            <button
              aria-expanded={menu?.kind === 'put'}
              aria-haspopup="menu"
              className={`pathway-tool ${menu?.kind === 'put' ? 'is-on' : ''}`}
              data-pathway-menu-trigger="put"
              onClick={(event) => {
                if (menu?.kind === 'put') {
                  setMenu(null);
                  return;
                }
                const button = event.currentTarget.getBoundingClientRect();
                openMenuAt(button.left, button.bottom + 4, 'put', button.top - 4);
              }}
              title="move this step onto another box"
              type="button"
            >
              put it on…
            </button>
          ) : null}
          {first ? (
            <button
              aria-pressed={isPopupStep(first)}
              className={`pathway-tool ${isPopupStep(first) ? 'is-on' : ''}`}
              onClick={() => togglePopup(first.id, numbersOf(selectedSteps))}
              title="a pop-up starts a box of its own, drawn with a dashed frame (P)"
              type="button"
            >
              pop-up
            </button>
          ) : null}
          {more}
        </>
      );
    }
    toolbox = (
      <div
        aria-label="change the selection"
        className={`pathway-toolbox ${above ? 'is-above' : 'is-below'}`}
        key={selection?.kind === 'boxes' ? selection.ids.join() : selectedSteps.map((step) => step.step_id).join()}
        onPointerDown={(event) => event.stopPropagation()}
        ref={toolboxRef}
        role="toolbar"
        style={style}
      >
        {tools}
      </div>
    );
  }

  const showInlineKey = Boolean(encodings && (encodings.hasBranch || encodings.hasReturn || encodings.hasPortal));

  return (
    <>
      <div className="pathway-sticky">
        {stickyHeader}
        <div className="pathway-status" role="status">
          <span className="pathway-status-text" key={message?.key ?? 'state'}>
            {status}
          </span>
          <span className="pathway-status-meta">
            {showInlineKey ? (
              <span aria-label="path key" className="pathway-status-legend">
                <span className="pathway-key-item" title="main forward flow">
                  <svg aria-hidden="true" height="8" viewBox="0 0 18 8" width="18">
                    <line stroke="#111" strokeWidth="1.5" x1="1" x2="14" y1="4" y2="4" />
                    <path d="M12 1.5 L16.5 4 L12 6.5 Z" fill="#111" />
                  </svg>
                  main
                </span>
                {encodings?.hasBranch ? (
                  <span className="pathway-key-item" title="branch or detour path">
                    <svg aria-hidden="true" height="8" viewBox="0 0 18 8" width="18">
                      <line stroke="#a44d10" strokeWidth="1.5" x1="1" x2="14" y1="4" y2="4" />
                      <path d="M12 1.5 L16.5 4 L12 6.5 Z" fill="#a44d10" />
                    </svg>
                    branch
                  </span>
                ) : null}
                {encodings?.hasReturn ? (
                  <span className="pathway-key-item" title="return to an earlier screen">
                    <svg aria-hidden="true" height="8" viewBox="0 0 18 8" width="18">
                      <line stroke="#2c5f8a" strokeDasharray="3 2" strokeWidth="1.35" x1="1" x2="14" y1="4" y2="4" />
                      <path d="M12 1.5 L16.5 4 L12 6.5 Z" fill="#2c5f8a" />
                    </svg>
                    return
                  </span>
                ) : null}
                {encodings?.hasPortal ? (
                  <span className="pathway-key-item" title="cross-row jump tag; click to scroll to the other screen">
                    <span aria-hidden="true" className="pathway-key-chip">
                      → S#
                    </span>
                    jump
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="pathway-status-keys">
              {history.length ? (
                <button className="analysis-task-link subtle" disabled={busy} onClick={undo} type="button">
                  undo ⌘Z
                </button>
              ) : null}
            </span>
          </span>
        </div>
      </div>
      {phaseRequest ? (
        <PathwayPhases
          at={phaseRequest.underToolbox ? underToolbox ?? undefined : undefined}
          disabled={busy}
          leaveOut={leaveOut}
          onClose={() => onPhaseRequest(null)}
          onSet={setPhase}
          pathway={pathway}
          request={phaseRequest}
        />
      ) : null}
      <div className="pathway-scroll">
        <div className={`pathway-stage ${drag ? 'is-dragging' : ''} ${panning ? 'is-panning' : ''}`} ref={stageRef} style={{ width: `${width}px` }}>
          <div
            aria-label={ariaLabel}
            className="pathway-figure"
            // The markup is built by buildPathwayFigure, which escapes every title, note and address it places.
            dangerouslySetInnerHTML={markup}
            onContextMenu={handleContextMenu}
            onKeyDown={handleFigureKey}
            onPointerDown={handlePointerDown}
            onPointerLeave={handleFigurePointerLeave}
            onPointerOver={handleFigurePointerOver}
            ref={figureRef}
          />
          {rects.selected.map((rect, index) => (
            <span
              aria-hidden="true"
              className={`pathway-selected ${selection?.kind === 'step' ? 'is-step' : ''}`}
              key={index}
              style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
            >
              <i />
              <i />
              <i />
              <i />
            </span>
          ))}
          {rects.pulse && jumpPulse ? (
            <span
              aria-hidden="true"
              className="pathway-jump-pulse"
              key={jumpPulse.key}
              style={{ left: rects.pulse.left - 6, top: rects.pulse.top - 6, width: rects.pulse.width + 12, height: rects.pulse.height + 12 }}
            />
          ) : null}
          {rects.source ? (
            <span aria-hidden="true" className="pathway-drag-source" style={{ left: rects.source.left, top: rects.source.top, width: rects.source.width, height: rects.source.height }} />
          ) : null}
          {rects.target ? (
            <span aria-hidden="true" className="pathway-drop" style={{ left: rects.target.left - 6, top: rects.target.top - 6, width: rects.target.width + 12, height: rects.target.height + 12 }} />
          ) : null}
          {toolbox}
          {menu ? (
            <PathwayMenu
              bounds={(() => {
                const scroller = stageRef.current?.parentElement?.getBoundingClientRect();
                if (!scroller) return undefined;
                return {
                  left: Math.max(8, scroller.left + 4),
                  right: Math.min(window.innerWidth - 8, scroller.right - 4),
                  top: 8,
                  bottom: window.innerHeight - 8,
                };
              })()}
              flipY={menu.flipY}
              items={menuItems()}
              onClose={() => setMenu(null)}
              x={menu.x}
              y={menu.y}
            />
          ) : null}
        </div>
      </div>
      {drag ? (
        <span aria-hidden="true" className="pathway-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
          {drag.label}
        </span>
      ) : null}
    </>
  );
}

/** Clamps a floating menu rectangle to stay completely visible inside the pathway canvas (or viewport if narrower). */
function clampMenuBounds(width: number, height: number, bounds?: MenuBounds) {
  const viewLeft = 8;
  const viewRight = window.innerWidth - 8;
  const viewTop = 8;
  const viewBottom = window.innerHeight - 8;
  const useCanvasX = Boolean(bounds && bounds.right - bounds.left >= width);
  return {
    minLeft: useCanvasX && bounds ? bounds.left : viewLeft,
    maxRight: useCanvasX && bounds ? bounds.right : viewRight,
    minTop: viewTop,
    maxBottom: viewBottom,
    width,
    height,
  };
}

/** The actions as a menu, at the pointer; an item with items of its own opens them beside it. */
function PathwayMenu({
  items,
  x,
  y,
  flipY,
  bounds,
  onClose,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  flipY?: number;
  bounds?: MenuBounds;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [openAnchor, setOpenAnchor] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const bLeft = bounds?.left;
  const bRight = bounds?.right;
  const bTop = bounds?.top;
  const bBottom = bounds?.bottom;
  // Keep the menu completely visible inside the pathway canvas & viewport (flipping left/up when near edges).
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const rectBounds =
      bLeft !== undefined && bRight !== undefined && bTop !== undefined && bBottom !== undefined
        ? { left: bLeft, right: bRight, top: bTop, bottom: bBottom }
        : undefined;
    const { minLeft, maxRight, minTop, maxBottom } = clampMenuBounds(box.width, box.height, rectBounds);
    let left = x;
    if (left + box.width > maxRight) {
      const flipped = x - box.width;
      left = flipped >= minLeft ? flipped : maxRight - box.width;
    }
    left = Math.round(Math.max(minLeft, Math.min(left, Math.max(minLeft, maxRight - box.width))));
    let top = y;
    if (top + box.height > maxBottom) {
      top = flipY !== undefined && flipY - box.height >= minTop ? flipY - box.height : maxBottom - box.height;
    }
    top = Math.round(Math.max(minTop, Math.min(top, Math.max(minTop, maxBottom - box.height))));
    setPos((current) => (current.left === left && current.top === top ? current : { left, top }));
  }, [x, y, flipY, bLeft, bRight, bTop, bBottom, items.length]);
  /** Whether the open submenu was opened with the keyboard, and so takes the focus. */
  const [byKey, setByKey] = useState(false);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    // Keys pressed in the menu stay in it: the figure's own (P, Enter, the arrows) would act on the selection behind it.
    event.stopPropagation();
    const submenu = document.activeElement instanceof Element ? document.activeElement.closest('.pathway-submenu') : null;
    const scope = submenu ?? ref.current;
    const buttons = [...(scope?.querySelectorAll<HTMLButtonElement>(':scope > div > button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
    } else if (event.key === 'ArrowRight' && !submenu && index >= 0 && items[index]?.items) {
      event.preventDefault();
      setByKey(true);
      setOpenAnchor((document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.pathway-menu-row') ?? null);
      setOpen(index);
    } else if (event.key === 'ArrowLeft' && submenu) {
      event.preventDefault();
      submenu.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
      setOpen(null);
      setOpenAnchor(null);
    } else if (event.key === 'Escape') {
      onClose();
    }
  }

  return (
    <div
      className="pathway-menu"
      onKeyDown={onKey}
      onPointerDown={(event) => event.stopPropagation()}
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((item, index) => (
        <div
          className="pathway-menu-row"
          key={item.label}
          onPointerEnter={(event) => {
            setByKey(false);
            setOpen(item.items ? index : null);
            setOpenAnchor(item.items ? event.currentTarget : null);
          }}
        >
          {item.divider ? <div aria-hidden="true" className="pathway-menu-divider" /> : null}
          <button
            aria-expanded={item.items ? open === index : undefined}
            aria-haspopup={item.items ? 'menu' : undefined}
            className={`pathway-menu-item ${item.danger ? 'is-danger' : ''}`}
            onClick={(event) => {
              if (item.items) {
                // Enter or Space (a click with no pointer) opens it with its first item in focus.
                setByKey(event.detail === 0);
                const nextOpen = open === index ? null : index;
                setOpen(nextOpen);
                setOpenAnchor(nextOpen !== null ? event.currentTarget.closest<HTMLElement>('.pathway-menu-row') : null);
                return;
              }
              onClose();
              item.run?.();
            }}
            role="menuitem"
            title={item.label}
            type="button"
          >
            <span className="pathway-menu-main">
              {item.thumb ? <img alt="" className="pathway-menu-thumb" loading="lazy" src={item.thumb} /> : null}
              <span className="pathway-menu-label">{item.label}</span>
            </span>
            <span className="pathway-menu-hint">{item.items ? '▸' : item.hint ?? ''}</span>
          </button>
          {item.items && open === index ? (
            <PathwaySubmenu anchor={openAnchor} bounds={bounds} focusFirst={byKey} items={item.items} onClose={onClose} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The items of a menu item, placed fixed beside its parent row and clamped strictly inside the canvas & viewport. */
function PathwaySubmenu({
  anchor,
  bounds,
  focusFirst,
  items,
  onClose,
}: {
  anchor: HTMLElement | null;
  bounds?: MenuBounds;
  focusFirst: boolean;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => {
    const row = anchor?.getBoundingClientRect();
    return row ? { left: row.right + 2, top: row.top - 4 } : { left: 8, top: 8 };
  });
  const bLeft = bounds?.left;
  const bRight = bounds?.right;
  const bTop = bounds?.top;
  const bBottom = bounds?.bottom;
  useLayoutEffect(() => {
    const element = ref.current;
    const row = anchor?.getBoundingClientRect();
    if (!element || !row) return;
    const box = element.getBoundingClientRect();
    const rectBounds =
      bLeft !== undefined && bRight !== undefined && bTop !== undefined && bBottom !== undefined
        ? { left: bLeft, right: bRight, top: bTop, bottom: bBottom }
        : undefined;
    const { minLeft, maxRight, minTop, maxBottom } = clampMenuBounds(box.width, box.height, rectBounds);
    let left = row.right + 2;
    if (left + box.width > maxRight) {
      const flipped = row.left - box.width - 2;
      left = flipped >= minLeft ? flipped : maxRight - box.width;
    }
    left = Math.round(Math.max(minLeft, Math.min(left, Math.max(minLeft, maxRight - box.width))));
    const top = Math.round(Math.max(minTop, Math.min(row.top - 4, Math.max(minTop, maxBottom - box.height))));
    setPos((current) => (current.left === left && current.top === top ? current : { left, top }));
  }, [anchor, bLeft, bRight, bTop, bBottom, items.length]);
  useEffect(() => {
    if (focusFirst) ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [focusFirst]);
  return (
    <div
      className="pathway-menu pathway-submenu"
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((child) => (
        <div className="pathway-menu-row" key={child.label}>
          {child.divider ? <div aria-hidden="true" className="pathway-menu-divider" /> : null}
          <button
            className="pathway-menu-item"
            onClick={() => {
              onClose();
              child.run?.();
            }}
            role="menuitem"
            title={child.label}
            type="button"
          >
            <span className="pathway-menu-main">
              {child.thumb ? <img alt="" className="pathway-menu-thumb" loading="lazy" src={child.thumb} /> : null}
              <span className="pathway-menu-label">{child.label}</span>
            </span>
            {child.hint ? <span className="pathway-menu-hint">{child.hint}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
