import type { Dispatch, HTMLAttributes, SetStateAction } from 'react';
import { useState } from 'react';
import { absoluteApiUrl } from '../../../api';
import { AnalysisResetDiamondButton, AnalysisStepperInput } from '../../../components/AnalysisControls';
import type { AnalysisHintKey } from '../../../lib/analysis';
import {
  areStableSettingsEqual,
  defaultStableSettings,
  describeChangeSize,
  getEffectiveStableValues,
  getRecordingTypeMetadata,
  STABLE_DEFAULT_SAMPLE_FPS,
  STABLE_DEFAULT_SENSITIVITY,
  sanitizeStableSettings,
  statusBarShare,
} from '../../../lib/stableSettings';
import type { AnalysisMetadata, RecordingSummary, RunSettings, StableSettings } from '../../../types';
import { IgnoreAreaEditor } from './IgnoreAreaEditor';

type HintBindingProps = Pick<HTMLAttributes<HTMLElement>, 'onBlur' | 'onFocus' | 'onMouseEnter' | 'onMouseLeave'>;

export interface StableParametersSectionProps {
  analysisMetadata: AnalysisMetadata | null;
  bindHint: (key: AnalysisHintKey) => HintBindingProps;
  ocrAvailable: boolean;
  ocrStatusMessage: string | null;
  projectDefaultSettings: RunSettings;
  runSettings: RunSettings;
  selectedRecordingSummary: RecordingSummary | null;
  setRunSettings: Dispatch<SetStateAction<RunSettings>>;
}

interface ToggleOption<T> {
  label: string;
  value: T;
}

