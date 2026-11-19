import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { setRunPhase } from '../api';
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
