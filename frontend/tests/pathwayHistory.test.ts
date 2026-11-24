import assert from 'node:assert/strict';
import test from 'node:test';
import { record, undoChanges } from '../src/lib/pathwayHistory';
import type { CandidateFrame } from '../src/types';

const step = (id: string, fields: Partial<CandidateFrame> = {}) => ({ id, ...fields }) as CandidateFrame;

test('an undo takes back what this browser did, and nothing else', () => {
  const before = [step('a'), step('b', { screen_link: 'x' }), step('c', { screen_kind: 'popup', title: 'Menu' })];
  // a merge the server does: a and b go to the box of t
  const entry = record('stacked Screen 2 onto Screen 1', before, [['a', { screen_link: 't' }], ['b', { screen_link: 't' }]]);
  const after = [step('a', { screen_link: 't' }), step('b', { screen_link: 't' }), step('c', { screen_kind: 'screen' })];
  assert.deepEqual(undoChanges(entry, after), { changes: [['a', { screen_link: 'auto' }], ['b', { screen_link: 'x' }]], kept: 0 });
  assert.equal(entry.label, 'stacked Screen 2 onto Screen 1');
});

test('a step someone else changed since is left as they left it', () => {
  // in a shared account: this browser made step a a pop-up, then a groupmate put it on another screen and
  // unmarked it again
  const entry = record('marked step 4 as a pop-up', [step('a'), step('b')], [['a', { screen_kind: 'popup' }], ['b', { title: 'Feed' }]]);
  const now = [step('a', { screen_kind: 'screen' }), step('b', { title: 'Feed' })];
  assert.deepEqual(undoChanges(entry, now), { changes: [['b', { title: '' }]], kept: 1 });
});

test('automatic and an empty title count as no say, and a step that is gone is skipped', () => {
  const entry = record('moved Screen 3 back to its automatic row', [step('a', { pathway_row: 'below' }), step('gone')], [
    ['a', { pathway_row: 'auto' }],
    ['gone', { title: 'x' }],
  ]);
  assert.deepEqual(undoChanges(entry, [step('a', { pathway_row: null })]), { changes: [['a', { pathway_row: 'below' }]], kept: 0 });
  assert.deepEqual(undoChanges(entry, [step('a', { pathway_row: 'below' })]), { changes: [], kept: 0 });
});

test('a return to an earlier screen is taken back, to the screen it said before or to none', () => {
  const entry = record('Screen 3 returns to Screen 2', [step('a'), step('b', { returns_to: 'x' })], [['a', { returns_to: 'b' }], ['b', { returns_to: 'auto' }]]);
  assert.deepEqual(undoChanges(entry, [step('a', { returns_to: 'b' }), step('b', { returns_to: null })]), {
    changes: [['a', { returns_to: 'auto' }], ['b', { returns_to: 'x' }]], kept: 0,
  });
  // someone else has said otherwise since: that stays
  assert.deepEqual(undoChanges(entry, [step('a', { returns_to: 'z' }), step('b', { returns_to: 'x' })]), { changes: [], kept: 1 });
});
