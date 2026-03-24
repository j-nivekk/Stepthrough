import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { absoluteApiUrl, getRun } from '../../api';
import { ComparisonMetrics, CandidateCard } from '../../components/CandidateCard';
import { EditableName } from '../../components/EditableName';
import {
  activeRunStatuses,
  buildCandidateComparison,
  candidateFilters,
  candidateMatchesFilter,
  getNextCandidateFocusId,
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
  formatProjectCounts,
  formatRelativeTime,
  formatRunTiming,
} from '../../lib/formatters';
import {
  analysisPresetDefaults,
  defaultHybridAdvancedSettings,
  describeAnalysisPreset,
  describeDetectorMode,
  describeExtractOffset,
  describeHybridMinDwellHint,
  describeHybridOcrConfirmationHint,
  describeHybridSampleFpsOverrideHint,
  describeHybridSettleWindowHint,
  describeMinSceneGap,
  describeSampleFps,
  describeTolerance,
  formatAnalysisEngineLabel,
  formatAnalysisPresetLabel,
  formatRunSettingsSummary,
  getSampleFpsGuardrail,
  parseRunPresetText,
  sanitizeRunSettings,
} from '../../lib/runSettings';
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
  CandidateFrame,
  CandidateStatus,
  ExportMode,
  Project,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunSettings,
} from '../../types';
import { AnalysisParametersPanel } from './components/AnalysisParametersPanel';
import { AnalysisTasksPanel } from './components/AnalysisTasksPanel';
import { AnalysisVideosPanel } from './components/AnalysisVideosPanel';
import type { WorkflowStage } from '../../lib/workflow';

export interface AnalysisScreenProps {
  acceptedStepSimilarityLinks: Map<string, SimilarLink>;
  abortRunPending: boolean;
  activeProject: Project | null;
  analysisActionMessage: string;
  analysisTaskItems: AnalysisTaskItem[];
  appError: string;
  bulkDeletePending: boolean;
  bulkExportPending: boolean;
  candidateSimilarityLinks: Map<string, SimilarLink>;
  createManualCandidatePending: boolean;
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
  onDeleteRecording: (recordingId: string, filename: string) => void;
  onDropFiles: (files: FileList | File[]) => void;
  onDeleteSelectedRuns: (runIds: string[]) => Promise<string[] | null>;
  onExportRun: (runId: string, mode: ExportMode, downloadName?: string) => Promise<void>;
  onExportTaskRuns: (runIds: string[]) => Promise<void>;
  onJumpToSelection: () => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onPreviewRecording: (recordingId: string) => void;
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
  previewRecording: RecordingSummary | null;
  projectDefaultSettings: RunSettings;
  recordings: RecordingSummary[];
  recordingsLoading: boolean;
  runSettings: RunSettings;
  selectedRecording: RecordingDetail | null;
  selectedRecordingId: string | null;
  selectedRecordingSummary: RecordingSummary | null;
  selectedRun: RunDetail | null;
  setRunSettings: React.Dispatch<React.SetStateAction<RunSettings>>;
  settingsFeedback: string;
  showPresetText: string;
}

