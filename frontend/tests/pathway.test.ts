import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { buildPathwayFigure, type PathwayFigureInput } from '../src/lib/pathwayFigure';
import { pathwayQueryOptions } from '../src/lib/pathwayQuery';
import { fitStepGrid } from '../src/lib/stepLayout';
import type { Pathway, PathwayScreen, PathwayStep, RunDetail } from '../src/types';

const measure = (text: string, size: number) => text.length * size * 0.6;
const longTitle = 'Detailed screen title with research context '.repeat(5).trim();
const pathway: Pathway = {
  format: 'stepthrough.pathway/1', detail: 'screens', step_count: 1, screen_count: 1, field_notes: {},
  steps: [{ step_id: 'step-001', step_index: 1, screen_id: 'screen-01', visit: 1, timestamp_ms: 0,
    timestamp_tc: '00:00:00.000', title: longTitle, notes: 'An annotation & <markup> "quoted".',
    transition_type: 'opening_screen', time_on_screen_ms: 1000, image_path: 'frame.png', image_url: '/frame.png',
    grouped_by: null, screen_choice: 'automatic', kind_choice: 'automatic', source_candidate_id: 'c1' }],
  screens: [{ id: 'screen-01', index: 1, title: longTitle, title_step_id: 'step-001', kind: 'screen',
    reached_from: null, image_step_id: 'step-001', time_on_screen_ms: 1000,
    visits: [{ visit: 1, step_ids: ['step-001'], arrived_ms: 0, time_on_screen_ms: 1000 }] }],
  transitions: [],
};
const input: PathwayFigureInput = {
  pathway, options: { notes: 'key', caption: true, times: true }, aspect: 390 / 844,
  title: 'A very long recording filename with research context '.repeat(5),
  subtitle: 'A long project title and recording metadata '.repeat(5), date: '2026-11-12', version: '1.1.0',
  imageFor: () => 'data:image/png;base64,AA==', measure,
};
function unescape(text: string) {
  return text.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}
function texts(svg: string, group: string) {
  const markup = svg.match(new RegExp(`<g id="${group}">([\\s\\S]*?)</g>`))?.[1] ?? '';
  return [...markup.matchAll(/<text ([^>]+)>([^<]*)<\/text>/g)].map((match) => {
    const attr = (name: string) => Number(match[1].match(new RegExp(`(?:^| )${name}="([^"]+)"`))?.[1]);
    return { x: attr('x'), y: attr('y'), size: attr('font-size'), content: unescape(match[2]), centered: match[1].includes('text-anchor="middle"') };
  });
}

test('long export headers and note titles stay within the SVG and preserve their text', () => {
  for (const aspect of [390 / 844, 16 / 9]) {
    const figure = buildPathwayFigure({ ...input, aspect });
    for (const group of ['header', 'notes', 'legend']) {
      const lines = texts(figure.svg, group);
      assert.ok(lines.length > 0, group);
      for (const line of lines) {
        const right = line.x + measure(line.content, line.size) * (line.centered ? 0.5 : 1);
        assert.ok(right <= figure.width - 48 + 0.1, `${group} overflows: ${line.content}`);
        assert.ok(line.y < figure.height - 20);
      }
    }
    const header = texts(figure.svg, 'header');
    assert.equal(header.filter((line) => line.size === 17).map((line) => line.content).join(' '), input.title.trim());
    const firstScreenY = Number(figure.svg.match(/data-screen="screen-01" transform="translate\([\d.]+ ([\d.]+)\)"/)?.[1]);
    assert.ok(Math.max(...header.map((line) => line.y)) + 40 < firstScreenY, 'header overlaps the screen title');
    const keyTitle = texts(figure.svg, 'notes').filter((line) => line.size === 10.5 && !line.content.includes('annotation') && line.content !== '0:00');
    assert.equal(keyTitle.map((line) => line.content).join(' '), longTitle);
  }
});

