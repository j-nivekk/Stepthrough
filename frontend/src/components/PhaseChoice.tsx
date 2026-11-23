import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { setRunPhase } from '../api';
import { formatPathwayTime } from '../lib/pathwayFigure';
import type { CandidateFrame } from '../types';

type Boundary = { start_ms: number; name: string };

const POPOVER_WIDTH = 236;
const POPOVER_ROOM = 280;

/** The phase a moment of the recording is in: the name of the last phase that starts at or before it. */
export function phaseAt(boundaries: Boundary[] | undefined, ms: number): string {
  let name = '';
  for (const boundary of boundaries ?? []) {
    if (boundary.start_ms <= ms) name = boundary.name;
    else break;
  }
  return name;
}

/**
 * Which phase an accepted step is in, in the step review: one of the phases named so far, a new one, or none.
 * Uses the same inline trigger and floating popover as ScreenChoice so both controls read uniformly on step cards
 * and list rows.
 */
export function PhaseChoice({
  candidate,
  runId,
  phases,
  prefix,
  icon,
}: {
  candidate: CandidateFrame;
  runId: string;
  phases: Boundary[] | undefined;
  /** Before the choice in a tight row, such as "phase: ". */
  prefix?: string;
  /** Compact icon shown in narrow cards when the text heading collapses. */
  icon?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const current = phaseAt(phases, candidate.timestamp_ms);
  const names = [...new Set((phases ?? []).map((boundary) => boundary.name).filter(Boolean))];
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const shellRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const inside = (node: Node | null) => Boolean(node && (shellRef.current?.contains(node) || popoverRef.current?.contains(node)));
    function closeOutside(event: PointerEvent) {
      if (!inside(event.target as Node | null)) {
        setOpen(false);
        setNaming(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        setNaming(false);
        triggerRef.current?.focus();
      }
    }
    function closeOnScroll(event: Event) {
      if (!(event.target instanceof Node) || !inside(event.target)) {
        setOpen(false);
        setNaming(false);
      }
    }
    const close = () => {
      setOpen(false);
      setNaming(false);
    };
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

  function toggle() {
    if (!open && shellRef.current) {
      const link = shellRef.current.getBoundingClientRect();
      const left = Math.max(16, Math.min(link.left, window.innerWidth - POPOVER_WIDTH - 16));
      const below = window.innerHeight - link.bottom;
      setPlace(
        below >= POPOVER_ROOM || below >= link.top
          ? { left, top: link.bottom + 6, maxHeight: Math.max(140, below - 22) }
          : { left, bottom: window.innerHeight - link.top + 6, maxHeight: Math.max(140, link.top - 22) },
      );
      setNaming(false);
      setError('');
    }
    setOpen((was) => !was);
  }

  async function choose(name: string) {
    if (name === current) {
      setOpen(false);
      setNaming(false);
      triggerRef.current?.focus();
      return;
    }
    setSaving(true);
    setError('');
    try {
      await setRunPhase(runId, { name, first_step: candidate.id, last_step: candidate.id });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['run', runId] }),
        queryClient.invalidateQueries({ queryKey: ['pathway', runId] }),
      ]);
      setNaming(false);
      setDraft('');
      setOpen(false);
      triggerRef.current?.focus();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message.toLocaleLowerCase() : 'could not save the phase.');
    } finally {
      setSaving(false);
    }
  }

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const valueText = saving ? 'saving…' : current || 'no phase';

  const popover = open ? (
    <div
      aria-label={`phase of step ${candidate.detector_index}`}
      className="screen-choice-popover phase-choice-popover"
      onClick={stop}
      onPointerDown={stop}
      ref={popoverRef}
      role="dialog"
      style={place}
    >
      <p className="screen-choice-heading">phase for this step</p>
      <button
        aria-pressed={!current}
        className={`screen-choice-option ${!current ? 'active' : ''}`}
        disabled={saving}
        onClick={() => void choose('')}
        type="button"
      >
        <span>no phase</span>
        <small>outside every phase</small>
      </button>
      {names.map((name) => (
        <button
          aria-pressed={current === name}
          className={`screen-choice-option ${current === name ? 'active' : ''}`}
          disabled={saving}
          key={name}
          onClick={() => void choose(name)}
          type="button"
        >
          <span>{name}</span>
        </button>
      ))}
      <div className="phase-choice-new">
        {naming ? (
          <form
            className="phase-choice-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim()) void choose(draft.trim());
            }}
          >
            <input
              aria-label="name of the new phase"
              autoFocus
              className="candidate-field phase-choice-input"
              disabled={saving}
              maxLength={80}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setNaming(false);
                }
              }}
              placeholder="sign up"
              value={draft}
            />
            <button className="analysis-pill success phase-choice-save" disabled={saving || !draft.trim()} type="submit">
              add
            </button>
          </form>
        ) : (
          <button
            className="screen-choice-option"
            disabled={saving}
            onClick={() => {
              setDraft('');
              setNaming(true);
            }}
            type="button"
          >
            <span>new phase…</span>
          </button>
        )}
      </div>
      {error ? <span className="editable-name-error">{error}</span> : null}
    </div>
  ) : null;

  return (
    <div className="screen-choice phase-choice" onClick={stop} onPointerDown={stop} ref={shellRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`phase: ${current || 'no phase'}`}
        className={`inline-link-button screen-choice-trigger ${current ? 'chosen' : ''}`}
        disabled={saving}
        onClick={toggle}
        ref={triggerRef}
        title={`phase: ${current || 'no phase'}`}
        type="button"
      >
        {icon ? <span className="candidate-choice-icon" aria-hidden="true">{icon}</span> : null}
        {prefix ? <span className="screen-choice-prefix">{prefix}</span> : null}
        <span className="screen-choice-value">{valueText}</span>
      </button>
      {popover && typeof document !== 'undefined' ? createPortal(popover, document.body) : popover}
    </div>
  );
}

