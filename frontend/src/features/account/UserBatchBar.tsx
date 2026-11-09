import { useState } from 'react';
import { deleteUser, newUserLink, updateUser } from '../../api';
import { downloadText, linksCsv } from '../../lib/accountLinks';
import type { AdminUser, UserLink } from '../../types';

type BatchAction = 'add-tag' | 'remove-tag' | 'delete-after' | 'links' | 'delete';

// The same rule as the server's: letters, digits, `-`, `_` and `.`.
const TAG_PATTERN = /^[\p{L}\p{N}_.-]{1,60}$/u;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

interface Outcome {
  done: AdminUser[];
  failed: { name: string; message: string }[];
}

/** Run one change per person, one after another, and keep going past failures. */
async function eachUser(users: AdminUser[], change: (user: AdminUser) => Promise<boolean | void>): Promise<Outcome> {
  const outcome: Outcome = { done: [], failed: [] };
  for (const user of users) {
    try {
      if ((await change(user)) !== false) outcome.done.push(user);
    } catch (caught) {
      outcome.failed.push({ name: user.name, message: caught instanceof Error ? caught.message : 'failed' });
    }
  }
  return outcome;
}

function describe(outcome: Outcome, verb: string): string {
  const parts = [`${verb} ${plural(outcome.done.length, 'person', 'people')}.`];
  if (outcome.failed.length) {
    const reasons = outcome.failed.map((failure) => `${failure.name}: ${failure.message.toLocaleLowerCase()}`);
    parts.push(`not changed: ${reasons.join(' · ')}`);
  }
  return parts.join(' ');
}

export interface UserBatchBarProps {
  currentUserId: string;
  selected: AdminUser[];
  /** After a change: a line for the notice, and the people who no longer exist. */
  onFinished: (message: string, deletedIds?: string[]) => void;
  /** An action was opened: the last one's notice no longer applies. */
  onOpen: () => void;
}

