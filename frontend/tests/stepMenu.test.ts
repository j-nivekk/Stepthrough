import assert from 'node:assert/strict';
import test from 'node:test';

import type { ActionItem } from '../src/components/ActionMenu';
import { returnTargets } from '../src/lib/pathwayReturns';
import { returningStep, stepMenuHeading, stepMenuItems, type StepMenuContext } from '../src/lib/stepMenu';
import type { CandidateChanges, CandidateFrame, CandidateStatus, Pathway } from '../src/types';

const step = (index: number, status: CandidateStatus = 'accepted', more: Partial<CandidateFrame> = {}) =>
  ({ id: `c${index}`, detector_index: index, status, timestamp_ms: index * 1000, timestamp_tc: `00:00:0${index}.000`, image_url: `c${index}.png`, ...more }) as CandidateFrame;

/** What the actions chosen did, as [name, ...what they were called with] with steps as their ids. */
let done: unknown[][] = [];
const note = (name: string) => (...args: unknown[]) => {
  done.push([name, ...args.map((arg) => (arg && typeof arg === 'object' && 'id' in arg ? arg.id : arg))]);
};

function context(steps: CandidateFrame[], clicked: string, selected: string[] = [], more: Partial<StepMenuContext> = {}): StepMenuContext {
  done = [];
  return {
    step: steps.find((each) => each.id === clicked) as CandidateFrame,
    selected: steps.filter((each) => selected.includes(each.id)),
    steps,
    view: 'grid',
    annotating: false,
    anchor: null,
    phases: ['sign up', 'feed'],
    phaseAt: (ms) => (ms < 3000 ? 'sign up' : ms < 5000 ? 'feed' : ''),
    numberOf: ({ status, detector_index }) =>
      status === 'accepted'
        ? { number: String(detector_index), name: `step ${detector_index}`, short: String(detector_index) }
        : { number: String(detector_index), name: `candidate ${detector_index}`, short: `candidate ${detector_index}` },
    thumbOf: (url) => url.replace('.png', '.webp'),
    returns: [],
    isPopup: ({ screen_kind }) => screen_kind === 'popup',
    popupChange: (_, popup): CandidateChanges => ({ screen_kind: popup ? 'popup' : 'auto' }),
    actions: {
      setStatus: note('setStatus'),
      setStatusOfSelected: note('setStatusOfSelected'),
      update: note('update'),
      updateSeveral: note('updateSeveral'),
      setPhase: note('setPhase'),
      playFromHere: note('playFromHere'),
      openScreenshot: note('openScreenshot'),
      annotate: note('annotate'),
      jumpTo: note('jumpTo'),
      toggleSelection: note('toggleSelection'),
      invertSelection: note('invertSelection'),
      clearSelection: note('clearSelection'),
    },
    ...more,
  };
}

const labels = (items: ActionItem[]) => items.map((item) => item.label);
function item(items: ActionItem[], ...path: string[]): ActionItem {
  const found = items.find((each) => each.label === path[0]);
  assert.ok(found, `no "${path[0]}" in ${labels(items).join(', ')}`);
  return path.length > 1 ? item(found.items ?? [], ...path.slice(1)) : found;
}
function choose(items: ActionItem[], ...path: string[]) {
  done = [];
  item(items, ...path).run?.();
  return done;
}

test('the menu of one step: its decision, what to do with it, where it goes in the pathway', () => {
  const here = context([step(1), step(2), step(3)], 'c2');
  assert.equal(stepMenuHeading(here), 'step 2');
  const items = stepMenuItems(here);
  assert.deepEqual(labels(items), ['accept', 'reject', 'reset', 'play from here', 'annotate', 'open screenshot', 'stacking', 'a pop-up', 'phase', 'select']);
  // the decision made is ticked; the others can be made, also with a key
  assert.deepEqual(items.slice(0, 3).map(({ hint, disabled }) => [hint, disabled]), [['✓', true], ['R', false], ['U', false]]);
  assert.deepEqual(choose(items, 'reject'), [['setStatus', 'c2', 'rejected']]);
  assert.deepEqual(choose(items, 'play from here'), [['playFromHere', 'c2']]);
  assert.deepEqual(choose(items, 'a pop-up'), [['update', 'c2', { screen_kind: 'popup' }]]);
  assert.deepEqual(choose(items, 'select'), [['toggleSelection', 'c2', false]]);
});

