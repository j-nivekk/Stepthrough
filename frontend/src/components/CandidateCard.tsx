import { useEffect, useRef, useState } from 'react';
import { screenshotUrl } from '../lib/screenshots';
import { useLive } from '../features/live/LiveProvider';
import { candidateLabelType, transitionLabelText, type SimilarLink } from '../lib/analysis';
import { stepEditor } from '../lib/live';
import type { StepHoverState } from '../features/analysis/useHoverClips';
import type { CandidateChanges, CandidateFrame, CandidateStatus } from '../types';
import { PhaseChoice } from './PhaseChoice';
import { ScreenChoice, screenChoiceSummary } from './ScreenChoice';
import { useStepNumbers } from './StepNumbers';
import { StepTextDetails } from './StepText';

/** Hover intent on a step's screenshot: wait, then the clip plays and "play from here" appears. */
export interface StepHoverProps {
  state: StepHoverState | null;
  onEnter: (slot: HTMLElement | null) => void;
  onLeave: () => void;
  onPlayFromHere: () => void;
}

export function PlayFromHereButton({ iconOnly, onClick }: { iconOnly: boolean; onClick: () => void }) {
  return (
    <button
      aria-label="play from here"
      className={`candidate-play-from-here ${iconOnly ? 'icon-only' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      title="play from here in the preview (p)"
      type="button"
    >
      <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 12 12" width="12">
        <path d="M3 1.8v8.4L10 6z" />
      </svg>
      {iconOnly ? null : <span>play from here</span>}
    </button>
  );
}

/** Two offset closed screen cards (front card + matching back card tucked cleanly behind its edges). */
export function StackingIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="13" viewBox="0 0 16 16" width="13">
      <rect height="10.25" rx="1" stroke="currentColor" strokeWidth="1.3" width="8.5" x="2" y="1.5" />
      <path
        d="M10.5 4.25h2.25a1 1 0 0 1 1 1v8.25a1 1 0 0 1-1 1H6.25a1 1 0 0 1-1-1V11.75"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
    </svg>
  );
}

/** Three-stage moon phase sequence (new -> half -> full) for walkthrough phases. */
export function PhasesIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="13" viewBox="0 0 22 16" width="18">
      <circle cx="3.75" cy="8" r="2.35" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="11" cy="8" r="2.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M11 5.25A2.75 2.75 0 0 1 11 10.75Z" fill="currentColor" />
      <circle cx="18.25" cy="8" fill="currentColor" r="2.65" />
    </svg>
  );
}

// Mouse rather than pointer events: browsers send mouse enter and leave when the page scrolls under a
// still pointer. Moving within a screenshot restarts the wait after a scroll cancelled it.
export function hoverHandlers(hover: StepHoverProps | undefined, slot: { current: HTMLElement | null }) {
  if (!hover) return {};
  return {
    onMouseEnter: () => hover.onEnter(slot.current),
    onMouseMove: () => {
      if (hover.state === null) hover.onEnter(slot.current);
    },
    onMouseLeave: () => hover.onLeave(),
  };
}

export function hasFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

/** The step's label with its legend colour, plus how many screens a typing step grouped. */
export function CandidateLabel({ candidate }: { candidate: CandidateFrame }) {
  const type = candidateLabelType(candidate);
  if (!type) {
    return null;
  }
  const grouped = candidate.score_breakdown?.grouped_states;
  return (
    <span className="candidate-label-copy">
      <span aria-hidden="true" className={`timeline-legend-color ${type}`} />
      {transitionLabelText(type)}
      {hasFiniteNumber(grouped) && grouped > 1 ? <span className="candidate-label-count">×{grouped}</span> : null}
    </span>
  );
}

type TextField = 'title' | 'notes';

/**
 * The title and notes being typed. Saved text that arrives meanwhile (from another browser of a shared account,
 * or this one's own save) is taken in, but never over typing that is not saved yet. A change is sent with the
 * text it began from, so that in a shared account it is refused rather than written over text saved elsewhere.
 */
export function useAnnotationDrafts(candidate: CandidateFrame, onUpdate: CandidateCardProps['onUpdate'], locked: boolean) {
  const saved = { title: candidate.title ?? '', notes: candidate.notes ?? '' };
  const [drafts, setDrafts] = useState(saved);
  const base = useRef(saved);
  const typing = useRef({ title: false, notes: false });
  const stepId = useRef(candidate.id);

  useEffect(() => {
    if (stepId.current !== candidate.id) {
      stepId.current = candidate.id;
      typing.current = { title: false, notes: false };
    }
    const next = { title: candidate.title ?? '', notes: candidate.notes ?? '' };
    for (const field of ['title', 'notes'] as const) {
      if (!typing.current[field]) base.current = { ...base.current, [field]: next[field] };
    }
    setDrafts((current) => ({
      title: typing.current.title ? current.title : next.title,
      notes: typing.current.notes ? current.notes : next.notes,
    }));
  }, [candidate.id, candidate.title, candidate.notes]);

  function edit(field: TextField, value: string) {
    if (locked) return;
    typing.current = { ...typing.current, [field]: true };
    setDrafts((current) => ({ ...current, [field]: value }));
  }

  function commit(field: TextField, value: string) {
    typing.current = { ...typing.current, [field]: false };
    const trimmed = value.trim();
    const current = (field === 'title' ? candidate.title : candidate.notes) ?? '';
    if (locked || trimmed === current.trim()) {
      setDrafts((drafts) => ({ ...drafts, [field]: current }));
      return;
    }
    onUpdate(field === 'title' ? { title: trimmed, previous_title: base.current.title } : { notes: trimmed, previous_notes: base.current.notes });
    if (base.current[field] !== current) {
      // Saved elsewhere since this browser began: in a shared account the change is refused, so the field shows
      // the saved text again (this browser's text goes into the message about it).
      base.current = { ...base.current, [field]: current };
      setDrafts((drafts) => ({ ...drafts, [field]: current }));
    }
  }

  return {
    title: drafts.title,
    setTitle: (value: string) => edit('title', value),
    notes: drafts.notes,
    setNotes: (value: string) => edit('notes', value),
    commit,
  };
}

/**
 * In a shared account, who is typing a step's title and notes: this browser claims the step while one of its text
 * fields has the focus, and while another browser holds it, the fields here are read-only.
 */
export function useStepEditing(candidate: CandidateFrame) {
  const { enabled, clientId, presence, setPresence } = useLive();
  const key = `editing:${candidate.id}`;
  const editor = enabled ? stepEditor(presence, candidate.run_id, candidate.id) : null;
  const lockedElsewhere = editor !== null && editor !== clientId;
  useEffect(() => () => setPresence(key, null), [key, setPresence]);
  return {
    lockedElsewhere,
    onFocusField: () => {
      if (!lockedElsewhere) setPresence(key, { kind: 'editing', run_id: candidate.run_id, candidate_id: candidate.id });
    },
    onBlurField: () => setPresence(key, null),
  };
}

export const EDITED_ELSEWHERE = 'being edited in another browser';

interface CandidateDecisionButtonProps {
  intent: CandidateStatus;
  isActive: boolean;
  label: string;
  onClick: () => void;
}

/** The ✓, ✕ and ↺ of a decision: on each step, and on the buttons that decide several steps at once. */
export function DecisionIcon({ intent }: { intent: CandidateStatus }) {
  return (
    <svg aria-hidden="true" className="candidate-decision-icon" viewBox="0 0 16 16">
      {intent === 'accepted' ? (
        <path
          d="M3.5 8.5 6.4 11.4 12.5 4.8"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.9"
        />
      ) : intent === 'rejected' ? (
        <path
          d="M4.3 4.3 11.7 11.7M11.7 4.3 4.3 11.7"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.9"
        />
      ) : (
        <path
          d="M11.6 6.2A4.4 4.4 0 1 0 12 8m0-3.8V7.6H8.6"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
      )}
    </svg>
  );
}

function CandidateDecisionButton({
  intent,
  isActive,
  label,
  onClick,
}: CandidateDecisionButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={isActive}
      className={`candidate-decision-button ${intent} ${isActive ? 'active' : ''}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      <DecisionIcon intent={intent} />
    </button>
  );
}

export function CandidateDecisionButtons({
  candidate,
  onSetStatus,
}: {
  candidate: CandidateFrame;
  onSetStatus: (status: CandidateStatus) => void;
}) {
  return (
    <>
      <CandidateDecisionButton
        intent="accepted"
        isActive={candidate.status === 'accepted'}
        label="accept candidate (a)"
        onClick={() => onSetStatus('accepted')}
      />
      <CandidateDecisionButton
        intent="rejected"
        isActive={candidate.status === 'rejected'}
        label="reject candidate (r)"
        onClick={() => onSetStatus('rejected')}
      />
      <CandidateDecisionButton
        intent="pending"
        isActive={candidate.status === 'pending'}
        label="reset candidate to pending (u)"
        onClick={() => onSetStatus('pending')}
      />
    </>
  );
}

/** That the user went back to an earlier screen after this step, as the reviewer said in the pathway. */
export function BackLink({ link, onJump }: { link: SimilarLink; onJump: () => void }) {
  return (
    <button
      className="inline-link-button candidate-back-link"
      onClick={(event) => {
        event.stopPropagation();
        onJump();
      }}
      title="after this step the user went back to that screen, as said in the pathway: jump to it"
      type="button"
    >
      {link.label}
    </button>
  );
}

export interface CandidateCardProps {
  candidate: CandidateFrame;
  isActive: boolean;
  isAnnotationExpanded: boolean;
  isCrossHovered?: boolean;
  isSelected: boolean;
  isSelectable: boolean;
  onActivate: () => void;
  onHoverChange?: (hovering: boolean) => void;
  onJumpToSimilar?: (() => void) | undefined;
  onPaintStart?: () => void;
  onPaintEnter?: () => void;
  onSetStatus: (status: CandidateStatus) => void;
  /** Its box was clicked; with shift, every step from the last one clicked to this one goes along. */
  onToggleSelection: (shift: boolean) => void;
  onToggleAnnotation: () => void;
  recordingHeight?: number | null;
  recordingWidth?: number | null;
  similarLink?: SimilarLink | undefined;
  /** Where the user went back to after the step, as the reviewer said. */
  backLink?: SimilarLink | undefined;
  onJumpBack?: (() => void) | undefined;
  /** Every step of the run, in order, for choosing which screen this one shows. */
  steps: CandidateFrame[];
  onUpdate: (payload: CandidateChanges) => void;
  /** The run and where its phases start, for choosing the phase of an accepted step. */
  phases?: { runId: string; boundaries: Array<{ start_ms: number; name: string }> | undefined };
  /** Narrow card: scores and the notes toggle move out of the way until the card is active. */
  compact?: boolean;
  hover?: StepHoverProps;
  /** How wide the card draws its screenshot, in CSS pixels, so it loads a copy that size (lib/screenshots.ts). */
  imageWidth?: number;
}

export function CandidateCard({
  candidate,
  imageWidth,
  isActive,
  isAnnotationExpanded,
  isCrossHovered = false,
  isSelected,
  isSelectable,
  onActivate,
  onHoverChange,
  onJumpToSimilar,
  backLink,
  onJumpBack,
  onPaintStart,
  onPaintEnter,
  onSetStatus,
  onToggleSelection,
  onToggleAnnotation,
  recordingHeight,
  recordingWidth,
  similarLink,
  steps,
  onUpdate,
  phases,
  compact = false,
  hover,
}: CandidateCardProps) {
  const liveSlotRef = useRef<HTMLDivElement | null>(null);
  const paintedDownRef = useRef(false);
  const editing = useStepEditing(candidate);
  const { title, setTitle, notes, setNotes, commit: commitTextField } = useAnnotationDrafts(candidate, onUpdate, editing.lockedElsewhere);
  // The title and notes fields open only on request, so a selected card can still be just a screenshot.
  // Saved text stays visible as plain text while the fields are closed.
  const hasAnnotation = Boolean(candidate.title || candidate.notes);
  const showAnnotation = isAnnotationExpanded;
  const annotationToggleLabel = showAnnotation ? 'hide notes' : hasAnnotation ? 'edit notes' : 'annotate';
  const numberOf = useStepNumbers();
  const called = numberOf(candidate);
  const screenSummary = screenChoiceSummary(candidate, steps, numberOf);

  const imageAspectRatio =
    recordingWidth && recordingHeight && recordingWidth > 0 && recordingHeight > 0 ? recordingWidth / recordingHeight : 16 / 10;

  return (
    <article
      className={`candidate-card ${candidate.status} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${isCrossHovered ? 'is-cross-hovered' : ''} ${compact ? 'compact' : ''} ${showAnnotation ? 'annotating' : ''}`}
      id={`candidate-${candidate.id}`}
      onClick={onActivate}
      onFocus={onActivate}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      onPointerEnter={() => onPaintEnter?.()}
      tabIndex={-1}
    >
      <div
        className={`candidate-image-wrap ${hover?.state ? `hover-${hover.state}` : ''}`}
        style={{ aspectRatio: String(imageAspectRatio) }}
        {...hoverHandlers(hover, liveSlotRef)}
      >
        <img alt={`candidate screenshot at ${candidate.timestamp_tc}`} loading="lazy" src={screenshotUrl(candidate.image_url, imageWidth)} />
        <div aria-hidden="true" className="candidate-live-slot" ref={liveSlotRef} />
        <span aria-hidden="true" className="candidate-hover-progress" />
        {hover?.state === 'armed' ? <PlayFromHereButton iconOnly={compact} onClick={hover.onPlayFromHere} /> : null}
        <div className="candidate-overlay">
          <span className="candidate-timecode">{candidate.timestamp_tc}</span>
          {isSelectable ? (
            <label
              className="candidate-select-toggle"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <input
                aria-label={`select ${called.name}`}
                checked={isSelected}
                onChange={() => undefined}
                onClick={(event) => {
                  if (paintedDownRef.current) {
                    paintedDownRef.current = false;
                    return;
                  }
                  onToggleSelection(event.shiftKey);
                }}
                // shift-click selects a range of steps; pointerdown without shift starts drag-to-paint selection
                onMouseDown={(event) => event.shiftKey && event.preventDefault()}
                onPointerDown={(event) => {
                  if (event.button === 0 && !event.shiftKey && !event.ctrlKey && onPaintStart) {
                    paintedDownRef.current = true;
                    onPaintStart();
                  }
                }}
                type="checkbox"
              />
            </label>
          ) : null}
        </div>
        <div
          className="candidate-overlay-actions"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <CandidateDecisionButtons candidate={candidate} onSetStatus={onSetStatus} />
        </div>
      </div>
      <div className="candidate-body">
        {editing.lockedElsewhere ? (
          <p className="live-band" role="status">
            {EDITED_ELSEWHERE}
          </p>
        ) : null}
        <div className="candidate-headline">
          <div className="candidate-heading-copy">
            <strong className="candidate-title">
              {candidate.candidate_origin === 'manual' ? 'manual ' : ''}
              {called.name}
            </strong>
            <div className="candidate-heading-meta">
              <span className={`candidate-status-copy ${candidate.status}`}>{candidate.status}</span>
              {candidate.candidate_origin === 'manual' ? <span className="candidate-origin-copy">manual</span> : null}
              <CandidateLabel candidate={candidate} />
            </div>
          </div>
        </div>

        <div className="candidate-meta-row">
          <details className="candidate-scores">
            <summary>scores</summary>
            <div className="candidate-scores-body">
              <span>
                change <strong className="info-text">{candidate.scene_score.toFixed(2)}</strong>
              </span>
              {candidate.score_breakdown ? (
                <>
                  <span>
                    visual <strong className="info-text">{candidate.score_breakdown.visual.toFixed(2)}</strong>
                  </span>
                  {candidate.text_state === 'read' ? (
                    <span>
                      text <strong className="info-text">{candidate.score_breakdown.text.toFixed(2)}</strong>
                    </span>
                  ) : null}
                  <span>
                    motion <strong className="warning-text">{candidate.score_breakdown.motion.toFixed(2)}</strong>
                  </span>
                  {candidate.score_breakdown.transition_type ? (
                    <span>
                      type <strong className="info-text">{candidate.score_breakdown.transition_type}</strong>
                    </span>
                  ) : null}
                  {hasFiniteNumber(candidate.score_breakdown.chrome_change) ? (
                    <span>
                      chrome <strong className="info-text">{candidate.score_breakdown.chrome_change.toFixed(2)}</strong>
                    </span>
                  ) : null}
                  {hasFiniteNumber(candidate.score_breakdown.content_change) ? (
                    <span>
                      content <strong className="info-text">{candidate.score_breakdown.content_change.toFixed(2)}</strong>
                    </span>
                  ) : null}
                  {hasFiniteNumber(candidate.score_breakdown.scroll_dy) ? (
                    <span>
                      scroll y <strong className="warning-text">{formatSigned(candidate.score_breakdown.scroll_dy)}</strong>
                    </span>
                  ) : null}
                  {hasFiniteNumber(candidate.score_breakdown.scroll_confidence) ? (
                    <span>
                      scroll conf <strong className="warning-text">{candidate.score_breakdown.scroll_confidence.toFixed(2)}</strong>
                    </span>
                  ) : null}
                  {hasFiniteNumber(candidate.score_breakdown.dwell_before_ms) ? (
                    <span>
                      dwell before <strong className="info-text">{candidate.score_breakdown.dwell_before_ms}ms</strong>
                    </span>
                  ) : null}
                  {hasFiniteNumber(candidate.score_breakdown.dwell_after_ms) ? (
                    <span>
                      {candidate.score_breakdown.grouped_states != null ? 'on screen' : 'dwell after'}{' '}
                      <strong className="info-text">{candidate.score_breakdown.dwell_after_ms}ms</strong>
                    </span>
                  ) : null}
                  {hasFiniteNumber(candidate.score_breakdown.grouped_states) && candidate.score_breakdown.grouped_states > 1 ? (
                    <span>
                      grouped <strong className="info-text">{candidate.score_breakdown.grouped_states} states</strong>
                    </span>
                  ) : null}
                  <span>{candidate.score_breakdown.changed_regions.length} changed regions</span>
                </>
              ) : null}
              {typeof candidate.similarity_distance === 'number' && (
                <span>
                  similarity <strong className="warning-text">{candidate.similarity_distance.toFixed(2)}</strong>
                </span>
              )}
            </div>
          </details>
          <StepTextDetails candidate={candidate} key={candidate.id} />
          <button
            aria-expanded={showAnnotation}
            className="candidate-annotation-toggle"
            onClick={(event) => {
              event.stopPropagation();
              onToggleAnnotation();
            }}
            type="button"
          >
            {annotationToggleLabel}
          </button>
        </div>

        {hasAnnotation && !showAnnotation ? (
          <div className="candidate-annotation-summary">
            {candidate.title ? <span className="candidate-annotation-summary-title">{candidate.title}</span> : null}
            {candidate.notes ? <span className="candidate-annotation-summary-notes">{candidate.notes}</span> : null}
          </div>
        ) : null}

        {similarLink && onJumpToSimilar && (
          <div className="candidate-secondary-row">
            <button
              className="inline-link-button candidate-similarity-link"
              onClick={onJumpToSimilar}
              title="jump to the earlier step that shows the same screen"
              type="button"
            >
              {similarLink.label}
            </button>
          </div>
        )}

        {backLink && onJumpBack ? (
          <div className="candidate-secondary-row">
            <BackLink link={backLink} onJump={onJumpBack} />
          </div>
        ) : null}

        {screenSummary && !showAnnotation ? (
          <div className="candidate-secondary-row candidate-screen-summary" title="your choice for the pathway">
            stacking: {screenSummary}
          </div>
        ) : null}

        {showAnnotation && (
          <div className="candidate-annotation-panel">
            <label className="candidate-field-group">
              <span>step title</span>
              <input
                className="candidate-field"
                onBlur={(event) => {
                  commitTextField('title', event.target.value);
                  editing.onBlurField();
                }}
                onChange={(event) => setTitle(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onFocus={editing.onFocusField}
                placeholder="optional custom label"
                readOnly={editing.lockedElsewhere}
                title={editing.lockedElsewhere ? EDITED_ELSEWHERE : title || undefined}
                value={title}
              />
            </label>

            <label className="candidate-field-group">
              <span>notes</span>
              <textarea
                className="candidate-field candidate-notes-field"
                onBlur={(event) => {
                  commitTextField('notes', event.target.value);
                  editing.onBlurField();
                }}
                onChange={(event) => setNotes(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onFocus={editing.onFocusField}
                placeholder="add observation, annotation note, or coding hint"
                readOnly={editing.lockedElsewhere}
                rows={2}
                title={editing.lockedElsewhere ? EDITED_ELSEWHERE : notes || undefined}
                value={notes}
              />
            </label>

            <div className="candidate-pathway-row">
              <div className="candidate-field-group candidate-pathway-item">
                <span className="candidate-pathway-label">stacking</span>
                <ScreenChoice candidate={candidate} icon={<StackingIcon />} onUpdate={onUpdate} steps={steps} />
              </div>

              {phases && candidate.status === 'accepted' ? (
                <div className="candidate-field-group candidate-pathway-item is-end">
                  <span className="candidate-pathway-label">phases…</span>
                  <PhaseChoice candidate={candidate} icon={<PhasesIcon />} phases={phases.boundaries} runId={phases.runId} />
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

export interface CandidateRowProps {
  candidate: CandidateFrame;
  isActive: boolean;
  isCrossHovered?: boolean;
  isSelected: boolean;
  isSelectable: boolean;
  onActivate: () => void;
  onHoverChange?: (hovering: boolean) => void;
  onJumpToSimilar?: (() => void) | undefined;
  onPaintStart?: () => void;
  onPaintEnter?: () => void;
  onSetStatus: (status: CandidateStatus) => void;
  onToggleSelection: (shift: boolean) => void;
  onUpdate: CandidateCardProps['onUpdate'];
  similarLink?: SimilarLink | undefined;
  backLink?: SimilarLink | undefined;
  onJumpBack?: (() => void) | undefined;
  steps: CandidateFrame[];
  phases?: CandidateCardProps['phases'];
  thumbHeight: number;
  thumbWidth: number;
  hover?: StepHoverProps;
}

/** One step as a table row: for runs with many steps, and for writing titles and notes in one pass. */
export function CandidateRow({
  candidate,
  isActive,
  isCrossHovered = false,
  isSelected,
  isSelectable,
  onActivate,
  onHoverChange,
  onJumpToSimilar,
  backLink,
  onJumpBack,
  onPaintStart,
  onPaintEnter,
  onSetStatus,
  onToggleSelection,
  onUpdate,
  similarLink,
  steps,
  phases,
  thumbHeight,
  thumbWidth,
  hover,
}: CandidateRowProps) {
  const noSlot = useRef<HTMLElement | null>(null);
  const paintedDownRef = useRef(false);
  const editing = useStepEditing(candidate);
  const called = useStepNumbers()(candidate);
  const locked = editing.lockedElsewhere;
  const { title, setTitle, notes, setNotes, commit } = useAnnotationDrafts(candidate, onUpdate, locked);
  const onScreenMs = candidate.score_breakdown?.dwell_after_ms;
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return (
    <div
      className={`candidate-row ${candidate.status} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${isCrossHovered ? 'is-cross-hovered' : ''} ${locked ? 'edited-elsewhere' : ''}`}
      id={`candidate-${candidate.id}`}
      onClick={onActivate}
      onFocus={onActivate}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      onPointerEnter={() => onPaintEnter?.()}
      role="row"
      tabIndex={-1}
    >
      <div className="candidate-row-select" role="cell">
        {isSelectable ? (
          <input
            aria-label={`select ${called.name}`}
            checked={isSelected}
            onChange={() => undefined}
            onClick={(event) => {
              stop(event);
              if (paintedDownRef.current) {
                paintedDownRef.current = false;
                return;
              }
              onToggleSelection(event.shiftKey);
            }}
            onMouseDown={(event) => event.shiftKey && event.preventDefault()}
            onPointerDown={(event) => {
              stop(event);
              if (event.button === 0 && !event.shiftKey && !event.ctrlKey && onPaintStart) {
                paintedDownRef.current = true;
                onPaintStart();
              }
            }}
            type="checkbox"
          />
        ) : null}
      </div>
      <div
        className={`candidate-row-thumb ${hover?.state ? `hover-${hover.state}` : ''}`}
        role="cell"
        style={{ width: thumbWidth, height: thumbHeight }}
        {...hoverHandlers(hover, noSlot)}
      >
        <img
          alt={`candidate screenshot at ${candidate.timestamp_tc}`}
          loading="lazy"
          src={screenshotUrl(candidate.image_url, thumbWidth)}
        />
        <span aria-hidden="true" className="candidate-hover-progress" />
        {hover?.state === 'armed' ? <PlayFromHereButton iconOnly onClick={hover.onPlayFromHere} /> : null}
      </div>
      <div className="candidate-row-step" role="cell">
        <strong className={candidate.status === 'accepted' ? '' : 'is-candidate'} title={called.name}>
          {candidate.candidate_origin === 'manual' ? 'manual ' : ''}
          {candidate.status === 'accepted' ? called.number : called.name}
        </strong>
        <span>{candidate.timestamp_tc}</span>
      </div>
      <div className="candidate-row-label" role="cell">
        <CandidateLabel candidate={candidate} />
        {similarLink && onJumpToSimilar ? (
          <button
            className="inline-link-button candidate-similarity-link"
            onClick={(event) => {
              stop(event);
              onJumpToSimilar();
            }}
            title="jump to the earlier step that shows the same screen"
            type="button"
          >
            {similarLink.label}
          </button>
        ) : null}
        {backLink && onJumpBack ? <BackLink link={backLink} onJump={onJumpBack} /> : null}
        <ScreenChoice candidate={candidate} onUpdate={onUpdate} prefix="stacking: " steps={steps} />
        {phases && candidate.status === 'accepted' ? (
          <PhaseChoice candidate={candidate} phases={phases.boundaries} prefix="phase: " runId={phases.runId} />
        ) : null}
      </div>
      <div className="candidate-row-duration" role="cell">
        {hasFiniteNumber(onScreenMs) ? formatSeconds(onScreenMs) : '–'}
      </div>
      <div className="candidate-row-title" role="cell">
        <input
          aria-label={`title of ${called.name}`}
          className="candidate-field"
          onBlur={(event) => {
            commit('title', event.target.value);
            editing.onBlurField();
          }}
          onChange={(event) => setTitle(event.target.value)}
          onClick={stop}
          onFocus={editing.onFocusField}
          placeholder={locked ? EDITED_ELSEWHERE : 'step title'}
          readOnly={locked}
          title={locked ? EDITED_ELSEWHERE : title || undefined}
          value={title}
        />
      </div>
      <div className="candidate-row-notes" role="cell">
        <input
          aria-label={`notes on ${called.name}`}
          className="candidate-field"
          onBlur={(event) => {
            commit('notes', event.target.value);
            editing.onBlurField();
          }}
          onChange={(event) => setNotes(event.target.value)}
          onClick={stop}
          onFocus={editing.onFocusField}
          placeholder={locked ? EDITED_ELSEWHERE : 'notes'}
          readOnly={locked}
          title={locked ? EDITED_ELSEWHERE : notes || undefined}
          value={notes}
        />
      </div>
      <div className="candidate-row-actions" onClick={stop} onPointerDown={stop} role="cell">
        <CandidateDecisionButtons candidate={candidate} onSetStatus={onSetStatus} />
      </div>
    </div>
  );
}
