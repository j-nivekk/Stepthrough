/**
 * The pathway figure as a PNG image. The SVG is drawn on a canvas at twice its size, with the app's font inside
 * it, so the text is set exactly as on the page. The file records its resolution, so documents and slides place
 * it at the figure's own size.
 */

export interface PngFigure {
  svg: string;
  width: number;
  height: number;
}

/** The fonts the figure is set in, as addresses the browser can load. */
export interface PngFonts {
  regular: string;
  italic: string;
}

/** Pixels per unit of the figure: twice its size on the page at 100%, sharp on screens and in print. */
export const PNG_SCALE = 2;
/** The largest canvas every current browser draws: Safari on iPhone and iPad stops at 4096 × 4096 pixels. */
const MAX_PIXELS = 4096 * 4096;
const MAX_SIDE = 16_384;
/** What a unit of the figure is taken to be: one CSS pixel, 1/96 inch. */
const UNITS_PER_INCH = 96;

/** The scale to draw a figure at: `preferred`, or less for a figure too large for a canvas at that size. */
export function pngScale(width: number, height: number, preferred = PNG_SCALE): number {
  const fit = Math.min(Math.sqrt(MAX_PIXELS / (width * height)), MAX_SIDE / width, MAX_SIDE / height);
  return Math.min(preferred, Math.floor(fit * 100) / 100);
}

/**
 * The SVG to draw: sized `scale` times larger, so every browser draws its shapes and text at the full resolution
 * rather than enlarging a smaller picture, and with the fonts inside it. An SVG drawn as an image cannot use the
 * fonts of the page, so without them its text would fall back to another typeface that is wider or narrower than
 * the one its lines were measured in.
 */
export function pngSvg(figure: PngFigure, scale: number, fonts: { regular: string; italic?: string }): string {
  const width = Math.round(figure.width * scale);
  const height = Math.round(figure.height * scale);
  const open = figure.svg.indexOf('>') + 1;
  const root = figure.svg
    .slice(0, open)
    .replace(/ width="[\d.]+"/, ` width="${width}"`)
    .replace(/ height="[\d.]+"/, ` height="${height}"`);
  const face = (url: string, style: string) =>
    `@font-face{font-family:"Inter";src:url("${url}") format("truetype");font-style:${style};font-weight:100 900}`;
  const style = `<style>${face(fonts.regular, 'normal')}${fonts.italic ? face(fonts.italic, 'italic') : ''}</style>`;
  return `${root}${style}${figure.svg.slice(open)}`;
}

/** Whether the figure has any italic text (the pop-up labels), so the italic font is only loaded when it is used. */
export function usesItalic(svg: string): boolean {
  return svg.includes('font-style="italic"');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The PNG with its resolution set to `dpi`, in place of any the browser wrote. Without it, programs assume 72 or
 * 96 dpi and show an image drawn at twice the size twice too large.
 */
export function setPngResolution(png: Uint8Array<ArrayBuffer>, dpi: number): Uint8Array<ArrayBuffer> {
  if (png.length < 8 || PNG_SIGNATURE.some((byte, index) => png[index] !== byte)) return png;
  const perMetre = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(21);
  const physView = new DataView(phys.buffer);
  physView.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  physView.setUint32(8, perMetre);
  physView.setUint32(12, perMetre);
  phys[16] = 1; // the unit is the metre
  physView.setUint32(17, crc32(phys.subarray(4, 17)));

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const end = offset + 12 + view.getUint32(offset);
    if (end > png.length) return png;
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type !== 'pHYs') parts.push(png.subarray(offset, end));
    // straight after the header, where it must come before the image data
    if (type === 'IHDR') parts.push(phys);
    offset = end;
  }
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

const fontData = new Map<string, Promise<string>>();

/** A font as a data URI, read once per page. */
function fontDataUri(url: string): Promise<string> {
  let data = fontData.get(url);
  if (!data) {
    data = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error('could not load the font for the png.');
        return response.blob();
      })
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('could not read the font for the png.'));
            reader.readAsDataURL(blob);
          }),
      );
    fontData.set(url, data);
    data.catch(() => fontData.delete(url));
  }
  return data;
}

/** The figure drawn as a PNG, at `PNG_SCALE` times its size where the browser allows it. */
export async function renderPathwayPng(figure: PngFigure, fonts: PngFonts): Promise<Blob> {
  const scale = pngScale(figure.width, figure.height);
  const [regular, italic] = await Promise.all([
    fontDataUri(fonts.regular),
    usesItalic(figure.svg) ? fontDataUri(fonts.italic) : Promise.resolve(undefined),
  ]);
  const url = URL.createObjectURL(new Blob([pngSvg(figure, scale, { regular, italic })], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(figure.width * scale);
    canvas.height = Math.round(figure.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('could not make the png: this browser has no canvas to draw it on.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('could not make the png: the figure is too large for this browser.');
    const png = setPngResolution(new Uint8Array(await blob.arrayBuffer()), UNITS_PER_INCH * scale);
    return new Blob([png], { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
