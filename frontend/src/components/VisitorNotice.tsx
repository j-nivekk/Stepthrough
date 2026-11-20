import { useEffect, useState } from 'react';

import { deletionDate, deletionIsNear, deletionLine, formatTimeLeft } from '../lib/visitors';

/** The notice's own minus (make it small) and plus (show it again), drawn alike. */
function Sign({ plus }: { plus?: boolean }) {
  return (
    <svg aria-hidden="true" className="visitor-notice-sign" height="10" viewBox="0 0 10 10" width="10">
      <path d={plus ? 'M1 5h8M5 1v8' : 'M1 5h8'} />
    </svg>
  );
}

/**
 * On every page of a project only visitor accounts own (backend/app/visitors.py): when it is deleted, and the
 * download that keeps it. It stays in view while the project is open; it can be made small, not closed.
 */
export function VisitorNotice({ deletesAt, onDownload }: { deletesAt: string; onDownload: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const near = deletionIsNear(deletesAt, now);

  if (small) {
    return (
      <button
        aria-label={`this project is ${deletionLine(deletesAt, now)}. show more`}
        className={`visitor-notice is-small ${near ? 'is-near' : ''}`}
        onClick={() => setSmall(false)}
        title={deletionDate(deletesAt)}
        type="button"
      >
        <span>{deletionLine(deletesAt, now)}</span>
        <Sign plus />
      </button>
    );
  }
  return (
    <aside aria-label="when this project is deleted" className={`visitor-notice ${near ? 'is-near' : ''}`}>
      <div className="visitor-notice-head">
        <p className="visitor-notice-text">
          this project is deleted <b>{formatTimeLeft(deletesAt, now)}</b>, on {deletionDate(deletesAt)}.
        </p>
        <button aria-label="make this notice small" className="visitor-notice-shrink" onClick={() => setSmall(true)} type="button">
          <Sign />
        </button>
      </div>
      <button
        className="pathway-tool visitor-notice-download"
        onClick={onDownload}
        title="the whole project as one file, videos included"
        type="button"
      >
        download
      </button>
    </aside>
  );
}
