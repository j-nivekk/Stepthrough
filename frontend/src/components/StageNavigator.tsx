import type { WorkflowStage } from '../lib/workflow';
import { workflowStages } from '../lib/workflow';

export interface StageNavigatorProps {
  activeStage: WorkflowStage;
  className?: string;
  disabledStages?: Partial<Record<WorkflowStage, boolean>>;
  onNavigate: (stage: WorkflowStage) => void;
}

export function StageNavigator({
  activeStage,
  className,
  disabledStages,
  onNavigate,
}: StageNavigatorProps) {
  return (
    <div className={className ? `stage-nav ${className}` : 'stage-nav'}>
      {workflowStages.map((stage) => (
        <button
          aria-current={stage === activeStage ? 'step' : undefined}
          className={`stage-nav-button ${stage === activeStage ? 'active' : ''}`}
          disabled={stage === activeStage || Boolean(disabledStages?.[stage])}
          key={stage}
          onClick={() => onNavigate(stage)}
          type="button"
        >
          {stage}
        </button>
      ))}
    </div>
  );
}
