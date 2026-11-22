import { useEffect, useRef, useState } from 'react';
import { APP_COMMIT, APP_VERSION, BUILD_LABEL, DOI, REPOSITORY_URL, VERSION_LABEL } from '../lib/buildInfo';
import { HowItWorksDemo } from './howItWorks/HowItWorksDemo';
import { PathwayTutorial } from './pathwayTutorial/PathwayTutorial';
import { WHATS_NEW_VERSION, WhatsNewTour } from './WhatsNewTour';
import { track } from '../lib/usage';

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
  const [showPathways, setShowPathways] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
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

    // Escape closes it, as it does the account and settings panels.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setPanel(null);
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
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
        // The same grey panel as account and settings: a header to close it by, then its sections.
        <div aria-label="about stepthrough" className="app-settings-panel" role="dialog">
          <div className="app-settings-header">
            <span>about</span>
            <button aria-label="close about" className="app-settings-close" onClick={() => setPanel(null)} type="button">
              ×
            </button>
          </div>
          <div className="app-settings-section">
            <p className="app-about-text">
              stepthrough turns screen recordings into reviewable walkthrough steps for app and interface research.
            </p>
          </div>
          <div className="app-settings-section">
            <p className="app-settings-section-label">guides</p>
            <button
              className="app-about-link"
              onClick={() => {
                setPanel(null);
                setShowDemo(true);
              }}
              type="button"
            >
              how it works
            </button>
            <button
              className="app-about-link"
              onClick={() => {
                setPanel(null);
                setShowPathways(true);
                track({ kind: 'tutorial_opened', from: 'about' });
              }}
              type="button"
            >
              how to work with pathways
            </button>
            <button
              className="app-about-link"
              onClick={() => {
                setPanel(null);
                setShowWhatsNew(true);
              }}
              type="button"
            >
              what's new in {WHATS_NEW_VERSION}
            </button>
          </div>
          <div className="app-settings-section">
            <p className="app-settings-section-label">version</p>
            <p className="app-about-text">
              {APP_VERSION}
              {BUILD_LABEL ? `, ${BUILD_LABEL}` : ''}
              {APP_COMMIT ? (
                <span className="app-about-commit" title="the commit this copy was built from">
                  , {APP_COMMIT}
                </span>
              ) : null}
            </p>
            <div className="app-about-links">
              <a className="app-about-link" href={REPOSITORY_URL} rel="noreferrer" target="_blank" title={REPOSITORY_URL}>
                GitHub
                <OutArrow />
              </a>
              <a className="app-about-link" href={`https://doi.org/${DOI}`} rel="noreferrer" target="_blank" title={`doi:${DOI}`}>
                DOI (Zenodo)
                <OutArrow />
              </a>
            </div>
          </div>
        </div>
      ) : null}
      {showDemo ? <HowItWorksDemo onClose={() => setShowDemo(false)} /> : null}
      {showPathways ? <PathwayTutorial onClose={() => setShowPathways(false)} /> : null}
      {showWhatsNew ? <WhatsNewTour onClose={() => setShowWhatsNew(false)} /> : null}
    </div>
  );
}

/** The up-right arrow after a link that opens another website. */
function OutArrow() {
  return (
    <svg aria-hidden="true" className="app-about-arrow" height="9" viewBox="0 0 9 9" width="9">
      <path d="M1.5 7.5 7.5 1.5M3 1.5h4.5V6" />
    </svg>
  );
}
