import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { track } from '../../lib/usage';

import { ART_HEIGHT, ART_WIDTH, MockArt } from './MockArt';
import { MockPathway, type MockNotes, type ScreenMark } from './MockPathway';
import {
  buildMockPathway,
  isPopup,
  jsonStep,
  mockStep,
  reasonText,
  type BoxMode,
  type Choices,
  type ScreenLink,
} from './tutorialModel';

const GUIDE_URL = 'https://github.com/j-nivekk/Stepthrough/blob/main/GUIDE.md';
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
    guide: '#2-key-terms',
    guideLabel: 'key terms: step, screen, pathway',
    task: 'switch from the recording to the pathway, and back, to watch the steps fold into screens.',
  },
  {
    name: 'read it',
    title: 'follow the journey',
    guide: '#pathway',
    guideLabel: 'reading a pathway',
    task: 'walk through the journey with ▶ until you reach step 8.',
  },
  {
    name: 'why together',
    title: 'why steps share a box',
    guide: '#pathway',
    guideLabel: 'which steps count as the same screen',
    task: 'click the step numbers 3, 5 and 8 under the boxes to see why each is where it is.',
  },
  {
    name: 'check it',
    title: 'it sees pixels, not meaning',
    guide: '#what-it-cannot-do',
    guideLabel: 'what it cannot do',
    task: 'find the two mistakes. look inside the boxes, then say for each box whether it is right.',
  },
  {
    name: 'correct it',
    title: 'correct it, step by step',
    guide: '#pathway',
    guideLabel: 'when the pathway gets it wrong',
    task: 'put step 6 on home (box 1), and give step 8 a screen of its own.',
  },
  {
    name: 'decide',
    title: 'one screen or two is your decision',
    guide: '#reporting-what-you-did',
    guideLabel: 'reporting what you did',
    task: 'decide whether settings before and after the pop-up are one screen or two.',
  },
  {
    name: 'figure',
    title: 'export the figure and the data',
    guide: '#8-exports',
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

const SPLIT = 'found it: home is in two boxes. 1 and 6 both show home, but 6 has a badge that 1 did not, so it was not the same picture and got a box of its own. one screen, split in two.';
const MERGED =
  'found it: 7 and 8 are two different articles, with another headline and another picture. reading a second article is going to another place in the app, so it needs a box of its own. stepthrough saw that the layout stayed and only the text and the picture changed, labelled 8 an update, and kept it with 7. two screens in one box.';

/** What each answer about each box of the automatic pathway means. */
const ANSWERS: Record<number, Record<Verdict, { ok: boolean; text: string }>> = {
  1: {
    right: { ok: false, text: 'box 1 on its own is fine. but is there another box that shows home too?' },
    split: { ok: true, text: SPLIT },
    merged: { ok: false, text: 'box 1 holds one step only, so it cannot hold two screens.' },
  },
  2: {
    right: { ok: true, text: 'right: 2, 3 and 5 are all settings: opened, scrolled, and back after the pop-up with notifications on. one place.' },
    split: { ok: false, text: 'no other box shows settings.' },
    merged: { ok: false, text: '2, 3 and 5 look a little different, but all are the settings screen: scrolled, and with a switch now on. one place.' },
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
    right: { ok: false, text: 'look inside: hover 7 and 8. are they the same article?' },
    split: { ok: false, text: 'no other box shows these articles. but are 7 and 8 the same article?' },
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
  const [menuStep, setMenuStep] = useState<number | null>(null);
  const [menuLeft, setMenuLeft] = useState(false);
  const [decision, setDecision] = useState<'one' | 'two' | null>(null);
  const [notes, setNotes] = useState<MockNotes>('hidden');
  const [times, setTimes] = useState(false);
  const [caption, setCaption] = useState(false);
  const [downloadNote, setDownloadNote] = useState<'svg' | 'png' | null>(null);
  // What "show me" is about to use (`view:chart`, `pill:3`, `box:6`, `menu:new` ...), shaded green.
  const [demo, setDemo] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

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
    setMenuStep(null);
    if (index === 5) setDecision(null);
    setNotes(index === 6 ? 'under' : 'hidden');
    setTimes(false);
    setCaption(index === 6);
    setDownloadNote(null);
  }

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
    setBubble((shown) => (shown?.step === n ? null : { step: n, text: `${n} · ${reasonText(pathway, n, choices)}` }));
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

  /** Open a step's screen menu, towards the left when there is no room on the right. */
  function openMenu(n: number, button: HTMLElement | null) {
    const tools = button?.closest('.pt-tools')?.getBoundingClientRect();
    const at = button?.getBoundingClientRect();
    setMenuLeft(Boolean(tools && at && at.left + 230 > tools.right));
    setMenuStep(n);
  }

  function choose(n: number, link: ScreenLink | 'auto') {
    setChoices((previous) => {
      const next = { ...previous, [n]: { ...previous[n] } };
      if (link === 'auto') delete next[n].link;
      else next[n].link = link;
      return next;
    });
    setMenuStep(null);
    setFollow(n);
  }

  function setPopup(n: number, popup: boolean) {
    const automatic = mockStep(n).label === 'modal';
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
      const chip = (n: number) => document.querySelector<HTMLElement>(`.pt-panel [data-chip="${n}"]`);
      const parts: Array<[string, () => void]> = [];
      if (pathway.screenOf.get(6) !== pathway.screenOf.get(1)) {
        const box = pathway.screenOf.get(6) ?? 6;
        parts.push([`box:${box}`, () => setSelected(box)], ['chip:6', () => openMenu(6, chip(6))], ['menu:1', () => choose(6, 1)]);
      }
      if (pathway.screenOf.get(8) === pathway.screenOf.get(7)) {
        const box = pathway.screenOf.get(8) ?? 7;
        parts.push([`box:${box}`, () => setSelected(box)], ['chip:8', () => openMenu(8, chip(8))], ['menu:new', () => choose(8, 'new')]);
      }
      play(parts, 1300);
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
      if (menuStep !== null) setMenuStep(null);
      else onClose();
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
  const selectedScreen = pathway.screens.find((screen) => screen.id === selected) ?? null;

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
      <ul className="pt-points">
        <li>the black numbers are step numbers, as in the step list and in <code>steps.csv</code>.</li>
        <li>an arrow carries the number of the step it leads to, so the journey can be read from 1 onwards.</li>
        <li>a solid arrow goes onwards; a <b>dashed</b> arrow goes back to a screen seen earlier.</li>
        <li>a stack means several steps on one screen; a <b>dashed frame</b> is a pop-up.</li>
      </ul>
    );
    tools = (
      <div className="pt-walk">
        <button aria-label="previous step" className="demo-icon-button" disabled={!current || current <= 1} onClick={() => setCurrent((n) => Math.max(1, (n ?? 1) - 1))} type="button">
          ◀
        </button>
        <span className="pt-walk-text">
          <b>step {current}</b> · {story?.story}
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
            a <b>revisit</b>: exactly the same picture as before;
          </li>
          <li>
            a pop-up <b>closing</b>: back to the screen under it;
          </li>
          <li>
            a change that stays on the screen: <b>scroll</b>, typing, an <b>update</b> of part of it.
          </li>
        </ol>
        <p>a pop-up, and anything else, starts a box of its own.</p>
      </>
    );
    tools = (
      <div aria-label="boxes" className="pt-switch" role="group">
        <span className="pathway-control-label">boxes</span>
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
            <b>one screen, split in two</b>: two boxes show the same screen, because something on it changed a
            little (a badge, a counter, new content);
          </li>
          <li>
            <b>two screens in one box</b>: one box holds different places, because they share a layout (two
            articles, two products, two profiles).
          </li>
        </ul>
        <p>a box shows only its first step: rest the pointer on a step number to see the others.</p>
      </>
    );
    tools = (
      <div aria-label="boxes" className="pt-switch" role="group">
        <span className="pathway-control-label">boxes</span>
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
          {picked !== null ? `step ${picked} is in ` : 'inside '}box {inside.index}, <b>{inside.title}</b>
          {inside.steps.length === 1 ? ': one step' : `: steps ${inside.steps.join(', ')}`}
          {picked !== null ? ' (when boxes are screens)' : ''}
        </p>
        <div className="pt-inside">
          {inside.steps.map((n) => (
            <figure className={n === picked ? 'picked' : ''} key={n}>
              <svg aria-hidden="true" viewBox={`0 0 ${ART_WIDTH} ${ART_HEIGHT}`}>
                <MockArt art={mockStep(n).art} />
                <rect fill="none" height={ART_HEIGHT} stroke="#111" strokeWidth={1} width={ART_WIDTH} />
              </svg>
              <figcaption>
                <b>{n}</b> {mockStep(n).label}
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
          in the pathway, click a box to select it, or the number under it to select that one step. a toolbox
          opens beside what you selected:
        </p>
        <ul className="pt-points">
          <li>
            <b>own screen</b>: the step gets a box of its own;
          </li>
          <li>
            <b>put it on</b> another box (or drag its number onto that box);
          </li>
          <li>
            <b>stack onto</b>: the whole box goes onto another (or drag the box).
          </li>
        </ul>
        <p>
          here, click a box: its steps are listed above the chart, each with these choices. every change can be
          taken back with ⌘Z, and the same choice is on every step card under <b>steps</b> (under annotate).
        </p>
      </>
    );
    tools = (
      <div className="pt-strip">
        {selectedScreen ? (
          <>
            <span className="pt-strip-name">
              {selectedScreen.index} · {selectedScreen.title}
            </span>
            <label className="pt-strip-check">
              <input checked={isPopup(mockStep(selectedScreen.id), choices)} onChange={(event) => setPopup(selectedScreen.id, event.target.checked)} type="checkbox" />
              pop-up
            </label>
            <span className="pathway-control-label">steps</span>
            {selectedScreen.steps.map((n) => {
              const link = choices[n]?.link;
              const label = link === 'new' ? 'own screen' : typeof link === 'number' ? `on box ${link}` : 'where it was found';
              return (
                <span className="pt-strip-step" key={n}>
                  <b>{n}</b>
                  <button
                    aria-expanded={menuStep === n}
                    className={`inline-link-button${shade(`chip:${n}`)}`}
                    data-chip={n}
                    onClick={(event) => (menuStep === n ? setMenuStep(null) : openMenu(n, event.currentTarget))}
                    type="button"
                  >
                    {label} ▾
                  </button>
                  {menuStep === n ? (
                    <span className={`pt-menu ${menuLeft ? 'to-left' : ''}`} role="menu">
                      <button onClick={() => choose(n, 'auto')} role="menuitem" type="button">
                        back where it was found
                      </button>
                      <button className={shade('menu:new').trim() || undefined} onClick={() => choose(n, 'new')} role="menuitem" type="button">
                        own screen
                      </button>
                      <span className="pt-menu-heading">put it on</span>
                      {pathway.screens
                        .filter((screen) => screen.id !== pathway.screenOf.get(n))
                        .map((screen) => (
                          <button className={`pt-menu-screen${shade(`menu:${screen.id}`)}`} key={screen.id} onClick={() => choose(n, screen.id)} role="menuitem" type="button">
                            <svg aria-hidden="true" height={30} viewBox={`0 0 ${ART_WIDTH} ${ART_HEIGHT}`} width={15}>
                              <MockArt art={mockStep(screen.id).art} />
                            </svg>
                            <b>{screen.id}</b> {screen.title}
                          </button>
                        ))}
                    </span>
                  ) : null}
                </span>
              );
            })}
            <button className="analysis-task-link subtle pt-strip-done" onClick={() => setSelected(null)} type="button">
              done
            </button>
          </>
        ) : (
          <span className="candidate-view-note">click a box in the chart to change it</span>
        )}
      </div>
    );
    if (done.has(4))
      after = (
        <p className="pt-feedback">
          both fixed. each choice is stored on its step: the step list shows <code>screen: same as 1</code>, and{' '}
          <code>pathway.json</code> marks the grouping as <code>researcher</code>.
        </p>
      );
  } else if (lesson === 5) {
    body = (
      <>
        <p>
          step 5 is settings again, with notifications now switched on. stepthrough put it with 2, because the
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
            <p className="demo-eyebrow">pathway tutorial</p>
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
              clickable={lesson === 2 ? 'steps' : lesson === 3 || lesson === 4 ? 'screens' : null}
              current={lesson === 1 ? current : null}
              demo={demo}
              marks={lesson === 3 && mode === 'screens' ? marks : {}}
              notes={lesson === 6 ? notes : 'hidden'}
              onScreen={
                lesson === 3
                  ? look
                  : (id) => {
                      setMenuStep(null);
                      setSelected((shown) => (shown === id ? null : id));
                    }
              }
              onStep={inspect}
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
              view={view}
            />
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
