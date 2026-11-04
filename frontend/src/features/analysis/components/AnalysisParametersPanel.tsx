import type { Dispatch, HTMLAttributes, RefObject, SetStateAction } from 'react';
import { AnalysisStarResetButton } from '../../../components/AnalysisControls';
import type { AnalysisHintKey, AnalysisPopoverKey } from '../../../lib/analysis';
import type { AnalysisMetadata, RecordingSummary, RunSettings } from '../../../types';
import { StableParametersSection } from './StableParametersSection';

type HintBindingProps = Pick<
  HTMLAttributes<HTMLElement>,
  'onBlur' | 'onFocus' | 'onMouseEnter' | 'onMouseLeave'
>;

export interface AnalysisParametersPanelProps {
  analysisMetadata: AnalysisMetadata | null;
  bindHint: (key: AnalysisHintKey) => HintBindingProps;
  closePopover: () => void;
  createRunPending: boolean;
  healthWarning: boolean;
  hintCardPosition: { left: number; top: number } | null;
  hintText: string | null;
  loadMenuRef: RefObject<HTMLDivElement | null>;
  onApplyImportedPreset: () => void;
  onCopyPresetText: () => void;
  onResetToProjectDefaults: () => void;
  onResetToUniversalDefaults: () => void;
  onSaveProjectPreset: () => void;
  onSaveUniversalPreset: () => void;
  onStartRun: () => void;
  onToggleHints: () => void;
  openPopover: AnalysisPopoverKey | null;
  ocrAvailable: boolean;
  ocrStatusMessage: string | null;
  parameterColumnRef: RefObject<HTMLElement | null>;
  presetCopyFeedback: string;
  presetImportDraft: string;
  presetImportError: string;
  presetMenuRef: RefObject<HTMLDivElement | null>;
  projectDefaultSettings: RunSettings;
  resetMenuRef: RefObject<HTMLDivElement | null>;
  runSettings: RunSettings;
  saveMenuRef: RefObject<HTMLDivElement | null>;
  selectedRecordingId: string | null;
  selectedRecordingSummary: RecordingSummary | null;
  setPresetImportDraftChange: (value: string) => void;
  setRunSettings: Dispatch<SetStateAction<RunSettings>>;
  showHints: boolean;
  showLowCandidateHint: boolean;
  showPresetText: string;
  togglePopover: (key: AnalysisPopoverKey) => void;
}

