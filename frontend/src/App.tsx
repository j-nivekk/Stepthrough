import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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

const workflowStages: WorkflowStage[] = ['projects', 'import', 'analysis'];

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

function formatSettingsSource(source: SettingsSource): string {
  if (source === 'project') {
    return 'project working preset';
  }
  if (source === 'browser') {
    return 'browser default preset';
  }
  return 'app defaults';
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
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [liveMessage, setLiveMessage] = useState<string>('');
  const [appError, setAppError] = useState<string>('');
  const [runsExpanded, setRunsExpanded] = useState(false);
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
      return recording?.runs.some((run) => ['queued', 'running'].includes(run.status)) ? 1500 : false;
    },
  });
  const runDetailQuery = useQuery({
    queryKey: ['run', selectedRunId],
    queryFn: () => getRun(selectedRunId as string),
    enabled: Boolean(selectedRunId),
    refetchInterval: (query) => {
      const run = query.state.data as RunDetail | undefined;
      return run && ['queued', 'running'].includes(run.summary.status) ? 2000 : false;
    },
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
      setRunsExpanded(false);
    }
  }, [projectDetailQuery.data, selectedRecordingId]);

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
    if (!['queued', 'running'].includes(runDetailQuery.data.summary.status)) {
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
    mutationFn: ({ projectId, file }: { file: File; localId?: string; projectId: string; source: 'import' | 'workspace' }) =>
      importRecording(projectId, file),
    onSuccess: (recording, variables) => {
      if (variables.source === 'workspace') {
        setUploadFile(null);
      }
      if (variables.source === 'import' && variables.localId) {
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
      setRunsExpanded(false);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', recording.project_id] });
      queryClient.invalidateQueries({ queryKey: ['recording', recording.id] });
    },
    onError: (error: Error, variables) => {
      setAppError(error.message);
      if (variables.source === 'import' && variables.localId) {
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
        setRunsExpanded(false);
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
      setRunsExpanded(true);
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
  const healthWarning = healthQuery.data && healthQuery.data.missing_tools.length > 0;
  const selectedVideoUrl = selectedRecording ? absoluteApiUrl(selectedRecording.source_url) : null;
  const exportUrl = selectedRun?.export_bundle ? absoluteApiUrl(selectedRun.export_bundle.zip_url) : null;
  const presetText = useMemo(() => serializeRunPresetText(runSettings), [runSettings]);
  const uploadedImportItems = useMemo(() => getUploadedImportItems(importQueue), [importQueue]);
  const canCompleteImport = uploadedImportItems.length > 0;
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

  function enterProject(projectId: string) {
    setSelectedProjectId(projectId);
    setSelectedRecordingId(null);
    setSelectedRunId(null);
    setRunsExpanded(false);
    setWorkflowStage('import');
    setAppError('');
    setUploadFile(null);
  }

  function handleCreateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim()) {
      return;
    }
    setAppError('');
    createProjectMutation.mutate(projectName.trim());
  }

  function handleImportRecording(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId || !uploadFile) {
      return;
    }
    setAppError('');
    importRecordingMutation.mutate({ projectId: selectedProjectId, file: uploadFile, source: 'workspace' });
  }

  function handleStartRun(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRecordingId) {
      return;
    }
    setAppError('');
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
    setRunSettings(defaultRunSettings);
    setSettingsFeedback('Reset the current project to the built-in defaults.');
  }

  async function handleCopyPresetText() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setSettingsFeedback('Clipboard copy is unavailable here. Open “Show preset text” to copy it manually.');
      return;
    }

    try {
      await navigator.clipboard.writeText(presetText);
      setSettingsFeedback('Copied the formatted preset text to your clipboard.');
    } catch {
      setSettingsFeedback('Could not copy automatically. Open “Show preset text” to copy it manually.');
    }
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

    setAppError('');
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
      source: 'import',
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
    setRunsExpanded(false);
    setWorkflowStage('analysis');
  }

  function confirmDeleteRun(runId: string) {
    if (!window.confirm('Delete this run and all screenshots and exports created by it?')) {
      return;
    }
    deleteRunMutation.mutate({ runId });
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
    <div className="shell">
      <StageNavigator
        activeStage="analysis"
        className="analysis-stage-nav"
        onNavigate={setProjectStage}
      />
      <aside className="sidebar">
        <div className="brand-card">
          <p className="eyebrow">Walkthrough Research Toolkit</p>
          <h1>Stepthrough</h1>
          <p className="lede">
            Import recordings, detect interface changes, review candidate screenshots, and export a chronological walkthrough.
          </p>
        </div>

        <form className="card stack-gap" onSubmit={handleCreateProject}>
          <div>
            <h2>New Project</h2>
            <p className="muted">Create a workspace for a study, participant session, or app flow.</p>
          </div>
          <input
            className="field"
            placeholder="e.g. Banking Onboarding Study"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
          />
          <button className="primary-button" disabled={createProjectMutation.isPending} type="submit">
            {createProjectMutation.isPending ? 'Creating…' : 'Create Project'}
          </button>
        </form>

        <section className="card stack-gap">
          <div className="section-header compact">
            <div>
              <h2>Projects</h2>
              <p className="muted">Choose the workspace you want to continue.</p>
            </div>
            <span className="count-badge">{projectsQuery.data?.length ?? 0}</span>
          </div>
          <div className="project-list">
            {projectsQuery.data?.map((project) => (
              <button
                key={project.id}
                className={`project-row ${project.id === selectedProjectId ? 'selected' : ''}`}
                onClick={() => enterProject(project.id)}
                type="button"
              >
                <span>
                  <strong>{project.name}</strong>
                  <small>{formatProjectSummary(project)}</small>
                </span>
                <span className="slug-pill">{project.slug}</span>
              </button>
            ))}
            {!projectsQuery.data?.length && <p className="empty-copy">Projects will appear here once you create one.</p>}
          </div>
        </section>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local-first processing</p>
            <h2>{activeProject ? activeProject.name : 'Loading project…'}</h2>
          </div>
          <div className="topbar-status">
            <span className={`status-pill ${healthWarning ? 'warning' : 'ready'}`}>
              {healthWarning ? 'Tools missing' : 'FFmpeg ready'}
            </span>
            {liveMessage && <span className="status-pill info">{liveMessage}</span>}
          </div>
        </header>

        {healthWarning && (
          <section className="banner warning-banner">
            <strong>Video tools are not ready.</strong>
            <span>{healthQuery.data?.message}</span>
          </section>
        )}

        {appError && (
          <section className="banner error-banner">
            <strong>Something went wrong.</strong>
            <span>{appError}</span>
          </section>
        )}

        {activeProject && (
          <section className="card stack-gap">
            <div className="section-header">
              <div>
                <h2>Recordings</h2>
                <p className="muted">Import a phone or desktop recording, then select it to configure detection.</p>
              </div>
              <span className="slug-pill">{activeProject.slug}</span>
            </div>

            <form className="upload-form" onSubmit={handleImportRecording}>
              <label className="upload-dropzone">
                <input
                  accept="video/*"
                  onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
                <span>{uploadFile ? uploadFile.name : 'Choose a recording file'}</span>
                <small>Stepthrough copies the video into local project storage.</small>
              </label>
              <button className="secondary-button" disabled={!selectedProjectId || !uploadFile || importRecordingMutation.isPending} type="submit">
                {importRecordingMutation.isPending ? 'Importing…' : 'Import Recording'}
              </button>
            </form>

            <div className="recording-list">
              {projectDetailQuery.data?.recordings.map((recording) => (
                <div className={`management-row ${recording.id === selectedRecordingId ? 'selected-shell' : ''}`} key={recording.id}>
                  <button
                    className={`recording-row ${recording.id === selectedRecordingId ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedRecordingId(recording.id);
                      setSelectedRunId(null);
                      setRunsExpanded(false);
                    }}
                    type="button"
                  >
                    <span>
                      <strong>{recording.filename}</strong>
                      <small>
                        {recording.duration_tc} · {recording.width}×{recording.height} · {recording.fps} fps
                      </small>
                    </span>
                    <span className="slug-pill">{recording.slug}</span>
                  </button>
                  <div className="row-actions">
                    <button className="danger-button" onClick={() => confirmDeleteRecording(recording.id, recording.filename)} type="button">
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {!projectDetailQuery.data?.recordings.length && (
                <p className="empty-copy">Imported recordings will appear here for processing and run history.</p>
              )}
            </div>
          </section>
        )}

        {selectedRecording && (
          <section className="card stack-gap">
            <div className="section-header">
              <div>
                <h2>Detection Setup</h2>
                <p className="muted">Tune how aggressively Stepthrough looks for interaction changes in the selected recording.</p>
              </div>
              <span className="count-badge">{selectedRecording.runs.length} runs</span>
            </div>

            <details className="disclosure-card">
              <summary>What do these settings mean?</summary>
              <div className="disclosure-body stack-gap">
                <p className="helper-text">Tolerance controls how much change is required before a screenshot is suggested.</p>
                <p className="helper-text">Min scene gap prevents near-duplicate screenshots from tiny changes too close together in time.</p>
                <p className="helper-text">Sample fps trades speed against sensitivity. Detector mode changes how frame differences are interpreted.</p>
                <p className="helper-text">Extract offset nudges the captured frame slightly after a change so the interface has time to settle.</p>
                <p className="helper-text">Your current form auto-saves per project in this browser. You can also promote it to a browser-wide default preset.</p>
              </div>
            </details>

            <details className="disclosure-card">
              <summary>Tips for mobile app interfaces</summary>
              <div className="disclosure-body stack-gap">
                <p className="helper-text">For apps like WhatsApp, tune in this order: tolerance, sample fps, min scene gap, detector mode, then extract offset.</p>
                <ol className="helper-list">
                  <li>Missing subtle screens like keyboards, badges, or sheet openings: lower tolerance first.</li>
                  <li>Missing very brief menus or overlays: raise sample fps next.</li>
                  <li>Getting too many near-duplicates from scrolling or animation: raise min scene gap.</li>
                  <li>If scrolling dominates the video and keeps triggering false scenes: switch from content to adaptive mode.</li>
                  <li>If screenshots look blurry or transitional: raise extract offset.</li>
                </ol>
                <p className="helper-text">A good mobile starting point is content mode with moderate tolerance, moderate sample fps, a mid-range scene gap, and a small positive extract offset.</p>
              </div>
            </details>

            <form className="stack-gap" onSubmit={handleStartRun}>
              <label className="field-group">
                <div className="field-headline">
                  <span>Tolerance</span>
                  <strong>{runSettings.tolerance}</strong>
                </div>
                <input
                  className="field"
                  max={100}
                  min={0}
                  onChange={(event) => setRunSettings((current) => ({ ...current, tolerance: Number(event.target.value) }))}
                  type="range"
                  value={runSettings.tolerance}
                />
                <small>{describeTolerance(runSettings.tolerance)}</small>
              </label>

              <div className="inline-fields">
                <label className="field-group">
                  <span>Min scene gap (ms)</span>
                  <input
                    className="field"
                    min={0}
                    onChange={(event) =>
                      setRunSettings((current) => ({ ...current, min_scene_gap_ms: Number(event.target.value) }))
                    }
                    type="number"
                    value={runSettings.min_scene_gap_ms}
                  />
                  <small>{describeMinSceneGap(runSettings.min_scene_gap_ms)}</small>
                </label>
                <label className="field-group">
                  <span>Sample fps</span>
                  <input
                    className="field"
                    min={1}
                    onChange={(event) =>
                      setRunSettings((current) => ({
                        ...current,
                        sample_fps: event.target.value ? Number(event.target.value) : null,
                      }))
                    }
                    type="number"
                    value={runSettings.sample_fps ?? ''}
                  />
                  <small>{describeSampleFps(runSettings.sample_fps)}</small>
                </label>
              </div>

              <div className="inline-fields">
                <label className="field-group">
                  <span>Detector mode</span>
                  <select
                    className="field"
                    onChange={(event) =>
                      setRunSettings((current) => ({ ...current, detector_mode: event.target.value as RunSettings['detector_mode'] }))
                    }
                    value={runSettings.detector_mode}
                  >
                    <option value="content">Content detector</option>
                    <option value="adaptive">Adaptive detector</option>
                  </select>
                  <small>{describeDetectorMode(runSettings.detector_mode)}</small>
                </label>
                <label className="field-group">
                  <span>Extract offset (ms)</span>
                  <input
                    className="field"
                    min={0}
                    onChange={(event) =>
                      setRunSettings((current) => ({ ...current, extract_offset_ms: Number(event.target.value) }))
                    }
                    type="number"
                    value={runSettings.extract_offset_ms}
                  />
                  <small>{describeExtractOffset(runSettings.extract_offset_ms)}</small>
                </label>
              </div>

              <div className="action-row">
                <button className="primary-button" disabled={createRunMutation.isPending || healthWarning} type="submit">
                  {createRunMutation.isPending ? 'Starting…' : 'Run Detection'}
                </button>
                <span className="helper-inline">If the first pass only finds the opening frame, you will be prompted to run a sensitive fallback.</span>
              </div>
            </form>

            <div className="preset-panel stack-gap">
              <div className="section-header compact">
                <div>
                  <h3>Preset Tools</h3>
                  <p className="muted">
                    Working preset source: {formatSettingsSource(settingsSource)}. Changes auto-save to this project in this browser.
                  </p>
                </div>
                <span className="status-pill small info">{formatRunSettingsSummary(runSettings)}</span>
              </div>

              <div className="action-row">
                <button className="secondary-button small-button" onClick={handleSaveBrowserDefault} type="button">
                  Save as Browser Default
                </button>
                <button
                  className="secondary-button small-button"
                  disabled={!globalPreset}
                  onClick={handleResetToBrowserDefault}
                  type="button"
                >
                  Reset to Browser Default
                </button>
                <button className="secondary-button small-button" onClick={handleResetToAppDefaults} type="button">
                  Reset to App Defaults
                </button>
                <button className="secondary-button small-button" onClick={() => void handleCopyPresetText()} type="button">
                  Copy Preset Text
                </button>
              </div>

              {settingsFeedback && <p className="helper-text success-text">{settingsFeedback}</p>}

              <details className="disclosure-card">
                <summary>Show preset text</summary>
                <div className="disclosure-body">
                  <pre className="preset-preview">{presetText}</pre>
                </div>
              </details>
            </div>

            <details className="disclosure-card recording-preview-toggle">
              <summary>Show selected recording preview and metadata</summary>
              <div className="recording-preview-layout disclosure-body">
                <video controls playsInline src={selectedVideoUrl ?? undefined} />
                <div className="recording-meta-panel">
                  <div className="meta-block">
                    <span>Filename</span>
                    <strong>{selectedRecording.filename}</strong>
                    <small>{selectedRecording.duration_tc}</small>
                  </div>
                  <div className="meta-block">
                    <span>Frame rate</span>
                    <strong>{selectedRecording.fps} fps</strong>
                    <small>{selectedRecording.width}×{selectedRecording.height}</small>
                  </div>
                  <div className="meta-block">
                    <span>Workflow</span>
                    <strong>Import → detect → review → export</strong>
                    <small>Runs stay attached to this recording until you delete them.</small>
                  </div>
                </div>
              </div>
            </details>

            <div className="section-header compact">
              <div>
                <h3>Previous Runs</h3>
                <p className="muted">Expand this section to inspect, abort, or delete earlier runs.</p>
              </div>
              <button className="secondary-button small-button" onClick={() => setRunsExpanded((value) => !value)} type="button">
                {runsExpanded ? 'Hide Runs' : 'Show Runs'}
              </button>
            </div>

            {runsExpanded && (
              <div className="run-list">
                {selectedRecording.runs.map((run) => (
                  <RunListItem
                    key={run.id}
                    run={run}
                    isSelected={run.id === selectedRunId}
                    onAbort={() => abortRunMutation.mutate(run.id)}
                    onDelete={() => confirmDeleteRun(run.id)}
                    onSelect={() => setSelectedRunId(run.id)}
                  />
                ))}
                {!selectedRecording.runs.length && <p className="empty-copy">No processing runs yet for this recording.</p>}
              </div>
            )}

            {!selectedRun && selectedRecording.runs.length > 0 && (
              <p className="empty-copy">Choose a run from “Previous Runs” to inspect logs, review screenshots, or export accepted steps.</p>
            )}
          </section>
        )}

        {selectedRun && (
          <section className="card stack-gap">
            <div className="run-header">
              <div>
                <p className="eyebrow">Selected Run</p>
                <div className="run-title-row">
                  <h2>{formatPhase(selectedRun.summary.phase)}</h2>
                  <span className={`status-pill ${selectedRun.summary.status}`}>{selectedRun.summary.status.replace('_', ' ')}</span>
                </div>
                <p className="muted">{selectedRun.summary.message || 'No status message yet.'}</p>
                <p className="helper-text">{formatRunTiming(selectedRun.summary)}</p>
              </div>
              <div className="action-row">
                {selectedRun.summary.is_abortable && (
                  <button className="secondary-button" disabled={abortRunMutation.isPending} onClick={() => abortRunMutation.mutate(selectedRun.summary.id)} type="button">
                    Abort Run
                  </button>
                )}
                {selectedRun.summary.needs_fallback_decision && (
                  <button
                    className="primary-button"
                    disabled={startFallbackMutation.isPending}
                    onClick={() => startFallbackMutation.mutate(selectedRun.summary.id)}
                    type="button"
                  >
                    {startFallbackMutation.isPending ? 'Starting fallback…' : 'Run Sensitive Fallback'}
                  </button>
                )}
                {selectedRun.summary.needs_fallback_decision && (
                  <button
                    className="secondary-button"
                    disabled={dismissFallbackMutation.isPending}
                    onClick={() => dismissFallbackMutation.mutate(selectedRun.summary.id)}
                    type="button"
                  >
                    Keep Current Result
                  </button>
                )}
                {selectedRun.summary.is_deletable && (
                  <button className="danger-button" disabled={deleteRunMutation.isPending} onClick={() => confirmDeleteRun(selectedRun.summary.id)} type="button">
                    Delete Run
                  </button>
                )}
                <button
                  className="primary-button"
                  disabled={!canExport || exportRunMutation.isPending}
                  onClick={() => exportRunMutation.mutate(selectedRun.summary.id)}
                  type="button"
                >
                  {exportRunMutation.isPending ? 'Exporting…' : 'Export Accepted Steps'}
                </button>
              </div>
            </div>

            <div className="progress-panel">
              <div className="progress-meta">
                <strong>{formatPhase(selectedRun.summary.phase)}</strong>
                <span>{formatPercent(selectedRun.summary.progress)}</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: formatPercent(selectedRun.summary.progress) }} />
              </div>
              <div className="progress-caption">
                <span>{selectedRun.summary.candidate_count} candidates so far</span>
                <span>{selectedRun.summary.accepted_count} accepted</span>
              </div>
            </div>

            {selectedRun.summary.needs_fallback_decision && (
              <div className="banner warning-banner banner-block">
                <strong>Primary pass found only the opening frame.</strong>
                <span>
                  Review the current result, keep it as-is, or run a sensitive fallback that rescans the same recording with more permissive settings.
                </span>
              </div>
            )}

            {selectedRun.export_bundle && (
              <div className="banner success-banner banner-block">
                <strong>Export ready.</strong>
                <a href={exportUrl ?? '#'} rel="noreferrer" target="_blank">
                  Download {selectedRun.export_bundle.item_count} screenshots as ZIP
                </a>
                <span className="helper-inline">The ZIP includes PNGs plus `steps.csv` and `steps.json` with timestamps and step metadata.</span>
              </div>
            )}

            <details className="disclosure-card" open={['queued', 'running', 'awaiting_fallback'].includes(selectedRun.summary.status)}>
              <summary>Run log and progress history</summary>
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

            <details className="disclosure-card">
              <summary>Review actions explained</summary>
              <div className="disclosure-body stack-gap">
                <p className="helper-text">Keep adds a screenshot to the ordered walkthrough.</p>
                <p className="helper-text">Reject excludes it from export but leaves it visible for reference.</p>
                <p className="helper-text">Reset returns it to an undecided state so you can revisit it later.</p>
                <p className="helper-text">Similar-scene cues mark likely returns to an earlier interface without merging them into one step.</p>
              </div>
            </details>

            <div className="review-summary-grid">
              <div className="summary-block accent">
                <span>Status</span>
                <strong>{selectedRun.summary.status.replace('_', ' ')}</strong>
                <small>{selectedRun.summary.message || 'Awaiting instructions'}</small>
              </div>
              <div className="summary-block">
                <span>Phase</span>
                <strong>{formatPhase(selectedRun.summary.phase)}</strong>
                <small>{formatPercent(selectedRun.summary.progress)}</small>
              </div>
              <div className="summary-block">
                <span>Candidates</span>
                <strong>{selectedRun.candidates.length}</strong>
                <small>Suggested screenshots</small>
              </div>
              <div className="summary-block">
                <span>Accepted</span>
                <strong>{selectedRun.accepted_steps.length}</strong>
                <small>Ordered walkthrough steps</small>
              </div>
            </div>

            <div className="run-settings-card stack-gap">
              <div className="section-header compact">
                <div>
                  <h3>Detection Settings Used</h3>
                  <p className="muted">These are the exact parameters that produced this run.</p>
                </div>
                <span className="status-pill small info">{formatDetectorModeLabel(selectedRun.summary.detector_mode)}</span>
              </div>
              <div className="run-settings-grid">
                <div className="meta-block">
                  <span>Mode</span>
                  <strong>{formatDetectorModeLabel(selectedRun.summary.detector_mode)}</strong>
                  <small>{describeDetectorMode(selectedRun.summary.detector_mode)}</small>
                </div>
                <div className="meta-block">
                  <span>Tolerance</span>
                  <strong>{selectedRun.summary.tolerance}</strong>
                  <small>{describeTolerance(selectedRun.summary.tolerance)}</small>
                </div>
                <div className="meta-block">
                  <span>Sample fps</span>
                  <strong>{selectedRun.summary.sample_fps ?? 'Source stream'}</strong>
                  <small>{describeSampleFps(selectedRun.summary.sample_fps)}</small>
                </div>
                <div className="meta-block">
                  <span>Min scene gap</span>
                  <strong>{selectedRun.summary.min_scene_gap_ms} ms</strong>
                  <small>{describeMinSceneGap(selectedRun.summary.min_scene_gap_ms)}</small>
                </div>
                <div className="meta-block">
                  <span>Extract offset</span>
                  <strong>{selectedRun.summary.extract_offset_ms} ms</strong>
                  <small>{describeExtractOffset(selectedRun.summary.extract_offset_ms)}</small>
                </div>
              </div>
            </div>

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
              {!selectedRun.accepted_steps.length && (
                <p className="empty-copy">Keep screenshots below to build the final walkthrough sequence.</p>
              )}
            </div>

            <div className="candidate-grid">
              {selectedRun.candidates.map((candidate) => (
                <CandidateCard
                  candidate={candidate}
                  key={candidate.id}
                  onJumpToSimilar={
                    candidateSimilarityLinks.has(candidate.id)
                      ? () => jumpToAnchor(candidateSimilarityLinks.get(candidate.id)!.targetId)
                      : undefined
                  }
                  similarLink={candidateSimilarityLinks.get(candidate.id)}
                  onUpdate={(payload) => updateCandidateMutation.mutate({ candidateId: candidate.id, payload })}
                />
              ))}
            </div>
          </section>
        )}

      </main>
    </div>
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
            <button className="inline-link-button" onClick={onJumpToSimilar} type="button">
              {similarLink.label}
            </button>
          </div>
        )}

        <div className="action-row compact">
          <button className="chip-button accept" onClick={() => setStatus('accepted')} type="button">
            Keep
          </button>
          <button className="chip-button reject" onClick={() => setStatus('rejected')} type="button">
            Reject
          </button>
          <button className="chip-button neutral" onClick={() => setStatus('pending')} type="button">
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
