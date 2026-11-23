import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The version whose changes the tour shows: it opens once per browser for each. */
export const WHATS_NEW_VERSION = '1.4.3';
const SEEN_KEY = 'stepthrough.whats-new';

export function whatsNewSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === WHATS_NEW_VERSION;
  } catch {
    return true; // without storage it would come back every time: better not at all
  }
}

export function markWhatsNewSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, WHATS_NEW_VERSION);
  } catch {
    // only a convenience
  }
}

interface Stop {
  title: string;
  text: ReactNode;
  /** What the stop points at, on the pathway; nothing found, the note shows in the middle of the window. */
  find: () => Element[];
}

const all = (selector: string) => [...document.querySelectorAll(selector)];
const one = (selector: string) => all(selector).slice(0, 1);

/** The boxes of the pathway (their screenshots), in order. */
const boxes = () => all('.pathway-figure [data-screen] image');

const STOPS: Stop[] = [
  {
    title: 'view, and sticky controls',
    text: (
      <>
        <b>screens</b>: one box per page. <b>steps</b>: one box per step. the controls bar stays pinned at the top as
        you scroll through tall charts.
      </>
    ),
    find: () => one('[aria-label="view of the pathway"]'),
  },
  {
    title: 'click a box',
    text: (
      <>
        opens its toolbox: <b>title</b>, <b>pop-up</b>, <b>stacking…</b> (with screen thumbnails, unstacking and
        automatic stacking), and <b>phase…</b>. renamed screens keep a compact <b>S#</b> tag. shift-click for several.
      </>
    ),
    find: () => boxes().slice(1, 2).concat(boxes().length === 1 ? boxes() : []),
  },
  {
    title: 'click a step number',
    text: (
      <>
        selects one step: <b>put it on…</b> another box (with thumbnails), or give a stacked step its <b>own screen</b>.
        for 4–5, pick a step in its toolbox.
      </>
    ),
    find: () => {
      const numbers = all('.pathway-figure [data-peek]');
      const several = numbers.find((number) => (number.getAttribute('data-peek') ?? '').includes(' '));
      return several ? [several] : numbers.slice(0, 1);
    },
  },
  {
    title: 'paths, hover and pan',
    text: (
      <>
        branches are amber, returns are dashed blue, and distant jumps show clickable chips. hover any arrow to
        spotlight its route, or drag empty space to pan the chart.
      </>
    ),
    find: () => {
      const legend = one('.pathway-status-legend');
      return legend.length ? legend : one('.pathway-status');
    },
  },
  {
    title: 'drag',
    text: (
      <>
        a box onto a box <b>stacks</b> them. a step number onto a box moves the step; off the boxes, it gets its own
        screen.
      </>
    ),
    find: () => boxes().slice(0, 2),
  },
  {
    title: 'right-click, ⋯ and undo',
    text: (
      <>
        right-click a box or step number for its menu (the toolbox steps out of the way). <b>⋯</b> holds rarer choices
        like row placement. <b>undo</b> (⌘Z or Ctrl+Z) takes back only your own changes.
      </>
    ),
    find: () => one('.pathway-status'),
  },
  {
    title: 'phases, and gallery view',
    text: (
      <>
        name parts of the walkthrough here, or with <b>phase…</b> on selected boxes — and try <b>gallery</b> in steps
        for close-up per-screen review. this tour stays under <b>about</b>.
      </>
    ),
    find: () => one('[data-phases-toggle]'),
  },
];

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function stillPreferred(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Where the elements are in the window, together; null when none of them is on the page. */
function around(elements: Element[]): Rect | null {
  const rects = elements.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * What changed in the pathway, shown on the pathway itself: each stop lights up one control, with the rest of the
 * page dimmed, and says what it does now. Next, back and skip (or the arrow keys and Escape); the page cannot be
 * used meanwhile. Opened by itself once per browser for each version (PathwayPanel), and from about at any time.
 * Without a pathway on the page, the notes are shown in the middle of the window, with a word to open one.
 */
export function WhatsNewTour({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const stop = STOPS[index];
  const last = index === STOPS.length - 1;

  const close = useCallback(() => {
    markWhatsNewSeen();
    onClose();
  }, [onClose]);

  // Each stop brings what it points at into view (skipping scroll when already clearly visible, e.g. sticky bars),
  // then follows it as the page scrolls or the window changes.
  useEffect(() => {
    const first = stop.find()[0];
    if (first) {
      const rect = first.getBoundingClientRect();
      const visible = rect.top >= 16 && rect.bottom <= window.innerHeight - 16;
      if (!visible) {
        first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: stillPreferred() ? 'auto' : 'smooth' });
      }
    }
    const measure = () => setSpot(around(stop.find()));
    measure();
    const later = window.setTimeout(measure, 350); // once a smooth scroll has arrived
    const settled = window.setTimeout(measure, 650);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(later);
      window.clearTimeout(settled);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [stop]);

  // The note goes below what is lit up, or above it, or beside it, inside the window; in the middle without one.
  useLayoutEffect(() => {
    const note = noteRef.current?.getBoundingClientRect();
    if (!note) return;
    const width = note.width;
    const height = note.height;
    if (!spot) {
      setPlace({ left: (window.innerWidth - width) / 2, top: (window.innerHeight - height) / 2 });
      return;
    }
    const gap = 14;
    const clampX = (x: number) => Math.max(8, Math.min(x, window.innerWidth - width - 8));
    const clampY = (y: number) => Math.max(8, Math.min(y, window.innerHeight - height - 8));
    if (spot.top + spot.height + gap + height < window.innerHeight - 8) {
      setPlace({ left: clampX(spot.left), top: spot.top + spot.height + gap });
    } else if (spot.top - gap - height > 8) {
      setPlace({ left: clampX(spot.left), top: spot.top - gap - height });
    } else {
      const right = spot.left + spot.width + gap;
      setPlace({ left: right + width < window.innerWidth - 8 ? right : clampX(spot.left - gap - width), top: clampY(spot.top) });
    }
  }, [spot, index]);

  useEffect(() => {
    nextRef.current?.focus();
  }, [index]);

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (last) close();
        else setIndex((current) => current + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setIndex((current) => Math.max(0, current - 1));
      } else if (event.key === 'Tab') {
        // the focus stays in the note
        const controls = [...(noteRef.current?.querySelectorAll<HTMLElement>('button') ?? [])];
        const at = controls.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        controls[(at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      } else {
        // the page's own keys (the review board's a, r, u, the pathway's P) wait until the tour is over
        event.stopImmediatePropagation();
      }
    }
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [close, last]);

  const pad = 6;
  return createPortal(
    <div aria-label={`what's new in ${WHATS_NEW_VERSION}`} aria-modal="true" className="whats-new" role="dialog">
      {spot ? (
        <div
          aria-hidden="true"
          className="whats-new-spot"
          style={{ left: spot.left - pad, top: spot.top - pad, width: spot.width + 2 * pad, height: spot.height + 2 * pad }}
        />
      ) : (
        <div aria-hidden="true" className="whats-new-dim" />
      )}
      <div
        className="whats-new-note"
        key={index}
        ref={noteRef}
        style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}
      >
        <span className="whats-new-kicker">
          what's new in {WHATS_NEW_VERSION}, {index + 1} of {STOPS.length}
        </span>
        <p className="whats-new-title">{stop.title}</p>
        <p className="whats-new-text">{stop.text}</p>
        {!spot ? <p className="whats-new-hint">open a pathway to see it in place.</p> : null}
        <div className="whats-new-actions">
          <button className="analysis-task-link subtle" onClick={close} type="button">
            skip
          </button>
          <span className="whats-new-spacer" />
          {index > 0 ? (
            <button className="pathway-tool" onClick={() => setIndex(index - 1)} type="button">
              back
            </button>
          ) : null}
          <button className="analysis-pill success" onClick={() => (last ? close() : setIndex(index + 1))} ref={nextRef} type="button">
            {last ? 'done' : 'next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
