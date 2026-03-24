import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  abortRun,
  createManualCandidate,
  createProject,
  createRun,
  deleteProject,
  deleteRecording,
  deleteRun,
  exportRun,
  getProject,
  getRecording,
  getRun,
  health,
  importRecording,
  listProjects,
  recheckOcr,
  resetDatabase,
  updateCandidate,
  updateProject,
  updateRecording,
} from './api';
import { AppSettings } from './components/AppSettings';
import { AppWatermark } from './components/AppWatermark';
import { PerformanceMonitor } from './components/PerformanceMonitor';
import { ViewportWarning } from './components/ViewportWarning';
import { AnalysisScreen } from './features/analysis/AnalysisScreen';
import { ImportScreen } from './features/import/ImportScreen';
import { EntryScreen } from './features/projects/EntryScreen';
import {
  activeRunStatuses,
  getAnalysisTaskStatusRank,
  type AnalysisTaskItem,
  type SimilarLink,
} from './lib/analysis';
import { downloadExportBundle, jumpToAnchor, sleep } from './lib/utils';
import {
  collectImportQueueItems,
  createImportQueueItemFromFile,
  getUploadedImportItems,
  syncImportQueueWithRecordings,
  type ImportQueueItem,
} from './lib/importQueue';
import { loadAppPreferences, saveAppPreferences, type AppPreferences } from './lib/appPreferences';
import {
  areRunSettingsEqual,
  clampRunSettingsForRecording,
  defaultRunSettings,
  enforceLocalOcrAvailability,
  getProjectPresetStorageKey,
  loadGlobalRunPreset,
  loadProjectRunPreset,
  parseRunPresetText,
  persistGlobalRunPreset,
  persistProjectRunPreset,
  sanitizeRunSettings,
  serializeRunPresetText,
} from './lib/runSettings';
import { workflowViewportMinimums, type ProjectEntryTarget, type WorkflowStage } from './lib/workflow';
import type {
  CandidateFrame,
  CandidateStatus,
  ExportMode,
  GlobalRunPreset,
  HealthResponse,
  Project,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunSettings,
  RunSummary,
} from './types';

type PendingTaskNavigation = {
  anchorId: 'analysis-candidate-review' | 'analysis-run-detail';
  runId: string;
};

