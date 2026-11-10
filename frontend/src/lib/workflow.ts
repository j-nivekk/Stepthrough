export type WorkflowStage = 'projects' | 'import' | 'analysis';
export type ProjectEntryTarget = Exclude<WorkflowStage, 'projects'>;

export const workflowStages: WorkflowStage[] = ['projects', 'import', 'analysis'];

export const workflowViewportMinimums: Record<WorkflowStage, { height: number; width: number }> = {
  projects: { width: 720, height: 640 },
  import: { width: 720, height: 640 },
  // Three columns stay usable down to here; shorter windows scroll. Smaller still, people may continue anyway.
  analysis: { width: 1024, height: 640 },
};
