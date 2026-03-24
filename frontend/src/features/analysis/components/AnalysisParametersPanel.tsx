import type { Dispatch, HTMLAttributes, RefObject, SetStateAction } from 'react';
import {
  AnalysisResetDiamondButton,
  AnalysisStarResetButton,
  AnalysisStepperInput,
} from '../../../components/AnalysisControls';
import type { AnalysisHintKey, AnalysisPopoverKey } from '../../../lib/analysis';
import { describeFrameSkip, clampInteger } from '../../../lib/utils';
import {
  analysisPresetDefaults,
  clampRunSettingsForRecording,
  defaultHybridAdvancedSettings,
  describeAnalysisPreset,
  formatHybridMinDwellAnnotation,
  formatHybridOcrAnnotation,
  formatHybridSampleFpsAnnotation,
  formatHybridSettleWindowAnnotation,
  getSampleFpsGuardrail,
  mapToleranceToDetectorThreshold,
  sanitizeRunSettings,
} from '../../../lib/runSettings';
import type { RecordingSummary, RunSettings } from '../../../types';

type HintBindingProps = Pick<
  HTMLAttributes<HTMLElement>,
  'onBlur' | 'onFocus' | 'onMouseEnter' | 'onMouseLeave'
>;

export interface AnalysisParametersPanelProps {
  bindHint: (key: AnalysisHintKey) => HintBindingProps;
  closePopover: () => void;
  createRunPending: boolean;
  healthWarning: boolean;
  hintCardPosition: { left: number; top: number } | null;
  hintText: string | null;
  isDetectorModeDirty: boolean;
  isEngineDirty: boolean;
  isExtractOffsetDirty: boolean;
  isHighFpsDirty: boolean;
  isHybridAdvancedDirty: boolean;
  isMinSceneGapDirty: boolean;
  isPresetDirty: boolean;
  isSampleFpsDirty: boolean;
  isToleranceDirty: boolean;
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
  parameterColumnRef: RefObject<HTMLElement | null>;
  presetCopyFeedback: string;
  presetImportDraft: string;
  presetImportError: string;
  presetMenuRef: RefObject<HTMLDivElement | null>;
  projectDefaultSettings: RunSettings;
  resetMenuRef: RefObject<HTMLDivElement | null>;
  runSettings: RunSettings;
  sampleFpsGuardrail: ReturnType<typeof getSampleFpsGuardrail>;
  saveMenuRef: RefObject<HTMLDivElement | null>;
  selectedRecordingId: string | null;
  selectedRecordingSummary: RecordingSummary | null;
  setPresetImportDraftChange: (value: string) => void;
  setRunSettings: Dispatch<SetStateAction<RunSettings>>;
  showHighFpsWarning: boolean;
  showHints: boolean;
  showLowCandidateHint: boolean;
  showPresetText: string;
  togglePopover: (key: AnalysisPopoverKey) => void;
}

