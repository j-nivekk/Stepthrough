import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { busyElsewhere, busyRunIds } from '../../lib/live';
import { useLive } from '../live/LiveProvider';
import { absoluteApiUrl, getRunText, setRunPhase } from '../../api';
import { EARLIER_TEXT, stepsWithText } from '../../lib/stepText';
import { screenshotUrl } from '../../lib/screenshots';
import { DecisionIcon } from '../../components/CandidateCard';
import { onSelectedText, shouldIgnoreContextMenu } from '../../components/ContextMenu';
import { CandidateGallery } from '../../components/CandidateGallery';
import { EditableName } from '../../components/EditableName';
import {
  activeRunStatuses,
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
  formatRunNumber,
  formatRunShortTimestamp,
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
import { clickSelection, invertSelection, keepShown, selectionState } from '../../lib/stepSelection';
import type {
  AnalysisMetadata,
  CandidateChanges,
  CandidateFrame,
  CandidateStatus,
  ExportMode,
  Project,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunSettings,
  RunSummary,
  TransitionType,
} from '../../types';
import { AnalysisParametersPanel } from './components/AnalysisParametersPanel';
import { AnalysisTasksPanel } from './components/AnalysisTasksPanel';
import { AnalysisVideosPanel } from './components/AnalysisVideosPanel';
import { RunComparison, type CarryOverPair } from './components/RunComparison';
import { RunTextControl } from './components/RunTextControl';
import { StepMenu } from './components/StepMenu';
import { defaultComparisonPair } from '../../lib/runComparison';
import type { ImportQueueItem } from '../../lib/importQueue';
import type { WorkflowStage } from '../../lib/workflow';
import { defaultStableSettings, formatStableSummary } from '../../lib/stableSettings';
import {
  clampStepSize,
  fitStepGrid,
  galleryLayoutSizing,
  loadStepLayout,
  recordingAspect,
  saveStepLayout,
  STEP_SIZE_DEFAULT,
  STEP_SIZE_MAX,
  STEP_SIZE_MIN,
  stepImageBox,
  stepThumbBox,
  type StepLayout,
} from '../../lib/stepLayout';
import { rangeFillStyle } from '../../lib/rangeFill';
import { playbackWindows, stepClip } from '../../lib/stepClips';
import type { StepHoverProps } from '../../components/CandidateCard';
import { PathwayPanel } from '../pathway/PathwayPanel';
import { useElementWidth } from './useElementWidth';
import { useHoverClips } from './useHoverClips';
import { usePlaybackHighlight } from './usePlaybackHighlight';
import { track } from '../../lib/usage';
import { phaseAt, withPhaseHeaders } from '../../components/PhaseChoice';
import { PhaseNamePopover } from '../../components/PhaseNamePopover';
import { isPopupStep, popupChange } from '../../components/ScreenChoice';
import { ReviewCard, ReviewRow } from '../../components/ReviewSteps';
import { StepNumbersProvider } from '../../components/StepNumbers';
import type { StepMenuContext } from '../../lib/stepMenu';
import { candidateNumber, returnLinks, reviewNumbers, START } from '../../lib/stepNumbers';
import { useStable } from '../../lib/useStable';


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
  duplicateRunPending: boolean;
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
  onCreateManualRun: (recordingId: string) => Promise<RunSummary>;
  onDeleteRecording: (recordingId: string, filename: string) => void;
  onDropFiles: (files: FileList | File[]) => void;
  /** Videos of the project still on their way in, and how to stop one. */
  uploads: ImportQueueItem[];
  onCancelUpload: (localId: string) => void;
  onDeleteSelectedRuns: (runIds: string[]) => Promise<string[] | null>;
  onDuplicateRun: (runId: string) => Promise<void>;
  onExportRun: (runId: string, mode: ExportMode, downloadName?: string) => Promise<void>;
  onExportTaskRuns: (runIds: string[]) => Promise<void>;
  onNavigateStage: (stage: WorkflowStage) => void;
  onPreviewRecording: (recordingId: string) => void;
  /** Open the preview on a recording without toggling it closed when it is already open. */
  onOpenPreview: (recordingId: string) => void;
  onRenameProject: (projectId: string, name: string, previousName: string) => Promise<void>;
  onRenameRecording: (recordingId: string, filename: string, previousFilename: string) => Promise<void>;
  /** Name a run ('' takes the name away); `previousName` is the name shown when the rename began ('' for none). */
  onRenameRun: (runId: string, name: string, previousName: string) => Promise<void>;
  onResetToProjectDefaults: () => void;
  onResetToUniversalDefaults: () => void;
  onRestoreFactorySettings: () => void;
  /** Brings the review of one run over to another run of the same recording; resolves once it is in. */
  onCarryOverReview: (sourceRunId: string, targetRunId: string, pairs: CarryOverPair[]) => Promise<boolean>;
  carryOverPending: boolean;
  /** Opens the about panel at the bottom right. */
  onOpenAbout: () => void;
  onSaveProjectPreset: () => void;
  onSaveUniversalPreset: () => void;
  onSelectRecording: (recordingId: string) => void;
  onSelectRun: (recordingId: string, runId: string, anchorId?: string) => void;
  onStartRun: () => void;
  onUpdateCandidate: (
    candidateId: string,
    payload: CandidateChanges,
  ) => void;
  /** Changes to several steps at once. */
  onUpdateCandidates: (runId: string, recordingId: string, changes: Array<[string, CandidateChanges]>) => Promise<void>;
  ocrAvailable: boolean;
  ocrStatusMessage: string | null;
  ocrProblem: string | null;
  onReadText: (runId: string) => void;
  onStopReadingText: (runId: string) => void;
  textPending: boolean;
  previewRecording: RecordingSummary | null;
  projectDefaultSettings: RunSettings;
  recordings: RecordingSummary[];
  recordingsLoading: boolean;
  runSettings: RunSettings;
  selectedRecording: RecordingDetail | null;
  selectedRecordingId: string | null;
  selectedRecordingSummary: RecordingSummary | null;
  /** Video focus bumped when selecting a video in the video list (not when picking a run in the tasks list). */
  videoListFocus: { recordingId: string; nonce: number } | null;
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
  duplicateRunPending,
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
  uploads,
  onCancelUpload,
  onDeleteSelectedRuns,
  onDuplicateRun,
  onExportRun,
  onExportTaskRuns,
  onNavigateStage,
  onPreviewRecording,
  onOpenPreview,
  onRenameProject,
  onRenameRecording,
  onRenameRun,
  onResetToProjectDefaults,
  onResetToUniversalDefaults,
  onRestoreFactorySettings,
  onCarryOverReview,
  carryOverPending,
  onOpenAbout,
  onSaveProjectPreset,
  onSaveUniversalPreset,
  onSelectRecording,
  onSelectRun,
  onStartRun,
  onUpdateCandidate,
  onUpdateCandidates,
  ocrAvailable,
  onReadText,
  onStopReadingText,
  textPending,
  ocrProblem,
  ocrStatusMessage,
  previewRecording,
  projectDefaultSettings,
  recordings,
  recordingsLoading,
  runSettings,
  selectedRecording,
  selectedRecordingId,
  selectedRecordingSummary,
  videoListFocus,
  selectedRunId,
  selectedRun,
  selectedRunLoading = false,
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
  const [pendingPlayFromMs, setPendingPlayFromMs] = useState<number | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  // The step whose box was clicked last: shift with a box selects from it (lib/stepSelection.ts). A ref, as the
  // keyboard's x reads it from a handler made once.
  const selectionAnchorRef = useRef<string | null>(null);
  const [bulkCandidatePending, setBulkCandidatePending] = useState(false);
  // The right-click menu of a step (or of the selected steps, when it is one of several), and the naming of a phase
  // that it can lead to.
  const [stepMenu, setStepMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeStepMenu = useCallback(() => setStepMenu(null), []);
  // Whether the pointer came down on selected text. By the time the menu is asked for it is too late to tell: on a Mac,
  // a right click selects the word it is on first.
  const pressedTextRef = useRef(false);
  useEffect(() => {
    const note = (event: PointerEvent) => {
      pressedTextRef.current = onSelectedText(event.clientX, event.clientY);
    };
    window.addEventListener('pointerdown', note, true);
    return () => window.removeEventListener('pointerdown', note, true);
  }, []);
  const [phaseNaming, setPhaseNaming] = useState<{ first: CandidateFrame; last: CandidateFrame; x: number; y: number; problem?: string } | null>(null);
  const closePhaseNaming = useCallback(() => setPhaseNaming(null), []);
  const queryClient = useQueryClient();
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
  // Two runs of one recording side by side (RunComparison), opened from the tasks list.
  const [comparison, setComparison] = useState<{ recordingId: string; left: string; right: string } | null>(null);
  const [presetCopyFeedback, setPresetCopyFeedback] = useState('');
  const [showHints, setShowHints] = useState(false);
  const [taskClockMs, setTaskClockMs] = useState(() => Date.now());
  const [focusedHintKey, setFocusedHintKey] = useState<AnalysisHintKey | null>(null);
  const [hoveredHintKey, setHoveredHintKey] = useState<AnalysisHintKey | null>(null);
  const [hintCardPosition, setHintCardPosition] = useState<{ left: number; top: number } | null>(null);
  const [hoveredLegendType, setHoveredLegendType] = useState<string | null>(null);
  const [hiddenSegmentTypes, setHiddenSegmentTypes] = useState<Set<string>>(new Set());
  const [hoveredCandidateId, setHoveredCandidateId] = useState<string | null>(null);
  const [timelineScrub, setTimelineScrub] = useState<{
    pct: number;
    ms: number;
    candidate: CandidateFrame | null;
    dragging: boolean;
  } | null>(null);
  const [acceptedStripPanning, setAcceptedStripPanning] = useState(false);
  const acceptedStripDragRef = useRef<{
    startX: number;
    startScroll: number;
    moved: boolean;
  } | null>(null);
  const paintSelectRef = useRef<{
    mode: 'select' | 'deselect';
    dragged: boolean;
  } | null>(null);
  const [stepLayout, setStepLayout] = useState<StepLayout>(() => loadStepLayout());
  const [reviewMode, setReviewMode] = useState<'steps' | 'pathway'>('steps');
  const [stepAreaRef, stepAreaWidth] = useElementWidth<HTMLDivElement>();
  const parameterColumnRef = useRef<HTMLElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  const resetMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const activeManualMarkIdRef = useRef<string | null>(null);
  const creatingManualRuns = useRef(new Map<string, Promise<RunSummary>>());


  const previewVideoUrl = previewRecording ? absoluteApiUrl(previewRecording.source_url) : null;
  const hintCopy: Record<AnalysisHintKey, string> = {
    presets:
      'save the current parameters for this project or as universal defaults, or load and share them as preset text.',
    reset:
      'reset the current analysis parameters to this project or universal defaults, or restore factory settings.',
    run: 'start a new analysis task for the selected video using the current parameter set.',
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
      'reads the text on each screenshot once the steps are found, to show, search and export it (ocr_text). it is not needed to find steps, and the analysis does not wait for it.',
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
  // The pathway takes the place of the whole step review, so its shortcuts are off while it shows.
  const showPathway = canReviewCandidates && isCompletedReview && reviewMode === 'pathway';
  const previewMatchesSelectedRun = Boolean(
    previewRecording && selectedRun && previewRecording.id === selectedRun.summary.recording_id,
  );
  // Shared accounts: what other browsers are doing to tasks right now (see LiveProvider).
  const live = useLive();
  const runsBusyElsewhere = useMemo(() => busyRunIds(live.busy, live.clientId), [live.busy, live.clientId]);
  const selectedRunBusy = busyElsewhere(live.busy, selectedRun?.summary.id ?? null, live.clientId);
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
          // stored with the run since runs have numbers; worked out from the order only for a server without them
          nextMap.set(item.run.id, item.run.run_number ?? index + 1);
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
  // Words looked for in the text of the screens leave the steps that have them.
  const [textQuery, setTextQuery] = useState('');
  const runText = selectedRun?.summary.text;
  useEffect(() => setTextQuery(''), [selectedRun?.summary.id]);
  const runTextQuery = useQuery({
    queryKey: ['run-text', selectedRun?.summary.id, runText?.read, runText?.earlier],
    queryFn: ({ signal }) => getRunText(selectedRun?.summary.id ?? '', signal),
    enabled: Boolean(selectedRun) && textQuery.trim() !== '',
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const stepsFound = useMemo(() => stepsWithText(runTextQuery.data, textQuery), [runTextQuery.data, textQuery]);
  const foundCandidates = useMemo(
    () => (stepsFound ? labelVisibleCandidates.filter((candidate) => stepsFound.has(candidate.id)) : labelVisibleCandidates),
    [labelVisibleCandidates, stepsFound],
  );
  const candidateCounts = useMemo(() => {
    const candidates = foundCandidates;
    return {
      pending: candidates.filter((candidate) => candidate.status === 'pending').length,
      accepted: candidates.filter((candidate) => candidate.status === 'accepted').length,
      rejected: candidates.filter((candidate) => candidate.status === 'rejected').length,
      all: candidates.length,
    };
  }, [foundCandidates]);
  const filteredCandidates = useMemo(() => {
    if (!selectedRun || !canReviewCandidates) {
      return [];
    }
    return foundCandidates.filter((candidate) => candidateMatchesFilter(candidate, activeCandidateFilter));
  }, [activeCandidateFilter, canReviewCandidates, foundCandidates, selectedRun]);
  const stepAspect = recordingAspect(selectedRecordingSummary?.width, selectedRecordingSummary?.height);
  // Fitted (the default): cards fill the width of the page. A size from the slider keeps cards exactly that size.
  const fittedStepGrid = stepLayout.size === null && stepAreaWidth > 0 ? fitStepGrid(stepAreaWidth, stepAspect) : null;
  const stepSize = stepLayout.size ?? fittedStepGrid?.size ?? STEP_SIZE_DEFAULT;
  const stepCardWidth = fittedStepGrid?.cardWidth ?? stepImageBox(stepSize, stepAspect).width;
  const stepThumb = stepThumbBox(stepSize, stepAspect);
  const gallerySizing = galleryLayoutSizing(stepLayout.size, stepAspect);
  const stepSliderValue = clampStepSize(stepSize);
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
  // What each screenshot is called: accepted steps as in the pathway and the files, the others as candidates.
  const stepNumbers = useMemo(
    () => reviewNumbers(selectedRun?.candidates ?? [], selectedRun?.accepted_steps ?? []),
    [selectedRun?.candidates, selectedRun?.accepted_steps],
  );
  const backLinks = useMemo(() => returnLinks(selectedRun?.candidates ?? [], stepNumbers), [selectedRun?.candidates, stepNumbers]);
  const stepPhases = useMemo(
    () => (selectedRun ? { runId: selectedRun.summary.id, boundaries: selectedRun.phases } : undefined),
    [selectedRun?.summary.id, selectedRun?.phases],
  );
  // For the steps a phase holds: the opening screen is where they start and none of them.
  const stepsToCount = useMemo(
    () => (selectedRun?.candidates ?? []).filter((candidate) => stepNumbers.get(candidate.id)?.number !== START),
    [selectedRun?.candidates, stepNumbers],
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
  // Steps are selected among the ones shown, whatever their decision, to accept, reject or reset them together.
  const shownCandidateIds = useMemo(() => filteredCandidates.map((candidate) => candidate.id), [filteredCandidates]);
  const selectedShownCandidateIds = useMemo(
    () => keepShown(selectedCandidateIds, shownCandidateIds),
    [selectedCandidateIds, shownCandidateIds],
  );
  const shownSelectionState = selectionState(selectedCandidateIds, shownCandidateIds);
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
    setSelectedCandidateIds((current) => keepShown(current, shownCandidateIds));
  }, [shownCandidateIds]);

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
    selectionAnchorRef.current = null;
    setBulkCandidatePending(false);
  }, [canReviewCandidates, selectedRun?.summary.id]);

  useEffect(() => {
    setOpenPopover((current) => (current === 'export' ? null : current));
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    setQueuedManualMarkItems((current) => current.filter((mark) => mark.runId === selectedRunId));
    setManualCapturePulseToken(0);
  }, [selectedRunId]);

  useEffect(() => {
    if (!openPopover) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        presetMenuRef.current?.contains(target) ||
        resetMenuRef.current?.contains(target) ||
        exportMenuRef.current?.contains(target)
      ) {
        return;
      }
      setOpenPopover(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpenPopover(null);
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
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

    const nextMark = queuedManualMarkItems.find((mark) => mark.runId === selectedRun.summary.id);
    if (!nextMark) return;
    activeManualMarkIdRef.current = nextMark.id;

    void (async () => {
      try {
        await onCreateManualCandidate(selectedRun.summary.id, nextMark.timestampMs);
      } catch {
        // The app reports save failures next to the review.
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

  // The clock moves the elapsed time of running analyses each second, and "last exported 5 min ago" each minute.
  // Each tick draws the whole page again (every step card, the pathway), so it ticks each second only while an
  // analysis is running.
  const anyRunActive = analysisTaskItems.some((item) => activeRunStatuses.includes(item.run.status));
  useEffect(() => {
    setTaskClockMs(Date.now());
    const intervalId = globalThis.setInterval(() => setTaskClockMs(Date.now()), anyRunActive ? 1000 : 60_000);
    return () => globalThis.clearInterval(intervalId);
  }, [anyRunActive]);

  useEffect(() => {
    if (!canReviewCandidates || showPathway) {
      return;
    }

    function handleReviewKeydown(event: KeyboardEvent) {
      if (isEditableElement(event.target)) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === 'Escape') {
        if (selectedCandidateIds.length > 0) {
          event.preventDefault();
          selectionAnchorRef.current = null;
          setSelectedCandidateIds([]);
        }
        return;
      }
      if (!activeCandidate && filteredCandidates.length > 0) {
        setActiveCandidateId(filteredCandidates[0].id);
        return;
      }

      if (!activeCandidate) {
        return;
      }

      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        // The lists of tasks and videos have menus of their own.
        const review = document.getElementById('analysis-candidate-review');
        const elsewhere = event.target instanceof Element && event.target !== document.body && !review?.contains(event.target);
        const box = document.getElementById(`candidate-${activeCandidate.id}`)?.getBoundingClientRect();
        if (elsewhere || !box) return;
        event.preventDefault();
        openStepMenu(activeCandidate.id, box.left + 18, Math.max(12, box.top + 18));
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
      } else if (lowerKey === 'x') {
        // select the step in focus (with shift, every step from the one selected last)
        event.preventDefault();
        toggleCandidateSelection(activeCandidate.id, event.shiftKey);
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
  }, [activeCandidate, canReviewCandidates, filteredCandidates, previewMatchesSelectedRun, selectedCandidateIds.length, selectedRun?.summary.id, selectedShownCandidateIds, showPathway, stepLayout.view]);

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

  /** A step's box: toggles it, or with shift every step from the last one clicked (or active step) to this one. */
  function toggleCandidateSelection(candidateId: string, shift = false) {
    const anchor = selectionAnchorRef.current ?? (shift ? activeCandidateId : null);
    selectionAnchorRef.current = candidateId;
    setSelectedCandidateIds((current) => clickSelection(current, shownCandidateIds, candidateId, anchor, shift));
  }

  /** Accept, reject or reset (to undecided) the selected steps, skipping the ones that are so already. The selection
   *  stays, so that a mistaken choice can be put right at once. */
  async function handleBulkCandidateStatusChange(status: Extract<CandidateStatus, 'accepted' | 'rejected' | 'pending'>) {
    if (!selectedRun) {
      return;
    }
    const byId = new Map(selectedRun.candidates.map((candidate) => [candidate.id, candidate]));
    const changing = selectedShownCandidateIds.filter((candidateId) => byId.get(candidateId)?.status !== status);
    if (!changing.length) {
      return;
    }

    setBulkCandidatePending(true);
    try {
      await onBulkUpdateCandidates(selectedRun.summary.id, selectedRun.summary.recording_id, changing, status);
    } finally {
      setBulkCandidatePending(false);
    }
  }

  async function handleUpdateSelectedCandidates(changes: Array<[string, CandidateChanges]>) {
    if (!selectedRun || !changes.length) return;
    setBulkCandidatePending(true);
    try {
      await onUpdateCandidates(selectedRun.summary.id, selectedRun.summary.recording_id, changes);
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
    if (!previewRecording) return;
    const timestamp = timestampOverrideMs ?? getCurrentPreviewTimestampMs();
    if (timestamp === null) return;

    setManualCapturePulseToken((current) => current + 1);
    function queueMark(runId: string, timestampMs: number) {
      setQueuedManualMarkItems((current) => [...current, { id: createLocalId('manual-mark'), runId, timestampMs }]);
    }
    if (canAddManualCandidate && selectedRun) {
      queueMark(selectedRun.summary.id, timestamp);
      return;
    }
    const recordingId = previewRecording.id;
    let creating = creatingManualRuns.current.get(recordingId);
    if (!creating) {
      creating = onCreateManualRun(recordingId).finally(() => creatingManualRuns.current.delete(recordingId));
      creatingManualRuns.current.set(recordingId, creating);
    }
    void creating.then((run) => queueMark(run.id, timestamp)).catch(() => {});
  }

  function handleToggleCandidateAnnotation(candidateId: string) {
    setExpandedAnnotationCandidateId((current) => (current === candidateId ? null : candidateId));
  }

  // End checkbox paint-select whenever the pointer lifts anywhere in the window.
  useEffect(() => {
    function endPaint() {
      paintSelectRef.current = null;
    }
    window.addEventListener('pointerup', endPaint);
    window.addEventListener('pointercancel', endPaint);
    return () => {
      window.removeEventListener('pointerup', endPaint);
      window.removeEventListener('pointercancel', endPaint);
    };
  }, []);

  function startPaintSelect(candidateId: string, currentlySelected: boolean) {
    const mode = currentlySelected ? 'deselect' : 'select';
    selectionAnchorRef.current = candidateId;
    paintSelectRef.current = { mode, dragged: false };
    setSelectedCandidateIds((current) =>
      mode === 'select'
        ? current.includes(candidateId)
          ? current
          : [...current, candidateId]
        : current.filter((id) => id !== candidateId),
    );
  }

  function continuePaintSelect(candidateId: string) {
    const paint = paintSelectRef.current;
    if (!paint) return;
    paint.dragged = true;
    selectionAnchorRef.current = candidateId;
    setSelectedCandidateIds((current) =>
      paint.mode === 'select'
        ? current.includes(candidateId)
          ? current
          : [...current, candidateId]
        : current.filter((id) => id !== candidateId),
    );
  }

  function resolveTimelinePoint(clientX: number, rect: DOMRect): { pct: number; ms: number; candidate: CandidateFrame | null } {
    const duration = Math.max(1, selectedRecordingSummary?.duration_ms ?? 1);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const pct = ratio * 100;
    const ms = ratio * duration;
    let nearest: CandidateFrame | null = null;
    let bestDiff = Infinity;
    for (const candidate of timelineCandidates) {
      const cPct = Math.max(0, Math.min(100, (candidate.timestamp_ms / duration) * 100));
      const diff = Math.abs(cPct - pct);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = candidate;
      }
    }
    // Snap to a candidate pin within 3.5% of the rail width (about 16–45px).
    return { pct, ms, candidate: bestDiff <= 3.5 ? nearest : null };
  }

  function handleTimelinePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // Direct click on a pin button lets the pin handle activation cleanly unless dragged.
    if (event.target instanceof Element && event.target.closest('.candidate-timeline-pin')) return;
    const rail = event.currentTarget;
    rail.setPointerCapture(event.pointerId);
    const point = resolveTimelinePoint(event.clientX, rail.getBoundingClientRect());
    setTimelineScrub({ ...point, dragging: true });
    setHoveredCandidateId(point.candidate?.id ?? null);
    if (previewMatchesSelectedRun) seekPreviewTo(point.ms);
  }

  function handleTimelinePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const rail = event.currentTarget;
    const point = resolveTimelinePoint(event.clientX, rail.getBoundingClientRect());
    const dragging = Boolean(timelineScrub?.dragging);
    setTimelineScrub({ ...point, dragging });
    setHoveredCandidateId(point.candidate?.id ?? null);
    if (dragging && previewMatchesSelectedRun) seekPreviewTo(point.ms);
  }

  function handleTimelinePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!timelineScrub?.dragging) return;
    const rail = event.currentTarget;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    const point = resolveTimelinePoint(event.clientX, rail.getBoundingClientRect());
    setTimelineScrub({ ...point, dragging: false });
    if (point.candidate) activateCandidate(point.candidate.id, { reveal: true, seekPreview: true });
    else if (previewMatchesSelectedRun) seekPreviewTo(point.ms);
  }

  function handleTimelinePointerLeave() {
    if (timelineScrub?.dragging) return;
    setTimelineScrub(null);
    setHoveredCandidateId(null);
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

    if (stepLayout.view === 'gallery') {
      if (options?.reveal) {
        window.setTimeout(() => jumpToAnchor('analysis-candidate-review'), 0);
      }
      return;
    }
    window.setTimeout(() => jumpToAnchor(`candidate-${candidate.id}`), 0);
  }

  function handleCandidateStatusChange(candidate: CandidateFrame, status: CandidateStatus) {
    setActiveCandidateId(candidate.id);
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
    if (stepLayout.view !== 'gallery') {
      window.setTimeout(() => jumpToAnchor(`candidate-${nextCandidateId}`), 0);
    }
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

  // Cards and rows get the same actions on every render, so that only those that look different are drawn again.
  const stepActions = useStable({
    activate: (candidateId: string) => setActiveCandidateId(candidateId),
    hoverChange: (candidateId: string, hovering: boolean) =>
      setHoveredCandidateId((current) => (hovering ? candidateId : current === candidateId ? null : current)),
    jumpTo: jumpToAnchor,
    paintEnter: continuePaintSelect,
    paintStart: startPaintSelect,
    setStatus: handleCandidateStatusChange,
    toggleSelection: toggleCandidateSelection,
    toggleAnnotation: handleToggleCandidateAnnotation,
    update: onUpdateCandidate,
    clipStart: hoverClips.start,
    clipLeave: hoverClips.leave,
    playFromHere: handlePlayFromHere,
  });
  const selectedShown = new Set(selectedShownCandidateIds);
  const taskActions = useStable({
    onAbortRun,
    onCompareRuns: handleCompareRuns,
    onDeleteRun: handleDeleteRun,
    onDuplicateRun,
    onRenameRun,
    onDeleteSelectedTasks: () => void handleDeleteSelectedTasks(),
    onEnterTaskSelectMode: handleEnterTaskSelectMode,
    onExitTaskSelectMode: handleExitTaskSelectMode,
    onExpandTaskRun: (runId: string) => setExpandedTaskRunId((current) => (current === runId ? null : runId)),
    onExportAllCompletedTasks: () => void handleExportAllCompletedTasks(),
    onExportSelectedTasks: () => void handleExportSelectedTasks(),
    onReviewTaskOutputs: handleReviewTaskOutputs,
    onSelectRun,
    onSetTaskFilter: setTaskFilter,
    onToggleTaskSelection: toggleTaskSelection,
  });

  // ── the right-click menu of the steps ──
  function openStepMenu(candidateId: string, x: number, y: number) {
    hoverClips.stop();
    setPhaseNaming(null);
    // One of several selected steps stands for all of them; any other is the one it is about.
    if (!(selectedShownCandidateIds.length > 1 && selectedShownCandidateIds.includes(candidateId))) setActiveCandidateId(candidateId);
    setStepMenu({ id: candidateId, x, y });
  }

  /** For all the views: a card, a row or a thumbnail, or in the gallery the large screenshot and what is beside it. */
  function handleStepContextMenu(event: React.MouseEvent<HTMLElement>) {
    const target = event.target instanceof Element ? event.target : null;
    const own = target?.closest('[data-step-id], [id^="candidate-"]');
    if (!target || !own || (shouldIgnoreContextMenu(target) && !target.closest('input[type="checkbox"]'))) return;
    if (pressedTextRef.current) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges(); // the word the click selected
    openStepMenu(own.getAttribute('data-step-id') ?? own.id.slice('candidate-'.length), event.clientX, event.clientY);
  }

  /** The accepted steps from one to another, in a phase or ('') in none; `null` asks for the name of a new one. */
  async function setPhaseOfSteps(first: CandidateFrame, last: CandidateFrame, name: string) {
    if (!selectedRun) return;
    await setRunPhase(selectedRun.summary.id, { name, first_step: first.id, last_step: last.id });
    await Promise.all(
      [['run', selectedRun.summary.id], ['pathway', selectedRun.summary.id], ['recording', selectedRun.summary.recording_id]].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  }

  function stepMenuContext(step: CandidateFrame, at: { x: number; y: number }): Omit<StepMenuContext, 'returns'> {
    const steps = selectedRun?.candidates ?? [];
    const selected = new Set(selectedShownCandidateIds);
    return {
      step,
      selected: steps.filter((each) => selected.has(each.id)),
      steps,
      view: stepLayout.view,
      annotating: expandedAnnotationCandidateId === step.id,
      anchor: selectionAnchorRef.current,
      phases: [...new Set((selectedRun?.phases ?? []).map((boundary) => boundary.name).filter(Boolean))],
      phaseAt: (ms) => phaseAt(selectedRun?.phases, ms),
      numberOf: (candidate) => stepNumbers.get(candidate.id) ?? candidateNumber(candidate.detector_index),
      similar: candidateSimilarityLinks.get(step.id),
      back: backLinks.get(step.id),
      thumbOf: (imageUrl) => screenshotUrl(imageUrl, 34),
      isPopup: isPopupStep,
      popupChange,
      actions: {
        setStatus: handleCandidateStatusChange,
        setStatusOfSelected: (status) => void handleBulkCandidateStatusChange(status),
        update: onUpdateCandidate,
        updateSeveral: (changes) => void handleUpdateSelectedCandidates(changes),
        setPhase: (first, last, name) => {
          if (name === null) setPhaseNaming({ first, last, ...at });
          else {
            void setPhaseOfSteps(first, last, name).catch((error: unknown) =>
              setPhaseNaming({ first, last, ...at, problem: error instanceof Error ? error.message.toLocaleLowerCase() : 'could not save the phase.' }),
            );
          }
        },
        playFromHere: handlePlayFromHere,
        openScreenshot: (candidate) => window.open(screenshotUrl(candidate.image_url), '_blank', 'noopener'),
        annotate: (candidate) => {
          if (stepLayout.view === 'grid') handleToggleCandidateAnnotation(candidate.id);
          else {
            const field = stepLayout.view === 'list' ? `#candidate-${CSS.escape(candidate.id)} .candidate-row-title input` : '.candidate-gallery-title-field';
            window.setTimeout(() => document.querySelector<HTMLElement>(field)?.focus(), 0);
          }
        },
        jumpTo: (targetId) => activateCandidate(targetId.slice('candidate-'.length), { reveal: true }),
        toggleSelection: toggleCandidateSelection,
        invertSelection: () => setSelectedCandidateIds(invertSelection(selectedCandidateIds, shownCandidateIds)),
        clearSelection: () => {
          selectionAnchorRef.current = null;
          setSelectedCandidateIds([]);
        },
      },
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

  /** Compare two finished runs of a recording: the newest, and the earlier one with the most review. */
  function handleCompareRuns(recordingId: string) {
    const runs = analysisTaskItems.filter((item) => item.recording.id === recordingId).map((item) => item.run);
    const pair = defaultComparisonPair(runs);
    if (!pair) return;
    setComparison({ recordingId, ...pair });
    track({ kind: 'comparison_opened' });
    window.setTimeout(() => jumpToAnchor('analysis-run-compare'), 0);
  }

  function leaveComparisonFor(runId: string) {
    const recordingId = comparison?.recordingId;
    setComparison(null);
    if (recordingId) handleReviewTaskOutputs(recordingId, runId);
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
              onSave={(nextValue, previousValue) => onRenameProject(activeProject.id, nextValue, previousValue)}
              renameLabel={`rename project ${activeProject.name}`}
              textClassName="analysis-pill-project-text"
              value={activeProject.name}
            />
          )}
          <span aria-live="polite" className="analysis-live-status" role="status" title={liveMessage || undefined}>
            {liveMessage}
          </span>
        </div>

        {(healthMessage || ocrProblem || appError || settingsFeedback || analysisActionMessage) && (
          <div aria-atomic="true" aria-live="polite" className="analysis-notices" role="status">
            {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
            {ocrProblem && <p className="entry-notice warning">{ocrProblem}</p>}
            {appError && <p className="entry-notice error">{appError}</p>}
            {settingsFeedback && <p className="entry-notice">{settingsFeedback}</p>}
            {analysisActionMessage && <p className="entry-notice">{analysisActionMessage}</p>}
          </div>
        )}

        {/* Selecting tasks needs a wider toolbar: the tasks column then takes more room and the others give way. */}
        <div className={`analysis-grid ${taskSelectMode ? 'tasks-widened' : ''}`}>
          <AnalysisVideosPanel
            onDeleteRecording={onDeleteRecording}
            onCancelUpload={onCancelUpload}
            onFilesDropped={onDropFiles}
            onPreviewRecording={onPreviewRecording}
            onRenameRecording={onRenameRecording}
            onRequestRename={handleRequestVideoRename}
            onSelectRecording={onSelectRecording}
            previewRecording={previewRecording}
            projectId={activeProject?.id ?? null}
            recordings={recordings}
            recordingsLoading={recordingsLoading}
            selectedRecordingId={selectedRecordingId}
            uploads={uploads}
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
            onApplyImportedPreset={handleApplyImportedPreset}
            onCopyPresetText={() => {
              void handleCopyPresetText();
            }}
            onResetToProjectDefaults={onResetToProjectDefaults}
            onResetToUniversalDefaults={onResetToUniversalDefaults}
            onRestoreFactorySettings={onRestoreFactorySettings}
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
            {...taskActions}
            analysisTaskItems={analysisTaskItems}
            busyRunIds={runsBusyElsewhere}
            analysisMetadata={analysisMetadata}
            bulkDeletePending={bulkDeletePending}
            bulkExportPending={bulkExportPending}
            duplicateRunPending={duplicateRunPending}
            expandedTaskRunId={expandedTaskRunId}
            videoListFocus={videoListFocus}
            groupedTaskItems={groupedTaskItems}
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

        {comparison ? (
          (() => {
            const items = analysisTaskItems.filter((item) => item.recording.id === comparison.recordingId);
            const recording = items[0]?.recording;
            return recording ? (
              <RunComparison
                analysisMetadata={analysisMetadata}
                busyRunIds={runsBusyElsewhere}
                carryOverPending={carryOverPending}
                key={comparison.recordingId}
                leftRunId={comparison.left}
                onCarryOver={(source, target, pairs) =>
                  void onCarryOverReview(source, target, pairs).then((done) => done && leaveComparisonFor(target))
                }
                onChangeRuns={(left, right) => setComparison({ ...comparison, left, right })}
                onClose={() => setComparison(null)}
                onReview={leaveComparisonFor}
                recording={recording}
                rightRunId={comparison.right}
                runs={items.map((item) => item.run)}
              />
            ) : null;
          })()
        ) : selectedRun ? (
          <section className="analysis-detail-section stack-gap" id="analysis-run-detail">
            {/* One title row: the file name on the left, when it ran and its logs on the right. Its settings are in the
                tasks list (details), so they are not repeated here. */}
            <div className="analysis-detail-header">
              <div className="analysis-detail-copy">
                <div className="run-title-row">
                  <h2>{selectedRecordingSummary?.filename ?? selectedRun.summary.recording_id}</h2>
                  {!isCompletedReview ? (
                    <span className={`status-pill ${selectedRun.summary.status}`}>
                      {selectedRun.summary.status.replace('_', ' ')}
                    </span>
                  ) : null}
                </div>
                {!isCompletedReview && selectedRun.summary.message ? (
                  <p className="muted">{selectedRun.summary.message}</p>
                ) : null}
              </div>
              <div className="analysis-detail-side">
                <p className="analysis-detail-meta">{formatRunTiming(selectedRun.summary)}</p>
                {selectedRun.summary.is_abortable ? (
                  <button
                    className="analysis-task-link danger"
                    disabled={abortRunPending}
                    onClick={() => onAbortRun(selectedRun.summary.id)}
                    type="button"
                  >
                    end
                  </button>
                ) : null}
              </div>
            </div>

            {selectedRunBusy.length ? (
              <div className="live-banner" role="status">
                <span className="live-banner-label">busy</span>
                <span>
                  another browser is {selectedRunBusy.map((entry) => entry.label).join(' and ')}. it updates here as soon as that
                  is done.
                </span>
              </div>
            ) : null}

            {!isCompletedReview ? (
              <div className="analysis-task-bar" aria-hidden="true">
                <div className="analysis-task-bar-fill" style={{ width: formatPercent(selectedRun.summary.progress) }} />
              </div>
            ) : null}

            {canReviewCandidates && isCompletedReview ? (
              <div className="review-mode-bar">
                <div aria-label="what to review" className="review-mode-switch" role="tablist">
                  {(['steps', 'pathway'] as const).map((mode) => (
                    <button
                      aria-selected={reviewMode === mode}
                      className={`candidate-filter-tab ${reviewMode === mode ? 'active' : ''}`}
                      key={mode}
                      onClick={() => {
                        if (mode !== reviewMode) track({ kind: 'page', name: mode === 'pathway' ? 'pathway' : 'review' });
                        setReviewMode(mode);
                      }}
                      role="tab"
                      title={
                        mode === 'steps'
                          ? 'review the steps: accept, reject, title and annotate them'
                          : 'the accepted steps as a chart of screens and the moves between them'
                      }
                      type="button"
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <div className="review-mode-side">
                  <RunTextControl
                    available={ocrAvailable}
                    onQueryChange={setTextQuery}
                    onRead={() => onReadText(selectedRun.summary.id)}
                    onStop={() => onStopReadingText(selectedRun.summary.id)}
                    pending={textPending}
                    query={reviewMode === 'steps' ? textQuery : null}
                    text={selectedRun.summary.text}
                    total={selectedRun.candidates.length}
                  />
                  {/* Export sits right-aligned under the run finish time, reachable from both steps and pathway views. */}
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
                        <div className="candidate-export-name-stack">
                          <label className="candidate-export-name-wrap">
                            <span className="sr-only">export zip name</span>
                            <input
                              aria-label="export zip name"
                              className="candidate-export-name-field"
                              onChange={(event) => setExportNameDraft(event.target.value)}
                              placeholder="file name (optional)"
                              value={exportNameDraft}
                            />
                            <span className="candidate-export-name-suffix">.zip</span>
                          </label>
                          <span className="candidate-export-name-preview">
                            {resolvedExportFilenamePreview
                              ? `→ ${resolvedExportFilenamePreview}`
                              : '→ named by the server'}
                          </span>
                        </div>
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
                        {selectedRun.summary.text.waiting > 0 ? (
                          <span className="analysis-export-status">
                            text is still being read: {selectedRun.summary.text.waiting} to go
                          </span>
                        ) : selectedRun.summary.text.earlier > 0 ? (
                          <span className="analysis-export-status" title={EARLIER_TEXT}>
                            text read by an earlier version
                          </span>
                        ) : null}
                        {selectedRunExportLabel ? (
                          <span className="analysis-export-status">{selectedRunExportLabel}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {showPathway ? (
              <PathwayPanel
                onOpenAbout={onOpenAbout}
                onUpdateCandidate={onUpdateCandidate}
                projectName={activeProject?.name ?? ''}
                recording={selectedRecordingSummary}
                run={selectedRun}
              />
            ) : null}

            {canReviewCandidates && !showPathway ? (
              <StepNumbersProvider numbers={stepNumbers}>
                {selectedRun.accepted_steps.length > 0 && (
                  <div
                    className={`accepted-strip-shell ${stepLayout.hideAccepted ? 'collapsed' : ''}`}
                    id="analysis-accepted-steps"
                  >
                    <button
                      aria-controls="analysis-accepted-strip"
                      aria-expanded={!stepLayout.hideAccepted}
                      className="accepted-strip-toggle"
                      onClick={() => setStepLayout((current) => ({ ...current, hideAccepted: !current.hideAccepted }))}
                      title={stepLayout.hideAccepted ? 'show the accepted steps' : 'hide the accepted steps'}
                      type="button"
                    >
                      <span aria-hidden="true" className="analysis-task-group-chevron" />
                      <span className="accepted-strip-title">accepted steps</span>
                      <small>{selectedRun.accepted_steps.length}</small>
                    </button>
                    <div
                      className={`accepted-strip ${acceptedStripPanning ? 'is-panning' : ''}`}
                      hidden={stepLayout.hideAccepted}
                      id="analysis-accepted-strip"
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        if (event.target instanceof Element && event.target.closest('button')) return;
                        const strip = event.currentTarget;
                        if (strip.scrollWidth <= strip.clientWidth) return;
                        acceptedStripDragRef.current = {
                          startX: event.clientX,
                          startScroll: strip.scrollLeft,
                          moved: false,
                        };
                      }}
                      onPointerMove={(event) => {
                        const drag = acceptedStripDragRef.current;
                        if (!drag) return;
                        const dx = event.clientX - drag.startX;
                        if (!drag.moved && Math.abs(dx) < 5) return;
                        if (!drag.moved) {
                          drag.moved = true;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setAcceptedStripPanning(true);
                        }
                        event.currentTarget.scrollLeft = drag.startScroll - dx;
                      }}
                      onPointerUp={(event) => {
                        const drag = acceptedStripDragRef.current;
                        if (!drag) return;
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        }
                        if (drag.moved) {
                          // Swallow the trailing click caused by pointer release after panning.
                          window.setTimeout(() => {
                            acceptedStripDragRef.current = null;
                          }, 0);
                        } else {
                          acceptedStripDragRef.current = null;
                        }
                        setAcceptedStripPanning(false);
                      }}
                      onPointerCancel={() => {
                        acceptedStripDragRef.current = null;
                        setAcceptedStripPanning(false);
                      }}
                    >
                      {selectedRun.accepted_steps.map((step) => {
                        const similarityLink = acceptedStepSimilarityLinks.get(step.step_id);
                        return (
                          <div
                            className={`accepted-step-chip ${hoveredCandidateId === step.source_candidate_id ? 'is-cross-hovered' : ''}`}
                            id={`accepted-step-${step.step_id}`}
                            key={step.step_id}
                            onClick={() => {
                              if (acceptedStripDragRef.current?.moved) return;
                              activateCandidate(step.source_candidate_id, { reveal: true });
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                activateCandidate(step.source_candidate_id, { reveal: true });
                              }
                            }}
                            onMouseEnter={() => setHoveredCandidateId(step.source_candidate_id)}
                            onMouseLeave={() => setHoveredCandidateId((id) => (id === step.source_candidate_id ? null : id))}
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
                      <div
                        aria-label="candidate timeline: hover to preview steps, click or drag to scrub"
                        className={`candidate-timeline-rail ${timelineScrub?.dragging ? 'is-scrubbing' : ''}`}
                        onPointerCancel={handleTimelinePointerUp}
                        onPointerDown={handleTimelinePointerDown}
                        onPointerLeave={handleTimelinePointerLeave}
                        onPointerMove={handleTimelinePointerMove}
                        onPointerUp={handleTimelinePointerUp}
                      >
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
                      {timelineScrub ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="candidate-timeline-hover-line"
                            style={{ left: `${timelineScrub.pct}%` }}
                          />
                          <div
                            aria-hidden="true"
                            className="candidate-timeline-preview"
                            style={{ left: `${Math.min(92, Math.max(8, timelineScrub.pct))}%` }}
                          >
                            {timelineScrub.candidate ? (
                              <>
                                <img
                                  alt=""
                                  className="candidate-timeline-preview-thumb"
                                  src={screenshotUrl(timelineScrub.candidate.image_url, 78)}
                                />
                                <div className="candidate-timeline-preview-meta">
                                  <span className="candidate-timeline-preview-head">
                                    <span className={`candidate-timeline-preview-dot ${timelineScrub.candidate.status}`} />
                                    <strong>
                                      {timelineScrub.candidate.candidate_origin === 'manual' ? 'manual ' : ''}
                                      {stepNumbers.get(timelineScrub.candidate.id)?.name ?? 'step'}
                                    </strong>
                                    <small>{timelineScrub.candidate.timestamp_tc}</small>
                                  </span>
                                  {timelineScrub.candidate.title ? (
                                    <span className="candidate-timeline-preview-title">
                                      {timelineScrub.candidate.title}
                                    </span>
                                  ) : null}
                                </div>
                              </>
                            ) : (
                              <span className="candidate-timeline-preview-time">
                                {formatPlaybackTimestamp(timelineScrub.ms)}
                              </span>
                            )}
                          </div>
                        </>
                      ) : null}
                      {timelineCandidates.map((candidate) => {
                        const tooltip = `${candidate.candidate_origin === 'manual' ? 'manual ' : ''}${stepNumbers.get(candidate.id)?.name ?? 'step'} • ${candidate.timestamp_tc} • ${candidate.status}`;
                        const pinPct = Math.min(
                          100,
                          Math.max(
                            0,
                            (candidate.timestamp_ms / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100,
                          ),
                        );
                        return (
                          <button
                            aria-label={tooltip}
                            className={`candidate-timeline-pin ${candidate.status} ${activeCandidateId === candidate.id ? 'active' : ''} ${hoveredCandidateId === candidate.id ? 'is-hovered' : ''}`}
                            data-tooltip={tooltip}
                            key={candidate.id}
                            onClick={() => activateCandidate(candidate.id, { reveal: true, seekPreview: true })}
                            onMouseEnter={() => {
                              setHoveredCandidateId(candidate.id);
                              setTimelineScrub((current) =>
                                current?.dragging ? current : { pct: pinPct, ms: candidate.timestamp_ms, candidate, dragging: false },
                              );
                            }}
                            style={{ left: `${pinPct}%` }}
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

                <div
                  className={`candidate-review-toolbar ${selectedShownCandidateIds.length > 0 ? 'has-selection' : ''}`}
                  id="analysis-review-toolbar"
                  ref={stepAreaRef}
                >
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
                    {canReviewCandidates && (
                      <span
                        aria-label="keyboard shortcuts: a to accept, r to reject, u to reset to undecided, x to select (shift+x for a range), p to play from the step, arrow keys to step, shift+F10 for a menu of every action"
                        className="candidate-review-key-hint"
                        title="right-click a step for a menu of every action, or one of several selected steps for all of them"
                      >
                        <span><span className="candidate-key-badge">a</span> accept</span>
                        <span><span className="candidate-key-badge">r</span> reject</span>
                        <span><span className="candidate-key-badge">u</span> reset</span>
                        <span><span className="candidate-key-badge">x</span> select</span>
                        <span><span className="candidate-key-badge">p</span> play</span>
                        <span><span className="candidate-key-badge">← →</span> step</span>
                      </span>
                    )}
                    {canReviewCandidates && filteredCandidates.length > 0 ? (
                      // Two groups: which steps (of the ones shown), and what to do with them.
                      <div className="candidate-bulk-actions">
                        <div aria-label="select steps" className="candidate-bulk-group" role="group">
                          <span
                            className="candidate-bulk-count"
                            title="shift-click a step's box, drag across checkboxes, or press shift+x to select a range"
                          >
                            select
                          </span>
                          <button
                            className="analysis-task-link subtle"
                            disabled={shownSelectionState === 'all'}
                            onClick={() => setSelectedCandidateIds(shownCandidateIds)}
                            title="every step shown"
                            type="button"
                          >
                            all
                          </button>
                          <button
                            className="analysis-task-link subtle"
                            disabled={shownSelectionState === 'none'}
                            onClick={() => {
                              selectionAnchorRef.current = null;
                              setSelectedCandidateIds([]);
                            }}
                            type="button"
                          >
                            none
                          </button>
                          <button
                            className="analysis-task-link subtle"
                            onClick={() => setSelectedCandidateIds((current) => invertSelection(current, shownCandidateIds))}
                            title="the steps shown that are not selected, instead of the ones that are"
                            type="button"
                          >
                            invert
                          </button>
                        </div>
                        {selectedShownCandidateIds.length > 0 ? (
                          <div aria-label="act on the selected steps" className="candidate-bulk-group" role="group">
                            <span className="candidate-bulk-count">
                              {selectedShownCandidateIds.length} of {shownCandidateIds.length} selected
                            </span>
                            <button
                              className="candidate-bulk-decision accepted"
                              disabled={bulkCandidatePending}
                              onClick={() => void handleBulkCandidateStatusChange('accepted')}
                              type="button"
                            >
                              <span aria-hidden="true" className="candidate-bulk-decision-dot">
                                <DecisionIcon intent="accepted" />
                              </span>
                              accept
                            </button>
                            <button
                              className="candidate-bulk-decision rejected"
                              disabled={bulkCandidatePending}
                              onClick={() => void handleBulkCandidateStatusChange('rejected')}
                              type="button"
                            >
                              <span aria-hidden="true" className="candidate-bulk-decision-dot">
                                <DecisionIcon intent="rejected" />
                              </span>
                              reject
                            </button>
                            <button
                              className="candidate-bulk-decision pending"
                              disabled={bulkCandidatePending}
                              onClick={() => void handleBulkCandidateStatusChange('pending')}
                              title="back to undecided"
                              type="button"
                            >
                              <span aria-hidden="true" className="candidate-bulk-decision-dot">
                                <DecisionIcon intent="pending" />
                              </span>
                              reset
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="candidate-view-controls">
                    <div aria-label="step layout" className="candidate-view-switch" role="group">
                      {(['grid', 'list', 'gallery'] as const).map((view) => (
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
                    <div className="candidate-size-control">
                      <label className="candidate-size-slider" title="image size">
                        <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                          <rect height="6" rx="1" width="6" x="4" y="4" />
                        </svg>
                        <input
                          aria-label="step image size"
                          max={STEP_SIZE_MAX}
                          min={STEP_SIZE_MIN}
                          onChange={(event) => setStepLayout((current) => ({ ...current, size: Number(event.target.value) }))}
                          step={10}
                          style={rangeFillStyle(stepSliderValue, STEP_SIZE_MIN, STEP_SIZE_MAX)}
                          type="range"
                          value={stepSliderValue}
                        />
                        <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 14 14" width="14">
                          <rect height="12" rx="1" width="12" x="1" y="1" />
                        </svg>
                      </label>
                      <button
                        aria-pressed={stepLayout.size === null}
                        className={`candidate-filter-tab ${stepLayout.size === null ? 'active' : ''}`}
                        onClick={() => setStepLayout((current) => ({ ...current, size: null }))}
                        title="size the images to fill the width of the page"
                        type="button"
                      >
                        fit
                      </button>
                    </div>
                  </div>
                </div>

                {stepsFound ? (
                  <div className="candidate-view-bar">
                    <span className="candidate-view-note">
                      {foundCandidates.length === 0 ? 'no step' : foundCandidates.length} of {labelVisibleCandidates.length}{' '}
                      {labelVisibleCandidates.length === 1 ? 'step' : 'steps'} with “{textQuery.trim()}” on the screen{' '}
                      <button className="analysis-task-link subtle" onClick={() => setTextQuery('')} type="button">
                        show all
                      </button>
                    </span>
                  </div>
                ) : null}

                {labelHiddenCount > 0 ? (
                  <div className="candidate-view-bar">
                    <span className="candidate-view-note">
                      {labelHiddenCount} {labelHiddenCount === 1 ? 'step' : 'steps'} hidden by label{' · '}
                      <button
                        className="analysis-task-link subtle"
                        onClick={() => setHiddenSegmentTypes(new Set())}
                        type="button"
                      >
                        show all
                      </button>
                    </span>
                  </div>
                ) : null}

                {filteredCandidates.length && stepLayout.view === 'gallery' ? (
                  <CandidateGallery
                    activeCandidateId={activeCandidateId}
                    allSteps={selectedRun.candidates}
                    onContextMenu={handleStepContextMenu}
                    backLinks={backLinks}
                    aspect={stepAspect}
                    candidates={filteredCandidates}
                    durationMs={selectedRecordingSummary?.duration_ms}
                    hoverFor={stepHover}
                    hoveredCandidateId={hoveredCandidateId}
                    onActivate={(candidateId) => setActiveCandidateId(candidateId)}
                    onHoverChange={setHoveredCandidateId}
                    onJumpToSimilar={(targetId) => {
                      if (targetId.startsWith('candidate-')) {
                        activateCandidate(targetId.slice('candidate-'.length), { reveal: true });
                      } else {
                        jumpToAnchor(targetId);
                      }
                    }}
                    onPaintEnter={(candidateId) => continuePaintSelect(candidateId)}
                    onPaintStart={(candidateId, currentlySelected) => startPaintSelect(candidateId, currentlySelected)}
                    onSetStatus={handleCandidateStatusChange}
                    onStep={handleStepCandidate}
                    onToggleSelection={(candidateId, shift) => toggleCandidateSelection(candidateId, shift)}
                    onUpdate={(candidateId, payload) => onUpdateCandidate(candidateId, payload)}
                    phases={{ runId: selectedRun.summary.id, boundaries: selectedRun.phases }}
                    selectedCandidateIds={selectedShownCandidateIds}
                    similarityLinks={candidateSimilarityLinks}
                    sizing={gallerySizing}
                  />
                ) : filteredCandidates.length && stepLayout.view === 'list' ? (
                  <div
                    aria-label="steps"
                    className="candidate-list"
                    id="analysis-candidate-review"
                    onContextMenu={handleStepContextMenu}
                    role="table"
                    style={{ '--candidate-thumb-width': `${stepThumb.width}px` } as CSSProperties}
                  >
                    <div className="candidate-row candidate-row-head" role="row">
                      <span className="candidate-row-select" role="columnheader">
                        <input
                          aria-label={shownSelectionState === 'all' ? 'select none of the steps shown' : 'select every step shown'}
                          checked={shownSelectionState === 'all'}
                          onChange={() => {
                            if (shownSelectionState === 'all') selectionAnchorRef.current = null;
                            setSelectedCandidateIds(shownSelectionState === 'all' ? [] : shownCandidateIds);
                          }}
                          ref={(box) => {
                            if (box) box.indeterminate = shownSelectionState === 'some';
                          }}
                          type="checkbox"
                        />
                      </span>
                      <span className="candidate-row-thumb" role="columnheader">
                        <span className="sr-only">screenshot</span>
                      </span>
                      <span className="candidate-row-step" role="columnheader">step</span>
                      <span className="candidate-row-label" role="columnheader">label, screen</span>
                      <span className="candidate-row-duration" role="columnheader">on screen</span>
                      <span className="candidate-row-title" role="columnheader">title</span>
                      <span className="candidate-row-notes" role="columnheader">notes</span>
                      <span className="candidate-row-actions" role="columnheader">
                        <span className="sr-only">decision</span>
                      </span>
                    </div>
                    {withPhaseHeaders(filteredCandidates, selectedRun.phases, (candidate) => {
                      return (
                        <ReviewRow
                          actions={stepActions}
                          candidate={candidate}
                          hoverState={hoverClips.hover?.id === candidate.id ? hoverClips.hover.state : null}
                          isActive={activeCandidateId === candidate.id}
                          isCrossHovered={hoveredCandidateId === candidate.id}
                          isSelected={selectedShown.has(candidate.id)}
                          key={candidate.id}
                          phases={stepPhases}
                          backLink={backLinks.get(candidate.id)}
                          similarLink={candidateSimilarityLinks.get(candidate.id)}
                          steps={selectedRun.candidates}
                          thumbHeight={stepThumb.height}
                          thumbWidth={stepThumb.width}
                        />
                      );
                    }, { list: true, allSteps: stepsToCount, durationMs: selectedRecordingSummary?.duration_ms })}
                  </div>
                ) : filteredCandidates.length ? (
                  <div
                    className={`candidate-grid sized ${fittedStepGrid ? 'fitted' : ''} ${filteredCandidates.length < 3 ? 'sparse' : ''}`}
                    id="analysis-candidate-review"
                    onContextMenu={handleStepContextMenu}
                    style={
                      fittedStepGrid
                        ? ({ '--candidate-columns': fittedStepGrid.columns } as CSSProperties)
                        : ({ '--candidate-card-width': `${stepCardWidth}px` } as CSSProperties)
                    }
                  >
                    {withPhaseHeaders(filteredCandidates, selectedRun.phases, (candidate) => {
                      return (
                        <ReviewCard
                          actions={stepActions}
                          candidate={candidate}
                          compact={stepCardWidth < 190}
                          hoverState={hoverClips.hover?.id === candidate.id ? hoverClips.hover.state : null}
                          imageWidth={stepCardWidth}
                          isActive={activeCandidateId === candidate.id}
                          isAnnotationExpanded={expandedAnnotationCandidateId === candidate.id}
                          isCrossHovered={hoveredCandidateId === candidate.id}
                          isSelected={selectedShown.has(candidate.id)}
                          key={candidate.id}
                          phases={stepPhases}
                          recordingHeight={selectedRecordingSummary?.height}
                          recordingWidth={selectedRecordingSummary?.width}
                          backLink={backLinks.get(candidate.id)}
                          similarLink={candidateSimilarityLinks.get(candidate.id)}
                          steps={selectedRun.candidates}
                        />
                      );
                    }, { list: false, allSteps: stepsToCount, durationMs: selectedRecordingSummary?.duration_ms })}
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
                {(() => {
                  const step = stepMenu ? selectedRun.candidates.find((candidate) => candidate.id === stepMenu.id) : undefined;
                  if (!stepMenu || !step) return null;
                  return <StepMenu context={stepMenuContext(step, stepMenu)} onClose={closeStepMenu} run={selectedRun} x={stepMenu.x} y={stepMenu.y} />;
                })()}
                {phaseNaming ? (
                  <PhaseNamePopover
                    label={
                      phaseNaming.first.id === phaseNaming.last.id
                        ? stepNumbers.get(phaseNaming.first.id)?.name ?? 'this step'
                        : `from ${stepNumbers.get(phaseNaming.first.id)?.name ?? 'step'} to ${stepNumbers.get(phaseNaming.last.id)?.name ?? 'step'}`
                    }
                    onClose={closePhaseNaming}
                    onSave={(name) => setPhaseOfSteps(phaseNaming.first, phaseNaming.last, name)}
                    problem={phaseNaming.problem}
                    x={phaseNaming.x}
                    y={phaseNaming.y}
                  />
                ) : null}
              </StepNumbersProvider>
            ) : null}
          </section>
        ) : selectedRecording ? (
          <section className="analysis-detail-section empty-state">
            <h2>{selectedRecording.filename}</h2>
            {selectedRunId && selectedRunLoading ? <p>loading task details…</p> : null}
            {!selectedRunId && !selectedRunLoading && (
              <p>select a video or a run to review steps and exports here.</p>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
