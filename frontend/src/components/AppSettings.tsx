import { useEffect, useRef, useState } from 'react';
import type { AppPreferences } from '../lib/appPreferences';
import type { HealthResponse } from '../types';

export interface AppSettingsProps {
  healthData: HealthResponse | undefined;
  isRecheckingOcr: boolean;
  isResettingDatabase: boolean;
  open: boolean;
  prefs: AppPreferences;
  onChangePref: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  onClose: () => void;
  onRecheckOcr: () => void;
  onResetDatabase: () => void;
}

export function AppSettings({
  healthData,
  isRecheckingOcr,
  isResettingDatabase,
  open,
  prefs,
  onChangePref,
  onClose,
  onRecheckOcr,
  onResetDatabase,
}: AppSettingsProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const resetInputRef = useRef<HTMLInputElement | null>(null);
  const [resetConfirmValue, setResetConfirmValue] = useState('');
  const [awaitingResetConfirm, setAwaitingResetConfirm] = useState(false);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (shellRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const ocrStatus = healthData?.ocr_status ?? null;
  const ocrStatusLabel =
    ocrStatus === 'available' ? 'ready' : ocrStatus === 'checking' ? 'checking…' : 'not installed';
  const ocrStatusClass =
    ocrStatus === 'available' ? 'ok' : ocrStatus === 'checking' ? 'checking' : 'missing';

  function handleResetClick() {
    setAwaitingResetConfirm(true);
    setResetConfirmValue('');
    setTimeout(() => resetInputRef.current?.focus(), 0);
  }

  function cancelResetConfirm() {
    setAwaitingResetConfirm(false);
    setResetConfirmValue('');
  }

  function handleResetConfirmKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancelResetConfirm();
    } else if (e.key === 'Enter' && resetConfirmValue.trim().toLowerCase() === 'reset') {
      setAwaitingResetConfirm(false);
      setResetConfirmValue('');
      onResetDatabase();
    }
  }

  return (
    <div className="app-settings-panel" ref={shellRef} role="dialog" aria-label="app settings">
      <div className="app-settings-header">
        <span>settings</span>
        <button className="app-settings-close" onClick={onClose} type="button" aria-label="close settings">
          ×
        </button>
      </div>

      <div className="app-settings-section">
        <p className="app-settings-section-label">analysis</p>
        <label className="app-settings-toggle-row">
          <span>enable v1 engine</span>
          <input
            checked={prefs.enableV1Engine}
            onChange={(e) => onChangePref('enableV1Engine', e.target.checked)}
            type="checkbox"
          />
        </label>
        <p className="app-settings-hint">
          when off, analysis always uses hybrid v2 and the engine selector is hidden throughout.
        </p>
      </div>

      <div className="app-settings-section">
        <p className="app-settings-section-label">display</p>
        <label className="app-settings-toggle-row">
          <span>performance monitor</span>
          <input
            checked={prefs.showPerfMonitor}
            onChange={(e) => onChangePref('showPerfMonitor', e.target.checked)}
            type="checkbox"
          />
        </label>
        <p className="app-settings-hint">shows a live fps readout in the bottom-left corner.</p>
      </div>

      <div className="app-settings-section">
        <p className="app-settings-section-label">system</p>
        <div className="app-settings-tool-row">
          <span>ffmpeg</span>
          <span
            className={`app-settings-status ${
              healthData ? (healthData.ffmpeg_available ? 'ok' : 'missing') : 'checking'
            }`}
          >
            {healthData ? (healthData.ffmpeg_available ? 'ready' : 'missing') : '…'}
          </span>
        </div>
        <div className="app-settings-tool-row">
          <span>ffprobe</span>
          <span
            className={`app-settings-status ${
              healthData ? (healthData.ffprobe_available ? 'ok' : 'missing') : 'checking'
            }`}
          >
            {healthData ? (healthData.ffprobe_available ? 'ready' : 'missing') : '…'}
          </span>
        </div>
        <div className="app-settings-tool-row">
          <span>ocr (paddleocr)</span>
          <span className={`app-settings-status ${ocrStatusClass}`}>{ocrStatusLabel}</span>
          {ocrStatus !== 'available' && (
            <button
              className="app-settings-action-btn"
              disabled={isRecheckingOcr || ocrStatus === 'checking'}
              onClick={onRecheckOcr}
              type="button"
            >
              {isRecheckingOcr ? 'checking…' : 'recheck'}
            </button>
          )}
        </div>
        {ocrStatus === 'unavailable' && (
          <p className="app-settings-hint">
            {'to install: '}
            <code className="app-settings-code">pip install paddlepaddle paddleocr</code>
            {', then use recheck.'}
          </p>
        )}
      </div>

      <div className="app-settings-section">
        <p className="app-settings-section-label">database</p>
        <div className="app-settings-action-row">
          <span>reset all data</span>
          {awaitingResetConfirm ? (
            <div className="app-settings-reset-confirm">
              <input
                aria-label="type reset to confirm"
                autoComplete="off"
                className="app-settings-reset-input"
                disabled={isResettingDatabase}
                onChange={(e) => setResetConfirmValue(e.target.value)}
                onKeyDown={handleResetConfirmKey}
                placeholder="type reset"
                ref={resetInputRef}
                spellCheck={false}
                type="text"
                value={resetConfirmValue}
              />
              <button
                aria-label="cancel reset"
                className="app-settings-reset-cancel"
                onClick={cancelResetConfirm}
                type="button"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              className="app-settings-danger-btn"
              disabled={isResettingDatabase}
              onClick={handleResetClick}
              type="button"
            >
              {isResettingDatabase ? 'resetting…' : 'reset'}
            </button>
          )}
        </div>
        <p className="app-settings-hint">
          {awaitingResetConfirm
            ? 'press enter to confirm, or escape to cancel.'
            : 'permanently deletes all projects, recordings, runs, and candidates. cannot be undone.'}
        </p>
      </div>
    </div>
  );
}
