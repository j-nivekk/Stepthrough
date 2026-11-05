import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DemoPhone } from './DemoPhone';
import { DemoTimeline, LABEL_COLOURS } from './DemoTimeline';
import { DURATION, LABEL_TEXT, STEPS } from './demoScript';

const SPEED = 1.6; // the 14-second recording plays in about 9 seconds
const GUIDE_URL = 'https://github.com/j-nivekk/Stepthrough/blob/main/GUIDE.md';
const HOLD_SECONDS = 2.2; // pause on a finished stage before moving on

const STAGES: { name: string; title: string; text: string; guide: string }[] = [
  {
    name: 'recording',
    guide: '#1-why-work-from-screen-recordings',
    title: 'a screen recording',
    text:
      'a recording is a continuous stream of frames: everything the participant saw, including every animation and in-between moment. stepthrough looks for the screens they actually stopped on.',
  },
  {
    name: 'working copy',
    guide: '#5-how-stepthrough-finds-steps',
    title: 'a working copy with a steady clock',
    text:
      'phones only store a new frame when the screen changes, so their recordings have no fixed frame rate. every upload is first turned into a working copy: 15 frames every second for the analysis, upright, in standard colours, so every frame has its true time.',
  },
  {
    name: 'compare',
    guide: '#5-how-stepthrough-finds-steps',
    title: 'every frame compared with the current screen',
    text:
      'each frame is compared with the first frame of the screen it belongs to, so slow changes, such as a page loading, still add up. a pixel only counts if it changes by more than the compression noise measured on this recording. the status bar, a blinking cursor and any areas you mark are ignored.',
  },
  {
    name: 'stable screens',
    guide: '#6-settings',
    title: 'screens that stay still',
    text:
      'a screen that stays still for at least the minimum time on screen (450 ms for phones) becomes a step. the "delivered" notice was on screen too briefly, and the chat it left behind is the same screen as before, so neither adds a step.',
  },
  {
    name: 'group & label',
    guide: '#labels',
    title: 'typing grouped, every step labelled',
    text:
      'each pause while typing would look like a screen of its own; the burst becomes one step that shows the finished text. every step gets a label describing the change that led to it. labels describe; they never decide what is a step.',
  },
  {
    name: 'screenshots',
    guide: '#8-exports',
    title: 'one screenshot per step',
    text:
      'for each step, one screenshot is taken 200 ms after the screen settles, inside the still period, so a screenshot never catches an animation half-way. how long each screen stayed on screen is kept as well.',
  },
  {
    name: 'review & export',
    guide: '#7-reviewing-steps',
    title: 'you decide, then export',
    text:
      'automatic steps are a starting point. accept or reject them, add titles and notes, or mark a moment by hand. the export holds the screenshots, steps.csv for a spreadsheet, and steps.json with the settings used and what every field means.',
  },
];

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export interface HowItWorksDemoProps {
  onClose: () => void;
}

