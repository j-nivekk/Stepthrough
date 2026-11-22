import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';

import type { PhaseBoundary, PhaseSteps } from '../../api';
import { isPopupStep, popupChange } from '../../components/ScreenChoice';
import { formatPathwayTime } from '../../lib/pathwayFigure';
import { record, undoChanges, type HistoryEntry } from '../../lib/pathwayHistory';
import { unstackAllChanges, unstackByVisitChanges, unstackStepsChanges } from '../../lib/pathwayUnstack';
import type { CandidateChanges, CandidateFrame, Pathway, PathwayPhase, PathwayRowChoice, PathwayScreen, PathwayStep } from '../../types';
import { PathwayPhases } from './PathwayPhases';

/** What the phases panel opens with (a stretch of steps for a new phase, a phase to change, or the list), and where
 *  in the window. */
export type PhaseRequest = ({ from: number; to: number } | { phase: PathwayPhase } | { list: true }) & { at?: { x: number; y: number } };

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
  onPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
}

/** What is selected, kept as steps (candidate ids): boxes are numbered again whenever the grouping changes. */
type Selection = { kind: 'boxes'; ids: string[] } | { kind: 'step'; ids: string[] } | null;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Drag {
  kind: 'box' | 'step';
  /** The box's first step, or the steps under the number. */
  ids: string[];
  label: string;
  x: number;
  y: number;
  target: { kind: 'box'; screen: PathwayScreen } | { kind: 'empty' } | null;
}

interface MenuItem {
  label: string;
  hint?: string;
  run?: () => void;
  items?: MenuItem[];
  danger?: boolean;
  /** Draws a thin rule above this item to separate groups in a menu or submenu. */
  divider?: boolean;
}

const DRAG_START = 5;
const HISTORY = 30;

