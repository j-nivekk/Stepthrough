import assert from 'node:assert/strict';
import test from 'node:test';

import { changeWithTransition, moveCardsWithTransition, transitionName } from '../src/lib/viewTransition';

test('an element id becomes a transition name, also when it starts with a digit', () => {
  assert.equal(transitionName('candidate-89ec079c'), 'vt-candidate-89ec079c');
  assert.equal(transitionName('3f2a'), 'vt-3f2a');
  assert.equal(transitionName('a b.c'), 'vt-a-b-c');
});

test('without view transitions (here, no browser) a change is made at once', () => {
  let changed = 0;
  changeWithTransition(() => {
    changed += 1;
  });
  moveCardsWithTransition(() => null, '.card', () => {
    changed += 1;
  });
  assert.equal(changed, 2);
});
