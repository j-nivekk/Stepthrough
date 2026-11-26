import { useMemo, useState } from 'react';
import { EditableName } from '../../components/EditableName';
import { StageNavigator } from '../../components/StageNavigator';
import { formatProjectSummary } from '../../lib/formatters';
import { projectImportsElsewhere } from '../../lib/live';
import { deletionDate, deletionIsNear, deletionLine } from '../../lib/visitors';
import { useLive } from '../live/LiveProvider';
import type { Project } from '../../types';
import type { ProjectEntryTarget, WorkflowStage } from '../../lib/workflow';

/** A project file on its way in from this page, to become a project of its own (App keeps it). */
export interface ProjectFileUpload {
  name: string;
  status: 'uploading' | 'error';
  /** Share sent, 0 to 1. */
  progress: number | null;
  error: string | null;
}

export interface EntryScreenProps {
  /** About the logged-in account, such as its coming deletion. */
  accountNotice?: string | null;
  appError: string;
  deletingProjectId?: string | null;
  healthMessage: string | null;
  isCreating: boolean;
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onDeleteProject: (projectId: string, projectName: string) => void;
  /** The whole project as one file, videos included, to keep it or bring it back later with import. */
  onDownloadProject: (projectId: string) => void;
  /** Bring a project back from its file, as a project of its own. */
  onImportProjectFile: (file: File) => void;
  onCancelProjectFileUpload: () => void;
  onDismissProjectFileUpload: () => void;
  projectFileUpload: ProjectFileUpload | null;
  onNavigateStage: (stage: WorkflowStage) => void;
  onOpenProject: (projectId: string, targetStage: ProjectEntryTarget) => void;
  onProjectNameChange: (value: string) => void;
  onProjectSearchChange: (value: string) => void;
  onProjectSortChange: (sort: 'name' | 'recent') => void;
  onRenameProject: (projectId: string, name: string, previousName: string) => Promise<void>;
  projectName: string;
  projectSearch: string;
  projectSort: 'name' | 'recent';
  projects: Project[];
  projectsLoading: boolean;
  projectsStatusMessage: string | null;
  ocrStatusMessage: string | null;
  selectedProjectCanJumpToAnalysis: boolean;
  selectedProjectId: string | null;
}

/** Where a click on a project leads: its analysis once it has videos, the import page while it has none. */
function entryTarget(project: Project): ProjectEntryTarget {
  return project.recording_count > 0 ? 'analysis' : 'import';
}

