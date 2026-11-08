import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { analysisTaskFilters, activeRunStatuses, type AnalysisTaskFilter, type AnalysisTaskGroup, type AnalysisTaskItem } from '../../../lib/analysis';
import { formatElapsedDuration } from '../../../lib/utils';
import { formatPercent, formatRunShortTimestamp } from '../../../lib/formatters';
import { formatRecordingTypeLabel, getEffectiveStableValues } from '../../../lib/stableSettings';
import type { AnalysisMetadata, RunSettings, RunSummary } from '../../../types';

const COLLAPSED_GROUPS_KEY = 'stepthrough.taskGroups.collapsed';

/** Statuses that count as "working right now" for the live highlight; queued runs have not started yet. */
const liveRunStatuses: RunSummary['status'][] = ['running', 'awaiting_fallback'];

function loadCollapsedGroups(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(ids: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...ids]));
  } catch {
    // storage can be unavailable (private window, blocked site data); collapsing still works for this visit
  }
}

interface AnalysisTaskRowSetting {
  isDirty: boolean;
  key: string;
  label: string;
  value: string;
  valueClassName?: string;
}

export interface AnalysisTasksPanelProps {
  analysisTaskItems: AnalysisTaskItem[];
  analysisMetadata: AnalysisMetadata | null;
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
  selectedRunSummary: RunSummary | null;
  selectedTaskRunIds: string[];
  taskClockMs: number;
  taskFilter: AnalysisTaskFilter;
  taskSelectMode: boolean;
}

