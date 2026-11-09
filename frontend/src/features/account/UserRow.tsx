import { useEffect, useState } from 'react';
import { deleteUser, newUserLink, transferProjects, updateUser } from '../../api';
import { formatCalendarDate, formatRelativeTime } from '../../lib/formatters';
import type { AdminUser, UserLink } from '../../types';
import { LinkBox } from './LinkBox';

function splitTags(text: string): string[] {
  return text.split(/[,\s]+/).map((tag) => tag.trim()).filter(Boolean);
}

function describeAccess(user: AdminUser): string {
  if (user.is_disabled) return 'switched off';
  if (user.has_password) return user.open_link === 'reset' ? 'password set · reset link open' : 'password set';
  return user.open_link ? 'invited' : 'no password yet';
}

export function describeUser(user: AdminUser, nowMs: number): string {
  if (user.is_builtin) {
    return `built-in account of projects made before logins · ${user.project_count} ${user.project_count === 1 ? 'project' : 'projects'}`;
  }
  return [
    user.display_name,
    user.tags.length ? user.tags.join(', ') : 'no tags',
    describeAccess(user),
    `${user.project_count} ${user.project_count === 1 ? 'project' : 'projects'}`,
    user.delete_after ? `deleted on ${formatCalendarDate(user.delete_after)}` : null,
    user.last_seen_at ? `seen ${formatRelativeTime(user.last_seen_at, nowMs)}` : 'never logged in',
  ]
    .filter(Boolean)
    .join(' · ');
}

type RowMode = 'idle' | 'edit' | 'delete';

export interface UserRowProps {
  currentUserId: string;
  /** Selecting several people: a checkbox instead of the row's own actions. */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelected?: () => void;
  nowMs: number;
  user: AdminUser;
  onChanged: (message?: string) => void;
}

