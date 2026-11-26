import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  argProblem,
  barState,
  findCommand,
  matchChoice,
  parseFrames,
  parseLine,
  parseStepList,
  parseStepReference,
  parseTime,
  type CommandHandler,
} from '../src/lib/commands';

const run = () => undefined;
/** The commands usable "here", as the registry would give them. */
function here(handlers: Record<string, CommandHandler>) {
  return (name: string) => handlers[name];
}

test('every command has a name of its own, and short forms that are no other command', () => {
  const names = COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  const aliases = COMMANDS.flatMap((command) => command.aliases ?? []);
  assert.equal(new Set(aliases).size, aliases.length);
  for (const alias of aliases) assert.ok(!names.includes(alias), alias);
});

test('a line is a name and what follows it', () => {
  assert.deepEqual(parseLine('/accept 3-7'), { name: 'accept', arg: '3-7', named: true });
  assert.deepEqual(parseLine('/acc'), { name: 'acc', arg: '', named: false });
  assert.deepEqual(parseLine('/title  Sign in page '), { name: 'title', arg: 'Sign in page', named: true });
  assert.deepEqual(parseLine('/'), { name: '', arg: '', named: false });
});

test('short forms are typed as they are, names in any case, and a number alone is a step', () => {
  assert.equal(findCommand('gg')?.name, 'top');
  assert.equal(findCommand('G')?.name, 'end');
  assert.equal(findCommand('a')?.name, 'accept');
  assert.equal(findCommand('Accept')?.name, 'accept');
  assert.equal(findCommand('exportfigure')?.name, 'download');
  assert.equal(findCommand('next')?.name, 'nextstep');
  for (const key of ['j', 'k', 'i', 'l']) assert.equal(findCommand(key), null);
  assert.equal(findCommand('w')?.name, 'export');
  assert.equal(findCommand('q')?.name, 'closepreview');
  assert.equal(findCommand('30')?.name, 'step');
  assert.equal(findCommand('nope'), null);
});

test('times, frames and lists of steps', () => {
  assert.equal(parseTime('1:23'), 83_000);
  assert.equal(parseTime('83.5'), 83_500);
  assert.equal(parseTime('1:02:03'), 3_723_000);
  assert.equal(parseTime('1:x'), null);
  assert.equal(parseFrames(''), 1);
  assert.equal(parseFrames('-3'), -3);
  assert.equal(parseFrames('+5'), 5);
  assert.equal(parseFrames('five'), null);
  assert.equal(parseFrames('9007199254740992'), null);
  assert.deepEqual(parseStepList('3-5, 9'), [3, 4, 5, 9]);
  assert.deepEqual(parseStepList('3,5,9'), [3, 5, 9]);
  assert.deepEqual(parseStepList('7-5'), [5, 6, 7]);
  assert.deepEqual(parseStepList('5,5'), [5]);
  assert.equal(parseStepList('3-'), null);
  assert.equal(parseStepList(''), null);
  assert.equal(parseStepList('9007199254740992'), null);
  assert.deepEqual(parseStepReference('start - 2'), { numbers: [0, 1, 2], candidates: false });
  assert.deepEqual(parseStepReference('candidate 3-5'), { numbers: [3, 4, 5], candidates: true });
});

test('a choice is typed in full or begun, as long as only one begins so', () => {
  assert.equal(matchChoice('gal', ['grid', 'list', 'gallery']), 'gallery');
  assert.equal(matchChoice('G', ['grid', 'gallery']), null);
  assert.equal(matchChoice('Grid', ['grid', 'gallery']), 'grid');
});

test('what an argument needs is said before Enter', () => {
  const min = findCommand('min')!;
  assert.equal(argProblem(min, '450', []), null);
  assert.equal(argProblem(min, '450 ms', []), null);
  assert.equal(argProblem(min, '50', []), 'at least 100 ms');
  assert.equal(argProblem(min, 'soon', []), 'soon is not a number');
  assert.equal(argProblem(min, '', []), '/min needs milliseconds');
  const view = findCommand('view')!;
  assert.equal(argProblem(view, 'cards', ['grid', 'list', 'gallery']), 'cards is not one of: grid, list, gallery');
  assert.equal(argProblem(view, 'g', ['grid', 'list', 'gallery']), 'choose a match with the arrow keys or type its full name');
  assert.equal(argProblem(findCommand('accept')!, '', []), null);
  assert.equal(argProblem(findCommand('accept')!, 'three', []), 'step numbers, as 12, 3-7 or 3,5,9');
  assert.equal(argProblem(findCommand('select')!, 'pending', []), null);
  assert.equal(argProblem(findCommand('note')!, '', []), '/note needs text');
  assert.equal(argProblem(findCommand('size')!, 'fit', []), null);
  assert.equal(argProblem(findCommand('top')!, 'now', []), '/top takes nothing after it');
});

