import { useState } from 'react';
import { EditableName } from '../../components/EditableName';
import { StageNavigator } from '../../components/StageNavigator';
import { formatProjectSummary } from '../../lib/formatters';
import type { ImportQueueItem } from '../../lib/importQueue';
import type { WorkflowStage } from '../../lib/workflow';
import type { Project } from '../../types';

export interface ImportScreenProps {
  appError: string;
  canComplete: boolean;
  healthMessage: string | null;
  isDeleting: boolean;
  isUploadBlocked: boolean;
  ocrStatusMessage: string | null;
  ocrStatusTone: 'info' | 'warning';
  ocrWarnings: string[];
  onDismissOcrWarnings: () => void;
  onDeleteRow: (localId: string) => void;
  onDone: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onRenameRow: (localId: string, filename: string) => Promise<void>;
  onUploadRow: (localId: string) => void;
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
  ocrStatusTone,
  ocrWarnings,
  onDismissOcrWarnings,
  onDeleteRow,
  onDone,
  onFilesSelected,
  onNavigateStage,
  onRenameProject,
  onRenameRow,
  onUploadRow,
  project,
  rows,
  selectionFeedback,
}: ImportScreenProps) {
  const [isDropzoneActive, setIsDropzoneActive] = useState(false);
  const uploadedCount = rows.filter((row) => row.status === 'uploaded').length;
  const queuedCount = rows.filter((row) => row.status !== 'uploaded').length;

  return (
    <div className="entry-screen import-screen">
      <div className="entry-shell import-shell">
        <StageNavigator activeStage="import" className="entry-stage-nav" onNavigate={onNavigateStage} />

        {(healthMessage || ocrStatusMessage || ocrWarnings.length > 0 || appError) && (
          <div className="entry-notices">
            {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
            {ocrStatusMessage && (
              <p className={ocrStatusTone === 'warning' ? 'entry-notice warning' : 'entry-notice'}>
                {ocrStatusMessage}
              </p>
            )}
            {ocrWarnings.length > 0 ? (
              <button className="entry-notice-dismiss" onClick={onDismissOcrWarnings} type="button">
                dismiss OCR details
              </button>
            ) : null}
            {ocrWarnings.map((warning) => (
              <p className="entry-notice diagnostic" key={warning}>
                OCR detail: {warning}
              </p>
            ))}
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
                  onSave={(nextValue) => onRenameProject(project.id, nextValue)}
                  renameLabel={`Rename project ${project.name}`}
                  textClassName="import-project-title"
                  value={project.name}
                />
              ) : (
                <p className="import-project-title">Loading project…</p>
              )}
              <p className="import-project-meta">
                {project ? formatProjectSummary(project) : 'Loading project details…'}
              </p>
            </div>
            <div className="import-header-actions">
              <button className="entry-enter-button import-done-button" disabled={!canComplete} onClick={onDone} type="button">
                done
              </button>
            </div>
          </div>

          <div className="import-section-head">
            <p className="import-section-title">import videos</p>
            <p className="import-status-copy">
              {uploadedCount} {uploadedCount === 1 ? 'video' : 'videos'} imported
              {queuedCount ? ` • ${queuedCount} queued` : ''}
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
              accept="video/*"
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
          </label>
          {selectionFeedback ? <p className="import-feedback-copy">{selectionFeedback}</p> : null}
          <p className="import-format-copy">supports .mp4, .mov, .m4v, .webm, and .mkv uploads</p>

          <div className="import-queue">
            {rows.map((row) => (
              <div className="import-row" key={row.localId}>
                <div className="import-row-copy">
                  <EditableName
                    buttonClassName="entry-rename-button"
                    containerClassName="import-row-name"
                    inputClassName="import-row-input"
                    lockedExtension
                    onSave={(nextValue) => onRenameRow(row.localId, nextValue)}
                    renameLabel={`Rename video ${row.filename}`}
                    textClassName="import-row-title"
                    value={row.filename}
                  />
                  {row.error && <p className="import-row-note error">{row.error}</p>}
                </div>
                <div className="import-row-actions">
                  {row.status === 'uploaded' ? (
                    <span className="import-pill neutral">uploaded</span>
                  ) : row.status === 'uploading' ? (
                    <span className="import-pill neutral muted">uploading...</span>
                  ) : (
                    <button
                      className="import-pill success"
                      disabled={isUploadBlocked}
                      onClick={() => onUploadRow(row.localId)}
                      type="button"
                    >
                      upload
                    </button>
                  )}
                  <button
                    className="import-pill danger import-delete-button"
                    disabled={isDeleting || row.status === 'uploading'}
                    onClick={() => onDeleteRow(row.localId)}
                    type="button"
                  >
                    delete
                  </button>
                </div>
              </div>
            ))}
            {!rows.length && (
              <p className="entry-empty-copy import-empty-copy">Selected and uploaded videos will appear here.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
