import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ContextMenu,
  keyboardMenuAnchor,
  shouldIgnoreContextMenu,
  triggerMenuAnchor,
  type ContextMenuItem,
  type ContextMenuState,
} from '../../../components/ContextMenu';
import { EditableName } from '../../../components/EditableName';
import { formatRecordingContextBadge } from '../../../lib/formatters';
import type { ImportQueueItem } from '../../../lib/importQueue';
import { uploadsElsewhere } from '../../../lib/live';
import { useLive } from '../../live/LiveProvider';
import type { RecordingSummary } from '../../../types';
import { PlaceholderRows } from '../../../components/Placeholders';

export interface AnalysisVideosPanelProps {
  onCancelUpload: (localId: string) => void;
  onDeleteRecording: (recordingId: string, filename: string) => void;
  onFilesDropped: (files: FileList | File[]) => void;
  onPreviewRecording: (recordingId: string) => void;
  onRenameRecording: (recordingId: string, filename: string, previousFilename: string) => Promise<void>;
  onRequestRename: (recordingId: string) => void;
  onSelectRecording: (recordingId: string) => void;
  previewRecording: RecordingSummary | null;
  projectId: string | null;
  recordings: RecordingSummary[];
  recordingsLoading: boolean;
  selectedRecordingId: string | null;
  /** Videos still on their way in: they join the list when they are in. */
  uploads: ImportQueueItem[];
  videoRenameRequest: { id: string; nonce: number } | null;
}

