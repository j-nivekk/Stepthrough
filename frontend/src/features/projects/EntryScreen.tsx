import { useMemo, useState } from 'react';
import { EditableName } from '../../components/EditableName';
import { StageNavigator } from '../../components/StageNavigator';
import { formatProjectSummary } from '../../lib/formatters';
import type { Project } from '../../types';
import type { ProjectEntryTarget, WorkflowStage } from '../../lib/workflow';

export interface EntryScreenProps {
  appError: string;
  deletingProjectId?: string | null;
  healthMessage: string | null;
  isCreating: boolean;
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onDeleteProject: (projectId: string, projectName: string) => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onOpenProject: (projectId: string, targetStage: ProjectEntryTarget) => void;
  onProjectNameChange: (value: string) => void;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  projectName: string;
  projects: Project[];
  projectsLoading: boolean;
  selectedProjectCanJumpToAnalysis: boolean;
  selectedProjectId: string | null;
}

export function EntryScreen({
  appError,
  deletingProjectId,
  healthMessage,
  isCreating,
  onCreate,
  onDeleteProject,
  onNavigateStage,
  onOpenProject,
  onProjectNameChange,
  onRenameProject,
  projectName,
  projects,
  projectsLoading,
  selectedProjectCanJumpToAnalysis,
  selectedProjectId,
}: EntryScreenProps) {
  const [projectSearch, setProjectSearch] = useState('');
  const [projectSort, setProjectSort] = useState<'name' | 'recent'>('recent');
  const visibleProjects = useMemo(() => {
    const searchValue = projectSearch.trim().toLowerCase();
    const filteredProjects = projects.filter((project) => project.name.toLowerCase().includes(searchValue));

    return filteredProjects.sort((left, right) => {
      if (projectSort === 'name') {
        return left.name.localeCompare(right.name);
      }
      const activityDelta =
        new Date(right.last_activity_at).getTime() - new Date(left.last_activity_at).getTime();
      if (activityDelta !== 0) {
        return activityDelta;
      }
      return left.name.localeCompare(right.name);
    });
  }, [projectSearch, projectSort, projects]);

  return (
    <div className="entry-screen">
      <div className="entry-shell">
        <StageNavigator
          activeStage="projects"
          className="entry-stage-nav"
          disabledStages={{
            analysis: !selectedProjectId || !selectedProjectCanJumpToAnalysis,
            import: !selectedProjectId,
          }}
          onNavigate={onNavigateStage}
        />

        <div className="entry-stage">
          {(healthMessage || appError) && (
            <div className="entry-notices">
              {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
              {appError && <p className="entry-notice error">{appError}</p>}
            </div>
          )}

          <form className="entry-create-form" onSubmit={onCreate}>
            <input
              className="entry-project-input"
              onChange={(event) => onProjectNameChange(event.target.value)}
              placeholder="create a project"
              value={projectName}
            />
            <button className="entry-enter-button" disabled={!projectName.trim() || isCreating} type="submit">
              {isCreating ? 'entering…' : 'enter'}
            </button>
          </form>

          <p className="entry-helper-copy">or select an existing project...</p>

          <div className="entry-project-browser">
            <div className="entry-project-tools">
              <input
                className="entry-project-search"
                onChange={(event) => setProjectSearch(event.target.value)}
                placeholder="search projects"
                value={projectSearch}
              />
              <div className="entry-project-sort">
                <button
                  className={`entry-project-sort-button ${projectSort === 'recent' ? 'active' : ''}`}
                  onClick={() => setProjectSort('recent')}
                  type="button"
                >
                  recent
                </button>
                <button
                  className={`entry-project-sort-button ${projectSort === 'name' ? 'active' : ''}`}
                  onClick={() => setProjectSort('name')}
                  type="button"
                >
                  a-z
                </button>
              </div>
            </div>

            <div className="entry-project-list">
              {visibleProjects.map((project) => (
                <div
                  className={`entry-project-row-shell ${project.id === selectedProjectId ? 'selected' : ''}`}
                  key={project.id}
                >
                  <div className="entry-project-row">
                    <div className="entry-project-row-copy">
                      <EditableName
                        buttonClassName="entry-rename-button"
                        containerClassName="entry-project-name"
                        displayButtonClassName="entry-project-select-button"
                        onDisplayClick={() => onOpenProject(project.id, 'import')}
                        onSave={(nextValue) => onRenameProject(project.id, nextValue)}
                        renameLabel={`Rename project ${project.name}`}
                        textClassName="entry-project-name-text"
                        value={project.name}
                      />
                      <button
                        className="entry-project-summary-button"
                        onClick={() => onOpenProject(project.id, 'import')}
                        type="button"
                      >
                        <small>{formatProjectSummary(project)}</small>
                      </button>
                    </div>
                    <div className="entry-project-actions">
                      <button
                        className="analysis-pill success entry-project-action-pill"
                        onClick={() => onOpenProject(project.id, 'import')}
                        type="button"
                      >
                        import
                      </button>
                      {project.recording_count > 0 ? (
                        <button
                          className="analysis-pill analysis-pill-accent entry-project-action-pill"
                          onClick={() => onOpenProject(project.id, 'analysis')}
                          type="button"
                        >
                          analysis
                        </button>
                      ) : null}
                      <button
                        className="analysis-pill danger entry-project-action-pill"
                        disabled={deletingProjectId === project.id}
                        onClick={() => onDeleteProject(project.id, project.name)}
                        type="button"
                      >
                        {deletingProjectId === project.id ? 'deleting…' : 'delete'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {!projects.length && !projectsLoading && <p className="entry-empty-copy">No existing projects yet.</p>}
              {Boolean(projects.length) && !visibleProjects.length && !projectsLoading && (
                <p className="entry-empty-copy">No projects match that search.</p>
              )}
              {projectsLoading && <p className="entry-empty-copy">Loading projects…</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
