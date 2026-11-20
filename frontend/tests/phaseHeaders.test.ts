import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReactElement } from 'react';
import { phaseAt, withPhaseHeaders } from '../src/components/PhaseChoice';

const step = (id: string, ms: number, status = 'accepted') => ({ id, timestamp_ms: ms, status });
const steps = [step('a', 0), step('b', 1000), step('c', 2000, 'rejected'), step('d', 3000), step('e', 4000), step('f', 5000)];
// sign up from 1 s, verify from 3 s, nothing from 5 s
const phases = [
  { start_ms: 1000, name: 'sign up' },
  { start_ms: 3000, name: 'verify' },
  { start_ms: 5000, name: '' },
];

function headers(shown: typeof steps) {
  const nodes = withPhaseHeaders(shown, phases, (item) => item.id, { list: false, allSteps: steps, durationMs: 6000 }) as Array<string | ReactElement<{ name: string; start: number; end: number | null; accepted: number }>>;
  return nodes.map((node) => (typeof node === 'string' ? node : `[${node.props.name || '-'} ${node.props.start}-${node.props.end} ${node.props.accepted}]`));
}

test('a header goes where the phase changes between two steps shown', () => {
  assert.equal(phaseAt(phases, 2500), 'sign up');
  // no header before the first phase; one where each starts, and one where the steps go on outside every phase
  assert.deepEqual(headers(steps), ['a', '[sign up 1000-3000 1]', 'b', 'c', '[verify 3000-5000 2]', 'd', 'e', '[- 5000-6000 1]', 'f']);
  // with some steps filtered out, the headers follow the steps that are shown, and still count the whole phase
  assert.deepEqual(headers([steps[2], steps[4]]), ['[sign up 1000-3000 1]', 'c', '[verify 3000-5000 2]', 'e']);
});

test('without phases, the steps are shown as they are', () => {
  assert.deepEqual(withPhaseHeaders(steps, [], (item) => item.id, { list: true, allSteps: steps, durationMs: null }), steps.map((item) => item.id));
  assert.deepEqual(withPhaseHeaders(steps, [{ start_ms: 0, name: '' }], (item) => item.id, { list: true, allSteps: steps, durationMs: null }), steps.map((item) => item.id));
});
