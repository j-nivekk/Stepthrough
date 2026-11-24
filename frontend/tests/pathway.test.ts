import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { BADGE_HEIGHT, BADGE_WIDTH } from '../src/lib/pathwayBadge';
import { BADGE_QR } from '../src/lib/pathwayBadgeData';
import { buildPathwayFigure, pathwayColumnsFor, pathwayFrameWidth, pathwayScale, type PathwayFigureInput } from '../src/lib/pathwayFigure';
import { pathwayQueryOptions } from '../src/lib/pathwayQuery';
import { fitStepGrid, galleryLayoutSizing, STEP_SIZE_MAX, STEP_SIZE_MIN } from '../src/lib/stepLayout';
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

function buildComplexPathway(): Pathway {
  const [base] = pathway.steps as [PathwayStep];
  const [first] = pathway.screens as [PathwayScreen];
  const screens: PathwayScreen[] = [];
  const steps: PathwayStep[] = [];
  let nextStep = 1;
  const addScreen = (index: number, reachedFrom: string | null, rowChoice: PathwayScreen['row_choice'] = 'automatic') => {
    const id = `screen-${String(index).padStart(2, '0')}`;
    const stepId = `step-${String(nextStep).padStart(3, '0')}`;
    steps.push({
      ...base,
      step_id: stepId,
      step_index: nextStep,
      screen_id: id,
      timestamp_ms: nextStep * 1000,
      title: `Screen ${index}`,
      notes: '',
      source_candidate_id: `c${nextStep}`,
    });
    screens.push({
      ...first,
      id,
      index,
      title: `Screen ${index}`,
      title_step_id: null,
      reached_from: reachedFrom,
      image_step_id: stepId,
      row_choice: rowChoice,
      visits: [{ visit: 1, step_ids: [stepId], arrived_ms: nextStep * 1000, time_on_screen_ms: 1000 }],
    });
    nextStep += 1;
    return id;
  };

  // Row 0: S1 -> S2 -> S3 -> S4 -> S5
  const s1 = addScreen(1, null);
  const s2 = addScreen(2, s1);
  const s3 = addScreen(3, s2);
  const s4 = addScreen(4, s3);
  const s5 = addScreen(5, s4);
  // Row 1 (branch 1 from S2): S6 -> S7
  const s6 = addScreen(6, s2, 'below');
  const s7 = addScreen(7, s6);
  // Row 2 (branch 2 from S2): S8 -> S9
  const s8 = addScreen(8, s2, 'below');
  const s9 = addScreen(9, s8);
  // Row 3 (branch 3 from S2): S10 -> S11
  const s10 = addScreen(10, s2, 'below');
  const s11 = addScreen(11, s10);

  let passStep = 20;
  const transition = (from: string, to: string, kind: 'forward' | 'return' = 'forward') => ({
    from_screen: from,
    to_screen: to,
    kind,
    passes: [{ step_id: `step-${passStep}`, step_index: passStep++, timestamp_ms: passStep * 1000, transition_type: 'tap' }],
  });

  return {
    ...pathway,
    step_count: steps.length,
    screen_count: screens.length,
    steps,
    screens,
    transitions: [
      transition(s1, s2),
      transition(s2, s3),
      transition(s3, s4),
      transition(s4, s5),
      // Long same-row forward detour (4 columns wide)
      transition(s1, s5, 'forward'),
      // Three distinct branches from S2
      transition(s2, s6),
      transition(s6, s7),
      transition(s2, s8),
      transition(s8, s9),
      transition(s2, s10),
      transition(s10, s11),
      // Adjacent-row return (row 1 -> row 0)
      transition(s7, s3, 'return'),
      // Distant multi-row return (row 3 -> row 0, 3 rows apart -> paired portal chips)
      transition(s11, s1, 'return'),
    ],
  };
}

function moveGroup(svg: string, id: string): string {
  const start = svg.indexOf(`<g id="${id}"`);
  if (start < 0) return '';
  let depth = 0;
  let pos = start;
  const tag = /<\/?g(?:\s|>)/g;
  tag.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(svg))) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return svg.slice(start, match.index + 4);
    } else {
      depth += 1;
    }
    pos = tag.lastIndex;
  }
  return svg.slice(start, pos);
}

