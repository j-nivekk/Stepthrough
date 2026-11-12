/**
 * The badge on every pathway figure: a QR code of the repository's address, when and with which version the
 * figure was made, and where to find and cite Stepthrough.
 *
 * It is drawn as outlines, not as text, so it looks the same wherever the file is opened, also without Inter
 * installed: Inter's letters with its slashed zero (see pathwayBadgeData.ts, made by
 * frontend/scripts/make_pathway_badge.py).
 */
import { BADGE_GLYPHS, BADGE_ITALIC_GLYPHS, BADGE_QR, BADGE_REPOSITORY_URL, BADGE_UNITS_PER_EM, type BadgeGlyph } from './pathwayBadgeData';

/** Where Stepthrough is archived for citing. */
export const BADGE_DOI = 'doi.org/10.5281/zenodo.24159850';

// The badge is laid out in the units of its design and scaled to the figure: the QR code on the left, the
// text beside it, in a card as wide as its longest line (the DOI) needs.
const PADDING = 56;
const QR_SIZE = 400;
const TEXT_LEFT = PADDING + QR_SIZE + 48;
const TEXT_SIZE = 46;
const LINK_SIZE = 44;
const DESIGN_HEIGHT = PADDING * 2 + QR_SIZE;

const INK = '#111';
const OUTLINE = '#3c3c3c';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (value: number): number => Math.round(value * 100) / 100;

type Run = [text: string, italic?: boolean];

function glyphOf(character: string, italic: boolean): BadgeGlyph {
  const table = italic ? BADGE_ITALIC_GLYPHS : BADGE_GLYPHS;
  // A letter the badge has no outline for leaves a gap as wide as a space.
  return table[character] ?? BADGE_GLYPHS[character] ?? BADGE_GLYPHS[' '] ?? [576, ''];
}

function widthOf(runs: Run[]): number {
  let width = 0;
  for (const [text, italic] of runs) for (const character of text) width += glyphOf(character, Boolean(italic))[0];
  return width;
}

const TEXT_WIDTH = (widthOf([[BADGE_DOI]]) * LINK_SIZE) / BADGE_UNITS_PER_EM;
const TEXT_RIGHT = TEXT_LEFT + TEXT_WIDTH;
const DESIGN_WIDTH = TEXT_RIGHT + PADDING;
export const BADGE_HEIGHT = 90;
export const BADGE_WIDTH = (BADGE_HEIGHT * DESIGN_WIDTH) / DESIGN_HEIGHT;

export function buildPathwayBadge({ date, version }: { date: string; version: string }): string {
  const used = new Map<string, string>(); // id of a letter's outline -> the outline
  const line = (left: number, baseline: number, size: number, runs: Run[]): string => {
    // A line too long for the badge (a long version name) is set smaller, never cut.
    const scale = Math.min(size / BADGE_UNITS_PER_EM, (TEXT_RIGHT - left) / Math.max(1, widthOf(runs)));
    let x = 0;
    let uses = '';
    for (const [text, italic] of runs) {
      for (const character of text) {
        const [advance, outline] = glyphOf(character, Boolean(italic));
        if (outline) {
          const id = `stepthrough-badge-${italic && BADGE_ITALIC_GLYPHS[character] ? 'i' : 'u'}${character.codePointAt(0)}`;
          used.set(id, outline);
          uses += `<use xlink:href="#${id}" x="${x}"/>`;
        }
        x += advance;
      }
    }
    return `<g transform="translate(${left} ${baseline}) scale(${n2(scale * 10000) / 10000})">${uses}</g>`;
  };

  const lines =
    line(TEXT_LEFT, 125, TEXT_SIZE, [['generated with '], ['Stepthrough', true]]) +
    line(TEXT_LEFT, 183, TEXT_SIZE, [[`on ${date}`]]) +
    line(TEXT_LEFT, 241, TEXT_SIZE, [[`using version ${version}`]]) +
    line(TEXT_LEFT, 347, LINK_SIZE, [[BADGE_REPOSITORY_URL.replace(/^https?:\/\//, '')]]) +
    line(TEXT_LEFT, 409, LINK_SIZE, [[BADGE_DOI]]);

  // One closed strip per run of dark squares in a row.
  let squares = '';
  BADGE_QR.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== '1') continue;
      let end = x;
      while (row[end + 1] === '1') end += 1;
      squares += `M${x} ${y}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  });
  const module = QR_SIZE / BADGE_QR.length;

  const defs = [...used].map(([id, outline]) => `<path id="${id}" d="${outline}"/>`).join('');
  const label = `generated with Stepthrough on ${date} using version ${version}. ${BADGE_REPOSITORY_URL.replace(/^https?:\/\//, '')}. ${BADGE_DOI}`;
  return (
    `<g id="badge" transform="scale(${n2((BADGE_HEIGHT / DESIGN_HEIGHT) * 100000) / 100000})">` +
    `<title>${esc(label)}</title>` +
    `<defs>${defs}</defs>` +
    `<rect x="2" y="2" width="${n2(DESIGN_WIDTH - 4)}" height="${DESIGN_HEIGHT - 4}" rx="50" fill="#fff" stroke="${OUTLINE}" stroke-width="4"/>` +
    `<path transform="translate(${PADDING} ${PADDING}) scale(${n2(module * 1000) / 1000})" d="${squares}" fill="${INK}" shape-rendering="crispEdges"/>` +
    `<g fill="${INK}">${lines}</g>` +
    `<line x1="${TEXT_LEFT}" y1="283" x2="${n2(TEXT_RIGHT)}" y2="283" stroke="#000" stroke-width="6" stroke-linecap="round"/>` +
    '</g>'
  );
}