function prefersStill(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function translateOf(element: Element): [number, number] | null {
  const match = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(element.getAttribute('transform') ?? '');
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
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
  onPointerOver,
  onPointerLeave,
}: PathwayCanvasProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const figureRef = useRef<HTMLDivElement | null>(null);
  const toolboxRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'context' | 'unstack' } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [history, setHistory] = useState<Undoable[]>([]);
  /** Where the pointer last chose something, for placing the phases panel near it. */
  const lastPoint = useRef<{ x: number; y: number }>({ x: 24, y: 120 });
  const [message, setMessage] = useState<{ text: string; key: number } | null>(null);
  const [rects, setRects] = useState<{ selected: Rect[]; target: Rect | null; source: Rect | null }>({ selected: [], target: null, source: null });
  const [toolboxShift, setToolboxShift] = useState(0);
  const down = useRef<{ x: number; y: number; screen: PathwayScreen | null; stepIds: string[] | null; phase: number | null; shift: boolean } | null>(null);

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
    screen.title === `Screen ${screen.index}` ? `Screen ${screen.index}` : `Screen ${screen.index}, ${screen.title}`;
  const stepsOf = (screen: PathwayScreen): PathwayStep[] =>
    screen.visits.flatMap((visit) => visit.step_ids).map((id) => stepById.get(id)).filter((step): step is PathwayStep => Boolean(step));
  const numbersOf = (steps: PathwayStep[]): string => {
    const numbers = steps.map((step) => step.step_index);
    if (numbers.length < 2) return `step ${numbers[0] ?? ''}`;
    const run = numbers.every((number, index) => !index || number === numbers[index - 1] + 1);
    return run ? `steps ${numbers[0]}–${numbers[numbers.length - 1]}` : `steps ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
  };

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
    setMessage(null);
  }, [runId]);

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
    onPhaseRequest({ ...request, at: request.at ?? (toolbox ? { x: toolbox.left, y: toolbox.bottom + 8 } : lastPoint.current) });
  }

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
      target === 'own' ? `gave ${numbersOf(steps)} a screen of its own` : target === 'auto' ? `put ${numbersOf(steps)} back where it was found` : `put ${numbersOf(steps)} on ${name(target)}`;
    const link = target === 'own' ? 'new' : target === 'auto' ? 'auto' : firstOf(target);
    void act(label, [[first.source_candidate_id, { screen_link: link }]]);
  };
  const stepMenuLabel = (step: PathwayStep): string => {
    const customTitle = candidateById.get(step.source_candidate_id)?.title?.trim();
    const detail = customTitle || formatPathwayTime(step.timestamp_ms);
    return `step ${step.step_index} · ${detail}`;
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
    void act(`gave step ${step.step_index} a screen of its own`, changes);
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
    void act(next ? `renamed ${name(screen)} to ${next}` : `took the title of ${name(screen)} away`, [[titleStep.source_candidate_id, { title: next }]]);
  };
  const phaseOfStep = (index: number): PathwayPhase | undefined =>
    (pathway.phases ?? []).find((phase) => index >= phase.first_step_index && index <= phase.last_step_index);
  const phaseFor = (steps: PathwayStep[]) => {
    const numbers = steps.map((step) => step.step_index);
    if (!numbers.length) return;
    openPhases({ from: Math.min(...numbers), to: Math.max(...numbers) });
  };

  function unstackMenuItems(box: PathwayScreen, includeEditSteps = false): MenuItem[] {
    const steps = stepsOf(box);
    if (steps.length < 2) return [];
    const list: MenuItem[] = [
      { label: `unstack all (${steps.length} steps)`, run: () => unstackAll(box) },
    ];
    if (box.visits.length > 1 && steps.length > box.visits.length) {
      list.push({ label: `by visit (${box.visits.length} visits)`, run: () => unstackByVisit(box) });
    }
    steps.forEach((step, index) => {
      list.push({
        label: stepMenuLabel(step),
        divider: index === 0,
        run: () => unstackOneStep(box, step),
      });
    });
    if (includeEditSteps) {
      list.push({ label: 'edit steps…', divider: true, run: () => editStepsOf(box) });
    }
    return list;
  }

  // ── the actions for what is selected: the toolbox shows the usual ones, the menu all of them ──
  function menuItems(): MenuItem[] {
    if (menu?.kind === 'unstack' && selectedBoxes.length === 1) {
      return unstackMenuItems(selectedBoxes[0], true);
    }
    const items: MenuItem[] = [];
    const others = (except: PathwayScreen[]) =>
      pathway.screens.filter((screen) => !except.includes(screen)).map((screen) => ({ label: `${name(screen)} (${numbersOf(stepsOf(screen))})`, screen }));
    if (selectedBoxes.length === 1) {
      const box = selectedBoxes[0];
      const steps = stepsOf(box);
      const first = candidateById.get(firstOf(box));
      const parent = pathway.screens.find((screen) => screen.id === box.reached_from);
      items.push({ label: 'rename', hint: 'Enter', run: () => titleRef.current?.focus() });
      if (first) items.push({ label: isPopupStep(first) ? 'not a pop-up' : 'a pop-up', hint: 'P', run: () => togglePopup(first.id, name(box)) });
      items.push({ label: 'stack onto', items: others([box]).map(({ label, screen }) => ({ label, run: () => stackBox(box, screen) })) });
      if (steps.length > 1) {
        items.push({ label: 'unstack', items: unstackMenuItems(box) });
        items.push({ label: 'edit steps…', run: () => editStepsOf(box) });
      }
      if (parent) {
        items.push({
          label: 'row',
          items: [
            { label: 'automatic', run: () => chooseRow(box, 'auto') },
            { label: `next to Screen ${parent.index}`, run: () => chooseRow(box, 'continue') },
            { label: 'on a row below', run: () => chooseRow(box, 'below') },
          ],
        });
      }
      const phase = phaseOfStep(steps[0]?.step_index ?? 0);
      items.push(phase ? { label: `change the phase ${phase.name}…`, run: () => openPhases({ phase }) } : { label: 'make a phase from here…', run: () => phaseFor(steps) });
    } else if (selectedBoxes.length > 1) {
      items.push({ label: `stack these ${selectedBoxes.length} together`, run: () => stackTogether(selectedBoxes) });
      items.push({ label: 'make a phase of these…', run: () => phaseFor(selectedBoxes.flatMap(stepsOf)) });
    } else if (selectedSteps.length) {
      const own = screenOf(selectedSteps[0].source_candidate_id);
      const first = candidateById.get(selectedSteps[0].source_candidate_id);
      items.push({ label: 'a screen of its own', run: () => moveStep(selectedSteps, 'own') });
      items.push({ label: 'put it on', items: others(own ? [own] : []).map(({ label, screen }) => ({ label, run: () => moveStep(selectedSteps, screen) })) });
      if (own && stepsOf(own).length > 1) {
        const boxStepCount = stepsOf(own).length;
        items.push({ label: `unstack all (${boxStepCount} steps)`, run: () => unstackAll(own) });
      }
      if (first?.screen_link) items.push({ label: 'back where it was found', run: () => moveStep(selectedSteps, 'auto') });
      if (first) items.push({ label: isPopupStep(first) ? 'not a pop-up' : 'a pop-up', hint: 'P', run: () => togglePopup(first.id, numbersOf(selectedSteps)) });
      const phase = phaseOfStep(selectedSteps[0].step_index);
      items.push(phase ? { label: `change the phase ${phase.name}…`, run: () => openPhases({ phase }) } : { label: 'make a phase from here…', run: () => phaseFor(selectedSteps) });
    } else {
      items.push({ label: 'add a phase…', run: () => phaseFor(pathway.steps.slice(0, 1)) });
    }
    if (history.length) items.push({ label: `undo: ${history[history.length - 1].label}`, hint: '⌘Z', run: undo });
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
    setRects({ selected, target, source });
  }, [selectedBoxes, selectedSteps, drag, rectOf, imageOf, numberOf, screenOf, stepByCandidate]);
  useLayoutEffect(measure, [measure, markup, width]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
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
        (group as SVGGElement).animate(
          [{ transform: `translate(${was[0]}px, ${was[1]}px)` }, { transform: `translate(${at[0]}px, ${at[1]}px)` }],
          { duration: 200, easing: 'ease-out' },
        );
      }
    }
    placesRef.current = next;
  }, [markup, screenById, firstOf]);

  // The toolbox stays inside what can be seen of the figure.
  useLayoutEffect(() => {
    const toolbox = toolboxRef.current;
    const scroller = stageRef.current?.parentElement;
    if (!toolbox || !scroller) {
      setToolboxShift(0);
      return;
    }
    const left = toolbox.offsetLeft - toolboxShift;
    const visibleRight = scroller.scrollLeft + scroller.clientWidth - 8;
    const visibleLeft = scroller.scrollLeft + 4;
    const shift = Math.max(visibleLeft - left, Math.min(0, visibleRight - (left + toolbox.offsetWidth)));
    if (Math.abs(shift - toolboxShift) > 0.5) setToolboxShift(shift);
  });

  // ── the pointer ──
  function hit(target: EventTarget | null) {
    const element = target instanceof Element ? target : null;
    const number = element?.closest('[data-peek]');
    const box = element?.closest('[data-screen]');
    const phase = element?.closest('[data-phase]');
    const screen = box ? screenById.get(box.getAttribute('data-screen') ?? '') ?? null : null;
    const stepIds = number ? (number.getAttribute('data-peek') ?? '').split(' ').filter((id) => stepById.has(id)) : null;
    return { screen, stepIds: stepIds?.length ? stepIds : null, phase: phase ? Number(phase.getAttribute('data-phase')) : null };
  }

  function selectAt(at: ReturnType<typeof hit>, shift: boolean) {
    setMessage(null); // a choice made by hand: the line says what is selected again
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

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    lastPoint.current = { x: event.clientX + 8, y: event.clientY + 8 };
    setMenu(null);
    const at = hit(event.target);
    down.current = { x: event.clientX, y: event.clientY, ...at, shift: event.shiftKey };
  }

  useEffect(() => {
    function move(event: globalThis.PointerEvent) {
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
      if (start && figureRef.current?.contains(event.target as Node)) selectAt({ screen: start.screen, stepIds: start.stepIds, phase: start.phase }, start.shift);
    }
    function cancel() {
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

  /** The menu is placed in the window (the figure's frame would cut it off at its edge), so a scroll closes it. */
  function openMenuAt(x: number, y: number, kind: 'context' | 'unstack' = 'context') {
    setMenu({ x, y, kind });
  }
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const at = hit(event.target);
    const id = at.screen ? firstOf(at.screen) : null;
    const inSelection =
      (selection?.kind === 'boxes' && id && selection.ids.includes(id) && !at.stepIds) ||
      (selection?.kind === 'step' && at.stepIds && at.stepIds.some((stepId) => selection.ids.includes(stepById.get(stepId)?.source_candidate_id ?? '')));
    if (!inSelection) selectAt({ ...at, phase: null }, false);
    lastPoint.current = { x: event.clientX, y: event.clientY };
    openMenuAt(event.clientX, event.clientY);
  }

  // Keys: on a box (reached with Tab) Enter selects it and the menu key opens its actions; with something selected,
  // P marks a pop-up, Enter renames, the arrows go to the box before or after, Escape lets go; ⌘Z takes back.
  function handleFigureKey(event: KeyboardEvent<HTMLDivElement>) {
    const at = hit(event.target);
    if (!at.screen) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectAt({ ...at, stepIds: null, phase: null }, event.shiftKey);
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      selectAt({ ...at, stepIds: null, phase: null }, false);
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
      if (!selection) return;
      if (event.key.toLowerCase() === 'p') {
        const first = selectedBoxes.length === 1 ? firstOf(selectedBoxes[0]) : selectedSteps[0]?.source_candidate_id;
        if (first) togglePopup(first, selectedBoxes.length === 1 ? name(selectedBoxes[0]) : numbersOf(selectedSteps));
      } else if (event.key === 'Enter' && selectedBoxes.length === 1 && !(event.target instanceof Element && event.target.closest('[data-screen]'))) {
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
        (!event.target.closest('.pathway-menu') && !event.target.closest('[data-pathway-unstack-trigger]'))
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
  } else if (selectedBoxes.length === 1) {
    const box = selectedBoxes[0];
    const boxSteps = stepsOf(box);
    status =
      boxSteps.length > 1
        ? `${name(box)}: ${numbersOf(boxSteps)}. drag onto another box to stack, or use unstack to separate steps.`
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

  // ── the toolbox, beside the selection ──
  let toolbox: ReactNode = null;
  if (!drag && rects.selected.length && (selectedBoxes.length || selectedSteps.length)) {
    const top = Math.min(...rects.selected.map((rect) => rect.top));
    const bottom = Math.max(...rects.selected.map((rect) => rect.top + rect.height));
    const left = Math.min(...rects.selected.map((rect) => rect.left));
    const above = top > 52;
    const style = { left: `${left + toolboxShift}px`, top: `${above ? top - 10 : bottom + 10}px` };
    const others = (except: PathwayScreen[]) => pathway.screens.filter((screen) => !except.includes(screen));
    const more = (
      <button
        aria-label="more"
        className="pathway-tool"
        onClick={(event) => {
          const button = event.currentTarget.getBoundingClientRect();
          openMenuAt(button.left, button.bottom + 4);
        }}
        title="everything else (right-click)"
        type="button"
      >
        ⋯
      </button>
    );
    let tools: ReactNode;
    if (selectedBoxes.length === 1) {
      const box = selectedBoxes[0];
      const first = candidateById.get(firstOf(box));
      const steps = stepsOf(box);
      const phase = phaseOfStep(steps[0]?.step_index ?? 0);
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
            ref={titleRef}
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
          <select
            aria-label="stack onto another box"
            className="pathway-tool-select"
            onChange={(event) => {
              const target = screenById.get(event.target.value);
              if (target) stackBox(box, target);
            }}
            title={`moves all of ${numbersOf(steps)} into the box you choose`}
            value=""
          >
            <option value="">stack onto…</option>
            {others([box]).map((screen) => (
              <option key={screen.id} value={screen.id}>
                {name(screen)} ({numbersOf(stepsOf(screen))})
              </option>
            ))}
          </select>
          {steps.length > 1 ? (
            <button
              aria-expanded={menu?.kind === 'unstack'}
              aria-haspopup="menu"
              className={`pathway-tool ${menu?.kind === 'unstack' ? 'is-on' : ''}`}
              data-pathway-unstack-trigger=""
              onClick={(event) => {
                if (menu?.kind === 'unstack') {
                  setMenu(null);
                  return;
                }
                const button = event.currentTarget.getBoundingClientRect();
                openMenuAt(button.left, button.bottom + 4, 'unstack');
              }}
              title="unstack all steps, pop out one step, or open the step editor"
              type="button"
            >
              unstack…
            </button>
          ) : null}
          <button className="pathway-tool" onClick={() => (phase ? openPhases({ phase }) : phaseFor(steps))} title={phase ? `the phase ${phase.name}` : 'make a phase from this box'} type="button">
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
          {more}
        </>
      );
    } else {
      const own = screenOf(selectedSteps[0].source_candidate_id);
      const first = candidateById.get(selectedSteps[0].source_candidate_id);
      // Every step stacked on this box can be picked on its own from the step toolbar.
      const boxSteps = own ? stepsOf(own) : selectedSteps;
      const picked = new Set(selectedSteps.map((step) => step.step_id));
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
                  {step.step_index}
                </button>
              ))}
            </span>
          ) : (
            <span className="pathway-tool-label">{numbersOf(selectedSteps)}</span>
          )}
          <button className="pathway-tool" onClick={() => moveStep(selectedSteps, 'own')} title="pop this step out into a box of its own" type="button">
            own screen
          </button>
          <select
            aria-label="put it on another box"
            className="pathway-tool-select"
            onChange={(event) => {
              const target = screenById.get(event.target.value);
              if (target) moveStep(selectedSteps, target);
            }}
            value=""
          >
            <option value="">put it on…</option>
            {others(own ? [own] : []).map((screen) => (
              <option key={screen.id} value={screen.id}>
                {name(screen)} ({numbersOf(stepsOf(screen))})
              </option>
            ))}
          </select>
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

  return (
    <>
      <div className="pathway-sticky">
        <div className="pathway-status" role="status">
          <span className="pathway-status-text" key={message?.key ?? 'state'}>
            {status}
          </span>
          <span className="pathway-status-keys">
            {history.length ? (
              <button className="analysis-task-link subtle" disabled={busy} onClick={undo} type="button">
                undo ⌘Z
              </button>
            ) : null}
          </span>
        </div>
      </div>
      {phaseRequest ? (
        <PathwayPhases disabled={busy} onClose={() => onPhaseRequest(null)} onSet={setPhase} pathway={pathway} request={phaseRequest} />
      ) : null}
      <div className="pathway-scroll">
        <div className={`pathway-stage ${drag ? 'is-dragging' : ''}`} ref={stageRef} style={{ width: `${width}px` }}>
          <div
            aria-label={ariaLabel}
            className="pathway-figure"
            // The markup is built by buildPathwayFigure, which escapes every title, note and address it places.
            dangerouslySetInnerHTML={markup}
            onContextMenu={handleContextMenu}
            onKeyDown={handleFigureKey}
            onPointerDown={handlePointerDown}
            onPointerLeave={onPointerLeave}
            onPointerOver={onPointerOver}
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
          {rects.source ? (
            <span aria-hidden="true" className="pathway-drag-source" style={{ left: rects.source.left, top: rects.source.top, width: rects.source.width, height: rects.source.height }} />
          ) : null}
          {rects.target ? (
            <span aria-hidden="true" className="pathway-drop" style={{ left: rects.target.left - 6, top: rects.target.top - 6, width: rects.target.width + 12, height: rects.target.height + 12 }} />
          ) : null}
          {toolbox}
          {menu ? <PathwayMenu items={menuItems()} onClose={() => setMenu(null)} x={menu.x} y={menu.y} /> : null}
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

/** The actions as a menu, at the pointer; an item with items of its own opens them beside it. */
function PathwayMenu({ items, x, y, onClose }: { items: MenuItem[]; x: number; y: number; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  // A menu near the right or bottom edge of the window opens to the left or upwards.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    setShift({
      x: box.right > window.innerWidth - 8 ? -(box.width) : 0,
      y: box.bottom > window.innerHeight - 8 ? -(box.bottom - window.innerHeight + 8) : 0,
    });
  }, [x, y]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(':scope > div > button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
    } else if (event.key === 'ArrowRight' && index >= 0 && items[index]?.items) {
      event.preventDefault();
      setOpen(index);
    } else if (event.key === 'ArrowLeft') {
      setOpen(null);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
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
      style={{ left: x + shift.x, top: y + shift.y }}
    >
      {items.map((item, index) => (
        <div className="pathway-menu-row" key={item.label} onPointerEnter={() => setOpen(item.items ? index : null)}>
          {item.divider ? <div aria-hidden="true" className="pathway-menu-divider" /> : null}
          <button
            aria-expanded={item.items ? open === index : undefined}
            aria-haspopup={item.items ? 'menu' : undefined}
            className={`pathway-menu-item ${item.danger ? 'is-danger' : ''}`}
            onClick={() => {
              if (item.items) {
                setOpen(open === index ? null : index);
                return;
              }
              onClose();
              item.run?.();
            }}
            role="menuitem"
            type="button"
          >
            <span>{item.label}</span>
            <span className="pathway-menu-hint">{item.items ? '▸' : item.hint ?? ''}</span>
          </button>
          {item.items && open === index ? <PathwaySubmenu items={item.items} onClose={onClose} /> : null}
        </div>
      ))}
    </div>
  );
}

/** The items of a menu item, beside it: to the right, or to the left where the window ends. */
function PathwaySubmenu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [toLeft, setToLeft] = useState(false);
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box && box.right > window.innerWidth - 8) setToLeft(true);
  }, []);
  return (
    <div className={`pathway-menu pathway-submenu ${toLeft ? 'to-left' : ''}`} ref={ref} role="menu">
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
            <span>{child.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