test('complex multi-row pathways separate branches, detours and returns with halos, distinct gutters, and paired jump chips', () => {
  const complex = buildComplexPathway();
  const page = buildPathwayFigure({ ...input, pathway: complex, options: { notes: 'hidden', caption: true, times: false }, aspect: 390 / 844, peek: true });
  const file = buildPathwayFigure({ ...input, pathway: complex, options: { notes: 'hidden', caption: true, times: false }, aspect: 390 / 844, peek: false });

  // Encodings metadata reflects all active visual encodings.
  assert.deepEqual(page.encodings, { hasBranch: true, hasReturn: true, hasPortal: true, hasPopup: false });

  // Semantic colours and white crossing halos exist in both page and export SVGs.
  assert.ok(file.svg.includes('stroke="#a44d10"'), 'branch / detour colour missing');
  assert.ok(file.svg.includes('stroke="#2c5f8a"'), 'return colour missing');
  assert.ok(file.svg.includes('class="pathway-move-halo"'), 'white crossing halo missing');

  // The three branch elbows leaving screen-02 must use distinct vertical gutter X coordinates so stems never stack.
  const elbowXs = [6, 8, 10].map((idx) => {
    const id = `move-screen-02-screen-${String(idx).padStart(2, '0')}`;
    const group = moveGroup(file.svg, id);
    // First horizontal segment ends at the elbow's vertical gutter X: M<x0> <y0> L<gx-r> <y0> Q<gx> <y0>
    const gutter = group.match(/Q([\d.]+) [\d.]+ [\d.]+ [\d.]+/);
    assert.ok(gutter, `expected elbow curve for ${id}`);
    return Number(gutter[1]);
  });
  assert.equal(new Set(elbowXs).size, 3, `expected 3 distinct gutter X positions, got ${elbowXs.join(', ')}`);

  // Distant 3-row return (screen-11 -> screen-01) uses paired jump chips (→ S1 and S11 →) with click-to-jump on page only.
  const portalPage = moveGroup(page.svg, 'move-screen-11-screen-01-ret');
  assert.ok(portalPage.includes('→ S1'), 'missing departure jump chip → S1');
  assert.ok(portalPage.includes('S11 →'), 'missing arrival jump chip S11 →');
  assert.ok(portalPage.includes('data-jump-to="screen-01"'), 'missing clickable departure jump target');
  assert.ok(portalPage.includes('data-jump-to="screen-11"'), 'missing clickable arrival jump target');

  // Exported file omits all interactive attributes and keeps identical geometry.
  for (const interactiveMark of ['data-move', 'data-jump-to', 'pathway-move-hit', 'pathway-jump-chip']) {
    assert.ok(!file.svg.includes(interactiveMark), `export SVG should not contain ${interactiveMark}`);
  }
  assert.equal(page.width, file.width);
  assert.equal(page.height, file.height);

  // Legend stays inside bounds and explains branches, returns, and jump tags.
  const legendTexts = texts(file.svg, 'legend');
  assert.ok(legendTexts.some((t) => t.content.includes('branch or detour')), 'legend missing branch/detour entry');
  assert.ok(legendTexts.some((t) => t.content.includes('return')), 'legend missing return entry');
  assert.ok(legendTexts.some((t) => t.content.includes('jump across rows')), 'legend missing jump entry');
  for (const line of legendTexts) {
    const right = line.x + measure(line.content, line.size) * (line.centered ? 0.5 : 1);
    assert.ok(right <= file.width - 48 + 0.1, `legend overflows: ${line.content}`);
  }
});

