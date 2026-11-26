// Changes to the page shown as the old page turning into the new one (the browser's view transitions): steps and pathway
// fading into each other, step cards moving to their new places when a filter changes. Where the browser has no view
// transitions, or asks for less motion, the change is made at once, as before.

import { flushSync } from 'react-dom';

interface ViewTransitionLike {
  finished: Promise<void>;
}
type DocumentWithTransitions = Document & { startViewTransition?: (update: () => void) => ViewTransitionLike };

/** How far past the window a card may be and still move rather than appear: what is further cannot be seen move. */
const NEAR_PX = 400;

function transitionsWelcome(): DocumentWithTransitions | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const doc = document as DocumentWithTransitions;
  if (typeof doc.startViewTransition !== 'function') return null;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
  return doc;
}

/** Make a change to what React shows as a view transition: the page as it was fades into the page as it is. */
export function changeWithTransition(update: () => void): void {
  const doc = transitionsWelcome();
  if (!doc) {
    update();
    return;
  }
  doc.startViewTransition(() => flushSync(update));
}

/** A transition name for an element id (an id may start with a digit, a name may not). */
export function transitionName(id: string): string {
  return `vt-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** Name the elements near the window that match the selector by their ids, so each moves on its own; the others are
 *  left to the page's fade. */
function nameNear(container: ParentNode, selector: string): HTMLElement[] {
  const named: HTMLElement[] = [];
  const seen = new Set<string>();
  for (const element of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
    if (!element.id || seen.has(element.id)) continue;
    const box = element.getBoundingClientRect();
    if (box.bottom < -NEAR_PX || box.top > window.innerHeight + NEAR_PX) continue;
    seen.add(element.id);
    element.style.viewTransitionName = transitionName(element.id);
    named.push(element);
  }
  return named;
}

/**
 * Make a change to a list of cards as a view transition in which each card near the window moves from where it was to
 * where it is, and cards that come or go fade. `selector` finds the cards (elements with an id) in `container`.
 */
export function moveCardsWithTransition(container: () => ParentNode | null, selector: string, update: () => void): void {
  const doc = transitionsWelcome();
  const before = container();
  if (!doc || !before) {
    update();
    return;
  }
  const named = nameNear(before, selector);
  const transition = doc.startViewTransition(() => {
    flushSync(update);
    const after = container();
    if (after) named.push(...nameNear(after, selector));
  });
  const clear = () => {
    for (const element of named) element.style.viewTransitionName = '';
  };
  transition.finished.then(clear, clear);
}
