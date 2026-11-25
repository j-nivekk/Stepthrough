import assert from 'node:assert/strict';
import test from 'node:test';

import { numberRange, pathwayNumber, returnLinks, returnsTo, reviewNumbers, stepName, stepsPhrase, stretchName } from '../src/lib/stepNumbers';
import type { AcceptedStep, CandidateFrame, CandidateStatus } from '../src/types';

const candidate = (index: number, status: CandidateStatus, label = 'navigation') =>
  ({ id: `c${index}`, detector_index: index, status, score_breakdown: { transition_type: label } }) as CandidateFrame;
const accepted = (...ids: Array<[string, number]>) =>
  ids.map(([id, index]) => ({ source_candidate_id: id, step_index: index }) as AcceptedStep);

test('in the review, an accepted step has its number in the files and the others are candidates', () => {
  const candidates = [
    candidate(1, 'accepted', 'opening_screen'), candidate(2, 'accepted'), candidate(3, 'rejected'), candidate(4, 'accepted'), candidate(5, 'pending'),
  ];
  const numbers = reviewNumbers(candidates, accepted(['c1', 0], ['c2', 1], ['c4', 2]));
  assert.deepEqual([...numbers.values()].map((entry) => entry.name), ['start', 'step 1', 'candidate 2', 'step 2', 'candidate 4']);
  assert.deepEqual([...numbers.values()].map((entry) => entry.short), ['start', '1', 'candidate 2', '2', 'candidate 4']);

  // Nothing reviewed yet: the numbers the steps get when all are accepted.
  const pending = reviewNumbers([candidate(1, 'pending', 'opening_screen'), candidate(2, 'pending')], []);
  assert.deepEqual([...pending.values()].map((entry) => entry.name), ['candidate 0', 'candidate 1']);

  // Without the opening screen (another engine, or turned off) both count from 1.
  const without = reviewNumbers([candidate(1, 'accepted'), candidate(2, 'pending')], accepted(['c1', 1]));
  assert.deepEqual([...without.values()].map((entry) => entry.name), ['step 1', 'candidate 2']);
});

const step = (index: number, way = String(index)) => ({ step_index: index, path_step: way, detour: /[a-z]/.test(way) });

test('in the pathway, a step has its number, or its number along the main way with the detours left out', () => {
  assert.equal(pathwayNumber(step(0)), 'start');
  assert.equal(pathwayNumber(step(0), true), 'start');
  assert.equal(pathwayNumber(step(22, '14')), '22');
  assert.equal(pathwayNumber(step(22, '14'), true), '14');
  assert.equal(pathwayNumber(step(14, '13a'), true), '13a');
  assert.equal(pathwayNumber({ step_index: 3 }, true), '3', 'a pathway without the numbers along the main way');
  assert.equal(stepName('start'), 'start');
  assert.equal(stepName('13a'), 'step 13a');
});

test('stretches of steps read as people would say them', () => {
  assert.equal(numberRange('7', '13'), '7–13');
  assert.equal(numberRange('7', '7'), '7');
  assert.equal(numberRange('13a', '13d'), '13a–d');
  assert.equal(numberRange('13', '13d'), '13–13d');
  assert.equal(numberRange('13a', '14'), '13a–14');
  assert.equal(stretchName('5', '5'), 'step 5');
  assert.equal(stretchName('start', 'start'), 'start');
  assert.equal(stretchName('start', '5'), 'start to step 5');
  assert.equal(stretchName('7', '13a'), 'steps 7–13a');
});

test('the steps of a box are named as stretches', () => {
  assert.equal(stepsPhrase([step(4)]), 'step 4');
  assert.equal(stepsPhrase([step(0)]), 'start');
  assert.equal(stepsPhrase([step(0), step(1)]), 'start and step 1');
  assert.equal(stepsPhrase([step(0), step(1), step(2)]), 'start and steps 1–2');
  assert.equal(stepsPhrase([step(0), step(1), step(2), step(5)]), 'start, steps 1–2 and 5');
  assert.equal(stepsPhrase([step(1), step(5), step(9)]), 'steps 1, 5 and 9');
  const box = [step(7), step(8), step(9), step(17, '9d'), step(18, '10')];
  assert.equal(stepsPhrase(box), 'steps 7–9 and 17–18');
  assert.equal(stepsPhrase(box, true), 'steps 7–9, 9d and 10');
});

test('an accepted step says where the user went back to after it, by the name of the step there', () => {
  const back = (index: number, status: CandidateStatus, to: string | null, label?: string) => ({ ...candidate(index, status, label), returns_to: to }) as CandidateFrame;
  const candidates = [
    back(1, 'accepted', null, 'opening_screen'), back(2, 'accepted', null), back(3, 'accepted', 'c2'), back(4, 'accepted', 'c1'),
    back(5, 'rejected', 'c2'), back(6, 'pending', 'c2'), back(7, 'accepted', 'c5'), back(8, 'accepted', 'gone'),
  ];
  const numbers = reviewNumbers(candidates, accepted(['c1', 0], ['c2', 1], ['c3', 2], ['c4', 3], ['c7', 4], ['c8', 5]));
  assert.deepEqual([...returnLinks(candidates, numbers)], [
    ['c3', { targetId: 'candidate-c2', label: 'then back to step 1' }],
    ['c4', { targetId: 'candidate-c1', label: 'then back to the start' }],
    ['c7', { targetId: 'candidate-c5', label: 'then back to candidate 4' }],
  ]);
});

test('a step that shows an earlier screen again says so, when there were others in between', () => {
  const found = (index: number, as: number | null, reason: string) =>
    ({ ...candidate(index, 'accepted'), same_screen_as: as === null ? null : `c${as}`, same_screen_reason: reason }) as CandidateFrame;
  const steps = [candidate(1, 'accepted'), found(2, 1, 'scroll'), found(3, null, 'new'), found(4, 2, 'same_page'), found(5, 4, 'same_page'), found(6, null, 'overlay'), found(7, 5, 'overlay_closed')];
  assert.deepEqual(steps.map((step) => returnsTo(step, steps)?.id), [undefined, undefined, undefined, 'c2', undefined, undefined, 'c5']);
  // a step added by hand in between is none of the engine's
  const added = { ...candidate(8, 'accepted'), candidate_origin: 'manual' } as CandidateFrame;
  assert.equal(returnsTo(steps[4], [...steps.slice(0, 4), added, ...steps.slice(4)]), undefined);
});
