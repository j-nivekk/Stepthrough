export interface ViewportWarningProps {
  currentHeight: number;
  currentWidth: number;
  minimumHeight: number;
  minimumWidth: number;
  /** Use Stepthrough at this size anyway (remembered in this browser; settings can turn the warning back on). */
  onDismiss: () => void;
}

export function ViewportWarning({
  currentHeight,
  currentWidth,
  minimumHeight,
  minimumWidth,
  onDismiss,
}: ViewportWarningProps) {
  return (
    <div className="viewport-warning-overlay" role="alert" aria-live="polite">
      <div className="viewport-warning-card">
        <h1>stepthrough works best with a larger window.</h1>
        <p>try making your browser window larger, or zoom out (ctrl or cmd and −).</p>
        <p className="viewport-warning-meta">
          current window {currentWidth} × {currentHeight} · recommended minimum {minimumWidth} × {minimumHeight}
        </p>
        <button className="analysis-task-link viewport-warning-dismiss" onClick={onDismiss} type="button">
          continue anyway
        </button>
        <p className="viewport-warning-meta">you can turn this warning back on in settings.</p>
      </div>
    </div>
  );
}
