import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { setRunPhase } from '../api';
import { formatPathwayTime } from '../lib/pathwayFigure';
import type { CandidateFrame } from '../types';

type Boundary = { start_ms: number; name: string };

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
 * Which phase of the walkthrough an accepted step is in, in the step review: one of the phases named so far, a new
 * one, or none. It names this one step, as the pathway's phases panel names a stretch of them; a phase with the same
 * name next to it takes it in.
 */
export function PhaseChoice({
  candidate,
  runId,
  phases,
  prefix,
}: {
  candidate: CandidateFrame;
  runId: string;
  phases: Boundary[] | undefined;
  /** Before the choice in a tight row, such as "phase: ". */
  prefix?: string;
}) {
  const queryClient = useQueryClient();
  const current = phaseAt(phases, candidate.timestamp_ms);
  const names = [...new Set((phases ?? []).map((boundary) => boundary.name).filter(Boolean))];
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function choose(name: string) {
    if (name === current) return;
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
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message.toLocaleLowerCase() : 'could not save the phase.');
    } finally {
      setSaving(false);
    }
  }

  if (naming) {
    return (
      <span className="phase-choice" onClick={(event) => event.stopPropagation()}>
        {prefix ? <span className="phase-choice-prefix">{prefix}</span> : null}
        <input
          aria-label="name of the new phase"
          autoFocus
          className="candidate-field phase-choice-input"
          disabled={saving}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft.trim()) void choose(draft.trim());
            if (event.key === 'Escape') setNaming(false);
          }}
          placeholder="sign up"
          value={draft}
        />
        {error ? <span className="editable-name-error">{error}</span> : null}
      </span>
    );
  }

  return (
    <span className="phase-choice" onClick={(event) => event.stopPropagation()}>
      {prefix ? <span className="phase-choice-prefix">{prefix}</span> : null}
      <select
        aria-label={`phase of step ${candidate.detector_index}`}
        className="phase-choice-select"
        disabled={saving}
        onChange={(event) => {
          if (event.target.value === '\u0000new') setNaming(true);
          else void choose(event.target.value);
        }}
        title="the phase of the walkthrough this step is in: drawn over its box in the pathway, and in the export"
        value={current}
      >
        <option value="">no phase</option>
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={'\u0000new'}>new phase…</option>
      </select>
      {error ? <span className="editable-name-error">{error}</span> : null}
    </span>
  );
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
              phase of the walkthrough, {when}, {accepted === 1 ? '1 accepted step' : `${accepted} accepted steps`}
            </span>
          </>
        ) : (
          <span className="step-phase-header-note">outside every phase, {when}</span>
        )}
      </span>
    </div>
  );
}
