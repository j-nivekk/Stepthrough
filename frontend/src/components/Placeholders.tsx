// Grey shapes where content is still loading, in the size and place of what will come, so that nothing moves when it
// arrives and an empty list is never said to be empty before it is known (styles.css .placeholder). They appear after a
// moment, so a quick answer shows none of them.

import type { CSSProperties } from 'react';

/** Rows of a list (the videos, the tasks): a name with something at its right, and a short line under it. */
export function PlaceholderRows({ count, label, group = false }: { count: number; label: string; group?: boolean }) {
  return (
    <div aria-busy="true" aria-label={label} className="placeholder placeholder-rows" role="status">
      {group ? <span className="placeholder-block placeholder-group" /> : null}
      {Array.from({ length: count }, (_, index) => (
        <div className="placeholder-row" key={index}>
          <span className="placeholder-block placeholder-name" style={{ width: `${62 - (index % 3) * 9}%` }} />
          <span className="placeholder-block placeholder-side" />
          <span className="placeholder-block placeholder-meta" />
        </div>
      ))}
    </div>
  );
}

/** Step cards: a screenshot in the recording's shape, and the lines under it. */
export function PlaceholderCards({ count, aspect, label }: { count: number; aspect: number; label: string }) {
  const style = { '--placeholder-aspect': String(aspect > 0 ? aspect : 16 / 9) } as CSSProperties;
  return (
    <div aria-busy="true" aria-label={label} className="placeholder placeholder-cards" role="status" style={style}>
      {Array.from({ length: count }, (_, index) => (
        <div className="placeholder-card" key={index}>
          <span className="placeholder-block placeholder-shot" />
          <span className="placeholder-block placeholder-name" />
          <span className="placeholder-block placeholder-meta" />
        </div>
      ))}
    </div>
  );
}

/** The pathway: a frame with a row of screens in it. */
export function PlaceholderFigure({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="placeholder placeholder-figure" role="status">
      {Array.from({ length: 4 }, (_, index) => (
        <span className="placeholder-block placeholder-screen" key={index} />
      ))}
    </div>
  );
}
