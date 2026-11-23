import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { formatPathwayTime } from '../../lib/pathwayFigure';
import type { Pathway, PathwayPhase } from '../../types';
import type { PhaseSteps } from '../../api';
import type { PhaseRequest } from './PathwayCanvas';

interface PathwayPhasesProps {
  pathway: Pathway;
  /** What the panel opens with (the list, a stretch of steps for a new phase, or a phase), and where. */
  request: PhaseRequest;
  /** Where it goes now, when that is no longer where it was opened (under the toolbox, which has moved). */
  at?: { x: number; y: number };
  onClose: () => void;
  disabled: boolean;
  /** Name the steps from `first_step` to `last_step` (candidate ids) as a phase; '' takes them out of every phase.
   *  `label` says what was done, for the status line and the undo. */
  onSet: (phase: PhaseSteps & { name: string; replacing?: PhaseSteps | null }, label: string) => Promise<void>;
}

interface Draft {
  /** The phase being changed, or null for a new one. */
  phase: PathwayPhase | null;
  name: string;
  from: number;
  to: number;
}

const stepsLabel = (phase: Pick<PathwayPhase, 'first_step_index' | 'last_step_index'>): string =>
  phase.first_step_index === phase.last_step_index
    ? `step ${phase.first_step_index}`
    : `steps ${phase.first_step_index}–${phase.last_step_index}`;

/**
 * The phases of the walkthrough, in a small floating panel: named stretches of steps, such as "sign up" or "verify
 * identity". The figure draws each as a bracket over its boxes with how many steps and screens it takes, and the
 * export gives every step its phase. A phase is stored as the stretch of the recording from its first step to the
 * step after its last, so a step added by hand in between belongs to it. Opened from the toolbar's phases, from
 * the toolbox or menu of a selection (with its steps), or from a phase's bracket in the chart.
 */