test('a step is the same screen as an earlier one that is not rejected, the nearest first', () => {
  const steps = [step(1, 'accepted', { title: 'home' }), step(2, 'rejected'), step(3, 'pending'), step(4, 'accepted', { screen_link: 'c1' }), step(5)];
  const items = stepMenuItems(context(steps, 'c4'));
  const stacking = item(items, 'stacking').items ?? [];
  assert.deepEqual(labels(stacking), ['automatic', 'a new screen', 'same as candidate 3, at 00:03', 'same as 1: home']);
  assert.deepEqual(stacking.map(({ hint }) => hint), [undefined, undefined, undefined, '✓']);
  assert.equal(stacking[3].thumb, 'c1.webp');
  assert.deepEqual(choose(items, 'stacking', 'automatic'), [['update', 'c4', { screen_link: 'auto' }]]);
  assert.deepEqual(choose(items, 'stacking', 'same as candidate 3, at 00:03'), [['update', 'c4', { screen_link: 'c3' }]]);
});

test('only an accepted step has a phase; the one it is in is ticked, and a new one asks for its name', () => {
  const steps = [step(1), step(2, 'pending'), step(3)];
  assert.ok(!labels(stepMenuItems(context(steps, 'c2'))).includes('phase'));
  const items = stepMenuItems(context(steps, 'c3'));
  const phases = item(items, 'phase').items ?? [];
  assert.deepEqual(phases.map(({ label, hint }) => [label, hint]), [['sign up', undefined], ['feed', '✓'], ['no phase', undefined], ['new phase…', undefined]]);
  assert.deepEqual(choose(items, 'phase', 'sign up'), [['setPhase', 'c3', 'c3', 'sign up']]);
  assert.deepEqual(choose(items, 'phase', 'no phase'), [['setPhase', 'c3', 'c3', '']]);
  assert.deepEqual(choose(items, 'phase', 'new phase…'), [['setPhase', 'c3', 'c3', null]]);
});

test('what the menu says fits the view and the step', () => {
  const steps = [step(1), step(2, 'accepted', { notes: 'a note', screen_kind: 'popup' })];
  const labelsIn = (more: Partial<StepMenuContext>) => labels(stepMenuItems(context(steps, 'c2', [], more)));
  assert.ok(labelsIn({}).includes('edit notes'));
  assert.ok(labelsIn({ annotating: true }).includes('hide notes'));
  assert.ok(labelsIn({ view: 'list' }).includes('edit title'));
  assert.ok(labelsIn({ view: 'gallery' }).includes('edit title'));
  assert.ok(labelsIn({}).includes('not a pop-up'));
  const links = stepMenuItems(
    context(steps, 'c2', [], {
      similar: { targetId: 'candidate-c1', label: 'similar to step 1' },
      back: { targetId: 'candidate-c1', label: 'then back to the start' },
    }),
  );
  assert.deepEqual(choose(links, 'go to step 1, which looks the same'), [['jumpTo', 'candidate-c1']]);
  assert.deepEqual(choose(links, 'go to the start, where this went back'), [['jumpTo', 'candidate-c1']]);
  const again = stepMenuItems(context(steps, 'c2', [], { similar: { targetId: 'candidate-c1', label: 'same screen as step 1' } }));
  assert.deepEqual(choose(again, 'go to step 1, which looks the same'), [['jumpTo', 'candidate-c1']]);
});

test('a range is selected from the step selected before', () => {
  const steps = [step(1), step(2), step(3)];
  const items = stepMenuItems(context(steps, 'c3', ['c1'], { anchor: 'c1' }));
  assert.deepEqual(choose(items, 'select from step 1 to here'), [['toggleSelection', 'c3', true]]);
  // not for a step that is selected, nor from a step that is gone
  const selected = labels(stepMenuItems(context(steps, 'c1', ['c1'], { anchor: 'c1' })));
  assert.ok(selected.includes('deselect') && !selected.some((label) => label.startsWith('select from')));
  assert.ok(!labels(stepMenuItems(context(steps, 'c3', [], { anchor: 'gone' }))).some((label) => label.startsWith('select from')));
});

