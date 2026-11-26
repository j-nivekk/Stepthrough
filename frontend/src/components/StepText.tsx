import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getStepText } from '../api';
import { EARLIER_TEXT, stepTextNote } from '../lib/stepText';
import type { CandidateFrame, StepTextDetail } from '../types';

/** The text read on a step's screenshot, loaded once it is wanted. */
export function useStepText(candidate: CandidateFrame | null, wanted: boolean) {
  const state = candidate?.text_state ?? null;
  return useQuery({
    queryKey: ['step-text', candidate?.id, state],
    queryFn: ({ signal }) => getStepText(candidate?.id ?? '', signal),
    enabled: wanted && (state === 'read' || state === 'earlier'),
    staleTime: 60_000,
  });
}

/** The text of a screenshot, line by line. `highlighted` is the line pointed at, here or on the screenshot. */
export function StepTextBody({
  candidate,
  detail,
  error,
  highlighted = null,
  onHighlight,
}: {
  candidate: CandidateFrame;
  detail: StepTextDetail | undefined;
  error?: Error | null;
  highlighted?: number | null;
  onHighlight?: (line: number | null) => void;
}) {
  const highlightedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    highlightedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  if (error) return <p className="step-text-note">{error.message}</p>;
  if (detail?.lines.length) {
    return (
      <ol className="step-text-lines" onMouseLeave={() => onHighlight?.(null)}>
        {detail.lines.map((line, index) => (
          <li
            className={index === highlighted ? 'is-highlighted' : ''}
            key={index}
            onMouseEnter={() => onHighlight?.(index)}
            ref={index === highlighted ? highlightedRef : undefined}
          >
            {line.text}
          </li>
        ))}
      </ol>
    );
  }
  if (detail?.text) {
    return (
      <>
        <p className="step-text-note">{EARLIER_TEXT}.</p>
        <p className="step-text-piece">{detail.text}</p>
      </>
    );
  }
  const loading = !detail && (candidate.text_state === 'read' || candidate.text_state === 'earlier');
  return <p className="step-text-note">{loading ? 'loading…' : stepTextNote(candidate)}</p>;
}

export function CopyTextButton({ detail }: { detail: StepTextDetail | undefined }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const text = detail?.lines.length ? detail.lines.map((line) => line.text).join('\n') : detail?.text ?? '';
  if (!text) return null;
  return (
    <button
      className="inline-link-button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
      type="button"
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

/** A step's text under "text" in its card; nothing when its text was not asked for. */
export function StepTextDetails({ candidate }: { candidate: CandidateFrame }) {
  const [open, setOpen] = useState(false);
  const text = useStepText(candidate, open);
  if (!candidate.text_state) return null;
  return (
    <details className="candidate-scores candidate-step-text" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>text</summary>
      {open ? (
        <div className="candidate-step-text-body" onClick={(event) => event.stopPropagation()}>
          <StepTextBody candidate={candidate} detail={text.data} error={text.error} />
          <CopyTextButton detail={text.data} />
        </div>
      ) : null}
    </details>
  );
}

/** Where the lines of text are, over a screenshot shown at any size. */
export function StepTextLayer({
  detail,
  highlighted,
  onHighlight,
}: {
  detail: StepTextDetail;
  highlighted: number | null;
  onHighlight: (line: number | null) => void;
}) {
  const { width, height } = detail;
  if (!width || !height) return null;
  return (
    <div className="step-text-layer" onMouseLeave={() => onHighlight(null)}>
      {detail.lines.map((line, index) => (
        <span
          className={`step-text-box ${index === highlighted ? 'is-highlighted' : ''}`}
          key={index}
          onMouseEnter={() => onHighlight(index)}
          style={{
            left: `${(line.x / width) * 100}%`,
            top: `${(line.y / height) * 100}%`,
            width: `${(line.width / width) * 100}%`,
            height: `${(line.height / height) * 100}%`,
          }}
          title={line.text}
        />
      ))}
    </div>
  );
}