test('wrapped multi-row pathways label both ends on 1-row wraps and stay inside bounds on multi-row wraps', () => {
  const [base] = pathway.steps as [PathwayStep];
  const [first] = pathway.screens as [PathwayScreen];
  const screens: PathwayScreen[] = [];
  const steps: PathwayStep[] = [];
  const transitions: Pathway['transitions'] = [];
  // Three screens per row:
  // Row 0: S1 -> S2 -> S3; Row 1: branch S5 below S2; Row 2: S4 (2-row wrap from S3) -> S6 -> S7; Row 3: S8 (1-row wrap from S7) -> S9.
  const add = (index: number, reachedFrom: string | null, rowChoice: PathwayScreen['row_choice'] = 'automatic') => {
    const id = `screen-${String(index).padStart(2, '0')}`;
    const stepId = `step-${String(index).padStart(3, '0')}`;
    steps.push({
      ...base,
      step_id: stepId,
      step_index: index,
      screen_id: id,
      timestamp_ms: index * 1000,
      title: `Screen ${index}`,
      notes: '',
      source_candidate_id: `c${index}`,
    });
    screens.push({
      ...first,
      id,
      index,
      title: `Screen ${index}`,
      title_step_id: null,
      reached_from: reachedFrom,
      image_step_id: stepId,
      row_choice: rowChoice,
      visits: [{ visit: 1, step_ids: [stepId], arrived_ms: index * 1000, time_on_screen_ms: 1000 }],
    });
    if (reachedFrom) {
      transitions.push({
        from_screen: reachedFrom,
        to_screen: id,
        kind: 'forward',
        passes: [{ step_id: stepId, step_index: index, timestamp_ms: index * 1000, transition_type: 'tap' }],
      });
    }
    return id;
  };
  const s1 = add(1, null);
  const s2 = add(2, s1);
  const s3 = add(3, s2);
  const s4 = add(4, s3);
  add(5, s2, 'below');
  const s6 = add(6, s4);
  const s7 = add(7, s6);
  const s8 = add(8, s7);
  add(9, s8);

  const wrapped: Pathway = { ...pathway, step_count: steps.length, screen_count: screens.length, steps, screens, transitions };
  const figure = buildPathwayFigure({ ...input, pathway: wrapped, aspect: 16 / 9, columns: 3, options: { notes: 'hidden', caption: true, times: false }, peek: true });

  // S3 -> S4 wraps across 2 rows (row 0 -> row 2) so it uses paired wrap-portal chips.
  const multiWrap = moveGroup(figure.svg, 'move-screen-03-screen-04');
  assert.ok(multiWrap.includes('→ S4'), 'multi-row wrap missing departure chip → S4');
  assert.ok(multiWrap.includes('S3 →'), 'multi-row wrap missing arrival chip S3 →');

  // S7 -> S8 wraps 1 row (row 2 -> row 3) so it draws a continuous wrap wire with both endpoint chips.
  const singleWrap = moveGroup(figure.svg, 'move-screen-07-screen-08');
  assert.ok(singleWrap.includes('→ S8'), '1-row wrap missing departure label → S8');
  assert.ok(singleWrap.includes('S7 →'), '1-row wrap missing arrival label S7 →');
  assert.ok(singleWrap.includes('class="pathway-move-halo"'), '1-row wrap missing halo');

  // Every text in #moves stays inside [0, figure.width].
  const movesMarkup = moveGroup(figure.svg, 'moves');
  for (const line of texts(movesMarkup, 'moves')) {
    const left = line.x - (line.centered ? measure(line.content, line.size) / 2 : 0);
    const right = line.x + measure(line.content, line.size) * (line.centered ? 0.5 : 1);
    assert.ok(left >= -1, `move label clips left edge (${left}): ${line.content}`);
    assert.ok(right <= figure.width + 1, `move label clips right edge (${right} > ${figure.width}): ${line.content}`);
  }
});

test('renamed screens display a compact S# badge with their title while untitled screens do not duplicate it', () => {
  const renamed = threeScreens();
  renamed.screens[1] = { ...renamed.screens[1], title: 'Gemini reply', title_step_id: 'step-002' };
  renamed.screens[2] = { ...renamed.screens[2], title: 'Authentication flow', title_step_id: 'step-003' };
  const figure = buildPathwayFigure({ ...input, pathway: renamed, options: { notes: 'hidden', caption: false, times: false }, aspect: 390 / 844 });

  const s1 = moveGroup(figure.svg, 'screen-01');
  const s2 = moveGroup(figure.svg, 'screen-02');
  const s3 = moveGroup(figure.svg, 'screen-03');

  // Untitled Screen 1 already says "Screen 1" and does not add a redundant S1 pill.
  assert.ok(!s1.includes('>S1</text>'), 'untitled screen should not duplicate S1 badge');
  assert.ok(s1.includes('>Screen 1</text>'));

  // Renamed screens carry compact S2 / S3 badges alongside their custom titles, staying within card bounds.
  assert.ok(s2.includes('>S2</text>'), 'renamed screen-02 missing S2 badge');
  assert.ok(s2.includes('>Gemini reply</text>'), 'renamed screen-02 missing custom title');
  assert.ok(s3.includes('>S3</text>'), 'renamed screen-03 missing S3 badge');
  assert.ok(s3.includes('>Authentication</text>') || s3.includes('>Authentication flow</text>'));

  // First line of screen-02 title starts to the right of the S2 badge and stays inside the card width.
  const cardWidth = Number(s2.match(/<rect width="([\d.]+)"/)?.[1]);
  const s2Texts = texts(`<g id="card">${s2}</g>`, 'card');
  const titleLine = s2Texts.find((line) => line.size === 12);
  assert.ok(titleLine, 'screen-02 title text missing');
  assert.ok(titleLine.x >= 25, `expected title line indented after S2 badge, got x=${titleLine.x}`);
  assert.ok(titleLine.x + measure(titleLine.content, 12) <= cardWidth + 0.1, 'title line overflows card width');
});

