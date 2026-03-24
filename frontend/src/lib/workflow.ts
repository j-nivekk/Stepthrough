export type WorkflowStage = 'projects' | 'import' | 'analysis';
export type ProjectEntryTarget = Exclude<WorkflowStage, 'projects'>;

export const workflowStages: WorkflowStage[] = ['projects', 'import', 'analysis'];

export const workflowViewportMinimums: Record<WorkflowStage, { height: number; width: number }> = {
  projects: { width: 720, height: 640 },
  import: { width: 720, height: 640 },
  analysis: { width: 1120, height: 760 },
};