test('long screen titles and notes under screens are shown in full, and the next row starts below them', () => {
  const note = 'A long annotation about everything that happens on this screen and why it matters. '.repeat(8).trim();
  const [base] = pathway.steps as [PathwayStep];
  const [first] = pathway.screens as [PathwayScreen];
  const step = (index: number, notes: string): PathwayStep => ({
    ...base, step_id: `step-00${index}`, step_index: index, screen_id: `screen-0${index}`, timestamp_ms: index * 1000, notes,
  });
  const screen = (index: number, reachedFrom: string | null): PathwayScreen => ({
    ...first, id: `screen-0${index}`, index, title_step_id: `step-00${index}`, reached_from: reachedFrom, image_step_id: `step-00${index}`,
    visits: [{ visit: 1, step_ids: [`step-00${index}`], arrived_ms: index * 1000, time_on_screen_ms: 1000 }],
  });
  // Screen 2 continues the first row; screen 3, also reached from screen 1, starts the row below it.
  const branching: Pathway = {
    ...pathway, step_count: 3, screen_count: 3,
    steps: [step(1, ''), step(2, note), step(3, '')],
    screens: [screen(1, null), screen(2, 'screen-01'), screen(3, 'screen-01')],
  };
  const card = (svg: string, id: string) => {
    const match = svg.match(new RegExp(`<g id="${id}" data-screen="${id}" transform="translate\\(([\\d.]+) ([\\d.]+)\\)">([\\s\\S]*?)</g>`));
    assert.ok(match, id);
    const width = Number(match[3].match(/<rect width="([\d.]+)"/)?.[1]);
    return { top: Number(match[2]), width, lines: texts(`<g id="card">${match[3]}</g>`, 'card') };
  };
  for (const aspect of [390 / 844, 16 / 9]) {
    const figure = buildPathwayFigure({ ...input, pathway: branching, options: { notes: 'under', caption: true, times: true }, aspect });
    const noted = card(figure.svg, 'screen-02');
    const title = noted.lines.filter((line) => line.size === 12);
    const notes = noted.lines.filter((line) => line.size === 10.5);
    assert.equal(title.map((line) => line.content).join(' '), longTitle);
    assert.equal(notes.map((line) => line.content).join(' '), note);
    assert.ok(notes.length > 4, 'the note is long enough to have been cut before');
    for (const line of [...title, ...notes]) assert.ok(measure(line.content, line.size) <= noted.width + 0.1, `wider than the screen: ${line.content}`);
    const below = card(figure.svg, 'screen-03');
    const belowTitleTop = below.top + Math.min(...below.lines.filter((line) => line.size === 12).map((line) => line.y)) - 12;
    assert.ok(belowTitleTop > noted.top + Math.max(...notes.map((line) => line.y)), 'the next row overlaps the note');
    assert.ok(noted.top + Math.max(...notes.map((line) => line.y)) < figure.height);
  }
});

test('step numbers are marked for the pointer preview on the page only, never in a file', () => {
  const page = buildPathwayFigure({ ...input, peek: true });
  assert.match(page.svg, /<g data-peek="step-001">/);
  assert.match(page.svg, /<image data-screenshot="" xlink:href=/);
  assert.match(page.svg, /class="pathway-peek-tag" visibility="hidden"/);
  const file = buildPathwayFigure(input);
  for (const mark of ['data-peek', 'data-screenshot', 'pathway-peek-tag']) assert.ok(!file.svg.includes(mark), mark);
  // the preview adds nothing that moves the figure
  assert.equal(page.width, file.width);
  assert.equal(page.height, file.height);
});

test('SVG text escapes markup and removes characters forbidden in XML', () => {
  const figure = buildPathwayFigure({ ...input, title: 'Example\u0000 <script> & "quote"' });
  assert.ok(!figure.svg.includes('\u0000'));
  assert.ok(!figure.svg.includes('<script>'));
  assert.ok(figure.svg.includes('&lt;script&gt;'));
  assert.ok(figure.svg.includes('&amp;'));
});

test('fitted grids use the available width for phone and desktop recordings', () => {
  for (const aspect of [390 / 844, 16 / 9]) {
    for (const width of [938, 1194, 1354, 1834]) {
      const grid = fitStepGrid(width, aspect);
      assert.ok(Math.abs(grid.columns * grid.cardWidth + (grid.columns - 1) * 16 - width) < 0.001);
      assert.ok(grid.cardWidth >= 124);
    }
  }
});