export function AnalysisParametersPanel({
  bindHint,
  closePopover,
  createRunPending,
  healthWarning,
  hintCardPosition,
  hintText,
  isDetectorModeDirty,
  isEngineDirty,
  isExtractOffsetDirty,
  isHighFpsDirty,
  isHybridAdvancedDirty,
  isMinSceneGapDirty,
  isPresetDirty,
  isSampleFpsDirty,
  isToleranceDirty,
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
  parameterColumnRef,
  presetCopyFeedback,
  presetImportDraft,
  presetImportError,
  presetMenuRef,
  projectDefaultSettings,
  resetMenuRef,
  runSettings,
  sampleFpsGuardrail,
  saveMenuRef,
  selectedRecordingId,
  selectedRecordingSummary,
  setPresetImportDraftChange,
  setRunSettings,
  showHighFpsWarning,
  showHints,
  showLowCandidateHint,
  showPresetText,
  togglePopover,
}: AnalysisParametersPanelProps) {
  return (
    <section className="analysis-column analysis-parameter-column" ref={parameterColumnRef}>
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
              className="analysis-pill success"
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
                  Paste preset text from Stepthrough to apply it to the active analysis controls.
                </p>
                <textarea
                  aria-label="Load preset text"
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
              className="analysis-pill analysis-pill-accent"
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
              <p className="analysis-toolbar-copy">Choose which defaults should replace the active analysis parameters.</p>
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
        <div className="analysis-parameter-group">
          <div className="analysis-mode-row" {...bindHint('analysis_engine')}>
            <span>analysis engine</span>
            <div className="analysis-parameter-control">
              <div className="analysis-mode-toggle">
                <button
                  className={`analysis-mode-button ${runSettings.analysis_engine === 'scene_v1' ? 'active' : ''}`}
                  onClick={() =>
                    setRunSettings((current) =>
                      sanitizeRunSettings({
                        ...current,
                        analysis_engine: 'scene_v1',
                        advanced: null,
                      }),
                    )
                  }
                  type="button"
                >
                  current v1
                </button>
                <button
                  className={`analysis-mode-button ${runSettings.analysis_engine === 'hybrid_v2' ? 'active' : ''}`}
                  onClick={() =>
                    setRunSettings((current) =>
                      sanitizeRunSettings({
                        ...current,
                        analysis_engine: 'hybrid_v2',
                        advanced: current.advanced ?? { ...defaultHybridAdvancedSettings },
                      }),
                    )
                  }
                  type="button"
                >
                  hybrid v2
                </button>
              </div>
            </div>
            {isEngineDirty && (
              <AnalysisResetDiamondButton
                className="outside"
                label="analysis engine"
                onClick={() =>
                  setRunSettings((current) => ({
                    ...current,
                    analysis_engine: projectDefaultSettings.analysis_engine,
                  }))
                }
              />
            )}
          </div>
          <span className="analysis-parameter-annotation">
            {runSettings.analysis_engine === 'hybrid_v2'
              ? 'visual diff + selective OCR for interface-level changes'
              : 'classic scene boundary detector for continuity and fast reruns'}
          </span>
        </div>

        {runSettings.analysis_engine === 'hybrid_v2' ? (
          <>
            <div className="analysis-parameter-group">
              <div className="analysis-mode-row" {...bindHint('analysis_preset')}>
                <span>preset</span>
                <div className="analysis-parameter-control">
                  <div className="analysis-mode-toggle">
                    <button
                      className={`analysis-mode-button ${runSettings.analysis_preset === 'subtle_ui' ? 'active' : ''}`}
                      onClick={() => setRunSettings((current) => ({ ...current, analysis_preset: 'subtle_ui' }))}
                      type="button"
                    >
                      subtle ui
                    </button>
                    <button
                      className={`analysis-mode-button ${runSettings.analysis_preset === 'balanced' ? 'active' : ''}`}
                      onClick={() => setRunSettings((current) => ({ ...current, analysis_preset: 'balanced' }))}
                      type="button"
                    >
                      balanced
                    </button>
                    <button
                      className={`analysis-mode-button ${runSettings.analysis_preset === 'noise_resistant' ? 'active' : ''}`}
                      onClick={() => setRunSettings((current) => ({ ...current, analysis_preset: 'noise_resistant' }))}
                      type="button"
                    >
                      ignore noise
                    </button>
                  </div>
                </div>
                {isPresetDirty && (
                  <AnalysisResetDiamondButton
                    className="outside"
                    label="analysis preset"
                    onClick={() =>
                      setRunSettings((current) => ({
                        ...current,
                        analysis_preset: projectDefaultSettings.analysis_preset,
                      }))
                    }
                  />
                )}
              </div>
              <span className="analysis-parameter-annotation">{describeAnalysisPreset(runSettings)}</span>
            </div>

            <details className="analysis-tuning-section">
              <summary className="analysis-tuning-summary" {...bindHint('hybrid_advanced')}>
                <span>advanced hybrid tuning</span>
                <span className="analysis-tuning-summary-actions">
                  {isHybridAdvancedDirty ? (
                    <AnalysisResetDiamondButton
                      label="advanced hybrid tuning"
                      onClick={() => {
                        setRunSettings((current) => ({
                          ...current,
                          advanced: projectDefaultSettings.advanced ?? { ...defaultHybridAdvancedSettings },
                        }));
                      }}
                    />
                  ) : null}
                  <span aria-hidden="true" className="analysis-tuning-summary-chevron" />
                </span>
              </summary>
              <div className="analysis-tuning-section-body">
                <div className="analysis-parameter-group">
                  <label className="analysis-parameter-row" {...bindHint('hybrid_sample_fps_override')}>
                    <span>sample fps override</span>
                    <div className="analysis-parameter-control">
                      <AnalysisStepperInput
                        ariaLabel="hybrid sample fps override"
                        className="analysis-parameter-input short"
                        max={Math.max(1, Math.ceil(selectedRecordingSummary?.fps ?? 30))}
                        min={1}
                        onChange={(rawValue) =>
                          setRunSettings((current) =>
                            clampRunSettingsForRecording(
                              {
                                ...current,
                                advanced: {
                                  ...(current.advanced ?? defaultHybridAdvancedSettings),
                                  sample_fps_override: rawValue ? Number(rawValue) : null,
                                },
                              },
                              selectedRecordingSummary?.fps ?? null,
                            ),
                          )
                        }
                        onStep={(direction) =>
                          setRunSettings((current) => {
                            const fallback = analysisPresetDefaults[current.analysis_preset].sampleFps;
                            const currentValue = current.advanced?.sample_fps_override ?? fallback;
                            return clampRunSettingsForRecording(
                              {
                                ...current,
                                advanced: {
                                  ...(current.advanced ?? defaultHybridAdvancedSettings),
                                  sample_fps_override: clampInteger(
                                    currentValue + direction,
                                    1,
                                    Math.max(1, Math.ceil(selectedRecordingSummary?.fps ?? 30)),
                                  ),
                                },
                              },
                              selectedRecordingSummary?.fps ?? null,
                            );
                          })
                        }
                        value={runSettings.advanced?.sample_fps_override ?? ''}
                      />
                    </div>
                  </label>
                  <span className="analysis-parameter-annotation">
                    {formatHybridSampleFpsAnnotation(runSettings)}
                  </span>
                </div>

                <div className="analysis-parameter-group">
                  <label className="analysis-parameter-row" {...bindHint('hybrid_min_dwell_ms')}>
                    <span>minimum dwell</span>
                    <div className="analysis-parameter-control">
                      <div className="analysis-parameter-input-group">
                        <AnalysisStepperInput
                          ariaLabel="hybrid minimum dwell"
                          className="analysis-parameter-input long"
                          min={0}
                          onChange={(rawValue) =>
                            setRunSettings((current) => ({
                              ...current,
                              advanced: {
                                ...(current.advanced ?? defaultHybridAdvancedSettings),
                                min_dwell_ms: rawValue ? Math.max(0, Number(rawValue)) : null,
                              },
                            }))
                          }
                          onStep={(direction) =>
                            setRunSettings((current) => {
                              const fallback = analysisPresetDefaults[current.analysis_preset].minDwellMs;
                              const currentValue = current.advanced?.min_dwell_ms ?? fallback;
                              return {
                                ...current,
                                advanced: {
                                  ...(current.advanced ?? defaultHybridAdvancedSettings),
                                  min_dwell_ms: Math.max(0, currentValue + direction * 25),
                                },
                              };
                            })
                          }
                          value={runSettings.advanced?.min_dwell_ms ?? ''}
                        />
                        <span className="analysis-parameter-suffix">ms</span>
                      </div>
                    </div>
                  </label>
                  <span className="analysis-parameter-annotation">
                    {formatHybridMinDwellAnnotation(runSettings)}
                  </span>
                </div>

                <div className="analysis-parameter-group">
                  <label className="analysis-parameter-row" {...bindHint('hybrid_settle_window_ms')}>
                    <span>settle window</span>
                    <div className="analysis-parameter-control">
                      <div className="analysis-parameter-input-group">
                        <AnalysisStepperInput
                          ariaLabel="hybrid settle window"
                          className="analysis-parameter-input long"
                          min={0}
                          onChange={(rawValue) =>
                            setRunSettings((current) => ({
                              ...current,
                              advanced: {
                                ...(current.advanced ?? defaultHybridAdvancedSettings),
                                settle_window_ms: rawValue ? Math.max(0, Number(rawValue)) : null,
                              },
                            }))
                          }
                          onStep={(direction) =>
                            setRunSettings((current) => {
                              const fallback = analysisPresetDefaults[current.analysis_preset].settleWindowMs;
                              const currentValue = current.advanced?.settle_window_ms ?? fallback;
                              return {
                                ...current,
                                advanced: {
                                  ...(current.advanced ?? defaultHybridAdvancedSettings),
                                  settle_window_ms: Math.max(0, currentValue + direction * 25),
                                },
                              };
                            })
                          }
                          value={runSettings.advanced?.settle_window_ms ?? ''}
                        />
                        <span className="analysis-parameter-suffix">ms</span>
                      </div>
                    </div>
                  </label>
                  <span className="analysis-parameter-annotation">
                    {formatHybridSettleWindowAnnotation(runSettings)}
                  </span>
                </div>

                <div className="analysis-parameter-group">
                  <div className="analysis-mode-row" {...bindHint('hybrid_ocr_confirmation')}>
                    <span>ocr confirmation</span>
                    <div className="analysis-parameter-control">
                      <div className="analysis-mode-toggle">
                        <button
                          className={`analysis-mode-button ${runSettings.advanced?.enable_ocr === false ? 'active' : ''}`}
                          onClick={() =>
                            setRunSettings((current) => ({
                              ...current,
                              advanced: {
                                ...(current.advanced ?? defaultHybridAdvancedSettings),
                                enable_ocr: false,
                                ocr_backend: null,
                              },
                            }))
                          }
                          type="button"
                        >
                          off
                        </button>
                        <button
                          className={`analysis-mode-button ${runSettings.advanced?.enable_ocr === false ? '' : 'active'}`}
                          onClick={() =>
                            setRunSettings((current) => ({
                              ...current,
                              advanced: {
                                ...(current.advanced ?? defaultHybridAdvancedSettings),
                                enable_ocr: true,
                                ocr_backend: 'paddleocr',
                              },
                            }))
                          }
                          type="button"
                        >
                          on
                        </button>
                      </div>
                    </div>
                  </div>
                  <span className="analysis-parameter-annotation">{formatHybridOcrAnnotation(runSettings)}</span>
                </div>
              </div>
            </details>
          </>
        ) : (
          <details className="analysis-tuning-section" open>
            <summary className="analysis-tuning-summary">
              <span>scene v1 tuning</span>
              <span className="analysis-tuning-summary-actions">
                <span aria-hidden="true" className="analysis-tuning-summary-chevron" />
              </span>
            </summary>
            <div className="analysis-tuning-section-body">
              <div className="analysis-parameter-group">
                <label className="analysis-parameter-row" {...bindHint('tolerance')}>
                  <span>tolerance</span>
                  <div className="analysis-parameter-control">
                    <AnalysisStepperInput
                      ariaLabel="tolerance"
                      className="analysis-parameter-input short"
                      max={100}
                      min={1}
                      onChange={(rawValue) =>
                        setRunSettings((current) => ({
                          ...current,
                          tolerance: clampInteger(rawValue === '' ? 1 : Number(rawValue), 1, 100),
                        }))
                      }
                      onStep={(direction) =>
                        setRunSettings((current) => ({
                          ...current,
                          tolerance: clampInteger(current.tolerance + direction, 1, 100),
                        }))
                      }
                      value={runSettings.tolerance}
                    />
                  </div>
                  {isToleranceDirty && (
                    <AnalysisResetDiamondButton
                      className="outside"
                      label="tolerance"
                      onClick={() =>
                        setRunSettings((current) => ({
                          ...current,
                          tolerance: projectDefaultSettings.tolerance,
                        }))
                      }
                    />
                  )}
                </label>
                <span className="analysis-parameter-annotation">
                  {runSettings.detector_mode === 'adaptive' ? 'adaptive' : 'content'} threshold:{' '}
                  {mapToleranceToDetectorThreshold(runSettings.tolerance, runSettings.detector_mode)}
                </span>
              </div>
              <div className="analysis-parameter-group">
                <label className="analysis-parameter-row" {...bindHint('min_scene_gap_ms')}>
                  <span>minimum scene gap</span>
                  <div className="analysis-parameter-control">
                    <div className="analysis-parameter-input-group">
                      <AnalysisStepperInput
                        ariaLabel="minimum scene gap"
                        className="analysis-parameter-input long"
                        min={0}
                        onChange={(rawValue) =>
                          setRunSettings((current) => ({
                            ...current,
                            min_scene_gap_ms: clampInteger(rawValue === '' ? 0 : Number(rawValue), 0),
                          }))
                        }
                        onStep={(direction) =>
                          setRunSettings((current) => ({
                            ...current,
                            min_scene_gap_ms: clampInteger(current.min_scene_gap_ms + direction, 0),
                          }))
                        }
                        value={runSettings.min_scene_gap_ms}
                      />
                      <span className="analysis-parameter-suffix">ms</span>
                    </div>
                  </div>
                  {isMinSceneGapDirty && (
                    <AnalysisResetDiamondButton
                      className="outside"
                      label="minimum scene gap"
                      onClick={() =>
                        setRunSettings((current) => ({
                          ...current,
                          min_scene_gap_ms: projectDefaultSettings.min_scene_gap_ms,
                        }))
                      }
                    />
                  )}
                </label>
                <span className="analysis-parameter-annotation">
                  {(runSettings.min_scene_gap_ms / 1000).toFixed(1).replace(/\.0$/, '')}s on original timeline
                </span>
              </div>
              <div className="analysis-parameter-group">
                <label className="analysis-parameter-row" {...bindHint('sample_fps')}>
                  <span>sample fps</span>
                  <div className="analysis-parameter-control">
                    <AnalysisStepperInput
                      ariaLabel="sample fps"
                      className="analysis-parameter-input short"
                      max={sampleFpsGuardrail.maxSampleFps}
                      min={1}
                      onChange={(rawValue) =>
                        setRunSettings((current) =>
                          clampRunSettingsForRecording(
                            {
                              ...current,
                              sample_fps: rawValue
                                ? clampInteger(Number(rawValue), 1, sampleFpsGuardrail.maxSampleFps)
                                : sampleFpsGuardrail.sourceFpsAvailable
                                  ? null
                                  : sampleFpsGuardrail.maxSampleFps,
                            },
                            selectedRecordingSummary?.fps ?? null,
                          ),
                        )
                      }
                      onStep={(direction) =>
                        setRunSettings((current) =>
                          clampRunSettingsForRecording(
                            {
                              ...current,
                              sample_fps: clampInteger(
                                (current.sample_fps ?? 1) + direction,
                                1,
                                sampleFpsGuardrail.maxSampleFps,
                              ),
                            },
                            selectedRecordingSummary?.fps ?? null,
                          ),
                        )
                      }
                      value={runSettings.sample_fps ?? ''}
                    />
                  </div>
                  {isSampleFpsDirty && (
                    <AnalysisResetDiamondButton
                      className="outside"
                      label="sample fps"
                      onClick={() =>
                        setRunSettings((current) => ({
                          ...current,
                          sample_fps: projectDefaultSettings.sample_fps,
                        }))
                      }
                    />
                  )}
                </label>
                <span className="analysis-parameter-annotation">
                  {describeFrameSkip(runSettings.sample_fps, selectedRecordingSummary?.fps ?? null)}
                </span>
              </div>
              <label className="analysis-parameter-row" {...bindHint('extract_offset_ms')}>
                <span>extract offset</span>
                <div className="analysis-parameter-control">
                  <div className="analysis-parameter-input-group">
                    <AnalysisStepperInput
                      ariaLabel="extract offset"
                      className="analysis-parameter-input long"
                      min={0}
                      onChange={(rawValue) =>
                        setRunSettings((current) => ({
                          ...current,
                          extract_offset_ms: clampInteger(rawValue === '' ? 0 : Number(rawValue), 0),
                        }))
                      }
                      onStep={(direction) =>
                        setRunSettings((current) => ({
                          ...current,
                          extract_offset_ms: clampInteger(current.extract_offset_ms + direction, 0),
                        }))
                      }
                      value={runSettings.extract_offset_ms}
                    />
                    <span className="analysis-parameter-suffix">ms</span>
                  </div>
                </div>
                {isExtractOffsetDirty && (
                  <AnalysisResetDiamondButton
                    className="outside"
                    label="extract offset"
                    onClick={() =>
                      setRunSettings((current) => ({
                        ...current,
                        extract_offset_ms: projectDefaultSettings.extract_offset_ms,
                      }))
                    }
                  />
                )}
              </label>

              <div className="analysis-mode-row" {...bindHint('allow_high_fps_sampling')}>
                <span>high-fps sampling</span>
                <div className="analysis-parameter-control">
                  <div className="analysis-mode-toggle">
                    <button
                      className={`analysis-mode-button ${runSettings.allow_high_fps_sampling ? '' : 'active'}`}
                      onClick={() =>
                        setRunSettings((current) =>
                          clampRunSettingsForRecording(
                            {
                              ...current,
                              allow_high_fps_sampling: false,
                            },
                            selectedRecordingSummary?.fps ?? null,
                          ),
                        )
                      }
                      type="button"
                    >
                      off
                    </button>
                    <button
                      className={`analysis-mode-button ${runSettings.allow_high_fps_sampling ? 'active' : ''}`}
                      onClick={() =>
                        setRunSettings((current) =>
                          clampRunSettingsForRecording(
                            {
                              ...current,
                              allow_high_fps_sampling: true,
                            },
                            selectedRecordingSummary?.fps ?? null,
                          ),
                        )
                      }
                      type="button"
                    >
                      on
                    </button>
                  </div>
                </div>
                {isHighFpsDirty && (
                  <AnalysisResetDiamondButton
                    className="outside"
                    label="high-fps sampling"
                    onClick={() =>
                      setRunSettings((current) =>
                        clampRunSettingsForRecording(
                          {
                            ...current,
                            allow_high_fps_sampling: projectDefaultSettings.allow_high_fps_sampling,
                          },
                          selectedRecordingSummary?.fps ?? null,
                        ),
                      )
                    }
                  />
                )}
              </div>

              <div className="analysis-parameter-group">
                <div className="analysis-mode-row" {...bindHint('detector_mode')}>
                  <span>detector mode</span>
                  <div className="analysis-parameter-control">
                    <div className="analysis-mode-toggle">
                      <button
                        className={`analysis-mode-button ${runSettings.detector_mode === 'content' ? 'active' : ''}`}
                        onClick={() =>
                          setRunSettings((current) => ({
                            ...current,
                            detector_mode: 'content',
                          }))
                        }
                        type="button"
                      >
                        content
                      </button>
                      <button
                        className={`analysis-mode-button ${runSettings.detector_mode === 'adaptive' ? 'active' : ''}`}
                        onClick={() =>
                          setRunSettings((current) => ({
                            ...current,
                            detector_mode: 'adaptive',
                          }))
                        }
                        type="button"
                      >
                        adaptive
                      </button>
                    </div>
                  </div>
                  {isDetectorModeDirty && (
                    <AnalysisResetDiamondButton
                      className="outside"
                      label="detector mode"
                      onClick={() =>
                        setRunSettings((current) => ({
                          ...current,
                          detector_mode: projectDefaultSettings.detector_mode,
                        }))
                      }
                    />
                  )}
                </div>
                <span className="analysis-parameter-annotation">
                  {runSettings.detector_mode === 'adaptive'
                    ? 'compares against recent frames · threshold range 1–7'
                    : 'compares to previous frame · threshold range 8–48'}
                </span>
              </div>
            </div>
          </details>
        )}
      </div>

      <div className="analysis-guidance-block">
        {runSettings.analysis_engine === 'hybrid_v2' ? (
          <p className="analysis-guidance-copy">
            Hybrid v2 is tuned for interface changes first. Start with the preset that matches your tolerance for
            noise, then only use advanced controls if a specific recording still over- or under-fires.
          </p>
        ) : (
          <p className="analysis-guidance-copy">
            If steps are missing, raise sample fps first, then lower tolerance, then lower minimum scene gaps. Use
            extract offset only to improve screenshot timing.
          </p>
        )}
        {showHighFpsWarning ? (
          <p className="analysis-guidance-copy warning">
            This video is {sampleFpsGuardrail.sourceFpsCeiling} fps. Turn on high-fps sampling to use source fps or
            go above 30 fps.
          </p>
        ) : null}
        {showLowCandidateHint ? (
          <p className="analysis-guidance-copy warning">
            {runSettings.analysis_engine === 'hybrid_v2'
              ? 'This run found very few interface changes. Try the Subtle UI preset or lower the hybrid dwell/settle timing.'
              : 'This run found very few scenes. Try higher sample fps first, then lower tolerance or minimum scene gaps.'}
          </p>
        ) : null}
        {runSettings.analysis_engine === 'scene_v1' && runSettings.tolerance <= 15 ? (
          <p className="analysis-guidance-copy warning">
            Note: A very low tolerance makes the detector highly sensitive. You may get many false positives from video
            compression noise or subtle background changes.
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