test('a step outside the selection, or selected on its own, has its own menu', () => {
  const steps = [step(1), step(2), step(3)];
  assert.equal(stepMenuHeading(context(steps, 'c3', ['c1', 'c2'])), 'step 3');
  assert.ok(labels(stepMenuItems(context(steps, 'c3', ['c1', 'c2']))).includes('play from here'));
  assert.equal(stepMenuHeading(context(steps, 'c1', ['c1'])), 'step 1');
  assert.equal(stepMenuHeading(context(steps, 'c1', ['c1', 'c2'])), '2 selected steps');
});

test('the menu of several: decisions for those that differ, in numbers when that is not all of them', () => {
  const steps = [step(1), step(2, 'pending'), step(3, 'rejected'), step(4, 'pending')];
  const items = stepMenuItems(context(steps, 'c2', ['c1', 'c2', 'c3']));
  assert.deepEqual(labels(items), [
    'accept 2 of 3', 'reject 2 of 3', 'reset 2 of 3', 'stacking', 'pop-ups', 'phase of step 1', 'invert selection', 'clear selection',
  ]);
  assert.deepEqual(choose(items, 'accept 2 of 3'), [['setStatusOfSelected', 'accepted']]);
  assert.deepEqual(choose(items, 'clear selection'), [['clearSelection']]);

  const alike = stepMenuItems(context(steps, 'c2', ['c2', 'c4']));
  assert.deepEqual(alike.slice(0, 3).map(({ label, hint, disabled }) => [label, hint, disabled]), [
    ['accept', undefined, false], ['reject', undefined, false], ['reset', '✓', true],
  ]);
  assert.ok(!labels(alike).some((label) => label.startsWith('phase')), 'none of them is accepted');
});

test('stacking and pop-ups of several change only the steps that are not so yet, in one go', () => {
  const steps = [step(1, 'rejected'), step(2), step(3, 'accepted', { screen_link: 'c2' }), step(4, 'accepted', { screen_link: 'new', screen_kind: 'popup' }), step(5)];
  const items = stepMenuItems(context(steps, 'c3', ['c1', 'c2', 'c3', 'c4', 'c5']));
  // the rejected step is not in the pathway: the first of the others is the screen
  assert.deepEqual(labels(item(items, 'stacking').items ?? []), ['automatic', 'each a new screen', 'all the same as 2']);
  assert.deepEqual(choose(items, 'stacking', 'all the same as 2'), [['updateSeveral', [['c4', { screen_link: 'c2' }], ['c5', { screen_link: 'c2' }]]]]);
  assert.deepEqual(choose(items, 'stacking', 'automatic'), [['updateSeveral', [['c3', { screen_link: 'auto' }], ['c4', { screen_link: 'auto' }]]]]);
  assert.deepEqual(choose(items, 'pop-ups, 4 of 5')[0]?.[0], 'updateSeveral');
  assert.deepEqual(choose(items, 'not pop-ups, 1 of 5'), [['updateSeveral', [['c4', { screen_kind: 'auto' }]]]]);

  const untouched = stepMenuItems(context([step(1), step(2)], 'c1', ['c1', 'c2']));
  const automatic = item(untouched, 'stacking', 'automatic');
  assert.deepEqual([automatic.hint, automatic.disabled], ['✓', true]);
});

test('several accepted steps are put in a phase as the stretch from the first to the last', () => {
  const steps = [step(1), step(2, 'pending'), step(3), step(4), step(5)];
  const items = stepMenuItems(context(steps, 'c3', ['c2', 'c3', 'c4', 'c5']));
  const phases = item(items, 'phase, from 3 to 5').items ?? [];
  assert.deepEqual(phases.map(({ hint }) => hint), [undefined, undefined, undefined, undefined], 'they are not all in one');
  assert.deepEqual(choose(items, 'phase, from 3 to 5', 'sign up'), [['setPhase', 'c3', 'c5', 'sign up']]);
  const within = stepMenuItems(context(steps, 'c3', ['c3', 'c4']));
  assert.equal(item(within, 'phase, from 3 to 4', 'feed').hint, '✓');
});

// ── return to ──