test('while the name is typed: what is usable here first, the rest of the best in grey', () => {
  const lookup = here({ accept: { run }, filter: { run }, find: { run }, top: { run } });
  const typed = barState('/ac', lookup);
  assert.equal(typed.mode, 'commands');
  assert.equal(typed.items[0].label, '/accept [‹steps›]');
  assert.equal(typed.items[0].line, '/accept ');
  assert.equal(typed.ghost, 'cept');
  // a command of the pathway, typed in the steps: listed dimmed, with where it works
  const away = barState('/zo', lookup);
  assert.equal(away.items[0].elsewhere, 'in the pathway');
  assert.equal(away.ghost, '');
  assert.equal(barState('/zoom', lookup).problem, '/zoom works in the pathway');
  assert.equal(barState('/qq', lookup).problem, 'there is no /qq');
  // an empty line lists all that is usable here
  assert.equal(barState('/', lookup).items.length, 4);
});

test('aliases accompany command suggestions and lead to the same contextual action', () => {
  const lookup = here({ top: { run }, export: { run }, exportproject: { run }, download: { run } });
  assert.deepEqual(barState('/gg', lookup).items[0].aliases, ['gg']);
  assert.equal(barState('/gg', lookup).items[0].line, '/top');
  const exports = barState('/export', lookup).items;
  assert.deepEqual(exports.map((item) => item.line), ['/export ', '/exportproject ', '/download ', '/exportruns ']);
  assert.deepEqual(exports[2].aliases, ['exportfigure']);
  assert.equal(barState('/exp', lookup).items[0].line, '/export ');
  assert.deepEqual(barState('/exportfigure ', lookup).items.map((item) => item.label), ['png', 'svg']);
  assert.deepEqual(barState('/w ', lookup).items.map((item) => item.line), ['/w accepted', '/w all']);
});

test('once the name is typed: the choices, the value now, and what the steps will be', () => {
  const lookup = here({
    view: { run, current: () => 'grid' },
    min: { run, current: () => '450', defaultValue: () => '600' },
    accept: { run, describe: (arg) => (arg ? `steps ${arg}` : 'step 4'), check: (arg) => (arg === '99' ? 'there is no step 99' : null) },
    run: { run, choices: () => [{ value: 'run #3', note: '12 of 40 reviewed' }, { value: '3', suggest: false }] },
    step: { run },
  });
  const view = barState('/view g', lookup);
  assert.equal(view.mode, 'argument');
  assert.deepEqual(view.items.map((item) => item.line), ['/view grid', '/view gallery']);
  assert.equal(view.items[0].note, 'now');
  assert.equal(view.ghost, 'rid');
  assert.equal(barState('/view g ', lookup).items[0].line, '/view grid');
  assert.equal(barState('/min ', lookup).hint, '100 to 10,000 ms; now 450; default 600');
  assert.equal(barState('/min 20', lookup).problem, 'at least 100 ms');
  assert.equal(barState('/accept ', lookup).detail, 'step 4');
  assert.equal(barState('/a 3-7', lookup).detail, 'steps 3-7');
  assert.equal(barState('/accept 99', lookup).problem, 'there is no step 99');
  assert.deepEqual(barState('/run ', lookup).items.map((item) => [item.label, item.note]), [
    ['run #3', '12 of 40 reviewed'],
    ['next', ''],
    ['previous', ''],
  ]);
  assert.equal(barState('/30', lookup).mode, 'argument');
  assert.equal(barState('/30', lookup).problem, null);
  assert.equal(barState('/30 ', lookup).problem, null);
  assert.equal(barState('/30 8', lookup).problem, '/30 takes nothing after it');
  assert.equal(barState('/run 3', lookup).problem, null);
});