test('the pathway badge uses a compact 72px height and simpler Version 2 (25x25) QR matrix', () => {
  assert.equal(BADGE_HEIGHT, 72);
  assert.ok(BADGE_WIDTH > 150 && BADGE_WIDTH < 210, `unexpected badge width: ${BADGE_WIDTH}`);
  assert.equal(BADGE_QR.length, 25);
  assert.ok(BADGE_QR.every((row) => row.length === 25));
});

test('gallery layout sizing adapts cleanly to fit mode, slider range, and portrait/landscape aspects', () => {
  const fitPhone = galleryLayoutSizing(null, 390 / 844);
  assert.match(fitPhone.stageHeightCss, /^clamp\(/);
  assert.ok(fitPhone.thumbWidth >= 42 && fitPhone.thumbHeight >= 60);

  const minDesktop = galleryLayoutSizing(STEP_SIZE_MIN, 16 / 9);
  const maxDesktop = galleryLayoutSizing(STEP_SIZE_MAX, 16 / 9);
  assert.ok(parseInt(maxDesktop.stageHeightCss, 10) > parseInt(minDesktop.stageHeightCss, 10));
  assert.ok(maxDesktop.thumbHeight > minDesktop.thumbHeight);
  assert.ok(maxDesktop.thumbWidth <= 184);
});

/** A pathway of screens `[index, reached from]` (a tree), with a forward move along each edge. */
function treePathway(tree: Array<[number, number | null]>): Pathway {
  const [base] = pathway.steps as [PathwayStep];
  const [first] = pathway.screens as [PathwayScreen];
  const id = (index: number) => `screen-${String(index).padStart(2, '0')}`;
  const steps = tree.map(([index]): PathwayStep => ({
    ...base, step_id: `step-${index}`, step_index: index, screen_id: id(index), timestamp_ms: index * 1000,
    title: `Screen ${index}`, notes: '', source_candidate_id: `c${index}`,
  }));
  const screens = tree.map(([index, from]): PathwayScreen => ({
    ...first, id: id(index), index, title: `Screen ${index}`, title_step_id: null, reached_from: from === null ? null : id(from),
    image_step_id: `step-${index}`, row_choice: 'automatic',
    visits: [{ visit: 1, step_ids: [`step-${index}`], arrived_ms: index * 1000, time_on_screen_ms: 1000 }],
  }));
  const transitions = tree
    .filter(([, from]) => from !== null)
    .map(([index, from]) => ({
      from_screen: id(from as number), to_screen: id(index), kind: 'forward' as const,
      passes: [{ step_id: `step-${index}`, step_index: index, timestamp_ms: index * 1000, transition_type: 'tap' }],
    }));
  return { ...pathway, step_count: steps.length, screen_count: screens.length, steps, screens, transitions, phases: [] };
}

test('the long way on keeps the row and a short side trip goes right below it', () => {
  // S2 leads to a short trip (S3, S4) first in time, and later to the long rest of the walkthrough (S5 to S9).
  const draw = treePathway([[1, null], [2, 1], [3, 2], [4, 3], [5, 2], [6, 5], [7, 6], [8, 7], [9, 8]]);
  const layout = (pathway: Pathway) =>
    rowOf(buildPathwayFigure({ ...input, pathway, columns: 3, options: { notes: 'hidden', caption: false, times: true } }).svg);
  const rows = layout(draw);
  const row = (index: number) => rows.get(`screen-${String(index).padStart(2, '0')}`) ?? 0;
  assert.equal(row(5), row(1), 'the long way on stays on the row');
  assert.ok(row(3) > row(1), 'the side trip goes below');
  assert.ok(row(4) < row(6), 'the side trip comes right below, before the rest of the long way on');
  assert.ok(row(9) > row(6));

  // what the server worked out wins: here it keeps the side trip on the row
  const told = { ...draw, screens: draw.screens.map((screen) => ({ ...screen, continues_with: screen.id === 'screen-02' ? 'screen-03' : undefined })) };
  const toldRows = layout(told);
  assert.equal(toldRows.get('screen-03'), toldRows.get('screen-01'));
  assert.ok((toldRows.get('screen-05') ?? 0) > (toldRows.get('screen-01') ?? 0));
});

test('a branch of a box at the end of a row starts a row of its own, drawn as a branch', () => {
  // Two columns: S2 ends the row; S3 carries the main path on (S3 to S6), S7 is a branch of S2.
  const draw = treePathway([[1, null], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 2]]);
  const figure = buildPathwayFigure({ ...input, pathway: draw, columns: 2, options: { notes: 'hidden', caption: false, times: true } });
  const rows = rowOf(figure.svg);
  assert.ok((rows.get('screen-07') ?? 0) < (rows.get('screen-03') ?? 0), 'the short branch comes first');
  const branch = moveGroup(figure.svg, 'move-screen-02-screen-07');
  const main = moveGroup(figure.svg, 'move-screen-02-screen-03');
  assert.ok(branch.includes('#a44d10'), 'the branch line and its chips are in the branch colour');
  assert.ok(!main.includes('#a44d10'), 'the row going on stays in ink');
  assert.ok(figure.encodings.hasPortal && figure.encodings.hasBranch);
});

