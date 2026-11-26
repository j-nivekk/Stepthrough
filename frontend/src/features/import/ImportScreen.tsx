import { useState } from 'react';
import { EditableName } from '../../components/EditableName';
import { StageNavigator } from '../../components/StageNavigator';
import { formatProjectSummary } from '../../lib/formatters';
import type { ImportQueueItem } from '../../lib/importQueue';
import { uploadsElsewhere } from '../../lib/live';
import type { WorkflowStage } from '../../lib/workflow';
import { useLive } from '../live/LiveProvider';
import type { Project } from '../../types';

export interface ImportScreenProps {
  appError: string;
  canComplete: boolean;
  healthMessage: string | null;
  isDeleting: boolean;
  isUploadBlocked: boolean;
  ocrStatusMessage: string | null;
  onDeleteRow: (localId: string) => void;
  onDone: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onRenameProject: (projectId: string, name: string, previousName: string) => Promise<void>;
  onRenameRow: (localId: string, filename: string, previousFilename: string) => Promise<void>;
  onRetryRow: (localId: string) => void;
  project: Project | null;
  rows: ImportQueueItem[];
  selectionFeedback: string;
}

export function ImportScreen({
  appError,
  canComplete,
  healthMessage,
  isDeleting,
  isUploadBlocked,
  ocrStatusMessage,
  onDeleteRow,
  onDone,
  onFilesSelected,
  onNavigateStage,
  onRenameProject,
  onRenameRow,
  onRetryRow,
  project,
  rows,
  selectionFeedback,
}: ImportScreenProps) {
  // In a shared account: videos another browser is uploading into this project.
  const live = useLive();
  const elsewhere = uploadsElsewhere(live.presence, project?.id ?? null, live.clientId);
  const [isDropzoneActive, setIsDropzoneActive] = useState(false);
  const uploadedCount = rows.filter((row) => row.status === 'uploaded').length;
  const onTheWay = rows.filter((row) => row.status === 'queued' || row.status === 'uploading').length;
  const failedCount = rows.filter((row) => row.status === 'error').length;

  return (
    <div className="entry-screen import-screen">
      <div className="entry-shell import-shell">
        <div className="entry-stage-nav">
          <StageNavigator activeStage="import" onNavigate={onNavigateStage} />
        </div>

        {(healthMessage || ocrStatusMessage || appError) && (
          <div className="entry-notices">
            {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
            {ocrStatusMessage && <p className="entry-notice warning">{ocrStatusMessage}</p>}
            {appError && <p className="entry-notice error">{appError}</p>}
          </div>
        )}

        <div className="import-stage">
          <div className="import-header">
            <div className="import-project-copy">
              {project ? (
                <EditableName
                  buttonClassName="entry-rename-button"
                  containerClassName="import-project-name"
                  onSave={(nextValue, previousValue) => onRenameProject(project.id, nextValue, previousValue)}
                  renameLabel={`rename project ${project.name}`}
                  textClassName="import-project-title"
                  value={project.name}
                />
              ) : (
                <p className="import-project-title">loading project…</p>
              )}
              <p className="import-project-meta">
                {project ? formatProjectSummary(project) : 'loading project details…'}
              </p>
            </div>
            <div className="import-header-actions">
              <button className="entry-enter-button import-done-button" disabled={!canComplete} onClick={onDone} type="button">
                done
              </button>
              {!canComplete ? (
                <p className="import-done-hint">add a video first</p>
              ) : onTheWay > 0 ? (
                <p className="import-done-hint">uploads carry on in the background</p>
              ) : null}
            </div>
          </div>

          <div className="import-section-head">
            <p className="import-section-title">import videos</p>
            <p className="import-status-copy">
              {uploadedCount} {uploadedCount === 1 ? 'video' : 'videos'} imported
              {onTheWay ? ` • ${onTheWay} uploading` : ''}
              {failedCount ? ` • ${failedCount} failed` : ''}
            </p>
          </div>

          <label
            className={`import-dropzone ${isUploadBlocked ? 'disabled' : ''} ${isDropzoneActive ? 'dragging' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDropzoneActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                return;
              }
              setIsDropzoneActive(false);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDropzoneActive(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDropzoneActive(false);
              onFilesSelected(event.dataTransfer.files);
            }}
          >
            <input
              accept="video/*,.zip"
              disabled={isUploadBlocked}
              multiple
              onChange={(event) => {
                if (event.target.files) {
                  onFilesSelected(event.target.files);
                }
                event.target.value = '';
              }}
              type="file"
            />
            <span>drag-and-drop your videos here,</span>
            <span>or click it to select your videos.</span>
            <span className="import-dropzone-note">they upload straight away, one after the other.</span>
          </label>
          {selectionFeedback ? <p className="import-feedback-copy">{selectionFeedback}</p> : null}
          <p className="import-format-copy">
            supports .mp4, .mov, .m4v, .webm, .mkv, and project files (.stepthrough.zip), whose videos join this project
            with their runs.
          </p>

          <div className="import-queue">
            {rows.map((row) => (
              <div className={`import-row ${row.status}`} key={row.localId}>
                <div className="import-row-copy">
                  <EditableName
                    buttonClassName="entry-rename-button"
                    containerClassName="import-row-name"
                    disabled={row.status === 'uploading'}
                    inputClassName="import-row-input"
                    lockedExtension
                    onSave={(nextValue, previousValue) => onRenameRow(row.localId, nextValue, previousValue)}
                    renameLabel={`rename video ${row.filename}`}
                    textClassName="import-row-title"
                    value={row.filename}
                  />
                  {row.error && <p className="import-row-note error">{row.error}</p>}
                </div>
                <div className="import-row-actions">
                  <span className="import-row-status">
                    {row.status === 'uploaded' ? (
                      <span className="import-pill neutral">uploaded</span>
                    ) : row.status === 'uploading' ? (
                      <span
                        aria-label={`uploading, ${Math.round((row.progress ?? 0) * 100)} percent`}
                        className="import-progress"
                        role="progressbar"
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={Math.round((row.progress ?? 0) * 100)}
                      >
                        <span className="import-progress-fill" style={{ width: `${Math.round((row.progress ?? 0) * 100)}%` }} />
                        <span className="import-progress-label">
                          {(row.progress ?? 0) >= 1 ? 'processing…' : `uploading ${Math.round((row.progress ?? 0) * 100)}%`}
                        </span>
                      </span>
                    ) : row.status === 'queued' ? (
                      <span className="import-pill neutral muted">waiting</span>
                    ) : (
                      <button
                        className="analysis-task-link subtle"
                        disabled={isUploadBlocked}
                        onClick={() => onRetryRow(row.localId)}
                        type="button"
                      >
                        retry
                      </button>
                    )}
                  </span>
                  <button
                    className="analysis-task-link danger import-delete-button"
                    disabled={row.status === 'uploaded' && isDeleting}
                    onClick={() => onDeleteRow(row.localId)}
                    title={
                      row.status === 'uploaded'
                        ? 'delete this video and everything made from it'
                        : row.status === 'error'
                          ? 'take this video off the list'
                          : 'stop this upload'
                    }
                    type="button"
                  >
                    {row.status === 'uploaded' ? 'delete' : row.status === 'error' ? 'remove' : 'cancel'}
                  </button>
                </div>
              </div>
            ))}
            {elsewhere.map((upload) => (
              <div className="import-row live-row" key={upload.key}>
                <div className="import-row-copy">
                  <span className="import-row-title">{upload.name}</span>
                </div>
                <div className="import-row-actions">
                  <span className="import-row-status">
                    <span className="live-pill">
                      uploading in another browser{upload.progress !== null ? ` ${Math.round(upload.progress * 100)}%` : ''}
                    </span>
                  </span>
                </div>
              </div>
            ))}
            {!rows.length && !elsewhere.length && (
              <p className="entry-empty-copy import-empty-copy">selected and uploaded videos will appear here.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
