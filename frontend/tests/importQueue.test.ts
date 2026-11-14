import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectImportQueueItems,
  importsInFlight,
  markImportUploaded,
  nextImportUpload,
  syncImportQueueWithRecordings,
} from '../src/lib/importQueue';
import type { RecordingSummary } from '../src/types';

const file = (name: string) => new File(['x'], name, { lastModified: 1 });
const recording = (id: string, projectId: string, filename = `${id}.mp4`): RecordingSummary =>
  ({ id, project_id: projectId, filename, slug: id, source_url: '', duration_ms: 1000, duration_tc: '', width: 390, height: 844, fps: 30, created_at: '' }) as RecordingSummary;

test('chosen videos wait in order and upload one at a time', () => {
  const { queueItems } = collectImportQueueItems([], [file('a.mp4'), file('b.mp4')], 'p1');
  assert.deepEqual(queueItems.map((item) => [item.status, item.projectId]), [['queued', 'p1'], ['queued', 'p1']]);
  assert.equal(nextImportUpload(queueItems)?.filename, 'a.mp4');
  const sending = queueItems.map((item, index) => (index === 0 ? { ...item, status: 'uploading' as const } : item));
  assert.equal(nextImportUpload(sending), null);
  assert.equal(importsInFlight(sending, 'p1').length, 2);
  assert.equal(importsInFlight(sending, 'p2').length, 0);
});

test('the same file again is a duplicate only within its project', () => {
  const { queueItems } = collectImportQueueItems([], [file('a.mp4')], 'p1');
  assert.equal(collectImportQueueItems(queueItems, [file('a.mp4')], 'p1').ignoredCount, 1);
  assert.equal(collectImportQueueItems(queueItems, [file('a.mp4')], 'p2').queueItems.length, 1);
});

test('a recording listed by a reload before its upload finished is listed once', () => {
  const [item] = collectImportQueueItems([], [file('a.mp4')], 'p1').queueItems;
  const uploading = [{ ...item, status: 'uploading' as const }];
  // the reload lists the new recording while its own request has not returned yet
  const synced = syncImportQueueWithRecordings(uploading, [recording('r1', 'p1', 'a.mp4')], 'p1');
  assert.equal(synced.length, 2);
  const done = markImportUploaded(synced, item.localId, recording('r1', 'p1', 'a.mp4'));
  assert.equal(done.length, 1);
  assert.deepEqual([done[0].localId, done[0].status, done[0].recordingId], [item.localId, 'uploaded', 'r1']);
});

test('a reload of one project leaves the uploads of another alone', () => {
  const [other] = collectImportQueueItems([], [file('b.mp4')], 'p2').queueItems;
  const queue = [{ ...other, status: 'uploading' as const }, ...syncImportQueueWithRecordings([], [recording('r1', 'p1')], 'p1')];
  const synced = syncImportQueueWithRecordings(queue, [], 'p1');
  assert.deepEqual(synced.map((item) => item.localId), [other.localId]);
});