/** The actions for everyone selected in the people list, shown above it instead of on each row. */
export function UserBatchBar({ currentUserId, selected, onFinished, onOpen }: UserBatchBarProps) {
  const [action, setAction] = useState<BatchAction | null>(null);
  const [tag, setTag] = useState('');
  const [date, setDate] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [links, setLinks] = useState<{ name: string; link: UserLink }[] | null>(null);
  const count = selected.length;
  const others = selected.filter((user) => user.id !== currentUserId);
  const includesYou = others.length < count;
  const selectedTags = [...new Set(selected.flatMap((user) => user.tags))].sort();

  function open(next: BatchAction) {
    onOpen();
    setAction((current) => (current === next ? null : next));
    setTag('');
    setDate('');
    setConfirmText('');
    setLinks(null);
  }

  async function run(work: () => Promise<string>, deletedIds?: () => string[]) {
    setPending(true);
    try {
      const message = await work();
      onFinished(message, deletedIds?.());
    } finally {
      setPending(false);
    }
  }

  async function switchAll(off: boolean) {
    onOpen();
    setAction(null);
    await run(async () => {
      const outcome = await eachUser(off ? others : selected, async (user) => {
        if (user.is_disabled === off) return false;
        await updateUser(user.id, { is_disabled: off });
      });
      return describe(outcome, off ? 'switched off' : 'switched on') + (off && includesYou ? ' you stay on.' : '');
    });
  }

  async function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanTag = tag.trim();
    if (action === 'add-tag' || action === 'remove-tag') {
      await run(async () => {
        const outcome = await eachUser(selected, async (user) => {
          const has = user.tags.includes(cleanTag);
          if (action === 'add-tag' ? has : !has) return false;
          const tags = action === 'add-tag' ? [...user.tags, cleanTag] : user.tags.filter((item) => item !== cleanTag);
          await updateUser(user.id, { tags });
        });
        return describe(outcome, action === 'add-tag' ? `added ${cleanTag} to` : `removed ${cleanTag} from`);
      });
      setAction(null);
    } else if (action === 'delete-after') {
      await run(async () => {
        const outcome = await eachUser(selected, async (user) => {
          await updateUser(user.id, { delete_after: date || null });
        });
        return describe(outcome, date ? 'set the deletion date of' : 'removed the deletion date of');
      });
      setAction(null);
    } else if (action === 'links') {
      const made: { name: string; link: UserLink }[] = [];
      await run(async () => {
        const outcome = await eachUser(selected, async (user) => {
          made.push({ name: user.name, link: await newUserLink(user.id) });
        });
        return describe(outcome, 'made new links for');
      });
      setLinks(made);
    } else if (action === 'delete' && confirmText.trim().toLowerCase() === 'delete') {
      let deleted: string[] = [];
      await run(
        async () => {
          const outcome = await eachUser(others, async (user) => {
            await deleteUser(user.id);
          });
          deleted = outcome.done.map((user) => user.id);
          return describe(outcome, 'deleted') + (includesYou ? ' you were not deleted.' : '');
        },
        () => deleted,
      );
      setAction(null);
    }
  }

  const tagValid = TAG_PATTERN.test(tag.trim());
  const link = 'analysis-task-link subtle';
  const people = plural(count, 'person', 'people');

  return (
    <div className="users-batch">
      <div className="users-batch-actions">
        <span className="users-batch-label">with {count} selected:</span>
        <button className={`${link} ${action === 'add-tag' ? 'active' : ''}`} disabled={!count} onClick={() => open('add-tag')} type="button">
          add tag
        </button>
        <button className={`${link} ${action === 'remove-tag' ? 'active' : ''}`} disabled={!count} onClick={() => open('remove-tag')} type="button">
          remove tag
        </button>
        <button className={`${link} ${action === 'delete-after' ? 'active' : ''}`} disabled={!count} onClick={() => open('delete-after')} type="button">
          deletion date
        </button>
        <button className={`${link} ${action === 'links' ? 'active' : ''}`} disabled={!count} onClick={() => open('links')} type="button">
          new links
        </button>
        <button className={link} disabled={!count || pending} onClick={() => void switchAll(true)} type="button">
          switch off
        </button>
        <button className={link} disabled={!count || pending} onClick={() => void switchAll(false)} type="button">
          switch on
        </button>
        <button
          className={`analysis-task-link danger ${action === 'delete' ? 'active' : ''}`}
          disabled={!count}
          onClick={() => open('delete')}
          type="button"
        >
          delete
        </button>
      </div>

      {action && count > 0 && (
        <form className="analysis-parameter-box users-batch-box" onSubmit={(event) => void apply(event)}>
          {(action === 'add-tag' || action === 'remove-tag') && (
            <>
              <label className="analysis-parameter-row">
                <span>tag</span>
                <input
                  autoFocus
                  className="users-control"
                  list={action === 'remove-tag' ? 'users-batch-tags' : undefined}
                  onChange={(event) => setTag(event.target.value)}
                  placeholder={action === 'add-tag' ? 'for example group-a' : 'one of their tags'}
                  spellCheck={false}
                  value={tag}
                />
              </label>
              <datalist id="users-batch-tags">
                {selectedTags.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
              <span className="analysis-parameter-annotation">
                {tag.trim() && !tagValid
                  ? 'one tag at a time, with letters, digits, -, _ and . only.'
                  : action === 'add-tag'
                    ? 'people who already have it are left as they are. the admin tag makes administrators.'
                    : 'people without it are left as they are; you keep your own admin tag.'}
              </span>
            </>
          )}
          {action === 'delete-after' && (
            <>
              <label className="analysis-parameter-row">
                <span>deleted on</span>
                <input autoFocus className="users-control" onChange={(event) => setDate(event.target.value)} type="date" value={date} />
              </label>
              <span className="analysis-parameter-annotation">
                replaces each person's date. leave it empty to keep the accounts until an administrator deletes them.
              </span>
            </>
          )}
          {action === 'links' && (
            <span className="analysis-parameter-annotation users-batch-copy">
              a new link for each of the {people}: an invitation for those without a password, a reset for the others.
              their earlier links stop working; passwords stay until the link is used.
            </span>
          )}
          {action === 'delete' && (
            <>
              <input
                aria-label="type delete to confirm"
                autoComplete="off"
                autoFocus
                className="users-confirm-input"
                onChange={(event) => setConfirmText(event.target.value)}
                placeholder="type delete"
                spellCheck={false}
                value={confirmText}
              />
              <span className="analysis-parameter-annotation">
                deletes {plural(others.length, 'account', 'accounts')} and the projects only they own. cannot be undone.
                {includesYou ? ' your own account is left out.' : ''}
              </span>
            </>
          )}

          {links ? (
            <div className="users-editor-actions">
              <button className={link} onClick={() => setAction(null)} type="button">
                done
              </button>
              <button
                className="analysis-pill success"
                onClick={() => downloadText('stepthrough-links.csv', linksCsv(links))}
                type="button"
              >
                download the {plural(links.length, 'link', 'links')} (csv)
              </button>
            </div>
          ) : (
            <div className="users-editor-actions">
              <button className={link} onClick={() => setAction(null)} type="button">
                cancel
              </button>
              <button
                className={`analysis-pill ${action === 'delete' ? 'danger' : 'success'}`}
                disabled={
                  pending ||
                  ((action === 'add-tag' || action === 'remove-tag') && !tagValid) ||
                  (action === 'delete' && (confirmText.trim().toLowerCase() !== 'delete' || !others.length))
                }
                type="submit"
              >
                {pending
                  ? 'working…'
                  : action === 'add-tag'
                    ? `add to ${people}`
                    : action === 'remove-tag'
                      ? `remove from ${people}`
                      : action === 'delete-after'
                        ? `set for ${people}`
                        : action === 'links'
                          ? `make ${plural(count, 'link', 'links')}`
                          : `delete ${plural(others.length, 'person', 'people')}`}
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
