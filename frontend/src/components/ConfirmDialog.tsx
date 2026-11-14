import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface ConfirmRequest {
  /** The question, such as `delete recording.mp4?` */
  message: string;
  /** What follows from it, in a line or two. */
  detail?: string;
  /** The button that goes ahead: `delete`, `restore`; `continue` when left out. */
  confirmLabel?: string;
  /** A red button for what cannot be undone. The focus then starts on cancel, so Enter does not destroy. */
  danger?: boolean;
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

function ConfirmDialog({ request, onAnswer }: { request: ConfirmRequest; onAnswer: (value: boolean) => void }) {
  const titleId = useId();
  const detailId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // focus goes back where it was when the dialog closes
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (request.danger ? cancelRef : confirmRef).current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      // No key reaches the page behind (the review board's a, r, u and arrows); Enter and space still press the
      // focused button, which is the browser's own doing.
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        onAnswer(false);
      } else if (event.key === 'Tab') {
        // focus stays on the two buttons
        event.preventDefault();
        (document.activeElement === cancelRef.current ? confirmRef : cancelRef).current?.focus();
      }
    }
    // capture, so that this runs before any listener of the page
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      previous?.focus?.();
    };
  }, [onAnswer, request.danger]);

  return (
    <div className="confirm-overlay" onPointerDown={(event) => event.target === event.currentTarget && onAnswer(false)}>
      <div
        aria-describedby={request.detail ? detailId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="confirm-dialog"
        role="alertdialog"
      >
        <p className="confirm-dialog-message" id={titleId}>
          {request.message}
        </p>
        {request.detail ? (
          <p className="confirm-dialog-detail" id={detailId}>
            {request.detail}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="analysis-task-link subtle" onClick={() => onAnswer(false)} ref={cancelRef} type="button">
            cancel
          </button>
          <button
            className={`analysis-pill ${request.danger ? 'danger' : 'success'}`}
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
