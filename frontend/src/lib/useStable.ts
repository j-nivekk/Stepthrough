import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Functions that stay the same objects from render to render, and always run the latest version. With them, a part of
 * the page wrapped in `memo` is drawn again only when what it shows changes, not because its handlers were made anew.
 * For handlers only (they run after the page is drawn): not for anything called while drawing.
 */
export function useStable<T extends object>(functions: T): T {
  const latest = useRef(functions);
  useLayoutEffect(() => {
    latest.current = functions;
  });
  const [stable] = useState<T>(() => {
    const entries = Object.keys(functions).map((key) => [
      key,
      (...args: unknown[]) => (latest.current[key as keyof T] as (...args: unknown[]) => unknown)(...args),
    ]);
    return Object.fromEntries(entries) as T;
  });
  return stable;
}
