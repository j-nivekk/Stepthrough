import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isCommandBarInput } from '../lib/utils';

/**
 * Asks for the name of a new phase, where the menu that led here was, and says why when it could not be saved. With a
 * `problem` it only says that: a phase chosen in the menu could not be.
 */
export function PhaseNamePopover({
  label,
  onClose,
  onSave,
  problem = '',
  x,
  y,
}: {
  /** Which steps: "from step 5 to step 12". */
  label: string;
  onClose: () => void;
  /** Resolves when it is saved. */
  onSave: (name: string) => Promise<void>;
  problem?: string;
  x: number;
  y: number;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPlace({
      left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isCommandBarInput(event.target)) return;
      event.stopPropagation(); // the selection stays
      onClose();
    };
    window.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [onClose]);

  async function save() {
    const value = name.trim();
    if (!value || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave(value);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message.toLocaleLowerCase() : 'could not save the phase.');
      setSaving(false);
    }
  }

  return createPortal(
    <div
      aria-label={`phase of ${label}`}
      className="screen-choice-popover phase-choice-popover"
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()} // the page's shortcuts stay out of it
      ref={ref}
      role="dialog"
      style={place}
    >
      <p className="screen-choice-heading">
        {problem ? 'phase' : 'new phase'}, {label}
      </p>
      {problem ? null : (
        <form
          className="phase-choice-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            aria-label="name of the new phase"
            autoFocus
            className="candidate-field phase-choice-input"
            disabled={saving}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="sign up"
            value={name}
          />
          <button className="analysis-pill success phase-choice-save" disabled={saving || !name.trim()} type="submit">
            add
          </button>
        </form>
      )}
      {problem || error ? <span className="editable-name-error" role="alert">{problem || error}</span> : null}
    </div>,
    document.body,
  );
}
