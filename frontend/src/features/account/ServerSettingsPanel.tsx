import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getServerSettings, updateServerSettings } from '../../api';
import type { ServerSettings, ServerSettingsChanges } from '../../types';

/** A number field that saves when it is left or Enter is pressed, and shows the saved value otherwise. */
function NumberSetting({
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
            if (event.key === 'Enter') event.currentTarget.blur();
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

function fromConfiguration(setting: { value: unknown; default: unknown }, shown: string): string {
  return setting.value === setting.default ? 'as the server is configured.' : `the server is configured for ${shown}.`;
}

/** What an administrator can change while the server runs (backend/app/server_settings.py); takes effect at once. */
export function ServerSettingsPanel() {
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
  const settings = settingsQuery.data;

  function save(changes: ServerSettingsChanges) {
    setMessage(null);
    mutation.mutate(changes);
  }

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
            <div className="analysis-mode-row">
              <span>compression</span>
              <div className="analysis-mode-toggle">
                {([true, false] as const).map((option) => (
                  <button
                    aria-pressed={settings.compression.value === option}
                    className={`analysis-mode-button ${settings.compression.value === option ? 'active' : ''}`}
                    disabled={mutation.isPending}
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