export function AnalysisScreen({
  acceptedStepSimilarityLinks,
  abortRunPending,
  activeProject,
  analysisActionMessage,
  analysisTaskItems,
  appError,
  bulkDeletePending,
  bulkExportPending,
  candidateSimilarityLinks,
  createManualCandidatePending,
  createRunPending,
  exportRunPending,
  healthMessage,
  healthWarning,
  liveMessage,
  onApplyImportedPreset,
  onAbortRun,
  onBulkUpdateCandidates,
  onCreateManualCandidate,
  onDeleteRecording,
  onDropFiles,
  onDeleteSelectedRuns,
  onExportRun,
  onExportTaskRuns,
  onJumpToSelection,
  onNavigateStage,
  onPreviewRecording,
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
  previewRecording,
  projectDefaultSettings,
  recordings,
  recordingsLoading,
  runSettings,
  selectedRecording,
  selectedRecordingId,
  selectedRecordingSummary,
  selectedRun,
  setRunSettings,
  settingsFeedback,
  showPresetText,
}: AnalysisScreenProps) {
  const [expandedTaskRunId, setExpandedTaskRunId] = useState<string | null>(null);
  const [selectedTaskRunIds, setSelectedTaskRunIds] = useState<string[]>([]);
  const [taskFilter, setTaskFilter] = useState<AnalysisTaskFilter>('all');
  const [taskSelectMode, setTaskSelectMode] = useState(false);
  const [videoRenameRequest, setVideoRenameRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [openPopover, setOpenPopover] = useState<AnalysisPopoverKey | null>(null);
  const [activeCandidateFilter, setActiveCandidateFilter] = useState<CandidateFilter>('all');
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [bulkCandidatePending, setBulkCandidatePending] = useState(false);
  const [queuedManualMarkItems, setQueuedManualMarkItems] = useState<PendingManualMark[]>([]);
  const [manualCapturePulseToken, setManualCapturePulseToken] = useState(0);
  const [expandedAnnotationCandidateId, setExpandedAnnotationCandidateId] = useState<string | null>(null);
  const [exportNameDraft, setExportNameDraft] = useState('');
  const [presetImportDraft, setPresetImportDraft] = useState('');
  const [presetImportError, setPresetImportError] = useState('');
  const [previewPlaybackMs, setPreviewPlaybackMs] = useState(0);
  const [showRunLogs, setShowRunLogs] = useState(false);
  const [compareRunId, setCompareRunId] = useState<string | null>(null);
  const [presetCopyFeedback, setPresetCopyFeedback] = useState('');
  const [showHints, setShowHints] = useState(false);
  const [taskClockMs, setTaskClockMs] = useState(() => Date.now());
  const [focusedHintKey, setFocusedHintKey] = useState<AnalysisHintKey | null>(null);
  const [hoveredHintKey, setHoveredHintKey] = useState<AnalysisHintKey | null>(null);
  const [hintCardPosition, setHintCardPosition] = useState<{ left: number; top: number } | null>(null);
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
  const sampleFpsGuardrail = getSampleFpsGuardrail(
    selectedRecordingSummary?.fps ?? null,
    runSettings.allow_high_fps_sampling,
  );
  const hintCopy: Record<AnalysisHintKey, string> = {
    analysis_engine:
      'Choose the classic scene detector for continuity, or the hybrid detector to prioritize interface-level changes such as menus, buttons, and content shifts.',
    analysis_preset:
      runSettings.analysis_engine === 'hybrid_v2'
        ? describeAnalysisPreset(runSettings)
        : 'Hybrid presets only affect the v2 detector. Switch engines to use the UI-change pipeline.',
    allow_high_fps_sampling: sampleFpsGuardrail.isHighFpsRecording
      ? `Turn this on to sample above 30 fps or use source fps for this ~${sampleFpsGuardrail.sourceFpsCeiling} fps recording.`
      : 'Use this only when you need denser sampling on recordings above 30 fps.',
    detector_mode: describeDetectorMode(runSettings.detector_mode),
    extract_offset_ms: describeExtractOffset(runSettings.extract_offset_ms),
    hybrid_advanced:
      runSettings.analysis_engine === 'hybrid_v2'
        ? 'Start with the preset. Use overrides only when a specific recording still misses or overfires on interface changes.'
        : 'Hybrid advanced controls are only used by the v2 detector.',
    hybrid_min_dwell_ms: describeHybridMinDwellHint(runSettings),
    hybrid_ocr_confirmation: describeHybridOcrConfirmationHint(),
    hybrid_sample_fps_override: describeHybridSampleFpsOverrideHint(runSettings),
    hybrid_settle_window_ms: describeHybridSettleWindowHint(runSettings),
    load: 'Paste Stepthrough preset text to load a saved parameter set into the active analysis controls.',
    min_scene_gap_ms: describeMinSceneGap(runSettings.min_scene_gap_ms),
    reset: 'Reset the current analysis parameters to this project or universal defaults.',
    run: 'Start a new analysis task for the selected video using the current parameter set.',
    sample_fps: describeSampleFps(runSettings.sample_fps, selectedRecordingSummary?.fps ?? null),
    save: 'Save the current analysis parameters for this project or as universal defaults.',
    tolerance: describeTolerance(runSettings.tolerance, runSettings.detector_mode),
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
  const isEngineDirty = runSettings.analysis_engine !== projectDefaultSettings.analysis_engine;
  const isPresetDirty = runSettings.analysis_preset !== projectDefaultSettings.analysis_preset;
  const isHybridAdvancedDirty =
    (runSettings.advanced?.sample_fps_override ?? null) !==
      (projectDefaultSettings.advanced?.sample_fps_override ?? null) ||
    (runSettings.advanced?.min_dwell_ms ?? null) !==
      (projectDefaultSettings.advanced?.min_dwell_ms ?? null) ||
    (runSettings.advanced?.settle_window_ms ?? null) !==
      (projectDefaultSettings.advanced?.settle_window_ms ?? null) ||
    (runSettings.advanced?.enable_ocr ?? true) !== (projectDefaultSettings.advanced?.enable_ocr ?? true);
  const isToleranceDirty = runSettings.tolerance !== projectDefaultSettings.tolerance;
  const isMinSceneGapDirty =
    runSettings.min_scene_gap_ms !== projectDefaultSettings.min_scene_gap_ms;
  const isSampleFpsDirty = runSettings.sample_fps !== projectDefaultSettings.sample_fps;
  const isHighFpsDirty =
    runSettings.allow_high_fps_sampling !== projectDefaultSettings.allow_high_fps_sampling;
  const isExtractOffsetDirty =
    runSettings.extract_offset_ms !== projectDefaultSettings.extract_offset_ms;
  const isDetectorModeDirty = runSettings.detector_mode !== projectDefaultSettings.detector_mode;
  const canAddManualCandidate = Boolean(
    previewMatchesSelectedRun &&
      selectedRun &&
      ['completed', 'failed', 'cancelled'].includes(selectedRun.summary.status),
  );
  const showHighFpsWarning = Boolean(
    runSettings.analysis_engine === 'scene_v1' &&
      selectedRecordingSummary &&
      sampleFpsGuardrail.isHighFpsRecording &&
      !runSettings.allow_high_fps_sampling,
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
      return analysisTaskItems.filter((item) => ['queued', 'running'].includes(item.run.status));
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
  const candidateCounts = useMemo(() => {
    const candidates = selectedRun?.candidates ?? [];
    return {
      pending: candidates.filter((candidate) => candidate.status === 'pending').length,
      accepted: candidates.filter((candidate) => candidate.status === 'accepted').length,
      rejected: candidates.filter((candidate) => candidate.status === 'rejected').length,
      all: candidates.length,
    };
  }, [selectedRun]);
  const filteredCandidates = useMemo(() => {
    if (!selectedRun || !canReviewCandidates) {
      return [];
    }
    return selectedRun.candidates.filter((candidate) =>
      candidateMatchesFilter(candidate, activeCandidateFilter),
    );
  }, [activeCandidateFilter, canReviewCandidates, selectedRun]);
  const timelineCandidates = useMemo(() => {
    if (!selectedRun) {
      return [];
    }
    return [...selectedRun.candidates].sort((left, right) => left.timestamp_ms - right.timestamp_ms);
  }, [selectedRun]);
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
      }
    }

    window.addEventListener('keydown', handleReviewKeydown);
    return () => window.removeEventListener('keydown', handleReviewKeydown);
  }, [activeCandidate, canReviewCandidates, filteredCandidates]);

  useEffect(() => {
    if (!canAddManualCandidate) {
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
  }, [canAddManualCandidate, previewPlaybackMs, selectedRun?.summary.id]);

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

  function handleCreateManualCandidate(timestampOverrideMs?: number) {
    if (!selectedRun || !canAddManualCandidate) {
      return;
    }

    const timestampMs = timestampOverrideMs ?? getCurrentPreviewTimestampMs();
    if (timestampMs === null) {
      return;
    }
    setManualCapturePulseToken((current) => current + 1);
    setQueuedManualMarkItems((current) => [...current, { id: createLocalId('manual-mark'), timestampMs }]);
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
    );
    if (!nextCandidateId) {
      return;
    }
    setActiveCandidateId(nextCandidateId);
    window.setTimeout(() => jumpToAnchor(`candidate-${nextCandidateId}`), 0);
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
          <div className="analysis-stage-nav-cell">
            <div className="analysis-project-path">
              <button className="analysis-nav-button" onClick={() => onNavigateStage('projects')} type="button">
                projects/
              </button>
              {activeProject ? (
                <EditableName
                  buttonClassName="entry-rename-button"
                  containerClassName="analysis-project-name"
                  onSave={(nextValue) => onRenameProject(activeProject.id, nextValue)}
                  renameLabel={`Rename project ${activeProject.name}`}
                  textClassName="analysis-project-name-text"
                  value={activeProject.name}
                />
              ) : (
                <span className="analysis-project-name-text">Project</span>
              )}
            </div>
            <p className="analysis-project-counts">{activeProject ? formatProjectCounts(activeProject) : ''}</p>
          </div>
          <div className="analysis-stage-nav-cell">
            <button className="analysis-nav-button" onClick={() => onNavigateStage('import')} type="button">
              import
            </button>
          </div>
          <div className="analysis-stage-nav-cell">
            <span className="analysis-nav-button active">analysis</span>
          </div>
        </div>

        {(healthMessage || appError || liveMessage || settingsFeedback || analysisActionMessage) && (
          <div aria-atomic="true" aria-live="polite" className="analysis-notices" role="status">
            {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
            {appError && <p className="entry-notice error">{appError}</p>}
            {liveMessage && <p className="entry-notice">{liveMessage}</p>}
            {settingsFeedback && <p className="entry-notice">{settingsFeedback}</p>}
            {analysisActionMessage && <p className="entry-notice">{analysisActionMessage}</p>}
          </div>
        )}

        <div className="analysis-grid">
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
            bindHint={bindHint}
            closePopover={closePopover}
            createRunPending={createRunPending}
            healthWarning={healthWarning}
            hintCardPosition={hintCardPosition}
            hintText={hintText}
            isDetectorModeDirty={isDetectorModeDirty}
            isEngineDirty={isEngineDirty}
            isExtractOffsetDirty={isExtractOffsetDirty}
            isHighFpsDirty={isHighFpsDirty}
            isHybridAdvancedDirty={isHybridAdvancedDirty}
            isMinSceneGapDirty={isMinSceneGapDirty}
            isPresetDirty={isPresetDirty}
            isSampleFpsDirty={isSampleFpsDirty}
            isToleranceDirty={isToleranceDirty}
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
            parameterColumnRef={parameterColumnRef}
            presetCopyFeedback={presetCopyFeedback}
            presetImportDraft={presetImportDraft}
            presetImportError={presetImportError}
            presetMenuRef={presetMenuRef}
            projectDefaultSettings={projectDefaultSettings}
            resetMenuRef={resetMenuRef}
            runSettings={runSettings}
            sampleFpsGuardrail={sampleFpsGuardrail}
            saveMenuRef={saveMenuRef}
            selectedRecordingId={selectedRecordingId}
            selectedRecordingSummary={selectedRecordingSummary}
            setPresetImportDraftChange={handlePresetImportDraftChange}
            setRunSettings={setRunSettings}
            showHighFpsWarning={showHighFpsWarning}
            showHints={showHints}
            showLowCandidateHint={showLowCandidateHint}
            showPresetText={showPresetText}
            togglePopover={togglePopover}
          />

          <AnalysisTasksPanel
            analysisTaskItems={analysisTaskItems}
            bulkDeletePending={bulkDeletePending}
            bulkExportPending={bulkExportPending}
            expandedTaskRunId={expandedTaskRunId}
            groupedTaskItems={groupedTaskItems}
            onAbortRun={onAbortRun}
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
            selectedRunId={selectedRun?.summary.id ?? null}
            selectedTaskRunIds={selectedTaskRunIds}
            taskClockMs={taskClockMs}
            taskFilter={taskFilter}
            taskSelectMode={taskSelectMode}
          />
        </div>

        {previewVideoUrl && (
          <div className="analysis-lower-grid">
            <div className="analysis-lower-column">
              {previewVideoUrl ? (
                <section className="analysis-panel analysis-preview-panel" id="analysis-video-preview">
                  <div className="analysis-preview-head">
                    <div className="analysis-preview-meta-wrap">
                      <span className="analysis-preview-meta">
                        {previewRecording?.filename} · {formatPlaybackTimestamp(previewPlaybackMs)}
                      </span>
                      {canAddManualCandidate ? (
                        <span className="analysis-preview-mark-copy">
                          click anywhere in the button or press K to mark the current frame
                        </span>
                      ) : null}
                    </div>
                    {canAddManualCandidate ? (
                      <button
                        aria-busy={createManualCandidatePending || queuedManualMarkItems.length > 0}
                        className="analysis-preview-mark-button"
                        onClick={(event) => {
                          if (event.detail !== 0) {
                            return;
                          }
                          handleCreateManualCandidate();
                        }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) {
                            return;
                          }
                          event.preventDefault();
                          const timestampMs = getCurrentPreviewTimestampMs();
                          if (timestampMs === null) {
                            return;
                          }
                          handleCreateManualCandidate(timestampMs);
                        }}
                        title="Mark the current preview frame as a new step."
                        type="button"
                      >
                        {manualCapturePulseToken > 0 ? (
                          <span
                            aria-hidden="true"
                            className="analysis-preview-mark-pulse"
                            key={manualCapturePulseToken}
                          />
                        ) : null}
                        <span className="analysis-preview-mark-main">
                          <span className="analysis-preview-mark-title">mark step</span>
                          <span className="analysis-preview-mark-subtitle">
                            captures this moment immediately while the video plays
                          </span>
                        </span>
                        <span className="analysis-preview-mark-shortcut">K</span>
                        {queuedManualMarkItems.length > 0 ? (
                          <span className="analysis-preview-mark-queue">{queuedManualMarkItems.length}</span>
                        ) : null}
                      </button>
                    ) : null}
                  </div>
                  <video
                    className="analysis-preview-video"
                    controls
                    onLoadedMetadata={(event) => setPreviewPlaybackMs(event.currentTarget.currentTime * 1000)}
                    onSeeked={(event) => setPreviewPlaybackMs(event.currentTarget.currentTime * 1000)}
                    onTimeUpdate={(event) => setPreviewPlaybackMs(event.currentTarget.currentTime * 1000)}
                    playsInline
                    ref={previewVideoRef}
                    src={previewVideoUrl}
                  />
                </section>
              ) : null}
            </div>
            <div className="analysis-lower-column" />
            <div className="analysis-lower-column" />
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
                  {formatAnalysisEngineLabel(selectedRun.summary.analysis_engine)} ·{' '}
                  {formatAnalysisPresetLabel(selectedRun.summary.analysis_preset)}
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
                                {new Date(event.created_at).toLocaleTimeString()} · {formatPhase(event.phase)}
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
                            <p className="empty-copy">Progress messages will appear here once the run starts.</p>
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
                    className="analysis-pill danger"
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
                      <h3>Compare completed runs</h3>
                    </div>
                    <label className="analysis-compare-select-wrap">
                      <span className="sr-only">Compare with another completed run</span>
                      <select
                        className="analysis-compare-select"
                        onChange={(event) => setCompareRunId(event.target.value || null)}
                        value={compareRunId ?? ''}
                      >
                        <option value="">select another completed run</option>
                        {comparableRuns.map((run) => (
                          <option key={run.id} value={run.id}>
                            {formatRunSettingsSummary(run)} · {new Date(run.created_at).toLocaleString()}
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
                                  ? selectedRun.summary.analysis_engine === 'scene_v1'
                                    ? 'v1 only'
                                    : 'v2 only'
                                  : comparedRun.summary.analysis_engine === 'scene_v1'
                                    ? 'v1 only'
                                    : 'v2 only';
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
                                        alt={`Selected run candidate at ${row.left.timestamp_tc}`}
                                        className="analysis-compare-image"
                                        src={absoluteApiUrl(row.left.image_url)}
                                      />
                                      <small>{row.left.timestamp_tc}</small>
                                      <ComparisonMetrics candidate={row.left} />
                                    </>
                                  ) : (
                                    <p className="analysis-compare-empty">No matching candidate</p>
                                  )}
                                </div>
                                <div className="analysis-compare-column">
                                  <p className="analysis-compare-column-label">comparison</p>
                                  {row.right ? (
                                    <>
                                      <img
                                        alt={`Comparison run candidate at ${row.right.timestamp_tc}`}
                                        className="analysis-compare-image"
                                        src={absoluteApiUrl(row.right.image_url)}
                                      />
                                      <small>{row.right.timestamp_tc}</small>
                                      <ComparisonMetrics candidate={row.right} />
                                    </>
                                  ) : (
                                    <p className="analysis-compare-empty">No matching candidate</p>
                                  )}
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </>
                  ) : compareRunId ? (
                    <p className="analysis-compare-guidance">Loading comparison run…</p>
                  ) : (
                    <p className="analysis-compare-guidance">
                      Select another completed run from this recording to compare outputs side by side.
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
                                <span className="accepted-step-link-label">returning scene</span>
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
                  <div className="candidate-timeline-shell">
                    <div className="candidate-timeline-rail" aria-label="Candidate timeline">
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
                ) : null}

                <div className="candidate-review-toolbar" id="analysis-review-toolbar">
                  <div className="candidate-review-nav-group">
                    <div aria-label="Candidate review filters" className="candidate-filter-tabs" role="tablist">
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
                        aria-label="Keyboard shortcuts: A to accept, R to reject, U to reset pending, arrow keys to step"
                        className="candidate-review-key-hint"
                      >
                        <span className="candidate-key-badge">A</span> accept {' · '}
                        <span className="candidate-key-badge">R</span> reject {' · '}
                        <span className="candidate-key-badge">U</span> reset {' · '}
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
                              <span className="sr-only">Export zip name</span>
                              <input
                                aria-label="Export zip name"
                                className="candidate-export-name-field"
                                onChange={(event) => setExportNameDraft(event.target.value)}
                                placeholder="Use server filename"
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

                {filteredCandidates.length ? (
                  <div className={`candidate-grid ${filteredCandidates.length < 3 ? 'sparse' : ''}`} id="analysis-candidate-review">
                    {filteredCandidates.map((candidate) => {
                      const similarityLink = candidateSimilarityLinks.get(candidate.id);
                      return (
                        <CandidateCard
                          candidate={candidate}
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
                    {activeCandidateFilter === 'all'
                      ? 'No scenes in this run.'
                      : activeCandidateFilter === 'pending'
                        ? 'No pending scenes left in this run.'
                        : `No ${activeCandidateFilter} scenes in this view.`}
                  </p>
                )}
              </>
            ) : null}
          </section>
        ) : selectedRecording ? (
          <section className="analysis-detail-section empty-state">
            <h2>{selectedRecording.filename}</h2>
            <p>Select a video name or a task link to review candidates, logs, and exports here.</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
