import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  API_BASE,
  absoluteApiUrl,
  abortRun,
  createProject,
  createRun,
  deleteRecording,
  deleteRun,
  dismissFallback,
  exportRun,
  getProject,
  getRecording,
  getRun,
  health,
  importRecording,
  listProjects,
  startFallback,
  updateCandidate,
} from './api';
import type {
  CandidateFrame,
  CandidateStatus,
  GlobalRunPreset,
  Project,
  ProjectRunPreset,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunPhase,
  RunSettings,
  RunSummary,
} from './types';

const defaultRunSettings: RunSettings = {
  tolerance: 50,
  min_scene_gap_ms: 900,
  sample_fps: 4,
  detector_mode: 'content',
  extract_offset_ms: 200,
};

const PRESET_STORAGE_VERSION = 1;
const GLOBAL_PRESET_STORAGE_KEY = 'stepthrough.run-preset.global.v1';
const PROJECT_PRESET_STORAGE_KEY_PREFIX = 'stepthrough.run-preset.project.v1';

type SettingsSource = 'project' | 'browser' | 'app';
type SimilarLink = { targetId: string; label: string };
type WorkflowStage = 'projects' | 'import' | 'analysis';
type ImportQueueStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

interface ImportQueueItem {
  localId: string;
  filename: string;
  file: File | null;
  status: ImportQueueStatus;
  recordingId: string | null;
  error: string | null;
  signature: string | null;
}

interface AnalysisTaskItem {
  recording: RecordingSummary;
  run: RunSummary;
}

type AnalysisHintKey =
  | 'detector_mode'
  | 'extract_offset_ms'
  | 'load'
  | 'min_scene_gap_ms'
  | 'reset'
  | 'run'
  | 'sample_fps'
  | 'save'
  | 'tolerance';

const workflowStages: WorkflowStage[] = ['projects', 'import', 'analysis'];
const activeRunStatuses: RunSummary['status'][] = ['queued', 'running'];
const analysisResetStarPoints = Array.from({ length: 34 }, (_value, index) => {
  const angle = -Math.PI / 2 + (Math.PI * index) / 17;
  const radiusX = index % 2 === 0 ? 43 : 35;
  const radiusY = index % 2 === 0 ? 16 : 12;
  const x = 46 + Math.cos(angle) * radiusX;
  const y = 16 + Math.sin(angle) * radiusY;
  return `${x.toFixed(2)},${y.toFixed(2)}`;
}).join(' ');

const phaseLabels: Record<RunPhase, string> = {
  queued: 'Queued',
  probing: 'Preparing',
  primary_scan: 'Primary scan',
  primary_extract: 'Primary extract',
  awaiting_fallback: 'Awaiting fallback',
  fallback_scan: 'Fallback scan',
  fallback_extract: 'Fallback extract',
  exporting: 'Exporting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Aborted',
};

function sanitizeRunSettings(settings?: Partial<RunSettings> | null): RunSettings {
  const tolerance = typeof settings?.tolerance === 'number' ? Math.min(100, Math.max(0, Math.round(settings.tolerance))) : defaultRunSettings.tolerance;
  const minSceneGap = typeof settings?.min_scene_gap_ms === 'number' ? Math.max(0, Math.round(settings.min_scene_gap_ms)) : defaultRunSettings.min_scene_gap_ms;
  const sampleFps =
    typeof settings?.sample_fps === 'number' && Number.isFinite(settings.sample_fps) && settings.sample_fps > 0
      ? Math.max(1, Math.round(settings.sample_fps))
      : null;
  const detectorMode = settings?.detector_mode === 'adaptive' ? 'adaptive' : 'content';
  const extractOffset =
    typeof settings?.extract_offset_ms === 'number' ? Math.max(0, Math.round(settings.extract_offset_ms)) : defaultRunSettings.extract_offset_ms;

  return {
    tolerance,
    min_scene_gap_ms: minSceneGap,
    sample_fps: sampleFps,
    detector_mode: detectorMode,
    extract_offset_ms: extractOffset,
  };
}

function getProjectPresetStorageKey(projectId: string): string {
  return `${PROJECT_PRESET_STORAGE_KEY_PREFIX}.${projectId}`;
}

function readStoredJson<T>(key: string): T | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const rawValue = window.localStorage.getItem(key);
    if (!rawValue) {
      return null;
    }
    return JSON.parse(rawValue) as T;
  } catch {
    return null;
  }
}

function loadGlobalRunPreset(): GlobalRunPreset | null {
  const stored = readStoredJson<GlobalRunPreset>(GLOBAL_PRESET_STORAGE_KEY);
  if (!stored || stored.version !== PRESET_STORAGE_VERSION) {
    return null;
  }
  return {
    ...stored,
    settings: sanitizeRunSettings(stored.settings),
  };
}

function loadProjectRunPreset(projectId: string): ProjectRunPreset | null {
  const stored = readStoredJson<ProjectRunPreset>(getProjectPresetStorageKey(projectId));
  if (!stored || stored.version !== PRESET_STORAGE_VERSION || stored.project_id !== projectId) {
    return null;
  }
  return {
    ...stored,
    settings: sanitizeRunSettings(stored.settings),
  };
}

function persistGlobalRunPreset(settings: RunSettings): GlobalRunPreset {
  const preset: GlobalRunPreset = {
    version: PRESET_STORAGE_VERSION,
    settings: sanitizeRunSettings(settings),
    saved_at: new Date().toISOString(),
  };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(GLOBAL_PRESET_STORAGE_KEY, JSON.stringify(preset));
  }
  return preset;
}

function persistProjectRunPreset(projectId: string, settings: RunSettings): ProjectRunPreset {
  const preset: ProjectRunPreset = {
    version: PRESET_STORAGE_VERSION,
    project_id: projectId,
    settings: sanitizeRunSettings(settings),
    saved_at: new Date().toISOString(),
  };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(getProjectPresetStorageKey(projectId), JSON.stringify(preset));
  }
  return preset;
}

function formatDetectorModeLabel(mode: RunSettings['detector_mode']): string {
  return mode === 'adaptive' ? 'Adaptive' : 'Content';
}

function describeTolerance(tolerance: number): string {
  if (tolerance <= 25) {
    return 'Very sensitive. Lower this when keyboard changes, small badges, or brief sheets are being missed.';
  }
  if (tolerance <= 60) {
    return 'Balanced. Good default for most walkthrough recordings. Lower it to catch subtler screens, raise it if typing or scrolling creates noise.';
  }
  return 'Conservative. Raise this when scrolling or tiny motion creates too many candidates. Lower it if real screens are being missed.';
}

function describeSampleFps(sampleFps: number | null): string {
  if (!sampleFps) {
    return 'No custom sampling limit. Raise this when brief overlays, menus, or quick transitions are being missed.';
  }
  if (sampleFps <= 3) {
    return 'Light sampling for faster processing. Increase it for brief overlays, keyboards, or quick menu states.';
  }
  if (sampleFps <= 8) {
    return 'Moderate sampling that works well for most recordings. Raise it if short-lived states are missed, lower it if runs get noisy or slow.';
  }
  return 'Dense sampling for rapid interactions. Lower it if scrolling produces too many near-duplicate candidates or processing becomes heavy.';
}

function describeDetectorMode(mode: RunSettings['detector_mode']): string {
  return mode === 'adaptive'
    ? 'Adaptive is better when scrolling or motion dominates the video. Switch here if movement keeps triggering false scenes.'
    : 'Content is the best starting point for tap-driven UI recordings. Stay here unless scrolling or motion is the main source of noise.';
}

function describeMinSceneGap(minSceneGapMs: number): string {
  if (minSceneGapMs <= 350) {
    return 'Tight spacing. Lower values help catch fast back-to-back screens, but may create more adjacent duplicates.';
  }
  if (minSceneGapMs <= 900) {
    return 'Balanced spacing. Lower it if quick navigation steps are being merged, raise it if scrolling creates clusters of similar screenshots.';
  }
  return 'Wide spacing. Raise this when one interaction produces too many nearby screenshots. Lower it if rapid state changes are being skipped.';
}

function describeExtractOffset(extractOffsetMs: number): string {
  if (extractOffsetMs <= 150) {
    return 'Early capture. Raise this if screenshots are caught mid-animation, blurred, or between interface states.';
  }
  if (extractOffsetMs <= 400) {
    return 'Balanced for most mobile interfaces. Raise it for animations, lower it if brief overlays disappear before capture.';
  }
  return 'Late capture after a detected change. Lower this if short-lived menus, banners, or sheets vanish before the screenshot is taken.';
}

function formatRunSettingsSummary(settings: RunSettings): string {
  return [
    formatDetectorModeLabel(settings.detector_mode),
    `tol ${settings.tolerance}`,
    settings.sample_fps ? `${settings.sample_fps} fps` : 'source fps',
    `gap ${settings.min_scene_gap_ms} ms`,
    `offset ${settings.extract_offset_ms} ms`,
  ].join(' · ');
}