export function AnalysisParametersPanel({
  analysisMetadata,
  bindHint,
  closePopover,
  createRunPending,
  healthWarning,
  hintCardPosition,
  hintText,
  loadMenuRef,
  onApplyImportedPreset,
  onCopyPresetText,
  onResetToProjectDefaults,
  onResetToUniversalDefaults,
  onSaveProjectPreset,
  onSaveUniversalPreset,
  onStartRun,
  onToggleHints,
  openPopover,
  ocrAvailable,
  ocrStatusMessage,
  parameterColumnRef,
  presetCopyFeedback,
  presetImportDraft,
  presetImportError,
  presetMenuRef,
  projectDefaultSettings,
  resetMenuRef,
  runSettings,
  saveMenuRef,
  selectedRecordingId,
  selectedRecordingSummary,
  setPresetImportDraftChange,
  setRunSettings,
  showHints,
  showLowCandidateHint,
  showPresetText,
  togglePopover,
}: AnalysisParametersPanelProps) {
  return (
    <section className={`analysis-column analysis-parameter-column ${showHints ? 'hints-on' : ''}`} ref={parameterColumnRef}>
      <div className="analysis-column-head">
        <p>parameters</p>
        <button
          className={`analysis-task-link subtle ${showHints ? 'active' : ''}`}
          onClick={onToggleHints}
          type="button"
        >
          {showHints ? 'hide hints' : 'show hints'}
        </button>
      </div>
      <div className="analysis-divider" />

      <div className="analysis-param-actions">
        <div className="analysis-param-actions-left">
          <div className="analysis-toolbar-shell" ref={loadMenuRef}>
            <button
              aria-expanded={openPopover === 'load'}
              className={`analysis-task-link subtle ${openPopover === 'load' ? 'active' : ''}`}
              {...bindHint('load')}
              onClick={() => togglePopover('load')}
              type="button"
            >
              load
            </button>
            {openPopover === 'load' ? (
              <div className="analysis-toolbar-popover analysis-toolbar-popover-wide">
                <div className="analysis-toolbar-popover-head">
                  <span>load preset text</span>
                </div>
                <p className="analysis-toolbar-copy">
                  paste preset text from stepthrough to apply it to the active analysis controls.
                </p>
                <textarea
                  aria-label="load preset text"
                  className="analysis-preset-import-field"
                  onChange={(event) => setPresetImportDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      onApplyImportedPreset();
                    }
                  }}
                  placeholder={showPresetText}
                  rows={8}
                  value={presetImportDraft}
                />
                {presetImportError ? <p className="analysis-toolbar-feedback error">{presetImportError}</p> : null}
                <div className="analysis-toolbar-action-row">
                  <button className="analysis-pill success" onClick={onApplyImportedPreset} type="button">
                    apply
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <div className="analysis-toolbar-shell" ref={saveMenuRef}>
            <button
              aria-expanded={openPopover === 'save'}
              className={`analysis-task-link subtle ${openPopover === 'save' ? 'active' : ''}`}
              {...bindHint('save')}
              onClick={() => togglePopover('save')}
              type="button"
            >
              save...
            </button>
            {openPopover === 'save' ? (
              <div className="analysis-toolbar-popover">
                <div className="analysis-toolbar-option-list">
                  <button
                    className="analysis-task-link subtle"
                    onClick={() => {
                      onSaveProjectPreset();
                      closePopover();
                    }}
                    type="button"
                  >
                    save for this project
                  </button>
                  <button
                    className="analysis-task-link subtle"
                    onClick={() => {
                      onSaveUniversalPreset();
                      closePopover();
                    }}
                    type="button"
                  >
                    save as universal defaults
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <div className="analysis-toolbar-shell" ref={presetMenuRef}>
            <button
              aria-expanded={openPopover === 'preset'}
              className={`analysis-task-link subtle ${openPopover === 'preset' ? 'active' : ''}`}
              onClick={() => togglePopover('preset')}
              type="button"
            >
              preset text
            </button>
            {openPopover === 'preset' ? (
              <div className="analysis-toolbar-popover analysis-toolbar-popover-wide">
                <div className="analysis-toolbar-popover-head">
                  <span>preset text</span>
                  <button className="analysis-task-link subtle" onClick={onCopyPresetText} type="button">
                    copy
                  </button>
                </div>
                <pre className="analysis-preset-preview">{showPresetText}</pre>
                {presetCopyFeedback ? <p className="analysis-toolbar-feedback">{presetCopyFeedback}</p> : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="analysis-toolbar-shell analysis-toolbar-shell-right" ref={resetMenuRef} {...bindHint('reset')}>
          <AnalysisStarResetButton expanded={openPopover === 'reset'} onClick={() => togglePopover('reset')} />
          {openPopover === 'reset' ? (
            <div className="analysis-toolbar-popover analysis-toolbar-popover-purple analysis-toolbar-popover-right">
              <div className="analysis-toolbar-popover-head">
                <span>reset</span>
              </div>
              <p className="analysis-toolbar-copy">choose which defaults should replace the active analysis parameters.</p>
              <div className="analysis-toolbar-option-list">
                <button
                  className="analysis-task-link subtle"
                  onClick={() => {
                    onResetToProjectDefaults();
                    closePopover();
                  }}
                  type="button"
                >
                  reset to project defaults
                </button>
                <button
                  className="analysis-task-link subtle"
                  onClick={() => {
                    onResetToUniversalDefaults();
                    closePopover();
                  }}
                  type="button"
                >
                  reset to universal defaults
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="analysis-parameter-box" id="analysis-parameters">
        <StableParametersSection
          analysisMetadata={analysisMetadata}
          bindHint={bindHint}
          ocrAvailable={ocrAvailable}
          ocrStatusMessage={ocrStatusMessage}
          projectDefaultSettings={projectDefaultSettings}
          runSettings={runSettings}
          selectedRecordingSummary={selectedRecordingSummary}
          setRunSettings={setRunSettings}
        />
      </div>

      <div className="analysis-guidance-block">
        <p className="analysis-guidance-copy">
          pick the recording type first. if a step is missing, lower the minimum time on screen or the smallest change;
          if something that keeps moving creates extra steps, draw an ignore area over it.
        </p>
        {showLowCandidateHint ? (
          <p className="analysis-guidance-copy warning">
            this run found very few stable screens. if the screen keeps moving (video, animation), draw an ignore area
            over it, or lower the minimum time on screen.
          </p>
        ) : null}
      </div>

      <div className="analysis-param-footer">
        <button
          className="analysis-pill success analysis-run-button"
          disabled={!selectedRecordingId || createRunPending || healthWarning}
          {...bindHint('run')}
          onClick={onStartRun}
          type="button"
        >
          {createRunPending ? 'running...' : 'run analysis'}
        </button>
      </div>

      {hintText && hintCardPosition ? (
        <div
          className="analysis-hint-float"
          style={{
            left: `${hintCardPosition.left}px`,
            top: `${hintCardPosition.top}px`,
          }}
        >
          <p className="analysis-hint-float-copy">{hintText}</p>
        </div>
      ) : null}
    </section>
  );
}