/** A long pathway in one line, as a desktop recording has. */
const line = (count: number) => treePathway(Array.from({ length: count }, (_, index): [number, number | null] => [index + 1, index ? index : null]));
const DESKTOP = 3248 / 2122;
const columnsFor = (draw: Pathway, space: number, zoom: number | null = null) =>
  pathwayColumnsFor({ pathway: draw, options: input.options, aspect: DESKTOP }, space, zoom);
const placesIn = (svg: string) =>
  new Map([...svg.matchAll(/data-screen="([^"]+)"[^>]* transform="translate\(([\d.]+) ([\d.]+)\)"/g)].map((match) => [match[1], { x: Number(match[2]), y: Number(match[3]) }]));

test('fitted to the page, a row takes as many boxes as fit with little shrinking, and a file made there the same', () => {
  const draw = line(12);
  const usual = buildPathwayFigure({ ...input, pathway: draw, aspect: DESKTOP });
  for (const space of [1000, 1340, 1600, 2400]) {
    const columns = columnsFor(draw, space);
    assert.ok(columns >= 2);
    const page = buildPathwayFigure({ ...input, pathway: draw, aspect: DESKTOP, columns, peek: true });
    assert.ok(space / page.width >= 0.78, `${space}: the figure is ${page.width} wide, shrunk below 78%`);
    assert.equal(pathwayScale(page.width, space), Math.min(1, space / page.width));
    // a file of it has the same rows and size, without what the page adds to its markup
    const file = buildPathwayFigure({ ...input, pathway: draw, aspect: DESKTOP, columns });
    assert.deepEqual([file.width, file.height], [page.width, page.height]);
    assert.deepEqual(placesIn(file.svg), placesIn(page.svg));
    assert.equal(placesIn(page.svg).size, 12);
    assert.ok(!file.svg.includes('data-peek'));
    // and it uses the space: one more column would not fit
    const wider = buildPathwayFigure({ ...input, pathway: draw, aspect: DESKTOP, columns: columns + 1, peek: true });
    assert.ok(space / wider.width < 0.78 || columns + 1 > 12, `${space}: room for ${columns + 1} columns`);
  }
  assert.ok(columnsFor(draw, 1340) < columnsFor(draw, 2400));
  assert.equal(columnsFor(line(3), 2400), 3, 'never more than there are boxes');
  // the times under the screens are a size up from the other small labels
  assert.ok(usual.svg.includes('font-size="11" fill="#4a4a45"'));
});

test('at a chosen size a row takes as many boxes as fit at about that size; beyond 100% the rows stay', () => {
  const draw = line(40);
  for (const space of [760, 1000, 1180, 1340, 1700]) {
    let before = 0;
    for (let percent = 100; percent >= 25; percent -= 5) {
      const zoom = percent / 100;
      const columns = columnsFor(draw, space, zoom);
      assert.ok(columns >= before, `${space} at ${percent}%: never fewer when smaller`);
      before = columns;
      const figure = buildPathwayFigure({ ...input, pathway: draw, aspect: DESKTOP, columns, peek: true });
      const scale = pathwayScale(figure.width, space, zoom);
      assert.ok(scale <= zoom && scale > zoom * 0.95, `${space} at ${percent}%: shown at ${scale}`);
      // it fits without scrolling sideways, unless not even two boxes do
      assert.ok(columns === 2 || figure.width * scale <= space + 0.01, `${space} at ${percent}%: ${columns} boxes make ${figure.width * scale}`);
      const wider = buildPathwayFigure({ ...input, pathway: draw, aspect: DESKTOP, columns: columns + 1, peek: true });
      assert.ok(wider.width * zoom > space * 1.05, `${space} at ${percent}%: room for ${columns + 1}`);
    }
    for (const zoom of [1.25, 1.5]) {
      assert.equal(columnsFor(draw, space, zoom), columnsFor(draw, space, 1), `${space} at ${zoom}: looking closer moves nothing`);
      assert.equal(pathwayScale(2000, space, zoom), zoom);
    }
  }
});

test('a return the reviewer added is drawn dashed with "back" on it, and the key says what that is', () => {
  // S1 -> S2 -> S3, then back to S2 without a step, and on to S4 and S5
  const base = treePathway([[1, null], [2, 1], [3, 2], [4, 2], [5, 4]]);
  const added = {
    from_screen: 'screen-03', to_screen: 'screen-02', kind: 'return',
    passes: [{ step_id: null, step_index: null, from_step_id: 'step-3', at_ms: null, origin: 'researcher' }],
  };
  const draw = { ...base, transitions: [...base.transitions, added] } as Pathway;
  const figure = (pathway: Pathway, peek = true, caption = true) =>
    buildPathwayFigure({ ...input, pathway, columns: 4, peek, options: { notes: 'hidden', caption, times: false } }).svg;
  const svg = figure(draw);
  const back = moveGroup(svg, 'move-screen-03-screen-02-ret');
  assert.ok(back.includes('>back</text>') && back.includes('stroke-dasharray'), back);
  assert.match(svg, /id="move-screen-03-screen-02-ret"[^>]* data-steps=""[^>]* data-added=""/);
  assert.ok(svg.includes('return without a step, added by the reviewer'));
  // the other moves keep their numbers, and say nothing of it
  assert.ok(moveGroup(svg, 'move-screen-02-screen-03').includes('>3</text>'));
  assert.equal(svg.match(/data-added/g)?.length, 1);
  assert.ok(!figure(base).includes('data-added') && !figure(base).includes('added by the reviewer'));
  // a file has the same, without what only the page needs
  const file = figure(draw, false);
  assert.ok(file.includes('>back</text>') && !file.includes('data-added'));

  // a move made both ways: once with a step, once without
  const both = { ...draw, transitions: [...base.transitions, { ...added, passes: [{ step_id: 'step-5', step_index: 5, from_step_id: 'step-4', at_ms: 5000, origin: 'recorded' }, ...added.passes] }] } as Pathway;
  const twice = figure(both);
  assert.match(twice, /id="move-screen-03-screen-02-ret"[^>]* data-steps="5"[^>]* data-added=""/);
  const labels = [...moveGroup(twice, 'move-screen-03-screen-02-ret').matchAll(/>(\d+|back)<\/text>/g)].map((match) => match[1]);
  assert.deepEqual(labels.slice(0, 2), ['5', 'back']);
});

test('laying a figure out to see how wide it is gives the width it is drawn at', () => {
  const branches = treePathway([[1, null], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7], [9, 1], [10, 9], [11, 10], [12, 3], [13, 12], [14, 13], [15, 14]]);
  for (const draw of [line(40), branches, line(1)]) {
    for (let columns = 2; columns <= 12; columns += 1) {
      const figure = { ...input, pathway: draw, aspect: DESKTOP, columns, peek: true };
      const laidOut = buildPathwayFigure({ ...figure, widthOnly: true });
      assert.equal(laidOut.width, buildPathwayFigure(figure).width, `${columns} columns`);
      assert.equal(laidOut.svg, '');
    }
  }
});

