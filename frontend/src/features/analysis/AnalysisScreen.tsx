import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
import { absoluteApiUrl, getRun } from '../../api';
import { ComparisonMetrics, CandidateCard, CandidateRow } from '../../components/CandidateCard';
import { EditableName } from '../../components/EditableName';
import {
  activeRunStatuses,
  buildCandidateComparison,
  candidateFilters,
  candidateMatchesFilter,
  candidateMatchesLabels,
  candidateLabelType,
  getNextCandidateFocusId,
  transitionLabels,
  type AnalysisHintKey,
  type AnalysisPopoverKey,
  type AnalysisTaskFilter,
  type AnalysisTaskGroup,
  type AnalysisTaskItem,
  type CandidateFilter,
  type PendingManualMark,
  type SimilarLink,
} from '../../lib/analysis';
import {
  formatPercent,
  formatPhase,
  formatRelativeTime,
  formatRunTiming,
} from '../../lib/formatters';
import { StageNavigator } from '../../components/StageNavigator';
import { formatRunSummaryLabel, parseRunPresetText } from '../../lib/runSettings';
import {
  buildReviewExportName,
  createLocalId,
  formatPlaybackTimestamp,
  isEditableElement,
  jumpToAnchor,
  normalizeZipFilename,
  clampInteger,
} from '../../lib/utils';
import type {
  AnalysisMetadata,
  CandidateFrame,
  CandidateStatus,
  ExportMode,
  OcrStatus,
  Project,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunSettings,
  TransitionType,
} from '../../types';
import { AnalysisParametersPanel } from './components/AnalysisParametersPanel';
import { AnalysisTasksPanel } from './components/AnalysisTasksPanel';
import { AnalysisVideosPanel } from './components/AnalysisVideosPanel';
import type { WorkflowStage } from '../../lib/workflow';
import { defaultStableSettings, formatStableSummary } from '../../lib/stableSettings';
import {
  loadStepLayout,
  recordingAspect,
  saveStepLayout,
  STEP_SIZE_MAX,
  STEP_SIZE_MIN,
  stepImageBox,
  stepThumbBox,
  type StepLayout,
} from '../../lib/stepLayout';
import { rangeFillStyle } from '../../lib/rangeFill';
import { playbackWindows, stepClip } from '../../lib/stepClips';
import type { StepHoverProps } from '../../components/CandidateCard';
import { useHoverClips } from './useHoverClips';
import { usePlaybackHighlight } from './usePlaybackHighlight';


export interface AnalysisScreenProps {
  acceptedStepSimilarityLinks: Map<string, SimilarLink>;
  analysisMetadata: AnalysisMetadata | null;
  abortRunPending: boolean;
  activeProject: Project | null;
  analysisActionMessage: string;
  analysisTaskItems: AnalysisTaskItem[];
  appError: string;
  bulkDeletePending: boolean;
  bulkExportPending: boolean;
  candidateSimilarityLinks: Map<string, SimilarLink>;
  createManualCandidatePending: boolean;
  createManualRunPending: boolean;
  createRunPending: boolean;
  exportRunPending: boolean;
  healthMessage: string | null;
  healthWarning: boolean;
  liveMessage: string;
  onAbortRun: (runId: string) => void;
  onApplyImportedPreset: (settings: RunSettings) => void;
  onBulkUpdateCandidates: (
    runId: string,
    recordingId: string,
    candidateIds: string[],
    status: CandidateStatus,
  ) => Promise<string[]>;
  onCreateManualCandidate: (runId: string, timestampMs: number) => Promise<CandidateFrame>;
  onCreateManualRun: (recordingId: string) => Promise<void>;
  onDeleteRecording: (recordingId: string, filename: string) => void;
  onDropFiles: (files: FileList | File[]) => void;
  onDeleteSelectedRuns: (runIds: string[]) => Promise<string[] | null>;
  onExportRun: (runId: string, mode: ExportMode, downloadName?: string) => Promise<void>;
  onExportTaskRuns: (runIds: string[]) => Promise<void>;
  onJumpToSelection: () => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onPreviewRecording: (recordingId: string) => void;
  /** Open the preview on a recording without toggling it closed when it is already open. */
  onOpenPreview: (recordingId: string) => void;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onRenameRecording: (recordingId: string, filename: string) => Promise<void>;
  onResetToProjectDefaults: () => void;
  onResetToUniversalDefaults: () => void;
  onSaveProjectPreset: () => void;
  onSaveUniversalPreset: () => void;
  onSelectRecording: (recordingId: string) => void;
  onSelectRun: (recordingId: string, runId: string, anchorId?: string) => void;
  onStartRun: () => void;
  onUpdateCandidate: (
    candidateId: string,
    payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>>,
  ) => void;
  ocrAvailable: boolean;
  ocrStatus: OcrStatus | null;
  ocrStatusMessage: string | null;
  ocrWarnings: string[];
  onDismissOcrWarnings: () => void;
  previewRecording: RecordingSummary | null;
  projectDefaultSettings: RunSettings;
  recordings: RecordingSummary[];
  recordingsLoading: boolean;
  runSettings: RunSettings;
  selectedRecording: RecordingDetail | null;
  selectedRecordingId: string | null;
  selectedRecordingSummary: RecordingSummary | null;
  selectedRunId: string | null;
  selectedRun: RunDetail | null;
  selectedRunLoading?: boolean;
  setRunSettings: Dispatch<SetStateAction<RunSettings>>;
  settingsFeedback: string;
  showPresetText: string;
}

type PreviewSizeKey = 'sm' | 'md' | 'lg';
type TimelineSegmentType = TransitionType | 'dwell';
type TimelineSegmentKind = 'event' | 'dwell_before' | 'dwell_after';

interface TimelineSegment {
  candidateId: string;
  endMs: number;
  key: string;
  kind: TimelineSegmentKind;
  startMs: number;
  type: TimelineSegmentType;
}

interface PositionedTimelineSegment extends TimelineSegment {
  endPct: number;
  startPct: number;
}

const TIMELINE_DWELL_VISIBILITY_MS = 500;
const PREVIEW_TIMELINE_MIN_WIDTH_PCT: Record<PreviewSizeKey, number> = {
  sm: 0.42,
  md: 0.26,
  lg: 0.16,
};
const CANDIDATE_TIMELINE_MIN_WIDTH_PCT = 0.2;

function positionTimelineSegments(
  segments: TimelineSegment[],
  durationMs: number,
  minWidthPct: number,
): PositionedTimelineSegment[] {
  if (durationMs <= 0) {
    return [];
  }
  return segments.flatMap((segment) => {
    const startMs = Math.max(0, Math.min(durationMs, Math.min(segment.startMs, segment.endMs)));
    const endMs = Math.max(0, Math.min(durationMs, Math.max(segment.startMs, segment.endMs)));
    if (endMs <= startMs) {
      return [];
    }
    const rawStartPct = (startMs / durationMs) * 100;
    const rawEndPct = (endMs / durationMs) * 100;
    const widthPct = Math.min(100, Math.max(minWidthPct, rawEndPct - rawStartPct));
    const startPct = Math.max(0, Math.min(100 - widthPct, rawStartPct));
    return [
      {
        ...segment,
        startPct,
        endPct: Math.min(100, startPct + widthPct),
      },
    ];
  });
}

