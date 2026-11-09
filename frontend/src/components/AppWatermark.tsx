import { useEffect, useRef, useState } from 'react';
import { HowItWorksDemo } from './howItWorks/HowItWorksDemo';

const APP_IDENTITY = 'stepthrough, v 0.1.0';

interface AppWatermarkProps {
  /** Who is logged in, as a button that opens the account panel; left out when the app has no logins. */
  account?: { label: string; active: boolean; onOpen: () => void } | null;
  /** Left out where settings make no sense yet (the login page). */
  onOpenSettings?: () => void;
}

export function AppWatermark({ account, onOpenSettings }: AppWatermarkProps) {
  const [showAbout, setShowAbout] = useState(false);
  const [showDemo, setShowDemo] = useState(false);
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
      {account ? (
        <button
          aria-label={`account: ${account.label}`}
          className={`app-watermark-about app-watermark-account ${account.active ? 'active' : ''}`}
          onClick={account.onOpen}
          type="button"
        >
          {account.label}
        </button>
      ) : null}
      {onOpenSettings ? (
        <button
          className="app-watermark-about"
          onClick={onOpenSettings}
          type="button"
        >
          settings
        </button>
      ) : null}
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
          <p>stepthrough turns screen recordings into reviewable walkthrough steps for app and interface research.</p>
          <button
            className="analysis-task-link subtle app-watermark-demo-link"
            onClick={() => {
              setShowAbout(false);
              setShowDemo(true);
            }}
            type="button"
          >
            how it works
          </button>
          <p>version 0.1.0</p>
        </div>
      ) : null}
      {showDemo ? <HowItWorksDemo onClose={() => setShowDemo(false)} /> : null}
    </div>
  );
}