function App() {
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
  const [globalPreset, setGlobalPreset] = useState<GlobalRunPreset | null>(() => loadGlobalRunPreset());
  const [projectDefaultSettings, setProjectDefaultSettings] = useState<RunSettings>(defaultRunSettings);
  const [importQueue, setImportQueue] = useState<ImportQueueItem[]>([]);
  const [importSelectionFeedback, setImportSelectionFeedback] = useState('');
  const [previewRecordingId, setPreviewRecordingId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [analysisActionMessage, setAnalysisActionMessage] = useState('');
  const [appError, setAppError] = useState('');
  const [dismissedOcrWarningsKey, setDismissedOcrWarningsKey] = useState<string | null>(null);
  const [bulkDeletePending, setBulkDeletePending] = useState(false);
  const [bulkExportPending, setBulkExportPending] = useState(false);
  const [appPrefs, setAppPrefs] = useState<AppPreferences>(() => loadAppPreferences());
  const [showSettings, setShowSettings] = useState(false);
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
  const ocrStatus = healthQuery.data?.ocr_status ?? null;
  const ocrAvailability = healthQuery.data?.ocr_available;
  const ocrStatusMessage = backendReady ? healthQuery.data?.ocr_message ?? null : null;
  const ocrWarnings = healthQuery.data?.ocr_warnings ?? [];
  const ocrWarningsKey = ocrWarnings.join('\n');
  const visibleOcrWarnings = ocrWarningsKey && dismissedOcrWarningsKey === ocrWarningsKey ? [] : ocrWarnings;
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
    queryFn: () => getRun(selectedRunId as string),
    enabled: Boolean(selectedRunId),
    refetchInterval: (query) => {
      const run = query.state.data as RunDetail | undefined;
      return run && activeRunStatuses.includes(run.summary.status) ? 2000 : false;
    },
  });

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
      setProjectDefaultSettings(defaultRunSettings);
      setSettingsFeedback('');
      setImportQueue([]);
      setImportSelectionFeedback('');
      setPendingAnalysisProjectId(null);
      setPreviewRecordingId(null);
      setWorkflowStage('projects');
      return;
    }

    const projectPreset = loadProjectRunPreset(selectedProjectId);
    const nextSettings = applyLocalOcrAvailability(projectPreset?.settings ?? globalPreset?.settings ?? defaultRunSettings);
    setProjectDefaultSettings(nextSettings);
    setRunSettings(nextSettings);
    setSettingsFeedback('');
  }, [globalPreset?.settings, selectedProjectId]);

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
    setImportQueue((current) => syncImportQueueWithRecordings(current, projectDetailQuery.data?.recordings ?? []));
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

  useEffect(() => {
    if (!selectedRunId || !runDetailQuery.data) {
      return;
    }
    if (!activeRunStatuses.includes(runDetailQuery.data.summary.status)) {
      setLiveMessage('');
      return;
    }

    const recordingId = runDetailQuery.data.summary.recording_id;
    const socketUrl = new URL(`/runs/${selectedRunId}/events`, import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000')
      .toString()
      .replace(/^http/, 'ws');
    const socket = new WebSocket(socketUrl);

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { message?: string };
      if (payload.message) {
        setLiveMessage(payload.message);
      }
      void refreshRunQueries(selectedRunId, recordingId);
    };

    socket.onclose = () => {
      setLiveMessage('');
      void refreshRunQueries(selectedRunId, recordingId);
    };

    socket.onerror = () => {
      setLiveMessage('Live progress connection dropped. Polling will continue.');
    };

    return () => socket.close();
  }, [runDetailQuery.data, selectedRunId]);

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
  const viewportMinimum = workflowViewportMinimums[activeViewportStage];
  const isViewportTooSmall =
    viewportSize.width < viewportMinimum.width || viewportSize.height < viewportMinimum.height;
  const viewportWarning = isViewportTooSmall ? (
    <ViewportWarning
      currentHeight={viewportSize.height}
      currentWidth={viewportSize.width}
      minimumHeight={viewportMinimum.height}
      minimumWidth={viewportMinimum.width}
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
    () => clampRunSettingsForRecording(applyLocalOcrAvailability(projectDefaultSettings), selectedRecordingSummary?.fps ?? null),
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
  const canCompleteImport = uploadedImportItems.length > 0;
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
    setRunSettings((current) => {
      const nextSettings = clampRunSettingsForRecording(current, selectedRecordingSummary?.fps ?? null);
      return areRunSettingsEqual(current, nextSettings) ? current : nextSettings;
    });
  }, [selectedRecordingSummary?.fps, runSettings.allow_high_fps_sampling]);

  useEffect(() => {
    if (!appPrefs.enableV1Engine && runSettings.analysis_engine === 'scene_v1') {
      setRunSettings((current) =>
        sanitizeRunSettings({ ...current, analysis_engine: 'hybrid_v2', advanced: current.advanced ?? null }),
      );
    }
  }, [appPrefs.enableV1Engine, runSettings.analysis_engine]);

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
        label: `Returns to ${target.step_id}`,
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
    mutationFn: ({ name, projectId }: { name: string; projectId: string }) => updateProject(projectId, name),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const deleteProjectMutation = useMutation({
    mutationFn: ({ projectId }: { projectId: string }) => deleteProject(projectId),
    onSuccess: (_result, variables) => {
      window.localStorage.removeItem(getProjectPresetStorageKey(variables.projectId));
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
    mutationFn: ({ file, filename, projectId }: { file: File; filename?: string; localId?: string; projectId: string }) =>
      importRecording(projectId, file, filename),
    onSuccess: (recording, variables) => {
      if (variables.localId) {
        setImportQueue((current) =>
          current.map((item) =>
            item.localId === variables.localId
              ? {
                  ...item,
                  filename: recording.filename,
                  file: null,
                  status: 'uploaded',
                  recordingId: recording.id,
                  error: null,
                  signature: null,
                }
              : item,
          ),
        );
      }
      setSelectedRecordingId(recording.id);
      setSelectedRunId(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', recording.project_id] });
      queryClient.invalidateQueries({ queryKey: ['recording', recording.id] });
    },
    onError: (error: Error, variables) => {
      setAppError(error.message);
      if (variables.localId) {
        setImportQueue((current) =>
          current.map((item) =>
            item.localId === variables.localId
              ? {
                  ...item,
                  status: 'error',
                  error: error.message,
                }
              : item,
          ),
        );
      }
    },
  });

  const updateRecordingMutation = useMutation({
    mutationFn: ({ filename, recordingId }: { filename: string; recordingId: string }) =>
      updateRecording(recordingId, filename),
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
    mutationFn: ({ candidateId, payload }: { candidateId: string; payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>> }) =>
      updateCandidate(candidateId, payload),
    onSuccess: (candidate) => {
      void refreshRunQueries(candidate.run_id, candidate.recording_id);
    },
    onError: (error: Error) => setAppError(error.message),
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

  function handleSaveProjectDefault() {
    if (!selectedProjectId) {
      return;
    }
    const savedPreset = persistProjectRunPreset(selectedProjectId, applyLocalOcrAvailability(runSettings));
    setProjectDefaultSettings(savedPreset.settings);
    setSettingsFeedback('saved the current settings for this project.');
  }

  function handleSaveBrowserDefault() {
    const savedPreset = persistGlobalRunPreset(applyLocalOcrAvailability(runSettings));
    setGlobalPreset(savedPreset);
    setSettingsFeedback('saved the current settings as universal defaults.');
  }

  function applyAnalysisSettings(nextSettings: RunSettings, feedback: string) {
    setRunSettings(clampRunSettingsForRecording(sanitizeRunSettings(applyLocalOcrAvailability(nextSettings)), selectedRecordingSummary?.fps ?? null));
    setSettingsFeedback(feedback);
  }

  function handleResetToProjectDefaults() {
    applyAnalysisSettings(effectiveProjectDefaultSettings, "reset the current settings to this project's defaults.");
  }

  function handleResetToUniversalDefaults() {
    applyAnalysisSettings(globalPreset?.settings ?? defaultRunSettings, 'reset the current settings to the universal defaults.');
  }

  function handleApplyImportedPreset(settings: RunSettings) {
    applyAnalysisSettings(settings, 'applied preset text to the active analysis parameters.');
  }

  async function handleCreateManualRunCandidate(runId: string, timestampMs: number) {
    clearAnalysisMessages();
    return createManualCandidateMutation.mutateAsync({ runId, timestampMs });
  }

  function confirmDeleteRecording(recordingId: string, filename: string) {
    if (!window.confirm(`delete ${filename} and every run, screenshot, and export created from it?`)) {
      return;
    }
    clearAnalysisMessages();
    deleteRecordingMutation.mutate({ recordingId });
  }

  function confirmDeleteProject(projectId: string, projectName: string) {
    if (!window.confirm(`delete ${projectName} and every recording, run, screenshot, and export in it?`)) {
      return;
    }
    clearAnalysisMessages();
    deleteProjectMutation.mutate({ projectId });
  }

  async function handleRenameProject(projectId: string, name: string) {
    clearAnalysisMessages();
    await updateProjectMutation.mutateAsync({ name, projectId });
  }

  async function handleRenameRecording(recordingId: string, filename: string) {
    clearAnalysisMessages();
    await updateRecordingMutation.mutateAsync({ filename, recordingId });
  }

  async function handleRenameImportItem(localId: string, filename: string) {
    const queueItem = importQueue.find((item) => item.localId === localId);
    if (!queueItem) {
      return;
    }

    if (queueItem.recordingId) {
      await handleRenameRecording(queueItem.recordingId, filename);
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

    handleNavigateToAnalysis(true);
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
    const { ignoredCount, queueItems } = collectImportQueueItems(importQueue, files);
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

    const { ignoredCount, queueItems } = collectImportQueueItems(importQueue, files);
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

    setImportQueue((current) => [
      ...current,
      ...queueItems.map((item) => ({
        ...item,
        status: 'uploading' as const,
        error: null,
      })),
    ]);

    setAnalysisActionMessage(
      `importing ${queueItems.length} ${queueItems.length === 1 ? 'video' : 'videos'}${
        ignoredCount > 0
          ? ` · ignored ${ignoredCount} duplicate ${ignoredCount === 1 ? 'file' : 'files'}`
          : ''
      }.`,
    );

    queueItems.forEach((item) => {
      if (!item.file) {
        return;
      }
      importRecordingMutation.mutate({
        projectId: selectedProjectId,
        file: item.file,
        filename: item.filename,
        localId: item.localId,
      });
    });
  }

  function handleUploadImportItem(localId: string) {
    if (!selectedProjectId) {
      return;
    }
    const queueItem = importQueue.find((item) => item.localId === localId);
    if (!queueItem?.file || queueItem.status === 'uploading') {
      return;
    }

    clearAnalysisMessages();
    setImportQueue((current) =>
      current.map((item) =>
        item.localId === localId
          ? {
              ...item,
              status: 'uploading',
              error: null,
            }
          : item,
      ),
    );
    importRecordingMutation.mutate({
      projectId: selectedProjectId,
      file: queueItem.file,
      filename: queueItem.filename,
      localId,
    });
  }

  function handleDeleteImportItem(localId: string) {
    const queueItem = importQueue.find((item) => item.localId === localId);
    if (!queueItem || queueItem.status === 'uploading') {
      return;
    }
    if (queueItem.recordingId) {
      if (!window.confirm(`delete ${queueItem.filename} and every run, screenshot, and export created from it?`)) {
        return;
      }
      deleteRecordingMutation.mutate({ localId, recordingId: queueItem.recordingId });
      return;
    }
    setImportQueue((current) => current.filter((item) => item.localId !== localId));
  }

  function handleNavigateToAnalysis(promptWhenEmpty: boolean) {
    if (!selectedProjectId) {
      return;
    }
    const uploadedRows = getUploadedImportItems(importQueue);
    if (!uploadedRows.length) {
      if (!promptWhenEmpty) {
        return;
      }
      const confirmed = window.confirm(
        'analysis is usually most useful after at least one uploaded video. continue without any uploaded videos?',
      );
      if (!confirmed) {
        return;
      }
    }

    const persistedRows = uploadedRows;
    const nextRecordingId =
      persistedRows[persistedRows.length - 1]?.recordingId ?? projectDetailQuery.data?.recordings[0]?.id ?? null;
    setPendingAnalysisProjectId(null);
    setImportQueue(persistedRows);
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

    const results = await Promise.allSettled(
      uniqueCandidateIds.map((candidateId) => updateCandidate(candidateId, { status })),
    );
    const failedCandidateIds: string[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        return;
      }
      failedCandidateIds.push(uniqueCandidateIds[index]);
    });

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
        `Could not update ${
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
          const runDetail = await getRun(item.run.id);
          const hasReviewedItems = runDetail.candidates.some((candidate) => candidate.status !== 'pending');
          const hasAcceptedItems = runDetail.candidates.some((candidate) => candidate.status === 'accepted');

          if (hasReviewedItems && !hasAcceptedItems) {
            throw new Error('This reviewed task has no accepted candidates to export.');
          }

          const exportMode: ExportMode = hasReviewedItems ? 'accepted' : 'all';
          const bundle = await exportRun(item.run.id, exportMode);
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
    if (!window.confirm(confirmCopy)) {
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

  if (workflowStage === 'projects' || !hasSelectedProject) {
    return (
      <>
        <EntryScreen
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
        <AppWatermark onOpenSettings={() => setShowSettings(true)} />
        <AppSettings
          healthData={healthQuery.data}
          isRecheckingOcr={recheckOcrMutation.isPending}
          isResettingDatabase={resetDatabaseMutation.isPending}
          open={showSettings}
          prefs={appPrefs}
          onChangePref={updateAppPref}
          onClose={() => setShowSettings(false)}
          onRecheckOcr={() => recheckOcrMutation.mutate()}
          onResetDatabase={() => resetDatabaseMutation.mutate()}
        />
        {appPrefs.showPerfMonitor && <PerformanceMonitor />}
        {viewportWarning}
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
          onUploadRow={handleUploadImportItem}
          project={activeProject}
          rows={importQueue}
          selectionFeedback={importSelectionFeedback}
        />
        <AppWatermark onOpenSettings={() => setShowSettings(true)} />
        <AppSettings
          healthData={healthQuery.data}
          isRecheckingOcr={recheckOcrMutation.isPending}
          isResettingDatabase={resetDatabaseMutation.isPending}
          open={showSettings}
          prefs={appPrefs}
          onChangePref={updateAppPref}
          onClose={() => setShowSettings(false)}
          onRecheckOcr={() => recheckOcrMutation.mutate()}
          onResetDatabase={() => resetDatabaseMutation.mutate()}
        />
        {appPrefs.showPerfMonitor && <PerformanceMonitor />}
        {viewportWarning}
      </>
    );
  }

  return (
    <>
      <AnalysisScreen
        acceptedStepSimilarityLinks={acceptedStepSimilarityLinks}
        abortRunPending={abortRunMutation.isPending}
        activeProject={activeProject}
        analysisActionMessage={analysisActionMessage}
        analysisTaskItems={analysisTaskItems}
        appError={appError}
        bulkDeletePending={bulkDeletePending}
        bulkExportPending={bulkExportPending}
        candidateSimilarityLinks={candidateSimilarityLinks}
        createManualCandidatePending={createManualCandidateMutation.isPending}
        createRunPending={createRunMutation.isPending}
        exportRunPending={exportRunMutation.isPending}
        healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
        healthWarning={Boolean(healthWarning)}
        liveMessage={liveMessage}
        onAbortRun={(runId) => abortRunMutation.mutate(runId)}
        onApplyImportedPreset={handleApplyImportedPreset}
        onBulkUpdateCandidates={handleBulkUpdateCandidates}
        onCreateManualCandidate={handleCreateManualRunCandidate}
        onDeleteRecording={confirmDeleteRecording}
        onDropFiles={handleQuickImportDrop}
        onDeleteSelectedRuns={handleDeleteSelectedRuns}
        onExportRun={handleExportRun}
        onExportTaskRuns={handleExportTaskRuns}
        onJumpToSelection={handleJumpToAnalysisSelection}
        onNavigateStage={setProjectStage}
        onPreviewRecording={handlePreviewRecording}
        onRenameProject={handleRenameProject}
        onRenameRecording={handleRenameRecording}
        onResetToProjectDefaults={handleResetToProjectDefaults}
        onResetToUniversalDefaults={handleResetToUniversalDefaults}
        onSaveProjectPreset={handleSaveProjectDefault}
        onSaveUniversalPreset={handleSaveBrowserDefault}
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
        enableV1Engine={appPrefs.enableV1Engine}
        showPresetText={presetText}
      />
      <AppWatermark onOpenSettings={() => setShowSettings(true)} />
      <AppSettings
        healthData={healthQuery.data}
        isRecheckingOcr={recheckOcrMutation.isPending}
        isResettingDatabase={resetDatabaseMutation.isPending}
        open={showSettings}
        prefs={appPrefs}
        onChangePref={updateAppPref}
        onClose={() => setShowSettings(false)}
        onRecheckOcr={() => recheckOcrMutation.mutate()}
        onResetDatabase={() => resetDatabaseMutation.mutate()}
      />
      {appPrefs.showPerfMonitor && <PerformanceMonitor />}
      {viewportWarning}
    </>
  );
}

export default App;
