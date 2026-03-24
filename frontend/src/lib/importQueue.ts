import type { RecordingSummary } from '../types';
import { createLocalId } from './utils';

export type ImportQueueStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export interface ImportQueueItem {
  localId: string;
  filename: string;
  file: File | null;
  status: ImportQueueStatus;
  recordingId: string | null;
  error: string | null;
  signature: string | null;
}

export function buildImportFileSignature(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

export function createImportQueueItemFromFile(file: File): ImportQueueItem {
  return {
    localId: createLocalId('upload'),
    filename: file.name,
    file,
    status: 'pending',
    recordingId: null,
    error: null,
    signature: buildImportFileSignature(file),
  };
}

export function createImportQueueItemFromRecording(recording: RecordingSummary): ImportQueueItem {
  return {
    localId: `recording-${recording.id}`,
    filename: recording.filename,
    file: null,
    status: 'uploaded',
    recordingId: recording.id,
    error: null,
    signature: null,
  };
}

export function syncImportQueueWithRecordings(
  current: ImportQueueItem[],
  recordings: RecordingSummary[],
): ImportQueueItem[] {
  const recordingsById = new Map(recordings.map((recording) => [recording.id, recording]));
  const seenRecordingIds = new Set<string>();
  const nextQueue: ImportQueueItem[] = [];

  current.forEach((item) => {
    if (!item.recordingId) {
      nextQueue.push(item);
      return;
    }

    const recording = recordingsById.get(item.recordingId);
    if (!recording) {
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

export function getUploadedImportItems(queue: ImportQueueItem[]): ImportQueueItem[] {
  return queue.filter((item) => item.status === 'uploaded' && Boolean(item.recordingId));
}
