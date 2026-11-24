import { useCallback, useEffect, useMemo, useRef, type PointerEvent } from 'react';

import { screenshotUrl, screenshotWidth } from '../../lib/screenshots';
import { pathwayNumber, stepName } from '../../lib/stepNumbers';
import type { Pathway } from '../../types';

/** How long each step of a number like `2–3` stays in the box while the pointer rests on it. */
const CYCLE_MS = 900;

interface Peek {
  number: Element;
  image: Element;
  tag: Element | null;
  timer: number | null;
}

/**
 * Resting the pointer on a step number under a box shows that step's screenshot in the box, with the step number
 * in its corner; a number that stands for several steps in a row (`2–3`) shows them in turn. A box otherwise shows
 * only its first step. The chart is markup from buildPathwayFigure with `peek`: this only changes attributes in it,
 * so nothing is drawn again, and leaving the number puts everything back.
 */
export function usePathwayPeek(pathway: Pathway | undefined, markup: string | undefined, boxWidth: number, leaveOut: boolean) {
  // the same copy of each screenshot as the boxes draw (lib/screenshots.ts)
  const copyWidth = screenshotWidth(boxWidth);
  const steps = useMemo(
    () =>
      new Map(
        (pathway?.steps ?? []).map((step) => [
          step.step_id,
          { url: screenshotUrl(step.image_url, copyWidth, 1), name: stepName(pathwayNumber(step, leaveOut)) },
        ]),
      ),
    [pathway, copyWidth, leaveOut],
  );
  const current = useRef<Peek | null>(null);

  const stop = useCallback(() => {
    const peek = current.current;
    if (!peek) return;
    current.current = null;
    if (peek.timer !== null) window.clearInterval(peek.timer);
    peek.image.removeAttribute('href'); // the box's own screenshot is in xlink:href
    peek.tag?.setAttribute('visibility', 'hidden');
    peek.number.classList.remove('active');
  }, []);

  // New markup replaces the elements a preview was changing.
  useEffect(() => stop, [markup, stop]);

  function onPointerOver(event: PointerEvent<HTMLElement>) {
    const number = event.target instanceof Element ? event.target.closest('[data-peek]') : null;
    if (number && number === current.current?.number) return;
    stop();
    if (!number) return;
    const box = number.closest('[data-screen]');
    const image = box?.querySelector('image[data-screenshot]');
    const ids = (number.getAttribute('data-peek') ?? '').split(' ').filter((id) => steps.has(id));
    if (!box || !image || !ids.length) return;
    const tag = box.querySelector('.pathway-peek-tag');
    const peek: Peek = { number, image, tag, timer: null };
    let shown = 0;
    const show = () => {
      const step = steps.get(ids[shown] ?? '');
      if (!step) return;
      image.setAttribute('href', step.url);
      const label = tag?.querySelector('text');
      const back = tag?.querySelector('rect');
      if (tag && label && back) {
        label.textContent = step.name;
        const width = (label instanceof SVGTextContentElement ? label.getComputedTextLength() : 30) + 14;
        back.setAttribute('width', String(width));
        label.setAttribute('x', String(5 + width / 2));
        tag.setAttribute('visibility', 'visible');
      }
    };
    show();
    if (ids.length > 1) {
      peek.timer = window.setInterval(() => {
        shown = (shown + 1) % ids.length;
        show();
      }, CYCLE_MS);
    }
    number.classList.add('active');
    current.current = peek;
  }

  return { onPointerOver, onPointerLeave: stop };
}
