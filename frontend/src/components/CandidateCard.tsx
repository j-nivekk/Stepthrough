import { useEffect, useRef, useState } from 'react';
import { absoluteApiUrl } from '../api';
import { candidateLabelType, transitionLabelText, type SimilarLink } from '../lib/analysis';
import type { StepHoverState } from '../features/analysis/useHoverClips';
import type { CandidateChanges, CandidateFrame, CandidateStatus } from '../types';
import { ScreenChoice, screenChoiceSummary } from './ScreenChoice';

/** Hover intent on a step's screenshot: wait, then the clip plays and "play from here" appears. */
export interface StepHoverProps {
  state: StepHoverState | null;
  onEnter: (slot: HTMLElement | null) => void;
  onLeave: () => void;
  onPlayFromHere: () => void;
}

function PlayFromHereButton({ iconOnly, onClick }: { iconOnly: boolean; onClick: () => void }) {
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

// Mouse rather than pointer events: browsers send mouse enter and leave when the page scrolls under a
// still pointer. Moving within a screenshot restarts the wait after a scroll cancelled it.
function hoverHandlers(hover: StepHoverProps | undefined, slot: { current: HTMLElement | null }) {
  if (!hover) return {};
  return {
    onMouseEnter: () => hover.onEnter(slot.current),
    onMouseMove: () => {
      if (hover.state === null) hover.onEnter(slot.current);
    },
    onMouseLeave: () => hover.onLeave(),
  };
}

function hasFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

/** The step's label with its legend colour, plus how many screens a typing step grouped. */
function CandidateLabel({ candidate }: { candidate: CandidateFrame }) {
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

function useAnnotationDrafts(candidate: CandidateFrame, onUpdate: CandidateCardProps['onUpdate']) {
  const [title, setTitle] = useState(candidate.title ?? '');
  const [notes, setNotes] = useState(candidate.notes ?? '');

  useEffect(() => {
    setTitle(candidate.title ?? '');
    setNotes(candidate.notes ?? '');
  }, [candidate.id, candidate.title, candidate.notes]);

  function commit(field: 'title' | 'notes', value: string) {
    const trimmed = value.trim();
    const currentValue = field === 'title' ? candidate.title ?? '' : candidate.notes ?? '';
    if (trimmed === currentValue.trim()) {
      return;
    }
    onUpdate({ [field]: trimmed });
  }

  return { title, setTitle, notes, setNotes, commit };
}

export function ComparisonMetrics({ candidate }: { candidate: CandidateFrame }) {
  return (
    <div className="analysis-compare-metrics">
      <span>overall {candidate.scene_score.toFixed(2)}</span>
      {candidate.score_breakdown ? (
        <>
          {candidate.score_breakdown.transition_type ? <span>{candidate.score_breakdown.transition_type}</span> : null}
          <span>visual {candidate.score_breakdown.visual.toFixed(2)}</span>
          <span>text {candidate.score_breakdown.text.toFixed(2)}</span>
          <span>motion {candidate.score_breakdown.motion.toFixed(2)}</span>
          <span>{candidate.score_breakdown.changed_regions.length} regions</span>
        </>
      ) : null}
    </div>
  );
}

interface CandidateDecisionButtonProps {
  intent: CandidateStatus;
  isActive: boolean;
  label: string;
  onClick: () => void;
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
    </button>
  );
}

function CandidateDecisionButtons({
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

export interface CandidateCardProps {
  candidate: CandidateFrame;
  isActive: boolean;
  isAnnotationExpanded: boolean;
  isSelected: boolean;
  isSelectable: boolean;
  onActivate: () => void;
  onJumpToSimilar?: (() => void) | undefined;
  onSetStatus: (status: CandidateStatus) => void;
  onToggleSelection: () => void;
  onToggleAnnotation: () => void;
  recordingHeight?: number | null;
  recordingWidth?: number | null;
  similarLink?: SimilarLink | undefined;
  /** Every step of the run, in order, for choosing which screen this one shows. */
  steps: CandidateFrame[];
  onUpdate: (payload: CandidateChanges) => void;
  /** Narrow card: scores and the notes toggle move out of the way until the card is active. */
  compact?: boolean;
  hover?: StepHoverProps;
}

export function CandidateCard({
  candidate,
  isActive,
  isAnnotationExpanded,
  isSelected,
  isSelectable,
  onActivate,
  onJumpToSimilar,
  onSetStatus,
  onToggleSelection,
  onToggleAnnotation,
  recordingHeight,
  recordingWidth,
  similarLink,
  steps,
  onUpdate,
  compact = false,
  hover,
}: CandidateCardProps) {
  const liveSlotRef = useRef<HTMLDivElement | null>(null);
  const { title, setTitle, notes, setNotes, commit: commitTextField } = useAnnotationDrafts(candidate, onUpdate);
  // The title and notes fields open only on request, so a selected card can still be just a screenshot.
  // Saved text stays visible as plain text while the fields are closed.
  const hasAnnotation = Boolean(candidate.title || candidate.notes);
  const showAnnotation = isAnnotationExpanded;
  const annotationToggleLabel = showAnnotation ? 'hide notes' : hasAnnotation ? 'edit notes' : 'annotate';
  const screenSummary = screenChoiceSummary(candidate, steps);

  const imageAspectRatio =
    recordingWidth && recordingHeight && recordingWidth > 0 && recordingHeight > 0 ? recordingWidth / recordingHeight : 16 / 10;

  return (
    <article
      className={`candidate-card ${candidate.status} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${compact ? 'compact' : ''} ${showAnnotation ? 'annotating' : ''}`}
      id={`candidate-${candidate.id}`}
      onClick={onActivate}
      onFocus={onActivate}
      tabIndex={-1}
    >
      <div
        className={`candidate-image-wrap ${hover?.state ? `hover-${hover.state}` : ''}`}
        style={{ aspectRatio: String(imageAspectRatio) }}
        {...hoverHandlers(hover, liveSlotRef)}
      >
        <img alt={`candidate screenshot at ${candidate.timestamp_tc}`} src={absoluteApiUrl(candidate.image_url)} />
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
                aria-label={`Select candidate ${candidate.detector_index}`}
                checked={isSelected}
                onChange={onToggleSelection}
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
        <div className="candidate-headline">
          <div className="candidate-heading-copy">
            <strong className="candidate-title">
              {candidate.candidate_origin === 'manual' ? 'manual step' : 'candidate'} {candidate.detector_index}
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
                  <span>
                    text <strong className="info-text">{candidate.score_breakdown.text.toFixed(2)}</strong>
                  </span>
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

        {screenSummary && !showAnnotation ? (
          <div className="candidate-secondary-row candidate-screen-summary" title="your choice for the pathway">
            screen: {screenSummary}
          </div>
        ) : null}

        {showAnnotation && (
          <div className="candidate-annotation-panel">
            <label className="candidate-field-group">
              <span>step title</span>
              <input
                className="candidate-field"
                onBlur={(event) => commitTextField('title', event.target.value)}
                onChange={(event) => setTitle(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                placeholder="optional custom label"
                value={title}
              />
            </label>

            <label className="candidate-field-group">
              <span>notes</span>
              <textarea
                className="candidate-field candidate-notes-field"
                onBlur={(event) => commitTextField('notes', event.target.value)}
                onChange={(event) => setNotes(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                placeholder="add observation, annotation note, or coding hint"
                value={notes}
              />
            </label>

            <div className="candidate-field-group">
              <span>screen in the pathway</span>
              <ScreenChoice candidate={candidate} onUpdate={onUpdate} steps={steps} />
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
  isSelected: boolean;
  isSelectable: boolean;
  onActivate: () => void;
  onJumpToSimilar?: (() => void) | undefined;
  onSetStatus: (status: CandidateStatus) => void;
  onToggleSelection: () => void;
  onUpdate: CandidateCardProps['onUpdate'];
  similarLink?: SimilarLink | undefined;
  steps: CandidateFrame[];
  thumbHeight: number;
  thumbWidth: number;
  hover?: StepHoverProps;
}

/** One step as a table row: for runs with many steps, and for writing titles and notes in one pass. */
export function CandidateRow({
  candidate,
  isActive,
  isSelected,
  isSelectable,
  onActivate,
  onJumpToSimilar,
  onSetStatus,
  onToggleSelection,
  onUpdate,
  similarLink,
  steps,
  thumbHeight,
  thumbWidth,
  hover,
}: CandidateRowProps) {
  const noSlot = useRef<HTMLElement | null>(null);
  const { title, setTitle, notes, setNotes, commit } = useAnnotationDrafts(candidate, onUpdate);
  const onScreenMs = candidate.score_breakdown?.dwell_after_ms;
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return (
    <div
      className={`candidate-row ${candidate.status} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
      id={`candidate-${candidate.id}`}
      onClick={onActivate}
      onFocus={onActivate}
      role="row"
      tabIndex={-1}
    >
      <div className="candidate-row-select" role="cell">
        {isSelectable ? (
          <input
            aria-label={`Select candidate ${candidate.detector_index}`}
            checked={isSelected}
            onChange={onToggleSelection}
            onClick={stop}
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
          src={absoluteApiUrl(candidate.image_url)}
        />
        <span aria-hidden="true" className="candidate-hover-progress" />
        {hover?.state === 'armed' ? <PlayFromHereButton iconOnly onClick={hover.onPlayFromHere} /> : null}
      </div>
      <div className="candidate-row-step" role="cell">
        <strong>
          {candidate.candidate_origin === 'manual' ? 'manual ' : ''}
          {candidate.detector_index}
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
        <ScreenChoice candidate={candidate} onUpdate={onUpdate} prefix="screen: " steps={steps} />
      </div>
      <div className="candidate-row-duration" role="cell">
        {hasFiniteNumber(onScreenMs) ? formatSeconds(onScreenMs) : '–'}
      </div>
      <div className="candidate-row-title" role="cell">
        <input
          aria-label={`title of step ${candidate.detector_index}`}
          className="candidate-field"
          onBlur={(event) => commit('title', event.target.value)}
          onChange={(event) => setTitle(event.target.value)}
          onClick={stop}
          placeholder="step title"
          value={title}
        />
      </div>
      <div className="candidate-row-notes" role="cell">
        <input
          aria-label={`notes on step ${candidate.detector_index}`}
          className="candidate-field"
          onBlur={(event) => commit('notes', event.target.value)}
          onChange={(event) => setNotes(event.target.value)}
          onClick={stop}
          placeholder="notes"
          title={notes || undefined}
          value={notes}
        />
      </div>
      <div className="candidate-row-actions" onClick={stop} onPointerDown={stop} role="cell">
        <CandidateDecisionButtons candidate={candidate} onSetStatus={onSetStatus} />
      </div>
    </div>
  );
}
