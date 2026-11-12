import { useEffect, useMemo, useState } from 'react';

import { isPopupStep, popupChange, ScreenChoice } from '../../components/ScreenChoice';
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
}

/**
 * Changes to one box of the pathway: its title, whether it is a pop-up, and where its steps belong. Every
 * change is stored on a step (its title, its screen choice), so the step review shows the same.
 */
export function PathwayBoxEditor({ pathway, candidates, selected, onSelect, onUpdateCandidate }: PathwayBoxEditorProps) {
  const steps = useMemo(() => new Map(pathway.steps.map((step) => [step.step_id, step])), [pathway]);
  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates]);
  const firstCandidateId = (screen: PathwayScreen): string => steps.get(screen.image_step_id)?.source_candidate_id ?? '';

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
      <select onChange={(event) => onSelect(event.target.value || null)} value={selected ? firstCandidateId(selected) : ''}>
        <option value="">{selected ? 'none' : 'choose a screen…'}</option>
        {pathway.screens.map((screen) => (
          <option key={screen.id} value={firstCandidateId(screen)}>
            {screen.index} · {screen.title}
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
          or click one in the chart, to rename it, mark it as a pop-up or move its steps to another box
        </span>
      </div>
    );
  }

  const first = byId.get(firstCandidateId(selected));
  const boxSteps = selected.visits.flatMap((visit) => visit.step_ids).map((id) => steps.get(id));
  const others = pathway.screens.filter((screen) => screen.id !== selected.id);

  function commitTitle(value: string) {
    const next = value.trim();
    if (titleCandidateId && next !== savedTitle) onUpdateCandidate(titleCandidateId, { title: next });
  }

  return (
    <div className="pathway-editor">
      {pick}
      <label className="pathway-editor-field">
        <span>title</span>
        <input
          className="candidate-field pathway-editor-title"
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
        <span>steps and where they belong</span>
        <div className="pathway-editor-steps">
          {boxSteps.map((step) => {
            const candidate = step ? byId.get(step.source_candidate_id) : undefined;
            if (!step || !candidate) return null;
            return (
              <span className="pathway-editor-step" key={step.step_id} title={`step ${step.step_index} at ${formatPathwayTime(step.timestamp_ms)}`}>
                <b>{step.step_index}</b>
                <ScreenChoice anyStep candidate={candidate} hidePopup onUpdate={(changes) => onUpdateCandidate(candidate.id, changes)} steps={candidates} />
              </span>
            );
          })}
        </div>
      </div>
      {others.length > 0 && first ? (
        <label className="pathway-editor-field">
          <span>merge into</span>
          <select
            onChange={(event) => {
              if (event.target.value) onUpdateCandidate(first.id, { screen_link: event.target.value });
            }}
            value=""
          >
            <option value="">another screen…</option>
            {others.map((screen) => (
              <option key={screen.id} value={firstCandidateId(screen)}>
                {screen.index} · {screen.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button className="analysis-task-link subtle pathway-editor-done" onClick={() => onSelect(null)} type="button">
        done
      </button>
    </div>
  );
}
