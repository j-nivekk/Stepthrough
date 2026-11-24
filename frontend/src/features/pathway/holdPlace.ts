/**
 * Keeps the reader's place in a pathway while its size changes: a smaller figure takes more boxes on a row, so every
 * box below the first row moves. What is selected, or else the box in the middle of the window, stays where it is on
 * the screen meanwhile.
 */
export interface HeldPlace {
  panel: Element;
  screen: string;
  x: number;
  y: number;
  /** When the size last changed: dragging the slider on holds the same box. */
  at: number;
}

const SAME_DRAG_MS = 1500;

export function translateOf(element: Element): [number, number] | null {
  const match = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(element.getAttribute('transform') ?? '');
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** The middle of a box's screenshot in the window: where it belongs, also while it still glides there. */
function middleOf(box: Element): { x: number; y: number } | null {
  const at = translateOf(box);
  const image = box.querySelector('image');
  const matrix = box instanceof SVGGraphicsElement ? box.ownerSVGElement?.getScreenCTM() : null;
  if (!at || !image || !matrix) return null;
  const x = at[0] + Number(image.getAttribute('width') ?? 0) / 2;
  const y = at[1] + Number(image.getAttribute('height') ?? 0) / 2;
  return { x: matrix.a * x + matrix.e, y: matrix.d * y + matrix.f };
}

const boxIn = (panel: Element, screen: string): Element | null => panel.querySelector(`.pathway-figure [data-screen="${CSS.escape(screen)}"]`);

/** Before the size changes: the box to hold. With nothing selected, none while the top of the figure is in view: it
 *  sizes from there. */
export function holdPlace(control: Element, held: HeldPlace | null): HeldPlace | null {
  const panel = control.closest('.pathway-panel');
  if (!panel) return null;
  const now = Date.now();
  if (held && held.panel === panel && now - held.at < SAME_DRAG_MS && boxIn(panel, held.screen)) return { ...held, at: now };
  const selected = panel.querySelector('.pathway-selected')?.getBoundingClientRect();
  const inView = selected && selected.bottom > 0 && selected.top < window.innerHeight;
  if (!inView && (panel.querySelector('.pathway-scroll')?.getBoundingClientRect().top ?? 0) >= 0) return null;
  const around = inView
    ? { x: selected.left + selected.width / 2, y: selected.top + selected.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  let best: HeldPlace | null = null;
  let distance = Infinity;
  for (const box of panel.querySelectorAll('.pathway-figure [data-screen]')) {
    const middle = middleOf(box);
    if (!middle) continue;
    const away = Math.hypot(middle.x - around.x, middle.y - around.y);
    if (away >= distance) continue;
    distance = away;
    best = { panel, screen: box.getAttribute('data-screen') ?? '', ...middle, at: now };
  }
  return best;
}

/** After it: scrolls so that the held box is where it was. */
export function keepPlace(held: HeldPlace): void {
  const box = boxIn(held.panel, held.screen);
  const middle = box ? middleOf(box) : null;
  if (!middle) return;
  window.scrollBy(0, middle.y - held.y);
  const scroll = held.panel.querySelector('.pathway-scroll');
  if (scroll) scroll.scrollLeft += middle.x - held.x;
}
