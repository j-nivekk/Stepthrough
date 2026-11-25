import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMockPathway, jsonStep, mockNumber, reasonText, type Choices } from '../src/components/pathwayTutorial/tutorialModel';

// The tutorial teaches the app's rules, so its practice pathway must group the way backend/app/services/pathway.py does.
const boxes = (choices: Choices = {}, mode: 'screens' | 'steps' = 'screens') =>
  buildMockPathway(choices, mode).screens.map((screen) => `${screen.title}:${screen.steps.join(',')}`);
const moves = (choices: Choices = {}) =>
  buildMockPathway(choices).moves.map((move) => `${move.from}>${move.to}:${move.passes.join(',')}${move.kind === 'return' ? ' back' : ''}`);

test('the automatic pathway has the two mistakes the lessons are about', () => {
  // 6 is home again with other posts (split off), 8 is the next product (kept with 7, as most of it is the same).
  assert.deepEqual(boxes(), ['Home:1', 'Settings:2,3,5', 'Permission:4', 'Screen 4:6', 'Product:7,8']);
  assert.deepEqual(moves(), ['1>2:2', '2>4:4', '4>2:5 back', '2>6:6', '6>7:7']);
  const pathway = buildMockPathway({});
  assert.equal(pathway.screens.find((screen) => screen.id === 4)?.popup, true);
  assert.match(reasonText(pathway, 5, {}), /modal closed/);
  assert.match(reasonText(pathway, 8, {}), /update/);
  // called as in the app: the opening screen is the start, and the steps count from the change that leaves it
  assert.deepEqual([1, 2, 8].map(mockNumber), ['start', '1', '7']);
  assert.match(reasonText(pathway, 8, {}), /is on 6 as well/);
  assert.match(reasonText(buildMockPathway({ 6: { link: 1 } }), 6, { 6: { link: 1 } }), /the same screen as the start\.$/);
});

test('the corrections of the lesson put home together and give the second product a box', () => {
  const fixed: Choices = { 6: { link: 1 }, 8: { link: 'new' } };
  assert.deepEqual(boxes(fixed), ['Home:1,6', 'Settings:2,3,5', 'Permission:4', 'Product:7', 'Screen 5:8']);
  assert.deepEqual(moves(fixed), ['1>2:2', '2>4:4', '4>2:5 back', '2>1:6 back', '1>7:7', '7>8:8']);
  const pathway = buildMockPathway(fixed);
  // The product branches off home: a row below, one column to the right.
  const product = pathway.screens.find((screen) => screen.id === 7);
  assert.deepEqual([product?.col, product?.row], [1, 1]);
  assert.deepEqual(jsonStep(pathway, 6, fixed), { step_index: 5, screen_id: 'screen-01', grouped_by: 'researcher', screen_choice: 'same_screen' });
  // and by what the engine found, as pathway.json calls it
  assert.deepEqual([3, 5].map((n) => jsonStep(pathway, n, fixed).grouped_by), ['scroll', 'overlay_closed']);
  assert.equal(jsonStep(buildMockPathway({}), 8, {}).grouped_by, 'same_page');
  assert.deepEqual(jsonStep(pathway, 8, fixed), { step_index: 7, screen_id: 'screen-05', grouped_by: null, screen_choice: 'new_screen' });
});

test('settings before and after the pop-up can be made two screens', () => {
  assert.deepEqual(boxes({ 5: { link: 'new' }, 6: { link: 1 } }).slice(0, 4), ['Home:1,6', 'Settings:2,3', 'Permission:4', 'Screen 4:5']);
});

test('by step, only the reviewer joins steps', () => {
  assert.equal(boxes({}, 'steps').length, 8);
  assert.deepEqual(boxes({ 6: { link: 1 } }, 'steps')[0], 'Home:1,6');
});

test('a step marked as a pop-up gets a box of its own, and unmarked it is an ordinary screen', () => {
  // What the engine found still holds for the others: 5 shows the screen of 2, as in the app.
  assert.deepEqual(boxes({ 3: { popup: true } }).slice(1, 3), ['Settings:2,5', 'Screen 3:3']);
  assert.equal(buildMockPathway({ 4: { popup: false } }).screens.find((screen) => screen.id === 4)?.popup, false);
});
