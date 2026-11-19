import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRunSettings, compareRuns, defaultComparisonPair } from '../src/lib/runComparison';
import { formatChangedAgo, formatLastChange, formatProjectSummary, formatRunNumber, formatRunTitle } from '../src/lib/formatters';
import type { CandidateFrame, Project, RunSummary } from '../src/types';

const step = (id: string, ms: number, extra: Partial<CandidateFrame> = {}) =>
  ({ id, timestamp_ms: ms, timestamp_tc: '', status: 'pending', candidate_origin: 'detected', title: null, notes: null, ...extra }) as CandidateFrame;
const run = (id: string, created: string, extra: Partial<RunSummary> = {}) =>
  ({ id, created_at: created, status: 'completed', accepted_count: 0, stable: null, ...extra }) as RunSummary;

test('the newest run is compared with the earlier one that has the most review', () => {
  const runs = [run('a', '2026-11-01', { accepted_count: 8 }), run('b', '2026-11-02', { accepted_count: 2 }), run('c', '2026-11-03')];
  assert.deepEqual(defaultComparisonPair(runs), { left: 'a', right: 'c' });
  assert.equal(defaultComparisonPair([run('a', '2026-11-01'), run('b', '2026-11-02', { status: 'failed' })]), null);
});

test('steps pair by moment; steps added by hand are counted to be added again, not paired', () => {
  const left = [
    step('l1', 0, { status: 'accepted', title: 'Home' }),
    step('l2', 3000, { status: 'accepted' }),
    step('l3', 6000, { status: 'rejected' }),
    step('m1', 9000, { candidate_origin: 'manual', status: 'accepted' }),
  ];
  const right = [step('r1', 100), step('r2', 3600), step('r3', 12000)];
  const result = compareRuns(left, right);
  assert.deepEqual(result.pairs, [
    { source_candidate_id: 'l1', target_candidate_id: 'r1' },
    { source_candidate_id: 'l2', target_candidate_id: 'r2' },
  ]);
  assert.deepEqual(result.counts, { both: 1, moved: 1, leftOnly: 1, rightOnly: 1 });
  assert.deepEqual(result.carryOver, { reviewed: 2, manual: 1, lost: 1 });
});

test('only the settings that differ are marked', () => {
  const rows = compareRunSettings(
    run('a', '1', { stable: { recording_type: 'phone', min_dwell_ms: 450 } as RunSummary['stable'] }),
    run('b', '2', { stable: { recording_type: 'phone', min_dwell_ms: 2500 } as RunSummary['stable'] }),
  );
  assert.deepEqual(rows.filter((row) => row.changed).map((row) => [row.label, row.value, row.right]), [['minimum time on screen', '450 ms', '2500 ms']]);
});

test('a run is called by its name or its number, and keeps the number in sight', () => {
  assert.equal(formatRunTitle({ name: null, run_number: 3 }), 'run #3');
  assert.equal(formatRunTitle({ name: '  ', run_number: 3 }), 'run #3');
  assert.equal(formatRunTitle({ name: 'Second try', run_number: 3 }), 'Second try');
  assert.equal(formatRunNumber({ run_number: 3 }), 'run #3');
  // a server from before stored numbers: the number worked out from the order
  assert.equal(formatRunTitle({ name: null, run_number: null }, 2), 'run #2');
});

test('the last change says when, and who where it is known', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.equal(formatChangedAgo('2026-11-18T11:59:40Z', now), 'just now');
  assert.equal(formatChangedAgo('2026-11-18T11:35:00Z', now), '25 min ago');
  assert.equal(formatLastChange(new Date(Date.now() - 30_000).toISOString(), 'Ada L.'), 'changed just now by Ada L.');
  assert.equal(formatLastChange(new Date(Date.now() - 30_000).toISOString(), null), 'changed just now');
  const project = {
    recording_count: 1, run_count: 3, last_activity_at: '2026-01-01T00:00:00Z',
    modified_at: new Date(Date.now() - 30_000).toISOString(), modified_by_name: 'bo',
  } as Project;
  assert.equal(formatProjectSummary(project), '1 video and 3 runs, changed just now by bo');
});
