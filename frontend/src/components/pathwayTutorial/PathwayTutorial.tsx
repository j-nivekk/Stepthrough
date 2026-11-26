import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { track } from '../../lib/usage';

import { ART_HEIGHT, ART_WIDTH, MockArt } from './MockArt';
import { MockPathway, type MockNotes, type ScreenMark } from './MockPathway';
import {
  buildMockPathway,
  isPopup,
  jsonStep,
  mockName,
  mockNames,
  mockNumber,
  mockStep,
  reasonText,
  type BoxMode,
  type Choices,
  type ScreenLink,
} from './tutorialModel';

const GUIDE_URL = 'https://github.com/j-nivekk/Stepthrough/wiki/';
/** How long "show me" shades a control green before it uses it, so it can be seen what is about to happen. */
const DEMO_LEAD_MS = 700;
const SEEN_KEY = 'stepthrough.pathway-tutorial.v1';
/** The corrections of lesson 5, applied when a later lesson is opened first. */
const FIXED: Choices = { 6: { link: 1 }, 8: { link: 'new' } };

export function pathwayTutorialSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return true;
  }
}

export function markPathwayTutorialSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, 'seen');
  } catch {
    // storage can be unavailable; the invitation then shows again next time
  }
}

interface Lesson {
  name: string;
  title: string;
  guide: string;
  guideLabel: string;
  task: string;
}

const LESSONS: Lesson[] = [
  {
    name: 'line to chart',
    title: 'a recording is a line; a pathway folds it',
    guide: 'Installing-and-Starting#key-terms',
    guideLabel: 'key terms: step, screen, pathway',
    task: 'switch from the recording to the pathway, and back, to watch the steps fold into screens.',
  },
  {
    name: 'read it',
    title: 'follow the journey',
    guide: 'Pathways#how-to-read-a-pathway',
    guideLabel: 'reading a pathway',
    task: 'walk through the journey with ▶ until you reach step 7.',
  },
  {
    name: 'why together',
    title: 'why steps share a box',
    guide: 'Pathways#automatic-grouping-screens-vs-steps',
    guideLabel: 'which steps count as the same screen',
    task: 'click the step numbers 2, 4 and 7 under the boxes to see why each is where it is.',
  },
  {
    name: 'check it',
    title: 'it sees pixels, not meaning',
    guide: 'How-Detection-Works-and-Settings#what-it-cannot-do',
    guideLabel: 'what it cannot do',
    task: 'find the two mistakes. look inside the boxes, then say for each box whether it is right.',
  },
  {
    name: 'correct it',
    title: 'correct it, step by step',
    guide: 'Pathways#correcting-the-pathway',
    guideLabel: 'when the pathway gets it wrong',
    task: 'put step 5 on home (box 1), and give step 7 a screen of its own.',
  },
  {
    name: 'decide',
    title: 'one screen or two is your decision',
    guide: 'Using-Stepthrough-in-Research#reporting-what-you-did',
    guideLabel: 'reporting what you did',
    task: 'decide whether settings before and after the pop-up are one screen or two.',
  },
  {
    name: 'figure',
    title: 'export the figure and the data',
    guide: 'Exports-and-Project-Files',
    guideLabel: 'exports',
    task: 'move the notes into a key below the chart.',
  },
];

/** The lessons' short names, in order (the usage report names them). */
export const TUTORIAL_LESSON_NAMES = LESSONS.map((lesson) => lesson.name);

type Verdict = 'right' | 'split' | 'merged';

const VERDICTS: Array<[Verdict, string]> = [
  ['right', 'yes: one screen'],
  ['split', 'no: the same screen as another box'],
  ['merged', 'no: different screens in one box'],
];

const SPLIT =
  'found it: home is in two boxes. the start and step 5 both show home, but by then the feed had other posts, so hardly anything of the first picture was left and it got a box of its own. one screen, split in two.';
const MERGED =
  'found it: 6 and 7 are two different products, with another photo, name and price. opening a second product is going to another place in the app, so it needs a box of its own. but all the rest of the page is the same on both, so stepthrough found most of 6 again on 7, labelled 7 an update, and kept it with 6. two screens in one box.';

/** What each answer about each box of the automatic pathway means. */
const ANSWERS: Record<number, Record<Verdict, { ok: boolean; text: string }>> = {
  1: {
    right: { ok: false, text: 'box 1 on its own is fine. but is there another box that shows home too?' },
    split: { ok: true, text: SPLIT },
    merged: { ok: false, text: 'box 1 holds one screenshot only, so it cannot hold two screens.' },
  },
  2: {
    right: { ok: true, text: 'right: 1, 2 and 4 are all settings: opened, scrolled, and back after the pop-up with notifications on. one place.' },
    split: { ok: false, text: 'no other box shows settings.' },
    merged: { ok: false, text: '1, 2 and 4 look a little different, but all are the settings screen: scrolled, and with a switch now on. one place.' },
  },
  4: {
    right: { ok: true, text: 'right: a pop-up is a screen of its own, drawn with a dashed frame.' },
    split: { ok: false, text: 'no other box shows this pop-up.' },
    merged: { ok: false, text: 'it holds one step only, so it cannot hold two screens.' },
  },
  6: {
    right: { ok: false, text: 'look at what it shows, and compare it with box 1.' },
    split: { ok: true, text: SPLIT },
    merged: { ok: false, text: 'it holds one step only, so it cannot hold two screens. but which screen is it?' },
  },
  7: {
    right: { ok: false, text: 'look inside: hover 6 and 7. are they the same product?' },
    split: { ok: false, text: 'no other box shows these products. but are 6 and 7 the same product?' },
    merged: { ok: true, text: MERGED },
  },
};

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export interface PathwayTutorialProps {
  onClose: () => void;
}