function serializeRunPresetText(settings: RunSettings): string {
  return [
    'Stepthrough Detection Preset',
    `Mode: ${formatDetectorModeLabel(settings.detector_mode)}`,
    `Tolerance: ${settings.tolerance}`,
    `Min scene gap: ${settings.min_scene_gap_ms} ms`,
    `Sample fps: ${settings.sample_fps ?? 'Source stream'}`,
    `Extract offset: ${settings.extract_offset_ms} ms`,
  ].join('\n');
}

function formatPercent(progress: number): string {
  return `${Math.round(progress * 100)}%`;
}

function formatPhase(phase: RunPhase): string {
  return phaseLabels[phase] ?? phase;
}

function formatRunTiming(run: RunSummary): string {
  if (run.status === 'completed' && run.completed_at) {
    return `Finished ${new Date(run.completed_at).toLocaleString()}`;
  }
  if (run.status === 'cancelled' && run.completed_at) {
    return `Aborted ${new Date(run.completed_at).toLocaleString()}`;
  }
  if (run.status === 'failed' && run.completed_at) {
    return `Failed ${new Date(run.completed_at).toLocaleString()}`;
  }
  if (run.started_at) {
    return `Started ${new Date(run.started_at).toLocaleString()}`;
  }
  return `Created ${new Date(run.created_at).toLocaleString()}`;
}

