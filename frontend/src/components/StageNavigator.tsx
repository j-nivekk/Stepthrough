import { Fragment, useState } from 'react';
import type { WorkflowStage } from '../lib/workflow';
import { workflowStages } from '../lib/workflow';

export interface StageNavigatorProps {
  activeStage: WorkflowStage;
  className?: string;
  disabledReasons?: Partial<Record<WorkflowStage, string>>;
  disabledStages?: Partial<Record<WorkflowStage, boolean>>;
  onNavigate: (stage: WorkflowStage) => void;
  stageLabels?: Partial<Record<WorkflowStage, string>>;
}

export function StageNavigator({
  activeStage,
  className,
  disabledReasons,
  disabledStages,
  onNavigate,
  stageLabels,
}: StageNavigatorProps) {
  const [expanded, setExpanded] = useState(false);

  const activeIndex = workflowStages.indexOf(activeStage);
  const stagesBefore = workflowStages.slice(0, activeIndex);
  const stagesAfter = workflowStages.slice(activeIndex + 1);

  const getLabel = (stage: WorkflowStage) => stageLabels?.[stage] ?? stage;

  function renderStageBtn(stage: WorkflowStage) {
    const disabled = Boolean(disabledStages?.[stage]);
    return (
      <button
        className="stage-pill-btn"
        disabled={disabled}
        onClick={() => onNavigate(stage)}
        title={disabled ? disabledReasons?.[stage] : undefined}
        type="button"
      >
        {getLabel(stage)}
      </button>
    );
  }

  return (
    <nav
      className={`stage-pill${expanded ? ' stage-pill--expanded' : ''}${className ? ` ${className}` : ''}`}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setExpanded(false); }}
      onFocus={() => setExpanded(true)}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      <span aria-hidden="true" className="stage-pill-dot" />

      {stagesBefore.length > 0 && (
        <span className="stage-pill-extra">
          <span className="stage-pill-extra-inner">
            {stagesBefore.map((stage, i) => (
              <Fragment key={stage}>
                {i > 0 && <span aria-hidden="true" className="stage-pill-sep">·</span>}
                {renderStageBtn(stage)}
              </Fragment>
            ))}
            <span aria-hidden="true" className="stage-pill-sep">·</span>
          </span>
        </span>
      )}

      <button aria-current="step" className="stage-pill-btn stage-pill-btn--active" disabled type="button">
        {getLabel(activeStage)}
      </button>

      {stagesAfter.length > 0 && (
        <span className="stage-pill-extra">
          <span className="stage-pill-extra-inner">
            <span aria-hidden="true" className="stage-pill-sep">·</span>
            {stagesAfter.map((stage, i) => (
              <Fragment key={stage}>
                {i > 0 && <span aria-hidden="true" className="stage-pill-sep">·</span>}
                {renderStageBtn(stage)}
              </Fragment>
            ))}
          </span>
        </span>
      )}
    </nav>
  );
}