test('between two boxes there is room for the numbers of the line, also beside a branch that runs down past it', () => {
  // the main row S1 to S8; S9 to S11 branch from S1, S12 to S15 from S3: that branch runs down past the line S10 -> S11
  const draw = treePathway([[1, null], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7], [9, 1], [10, 9], [11, 10], [12, 3], [13, 12], [14, 13], [15, 14]]);
  // the line S5 -> S6 is taken five times, so it has four numbers on it
  const busy = draw.transitions.find((move) => move.from_screen === 'screen-05' && move.to_screen === 'screen-06');
  assert.ok(busy);
  busy.passes = [106, 121, 136, 151, 166].map((step) => ({ ...busy.passes[0], step_id: `busy-${step}`, step_index: step }));
  const figure = buildPathwayFigure({ ...input, pathway: draw, aspect: DESKTOP, columns: 8, options: { notes: 'hidden', caption: false, times: false } });
  const places = placesIn(figure.svg);
  const width = pathwayFrameWidth(DESKTOP);
  const id = (index: number) => `screen-${String(index).padStart(2, '0')}`;
  const at = (index: number) => places.get(id(index)) ?? { x: 0, y: 0 };
  const numbers = (from: number, to: number) => {
    const rects = [...moveGroup(figure.svg, `move-${id(from)}-${id(to)}`).matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="15"/g)];
    const left = Math.min(...rects.map((match) => Number(match[1])));
    const right = Math.max(...rects.map((match) => Number(match[1]) + Number(match[2])));
    return { left, right, count: rects.length };
  };
  for (const [from, to] of [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [12, 13], [13, 14], [14, 15]]) {
    const { left, right, count } = numbers(from, to);
    assert.ok(count >= 1);
    assert.ok(left >= at(from).x + width + 16, `S${from} -> S${to}: line before the numbers`);
    assert.ok(right <= at(to).x - 16, `S${from} -> S${to}: line and arrowhead after the numbers`);
  }
  assert.equal(numbers(5, 6).count, 4);
  // only the gap that needs it is wider
  const gap = (from: number, to: number) => at(to).x - at(from).x - width;
  assert.ok(gap(5, 6) > gap(1, 2) + 40 && gap(6, 7) === 72 && gap(4, 5) === 72, [gap(1, 2), gap(4, 5), gap(5, 6), gap(6, 7)].join());

  // the branch S3 -> S12 and the line S10 -> S11 share a gap: its numbers are clear of the branch
  assert.ok(at(10).y > at(3).y && at(10).y < at(12).y && at(10).x === at(3).x);
  const trunk = Number(/Q([\d.]+) /.exec(moveGroup(figure.svg, `move-${id(3)}-${id(12)}`))?.[1]);
  assert.ok(trunk > at(3).x + width && numbers(10, 11).left >= trunk + 6, `branch at ${trunk}, numbers from ${numbers(10, 11).left}`);
  const branch = numbers(3, 12);
  assert.ok(branch.left >= trunk + 6 && branch.right <= at(12).x - 16);
});

