import type { RecordingSummary } from '../types';
import { createLocalId } from './utils';

/**
 * A video on its way into a project. Chosen videos upload by themselves, one at a time and in the order they were
 * chosen: `queued` waits for its turn, `uploading` is on its way, `uploaded` is a recording of the project, and
 * `error` failed (retry puts it back in the queue).
 */
export type ImportQueueStatus = 'queued' | 'uploading' | 'uploaded' | 'error';

export interface ImportQueueItem {
  localId: string;
  /** The project the video goes into, so that an upload still lands there after a switch of project. */
  projectId: string | null;
  filename: string;
  file: File | null;
  status: ImportQueueStatus;
  /** Share of the file sent, 0 to 1, while uploading; null when unknown. */
  progress: number | null;
  recordingId: string | null;
  error: string | null;
  signature: string | null;
}

export function buildImportFileSignature(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

export function createImportQueueItemFromFile(file: File, projectId: string): ImportQueueItem {
  return {
    localId: createLocalId('upload'),
    projectId,
    filename: file.name,
    file,
    status: 'queued',
    progress: null,
    recordingId: null,
    error: null,
    signature: buildImportFileSignature(file),
  };
}

export function collectImportQueueItems(
  currentQueue: ImportQueueItem[],
  files: FileList | File[],
  projectId: string,
): { ignoredCount: number; queueItems: ImportQueueItem[] } {
  const incomingFiles = Array.from(files);
  if (!incomingFiles.length) {
    return { ignoredCount: 0, queueItems: [] };
  }

  let ignoredCount = 0;
  const knownSignatures = new Set(
    currentQueue
      .filter((item) => item.projectId === projectId)
      .map((item) => item.signature)
      .filter((value): value is string => Boolean(value)),
  );
  const queueItems = incomingFiles.flatMap((file) => {
    const signature = buildImportFileSignature(file);
    if (knownSignatures.has(signature)) {
      ignoredCount += 1;
      return [];
    }
    knownSignatures.add(signature);
    return [createImportQueueItemFromFile(file, projectId)];
  });

  return { ignoredCount, queueItems };
}

export function createImportQueueItemFromRecording(recording: RecordingSummary): ImportQueueItem {
  return {
    localId: `recording-${recording.id}`,
    projectId: recording.project_id,
    filename: recording.filename,
    file: null,
    status: 'uploaded',
    progress: null,
    recordingId: recording.id,
    error: null,
    signature: null,
  };
}

/**
 * The queue after the project's recordings were loaded again: uploaded rows follow the recordings of `projectId`
 * (renamed, deleted, or added elsewhere), rows still on their way stay, and rows of other projects stay untouched.
 */
export function syncImportQueueWithRecordings(
  current: ImportQueueItem[],
  recordings: RecordingSummary[],
  projectId: string,
): ImportQueueItem[] {
  const recordingsById = new Map(recordings.map((recording) => [recording.id, recording]));
  const seenRecordingIds = new Set<string>();
  const nextQueue: ImportQueueItem[] = [];

  current.forEach((item) => {
    if (!item.recordingId || (item.projectId !== null && item.projectId !== projectId)) {
      if (item.recordingId) seenRecordingIds.add(item.recordingId);
      nextQueue.push(item);
      return;
    }

    const recording = recordingsById.get(item.recordingId);
    if (!recording || seenRecordingIds.has(recording.id)) {
      return;
    }

    seenRecordingIds.add(recording.id);
    nextQueue.push({
      ...createImportQueueItemFromRecording(recording),
      localId: item.localId,
    });
  });

  recordings.forEach((recording) => {
    if (!seenRecordingIds.has(recording.id)) {
      nextQueue.push(createImportQueueItemFromRecording(recording));
    }
  });

  return nextQueue;
}

/**
 * The row an upload has finished for: now a recording. A reload of the project's recordings can have listed the
 * new recording already, as a row of its own; that row goes, so the recording is listed once.
 */
export function markImportUploaded(current: ImportQueueItem[], localId: string, recording: RecordingSummary): ImportQueueItem[] {
  return current
    .filter((item) => item.localId === localId || item.recordingId !== recording.id)
    .map((item) =>
      item.localId === localId
        ? {
            ...item,
            projectId: recording.project_id,
            filename: recording.filename,
            file: null,
            status: 'uploaded',
            progress: null,
            recordingId: recording.id,
            error: null,
            signature: null,
          }
        : item,
    );
}

/** Whether a chosen file is a project file (a whole project, made with download) rather than a video. */
export function isProjectFile(name: string): boolean {
  return /\.zip$/i.test(name.trim());
}

/** The row of a project file that came in: its first video takes the row, the others get rows of their own. */
export function markProjectFileUploaded(current: ImportQueueItem[], localId: string, recordings: RecordingSummary[]): ImportQueueItem[] {
  if (!recordings.length) return current.filter((item) => item.localId !== localId);
  let next = markImportUploaded(current, localId, recordings[0]);
  for (const recording of recordings.slice(1)) {
    next = [...next.filter((item) => item.recordingId !== recording.id), createImportQueueItemFromRecording(recording)];
  }
  return next;
}

/** The next video to send, or null while one is on its way (videos go one at a time) or none is waiting. */
export function nextImportUpload(queue: ImportQueueItem[]): ImportQueueItem | null {
  if (queue.some((item) => item.status === 'uploading')) {
    return null;
  }
  return queue.find((item) => item.status === 'queued' && item.file !== null && item.projectId !== null) ?? null;
}

/** Videos of a project still on their way: waiting or uploading. */
export function importsInFlight(queue: ImportQueueItem[], projectId: string | null): ImportQueueItem[] {
  return queue.filter((item) => item.projectId === projectId && (item.status === 'queued' || item.status === 'uploading'));
}

export function getUploadedImportItems(queue: ImportQueueItem[]): ImportQueueItem[] {
  return queue.filter((item) => item.status === 'uploaded' && Boolean(item.recordingId));
}
