import { useEffect, useRef, type Dispatch, type HTMLAttributes, type KeyboardEvent, type RefObject, type SetStateAction } from 'react';
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
  onApplyImportedPreset: () => void;
  onCopyPresetText: () => void;
  onResetToProjectDefaults: () => void;
  onResetToUniversalDefaults: () => void;
  onRestoreFactorySettings: () => void;
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
  onApplyImportedPreset,
  onCopyPresetText,
  onResetToProjectDefaults,
  onResetToUniversalDefaults,
  onRestoreFactorySettings,
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

      {/* Presets on the left (save and share as text), and the signature purple star reset menu on the right. */}
      <div className="analysis-param-actions">
        <div className="analysis-toolbar-shell" ref={presetMenuRef} {...bindHint('presets')}>
          <button
            aria-expanded={openPopover === 'presets'}
            aria-haspopup="menu"
            className={`analysis-task-link subtle ${openPopover === 'presets' || openPopover === 'load' || openPopover === 'preset' ? 'active' : ''}`}
            onClick={() => togglePopover('presets')}
            type="button"
          >
            presets
          </button>
          {openPopover === 'presets' ? (
            <PresetsMenu
              items={[
                [
                  { label: 'save for this project', run: onSaveProjectPreset },
                  { label: 'save as universal defaults', run: onSaveUniversalPreset },
                ],
                [
                  { label: 'load preset text…', keepOpen: true, run: () => togglePopover('load') },
                  { label: 'show preset text…', keepOpen: true, run: () => togglePopover('preset') },
                ],
              ]}
              onClose={closePopover}
            />
          ) : null}
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
                autoFocus
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
              <div className="analysis-toolbar-divider" />
              <div className="analysis-toolbar-option-list">
                <button
                  className="analysis-task-link subtle"
                  onClick={() => {
                    closePopover();
                    onRestoreFactorySettings();
                  }}
                  type="button"
                >
                  restore factory settings…
                </button>
              </div>
              <p className="analysis-toolbar-copy">
                forgets the saved universal defaults and this project's, and starts again from stepthrough's own.
              </p>
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
            this run found very few screens that stayed still. if the screen keeps moving (video, animation), draw an ignore area
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

interface PresetsMenuItem {
  label: string;
  danger?: boolean;
  title?: string;
  /** Opens a panel of its own in the menu's place, rather than closing it. */
  keepOpen?: boolean;
  run: () => void;
}

/** The presets menu, in the look of a run's menu in the tasks list: groups of actions with a rule between them, the
 *  arrow keys to move, Escape to close. */
function PresetsMenu({ items, onClose }: { items: PresetsMenuItem[][]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // the menu's keys are its own, not the page's shortcuts
    event.stopPropagation();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Escape') {
      onClose();
    }
  }

  return (
    <div className="pathway-menu is-compact analysis-presets-menu" onKeyDown={handleKeyDown} ref={ref} role="menu">
      {items.map((group, groupIndex) => (
        <div key={groupIndex} role="group">
          {groupIndex > 0 ? <div aria-hidden="true" className="pathway-menu-divider" /> : null}
          {group.map((item) => (
            <div className="pathway-menu-row" key={item.label}>
              <button
                className={`pathway-menu-item ${item.danger ? 'is-danger' : ''}`}
                onClick={() => {
                  if (!item.keepOpen) onClose();
                  item.run();
                }}
                role="menuitem"
                title={item.title}
                type="button"
              >
                <span>{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