export function AnalysisTasksPanel({
  analysisTaskItems,
  analysisMetadata,
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
  selectedRunSummary,
  selectedTaskRunIds,
  taskClockMs,
  taskFilter,
  taskSelectMode,
}: AnalysisTasksPanelProps) {
  const [collapsedRecordingIds, setCollapsedRecordingIds] = useState<Set<string>>(loadCollapsedGroups);
  const knownActiveRunIds = useRef<Set<string> | null>(null);

  function setGroupCollapsed(recordingId: string, collapsed: boolean) {
    setCollapsedRecordingIds((current) => {
      if (current.has(recordingId) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(recordingId);
      else next.delete(recordingId);
      saveCollapsedGroups(next);
      return next;
    });
  }

  // A run that has just been started opens its video's group, so a new run never starts out of sight.
  useEffect(() => {
    const activeItems = analysisTaskItems.filter((item) => activeRunStatuses.includes(item.run.status));
    const previous = knownActiveRunIds.current;
    knownActiveRunIds.current = new Set(activeItems.map((item) => item.run.id));
    if (!previous) return;
    activeItems
      .filter((item) => !previous.has(item.run.id))
      .forEach((item) => setGroupCollapsed(item.recording.id, false));
  }, [analysisTaskItems]);

  // Selecting a run from elsewhere (the videos list, the review board) opens the group it sits in.
  useEffect(() => {
    if (!selectedRunId) return;
    const item = analysisTaskItems.find((candidate) => candidate.run.id === selectedRunId);
    if (item) setGroupCollapsed(item.recording.id, false);
    // only a change of selection reopens a group; list refreshes must not undo a collapse
  }, [selectedRunId]);

  function renderTaskRow(item: AnalysisTaskItem) {
    const isSelected = selectedRunId === item.run.id;
    const run = isSelected && selectedRunSummary?.id === item.run.id ? selectedRunSummary : item.run;
    const runNumber = runNumberById.get(run.id) ?? 1;
    const isExpanded = expandedTaskRunId === run.id;
    const isMarked = selectedTaskRunIds.includes(run.id);
    const isError = run.status === 'failed';
    const isDone = run.status === 'completed';
    const hasCandidates = run.candidate_count > 0;
    const hasExported = Boolean(run.export_bundle_id);
    const runTimestampLabel = formatRunShortTimestamp(run.started_at ?? run.created_at);
    const actionButtons: Array<{ anchorId?: string; label: string }> = [];
    const stableRun = run.stable ?? null;
    const stableDefaults = projectDefaultSettings.stable ?? null;
    const taskSettings: AnalysisTaskRowSetting[] =
      stableRun
        ? [
            {
              key: 'type',
              label: 'type',
              value: formatRecordingTypeLabel(stableRun.recording_type),
              valueClassName: 'mode',
              isDirty: stableRun.recording_type !== stableDefaults?.recording_type,
            },
            {
              key: 'dwell',
              label: 'on screen',
              value: `${getEffectiveStableValues(stableRun, analysisMetadata).minDwellMs}ms`,
              isDirty: (stableRun.min_dwell_ms ?? null) !== (stableDefaults?.min_dwell_ms ?? null),
            },
            {
              key: 'change',
              label: 'change',
              value: `${getEffectiveStableValues(stableRun, analysisMetadata).minChangePercent.toFixed(2)}%`,
              isDirty: (stableRun.min_change_percent ?? null) !== (stableDefaults?.min_change_percent ?? null),
            },
            ...(stableRun.ignore_regions.length
              ? [{ key: 'ignore', label: 'ignored', value: String(stableRun.ignore_regions.length), isDirty: true }]
              : []),
            {
              key: 'typing',
              label: 'typing',
              value: stableRun.group_typing ? 'grouped' : 'each pause',
              isDirty: stableRun.group_typing !== (stableDefaults?.group_typing ?? true),
            },
            ...(stableRun.scroll_mode === 'merge'
              ? [{ key: 'scroll', label: 'scroll', value: 'merged', isDirty: stableDefaults?.scroll_mode !== 'merge' }]
              : []),
          ]
        : [];
    const progressLabel = isDone
      ? `${run.candidate_count} ${run.candidate_count === 1 ? 'step' : 'steps'}`
      : isError
        ? 'error'
        : run.status === 'cancelled'
          ? 'ended'
          : run.status === 'queued'
            ? 'queued' // waiting for a free analysis slot on a shared server
            : formatPercent(run.progress);
    const elapsedSource = activeRunStatuses.includes(run.status) ? run.started_at ?? run.created_at : null;
    const elapsedLabel = elapsedSource ? formatElapsedDuration(taskClockMs - new Date(elapsedSource).getTime()) : null;
    const isLive = liveRunStatuses.includes(run.status);
    // the expanded, unselected row already shows the full progress bar
    const showLiveLine = isLive && !(isExpanded && !isSelected);
    const rowClassName = ['analysis-task-row', isSelected ? 'selected' : null, isLive ? 'running' : null, showLiveLine ? 'live-line' : null]
      .filter(Boolean)
      .join(' ');

    if (run.is_abortable) {
      actionButtons.push({ label: 'end' });
    } else if (hasCandidates && ['completed', 'failed', 'cancelled'].includes(run.status)) {
      actionButtons.push({ anchorId: 'analysis-candidate-review', label: 'review outputs' });
    } else if (!hasCandidates) {
      actionButtons.push({ anchorId: 'analysis-run-detail', label: 'view task' });
    }

    return (
      <div
        className={rowClassName}
        key={run.id}
        style={showLiveLine ? ({ '--run-progress': formatPercent(run.progress) } as CSSProperties) : undefined}
      >
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
                  if (isDone && hasCandidates) {
                    onReviewTaskOutputs(item.recording.id, run.id);
                  } else {
                    onSelectRun(item.recording.id, run.id, 'analysis-run-detail');
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
    const isCollapsed = collapsedRecordingIds.has(group.recording.id);
    const runCountLabel = `${group.runs.length} ${group.runs.length === 1 ? 'run' : 'runs'}`;
    const liveCount = group.runs.filter((item) => liveRunStatuses.includes(item.run.status)).length;
    const queuedCount = group.runs.filter((item) => item.run.status === 'queued').length;
    const rowsId = `analysis-task-group-rows-${group.recording.id}`;
    return (
      <div className={`analysis-task-group ${isCollapsed ? 'collapsed' : ''}`} key={group.recording.id}>
        <button
          aria-controls={rowsId}
          aria-expanded={!isCollapsed}
          className="analysis-task-group-header"
          onClick={() => setGroupCollapsed(group.recording.id, !isCollapsed)}
          title={`${isCollapsed ? 'show' : 'hide'} runs for ${group.recording.filename}`}
          type="button"
        >
          <span aria-hidden="true" className="analysis-task-group-chevron" />
          <span className="analysis-task-group-title">{group.recording.filename}</span>
          <span className="analysis-task-group-count">
            {isCollapsed && liveCount ? (
              <span className="analysis-task-group-live">
                <span aria-hidden="true" className="analysis-task-group-live-dot" />
                {liveCount} running
              </span>
            ) : null}
            {isCollapsed && queuedCount ? <span>{queuedCount} queued</span> : null}
            <span>{runCountLabel}</span>
          </span>
        </button>
        {isCollapsed ? null : (
          <div className="analysis-task-group-rows" id={rowsId}>
            {group.runs.map((item) => renderTaskRow(item))}
          </div>
        )}
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
        {!analysisTaskItems.length && <p className="entry-empty-copy">run summaries will appear here once analysis starts.</p>}
        {Boolean(analysisTaskItems.length) && !groupedTaskItems.length && (
          <p className="entry-empty-copy">no tasks in this filter yet.</p>
        )}
      </div>
    </section>
  );
}
