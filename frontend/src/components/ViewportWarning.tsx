export interface ViewportWarningProps {
  currentHeight: number;
  currentWidth: number;
  minimumHeight: number;
  minimumWidth: number;
}

export function ViewportWarning({
  currentHeight,
  currentWidth,
  minimumHeight,
  minimumWidth,
}: ViewportWarningProps) {
  return (
    <div className="viewport-warning-overlay" role="alert" aria-live="polite">
      <div className="viewport-warning-card">
        <h1>stepthrough works best with a larger window.</h1>
        <p>try making your browser window wider/taller.</p>
        <p className="viewport-warning-meta">
          current window {currentWidth} × {currentHeight} · recommended minimum {minimumWidth} × {minimumHeight}
        </p>
      </div>
    </div>
  );
}
