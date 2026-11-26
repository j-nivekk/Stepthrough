import { useCallback, useEffect, useState } from 'react';

/**
 * Whether an element with `position: sticky; top: -1px` is stuck at the top of the window. Stuck, one pixel of it is
 * out of the window, which an IntersectionObserver notices without listening to every scroll.
 */
export function useStuck<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [stuck, setStuck] = useState(false);
  const [observer] = useState(() =>
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            const entry = entries[entries.length - 1];
            if (entry) setStuck(entry.intersectionRatio < 1 && entry.boundingClientRect.top < 0);
          },
          { threshold: [1] },
        ),
  );
  const ref = useCallback(
    (node: T | null) => {
      observer?.disconnect();
      if (node) observer?.observe(node);
      else setStuck(false);
    },
    [observer],
  );
  useEffect(() => () => observer?.disconnect(), [observer]);
  return [ref, stuck];
}
