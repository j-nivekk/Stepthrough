import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCandidateChanges,
  busyElsewhere,
  busyRunIds,
  isSharedAccount,
  patchCandidate,
  projectImportsElsewhere,
  staleQueries,
  stepEditor,
  uploadsElsewhere,
  withCandidateStatuses,
} from '../src/lib/live';
import type { CandidateFrame, LiveBusy, LiveEvent, LivePresence, RunDetail, SessionUser } from '../src/types';

const event = (kind: LiveEvent['kind'], ids: Partial<LiveEvent> = {}): LiveEvent => ({
  seq: 1, kind, project_id: 'p', recording_id: 'r', run_id: 'run', by: 'other', ...ids,
});

test('a change makes out of date only the data it touches', () => {
  assert.deepEqual(staleQueries(event('projects', { recording_id: null, run_id: null })), [['projects'], ['project', 'p']]);
  assert.deepEqual(staleQueries(event('project', { run_id: null })), [['projects'], ['project', 'p'], ['recording', 'r']]);
  assert.deepEqual(staleQueries(event('recording')), [['projects'], ['project', 'p'], ['recording', 'r'], ['run', 'run']]);
  assert.deepEqual(staleQueries(event('run')), [['projects'], ['recording', 'r'], ['run', 'run'], ['pathway', 'run']]);
  assert.deepEqual(staleQueries(event('candidate')), [['projects'], ['recording', 'r'], ['run', 'run'], ['pathway', 'run']]);
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

test('a change this browser makes shows on the step as the server will save it', () => {
  const step = {
    id: 'a', status: 'pending', title: 'Home', notes: null,
    screen_link: 'b', screen_kind: 'popup', pathway_row: null, returns_to: 'c',
  } as unknown as CandidateFrame;
  assert.deepEqual(
    applyCandidateChanges(step, { status: 'accepted', title: 'Inbox', previous_title: 'Home' }),
    { ...step, status: 'accepted', title: 'Inbox' },
  );
  // auto clears the reviewer's say; other values are kept as they are
  const cleared = applyCandidateChanges(step, { screen_link: 'auto', screen_kind: 'auto', returns_to: 'auto', pathway_row: 'auto' });
  assert.equal(cleared.screen_link, null);
  assert.equal(cleared.screen_kind, null);
  assert.equal(cleared.returns_to, null);
  assert.equal(cleared.pathway_row, null);
  assert.equal(applyCandidateChanges(step, { screen_link: 'new' }).screen_link, 'new');
  assert.equal(applyCandidateChanges(step, { notes: '' }).notes, '');
  // the step itself is not changed
  assert.equal(step.status, 'pending');
});

test('a decision for several steps shows on all of them, and a run with nothing to change stays the same', () => {
  const step = (id: string, status: CandidateFrame['status']) => ({ id, status }) as CandidateFrame;
  const detail = { candidates: [step('a', 'pending'), step('b', 'accepted'), step('c', 'pending')] } as unknown as RunDetail;
  const decided = withCandidateStatuses(detail, ['a', 'b'], 'rejected');
  assert.deepEqual(decided?.candidates.map((candidate) => candidate.status), ['rejected', 'rejected', 'pending']);
  assert.equal(decided?.candidates[2], detail.candidates[2]);
  assert.equal(withCandidateStatuses(detail, ['b'], 'accepted'), detail);
  assert.equal(withCandidateStatuses(undefined, ['a'], 'accepted'), undefined);
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

test('project files other browsers bring in show on the list of projects, not the browser\'s own', () => {
  const presence: LivePresence[] = [
    { client: 'me', targets: [{ kind: 'importing_project', name: 'mine.stepthrough.zip', progress: 0.2 }] },
    { client: 'them', targets: [{ kind: 'importing_project', name: 'theirs.stepthrough.zip', progress: 0.4 }, { kind: 'uploading', project_id: 'p', name: 'a.mp4', progress: null }] },
  ];
  assert.deepEqual(
    projectImportsElsewhere(presence, 'me').map((upload) => [upload.name, upload.progress]),
    [['theirs.stepthrough.zip', 0.4]],
  );
});

test('a visitor account is a shared one', () => {
  const user = { id: 'g', name: 'g', display_name: null, tags: ['visitor'], is_admin: false, delete_after: null } as SessionUser;
  assert.equal(isSharedAccount(user), true);
  assert.equal(isSharedAccount({ ...user, is_admin: true }), false);
});