test('with the optional detours left out, the numbers count on along the main way and the counts leave them out', () => {
  // S1 is the opening screen; S2 -> S3 is a trip that comes back, S2 -> S4 -> S5 the main way
  const base = treePathway([[1, null], [2, 1], [3, 2], [4, 2], [5, 4]]);
  const ways = ['0', '1', '1a', '2', '3'];
  const steps = base.steps.map((step, index) => ({ ...step, step_index: index, path_step: ways[index], detour: index === 2 }));
  const phase = { name: 'browse', first_step_id: 'step-1', last_step_id: 'step-5', first_step_index: 0, last_step_index: 4,
    step_count: 4, screen_count: 5, main_step_count: 3, main_screen_count: 4, screen_ids: steps.map((step) => step.screen_id),
    start_ms: 1000, end_ms: null, duration_ms: null };
  const draw = { ...base, steps, phases: [phase], step_count: 4, main_step_count: 3, main_screen_count: 4 } as Pathway;
  const figure = (countDetours?: boolean) =>
    buildPathwayFigure({ ...input, pathway: draw, columns: 4, options: { notes: 'hidden', caption: true, times: false, countDetours } }).svg;
  // the numbers under the boxes and on the lines, without those of the key
  const numbers = (svg: string, part: string) =>
    [...(new RegExp(`<g id="${part}">.*?(?=<g id="(?:screens|legend|notes|phases)"|<line id="rule"|$)`, 's').exec(svg)?.[0] ?? '')
      .matchAll(/font-weight="700"[^>]*>(start|\d+[a-z]*)<\/text>/g)].map((match) => match[1]);

  const counted = figure();
  assert.deepEqual(numbers(counted, 'screens').sort(), ['1', '2', '3', '4', 'start']);
  assert.deepEqual(numbers(counted, 'moves').sort(), ['1', '2', '3', '4']);
  assert.ok(counted.includes('4 steps on 5 screens'), 'the phase counts every step');
  assert.ok(!counted.includes('optional detour'));
  assert.ok(counted.includes('step number, as in steps.csv'));

  const leftOut = figure(false);
  assert.deepEqual(numbers(leftOut, 'screens').sort(), ['1', '1a', '2', '3', 'start'], 'no gap, and the last number is the count');
  assert.deepEqual(numbers(leftOut, 'moves').sort(), ['1', '1a', '2', '3']);
  assert.ok(leftOut.includes('3 steps on 4 screens'), "the phase's counts leave the trip out");
  assert.ok(leftOut.includes('step of an optional detour, after step 1'), 'the key says what the letter means');
  assert.ok(leftOut.includes('(path_step in steps.csv)'), 'and where to find these numbers');
  // the opening screen has a key of its own, and none without it
  assert.ok(leftOut.includes('opening screen (step 0)') && counted.includes('opening screen (step 0)'));
  const later = buildPathwayFigure({ ...input, pathway: base, columns: 4 }).svg;
  assert.ok(!later.includes('opening screen (step 0)') && !later.includes('>start<'));
});

