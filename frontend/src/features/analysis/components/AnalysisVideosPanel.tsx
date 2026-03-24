import { EditableName } from '../../../components/EditableName';
import { formatRecordingContextBadge } from '../../../lib/formatters';
import type { RecordingSummary } from '../../../types';

export interface AnalysisVideosPanelProps {
  onDeleteRecording: (recordingId: string, filename: string) => void;
  onJumpToSelection: () => void;
  onPreviewRecording: (recordingId: string) => void;
  onRenameRecording: (recordingId: string, filename: string) => Promise<void>;
  onRequestRename: (recordingId: string) => void;
  onSelectRecording: (recordingId: string) => void;
  previewRecording: RecordingSummary | null;
  recordings: RecordingSummary[];
  recordingsLoading: boolean;
  selectedRecordingId: string | null;
  videoRenameRequest: { id: string; nonce: number } | null;
}

export function AnalysisVideosPanel({
  onDeleteRecording,
  onJumpToSelection,
  onPreviewRecording,
  onRenameRecording,
  onRequestRename,
  onSelectRecording,
  previewRecording,
  recordings,
  recordingsLoading,
  selectedRecordingId,
  videoRenameRequest,
}: AnalysisVideosPanelProps) {
  return (
    <section className="analysis-column">
      <div className="analysis-column-head">
        <p>videos</p>
        <button className="analysis-pill analysis-pill-accent" onClick={onJumpToSelection} type="button">
          jump to selection
        </button>
      </div>
      <div className="analysis-divider" />
      <div className="analysis-videos">
        {recordings.map((recording) => {
          const isSelected = recording.id === selectedRecordingId;
          const isPreviewing = previewRecording?.id === recording.id;
          return (
            <div
              className={`analysis-video-row ${isSelected ? 'selected' : ''} ${isPreviewing ? 'previewing' : ''}`}
              key={recording.id}
            >
              <div className="analysis-video-row-button">
                <EditableName
                  containerClassName="analysis-video-name"
                  displayButtonClassName="analysis-video-select-button"
                  editRequestToken={videoRenameRequest?.id === recording.id ? videoRenameRequest.nonce : null}
                  lockedExtension
                  onDisplayClick={() => onSelectRecording(recording.id)}
                  onSave={(nextValue) => onRenameRecording(recording.id, nextValue)}
                  renameLabel={`Rename video ${recording.filename}`}
                  showRenameButton={false}
                  textClassName="analysis-video-name-text"
                  value={recording.filename}
                />
                <div className="analysis-video-meta">
                  <span className="analysis-video-duration">{recording.duration_tc}</span>
                  <span className="analysis-video-context-badge">{formatRecordingContextBadge(recording)}</span>
                </div>
              </div>
              <div className="analysis-video-actions">
                <button
                  className="analysis-task-link subtle analysis-video-hover-link"
                  onClick={() => onRequestRename(recording.id)}
                  type="button"
                >
                  rename
                </button>
                <button
                  className="analysis-task-link subtle analysis-video-hover-link analysis-video-preview-link"
                  onClick={() => onPreviewRecording(recording.id)}
                  type="button"
                >
                  {isPreviewing ? 'hide preview' : 'preview'}
                </button>
                <button
                  className="analysis-task-link danger analysis-video-hover-link"
                  onClick={() => onDeleteRecording(recording.id, recording.filename)}
                  type="button"
                >
                  delete
                </button>
              </div>
            </div>
          );
        })}
        {!recordings.length && (
          <p className="entry-empty-copy">
            {recordingsLoading ? 'Loading videos…' : 'Uploaded videos will appear here.'}
          </p>
        )}
      </div>
    </section>
  );
}
