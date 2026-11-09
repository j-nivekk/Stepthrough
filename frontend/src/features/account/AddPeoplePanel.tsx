import { useRef, useState } from 'react';
import { createUser, importUsers } from '../../api';
import { downloadText, linksCsv } from '../../lib/accountLinks';
import type { UserImportResult, UserLink } from '../../types';
import { LinkBox } from './LinkBox';

type Source = 'list' | 'person';

// The layout of 4CAT's bulk user import, with one row per kind of entry.
const EXAMPLE_LIST = [
  'name,expires,tags,password,notes',
  'jdoe,2027-02-01,group-a,,',
  'asmith,2027-02-01,group-a group-b,,two tags: separate them with a space',
  'mlee,,,,no date: kept until an administrator deletes the account',
].join('\n') + '\n';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Rows in a list, not counting the header: enough to label the button, the server reads it properly. */
function countRows(text: string): number {
  return Math.max(0, text.split(/\r?\n/).filter((line) => line.trim()).length - 1);
}

export interface AddPeoplePanelProps {
  onChanged: () => Promise<unknown>;
}

/** The left column of the users page: one form, laid out like the analysis parameters, that imports a list
 *  (the usual way) or adds one person, with the tags and deletion date chosen before the button. */
export function AddPeoplePanel({ onChanged }: AddPeoplePanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [source, setSource] = useState<Source>('list');
  const [file, setFile] = useState<{ file: File; rows: number } | null>(null);
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [deleteAfter, setDeleteAfter] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState<{ name: string; link: UserLink } | null>(null);
  const [imported, setImported] = useState<UserImportResult | null>(null);

  async function chooseFile(chosen: File | undefined) {
    setFile(chosen ? { file: chosen, rows: countRows(await chosen.text()) } : null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      if (source === 'list' && file) {
        setImported(await importUsers(file.file, tags, deleteAfter));
        setAdded(null);
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else if (source === 'person' && name.trim()) {
        const tagList = tags.split(/[,\s]+/).map((tag) => tag.trim()).filter(Boolean);
        const result = await createUser({ name: name.trim(), tags: tagList, delete_after: deleteAfter || null });
        setAdded({ name: result.user.name, link: result.link });
        setImported(null);
        setName('');
      }
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work.');
    } finally {
      setPending(false);
    }
  }

  const ready = source === 'list' ? Boolean(file) : Boolean(name.trim());
  const label =
    source === 'list'
      ? pending
        ? 'importing…'
        : file
          ? `import ${plural(file.rows, 'person', 'people')}`
          : 'import'
      : pending
        ? 'adding…'
        : name.trim()
          ? `add ${name.trim()}`
          : 'add';
  const importLinks = imported?.created.filter((row) => row.link) ?? [];

  return (
    <section className="analysis-column users-add-column">
      <div className="analysis-column-head">
        <p>add people</p>
      </div>
      <div className="analysis-divider" />

      <form className="users-add-form" onSubmit={handleSubmit}>
        <div className="analysis-parameter-box">
          <div className="analysis-parameter-group">
            <div className="analysis-mode-row">
              <span>from</span>
              <div className="analysis-mode-toggle">
                {(['list', 'person'] as const).map((option) => (
                  <button
                    aria-pressed={source === option}
                    className={`analysis-mode-button ${source === option ? 'active' : ''}`}
                    key={option}
                    onClick={() => setSource(option)}
                    type="button"
                  >
                    {option === 'list' ? 'a list' : 'one person'}
                  </button>
                ))}
              </div>
            </div>
            <span className="analysis-parameter-annotation">
              {source === 'list'
                ? 'the usual way: a whole group at once.'
                : 'a single account, such as a new administrator.'}
            </span>
          </div>

          {source === 'list' ? (
            <div className="analysis-parameter-group">
              <div className="analysis-parameter-row">
                <span>list</span>
                <button
                  className="users-control users-file-button"
                  onClick={() => fileInputRef.current?.click()}
                  title={file?.file.name}
                  type="button"
                >
                  {file ? file.file.name : 'choose a csv file…'}
                </button>
              </div>
              <span className="analysis-parameter-annotation">
                a <code className="app-settings-code">name</code> column, as 4cat uses; optionally{' '}
                <code className="app-settings-code">expires</code>, <code className="app-settings-code">tags</code>,{' '}
                <code className="app-settings-code">password</code> and <code className="app-settings-code">notes</code>.
              </span>
              <input
                accept=".csv,.tsv,.txt,text/csv"
                className="users-file-input"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
                ref={fileInputRef}
                type="file"
              />
            </div>
          ) : (
            <div className="analysis-parameter-group">
              <label className="analysis-parameter-row">
                <span>name</span>
                <input
                  autoCapitalize="none"
                  className="users-control"
                  onChange={(event) => setName(event.target.value)}
                  placeholder="what they log in with"
                  spellCheck={false}
                  value={name}
                />
              </label>
              <span className="analysis-parameter-annotation">they get a link to choose their own password.</span>
            </div>
          )}

          <div className="analysis-parameter-group">
            <label className="analysis-parameter-row">
              <span>tags</span>
              <input
                className="users-control"
                onChange={(event) => setTags(event.target.value)}
                placeholder="none"
                spellCheck={false}
                value={tags}
              />
            </label>
            <span className="analysis-parameter-annotation">
              {source === 'list' ? "for everyone, on top of a row's own tags. " : ''}separate with commas; the admin tag
              makes an administrator.
            </span>
          </div>

          <div className="analysis-parameter-group">
            <label className="analysis-parameter-row">
              <span>deleted on</span>
              <input
                className="users-control"
                onChange={(event) => setDeleteAfter(event.target.value)}
                type="date"
                value={deleteAfter}
              />
            </label>
            <span className="analysis-parameter-annotation">
              {source === 'list' ? "unless a row has its own expires date. " : ''}without a date, the account is kept until
              an administrator deletes it.
            </span>
          </div>
        </div>

        {source === 'list' && (
          <p className="analysis-guidance-copy">
            starting a list?{' '}
            <button
              className="analysis-task-link users-inline-link"
              onClick={() => downloadText('stepthrough-people.csv', EXAMPLE_LIST)}
              type="button"
            >
              download an example
            </button>{' '}
            to fill in. a spreadsheet can save it as csv.
          </p>
        )}

        <button className="analysis-pill success analysis-run-button" disabled={!ready || pending} type="submit">
          {label}
        </button>
        {error && <p className="analysis-guidance-copy users-error">{error}</p>}
      </form>

      {added && <LinkBox link={added.link} name={added.name} onDismiss={() => setAdded(null)} />}

      {imported && (
        <div className="users-result">
          <p className="users-result-summary">
            {[
              `made ${plural(imported.created.length, 'account', 'accounts')}`,
              imported.existing.length ? `${imported.existing.length} already existed` : null,
              imported.errors.length ? `${plural(imported.errors.length, 'row', 'rows')} skipped` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {importLinks.length > 0 && (
            <>
              <p className="analysis-guidance-copy">
                each new person needs their link to choose a password. links work once, for 14 days, and are only
                shown now.
              </p>
              <button
                className="analysis-pill success"
                onClick={() => downloadText('stepthrough-links.csv', linksCsv(importLinks))}
                type="button"
              >
                download the {plural(importLinks.length, 'link', 'links')} (csv)
              </button>
            </>
          )}
          {imported.existing.length > 0 && (
            <p className="analysis-guidance-copy">left as they were: {imported.existing.join(', ')}.</p>
          )}
          {imported.errors.map((problem) => (
            <p className="analysis-guidance-copy users-error" key={problem.row}>
              row {problem.row}
              {problem.name ? ` (${problem.name})` : ''}: {problem.message}
            </p>
          ))}
          <button className="analysis-task-link subtle users-result-close" onClick={() => setImported(null)} type="button">
            done
          </button>
        </div>
      )}
    </section>
  );
}