export function PathwayPhases({ pathway, request, at, onClose, disabled, onSet }: PathwayPhasesProps) {
  const phases = pathway.phases ?? [];
  const steps = pathway.steps;
  const byIndex = useMemo(() => new Map(steps.map((step) => [step.step_index, step])), [steps]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: request.at?.x ?? 16, top: request.at?.y ?? 16 });

  // A draft whose steps are gone (rejected, or the run changed) is let go.
  useEffect(() => {
    if (draft && (!byIndex.has(draft.from) || !byIndex.has(draft.to))) setDraft(null);
  }, [byIndex, draft]);

  function start(phase: PathwayPhase | null, range?: { from: number; to: number }) {
    setError('');
    if (phase) {
      setDraft({ phase, name: phase.name, from: phase.first_step_index, to: phase.last_step_index });
      return;
    }
    // the steps it was opened on, or else the first step outside every phase
    const free = steps.find((step) => !step.phase)?.step_index ?? steps[0]?.step_index ?? 1;
    setDraft({ phase: null, name: '', from: range?.from ?? free, to: range?.to ?? free });
  }

  // Opened on a stretch of steps or a phase, the panel starts on it.
  useEffect(() => {
    if ('phase' in request) {
      const phase = phases.find((item) => item.first_step_id === request.phase.first_step_id && item.name === request.phase.name);
      start(phase ?? null);
    } else if ('from' in request) start(null, request);
    else setDraft(null);
    // only when asked anew, not as the phases change after a save
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // It floats where it was opened (or, opened from the toolbox, under it as it moves), inside the window.
  const x = at?.x ?? request.at?.x ?? 16;
  const y = at?.y ?? request.at?.y ?? 16;
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
    setPlace({ left, top });
  }, [x, y, draft, phases.length]);

  // Escape, or a click elsewhere (but on the phases button, which opens and closes it), closes it.
  useEffect(() => {
    function away(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('.pathway-phases, [data-phases-toggle], .pathway-toolbox, .pathway-menu')) return;
      onClose();
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  async function send(name: string, label: string, replacing?: Draft['phase']) {
    if (!draft) return;
    const first = byIndex.get(draft.from);
    const last = byIndex.get(draft.to);
    if (!first || !last) return;
    const wasFirst = replacing ? steps.find((step) => step.step_id === replacing.first_step_id) : undefined;
    const wasLast = replacing ? steps.find((step) => step.step_id === replacing.last_step_id) : undefined;
    setSaving(true);
    setError('');
    try {
      await onSet(
        {
          name,
          first_step: first.source_candidate_id,
          last_step: last.source_candidate_id,
          replacing: wasFirst && wasLast ? { first_step: wasFirst.source_candidate_id, last_step: wasLast.source_candidate_id } : null,
        },
        label,
      );
      setDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message.toLocaleLowerCase() : 'could not save the phase.');
    } finally {
      setSaving(false);
    }
  }

  function save() {
    if (!draft || !draft.name.trim()) return;
    const name = draft.name.trim();
    const stretch = stepsLabel({ first_step_index: draft.from, last_step_index: draft.to });
    const label = !draft.phase
      ? `named ${stretch} ${name}`
      : draft.phase.name === name
        ? `changed the phase ${name} to ${stretch}`
        : `renamed the phase ${draft.phase.name} to ${name}, ${stretch}`;
    void send(name, label, draft.phase);
  }

  function remove() {
    if (!draft?.phase) return;
    const phase = draft.phase;
    const first = steps.find((step) => step.step_id === phase.first_step_id);
    const last = steps.find((step) => step.step_id === phase.last_step_id);
    if (!first || !last) return;
    // the stretch the phase has, whatever the draft says now
    setDraft({ ...draft, from: first.step_index, to: last.step_index });
    void (async () => {
      setSaving(true);
      setError('');
      try {
        await onSet({ name: '', first_step: first.source_candidate_id, last_step: last.source_candidate_id }, `took the phase ${phase.name} away`);
        setDraft(null);
      } catch (removeError) {
        setError(removeError instanceof Error ? removeError.message.toLocaleLowerCase() : 'could not remove the phase.');
      } finally {
        setSaving(false);
      }
    })();
  }

  // Other phases the draft would take steps from, so that is said before it happens.
  const takenFrom = draft
    ? phases.filter((phase) => phase !== draft.phase && phase.first_step_index <= draft.to && phase.last_step_index >= draft.from)
    : [];
  const option = (index: number) => {
    const step = byIndex.get(index);
    return (
      <option key={index} value={index}>
        {step ? `${index}, at ${formatPathwayTime(step.timestamp_ms)}` : index}
      </option>
    );
  };
  const indexes = steps.map((step) => step.step_index);

  return (
    <div
      aria-label="phases of the walkthrough"
      className="pathway-phases"
      ref={ref}
      role="dialog"
      style={{ left: place.left, top: place.top }}
    >
      <div className="pathway-phases-head">
        <span>phases</span>
        <button aria-label="close the phases" className="pathway-phases-close" onClick={onClose} type="button">
          ×
        </button>
      </div>
      <p className="pathway-phases-hint">named stretches of steps, such as sign up: drawn over the boxes, and in the export.</p>
      <div className="pathway-phase-list">
        {phases.map((phase) => (
          <button
            aria-pressed={draft?.phase === phase}
            className={`pathway-chip ${draft?.phase === phase ? 'is-on' : ''}`}
            disabled={disabled || saving}
            key={`${phase.first_step_id}-${phase.name}`}
            onClick={() => start(phase)}
            title={`${phase.name}: ${phase.step_count} ${phase.step_count === 1 ? 'step' : 'steps'} on ${phase.screen_count} ${phase.screen_count === 1 ? 'screen' : 'screens'}; click to change it`}
            type="button"
          >
            <span className="pathway-chip-name">{phase.name}</span>
            <span className="pathway-chip-steps">{stepsLabel(phase)}</span>
          </button>
        ))}
        {draft?.phase === null ? null : (
          <button className="pathway-tool" disabled={disabled || saving} onClick={() => start(null)} type="button">
            + add a phase
          </button>
        )}
      </div>
      {draft ? (
        <form
          className="pathway-phase-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="pathway-phase-row">
            <span>name</span>
            <input
              autoFocus
              className="pathway-tool-title"
              disabled={saving}
              maxLength={80}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="sign up"
              value={draft.name}
            />
          </label>
          <div className="pathway-phase-row">
            <span>steps</span>
            <select
              aria-label="first step"
              className="pathway-tool-select"
              disabled={saving}
              onChange={(event) => {
                const from = Number(event.target.value);
                setDraft({ ...draft, from, to: Math.max(from, draft.to) });
              }}
              value={draft.from}
            >
              {indexes.map(option)}
            </select>
            <span className="pathway-phase-to">to</span>
            <select aria-label="last step" className="pathway-tool-select" disabled={saving} onChange={(event) => setDraft({ ...draft, to: Number(event.target.value) })} value={draft.to}>
              {indexes.filter((index) => index >= draft.from).map(option)}
            </select>
          </div>
          {takenFrom.length ? <p className="pathway-phases-hint">this takes steps from {takenFrom.map((phase) => phase.name).join(' and ')}.</p> : null}
          <div className="pathway-phase-actions">
            {draft.phase ? (
              <button className="pathway-tool is-danger" disabled={saving} onClick={remove} type="button">
                remove
              </button>
            ) : null}
            <button className="pathway-tool" disabled={saving} onClick={() => setDraft(null)} type="button">
              cancel
            </button>
            <button className="analysis-pill success" disabled={saving || disabled || !draft.name.trim()} type="submit">
              {draft.phase ? 'save' : 'add'}
            </button>
          </div>
        </form>
      ) : null}
      {error ? <p className="pathway-phases-hint is-error">{error}</p> : null}
    </div>
  );
}