/**
 * A hands-on tutorial for pathways. Instead of watching, the learner works on a small practice pathway:
 * folds a recording into screens, follows the journey, finds what the automatic grouping got wrong,
 * corrects it, decides an interpretive question, and prepares the figure. The chart animates every change,
 * so the effect of each action can be seen.
 */
export function PathwayTutorial({ onClose }: PathwayTutorialProps) {
  const reducedMotion = useRef(prefersReducedMotion()).current;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<number[]>([]);
  const [lesson, setLesson] = useState(0);
  // For the usage report: which lessons were solved, and since when the tutorial is open.
  const solved = useRef(new Set<number>());
  const openedAt = useRef(Date.now());
  const [done, setDone] = useState<Set<number>>(new Set());
  const [view, setView] = useState<'line' | 'chart'>('line');
  const [folds, setFolds] = useState(0);
  const [mode, setMode] = useState<BoxMode>('screens');
  const [choices, setChoices] = useState<Choices>({});
  const [current, setCurrent] = useState<number | null>(null);
  const [inspected, setInspected] = useState<Set<number>>(new Set());
  const [bubble, setBubble] = useState<{ step: number; text: string } | null>(null);
  const [marks, setMarks] = useState<Record<number, ScreenMark>>({});
  // Lesson 4: the box being looked at (as boxes are by screen), the step clicked to get there when boxes are
  // by step, and the answers given.
  const [checked, setChecked] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>({});
  const [selected, setSelected] = useState<number | null>(null);
  // After a choice, the box of the step that changed is selected (boxes are made again on every change).
  const [follow, setFollow] = useState<number | null>(null);
  // Lesson 5 ("correct it"), as in the app: the step whose number was clicked, a step being dragged (and the box it
  // would go to, or 'new' off the boxes), and the choices before each change, for the undo.
  const [chosenStep, setChosenStep] = useState<number | null>(null);
  const [putMenuOpen, setPutMenuOpen] = useState(false);
  const putMenuRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ n: number; x: number; y: number; moved: boolean; target: number | 'new' | null } | null>(null);
  const [history, setHistory] = useState<Choices[]>([]);
  // The choices as they are now, for the undo of a change made later ("show me" makes its changes on a timer).
  const choicesNow = useRef<Choices>({});
  const [decision, setDecision] = useState<'one' | 'two' | null>(null);
  const [notes, setNotes] = useState<MockNotes>('hidden');
  const [times, setTimes] = useState(false);
  const [caption, setCaption] = useState(false);
  const [downloadNote, setDownloadNote] = useState<'svg' | 'png' | null>(null);
  // What "show me" is about to use (`view:chart`, `pill:3`, `box:6`, `menu:new` ...), shaded green.
  const [demo, setDemo] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  choicesNow.current = choices;
  const pathway = useMemo(() => buildMockPathway(choices, mode), [choices, mode]);
  const byScreen = useMemo(() => buildMockPathway(choices, 'screens'), [choices]);
  const splitFound = verdicts[1] === 'split' || verdicts[6] === 'split';
  const mergedFound = verdicts[7] === 'merged';
  const info = LESSONS[lesson] ?? LESSONS[0];

  useEffect(() => {
    if (follow === null) return;
    setSelected(pathway.screenOf.get(follow) ?? null);
    setFollow(null);
  }, [pathway, follow]);

  function clearTimers() {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  }

  function later(ms: number, action: () => void) {
    timers.current.push(window.setTimeout(action, reducedMotion ? 0 : ms));
  }

  function complete(index: number) {
    if (!solved.current.has(index)) {
      solved.current.add(index);
      track({ kind: 'tutorial_solved', lesson: index + 1 });
    }
    setDone((previous) => (previous.has(index) ? previous : new Set(previous).add(index)));
  }

  useEffect(() => {
    track({ kind: 'tutorial_lesson', lesson: lesson + 1 });
  }, [lesson]);

  useEffect(
    () => () =>
      track({
        kind: 'tutorial_closed',
        solved: solved.current.size,
        minutes: Math.round((Date.now() - openedAt.current) / 60_000),
      }),
    [],
  );

  // Every lesson starts from its own state, so lessons can be taken again or out of order.
  function open(index: number) {
    clearTimers();
    setDemo(null);
    setLesson(index);
    setView(index === 0 ? 'line' : 'chart');
    setFolds(0);
    setMode('screens');
    const restored: Choices = index === 6 && decision === 'two' ? { ...FIXED, 5: { link: 'new' } } : FIXED;
    setChoices(index >= 5 ? restored : {});
    setCurrent(index === 1 ? 1 : null);
    setInspected(new Set());
    setBubble(null);
    setMarks({});
    setChecked(null);
    setPicked(null);
    setVerdicts({});
    setSelected(null);
    setChosenStep(null);
    setPutMenuOpen(false);
    setDrag(null);
    setHistory([]);
    if (index === 5) setDecision(null);
    setNotes(index === 6 ? 'under' : 'hidden');
    setTimes(false);
    setCaption(index === 6);
    setDownloadNote(null);
  }

  useEffect(() => {
    setPutMenuOpen(false);
  }, [chosenStep, lesson]);

  useEffect(() => {
    if (!putMenuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!putMenuRef.current?.contains(event.target as Node)) setPutMenuOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [putMenuOpen]);

  useEffect(() => () => clearTimers(), []);

  // ── what the lessons check ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (lesson === 0 && folds >= 2) complete(0);
    if (lesson === 1 && current === 8) complete(1);
    if (lesson === 2 && [3, 5, 8].every((n) => inspected.has(n))) complete(2);
    if (lesson === 3 && splitFound && mergedFound) complete(3);
    if (lesson === 4 && pathway.screenOf.get(6) === pathway.screenOf.get(1) && pathway.screenOf.get(8) !== pathway.screenOf.get(7)) complete(4);
    if (lesson === 5 && decision) complete(5);
    if (lesson === 6 && notes === 'key') {
      complete(6);
      markPathwayTutorialSeen();
    }
  }, [lesson, folds, current, inspected, splitFound, mergedFound, pathway, decision, notes]);

  // ── actions ────────────────────────────────────────────────────────────────────────────────────

  function fold(next: 'line' | 'chart') {
    // Read through a ref: "show me" calls this later, when the view it saw may have changed.
    if (next === viewRef.current) return;
    setView(next);
    setFolds((count) => count + 1);
  }

  function inspect(n: number) {
    setBubble((shown) => (shown?.step === n ? null : { step: n, text: `${mockNumber(n)} · ${reasonText(pathway, n, choices)}` }));
    setInspected((previous) => new Set(previous).add(n));
  }

  /** Look inside a box. When boxes are by step, a step stands for the box it is in when boxes are by screen. */
  function look(id: number) {
    const box = mode === 'steps' ? byScreen.screenOf.get(id) ?? id : id;
    setPicked(mode === 'steps' ? id : null);
    setChecked(box);
  }

  function answer(box: number, verdict: Verdict) {
    const result = ANSWERS[box]?.[verdict];
    if (!result) return;
    setVerdicts((previous) => ({ ...previous, [box]: verdict }));
    if (result.ok && verdict === 'split') setMarks((previous) => ({ ...previous, 1: 'good', 6: 'good' }));
    if (result.ok && verdict === 'merged') setMarks((previous) => ({ ...previous, 7: 'good' }));
  }

  function choose(n: number, link: ScreenLink | 'auto') {
    const before = choicesNow.current;
    setHistory((previous) => [...previous, before]);
    setChoices((previous) => {
      const next = { ...previous, [n]: { ...previous[n] } };
      if (link === 'auto') delete next[n].link;
      else next[n].link = link;
      return next;
    });
    setFollow(n);
  }

  /** Take the last change back, as ⌘Z does in the app. */
  function undo() {
    const last = history[history.length - 1];
    if (!last) return;
    setChoices(last);
    setHistory((previous) => previous.slice(0, -1));
  }

  // A step number pressed and moved is dragged: onto a box puts it there, off the boxes gives it a screen of its
  // own. Let go without moving, it is a click, which selects the step (MockPathway's onStep).
  useEffect(() => {
    if (!drag) return;
    const current = drag;
    function move(event: PointerEvent) {
      const moved = current.moved || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 5;
      if (!moved) return;
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const box = under?.closest('[data-box]');
      const own = pathway.screenOf.get(current.n);
      const id = box ? Number(box.getAttribute('data-box')) : null;
      const target = id !== null && id !== own ? id : !box && under?.closest('.pt-mock') ? 'new' : null;
      setDrag({ ...current, moved, x: event.clientX, y: event.clientY, target });
    }
    function up() {
      setDrag(null);
      if (current.moved && current.target !== null) {
        choose(current.n, current.target);
        setChosenStep(current.n);
      }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  function setPopup(n: number, popup: boolean) {
    const automatic = mockStep(n).label === 'modal';
    const before = choicesNow.current;
    setHistory((previous) => [...previous, before]);
    setChoices((previous) => {
      const next = { ...previous, [n]: { ...previous[n] } };
      if (popup === automatic) delete next[n].popup;
      else next[n].popup = popup;
      return next;
    });
  }

  function decide(answer: 'one' | 'two') {
    setDecision(answer);
    setChoices((previous) => {
      const next = { ...previous, 5: { ...previous[5] } };
      if (answer === 'two') next[5].link = 'new';
      else delete next[5].link;
      return next;
    });
  }

  /**
   * Play a lesson's task: each part first shades what it is about to use green, then uses it, the way a
   * person would point before they click.
   */
  function play(parts: Array<[target: string, action: () => void]>, gap: number) {
    clearTimers();
    parts.forEach(([target, action], index) => {
      later(index * gap, () => setDemo(target));
      later(index * gap + DEMO_LEAD_MS, action);
    });
    later((parts.length - 1) * gap + DEMO_LEAD_MS + 800, () => setDemo(null));
  }

  function showMe() {
    track({ kind: 'tutorial_show_me', lesson: lesson + 1 });
    if (lesson === 0) {
      play(
        [
          ['view:chart', () => fold('chart')],
          ['view:line', () => fold('line')],
          ['view:chart', () => fold('chart')],
        ],
        2000,
      );
    } else if (lesson === 1) {
      const parts: Array<[string, () => void]> = [];
      for (let n = (current ?? 1) + 1; n <= 8; n += 1) parts.push(['walk:next', () => setCurrent(n)]);
      play(parts, 1000);
    } else if (lesson === 2) {
      play(
        [3, 5, 8].filter((n) => !inspected.has(n)).map((n) => [`pill:${n}`, () => inspect(n)] as [string, () => void]),
        2200,
      );
    } else if (lesson === 3) {
      const parts: Array<[string, () => void]> = mode === 'steps' ? [['boxes:screens', () => setMode('screens')]] : [];
      if (!splitFound) parts.push(['box:6', () => setChecked(6)], ['verdict:split', () => answer(6, 'split')]);
      if (!mergedFound) parts.push(['box:7', () => setChecked(7)], ['pill:8', () => undefined], ['verdict:merged', () => answer(7, 'merged')]);
      play(parts, 1700);
    } else if (lesson === 4) {
      // step 6 is picked up and dropped on home; step 8 gets a screen of its own from its toolbox
      const parts: Array<[string, () => void]> = [];
      if (pathway.screenOf.get(6) !== pathway.screenOf.get(1)) {
        parts.push(['pill:6', () => setChosenStep(6)], ['box:1', () => choose(6, 1)]);
      }
      if (pathway.screenOf.get(8) === pathway.screenOf.get(7)) {
        parts.push(['pill:8', () => setChosenStep(8)], ['tool:own', () => choose(8, 'new')]);
      }
      play(parts, 1500);
    } else if (lesson === 5) {
      play([['decide:one', () => decide('one')]], 0);
    } else if (lesson === 6) {
      play([['notes:key', () => setNotes('key')]], 0);
    }
  }

  /** The green shade on what "show me" is about to use. */
  const shade = (target: string) => (demo === target ? ' pt-demo' : '');

  // ── keyboard: keep the page's shortcuts away, close on escape, keep focus inside ─────────────────

  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (putMenuOpen) setPutMenuOpen(false);
      else if (drag) setDrag(null);
      else if (chosenStep !== null) setChosenStep(null);
      else onClose();
      return;
    }
    if (lesson === 4 && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      undo();
      return;
    }
    if (event.key === 'Tab') {
      const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? []);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    // Stopped here, the page's review shortcuts (a, r, u, p, arrows, space) never see it; the focused
    // control still gets its usual behaviour.
    event.stopImmediatePropagation();
  };

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => keyRef.current(event);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previousFocus?.focus?.();
    };
  }, []);

  function close() {
    if (done.size) markPathwayTutorialSeen();
    onClose();
  }

  // ── the parts of each lesson ───────────────────────────────────────────────────────────────────

  const story = current ? mockStep(current) : null;
  // The toolbox of the step whose number was clicked, matching the app: own screen (only on stacked boxes),
  // put it on… (custom menu with screen thumbnails), pop-up, and stack automatically when overridden.
  const ownBox = chosenStep !== null ? pathway.screenOf.get(chosenStep) : undefined;
  const ownScreen = ownBox !== undefined ? pathway.screens.find((screen) => screen.id === ownBox) : undefined;
  const canSplitOwn = Boolean(ownScreen && ownScreen.steps.length > 1);
  const stepTool =
    lesson === 4 && chosenStep !== null ? (
      <>
        <span className="pathway-tool-label">{mockName(chosenStep)}</span>
        {canSplitOwn ? (
          <button className={`pathway-tool${shade('tool:own')}`} onClick={() => choose(chosenStep, 'new')} type="button">
            own screen
          </button>
        ) : null}
        <div className="pt-put-shell" ref={putMenuRef}>
          <button
            aria-expanded={putMenuOpen}
            aria-haspopup="menu"
            className={`pathway-tool ${putMenuOpen ? 'is-on' : ''}`}
            onClick={() => setPutMenuOpen((open) => !open)}
            type="button"
          >
            put it on…
          </button>
          {putMenuOpen ? (
            <div className="pathway-menu is-compact pt-put-menu" role="menu">
              {pathway.screens
                .filter((screen) => screen.id !== ownBox)
                .map((screen) => {
                  const previewStep = screen.steps[0];
                  return (
                    <div className="pathway-menu-row" key={screen.id}>
                      <button
                        className="pathway-menu-item"
                        onClick={() => {
                          setPutMenuOpen(false);
                          choose(chosenStep, screen.id);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <span className="pathway-menu-item-body">
                          <span aria-hidden="true" className="pathway-menu-thumb pt-menu-thumb">
                            <svg viewBox={`0 0 ${ART_WIDTH} ${ART_HEIGHT}`}>
                              <MockArt art={mockStep(previewStep).art} />
                            </svg>
                          </span>
                          <span>
                            S{screen.index} · {screen.title}
                          </span>
                        </span>
                      </button>
                    </div>
                  );
                })}
            </div>
          ) : null}
        </div>
        <button
          aria-pressed={isPopup(mockStep(chosenStep), choices)}
          className={`pathway-tool ${isPopup(mockStep(chosenStep), choices) ? 'is-on' : ''}`}
          onClick={() => setPopup(chosenStep, !isPopup(mockStep(chosenStep), choices))}
          type="button"
        >
          pop-up
        </button>
        {choices[chosenStep]?.link !== undefined ? (
          <button className="pathway-tool" onClick={() => choose(chosenStep, 'auto')} type="button">
            stack automatically
          </button>
        ) : null}
      </>
    ) : null;

  let body: ReactNode = null;
  let tools: ReactNode = null;
  let after: ReactNode = null;
  let below: ReactNode = null;
  if (lesson === 0) {
    body = (
      <>
        <p>
          stepthrough finds steps in time order: the recording is a line. a <b>pathway</b> puts the steps that show
          the same screen of the app in one box. the line folds into a chart, and what a line hides becomes
          visible: where someone went back, took a detour, or went another way.
        </p>
        <p>a pathway is drawn from the <b>accepted</b> steps only, so review the steps first.</p>
      </>
    );
    tools = (
      <div aria-label="view" className="pt-switch" role="group">
        <button aria-pressed={view === 'line'} className={`candidate-filter-tab ${view === 'line' ? 'active' : ''}${shade('view:line')}`} onClick={() => fold('line')} type="button">
          the recording
        </button>
        <button aria-pressed={view === 'chart'} className={`candidate-filter-tab ${view === 'chart' ? 'active' : ''}${shade('view:chart')}`} onClick={() => fold('chart')} type="button">
          the pathway
        </button>
      </div>
    );
  } else if (lesson === 1) {
    body = (
      <>
        <p>
          the journey begins at <b>start</b>, the opening screen: nothing was done to get there, so it is not a step. the
          black numbers are step numbers, as in <code>steps.csv</code>. each arrow carries the number of the step it leads
          to, so you can read the journey straight through from 1 onwards.
        </p>
        <p>
          solid arrows move onwards (<b>amber</b> on a branch or detour), while <b>dashed blue</b> arrows return to a
          screen seen earlier. stacked cards hold several steps on one screen, a <b>dashed frame</b> marks a pop-up,
          and renamed screens keep a small <b>S#</b> tag.
        </p>
      </>
    );
    tools = (
      <div className="pt-walk">
        <button aria-label="previous step" className="demo-icon-button" disabled={!current || current <= 1} onClick={() => setCurrent((n) => Math.max(1, (n ?? 1) - 1))} type="button">
          ◀
        </button>
        <span className="pt-walk-text">
          <b>{current ? mockName(current) : ''}</b> · {story?.story}
        </span>
        <button aria-label="next step" className={`demo-icon-button primary${shade('walk:next')}`} disabled={current === 8} onClick={() => setCurrent((n) => Math.min(8, (n ?? 0) + 1))} type="button">
          ▶
        </button>
      </div>
    );
    if (current === 6) after = <p className="pt-aside">home again, but in a box of its own. keep that in mind for lesson 4.</p>;
  } else if (lesson === 2) {
    body = (
      <>
        <p>a step joins the box of an earlier step by the first of these that applies:</p>
        <ol className="pt-points">
          <li>
            <b>your choice</b> (lesson 5);
          </li>
          <li>
            a <b>revisit</b>: the same picture as before;
          </li>
          <li>
            <b>what the screenshots show</b>: the pop-up over the screen closed, the content scrolled, something was
            typed, or most of what is there was seen before.
          </li>
        </ol>
        <p>a pop-up starts a box of its own, and so does a screen where hardly anything was seen before.</p>
      </>
    );
    tools = (
      <div aria-label="view" className="pt-switch" role="group">
        <span className="pathway-control-label">view</span>
        {(['screens', 'steps'] as const).map((value) => (
          <button
            aria-pressed={mode === value}
            className={`candidate-filter-tab ${mode === value ? 'active' : ''}`}
            key={value}
            onClick={() => {
              setMode(value);
              setBubble(null);
            }}
            type="button"
          >
            {value}
          </button>
        ))}
        <span className="pt-tool-hint">
          <b>steps</b> keeps only the first two rules: your choice and a revisit
        </span>
      </div>
    );
  } else if (lesson === 3) {
    body = (
      <>
        <p>
          the grouping goes by what the screen looks like, not by what it means, so check every pathway against
          the recording. look for two kinds of mistakes:
        </p>
        <ul className="pt-points">
          <li>
            <b>one screen, split in two</b>: two boxes show the same screen, because what is on it was replaced (a feed
            with other posts, dark mode);
          </li>
          <li>
            <b>two screens in one box</b>: one box holds different places, because most of what they show is the same
            (two products, two profiles, two pages that are still empty).
          </li>
        </ul>
        <p>a box shows only its first step: rest the pointer on a step number to see the others.</p>
      </>
    );
    tools = (
      <div aria-label="view" className="pt-switch" role="group">
        <span className="pathway-control-label">view</span>
        {(['screens', 'steps'] as const).map((value) => (
          <button
            aria-pressed={mode === value}
            className={`candidate-filter-tab ${mode === value ? 'active' : ''}${shade(`boxes:${value}`)}`}
            key={value}
            onClick={() => {
              setMode(value);
              setPicked(null);
            }}
            type="button"
          >
            {value}
          </button>
        ))}
        <span className="pt-tool-hint">
          {mode === 'steps' ? 'every step on its own: click one to look at the box it is in' : 'hover a step number to see its screenshot · click a box to look inside'}
        </span>
      </div>
    );
    after = (
      <ul className="pt-found">
        <li className={splitFound ? 'found' : ''}>
          <span aria-hidden="true">{splitFound ? '✓' : '○'}</span> one screen, split in two
        </li>
        <li className={mergedFound ? 'found' : ''}>
          <span aria-hidden="true">{mergedFound ? '✓' : '○'}</span> two screens in one box
        </li>
      </ul>
    );
    const inside = checked !== null ? byScreen.screens.find((screen) => screen.id === checked) : null;
    const given = checked !== null ? verdicts[checked] : undefined;
    const result = checked !== null && given ? ANSWERS[checked]?.[given] : undefined;
    below = inside ? (
      <div className="pt-inside-wrap">
        <p className="pt-inside-title">
          {picked !== null ? `${mockName(picked)} is in ` : 'inside '}box {inside.index}, <b>{inside.title}</b>: {mockNames(inside.steps)}
          {picked !== null ? ' (in screens view)' : ''}
        </p>
        <div className="pt-inside">
          {inside.steps.map((n) => (
            <figure className={n === picked ? 'picked' : ''} key={n}>
              <svg aria-hidden="true" viewBox={`0 0 ${ART_WIDTH} ${ART_HEIGHT}`}>
                <MockArt art={mockStep(n).art} />
                <rect fill="none" height={ART_HEIGHT} stroke="#111" strokeWidth={1} width={ART_WIDTH} />
              </svg>
              <figcaption>
                <b>{mockNumber(n)}</b> {mockStep(n).label}
              </figcaption>
            </figure>
          ))}
          <div className="pt-verdict">
            <p>is this box right?</p>
            <div className="pt-verdict-buttons" role="group" aria-label="is this box right?">
              {VERDICTS.map(([value, label]) => (
                <button
                  aria-pressed={given === value}
                  className={`analysis-pill ${given === value ? (result?.ok ? 'success' : 'danger') : ''}${shade(`verdict:${value}`)}`}
                  key={value}
                  onClick={() => answer(inside.id, value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            {result ? <p className={`pt-verdict-result ${result.ok ? 'ok' : ''}`}>{result.text}</p> : null}
          </div>
        </div>
      </div>
    ) : (
      <p className="pt-inside-title">click a box to look inside it: its steps are shown here, side by side.</p>
    );
  } else if (lesson === 4) {
    body = (
      <>
        <p>
          in the pathway, click the number under a box to select that step. a toolbox opens beside it:
        </p>
        <ul className="pt-points">
          <li>
            <b>put it on…</b> another box (with screen thumbnails);
          </li>
          <li>
            <b>own screen</b> (on a stacked box): the step gets a box of its own.
          </li>
        </ul>
        <p>
          or drag the number: onto a box to put the step there, or off the boxes for a screen of its own. in a real
          pathway, clicking a box opens <b>stacking…</b>, <b>phase…</b> and <b>⋯</b>, and dragging a box onto another
          stacks all its steps. every change can be taken back with <b>⌘Z</b>.
        </p>
      </>
    );
    const own = chosenStep !== null ? pathway.screenOf.get(chosenStep) : undefined;
    const targetBox = drag?.target !== undefined && drag?.target !== null && drag.target !== 'new' ? pathway.screens.find((screen) => screen.id === drag.target) : undefined;
    const status = drag?.moved
      ? drag.target === 'new'
        ? `let go to give ${mockName(drag.n)} a screen of its own`
        : targetBox
          ? `let go to put ${mockName(drag.n)} on box ${targetBox.index}, ${targetBox.title}`
          : 'let go outside the chart, or press Escape, to leave it'
      : chosenStep !== null
        ? `${mockName(chosenStep)}: drag it onto a box, or use the toolbox`
        : 'click a step number to select that step, or drag it onto a box';
    tools = (
      <div className="pt-status">
        <span>{status}</span>
        {history.length ? (
          <button className={`analysis-task-link subtle${shade('undo')}`} onClick={undo} type="button">
            undo ⌘Z
          </button>
        ) : null}
      </div>
    );
    if (done.has(4))
      after = (
        <p className="pt-feedback">
          both fixed. each choice is stored on its step: the step list shows <code>stacking: same as start</code>, and{' '}
          <code>pathway.json</code> marks the grouping as <code>researcher</code>.
        </p>
      );
  } else if (lesson === 5) {
    body = (
      <>
        <p>
          step 4 is settings again, with notifications now switched on. stepthrough put it with 1, because the
          pop-up closed. but is &ldquo;off&rdquo; and &ldquo;on&rdquo; one screen or two?
        </p>
        <p>
          there is no automatic right answer: it depends on your question. for a study of <b>consent prompts</b>,
          what would you choose?
        </p>
        <div className="pt-choice">
          <button className={`analysis-pill ${decision === 'one' ? 'success' : ''}${shade('decide:one')}`} onClick={() => decide('one')} type="button">
            one screen
          </button>
          <button className={`analysis-pill ${decision === 'two' ? 'success' : ''}`} onClick={() => decide('two')} type="button">
            two screens
          </button>
        </div>
      </>
    );
    after = decision ? (
      <>
        <p className="pt-feedback">
          {decision === 'one'
            ? 'one screen: the switch changes during the visit to settings. this suits a question about where people go.'
            : 'two screens: "on" gets a box of its own, so the change of state shows as a move. this suits a question about what people change.'}{' '}
          either way, apply the same rule to every recording in the study and say so in your method section.{' '}
          <code>pathway.json</code> records which groupings are yours (below the chart).
        </p>
      </>
    ) : null;
    below = (
      <table className="pt-json">
        <caption>
          <code>pathway.json</code>, as exported: the steps this lesson is about
        </caption>
        <thead>
          <tr>
            <th>step_index</th>
            <th>screen_id</th>
            <th>grouped_by</th>
            <th>screen_choice</th>
          </tr>
        </thead>
        <tbody>
          {[5, 6, 8].map((n) => {
            const row = jsonStep(pathway, n, choices);
            return (
              <tr key={n}>
                <td>{row.step_index}</td>
                <td>"{row.screen_id}"</td>
                <td>{row.grouped_by === null ? 'null' : `"${row.grouped_by}"`}</td>
                <td>"{row.screen_choice}"</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  } else if (lesson === 6) {
    body = (
      <>
        <p>
          <b>download svg</b> saves one file with the screenshots inside, ready to finish in figma, inkscape or
          illustrator: text stays text, every screen is a group. <b>png</b> saves it as a picture at twice the size,
          for slides and documents. a badge records the date and the version of stepthrough, and where to cite it.
        </p>
        <p>
          the export zip holds <code>pathway.json</code>: the same screens and moves, for your own analysis.
        </p>
      </>
    );
    tools = (
      <div className="pt-figure-tools">
        <span className="pathway-control" role="group" aria-label="notes">
          <span className="pathway-control-label">notes</span>
          {(
            [
              ['under', 'under screens'],
              ['key', 'in a key'],
              ['hidden', 'off'],
            ] as const
          ).map(([value, label]) => (
            <button aria-pressed={notes === value} className={`candidate-filter-tab ${notes === value ? 'active' : ''}${shade(`notes:${value}`)}`} key={value} onClick={() => setNotes(value)} type="button">
              {label}
            </button>
          ))}
        </span>
        <span className="pathway-control" role="group" aria-label="show">
          <span className="pathway-control-label">show</span>
          <button aria-pressed={times} className={`candidate-filter-tab ${times ? 'active' : ''}`} onClick={() => setTimes((value) => !value)} type="button">
            times
          </button>
          <button aria-pressed={caption} className={`candidate-filter-tab ${caption ? 'active' : ''}`} onClick={() => setCaption((value) => !value)} type="button">
            title and legend
          </button>
        </span>
        <span className="pathway-control pathway-download" role="group" aria-label="download">
          <span className="pathway-control-label">download</span>
          {(['svg', 'png'] as const).map((format) => (
            <button className="analysis-pill success" key={format} onClick={() => setDownloadNote((value) => (value === format ? null : format))} type="button">
              {format}
            </button>
          ))}
        </span>
      </div>
    );
    after = (
      <>
        {downloadNote ? <p className="pt-aside">in the app, this saves the chart as it is shown here, as pathway.{downloadNote}.</p> : null}
        {done.has(6) ? (
          <div className="pt-finish">
            <p>
              <b>you are ready.</b> on your own runs: accept the steps, open <b>pathway</b>, check it against the
              recording, correct what is wrong, decide what counts as one screen, and note how you decided.
            </p>
            <button className="analysis-pill success" onClick={close} type="button">
              close and try it on a run
            </button>
          </div>
        ) : null}
      </>
    );
  }

  return createPortal(
    <div
      className="demo-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div aria-labelledby="pt-title" aria-modal="true" className="demo-panel pt-panel" ref={panelRef} role="dialog" tabIndex={-1}>
        <header className="demo-header">
          <div>
            <p className="demo-eyebrow">tutorial</p>
            <h2 id="pt-title">working with pathways</h2>
          </div>
          <button aria-label="close" className="demo-icon-button" onClick={close} title="close (esc)" type="button">
            <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" viewBox="0 0 14 14" width="14">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
            </svg>
          </button>
        </header>

        <div className="pt-body">
          <section aria-live="polite" className="pt-lesson">
            <span className="demo-stage-count">
              lesson {lesson + 1} of {LESSONS.length}
            </span>
            <h3>{info.title}</h3>
            <div className="pt-text">{body}</div>
            <div className={`pt-task ${done.has(lesson) ? 'done' : ''}`}>
              <span aria-hidden="true" className="pt-task-mark">
                {done.has(lesson) ? '✓' : ''}
              </span>
              <span>
                <b>{done.has(lesson) ? 'done' : 'try it'}</b> · {info.task}
              </span>
              {done.has(lesson) ? null : (
                <button className="analysis-task-link subtle pt-show-me" disabled={demo !== null} onClick={showMe} type="button">
                  {demo !== null ? 'showing you…' : 'show me'}
                </button>
              )}
            </div>
            {after}
            <a
              className="demo-guide-link"
              href={`${GUIDE_URL}${info.guide}`}
              onClick={() => track({ kind: 'guide_opened', from: 'tutorial' })}
              rel="noreferrer"
              target="_blank"
            >
              in the guide: {info.guideLabel} ↗
            </a>
          </section>

          <section className="pt-practice">
            {tools ? <div className="pt-tools">{tools}</div> : null}
            <MockPathway
              bubble={lesson === 2 ? bubble : null}
              caption={lesson === 6 && caption}
              chosen={lesson === 4 ? chosenStep : null}
              clickable={lesson === 2 || lesson === 4 ? 'steps' : lesson === 3 ? 'screens' : null}
              current={lesson === 1 ? current : null}
              demo={demo}
              marks={lesson === 3 && mode === 'screens' ? marks : {}}
              notes={lesson === 6 ? notes : 'hidden'}
              dropTarget={lesson === 4 && drag?.moved && typeof drag.target === 'number' ? drag.target : null}
              onScreen={lesson === 3 ? look : undefined}
              onStep={lesson === 4 ? (n) => setChosenStep((shown) => (shown === n ? null : n)) : inspect}
              onStepPress={
                lesson === 4
                  ? (n, event) => {
                      if (event.button === 0) setDrag({ n, x: event.clientX, y: event.clientY, moved: false, target: null });
                    }
                  : undefined
              }
              pathway={pathway}
              selected={
                lesson === 4
                  ? selected
                  : lesson === 3 && checked !== null
                    ? mode === 'steps'
                      ? byScreen.screens.find((screen) => screen.id === checked)?.steps ?? null
                      : checked
                    : null
              }
              spotlight={lesson === 1 ? current : lesson === 2 ? bubble?.step ?? null : demo?.startsWith('pill:') ? Number(demo.slice(5)) : null}
              times={lesson === 6 && times}
              tool={drag?.moved ? null : stepTool}
              view={view}
            />
            {drag?.moved ? (
              <span aria-hidden="true" className="pathway-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
                {mockName(drag.n)}
              </span>
            ) : null}
            {below ? <div className="pt-below">{below}</div> : null}
          </section>
        </div>

        <footer className="demo-footer">
          <nav aria-label="lessons" className="demo-stages">
            {LESSONS.map((entry, index) => (
              <button
                aria-current={lesson === index ? 'step' : undefined}
                className={`candidate-filter-tab ${lesson === index ? 'active' : ''}`}
                key={entry.name}
                onClick={() => open(index)}
                type="button"
              >
                {done.has(index) ? '✓ ' : `${index + 1} `}
                {entry.name}
              </button>
            ))}
          </nav>
          <div className="demo-controls">
            <button className="analysis-task-link subtle" disabled={lesson === 0} onClick={() => open(lesson - 1)} type="button">
              back
            </button>
            {lesson < LESSONS.length - 1 ? (
              <button className={`analysis-pill ${done.has(lesson) ? 'success' : ''}`} onClick={() => open(lesson + 1)} type="button">
                next lesson
              </button>
            ) : (
              <button className="analysis-pill" onClick={close} type="button">
                close
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
