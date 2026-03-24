import { useEffect, useRef, useState } from 'react';

const APP_IDENTITY = 'stepthrough, v 0.1.0';

export function AppWatermark() {
  const [showAbout, setShowAbout] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showAbout) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (shellRef.current?.contains(event.target as Node)) {
        return;
      }
      setShowAbout(false);
    }

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [showAbout]);

  return (
    <div className="app-watermark-shell" ref={shellRef}>
      <span className="app-watermark-text">{APP_IDENTITY}</span>
      <button
        aria-expanded={showAbout}
        className={`app-watermark-about ${showAbout ? 'active' : ''}`}
        onClick={() => setShowAbout((current) => !current)}
        type="button"
      >
        about
      </button>
      {showAbout ? (
        <div className="app-watermark-popover">
          <p>stepthrough helps researchers turn screen recordings into reviewable scene candidates for step-by-step analysis.</p>
          <p>version 0.1.0</p>
        </div>
      ) : null}
    </div>
  );
}
