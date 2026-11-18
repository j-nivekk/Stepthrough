import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  abortRun,
  ApiError,
  apiSocketUrl,
  createManualCandidate,
  createManualRun,
  createProject,
  createRun,
  deleteProject,
  deleteRecording,
  deleteRun,
  exportRun,
  getAnalysisMetadata,
  getProject,
  getRecording,
  getRun,
  getSavedRunSettings,
  health,
  importRecording,
  isAbortError,
  listProjects,
  logOut,
  recheckOcr,
  resetDatabase,
  saveRunSettings,
  forgetRunSettings,
  carryOverReview,
  setCandidateStatuses,
  updateCandidate,
  updateProject,
  updateRecording,
} from './api';
import { AppSettings } from './components/AppSettings';
import { AppWatermark, type CornerPanel } from './components/AppWatermark';
import { useConfirm } from './components/ConfirmDialog';
import { AccountPanel } from './features/account/AccountPanel';
import { UsersScreen } from './features/account/UsersScreen';
import { PerformanceMonitor } from './components/PerformanceMonitor';
import { ViewportWarning } from './components/ViewportWarning';
import { AnalysisScreen } from './features/analysis/AnalysisScreen';
import { useLive } from './features/live/LiveProvider';
import { ImportScreen } from './features/import/ImportScreen';
import { EntryScreen } from './features/projects/EntryScreen';
import {
  activeRunStatuses,
  getAnalysisTaskStatusRank,
  type AnalysisTaskItem,
  type SimilarLink,
} from './lib/analysis';
import { downloadExportBundle, jumpToAnchor, sleep } from './lib/utils';
import { formatCalendarDate } from './lib/formatters';
import {
  collectImportQueueItems,
  getUploadedImportItems,
  importsInFlight,
  markImportUploaded,
  nextImportUpload,
  syncImportQueueWithRecordings,
  type ImportQueueItem,
} from './lib/importQueue';
import { loadAppPreferences, saveAppPreferences, type AppPreferences } from './lib/appPreferences';
import {
  areRunSettingsEqual,
  defaultRunSettings,
  enforceLocalOcrAvailability,
  findSavedRunSettings,
  forgetBrowserRunPresets,
  parseRunPresetText,
  readBrowserRunPresets,
  sanitizeRunSettings,
  serializeRunPresetText,
} from './lib/runSettings';
import { workflowViewportMinimums, type ProjectEntryTarget, type WorkflowStage } from './lib/workflow';
import { track } from './lib/usage';
import type {
  AnalysisMetadata,
  CandidateChanges,
  CandidateFrame,
  CandidateStatus,
  ExportMode,
  HealthResponse,
  Project,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunSettings,
  RunSummary,
  SavedRunSettings,
  SessionInfo,
} from './types';

type PendingTaskNavigation = {
  anchorId: 'analysis-candidate-review' | 'analysis-run-detail';
  runId: string;
};

const SAVED_RUN_SETTINGS_KEY = ['saved-run-settings'];

// Logged-in people are reminded this many days before their account is deleted.
const DELETION_NOTICE_DAYS = 30;

function deletionNotice(deleteAfter: string | null | undefined): string | null {
  if (!deleteAfter) return null;
  const daysLeft = (new Date(`${deleteAfter}T00:00:00`).getTime() - Date.now()) / 86_400_000;
  if (daysLeft > DELETION_NOTICE_DAYS) return null;
  return `your account and the projects only it owns are deleted on ${formatCalendarDate(deleteAfter)}. export what you want to keep before then.`;
}

export interface AppProps {
  /** Who is logged in and how this server recognises people; null if the backend did not answer. */
  session: SessionInfo | null;
  /** Called after logging out, with the new (logged-out) session. */
  onSessionChange: (session: SessionInfo) => void;
}

