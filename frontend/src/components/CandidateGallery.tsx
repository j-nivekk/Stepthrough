import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { screenshotUrl } from '../lib/screenshots';
import type { SimilarLink } from '../lib/analysis';
import { formatPathwayTime } from '../lib/pathwayFigure';
import type { GalleryLayoutSizing } from '../lib/stepLayout';
import { START } from '../lib/stepNumbers';
import type { CandidateChanges, CandidateFrame, CandidateStatus, StepTextDetail } from '../types';
import {
  BackLink,
  CandidateDecisionButtons,
  CandidateLabel,
  EDITED_ELSEWHERE,
  PhasesIcon,
  StackingIcon,
  formatSeconds,
  formatSigned,
  hasFiniteNumber,
  hoverHandlers,
  useAnnotationDrafts,
  useStepEditing,
  type StepHoverProps,
} from './CandidateCard';
import { PhaseChoice, phaseInfoAt, type PhaseSpanInfo } from './PhaseChoice';
import { ScreenChoice } from './ScreenChoice';
import { useStepNumbers } from './StepNumbers';
import { CopyTextButton, StepTextBody, StepTextLayer, useStepText } from './StepText';

export interface CandidateGalleryProps {
  candidates: CandidateFrame[];
  allSteps: CandidateFrame[];
  activeCandidateId: string | null;
  hoveredCandidateId: string | null;
  selectedCandidateIds: string[];
  similarityLinks: Map<string, SimilarLink>;
  /** Where the user went back to after a step, as the reviewer said in the pathway. */
  backLinks: Map<string, SimilarLink>;
  phases?: { runId: string; boundaries: Array<{ start_ms: number; name: string }> | undefined };
  durationMs?: number | null;
  aspect: number;
  sizing: GalleryLayoutSizing;
  hoverFor: (candidate: CandidateFrame) => StepHoverProps;
  onActivate: (candidateId: string) => void;
  onStep: (direction: -1 | 1) => void;
  onHoverChange: (candidateId: string | null) => void;
  onJumpToSimilar: (targetId: string) => void;
  onPaintStart: (candidateId: string, currentlySelected: boolean) => void;
  onPaintEnter: (candidateId: string) => void;
  onSetStatus: (candidate: CandidateFrame, status: CandidateStatus) => void;
  onToggleSelection: (candidateId: string, shift: boolean) => void;
  onUpdate: (candidateId: string, payload: CandidateChanges) => void;
  /** A right click on a thumbnail, the large screenshot or the panel beside it. */
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

interface FilmstripPhaseGroup {
  key: string;
  name: string;
  items: CandidateFrame[];
}

function formatPhaseRange(info: PhaseSpanInfo): string {
  const when = `${formatPathwayTime(info.start)}${info.end !== null ? ` to ${formatPathwayTime(info.end)}` : ' onwards'}`;
  if (!info.name) return `outside every phase · ${when}`;
  const count = info.accepted === 1 ? '1 accepted step' : `${info.accepted} accepted steps`;
  return `phase · ${when} · ${count}`;
}

/**
 * Finder-style gallery view for close-up, per-screen review and annotation: a large matted screenshot stage
 * (whose inner media frame hugs the exact rendered screenshot pixels for future on-screen element callouts),
 * an always-open editorial inspector beside it, and a horizontal filmstrip with batch selection below.
 */
export function CandidateGallery({
  candidates,
  allSteps,
  activeCandidateId,
  hoveredCandidateId,
  selectedCandidateIds,
  similarityLinks,
  backLinks,
  phases,
  durationMs,
  aspect,
  sizing,
  hoverFor,
  onActivate,
  onStep,
  onHoverChange,
  onJumpToSimilar,
  onPaintStart,
  onPaintEnter,
  onSetStatus,
  onToggleSelection,
  onUpdate,
  onContextMenu,
}: CandidateGalleryProps) {
  const activeIndex = useMemo(() => {
    if (!candidates.length) return -1;
    const index = activeCandidateId ? candidates.findIndex((item) => item.id === activeCandidateId) : -1;
    return index >= 0 ? index : 0;
  }, [activeCandidateId, candidates]);

  const activeCandidate = activeIndex >= 0 ? candidates[activeIndex] : null;
  const selectedSet = useMemo(() => new Set(selectedCandidateIds), [selectedCandidateIds]);

  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const thumbRefs = useRef(new Map<string, HTMLDivElement>());
  const paintedDownIdRef = useRef<string | null>(null);
  const [stripPanning, setStripPanning] = useState(false);
  const stripDragRef = useRef<{ startX: number; startScroll: number; moved: boolean } | null>(null);

  // Smoothly keep the active thumbnail centered horizontally in the filmstrip without nudging vertical page scroll.
  useEffect(() => {
    if (!activeCandidate) return;
    const strip = filmstripRef.current;
    const tile = thumbRefs.current.get(activeCandidate.id);
    if (!strip || !tile) return;
    const stripRect = strip.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    const margin = 44;
    if (tileRect.left < stripRect.left + margin || tileRect.right > stripRect.right - margin) {
      const targetLeft =
        strip.scrollLeft + (tileRect.left + tileRect.width / 2) - (stripRect.left + stripRect.width / 2);
      strip.scrollTo({ left: Math.max(0, targetLeft), behavior: 'smooth' });
    }
  }, [activeCandidate?.id, candidates.length]);

  const hasPhases = useMemo(
    () => Boolean(phases?.boundaries?.some((boundary) => boundary.name)),
    [phases?.boundaries],
  );

  const numberOf = useStepNumbers();

  // The text of the step shown, which stays open from one step to the next, and the line of it pointed at.
  const [textWanted, setTextWanted] = useState(false);
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);
  const textOpen = textWanted && Boolean(activeCandidate?.text_state);
  const stepText = useStepText(activeCandidate, textOpen);
  useEffect(() => setHighlightedLine(null), [activeCandidate?.id, textOpen]);