export function EntryScreen({
  accountNotice,
  appError,
  deletingProjectId,
  healthMessage,
  isCreating,
  onCreate,
  onDeleteProject,
  onDownloadProject,
  onImportProjectFile,
  onCancelProjectFileUpload,
  onDismissProjectFileUpload,
  projectFileUpload,
  onNavigateStage,
  onOpenProject,
  onProjectNameChange,
  onProjectSearchChange,
  onProjectSortChange,
  onRenameProject,
  projectName,
  projectSearch,
  projectSort,
  projects,
  projectsLoading,
  projectsStatusMessage,
  ocrStatusMessage,
  selectedProjectCanJumpToAnalysis,
  selectedProjectId,
}: EntryScreenProps) {
  // In a shared account: project files another browser is bringing in from its list of projects.
  const live = useLive();
  const importsElsewhere = projectImportsElsewhere(live.presence, live.clientId);
  // "or import a project": a dropzone for a project file, open while it is wanted or a file is on its way
  const [importOpen, setImportOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const showImport = importOpen || Boolean(projectFileUpload);
  const uploading = projectFileUpload?.status === 'uploading';
  const percent = Math.round((projectFileUpload?.progress ?? 0) * 100);
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
        <div className="entry-stage-nav">
          <StageNavigator
            activeStage="projects"
            disabledReasons={{
              analysis: !selectedProjectId
                ? 'open a project first'
                : !selectedProjectCanJumpToAnalysis
                  ? 'import at least one video first'
                  : undefined,
              import: !selectedProjectId ? 'open a project first' : undefined,
            }}
            disabledStages={{
              analysis: !selectedProjectId || !selectedProjectCanJumpToAnalysis,
              import: !selectedProjectId,
            }}
            onNavigate={onNavigateStage}
          />
        </div>

        <div className="entry-stage">
          {(accountNotice ||
            healthMessage ||
            ocrStatusMessage ||
            appError) && (
            <div className="entry-notices">
              {accountNotice && <p className="entry-notice warning">{accountNotice}</p>}
              {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
              {ocrStatusMessage && <p className="entry-notice warning">{ocrStatusMessage}</p>}
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

          <div className="entry-side">
            <p className="entry-helper-copy">or select an existing project...</p>
            <button
              aria-expanded={showImport}
              className="entry-helper-copy entry-helper-link"
              onClick={() => setImportOpen((open) => !open)}
              type="button"
            >
              or import a project...
            </button>
            {showImport ? (
              <label
                className={`import-dropzone entry-project-dropzone ${uploading ? 'disabled' : ''} ${dragging ? 'dragging' : ''}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  const [file] = Array.from(event.dataTransfer.files);
                  if (file && !uploading) onImportProjectFile(file);
                }}
              >
                <input
                  accept=".zip,application/zip"
                  aria-label="choose a project file"
                  disabled={uploading}
                  onChange={(event) => {
                    const [file] = Array.from(event.target.files ?? []);
                    if (file) onImportProjectFile(file);
                    event.target.value = '';
                  }}
                  type="file"
                />
                <span>drop a project file here,</span>
                <span>or click to choose it.</span>
                <span className="import-dropzone-note">.stepthrough.zip</span>
              </label>
            ) : null}
            {importsElsewhere.map((upload) => (
              <div className="entry-project-upload" key={upload.key}>
                <span className="import-row-title">{upload.name}</span>
                <span className="live-pill">
                  importing in another browser{upload.progress !== null ? ` ${Math.round(upload.progress * 100)}%` : ''}
                </span>
              </div>
            ))}
            {projectFileUpload ? (
              <div className={`entry-project-upload ${projectFileUpload.status}`}>
                <span className="import-row-title">{projectFileUpload.name}</span>
                {uploading ? (
                  <div className="entry-project-upload-progress">
                    <span
                      aria-label={`uploading, ${percent} percent`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={percent}
                      className="import-progress"
                      role="progressbar"
                    >
                      <span className="import-progress-fill" style={{ width: `${percent}%` }} />
                      <span className="import-progress-label">{percent >= 100 ? 'unpacking…' : `uploading ${percent}%`}</span>
                    </span>
                    <button className="analysis-task-link subtle" onClick={onCancelProjectFileUpload} type="button">
                      cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="import-row-note error">{projectFileUpload.error}</p>
                    <button className="analysis-task-link subtle" onClick={onDismissProjectFileUpload} type="button">
                      dismiss
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>

          <div className="entry-project-browser">
            <div className="entry-project-tools">
              <input
                className="entry-project-search"
                onChange={(event) => onProjectSearchChange(event.target.value)}
                placeholder="search projects"
                value={projectSearch}
              />
              <div className="entry-project-sort">
                <button
                  className={`entry-project-sort-button ${projectSort === 'recent' ? 'active' : ''}`}
                  onClick={() => onProjectSortChange('recent')}
                  type="button"
                >
                  recent
                </button>
                <button
                  className={`entry-project-sort-button ${projectSort === 'name' ? 'active' : ''}`}
                  onClick={() => onProjectSortChange('name')}
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
                        onDisplayClick={() => onOpenProject(project.id, entryTarget(project))}
                        onSave={(nextValue, previousValue) => onRenameProject(project.id, nextValue, previousValue)}
                        renameLabel={`rename project ${project.name}`}
                        textClassName="entry-project-name-text"
                        value={project.name}
                      />
                      <button
                        className="entry-project-summary-button"
                        onClick={() => onOpenProject(project.id, entryTarget(project))}
                        type="button"
                      >
                        <small>{formatProjectSummary(project)}</small>
                      </button>
                      {project.deletes_at ? (
                        <small
                          className={`entry-project-deletion ${deletionIsNear(project.deletes_at) ? 'is-near' : ''}`}
                          title={deletionDate(project.deletes_at)}
                        >
                          {deletionLine(project.deletes_at)}
                        </small>
                      ) : null}
                    </div>
                    <div className="entry-project-actions">
                      <button
                        className="analysis-task-link subtle entry-project-action-pill"
                        onClick={() => onOpenProject(project.id, 'import')}
                        type="button"
                      >
                        import
                      </button>
                      {project.recording_count > 0 ? (
                        <button
                          className="analysis-task-link subtle entry-project-action-pill"
                          onClick={() => onOpenProject(project.id, 'analysis')}
                          type="button"
                        >
                          analysis
                        </button>
                      ) : null}
                      {project.recording_count > 0 ? (
                        <button
                          className="analysis-task-link subtle entry-project-action-pill"
                          onClick={() => onDownloadProject(project.id)}
                          title="the whole project as one file, videos included"
                          type="button"
                        >
                          download
                        </button>
                      ) : null}
                      <button
                        className="analysis-task-link danger entry-project-action-pill"
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
              {projectsStatusMessage && <p className="entry-empty-copy">{projectsStatusMessage}</p>}
              {!projectsStatusMessage && !projects.length && !projectsLoading && (
                <p className="entry-empty-copy">no existing projects yet.</p>
              )}
              {Boolean(projects.length) && !visibleProjects.length && !projectsLoading && (
                <p className="entry-empty-copy">no projects match that search.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
