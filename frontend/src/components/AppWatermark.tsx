import { useEffect, useRef, useState } from 'react';
import { APP_VERSION, BUILD_LABEL, VERSION_LABEL } from '../lib/buildInfo';
import { HowItWorksDemo } from './howItWorks/HowItWorksDemo';

const APP_IDENTITY = `stepthrough, ${VERSION_LABEL}`;

/** The panels that open from the bottom-right corner. Only one is open at a time. */
export type CornerPanel = 'account' | 'settings' | 'about';

interface AppWatermarkProps {
  /** Who is logged in, as a button that opens the account panel; left out when the app has no logins. */
  accountLabel?: string | null;
  /** Left out where settings make no sense yet (the login page). */
  withSettings?: boolean;
  /** Which corner panel is open, kept by the page so that opening one closes the others. Without it (the login
   *  page, which has only "about"), the watermark keeps track itself. */
  openPanel?: CornerPanel | null;
  onOpenPanel?: (panel: CornerPanel | null) => void;
}

export function AppWatermark({ accountLabel, withSettings = false, openPanel, onOpenPanel }: AppWatermarkProps) {
  const [ownPanel, setOwnPanel] = useState<CornerPanel | null>(null);
  const [showDemo, setShowDemo] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const panel = onOpenPanel ? openPanel ?? null : ownPanel;
  const setPanel = onOpenPanel ?? setOwnPanel;
  const showAbout = panel === 'about';

  useEffect(() => {
    if (!showAbout) {
      return;
    }

    // A click elsewhere closes "about". Clicks on the other corner buttons open their own panel instead, which
    // closes this one too.
    function handlePointerDown(event: MouseEvent) {
      if (shellRef.current?.contains(event.target as Node)) {
        return;
      }
      setPanel(null);
    }

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [showAbout, setPanel]);

  return (
    <div className="app-watermark-shell" ref={shellRef}>
      <span className="app-watermark-text">{APP_IDENTITY}</span>
      {accountLabel ? (
        <button
          aria-expanded={panel === 'account'}
          aria-label={`account: ${accountLabel}`}
          className={`app-watermark-about app-watermark-account ${panel === 'account' ? 'active' : ''}`}
          onClick={() => setPanel('account')}
          type="button"
        >
          {accountLabel}
        </button>
      ) : null}
      {withSettings ? (
        <button
          aria-expanded={panel === 'settings'}
          className={`app-watermark-about ${panel === 'settings' ? 'active' : ''}`}
          onClick={() => setPanel('settings')}
          type="button"
        >
          settings
        </button>
      ) : null}
      <button
        aria-expanded={showAbout}
        className={`app-watermark-about ${showAbout ? 'active' : ''}`}
        onClick={() => setPanel(showAbout ? null : 'about')}
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
              setPanel(null);
              setShowDemo(true);
            }}
            type="button"
          >
            how it works
          </button>
          <p>
            version {APP_VERSION}
            {BUILD_LABEL ? ` (${BUILD_LABEL})` : ''}
          </p>
        </div>
      ) : null}
      {showDemo ? <HowItWorksDemo onClose={() => setShowDemo(false)} /> : null}
    </div>
  );
}
