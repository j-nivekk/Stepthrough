import { useState } from 'react';
import { analysisTaskFilters, activeRunStatuses, type AnalysisTaskFilter, type AnalysisTaskGroup, type AnalysisTaskItem } from '../../../lib/analysis';
import { formatElapsedDuration } from '../../../lib/utils';
import { analysisPresetDefaults, formatAnalysisEngineLabel, formatAnalysisPresetLabel } from '../../../lib/runSettings';
import { formatPercent, formatRunShortTimestamp } from '../../../lib/formatters';
import type { RunSettings } from '../../../types';

interface AnalysisTaskRowSetting {
  isDirty: boolean;
  key: string;
  label: string;
  value: string;
  valueClassName?: string;
}

export interface AnalysisTasksPanelProps {
  analysisTaskItems: AnalysisTaskItem[];
  bulkDeletePending: boolean;
  bulkExportPending: boolean;
  expandedTaskRunId: string | null;
  groupedTaskItems: AnalysisTaskGroup[];
  onAbortRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
  onDeleteSelectedTasks: () => void;
  onEnterTaskSelectMode: () => void;
  onExitTaskSelectMode: () => void;
  onExpandTaskRun: (runId: string) => void;
  onExportAllCompletedTasks: () => void;
  onExportSelectedTasks: () => void;
  onReviewTaskOutputs: (recordingId: string, runId: string) => void;
  onSelectRun: (recordingId: string, runId: string, anchorId?: string) => void;
  onSetTaskFilter: (filter: AnalysisTaskFilter) => void;
  onToggleTaskSelection: (runId: string) => void;
  projectDefaultSettings: RunSettings;
  runNumberById: Map<string, number>;
  selectedRunId: string | null;
  selectedTaskRunIds: string[];
  taskClockMs: number;
  taskFilter: AnalysisTaskFilter;
  taskSelectMode: boolean;
}