function ModeToggle<T extends string | boolean>({
  disabled,
  onSelect,
  options,
  value,
}: {
  disabled?: boolean;
  onSelect: (value: T) => void;
  options: ToggleOption<T>[];
  value: T;
}) {
  return (
    <div className="analysis-mode-toggle">
      {options.map((option) => (
        <button
          className={`analysis-mode-button ${value === option.value ? 'active' : ''}`}
          disabled={disabled}
          key={String(option.value)}
          onClick={() => onSelect(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const ON_OFF: ToggleOption<boolean>[] = [
  { label: 'off', value: false },
  { label: 'on', value: true },
];

export function StableParametersSection({
  analysisMetadata,
  bindHint,
  ocrAvailable,
  ocrStatusMessage,
  projectDefaultSettings,
  runSettings,
  selectedRecordingSummary,
  setRunSettings,
}: StableParametersSectionProps) {
  const [editingAreas, setEditingAreas] = useState(false);
  const stable = runSettings.stable ?? defaultStableSettings;
  const defaults = projectDefaultSettings.stable ?? defaultStableSettings;
  const effective = getEffectiveStableValues(stable, analysisMetadata);
  const typeMetadata = getRecordingTypeMetadata(analysisMetadata, stable.recording_type);
  const recordingWidth = selectedRecordingSummary?.width ?? null;
  const recordingHeight = selectedRecordingSummary?.height ?? null;
  const statusBarVisible = stable.recording_type === 'phone' && statusBarShare(recordingWidth, recordingHeight) > 0;

  function update(patch: Partial<StableSettings>) {
    setRunSettings((current) => ({
      ...current,
      stable: sanitizeStableSettings({ ...(current.stable ?? defaultStableSettings), ...patch }),
    }));
  }

  function dirty<K extends keyof StableSettings>(key: K): boolean {
    return !areStableSettingsEqual({ ...defaults, [key]: stable[key] }, defaults);
  }

  function resetButton<K extends keyof StableSettings>(key: K, label: string) {
    return dirty(key) ? (
      <AnalysisResetDiamondButton className="outside" label={label} onClick={() => update({ [key]: defaults[key] })} />
    ) : null;
  }

  const advancedDirty = dirty('sensitivity') || dirty('sample_fps');

  return (
    <>
      <div className="analysis-parameter-group">
        <div className="analysis-mode-row" {...bindHint('stable_recording_type')}>
          <span>recording type</span>
          <div className="analysis-parameter-control">
            <ModeToggle
              onSelect={(recordingType) => update({ recording_type: recordingType })}
              options={[
                { label: 'phone or tablet', value: 'phone' },
                { label: 'computer', value: 'desktop' },
              ]}
              value={stable.recording_type}
            />
          </div>
          {resetButton('recording_type', 'recording type')}
        </div>
        <span className="analysis-parameter-annotation">{typeMetadata.description.toLowerCase()}</span>
      </div>

      <div className="analysis-parameter-group">
        <label className="analysis-parameter-row" {...bindHint('stable_min_dwell_ms')}>
          <span>minimum time on screen</span>
          <div className="analysis-parameter-control">
            <div className="analysis-parameter-input-group">
              <AnalysisStepperInput
                ariaLabel="minimum time on screen"
                className="analysis-parameter-input long"
                max={10000}
                min={100}
                onChange={(rawValue) => update({ min_dwell_ms: rawValue ? Number(rawValue) : null })}
                onStep={(direction) => update({ min_dwell_ms: effective.minDwellMs + direction * 50 })}
                placeholder={String(effective.minDwellMs)}
                value={stable.min_dwell_ms ?? ''}
              />
              <span className="analysis-parameter-suffix">ms</span>
            </div>
          </div>
          {resetButton('min_dwell_ms', 'minimum time on screen')}
        </label>
        <span className="analysis-parameter-annotation">
          {stable.min_dwell_ms == null ? `auto: ${effective.minDwellMs} ms for this recording type. ` : ''}
          a screen must stay still this long to become a step
        </span>
      </div>

      <div className="analysis-parameter-group">
        <label className="analysis-parameter-row" {...bindHint('stable_min_change')}>
          <span>smallest change</span>
          <div className="analysis-parameter-control">
            <div className="analysis-parameter-input-group">
              <AnalysisStepperInput
                ariaLabel="smallest change"
                className="analysis-parameter-input long"
                max={25}
                min={0.01}
                onChange={(rawValue) => update({ min_change_percent: rawValue ? Number(rawValue) : null })}
                onStep={(direction) =>
                  update({ min_change_percent: Math.max(0.01, Number((effective.minChangePercent + direction * 0.05).toFixed(2))) })
                }
                placeholder={effective.minChangePercent.toFixed(2)}
                step={0.01}
                value={stable.min_change_percent ?? ''}
              />
              <span className="analysis-parameter-suffix">%</span>
            </div>
          </div>
          {resetButton('min_change_percent', 'smallest change')}
        </label>
        <span className="analysis-parameter-annotation">
          {stable.min_change_percent == null ? 'auto: ' : ''}
          {describeChangeSize(effective.minChangePercent, recordingWidth, recordingHeight)}
        </span>
      </div>

      <div className="analysis-parameter-group">
        <div className="analysis-mode-row" {...bindHint('stable_ignore_areas')}>
          <span>ignore areas</span>
          <div className="analysis-parameter-control">
            <button
              aria-expanded={editingAreas}
              className={`analysis-task-link subtle ${editingAreas ? 'active' : ''}`}
              onClick={() => setEditingAreas((open) => !open)}
              type="button"
            >
              {editingAreas ? 'done' : stable.ignore_regions.length ? `edit (${stable.ignore_regions.length})` : 'draw...'}
            </button>
          </div>
          {resetButton('ignore_regions', 'ignore areas')}
        </div>
        {editingAreas ? (
          <IgnoreAreaEditor
            durationMs={selectedRecordingSummary?.duration_ms ?? 0}
            height={recordingHeight ?? 9}
            onChange={(regions) => update({ ignore_regions: regions })}
            regions={stable.ignore_regions}
            statusBarShare={statusBarVisible && effective.ignoreStatusBar ? statusBarShare(recordingWidth, recordingHeight) : 0}
            videoUrl={selectedRecordingSummary ? absoluteApiUrl(selectedRecordingSummary.source_url) : null}
            width={recordingWidth ?? 16}
          />
        ) : null}
      </div>

      {stable.recording_type === 'phone' ? (
        <div className="analysis-parameter-group">
          <div className="analysis-mode-row" {...bindHint('stable_status_bar')}>
            <span>phone status bar</span>
            <div className="analysis-parameter-control">
              <ModeToggle
                onSelect={(ignore) => update({ ignore_status_bar: ignore === typeMetadata.ignore_status_bar ? null : ignore })}
                options={[
                  { label: 'include', value: false },
                  { label: 'ignore', value: true },
                ]}
                value={effective.ignoreStatusBar}
              />
            </div>
            {resetButton('ignore_status_bar', 'phone status bar')}
          </div>
        </div>
      ) : null}

      <div className="analysis-parameter-group">
        <div className="analysis-mode-row" {...bindHint('stable_scroll_mode')}>
          <span>scrolling</span>
          <div className="analysis-parameter-control">
            <ModeToggle
              onSelect={(mode) => update({ scroll_mode: mode })}
              options={[
                { label: 'each stop', value: 'each_stop' },
                { label: 'merge stops', value: 'merge' },
              ]}
              value={stable.scroll_mode}
            />
          </div>
          {resetButton('scroll_mode', 'scrolling')}
        </div>
        <span className="analysis-parameter-annotation">
          {stable.scroll_mode === 'merge'
            ? 'a page scrolled in several stops becomes one step, showing where the scroll began'
            : 'every place the screen comes to rest while scrolling is a step'}
        </span>
      </div>

      <div className="analysis-mode-row" {...bindHint('stable_group_typing')}>
        <span>group typing</span>
        <div className="analysis-parameter-control">
          <ModeToggle onSelect={(value) => update({ group_typing: value })} options={ON_OFF} value={stable.group_typing} />
        </div>
        {resetButton('group_typing', 'group typing')}
      </div>

      <div className="analysis-mode-row" {...bindHint('stable_opening_screen')}>
        <span>opening screen</span>
        <div className="analysis-parameter-control">
          <ModeToggle
            onSelect={(value) => update({ include_opening_screen: value })}
            options={ON_OFF}
            value={stable.include_opening_screen}
          />
        </div>
        {resetButton('include_opening_screen', 'opening screen')}
      </div>

      <div className="analysis-parameter-group">
        <div className="analysis-mode-row" {...bindHint('stable_ocr')}>
          <span>read text (ocr)</span>
          <div className="analysis-parameter-control">
            <ModeToggle
              disabled={!ocrAvailable}
              onSelect={(value) => update({ enable_ocr: value })}
              options={ON_OFF}
              value={stable.enable_ocr}
            />
          </div>
          {resetButton('enable_ocr', 'read text')}
        </div>
        <span className="analysis-parameter-annotation">
          {!ocrAvailable && ocrStatusMessage
            ? ocrStatusMessage
            : 'stores the text of each screenshot for exports; not needed to find steps'}
        </span>
      </div>

      <details className="analysis-tuning-section">
        <summary className="analysis-tuning-summary" {...bindHint('stable_advanced')}>
          <span>advanced</span>
          <span className="analysis-tuning-summary-actions">
            {advancedDirty ? (
              <AnalysisResetDiamondButton
                label="advanced settings"
                onClick={() => update({ sensitivity: defaults.sensitivity, sample_fps: defaults.sample_fps })}
              />
            ) : null}
            <span aria-hidden="true" className="analysis-tuning-summary-chevron" />
          </span>
        </summary>
        <div className="analysis-tuning-section-body">
          <div className="analysis-parameter-group">
            <label className="analysis-parameter-row" {...bindHint('stable_sensitivity')}>
              <span>pixel threshold</span>
              <div className="analysis-parameter-control">
                <div className="analysis-parameter-input-group">
                  <AnalysisStepperInput
                    ariaLabel="pixel threshold in multiples of the measured noise"
                    className="analysis-parameter-input short"
                    max={20}
                    min={1}
                    onChange={(rawValue) => update({ sensitivity: rawValue ? Number(rawValue) : null })}
                    onStep={(direction) => update({ sensitivity: effective.sensitivity + direction * 0.5 })}
                    placeholder={String(effective.sensitivity)}
                    step={0.5}
                    value={stable.sensitivity ?? ''}
                  />
                  <span className="analysis-parameter-suffix">× noise</span>
                </div>
              </div>
              {resetButton('sensitivity', 'pixel threshold')}
            </label>
            <span className="analysis-parameter-annotation">
              {stable.sensitivity == null ? `auto: ${STABLE_DEFAULT_SENSITIVITY}× ` : ''}the noise measured on the
              recording, and at least 10 grey levels
            </span>
          </div>
          <div className="analysis-parameter-group">
            <label className="analysis-parameter-row" {...bindHint('stable_sample_fps')}>
              <span>analysis rate</span>
              <div className="analysis-parameter-control">
                <div className="analysis-parameter-input-group">
                  <AnalysisStepperInput
                    ariaLabel="analysis rate"
                    className="analysis-parameter-input short"
                    max={30}
                    min={2}
                    onChange={(rawValue) => update({ sample_fps: rawValue ? Number(rawValue) : null })}
                    onStep={(direction) => update({ sample_fps: effective.sampleFps + direction })}
                    placeholder={String(effective.sampleFps)}
                    value={stable.sample_fps ?? ''}
                  />
                  <span className="analysis-parameter-suffix">fps</span>
                </div>
              </div>
              {resetButton('sample_fps', 'analysis rate')}
            </label>
            <span className="analysis-parameter-annotation">
              {stable.sample_fps == null ? `auto: ${STABLE_DEFAULT_SAMPLE_FPS} fps, ` : ''}rounded to a whole share of the
              recording&apos;s frame rate
            </span>
          </div>
        </div>
      </details>
    </>
  );
}
