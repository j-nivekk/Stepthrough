import assert from 'node:assert/strict';
import test from 'node:test';

import { clickSelection, invertSelection, keepShown, selectionState } from '../src/lib/stepSelection';

const shown = ['s1', 's2', 's3', 's4', 's5'];

test('a click toggles one step', () => {
  assert.deepEqual(clickSelection([], shown, 's2', null, false), ['s2']);
  assert.deepEqual(clickSelection(['s2', 's4'], shown, 's2', 's4', false), ['s4']);
});

test('shift with a click sets the range from the last step clicked', () => {
  // s2 clicked before; shift-clicking s4 selects s2 to s4
  assert.deepEqual(clickSelection(['s2'], shown, 's4', 's2', true), ['s2', 's3', 's4']);
  // upwards as well
  assert.deepEqual(clickSelection(['s5'], shown, 's3', 's5', true), ['s3', 's4', 's5']);
  // shift-clicking a selected step clears the range
  assert.deepEqual(clickSelection(['s1', 's2', 's3', 's4'], shown, 's3', 's1', true), ['s4']);
  // without a step clicked before, or one no longer shown, shift is an ordinary click
  assert.deepEqual(clickSelection([], shown, 's3', null, true), ['s3']);
  assert.deepEqual(clickSelection([], shown, 's3', 'gone', true), ['s3']);
});

test('the selection follows the order and the steps shown', () => {
  assert.deepEqual(keepShown(['s4', 'hidden', 's1'], shown), ['s1', 's4']);
  assert.deepEqual(clickSelection(['hidden'], shown, 's1', null, false), ['s1']);
});

test('invert, and what a box over all of them says', () => {
  assert.deepEqual(invertSelection(['s1', 's3'], shown), ['s2', 's4', 's5']);
  assert.deepEqual(invertSelection([], shown), shown);
  assert.equal(selectionState([], shown), 'none');
  assert.equal(selectionState(['s2'], shown), 'some');
  assert.equal(selectionState(shown, shown), 'all');
  assert.equal(selectionState(['hidden'], shown), 'none');
});
