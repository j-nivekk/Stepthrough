import { useCallback, useState } from 'react';

/**
 * The content width of an element, kept current as the window or the layout around it changes. Pass the returned
 * ref to the element; the width is 0 until it has been laid out.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const [observer] = useState(
    () =>
      new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setWidth(Math.floor(entry.contentRect.width));
      }),
  );
  const ref = useCallback(
    (node: T | null) => {
      observer.disconnect();
      if (node) {
        observer.observe(node);
        // Measured now as well, so the first paint already has the width (the observer reports a frame later).
        setWidth(Math.floor(node.clientWidth));
      }
    },
    [observer],
  );
  return [ref, width];
}