test('the steps on one screen: the start stands apart, and a visit splits where it goes from a detour to the main way', () => {
  // all on one screen: the opening screen, two steps, then the step that comes back from a trip and two more
  const base = treePathway([[1, null], [2, 1]]);
  const [home, trip] = base.screens;
  const step = (index: number, screen: PathwayScreen, way: string, visit = 1) => ({
    ...base.steps[0], step_id: `step-${index}`, step_index: index, screen_id: screen.id, path_step: way, detour: /[a-z]/.test(way), visit, timestamp_ms: index * 1000,
  });
  const steps = [step(0, home, '0'), step(1, home, '1'), step(2, home, '2'), step(3, trip, '2a'), step(4, trip, '2b'), step(5, home, '2c', 2), step(6, home, '3', 2), step(7, home, '4', 2)];
  const visit = (number: number, ids: number[]) => ({ visit: number, step_ids: ids.map((id) => `step-${id}`), arrived_ms: ids[0] * 1000, time_on_screen_ms: 1000 });
  const screens = [
    { ...home, image_step_id: 'step-0', visits: [visit(1, [0, 1, 2]), visit(2, [5, 6, 7])] },
    { ...trip, image_step_id: 'step-3', visits: [visit(1, [3, 4])] },
  ];
  const pass = (index: number) => ({ step_id: `step-${index}`, step_index: index, from_step_id: `step-${index - 1}`, at_ms: index * 1000, transition_type: 'tap' });
  const draw = {
    ...base, steps, screens, transitions: [
      { from_screen: home.id, to_screen: trip.id, kind: 'forward', passes: [pass(3)] },
      { from_screen: trip.id, to_screen: home.id, kind: 'return', passes: [pass(5)] },
    ],
  } as Pathway;
  const peeks = (countDetours: boolean) =>
    [...buildPathwayFigure({ ...input, pathway: draw, peek: true, options: { notes: 'hidden', caption: false, times: false, countDetours } }).svg
      .matchAll(/<g data-peek="([^"]+)">.*?>([^<]+)<\/text><\/g>/g)].map((match) => [match[2], match[1].split(' ').length]);
  assert.deepEqual(peeks(true), [['start', 1], ['1–2', 2], ['5–7', 3], ['3–4', 2]]);
  assert.deepEqual(peeks(false), [['start', 1], ['1–2', 2], ['2c', 1], ['3–4', 2], ['2a–b', 2]]);
});
