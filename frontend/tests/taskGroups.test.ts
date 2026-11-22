import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTaskGroupFoldState,
  focusVideoGroup,
  isTaskGroupCollapsed,
  revealTaskGroup,
  setTaskGroupCollapsed,
  summarizeRunReview,
} from '../src/lib/taskGroups';

test('selecting a video from the video list opens its runs and folds the others', () => {
  let state = createTaskGroupFoldState(['v1'], null);
  state = focusVideoGroup(state, 'v1');

  assert.equal(isTaskGroupCollapsed(state, 'v1'), false);
  assert.equal(isTaskGroupCollapsed(state, 'v2'), true);
  assert.equal(isTaskGroupCollapsed(state, 'v3'), true);
  assert.equal(state.collapsed.has('v1'), false);
});

test('selecting a run directly in the tasks list leaves all open groups as-is', () => {
  let state = createTaskGroupFoldState([], 'v1');
  // User manually opens v2 while v1 is focused
  state = setTaskGroupCollapsed(state, 'v2', false);
  assert.equal(isTaskGroupCollapsed(state, 'v1'), false);
  assert.equal(isTaskGroupCollapsed(state, 'v2'), false);
  assert.equal(isTaskGroupCollapsed(state, 'v3'), true);

  // User picks a run inside v2 -> only reveals v2, does NOT re-focus or collapse v1
  state = revealTaskGroup(state, 'v2');
  assert.equal(isTaskGroupCollapsed(state, 'v1'), false);
  assert.equal(isTaskGroupCollapsed(state, 'v2'), false);
  assert.equal(isTaskGroupCollapsed(state, 'v3'), true);

  // Clicking v1 in the video list again collapses v2 back down
  state = focusVideoGroup(state, 'v1');
  assert.equal(isTaskGroupCollapsed(state, 'v1'), false);
  assert.equal(isTaskGroupCollapsed(state, 'v2'), true);
  assert.equal(isTaskGroupCollapsed(state, 'v3'), true);
});

test('folding a temporarily opened group does not persist it as manually collapsed', () => {
  let state = createTaskGroupFoldState([], 'v1');
  state = setTaskGroupCollapsed(state, 'v2', false);
  assert.equal(isTaskGroupCollapsed(state, 'v2'), false);

  state = setTaskGroupCollapsed(state, 'v2', true);
  assert.equal(isTaskGroupCollapsed(state, 'v2'), true);
  assert.equal(state.collapsed.has('v2'), false);

  // When focus clears, v2 is no longer stuck collapsed
  state = focusVideoGroup(state, null);
  assert.equal(isTaskGroupCollapsed(state, 'v2'), false);
});

test('run review summary counts accepted, rejected, and pending steps', () => {
  assert.equal(summarizeRunReview({ candidate_count: 0, accepted_count: 0, rejected_count: 0 }), null);

  const partial = summarizeRunReview({ candidate_count: 10, accepted_count: 5, rejected_count: 2 });
  assert.ok(partial);
  assert.equal(partial.reviewed, 7);
  assert.equal(partial.pending, 3);
  assert.equal(partial.acceptedPct, 50);
  assert.equal(partial.rejectedPct, 20);
  assert.equal(partial.label, '7/10 reviewed');
  assert.equal(partial.tooltip, '7 of 10 steps reviewed: 5 accepted, 2 rejected, 3 pending');

  const untouched = summarizeRunReview({ candidate_count: 4, accepted_count: 0 });
  assert.ok(untouched);
  assert.equal(untouched.reviewed, 0);
  assert.equal(untouched.pending, 4);
  assert.equal(untouched.label, '0/4 reviewed');

  const done = summarizeRunReview({ candidate_count: 1, accepted_count: 1, rejected_count: 0 });
  assert.ok(done);
  assert.equal(done.label, '1/1 reviewed');
  assert.equal(done.tooltip, '1 of 1 step reviewed: 1 accepted, 0 rejected, 0 pending');
});