/** Screens as [id, steps on it...]: steps count from 0 (the opening screen) and come from candidate c<number>. */
function pathwayOf(...screens: Array<[string, ...number[]]>): Pathway {
  return {
    screens: screens.map(([id, ...on], index) => ({
      id, index: index + 1, title: id === 'home' ? 'home' : `Screen ${index + 1}`, image_step_id: `s${on[0]}`, visits: [{ step_ids: on.map((each) => `s${each}`) }],
    })),
    steps: screens.flatMap(([id, ...on]) =>
      on.map((each) => ({ step_id: `s${each}`, step_index: each, screen_id: id, image_url: `c${each}.png`, source_candidate_id: `c${each}`, returns_to: each === 6 ? 'home' : null })),
    ),
  } as unknown as Pathway;
}

test('a step returns to a screen seen before it, the latest first, and never to its own', () => {
  const pathway = pathwayOf(['home', 0, 3], ['b', 1, 2], ['c', 4, 5], ['d', 6, 7]);
  assert.deepEqual(returnTargets(pathway, 'c5').map(({ id, label }) => [id, label]), [
    ['c1', 'Screen 2 (steps 1–2)'], ['c0', 'Screen 1, home (start and step 3)'],
  ]);
  assert.deepEqual(returnTargets(pathway, 'c3').map(({ id }) => id), ['c1'], 'it is on home itself');
  assert.deepEqual(returnTargets(pathway, 'c0'), [], 'nothing was seen before the start');
  assert.deepEqual(returnTargets(pathway, 'c9'), [], 'not in the pathway');
  assert.deepEqual(returnTargets(pathway, 'c6').map(({ current }) => current), [false, false, true]);
});

test('an accepted step can say where the user went back to; the choice made is ticked and can be taken away', () => {
  const steps = [step(1), step(2), step(3, 'accepted', { returns_to: 'c1' }), step(4, 'pending')];
  const returns = [
    { id: 'c2', name: 'Screen 2', label: 'Screen 2 (step 2)', imageUrl: 'c2.png', current: false },
    { id: 'c1', name: 'Screen 1', label: 'Screen 1 (step 1)', imageUrl: 'c1.png', current: true },
  ];
  const items = stepMenuItems(context(steps, 'c3', [], { returns }));
  const back = item(items, 'return to').items ?? [];
  assert.deepEqual(back.map(({ label, hint, thumb }) => [label, hint, thumb]), [
    ['no return', undefined, undefined], ['Screen 2 (step 2)', undefined, 'c2.webp'], ['Screen 1 (step 1)', '✓', 'c1.webp'],
  ]);
  assert.deepEqual(choose(items, 'return to', 'Screen 2 (step 2)'), [['update', 'c3', { returns_to: 'c2' }]]);
  assert.deepEqual(choose(items, 'return to', 'no return'), [['update', 'c3', { returns_to: 'auto' }]]);
  // nothing to take away, and nothing for a step that is not accepted or has nowhere to go back to
  assert.deepEqual(labels(item(stepMenuItems(context(steps, 'c2', [], { returns: returns.slice(1) })), 'return to').items ?? []), ['Screen 1 (step 1)']);
  assert.ok(!labels(stepMenuItems(context(steps, 'c4', [], { returns }))).includes('return to'));
  assert.ok(!labels(stepMenuItems(context(steps, 'c1', [], { returns: [] }))).includes('return to'));
  // a return that the pathway has no place for any more can still be taken away
  assert.deepEqual(labels(item(stepMenuItems(context(steps, 'c3', [], { returns: [] })), 'return to').items ?? []), ['no return']);
});

test('while the pathway loads, return to waits for it', () => {
  const waiting = item(stepMenuItems(context([step(1), step(2)], 'c2', [], { returns: undefined })), 'return to');
  assert.deepEqual([waiting.disabled, waiting.items], [true, undefined]);
});

test('several steps return after the last accepted one of them', () => {
  const steps = [step(1), step(2), step(3), step(4, 'pending')];
  const returns = [{ id: 'c1', name: 'Screen 1', label: 'Screen 1 (step 1)', imageUrl: 'c1.png', current: false }];
  const several = context(steps, 'c2', ['c2', 'c3', 'c4'], { returns });
  assert.equal(returningStep(several)?.id, 'c3');
  assert.deepEqual(choose(stepMenuItems(several), 'after 3, return to', 'Screen 1 (step 1)'), [['update', 'c3', { returns_to: 'c1' }]]);
  assert.equal(returningStep(context(steps, 'c4', [])), undefined, 'a pending step');
  assert.equal(returningStep(context(steps, 'c1', ['c2', 'c3']))?.id, 'c1', 'outside the selection');
});
