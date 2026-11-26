import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getServerSettings, updateServerSettings } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import type { ServerSettings, ServerSettingsChanges } from '../../types';

/** How long usage and traffic are kept: days, 0 for nothing, null for ever. */
const KEEP_CHOICES: Array<[number | null, string]> = [
  [0, 'off'],
  [14, '2 weeks'],
  [21, '3 weeks'],
  [28, '4 weeks'],
  [56, '8 weeks'],
  [null, 'for ever'],
];

export function keepLabel(days: number | null): string {
  const named = KEEP_CHOICES.find(([value]) => value === days);
  if (named) return named[1] === 'off' ? 'not at all' : named[1];
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The keeping time of usage and traffic: a few usual lengths, for ever, off, or a number of days. A shorter time
 * deletes what is older at once, so it asks first. */
function KeepSetting({ onSave, value }: { onSave: (value: number | null) => void; value: number | null }) {
  const named = KEEP_CHOICES.some(([days]) => days === value);
  const [custom, setCustom] = useState(!named);
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const { confirm, dialog } = useConfirm();
  useEffect(() => {
    setDraft(value === null ? '' : String(value));
    if (!KEEP_CHOICES.some(([days]) => days === value)) setCustom(true);
  }, [value]);

  async function choose(next: number | null) {
    if (next === value) return;
    const shorter = next !== null && (value === null || next < value);
    if (shorter) {
      const confirmed = await confirm({
        message: next === 0 ? 'stop recording usage and traffic?' : `keep usage and traffic for ${keepLabel(next)}?`,
        detail:
          next === 0
            ? 'everything recorded so far is deleted now, and nothing more is recorded. this cannot be undone.'
            : `whatever is older than ${keepLabel(next)} is deleted now. this cannot be undone.`,
        confirmLabel: next === 0 ? 'stop and delete' : 'delete older',
        danger: true,
      });
      if (!confirmed) {
        setDraft(value === null ? '' : String(value));
        return;
      }
    }
    onSave(next);
  }

  function commitCustom() {
    const days = Number(draft);
    if (draft.trim() === '' || !Number.isInteger(days) || days < 1 || days > 3650) {
      setDraft(value === null ? '' : String(value));
      return;
    }
    void choose(days);
  }

  return (
    <label className="analysis-parameter-row">
      <span>keep usage for</span>
      <span className="users-server-number">
        <select
          className="users-control users-keep-select"
          onChange={(event) => {
            if (event.target.value === 'custom') {
              setCustom(true);
              return;
            }
            setCustom(false);
            void choose(event.target.value === 'forever' ? null : Number(event.target.value));
          }}
          value={custom ? 'custom' : value === null ? 'forever' : String(value)}
        >
          {KEEP_CHOICES.map(([days, label]) => (
            <option key={label} value={days === null ? 'forever' : String(days)}>
              {label}
            </option>
          ))}
          <option value="custom">custom…</option>
        </select>
        {custom ? (
          <>
            <input
              aria-label="days to keep usage and traffic"
              className="users-control users-keep-days"
              max={3650}
              min={1}
              onBlur={commitCustom}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // the Enter must end here: otherwise it also presses the button the question below focuses
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              step={1}
              type="number"
              value={draft}
            />
            <span className="users-server-unit">d</span>
          </>
        ) : null}
      </span>
      {dialog}
    </label>
  );
}

/** A number field that saves when it is left or Enter is pressed, and shows the saved value otherwise. */
export function NumberSetting({
  label,
  max,
  min,
  onSave,
  step,
  unit,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onSave: (value: number) => void;
  step: number;
  unit?: string;
  value: number;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    const next = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(next) || next < min || next > max) {
      setDraft(String(value));
      return;
    }
    if (next !== value) onSave(next);
  }

  return (
    <label className="analysis-parameter-row">
      <span>{label}</span>
      <span className="users-server-number">
        <input
          className="users-control"
          max={max}
          min={min}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // the Enter must end here: otherwise it also presses the button a question that follows focuses
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          step={step}
          type="number"
          value={draft}
        />
        <span className="users-server-unit">{unit ?? ''}</span>
      </span>
    </label>
  );
}

/** A number that may also be left empty, for no limit: saved when the field is left or Enter is pressed. */
export function OptionalNumberSetting({
  empty,
  label,
  max,
  onSave,
  unit,
  value,
}: {
  /** What an empty field means, as its placeholder. */
  empty: string;
  label: string;
  max: number;
  onSave: (value: number | null) => void;
  unit: string;
  value: number | null;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);

  function commit() {
    if (draft.trim() === '') {
      if (value !== null) onSave(null);
      return;
    }
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 1 || next > max) {
      setDraft(value === null ? '' : String(value));
      return;
    }
    if (next !== value) onSave(next);
  }

  return (
    <label className="analysis-parameter-row">
      <span>{label}</span>
      <span className="users-server-number">
        <input
          className="users-control"
          max={max}
          min={1}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          placeholder={empty}
          step={1}
          type="number"
          value={draft}
        />
        <span className="users-server-unit">{unit}</span>
      </span>
    </label>
  );
}