function App({ session, onSessionChange }: AppProps) {
  const queryClient = useQueryClient();
  const [projectName, setProjectName] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [projectSort, setProjectSort] = useState<'name' | 'recent'>('recent');
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>('projects');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [pendingAnalysisProjectId, setPendingAnalysisProjectId] = useState<string | null>(null);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [pendingTaskNavigation, setPendingTaskNavigation] = useState<PendingTaskNavigation | null>(null);
  const [runSettings, setRunSettingsState] = useState<RunSettings>(defaultRunSettings);
  const [settingsFeedback, setSettingsFeedback] = useState('');
  const [importQueue, setImportQueue] = useState<ImportQueueItem[]>([]);
  // Asking before acting happens in the page: some embedded browsers block window.confirm.
  const { confirm, dialog: confirmDialog } = useConfirm();
  /** The upload under way, by row, so that it can be cancelled. */
  const uploadControllers = useRef(new Map<string, AbortController>());
  // An upload can take minutes: when it ends, it needs the selection as it is then, not as it was at its start.
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedRecordingIdRef = useRef(selectedRecordingId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    selectedRecordingIdRef.current = selectedRecordingId;
  }, [selectedProjectId, selectedRecordingId]);
  const [importSelectionFeedback, setImportSelectionFeedback] = useState('');
  const [previewRecordingId, setPreviewRecordingId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [analysisActionMessage, setAnalysisActionMessage] = useState('');
  const [appError, setAppError] = useState('');
  const [dismissedOcrWarningsKey, setDismissedOcrWarningsKey] = useState<string | null>(null);
  const [bulkDeletePending, setBulkDeletePending] = useState(false);
  const [bulkExportPending, setBulkExportPending] = useState(false);
  const [appPrefs, setAppPrefs] = useState<AppPreferences>(() => loadAppPreferences());
  // The account, settings and about panels share the bottom-right corner: one at a time.
  const [cornerPanel, setCornerPanel] = useState<CornerPanel | null>(null);
  const closeCornerPanel = (panel: CornerPanel) =>
    setCornerPanel((current) => (current === panel ? null : current));
  const [showUsers, setShowUsers] = useState(false);
  // For the usage report: which page is open (lib/usage.ts sends nothing where usage is not recorded).
  useEffect(() => {
    if (!showUsers) track({ kind: 'page', name: workflowStage });
  }, [showUsers, workflowStage]);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const sessionUser = session?.user ?? null;
  // With password logins, who is logged in shows next to settings; the desktop app has one built-in user.
  const accountUser = session?.mode === 'password' ? sessionUser : null;
  const isAdmin = sessionUser?.is_admin ?? true;
  const isShared = Boolean(accountUser && !accountUser.is_admin && accountUser.tags.includes('shared'));
  const [viewportSize, setViewportSize] = useState(() => ({
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
  }));

  const healthQuery = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: health,
    retry: false,
    refetchInterval: (query) => {
      const current = query.state.data;
      return !current || current.ocr_status === 'checking' ? 1_500 : 30_000;
    },
  });
  const backendReady = healthQuery.isSuccess;
  const analysisMetadataQuery = useQuery<AnalysisMetadata>({
    queryKey: ['analysis-metadata'],
    queryFn: getAnalysisMetadata,
    enabled: backendReady,
    staleTime: Infinity,
  });
  const analysisMetadata = analysisMetadataQuery.data ?? null;
  // Settings saved to start new runs from. They are kept with the account, so they follow it to any computer.
  const savedRunSettingsQuery = useQuery<SavedRunSettings[]>({
    queryKey: SAVED_RUN_SETTINGS_KEY,
    queryFn: getSavedRunSettings,
    enabled: backendReady,
  });
  const savedRunSettings = savedRunSettingsQuery.data;
  const savedRunSettingsLoaded = savedRunSettings !== undefined;
  const universalDefaultSettings = useMemo(
    () => findSavedRunSettings(savedRunSettings ?? [], null) ?? defaultRunSettings,
    [savedRunSettings],
  );
  const projectDefaultSettings = useMemo(
    () =>
      (selectedProjectId ? findSavedRunSettings(savedRunSettings ?? [], selectedProjectId) : null) ??
      universalDefaultSettings,
    [savedRunSettings, selectedProjectId, universalDefaultSettings],
  );
  const ocrStatus = healthQuery.data?.ocr_status ?? null;
  const ocrAvailability = healthQuery.data?.ocr_available;
  const ocrStatusMessage = backendReady ? healthQuery.data?.ocr_message ?? null : null;
  const ocrWarnings = healthQuery.data?.ocr_warnings ?? [];
  const ocrWarningsKey = ocrWarnings.join('\n');
  // OCR's diagnostics are about the server's set-up, so only administrators (who can act on them) see them.
  const visibleOcrWarnings =
    !isAdmin || (ocrWarningsKey && dismissedOcrWarningsKey === ocrWarningsKey) ? [] : ocrWarnings;
  const ocrAvailable = ocrAvailability !== false;
  const applyLocalOcrAvailability = (settings: RunSettings) =>
    enforceLocalOcrAvailability(settings, ocrAvailability);
  const setRunSettings: Dispatch<SetStateAction<RunSettings>> = (next) => {
    setRunSettingsState((current) =>
      applyLocalOcrAvailability(typeof next === 'function' ? next(current) : next),
    );
  };
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    enabled: backendReady,
  });
  const projectDetailQuery = useQuery({
    queryKey: ['project', selectedProjectId],
    queryFn: () => getProject(selectedProjectId as string),
    enabled: Boolean(selectedProjectId),
  });
  const recordingDetailQuery = useQuery({
    queryKey: ['recording', selectedRecordingId],
    queryFn: () => getRecording(selectedRecordingId as string),
    enabled: Boolean(selectedRecordingId),
    refetchInterval: (query) => {
      const recording = query.state.data;
      return recording?.runs.some((run) => activeRunStatuses.includes(run.status)) ? 1500 : false;
    },
  });
  const runDetailQuery = useQuery({
    queryKey: ['run', selectedRunId],
    queryFn: ({ signal }) => getRun(selectedRunId as string, signal),
    enabled: Boolean(selectedRunId),
    refetchInterval: (query) => {
      const run = query.state.data as RunDetail | undefined;
      return run && activeRunStatuses.includes(run.summary.status) ? 2000 : false;
    },
  });
  // In a shared account the other browsers see what this one uploads (see LiveProvider).
  const { setPresence } = useLive();

  const projectRecordings = projectDetailQuery.data?.recordings ?? [];
  const analysisRecordingQueries = useQueries({
    queries: projectRecordings.map((recording) => ({
      queryKey: ['recording', recording.id, 'analysis'],
      queryFn: () => getRecording(recording.id),
      enabled: workflowStage === 'analysis' && Boolean(selectedProjectId),
      refetchInterval: (query: { state: { data: RecordingDetail | undefined } }) =>
        query.state.data?.runs.some((run) => activeRunStatuses.includes(run.status)) ? 1500 : false,
    })),
  });

  useEffect(() => {
    if (!selectedProjectId) {
      setRunSettings(defaultRunSettings);
      setSettingsFeedback('');
      uploadControllers.current.forEach((controller) => controller.abort());
      setImportQueue([]);
      setImportSelectionFeedback('');
      setPendingAnalysisProjectId(null);
      setPreviewRecordingId(null);
      setWorkflowStage('projects');
      return;
    }

    setSettingsFeedback('');
  }, [selectedProjectId]);

  useEffect(() => {
    if (!isShared || !(projectDetailQuery.error instanceof ApiError) || projectDetailQuery.error.status !== 404) {
      return;
    }
    setSelectedProjectId(null);
    setSelectedRecordingId(null);
    setSelectedRunId(null);
    setPendingTaskNavigation(null);
    setAppError('This project is no longer available.');
  }, [isShared, projectDetailQuery.error]);

  // A project opens with the settings saved for it, or else the person's own defaults; again once those have
  // loaded. Saving, or fetching them again later, leaves the settings on screen alone.
  useEffect(() => {
    if (selectedProjectId) {
      setRunSettings(projectDefaultSettings);
    }
  }, [savedRunSettingsLoaded, selectedProjectId]);

  // Earlier versions kept saved settings in the browser. They go to the first account that opens the app here,
  // where it has saved nothing of its own, and are then forgotten, so they cannot reach a second account.
  useEffect(() => {
    if (!savedRunSettings) {
      return;
    }
    const presets = readBrowserRunPresets();
    if (!presets) {
      return;
    }
    const isSaved = (projectId: string | null) => savedRunSettings.some((item) => item.project_id === projectId);
    const missing = [
      ...(presets.defaults && !isSaved(null) ? [{ projectId: null, settings: presets.defaults }] : []),
      ...presets.projects.filter(({ projectId }) => !isSaved(projectId)),
    ];
    void Promise.allSettled(missing.map(({ projectId, settings }) => saveRunSettings(projectId, settings))).then(
      (results) => {
        results.forEach((result) => {
          if (result.status === 'fulfilled') {
            rememberSavedRunSettings(result.value);
          }
        });
        // A project this account cannot open is refused; keep the presets for another try only when the server
        // could not be reached.
        if (results.every((result) => result.status === 'fulfilled' || result.reason instanceof ApiError)) {
          forgetBrowserRunPresets(presets);
        }
      },
    );
  }, [savedRunSettingsLoaded]);

  useEffect(() => {
    function syncViewportSize() {
      setViewportSize({
        height: window.innerHeight,
        width: window.innerWidth,
      });
    }

    syncViewportSize();
    window.addEventListener('resize', syncViewportSize);
    return () => window.removeEventListener('resize', syncViewportSize);
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    setImportQueue((current) =>
      syncImportQueueWithRecordings(current, projectDetailQuery.data?.recordings ?? [], selectedProjectId),
    );
  }, [projectDetailQuery.data?.recordings, selectedProjectId]);

  useEffect(() => {
    if (!pendingAnalysisProjectId || pendingAnalysisProjectId !== selectedProjectId) {
      return;
    }

    const recordings = projectDetailQuery.data?.recordings ?? [];
    if (recordings.length > 0) {
      setSelectedRecordingId(recordings[0].id);
      setSelectedRunId(null);
      setPendingAnalysisProjectId(null);
      return;
    }

    if (projectDetailQuery.isFetched && !projectDetailQuery.isFetching) {
      setWorkflowStage('import');
      setPendingAnalysisProjectId(null);
    }
  }, [
    pendingAnalysisProjectId,
    projectDetailQuery.data?.recordings,
    projectDetailQuery.isFetched,
    projectDetailQuery.isFetching,
    selectedProjectId,
  ]);

  useEffect(() => {
    if (!importSelectionFeedback) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => setImportSelectionFeedback(''), 2400);
    return () => globalThis.clearTimeout(timeoutId);
  }, [importSelectionFeedback]);

  useEffect(() => {
    const recordings = projectDetailQuery.data?.recordings ?? [];
    const stillSelected = recordings.some((recording) => recording.id === selectedRecordingId);
    if (!stillSelected) {
      setSelectedRecordingId(null);
      setSelectedRunId(null);
    }
  }, [projectDetailQuery.data, selectedRecordingId]);

  useEffect(() => {
    if (!previewRecordingId) {
      return;
    }
    if (!projectRecordings.some((recording) => recording.id === previewRecordingId)) {
      setPreviewRecordingId(null);
    }
  }, [previewRecordingId, projectRecordings]);

  useEffect(() => {
    if (!recordingDetailQuery.data) {
      return;
    }
    const runs = recordingDetailQuery.data.runs ?? [];
    const stillSelected = runs.some((run) => run.id === selectedRunId);
    if (!stillSelected) {
      setSelectedRunId(null);
      setPendingTaskNavigation(null);
    }
  }, [recordingDetailQuery.data, selectedRunId]);

  const selectedRunRecordingId = runDetailQuery.data?.summary.recording_id ?? null;
  const selectedRunIsActive = runDetailQuery.data
    ? activeRunStatuses.includes(runDetailQuery.data.summary.status)
    : false;

  // One progress connection per running task. It must not depend on the run data itself: every progress
  // event refreshes that data, and re-subscribing on each refresh closed the socket, blanked the message
  // and replayed every earlier event, so the progress line flickered and the page jumped.
  useEffect(() => {
    if (!selectedRunId || !selectedRunRecordingId) {
      return;
    }
    if (!selectedRunIsActive) {
      setLiveMessage('');
      return;
    }

    const runId = selectedRunId;
    const recordingId = selectedRunRecordingId;
    const socketUrl = apiSocketUrl(`/runs/${runId}/events`);
    const socket = new WebSocket(socketUrl);

    // A run sends several progress events a second; refresh the task list and run at most once a second.
    let refreshTimer: number | null = null;
    let lastRefreshAt = 0;
    function scheduleRefresh() {
      if (refreshTimer !== null) {
        return;
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        lastRefreshAt = Date.now();
        void refreshRunQueries(runId, recordingId);
      }, Math.max(0, 1000 - (Date.now() - lastRefreshAt)));
    }

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { message?: string };
      if (payload.message) {
        setLiveMessage(payload.message);
      }
      scheduleRefresh();
    };

    socket.onclose = () => {
      setLiveMessage('');
      void refreshRunQueries(runId, recordingId);
    };

    socket.onerror = () => {
      setLiveMessage('Live progress connection dropped. Polling will continue.');
    };

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    };
  }, [selectedRunId, selectedRunRecordingId, selectedRunIsActive]);

  const selectedProject = useMemo(
    () => projectsQuery.data?.find((project) => project.id === selectedProjectId) ?? null,
    [projectsQuery.data, selectedProjectId],
  );
  const activeProject = projectDetailQuery.data?.project ?? selectedProject;
  const selectedProjectSummary = activeProject?.id === selectedProjectId ? activeProject : selectedProject;
  const selectedProjectCanJumpToAnalysis = Boolean(selectedProjectSummary?.recording_count);
  const hasSelectedProject = Boolean(selectedProjectId);
  const activeViewportStage: WorkflowStage =
    workflowStage === 'projects' || !hasSelectedProject ? 'projects' : workflowStage;
  // The admin panel has the analysis page's columns, so it needs the same room.
  const viewportMinimum = workflowViewportMinimums[showUsers ? 'analysis' : activeViewportStage];
  const isViewportTooSmall =
    viewportSize.width < viewportMinimum.width || viewportSize.height < viewportMinimum.height;
  const viewportWarning =
    isViewportTooSmall && appPrefs.warnSmallWindow ? (
      <ViewportWarning
        currentHeight={viewportSize.height}
        currentWidth={viewportSize.width}
        minimumHeight={viewportMinimum.height}
        minimumWidth={viewportMinimum.width}
        onDismiss={() => updateAppPref('warnSmallWindow', false)}
      />
    ) : null;

  const selectedRecording = recordingDetailQuery.data ?? null;
  const selectedRun = runDetailQuery.data ?? null;
  const selectedRecordingSummary =
    projectRecordings.find((recording) => recording.id === selectedRecordingId) ?? null;
  const previewRecording =
    projectRecordings.find((recording) => recording.id === previewRecordingId) ?? null;

  async function refreshRecordingQueries(recordingId: string): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['recording', recordingId] }),
      queryClient.invalidateQueries({ queryKey: ['recording', recordingId, 'analysis'] }),
    ]);
  }

  async function refreshRunQueries(runId: string, recordingId: string): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['run', runId] }),
      refreshRecordingQueries(recordingId),
    ]);
  }

  function updateAppPref<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
    setAppPrefs((prev) => {
      const next = { ...prev, [key]: value };
      saveAppPreferences(next);
      return next;
    });
  }

  useEffect(() => {
    if (!pendingTaskNavigation || !selectedRun || selectedRun.summary.id !== pendingTaskNavigation.runId) {
      return;
    }

    const anchorId =
      pendingTaskNavigation.anchorId === 'analysis-candidate-review' &&
      selectedRun.summary.status === 'completed' &&
      selectedRun.candidates.length > 0
        ? 'analysis-candidate-review'
        : 'analysis-run-detail';

    jumpToAnalysisAnchor(anchorId);
    setPendingTaskNavigation(null);
  }, [pendingTaskNavigation, selectedRun]);

  const effectiveProjectDefaultSettings = useMemo(
    () => applyLocalOcrAvailability(projectDefaultSettings),
    [projectDefaultSettings, selectedRecordingSummary?.fps, ocrAvailability],
  );
  const healthWarning = Boolean(healthQuery.data && healthQuery.data.missing_tools.length > 0);
  const ocrEntryMessage = backendReady && ocrStatus !== 'available' ? ocrStatusMessage : null;
  const ocrEntryMessageTone = ocrStatus === 'unavailable' ? 'warning' : 'info';
  const projectsStatusMessage = !backendReady
    ? 'connecting to backend…'
    : projectsQuery.isLoading
      ? 'loading projects…'
      : projectsQuery.isError
        ? projectsQuery.error instanceof Error
          ? projectsQuery.error.message
          : 'Could not load projects.'
        : null;

  useEffect(() => {
    if (!ocrWarnings.length && dismissedOcrWarningsKey !== null) {
      setDismissedOcrWarningsKey(null);
    }
  }, [dismissedOcrWarningsKey, ocrWarnings.length]);

  function dismissOcrWarnings() {
    if (!ocrWarningsKey) {
      return;
    }
    setDismissedOcrWarningsKey(ocrWarningsKey);
  }
  const presetText = useMemo(() => serializeRunPresetText(runSettings), [runSettings]);
  const uploadedImportItems = useMemo(() => getUploadedImportItems(importQueue), [importQueue]);
  const projectImportRows = useMemo(
    () => importQueue.filter((item) => item.projectId === null || item.projectId === selectedProjectId),
    [importQueue, selectedProjectId],
  );
  const projectImportsInFlight = useMemo(() => importsInFlight(importQueue, selectedProjectId), [importQueue, selectedProjectId]);
  // Done once a video is in, or on its way: uploads carry on while the analysis page is open.
  const canCompleteImport =
    uploadedImportItems.some((item) => item.projectId === selectedProjectId) || projectImportsInFlight.length > 0;
  const analysisRecordingsLoading =
    workflowStage === 'analysis' &&
    pendingAnalysisProjectId === selectedProjectId &&
    (!projectDetailQuery.data || projectDetailQuery.data.recordings.length === 0);
  const analysisTaskItems = useMemo<AnalysisTaskItem[]>(() => {
    return projectRecordings
      .flatMap((recording, index) => {
        const detail = analysisRecordingQueries[index]?.data;
        return (detail?.runs ?? []).map((run) => ({ recording, run }));
      })
      .sort((left, right) => {
        const statusRankDelta = getAnalysisTaskStatusRank(left.run.status) - getAnalysisTaskStatusRank(right.run.status);
        if (statusRankDelta !== 0) {
          return statusRankDelta;
        }
        return new Date(right.run.created_at).getTime() - new Date(left.run.created_at).getTime();
      });
  }, [analysisRecordingQueries, projectRecordings]);

  useEffect(() => {
    if (ocrAvailability !== false) {
      return;
    }
    setRunSettingsState((current) => {
      const nextSettings = applyLocalOcrAvailability(current);
      return areRunSettingsEqual(current, nextSettings) ? current : nextSettings;
    });
  }, [ocrAvailability]);

  const latestRunByRecordingId = useMemo(() => {
    const nextMap = new Map<string, RunSummary>();
    analysisTaskItems.forEach((item) => {
      const existing = nextMap.get(item.recording.id);
      if (!existing || new Date(item.run.created_at).getTime() > new Date(existing.created_at).getTime()) {
        nextMap.set(item.recording.id, item.run);
      }
    });
    return nextMap;
  }, [analysisTaskItems]);
  const analysisTaskItemByRunId = useMemo(
    () => new Map(analysisTaskItems.map((item) => [item.run.id, item])),
    [analysisTaskItems],
  );
  const candidateSimilarityLinks = useMemo(() => {
    const links = new Map<string, SimilarLink>();
    if (!selectedRun) {
      return links;
    }

    const candidatesById = new Map(selectedRun.candidates.map((candidate) => [candidate.id, candidate]));
    const firstCandidateByGroup = new Map<string, CandidateFrame>();

    selectedRun.candidates.forEach((candidate) => {
      const directTarget = candidate.similar_to_candidate_id
        ? candidatesById.get(candidate.similar_to_candidate_id)
        : null;
      const groupedTarget =
        !directTarget && candidate.revisit_group_id
          ? firstCandidateByGroup.get(candidate.revisit_group_id)
          : null;
      const target = directTarget ?? groupedTarget;

      if (target && target.id !== candidate.id) {
        links.set(candidate.id, {
          targetId: `candidate-${target.id}`,
          label: `similar to candidate ${target.detector_index}`,
        });
      }

      if (candidate.revisit_group_id && !firstCandidateByGroup.has(candidate.revisit_group_id)) {
        firstCandidateByGroup.set(candidate.revisit_group_id, candidate);
      }
    });

    return links;
  }, [selectedRun]);
  const acceptedStepSimilarityLinks = useMemo(() => {
    const links = new Map<string, SimilarLink>();
    if (!selectedRun) {
      return links;
    }

    const acceptedStepsById = new Map(selectedRun.accepted_steps.map((step) => [step.step_id, step]));
    selectedRun.accepted_steps.forEach((step) => {
      if (!step.similar_to_step_id) {
        return;
      }
      const target = acceptedStepsById.get(step.similar_to_step_id);
      if (!target || target.step_id === step.step_id) {
        return;
      }
      links.set(step.step_id, {
        targetId: `accepted-step-${target.step_id}`,
        label: `returns to ${target.step_id}`,
      });
    });

    return links;
  }, [selectedRun]);

  const createProjectMutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      setProjectName('');
      openProject(project.id, 'import');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const updateProjectMutation = useMutation({
    mutationFn: ({ name, previousName, projectId }: { name: string; previousName: string; projectId: string }) =>
      updateProject(projectId, name, previousName),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const saveRunSettingsMutation = useMutation({
    mutationFn: ({ projectId, settings }: { projectId: string | null; settings: RunSettings }) =>
      saveRunSettings(projectId, settings),
    onSuccess: (saved) => {
      rememberSavedRunSettings(saved);
      setSettingsFeedback(
        saved.project_id
          ? 'saved the current settings for this project.'
          : 'saved the current settings as universal defaults.',
      );
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const carryOverReviewMutation = useMutation({
    mutationFn: ({ pairs, sourceRunId, targetRunId }: { pairs: Array<{ source_candidate_id: string; target_candidate_id: string }>; sourceRunId: string; targetRunId: string }) =>
      carryOverReview(targetRunId, sourceRunId, pairs),
    onSuccess: (result, { targetRunId }) => {
      const parts = [
        `${result.decisions} ${result.decisions === 1 ? 'decision' : 'decisions'}`,
        `${result.titles} ${result.titles === 1 ? 'title' : 'titles'}`,
        `${result.notes} ${result.notes === 1 ? 'note' : 'notes'}`,
        result.screen_choices ? `${result.screen_choices} screen ${result.screen_choices === 1 ? 'choice' : 'choices'}` : '',
        result.added_manual ? `${result.added_manual} ${result.added_manual === 1 ? 'step' : 'steps'} added by hand again` : '',
      ].filter(Boolean);
      setAnalysisActionMessage(
        `brought over ${parts.join(', ')}.${result.unmatched ? ` ${result.unmatched} reviewed ${result.unmatched === 1 ? 'step had' : 'steps had'} no match and stayed behind.` : ''}`,
      );
      void queryClient.invalidateQueries({ queryKey: ['run', targetRunId] });
      void queryClient.invalidateQueries({ queryKey: ['recording'] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  async function handleCarryOverReview(
    sourceRunId: string,
    targetRunId: string,
    pairs: Array<{ source_candidate_id: string; target_candidate_id: string }>,
  ): Promise<boolean> {
    clearAnalysisMessages();
    try {
      await carryOverReviewMutation.mutateAsync({ pairs, sourceRunId, targetRunId });
      return true;
    } catch {
      return false; // shown by onError
    }
  }

  // Back to the factory settings: forget the saved universal defaults and this project's, then use the factory ones.
  const restoreFactorySettingsMutation = useMutation({
    mutationFn: async ({ projectId }: { projectId: string | null }) => {
      await forgetRunSettings(null);
      if (projectId) await forgetRunSettings(projectId);
    },
    onSuccess: (_result, { projectId }) => {
      queryClient.setQueryData<SavedRunSettings[]>(SAVED_RUN_SETTINGS_KEY, (current = []) =>
        current.filter((item) => item.project_id !== null && item.project_id !== projectId),
      );
      applyAnalysisSettings(defaultRunSettings, 'restored the factory settings, and forgot the saved defaults.');
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const deleteProjectMutation = useMutation({
    mutationFn: ({ projectId }: { projectId: string }) => deleteProject(projectId),
    onSuccess: (_result, variables) => {
      // The server drops the settings saved for it along with it.
      queryClient.setQueryData<SavedRunSettings[]>(SAVED_RUN_SETTINGS_KEY, (current) =>
        current?.filter((item) => item.project_id !== variables.projectId),
      );
      if (selectedProjectId === variables.projectId) {
        if (selectedRecordingId) {
          queryClient.removeQueries({ queryKey: ['recording', selectedRecordingId] });
        }
        if (previewRecordingId) {
          queryClient.removeQueries({ queryKey: ['recording', previewRecordingId] });
        }
        if (selectedRunId) {
          queryClient.removeQueries({ queryKey: ['run', selectedRunId] });
        }
        setSelectedProjectId(null);
        setPendingAnalysisProjectId(null);
        setSelectedRecordingId(null);
        setSelectedRunId(null);
        setPreviewRecordingId(null);
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.removeQueries({ queryKey: ['project', variables.projectId] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const importRecordingMutation = useMutation({
    mutationFn: ({ file, filename, localId, projectId }: { file: File; filename?: string; localId: string; projectId: string }) => {
      const controller = new AbortController();
      uploadControllers.current.set(localId, controller);
      let shown = -1;
      // In a shared account the other browsers show this upload while it lasts, in steps of a tenth.
      const presenceKey = `upload:${localId}`;
      const announce = (progress: number) =>
        setPresence(presenceKey, { kind: 'uploading', project_id: projectId, name: filename || file.name, progress });
      announce(0);
      return importRecording(projectId, file, filename, {
        signal: controller.signal,
        onProgress: (fraction) => {
          // one update per whole percent is plenty
          const percent = Math.floor(fraction * 100);
          if (percent === shown) return;
          if (Math.floor(percent / 10) !== Math.floor(shown / 10)) announce(Math.floor(percent / 10) / 10);
          shown = percent;
          setImportQueue((current) =>
            current.map((item) => (item.localId === localId && item.status === 'uploading' ? { ...item, progress: fraction } : item)),
          );
        },
      }).finally(() => {
        uploadControllers.current.delete(localId);
        setPresence(presenceKey, null);
      });
    },
    onSuccess: (recording, variables) => {
      setImportQueue((current) => markImportUploaded(current, variables.localId, recording));
      // The first video of a project becomes the selection; later ones do not take it from what is being worked on.
      if (recording.project_id === selectedProjectIdRef.current && !selectedRecordingIdRef.current) {
        setSelectedRecordingId(recording.id);
        setSelectedRunId(null);
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', recording.project_id] });
      queryClient.invalidateQueries({ queryKey: ['recording', recording.id] });
    },
    onError: (error: Error, variables) => {
      if (isAbortError(error)) {
        // cancelled: the row goes
        setImportQueue((current) => current.filter((item) => item.localId !== variables.localId));
        return;
      }
      setAppError(error.message);
      setImportQueue((current) =>
        current.map((item) =>
          item.localId === variables.localId
            ? {
                ...item,
                status: 'error',
                progress: null,
                error: error.message,
              }
            : item,
        ),
      );
    },
  });

  // Closing or reloading the page would drop the videos still on their way: the browser asks first.
  const uploadsUnderWay = importQueue.some((item) => item.status === 'queued' || item.status === 'uploading');
  useEffect(() => {
    if (!uploadsUnderWay) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploadsUnderWay]);

  // Chosen videos upload by themselves, one at a time, in the order they were chosen.
  useEffect(() => {
    const next = nextImportUpload(importQueue);
    if (!next?.file || !next.projectId) {
      return;
    }
    setImportQueue((current) =>
      current.map((item) => (item.localId === next.localId ? { ...item, status: 'uploading', progress: 0, error: null } : item)),
    );
    importRecordingMutation.mutate({ projectId: next.projectId, file: next.file, filename: next.filename, localId: next.localId });
    // importRecordingMutation is stable enough: mutate() always runs the latest options
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importQueue]);

  const updateRecordingMutation = useMutation({
    mutationFn: ({ filename, previousFilename, recordingId }: { filename: string; previousFilename: string; recordingId: string }) =>
      updateRecording(recordingId, filename, previousFilename),
    onSuccess: (recording) => {
      setImportQueue((current) =>
        current.map((item) =>
          item.recordingId === recording.id
            ? {
                ...item,
                filename: recording.filename,
              }
            : item,
        ),
      );
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', recording.project_id] });
      queryClient.invalidateQueries({ queryKey: ['recording', recording.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const deleteRecordingMutation = useMutation({
    mutationFn: ({ recordingId }: { localId?: string; recordingId: string }) => deleteRecording(recordingId),
    onSuccess: (_result, variables) => {
      setImportQueue((current) =>
        current.filter((item) => item.localId !== variables.localId && item.recordingId !== variables.recordingId),
      );
      if (selectedRecordingId === variables.recordingId) {
        setSelectedRecordingId(null);
        setSelectedRunId(null);
        setPendingTaskNavigation(null);
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] });
      queryClient.removeQueries({ queryKey: ['recording', variables.recordingId] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const createRunMutation = useMutation({
    mutationFn: ({ recordingId, settings }: { recordingId: string; settings: RunSettings }) =>
      createRun(recordingId, settings),
    onSuccess: (run) => {
      rememberNewRun(run);
      setSelectedRunId(run.id);
      setLiveMessage('queued detection job.');
      void refreshRunQueries(run.id, run.recording_id);
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const abortRunMutation = useMutation({
    mutationFn: abortRun,
    onSuccess: (run) => {
      void refreshRunQueries(run.id, run.recording_id);
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const resetDatabaseMutation = useMutation({
    mutationFn: resetDatabase,
    onSuccess: () => {
      setSelectedProjectId(null);
      setSelectedRecordingId(null);
      setSelectedRunId(null);
      setWorkflowStage('projects');
      queryClient.clear();
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const recheckOcrMutation = useMutation({
    mutationFn: recheckOcr,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['health'] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const updateCandidateMutation = useMutation({
    mutationKey: ['candidate-update'],
    mutationFn: ({ candidateId, payload }: { candidateId: string; payload: CandidateChanges }) =>
      updateCandidate(candidateId, payload),
    onSuccess: (candidate) => {
      return refreshRunQueries(candidate.run_id, candidate.recording_id);
    },
    onError: (error: Error, { payload }) => {
      // In a shared account, text saved in another browser meanwhile is kept and shown here; this browser's text
      // goes into the message, so it is not lost.
      const text = payload.title ?? payload.notes;
      if (error instanceof ApiError && error.status === 409 && text) {
        setAppError(`${error.message} Your text: “${text}”`);
        if (selectedRunId) void queryClient.invalidateQueries({ queryKey: ['run', selectedRunId] });
        return;
      }
      setAppError(error.message);
    },
  });

  const createManualCandidateMutation = useMutation({
    mutationFn: ({ runId, timestampMs }: { runId: string; timestampMs: number }) =>
      createManualCandidate(runId, timestampMs),
    onSuccess: async (candidate) => {
      setAnalysisActionMessage(`added manual step at ${candidate.timestamp_tc}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        selectedProjectId ? queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] }) : Promise.resolve(),
        refreshRunQueries(candidate.run_id, candidate.recording_id),
      ]);
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const createManualRunMutation = useMutation({
    mutationFn: (recordingId: string) => createManualRun(recordingId),
    onSuccess: async (run) => {
      rememberNewRun(run);
      setSelectedRunId(run.id);
      await refreshRunQueries(run.id, run.recording_id);
    },
    onError: (error: Error) => setAppError(error.message),
  });

  function rememberNewRun(run: RunSummary) {
    queryClient.setQueriesData<RecordingDetail>({ queryKey: ['recording', run.recording_id] }, (current) => {
      if (!current || current.runs.some(({ id }) => id === run.id)) return current;
      return { ...current, runs: [run, ...current.runs] };
    });
  }

  const exportRunMutation = useMutation({
    mutationFn: async ({ downloadName, mode, runId }: { downloadName?: string; mode: ExportMode; runId: string }) => {
      const bundle = await exportRun(runId, mode);
      await downloadExportBundle(bundle, downloadName);
      return { runId };
    },
    onSuccess: ({ runId }) => {
      const task = analysisTaskItemByRunId.get(runId);
      if (task) {
        void refreshRunQueries(runId, task.run.recording_id);
      }
    },
    onError: (error: Error) => setAppError(error.message),
  });

  async function waitForRunToLeaveActiveState(runId: string): Promise<RunDetail> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const run = await getRun(runId);
      if (!activeRunStatuses.includes(run.summary.status)) {
        return run;
      }
      await sleep(1000);
    }
    throw new Error('Timed out while waiting for the task to stop.');
  }

  function clearAnalysisMessages() {
    setAppError('');
    setAnalysisActionMessage('');
  }

  function openProject(projectId: string, targetStage: ProjectEntryTarget) {
    setSelectedProjectId(projectId);
    setPendingAnalysisProjectId(targetStage === 'analysis' ? projectId : null);
    setSelectedRecordingId(null);
    setSelectedRunId(null);
    setPendingTaskNavigation(null);
    setPreviewRecordingId(null);
    setWorkflowStage(targetStage);
    clearAnalysisMessages();
  }

  function handleCreateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim()) {
      return;
    }
    clearAnalysisMessages();
    createProjectMutation.mutate(projectName.trim());
  }

  function setAnalysisSelection(recordingId: string, jumpToRunDetail: boolean) {
    const latestRun = latestRunByRecordingId.get(recordingId) ?? null;
    setSelectedRecordingId(recordingId);
    setSelectedRunId(latestRun?.id ?? null);
    setPendingTaskNavigation(null);
    if (latestRun && jumpToRunDetail) {
      jumpToAnalysisAnchor('analysis-run-detail');
    }
  }

  function handleSelectRecording(recordingId: string) {
    setAnalysisSelection(recordingId, true);
  }

  function handlePreviewRecording(recordingId: string) {
    setPreviewRecordingId((current) => {
      const nextRecordingId = current === recordingId ? null : recordingId;
      if (nextRecordingId) {
        jumpToAnalysisAnchor('analysis-video-preview');
      }
      return nextRecordingId;
    });
  }

  function handleStartAnalysisRun() {
    if (!selectedRecordingId) {
      return;
    }
    clearAnalysisMessages();
    createRunMutation.mutate({
      recordingId: selectedRecordingId,
      settings: applyLocalOcrAvailability(runSettings),
    });
  }

  function rememberSavedRunSettings(saved: SavedRunSettings) {
    queryClient.setQueryData<SavedRunSettings[]>(SAVED_RUN_SETTINGS_KEY, (current = []) => [
      ...current.filter((item) => item.project_id !== saved.project_id),
      saved,
    ]);
  }

  function handleSaveProjectDefault() {
    if (!selectedProjectId) {
      return;
    }
    saveRunSettingsMutation.mutate({ projectId: selectedProjectId, settings: applyLocalOcrAvailability(runSettings) });
  }

  function handleSaveUniversalDefault() {
    saveRunSettingsMutation.mutate({ projectId: null, settings: applyLocalOcrAvailability(runSettings) });
  }

  function applyAnalysisSettings(nextSettings: RunSettings, feedback: string) {
    setRunSettings(sanitizeRunSettings(applyLocalOcrAvailability(nextSettings)));
    setSettingsFeedback(feedback);
  }

  function handleResetToProjectDefaults() {
    applyAnalysisSettings(effectiveProjectDefaultSettings, "reset the current settings to this project's defaults.");
  }

  function handleResetToUniversalDefaults() {
    applyAnalysisSettings(universalDefaultSettings, 'reset the current settings to the universal defaults.');
  }

  async function handleRestoreFactorySettings() {
    const others = (savedRunSettings ?? []).filter((item) => item.project_id !== null && item.project_id !== selectedProjectId).length;
    const confirmed = await confirm({
      message: "restore stepthrough's factory settings?",
      detail: [
        `this forgets the settings you saved as universal defaults${selectedProjectId ? ' and for this project' : ''}.`,
        others ? `settings saved for ${others} other ${others === 1 ? 'project stay' : 'projects stay'}.` : '',
      ].filter(Boolean).join(' '),
      confirmLabel: 'restore',
    });
    if (!confirmed) {
      return;
    }
    restoreFactorySettingsMutation.mutate({ projectId: selectedProjectId });
  }

  function handleApplyImportedPreset(settings: RunSettings) {
    applyAnalysisSettings(settings, 'applied preset text to the active analysis parameters.');
  }

  async function handleCreateManualRunCandidate(runId: string, timestampMs: number) {
    clearAnalysisMessages();
    return createManualCandidateMutation.mutateAsync({ runId, timestampMs });
  }

  async function handleCreateManualRun(recordingId: string) {
    clearAnalysisMessages();
    setSelectedRecordingId(recordingId);
    return createManualRunMutation.mutateAsync(recordingId);
  }

  /** Ask before deleting a recording: it takes every run, screenshot and export made from it along. */
  function confirmRecordingDeletion(filename: string): Promise<boolean> {
    return confirm({
      message: `delete ${filename}?`,
      detail: 'every run, screenshot and export made from it goes too. this cannot be undone.',
      confirmLabel: 'delete',
      danger: true,
    });
  }

  async function confirmDeleteRecording(recordingId: string, filename: string) {
    if (!(await confirmRecordingDeletion(filename))) {
      return;
    }
    clearAnalysisMessages();
    deleteRecordingMutation.mutate({ recordingId });
  }

  async function confirmDeleteProject(projectId: string, projectName: string) {
    const confirmed = await confirm({
      // In a shared account everyone sees everyone's projects, so there the question says whose project to delete.
      ...(isShared
        ? {
            message: `are you sure you want to delete the project ${projectName}?`,
            detail:
              'only do so if this is your own project: it goes for everyone who can open it, with every recording, ' +
              'run, screenshot and export in it. this cannot be undone.',
          }
        : {
            message: `delete ${projectName}?`,
            detail: 'every recording, run, screenshot and export in it goes too. this cannot be undone.',
          }),
      confirmLabel: 'delete',
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    clearAnalysisMessages();
    deleteProjectMutation.mutate({ projectId });
  }

  async function handleRenameProject(projectId: string, name: string, previousName: string) {
    clearAnalysisMessages();
    await updateProjectMutation.mutateAsync({ name, previousName, projectId });
  }

  async function handleRenameRecording(recordingId: string, filename: string, previousFilename: string) {
    clearAnalysisMessages();
    await updateRecordingMutation.mutateAsync({ filename, previousFilename, recordingId });
  }

  async function handleRenameImportItem(localId: string, filename: string, previousFilename: string) {
    const queueItem = importQueue.find((item) => item.localId === localId);
    if (!queueItem) {
      return;
    }

    if (queueItem.recordingId) {
      await handleRenameRecording(queueItem.recordingId, filename, previousFilename);
      return;
    }

    setImportQueue((current) =>
      current.map((item) =>
        item.localId === localId
          ? {
              ...item,
              filename,
            }
          : item,
      ),
    );
  }

  function setProjectStage(stage: WorkflowStage) {
    if (stage === 'projects') {
      setPendingAnalysisProjectId(null);
      setWorkflowStage('projects');
      return;
    }
    if (!selectedProjectId) {
      return;
    }

    if (workflowStage === 'projects') {
      if (stage === 'analysis' && !selectedProjectCanJumpToAnalysis) {
        return;
      }
      openProject(selectedProjectId, stage);
      return;
    }

    if (stage === 'import') {
      setPendingAnalysisProjectId(null);
      setPendingTaskNavigation(null);
      setWorkflowStage('import');
      return;
    }

    void handleNavigateToAnalysis(true);
  }

  function jumpToAnalysisAnchor(anchorId: string) {
    if (typeof window === 'undefined') {
      return;
    }
    window.setTimeout(() => jumpToAnchor(anchorId), 0);
  }

  function handleJumpToAnalysisSelection() {
    if (selectedRun) {
      jumpToAnchor('analysis-run-detail');
      return;
    }
    if (previewRecordingId) {
      jumpToAnchor('analysis-video-preview');
      return;
    }
    jumpToAnchor('analysis-parameters');
  }

  function handleSelectTaskRun(recordingId: string, runId: string, anchorId = 'analysis-run-detail') {
    setSelectedRecordingId(recordingId);
    setSelectedRunId(runId);
    setPendingTaskNavigation({ runId, anchorId: anchorId === 'analysis-candidate-review' ? anchorId : 'analysis-run-detail' });
  }

  function handleImportFileSelection(files: FileList | File[]) {
    if (!selectedProjectId) {
      return;
    }
    const { ignoredCount, queueItems } = collectImportQueueItems(importQueue, files, selectedProjectId);
    if (!queueItems.length && ignoredCount === 0) {
      return;
    }
    if (queueItems.length > 0) {
      setImportQueue((current) => [...current, ...queueItems]);
    }
    if (ignoredCount > 0) {
      setImportSelectionFeedback(
        `${ignoredCount} duplicate ${ignoredCount === 1 ? 'video was' : 'videos were'} ignored.`,
      );
    } else {
      setImportSelectionFeedback('');
    }
  }

  function handleQuickImportDrop(files: FileList | File[]) {
    if (!selectedProjectId) {
      return;
    }

    const { ignoredCount, queueItems } = collectImportQueueItems(importQueue, files, selectedProjectId);
    if (!queueItems.length && ignoredCount === 0) {
      return;
    }

    clearAnalysisMessages();

    if (!queueItems.length) {
      setAnalysisActionMessage(
        `${ignoredCount} duplicate ${ignoredCount === 1 ? 'video was' : 'videos were'} ignored.`,
      );
      return;
    }

    setImportQueue((current) => [...current, ...queueItems]);
    setAnalysisActionMessage(
      `importing ${queueItems.length} ${queueItems.length === 1 ? 'video' : 'videos'}${
        ignoredCount > 0
          ? ` · ignored ${ignoredCount} duplicate ${ignoredCount === 1 ? 'file' : 'files'}`
          : ''
      }.`,
    );
  }

  /** Try a failed upload again: back in the queue. */
  function handleRetryImportItem(localId: string) {
    clearAnalysisMessages();
    setImportQueue((current) =>
      current.map((item) =>
        item.localId === localId && item.status === 'error' && item.file
          ? { ...item, status: 'queued', progress: null, error: null }
          : item,
      ),
    );
  }

  /**
   * The row's one action besides retry: cancel a video on its way (waiting or uploading), remove one that failed,
   * or delete an uploaded recording with everything made from it.
   */
  async function handleDeleteImportItem(localId: string) {
    const queueItem = importQueue.find((item) => item.localId === localId);
    if (!queueItem) {
      return;
    }
    if (queueItem.status === 'uploading') {
      // the row goes when the request has stopped (onError); a request that had already finished on the server
      // still becomes a recording, and shows up with the next reload of the project
      uploadControllers.current.get(localId)?.abort();
      return;
    }
    if (queueItem.recordingId) {
      if (!(await confirmRecordingDeletion(queueItem.filename))) {
        return;
      }
      deleteRecordingMutation.mutate({ localId, recordingId: queueItem.recordingId });
      return;
    }
    setImportQueue((current) => current.filter((item) => item.localId !== localId));
  }

  async function handleNavigateToAnalysis(promptWhenEmpty: boolean) {
    if (!selectedProjectId) {
      return;
    }
    const uploadedRows = getUploadedImportItems(importQueue).filter((item) => item.projectId === selectedProjectId);
    const inFlight = importsInFlight(importQueue, selectedProjectId);
    if (!uploadedRows.length && !inFlight.length) {
      if (!promptWhenEmpty) {
        return;
      }
      const confirmed = await confirm({
        message: 'continue without any uploaded videos?',
        detail: 'analysis is usually most useful after at least one uploaded video.',
      });
      if (!confirmed) {
        return;
      }
    }
    const failed = importQueue.filter((item) => item.projectId === selectedProjectId && item.status === 'error');
    if (
      failed.length &&
      !(await confirm({
        message: `${failed.length} ${failed.length === 1 ? 'video' : 'videos'} could not be uploaded.`,
        detail: 'continue without them? you can upload them again later.',
      }))
    ) {
      return;
    }

    const nextRecordingId =
      uploadedRows[uploadedRows.length - 1]?.recordingId ?? projectDetailQuery.data?.recordings[0]?.id ?? null;
    setPendingAnalysisProjectId(null);
    // Failed rows go; uploads still on their way carry on and join the videos column when they are in.
    setImportQueue((current) => current.filter((item) => item.status !== 'error' || item.projectId !== selectedProjectId));
    setSelectedRecordingId(nextRecordingId);
    setSelectedRunId(null);
    setPendingTaskNavigation(null);
    setWorkflowStage('analysis');
  }

  async function handleExportRun(runId: string, mode: ExportMode, downloadName?: string): Promise<void> {
    clearAnalysisMessages();
    await exportRunMutation.mutateAsync({ downloadName, mode, runId });
    setAnalysisActionMessage(mode === 'accepted' ? 'exported accepted steps.' : 'exported all steps.');
  }

  async function handleBulkUpdateCandidates(
    runId: string,
    recordingId: string,
    candidateIds: string[],
    status: CandidateStatus,
  ): Promise<string[]> {
    const uniqueCandidateIds = Array.from(new Set(candidateIds));
    if (!uniqueCandidateIds.length) {
      return [];
    }

    clearAnalysisMessages();

    // One request for all of them: one change to the task, whoever else is working on it.
    let failure: unknown = null;
    try {
      await setCandidateStatuses(runId, uniqueCandidateIds, status);
    } catch (error) {
      failure = error;
    }
    const failedCandidateIds = failure ? uniqueCandidateIds : [];

    await refreshRunQueries(runId, recordingId);

    const successCount = uniqueCandidateIds.length - failedCandidateIds.length;
    if (successCount > 0) {
      setAnalysisActionMessage(
        `${status === 'accepted' ? 'accepted' : status === 'rejected' ? 'rejected' : 'updated'} ${successCount} ${
          successCount === 1 ? 'candidate' : 'candidates'
        }.`,
      );
    }
    if (failedCandidateIds.length > 0) {
      setAppError(
        failure instanceof ApiError && (failure.status === 409 || failure.status === 422)
          ? failure.message
          : `Could not update ${
              failedCandidateIds.length === 1 ? '1 selected candidate' : `${failedCandidateIds.length} selected candidates`
            }.`,
      );
    }

    return failedCandidateIds;
  }

  async function handleExportTaskRuns(runIds: string[]): Promise<void> {
    const uniqueRunIds = Array.from(new Set(runIds));
    const tasks = uniqueRunIds
      .map((runId) => analysisTaskItemByRunId.get(runId))
      .filter((item): item is AnalysisTaskItem => Boolean(item));
    const completedTasks = tasks.filter((item) => item.run.status === 'completed');
    const skippedCount = tasks.length - completedTasks.length;

    clearAnalysisMessages();
    if (!completedTasks.length) {
      setAppError('Only completed tasks can be exported.');
      return;
    }

    setBulkExportPending(true);
    try {
      const results = await Promise.allSettled(
        completedTasks.map(async (item) => {
          const bundle = await exportRun(item.run.id, 'auto');
          await refreshRunQueries(item.run.id, item.run.recording_id);
          await downloadExportBundle(bundle);
          return item.run.id;
        }),
      );

      let successCount = 0;
      const failures: string[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          successCount += 1;
          return;
        }
        failures.push(
          `${completedTasks[index].recording.filename}: ${
            result.reason instanceof Error ? result.reason.message : 'Export failed.'
          }`,
        );
      });

      if (successCount > 0) {
        const skipSuffix = skippedCount
          ? ` skipped ${skippedCount} non-completed ${skippedCount === 1 ? 'task' : 'tasks'}.`
          : '';
        setAnalysisActionMessage(`exported ${successCount} ${successCount === 1 ? 'task' : 'tasks'}.${skipSuffix}`);
      }
      if (failures.length > 0) {
        setAppError(
          `Could not export ${failures.length === 1 ? 'a task' : `${failures.length} tasks`}: ${failures.join(' · ')}`,
        );
      }
    } finally {
      setBulkExportPending(false);
    }
  }

  async function handleDeleteSelectedRuns(runIds: string[]): Promise<string[] | null> {
    const uniqueRunIds = Array.from(new Set(runIds));
    const tasks = uniqueRunIds
      .map((runId) => analysisTaskItemByRunId.get(runId))
      .filter((item): item is AnalysisTaskItem => Boolean(item));

    if (!tasks.length) {
      return [];
    }

    const activeTasks = tasks.filter((item) => activeRunStatuses.includes(item.run.status));
    const confirmCopy = activeTasks.length
      ? `delete ${tasks.length} selected ${tasks.length === 1 ? 'task' : 'tasks'}? ${activeTasks.length} active ${
          activeTasks.length === 1 ? 'task will' : 'tasks will'
        } be ended first, then deleted.`
      : `delete ${tasks.length} selected ${tasks.length === 1 ? 'task' : 'tasks'}?`;
    if (!(await confirm({ message: confirmCopy, confirmLabel: 'delete', danger: true }))) {
      return null;
    }

    clearAnalysisMessages();
    setBulkDeletePending(true);

    const failedRunIds = new Set<string>();
    const failures: string[] = [];
    let deletedCount = 0;

    try {
      if (activeTasks.length > 0) {
        const abortResults = await Promise.allSettled(
          activeTasks.map(async (item) => {
            const run = await abortRun(item.run.id);
            await refreshRunQueries(run.id, run.recording_id);
            return run.id;
          }),
        );

        abortResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            return;
          }
          failedRunIds.add(activeTasks[index].run.id);
          failures.push(
            `${activeTasks[index].recording.filename}: ${
              result.reason instanceof Error ? result.reason.message : 'Could not end the task before deleting it.'
            }`,
          );
        });

        const waitingTasks = activeTasks.filter((item) => !failedRunIds.has(item.run.id));
        const waitResults = await Promise.allSettled(
          waitingTasks.map(async (item) => {
            const run = await waitForRunToLeaveActiveState(item.run.id);
            await refreshRunQueries(run.summary.id, run.summary.recording_id);
            return run.summary.id;
          }),
        );

        waitResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            return;
          }
          failedRunIds.add(waitingTasks[index].run.id);
          failures.push(
            `${waitingTasks[index].recording.filename}: ${
              result.reason instanceof Error ? result.reason.message : 'Timed out waiting for the task to stop.'
            }`,
          );
        });
      }

      const deletableTasks = tasks.filter((item) => !failedRunIds.has(item.run.id));
      const deleteResults = await Promise.allSettled(
        deletableTasks.map(async (item) => {
          await deleteRun(item.run.id);
          if (selectedRunId === item.run.id) {
            setSelectedRunId(null);
            setPendingTaskNavigation(null);
          }
          await refreshRecordingQueries(item.run.recording_id);
          queryClient.removeQueries({ queryKey: ['run', item.run.id] });
          return item.run.id;
        }),
      );

      deleteResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          deletedCount += 1;
          return;
        }
        failedRunIds.add(deletableTasks[index].run.id);
        failures.push(
          `${deletableTasks[index].recording.filename}: ${
            result.reason instanceof Error ? result.reason.message : 'Delete failed.'
          }`,
        );
      });

      if (selectedProjectId) {
        await queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] });
      }
      await queryClient.invalidateQueries({ queryKey: ['projects'] });

      if (deletedCount > 0) {
        setAnalysisActionMessage(`deleted ${deletedCount} ${deletedCount === 1 ? 'task' : 'tasks'}.`);
      }
      if (failures.length > 0) {
        setAppError(
          `Could not delete ${failures.length === 1 ? 'a task' : `${failures.length} tasks`}: ${failures.join(' · ')}`,
        );
      }

      return tasks.filter((item) => failedRunIds.has(item.run.id)).map((item) => item.run.id);
    } finally {
      setBulkDeletePending(false);
    }
  }

  async function handleLogOut() {
    setIsLoggingOut(true);
    try {
      await logOut();
    } catch {
      // Already logged out (or the backend is gone): the login page is still the right place.
    } finally {
      setIsLoggingOut(false);
    }
    setCornerPanel(null);
    onSessionChange({ mode: 'password', user: null });
  }

  // The watermark, the settings and account panels, and the overlays: the same on every page.
  const chrome = (
    <>
      <AppWatermark
        accountLabel={accountUser ? accountUser.display_name ?? accountUser.name : null}
        onOpenPanel={setCornerPanel}
        openPanel={cornerPanel}
        withSettings
      />
      <AppSettings
        healthData={healthQuery.data}
        isAdmin={isAdmin}
        isRecheckingOcr={recheckOcrMutation.isPending}
        isResettingDatabase={resetDatabaseMutation.isPending}
        open={cornerPanel === 'settings'}
        prefs={appPrefs}
        onChangePref={updateAppPref}
        onClose={() => closeCornerPanel('settings')}
        onRecheckOcr={() => recheckOcrMutation.mutate()}
        onResetDatabase={() => resetDatabaseMutation.mutate()}
      />
      {accountUser && (
        <AccountPanel
          isLoggingOut={isLoggingOut}
          onClose={() => closeCornerPanel('account')}
          onLogOut={() => void handleLogOut()}
          onOpenUsers={() => {
            setCornerPanel(null);
            setShowUsers(true);
          }}
          open={cornerPanel === 'account'}
          user={accountUser}
        />
      )}
      {appPrefs.showPerfMonitor && <PerformanceMonitor />}
      {viewportWarning}
      {confirmDialog}
    </>
  );

  if (showUsers && accountUser?.is_admin) {
    return (
      <>
        <UsersScreen currentUserId={accountUser.id} onBack={() => setShowUsers(false)} />
        {chrome}
      </>
    );
  }

  if (workflowStage === 'projects' || !hasSelectedProject) {
    return (
      <>
        <EntryScreen
          accountNotice={deletionNotice(accountUser?.delete_after)}
          appError={appError}
          healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
          isCreating={createProjectMutation.isPending}
          deletingProjectId={deleteProjectMutation.isPending ? deleteProjectMutation.variables?.projectId ?? null : null}
          ocrStatusMessage={ocrEntryMessage}
          ocrStatusTone={ocrEntryMessageTone}
          ocrWarnings={visibleOcrWarnings}
          onDismissOcrWarnings={dismissOcrWarnings}
          onCreate={handleCreateProject}
          onDeleteProject={confirmDeleteProject}
          onNavigateStage={setProjectStage}
          onOpenProject={openProject}
          onProjectNameChange={setProjectName}
          onProjectSearchChange={setProjectSearch}
          onProjectSortChange={setProjectSort}
          onRenameProject={handleRenameProject}
          projectSearch={projectSearch}
          projectSort={projectSort}
          projectName={projectName}
          projects={projectsQuery.data ?? []}
          projectsLoading={projectsQuery.isLoading}
          projectsStatusMessage={projectsStatusMessage}
          selectedProjectCanJumpToAnalysis={selectedProjectCanJumpToAnalysis}
          selectedProjectId={selectedProjectId}
        />
        {chrome}
      </>
    );
  }

  if (workflowStage === 'import') {
    return (
      <>
        <ImportScreen
          appError={appError}
          canComplete={canCompleteImport}
          healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
          isDeleting={deleteRecordingMutation.isPending}
          isUploadBlocked={Boolean(healthWarning)}
          ocrStatusMessage={ocrEntryMessage}
          ocrStatusTone={ocrEntryMessageTone}
          ocrWarnings={visibleOcrWarnings}
          onDismissOcrWarnings={dismissOcrWarnings}
          onDeleteRow={handleDeleteImportItem}
          onDone={() => void handleNavigateToAnalysis(false)}
          onFilesSelected={handleImportFileSelection}
          onNavigateStage={setProjectStage}
          onRenameProject={handleRenameProject}
          onRenameRow={handleRenameImportItem}
          onRetryRow={handleRetryImportItem}
          project={activeProject}
          rows={projectImportRows}
          selectionFeedback={importSelectionFeedback}
        />
        {chrome}
      </>
    );
  }

  return (
    <>
      <AnalysisScreen
        acceptedStepSimilarityLinks={acceptedStepSimilarityLinks}
        analysisMetadata={analysisMetadata}
        abortRunPending={abortRunMutation.isPending}
        activeProject={activeProject}
        analysisActionMessage={analysisActionMessage}
        analysisTaskItems={analysisTaskItems}
        appError={appError}
        bulkDeletePending={bulkDeletePending}
        bulkExportPending={bulkExportPending}
        candidateSimilarityLinks={candidateSimilarityLinks}
        createManualCandidatePending={createManualCandidateMutation.isPending}
        createManualRunPending={createManualRunMutation.isPending}
        createRunPending={createRunMutation.isPending}
        exportRunPending={exportRunMutation.isPending}
        healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
        healthWarning={Boolean(healthWarning)}
        liveMessage={liveMessage}
        onAbortRun={(runId) => abortRunMutation.mutate(runId)}
        onApplyImportedPreset={handleApplyImportedPreset}
        onBulkUpdateCandidates={handleBulkUpdateCandidates}
        onCreateManualCandidate={handleCreateManualRunCandidate}
        onCreateManualRun={handleCreateManualRun}
        onDeleteRecording={confirmDeleteRecording}
        onDropFiles={handleQuickImportDrop}
        onCancelUpload={handleDeleteImportItem}
        uploads={projectImportsInFlight}
        onDeleteSelectedRuns={handleDeleteSelectedRuns}
        onExportRun={handleExportRun}
        onExportTaskRuns={handleExportTaskRuns}
        onJumpToSelection={handleJumpToAnalysisSelection}
        onNavigateStage={setProjectStage}
        onPreviewRecording={handlePreviewRecording}
        onOpenPreview={setPreviewRecordingId}
        onRenameProject={handleRenameProject}
        onRenameRecording={handleRenameRecording}
        onResetToProjectDefaults={handleResetToProjectDefaults}
        onResetToUniversalDefaults={handleResetToUniversalDefaults}
        onRestoreFactorySettings={handleRestoreFactorySettings}
        onOpenAbout={() => setCornerPanel('about')}
        onCarryOverReview={handleCarryOverReview}
        carryOverPending={carryOverReviewMutation.isPending}
        onSaveProjectPreset={handleSaveProjectDefault}
        onSaveUniversalPreset={handleSaveUniversalDefault}
        onSelectRecording={handleSelectRecording}
        onSelectRun={handleSelectTaskRun}
        onStartRun={handleStartAnalysisRun}
        onUpdateCandidate={(candidateId, payload) => updateCandidateMutation.mutate({ candidateId, payload })}
        ocrAvailable={ocrAvailable}
        ocrStatus={ocrStatus}
        ocrStatusMessage={ocrStatusMessage}
        ocrWarnings={visibleOcrWarnings}
        onDismissOcrWarnings={dismissOcrWarnings}
        previewRecording={previewRecording}
        projectDefaultSettings={effectiveProjectDefaultSettings}
        recordings={projectRecordings}
        recordingsLoading={analysisRecordingsLoading}
        runSettings={runSettings}
        selectedRecording={selectedRecording}
        selectedRecordingId={selectedRecordingId}
        selectedRunId={selectedRunId}
        selectedRecordingSummary={selectedRecordingSummary}
        selectedRun={selectedRun}
        selectedRunLoading={runDetailQuery.isLoading || runDetailQuery.isFetching}
        setRunSettings={setRunSettings}
        settingsFeedback={settingsFeedback}
        showPresetText={presetText}
      />
      {chrome}
    </>
  );
}

export default App;
