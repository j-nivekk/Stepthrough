import type { WorkflowStage } from '../lib/workflow';
import { workflowStages } from '../lib/workflow';

export interface StageNavigatorProps {
  activeStage: WorkflowStage;
  className?: string;
  disabledReasons?: Partial<Record<WorkflowStage, string>>;
  disabledStages?: Partial<Record<WorkflowStage, boolean>>;
  onNavigate: (stage: WorkflowStage) => void;
}

export function StageNavigator({
  activeStage,
  className,
  disabledReasons,
  disabledStages,
  onNavigate,
}: StageNavigatorProps) {
  return (
    <div className={className ? `stage-nav ${className}` : 'stage-nav'}>
      {workflowStages.map((stage) => {
        const isDisabledByCondition = stage !== activeStage && Boolean(disabledStages?.[stage]);
        return (
          <button
            aria-current={stage === activeStage ? 'step' : undefined}
            className={`stage-nav-button ${stage === activeStage ? 'active' : ''}`}
            disabled={stage === activeStage || Boolean(disabledStages?.[stage])}
            key={stage}
            onClick={() => onNavigate(stage)}
            title={isDisabledByCondition ? disabledReasons?.[stage] : undefined}
            type="button"
          >
            {stage}
          </button>
        );
      })}
    </div>
  );
}
