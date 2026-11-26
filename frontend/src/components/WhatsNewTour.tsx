import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The version whose changes the tour shows: it opens once per browser for each. */
export const WHATS_NEW_VERSION = '1.5.0';
const SEEN_KEY = 'stepthrough.whats-new';

/** Whether to open the tour by itself: for someone who saw the tour of an earlier version, so knew the app before.
 *  Someone new to it finds the tour under about. */
export function whatsNewDue(): boolean {
  try {
    const seen = window.localStorage.getItem(SEEN_KEY);
    return seen !== null && seen !== WHATS_NEW_VERSION;
  } catch {
    return false;
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
/** The first of these that is on the page. */
const first = (...selectors: string[]) => {
  for (const selector of selectors) {
    const found = one(selector);
    if (found.length) return found;
  }
  return [];
};

/** Where text is asked for: the run's button, or else the bar it is in, beside export (where the run opens). */
const readText = () => {
  const button = all('.run-text button').filter((element) => /read|try again/.test(element.textContent ?? '')).slice(0, 1);
  return button.length ? button : first('.review-mode-side', '.review-mode-bar');
};

/** Where a step's text opens: on a card, or beside the screenshot in the gallery. */
const textLinks = () => {
  const card = one('.candidate-step-text summary');
  if (card.length) return card;
  return all('.candidate-gallery-scores-toggle').filter((button) => button.textContent?.trim() === 'text').slice(0, 1);
};

const STOPS: Stop[] = [
  {
    title: 'the text on the screens',
    text: (
      <>
        stepthrough reads the text on each screenshot, of any run, also older ones: <b>read text</b> beside{' '}
        <b>export</b>, or <b>read text (ocr)</b> before an analysis. the steps come first and the text follows, much
        faster than before and in more languages. you can go on working meanwhile.
      </>
    ),
    find: readText,
  },
  {
    title: 'text of 1.4 can be wrong',
    text: (
      <>
        up to 1.4.5, a screenshot could get the text of an earlier one that looked much like it. a run with such text
        says <b>text read by an earlier version</b>, and <b>read again</b> replaces it. in exports it is marked{' '}
        <code>earlier</code>.
      </>
    ),
    find: () => first('.run-text', '.review-mode-bar'),
  },
  {
    title: 'read it, find it',
    text: (
      <>
        <b>text</b> on a step shows what was read. in the gallery the lines are also marked on the screenshot: point at
        a line to see where it is. <b>find text</b> shows only the steps with the words you type.
      </>
    ),
    find: () => {
      const links = textLinks();
      return links.length ? links : first('.run-text-find', '[aria-label="step layout"]');
    },
  },
  {
    title: 'in exports, also as PAGE XML',
    text: (
      <>
        <code>steps.json</code> has each line with its place on the screenshot. the text of each screenshot is also in{' '}
        <code>images/page</code> as PAGE XML, which Transkribus and eScriptorium open with the screenshots.
      </>
    ),
    find: () => one('.candidate-export-shell'),
  },
  {
    title: 'how long it takes',
    text: (
      <>
        an analysis that waits or runs says when it should be ready, and so does its text:{' '}
        <b>34%, ready in about 20 s</b>. the server works it out from what it took before, so it is rough. this tour
        stays under <b>about</b>.
      </>
    ),
    find: () => first('.analysis-tasks .analysis-task-row', '.analysis-tasks'),
  },
];

/** Where the stops are, for when they are not on the page. */
const WHERE = 'open the steps of a finished run to see it in place.';

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
 * What changed, shown in place: each stop lights up one control, with the rest of the page dimmed, and says what it
 * does now. Next, back and skip (or the arrow keys and Escape); the page cannot be used meanwhile. Opened by itself
 * once per browser for each version, where the changes are (for 1.5.0 the steps of a finished run: AnalysisScreen),
 * and from about at any time. Without them on the page, the notes are shown in the middle of the window, with a word
 * to open them.
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
    const show = (smooth: boolean) => {
      const first = stop.find()[0];
      if (!first) return;
      const rect = first.getBoundingClientRect();
      const visible = rect.top >= 16 && rect.bottom <= window.innerHeight - 16;
      if (!visible) {
        first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: smooth && !stillPreferred() ? 'smooth' : 'auto' });
      }
    };
    show(true);
    const measure = () => setSpot(around(stop.find()));
    measure();
    const later = window.setTimeout(measure, 350); // once a smooth scroll has arrived
    // The page may scroll by itself as the tour opens (to a run just opened): then it is shown again.
    const settled = window.setTimeout(() => {
      show(false);
      measure();
    }, 900);
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
        {!spot ? <p className="whats-new-hint">{WHERE}</p> : null}
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