function run(id: string, title = ''): RunDetail {
  // Only the fields the query depends on are needed for these cache transitions.
  return { summary: { id }, accepted_steps: [{}], candidates: [{ id: 'c1', title }] } as RunDetail;
}

test('a loading pathway never borrows a chart from a different run or grouping mode', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const loaded = pathwayQueryOptions(run('first'), 'screens', async () => pathway);
  await client.fetchQuery(loaded);
  const observer = new QueryObserver(client, loaded);
  const unsubscribe = observer.subscribe(() => {});
  const pending = () => new Promise<Pathway>(() => {});
  try {
    observer.setOptions(pathwayQueryOptions(run('second'), 'screens', pending));
    assert.equal(observer.getCurrentResult().data, undefined);
    observer.setOptions(loaded);
    observer.setOptions(pathwayQueryOptions(run('first'), 'steps', pending));
    assert.equal(observer.getCurrentResult().data, undefined);
    observer.setOptions(loaded);
    observer.setOptions(pathwayQueryOptions(run('first', 'Edited title'), 'screens', pending));
    assert.equal(observer.getCurrentResult().data, pathway);
    assert.equal(observer.getCurrentResult().isPlaceholderData, true);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test('the badge cites the DOI of all versions, which leads to the newest', () => {
  const figure = buildPathwayFigure(input);
  assert.ok(figure.svg.includes('doi.org/10.5281/zenodo.24159849'));
  assert.ok(!figure.svg.includes('zenodo.24159850'));
});

function threeScreens(extra: { rows?: Array<PathwayScreen['row_choice']>; phases?: Pathway['phases'] } = {}): Pathway {
  const [base] = pathway.steps as [PathwayStep];
  const [first] = pathway.screens as [PathwayScreen];
  const step = (index: number): PathwayStep => ({
    ...base, step_id: `step-00${index}`, step_index: index, screen_id: `screen-0${index}`, timestamp_ms: index * 1000,
    title: `Screen ${index}`, notes: '',
  });
  const screen = (index: number, reachedFrom: string | null): PathwayScreen => ({
    ...first, id: `screen-0${index}`, index, title: `Screen ${index}`, title_step_id: null, reached_from: reachedFrom,
    image_step_id: `step-00${index}`, row_choice: extra.rows?.[index - 1] ?? 'automatic',
    visits: [{ visit: 1, step_ids: [`step-00${index}`], arrived_ms: index * 1000, time_on_screen_ms: 1000 }],
  });
  // screens 2 and 3 are both reached from screen 1
  return {
    ...pathway, step_count: 3, screen_count: 3, steps: [step(1), step(2), step(3)],
    screens: [screen(1, null), screen(2, 'screen-01'), screen(3, 'screen-01')], phases: extra.phases ?? [],
  };
}

function rowOf(svg: string): Map<string, number> {
  return new Map([...svg.matchAll(/data-screen="([^"]+)" transform="translate\([\d.]+ ([\d.]+)\)"/g)].map((match) => [match[1], Number(match[2])]));
}

test('the reviewer decides which box carries on the row and which goes below', () => {
  const draw = (rows?: Array<PathwayScreen['row_choice']>) =>
    rowOf(buildPathwayFigure({ ...input, pathway: threeScreens({ rows }), options: { notes: 'hidden', caption: false, times: true } }).svg);
  const automatic = draw();
  assert.equal(automatic.get('screen-02'), automatic.get('screen-01'));
  assert.ok((automatic.get('screen-03') ?? 0) > (automatic.get('screen-01') ?? 0));

  const continued = draw(['automatic', 'automatic', 'continue']);
  assert.equal(continued.get('screen-03'), continued.get('screen-01'));
  assert.ok((continued.get('screen-02') ?? 0) > (continued.get('screen-01') ?? 0));

  // below: the next box reached from the same screen takes the row instead
  const below = draw(['automatic', 'below', 'automatic']);
  assert.equal(below.get('screen-03'), below.get('screen-01'));
  assert.ok((below.get('screen-02') ?? 0) > (below.get('screen-01') ?? 0));

  // a box alone below: nothing carries on the row
  const alone = draw(['automatic', 'below', 'below']);
  assert.ok((alone.get('screen-02') ?? 0) > (alone.get('screen-01') ?? 0));
  assert.ok((alone.get('screen-03') ?? 0) > (alone.get('screen-02') ?? 0));
});

test('a phase is a bracket over its boxes with its name and what it takes, above their titles', () => {
  const phase = {
    name: 'Sign up and verify the account with a long name', first_step_id: 'step-001', last_step_id: 'step-002',
    first_step_index: 1, last_step_index: 2, step_count: 2, screen_count: 2, screen_ids: ['screen-01', 'screen-02'],
    start_ms: 1000, end_ms: 3000, duration_ms: 2000,
  };
  for (const aspect of [390 / 844, 16 / 9]) {
    const figure = buildPathwayFigure({ ...input, aspect, pathway: threeScreens({ phases: [phase] }), options: { notes: 'hidden', caption: true, times: true } });
    const lines = texts(figure.svg, 'phases');
    const name = lines.filter((line) => line.size === 10.5).map((line) => line.content).join(' ');
    assert.equal(name, phase.name);
    assert.deepEqual(lines.filter((line) => line.size === 10).map((line) => line.content), ['2 steps on 2 screens, 0:02']);
    const rows = rowOf(figure.svg);
    const firstTop = rows.get('screen-01') ?? 0;
    // the bracket and its words sit above the titles of the row (a title is 12px, about 9px above the screenshot)
    const bracketY = Number(figure.svg.match(/<g id="phases">[\s\S]*?<path d="M[\d.]+ [\d.]+ V([\d.]+)/)?.[1]);
    assert.ok(bracketY < firstTop - 9 - 12, `bracket at ${bracketY}, screenshots at ${firstTop}`);
    for (const line of lines) assert.ok(line.y < bracketY && line.x + measure(line.content, line.size) <= figure.width - 48);
    assert.ok(texts(figure.svg, 'legend').some((line) => line.content.startsWith('phase of the walkthrough')));
  }
  // without phases, no bracket and nothing in the legend about them
  const plain = buildPathwayFigure({ ...input, pathway: threeScreens(), options: { notes: 'hidden', caption: true, times: true } });
  assert.ok(!plain.svg.includes('id="phases"'));
  assert.ok(!texts(plain.svg, 'legend').some((line) => line.content.startsWith('phase')));
});

test('a phase that goes on in another row is open where it breaks, and says continued there', () => {
  const phase = {
    name: 'Sign up', first_step_id: 'step-001', last_step_id: 'step-003', first_step_index: 1, last_step_index: 3,
    step_count: 3, screen_count: 3, screen_ids: ['screen-01', 'screen-02', 'screen-03'], start_ms: 1000, end_ms: 4000, duration_ms: 3000,
  };
  // screens 1 and 2 share a row; screen 3, also reached from screen 1, is a branch below
  const figure = buildPathwayFigure({ ...input, pathway: threeScreens({ phases: [phase] }), options: { notes: 'hidden', caption: false, times: false } });
  const lines = texts(figure.svg, 'phases').map((line) => line.content);
  assert.deepEqual(lines, ['Sign up', '3 steps on 3 screens', 'Sign up, continued']);
  const phases = figure.svg.match(/<g id="phases">([\s\S]*?)<\/g>/)?.[1] ?? '';
  // the first bracket runs on to the right, the second comes in from the left: a short dashed line at each break
  assert.equal([...phases.matchAll(/stroke-dasharray="2 2"/g)].length, 2);
  // in a file, the brackets are not marked for the pointer; on the page they can be clicked
  assert.ok(!phases.includes('data-phase'));
  const page = buildPathwayFigure({ ...input, peek: true, pathway: threeScreens({ phases: [phase] }), options: { notes: 'hidden', caption: false, times: false } });
  assert.equal([...page.svg.matchAll(/data-phase="0"/g)].length, 2);
  assert.ok(page.svg.includes('tabindex="0" role="button" aria-label="Screen 1"'));
});