function fromConfiguration(setting: { value: unknown; default: unknown }, shown: string): string {
  return setting.value === setting.default ? 'as the server is configured.' : `the server is configured for ${shown}.`;
}

/** The server's settings and a way to change them, with a line saying how the last change went. */
export function useServerSettings() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ['server-settings'], queryFn: getServerSettings });
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (changes: ServerSettingsChanges) => updateServerSettings(changes),
    onSuccess: (settings: ServerSettings) => {
      queryClient.setQueryData(['server-settings'], settings);
      setMessage({ tone: 'ok', text: 'saved. it applies from now on.' });
    },
    onError: (error: Error) => setMessage({ tone: 'error', text: error.message.toLocaleLowerCase() }),
  });

  function save(changes: ServerSettingsChanges) {
    setMessage(null);
    mutation.mutate(changes);
  }

  return { settingsQuery, settings: settingsQuery.data, save, message, pending: mutation.isPending };
}

/** What an administrator can change while the server runs (backend/app/server_settings.py); takes effect at once.
 *  The settings for visitor accounts are with the people (VisitorSettings). */
export function ServerSettingsPanel() {
  const { settingsQuery, settings, save, message, pending } = useServerSettings();

  return (
    <section className="analysis-column users-server-column">
      <div className="analysis-column-head">
        <p>server</p>
      </div>
      <div className="analysis-divider" />
      {settingsQuery.isError && <p className="entry-empty-copy">{settingsQuery.error.message}</p>}
      {settings && (
        <div className="analysis-parameter-box">
          <div className="analysis-parameter-group">
            <NumberSetting
              label="analyses at a time"
              max={64}
              min={0}
              onSave={(value) => save({ analyses_at_a_time: value })}
              step={1}
              value={settings.analyses_at_a_time.value}
            />
            <span className="analysis-parameter-annotation">
              the others wait their turn; 0 is no limit. analyses share the server's one process, so more than 2 or 3
              mostly slows everything else down. {fromConfiguration(settings.analyses_at_a_time, String(settings.analyses_at_a_time.default || 'no limit'))}
            </span>
          </div>

          <div className="analysis-parameter-group">
            <NumberSetting
              label="text readers"
              max={8}
              min={0}
              onSave={(value) => save({ text_readers: value })}
              step={1}
              value={settings.text_readers.value}
            />
            <span className="analysis-parameter-annotation">
              processes that read the text of screenshots, after the analyses and at low priority, so nobody waits for
              them; runs take turns. each uses up to 1 GB while there is something to read. 0 turns text recognition off and
              stops what is being read. {fromConfiguration(settings.text_readers, String(settings.text_readers.default))}
            </span>
          </div>

          <div className="analysis-parameter-group">
            <NumberSetting
              label="threads for each reader"
              max={32}
              min={1}
              onSave={(value) => save({ text_threads: value })}
              step={1}
              value={settings.text_threads.value}
            />
            <span className="analysis-parameter-annotation">
              about as many processor cores it keeps busy. more make one run faster; more readers keep more runs going.{' '}
              {fromConfiguration(settings.text_threads, String(settings.text_threads.default))}
            </span>
          </div>

          <div className="analysis-parameter-group">
            <div className="analysis-mode-row">
              <span>compression</span>
              <div className="analysis-mode-toggle">
                {([true, false] as const).map((option) => (
                  <button
                    aria-pressed={settings.compression.value === option}
                    className={`analysis-mode-button ${settings.compression.value === option ? 'active' : ''}`}
                    disabled={pending}
                    key={String(option)}
                    onClick={() => settings.compression.value !== option && save({ compression: option })}
                    type="button"
                  >
                    {option ? 'on' : 'off'}
                  </button>
                ))}
              </div>
            </div>
            <span className="analysis-parameter-annotation">
              sends data, pages and scripts at about a tenth of their size. switch it off only if something goes wrong
              with it.
            </span>
          </div>

          <div className="analysis-parameter-group">
            <KeepSetting onSave={(value) => save({ usage_keep_days: value })} value={settings.usage_keep_days.value} />
            <span className="analysis-parameter-annotation">
              how long the usage and traffic reports keep what they record, then delete it: 4 weeks is half a teaching
              block of 8 weeks; custom is a number of days. off records nothing; for ever keeps everything until you choose a shorter time.
              progress is read from the projects and is not affected. {fromConfiguration(settings.usage_keep_days, keepLabel(settings.usage_keep_days.default))}
            </span>
          </div>

          <div className="analysis-parameter-group">
            <NumberSetting
              label="spread live reloads over"
              max={10}
              min={0}
              onSave={(value) => save({ live_spread_seconds: value })}
              step={0.5}
              unit="s"
              value={settings.live_spread_seconds.value}
            />
            <span className="analysis-parameter-annotation">
              in shared accounts, the browsers showing a task load it again after a change at a random moment within
              this time, so that they do not all ask at once. {fromConfiguration(settings.live_spread_seconds, `${settings.live_spread_seconds.default} s`)}
            </span>
          </div>

        </div>
      )}
      {message && (
        <p className={`analysis-guidance-copy ${message.tone === 'error' ? 'users-error' : ''}`}>{message.text}</p>
      )}
    </section>
  );
}
