import { useEffect, useMemo, useRef, useState } from 'react';
import { joinFilename, splitFilename } from '../lib/utils';

export interface EditableNameProps {
  buttonClassName?: string;
  containerClassName?: string;
  disabled?: boolean;
  displayButtonClassName?: string;
  editRequestToken?: number | string | null;
  inputClassName?: string;
  lockedExtension?: boolean;
  onDisplayClick?: () => void;
  onSave: (nextValue: string, previousValue: string) => Promise<void> | void;
  renameLabel: string;
  showRenameButton?: boolean;
  textClassName?: string;
  value: string;
}

export function EditableName({
  buttonClassName,
  containerClassName,
  disabled = false,
  displayButtonClassName,
  editRequestToken,
  inputClassName,
  lockedExtension = false,
  onDisplayClick,
  onSave,
  renameLabel,
  showRenameButton = true,
  textClassName,
  value,
}: EditableNameProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [originalValue, setOriginalValue] = useState(value);
  const saving = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editValue = isEditing ? originalValue : value;
  const { base, extension } = useMemo(
    () => (lockedExtension ? splitFilename(editValue) : { base: editValue, extension: '' }),
    [lockedExtension, editValue],
  );

  useEffect(() => {
    if (!isEditing) {
      setDraft(base);
      setError('');
      return;
    }
    setDraft(base);
    setError('');
  }, [base, isEditing]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [isEditing]);

  useEffect(() => {
    if (editRequestToken == null || disabled) {
      return;
    }
    startEditing();
  }, [disabled, editRequestToken]);

  function startEditing() {
    setOriginalValue(value);
    setIsEditing(true);
  }

  async function commitRename() {
    if (saving.current) return false;
    const nextBase = draft.trim();
    if (!nextBase) {
      setError('name required');
      return false;
    }

    const nextValue = lockedExtension ? joinFilename(nextBase, extension) : nextBase;
    if (nextValue === originalValue) {
      setIsEditing(false);
      setError('');
      return true;
    }

    saving.current = true;
    setIsSaving(true);
    try {
      await onSave(nextValue, originalValue);
      setIsEditing(false);
      setError('');
      return true;
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : 'Could not rename.');
      return false;
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  }

  return (
    <div className={containerClassName ? `editable-name ${containerClassName}` : 'editable-name'}>
      {isEditing ? (
        <div className="editable-name-edit">
          <input
            aria-label={renameLabel}
            className={inputClassName ? `editable-name-input ${inputClassName}` : 'editable-name-input'}
            disabled={isSaving}
            onBlur={() => {
              void commitRename();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) {
                setError('');
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commitRename();
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(base);
                setError('');
                setIsEditing(false);
              }
            }}
            ref={inputRef}
            type="text"
            value={draft}
          />
          {lockedExtension && extension ? <span className="editable-name-suffix">{extension}</span> : null}
        </div>
      ) : (
        <>
          {onDisplayClick ? (
            <button
              className={
                displayButtonClassName
                  ? `editable-name-display-button ${displayButtonClassName}`
                  : 'editable-name-display-button'
              }
              onClick={onDisplayClick}
              type="button"
            >
              <span
                className={textClassName ? `editable-name-text ${textClassName}` : 'editable-name-text'}
                title={value}
              >
                {value}
              </span>
            </button>
          ) : (
            <span className={textClassName ? `editable-name-text ${textClassName}` : 'editable-name-text'} title={value}>
              {value}
            </span>
          )}
          {showRenameButton ? (
            <button
              className={buttonClassName ? `editable-name-button ${buttonClassName}` : 'editable-name-button'}
              disabled={disabled}
              onClick={startEditing}
              type="button"
            >
              rename
            </button>
          ) : null}
        </>
      )}
      {error ? <span className="editable-name-error">{error}</span> : null}
    </div>
  );
}