  const filmstripGroups = useMemo<FilmstripPhaseGroup[]>(() => {
    if (!hasPhases) {
      return [{ key: 'all', name: '', items: candidates }];
    }
    const groups: FilmstripPhaseGroup[] = [];
    for (const candidate of candidates) {
      const info = phaseInfoAt(phases?.boundaries, candidate.timestamp_ms, allSteps, durationMs);
      const name = info?.name ?? '';
      const last = groups[groups.length - 1];
      if (last && last.name === name) {
        last.items.push(candidate);
      } else {
        groups.push({ key: `${candidate.id}-${name}`, name, items: [candidate] });
      }
    }
    return groups;
  }, [allSteps, candidates, durationMs, hasPhases, phases?.boundaries]);

  if (!activeCandidate) return null;

  // the opening screen is where the steps start and none of them, so a phase does not count it
  const stepsToCount = allSteps.filter((step) => numberOf(step).number !== START);
  const activePhase = phaseInfoAt(phases?.boundaries, activeCandidate.timestamp_ms, stepsToCount, durationMs);
  const activeHover = hoverFor(activeCandidate);
  const activeSimilar = similarityLinks.get(activeCandidate.id);
  const activeBack = backLinks.get(activeCandidate.id);

  return (
    <div
      aria-label="steps gallery"
      className="candidate-gallery"
      id="analysis-candidate-review"
      onContextMenu={onContextMenu}
      style={
        {
          '--gallery-stage-height': sizing.stageHeightCss,
          '--gallery-aspect': String(aspect),
          '--gallery-thumb-height': `${sizing.thumbHeight}px`,
          '--gallery-thumb-width': `${sizing.thumbWidth}px`,
        } as CSSProperties
      }
    >
      <div className="candidate-gallery-main">
        <GalleryStage
          activeIndex={activeIndex}
          candidate={activeCandidate}
          hover={activeHover}
          highlightedLine={highlightedLine}
          isSelected={selectedSet.has(activeCandidate.id)}
          onHighlightLine={setHighlightedLine}
          onSetStatus={(status) => onSetStatus(activeCandidate, status)}
          onStep={onStep}
          onToggleSelection={(shift) => onToggleSelection(activeCandidate.id, shift)}
          name={numberOf(activeCandidate).name}
          text={textOpen ? stepText.data : undefined}
          total={candidates.length}
        />

        <GalleryInspector
          activePhase={activePhase}
          candidate={activeCandidate}
          backLink={activeBack}
          onJumpBack={activeBack ? () => onJumpToSimilar(activeBack.targetId) : undefined}
          onJumpToSimilar={activeSimilar ? () => onJumpToSimilar(activeSimilar.targetId) : undefined}
          onUpdate={(payload) => onUpdate(activeCandidate.id, payload)}
          phases={phases}
          name={numberOf(activeCandidate).name}
          similarLink={activeSimilar}
          steps={allSteps}
          highlightedLine={highlightedLine}
          onHighlightLine={setHighlightedLine}
          onToggleText={setTextWanted}
          text={stepText.data}
          textError={stepText.error}
          textOpen={textOpen}
        />
      </div>

      <div className="candidate-gallery-filmstrip-shell">
        <div
          aria-label="step filmstrip"
          className={`candidate-gallery-filmstrip ${hasPhases ? 'has-phases' : ''} ${stripPanning ? 'is-panning' : ''}`}
          onPointerCancel={() => {
            stripDragRef.current = null;
            setStripPanning(false);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || event.ctrlKey) return; // with Control it is a right click on a Mac
            if (event.target instanceof Element && event.target.closest('input, label')) return;
            const strip = event.currentTarget;
            if (strip.scrollWidth <= strip.clientWidth) return;
            stripDragRef.current = {
              startX: event.clientX,
              startScroll: strip.scrollLeft,
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const drag = stripDragRef.current;
            if (!drag) return;
            const dx = event.clientX - drag.startX;
            if (!drag.moved && Math.abs(dx) < 6) return;
            if (!drag.moved) {
              drag.moved = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              setStripPanning(true);
            }
            event.currentTarget.scrollLeft = drag.startScroll - dx;
          }}
          onPointerUp={(event) => {
            const drag = stripDragRef.current;
            if (!drag) return;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (drag.moved) {
              window.setTimeout(() => {
                stripDragRef.current = null;
              }, 0);
            } else {
              stripDragRef.current = null;
            }
            setStripPanning(false);
          }}
          onWheel={(event) => {
            const strip = event.currentTarget;
            if (strip.scrollWidth <= strip.clientWidth) return;
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
              strip.scrollLeft += event.deltaY;
              event.preventDefault();
            }
          }}
          ref={filmstripRef}
          role="listbox"
        >
          {filmstripGroups.map((group, groupIndex) => (
            <div
              className={`candidate-gallery-phase-group ${hasPhases ? 'with-header' : ''} ${groupIndex > 0 ? 'has-divider' : ''} ${group.name ? '' : 'is-none'}`}
              key={group.key}
            >
              {hasPhases ? (
                <div className="candidate-gallery-phase-rail">
                  <button
                    className="candidate-gallery-phase-label"
                    onClick={() => {
                      if (stripDragRef.current?.moved) return;
                      if (group.items[0]) onActivate(group.items[0].id);
                    }}
                    title={group.name || 'outside every phase'}
                    type="button"
                  >
                    {group.name || 'outside every phase'}
                  </button>
                </div>
              ) : null}
              <div className="candidate-gallery-phase-thumbs">
                {group.items.map((candidate) => {
                  const isActive = candidate.id === activeCandidate.id;
                  const isSelected = selectedSet.has(candidate.id);
                  const isCrossHovered = hoveredCandidateId === candidate.id;
                  const called = numberOf(candidate);
                  return (
                    <div
                      aria-selected={isActive}
                      className={`candidate-gallery-thumb ${candidate.status} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${isCrossHovered ? 'is-cross-hovered' : ''}`}
                      id={`candidate-${candidate.id}`}
                      key={candidate.id}
                      onClick={(event) => {
                        if (stripDragRef.current?.moved) return;
                        if (event.shiftKey) {
                          event.preventDefault();
                          onToggleSelection(candidate.id, true);
                          onActivate(candidate.id);
                          return;
                        }
                        if (event.metaKey || event.ctrlKey) {
                          event.preventDefault();
                          onToggleSelection(candidate.id, false);
                          return;
                        }
                        onActivate(candidate.id);
                      }}
                      onMouseDown={(event) => {
                        if (event.shiftKey) event.preventDefault();
                      }}
                      onMouseEnter={() => onHoverChange(candidate.id)}
                      onMouseLeave={() => onHoverChange(null)}
                      onPointerEnter={() => onPaintEnter(candidate.id)}
                      ref={(node) => {
                        if (node) thumbRefs.current.set(candidate.id, node);
                        else thumbRefs.current.delete(candidate.id);
                      }}
                      role="option"
                      tabIndex={-1}
                      title={`${called.name} · ${candidate.timestamp_tc}${candidate.title ? ` · ${candidate.title}` : ''}`}
                    >
                      <div className="candidate-gallery-thumb-media">
                        <img
                          alt={`${called.name} at ${candidate.timestamp_tc}`}
                          draggable={false}
                          loading="lazy"
                          src={screenshotUrl(candidate.image_url, sizing.thumbWidth)}
                        />
                        <label
                          className="candidate-gallery-thumb-check"
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <input
                            aria-label={`select ${called.name}`}
                            checked={isSelected}
                            onChange={() => undefined}
                            onClick={(event) => {
                              if (paintedDownIdRef.current === candidate.id) {
                                paintedDownIdRef.current = null;
                                return;
                              }
                              onToggleSelection(candidate.id, event.shiftKey);
                            }}
                            onMouseDown={(event) => event.shiftKey && event.preventDefault()}
                            onPointerDown={(event) => {
                              if (event.button === 0 && !event.shiftKey && !event.ctrlKey) {
                                paintedDownIdRef.current = candidate.id;
                                onPaintStart(candidate.id, isSelected);
                              }
                            }}
                            type="checkbox"
                          />
                        </label>
                        <span aria-hidden="true" className={`candidate-gallery-thumb-status ${candidate.status}`} />
                      </div>
                      <div className="candidate-gallery-thumb-caption">
                        <span className={`candidate-gallery-thumb-num ${candidate.status === 'accepted' ? '' : 'is-candidate'}`}>
                          {called.number}
                        </span>
                        <span className="candidate-gallery-thumb-time">{candidate.timestamp_tc.slice(3, 8)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface GalleryStageProps {
  candidate: CandidateFrame;
  /** What the step is called: "step 5", "candidate 7". */
  name: string;
  activeIndex: number;
  total: number;
  isSelected: boolean;
  hover: StepHoverProps;
  /** The text of the step, while it is open beside the screenshot: its lines are then marked on it. */
  text?: StepTextDetail;
  highlightedLine: number | null;
  onHighlightLine: (line: number | null) => void;
  onStep: (direction: -1 | 1) => void;
  onSetStatus: (status: CandidateStatus) => void;
  onToggleSelection: (shift: boolean) => void;
}

function GalleryStage({
  candidate,
  name,
  activeIndex,
  total,
  isSelected,
  hover,
  text,
  highlightedLine,
  onHighlightLine,
  onStep,
  onSetStatus,
  onToggleSelection,
}: GalleryStageProps) {
  const liveSlotRef = useRef<HTMLDivElement | null>(null);

  return (
    <div data-step-id={candidate.id} className={`candidate-gallery-stage ${candidate.status} ${isSelected ? 'selected' : ''}`}>
      <div className="candidate-gallery-stage-top">
        <div className="candidate-gallery-stage-meta">
          <span className="candidate-timecode">{candidate.timestamp_tc}</span>
          <span className="candidate-gallery-counter">
            {activeIndex + 1} / {total}
          </span>
        </div>
        <label
          className="candidate-gallery-stage-select"
          onClick={(event) => event.stopPropagation()}
          title="select this step for batch actions (x, or shift+x for a range)"
        >
          <input
            aria-label={`select ${name}`}
            checked={isSelected}
            onChange={() => undefined}
            onClick={(event) => onToggleSelection(event.shiftKey)}
            onMouseDown={(event) => event.shiftKey && event.preventDefault()}
            type="checkbox"
          />
          <span>{isSelected ? 'selected' : 'select'}</span>
        </label>
      </div>

      <div className="candidate-gallery-media-row">
        <button
          aria-label="previous step"
          className="candidate-gallery-nav-btn"
          disabled={activeIndex <= 0}
          onClick={() => onStep(-1)}
          title="previous step (←)"
          type="button"
        >
          <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 16 16" width="16">
            <path d="M10 3.5 5.5 8 10 12.5" />
          </svg>
        </button>

        <div className="candidate-gallery-viewport">
          {/* Coordinate-faithful frame hugging the rendered screenshot pixels 1:1. While its text is open, pointing at
              the screenshot picks lines of text, so it plays no clip. */}
          <div
            className={`candidate-gallery-frame ${hover.state && !text ? `hover-${hover.state}` : ''}`}
            data-gallery-media-frame=""
            {...hoverHandlers(text ? undefined : hover, liveSlotRef)}
          >
            <img
              alt={`candidate screenshot at ${candidate.timestamp_tc}`}
              draggable={false}
              src={screenshotUrl(candidate.image_url)}
            />
            <div aria-hidden="true" className="candidate-live-slot" ref={liveSlotRef} />
            <span aria-hidden="true" className="candidate-hover-progress" />
            {text ? <StepTextLayer detail={text} highlighted={highlightedLine} onHighlight={onHighlightLine} /> : null}
          </div>
        </div>

        <button
          aria-label="next step"
          className="candidate-gallery-nav-btn"
          disabled={activeIndex >= total - 1}
          onClick={() => onStep(1)}
          title="next step (→)"
          type="button"
        >
          <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 16 16" width="16">
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </button>
      </div>

      <div className="candidate-gallery-stage-bottom">
        <button
          className="candidate-gallery-play-btn"
          onClick={hover.onPlayFromHere}
          title="play from here in the preview (p)"
          type="button"
        >
          <svg aria-hidden="true" fill="currentColor" height="11" viewBox="0 0 12 12" width="11">
            <path d="M3 1.8v8.4L10 6z" />
          </svg>
          <span>play from here</span>
        </button>
        <div className="candidate-gallery-decisions">
          <CandidateDecisionButtons candidate={candidate} onSetStatus={onSetStatus} />
        </div>
      </div>
    </div>
  );
}

interface GalleryInspectorProps {
  candidate: CandidateFrame;
  /** What the step is called: "step 5", "candidate 7". */
  name: string;
  activePhase: PhaseSpanInfo | null;
  similarLink?: SimilarLink;
  onJumpToSimilar?: () => void;
  backLink?: SimilarLink;
  onJumpBack?: () => void;
  steps: CandidateFrame[];
  phases?: { runId: string; boundaries: Array<{ start_ms: number; name: string }> | undefined };
  text?: StepTextDetail;
  textError?: Error | null;
  textOpen: boolean;
  highlightedLine: number | null;
  onHighlightLine: (line: number | null) => void;
  onToggleText: (open: boolean) => void;
  onUpdate: (payload: CandidateChanges) => void;
}

function GalleryInspector({
  candidate,
  name,
  activePhase,
  similarLink,
  onJumpToSimilar,
  backLink,
  onJumpBack,
  steps,
  phases,
  text,
  textError,
  textOpen,
  highlightedLine,
  onHighlightLine,
  onToggleText,
  onUpdate,
}: GalleryInspectorProps) {
  const editing = useStepEditing(candidate);
  const { title, setTitle, notes, setNotes, commit } = useAnnotationDrafts(candidate, onUpdate, editing.lockedElsewhere);
  const onScreenMs = candidate.score_breakdown?.dwell_after_ms;
  const [scoresOpen, setScoresOpen] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);

  // Close the temporary scores overlay when switching to another step.
  useEffect(() => {
    setScoresOpen(false);
  }, [candidate.id]);

  // Allow Escape to collapse the temporary scores or text overlay cleanly.
  useEffect(() => {
    if (!scoresOpen && !textOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setScoresOpen(false);
        onToggleText(false);
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onToggleText, scoresOpen, textOpen]);

  // Auto-grow the step title textarea as it wraps, capped cleanly so notes always retain room.
  // Include top/bottom border thickness so border-box sizing never triggers a 2px phantom scrollbar on 1 line.
  useEffect(() => {
    const field = titleRef.current;
    if (!field) return;
    field.style.height = 'auto';
    const borderY = field.offsetHeight - field.clientHeight;
    const nextHeight = field.scrollHeight + borderY;
    field.style.height = `${Math.min(nextHeight, 94)}px`;
    field.style.overflowY = nextHeight > 94 ? 'auto' : 'hidden';
  }, [title, candidate.id]);

  return (
    <aside aria-label="step inspector" className={`candidate-gallery-inspector ${candidate.status}`} data-step-id={candidate.id}>
      {editing.lockedElsewhere ? (
        <p className="live-band" role="status">
          {EDITED_ELSEWHERE}
        </p>
      ) : null}

      <div className="candidate-gallery-inspector-head">
        <div className="candidate-gallery-inspector-title-row">
          <strong className="candidate-title">{name}</strong>
          {hasFiniteNumber(onScreenMs) ? (
            <span className="candidate-gallery-dwell" title="time on screen">
              {formatSeconds(onScreenMs)}
            </span>
          ) : null}
        </div>
        <div className="candidate-heading-meta">
          <span className={`candidate-status-copy ${candidate.status}`}>{candidate.status}</span>
          {candidate.candidate_origin === 'manual' ? <span className="candidate-origin-copy">manual</span> : null}
          <CandidateLabel candidate={candidate} />
        </div>
        {similarLink && onJumpToSimilar ? (
          <button
            className="inline-link-button candidate-similarity-link"
            onClick={onJumpToSimilar}
            title="jump to the earlier step that shows the same screen"
            type="button"
          >
            {similarLink.label}
          </button>
        ) : null}
        {backLink && onJumpBack ? <BackLink link={backLink} onJump={onJumpBack} /> : null}
      </div>

      {activePhase ? (
        <div className={`candidate-gallery-phase-banner ${activePhase.name ? '' : 'is-none'}`}>
          {activePhase.name ? <strong className="candidate-gallery-phase-banner-name">{activePhase.name}</strong> : null}
          <span className="candidate-gallery-phase-banner-meta">{formatPhaseRange(activePhase)}</span>
        </div>
      ) : null}

      {/* Flexible middle area: step title auto-grows and notes expands to fill all remaining space;
          the temporary scores drawer expands upward over this region without shifting the bottom settings. */}
      <div className="candidate-gallery-inspector-middle">
        <div className="candidate-gallery-inspector-fields">
          <label className="candidate-field-group candidate-gallery-title-group">
            <span>step title</span>
            <textarea
              className="candidate-field candidate-gallery-title-field"
              onBlur={(event) => {
                commit('title', event.target.value.replace(/\s*\n+\s*/g, ' '));
                editing.onBlurField();
              }}
              onChange={(event) => setTitle(event.target.value.replace(/\r?\n/g, ' '))}
              onFocus={editing.onFocusField}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              placeholder="optional custom label"
              readOnly={editing.lockedElsewhere}
              ref={titleRef}
              rows={1}
              title={editing.lockedElsewhere ? EDITED_ELSEWHERE : title || undefined}
              value={title}
            />
          </label>

          <label className="candidate-field-group candidate-gallery-notes-group">
            <span>notes</span>
            <textarea
              className="candidate-field candidate-notes-field candidate-gallery-notes"
              onBlur={(event) => {
                commit('notes', event.target.value);
                editing.onBlurField();
              }}
              onChange={(event) => setNotes(event.target.value)}
              onFocus={editing.onFocusField}
              placeholder="add observation, annotation note, or coding hint"
              readOnly={editing.lockedElsewhere}
              title={editing.lockedElsewhere ? EDITED_ELSEWHERE : notes || undefined}
              value={notes}
            />
          </label>
        </div>

        {textOpen ? (
          <div aria-label="text on the screen" className="candidate-gallery-scores-overlay candidate-gallery-text-overlay" role="region">
            <div className="candidate-gallery-scores-overlay-head">
              <span>text</span>
              <span className="candidate-gallery-text-actions">
                <CopyTextButton detail={text} />
                <button aria-label="hide text" className="inline-link-button" onClick={() => onToggleText(false)} type="button">
                  hide
                </button>
              </span>
            </div>
            <StepTextBody candidate={candidate} detail={text} error={textError} highlighted={highlightedLine} onHighlight={onHighlightLine} />
          </div>
        ) : null}

        {scoresOpen ? (
          <div aria-label="step scores" className="candidate-gallery-scores-overlay" role="region">
            <div className="candidate-gallery-scores-overlay-head">
              <span>scores</span>
              <button
                aria-label="hide scores"
                className="inline-link-button"
                onClick={() => setScoresOpen(false)}
                type="button"
              >
                hide
              </button>
            </div>
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
          </div>
        ) : null}
      </div>

      {/* Pinned footer: compact `<icon> <operation>  [control]` rows for stacking & phases, plus scores toggle. */}
      <div className="candidate-gallery-inspector-footer">
        <div className="candidate-gallery-setting-row">
          <span className="candidate-gallery-setting-label">
            <StackingIcon />
            <span>stacking</span>
          </span>
          <div className="candidate-gallery-setting-control">
            <ScreenChoice candidate={candidate} onUpdate={onUpdate} steps={steps} />
          </div>
        </div>

        {phases && candidate.status === 'accepted' ? (
          <div className="candidate-gallery-setting-row">
            <span className="candidate-gallery-setting-label">
              <PhasesIcon />
              <span>phases</span>
            </span>
            <div className="candidate-gallery-setting-control">
              <PhaseChoice candidate={candidate} phases={phases.boundaries} runId={phases.runId} />
            </div>
          </div>
        ) : null}

        <div className="candidate-gallery-scores-row">
          <button
            aria-expanded={scoresOpen}
            className={`inline-link-button candidate-gallery-scores-toggle ${scoresOpen ? 'is-open' : ''}`}
            onClick={() => {
              onToggleText(false);
              setScoresOpen((open) => !open);
            }}
            type="button"
          >
            {scoresOpen ? 'hide scores' : 'scores'}
          </button>
          {candidate.text_state ? (
            <button
              aria-expanded={textOpen}
              className={`inline-link-button candidate-gallery-scores-toggle ${textOpen ? 'is-open' : ''}`}
              onClick={() => {
                setScoresOpen(false);
                onToggleText(!textOpen);
              }}
              title="the text on the screen, and where it is"
              type="button"
            >
              {textOpen ? 'hide text' : 'text'}
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
