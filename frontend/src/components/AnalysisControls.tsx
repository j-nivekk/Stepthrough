const analysisResetStarPoints = Array.from({ length: 34 }, (_value, index) => {
  const angle = -Math.PI / 2 + (Math.PI * index) / 17;
  const radiusX = index % 2 === 0 ? 43 : 35;
  const radiusY = index % 2 === 0 ? 16 : 12;
  const x = 46 + Math.cos(angle) * radiusX;
  const y = 16 + Math.sin(angle) * radiusY;
  return `${x.toFixed(2)},${y.toFixed(2)}`;
}).join(' ');

export interface AnalysisResetDiamondButtonProps {
  className?: string;
  label: string;
  onClick: () => void;
}

export function AnalysisResetDiamondButton({
  className,
  label,
  onClick,
}: AnalysisResetDiamondButtonProps) {
  return (
    <button
      aria-label={`Reset ${label} to default`}
      className={className ? `analysis-dirty-reset ${className}` : 'analysis-dirty-reset'}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      title={`Reset ${label} to default`}
      type="button"
    >
      <span className="analysis-dirty-reset-glyph" />
    </button>
  );
}

export interface AnalysisStarResetButtonProps {
  expanded?: boolean;
  onClick: () => void;
}

export function AnalysisStarResetButton({
  expanded = false,
  onClick,
}: AnalysisStarResetButtonProps) {
  return (
    <button
      aria-label="Open reset defaults menu"
      aria-expanded={expanded}
      className="analysis-star-reset"
      onClick={onClick}
      title="Open reset defaults menu"
      type="button"
    >
      <svg aria-hidden="true" className="analysis-star-reset-shape" viewBox="0 0 92 32">
        <polygon points={analysisResetStarPoints} />
      </svg>
      <span className="analysis-star-reset-label">reset</span>
    </button>
  );
}

export interface AnalysisStepperInputProps {
  ariaLabel: string;
  className: string;
  max?: number;
  min?: number;
  onChange: (rawValue: string) => void;
  onStep: (direction: -1 | 1) => void;
  value: number | string;
}

export function AnalysisStepperInput({
  ariaLabel,
  className,
  max,
  min,
  onChange,
  onStep,
  value,
}: AnalysisStepperInputProps) {
  return (
    <div className="analysis-stepper-input">
      <div className="analysis-stepper-controls">
        <button
          aria-label={`Increase ${ariaLabel}`}
          className="analysis-stepper-button"
          onClick={() => onStep(1)}
          type="button"
        >
          <span aria-hidden="true" className="analysis-stepper-glyph up" />
        </button>
        <button
          aria-label={`Decrease ${ariaLabel}`}
          className="analysis-stepper-button"
          onClick={() => onStep(-1)}
          type="button"
        >
          <span aria-hidden="true" className="analysis-stepper-glyph down" />
        </button>
      </div>
      <input
        aria-label={ariaLabel}
        className={className}
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        type="number"
        value={value}
      />
    </div>
  );
}