export function AnalysisTasksPanel({
  analysisTaskItems,
  bulkDeletePending,
  bulkExportPending,
  expandedTaskRunId,
  groupedTaskItems,
  onAbortRun,
  onDeleteRun,
  onDeleteSelectedTasks,
  onEnterTaskSelectMode,
  onExitTaskSelectMode,
  onExpandTaskRun,
  onExportAllCompletedTasks,
  onExportSelectedTasks,
  onReviewTaskOutputs,
  onSelectRun,
  onSetTaskFilter,
  onToggleTaskSelection,
  projectDefaultSettings,
  runNumberById,
  selectedRunId,
  selectedTaskRunIds,
  taskClockMs,
  taskFilter,
  taskSelectMode,
}: AnalysisTasksPanelProps) {
  const [shakeRunId, setShakeRunId] = useState<string | null>(null);

  function triggerShake(runId: string) {
    setShakeRunId(runId);
    setTimeout(() => setShakeRunId((current) => (current === runId ? null : current)), 500);
  }

  function renderTaskRow(item: AnalysisTaskItem) {
    const run = item.run;
    const runNumber = runNumberById.get(run.id) ?? 1;
    const isExpanded = expandedTaskRunId === run.id;
    const isSelected = selectedRunId === run.id;
    const isMarked = selectedTaskRunIds.includes(run.id);
    const isError = run.status === 'failed';
    const isDone = run.status === 'completed';
    const hasCandidates = run.candidate_count > 0;
    const hasExported = Boolean(run.export_bundle_id);
    const runTimestampLabel = formatRunShortTimestamp(run.started_at ?? run.created_at);
    const actionButtons: Array<{ anchorId?: string; label: string }> = [];
    const taskSettings: AnalysisTaskRowSetting[] =
      run.analysis_engine === 'hybrid_v2'
        ? [
            {
              key: 'engine',
              label: 'engine',
              value: formatAnalysisEngineLabel(run.analysis_engine),
              valueClassName: 'mode',
              isDirty: run.analysis_engine !== projectDefaultSettings.analysis_engine,
            },
            {
              key: 'preset',
              label: 'preset',
              value: formatAnalysisPresetLabel(run.analysis_preset),
              valueClassName: 'mode',
              isDirty: run.analysis_preset !== projectDefaultSettings.analysis_preset,
            },
            {
              key: 'hybrid-fps',
              label: 'fps',
              value: String(run.advanced?.sample_fps_override ?? analysisPresetDefaults[run.analysis_preset].sampleFps),
              valueClassName: 'sample-fps',
              isDirty:
                (run.advanced?.sample_fps_override ?? null) !==
                (projectDefaultSettings.advanced?.sample_fps_override ?? null),
            },
            {
              key: 'ocr',
              label: 'ocr',
              value: run.advanced?.enable_ocr === false ? 'off' : 'on',
              isDirty:
                (run.advanced?.enable_ocr ?? true) !== (projectDefaultSettings.advanced?.enable_ocr ?? true),
            },
          ]
        : [
            {
              key: 'tolerance',
              label: 'tolerance',
              value: String(run.tolerance),
              isDirty: run.tolerance !== projectDefaultSettings.tolerance,
            },
            {
              key: 'gaps',
              label: 'gaps',
              value: String(run.min_scene_gap_ms),
              isDirty: run.min_scene_gap_ms !== projectDefaultSettings.min_scene_gap_ms,
            },
            {
              key: 'fps',
              label: 'fps',
              value: run.sample_fps ? String(run.sample_fps) : 'src',
              valueClassName: 'sample-fps',
              isDirty: run.sample_fps !== projectDefaultSettings.sample_fps,
            },
            {
              key: 'offset',
              label: 'offset',
              value: String(run.extract_offset_ms),
              isDirty: run.extract_offset_ms !== projectDefaultSettings.extract_offset_ms,
            },
            {
              key: 'mode',
              label: 'mode',
              value: run.detector_mode,
              valueClassName: 'mode',
              isDirty: run.detector_mode !== projectDefaultSettings.detector_mode,
            },
          ];
    const progressLabel = isDone
      ? `${run.candidate_count} scenes`
      : isError
        ? 'error'
        : run.status === 'cancelled'
          ? 'ended'
          : formatPercent(run.progress);
    const elapsedSource = activeRunStatuses.includes(run.status) ? run.started_at ?? run.created_at : null;
    const elapsedLabel = elapsedSource ? formatElapsedDuration(taskClockMs - new Date(elapsedSource).getTime()) : null;

    if (run.is_abortable) {
      actionButtons.push({ label: 'end' });
    } else if (hasCandidates && ['completed', 'failed', 'cancelled'].includes(run.status)) {
      actionButtons.push({ anchorId: 'analysis-candidate-review', label: 'review outputs' });
    } else if (!hasCandidates) {
      actionButtons.push({ anchorId: 'analysis-run-detail', label: 'view task' });
    }

    return (
      <div className={`analysis-task-row ${isSelected ? 'selected' : ''} ${shakeRunId === run.id ? 'shake' : ''}`} key={run.id}>
        <div className="analysis-task-head">
          <div className="analysis-task-head-primary">
            {taskSelectMode && (
              <label className="analysis-task-select-toggle">
                <input checked={isMarked} onChange={() => onToggleTaskSelection(run.id)} type="checkbox" />
                <span className="analysis-task-select-copy">select task</span>
              </label>
            )}
            <div className="analysis-task-title-wrap">
              <button
                className={`analysis-task-title ${isError ? 'error' : ''}`}
                onClick={() => {
                  if (isDone) {
                    if (hasCandidates) {
                      onReviewTaskOutputs(item.recording.id, run.id);
                    } else {
                      onSelectRun(item.recording.id, run.id, 'analysis-run-detail');
                    }
                  } else {
                    triggerShake(run.id);
                  }
                }}
                type="button"
              >
                {`run #${runNumber}`}
              </button>
              <span className="analysis-task-subtitle">{runTimestampLabel}</span>
            </div>
          </div>
          <div className="analysis-task-meta">
            {hasExported ? <span className="analysis-task-export-badge">exported</span> : null}
            <span className={`analysis-task-progress ${isError ? 'error' : isDone ? 'success' : ''}`}>
              {progressLabel}
            </span>
            {elapsedLabel ? <span className="analysis-task-elapsed">{elapsedLabel}</span> : null}
            <button
              className={`analysis-task-link ${isExpanded ? 'plain' : ''}`}
              onClick={() => onExpandTaskRun(run.id)}
              type="button"
            >
              details
            </button>
            {actionButtons.map((action) =>
              action.label === 'end' ? (
                <button className="analysis-task-link danger" key={action.label} onClick={() => onAbortRun(run.id)} type="button">
                  {action.label}
                </button>
              ) : action.label === 'review outputs' ? (
                <button
                  className="analysis-task-link subtle"
                  key={action.label}
                  onClick={() => onReviewTaskOutputs(item.recording.id, run.id)}
                  type="button"
                >
                  {action.label}
                </button>
              ) : (
                <button
                  className="analysis-task-link subtle"
                  key={action.label}
                  onClick={() => onSelectRun(item.recording.id, run.id, action.anchorId ?? 'analysis-run-detail')}
                  type="button"
                >
                  {action.label}
                </button>
              ),
            )}
            <button
              className="analysis-task-link danger analysis-task-hover-link"
              onClick={() => onDeleteRun(run.id)}
              type="button"
            >
              delete
            </button>
          </div>
        </div>

        {isExpanded && (
          <>
            {!isSelected && (
              <div className="analysis-task-bar" aria-hidden="true">
                <div className="analysis-task-bar-fill" style={{ width: isDone ? '100%' : formatPercent(run.progress) }} />
              </div>
            )}
            <div className="analysis-task-settings">
              {taskSettings.map((setting) => (
                <div className={`analysis-task-setting ${setting.key === 'mode' ? 'mode' : ''}`} key={setting.key}>
                  <span className="analysis-task-setting-label">{setting.label}</span>
                  <span
                    className={['analysis-task-setting-value', setting.valueClassName, setting.isDirty ? 'dirty' : null]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {setting.value}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  function renderTaskGroup(group: AnalysisTaskGroup) {
    const visibleRunCountLabel = `${group.runs.length} ${group.runs.length === 1 ? 'run' : 'runs'}`;
    return (
      <div className="analysis-task-group" key={group.recording.id}>
        <div className="analysis-task-group-header">
          <span className="analysis-task-group-title" title={group.recording.filename}>
            {group.recording.filename}
          </span>
          <span className="analysis-task-group-count">{visibleRunCountLabel}</span>
        </div>
        <div className="analysis-task-group-rows">{group.runs.map((item) => renderTaskRow(item))}</div>
      </div>
    );
  }

  return (
    <section className="analysis-column">
      <div className="analysis-column-head">
        <p>tasks</p>
        <div className="analysis-task-head-tools">
          <div className="analysis-task-filter-tabs">
            {analysisTaskFilters.map((filter) => (
              <button
                className={`analysis-task-filter-button ${taskFilter === filter ? 'active' : ''}`}
                key={filter}
                onClick={() => onSetTaskFilter(filter)}
                type="button"
              >
                {filter}
              </button>
            ))}
          </div>
          <div className="analysis-task-toolbar">
            {taskSelectMode ? (
              <>
                <span className="analysis-task-selection-count">{selectedTaskRunIds.length} selected</span>
                <button
                  className="analysis-task-link danger"
                  disabled={!selectedTaskRunIds.length || bulkDeletePending}
                  onClick={onDeleteSelectedTasks}
                  type="button"
                >
                  {bulkDeletePending ? 'deleting...' : 'delete selected'}
                </button>
                <button
                  className="analysis-task-link subtle"
                  disabled={!selectedTaskRunIds.length || bulkExportPending}
                  onClick={onExportSelectedTasks}
                  type="button"
                >
                  {bulkExportPending ? 'exporting...' : 'export selected'}
                </button>
                <button
                  className="analysis-task-link subtle"
                  disabled={!analysisTaskItems.some((item) => item.run.status === 'completed') || bulkExportPending}
                  onClick={onExportAllCompletedTasks}
                  type="button"
                >
                  export all completed
                </button>
                <button className="analysis-task-link subtle" onClick={onExitTaskSelectMode} type="button">
                  done
                </button>
              </>
            ) : (
              <button className="analysis-task-link subtle" onClick={onEnterTaskSelectMode} type="button">
                select
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="analysis-divider" />
      <div className="analysis-tasks">
        {groupedTaskItems.map((group) => renderTaskGroup(group))}
        {!analysisTaskItems.length && <p className="entry-empty-copy">Run summaries will appear here once analysis starts.</p>}
        {Boolean(analysisTaskItems.length) && !groupedTaskItems.length && (
          <p className="entry-empty-copy">No tasks in this filter yet.</p>
        )}
      </div>
    </section>
  );
}