export function UserRow({ currentUserId, nowMs, user, onChanged, selectMode, selected, onToggleSelected }: UserRowProps) {
  const isSelf = user.id === currentUserId;
  const [mode, setMode] = useState<RowMode>('idle');
  const [link, setLink] = useState<UserLink | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [tags, setTags] = useState('');
  const [deleteAfter, setDeleteAfter] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    if (selectMode) setMode('idle');
  }, [selectMode]);

  async function act(action: () => Promise<string | void>) {
    setPending(true);
    setError('');
    try {
      const message = await action();
      onChanged(message || undefined);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work.');
      return false;
    } finally {
      setPending(false);
    }
  }

  function startEditing() {
    setDisplayName(user.display_name ?? '');
    setTags(user.tags.join(', '));
    setDeleteAfter(user.delete_after ?? '');
    setNotes(user.notes ?? '');
    setError('');
    setMode('edit');
  }

  async function saveEdits(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await act(async () => {
      await updateUser(user.id, {
        display_name: displayName.trim() || null,
        tags: splitTags(tags),
        delete_after: deleteAfter || null,
        notes: notes.trim() || null,
      });
    });
    if (saved) setMode('idle');
  }

  async function makeLink() {
    await act(async () => {
      setLink(await newUserLink(user.id));
    });
  }

  async function confirmDelete(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setMode('idle');
      return;
    }
    if (event.key !== 'Enter' || confirmText.trim().toLowerCase() !== 'delete') return;
    await act(async () => {
      const { deleted_projects: projects } = await deleteUser(user.id);
      return `deleted ${user.name}${projects.length ? ` and ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}` : ''}.`;
    });
  }

  const action = 'analysis-task-link subtle';
  return (
    <div
      className={`users-row ${user.is_disabled ? 'switched-off' : ''} ${mode !== 'idle' ? 'open' : ''} ${
        selectMode ? 'selecting' : ''
      } ${selected ? 'selected' : ''} ${user.is_builtin ? 'builtin' : ''}`}
    >
      <div className="users-row-line">
        {selectMode && (
          <label className="analysis-task-select-toggle users-row-check" title={user.is_builtin ? 'the built-in account cannot be changed' : undefined}>
            <input
              checked={Boolean(selected)}
              disabled={user.is_builtin}
              onChange={() => onToggleSelected?.()}
              type="checkbox"
            />
            <span className="analysis-task-select-copy">select {user.name}</span>
          </label>
        )}
        <div
          className="users-row-copy"
          onClick={selectMode && !user.is_builtin ? () => onToggleSelected?.() : undefined}
        >
          <span className="users-row-name">
            {user.name}
            {isSelf && <span className="users-row-you">you</span>}
          </span>
          <span className="users-row-meta">{describeUser(user, nowMs)}</span>
        </div>
        {!selectMode && user.is_builtin && user.project_count > 0 && (
          <div className="users-row-actions">
            <button
              className={action}
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  const { moved } = await transferProjects(user.id, currentUserId);
                  return `${moved} ${moved === 1 ? 'project is' : 'projects are'} now yours, in your project list.`;
                })
              }
              title="projects made before logins belong to the built-in account; take them into your own list"
              type="button"
            >
              take over its projects
            </button>
          </div>
        )}
        {!selectMode && !user.is_builtin && (
          <div className="users-row-actions">
            <button className={action} onClick={startEditing} type="button">
              edit
            </button>
            <button
              className={action}
              disabled={pending}
              onClick={() => void makeLink()}
              title="a link to set a password; earlier links stop working"
              type="button"
            >
              {user.has_password ? 'reset link' : 'new link'}
            </button>
            {!isSelf && (
              <button
                className={action}
                disabled={pending}
                onClick={() => void act(async () => { await updateUser(user.id, { is_disabled: !user.is_disabled }); })}
                type="button"
              >
                {user.is_disabled ? 'switch on' : 'switch off'}
              </button>
            )}
            {!isSelf && (
              <button
                className="analysis-task-link danger"
                onClick={() => {
                  setConfirmText('');
                  setMode('delete');
                }}
                type="button"
              >
                delete
              </button>
            )}
          </div>
        )}
      </div>

      {mode === 'edit' && (
        <form className="analysis-parameter-box users-editor" onSubmit={saveEdits}>
          <label className="analysis-parameter-row">
            <span>display name</span>
            <input className="users-control" onChange={(e) => setDisplayName(e.target.value)} placeholder="none" value={displayName} />
          </label>
          <label className="analysis-parameter-row">
            <span>tags</span>
            <input
              className="users-control"
              onChange={(e) => setTags(e.target.value)}
              placeholder="none"
              spellCheck={false}
              value={tags}
            />
          </label>
          <label className="analysis-parameter-row">
            <span>deleted on</span>
            <input className="users-control" onChange={(e) => setDeleteAfter(e.target.value)} type="date" value={deleteAfter} />
          </label>
          <label className="analysis-parameter-row">
            <span>notes</span>
            <input
              className="users-control"
              onChange={(e) => setNotes(e.target.value)}
              placeholder="only administrators see these"
              value={notes}
            />
          </label>
          <div className="users-editor-actions">
            <button className={action} onClick={() => setMode('idle')} type="button">
              cancel
            </button>
            <button className="analysis-pill success" disabled={pending} type="submit">
              {pending ? 'saving…' : 'save'}
            </button>
          </div>
        </form>
      )}

      {mode === 'delete' && (
        <div className="users-confirm">
          <input
            aria-label="type delete to confirm"
            autoComplete="off"
            autoFocus
            className="users-confirm-input"
            disabled={pending}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => void confirmDelete(e)}
            placeholder="type delete"
            spellCheck={false}
            value={confirmText}
          />
          <p className="analysis-guidance-copy">
            deletes {user.name}
            {user.project_count > 0 ? ` and the projects only they own (${user.project_count} at most)` : ''}. cannot be
            undone. press enter to confirm, or{' '}
            <button className="analysis-task-link subtle users-inline-link" onClick={() => setMode('idle')} type="button">
              cancel
            </button>
            .
          </p>
        </div>
      )}

      {link && <LinkBox link={link} name={user.name} onDismiss={() => setLink(null)} />}
      {error && <p className="analysis-guidance-copy users-error">{error}</p>}
    </div>
  );
}
