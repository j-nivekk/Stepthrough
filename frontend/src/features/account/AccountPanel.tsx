import { useEffect, useRef, useState } from 'react';
import { changePassword } from '../../api';
import { formatCalendarDate } from '../../lib/formatters';
import { isSharedAccount } from '../../lib/live';
import { formatHours, formatSize } from '../../lib/visitors';
import type { SessionUser } from '../../types';

const MIN_PASSWORD_LENGTH = 8;

export interface AccountPanelProps {
  isLoggingOut: boolean;
  open: boolean;
  user: SessionUser;
  onClose: () => void;
  onLogOut: () => void;
  onOpenUsers: () => void;
}

/** "Signed in as", password change and logging out: a panel next to settings, in the same style. */
export function AccountPanel({ isLoggingOut, open, user, onClose, onLogOut, onOpenUsers }: AccountPanelProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Element | null;
      if (shellRef.current?.contains(target) || target?.closest('[data-corner-panel-trigger="account"]')) return;
      onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  async function handleChangePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (next !== again) {
      setMessage({ tone: 'error', text: 'the two new passwords differ.' });
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setMessage({ tone: 'ok', text: 'password changed. other browsers were logged out.' });
    } catch (caught) {
      setMessage({ tone: 'error', text: caught instanceof Error ? caught.message.toLocaleLowerCase() : 'could not change it.' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="app-settings-panel" ref={shellRef} role="dialog" aria-label="account">
      <div className="app-settings-header">
        <span>account</span>
        <button className="app-settings-close" onClick={onClose} type="button" aria-label="close account">
          ×
        </button>
      </div>

      <div className="app-settings-section">
        <p className="app-settings-section-label">logged in as</p>
        <div className="app-settings-tool-row">
          <span className="account-panel-name">{user.display_name ?? user.name}</span>
          {user.is_admin && (
            <button className="app-settings-action-btn" onClick={onOpenUsers} type="button">
              admin panel
            </button>
          )}
        </div>
        <p className="app-settings-hint">
          {user.display_name ? `${user.name} · ` : ''}
          {user.tags.length ? user.tags.join(', ') : 'no tags'}
        </p>
      </div>

      {user.delete_after && (
        <div className="app-settings-section">
          <p className="app-settings-section-label">deletion</p>
          <p className="app-settings-hint account-panel-warning">
            this account and the projects only it owns are deleted on {formatCalendarDate(user.delete_after)}.
            export what you want to keep before then.
          </p>
        </div>
      )}

      {user.visitor && !user.is_admin ? (
        <div className="app-settings-section">
          <p className="app-settings-section-label">visitor account</p>
          <p className="app-settings-hint">
            projects are deleted {formatHours(user.visitor.keep_hours)} after they are made. videos up to{' '}
            {formatSize(user.visitor.upload_limit_bytes)}
            {user.visitor.storage_limit_bytes !== null && user.visitor.storage_used_bytes !== null
              ? `; ${formatSize(user.visitor.storage_used_bytes)} of ${formatSize(user.visitor.storage_limit_bytes)} used.`
              : '.'}
          </p>
        </div>
      ) : null}

      {isSharedAccount(user) ? (
        <div className="app-settings-section">
          <p className="app-settings-section-label">password</p>
          <p className="app-settings-hint">
            this account is shared, so only an administrator can give it a new password. changing it here would log
            everyone else out.
          </p>
        </div>
      ) : (
        <form className="app-settings-section" onSubmit={handleChangePassword}>
          <p className="app-settings-section-label">password</p>
          <input autoComplete="username" hidden readOnly value={user.name} />
          <input
            aria-label="current password"
            autoComplete="current-password"
            className="app-settings-field"
            onChange={(event) => setCurrent(event.target.value)}
            placeholder="current password"
            type="password"
            value={current}
          />
          <input
            aria-label="new password"
            autoComplete="new-password"
            className="app-settings-field"
            onChange={(event) => setNext(event.target.value)}
            placeholder="new password"
            type="password"
            value={next}
          />
          <div className="app-settings-action-row">
            <input
              aria-label="new password again"
              autoComplete="new-password"
              className="app-settings-field"
              onChange={(event) => setAgain(event.target.value)}
              placeholder="again"
              type="password"
              value={again}
            />
            <button
              className="app-settings-action-btn"
              disabled={!current || next.length < MIN_PASSWORD_LENGTH || !again || pending}
              type="submit"
            >
              {pending ? 'changing…' : 'change'}
            </button>
          </div>
          <p className={`app-settings-hint ${message?.tone === 'error' ? 'account-panel-error' : ''}`}>
            {message?.text ?? `at least ${MIN_PASSWORD_LENGTH} characters, not a common password. other browsers are logged out.`}
          </p>
        </form>
      )}

      <div className="app-settings-section">
        <div className="app-settings-action-row">
          <span>log out of this browser</span>
          <button className="app-settings-action-btn" disabled={isLoggingOut} onClick={onLogOut} type="button">
            {isLoggingOut ? 'logging out…' : 'log out'}
          </button>
        </div>
      </div>
    </div>
  );
}