/** An animated walk through the analysis of a scripted phone recording, in seven stages. */
export function HowItWorksDemo({ onClose }: HowItWorksDemoProps) {
  const reducedMotion = useRef(prefersReducedMotion()).current;
  const [stage, setStage] = useState(1);
  const [t, setT] = useState(reducedMotion ? DURATION : 0);
  const [playing, setPlaying] = useState(!reducedMotion);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const holdRef = useRef(0);
  const tRef = useRef(t);
  const stageRef = useRef(stage);
  tRef.current = t;
  stageRef.current = stage;

  // Playback: the recording runs once per stage; while playing, the next stage follows after a pause.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    function tick(now: number) {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (tRef.current < DURATION) {
        tRef.current = Math.min(DURATION, tRef.current + delta * SPEED);
        setT(tRef.current);
      } else {
        holdRef.current += delta;
        if (holdRef.current >= HOLD_SECONDS) {
          holdRef.current = 0;
          if (stageRef.current >= STAGES.length) {
            setPlaying(false);
            return;
          }
          stageRef.current += 1;
          tRef.current = 0;
          setStage(stageRef.current);
          setT(0);
        }
      }
      frame = window.requestAnimationFrame(tick);
    }
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing]);

  function goTo(next: number) {
    const clamped = Math.min(STAGES.length, Math.max(1, next));
    holdRef.current = 0;
    stageRef.current = clamped;
    tRef.current = reducedMotion ? DURATION : 0;
    setStage(clamped);
    setT(tRef.current);
    if (!reducedMotion) setPlaying(true);
  }

  function replay() {
    holdRef.current = 0;
    tRef.current = 0;
    setT(0);
    setPlaying(true);
  }

  function togglePlay() {
    if (!playing && tRef.current >= DURATION && !reducedMotion) {
      holdRef.current = 0;
      tRef.current = 0;
      setT(0);
    }
    setPlaying((current) => !current);
  }

  // Handlers change every render; the listener reads the latest through a ref.
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandlerRef.current = (event: KeyboardEvent) => {
    if (event.key === 'Tab') return;
    // Keep the review shortcuts (a, r, u, p, arrows, space) away from the page underneath.
    event.stopImmediatePropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      goTo(stageRef.current + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goTo(stageRef.current - 1);
    } else if (event.key === ' ') {
      event.preventDefault();
      togglePlay();
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      replay();
    }
  };

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previousFocus?.focus?.();
    };
  }, []);

  const current = STAGES[stage - 1];

  return createPortal(
    <div
      className="demo-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div aria-labelledby="demo-title" aria-modal="true" className="demo-panel" ref={panelRef} role="dialog" tabIndex={-1}>
        <header className="demo-header">
          <div>
            <p className="demo-eyebrow">how it works</p>
            <h2 id="demo-title">from screen recording to steps</h2>
          </div>
          <button aria-label="close" className="demo-icon-button" onClick={onClose} title="close (esc)" type="button">
            <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" viewBox="0 0 14 14" width="14">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
            </svg>
          </button>
        </header>

        <div className="demo-body">
          <div className="demo-phone-column">
            <DemoPhone showMasks={stage === 3} t={t} />
            <span className="demo-time">{t.toFixed(1)} s</span>
          </div>

          <div className="demo-main">
            <div aria-live="polite" className="demo-caption">
              <span className="demo-stage-count">
                {stage} / {STAGES.length}
              </span>
              <h3>{current.title}</h3>
              <p>{current.text}</p>
              <a className="demo-guide-link" href={`${GUIDE_URL}${current.guide}`} rel="noreferrer" target="_blank">
                more in the guide on github ↗
              </a>
            </div>

            <DemoTimeline stage={stage} t={t} />

            {/* The strip keeps its space in every stage so the panel does not jump when it appears. */}
            <div className="demo-strip">
              {stage >= 6 ? (
                <>
                <div className="demo-thumbs">
                  {STEPS.map((step, position) => {
                    const shown = stage >= 7 || t >= step.shot;
                    const decided = stage >= 7 && t >= 1 + position * 1.5;
                    return (
                      <figure className={`demo-thumb ${shown ? 'shown' : ''} ${decided ? (step.accepted ? 'accepted' : 'rejected') : ''}`} key={step.index}>
                        <div className="demo-thumb-frame">
                          <DemoPhone className="mini" t={step.shot} />
                          {decided ? (
                            <span className={`demo-decision ${step.accepted ? 'accepted' : 'rejected'}`}>
                              <svg aria-hidden="true" fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 16 16" width="10">
                                {step.accepted ? <path d="M3.5 8.5 6.4 11.4 12.5 4.8" /> : <path d="M4.3 4.3 11.7 11.7M11.7 4.3 4.3 11.7" />}
                              </svg>
                            </span>
                          ) : null}
                        </div>
                        <figcaption>
                          <span className="demo-thumb-swatch" style={{ background: LABEL_COLOURS[step.label] }} />
                          {step.index} {LABEL_TEXT[step.label]}
                          {stage >= 7 && decided ? <em>{step.accepted ? step.title : 'rejected'}</em> : null}
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
                {stage >= 7 ? (
                  <div className={`demo-export ${t >= 10 ? 'shown' : ''}`}>
                    <strong>export.zip</strong>
                    <span>images/ · 5 screenshots</span>
                    <span>steps.csv</span>
                    <span>steps.json</span>
                  </div>
                ) : null}
                </>
              ) : null}
            </div>
          </div>
        </div>

        <footer className="demo-footer">
          <nav aria-label="stages" className="demo-stages">
            {STAGES.map((entry, index) => (
              <button
                aria-current={stage === index + 1 ? 'step' : undefined}
                className={`candidate-filter-tab ${stage === index + 1 ? 'active' : ''}`}
                key={entry.name}
                onClick={() => goTo(index + 1)}
                type="button"
              >
                {entry.name}
              </button>
            ))}
          </nav>
          <div className="demo-controls">
            <button aria-label="replay this stage" className="demo-icon-button" onClick={replay} title="replay this stage (r)" type="button">
              <svg aria-hidden="true" fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 16 16" width="13">
                <path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" />
                <path d="M3.2 2.6v2.9h2.9" />
              </svg>
            </button>
            <button aria-label="previous stage" className="demo-icon-button" disabled={stage === 1} onClick={() => goTo(stage - 1)} title="previous (←)" type="button">
              <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 12 12" width="12">
                <path d="M8.5 2v8L3 6z" />
              </svg>
            </button>
            <button aria-label={playing ? 'pause' : 'play'} className="demo-icon-button primary" onClick={togglePlay} title="play or pause (space)" type="button">
              {playing ? (
                <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 12 12" width="12">
                  <rect height="8" width="2.4" x="3" y="2" />
                  <rect height="8" width="2.4" x="6.6" y="2" />
                </svg>
              ) : (
                <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 12 12" width="12">
                  <path d="M3.5 2v8L9.5 6z" />
                </svg>
              )}
            </button>
            <button aria-label="next stage" className="demo-icon-button" disabled={stage === STAGES.length} onClick={() => goTo(stage + 1)} title="next (→)" type="button">
              <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 12 12" width="12">
                <path d="M3.5 2v8L9 6z" />
              </svg>
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