export interface PhaseSpanInfo {
  name: string;
  start: number;
  end: number | null;
  accepted: number;
}

/**
 * Resolve the walkthrough phase stretch containing `timestampMs` (or null when the run defines no named phases).
 * Returns `name: ''` when named phases exist elsewhere in the run but this step falls outside every phase.
 */
export function phaseInfoAt(
  boundaries: Boundary[] | undefined,
  timestampMs: number,
  allSteps: Array<{ timestamp_ms: number; status: string }>,
  durationMs: number | null | undefined,
): PhaseSpanInfo | null {
  const named = (boundaries ?? []).filter((boundary) => boundary.name);
  if (!named.length) return null;
  const ordered = [...(boundaries ?? [])].sort((a, b) => a.start_ms - b.start_ms);
  const name = phaseAt(ordered, timestampMs);
  const index = ordered.reduce((found, boundary, at) => (boundary.start_ms <= timestampMs ? at : found), -1);
  const start = index >= 0 ? ordered[index].start_ms : 0;
  const end = ordered[index + 1]?.start_ms ?? durationMs ?? null;
  const accepted = allSteps.filter(
    (item) => item.status === 'accepted' && item.timestamp_ms >= start && (end === null || item.timestamp_ms < end),
  ).length;
  return { name, start, end, accepted };
}

/**
 * The steps of the step review, with a header where a phase of the walkthrough starts (and where one ends, when the
 * steps after it are in none). Phases are stretches of the recording, so a header goes wherever the phase changes
 * between two steps shown, also when some steps are filtered out. Without phases, the steps are shown as they are.
 */
export function withPhaseHeaders<T extends { id: string; timestamp_ms: number }>(
  steps: T[],
  boundaries: Boundary[] | undefined,
  render: (step: T) => ReactNode,
  options: { list: boolean; allSteps: Array<{ timestamp_ms: number; status: string }>; durationMs: number | null | undefined },
): ReactNode[] {
  const named = (boundaries ?? []).filter((boundary) => boundary.name);
  if (!named.length) return steps.map(render);
  const ordered = [...(boundaries ?? [])].sort((a, b) => a.start_ms - b.start_ms);
  const nodes: ReactNode[] = [];
  let previous = '';
  for (const step of steps) {
    const name = phaseAt(ordered, step.timestamp_ms);
    if (name !== previous && (name || previous)) {
      // the stretch the step is in: from the last start at or before it to the next start (or the end)
      const index = ordered.reduce((found, boundary, at) => (boundary.start_ms <= step.timestamp_ms ? at : found), -1);
      const start = index >= 0 ? ordered[index].start_ms : 0;
      const end = ordered[index + 1]?.start_ms ?? options.durationMs ?? null;
      const accepted = options.allSteps.filter(
        (item) => item.status === 'accepted' && item.timestamp_ms >= start && (end === null || item.timestamp_ms < end),
      ).length;
      nodes.push(
        <PhaseHeader accepted={accepted} end={end} key={`phase-${step.id}`} list={options.list} name={name} start={start} />,
      );
    }
    previous = name;
    nodes.push(render(step));
  }
  return nodes;
}

/** A phase's header in the step review: its name, its stretch of the recording and how many steps it holds. */
function PhaseHeader({ name, start, end, accepted, list }: { name: string; start: number; end: number | null; accepted: number; list: boolean }) {
  const when = `${formatPathwayTime(start)}${end !== null ? ` to ${formatPathwayTime(end)}` : ' onwards'}`;
  return (
    <div className={`step-phase-header ${list ? 'in-list' : ''} ${name ? '' : 'is-none'}`} role={list ? 'row' : undefined}>
      <span role={list ? 'cell' : undefined}>
        {name ? (
          <>
            <b>{name}</b>
            <span className="step-phase-header-note">
              phase, {when}, {accepted === 1 ? '1 accepted step' : `${accepted} accepted steps`}
            </span>
          </>
        ) : (
          <span className="step-phase-header-note">outside every phase, {when}</span>
        )}
      </span>
    </div>
  );
}
