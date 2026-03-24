import { useEffect, useState } from 'react';
import { absoluteApiUrl } from '../api';
import type { SimilarLink } from '../lib/analysis';
import type { CandidateFrame, CandidateStatus } from '../types';

export function ComparisonMetrics({ candidate }: { candidate: CandidateFrame }) {
  return (
    <div className="analysis-compare-metrics">
      <span>overall {candidate.scene_score.toFixed(2)}</span>
      {candidate.score_breakdown ? (
        <>
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
  onUpdate: (payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>>) => void;
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
  onUpdate,
}: CandidateCardProps) {
  const [title, setTitle] = useState(candidate.title ?? '');
  const [notes, setNotes] = useState(candidate.notes ?? '');
  const showAnnotation = isAnnotationExpanded || isActive || Boolean(candidate.title || candidate.notes);
  const annotationToggleLabel = showAnnotation ? 'hide notes' : 'annotate';

  const imageAspectRatio = (() => {
    if (recordingWidth && recordingHeight && recordingWidth > 0 && recordingHeight > 0) {
      const naturalRatio = recordingWidth / recordingHeight;
      return Math.max(naturalRatio, 9 / 16);
    }
    return 16 / 10;
  })();

  useEffect(() => {
    setTitle(candidate.title ?? '');
    setNotes(candidate.notes ?? '');
  }, [candidate.id, candidate.title, candidate.notes]);

  function commitTextField(field: 'title' | 'notes', value: string) {
    const trimmed = value.trim();
    const currentValue = field === 'title' ? candidate.title ?? '' : candidate.notes ?? '';
    if (trimmed === currentValue.trim()) {
      return;
    }
    onUpdate({ [field]: trimmed } as Partial<Pick<CandidateFrame, 'title' | 'notes'>>);
  }

  return (
    <article
      className={`candidate-card ${candidate.status} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
      id={`candidate-${candidate.id}`}
      onClick={onActivate}
      onFocus={onActivate}
      tabIndex={-1}
    >
      <div className="candidate-image-wrap" style={{ aspectRatio: String(imageAspectRatio) }}>
        <img alt={`Candidate screenshot at ${candidate.timestamp_tc}`} src={absoluteApiUrl(candidate.image_url)} />
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
          <CandidateDecisionButton
            intent="accepted"
            isActive={candidate.status === 'accepted'}
            label="Accept candidate (A)"
            onClick={() => onSetStatus('accepted')}
          />
          <CandidateDecisionButton
            intent="rejected"
            isActive={candidate.status === 'rejected'}
            label="Reject candidate (R)"
            onClick={() => onSetStatus('rejected')}
          />
          <CandidateDecisionButton
            intent="pending"
            isActive={candidate.status === 'pending'}
            label="Reset candidate to pending (U)"
            onClick={() => onSetStatus('pending')}
          />
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
          {!showAnnotation && (
            <button
              className="candidate-annotation-toggle"
              onClick={(event) => {
                event.stopPropagation();
                onToggleAnnotation();
              }}
              type="button"
            >
              {annotationToggleLabel}
            </button>
          )}
          {showAnnotation && (candidate.title || candidate.notes) && (
            <button
              className="candidate-annotation-toggle"
              onClick={(event) => {
                event.stopPropagation();
                onToggleAnnotation();
              }}
              type="button"
            >
              hide notes
            </button>
          )}
        </div>

        {similarLink && onJumpToSimilar && (
          <div className="candidate-secondary-row">
            <button
              className="inline-link-button candidate-similarity-link"
              onClick={onJumpToSimilar}
              title="Jump to the earlier matching scene."
              type="button"
            >
              {similarLink.label}
            </button>
          </div>
        )}

        {showAnnotation && (
          <div className="candidate-annotation-panel">
            <label className="candidate-field-group">
              <span>step title</span>
              <input
                className="candidate-field"
                onBlur={(event) => commitTextField('title', event.target.value)}
                onChange={(event) => setTitle(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                placeholder="Optional custom label"
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
                placeholder="Add observation, annotation note, or coding hint"
                value={notes}
              />
            </label>
          </div>
        )}
      </div>
    </article>
  );
}