export function AnalysisScreen({
  acceptedStepSimilarityLinks,
  analysisMetadata,
  abortRunPending,
  activeProject,
  analysisActionMessage,
  analysisTaskItems,
  appError,
  bulkDeletePending,
  bulkExportPending,
  candidateSimilarityLinks,
  createManualCandidatePending,
  createManualRunPending,
  createRunPending,
  exportRunPending,
  healthMessage,
  healthWarning,
  liveMessage,
  onApplyImportedPreset,
  onAbortRun,
  onBulkUpdateCandidates,
  onCreateManualCandidate,
  onCreateManualRun,
  onDeleteRecording,
  onDropFiles,
  onDeleteSelectedRuns,
  onExportRun,
  onExportTaskRuns,
  onJumpToSelection,
  onNavigateStage,
  onPreviewRecording,
  onOpenPreview,
  onRenameProject,
  onRenameRecording,
  onResetToProjectDefaults,
  onResetToUniversalDefaults,
  onSaveProjectPreset,
  onSaveUniversalPreset,
  onSelectRecording,
  onSelectRun,
  onStartRun,
  onUpdateCandidate,
  ocrAvailable,
  ocrStatus,
  ocrStatusMessage,
  ocrWarnings,
  onDismissOcrWarnings,
  previewRecording,
  projectDefaultSettings,
  recordings,
  recordingsLoading,
  runSettings,
  selectedRecording,
  selectedRecordingId,
  selectedRecordingSummary,
  selectedRunId,
  selectedRun,
  selectedRunLoading = false,
  setRunSettings,
  settingsFeedback,
  showPresetText,
}: AnalysisScreenProps) {
  const [ocrWarningsExpanded, setOcrWarningsExpanded] = useState(false);
  const [expandedTaskRunId, setExpandedTaskRunId] = useState<string | null>(null);
  const [selectedTaskRunIds, setSelectedTaskRunIds] = useState<string[]>([]);
  const [taskFilter, setTaskFilter] = useState<AnalysisTaskFilter>('all');
  const [taskSelectMode, setTaskSelectMode] = useState(false);
  const [videoRenameRequest, setVideoRenameRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [openPopover, setOpenPopover] = useState<AnalysisPopoverKey | null>(null);
  const [activeCandidateFilter, setActiveCandidateFilter] = useState<CandidateFilter>('all');
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [pendingPlayFromMs, setPendingPlayFromMs] = useState<number | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [bulkCandidatePending, setBulkCandidatePending] = useState(false);
  const [queuedManualMarkItems, setQueuedManualMarkItems] = useState<PendingManualMark[]>([]);
  const [manualCapturePulseToken, setManualCapturePulseToken] = useState(0);
  const [expandedAnnotationCandidateId, setExpandedAnnotationCandidateId] = useState<string | null>(null);
  const [exportNameDraft, setExportNameDraft] = useState('');
  const [presetImportDraft, setPresetImportDraft] = useState('');
  const [presetImportError, setPresetImportError] = useState('');
  const [previewPlaybackMs, setPreviewPlaybackMs] = useState(0);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [previewSizeKey, setPreviewSizeKey] = useState<PreviewSizeKey>('md');
  const [previewBg, setPreviewBg] = useState<'dark' | 'light'>('dark');
  const [showRunLogs, setShowRunLogs] = useState(false);
  const [compareRunId, setCompareRunId] = useState<string | null>(null);
  const [presetCopyFeedback, setPresetCopyFeedback] = useState('');
  const [showHints, setShowHints] = useState(false);
  const [taskClockMs, setTaskClockMs] = useState(() => Date.now());
  const [focusedHintKey, setFocusedHintKey] = useState<AnalysisHintKey | null>(null);
  const [hoveredHintKey, setHoveredHintKey] = useState<AnalysisHintKey | null>(null);
  const [hintCardPosition, setHintCardPosition] = useState<{ left: number; top: number } | null>(null);
  const [hoveredLegendType, setHoveredLegendType] = useState<string | null>(null);
  const [hiddenSegmentTypes, setHiddenSegmentTypes] = useState<Set<string>>(new Set());
  const [stepLayout, setStepLayout] = useState<StepLayout>(() => loadStepLayout());
  const parameterColumnRef = useRef<HTMLElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const saveMenuRef = useRef<HTMLDivElement | null>(null);
  const loadMenuRef = useRef<HTMLDivElement | null>(null);
  const resetMenuRef = useRef<HTMLDivElement | null>(null);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const activeManualMarkIdRef = useRef<string | null>(null);

  const compareRunDetailQuery = useQuery({
    queryKey: ['run', compareRunId, 'compare'],
    queryFn: () => getRun(compareRunId as string),
    enabled: Boolean(compareRunId),
  });

  const previewVideoUrl = previewRecording ? absoluteApiUrl(previewRecording.source_url) : null;
  const comparedRun = compareRunDetailQuery.data ?? null;
  const hintCopy: Record<AnalysisHintKey, string> = {
    load: 'paste stepthrough preset text to load a saved parameter set into the active analysis controls.',
    reset: 'reset the current analysis parameters to this project or universal defaults.',
    run: 'start a new analysis task for the selected video using the current parameter set.',
    save: 'save the current analysis parameters for this project or as universal defaults.',
    stable_advanced:
      'expert settings. the defaults work for screen recordings; change them only when a specific recording needs it.',
    stable_group_typing:
      'on: a burst of typing with short pauses becomes one step showing the finished text. off: every pause longer than the minimum time on screen is its own step.',
    stable_ignore_areas:
      'draw boxes over parts of the screen that change without being a step, such as a live clock, an animated banner or an embedded video. changes inside them are ignored.',
    stable_min_change:
      'the smallest connected change, as a share of the screen, that counts. lower it to catch tiny badges or toggles; raise it if a moving pointer or small animation creates extra steps.',
    stable_min_dwell_ms:
      'how long the screen must stay still to count as a step. shorter catches brief screens; longer skips screens the user only passed through.',
    stable_ocr:
      'reads the text in each screenshot and adds it to exports (ocr_text). it is not needed to find steps and makes runs slower.',
    stable_opening_screen: 'include the screen the recording starts on as step 0.',
    stable_recording_type:
      'sets sensible defaults: phone recordings ignore the status bar; computer recordings ignore small changes such as the moving mouse pointer.',
    stable_sample_fps:
      'how many frames per second are analysed. the default of 15 is enough for interfaces; lower is faster.',
    stable_scroll_mode:
      'each stop: every place the page comes to rest is a step. merge stops: a page scrolled in several stops becomes one step.',
    stable_sensitivity:
      'how much a pixel must change to count, in multiples of the compression noise measured on this recording (never below 10 grey levels). raise it for noisy recordings.',
    stable_status_bar:
      'the phone status bar (clock, battery, recording indicator) changes on its own. ignore it unless it matters for your analysis.',
  };
  const activeHintKey = focusedHintKey ?? hoveredHintKey;
  const hintText = showHints && activeHintKey ? hintCopy[activeHintKey] : null;
  const isCompletedReview = selectedRun?.summary.status === 'completed';
  const canReviewCandidates = Boolean(
    selectedRun &&
      selectedRun.candidates.length > 0 &&
      ['completed', 'failed', 'cancelled'].includes(selectedRun.summary.status),
  );
  const previewMatchesSelectedRun = Boolean(
    previewRecording && selectedRun && previewRecording.id === selectedRun.summary.recording_id,
  );
  const canAddManualCandidate = Boolean(
    previewMatchesSelectedRun &&
      selectedRun &&
      ['completed', 'failed', 'cancelled'].includes(selectedRun.summary.status),
  );
  const showLowCandidateHint = Boolean(
    selectedRun &&
      (selectedRun.summary.status === 'completed' ||
        selectedRun.summary.status === 'failed' ||
        selectedRun.summary.status === 'cancelled') &&
      selectedRun.candidates.length <= 2,
  );
  const filteredAnalysisTaskItems = useMemo(() => {
    if (taskFilter === 'all') {
      return analysisTaskItems;
    }
    if (taskFilter === 'active') {
      return analysisTaskItems.filter((item) => ['queued', 'running', 'awaiting_fallback'].includes(item.run.status));
    }
    if (taskFilter === 'completed') {
      return analysisTaskItems.filter((item) => item.run.status === 'completed');
    }
    return analysisTaskItems.filter((item) => ['failed', 'cancelled'].includes(item.run.status));
  }, [analysisTaskItems, taskFilter]);
  const runNumberById = useMemo(() => {
    const nextMap = new Map<string, number>();
    const itemsByRecordingId = new Map<string, AnalysisTaskItem[]>();

    analysisTaskItems.forEach((item) => {
      const bucket = itemsByRecordingId.get(item.recording.id);
      if (bucket) {
        bucket.push(item);
        return;
      }
      itemsByRecordingId.set(item.recording.id, [item]);
    });

    itemsByRecordingId.forEach((items) => {
      items
        .slice()
        .sort(
          (left, right) =>
            new Date(left.run.created_at).getTime() - new Date(right.run.created_at).getTime(),
        )
        .forEach((item, index) => {
          nextMap.set(item.run.id, index + 1);
        });
    });

    return nextMap;
  }, [analysisTaskItems]);
  const groupedTaskItems = useMemo<AnalysisTaskGroup[]>(() => {
    const groups = new Map<string, AnalysisTaskGroup>();

    filteredAnalysisTaskItems.forEach((item) => {
      const existingGroup = groups.get(item.recording.id);
      if (existingGroup) {
        existingGroup.runs.push(item);
        return;
      }

      groups.set(item.recording.id, {
        recording: item.recording,
        runs: [item],
      });
    });

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        runs: group.runs
          .slice()
          .sort(
            (left, right) =>
              new Date(right.run.created_at).getTime() - new Date(left.run.created_at).getTime(),
          ),
      }))
      .sort((left, right) => {
        const leftTimestamp = new Date(left.runs[0]?.run.created_at ?? 0).getTime();
        const rightTimestamp = new Date(right.runs[0]?.run.created_at ?? 0).getTime();
        return rightTimestamp - leftTimestamp;
      });
  }, [filteredAnalysisTaskItems]);
  // Labels switched off in the timeline legend hide those steps too; the status tabs count what is left.
  const labelVisibleCandidates = useMemo(
    () => (selectedRun?.candidates ?? []).filter((candidate) => candidateMatchesLabels(candidate, hiddenSegmentTypes)),
    [hiddenSegmentTypes, selectedRun],
  );
  const labelHiddenCount = (selectedRun?.candidates.length ?? 0) - labelVisibleCandidates.length;
  const candidateCounts = useMemo(() => {
    const candidates = labelVisibleCandidates;
    return {
      pending: candidates.filter((candidate) => candidate.status === 'pending').length,
      accepted: candidates.filter((candidate) => candidate.status === 'accepted').length,
      rejected: candidates.filter((candidate) => candidate.status === 'rejected').length,
      all: candidates.length,
    };
  }, [labelVisibleCandidates]);
  const filteredCandidates = useMemo(() => {
    if (!selectedRun || !canReviewCandidates) {
      return [];
    }
    return labelVisibleCandidates.filter((candidate) => candidateMatchesFilter(candidate, activeCandidateFilter));
  }, [activeCandidateFilter, canReviewCandidates, labelVisibleCandidates, selectedRun]);
  const stepAspect = recordingAspect(selectedRecordingSummary?.width, selectedRecordingSummary?.height);
  const stepCardBox = stepImageBox(stepLayout.size, stepAspect);
  const stepThumb = stepThumbBox(stepLayout.size, stepAspect);
  useEffect(() => {
    saveStepLayout(stepLayout);
  }, [stepLayout]);
  const scrubDurationMs = previewRecording?.duration_ms ?? selectedRecordingSummary?.duration_ms ?? 0;
  // Hover clips and "play from here" use the selected run's recording; the ring follows the preview.
  const runRecording = recordings.find((recording) => recording.id === selectedRun?.summary.recording_id) ?? null;
  const hoverClips = useHoverClips(runRecording ? absoluteApiUrl(runRecording.source_url) : null);
  const stepPlaybackWindows = useMemo(
    () => playbackWindows(selectedRun?.candidates ?? [], runRecording?.duration_ms ?? 0),
    [runRecording?.duration_ms, selectedRun?.candidates],
  );
  const timelineCandidates = useMemo(() => {
    if (!selectedRun) {
      return [];
    }
    return [...selectedRun.candidates].sort((left, right) => left.timestamp_ms - right.timestamp_ms);
  }, [selectedRun]);
  const timelineSegments = useMemo(() => {
    const durationMs = selectedRecordingSummary?.duration_ms ?? 0;
    if (durationMs <= 0 || timelineCandidates.length === 0) {
      return [];
    }
    return timelineCandidates.flatMap((candidate) => {
      const breakdown = candidate.score_breakdown;
      if (!breakdown) {
        return [];
      }
      const eventStartMs = Math.max(0, breakdown.event_start_ms ?? candidate.timestamp_ms);
      const eventEndMs = Math.max(eventStartMs, breakdown.event_end_ms ?? candidate.timestamp_ms);
      const segments: TimelineSegment[] = [];

      if (eventEndMs > eventStartMs) {
        segments.push({
          candidateId: candidate.id,
          endMs: eventEndMs,
          key: `${candidate.id}-event`,
          kind: 'event',
          startMs: eventStartMs,
          type: breakdown.transition_type ?? 'unknown',
        });
      }

      const dwellBeforeMs = breakdown.dwell_before_ms ?? 0;
      if (dwellBeforeMs >= TIMELINE_DWELL_VISIBILITY_MS && eventStartMs > 0) {
        segments.push({
          candidateId: candidate.id,
          endMs: eventStartMs,
          key: `${candidate.id}-dwell-before`,
          kind: 'dwell_before',
          startMs: eventStartMs - dwellBeforeMs,
          type: 'dwell',
        });
      }

      const dwellAfterMs = breakdown.dwell_after_ms ?? 0;
      if (dwellAfterMs >= TIMELINE_DWELL_VISIBILITY_MS && eventEndMs < durationMs) {
        segments.push({
          candidateId: candidate.id,
          endMs: eventEndMs + dwellAfterMs,
          key: `${candidate.id}-dwell-after`,
          kind: 'dwell_after',
          startMs: eventEndMs,
          type: 'dwell',
        });
      }

      return segments;
    });
  }, [selectedRecordingSummary?.duration_ms, timelineCandidates]);
  const previewTimelineSegments = useMemo(
    () =>
      previewMatchesSelectedRun
        ? positionTimelineSegments(
            timelineSegments,
            scrubDurationMs,
            PREVIEW_TIMELINE_MIN_WIDTH_PCT[previewSizeKey],
          )
        : [],
    [previewMatchesSelectedRun, previewSizeKey, scrubDurationMs, timelineSegments],
  );
  const candidateTimelineSegments = useMemo(
    () =>
      positionTimelineSegments(
        timelineSegments,
        selectedRecordingSummary?.duration_ms ?? 0,
        CANDIDATE_TIMELINE_MIN_WIDTH_PCT,
      ),
    [selectedRecordingSummary?.duration_ms, timelineSegments],
  );
  const activeCandidate = useMemo(() => {
    if (!selectedRun || !activeCandidateId) {
      return null;
    }
    return selectedRun.candidates.find((candidate) => candidate.id === activeCandidateId) ?? null;
  }, [activeCandidateId, selectedRun]);
  const selectablePendingCandidateIds = useMemo(
    () => new Set(filteredCandidates.filter((candidate) => candidate.status === 'pending').map((candidate) => candidate.id)),
    [filteredCandidates],
  );
  const selectedPendingCandidateIds = useMemo(
    () => selectedCandidateIds.filter((candidateId) => selectablePendingCandidateIds.has(candidateId)),
    [selectedCandidateIds, selectablePendingCandidateIds],
  );
  const canShowTimeline = Boolean(
    isCompletedReview &&
      selectedRecordingSummary &&
      selectedRecordingSummary.duration_ms > 0 &&
      timelineCandidates.length > 0,
  );
  const canExportAccepted = Boolean(
    selectedRun && selectedRun.summary.status === 'completed' && selectedRun.accepted_steps.length > 0,
  );
  const canExportAll = Boolean(
    selectedRun && selectedRun.summary.status === 'completed' && selectedRun.candidates.length > 0,
  );
  const selectedRunExportLabel = useMemo(() => {
    if (!selectedRun?.summary.export_bundle_id) {
      return null;
    }
    if (selectedRun.export_bundle?.created_at) {
      return `last exported ${formatRelativeTime(selectedRun.export_bundle.created_at, taskClockMs)}`;
    }
    return 'exported';
  }, [selectedRun, taskClockMs]);
  const resolvedExportFilenamePreview = normalizeZipFilename(exportNameDraft);
  const comparableRuns = useMemo(
    () =>
      (selectedRecording?.runs ?? []).filter(
        (run) => run.id !== selectedRun?.summary.id && run.status === 'completed',
      ),
    [selectedRecording?.runs, selectedRun?.summary.id],
  );
  const comparisonRows = useMemo(
    () =>
      selectedRun && comparedRun
        ? buildCandidateComparison(selectedRun.candidates, comparedRun.candidates)
        : [],
    [comparedRun, selectedRun],
  );

  useEffect(() => {
    if (!expandedTaskRunId) {
      return;
    }
    if (!analysisTaskItems.some((item) => item.run.id === expandedTaskRunId)) {
      setExpandedTaskRunId(null);
    }
  }, [analysisTaskItems, expandedTaskRunId]);

  useEffect(() => {
    setSelectedTaskRunIds((current) =>
      current.filter((runId) => analysisTaskItems.some((item) => item.run.id === runId)),
    );
  }, [analysisTaskItems]);

  useEffect(() => {
    setSelectedCandidateIds((current) =>
      current.filter((candidateId) => selectablePendingCandidateIds.has(candidateId)),
    );
  }, [selectablePendingCandidateIds]);

  useEffect(() => {
    if (!showHints) {
      setFocusedHintKey(null);
      setHoveredHintKey(null);
      setHintCardPosition(null);
    }
  }, [showHints]);

  useEffect(() => {
    if (!focusedHintKey && !hoveredHintKey) {
      setHintCardPosition(null);
    }
  }, [focusedHintKey, hoveredHintKey]);

  useEffect(() => {
    setActiveCandidateFilter(canReviewCandidates ? 'all' : 'pending');
    setExpandedAnnotationCandidateId(null);
    setSelectedCandidateIds([]);
    setBulkCandidatePending(false);
  }, [canReviewCandidates, selectedRun?.summary.id]);

  useEffect(() => {
    setShowRunLogs(false);
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    if (!compareRunId) {
      return;
    }
    if (
      compareRunId === selectedRun?.summary.id ||
      !comparableRuns.some((run) => run.id === compareRunId)
    ) {
      setCompareRunId(null);
    }
  }, [compareRunId, comparableRuns, selectedRun?.summary.id]);

  useEffect(() => {
    setOpenPopover((current) => (current === 'export' ? null : current));
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    setQueuedManualMarkItems([]);
    activeManualMarkIdRef.current = null;
    setManualCapturePulseToken(0);
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    if (!openPopover) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        saveMenuRef.current?.contains(target) ||
        loadMenuRef.current?.contains(target) ||
        resetMenuRef.current?.contains(target) ||
        presetMenuRef.current?.contains(target) ||
        exportMenuRef.current?.contains(target)
      ) {
        return;
      }
      setOpenPopover(null);
    }

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [openPopover]);

  useEffect(() => {
    setPreviewPlaybackMs(0);
  }, [previewRecording?.id]);

  useEffect(() => {
    if (!selectedRun?.candidates.length) {
      setActiveCandidateId(null);
      return;
    }
    setActiveCandidateId(selectedRun.candidates[0].id);
  }, [selectedRun?.summary.id, selectedRun?.candidates.length]);

  useEffect(() => {
    if (!filteredCandidates.length) {
      return;
    }
    if (activeCandidateId && filteredCandidates.some((candidate) => candidate.id === activeCandidateId)) {
      return;
    }
    setActiveCandidateId(filteredCandidates[0].id);
  }, [activeCandidateId, filteredCandidates]);

  useEffect(() => {
    if (!selectedRun || !queuedManualMarkItems.length) {
      return;
    }
    if (activeManualMarkIdRef.current) {
      return;
    }

    const nextMark = queuedManualMarkItems[0];
    activeManualMarkIdRef.current = nextMark.id;

    void (async () => {
      try {
        await onCreateManualCandidate(selectedRun.summary.id, nextMark.timestampMs);
      } finally {
        activeManualMarkIdRef.current = null;
        setQueuedManualMarkItems((current) => current.filter((item) => item.id !== nextMark.id));
      }
    })();
  }, [onCreateManualCandidate, queuedManualMarkItems, selectedRun]);

  useEffect(() => {
    if (!selectedRun || selectedRun.summary.status !== 'completed') {
      setExportNameDraft('');
      return;
    }

    setExportNameDraft(
      buildReviewExportName(selectedRecordingSummary?.filename ?? selectedRun.summary.recording_id),
    );
  }, [
    selectedRecordingSummary?.filename,
    selectedRun?.summary.id,
    selectedRun?.summary.recording_id,
    selectedRun?.summary.status,
  ]);

  useEffect(() => {
    if (!presetCopyFeedback) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => setPresetCopyFeedback(''), 1800);
    return () => globalThis.clearTimeout(timeoutId);
  }, [presetCopyFeedback]);

  useEffect(() => {
    if (openPopover !== 'load' && presetImportError) {
      setPresetImportError('');
    }
    if (openPopover !== 'preset' && presetCopyFeedback) {
      setPresetCopyFeedback('');
    }
  }, [openPopover, presetCopyFeedback, presetImportError]);

  useEffect(() => {
    const intervalId = globalThis.setInterval(() => setTaskClockMs(Date.now()), 1000);
    return () => globalThis.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!canReviewCandidates) {
      return;
    }

    function handleReviewKeydown(event: KeyboardEvent) {
      if (isEditableElement(event.target)) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (!activeCandidate && filteredCandidates.length > 0) {
        setActiveCandidateId(filteredCandidates[0].id);
        return;
      }

      if (!activeCandidate) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handleStepCandidate(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleStepCandidate(1);
        return;
      }

      const lowerKey = event.key.toLowerCase();
      if (lowerKey === 'a') {
        event.preventDefault();
        handleCandidateStatusChange(activeCandidate, 'accepted');
      } else if (lowerKey === 'r') {
        event.preventDefault();
        handleCandidateStatusChange(activeCandidate, 'rejected');
      } else if (lowerKey === 'u') {
        event.preventDefault();
        handleCandidateStatusChange(activeCandidate, 'pending');
      } else if (lowerKey === 'p') {
        event.preventDefault();
        handlePlayFromHere(activeCandidate);
      }
    }

    window.addEventListener('keydown', handleReviewKeydown);
    return () => window.removeEventListener('keydown', handleReviewKeydown);
  }, [activeCandidate, canReviewCandidates, filteredCandidates, previewMatchesSelectedRun, selectedRun?.summary.id]);

  useEffect(() => {
    if (!previewVideoUrl) {
      return;
    }

    function handleManualTagKeydown(event: KeyboardEvent) {
      if (isEditableElement(event.target) || event.metaKey || event.ctrlKey || event.altKey || event.repeat) {
        return;
      }
      if (event.key.toLowerCase() !== 'k') {
        return;
      }
      event.preventDefault();
      void handleCreateManualCandidate();
    }

    window.addEventListener('keydown', handleManualTagKeydown);
    return () => window.removeEventListener('keydown', handleManualTagKeydown);
  }, [canAddManualCandidate, previewVideoUrl, previewPlaybackMs, selectedRun?.summary.id]);

  useEffect(() => {
    if (!previewVideoUrl) return;

    function handleTransportKeydown(event: KeyboardEvent) {
      if (isEditableElement(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === ' ') {
        event.preventDefault();
        const video = previewVideoRef.current;
        if (video) {
          if (video.paused) void video.play();
          else video.pause();
        }
        return;
      }
      if (event.repeat) return;
      const frameMs = 1000 / 30;
      const durationMs = selectedRecordingSummary?.duration_ms ?? 0;
      if (event.key === ',') {
        event.preventDefault();
        const video = previewVideoRef.current;
        if (video) {
          const clamped = Math.max(0, durationMs > 0 ? Math.min(durationMs - 1, previewPlaybackMs - frameMs) : previewPlaybackMs - frameMs);
          video.currentTime = clamped / 1000;
          setPreviewPlaybackMs(clamped);
        }
      } else if (event.key === '.') {
        event.preventDefault();
        const video = previewVideoRef.current;
        if (video) {
          const clamped = Math.max(0, durationMs > 0 ? Math.min(durationMs - 1, previewPlaybackMs + frameMs) : previewPlaybackMs + frameMs);
          video.currentTime = clamped / 1000;
          setPreviewPlaybackMs(clamped);
        }
      }
    }

    window.addEventListener('keydown', handleTransportKeydown);
    return () => window.removeEventListener('keydown', handleTransportKeydown);
  }, [previewVideoUrl, previewPlaybackMs, selectedRecordingSummary?.duration_ms]);

  useEffect(() => {
    if (previewVideoRef.current) {
      previewVideoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    const video = previewVideoRef.current;
    if (!video) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (!entry.isIntersecting) video.pause(); },
      { threshold: 0 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [previewVideoUrl]);

  usePlaybackHighlight(previewVideoRef, stepPlaybackWindows, previewMatchesSelectedRun && canReviewCandidates, previewVideoUrl);

  // "Play from here": once the preview shows this run's recording, seek, scroll it into view and start
  // playing when it is visible (the preview pauses itself while it is scrolled out of view).
  useEffect(() => {
    if (pendingPlayFromMs === null || !previewMatchesSelectedRun) return;
    const video = previewVideoRef.current;
    if (!video) return;
    const startMs = pendingPlayFromMs;
    let observer: IntersectionObserver | null = null;
    let fallback: number | null = null;
    let done = false;

    function go() {
      if (done || !video) return;
      done = true;
      observer?.disconnect();
      if (fallback !== null) window.clearTimeout(fallback);
      void video.play().catch(() => undefined);
      setPendingPlayFromMs(null);
    }

    function seekAndReveal() {
      if (!video) return;
      video.currentTime = startMs / 1000;
      setPreviewPlaybackMs(startMs);
      jumpToAnchor('analysis-video-preview');
      observer = new IntersectionObserver(([entry]) => {
        if (entry.intersectionRatio >= 0.5) go();
      }, { threshold: [0.5] });
      observer.observe(video);
      fallback = window.setTimeout(go, 1500);
    }

    if (video.readyState >= 1) seekAndReveal();
    else video.addEventListener('loadedmetadata', seekAndReveal, { once: true });
    return () => {
      done = true;
      observer?.disconnect();
      if (fallback !== null) window.clearTimeout(fallback);
      video.removeEventListener('loadedmetadata', seekAndReveal);
    };
  }, [pendingPlayFromMs, previewMatchesSelectedRun, previewVideoUrl]);

  function updateHintCardPosition(element: HTMLElement) {
    const container = parameterColumnRef.current;
    if (!container) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const maxLeft = Math.max(0, containerRect.width - 220);
    const left = Math.min(Math.max(0, elementRect.left - containerRect.left), maxLeft);
    const maxTop = Math.max(0, containerRect.height - 88);
    const top = Math.min(Math.max(0, elementRect.bottom - containerRect.top + 10), maxTop);
    setHintCardPosition({ left, top });
  }

  function bindHint(key: AnalysisHintKey) {
    if (!showHints) {
      return {};
    }
    return {
      onBlur: () => {
        setFocusedHintKey((current) => (current === key ? null : current));
      },
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        updateHintCardPosition(event.currentTarget);
        setFocusedHintKey(key);
      },
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
        updateHintCardPosition(event.currentTarget);
        setFocusedHintKey(null);
        setHoveredHintKey(key);
      },
      onMouseLeave: () => {
        setHoveredHintKey((current) => (current === key ? null : current));
      },
    };
  }

  function togglePopover(key: AnalysisPopoverKey) {
    setOpenPopover((current) => (current === key ? null : key));
  }

  function closePopover() {
    setOpenPopover(null);
  }

  function handlePresetImportDraftChange(nextValue: string) {
    setPresetImportDraft(nextValue);
    if (presetImportError) {
      setPresetImportError('');
    }
  }

  function handleApplyImportedPreset() {
    const parseResult = parseRunPresetText(presetImportDraft);
    if ('error' in parseResult) {
      setPresetImportError(parseResult.error);
      return;
    }

    onApplyImportedPreset(parseResult.settings);
    setPresetImportDraft('');
    setPresetImportError('');
    closePopover();
  }

  function toggleTaskSelection(runId: string) {
    setSelectedTaskRunIds((current) =>
      current.includes(runId) ? current.filter((value) => value !== runId) : [...current, runId],
    );
  }

  async function handleDeleteSelectedTasks() {
    const failedRunIds = await onDeleteSelectedRuns(selectedTaskRunIds);
    if (failedRunIds === null) {
      return;
    }
    setSelectedTaskRunIds(failedRunIds);
  }

  function handleDeleteRun(runId: string) {
    void onDeleteSelectedRuns([runId]);
  }

  async function handleExportSelectedTasks() {
    await onExportTaskRuns(selectedTaskRunIds);
  }

  async function handleExportAllCompletedTasks() {
    await onExportTaskRuns(
      analysisTaskItems.filter((item) => item.run.status === 'completed').map((item) => item.run.id),
    );
  }

  async function handleSelectedRunExport(mode: ExportMode) {
    if (!selectedRun) {
      return;
    }
    await onExportRun(selectedRun.summary.id, mode, exportNameDraft);
    closePopover();
  }

  async function handleCopyPresetText() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setPresetCopyFeedback('copy unavailable');
      return;
    }
    try {
      await navigator.clipboard.writeText(showPresetText);
      setPresetCopyFeedback('copied');
    } catch {
      setPresetCopyFeedback('copy failed');
    }
  }

  function toggleCandidateSelection(candidateId: string) {
    setSelectedCandidateIds((current) =>
      current.includes(candidateId) ? current.filter((value) => value !== candidateId) : [...current, candidateId],
    );
  }

  async function handleBulkCandidateStatusChange(
    status: Extract<CandidateStatus, 'accepted' | 'rejected'>,
  ) {
    if (!selectedRun || !selectedPendingCandidateIds.length) {
      return;
    }

    setBulkCandidatePending(true);
    try {
      const failedCandidateIds = await onBulkUpdateCandidates(
        selectedRun.summary.id,
        selectedRun.summary.recording_id,
        selectedPendingCandidateIds,
        status,
      );
      setSelectedCandidateIds(failedCandidateIds);
    } finally {
      setBulkCandidatePending(false);
    }
  }

  function getCurrentPreviewTimestampMs() {
    const previewDurationMs = previewRecording?.duration_ms ?? selectedRecordingSummary?.duration_ms ?? null;
    const directSeconds = previewVideoRef.current?.currentTime;
    const fallbackSeconds = previewPlaybackMs / 1000;
    const rawSeconds =
      typeof directSeconds === 'number' && Number.isFinite(directSeconds)
        ? directSeconds
        : Number.isFinite(fallbackSeconds)
          ? fallbackSeconds
          : null;
    if (rawSeconds === null) {
      return null;
    }

    const clampedSeconds =
      previewDurationMs && previewDurationMs > 0
        ? Math.min(rawSeconds, Math.max(0, (previewDurationMs - 1) / 1000))
        : Math.max(0, rawSeconds);
    return Math.max(0, Math.round(clampedSeconds * 1000));
  }

  function seekPreviewTo(ms: number) {
    const video = previewVideoRef.current;
    if (!video) return;
    const durationMs = previewRecording?.duration_ms ?? selectedRecordingSummary?.duration_ms ?? 0;
    const clamped = Math.max(0, durationMs > 0 ? Math.min(durationMs - 1, ms) : ms);
    video.currentTime = clamped / 1000;
    setPreviewPlaybackMs(clamped);
  }

  function handlePreviewPlayPause() {
    const video = previewVideoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }

  function handlePreviewStepFrame(delta: 1 | -1) {
    const frameMs = 1000 / 30;
    seekPreviewTo(previewPlaybackMs + delta * frameMs);
  }

  function handleCyclePlaybackRate() {
    const rates = [0.5, 1, 1.5, 2] as const;
    setPlaybackRate((current) => {
      const idx = rates.indexOf(current as (typeof rates)[number]);
      return rates[(idx + 1) % rates.length];
    });
  }

  function handlePreviewJumpToPin(direction: 'next' | 'prev') {
    if (!previewMatchesSelectedRun || timelineCandidates.length === 0) return;
    const buffer = 250;
    if (direction === 'next') {
      const next = timelineCandidates.find((c) => c.timestamp_ms > previewPlaybackMs + buffer);
      if (next) seekPreviewTo(next.timestamp_ms);
    } else {
      const prev = [...timelineCandidates].reverse().find((c) => c.timestamp_ms < previewPlaybackMs - buffer);
      if (prev) seekPreviewTo(prev.timestamp_ms);
    }
  }

  function handleCreateManualCandidate(timestampOverrideMs?: number) {
    const timestampMs = timestampOverrideMs ?? getCurrentPreviewTimestampMs();
    if (timestampMs === null) return;

    setManualCapturePulseToken((current) => current + 1);
    setQueuedManualMarkItems((current) => [...current, { id: createLocalId('manual-mark'), timestampMs }]);

    if (!canAddManualCandidate && previewRecording) {
      void onCreateManualRun(previewRecording.id);
    }
  }

  function handleToggleCandidateAnnotation(candidateId: string) {
    setExpandedAnnotationCandidateId((current) => (current === candidateId ? null : candidateId));
  }

  function activateCandidate(candidateId: string, options?: { reveal?: boolean; seekPreview?: boolean }) {
    const candidate = selectedRun?.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) {
      return;
    }

    if (options?.reveal && !candidateMatchesFilter(candidate, activeCandidateFilter)) {
      setActiveCandidateFilter('all');
    }
    const labelType = candidateLabelType(candidate);
    if (options?.reveal && labelType && hiddenSegmentTypes.has(labelType)) {
      setHiddenSegmentTypes((current) => {
        const next = new Set(current);
        next.delete(labelType);
        return next;
      });
    }
    setActiveCandidateId(candidate.id);

    if (options?.seekPreview && previewMatchesSelectedRun && previewVideoRef.current) {
      previewVideoRef.current.currentTime = candidate.timestamp_ms / 1000;
      setPreviewPlaybackMs(candidate.timestamp_ms);
    }

    window.setTimeout(() => jumpToAnchor(`candidate-${candidate.id}`), 0);
  }

  function handleCandidateStatusChange(candidate: CandidateFrame, status: CandidateStatus) {
    setActiveCandidateId(candidate.id);
    if (status !== 'pending') {
      setSelectedCandidateIds((current) => current.filter((candidateId) => candidateId !== candidate.id));
    }
    onUpdateCandidate(candidate.id, { status });
    if (status === 'pending') {
      return;
    }
    const nextCandidateId = getNextCandidateFocusId(
      selectedRun?.candidates ?? [],
      candidate.id,
      activeCandidateFilter,
      hiddenSegmentTypes,
    );
    if (!nextCandidateId) {
      return;
    }
    setActiveCandidateId(nextCandidateId);
    window.setTimeout(() => jumpToAnchor(`candidate-${nextCandidateId}`), 0);
  }

  function handlePlayFromHere(candidate: CandidateFrame) {
    if (!selectedRun) return;
    hoverClips.stop();
    setActiveCandidateId(candidate.id);
    setPendingPlayFromMs(stepClip(candidate).startMs);
    if (!previewMatchesSelectedRun) onOpenPreview(selectedRun.summary.recording_id);
  }

  function stepHover(candidate: CandidateFrame): StepHoverProps {
    return {
      state: hoverClips.hover?.id === candidate.id ? hoverClips.hover.state : null,
      onEnter: (slot) => hoverClips.start(candidate, slot),
      onLeave: () => hoverClips.leave(candidate.id),
      onPlayFromHere: () => handlePlayFromHere(candidate),
    };
  }

  function handleStepCandidate(direction: -1 | 1) {
    if (!filteredCandidates.length) {
      return;
    }

    const currentIndex = activeCandidateId
      ? filteredCandidates.findIndex((candidate) => candidate.id === activeCandidateId)
      : -1;
    const nextIndex =
      currentIndex === -1
        ? direction > 0
          ? 0
          : filteredCandidates.length - 1
        : clampInteger(currentIndex + direction, 0, filteredCandidates.length - 1);
    activateCandidate(filteredCandidates[nextIndex].id);
  }

  function handleToggleHints() {
    setShowHints((current) => !current);
    setFocusedHintKey(null);
    setHoveredHintKey(null);
    setHintCardPosition(null);
  }

  function handleRequestVideoRename(recordingId: string) {
    setVideoRenameRequest((current) => ({
      id: recordingId,
      nonce: current?.id === recordingId ? current.nonce + 1 : 1,
    }));
  }

  function handleReviewTaskOutputs(recordingId: string, runId: string) {
    setActiveCandidateFilter('all');
    onSelectRun(recordingId, runId, 'analysis-candidate-review');
  }

  function handleEnterTaskSelectMode() {
    setTaskSelectMode(true);
    setSelectedTaskRunIds([]);
  }

  function handleExitTaskSelectMode() {
    setTaskSelectMode(false);
    setSelectedTaskRunIds([]);
  }

  return (
    <div className="entry-screen analysis-screen">
      <div className="analysis-stage-shell">
        <div className="analysis-stage-nav">
          <StageNavigator
            activeStage="analysis"
            onNavigate={onNavigateStage}
          />
          {activeProject && (
            <EditableName
              buttonClassName="entry-rename-button"
              containerClassName="analysis-pill-project"
              onSave={(nextValue) => onRenameProject(activeProject.id, nextValue)}
              renameLabel={`rename project ${activeProject.name}`}
              textClassName="analysis-pill-project-text"
              value={activeProject.name}
            />
          )}
          <span aria-live="polite" className="analysis-live-status" role="status" title={liveMessage || undefined}>
            {liveMessage}
          </span>
          {ocrWarnings.length > 0 && (
            <div className="nav-ocr-inline">
              <button
                className="entry-notice-ocr-summary"
                onClick={() => setOcrWarningsExpanded((prev) => !prev)}
                type="button"
              >
                {ocrWarnings.length} OCR {ocrWarnings.length === 1 ? 'warning' : 'warnings'}{' '}
                — {ocrWarningsExpanded ? 'hide' : 'show'}
              </button>
              <button className="entry-notice-dismiss" onClick={onDismissOcrWarnings} type="button">
                dismiss
              </button>
            </div>
          )}
        </div>

        {(healthMessage || (ocrStatus !== 'available' && ocrStatusMessage) || (ocrWarnings.length > 0 && ocrWarningsExpanded) || appError || settingsFeedback || analysisActionMessage) && (
          <div aria-atomic="true" aria-live="polite" className="analysis-notices" role="status">
            {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
            {ocrStatus !== 'available' && ocrStatusMessage && (
              <p className={ocrStatus === 'unavailable' ? 'entry-notice warning' : 'entry-notice'}>
                {ocrStatusMessage}
              </p>
            )}
            {ocrWarnings.length > 0 && ocrWarningsExpanded &&
              ocrWarnings.map((warning) => (
                <p className="entry-notice diagnostic" key={warning}>
                  {warning}
                </p>
              ))}
            {appError && <p className="entry-notice error">{appError}</p>}
            {settingsFeedback && <p className="entry-notice">{settingsFeedback}</p>}
            {analysisActionMessage && <p className="entry-notice">{analysisActionMessage}</p>}
          </div>
        )}

        {/* Selecting tasks needs a wider toolbar: the tasks column then takes more room and the others give way. */}
        <div className={`analysis-grid ${taskSelectMode ? 'tasks-widened' : ''}`}>
          <AnalysisVideosPanel
            onDeleteRecording={onDeleteRecording}
            onFilesDropped={onDropFiles}
            onJumpToSelection={onJumpToSelection}
            onPreviewRecording={onPreviewRecording}
            onRenameRecording={onRenameRecording}
            onRequestRename={handleRequestVideoRename}
            onSelectRecording={onSelectRecording}
            previewRecording={previewRecording}
            recordings={recordings}
            recordingsLoading={recordingsLoading}
            selectedRecordingId={selectedRecordingId}
            videoRenameRequest={videoRenameRequest}
          />

          <AnalysisParametersPanel
            analysisMetadata={analysisMetadata}
            bindHint={bindHint}
            closePopover={closePopover}
            createRunPending={createRunPending}
            healthWarning={healthWarning}
            hintCardPosition={hintCardPosition}
            hintText={hintText}
            loadMenuRef={loadMenuRef}
            onApplyImportedPreset={handleApplyImportedPreset}
            onCopyPresetText={() => {
              void handleCopyPresetText();
            }}
            onResetToProjectDefaults={onResetToProjectDefaults}
            onResetToUniversalDefaults={onResetToUniversalDefaults}
            onSaveProjectPreset={onSaveProjectPreset}
            onSaveUniversalPreset={onSaveUniversalPreset}
            onStartRun={onStartRun}
            onToggleHints={handleToggleHints}
            openPopover={openPopover}
            ocrAvailable={ocrAvailable}
            ocrStatusMessage={ocrStatusMessage}
            parameterColumnRef={parameterColumnRef}
            presetCopyFeedback={presetCopyFeedback}
            presetImportDraft={presetImportDraft}
            presetImportError={presetImportError}
            presetMenuRef={presetMenuRef}
            projectDefaultSettings={projectDefaultSettings}
            resetMenuRef={resetMenuRef}
            runSettings={runSettings}
            saveMenuRef={saveMenuRef}
            selectedRecordingId={selectedRecordingId}
            selectedRecordingSummary={selectedRecordingSummary}
            setPresetImportDraftChange={handlePresetImportDraftChange}
            setRunSettings={setRunSettings}
            showHints={showHints}
            showLowCandidateHint={showLowCandidateHint}
            showPresetText={showPresetText}
            togglePopover={togglePopover}
          />

          <AnalysisTasksPanel
            analysisTaskItems={analysisTaskItems}
            analysisMetadata={analysisMetadata}
            bulkDeletePending={bulkDeletePending}
            bulkExportPending={bulkExportPending}
            expandedTaskRunId={expandedTaskRunId}
            groupedTaskItems={groupedTaskItems}
            onAbortRun={onAbortRun}
            onDeleteRun={handleDeleteRun}
            onDeleteSelectedTasks={() => {
              void handleDeleteSelectedTasks();
            }}
            onEnterTaskSelectMode={handleEnterTaskSelectMode}
            onExitTaskSelectMode={handleExitTaskSelectMode}
            onExpandTaskRun={(runId) =>
              setExpandedTaskRunId((current) => (current === runId ? null : runId))
            }
            onExportAllCompletedTasks={() => {
              void handleExportAllCompletedTasks();
            }}
            onExportSelectedTasks={() => {
              void handleExportSelectedTasks();
            }}
            onReviewTaskOutputs={handleReviewTaskOutputs}
            onSelectRun={onSelectRun}
            onSetTaskFilter={setTaskFilter}
            onToggleTaskSelection={toggleTaskSelection}
            projectDefaultSettings={projectDefaultSettings}
            runNumberById={runNumberById}
            selectedRunId={selectedRunId}
            selectedRunSummary={selectedRun?.summary ?? null}
            selectedTaskRunIds={selectedTaskRunIds}
            taskClockMs={taskClockMs}
            taskFilter={taskFilter}
            taskSelectMode={taskSelectMode}
          />
        </div>

        {previewVideoUrl && (
          <div className="analysis-preview-wrap" data-bg={previewBg}>
            <div className="analysis-preview-close-rail">
              <button
                aria-label="close preview"
                className="preview-control-btn analysis-preview-close"
                onClick={() => {
                  if (previewRecording) onPreviewRecording(previewRecording.id);
                }}
                title="close preview"
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" viewBox="0 0 14 14" width="14">
                  <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
                </svg>
              </button>
            </div>
            <section className="analysis-panel analysis-preview-panel" data-size={previewSizeKey} id="analysis-video-preview">
                  <span className="analysis-preview-filename">{previewRecording?.filename}</span>
                  <video
                    className="analysis-preview-video"
                    onLoadedMetadata={(event) => setPreviewPlaybackMs(event.currentTarget.currentTime * 1000)}
                    onPause={() => setIsPreviewPlaying(false)}
                    onPlay={() => setIsPreviewPlaying(true)}
                    onSeeked={(event) => setPreviewPlaybackMs(event.currentTarget.currentTime * 1000)}
                    onTimeUpdate={(event) => setPreviewPlaybackMs(event.currentTarget.currentTime * 1000)}
                    playsInline
                    ref={previewVideoRef}
                    src={previewVideoUrl}
                  />
                  {scrubDurationMs > 0 ? (
                    <div
                      className="preview-scrubber"
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        const rect = event.currentTarget.getBoundingClientRect();
                        seekPreviewTo(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * scrubDurationMs);
                      }}
                      onPointerMove={(event) => {
                        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        seekPreviewTo(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * scrubDurationMs);
                      }}
                    >
                      <div className="preview-scrubber-track">
                        <div
                          className="preview-scrubber-progress"
                          style={{ width: `${Math.min(100, Math.max(0, (previewPlaybackMs / scrubDurationMs) * 100))}%` }}
                        />
                        {previewTimelineSegments
                          .filter((segment) => !hiddenSegmentTypes.has(segment.type))
                          .map((segment) => (
                          <span
                            aria-hidden="true"
                            className={`preview-scrubber-segment timeline-segment timeline-segment--${segment.type}`}
                            data-kind={segment.kind}
                            key={segment.key}
                            style={{
                              left: `${segment.startPct}%`,
                              width: `${segment.endPct - segment.startPct}%`,
                              opacity: hoveredLegendType && hoveredLegendType !== segment.type ? 0.1 : 1,
                              transition: 'opacity 150ms ease',
                            }}
                          />
                        ))}
                        {previewMatchesSelectedRun &&
                          timelineCandidates.map((candidate) => (
                            <span
                              className={`preview-scrubber-pin ${candidate.status}`}
                              key={candidate.id}
                              style={{ left: `${Math.min(100, Math.max(0, (candidate.timestamp_ms / scrubDurationMs) * 100))}%` }}
                            />
                          ))}
                        {queuedManualMarkItems.map((item) => (
                          <span
                            className="preview-scrubber-pin pending manual"
                            key={item.id}
                            style={{ left: `${Math.min(100, Math.max(0, (item.timestampMs / scrubDurationMs) * 100))}%` }}
                          />
                        ))}
                        <div
                          className="preview-scrubber-playhead"
                          style={{ left: `${Math.min(100, Math.max(0, (previewPlaybackMs / scrubDurationMs) * 100))}%` }}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="preview-transport">
                    <div className="preview-transport-controls">
                      <button
                        className="preview-control-btn"
                        disabled={!previewMatchesSelectedRun || timelineCandidates.length === 0}
                        onClick={() => handlePreviewJumpToPin('prev')}
                        title="jump to the previous step"
                        type="button"
                      >
                        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 16 16" width="16">
                          <path d="M3.5 3.5v9" />
                          <path d="M4.5 8 11.5 3.8v8.4z" fill="currentColor" stroke="none" />
                        </svg>
                      </button>
                      <button
                        className="preview-control-btn"
                        onClick={() => handlePreviewStepFrame(-1)}
                        title="step back one frame (,)"
                        type="button"
                      >
                        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 16 16" width="16">
                          <path d="M9.5 5 6 8l3.5 3" />
                        </svg>
                      </button>
                      <button
                        className="preview-control-btn preview-control-btn--play"
                        onClick={handlePreviewPlayPause}
                        title={isPreviewPlaying ? 'pause (space)' : 'play (space)'}
                        type="button"
                      >
                        {isPreviewPlaying ? (
                          <svg aria-hidden="true" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" viewBox="0 0 16 16" width="16">
                            <path d="M5.5 3.5v9M10.5 3.5v9" />
                          </svg>
                        ) : (
                          <svg aria-hidden="true" fill="currentColor" height="16" viewBox="0 0 16 16" width="16">
                            <path d="M5 3.5 13 8l-8 4.5z" />
                          </svg>
                        )}
                      </button>
                      <button
                        className="preview-control-btn"
                        onClick={() => handlePreviewStepFrame(1)}
                        title="step forward one frame (.)"
                        type="button"
                      >
                        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 16 16" width="16">
                          <path d="M6.5 5 10 8l-3.5 3" />
                        </svg>
                      </button>
                      <button
                        className="preview-control-btn"
                        disabled={!previewMatchesSelectedRun || timelineCandidates.length === 0}
                        onClick={() => handlePreviewJumpToPin('next')}
                        title="jump to the next step"
                        type="button"
                      >
                        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 16 16" width="16">
                          <path d="M12.5 3.5v9" />
                          <path d="M11.5 8 4.5 3.8v8.4z" fill="currentColor" stroke="none" />
                        </svg>
                      </button>
                    </div>
                    <span className="preview-timecode">{formatPlaybackTimestamp(previewPlaybackMs)}</span>
                    <div className="preview-transport-right">
                      <button
                        className="preview-control-btn preview-rate-btn"
                        onClick={handleCyclePlaybackRate}
                        title="playback speed"
                        type="button"
                      >
                        {playbackRate === 1 ? '1×' : `${playbackRate}×`}
                      </button>
                      <button
                        className="preview-control-btn preview-bg-btn"
                        onClick={() => setPreviewBg(previewBg === 'dark' ? 'light' : 'dark')}
                        title={previewBg === 'dark' ? 'switch to light background' : 'switch to dark background'}
                        type="button"
                      >
                        {previewBg === 'dark' ? (
                          <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                            <circle cx="7" cy="7" r="2.5" />
                            <path d="M7 1.5v1M7 11.5v1M1.5 7h1M11.5 7h1M3.4 3.4l.7.7M9.9 9.9l.7.7M9.9 4.1l-.7.7M4.4 9.6l-.7.7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" fill="none"/>
                          </svg>
                        ) : (
                          <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                            <path d="M7 2a5 5 0 1 0 5 5 5.006 5.006 0 0 0-5-5zm0 1a4 4 0 0 1 0 8V3z"/>
                          </svg>
                        )}
                      </button>
                      <div className="preview-size-group" role="group" aria-label="video size">
                        {(['sm', 'md', 'lg'] as const).map((size) => (
                          <button
                            aria-pressed={previewSizeKey === size}
                            className={`preview-control-btn preview-size-btn ${previewSizeKey === size ? 'active' : ''}`}
                            key={size}
                            onClick={() => setPreviewSizeKey(size)}
                            title={size === 'sm' ? 'small' : size === 'md' ? 'medium' : 'large'}
                            type="button"
                          >
                            <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                              {size === 'sm' && <rect height="6" rx="1" width="8" x="3" y="4" />}
                              {size === 'md' && <rect height="8" rx="1" width="10" x="2" y="3" />}
                              {size === 'lg' && <rect height="10" rx="1" width="12" x="1" y="2" />}
                            </svg>
                          </button>
                        ))}
                      </div>
                      <button
                        aria-busy={createManualCandidatePending || createManualRunPending || queuedManualMarkItems.length > 0}
                        className="preview-mark-btn"
                        onClick={(event) => {
                          if (event.detail !== 0) return;
                          handleCreateManualCandidate();
                        }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.preventDefault();
                          const timestampMs = getCurrentPreviewTimestampMs();
                          if (timestampMs !== null) handleCreateManualCandidate(timestampMs);
                        }}
                        title="mark the current frame as a new step (k)"
                        type="button"
                      >
                        {manualCapturePulseToken > 0 ? (
                          <span aria-hidden="true" className="preview-mark-pulse" key={manualCapturePulseToken} />
                        ) : null}
                        <svg aria-hidden="true" height="12" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 16 16" width="12">
                          <path d="M8 2v12M2 8h12" />
                        </svg>
                        <span>mark</span>
                        <kbd>k</kbd>
                        {queuedManualMarkItems.length > 0 ? (
                          <span className="preview-mark-queue">{queuedManualMarkItems.length}</span>
                        ) : null}
                      </button>
                    </div>
                  </div>
            </section>
          </div>
        )}

        {selectedRun ? (
          <section className="analysis-detail-section stack-gap" id="analysis-run-detail">
            <div className="analysis-detail-header">
              <div className="analysis-detail-copy">
                <p className="analysis-section-eyebrow">selected task</p>
                {isCompletedReview ? (
                  <h2>{selectedRecordingSummary?.filename ?? selectedRun.summary.recording_id}</h2>
                ) : (
                  <div className="run-title-row">
                    <h2>{selectedRecordingSummary?.filename ?? selectedRun.summary.recording_id}</h2>
                    <span className={`status-pill ${selectedRun.summary.status}`}>
                      {selectedRun.summary.status.replace('_', ' ')}
                    </span>
                  </div>
                )}
                <p className="analysis-detail-meta">
                  {formatRunSummaryLabel(selectedRun.summary, analysisMetadata)}
                </p>
                {!isCompletedReview && selectedRun.summary.message ? (
                  <p className="muted">{selectedRun.summary.message}</p>
                ) : null}
                <div className="analysis-detail-meta-row">
                  <p className="analysis-detail-meta">{formatRunTiming(selectedRun.summary)}</p>
                  <div className="analysis-log-popover-shell">
                    <button
                      className="analysis-task-link subtle analysis-log-toggle"
                      id="analysis-run-logs"
                      onClick={() => setShowRunLogs((current) => !current)}
                      type="button"
                    >
                      {showRunLogs ? 'hide logs' : 'view logs'}
                    </button>
                    {showRunLogs ? (
                      <div className="analysis-log-popover">
                        <div className="analysis-log-lines">
                          {selectedRun.events.map((event) => (
                            <p className={`analysis-log-line ${event.level}`} key={event.id}>
                              <span className="analysis-log-line-meta">
                                {new Date(event.created_at).toLocaleTimeString().toLocaleLowerCase()} · {formatPhase(event.phase)}
                              </span>
                              <span>{event.message}</span>
                              {typeof event.progress === 'number' ? (
                                <span className="analysis-log-line-progress">
                                  {formatPercent(event.progress)}
                                </span>
                              ) : null}
                            </p>
                          ))}
                          {!selectedRun.events.length && (
                            <p className="empty-copy">progress messages will appear here once the run starts.</p>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              {selectedRun.summary.is_abortable ? (
                <div className="action-row">
                  <button
                    className="analysis-task-link danger"
                    disabled={abortRunPending}
                    onClick={() => onAbortRun(selectedRun.summary.id)}
                    type="button"
                  >
                    end
                  </button>
                </div>
              ) : null}
            </div>

            {!isCompletedReview ? (
              <div className="analysis-task-bar" aria-hidden="true">
                <div className="analysis-task-bar-fill" style={{ width: formatPercent(selectedRun.summary.progress) }} />
              </div>
            ) : null}

            {selectedRun.summary.status === 'completed' ? (
              <details className="analysis-compare-shell">
                <summary className="analysis-compare-trigger">
                  <span>compare runs</span>
                  <span aria-hidden="true" className="analysis-compare-trigger-chevron" />
                </summary>
                <div className="analysis-compare-body">
                  <div className="analysis-compare-head">
                    <div className="analysis-compare-head-copy">
                      <p className="analysis-compare-head-eyebrow">comparison</p>
                      <h3>compare completed runs</h3>
                    </div>
                    <label className="analysis-compare-select-wrap">
                      <span className="sr-only">compare with another completed run</span>
                      <select
                        className="analysis-compare-select"
                        onChange={(event) => setCompareRunId(event.target.value || null)}
                        value={compareRunId ?? ''}
                      >
                        <option value="">select another completed run</option>
                        {comparableRuns.map((run) => (
                          <option key={run.id} value={run.id}>
                            {formatRunSummaryLabel(run, analysisMetadata)} · {new Date(run.created_at).toLocaleString().toLocaleLowerCase()}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {comparedRun ? (
                    <>
                      <div className="analysis-compare-summary">
                        <span className="compare-stat-both">
                          {comparisonRows.filter((row) => row.badge === 'both').length} matched
                        </span>
                        <span className="compare-stat-timing">
                          {comparisonRows.filter((row) => row.badge === 'timing_shifted').length} timing shifted
                        </span>
                        <span className="compare-stat-left">
                          {comparisonRows.filter((row) => row.badge === 'left_only').length} only in selected
                        </span>
                        <span className="compare-stat-right">
                          {comparisonRows.filter((row) => row.badge === 'right_only').length} only in comparison
                        </span>
                      </div>
                      <div className="analysis-compare-grid">
                        {comparisonRows.map((row, index) => {
                          const badgeLabel =
                            row.badge === 'both'
                              ? 'both'
                              : row.badge === 'timing_shifted'
                                ? 'timing shifted'
                                : row.badge === 'left_only'
                                  ? 'selected only'
                                  : 'comparison only';
                          return (
                            <article
                              className="analysis-compare-card"
                              key={`${row.left?.id ?? 'left-none'}-${row.right?.id ?? 'right-none'}-${index}`}
                            >
                              <div className="analysis-compare-card-head">
                                <span className={`analysis-compare-badge ${row.badge}`}>{badgeLabel}</span>
                                {typeof row.timeDeltaMs === 'number' ? <small>{row.timeDeltaMs}ms apart</small> : null}
                              </div>
                              <div className="analysis-compare-card-columns">
                                <div className="analysis-compare-column">
                                  <p className="analysis-compare-column-label">selected</p>
                                  {row.left ? (
                                    <>
                                      <img
                                        alt={`selected run candidate at ${row.left.timestamp_tc}`}
                                        className="analysis-compare-image"
                                        src={absoluteApiUrl(row.left.image_url)}
                                      />
                                      <small>{row.left.timestamp_tc}</small>
                                      <ComparisonMetrics candidate={row.left} />
                                    </>
                                  ) : (
                                    <p className="analysis-compare-empty">no matching candidate</p>
                                  )}
                                </div>
                                <div className="analysis-compare-column">
                                  <p className="analysis-compare-column-label">comparison</p>
                                  {row.right ? (
                                    <>
                                      <img
                                        alt={`comparison run candidate at ${row.right.timestamp_tc}`}
                                        className="analysis-compare-image"
                                        src={absoluteApiUrl(row.right.image_url)}
                                      />
                                      <small>{row.right.timestamp_tc}</small>
                                      <ComparisonMetrics candidate={row.right} />
                                    </>
                                  ) : (
                                    <p className="analysis-compare-empty">no matching candidate</p>
                                  )}
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </>
                  ) : compareRunId ? (
                    <p className="analysis-compare-guidance">loading comparison run…</p>
                  ) : (
                    <p className="analysis-compare-guidance">
                      select another completed run from this recording to compare outputs side by side.
                    </p>
                  )}
                </div>
              </details>
            ) : null}

            {canReviewCandidates ? (
              <>
                {selectedRun.accepted_steps.length > 0 && (
                  <div className="accepted-strip-shell" id="analysis-accepted-steps">
                    <div className="candidate-review-head">
                      <p className="candidate-review-title">accepted steps</p>
                    </div>
                    <div className="accepted-strip">
                      {selectedRun.accepted_steps.map((step) => {
                        const similarityLink = acceptedStepSimilarityLinks.get(step.step_id);
                        return (
                          <div
                            className="accepted-step-chip"
                            id={`accepted-step-${step.step_id}`}
                            key={step.step_id}
                            onClick={() => activateCandidate(step.source_candidate_id, { reveal: true })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                activateCandidate(step.source_candidate_id, { reveal: true });
                              }
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            <div className="accepted-step-topline">
                              <span className="accepted-step-id">{step.step_id}</span>
                              <small>{step.timestamp_tc}</small>
                            </div>
                            <strong className="accepted-step-title" title={step.title}>
                              {step.title}
                            </strong>
                            {similarityLink ? (
                              <div className="linked-scene-row">
                                <span className="accepted-step-link-label">returning screen</span>
                                <button
                                  className="inline-link-button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    jumpToAnchor(similarityLink.targetId);
                                  }}
                                  type="button"
                                >
                                  {similarityLink.label}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {canShowTimeline ? (
                  <div className="candidate-timeline-wrapper">
                    <div className="timeline-legend" aria-hidden="false">
                      {transitionLabels
                        .filter(({ type }) =>
                          candidateTimelineSegments.some((s) => s.type === type) ||
                          previewTimelineSegments.some((s) => s.type === type)
                        )
                        .map(({ type, label }) => (
                          <button
                            key={type}
                            aria-pressed={!hiddenSegmentTypes.has(type)}
                            className={`timeline-legend-item ${hiddenSegmentTypes.has(type) ? 'hidden' : ''}`}
                            title={
                              type === 'dwell'
                                ? `${hiddenSegmentTypes.has(type) ? 'show' : 'hide'} dwell on the timeline`
                                : `${hiddenSegmentTypes.has(type) ? 'show' : 'hide'} ${label} steps`
                            }
                            onMouseEnter={() => setHoveredLegendType(type)}
                            onMouseLeave={() => setHoveredLegendType(null)}
                            onClick={() => {
                              setHiddenSegmentTypes((prev) => {
                                const next = new Set(prev);
                                if (next.has(type)) next.delete(type);
                                else next.add(type);
                                return next;
                              });
                            }}
                            type="button"
                          >
                            <span className={`timeline-legend-color ${type}`} />
                            {label}
                          </button>
                        ))}
                    </div>
                    <div className="candidate-timeline-shell">
                      <div className="candidate-timeline-rail" aria-label="candidate timeline">
                      {candidateTimelineSegments
                        .filter((segment) => !hiddenSegmentTypes.has(segment.type))
                        .map((segment) => (
                        <span
                          aria-hidden="true"
                          className={`candidate-timeline-segment timeline-segment timeline-segment--${segment.type}`}
                          data-kind={segment.kind}
                          key={segment.key}
                          style={{
                            left: `${segment.startPct}%`,
                            width: `${segment.endPct - segment.startPct}%`,
                            opacity: hoveredLegendType && hoveredLegendType !== segment.type ? 0.1 : 1,
                            transition: 'opacity 150ms ease',
                          }}
                        />
                      ))}
                      {previewMatchesSelectedRun ? (
                        <span
                          aria-hidden="true"
                          className="candidate-timeline-playhead"
                          style={{
                            left: `${Math.min(
                              100,
                              Math.max(
                                0,
                                (previewPlaybackMs / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100,
                              ),
                            )}%`,
                          }}
                        />
                      ) : null}
                      {timelineCandidates.map((candidate) => {
                        const tooltip = `${candidate.candidate_origin === 'manual' ? 'manual' : 'candidate'} ${candidate.detector_index} • ${candidate.timestamp_tc} • ${candidate.status}`;
                        return (
                          <button
                            aria-label={tooltip}
                            className={`candidate-timeline-pin ${candidate.status} ${activeCandidateId === candidate.id ? 'active' : ''}`}
                            data-tooltip={tooltip}
                            key={candidate.id}
                            onClick={() => activateCandidate(candidate.id, { reveal: true, seekPreview: true })}
                            style={{
                              left: `${Math.min(
                                100,
                                Math.max(
                                  0,
                                  (candidate.timestamp_ms / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100,
                                ),
                              )}%`,
                            }}
                            title={tooltip}
                            type="button"
                          />
                        );
                      })}
                      {queuedManualMarkItems.map((item) => (
                        <span
                          aria-hidden="true"
                          className="candidate-timeline-pin pending manual-pending active"
                          data-tooltip={`manual mark • ${formatPlaybackTimestamp(item.timestampMs)}`}
                          key={item.id}
                          style={{
                            left: `${Math.min(
                              100,
                              Math.max(
                                0,
                                (item.timestampMs / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100,
                              ),
                            )}%`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  </div>
                ) : null}

                <div className="candidate-review-toolbar" id="analysis-review-toolbar">
                  <div className="candidate-review-nav-group">
                    <div aria-label="candidate review filters" className="candidate-filter-tabs" role="tablist">
                      {candidateFilters.map((filter) => (
                        <button
                          aria-selected={activeCandidateFilter === filter}
                          className={`candidate-filter-tab ${activeCandidateFilter === filter ? 'active' : ''}`}
                          key={filter}
                          onClick={() => setActiveCandidateFilter(filter)}
                          role="tab"
                          type="button"
                        >
                          <span>{filter}</span>
                          <small>{candidateCounts[filter]}</small>
                        </button>
                      ))}
                    </div>
                    <div className="candidate-review-stepper">
                      <button
                        className="analysis-task-link subtle"
                        disabled={filteredCandidates.length <= 1}
                        onClick={() => handleStepCandidate(-1)}
                        type="button"
                      >
                        prev
                      </button>
                      <button
                        className="analysis-task-link subtle"
                        disabled={filteredCandidates.length <= 1}
                        onClick={() => handleStepCandidate(1)}
                        type="button"
                      >
                        next
                      </button>
                    </div>
                    {canReviewCandidates && (
                      <span
                        aria-label="keyboard shortcuts: a to accept, r to reject, u to reset pending, p to play from the step, arrow keys to step"
                        className="candidate-review-key-hint"
                      >
                        <span className="candidate-key-badge">a</span> accept {' · '}
                        <span className="candidate-key-badge">r</span> reject {' · '}
                        <span className="candidate-key-badge">u</span> reset {' · '}
                        <span className="candidate-key-badge">p</span> play {' · '}
                        <span className="candidate-key-badge">← →</span> step
                      </span>
                    )}
                  </div>

                  {selectedPendingCandidateIds.length > 0 || isCompletedReview ? (
                    <div className="candidate-review-actions">
                      {selectedPendingCandidateIds.length > 0 ? (
                        <div className="candidate-bulk-actions">
                          <span className="candidate-bulk-count">
                            {selectedPendingCandidateIds.length}{' '}
                            {selectedPendingCandidateIds.length === 1
                              ? 'candidate selected'
                              : 'candidates selected'}
                          </span>
                          <button
                            className="analysis-task-link subtle"
                            disabled={bulkCandidatePending}
                            onClick={() => void handleBulkCandidateStatusChange('accepted')}
                            type="button"
                          >
                            {bulkCandidatePending ? 'working...' : 'accept selected'}
                          </button>
                          <button
                            className="analysis-task-link subtle"
                            disabled={bulkCandidatePending}
                            onClick={() => void handleBulkCandidateStatusChange('rejected')}
                            type="button"
                          >
                            {bulkCandidatePending ? 'working...' : 'reject selected'}
                          </button>
                          <button
                            className="analysis-task-link subtle"
                            disabled={bulkCandidatePending}
                            onClick={() => setSelectedCandidateIds([])}
                            type="button"
                          >
                            clear selection
                          </button>
                        </div>
                      ) : null}
                      {isCompletedReview ? (
                        <>
                          <div className="candidate-export-name-stack">
                            <label className="candidate-export-name-wrap">
                              <span className="sr-only">export zip name</span>
                              <input
                                aria-label="export zip name"
                                className="candidate-export-name-field"
                                onChange={(event) => setExportNameDraft(event.target.value)}
                                placeholder="use server filename"
                                value={exportNameDraft}
                              />
                              <span className="candidate-export-name-suffix">.zip</span>
                            </label>
                            <span className="candidate-export-name-preview">
                              {resolvedExportFilenamePreview
                                ? `→ ${resolvedExportFilenamePreview}`
                                : '→ server-generated filename'}
                            </span>
                          </div>
                          {selectedRunExportLabel ? (
                            <span className="analysis-export-status">{selectedRunExportLabel}</span>
                          ) : null}
                          <div className="candidate-export-shell" ref={exportMenuRef}>
                            <button
                              aria-expanded={openPopover === 'export'}
                              className="analysis-pill success"
                              disabled={!canExportAll || exportRunPending}
                              onClick={() => togglePopover('export')}
                              type="button"
                            >
                              {exportRunPending ? 'exporting...' : 'export'}
                            </button>
                            {openPopover === 'export' ? (
                              <div className="candidate-export-popover">
                                <div className="candidate-export-option-list">
                                  <button
                                    className="analysis-task-link subtle"
                                    disabled={!canExportAccepted || exportRunPending}
                                    onClick={() => void handleSelectedRunExport('accepted')}
                                    type="button"
                                  >
                                    export accepted
                                  </button>
                                  <button
                                    className="analysis-task-link subtle"
                                    disabled={!canExportAll || exportRunPending}
                                    onClick={() => void handleSelectedRunExport('all')}
                                    type="button"
                                  >
                                    export all
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="candidate-view-bar">
                  <span className="candidate-view-note">
                    {labelHiddenCount > 0 ? (
                      <>
                        {labelHiddenCount} {labelHiddenCount === 1 ? 'step' : 'steps'} hidden by label{' · '}
                        <button
                          className="analysis-task-link subtle"
                          onClick={() => setHiddenSegmentTypes(new Set())}
                          type="button"
                        >
                          show all
                        </button>
                      </>
                    ) : canShowTimeline ? (
                      'click a label above the timeline to hide its steps'
                    ) : null}
                  </span>
                  <div className="candidate-view-controls">
                    <div aria-label="step layout" className="candidate-view-switch" role="group">
                      {(['grid', 'list'] as const).map((view) => (
                        <button
                          aria-pressed={stepLayout.view === view}
                          className={`candidate-filter-tab ${stepLayout.view === view ? 'active' : ''}`}
                          key={view}
                          onClick={() => setStepLayout((current) => ({ ...current, view }))}
                          type="button"
                        >
                          {view}
                        </button>
                      ))}
                    </div>
                    <label className="candidate-size-control" title="image size">
                      <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                        <rect height="6" rx="1" width="6" x="4" y="4" />
                      </svg>
                      <input
                        aria-label="step image size"
                        max={STEP_SIZE_MAX}
                        min={STEP_SIZE_MIN}
                        onChange={(event) => setStepLayout((current) => ({ ...current, size: Number(event.target.value) }))}
                        step={10}
                        style={rangeFillStyle(stepLayout.size, STEP_SIZE_MIN, STEP_SIZE_MAX)}
                        type="range"
                        value={stepLayout.size}
                      />
                      <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                        <rect height="12" rx="1" width="12" x="1" y="1" />
                      </svg>
                    </label>
                  </div>
                </div>

                {filteredCandidates.length && stepLayout.view === 'list' ? (
                  <div
                    aria-label="steps"
                    className="candidate-list"
                    id="analysis-candidate-review"
                    role="table"
                    style={{ '--candidate-thumb-width': `${stepThumb.width}px` } as CSSProperties}
                  >
                    <div className="candidate-row candidate-row-head" role="row">
                      <span className="candidate-row-select" role="columnheader">
                        <span className="sr-only">select</span>
                      </span>
                      <span className="candidate-row-thumb" role="columnheader">
                        <span className="sr-only">screenshot</span>
                      </span>
                      <span className="candidate-row-step" role="columnheader">step</span>
                      <span className="candidate-row-label" role="columnheader">label</span>
                      <span className="candidate-row-duration" role="columnheader">on screen</span>
                      <span className="candidate-row-title" role="columnheader">title</span>
                      <span className="candidate-row-notes" role="columnheader">notes</span>
                      <span className="candidate-row-actions" role="columnheader">
                        <span className="sr-only">decision</span>
                      </span>
                    </div>
                    {filteredCandidates.map((candidate) => {
                      const similarityLink = candidateSimilarityLinks.get(candidate.id);
                      return (
                        <CandidateRow
                          candidate={candidate}
                          isActive={activeCandidateId === candidate.id}
                          isSelectable={candidate.status === 'pending'}
                          isSelected={selectedPendingCandidateIds.includes(candidate.id)}
                          key={candidate.id}
                          onActivate={() => setActiveCandidateId(candidate.id)}
                          onJumpToSimilar={similarityLink ? () => jumpToAnchor(similarityLink.targetId) : undefined}
                          onSetStatus={(status) => handleCandidateStatusChange(candidate, status)}
                          onToggleSelection={() => toggleCandidateSelection(candidate.id)}
                          onUpdate={(payload) => onUpdateCandidate(candidate.id, payload)}
                          similarLink={similarityLink}
                          thumbHeight={stepThumb.height}
                          thumbWidth={stepThumb.width}
                          hover={stepHover(candidate)}
                        />
                      );
                    })}
                  </div>
                ) : filteredCandidates.length ? (
                  <div
                    className={`candidate-grid sized ${filteredCandidates.length < 3 ? 'sparse' : ''}`}
                    id="analysis-candidate-review"
                    style={{ '--candidate-card-width': `${stepCardBox.width}px` } as CSSProperties}
                  >
                    {filteredCandidates.map((candidate) => {
                      const similarityLink = candidateSimilarityLinks.get(candidate.id);
                      return (
                        <CandidateCard
                          candidate={candidate}
                          compact={stepCardBox.width < 190}
                          hover={stepHover(candidate)}
                          isActive={activeCandidateId === candidate.id}
                          isAnnotationExpanded={expandedAnnotationCandidateId === candidate.id}
                          isSelected={selectedPendingCandidateIds.includes(candidate.id)}
                          isSelectable={candidate.status === 'pending'}
                          key={candidate.id}
                          onActivate={() => setActiveCandidateId(candidate.id)}
                          onJumpToSimilar={similarityLink ? () => jumpToAnchor(similarityLink.targetId) : undefined}
                          onSetStatus={(status) => handleCandidateStatusChange(candidate, status)}
                          onToggleSelection={() => toggleCandidateSelection(candidate.id)}
                          onToggleAnnotation={() => handleToggleCandidateAnnotation(candidate.id)}
                          onUpdate={(payload) => onUpdateCandidate(candidate.id, payload)}
                          recordingHeight={selectedRecordingSummary?.height}
                          recordingWidth={selectedRecordingSummary?.width}
                          similarLink={similarityLink}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <p className="entry-empty-copy candidate-empty-copy">
                    {labelHiddenCount > 0 && labelVisibleCandidates.length === 0
                      ? 'every step in this run has a hidden label.'
                      : activeCandidateFilter === 'all'
                      ? 'no steps in this run.'
                      : activeCandidateFilter === 'pending'
                        ? 'no pending steps left in this run.'
                        : `no ${activeCandidateFilter} steps in this view.`}
                  </p>
                )}
              </>
            ) : null}
          </section>
        ) : selectedRecording ? (
          <section className="analysis-detail-section empty-state">
            <h2>{selectedRecording.filename}</h2>
            {selectedRunId && selectedRunLoading ? <p>loading task details…</p> : null}
            {!selectedRunId && !selectedRunLoading && (
              <p>select a video name or a task link to review candidates, logs, and exports here.</p>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