export function AnalysisVideosPanel({
  onCancelUpload,
  onDeleteRecording,
  onFilesDropped,
  onPreviewRecording,
  onRenameRecording,
  onRequestRename,
  onSelectRecording,
  previewRecording,
  projectId,
  recordings,
  recordingsLoading,
  selectedRecordingId,
  uploads,
  videoRenameRequest,
}: AnalysisVideosPanelProps) {
  // In a shared account: videos another browser is uploading into this project.
  const live = useLive();
  const elsewhere = uploadsElsewhere(live.presence, projectId, live.clientId);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const menuRecording = menu ? recordings.find((recording) => recording.id === menu.id) ?? null : null;

  // Close the context menu if its video disappears (e.g. deleted in another browser).
  useEffect(() => {
    if (menu && !menuRecording) setMenu(null);
  }, [menu, menuRecording]);

  const closeMenu = useCallback(
    (refocus = false) => {
      const recordingId = menu?.id;
      setMenu(null);
      if (!refocus || !recordingId) return;
      window.requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-video-menu-trigger="${CSS.escape(recordingId)}"]`)?.focus(),
      );
    },
    [menu?.id],
  );

  function handleRowContextMenu(event: MouseEvent<HTMLDivElement>, recordingId: string) {
    if (shouldIgnoreContextMenu(event.target)) return;
    event.preventDefault();
    setMenu({ id: recordingId, x: event.clientX, y: event.clientY });
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, recordingId: string) {
    if (shouldIgnoreContextMenu(event.target)) return;
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    setMenu(keyboardMenuAnchor(event.currentTarget, '[data-video-menu-trigger]', recordingId));
  }

  function handleMoreClick(event: MouseEvent<HTMLButtonElement>, recordingId: string) {
    if (menu?.id === recordingId) {
      setMenu(null);
      return;
    }
    setMenu(triggerMenuAnchor(event.currentTarget, recordingId));
  }

  function buildVideoMenuItems(recording: RecordingSummary): ContextMenuItem[] {
    return [
      {
        label: 'rename',
        run: () => onRequestRename(recording.id),
      },
      {
        label: 'delete',
        danger: true,
        run: () => onDeleteRecording(recording.id, recording.filename),
      },
    ];
  }

  function isFileDrag(event: React.DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  return (
    <section
      className="analysis-column"
      onDragOver={(event) => {
        if (!isFileDrag(event)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        if (!isFileDrag(event)) {
          return;
        }
        event.preventDefault();
        if (event.dataTransfer.files.length > 0) {
          onFilesDropped(event.dataTransfer.files);
        }
      }}
    >
      <div className="analysis-column-head">
        <p>videos</p>
      </div>
      <div className="analysis-divider" />
      <div className="analysis-videos">
        {recordings.map((recording) => {
          const isSelected = recording.id === selectedRecordingId;
          const isPreviewing = previewRecording?.id === recording.id;
          const isMenuOpen = menu?.id === recording.id;
          return (
            <div
              className={`analysis-video-row ${isSelected ? 'selected' : ''} ${isPreviewing ? 'previewing' : ''} ${isMenuOpen ? 'menu-open' : ''}`}
              key={recording.id}
              onContextMenu={(event) => handleRowContextMenu(event, recording.id)}
              onKeyDown={(event) => handleRowKeyDown(event, recording.id)}
            >
              <div className="analysis-video-row-button">
                <EditableName
                  containerClassName="analysis-video-name"
                  displayButtonClassName="analysis-video-select-button"
                  editRequestToken={videoRenameRequest?.id === recording.id ? videoRenameRequest.nonce : null}
                  lockedExtension
                  onDisplayClick={() => onSelectRecording(recording.id)}
                  onSave={(nextValue, previousValue) => onRenameRecording(recording.id, nextValue, previousValue)}
                  renameLabel={`rename video ${recording.filename}`}
                  showRenameButton={false}
                  textClassName="analysis-video-name-text"
                  value={recording.filename}
                />
                <span className="analysis-video-duration">{recording.duration_tc}</span>
              </div>
              <div className="analysis-video-subrow">
                <span className="analysis-video-context-badge">{formatRecordingContextBadge(recording)}</span>
                <div className="analysis-video-actions">
                  <button
                    className="analysis-task-link subtle analysis-video-hover-link analysis-video-preview-link"
                    onClick={() => onPreviewRecording(recording.id)}
                    type="button"
                  >
                    {isPreviewing ? 'hide preview' : 'preview'}
                  </button>
                  <button
                    aria-expanded={isMenuOpen}
                    aria-haspopup="menu"
                    aria-label={`more actions for ${recording.filename}`}
                    className={`analysis-task-link plain analysis-task-more analysis-video-hover-link ${isMenuOpen ? 'is-open' : ''}`}
                    data-video-menu-trigger={recording.id}
                    onClick={(event) => handleMoreClick(event, recording.id)}
                    title="more actions (right-click)"
                    type="button"
                  >
                    ⋯
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {uploads.map((upload) => {
          const percent = Math.round((upload.progress ?? 0) * 100);
          return (
            <div className="analysis-video-row analysis-video-upload" key={upload.localId}>
              <div className="analysis-video-row-button">
                <span className="analysis-video-name-text">{upload.filename}</span>
                <button className="analysis-task-link danger" onClick={() => onCancelUpload(upload.localId)} type="button">
                  cancel
                </button>
              </div>
              <div className="analysis-video-subrow">
                <span className="analysis-video-duration">
                  {upload.status === 'queued' ? 'waiting to upload' : percent >= 100 ? 'processing…' : `uploading ${percent}%`}
                </span>
              </div>
            </div>
          );
        })}
        {elsewhere.map((upload) => (
          <div className="analysis-video-row analysis-video-upload live-row" key={upload.key}>
            <div className="analysis-video-row-button">
              <span className="analysis-video-name-text">{upload.name}</span>
            </div>
            <div className="analysis-video-subrow">
              <span className="live-pill">
                uploading in another browser{upload.progress !== null ? ` ${Math.round(upload.progress * 100)}%` : ''}
              </span>
            </div>
          </div>
        ))}
        {!recordings.length && !uploads.length && !elsewhere.length ? (
          recordingsLoading ? (
            <PlaceholderRows count={2} label="loading the videos" />
          ) : (
            <p className="entry-empty-copy">uploaded videos will appear here.</p>
          )
        ) : null}
      </div>
      {menu && menuRecording ? (
        <ContextMenu
          alignRight={menu.alignRight}
          anchorTop={menu.anchorTop}
          className="analysis-video-menu"
          items={buildVideoMenuItems(menuRecording)}
          key={menu.id}
          onClose={closeMenu}
          triggerSelector={`[data-video-menu-trigger="${CSS.escape(menu.id)}"]`}
          x={menu.x}
          y={menu.y}
        />
      ) : null}
    </section>
  );
}
