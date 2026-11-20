import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { analysisTaskFilters, activeRunStatuses, type AnalysisTaskFilter, type AnalysisTaskGroup, type AnalysisTaskItem } from '../../../lib/analysis';
import { formatElapsedDuration } from '../../../lib/utils';
import { EditableName } from '../../../components/EditableName';
import { formatLastChange, formatPercent, formatRunNumber, formatRunShortTimestamp, formatRunTitle } from '../../../lib/formatters';
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

interface TaskMenuState {
  runId: string;
  x: number;
  y: number;
  alignRight?: boolean;
  anchorTop?: number;
}

interface TaskMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** Afterwards the focus goes back to the run's ⋯ (not for rename, whose field takes it, nor delete, whose
   *  question does). */
  refocus?: boolean;
  run: () => void;
}

export interface AnalysisTasksPanelProps {
  analysisTaskItems: AnalysisTaskItem[];
  analysisMetadata: AnalysisMetadata | null;
  bulkDeletePending: boolean;
  bulkExportPending: boolean;
  busyRunIds: string[];
  duplicateRunPending: boolean;
  expandedTaskRunId: string | null;
  groupedTaskItems: AnalysisTaskGroup[];
  onAbortRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
  onDuplicateRun: (runId: string) => Promise<void>;
  /** Name a run ('' takes the name away); `previousName` is the name shown when the rename began ('' for none). */
  onRenameRun: (runId: string, name: string, previousName: string) => Promise<void>;
  onDeleteSelectedTasks: () => void;
  onEnterTaskSelectMode: () => void;
  onExitTaskSelectMode: () => void;
  onExpandTaskRun: (runId: string) => void;
  onExportAllCompletedTasks: () => void;
  onExportSelectedTasks: () => void;
  /** Opens the comparison of two finished runs of a recording. */
  onCompareRuns: (recordingId: string) => void;
  onReviewTaskOutputs: (recordingId: string, runId: string) => void;
  onSelectRun: (recordingId: string, runId: string, anchorId?: string) => void;
  onSetTaskFilter: (filter: AnalysisTaskFilter) => void;
  onToggleTaskSelection: (runId: string) => void;
  projectDefaultSettings: RunSettings;
  runNumberById: Map<string, number>;
  selectedRunId: string | null;
  /** The video selected in the videos column: while one is, the runs of the others are folded away. */
  selectedRecordingId: string | null;
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
  busyRunIds,
  duplicateRunPending,
  expandedTaskRunId,
  groupedTaskItems,
  onAbortRun,
  onDeleteRun,
  onDuplicateRun,
  onRenameRun,
  onDeleteSelectedTasks,
  onEnterTaskSelectMode,
  onExitTaskSelectMode,
  onExpandTaskRun,
  onExportAllCompletedTasks,
  onExportSelectedTasks,
  onCompareRuns,
  onReviewTaskOutputs,
  onSelectRun,
  onSetTaskFilter,
  onToggleTaskSelection,
  projectDefaultSettings,
  runNumberById,
  selectedRunId,
  selectedRecordingId,
  selectedRunSummary,
  selectedTaskRunIds,
  taskClockMs,
  taskFilter,
  taskSelectMode,
}: AnalysisTasksPanelProps) {
  const [collapsedRecordingIds, setCollapsedRecordingIds] = useState<Set<string>>(loadCollapsedGroups);
  // which run's name to edit, from its context menu; the nonce starts the edit again on a second click
  const [renameRequest, setRenameRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [menu, setMenu] = useState<TaskMenuState | null>(null);
  const knownActiveRunIds = useRef<Set<string> | null>(null);

  // While a video is selected, the runs of the other videos are folded away for the time being: this is not
  // saved with the groups folded by hand. A group opened meanwhile stays open until another video is selected.
  const [openedBesideSelection, setOpenedBesideSelection] = useState<Set<string>>(() => new Set());
  const foldedForSelection = (recordingId: string) =>
    Boolean(selectedRecordingId) && recordingId !== selectedRecordingId && !openedBesideSelection.has(recordingId);

  function setGroupCollapsed(recordingId: string, collapsed: boolean) {
    if (!collapsed) {
      setOpenedBesideSelection((current) => (current.has(recordingId) ? current : new Set(current).add(recordingId)));
    }
    setCollapsedRecordingIds((current) => {
      if (current.has(recordingId) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(recordingId);
      else next.delete(recordingId);
      saveCollapsedGroups(next);
      return next;
    });
  }

  // Selecting another video folds the others again, and opens its own runs.
  useEffect(() => {
    setOpenedBesideSelection(new Set());
    if (selectedRecordingId) setGroupCollapsed(selectedRecordingId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRecordingId]);

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

  const menuItem = menu ? analysisTaskItems.find((candidate) => candidate.run.id === menu.runId) ?? null : null;
  const menuRun = menuItem
    ? selectedRunId === menuItem.run.id && selectedRunSummary?.id === menuItem.run.id
      ? selectedRunSummary
      : menuItem.run
    : null;

  // Close the context menu if its run disappears (e.g. deleted in another browser).
  useEffect(() => {
    if (menu && !menuRun) setMenu(null);
  }, [menu, menuRun]);

  // Dismiss the floating run menu on outside pointerdown, scroll, resize, or Escape (matches PathwayCanvas).
  useEffect(() => {
    if (!menu) return;
    const triggerSelector = `[data-task-menu-trigger="${CSS.escape(menu.runId)}"]`;
    const close = () => setMenu(null);
    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.analysis-task-menu') || target?.closest(triggerSelector)) return;
      setMenu(null);
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenu(null);
      }
    }
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menu]);

  /** Close the menu; after Escape or an action that leaves the focus nowhere, it goes back to the run's ⋯, so
   *  that someone using the keyboard keeps their place. */
  function closeMenu(refocus = false) {
    const runId = menu?.runId;
    setMenu(null);
    if (!refocus || !runId) return;
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-task-menu-trigger="${CSS.escape(runId)}"]`)?.focus(),
    );
  }

  function handleRowContextMenu(event: MouseEvent<HTMLDivElement>, runId: string) {
    // Keep the browser's native text menu while editing a run's name inline.
    if (event.target instanceof Element && event.target.closest('input, textarea')) return;
    event.preventDefault();
    setMenu({ runId, x: event.clientX, y: event.clientY });
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, runId: string) {
    if (event.target instanceof Element && event.target.closest('input, textarea')) return;
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    const trigger = event.currentTarget.querySelector<HTMLElement>('[data-task-menu-trigger]');
    const rect = (trigger ?? event.currentTarget).getBoundingClientRect();
    setMenu({ runId, x: rect.right, y: rect.bottom + 4, alignRight: true, anchorTop: rect.top - 4 });
  }

  function handleMoreClick(event: MouseEvent<HTMLButtonElement>, runId: string) {
    if (menu?.runId === runId) {
      setMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ runId, x: rect.right, y: rect.bottom + 4, alignRight: true, anchorTop: rect.top - 4 });
  }

  function buildTaskMenuItems(run: RunSummary): TaskMenuItem[] {
    const busy = busyRunIds.includes(run.id);
    const isDone = run.status === 'completed';
    const isExpanded = expandedTaskRunId === run.id;
    return [
      {
        // the settings the run used and who changed it last, under its row
        label: isExpanded ? 'hide details' : 'details',
        refocus: true,
        run: () => onExpandTaskRun(run.id),
      },
      {
        label: 'rename',
        disabled: busy,
        run: () => setRenameRequest((current) => ({ id: run.id, nonce: (current?.nonce ?? 0) + 1 })),
      },
      {
        label: 'duplicate',
        disabled: !isDone || busy || duplicateRunPending,
        title: !isDone ? 'only completed runs can be duplicated' : undefined,
        refocus: true,
        run: () => {
          void onDuplicateRun(run.id);
        },
      },
      {
        label: 'delete',
        danger: true,
        disabled: busy,
        run: () => onDeleteRun(run.id),
      },
    ];
  }

  function renderTaskRow(item: AnalysisTaskItem) {
    const isSelected = selectedRunId === item.run.id;
    const run = isSelected && selectedRunSummary?.id === item.run.id ? selectedRunSummary : item.run;
    const busy = busyRunIds.includes(run.id);
    const runNumber = runNumberById.get(run.id) ?? 1;
    const numberLabel = formatRunNumber(run, runNumber);
    const isExpanded = expandedTaskRunId === run.id;
    const isMarked = selectedTaskRunIds.includes(run.id);
    const isError = run.status === 'failed';
    const isDone = run.status === 'completed';
    const hasCandidates = run.candidate_count > 0;
    const hasExported = Boolean(run.export_bundle_id);
    const runTimestampLabel = formatRunShortTimestamp(run.started_at ?? run.created_at);
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
              value: `${getEffectiveStableValues(stableRun, analysisMetadata).minDwellMs} ms`,
              isDirty: (stableRun.min_dwell_ms ?? null) !== (stableDefaults?.min_dwell_ms ?? null),
            },
            {
              key: 'change',
              label: 'change',
              value: `${getEffectiveStableValues(stableRun, analysisMetadata).minChangePercent.toFixed(2)} %`,
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
    const isMenuOpen = menu?.runId === run.id;
    const rowClassName = [
      'analysis-task-row',
      isSelected ? 'selected' : null,
      isLive ? 'running' : null,
      showLiveLine ? 'live-line' : null,
      isMenuOpen ? 'menu-open' : null,
    ]
      .filter(Boolean)
      .join(' ');

    // The title opens the run: at its steps once it has any and has stopped, else at the run itself.
    const opensReview = hasCandidates && ['completed', 'failed', 'cancelled'].includes(run.status);

    return (
      <div
        className={rowClassName}
        key={run.id}
        onContextMenu={(event) => handleRowContextMenu(event, run.id)}
        onKeyDown={(event) => handleRowKeyDown(event, run.id)}
        style={showLiveLine ? ({ '--run-progress': formatPercent(run.progress) } as CSSProperties) : undefined}
      >
        <div className="analysis-task-head">
          <div className="analysis-task-head-primary">
            {taskSelectMode && (
              <label className="analysis-task-select-toggle">
                <input checked={isMarked} disabled={busy && !isMarked} onChange={() => onToggleTaskSelection(run.id)} type="checkbox" />
                <span className="analysis-task-select-copy">select task</span>
              </label>
            )}
            <div className="analysis-task-title-wrap">
              <EditableName
                containerClassName="analysis-task-name"
                disabled={busy}
                displayButtonClassName={`analysis-task-title ${isError ? 'error' : ''}`}
                editRequestToken={renameRequest?.id === run.id ? renameRequest.nonce : null}
                onDisplayClick={() => {
                  if (opensReview) {
                    onReviewTaskOutputs(item.recording.id, run.id);
                  } else {
                    onSelectRun(item.recording.id, run.id, 'analysis-run-detail');
                  }
                }}
                // Typing the number back (or the name away) takes the name away: the run is called by its number again.
                onSave={(nextValue, previousValue) =>
                  onRenameRun(run.id, nextValue === numberLabel ? '' : nextValue, previousValue === numberLabel ? '' : previousValue)
                }
                renameLabel={`rename ${numberLabel}`}
                showRenameButton={false}
                textClassName="analysis-task-name-text"
                value={formatRunTitle(run, runNumber)}
              />
              {/* A named run keeps its number in sight: it is how the run is told apart in comparisons and logs. */}
              <span className="analysis-task-subtitle">{run.name ? `${numberLabel}, ${runTimestampLabel}` : runTimestampLabel}</span>
            </div>
          </div>
          <div className="analysis-task-meta">
            {busy ? <span className="analysis-task-busy live-pill" title="being changed in another browser">busy</span> : null}
            {hasExported ? <span className="analysis-task-export-badge">exported</span> : null}
            <span className={`analysis-task-progress ${isError ? 'error' : isDone ? 'success' : ''}`}>
              {progressLabel}
            </span>
            {elapsedLabel ? <span className="analysis-task-elapsed">{elapsedLabel}</span> : null}
            {run.is_abortable ? (
              <button className="analysis-task-link danger" disabled={busy} onClick={() => onAbortRun(run.id)} type="button">
                end
              </button>
            ) : null}
            <button
              aria-expanded={isMenuOpen}
              aria-haspopup="menu"
              aria-label={`more actions for ${formatRunTitle(run, runNumber)}`}
              className={`analysis-task-link plain analysis-task-more analysis-task-hover-link ${isMenuOpen ? 'is-open' : ''}`}
              data-task-menu-trigger={run.id}
              onClick={(event) => handleMoreClick(event, run.id)}
              title="more actions (right-click)"
              type="button"
            >
              ⋯
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
            {run.modified_at ? (
              <div className="analysis-task-changed">
                <span title={formatRunShortTimestamp(run.modified_at)}>{formatLastChange(run.modified_at, run.modified_by_name)}</span>
              </div>
            ) : null}
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
    const isCollapsed = collapsedRecordingIds.has(group.recording.id) || foldedForSelection(group.recording.id);
    const runCountLabel = `${group.runs.length} ${group.runs.length === 1 ? 'run' : 'runs'}`;
    const liveCount = group.runs.filter((item) => liveRunStatuses.includes(item.run.status)).length;
    const queuedCount = group.runs.filter((item) => item.run.status === 'queued').length;
    const rowsId = `analysis-task-group-rows-${group.recording.id}`;
    return (
      <div className={`analysis-task-group ${isCollapsed ? 'collapsed' : ''}`} key={group.recording.id}>
        <div className="analysis-task-group-head">
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
          {group.runs.filter((item) => item.run.status === 'completed').length >= 2 ? (
            <button
              className="analysis-task-link subtle analysis-task-compare"
              onClick={() => onCompareRuns(group.recording.id)}
              title="compare two finished runs of this recording: what other settings changed"
              type="button"
            >
              compare
            </button>
          ) : null}
        </div>
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
      {/* As the other two columns: the title and one link in the head, the rest below the rule (like parameters'
          load / save row), so that the three heads and rules stay on one line whatever the width. */}
      <div className="analysis-column-head">
        <p>tasks</p>
        {taskSelectMode ? (
          <button className="analysis-task-link subtle" onClick={onExitTaskSelectMode} type="button">
            done
          </button>
        ) : (
          <button className="analysis-task-link subtle" onClick={onEnterTaskSelectMode} type="button">
            select
          </button>
        )}
      </div>
      <div className="analysis-divider" />
      <div className="analysis-task-tools">
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
        {taskSelectMode ? (
          <div className="analysis-task-toolbar">
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
          </div>
        ) : null}
      </div>
      <div className="analysis-tasks">
        {groupedTaskItems.map((group) => renderTaskGroup(group))}
        {!analysisTaskItems.length && <p className="entry-empty-copy">run summaries will appear here once analysis starts.</p>}
        {Boolean(analysisTaskItems.length) && !groupedTaskItems.length && (
          <p className="entry-empty-copy">no tasks in this filter yet.</p>
        )}
      </div>
      {menu && menuRun ? (
        <TaskContextMenu
          alignRight={menu.alignRight}
          anchorTop={menu.anchorTop}
          items={buildTaskMenuItems(menuRun)}
          key={menu.runId}
          onClose={closeMenu}
          x={menu.x}
          y={menu.y}
        />
      ) : null}
    </section>
  );
}

/** Compact run context menu, matching PathwayMenu's visual language at the tasks list's tighter scale. */
function TaskContextMenu({
  alignRight = false,
  anchorTop,
  items,
  onClose,
  x,
  y,
}: {
  alignRight?: boolean;
  anchorTop?: number;
  items: TaskMenuItem[];
  onClose: (refocus?: boolean) => void;
  x: number;
  y: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const rawLeft = alignRight ? x - width : x;
    const flippedLeft = rawLeft + width > window.innerWidth - 8 ? x - width : rawLeft;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, flippedLeft));
    const flippedTop = y + height > window.innerHeight - 8 ? (anchorTop ?? y) - height : y;
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, flippedTop));
    setPosition({ left, top });
  }, [x, y, alignRight, anchorTop]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keys pressed in the menu are the menu's: the page's own shortcuts (a, r, u and the arrows in the step review,
    // k, Space for the video) listen on the window and would otherwise act on what is behind it.
    event.stopPropagation();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = index < 0 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      onClose(true);
    }
  }

  return (
    <div
      className="pathway-menu is-compact analysis-task-menu"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      ref={ref}
      role="menu"
      style={{ left: position.left, top: position.top }}
    >
      {items.map((item) => (
        <div className="pathway-menu-row" key={item.label}>
          <button
            className={`pathway-menu-item ${item.danger ? 'is-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onClose(item.refocus);
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
  );
}
