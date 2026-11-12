import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { buildPathwayFigure, type PathwayFigureInput } from '../src/lib/pathwayFigure';
import { pathwayQueryOptions } from '../src/lib/pathwayQuery';
import { fitStepGrid } from '../src/lib/stepLayout';
import type { Pathway, RunDetail } from '../src/types';

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
