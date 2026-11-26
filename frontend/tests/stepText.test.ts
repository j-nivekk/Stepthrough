import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAnalysisWait, formatWait } from '../src/lib/formatters';
import { foldText, hasText, runTextNotice, searchWords, stepTextNote, stepsWithText } from '../src/lib/stepText';
import type { RunText, RunTextDetail } from '../src/types';

const text = (changes: Partial<RunText> = {}): RunText => ({ waiting: 0, read: 0, failed: 0, earlier: 0, problem: null, ...changes });

function detail(...texts: Array<string | null>): RunTextDetail {
  return { summary: text(), steps: texts.map((each, index) => ({ candidate_id: `c${index}`, state: 'read', text: each })) };
}

test('text is compared without case, accents and extra spaces', () => {
  assert.equal(foldText('  Réglages\n  ÉCRAN '), 'reglages ecran');
  assert.equal(foldText('設定'), '設定');
});

test('words are looked for one by one, and together between quotation marks', () => {
  assert.deepEqual(searchWords('cookie  Settings'), ['cookie', 'settings']);
  assert.deepEqual(searchWords('"accept all" “manage options” x'), ['accept all', 'manage options', 'x']);
  assert.deepEqual(searchWords(' "" " '), []);
});

test('steps with every word are found', () => {
  const run = detail('Accept all cookies', 'All settings', null, 'cookies: accept them all');
  assert.deepEqual([...(stepsWithText(run, 'ALL accept') ?? [])], ['c0', 'c3']);
  assert.deepEqual([...(stepsWithText(run, '"accept all"') ?? [])], ['c0']);
  assert.deepEqual([...(stepsWithText(run, 'setting') ?? [])], ['c1']);
  assert.deepEqual([...(stepsWithText(run, 'nowhere') ?? [])], []);
});

test('nothing looked for, or no text yet, leaves every step', () => {
  assert.equal(stepsWithText(detail('a'), '  '), null);
  assert.equal(stepsWithText(undefined, 'a'), null);
});

test('a run without text offers to read it', () => {
  const notice = runTextNotice(text(), 12);
  assert.deepEqual([notice.kind, notice.label, notice.action], ['none', '', { does: 'read', label: 'read text' }]);
  assert.equal(runTextNotice(text(), 0).action, null);
});

test('a run being read says how far it is and can be stopped', () => {
  const notice = runTextNotice(text({ waiting: 5, read: 6, failed: 1 }), 12);
  assert.deepEqual([notice.kind, notice.label, notice.action?.does], ['reading', 'reading text, 7 of 12', 'stop']);
});

test('a run whose text is read needs nothing', () => {
  assert.deepEqual([runTextNotice(text({ read: 12 }), 12).label, runTextNotice(text({ read: 12 }), 12).action], ['', null]);
});

test('what is missing can be read or tried again', () => {
  assert.deepEqual(
    [runTextNotice(text({ read: 11 }), 12), runTextNotice(text({ read: 9 }), 12), runTextNotice(text({ read: 10, failed: 2 }), 12)].map(
      (notice) => [notice.label, notice.action?.label],
    ),
    [
      ['text of 1 step not read', 'read it'],
      ['text of 3 steps not read', 'read them'],
      ['text of 2 steps could not be read', 'try again'],
    ],
  );
  assert.equal(runTextNotice(text({ failed: 12 }), 12).label, 'text could not be read');
});

test('text of an earlier version is said to be, and can be read again', () => {
  assert.equal(runTextNotice(text({ earlier: 12 }), 12).label, 'text read by an earlier version');
  const part = runTextNotice(text({ earlier: 5, read: 7 }), 12);
  assert.deepEqual([part.label, part.action?.label], ['text of 5 steps read by an earlier version', 'read again']);
  assert.match(part.title ?? '', /1\.5\.0/);
});

test('why text was not read is said as the app writes', () => {
  const notice = runTextNotice(text({ problem: 'The models could not be fetched.' }), 12);
  assert.deepEqual([notice.kind, notice.label, notice.action?.label], ['problem', 'text was not read. the models could not be fetched.', 'try again']);
});

test('text can be searched once there is any', () => {
  assert.deepEqual([hasText(text()), hasText(text({ read: 1 })), hasText(text({ earlier: 1 })), hasText(text({ waiting: 3 }))], [false, true, true, false]);
});

test('a step without lines says why', () => {
  assert.deepEqual(
    (['waiting', 'failed', 'read', null] as const).map((text_state) => stepTextNote({ text_state })),
    ['waiting to be read', 'the text of this screenshot could not be read', 'no text on this screen', 'the text of this screenshot has not been read'],
  );
});

test('a run being read says when it is ready, once the server can tell', () => {
  assert.equal(runTextNotice(text({ waiting: 5, read: 7, seconds_left: 70 }), 12).label, 'reading text, 7 of 12, ready in about a minute');
  assert.equal(runTextNotice(text({ waiting: 5, read: 7, seconds_left: null }), 12).label, 'reading text, 7 of 12');
});

test('waits are put as roughly as they are known', () => {
  assert.deepEqual(
    [3, 9.9, 14, 26, 49, 50, 89, 90, 151, 3500, 3600, 5400, 7300].map(formatWait),
    ['a few seconds', 'a few seconds', 'about 10 s', 'about 30 s', 'about 50 s', 'about a minute', 'about a minute',
     'about 2 min', 'about 3 min', 'about 58 min', 'about 1 hour', 'about 1.5 hours', 'about 2 hours'],
  );
});

test('an analysis says when it is ready, and a queued one when it starts', () => {
  assert.equal(formatAnalysisWait({ status: 'running', seconds_left: 22 }), 'ready in about 20 s');
  assert.equal(formatAnalysisWait({ status: 'queued', seconds_to_start: 70, seconds_left: 95 }), 'ready in about 2 min, starts in about a minute');
  assert.equal(formatAnalysisWait({ status: 'queued', seconds_to_start: 0, seconds_left: 20 }), 'ready in about 20 s');
  assert.equal(formatAnalysisWait({ status: 'running', seconds_left: null }), null);
});
