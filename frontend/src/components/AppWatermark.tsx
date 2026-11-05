import { useEffect, useRef, useState } from 'react';
import { HowItWorksDemo } from './howItWorks/HowItWorksDemo';

const APP_IDENTITY = 'stepthrough, v 0.1.0';

interface AppWatermarkProps {
  onOpenSettings: () => void;
}

export function AppWatermark({ onOpenSettings }: AppWatermarkProps) {
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
      <button
        className="app-watermark-about"
        onClick={onOpenSettings}
        type="button"
      >
        settings
      </button>
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
