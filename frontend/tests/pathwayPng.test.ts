import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { buildPathwayFigure } from '../src/lib/pathwayFigure';
import { PNG_SCALE, pngScale, pngSvg, setPngResolution, usesItalic } from '../src/lib/pathwayPng';
import type { Pathway } from '../src/types';

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 1 × 1 white PNG, with the chunks given after its header. */
function png(...extra: Buffer[]): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...extra,
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))),
    chunk('IEND', new Uint8Array()),
  ]));
}

function chunks(bytes: Uint8Array): Array<{ type: string; data: Buffer; crcOk: boolean }> {
  const buffer = Buffer.from(bytes);
  const found = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const crcOk = buffer.readUInt32BE(offset + 8 + length) === crc32(buffer.subarray(offset + 4, offset + 8 + length));
    found.push({ type, data, crcOk });
    offset += 12 + length;
  }
  return found;
}

test('a figure is drawn at twice its size, or as large as a canvas allows', () => {
  assert.equal(pngScale(1700, 2400), PNG_SCALE);
  for (const [width, height] of [[1700, 9000], [1700, 40_000], [30_000, 400]]) {
    const scale = pngScale(width, height);
    assert.ok(scale < PNG_SCALE && scale > 0);
    assert.ok(Math.round(width * scale) * Math.round(height * scale) <= 4096 * 4096, `${width} × ${height}`);
    assert.ok(width * scale <= 16_384 && height * scale <= 16_384);
  }
});

test('the PNG records its resolution right after its header, replacing one the browser wrote', () => {
  const physOf = (bytes: Uint8Array) => chunks(bytes).filter((item) => item.type === 'pHYs');
  for (const source of [png(), png(chunk('pHYs', new Uint8Array([0, 0, 11, 19, 0, 0, 11, 19, 1])))]) {
    const result = setPngResolution(source, 192);
    const list = chunks(result);
    assert.deepEqual(list.map((item) => item.type), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
    assert.ok(list.every((item) => item.crcOk));
    const [phys] = physOf(result);
    assert.equal(phys.data.readUInt32BE(0), 7559); // 192 dpi in pixels per metre
    assert.equal(phys.data.readUInt32BE(4), 7559);
    assert.equal(phys.data[8], 1);
  }
  const notPng = new Uint8Array([1, 2, 3]);
  assert.equal(setPngResolution(notPng, 192), notPng);
});

test('the SVG to draw is scaled and carries the fonts, without changing the drawing', () => {
  const pathway: Pathway = {
    format: 'stepthrough.pathway/1', detail: 'screens', step_count: 1, screen_count: 1, field_notes: {},
    steps: [{ step_id: 'step-001', step_index: 1, screen_id: 'screen-01', visit: 1, timestamp_ms: 0,
      timestamp_tc: '00:00:00.000', title: 'Home', notes: '', transition_type: 'opening_screen', time_on_screen_ms: 1000,
      image_path: 'frame.png', image_url: '/frame.png', grouped_by: null, screen_choice: 'automatic',
      kind_choice: 'automatic', source_candidate_id: 'c1' }],
    screens: [{ id: 'screen-01', index: 1, title: 'Home', title_step_id: 'step-001', kind: 'popup',
      reached_from: null, image_step_id: 'step-001', time_on_screen_ms: 1000,
      visits: [{ visit: 1, step_ids: ['step-001'], arrived_ms: 0, time_on_screen_ms: 1000 }] }],
    transitions: [],
  };
  const figure = buildPathwayFigure({
    pathway, options: { notes: 'under', caption: true, times: true }, aspect: 16 / 9, title: 'recording.mp4',
    subtitle: 'project', date: '2026-11-14', version: '1.1.1', imageFor: () => 'data:image/jpeg;base64,AA==',
    measure: (text, size) => text.length * size * 0.6,
  });
  assert.ok(usesItalic(figure.svg), 'a pop-up is labelled in italics');
  const svg = pngSvg(figure, 2, { regular: 'data:font/ttf;base64,AAAA', italic: 'data:font/ttf;base64,BBBB' });
  const root = svg.slice(0, svg.indexOf('>') + 1);
  assert.match(root, new RegExp(` width="${figure.width * 2}" height="${figure.height * 2}" viewBox="0 0 ${figure.width} ${figure.height}"`));
  assert.ok(svg.slice(root.length).startsWith('<style>@font-face{font-family:"Inter";src:url("data:font/ttf;base64,AAAA")'));
  assert.ok(svg.includes('url("data:font/ttf;base64,BBBB") format("truetype");font-style:italic'));
  assert.equal(svg.slice(svg.indexOf('</style>') + '</style>'.length), figure.svg.slice(figure.svg.indexOf('>') + 1));
  assert.ok(!pngSvg(figure, 2, { regular: 'r' }).includes('font-style:italic'));
});
