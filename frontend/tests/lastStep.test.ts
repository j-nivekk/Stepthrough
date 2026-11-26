import assert from 'node:assert/strict';
import test from 'node:test';

import { LAST_STEP_RUNS, rememberStep, rememberedStep, stepToReturnTo } from '../src/lib/lastStep';
import { jumpBlock } from '../src/lib/utils';

/** A Storage kept in memory, as a browser's localStorage. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

test('a run opens where its review was left, unless that is its first step or gone', () => {
  const storage = memoryStorage();
  const steps = ['s1', 's2', 's3'];
  assert.equal(stepToReturnTo('run', steps, storage), null);
  rememberStep('run', 's3', storage);
  assert.equal(stepToReturnTo('run', steps, storage), 's3');
  // the first step: the run starts there anyway
  rememberStep('run', 's1', storage);
  assert.equal(stepToReturnTo('run', steps, storage), null);
  // a step since deleted from the run
  rememberStep('run', 'deleted', storage);
  assert.equal(stepToReturnTo('run', steps, storage), null);
  // other runs keep their own
  rememberStep('other', 's2', storage);
  assert.equal(rememberedStep('other', storage), 's2');
  assert.equal(rememberedStep('run', storage), 'deleted');
});

test('only the most recent runs are remembered', () => {
  const storage = memoryStorage();
  for (let index = 0; index < LAST_STEP_RUNS + 5; index += 1) rememberStep(`run-${index}`, 'step', storage);
  assert.equal(rememberedStep('run-0', storage), null);
  assert.equal(rememberedStep('run-4', storage), null);
  assert.equal(rememberedStep('run-5', storage), 'step');
  // working on an old run again makes it recent
  rememberStep('run-5', 'later', storage);
  for (let index = 0; index < LAST_STEP_RUNS - 1; index += 1) rememberStep(`new-${index}`, 'step', storage);
  assert.equal(rememberedStep('run-5', storage), 'later');
  assert.equal(rememberedStep('run-6', storage), null);
});

test('without storage, or with something else in it, nothing is remembered and nothing breaks', () => {
  assert.equal(rememberedStep('run', undefined), null);
  rememberStep('run', 'step', undefined);
  const storage = memoryStorage();
  storage.setItem('stepthrough.last-step.v1', 'not json');
  assert.equal(rememberedStep('run', storage), null);
  storage.setItem('stepthrough.last-step.v1', JSON.stringify({ run: 3, other: 'step' }));
  assert.equal(rememberedStep('run', storage), null);
  assert.equal(rememberedStep('other', storage), 'step');
});

test('a jump puts what fits in the middle of the window, and a whole run at the top', () => {
  assert.equal(jumpBlock(300, 900), 'center');
  assert.equal(jumpBlock(6480, 900), 'start');
  assert.equal(jumpBlock(720, 900), 'center');
  assert.equal(jumpBlock(721, 900), 'start');
});
