import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { absoluteApiUrl } from '../api';
import type { CandidateChanges, CandidateFrame } from '../types';

/** Whether the step counts as a pop-up: the reviewer's say, or else the detector's label. */
export function isPopupStep(candidate: CandidateFrame): boolean {
  if (candidate.screen_kind) return candidate.screen_kind === 'popup';
  return candidate.score_breakdown?.transition_type === 'modal';
}

/** The change that makes the step a pop-up or not; back to automatic when that is what the label says anyway. */
export function popupChange(candidate: CandidateFrame, popup: boolean): CandidateChanges {
  const automatic = candidate.score_breakdown?.transition_type === 'modal';
  return { screen_kind: popup === automatic ? 'auto' : popup ? 'popup' : 'screen' };
}

function linkText(candidate: CandidateFrame, steps: CandidateFrame[]): string | null {
  if (!candidate.screen_link) return null;
  if (candidate.screen_link === 'new') return 'a new screen';
  const same = steps.find((step) => step.id === candidate.screen_link);
  return same ? `same as ${same.detector_index}` : null;
}

/** What the reviewer chose for the step's place in the pathway, or null when everything is automatic. */
export function screenChoiceSummary(candidate: CandidateFrame, steps: CandidateFrame[]): string | null {
  const parts = [linkText(candidate, steps), candidate.screen_kind === 'popup' ? 'pop-up' : candidate.screen_kind === 'screen' ? 'not a pop-up' : null];
  const chosen = parts.filter(Boolean);
  return chosen.length ? chosen.join(' · ') : null;
}

const POPOVER_WIDTH = 264;
/** Height the list likes to have; with less room below the link, it opens upwards if there is more there. */
const POPOVER_ROOM = 380;

interface ScreenChoiceProps {
  candidate: CandidateFrame;
  /** Every step of the run, in order. The earlier ones can be picked as the same screen. */
  steps: CandidateFrame[];
  onUpdate: (changes: CandidateChanges) => void;
  /** Text in front of the choice, for places without a heading of their own. */
  prefix?: string;
  /** Offer later steps as well as earlier ones (in the pathway, where a step can move to any box). */
  anyStep?: boolean;
  /** Leave out the pop-up switch, where the place that shows the choice has its own. */
  hidePopup?: boolean;
}

/**
 * Which screen a step shows in the pathway, for when the automatic grouping gets it wrong: leave it automatic,
 * give the step a screen of its own, or pick an earlier step that shows the same screen. A switch marks the
 * step as a pop-up.
 */
export function ScreenChoice({ candidate, steps, onUpdate, prefix, anyStep = false, hidePopup = false }: ScreenChoiceProps) {
  const [open, setOpen] = useState(false);
  // Where the list opens, in the window: it is not part of the card, which would cut it off.
  const [place, setPlace] = useState<CSSProperties>({});
  const shellRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (shellRef.current && !shellRef.current.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    // The list stays where it opened, so it closes when the page under it moves (not when the list itself scrolls).
    function closeOnScroll(event: Event) {
      if (!(event.target instanceof Node) || !shellRef.current?.contains(event.target)) setOpen(false);
    }
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // Nearest first: the screen a step belongs to is usually a recent one. Later steps come after the earlier ones.
  const earlier = useMemo(() => {
    if (!open) return [];
    const others = steps.filter((step) => step.id !== candidate.id && step.status !== 'rejected');
    const before = others.filter((step) => step.detector_index < candidate.detector_index).reverse();
    return anyStep ? [...before, ...others.filter((step) => step.detector_index > candidate.detector_index)] : before;
  }, [open, steps, candidate.id, candidate.detector_index, anyStep]);

  const popup = isPopupStep(candidate);
  const link = linkText(candidate, steps);
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  function toggle() {
    if (!open && shellRef.current) {
      // Below the link, or above it when there is more room there; never past the edge of the window.
      const link = shellRef.current.getBoundingClientRect();
      const left = Math.max(16, Math.min(link.left, window.innerWidth - POPOVER_WIDTH - 16));
      const below = window.innerHeight - link.bottom;
      setPlace(
        below >= POPOVER_ROOM || below >= link.top
          ? { left, top: link.bottom + 6, maxHeight: Math.max(160, below - 22) }
          : { left, bottom: window.innerHeight - link.top + 6, maxHeight: Math.max(160, link.top - 22) },
      );
    }
    setOpen((current) => !current);
  }

  function choose(screenLink: string) {
    onUpdate({ screen_link: screenLink });
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div className="screen-choice" onClick={stop} onPointerDown={stop} ref={shellRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`inline-link-button screen-choice-trigger ${link || candidate.screen_kind ? 'chosen' : ''}`}
        onClick={toggle}
        ref={triggerRef}
        title="which screen this step shows in the pathway"
        type="button"
      >
        {prefix ? <span className="screen-choice-prefix">{prefix}</span> : null}
        {link ?? 'automatic'}
        {popup && !hidePopup ? ' · pop-up' : ''}
      </button>
      {open ? (
        <div
          aria-label={`screen of step ${candidate.detector_index} in the pathway`}
          className="screen-choice-popover"
          role="dialog"
          style={place}
        >
          <p className="screen-choice-heading">in the pathway, this step shows</p>
          <button
            aria-pressed={!candidate.screen_link}
            className={`screen-choice-option ${!candidate.screen_link ? 'active' : ''}`}
            onClick={() => choose('auto')}
            type="button"
          >
            <span>automatic</span>
            <small>from revisits and labels</small>
          </button>
          <button
            aria-pressed={candidate.screen_link === 'new'}
            className={`screen-choice-option ${candidate.screen_link === 'new' ? 'active' : ''}`}
            onClick={() => choose('new')}
            type="button"
          >
            <span>a new screen</span>
            <small>a box of its own</small>
          </button>
          {earlier.length > 0 ? (
            <>
              <p className="screen-choice-heading">the same screen as</p>
              <div className="screen-choice-steps">
                {earlier.map((step) => (
                  <button
                    aria-pressed={candidate.screen_link === step.id}
                    className={`screen-choice-step ${candidate.screen_link === step.id ? 'active' : ''}`}
                    key={step.id}
                    onClick={() => choose(step.id)}
                    type="button"
                  >
                    <img alt="" loading="lazy" src={absoluteApiUrl(step.image_url)} />
                    <strong>{step.detector_index}</strong>
                    <span>{step.title || step.timestamp_tc}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {hidePopup ? null : (
            <label className="screen-choice-popup">
              <input checked={popup} onChange={(event) => onUpdate(popupChange(candidate, event.target.checked))} type="checkbox" />
              this step is a pop-up
            </label>
          )}
        </div>
      ) : null}
    </div>
  );
}