function formatProjectActivity(lastActivityAt: string): string {
  const timestamp = new Date(lastActivityAt).getTime();
  if (Number.isNaN(timestamp)) {
    return lastActivityAt;
  }

  const diffMs = Date.now() - timestamp;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const monthMs = 30 * dayMs;

  if (diffMs <= 0) {
    return 'now';
  }
  if (diffMs < dayMs) {
    return `${Math.max(1, Math.floor(diffMs / hourMs))}h`;
  }
  if (diffMs < monthMs) {
    return `${Math.max(1, Math.floor(diffMs / dayMs))}d`;
  }
  if (diffMs < 6 * monthMs) {
    return `${Math.max(1, Math.floor(diffMs / monthMs))}mo`;
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatProjectSummary(project: Project): string {
  const videoLabel = `${project.recording_count} ${project.recording_count === 1 ? 'video' : 'videos'}`;
  const runLabel = `${project.run_count} ${project.run_count === 1 ? 'run' : 'runs'}`;
  return `${videoLabel} • ${runLabel} • ${formatProjectActivity(project.last_activity_at)}`;
}

function formatProjectCounts(project: Project): string {
  const videoLabel = `${project.recording_count} ${project.recording_count === 1 ? 'video' : 'videos'}`;
  const runLabel = `${project.run_count} ${project.run_count === 1 ? 'run' : 'runs'}`;
  return `${videoLabel} • ${runLabel}`;
}

function jumpToAnchor(anchorId: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const target = document.getElementById(anchorId);
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  target.focus({ preventScroll: true });
}

function createLocalId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

function clampInteger(value: number, min?: number, max?: number): number {
  let nextValue = Math.round(value);
  if (typeof min === 'number') {
    nextValue = Math.max(min, nextValue);
  }
  if (typeof max === 'number') {
    nextValue = Math.min(max, nextValue);
  }
  return nextValue;
}

function triggerDownload(url: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function buildImportFileSignature(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function createImportQueueItemFromFile(file: File): ImportQueueItem {
  return {
    localId: createLocalId('upload'),
    filename: file.name,
    file,
    status: 'pending',
    recordingId: null,
    error: null,
    signature: buildImportFileSignature(file),
  };
}

function createImportQueueItemFromRecording(recording: RecordingSummary): ImportQueueItem {
  return {
    localId: `recording-${recording.id}`,
    filename: recording.filename,
    file: null,
    status: 'uploaded',
    recordingId: recording.id,
    error: null,
    signature: null,
  };
}

function syncImportQueueWithRecordings(current: ImportQueueItem[], recordings: RecordingSummary[]): ImportQueueItem[] {
  const recordingsById = new Map(recordings.map((recording) => [recording.id, recording]));
  const seenRecordingIds = new Set<string>();
  const nextQueue: ImportQueueItem[] = [];

  current.forEach((item) => {
    if (!item.recordingId) {
      nextQueue.push(item);
      return;
    }

    const recording = recordingsById.get(item.recordingId);
    if (!recording) {
      return;
    }

    seenRecordingIds.add(recording.id);
    nextQueue.push({
      ...createImportQueueItemFromRecording(recording),
      localId: item.localId,
    });
  });

  recordings.forEach((recording) => {
    if (!seenRecordingIds.has(recording.id)) {
      nextQueue.push(createImportQueueItemFromRecording(recording));
    }
  });

  return nextQueue;
}

function getUploadedImportItems(queue: ImportQueueItem[]): ImportQueueItem[] {
  return queue.filter((item) => item.status === 'uploaded' && Boolean(item.recordingId));
}

function getAnalysisTaskStatusRank(status: RunSummary['status']): number {
  if (status === 'running') {
    return 0;
  }
  if (status === 'queued') {
    return 1;
  }
  if (status === 'awaiting_fallback') {
    return 2;
  }
  if (status === 'completed') {
    return 3;
  }
  if (status === 'failed') {
    return 4;
  }
  return 5;
}

function App() {
  const queryClient = useQueryClient();
  const [projectName, setProjectName] = useState('');
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>('projects');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runSettings, setRunSettings] = useState<RunSettings>(defaultRunSettings);
  const [settingsSource, setSettingsSource] = useState<SettingsSource>('app');
  const [settingsFeedback, setSettingsFeedback] = useState('');
  const [globalPreset, setGlobalPreset] = useState<GlobalRunPreset | null>(() => loadGlobalRunPreset());
  const [importQueue, setImportQueue] = useState<ImportQueueItem[]>([]);
  const [previewRecordingId, setPreviewRecordingId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState<string>('');
  const [analysisActionMessage, setAnalysisActionMessage] = useState<string>('');
  const [appError, setAppError] = useState<string>('');
  const [bulkDeletePending, setBulkDeletePending] = useState(false);
  const [bulkExportPending, setBulkExportPending] = useState(false);
  const isHydratingProjectSettingsRef = useRef(false);
  const hydratedProjectIdRef = useRef<string | null>(null);
  const hydratedSettingsSignatureRef = useRef<string | null>(null);

  const healthQuery = useQuery({ queryKey: ['health'], queryFn: health, refetchInterval: 30_000 });
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: listProjects });
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
      isHydratingProjectSettingsRef.current = false;
      hydratedProjectIdRef.current = null;
      hydratedSettingsSignatureRef.current = null;
      setRunSettings(defaultRunSettings);
      setSettingsSource(globalPreset ? 'browser' : 'app');
      setSettingsFeedback('');
      setImportQueue([]);
      setPreviewRecordingId(null);
      setWorkflowStage('projects');
      return;
    }

    const projectPreset = loadProjectRunPreset(selectedProjectId);
    const nextSettings = projectPreset?.settings ?? globalPreset?.settings ?? defaultRunSettings;
    isHydratingProjectSettingsRef.current = true;
    hydratedProjectIdRef.current = selectedProjectId;
    hydratedSettingsSignatureRef.current = JSON.stringify(nextSettings);
    setRunSettings(nextSettings);
    setSettingsSource(projectPreset ? 'project' : globalPreset ? 'browser' : 'app');
    setSettingsFeedback('');
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    const currentSignature = JSON.stringify(runSettings);
    if (isHydratingProjectSettingsRef.current) {
      if (hydratedProjectIdRef.current === selectedProjectId && hydratedSettingsSignatureRef.current === currentSignature) {
        isHydratingProjectSettingsRef.current = false;
        hydratedProjectIdRef.current = null;
        hydratedSettingsSignatureRef.current = null;
      }
      return;
    }

    persistProjectRunPreset(selectedProjectId, runSettings);
    setSettingsSource('project');
  }, [runSettings, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    setImportQueue((current) => syncImportQueueWithRecordings(current, projectDetailQuery.data?.recordings ?? []));
  }, [projectDetailQuery.data?.recordings, selectedProjectId]);

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
    const runs = recordingDetailQuery.data?.runs ?? [];
    const stillSelected = runs.some((run) => run.id === selectedRunId);
    if (!stillSelected) {
      setSelectedRunId(null);
    }
  }, [recordingDetailQuery.data, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || !runDetailQuery.data) {
      return;
    }
    if (!activeRunStatuses.includes(runDetailQuery.data.summary.status)) {
      return;
    }

    const socketUrl = new URL(`/runs/${selectedRunId}/events`, API_BASE).toString().replace(/^http/, 'ws');
    const socket = new WebSocket(socketUrl);

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { message?: string };
      if (payload.message) {
        setLiveMessage(payload.message);
      }
      queryClient.invalidateQueries({ queryKey: ['run', selectedRunId] });
      queryClient.invalidateQueries({ queryKey: ['recording', selectedRecordingId] });
    };

    socket.onerror = () => {
      setLiveMessage('Live progress connection dropped. Polling will continue.');
    };

    return () => socket.close();
  }, [queryClient, runDetailQuery.data, selectedRecordingId, selectedRunId]);

  const createProjectMutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      setProjectName('');
      enterProject(project.id);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const importRecordingMutation = useMutation({
    mutationFn: ({ projectId, file }: { file: File; localId?: string; projectId: string }) => importRecording(projectId, file),
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

  const deleteRecordingMutation = useMutation({
    mutationFn: ({ recordingId }: { localId?: string; recordingId: string }) => deleteRecording(recordingId),
    onSuccess: (_result, variables) => {
      setImportQueue((current) => current.filter((item) => item.localId !== variables.localId && item.recordingId !== variables.recordingId));
      if (selectedRecordingId === variables.recordingId) {
        setSelectedRecordingId(null);
        setSelectedRunId(null);
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] });
      queryClient.removeQueries({ queryKey: ['recording', variables.recordingId] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const createRunMutation = useMutation({
    mutationFn: ({ recordingId, settings }: { recordingId: string; settings: RunSettings }) => createRun(recordingId, settings),
    onSuccess: (run) => {
      setSelectedRunId(run.id);
      setLiveMessage('Queued detection job.');
      queryClient.invalidateQueries({ queryKey: ['recording', run.recording_id] });
      queryClient.invalidateQueries({ queryKey: ['run', run.id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const abortRunMutation = useMutation({
    mutationFn: abortRun,
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['run', run.id] });
      queryClient.invalidateQueries({ queryKey: ['recording', run.recording_id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const deleteRunMutation = useMutation({
    mutationFn: ({ runId }: { runId: string }) => deleteRun(runId),
    onSuccess: (_result, variables) => {
      if (selectedRunId === variables.runId) {
        setSelectedRunId(null);
      }
      queryClient.invalidateQueries({ queryKey: ['recording', selectedRecordingId] });
      queryClient.removeQueries({ queryKey: ['run', variables.runId] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const startFallbackMutation = useMutation({
    mutationFn: startFallback,
    onSuccess: (run) => {
      setSelectedRunId(run.id);
      queryClient.invalidateQueries({ queryKey: ['run', run.id] });
      queryClient.invalidateQueries({ queryKey: ['recording', run.recording_id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const dismissFallbackMutation = useMutation({
    mutationFn: dismissFallback,
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['run', run.id] });
      queryClient.invalidateQueries({ queryKey: ['recording', run.recording_id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const updateCandidateMutation = useMutation({
    mutationFn: ({ candidateId, payload }: { candidateId: string; payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>> }) =>
      updateCandidate(candidateId, payload),
    onSuccess: (candidate) => {
      queryClient.invalidateQueries({ queryKey: ['run', candidate.run_id] });
      queryClient.invalidateQueries({ queryKey: ['recording', candidate.recording_id] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const exportRunMutation = useMutation({
    mutationFn: exportRun,
    onSuccess: (_bundle, runId) => {
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const selectedProject = useMemo(() => {
    return projectsQuery.data?.find((project) => project.id === selectedProjectId) ?? null;
  }, [projectsQuery.data, selectedProjectId]);
  const activeProject = projectDetailQuery.data?.project ?? selectedProject;
  const hasSelectedProject = Boolean(selectedProjectId);

  const selectedRecording = recordingDetailQuery.data ?? null;
  const selectedRun = runDetailQuery.data ?? null;
  const selectedRecordingSummary = projectRecordings.find((recording) => recording.id === selectedRecordingId) ?? null;
  const previewRecording = projectRecordings.find((recording) => recording.id === previewRecordingId) ?? null;
  const healthWarning = healthQuery.data && healthQuery.data.missing_tools.length > 0;
  const presetText = useMemo(() => serializeRunPresetText(runSettings), [runSettings]);
  const uploadedImportItems = useMemo(() => getUploadedImportItems(importQueue), [importQueue]);
  const canCompleteImport = uploadedImportItems.length > 0;
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
  const analysisTaskItemByRunId = useMemo(() => {
    return new Map(analysisTaskItems.map((item) => [item.run.id, item]));
  }, [analysisTaskItems]);
  const candidateSimilarityLinks = useMemo(() => {
    const links = new Map<string, SimilarLink>();
    if (!selectedRun) {
      return links;
    }

    const candidatesById = new Map(selectedRun.candidates.map((candidate) => [candidate.id, candidate]));
    const firstCandidateByGroup = new Map<string, CandidateFrame>();

    selectedRun.candidates.forEach((candidate) => {
      const directTarget = candidate.similar_to_candidate_id ? candidatesById.get(candidate.similar_to_candidate_id) : null;
      const groupedTarget = !directTarget && candidate.revisit_group_id ? firstCandidateByGroup.get(candidate.revisit_group_id) : null;
      const target = directTarget ?? groupedTarget;

      if (target && target.id !== candidate.id) {
        links.set(candidate.id, {
          targetId: `candidate-${target.id}`,
          label: `Similar to candidate ${target.detector_index}`,
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

  function enterProject(projectId: string) {
    setSelectedProjectId(projectId);
    setSelectedRecordingId(null);
    setSelectedRunId(null);
    setWorkflowStage('import');
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
    createRunMutation.mutate({ recordingId: selectedRecordingId, settings: runSettings });
  }

  function handleSaveBrowserDefault() {
    const savedPreset = persistGlobalRunPreset(runSettings);
    setGlobalPreset(savedPreset);
    setSettingsFeedback('Saved the current settings as your browser default preset.');
  }

  function handleResetToBrowserDefault() {
    if (!globalPreset) {
      return;
    }
    setRunSettings(globalPreset.settings);
    setSettingsFeedback('Reset the current project to your browser default preset.');
  }

  function handleResetToAppDefaults() {
    setRunSettings({ ...defaultRunSettings });
    setSettingsFeedback('Reset the current project to the built-in defaults.');
  }

  function confirmDeleteRecording(recordingId: string, filename: string) {
    if (!window.confirm(`Delete ${filename} and every run, screenshot, and export created from it?`)) {
      return;
    }
    deleteRecordingMutation.mutate({ recordingId });
  }

  function setProjectStage(stage: WorkflowStage) {
    if (stage === 'projects') {
      setWorkflowStage('projects');
      return;
    }
    if (stage === 'import') {
      if (!selectedProjectId) {
        return;
      }
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
    jumpToAnalysisAnchor(anchorId);
  }

  function handleImportFileSelection(files: FileList | File[]) {
    const incomingFiles = Array.from(files);
    if (!incomingFiles.length) {
      return;
    }
    setImportQueue((current) => {
      const knownSignatures = new Set(current.map((item) => item.signature).filter((value): value is string => Boolean(value)));
      const additions = incomingFiles.flatMap((file) => {
        const signature = buildImportFileSignature(file);
        if (knownSignatures.has(signature)) {
          return [];
        }
        knownSignatures.add(signature);
        return [createImportQueueItemFromFile(file)];
      });
      return additions.length ? [...current, ...additions] : current;
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
      localId,
    });
  }

  function handleDeleteImportItem(localId: string) {
    const queueItem = importQueue.find((item) => item.localId === localId);
    if (!queueItem || queueItem.status === 'uploading') {
      return;
    }
    if (queueItem.recordingId) {
      if (!window.confirm(`Delete ${queueItem.filename} and every run, screenshot, and export created from it?`)) {
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
      const confirmed = window.confirm('Analysis is usually most useful after at least one uploaded video. Continue without any uploaded videos?');
      if (!confirmed) {
        return;
      }
    }

    const persistedRows = uploadedRows;
    const nextRecordingId = persistedRows[persistedRows.length - 1]?.recordingId ?? projectDetailQuery.data?.recordings[0]?.id ?? null;
    setImportQueue(persistedRows);
    setSelectedRecordingId(nextRecordingId);
    setSelectedRunId(null);
    setWorkflowStage('analysis');
  }

  function confirmDeleteRun(runId: string) {
    if (!window.confirm('Delete this run and all screenshots and exports created by it?')) {
      return;
    }
    deleteRunMutation.mutate({ runId });
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
          const bundle = await exportRun(item.run.id);
          await queryClient.invalidateQueries({ queryKey: ['run', item.run.id] });
          await queryClient.invalidateQueries({ queryKey: ['recording', item.run.recording_id] });
          triggerDownload(absoluteApiUrl(bundle.zip_url));
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
          `${completedTasks[index].recording.filename}: ${result.reason instanceof Error ? result.reason.message : 'Export failed.'}`,
        );
      });

      if (successCount > 0) {
        const skipSuffix = skippedCount ? ` Skipped ${skippedCount} non-completed ${skippedCount === 1 ? 'task' : 'tasks'}.` : '';
        setAnalysisActionMessage(`Exported ${successCount} ${successCount === 1 ? 'task' : 'tasks'}.${skipSuffix}`);
      }
      if (failures.length > 0) {
        setAppError(`Could not export ${failures.length === 1 ? 'a task' : `${failures.length} tasks`}: ${failures.join(' · ')}`);
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
      ? `Delete ${tasks.length} selected ${tasks.length === 1 ? 'task' : 'tasks'}? ${activeTasks.length} active ${
          activeTasks.length === 1 ? 'task will' : 'tasks will'
        } be ended first, then deleted.`
      : `Delete ${tasks.length} selected ${tasks.length === 1 ? 'task' : 'tasks'}?`;
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
            await queryClient.invalidateQueries({ queryKey: ['run', run.id] });
            await queryClient.invalidateQueries({ queryKey: ['recording', run.recording_id] });
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
            await queryClient.invalidateQueries({ queryKey: ['run', run.summary.id] });
            await queryClient.invalidateQueries({ queryKey: ['recording', run.summary.recording_id] });
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
          }
          await queryClient.invalidateQueries({ queryKey: ['recording', item.run.recording_id] });
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
        setAnalysisActionMessage(`Deleted ${deletedCount} ${deletedCount === 1 ? 'task' : 'tasks'}.`);
      }
      if (failures.length > 0) {
        setAppError(`Could not delete ${failures.length === 1 ? 'a task' : `${failures.length} tasks`}: ${failures.join(' · ')}`);
      }

      return tasks.filter((item) => failedRunIds.has(item.run.id)).map((item) => item.run.id);
    } finally {
      setBulkDeletePending(false);
    }
  }

  const canExport = Boolean(selectedRun && selectedRun.summary.status === 'completed' && selectedRun.accepted_steps.length > 0);

  if (workflowStage === 'projects' || !hasSelectedProject) {
    return (
      <EntryScreen
        appError={appError}
        healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
        isCreating={createProjectMutation.isPending}
        onCreate={handleCreateProject}
        onNavigateStage={setProjectStage}
        onProjectNameChange={setProjectName}
        onSelectProject={enterProject}
        projectName={projectName}
        projects={projectsQuery.data ?? []}
        projectsLoading={projectsQuery.isLoading}
        selectedProjectId={selectedProjectId}
      />
    );
  }

  if (workflowStage === 'import') {
    return (
      <ImportScreen
        appError={appError}
        canComplete={canCompleteImport}
        healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
        isDeleting={deleteRecordingMutation.isPending}
        isUploadBlocked={Boolean(healthWarning)}
        onDeleteRow={handleDeleteImportItem}
        onDone={() => void handleNavigateToAnalysis(false)}
        onFilesSelected={handleImportFileSelection}
        onNavigateStage={setProjectStage}
        onUploadRow={handleUploadImportItem}
        project={activeProject}
        rows={importQueue}
      />
    );
  }

  return (
    <AnalysisScreen
      acceptedStepSimilarityLinks={acceptedStepSimilarityLinks}
      abortRunPending={abortRunMutation.isPending}
      activeProject={activeProject}
      analysisActionMessage={analysisActionMessage}
      analysisTaskItems={analysisTaskItems}
      appError={appError}
      bulkDeletePending={bulkDeletePending}
      bulkExportPending={bulkExportPending}
      canExport={canExport}
      candidateSimilarityLinks={candidateSimilarityLinks}
      canLoadPreset={Boolean(globalPreset)}
      createRunPending={createRunMutation.isPending}
      deleteRunPending={deleteRunMutation.isPending}
      dismissFallbackPending={dismissFallbackMutation.isPending}
      exportRunPending={exportRunMutation.isPending}
      healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
      healthWarning={Boolean(healthWarning)}
      liveMessage={liveMessage}
      onAbortRun={(runId) => abortRunMutation.mutate(runId)}
      onDeleteRecording={confirmDeleteRecording}
      onDeleteRun={confirmDeleteRun}
      onDeleteSelectedRuns={handleDeleteSelectedRuns}
      onDismissFallback={(runId) => dismissFallbackMutation.mutate(runId)}
      onExportRun={(runId) => exportRunMutation.mutate(runId)}
      onExportTaskRuns={handleExportTaskRuns}
      onJumpToSelection={handleJumpToAnalysisSelection}
      onLoadPreset={handleResetToBrowserDefault}
      onNavigateStage={setProjectStage}
      onPreviewRecording={handlePreviewRecording}
      onResetPreset={handleResetToAppDefaults}
      onSavePreset={handleSaveBrowserDefault}
      onSelectRecording={handleSelectRecording}
      onSelectRun={handleSelectTaskRun}
      onStartFallback={(runId) => startFallbackMutation.mutate(runId)}
      onStartRun={handleStartAnalysisRun}
      onUpdateCandidate={(candidateId, payload) => updateCandidateMutation.mutate({ candidateId, payload })}
      previewRecording={previewRecording}
      recordings={projectRecordings}
      selectedRecording={selectedRecording}
      selectedRecordingId={selectedRecordingId}
      selectedRecordingSummary={selectedRecordingSummary}
      selectedRun={selectedRun}
      settingsFeedback={settingsFeedback}
      runSettings={runSettings}
      setRunSettings={setRunSettings}
      showPresetText={presetText}
    />
  );
}

interface EntryScreenProps {
  appError: string;
  healthMessage: string | null;
  isCreating: boolean;
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onProjectNameChange: (value: string) => void;
  onSelectProject: (projectId: string) => void;
  projectName: string;
  projects: Project[];
  projectsLoading: boolean;
  selectedProjectId: string | null;
}

interface StageNavigatorProps {
  activeStage: WorkflowStage;
  className?: string;
  disabledStages?: Partial<Record<WorkflowStage, boolean>>;
  onNavigate: (stage: WorkflowStage) => void;
}

interface ImportScreenProps {
  appError: string;
  canComplete: boolean;
  healthMessage: string | null;
  isDeleting: boolean;
  isUploadBlocked: boolean;
  onDeleteRow: (localId: string) => void;
  onDone: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onUploadRow: (localId: string) => void;
  project: Project | null;
  rows: ImportQueueItem[];
}

interface AnalysisScreenProps {
  acceptedStepSimilarityLinks: Map<string, SimilarLink>;
  abortRunPending: boolean;
  activeProject: Project | null;
  analysisActionMessage: string;
  analysisTaskItems: AnalysisTaskItem[];
  appError: string;
  bulkDeletePending: boolean;
  bulkExportPending: boolean;
  canExport: boolean;
  candidateSimilarityLinks: Map<string, SimilarLink>;
  canLoadPreset: boolean;
  createRunPending: boolean;
  deleteRunPending: boolean;
  dismissFallbackPending: boolean;
  exportRunPending: boolean;
  healthMessage: string | null;
  healthWarning: boolean;
  liveMessage: string;
  onAbortRun: (runId: string) => void;
  onDeleteRecording: (recordingId: string, filename: string) => void;
  onDeleteRun: (runId: string) => void;
  onDeleteSelectedRuns: (runIds: string[]) => Promise<string[] | null>;
  onDismissFallback: (runId: string) => void;
  onExportRun: (runId: string) => void;
  onExportTaskRuns: (runIds: string[]) => Promise<void>;
  onJumpToSelection: () => void;
  onLoadPreset: () => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onPreviewRecording: (recordingId: string) => void;
  onResetPreset: () => void;
  onSavePreset: () => void;
  onSelectRecording: (recordingId: string) => void;
  onSelectRun: (recordingId: string, runId: string, anchorId?: string) => void;
  onStartFallback: (runId: string) => void;
  onStartRun: () => void;
  onUpdateCandidate: (candidateId: string, payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>>) => void;
  previewRecording: RecordingSummary | null;
  recordings: RecordingSummary[];
  runSettings: RunSettings;
  selectedRecording: RecordingDetail | null;
  selectedRecordingId: string | null;
  selectedRecordingSummary: RecordingSummary | null;
  selectedRun: RunDetail | null;
  setRunSettings: React.Dispatch<React.SetStateAction<RunSettings>>;
  settingsFeedback: string;
  showPresetText: string;
}

function StageNavigator({ activeStage, className, disabledStages, onNavigate }: StageNavigatorProps) {
  return (
    <div className={className ? `stage-nav ${className}` : 'stage-nav'}>
      {workflowStages.map((stage) => (
        <button
          aria-current={stage === activeStage ? 'step' : undefined}
          className={`stage-nav-button ${stage === activeStage ? 'active' : ''}`}
          disabled={stage === activeStage || Boolean(disabledStages?.[stage])}
          key={stage}
          onClick={() => onNavigate(stage)}
          type="button"
        >
          {stage}
        </button>
      ))}
    </div>
  );
}

interface AnalysisResetDiamondButtonProps {
  className?: string;
  label: string;
  onClick: () => void;
}

function AnalysisResetDiamondButton({ className, label, onClick }: AnalysisResetDiamondButtonProps) {
  return (
    <button
      aria-label={`Reset ${label} to default`}
      className={className ? `analysis-dirty-reset ${className}` : 'analysis-dirty-reset'}
      onClick={onClick}
      title={`Reset ${label} to default`}
      type="button"
    >
      <span className="analysis-dirty-reset-glyph" />
    </button>
  );
}

interface AnalysisStarResetButtonProps {
  onClick: () => void;
}

function AnalysisStarResetButton({ onClick }: AnalysisStarResetButtonProps) {
  return (
    <button
      aria-label="Reset all analysis parameters to defaults"
      className="analysis-star-reset"
      onClick={onClick}
      title="Reset all analysis parameters to defaults"
      type="button"
    >
      <svg aria-hidden="true" className="analysis-star-reset-shape" viewBox="0 0 92 32">
        <polygon points={analysisResetStarPoints} />
      </svg>
      <span className="analysis-star-reset-label">reset</span>
    </button>
  );
}

interface AnalysisStepperInputProps {
  ariaLabel: string;
  className: string;
  max?: number;
  min?: number;
  onChange: (rawValue: string) => void;
  onStep: (direction: -1 | 1) => void;
  value: number | string;
}

function AnalysisStepperInput({ ariaLabel, className, max, min, onChange, onStep, value }: AnalysisStepperInputProps) {
  return (
    <div className="analysis-stepper-input">
      <div className="analysis-stepper-controls">
        <button
          aria-label={`Increase ${ariaLabel}`}
          className="analysis-stepper-button"
          onClick={() => onStep(1)}
          type="button"
        >
          <span aria-hidden="true" className="analysis-stepper-glyph up" />
        </button>
        <button
          aria-label={`Decrease ${ariaLabel}`}
          className="analysis-stepper-button"
          onClick={() => onStep(-1)}
          type="button"
        >
          <span aria-hidden="true" className="analysis-stepper-glyph down" />
        </button>
      </div>
      <input
        aria-label={ariaLabel}
        className={className}
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        type="number"
        value={value}
      />
    </div>
  );
}

function ImportScreen({
  appError,
  canComplete,
  healthMessage,
  isDeleting,
  isUploadBlocked,
  onDeleteRow,
  onDone,
  onFilesSelected,
  onNavigateStage,
  onUploadRow,
  project,
  rows,
}: ImportScreenProps) {
  return (
    <div className="entry-screen import-screen">
      <div className="entry-shell import-shell">
        <StageNavigator activeStage="import" className="entry-stage-nav" onNavigate={onNavigateStage} />

        {(healthMessage || appError) && (
          <div className="entry-notices">
            {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
            {appError && <p className="entry-notice error">{appError}</p>}
          </div>
        )}

        <div className="import-stage">
          <div className="import-header">
            <div className="import-project-copy">
              <p className="import-project-title">{project ? project.name : 'Loading project…'}</p>
              <p className="import-project-meta">{project ? formatProjectSummary(project) : 'Loading project details…'}</p>
            </div>
            <button className="entry-enter-button import-done-button" disabled={!canComplete} onClick={onDone} type="button">
              done
            </button>
          </div>

          <p className="import-section-title">import videos</p>

          <label
            className={`import-dropzone ${isUploadBlocked ? 'disabled' : ''}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              onFilesSelected(event.dataTransfer.files);
            }}
          >
            <input
              accept="video/*"
              disabled={isUploadBlocked}
              multiple
              onChange={(event) => {
                if (event.target.files) {
                  onFilesSelected(event.target.files);
                }
                event.target.value = '';
              }}
              type="file"
            />
            <span>drag-and-drop your videos here,</span>
            <span>or click it to select your videos.</span>
          </label>

          <div className="import-queue">
            {rows.map((row) => (
              <div className="import-row" key={row.localId}>
                <div className="import-row-copy">
                  <p className="import-row-title">{row.filename}</p>
                  {row.error && <p className="import-row-note error">{row.error}</p>}
                </div>
                <div className="import-row-actions">
                  {row.status === 'uploaded' ? (
                    <span className="import-pill neutral">uploaded</span>
                  ) : row.status === 'uploading' ? (
                    <span className="import-pill neutral muted">uploading...</span>
                  ) : (
                    <button
                      className="import-pill success"
                      disabled={isUploadBlocked}
                      onClick={() => onUploadRow(row.localId)}
                      type="button"
                    >
                      upload
                    </button>
                  )}
                  <button
                    className="import-pill danger import-delete-button"
                    disabled={isDeleting || row.status === 'uploading'}
                    onClick={() => onDeleteRow(row.localId)}
                    type="button"
                  >
                    delete
                  </button>
                </div>
              </div>
            ))}
            {!rows.length && <p className="entry-empty-copy import-empty-copy">Selected and uploaded videos will appear here.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function AnalysisScreen({
  acceptedStepSimilarityLinks,
  abortRunPending,
  activeProject,
  analysisActionMessage,
  analysisTaskItems,
  appError,
  bulkDeletePending,
  bulkExportPending,
  canExport,
  candidateSimilarityLinks,
  canLoadPreset,
  createRunPending,
  deleteRunPending,
  dismissFallbackPending,
  exportRunPending,
  healthMessage,
  healthWarning,
  liveMessage,
  onAbortRun,
  onDeleteRecording,
  onDeleteRun,
  onDeleteSelectedRuns,
  onDismissFallback,
  onExportRun,
  onExportTaskRuns,
  onJumpToSelection,
  onLoadPreset,
  onNavigateStage,
  onPreviewRecording,
  onResetPreset,
  onSavePreset,
  onSelectRecording,
  onSelectRun,
  onStartFallback,
  onStartRun,
  onUpdateCandidate,
  previewRecording,
  recordings,
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
  const [taskSelectMode, setTaskSelectMode] = useState(false);
  const [presetCopyFeedback, setPresetCopyFeedback] = useState('');
  const [showHints, setShowHints] = useState(false);
  const [focusedHintKey, setFocusedHintKey] = useState<AnalysisHintKey | null>(null);
  const [hoveredHintKey, setHoveredHintKey] = useState<AnalysisHintKey | null>(null);
  const [hintCardPosition, setHintCardPosition] = useState<{ left: number; top: number } | null>(null);
  const parameterColumnRef = useRef<HTMLElement | null>(null);

  const previewVideoUrl = previewRecording ? absoluteApiUrl(previewRecording.source_url) : null;
  const exportUrl = selectedRun?.export_bundle ? absoluteApiUrl(selectedRun.export_bundle.zip_url) : null;
  const hintCopy: Record<AnalysisHintKey, string> = {
    detector_mode: describeDetectorMode(runSettings.detector_mode),
    extract_offset_ms: describeExtractOffset(runSettings.extract_offset_ms),
    load: 'Load the browser default preset into the active analysis parameters.',
    min_scene_gap_ms: describeMinSceneGap(runSettings.min_scene_gap_ms),
    reset: 'Reset the current analysis parameters back to the built-in defaults.',
    run: 'Start a new analysis task for the selected video using the current parameter set.',
    sample_fps: describeSampleFps(runSettings.sample_fps),
    save: 'Save the current analysis parameters as your browser default preset for future runs.',
    tolerance: describeTolerance(runSettings.tolerance),
  };
  const activeHintKey = focusedHintKey ?? hoveredHintKey;
  const hintText = showHints && activeHintKey ? hintCopy[activeHintKey] : null;
  const isToleranceDirty = runSettings.tolerance !== defaultRunSettings.tolerance;
  const isMinSceneGapDirty = runSettings.min_scene_gap_ms !== defaultRunSettings.min_scene_gap_ms;
  const isSampleFpsDirty = runSettings.sample_fps !== defaultRunSettings.sample_fps;
  const isExtractOffsetDirty = runSettings.extract_offset_ms !== defaultRunSettings.extract_offset_ms;
  const isDetectorModeDirty = runSettings.detector_mode !== defaultRunSettings.detector_mode;

  useEffect(() => {
    if (!expandedTaskRunId) {
      return;
    }
    if (!analysisTaskItems.some((item) => item.run.id === expandedTaskRunId)) {
      setExpandedTaskRunId(null);
    }
  }, [analysisTaskItems, expandedTaskRunId]);

  useEffect(() => {
    setSelectedTaskRunIds((current) => current.filter((runId) => analysisTaskItems.some((item) => item.run.id === runId)));
  }, [analysisTaskItems]);

  useEffect(() => {
    if (!showHints) {
      setFocusedHintKey(null);
      setHoveredHintKey(null);
      setHintCardPosition(null);
    }
  }, [showHints]);

  useEffect(() => {
    if (!presetCopyFeedback) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => setPresetCopyFeedback(''), 1800);
    return () => globalThis.clearTimeout(timeoutId);
  }, [presetCopyFeedback]);

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
        setHintCardPosition(null);
      },
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        updateHintCardPosition(event.currentTarget);
        setFocusedHintKey(key);
      },
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
        updateHintCardPosition(event.currentTarget);
        setHoveredHintKey(key);
      },
      onMouseLeave: () => {
        setHoveredHintKey((current) => (current === key ? null : current));
        setHintCardPosition(null);
      },
    };
  }

  function toggleTaskSelection(runId: string) {
    setSelectedTaskRunIds((current) => (current.includes(runId) ? current.filter((value) => value !== runId) : [...current, runId]));
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

  function renderTaskRow(item: AnalysisTaskItem) {
    const run = item.run;
    const isExpanded = expandedTaskRunId === run.id;
    const isSelected = selectedRun?.summary.id === run.id;
    const isMarked = selectedTaskRunIds.includes(run.id);
    const isError = run.status === 'failed';
    const isDone = run.status === 'completed';
    const taskSettings = [
      { key: 'tolerance', label: 'tolerance', value: String(run.tolerance), isDirty: run.tolerance !== defaultRunSettings.tolerance },
      {
        key: 'gaps',
        label: 'gaps',
        value: String(run.min_scene_gap_ms),
        isDirty: run.min_scene_gap_ms !== defaultRunSettings.min_scene_gap_ms,
      },
      {
        key: 'fps',
        label: 'fps',
        value: run.sample_fps ? String(run.sample_fps) : 'src',
        valueClassName: 'sample-fps',
        isDirty: run.sample_fps !== defaultRunSettings.sample_fps,
      },
      {
        key: 'offset',
        label: 'offset',
        value: String(run.extract_offset_ms),
        isDirty: run.extract_offset_ms !== defaultRunSettings.extract_offset_ms,
      },
      {
        key: 'mode',
        label: 'mode',
        value: run.detector_mode,
        valueClassName: 'mode',
        isDirty: run.detector_mode !== defaultRunSettings.detector_mode,
      },
    ];
    const progressLabel = isDone
      ? `done${run.candidate_count ? ` • ${run.candidate_count} scenes` : ''}`
      : isError
        ? 'error'
        : run.status === 'cancelled'
          ? 'ended'
          : formatPercent(run.progress);

    const secondaryAction =
      run.is_abortable ? (
        <button className="analysis-task-link danger" onClick={() => onAbortRun(run.id)} type="button">
          end
        </button>
      ) : run.export_bundle_id ? (
        <button className="analysis-task-link subtle" onClick={() => onSelectRun(item.recording.id, run.id, 'analysis-run-detail')} type="button">
          view outputs
        </button>
      ) : ['failed', 'completed', 'cancelled'].includes(run.status) ? (
        <button className="analysis-task-link subtle" onClick={() => onSelectRun(item.recording.id, run.id, 'analysis-run-logs')} type="button">
          view logs
        </button>
      ) : null;

    return (
      <div className={`analysis-task-row ${isSelected ? 'selected' : ''}`} key={run.id}>
        <div className="analysis-task-head">
          <div className="analysis-task-head-primary">
            {taskSelectMode && (
              <label className="analysis-task-select-toggle">
                <input checked={isMarked} onChange={() => toggleTaskSelection(run.id)} type="checkbox" />
                <span className="analysis-task-select-copy">select task</span>
              </label>
            )}
            <button
              className={`analysis-task-title ${isError ? 'error' : ''}`}
              onClick={() => onSelectRun(item.recording.id, run.id, 'analysis-run-detail')}
              type="button"
            >
              {item.recording.filename}
            </button>
          </div>
          <div className="analysis-task-meta">
            <span className={`analysis-task-progress ${isError ? 'error' : isDone ? 'success' : ''}`}>{progressLabel}</span>
            <button
              className={`analysis-task-link ${isExpanded ? 'plain' : ''}`}
              onClick={() => setExpandedTaskRunId((current) => (current === run.id ? null : run.id))}
              type="button"
            >
              details
            </button>
            {secondaryAction}
          </div>
        </div>

        {isExpanded && (
          <>
            <div className="analysis-task-bar" aria-hidden="true">
              <div className="analysis-task-bar-fill" style={{ width: isDone ? '100%' : formatPercent(run.progress) }} />
            </div>
            <div className="analysis-task-settings">
              {taskSettings.map((setting) => (
                <div className={`analysis-task-setting ${setting.key === 'mode' ? 'mode' : ''}`} key={setting.key}>
                  <span className="analysis-task-setting-label">{setting.label}</span>
                  <span
                    className={[
                      'analysis-task-setting-value',
                      setting.valueClassName,
                      setting.isDirty ? 'dirty' : null,
                    ]
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

  return (
    <div className="entry-screen analysis-screen">
      <div className="analysis-stage-shell">
        <div className="analysis-stage-nav">
          <div className="analysis-stage-nav-cell">
            <button className="analysis-nav-button" onClick={() => onNavigateStage('projects')} type="button">
              <span className="analysis-project-path">
                projects/
                <span>{activeProject?.name ?? 'Project'}</span>
              </span>
            </button>
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
          <div className="analysis-notices">
            {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
            {appError && <p className="entry-notice error">{appError}</p>}
            {liveMessage && <p className="entry-notice">{liveMessage}</p>}
            {settingsFeedback && <p className="entry-notice">{settingsFeedback}</p>}
            {analysisActionMessage && <p className="entry-notice">{analysisActionMessage}</p>}
          </div>
        )}

        <div className="analysis-grid">
          <section className="analysis-column">
            <div className="analysis-column-head">
              <p>videos</p>
              <button className="analysis-pill analysis-pill-accent" onClick={onJumpToSelection} type="button">
                jump to selection
              </button>
            </div>
            <div className="analysis-divider" />
            <div className="analysis-videos">
              {recordings.map((recording) => {
                const isSelected = recording.id === selectedRecordingId;
                const isPreviewing = previewRecording?.id === recording.id;
                return (
                  <div className={`analysis-video-row ${isSelected ? 'selected' : ''} ${isPreviewing ? 'previewing' : ''}`} key={recording.id}>
                    <button className="analysis-video-row-button" onClick={() => onSelectRecording(recording.id)} type="button">
                      <span>{recording.filename}</span>
                      <span>{recording.duration_tc}</span>
                    </button>
                    <div className="analysis-video-actions">
                      <button
                        className="analysis-task-link subtle analysis-video-hover-link analysis-video-preview-link"
                        onClick={() => onPreviewRecording(recording.id)}
                        type="button"
                      >
                        {isPreviewing ? 'hide preview' : 'preview'}
                      </button>
                      <button
                        className="analysis-task-link danger analysis-video-hover-link"
                        onClick={() => onDeleteRecording(recording.id, recording.filename)}
                        type="button"
                      >
                        delete
                      </button>
                    </div>
                  </div>
                );
              })}
              {!recordings.length && <p className="entry-empty-copy">Uploaded videos will appear here.</p>}
            </div>
          </section>

          <section className="analysis-column analysis-parameter-column" ref={parameterColumnRef}>
            <div className="analysis-column-head">
              <p>parameters</p>
              <button
                className={`analysis-task-link subtle ${showHints ? 'active' : ''}`}
                onClick={() => {
                  setShowHints((current) => !current);
                  setFocusedHintKey(null);
                  setHoveredHintKey(null);
                  setHintCardPosition(null);
                }}
                type="button"
              >
                {showHints ? 'hide hints' : 'show hints'}
              </button>
            </div>
            <div className="analysis-divider" />

            <div className="analysis-param-actions">
              <div className="analysis-param-actions-left">
                <button className="analysis-pill success" disabled={!canLoadPreset} {...bindHint('load')} onClick={onLoadPreset} type="button">
                  load
                </button>
                <button className="analysis-pill analysis-pill-accent" {...bindHint('save')} onClick={onSavePreset} type="button">
                  save...
                </button>
                <details className="analysis-inline-details analysis-preset-details">
                  <summary>preset text</summary>
                  <div className="analysis-preset-card">
                    <div className="analysis-preset-card-head">
                      <span>preset text</span>
                      <button className="analysis-task-link subtle" onClick={() => void handleCopyPresetText()} type="button">
                        copy
                      </button>
                    </div>
                    <pre className="preset-preview analysis-preset-preview">{showPresetText}</pre>
                  </div>
                </details>
              </div>
              <div {...bindHint('reset')}>
                <AnalysisStarResetButton onClick={onResetPreset} />
              </div>
            </div>

            <div className="analysis-parameter-box" id="analysis-parameters">
              <label className="analysis-parameter-row" {...bindHint('tolerance')}>
                <span>tolerance</span>
                <div className="analysis-parameter-control">
                  <AnalysisStepperInput
                    ariaLabel="tolerance"
                    className="analysis-parameter-input short"
                    max={100}
                    min={0}
                    onChange={(rawValue) =>
                      setRunSettings((current) => ({
                        ...current,
                        tolerance: clampInteger(rawValue === '' ? 0 : Number(rawValue), 0, 100),
                      }))
                    }
                    onStep={(direction) =>
                      setRunSettings((current) => ({
                        ...current,
                        tolerance: clampInteger(current.tolerance + direction, 0, 100),
                      }))
                    }
                    value={runSettings.tolerance}
                  />
                </div>
                {isToleranceDirty && (
                  <AnalysisResetDiamondButton
                    className="outside"
                    label="tolerance"
                    onClick={() => setRunSettings((current) => ({ ...current, tolerance: defaultRunSettings.tolerance }))}
                  />
                )}
              </label>
              <label className="analysis-parameter-row" {...bindHint('min_scene_gap_ms')}>
                <span>minimum scene gaps</span>
                <div className="analysis-parameter-control">
                  <div className="analysis-parameter-input-group">
                    <AnalysisStepperInput
                      ariaLabel="minimum scene gaps"
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
                    label="minimum scene gaps"
                    onClick={() => setRunSettings((current) => ({ ...current, min_scene_gap_ms: defaultRunSettings.min_scene_gap_ms }))}
                  />
                )}
              </label>
              <label className="analysis-parameter-row" {...bindHint('sample_fps')}>
                <span>sample fps</span>
                <div className="analysis-parameter-control">
                  <AnalysisStepperInput
                    ariaLabel="sample fps"
                    className="analysis-parameter-input short"
                    min={1}
                    onChange={(rawValue) =>
                      setRunSettings((current) => ({
                        ...current,
                        sample_fps: rawValue ? clampInteger(Number(rawValue), 1) : null,
                      }))
                    }
                    onStep={(direction) =>
                      setRunSettings((current) => ({
                        ...current,
                        sample_fps: clampInteger((current.sample_fps ?? 1) + direction, 1),
                      }))
                    }
                    value={runSettings.sample_fps ?? ''}
                  />
                </div>
                {isSampleFpsDirty && (
                  <AnalysisResetDiamondButton
                    className="outside"
                    label="sample fps"
                    onClick={() => setRunSettings((current) => ({ ...current, sample_fps: defaultRunSettings.sample_fps }))}
                  />
                )}
              </label>
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
                    onClick={() => setRunSettings((current) => ({ ...current, extract_offset_ms: defaultRunSettings.extract_offset_ms }))}
                  />
                )}
              </label>
            </div>

            <div className="analysis-mode-row" {...bindHint('detector_mode')}>
              <span>detector mode</span>
              <div className="analysis-parameter-control">
                <div className="analysis-mode-toggle">
                  <button
                    className={`analysis-mode-button ${runSettings.detector_mode === 'content' ? 'active' : ''}`}
                    onClick={() => setRunSettings((current) => ({ ...current, detector_mode: 'content' }))}
                    type="button"
                  >
                    content
                  </button>
                  <button
                    className={`analysis-mode-button ${runSettings.detector_mode === 'adaptive' ? 'active' : ''}`}
                    onClick={() => setRunSettings((current) => ({ ...current, detector_mode: 'adaptive' }))}
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
                  onClick={() => setRunSettings((current) => ({ ...current, detector_mode: defaultRunSettings.detector_mode }))}
                />
              )}
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
              {presetCopyFeedback ? <span className="analysis-preset-feedback">{presetCopyFeedback}</span> : null}
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

          <section className="analysis-column">
            <div className="analysis-column-head">
              <p>tasks</p>
              <div className="analysis-task-toolbar">
                {taskSelectMode ? (
                  <>
                    <span className="analysis-task-selection-count">{selectedTaskRunIds.length} selected</span>
                    <button
                      className="analysis-task-link subtle"
                      disabled={!selectedTaskRunIds.length || bulkDeletePending}
                      onClick={() => void handleDeleteSelectedTasks()}
                      type="button"
                    >
                      {bulkDeletePending ? 'deleting...' : 'delete selected'}
                    </button>
                    <button
                      className="analysis-task-link subtle"
                      disabled={!selectedTaskRunIds.length || bulkExportPending}
                      onClick={() => void handleExportSelectedTasks()}
                      type="button"
                    >
                      {bulkExportPending ? 'exporting...' : 'export selected'}
                    </button>
                    <button
                      className="analysis-task-link subtle"
                      disabled={!analysisTaskItems.some((item) => item.run.status === 'completed') || bulkExportPending}
                      onClick={() => void handleExportAllCompletedTasks()}
                      type="button"
                    >
                      export all completed
                    </button>
                    <button
                      className="analysis-task-link subtle"
                      onClick={() => {
                        setTaskSelectMode(false);
                        setSelectedTaskRunIds([]);
                      }}
                      type="button"
                    >
                      done
                    </button>
                  </>
                ) : (
                  <button
                    className="analysis-task-link subtle"
                    onClick={() => {
                      setTaskSelectMode(true);
                      setSelectedTaskRunIds([]);
                    }}
                    type="button"
                  >
                    select
                  </button>
                )}
              </div>
            </div>
            <div className="analysis-divider" />
            <div className="analysis-tasks">
              {analysisTaskItems.map((item) => renderTaskRow(item))}
              {!analysisTaskItems.length && <p className="entry-empty-copy">Run summaries will appear here once analysis starts.</p>}
            </div>
          </section>
        </div>

        {previewVideoUrl && (
          <div className="analysis-lower-grid">
            <div className="analysis-lower-column">
              {previewVideoUrl ? (
                <section className="analysis-panel analysis-preview-panel" id="analysis-video-preview">
                  <video className="analysis-preview-video" controls playsInline src={previewVideoUrl} />
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
              <div>
                <p className="analysis-section-eyebrow">selected task</p>
                <div className="run-title-row">
                  <h2>{selectedRecordingSummary?.filename ?? selectedRun.summary.recording_id}</h2>
                  <span className={`status-pill ${selectedRun.summary.status}`}>{selectedRun.summary.status.replace('_', ' ')}</span>
                </div>
                <p className="muted">{selectedRun.summary.message || 'No status message yet.'}</p>
                <p className="analysis-detail-meta">{formatRunTiming(selectedRun.summary)}</p>
              </div>
              <div className="action-row">
                {selectedRun.summary.is_abortable && (
                  <button className="analysis-pill danger" disabled={abortRunPending} onClick={() => onAbortRun(selectedRun.summary.id)} type="button">
                    end
                  </button>
                )}
                {selectedRun.summary.needs_fallback_decision && (
                  <button className="analysis-pill analysis-pill-accent" onClick={() => onStartFallback(selectedRun.summary.id)} type="button">
                    sensitive fallback
                  </button>
                )}
                {selectedRun.summary.needs_fallback_decision && (
                  <button
                    className="analysis-pill analysis-pill-muted"
                    disabled={dismissFallbackPending}
                    onClick={() => onDismissFallback(selectedRun.summary.id)}
                    type="button"
                  >
                    keep current
                  </button>
                )}
                {selectedRun.summary.is_deletable && (
                  <button className="analysis-pill danger" disabled={deleteRunPending} onClick={() => onDeleteRun(selectedRun.summary.id)} type="button">
                    delete
                  </button>
                )}
                <button
                  className="analysis-pill success"
                  disabled={!canExport || exportRunPending}
                  onClick={() => onExportRun(selectedRun.summary.id)}
                  type="button"
                >
                  {exportRunPending ? 'exporting...' : 'export'}
                </button>
              </div>
            </div>

            <div className="analysis-task-bar" aria-hidden="true">
              <div className="analysis-task-bar-fill" style={{ width: formatPercent(selectedRun.summary.progress) }} />
            </div>

            {selectedRun.summary.needs_fallback_decision && (
              <div className="banner warning-banner banner-block">
                <strong>Primary pass found only the opening frame.</strong>
                <span>Run a sensitive fallback if the current result missed meaningful transitions.</span>
              </div>
            )}

            {selectedRun.export_bundle && (
              <div className="banner success-banner banner-block">
                <strong>Export ready.</strong>
                <a href={exportUrl ?? '#'} rel="noreferrer" target="_blank">
                  Download {selectedRun.export_bundle.item_count} screenshots as ZIP
                </a>
              </div>
            )}

            <div className="analysis-run-stats">
              <div className="summary-block">
                <span>phase</span>
                <strong>{formatPhase(selectedRun.summary.phase)}</strong>
              </div>
              <div className="summary-block">
                <span>candidates</span>
                <strong>{selectedRun.candidates.length}</strong>
              </div>
              <div className="summary-block">
                <span>accepted</span>
                <strong>{selectedRun.accepted_steps.length}</strong>
              </div>
            </div>

            <details className="disclosure-card" id="analysis-run-logs" open={['queued', 'running', 'awaiting_fallback'].includes(selectedRun.summary.status)}>
              <summary>logs</summary>
              <div className="log-list disclosure-body">
                {selectedRun.events.map((event) => (
                  <div className={`log-row ${event.level}`} key={event.id}>
                    <div className="log-meta">
                      <span className="status-pill small">{formatPhase(event.phase)}</span>
                      <small>{new Date(event.created_at).toLocaleTimeString()}</small>
                    </div>
                    <strong>{event.message}</strong>
                    {typeof event.progress === 'number' && <small>{formatPercent(event.progress)}</small>}
                  </div>
                ))}
                {!selectedRun.events.length && <p className="empty-copy">Progress messages will appear here once the run starts.</p>}
              </div>
            </details>

            {selectedRun.accepted_steps.length > 0 && (
              <div className="accepted-strip-shell">
                <div className="accepted-strip">
                  {selectedRun.accepted_steps.map((step) => {
                    const similarityLink = acceptedStepSimilarityLinks.get(step.step_id);
                    return (
                      <div className="accepted-step-chip" id={`accepted-step-${step.step_id}`} key={step.step_id} tabIndex={-1}>
                        <div className="accepted-step-topline">
                          <span className="status-pill small info">{step.step_id}</span>
                          <small>{step.timestamp_tc}</small>
                        </div>
                        <strong className="accepted-step-title" title={step.title}>
                          {step.title}
                        </strong>
                        {similarityLink ? (
                          <div className="linked-scene-row">
                            <span className="status-pill small warning">Returning scene</span>
                            <button className="inline-link-button" onClick={() => jumpToAnchor(similarityLink.targetId)} type="button">
                              {similarityLink.label}
                            </button>
                          </div>
                        ) : (
                          <small>{step.export_filename}</small>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="candidate-grid">
              {selectedRun.candidates.map((candidate) => {
                const similarityLink = candidateSimilarityLinks.get(candidate.id);
                return (
                  <CandidateCard
                    candidate={candidate}
                    key={candidate.id}
                    onJumpToSimilar={similarityLink ? () => jumpToAnchor(similarityLink.targetId) : undefined}
                    similarLink={similarityLink}
                    onUpdate={(payload) => onUpdateCandidate(candidate.id, payload)}
                  />
                );
              })}
            </div>
          </section>
        ) : selectedRecording ? (
          <section className="analysis-detail-section empty-state">
            <h2>{selectedRecording.filename}</h2>
            <p>Select a video name or a task output/log link to review screenshots, logs, and exports here.</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function EntryScreen({
  appError,
  healthMessage,
  isCreating,
  onCreate,
  onNavigateStage,
  onProjectNameChange,
  onSelectProject,
  projectName,
  projects,
  projectsLoading,
  selectedProjectId,
}: EntryScreenProps) {
  return (
    <div className="entry-screen">
      <div className="entry-shell">
        <StageNavigator
          activeStage="projects"
          className="entry-stage-nav"
          disabledStages={{ analysis: !selectedProjectId, import: !selectedProjectId }}
          onNavigate={onNavigateStage}
        />

        <div className="entry-stage">
          {(healthMessage || appError) && (
            <div className="entry-notices">
              {healthMessage && <p className="entry-notice warning">{healthMessage}</p>}
              {appError && <p className="entry-notice error">{appError}</p>}
            </div>
          )}

          <form className="entry-create-form" onSubmit={onCreate}>
            <input
              className="entry-project-input"
              onChange={(event) => onProjectNameChange(event.target.value)}
              placeholder="create a project"
              value={projectName}
            />
            <button className="entry-enter-button" disabled={!projectName.trim() || isCreating} type="submit">
              {isCreating ? 'entering…' : 'enter'}
            </button>
          </form>

          <p className="entry-helper-copy">or select an existing project...</p>

          <div className="entry-project-list">
            {projects.map((project) => (
              <button
                className={`entry-project-row ${project.id === selectedProjectId ? 'selected' : ''}`}
                key={project.id}
                onClick={() => onSelectProject(project.id)}
                type="button"
              >
                <strong>{project.name}</strong>
                <small>{formatProjectSummary(project)}</small>
              </button>
            ))}
            {!projects.length && !projectsLoading && <p className="entry-empty-copy">No existing projects yet.</p>}
            {projectsLoading && <p className="entry-empty-copy">Loading projects…</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

interface RunListItemProps {
  run: RunSummary;
  isSelected: boolean;
  onAbort: () => void;
  onDelete: () => void;
  onSelect: () => void;
}

function RunListItem({ run, isSelected, onAbort, onDelete, onSelect }: RunListItemProps) {
  return (
    <div className={`management-row ${isSelected ? 'selected-shell' : ''}`}>
      <button className={`run-row ${isSelected ? 'selected' : ''}`} onClick={onSelect} type="button">
        <span className="run-row-copy">
          <strong>{formatPhase(run.phase)}</strong>
          <small>{formatPercent(run.progress)} · {run.candidate_count} candidates · {run.accepted_count} accepted</small>
          <small className="run-settings-summary">{formatRunSettingsSummary(run)}</small>
        </span>
        <span className="run-row-status">
          <small>{formatRunTiming(run)}</small>
          <span className={`status-pill small ${run.status}`}>{run.status.replace('_', ' ')}</span>
        </span>
      </button>
      <div className="row-actions">
        {run.is_abortable && (
          <button className="secondary-button small-button" onClick={onAbort} type="button">
            Abort
          </button>
        )}
        {run.is_deletable && (
          <button className="danger-button small-button" onClick={onDelete} type="button">
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

interface CandidateCardProps {
  candidate: CandidateFrame;
  onJumpToSimilar?: (() => void) | undefined;
  similarLink?: SimilarLink | undefined;
  onUpdate: (payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>>) => void;
}

function CandidateCard({ candidate, onJumpToSimilar, similarLink, onUpdate }: CandidateCardProps) {
  const [title, setTitle] = useState(candidate.title ?? '');
  const [notes, setNotes] = useState(candidate.notes ?? '');

  useEffect(() => {
    setTitle(candidate.title ?? '');
    setNotes(candidate.notes ?? '');
  }, [candidate.id, candidate.title, candidate.notes]);

  function commitTextField(field: 'title' | 'notes', value: string) {
    const trimmed = value.trim();
    const currentValue = field === 'title' ? candidate.title ?? '' : candidate.notes ?? '';
    if (trimmed === currentValue.trim()) {
      return;
    }
    onUpdate({ [field]: trimmed } as Partial<Pick<CandidateFrame, 'title' | 'notes'>>);
  }

  function setStatus(status: CandidateStatus) {
    onUpdate({ status });
  }

  return (
    <article className={`candidate-card ${candidate.status}`} id={`candidate-${candidate.id}`} tabIndex={-1}>
      <div className="candidate-image-wrap">
        <img alt={`Candidate screenshot at ${candidate.timestamp_tc}`} src={absoluteApiUrl(candidate.image_url)} />
        <div className="candidate-overlay">
          <span className="status-pill small info">{candidate.timestamp_tc}</span>
          {similarLink && <span className="status-pill small warning">Similar scene</span>}
        </div>
      </div>
      <div className="candidate-body">
        <div className="candidate-headline">
          <div>
            <strong>Candidate {candidate.detector_index}</strong>
            <small>
              Change score {candidate.scene_score.toFixed(2)}
              {typeof candidate.similarity_distance === 'number' ? ` · revisit ${candidate.similarity_distance.toFixed(2)}` : ''}
            </small>
          </div>
          <span className={`status-pill small ${candidate.status}`}>{candidate.status}</span>
        </div>

        {similarLink && onJumpToSimilar && (
          <div className="linked-scene-row">
            <span className="status-pill small warning">Returning view</span>
            <button className="inline-link-button" onClick={onJumpToSimilar} title="Jump to the earlier matching scene." type="button">
              {similarLink.label}
            </button>
          </div>
        )}

        <div className="action-row compact">
          <button className="chip-button accept" onClick={() => setStatus('accepted')} title="Keep this screenshot in the exported walkthrough." type="button">
            Keep
          </button>
          <button className="chip-button reject" onClick={() => setStatus('rejected')} title="Exclude this screenshot from the walkthrough." type="button">
            Reject
          </button>
          <button className="chip-button neutral" onClick={() => setStatus('pending')} title="Clear the current decision for this screenshot." type="button">
            Reset
          </button>
        </div>

        <label className="field-group">
          <span>Step title</span>
          <input
            className="field"
            onBlur={(event) => commitTextField('title', event.target.value)}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Optional custom label"
            value={title}
          />
        </label>

        <label className="field-group">
          <span>Notes</span>
          <textarea
            className="field notes-field"
            onBlur={(event) => commitTextField('notes', event.target.value)}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Add observation, annotation note, or coding hint"
            value={notes}
          />
        </label>
      </div>
    </article>
  );
}

export default App;
