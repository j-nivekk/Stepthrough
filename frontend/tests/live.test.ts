import assert from 'node:assert/strict';
import test from 'node:test';
import { busyElsewhere, busyRunIds, isSharedAccount, patchCandidate, staleQueries, stepEditor, uploadsElsewhere } from '../src/lib/live';
import type { CandidateFrame, LiveBusy, LiveEvent, LivePresence, RunDetail, SessionUser } from '../src/types';

const event = (kind: LiveEvent['kind'], ids: Partial<LiveEvent> = {}): LiveEvent => ({
  seq: 1, kind, project_id: 'p', recording_id: 'r', run_id: 'run', by: 'other', ...ids,
});

test('a change makes out of date only the data it touches', () => {
  assert.deepEqual(staleQueries(event('projects', { recording_id: null, run_id: null })), [['projects'], ['project', 'p']]);
  assert.deepEqual(staleQueries(event('project', { run_id: null })), [['projects'], ['project', 'p'], ['recording', 'r']]);
  assert.deepEqual(staleQueries(event('recording')), [['projects'], ['project', 'p'], ['recording', 'r'], ['run', 'run']]);
  assert.deepEqual(staleQueries(event('run')), [['recording', 'r'], ['run', 'run'], ['pathway', 'run']]);
  assert.deepEqual(staleQueries(event('candidate')), [['run', 'run'], ['pathway', 'run']]);
  assert.deepEqual(staleQueries(event('settings')), [['saved-run-settings']]);
  assert.deepEqual(staleQueries(event('state')), []);
});

test('a step changed elsewhere is patched into the task, and nothing else is', () => {
  const step = (id: string, title: string | null) => ({ id, title }) as CandidateFrame;
  const detail = { candidates: [step('a', null), step('b', null)] } as unknown as RunDetail;
  const patched = patchCandidate(detail, step('b', 'Home'));
  assert.deepEqual(patched?.candidates.map((candidate) => candidate.title), [null, 'Home']);
  assert.equal(patchCandidate(detail, step('elsewhere', 'x')), detail);
  assert.equal(patchCandidate(undefined, step('b', 'x')), undefined);
});

test('of two browsers on one step, the first keeps it, and every browser agrees', () => {
  const editing = (client: string, since: number, candidate = 'step'): LivePresence => ({
    client, targets: [{ kind: 'editing', run_id: 'run', candidate_id: candidate, since }],
  });
  const presence = [editing('late', 12), editing('early', 4), editing('other step', 1, 'other')];
  assert.equal(stepEditor(presence, 'run', 'step'), 'early');
  assert.equal(stepEditor([...presence].reverse(), 'run', 'step'), 'early');
  assert.equal(stepEditor([editing('b', 4), editing('a', 4)], 'run', 'step'), 'a');
  assert.equal(stepEditor(presence, 'run', 'nobody'), null);
});

test('uploads and busy work elsewhere leave out this browser', () => {
  const presence: LivePresence[] = [
    { client: 'me', targets: [{ kind: 'uploading', project_id: 'p', name: 'mine.mp4', progress: 0.5 }] },
    { client: 'other', targets: [{ kind: 'uploading', project_id: 'p', name: 'theirs.mp4', progress: 0.3 }] },
    { client: 'third', targets: [{ kind: 'uploading', project_id: 'another', name: 'elsewhere.mp4', progress: null }] },
  ];
  assert.deepEqual(uploadsElsewhere(presence, 'p', 'me').map((upload) => upload.name), ['theirs.mp4']);
  assert.deepEqual(uploadsElsewhere(presence, null, 'me'), []);
  const busy: LiveBusy[] = [
    { id: '1', project_id: 'p', run_id: 'run', label: 'adding a step by hand to this task', by: 'other' },
    { id: '2', project_id: 'p', run_id: 'run', label: 'exporting', by: 'me' },
    { id: '3', project_id: 'p', run_id: 'run-2', label: 'merging two screens', by: 'other' },
  ];
  assert.deepEqual(busyElsewhere(busy, 'run', 'me').map((entry) => entry.label), ['adding a step by hand to this task']);
  assert.deepEqual(busyRunIds(busy, 'me').sort(), ['run', 'run-2']);
});

test('only a regular account with the shared tag is shared', () => {
  const user = (tags: string[], is_admin = false): SessionUser => ({ id: 'u', name: 'g1', display_name: null, tags, is_admin, delete_after: null });
  assert.equal(isSharedAccount(user(['shared'])), true);
  assert.equal(isSharedAccount(user(['shared', 'admin'], true)), false);
  assert.equal(isSharedAccount(user(['group-a'])), false);
  assert.equal(isSharedAccount(null), false);
});
