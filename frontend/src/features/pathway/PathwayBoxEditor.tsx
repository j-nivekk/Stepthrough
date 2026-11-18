import { useEffect, useMemo, useState } from 'react';

import { isPopupStep, popupChange, ScreenChoice, type PathwayPlaces } from '../../components/ScreenChoice';
import { formatPathwayTime } from '../../lib/pathwayFigure';
import type { CandidateChanges, CandidateFrame, Pathway, PathwayScreen } from '../../types';

interface PathwayBoxEditorProps {
  pathway: Pathway;
  /** Every step of the run, in order. */
  candidates: CandidateFrame[];
  selected: PathwayScreen | null;
  /** Select the box that holds this step, or none. */
  onSelect: (candidateId: string | null) => void;
  onUpdateCandidate: (candidateId: string, changes: CandidateChanges) => void;
  onMerge: (sourceId: string, targetId: string) => void;
  disabled: boolean;
}

/**
 * Changes to one box of the pathway: its title, whether it is a pop-up, and where its steps belong. Every
 * change is stored on a step (its title, its screen choice), so the step review shows the same.
 */
export function PathwayBoxEditor({ pathway, candidates, selected, onSelect, onUpdateCandidate, onMerge, disabled }: PathwayBoxEditorProps) {
  const steps = useMemo(() => new Map(pathway.steps.map((step) => [step.step_id, step])), [pathway]);
  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates]);
  const firstCandidateId = (screen: PathwayScreen): string => steps.get(screen.image_step_id)?.source_candidate_id ?? '';

  // A box is named with its steps, as "Screen 4 (step 6)", so its number is never taken for a step's.
  const stepNumbers = (screen: PathwayScreen): number[] =>
    screen.visits.flatMap((visit) => visit.step_ids).map((id) => steps.get(id)?.step_index ?? 0).filter(Boolean);
  const listed = (numbers: number[]): string =>
    numbers.length < 2 ? String(numbers[0] ?? '') : `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
  const screenName = (screen: PathwayScreen): string =>
    screen.title === `Screen ${screen.index}` ? `Screen ${screen.index}` : `Screen ${screen.index}, ${screen.title}`;
  const screenOption = (screen: PathwayScreen): string => {
    const numbers = stepNumbers(screen);
    return `${screenName(screen)} (${numbers.length === 1 ? 'step' : 'steps'} ${listed(numbers)})`;
  };
  const places = useMemo(() => {
    const number = new Map<string, number>();
    const box = new Map<string, string>();
    for (const step of pathway.steps) number.set(step.source_candidate_id, step.step_index);
    for (const screen of pathway.screens) {
      for (const id of screen.visits.flatMap((visit) => visit.step_ids)) {
        const candidateId = steps.get(id)?.source_candidate_id;
        if (candidateId) box.set(candidateId, `Screen ${screen.index}`);
      }
    }
    return { number, box };
  }, [pathway, steps]);

  // A box takes the title of its first step that has one, so renaming it renames that step (or its first step).
  const titleCandidateId = selected ? steps.get(selected.title_step_id ?? selected.image_step_id)?.source_candidate_id : undefined;
  const savedTitle = selected?.title_step_id ? selected.title : '';
  const [title, setTitle] = useState(savedTitle);
  useEffect(() => {
    setTitle(savedTitle);
  }, [selected?.id, savedTitle]);

  const pick = (
    <label className="pathway-editor-field">
      <span className={selected ? '' : 'sr-only'}>screen</span>
      <select disabled={disabled} onChange={(event) => onSelect(event.target.value || null)} value={selected ? firstCandidateId(selected) : ''}>
        <option value="">{selected ? 'none' : 'choose a screen…'}</option>
        {pathway.screens.map((screen) => (
          <option key={screen.id} value={firstCandidateId(screen)}>
            {screenOption(screen)}
          </option>
        ))}
      </select>
    </label>
  );

  if (!selected) {
    return (
      <div className="pathway-editor idle">
        {pick}
        <span className="candidate-view-note">
          or click one in the chart, to rename it, mark it as a pop-up or move its steps to another box. rest the
          pointer on a step number under a box to see that step
        </span>
      </div>
    );
  }

  const first = byId.get(firstCandidateId(selected));
  const boxSteps = selected.visits.flatMap((visit) => visit.step_ids).map((id) => steps.get(id));
  const others = pathway.screens.filter((screen) => screen.id !== selected.id);
  const ownNumbers = stepNumbers(selected);
  const inPathway: PathwayPlaces = { ...places, boxSize: ownNumbers.length };
  const mergeScope =
    ownNumbers.length === 1 ? `its one step, ${ownNumbers[0]}` : ownNumbers.length === 2 ? 'both steps together' : `all ${ownNumbers.length} steps together`;

  function commitTitle(value: string) {
    const next = value.trim();
    if (titleCandidateId && next !== savedTitle) onUpdateCandidate(titleCandidateId, { title: next });
  }

  return (
    <fieldset className="pathway-editor" disabled={disabled}>
      {pick}
      <label className="pathway-editor-field">
        <span>title</span>
        <input
          className="candidate-field pathway-editor-title"
          maxLength={240}
          onBlur={(event) => commitTitle(event.target.value)}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          placeholder={`Screen ${selected.index}`}
          value={title}
        />
      </label>
      {first ? (
        <label className="pathway-editor-check" title="a pop-up is drawn with a dashed frame">
          <input checked={isPopupStep(first)} onChange={(event) => onUpdateCandidate(first.id, popupChange(first, event.target.checked))} type="checkbox" />
          pop-up
        </label>
      ) : null}
      <div className="pathway-editor-field">
        <span>
          steps and where they belong <em className="pathway-editor-scope">each on its own</em>
        </span>
        <div className="pathway-editor-steps">
          {boxSteps.map((step) => {
            const candidate = step ? byId.get(step.source_candidate_id) : undefined;
            if (!step || !candidate) return null;
            return (
              <span className="pathway-editor-step" key={step.step_id} title={`step ${step.step_index} at ${formatPathwayTime(step.timestamp_ms)}`}>
                <b>{step.step_index}</b>
                <ScreenChoice
                  anyStep
                  candidate={candidate}
                  hidePopup
                  inPathway={inPathway}
                  onUpdate={(changes) => onUpdateCandidate(candidate.id, changes)}
                  steps={candidates}
                />
              </span>
            );
          })}
        </div>
      </div>
      {others.length > 0 && first ? (
        <label
          className="pathway-editor-field"
          title={`moves every step of this box (${listed(ownNumbers)}) into the screen you choose. to move one step, use its choice under steps and where they belong.`}
        >
          <span>
            merge into <em className="pathway-editor-scope">{mergeScope}</em>
          </span>
          <select
            onChange={(event) => {
              if (event.target.value) onMerge(first.id, event.target.value);
            }}
            value=""
          >
            <option value="">another screen…</option>
            {others.map((screen) => (
              <option key={screen.id} value={firstCandidateId(screen)}>
                {screenOption(screen)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button className="analysis-task-link subtle pathway-editor-done" onClick={() => onSelect(null)} type="button">
        done
      </button>
    </fieldset>
  );
}
