import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface ConfirmRequest {
  /** The question, such as `delete recording.mp4?` */
  message: string;
  /** What follows from it, in a line or two; paragraphs and links where it needs them. */
  detail?: ReactNode;
  /** The button that goes ahead: `delete`, `restore`; `continue` when left out. */
  confirmLabel?: string;
  /** A red button for what cannot be undone. The focus then starts on cancel, so Enter does not destroy. */
  danger?: boolean;
  /** For what costs others something, such as reading text on a shared server: marked like a crash-test dummy,
   *  with a yellow button. The focus starts on cancel, as for danger. */
  caution?: boolean;
}

interface Pending extends ConfirmRequest {
  resolve: (answer: boolean) => void;
}

/**
 * Ask before acting, in the page itself. The browser's own `window.confirm` is blocked in some embedded browsers
 * (it then answers no without asking), so deleting a recording there did nothing. `confirm` resolves to true or
 * false; render `dialog` once, somewhere on every page.
 */
export function useConfirm(): { confirm: (request: ConfirmRequest) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setPending((current) => {
          current?.resolve(false); // a new question replaces one still open
          return { ...request, resolve };
        });
      }),
    [],
  );

  const answer = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  return { confirm, dialog: pending ? <ConfirmDialog onAnswer={answer} request={pending} /> : null };
}

/** The mark of a crash-test dummy: a circle in yellow and black quarters. */
function CautionMark() {
  return (
    // Four quarters side by side, not yellow over a black circle, which would leave a dark rim round the yellow.
    <svg aria-hidden="true" className="confirm-dialog-mark" viewBox="0 0 32 32">
      <path d="M16 16V0A16 16 0 0 0 0 16Z M16 16V32A16 16 0 0 0 32 16Z" fill="var(--caution-yellow)" />
      <path d="M16 16V0A16 16 0 0 1 32 16Z M16 16V32A16 16 0 0 1 0 16Z" fill="#000" />
    </svg>
  );
}

function ConfirmDialog({ request, onAnswer }: { request: ConfirmRequest; onAnswer: (value: boolean) => void }) {
  const titleId = useId();
  const detailId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const careful = request.danger || request.caution;

  useEffect(() => {
    // focus goes back where it was when the dialog closes
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (careful ? cancelRef : confirmRef).current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      // No key reaches the page behind (the review board's a, r, u and arrows); Enter and space still press the
      // focused button, which is the browser's own doing.
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        onAnswer(false);
      } else if (event.key === 'Tab') {
        // focus stays in the dialog: its links and its two buttons, in turn
        event.preventDefault();
        const stops = [...(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button') ?? [])];
        const here = stops.indexOf(document.activeElement as HTMLElement);
        stops[(here + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
      }
    }
    // capture, so that this runs before any listener of the page
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      previous?.focus?.();
    };
  }, [onAnswer, careful]);

  const copy = (
    <>
      <p className="confirm-dialog-message" id={titleId}>
        {request.message}
      </p>
      {request.detail ? (
        <div className="confirm-dialog-detail" id={detailId}>
          {request.detail}
        </div>
      ) : null}
    </>
  );

  return (
    <div className="confirm-overlay" onPointerDown={(event) => event.target === event.currentTarget && onAnswer(false)}>
      <div
        aria-describedby={request.detail ? detailId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`confirm-dialog ${request.caution ? 'is-caution' : ''}`}
        ref={dialogRef}
        role="alertdialog"
      >
        {request.caution ? (
          <div className="confirm-dialog-body">
            <CautionMark />
            <div className="confirm-dialog-copy">{copy}</div>
          </div>
        ) : (
          copy
        )}
        <div className="confirm-dialog-actions">
          <button className="analysis-task-link subtle" onClick={() => onAnswer(false)} ref={cancelRef} type="button">
            cancel
          </button>
          <button
            className={`analysis-pill ${request.danger ? 'danger' : request.caution ? 'caution' : 'success'}`}
            onClick={() => onAnswer(true)}
            ref={confirmRef}
            type="button"
          >
            {request.confirmLabel ?? 'continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
