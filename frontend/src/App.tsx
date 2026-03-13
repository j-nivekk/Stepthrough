import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  API_BASE,
  absoluteApiUrl,
  abortRun,
  createManualCandidate,
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
  updateProject,
  updateRecording,
} from './api';
import type {
  CandidateFrame,
  CandidateStatus,
  ExportMode,
  ExportBundle,
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
  allow_high_fps_sampling: false,
  detector_mode: 'content',
  extract_offset_ms: 200,
};

const contentThresholdRange: [number, number] = [8, 48];
const adaptiveThresholdRange: [number, number] = [1, 7];

const PRESET_STORAGE_VERSION = 1;
const GLOBAL_PRESET_STORAGE_KEY = 'stepthrough.run-preset.global.v1';
const PROJECT_PRESET_STORAGE_KEY_PREFIX = 'stepthrough.run-preset.project.v1';
const APP_IDENTITY = 'stepthrough, v 0.1.0';
const workflowViewportMinimums: Record<WorkflowStage, { height: number; width: number }> = {
  projects: { width: 720, height: 640 },
  import: { width: 720, height: 640 },
  analysis: { width: 1120, height: 760 },
};

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
  | 'allow_high_fps_sampling'
  | 'detector_mode'
  | 'extract_offset_ms'
  | 'load'
  | 'min_scene_gap_ms'
  | 'reset'
  | 'run'
  | 'sample_fps'
  | 'save'
  | 'tolerance';
type AnalysisTaskFilter = 'all' | 'active' | 'completed' | 'failed';
type CandidateFilter = CandidateStatus | 'all';

const workflowStages: WorkflowStage[] = ['projects', 'import', 'analysis'];
const activeRunStatuses: RunSummary['status'][] = ['queued', 'running'];
const candidateFilters: CandidateFilter[] = ['all', 'pending', 'accepted', 'rejected'];
const analysisTaskFilters: AnalysisTaskFilter[] = ['all', 'active', 'completed', 'failed'];
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
  primary_scan: 'Scan',
  primary_extract: 'Extract',
  awaiting_fallback: 'Awaiting fallback',
  fallback_scan: 'Fallback scan',
  fallback_extract: 'Fallback extract',
  exporting: 'Exporting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Aborted',
};

function sanitizeRunSettings(settings?: Partial<RunSettings> | null): RunSettings {
  const tolerance = typeof settings?.tolerance === 'number' ? Math.min(100, Math.max(1, Math.round(settings.tolerance))) : defaultRunSettings.tolerance;
  const minSceneGap = typeof settings?.min_scene_gap_ms === 'number' ? Math.max(0, Math.round(settings.min_scene_gap_ms)) : defaultRunSettings.min_scene_gap_ms;
  const sampleFps =
    typeof settings?.sample_fps === 'number' && Number.isFinite(settings.sample_fps) && settings.sample_fps > 0
      ? Math.max(1, Math.round(settings.sample_fps))
      : null;
  const allowHighFpsSampling = settings?.allow_high_fps_sampling === true;
  const detectorMode = settings?.detector_mode === 'adaptive' ? 'adaptive' : 'content';
  const extractOffset =
    typeof settings?.extract_offset_ms === 'number' ? Math.max(0, Math.round(settings.extract_offset_ms)) : defaultRunSettings.extract_offset_ms;

  return {
    tolerance,
    min_scene_gap_ms: minSceneGap,
    sample_fps: sampleFps,
    allow_high_fps_sampling: allowHighFpsSampling,
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

function mapToleranceToDetectorThreshold(tolerance: number, detectorMode: RunSettings['detector_mode']): number {
  const [floor, ceiling] = detectorMode === 'adaptive' ? adaptiveThresholdRange : contentThresholdRange;
  const normalized = (Math.min(100, Math.max(1, tolerance)) - 1) / 99;
  return Number((floor + ((ceiling - floor) * normalized)).toFixed(2));
}

function describeTolerance(tolerance: number, detectorMode: RunSettings['detector_mode']): string {
  const threshold = mapToleranceToDetectorThreshold(tolerance, detectorMode);
  const thresholdLabel = detectorMode === 'adaptive' ? `Adaptive threshold ${threshold}.` : `Content threshold ${threshold}.`;
  if (tolerance <= 25) {
    return `${thresholdLabel} Very sensitive. Lower this when keyboard changes, small badges, or brief sheets are being missed.`;
  }
  if (tolerance <= 60) {
    return `${thresholdLabel} Balanced. Good default for most walkthrough recordings. Lower it to catch subtler screens, raise it if typing or scrolling creates noise.`;
  }
  return `${thresholdLabel} Conservative. Raise this when scrolling or tiny motion creates too many candidates. Lower it if real screens are being missed.`;
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

function getSampleFpsGuardrail(recordingFps: number | null | undefined, allowHighFpsSampling: boolean) {
  const sourceCeiling = Math.max(1, Math.ceil(recordingFps && Number.isFinite(recordingFps) ? recordingFps : 30));
  const cappedMax = Math.min(30, sourceCeiling);
  return {
    isHighFpsRecording: sourceCeiling > 30,
    maxSampleFps: allowHighFpsSampling ? sourceCeiling : cappedMax,
    sourceFpsAvailable: sourceCeiling <= 30 || allowHighFpsSampling,
    sourceFpsCeiling: sourceCeiling,
  };
}

function clampRunSettingsForRecording(settings: RunSettings, recordingFps: number | null | undefined): RunSettings {
  const sanitized = sanitizeRunSettings(settings);
  const guardrail = getSampleFpsGuardrail(recordingFps, sanitized.allow_high_fps_sampling);
  let nextSampleFps = sanitized.sample_fps;
  if (typeof nextSampleFps === 'number') {
    nextSampleFps = clampInteger(nextSampleFps, 1, guardrail.maxSampleFps);
  } else if (!guardrail.sourceFpsAvailable) {
    nextSampleFps = guardrail.maxSampleFps;
  }

  return {
    ...sanitized,
    sample_fps: nextSampleFps,
  };
}

function areRunSettingsEqual(left: RunSettings, right: RunSettings): boolean {
  return (
    left.tolerance === right.tolerance &&
    left.min_scene_gap_ms === right.min_scene_gap_ms &&
    left.sample_fps === right.sample_fps &&
    left.allow_high_fps_sampling === right.allow_high_fps_sampling &&
    left.detector_mode === right.detector_mode &&
    left.extract_offset_ms === right.extract_offset_ms
  );
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
    settings.allow_high_fps_sampling ? 'high fps on' : null,
    `gap ${settings.min_scene_gap_ms} ms`,
    `offset ${settings.extract_offset_ms} ms`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function serializeRunPresetText(settings: RunSettings): string {
  return [
    'Stepthrough Detection Preset',
    `Mode: ${formatDetectorModeLabel(settings.detector_mode)}`,
    `Tolerance: ${settings.tolerance}`,
    `Min scene gap: ${settings.min_scene_gap_ms} ms`,
    `Sample fps: ${settings.sample_fps ?? 'Source stream'}`,
    `High-fps sampling: ${settings.allow_high_fps_sampling ? 'Enabled' : 'Disabled'}`,
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

function getFilenameStem(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return 'stepthrough';
  }
  return trimmed.replace(/\.[^./\\]+$/, '');
}

function buildReviewExportName(filename: string): string {
  return `${getFilenameStem(filename)}-review-export`;
}

function normalizeZipFilename(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const sanitized = trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.zip$/i, '');
  return sanitized ? `${sanitized}.zip` : null;
}

function formatPlaybackTimestamp(timestampMs: number): string {
  const safeTimestamp = Math.max(0, Math.round(timestampMs));
  const totalSeconds = Math.floor(safeTimestamp / 1000);
  const milliseconds = safeTimestamp % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
  return `${clock}.${String(milliseconds).padStart(3, '0')}`;
}

async function triggerNamedDownload(url: string, filename: string): Promise<void> {
  if (typeof document === 'undefined') {
    return;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Could not download the export bundle.');
  }

  const blob = await response.blob();
  const objectUrl = globalThis.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => {
    globalThis.URL.revokeObjectURL(objectUrl);
  }, 0);
}

async function downloadExportBundle(bundle: ExportBundle, downloadName?: string): Promise<void> {
  const bundleUrl = absoluteApiUrl(bundle.zip_url);
  const normalizedDownloadName = typeof downloadName === 'string' ? normalizeZipFilename(downloadName) : null;

  if (normalizedDownloadName) {
    await triggerNamedDownload(bundleUrl, normalizedDownloadName);
    return;
  }

  triggerDownload(bundleUrl);
}

function buildImportFileSignature(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
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

function splitFilename(value: string): { base: string; extension: string } {
  const lastDotIndex = value.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex === value.length - 1) {
    return { base: value, extension: '' };
  }
  return {
    base: value.slice(0, lastDotIndex),
    extension: value.slice(lastDotIndex),
  };
}

function joinFilename(base: string, extension: string): string {
  const normalizedBase = base.trim();
  return `${normalizedBase}${extension}`;
}

function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
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

function candidateMatchesFilter(candidate: CandidateFrame, filter: CandidateFilter): boolean {
  return filter === 'all' ? true : candidate.status === filter;
}

function getNextCandidateFocusId(candidates: CandidateFrame[], currentCandidateId: string, filter: CandidateFilter): string | null {
  const currentIndex = candidates.findIndex((candidate) => candidate.id === currentCandidateId);
  if (currentIndex === -1) {
    return null;
  }

  const remainingCandidates = candidates.slice(currentIndex + 1);
  if (filter === 'all' || filter === 'pending') {
    return remainingCandidates.find((candidate) => candidate.status === 'pending')?.id ?? null;
  }

  return remainingCandidates.find((candidate) => candidateMatchesFilter(candidate, filter))?.id ?? null;
}

function App() {
  const queryClient = useQueryClient();
  const [projectName, setProjectName] = useState('');
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>('projects');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runSettings, setRunSettings] = useState<RunSettings>(defaultRunSettings);
  const [settingsFeedback, setSettingsFeedback] = useState('');
  const [globalPreset, setGlobalPreset] = useState<GlobalRunPreset | null>(() => loadGlobalRunPreset());
  const [projectDefaultSettings, setProjectDefaultSettings] = useState<RunSettings>(defaultRunSettings);
  const [importQueue, setImportQueue] = useState<ImportQueueItem[]>([]);
  const [importSelectionFeedback, setImportSelectionFeedback] = useState('');
  const [previewRecordingId, setPreviewRecordingId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState<string>('');
  const [analysisActionMessage, setAnalysisActionMessage] = useState<string>('');
  const [appError, setAppError] = useState<string>('');
  const [bulkDeletePending, setBulkDeletePending] = useState(false);
  const [bulkExportPending, setBulkExportPending] = useState(false);
  const [viewportSize, setViewportSize] = useState(() => ({
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
  }));
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
      setRunSettings(defaultRunSettings);
      setProjectDefaultSettings(defaultRunSettings);
      setSettingsFeedback('');
      setImportQueue([]);
      setImportSelectionFeedback('');
      setPreviewRecordingId(null);
      setWorkflowStage('projects');
      return;
    }

    const projectPreset = loadProjectRunPreset(selectedProjectId);
    const nextSettings = projectPreset?.settings ?? globalPreset?.settings ?? defaultRunSettings;
    setProjectDefaultSettings(nextSettings);
    setRunSettings(nextSettings);
    setSettingsFeedback('');
  }, [selectedProjectId]);

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

  const updateProjectMutation = useMutation({
    mutationFn: ({ name, projectId }: { name: string; projectId: string }) => updateProject(projectId, name),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', project.id] });
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
    mutationFn: ({ filename, recordingId }: { filename: string; recordingId: string }) => updateRecording(recordingId, filename),
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

  const createManualCandidateMutation = useMutation({
    mutationFn: ({ runId, timestampMs }: { runId: string; timestampMs: number }) => createManualCandidate(runId, timestampMs),
    onSuccess: async (candidate) => {
      setAnalysisActionMessage(`Added manual step at ${candidate.timestamp_tc}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        selectedProjectId
          ? queryClient.fetchQuery({
              queryKey: ['project', selectedProjectId],
              queryFn: () => getProject(selectedProjectId),
            })
          : Promise.resolve(),
        queryClient.fetchQuery({
          queryKey: ['run', candidate.run_id],
          queryFn: () => getRun(candidate.run_id),
        }),
        queryClient.fetchQuery({
          queryKey: ['recording', candidate.recording_id],
          queryFn: () => getRecording(candidate.recording_id),
        }),
        queryClient.fetchQuery({
          queryKey: ['recording', candidate.recording_id, 'analysis'],
          queryFn: () => getRecording(candidate.recording_id),
        }),
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
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
    },
    onError: (error: Error) => setAppError(error.message),
  });

  const selectedProject = useMemo(() => {
    return projectsQuery.data?.find((project) => project.id === selectedProjectId) ?? null;
  }, [projectsQuery.data, selectedProjectId]);
  const activeProject = projectDetailQuery.data?.project ?? selectedProject;
  const hasSelectedProject = Boolean(selectedProjectId);
  const activeViewportStage: WorkflowStage = workflowStage === 'projects' || !hasSelectedProject ? 'projects' : workflowStage;
  const viewportMinimum = workflowViewportMinimums[activeViewportStage];
  const isViewportTooSmall = viewportSize.width < viewportMinimum.width || viewportSize.height < viewportMinimum.height;
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
  const selectedRecordingSummary = projectRecordings.find((recording) => recording.id === selectedRecordingId) ?? null;
  const previewRecording = projectRecordings.find((recording) => recording.id === previewRecordingId) ?? null;
  const effectiveProjectDefaultSettings = useMemo(
    () => clampRunSettingsForRecording(projectDefaultSettings, selectedRecordingSummary?.fps ?? null),
    [projectDefaultSettings, selectedRecordingSummary?.fps],
  );
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

  useEffect(() => {
    setRunSettings((current) => {
      const nextSettings = clampRunSettingsForRecording(current, selectedRecordingSummary?.fps ?? null);
      return areRunSettingsEqual(current, nextSettings) ? current : nextSettings;
    });
  }, [selectedRecordingSummary?.fps, runSettings.allow_high_fps_sampling]);

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

  function handleSaveProjectDefault() {
    if (!selectedProjectId) {
      return;
    }
    const savedPreset = persistProjectRunPreset(selectedProjectId, runSettings);
    setProjectDefaultSettings(savedPreset.settings);
    setSettingsFeedback('Saved the current settings for this project.');
  }

  function handleSaveBrowserDefault() {
    const savedPreset = persistGlobalRunPreset(runSettings);
    setGlobalPreset(savedPreset);
    setSettingsFeedback('Saved the current settings as universal defaults.');
  }

  function handleLoadProjectDefaults() {
    setRunSettings(effectiveProjectDefaultSettings);
    setSettingsFeedback("Loaded this project's defaults.");
  }

  function handleResetToProjectDefaults() {
    setRunSettings({ ...effectiveProjectDefaultSettings });
    setSettingsFeedback("Reset the current settings to this project's defaults.");
  }

  async function handleCreateManualRunCandidate(runId: string, timestampMs: number) {
    clearAnalysisMessages();
    return createManualCandidateMutation.mutateAsync({ runId, timestampMs });
  }

  function confirmDeleteRecording(recordingId: string, filename: string) {
    if (!window.confirm(`Delete ${filename} and every run, screenshot, and export created from it?`)) {
      return;
    }
    deleteRecordingMutation.mutate({ recordingId });
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
    let ignoredCount = 0;
    setImportQueue((current) => {
      const knownSignatures = new Set(current.map((item) => item.signature).filter((value): value is string => Boolean(value)));
      const additions = incomingFiles.flatMap((file) => {
        const signature = buildImportFileSignature(file);
        if (knownSignatures.has(signature)) {
          ignoredCount += 1;
          return [];
        }
        knownSignatures.add(signature);
        return [createImportQueueItemFromFile(file)];
      });
      return additions.length ? [...current, ...additions] : current;
    });
    if (ignoredCount > 0) {
      setImportSelectionFeedback(`${ignoredCount} duplicate ${ignoredCount === 1 ? 'video was' : 'videos were'} ignored.`);
    } else {
      setImportSelectionFeedback('');
    }
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

  async function handleExportRun(runId: string, mode: ExportMode, downloadName?: string): Promise<void> {
    clearAnalysisMessages();
    await exportRunMutation.mutateAsync({ downloadName, mode, runId });
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

  if (workflowStage === 'projects' || !hasSelectedProject) {
    return (
      <>
        <EntryScreen
          appError={appError}
          healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
          isCreating={createProjectMutation.isPending}
          onCreate={handleCreateProject}
          onNavigateStage={setProjectStage}
          onProjectNameChange={setProjectName}
          onRenameProject={handleRenameProject}
          onSelectProject={enterProject}
          projectName={projectName}
          projects={projectsQuery.data ?? []}
          projectsLoading={projectsQuery.isLoading}
          selectedProjectId={selectedProjectId}
        />
        <AppWatermark />
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
        <AppWatermark />
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
        dismissFallbackPending={dismissFallbackMutation.isPending}
        exportRunPending={exportRunMutation.isPending}
        healthMessage={healthWarning ? healthQuery.data?.message ?? 'Video tools are not ready.' : null}
        healthWarning={Boolean(healthWarning)}
        liveMessage={liveMessage}
        onAbortRun={(runId) => abortRunMutation.mutate(runId)}
        onDeleteRecording={confirmDeleteRecording}
        onDeleteSelectedRuns={handleDeleteSelectedRuns}
        onCreateManualCandidate={handleCreateManualRunCandidate}
        onDismissFallback={(runId) => dismissFallbackMutation.mutate(runId)}
        onExportRun={handleExportRun}
        onExportTaskRuns={handleExportTaskRuns}
        onJumpToSelection={handleJumpToAnalysisSelection}
        onLoadProjectPreset={handleLoadProjectDefaults}
        onNavigateStage={setProjectStage}
        onPreviewRecording={handlePreviewRecording}
        onRenameProject={handleRenameProject}
        onRenameRecording={handleRenameRecording}
        onResetPreset={handleResetToProjectDefaults}
        onSaveProjectPreset={handleSaveProjectDefault}
        onSaveUniversalPreset={handleSaveBrowserDefault}
        onSelectRecording={handleSelectRecording}
        onSelectRun={handleSelectTaskRun}
        onStartFallback={(runId) => startFallbackMutation.mutate(runId)}
        onStartRun={handleStartAnalysisRun}
        onUpdateCandidate={(candidateId, payload) => updateCandidateMutation.mutate({ candidateId, payload })}
        previewRecording={previewRecording}
        projectDefaultSettings={effectiveProjectDefaultSettings}
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
      <AppWatermark />
      {viewportWarning}
    </>
  );
}

interface EntryScreenProps {
  appError: string;
  healthMessage: string | null;
  isCreating: boolean;
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onProjectNameChange: (value: string) => void;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
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
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onRenameRow: (localId: string, filename: string) => Promise<void>;
  onUploadRow: (localId: string) => void;
  project: Project | null;
  rows: ImportQueueItem[];
  selectionFeedback: string;
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
  candidateSimilarityLinks: Map<string, SimilarLink>;
  createManualCandidatePending: boolean;
  createRunPending: boolean;
  dismissFallbackPending: boolean;
  exportRunPending: boolean;
  healthMessage: string | null;
  healthWarning: boolean;
  liveMessage: string;
  onAbortRun: (runId: string) => void;
  onCreateManualCandidate: (runId: string, timestampMs: number) => Promise<CandidateFrame>;
  onDeleteRecording: (recordingId: string, filename: string) => void;
  onDeleteSelectedRuns: (runIds: string[]) => Promise<string[] | null>;
  onDismissFallback: (runId: string) => void;
  onExportRun: (runId: string, mode: ExportMode, downloadName?: string) => Promise<void>;
  onExportTaskRuns: (runIds: string[]) => Promise<void>;
  onJumpToSelection: () => void;
  onLoadProjectPreset: () => void;
  onNavigateStage: (stage: WorkflowStage) => void;
  onPreviewRecording: (recordingId: string) => void;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onRenameRecording: (recordingId: string, filename: string) => Promise<void>;
  onResetPreset: () => void;
  onSaveProjectPreset: () => void;
  onSaveUniversalPreset: () => void;
  onSelectRecording: (recordingId: string) => void;
  onSelectRun: (recordingId: string, runId: string, anchorId?: string) => void;
  onStartFallback: (runId: string) => void;
  onStartRun: () => void;
  onUpdateCandidate: (candidateId: string, payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>>) => void;
  previewRecording: RecordingSummary | null;
  projectDefaultSettings: RunSettings;
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

function AppWatermark() {
  const [showAbout, setShowAbout] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showAbout) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (shellRef.current?.contains(event.target as Node)) {
        return;
      }
      setShowAbout(false);
    }

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [showAbout]);

  return (
    <div className="app-watermark-shell" ref={shellRef}>
      <span className="app-watermark-text">{APP_IDENTITY}</span>
      <button
        aria-expanded={showAbout}
        className={`app-watermark-about ${showAbout ? 'active' : ''}`}
        onClick={() => setShowAbout((current) => !current)}
        type="button"
      >
        about
      </button>
      {showAbout ? (
        <div className="app-watermark-popover">
          <p>Stepthrough helps researchers turn screen recordings into reviewable scene candidates for step-by-step analysis.</p>
          <p>version 0.1.0</p>
        </div>
      ) : null}
    </div>
  );
}

interface ViewportWarningProps {
  currentHeight: number;
  currentWidth: number;
  minimumHeight: number;
  minimumWidth: number;
}

function ViewportWarning({ currentHeight, currentWidth, minimumHeight, minimumWidth }: ViewportWarningProps) {
  return (
    <div className="viewport-warning-overlay" role="alert" aria-live="polite">
      <div className="viewport-warning-card">
        <h1>stepthrough works best with a larger window.</h1>
        <p>Try making your browser window wider/taller.</p>
        <p className="viewport-warning-meta">
          current window {currentWidth} × {currentHeight} · recommended minimum {minimumWidth} × {minimumHeight}
        </p>
      </div>
    </div>
  );
}

interface EditableNameProps {
  buttonClassName?: string;
  containerClassName?: string;
  disabled?: boolean;
  displayButtonClassName?: string;
  editRequestToken?: number | string | null;
  inputClassName?: string;
  lockedExtension?: boolean;
  onDisplayClick?: () => void;
  onSave: (nextValue: string) => Promise<void> | void;
  renameLabel: string;
  showRenameButton?: boolean;
  textClassName?: string;
  value: string;
}

function EditableName({
  buttonClassName,
  containerClassName,
  disabled = false,
  displayButtonClassName,
  editRequestToken,
  inputClassName,
  lockedExtension = false,
  onDisplayClick,
  onSave,
  renameLabel,
  showRenameButton = true,
  textClassName,
  value,
}: EditableNameProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { base, extension } = useMemo(() => (lockedExtension ? splitFilename(value) : { base: value, extension: '' }), [lockedExtension, value]);

  useEffect(() => {
    if (!isEditing) {
      setDraft(base);
      setError('');
      return;
    }
    setDraft(base);
    setError('');
  }, [base, isEditing]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [isEditing]);

  useEffect(() => {
    if (editRequestToken == null || disabled) {
      return;
    }
    setIsEditing(true);
  }, [disabled, editRequestToken]);

  async function commitRename() {
    const nextBase = draft.trim();
    if (!nextBase) {
      setError('name required');
      return false;
    }

    const nextValue = lockedExtension ? joinFilename(nextBase, extension) : nextBase;
    if (nextValue === value) {
      setIsEditing(false);
      setError('');
      return true;
    }

    setIsSaving(true);
    try {
      await onSave(nextValue);
      setIsEditing(false);
      setError('');
      return true;
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : 'Could not rename.');
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className={containerClassName ? `editable-name ${containerClassName}` : 'editable-name'}>
      {isEditing ? (
        <div className="editable-name-edit">
          <input
            aria-label={renameLabel}
            className={inputClassName ? `editable-name-input ${inputClassName}` : 'editable-name-input'}
            disabled={isSaving}
            onBlur={() => {
              void commitRename();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) {
                setError('');
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commitRename();
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(base);
                setError('');
                setIsEditing(false);
              }
            }}
            ref={inputRef}
            type="text"
            value={draft}
          />
          {lockedExtension && extension ? <span className="editable-name-suffix">{extension}</span> : null}
        </div>
      ) : (
        <>
          {onDisplayClick ? (
            <button
              className={displayButtonClassName ? `editable-name-display-button ${displayButtonClassName}` : 'editable-name-display-button'}
              onClick={onDisplayClick}
              type="button"
            >
              <span className={textClassName ? `editable-name-text ${textClassName}` : 'editable-name-text'} title={value}>
                {value}
              </span>
            </button>
          ) : (
            <span className={textClassName ? `editable-name-text ${textClassName}` : 'editable-name-text'} title={value}>
              {value}
            </span>
          )}
          {showRenameButton ? (
            <button
              className={buttonClassName ? `editable-name-button ${buttonClassName}` : 'editable-name-button'}
              disabled={disabled}
              onClick={() => setIsEditing(true)}
              type="button"
            >
              rename
            </button>
          ) : null}
        </>
      )}
      {error ? <span className="editable-name-error">{error}</span> : null}
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
  onRenameProject,
  onRenameRow,
  onUploadRow,
  project,
  rows,
  selectionFeedback,
}: ImportScreenProps) {
  const [isDropzoneActive, setIsDropzoneActive] = useState(false);
  const uploadedCount = rows.filter((row) => row.status === 'uploaded').length;
  const queuedCount = rows.filter((row) => row.status !== 'uploaded').length;

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
              {project ? (
                <EditableName
                  buttonClassName="entry-rename-button"
                  containerClassName="import-project-name"
                  onSave={(nextValue) => onRenameProject(project.id, nextValue)}
                  renameLabel={`Rename project ${project.name}`}
                  textClassName="import-project-title"
                  value={project.name}
                />
              ) : (
                <p className="import-project-title">Loading project…</p>
              )}
              <p className="import-project-meta">{project ? formatProjectSummary(project) : 'Loading project details…'}</p>
            </div>
            <div className="import-header-actions">
              <button className="entry-enter-button import-done-button" disabled={!canComplete} onClick={onDone} type="button">
                done
              </button>
            </div>
          </div>

          <div className="import-section-head">
            <p className="import-section-title">import videos</p>
            <p className="import-status-copy">
              {uploadedCount} {uploadedCount === 1 ? 'video' : 'videos'} imported
              {queuedCount ? ` • ${queuedCount} queued` : ''}
            </p>
          </div>

          <label
            className={`import-dropzone ${isUploadBlocked ? 'disabled' : ''} ${isDropzoneActive ? 'dragging' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDropzoneActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                return;
              }
              setIsDropzoneActive(false);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDropzoneActive(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDropzoneActive(false);
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
          {selectionFeedback ? <p className="import-feedback-copy">{selectionFeedback}</p> : null}
          <p className="import-format-copy">supports .mp4, .mov, .m4v, .webm, and .mkv uploads</p>

          <div className="import-queue">
            {rows.map((row) => (
              <div className="import-row" key={row.localId}>
                <div className="import-row-copy">
                  <EditableName
                    buttonClassName="entry-rename-button"
                    containerClassName="import-row-name"
                    inputClassName="import-row-input"
                    lockedExtension
                    onSave={(nextValue) => onRenameRow(row.localId, nextValue)}
                    renameLabel={`Rename video ${row.filename}`}
                    textClassName="import-row-title"
                    value={row.filename}
                  />
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
  candidateSimilarityLinks,
  createManualCandidatePending,
  createRunPending,
  dismissFallbackPending,
  exportRunPending,
  healthMessage,
  healthWarning,
  liveMessage,
  onAbortRun,
  onCreateManualCandidate,
  onDeleteRecording,
  onDeleteSelectedRuns,
  onDismissFallback,
  onExportRun,
  onExportTaskRuns,
  onJumpToSelection,
  onLoadProjectPreset,
  onNavigateStage,
  onPreviewRecording,
  onRenameProject,
  onRenameRecording,
  onResetPreset,
  onSaveProjectPreset,
  onSaveUniversalPreset,
  onSelectRecording,
  onSelectRun,
  onStartFallback,
  onStartRun,
  onUpdateCandidate,
  previewRecording,
  projectDefaultSettings,
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
  const [taskFilter, setTaskFilter] = useState<AnalysisTaskFilter>('all');
  const [taskSelectMode, setTaskSelectMode] = useState(false);
  const [videoRenameRequest, setVideoRenameRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [activeCandidateFilter, setActiveCandidateFilter] = useState<CandidateFilter>('all');
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [pendingManualMarkTimestampMs, setPendingManualMarkTimestampMs] = useState<number | null>(null);
  const [expandedAnnotationCandidateId, setExpandedAnnotationCandidateId] = useState<string | null>(null);
  const [exportNameDraft, setExportNameDraft] = useState('');
  const [previewPlaybackMs, setPreviewPlaybackMs] = useState(0);
  const [showRunLogs, setShowRunLogs] = useState(false);
  const [presetCopyFeedback, setPresetCopyFeedback] = useState('');
  const [showHints, setShowHints] = useState(false);
  const [taskClockMs, setTaskClockMs] = useState(() => Date.now());
  const [focusedHintKey, setFocusedHintKey] = useState<AnalysisHintKey | null>(null);
  const [hoveredHintKey, setHoveredHintKey] = useState<AnalysisHintKey | null>(null);
  const [hintCardPosition, setHintCardPosition] = useState<{ left: number; top: number } | null>(null);
  const parameterColumnRef = useRef<HTMLElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const saveMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  const previewVideoUrl = previewRecording ? absoluteApiUrl(previewRecording.source_url) : null;
  const sampleFpsGuardrail = getSampleFpsGuardrail(selectedRecordingSummary?.fps ?? null, runSettings.allow_high_fps_sampling);
  const hintCopy: Record<AnalysisHintKey, string> = {
    allow_high_fps_sampling: sampleFpsGuardrail.isHighFpsRecording
      ? `Turn this on to sample above 30 fps or use source fps for this ${sampleFpsGuardrail.sourceFpsCeiling} fps recording.`
      : 'Use this only when you need denser sampling on recordings above 30 fps.',
    detector_mode: describeDetectorMode(runSettings.detector_mode),
    extract_offset_ms: describeExtractOffset(runSettings.extract_offset_ms),
    load: 'Load this project\'s saved defaults into the active analysis parameters.',
    min_scene_gap_ms: describeMinSceneGap(runSettings.min_scene_gap_ms),
    reset: 'Reset the current analysis parameters back to this project\'s defaults.',
    run: 'Start a new analysis task for the selected video using the current parameter set.',
    sample_fps: describeSampleFps(runSettings.sample_fps),
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
  const previewMatchesSelectedRun = Boolean(previewRecording && selectedRun && previewRecording.id === selectedRun.summary.recording_id);
  const isToleranceDirty = runSettings.tolerance !== projectDefaultSettings.tolerance;
  const isMinSceneGapDirty = runSettings.min_scene_gap_ms !== projectDefaultSettings.min_scene_gap_ms;
  const isSampleFpsDirty = runSettings.sample_fps !== projectDefaultSettings.sample_fps;
  const isHighFpsDirty = runSettings.allow_high_fps_sampling !== projectDefaultSettings.allow_high_fps_sampling;
  const isExtractOffsetDirty = runSettings.extract_offset_ms !== projectDefaultSettings.extract_offset_ms;
  const isDetectorModeDirty = runSettings.detector_mode !== projectDefaultSettings.detector_mode;
  const canAddManualCandidate = Boolean(
    previewMatchesSelectedRun && selectedRun && ['completed', 'failed', 'cancelled'].includes(selectedRun.summary.status),
  );
  const showHighFpsWarning = Boolean(selectedRecordingSummary && sampleFpsGuardrail.isHighFpsRecording && !runSettings.allow_high_fps_sampling);
  const showLowCandidateHint = Boolean(
    selectedRun &&
      (selectedRun.summary.needs_fallback_decision ||
        (['completed', 'failed', 'cancelled'].includes(selectedRun.summary.status) && selectedRun.candidates.length <= 2)),
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
    return selectedRun.candidates.filter((candidate) => candidateMatchesFilter(candidate, activeCandidateFilter));
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
  const canShowTimeline =
    Boolean(
      isCompletedReview &&
        selectedRecordingSummary &&
        selectedRecordingSummary.duration_ms > 0 &&
        timelineCandidates.length > 0,
    );
  const canExportAccepted = Boolean(selectedRun && selectedRun.summary.status === 'completed' && selectedRun.accepted_steps.length > 0);
  const canExportAll = Boolean(selectedRun && selectedRun.summary.status === 'completed' && selectedRun.candidates.length > 0);

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
    setActiveCandidateFilter(canReviewCandidates ? 'all' : 'pending');
    setExpandedAnnotationCandidateId(null);
  }, [canReviewCandidates, selectedRun?.summary.id]);

  useEffect(() => {
    setShowRunLogs(false);
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    setShowExportMenu(false);
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    setPendingManualMarkTimestampMs(null);
  }, [selectedRun?.summary.id]);

  useEffect(() => {
    if (!showSaveMenu && !showExportMenu) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (saveMenuRef.current?.contains(target) || exportMenuRef.current?.contains(target)) {
        return;
      }
      setShowSaveMenu(false);
      setShowExportMenu(false);
    }

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [showExportMenu, showSaveMenu]);

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
    if (!selectedRun || selectedRun.summary.status !== 'completed') {
      setExportNameDraft('');
      return;
    }

    setExportNameDraft(buildReviewExportName(selectedRecordingSummary?.filename ?? selectedRun.summary.recording_id));
  }, [selectedRecordingSummary?.filename, selectedRun?.summary.id, selectedRun?.summary.recording_id, selectedRun?.summary.status]);

  useEffect(() => {
    if (!presetCopyFeedback) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => setPresetCopyFeedback(''), 1800);
    return () => globalThis.clearTimeout(timeoutId);
  }, [presetCopyFeedback]);

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

  async function handleSelectedRunExport(mode: ExportMode) {
    if (!selectedRun) {
      return;
    }
    await onExportRun(selectedRun.summary.id, mode, exportNameDraft);
    setShowExportMenu(false);
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

  async function handleCreateManualCandidate(timestampOverrideMs?: number) {
    if (!selectedRun || !canAddManualCandidate) {
      return;
    }

    const timestampMs = timestampOverrideMs ?? getCurrentPreviewTimestampMs();
    if (timestampMs === null) {
      return;
    }
    setPendingManualMarkTimestampMs(timestampMs);
    try {
      await onCreateManualCandidate(selectedRun.summary.id, timestampMs);
      setPendingManualMarkTimestampMs(null);
    } catch {
      setPendingManualMarkTimestampMs(null);
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
    setActiveCandidateId(candidate.id);

    if (options?.seekPreview && previewMatchesSelectedRun && previewVideoRef.current) {
      previewVideoRef.current.currentTime = candidate.timestamp_ms / 1000;
      setPreviewPlaybackMs(candidate.timestamp_ms);
    }

    window.setTimeout(() => jumpToAnchor(`candidate-${candidate.id}`), 0);
  }

  function handleCandidateStatusChange(candidate: CandidateFrame, status: CandidateStatus) {
    setActiveCandidateId(candidate.id);
    onUpdateCandidate(candidate.id, { status });
    if (status === 'pending') {
      return;
    }
    const nextCandidateId = getNextCandidateFocusId(selectedRun?.candidates ?? [], candidate.id, activeCandidateFilter);
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

    const currentIndex = activeCandidateId ? filteredCandidates.findIndex((candidate) => candidate.id === activeCandidateId) : -1;
    const nextIndex =
      currentIndex === -1 ? (direction > 0 ? 0 : filteredCandidates.length - 1) : clampInteger(currentIndex + direction, 0, filteredCandidates.length - 1);
    activateCandidate(filteredCandidates[nextIndex].id);
  }

  function renderTaskRow(item: AnalysisTaskItem) {
    const run = item.run;
    const isExpanded = expandedTaskRunId === run.id;
    const isSelected = selectedRun?.summary.id === run.id;
    const isMarked = selectedTaskRunIds.includes(run.id);
    const isError = run.status === 'failed';
    const isDone = run.status === 'completed';
    const hasCandidates = run.candidate_count > 0;
    const actionButtons: Array<{ anchorId?: string; label: string; tone?: 'danger' | 'subtle' }> = [];
    const taskSettings = [
      { key: 'tolerance', label: 'tolerance', value: String(run.tolerance), isDirty: run.tolerance !== projectDefaultSettings.tolerance },
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
      actionButtons.push({ label: 'end', tone: 'danger' });
    } else {
      if (hasCandidates && ['completed', 'failed', 'cancelled'].includes(run.status)) {
        actionButtons.push({ anchorId: 'analysis-candidate-review', label: 'review outputs', tone: 'subtle' });
      } else if (!hasCandidates) {
        actionButtons.push({ anchorId: 'analysis-run-detail', label: 'view task', tone: 'subtle' });
      }
    }

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
            {elapsedLabel ? <span className="analysis-task-elapsed">{elapsedLabel}</span> : null}
            <button
              className={`analysis-task-link ${isExpanded ? 'plain' : ''}`}
              onClick={() => setExpandedTaskRunId((current) => (current === run.id ? null : run.id))}
              type="button"
            >
              details
            </button>
            {actionButtons.map((action) =>
              action.label === 'end' ? (
                <button className="analysis-task-link danger" key={action.label} onClick={() => onAbortRun(run.id)} type="button">
                  {action.label}
                </button>
              ) : (
                <button
                  className="analysis-task-link subtle"
                  key={action.label}
                  onClick={() => {
                    if (action.label === 'review outputs') {
                      setActiveCandidateFilter('all');
                    }
                    onSelectRun(item.recording.id, run.id, action.anchorId ?? 'analysis-run-detail');
                  }}
                  type="button"
                >
                  {action.label}
                </button>
              ),
            )}
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
                    <div className="analysis-video-row-button">
                      <EditableName
                        containerClassName="analysis-video-name"
                        displayButtonClassName="analysis-video-select-button"
                        editRequestToken={videoRenameRequest?.id === recording.id ? videoRenameRequest.nonce : null}
                        lockedExtension
                        onDisplayClick={() => onSelectRecording(recording.id)}
                        onSave={(nextValue) => onRenameRecording(recording.id, nextValue)}
                        renameLabel={`Rename video ${recording.filename}`}
                        showRenameButton={false}
                        textClassName="analysis-video-name-text"
                        value={recording.filename}
                      />
                      <span className="analysis-video-duration">{recording.duration_tc}</span>
                    </div>
                    <div className="analysis-video-actions">
                      <button
                        className="analysis-task-link subtle analysis-video-hover-link"
                        onClick={() =>
                          setVideoRenameRequest((current) => ({
                            id: recording.id,
                            nonce: current?.id === recording.id ? current.nonce + 1 : 1,
                          }))
                        }
                        type="button"
                      >
                        rename
                      </button>
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
                <button className="analysis-pill success" {...bindHint('load')} onClick={onLoadProjectPreset} type="button">
                  load
                </button>
                <div className="analysis-save-shell" ref={saveMenuRef}>
                  <button
                    aria-expanded={showSaveMenu}
                    className="analysis-pill analysis-pill-accent"
                    {...bindHint('save')}
                    onClick={() => {
                      setShowExportMenu(false);
                      setShowSaveMenu((current) => !current);
                    }}
                    type="button"
                  >
                    save...
                  </button>
                  {showSaveMenu ? (
                    <div className="analysis-save-popover">
                      <div className="analysis-save-option-list">
                        <button
                          className="analysis-task-link subtle"
                          onClick={() => {
                            onSaveProjectPreset();
                            setShowSaveMenu(false);
                          }}
                          type="button"
                        >
                          save for this project
                        </button>
                        <button
                          className="analysis-task-link subtle"
                          onClick={() => {
                            onSaveUniversalPreset();
                            setShowSaveMenu(false);
                          }}
                          type="button"
                        >
                          save as universal defaults
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
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
                    min={1}
                    onChange={(rawValue) =>
                      setRunSettings((current) => ({
                        ...current,
                        tolerance: clampInteger(rawValue === '' ? 1 : Number(rawValue), 1, 100),
                      }))
                    }
                    onStep={(direction) =>
                      setRunSettings((current) => ({
                        ...current,
                        tolerance: clampInteger(current.tolerance + direction, 1, 100),
                      }))
                    }
                    value={runSettings.tolerance}
                  />
                </div>
                {isToleranceDirty && (
                  <AnalysisResetDiamondButton
                    className="outside"
                    label="tolerance"
                    onClick={() => setRunSettings((current) => ({ ...current, tolerance: projectDefaultSettings.tolerance }))}
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
                    onClick={() => setRunSettings((current) => ({ ...current, min_scene_gap_ms: projectDefaultSettings.min_scene_gap_ms }))}
                  />
                )}
              </label>
              <label className="analysis-parameter-row" {...bindHint('sample_fps')}>
                <span>sample fps</span>
                <div className="analysis-parameter-control">
                  <AnalysisStepperInput
                    ariaLabel="sample fps"
                    className="analysis-parameter-input short"
                    max={sampleFpsGuardrail.maxSampleFps}
                    min={1}
                    onChange={(rawValue) =>
                      setRunSettings((current) =>
                        clampRunSettingsForRecording(
                          {
                            ...current,
                            sample_fps: rawValue
                              ? clampInteger(Number(rawValue), 1, sampleFpsGuardrail.maxSampleFps)
                              : sampleFpsGuardrail.sourceFpsAvailable
                                ? null
                                : sampleFpsGuardrail.maxSampleFps,
                          },
                          selectedRecordingSummary?.fps ?? null,
                        ),
                      )
                    }
                    onStep={(direction) =>
                      setRunSettings((current) =>
                        clampRunSettingsForRecording(
                          {
                            ...current,
                            sample_fps: clampInteger((current.sample_fps ?? 1) + direction, 1, sampleFpsGuardrail.maxSampleFps),
                          },
                          selectedRecordingSummary?.fps ?? null,
                        ),
                      )
                    }
                    value={runSettings.sample_fps ?? ''}
                  />
                </div>
                {isSampleFpsDirty && (
                  <AnalysisResetDiamondButton
                    className="outside"
                    label="sample fps"
                    onClick={() => setRunSettings((current) => ({ ...current, sample_fps: projectDefaultSettings.sample_fps }))}
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
                    onClick={() => setRunSettings((current) => ({ ...current, extract_offset_ms: projectDefaultSettings.extract_offset_ms }))}
                  />
                )}
              </label>
            </div>

            <div className="analysis-mode-row" {...bindHint('allow_high_fps_sampling')}>
              <span>high-fps sampling</span>
              <div className="analysis-parameter-control">
                <div className="analysis-mode-toggle">
                  <button
                    className={`analysis-mode-button ${runSettings.allow_high_fps_sampling ? '' : 'active'}`}
                    onClick={() =>
                      setRunSettings((current) =>
                        clampRunSettingsForRecording(
                          {
                            ...current,
                            allow_high_fps_sampling: false,
                          },
                          selectedRecordingSummary?.fps ?? null,
                        ),
                      )
                    }
                    type="button"
                  >
                    off
                  </button>
                  <button
                    className={`analysis-mode-button ${runSettings.allow_high_fps_sampling ? 'active' : ''}`}
                    onClick={() =>
                      setRunSettings((current) =>
                        clampRunSettingsForRecording(
                          {
                            ...current,
                            allow_high_fps_sampling: true,
                          },
                          selectedRecordingSummary?.fps ?? null,
                        ),
                      )
                    }
                    type="button"
                  >
                    on
                  </button>
                </div>
              </div>
              {isHighFpsDirty && (
                <AnalysisResetDiamondButton
                  className="outside"
                  label="high-fps sampling"
                  onClick={() =>
                    setRunSettings((current) =>
                      clampRunSettingsForRecording(
                        {
                          ...current,
                          allow_high_fps_sampling: projectDefaultSettings.allow_high_fps_sampling,
                        },
                        selectedRecordingSummary?.fps ?? null,
                      ),
                    )
                  }
                />
              )}
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
                  onClick={() => setRunSettings((current) => ({ ...current, detector_mode: projectDefaultSettings.detector_mode }))}
                />
              )}
            </div>

            <div className="analysis-mode-row analysis-parallel-row">
              <span>parallel processing</span>
              <span className="analysis-parallel-value">across videos only</span>
            </div>
            <p className="analysis-parallel-copy">Different videos can process in parallel. Each video keeps one active task at a time.</p>

            <div className="analysis-guidance-block">
              <p className="analysis-guidance-copy">
                If steps are missing, raise sample fps first, then lower tolerance, then lower minimum scene gaps. Use extract
                offset only to improve screenshot timing.
              </p>
              {showHighFpsWarning ? (
                <p className="analysis-guidance-copy warning">
                  This video is {sampleFpsGuardrail.sourceFpsCeiling} fps. Turn on high-fps sampling to use source fps or go above
                  30 fps.
                </p>
              ) : null}
              {showLowCandidateHint ? (
                <p className="analysis-guidance-copy warning">
                  This run found very few scenes. Try higher sample fps first, then lower tolerance or minimum scene gaps.
                </p>
              ) : null}
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
              <div className="analysis-task-head-tools">
                <div className="analysis-task-filter-tabs">
                  {analysisTaskFilters.map((filter) => (
                    <button
                      className={`analysis-task-filter-button ${taskFilter === filter ? 'active' : ''}`}
                      key={filter}
                      onClick={() => setTaskFilter(filter)}
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
            </div>
            <div className="analysis-divider" />
            <div className="analysis-tasks">
              {filteredAnalysisTaskItems.map((item) => renderTaskRow(item))}
              {!analysisTaskItems.length && <p className="entry-empty-copy">Run summaries will appear here once analysis starts.</p>}
              {Boolean(analysisTaskItems.length) && !filteredAnalysisTaskItems.length && (
                <p className="entry-empty-copy">No tasks in this filter yet.</p>
              )}
            </div>
          </section>
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
                          {pendingManualMarkTimestampMs !== null
                            ? `marking ${formatPlaybackTimestamp(pendingManualMarkTimestampMs)}…`
                            : 'marks the current frame immediately'}
                        </span>
                      ) : null}
                    </div>
                    {canAddManualCandidate ? (
                      <button
                        className="analysis-pill success analysis-preview-mark-button"
                        disabled={createManualCandidatePending}
                        onClick={(event) => {
                          if (event.detail !== 0) {
                            return;
                          }
                          void handleCreateManualCandidate();
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
                          void handleCreateManualCandidate(timestampMs);
                        }}
                        title="Mark the current preview frame as a new step."
                        type="button"
                      >
                        {createManualCandidatePending ? 'marking…' : 'mark step (K)'}
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
                    <span className={`status-pill ${selectedRun.summary.status}`}>{selectedRun.summary.status.replace('_', ' ')}</span>
                  </div>
                )}
                {!isCompletedReview && selectedRun.summary.message ? <p className="muted">{selectedRun.summary.message}</p> : null}
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
                                <span className="analysis-log-line-progress">{formatPercent(event.progress)}</span>
                              ) : null}
                            </p>
                          ))}
                          {!selectedRun.events.length && <p className="empty-copy">Progress messages will appear here once the run starts.</p>}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              {selectedRun.summary.is_abortable || selectedRun.summary.needs_fallback_decision ? (
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
                </div>
              ) : null}
            </div>

            {!isCompletedReview ? (
              <div className="analysis-task-bar" aria-hidden="true">
                <div className="analysis-task-bar-fill" style={{ width: formatPercent(selectedRun.summary.progress) }} />
              </div>
            ) : null}

            {selectedRun.summary.needs_fallback_decision && (
              <div className="banner warning-banner banner-block">
                <strong>Primary pass found only the opening frame.</strong>
                <span>Run a sensitive fallback if the current result missed meaningful transitions.</span>
              </div>
            )}

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
                            left: `${Math.min(100, Math.max(0, (previewPlaybackMs / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100))}%`,
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
                              left: `${Math.min(100, Math.max(0, (candidate.timestamp_ms / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100))}%`,
                            }}
                            title={tooltip}
                            type="button"
                          />
                        );
                      })}
                      {pendingManualMarkTimestampMs !== null ? (
                        <span
                          aria-hidden="true"
                          className="candidate-timeline-pin pending manual-pending active"
                          data-tooltip={`marking step • ${formatPlaybackTimestamp(pendingManualMarkTimestampMs)}`}
                          style={{
                            left: `${Math.min(100, Math.max(0, (pendingManualMarkTimestampMs / Math.max(1, selectedRecordingSummary?.duration_ms ?? 1)) * 100))}%`,
                          }}
                        />
                      ) : null}
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
                  </div>
                  {isCompletedReview ? (
                    <div className="candidate-review-actions">
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
                      <div className="candidate-export-shell" ref={exportMenuRef}>
                        <button
                          className="analysis-pill success"
                          disabled={!canExportAll || exportRunPending}
                          onClick={() => {
                            setShowSaveMenu(false);
                            setShowExportMenu((current) => !current);
                          }}
                          type="button"
                        >
                          {exportRunPending ? 'exporting...' : 'export'}
                        </button>
                        {showExportMenu ? (
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
                          key={candidate.id}
                          onActivate={() => setActiveCandidateId(candidate.id)}
                          onJumpToSimilar={similarityLink ? () => jumpToAnchor(similarityLink.targetId) : undefined}
                          onSetStatus={(status) => handleCandidateStatusChange(candidate, status)}
                          onToggleAnnotation={() => handleToggleCandidateAnnotation(candidate.id)}
                          onUpdate={(payload) => onUpdateCandidate(candidate.id, payload)}
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

function EntryScreen({
  appError,
  healthMessage,
  isCreating,
  onCreate,
  onNavigateStage,
  onProjectNameChange,
  onRenameProject,
  onSelectProject,
  projectName,
  projects,
  projectsLoading,
  selectedProjectId,
}: EntryScreenProps) {
  const [projectSearch, setProjectSearch] = useState('');
  const [projectSort, setProjectSort] = useState<'name' | 'recent'>('recent');
  const visibleProjects = useMemo(() => {
    const searchValue = projectSearch.trim().toLowerCase();
    const filteredProjects = projects.filter((project) => project.name.toLowerCase().includes(searchValue));

    return filteredProjects.sort((left, right) => {
      if (projectSort === 'name') {
        return left.name.localeCompare(right.name);
      }
      const activityDelta = new Date(right.last_activity_at).getTime() - new Date(left.last_activity_at).getTime();
      if (activityDelta !== 0) {
        return activityDelta;
      }
      return left.name.localeCompare(right.name);
    });
  }, [projectSearch, projectSort, projects]);

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

          <div className="entry-project-browser">
            <div className="entry-project-tools">
              <input
                className="entry-project-search"
                onChange={(event) => setProjectSearch(event.target.value)}
                placeholder="search projects"
                value={projectSearch}
              />
              <div className="entry-project-sort">
                <button
                  className={`entry-project-sort-button ${projectSort === 'recent' ? 'active' : ''}`}
                  onClick={() => setProjectSort('recent')}
                  type="button"
                >
                  recent
                </button>
                <button
                  className={`entry-project-sort-button ${projectSort === 'name' ? 'active' : ''}`}
                  onClick={() => setProjectSort('name')}
                  type="button"
                >
                  a-z
                </button>
              </div>
            </div>

            <div className="entry-project-list">
              {visibleProjects.map((project) => (
                <div className={`entry-project-row-shell ${project.id === selectedProjectId ? 'selected' : ''}`} key={project.id}>
                  <div className="entry-project-row">
                    <EditableName
                      buttonClassName="entry-rename-button"
                      containerClassName="entry-project-name"
                      displayButtonClassName="entry-project-select-button"
                      onDisplayClick={() => onSelectProject(project.id)}
                      onSave={(nextValue) => onRenameProject(project.id, nextValue)}
                      renameLabel={`Rename project ${project.name}`}
                      textClassName="entry-project-name-text"
                      value={project.name}
                    />
                    <button className="entry-project-summary-button" onClick={() => onSelectProject(project.id)} type="button">
                      <small>{formatProjectSummary(project)}</small>
                    </button>
                  </div>
                </div>
              ))}
              {!projects.length && !projectsLoading && <p className="entry-empty-copy">No existing projects yet.</p>}
              {Boolean(projects.length) && !visibleProjects.length && !projectsLoading && (
                <p className="entry-empty-copy">No projects match that search.</p>
              )}
              {projectsLoading && <p className="entry-empty-copy">Loading projects…</p>}
            </div>
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
  isActive: boolean;
  isAnnotationExpanded: boolean;
  onActivate: () => void;
  onJumpToSimilar?: (() => void) | undefined;
  onSetStatus: (status: CandidateStatus) => void;
  onToggleAnnotation: () => void;
  similarLink?: SimilarLink | undefined;
  onUpdate: (payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>>) => void;
}

interface CandidateDecisionButtonProps {
  intent: CandidateStatus;
  isActive: boolean;
  label: string;
  onClick: () => void;
}

function CandidateDecisionButton({ intent, isActive, label, onClick }: CandidateDecisionButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={isActive}
      className={`candidate-decision-button ${intent} ${isActive ? 'active' : ''}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      <svg aria-hidden="true" className="candidate-decision-icon" viewBox="0 0 16 16">
        {intent === 'accepted' ? (
          <path d="M3.5 8.5 6.4 11.4 12.5 4.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
        ) : intent === 'rejected' ? (
          <path d="M4.3 4.3 11.7 11.7M11.7 4.3 4.3 11.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" />
        ) : (
          <path d="M11.6 6.2A4.4 4.4 0 1 0 12 8m0-3.8V7.6H8.6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
        )}
      </svg>
    </button>
  );
}

function CandidateCard({
  candidate,
  isActive,
  isAnnotationExpanded,
  onActivate,
  onJumpToSimilar,
  onSetStatus,
  onToggleAnnotation,
  similarLink,
  onUpdate,
}: CandidateCardProps) {
  const [title, setTitle] = useState(candidate.title ?? '');
  const [notes, setNotes] = useState(candidate.notes ?? '');
  const annotationToggleLabel = isAnnotationExpanded ? 'hide notes' : candidate.title || candidate.notes ? 'edit notes' : 'annotate';

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

  return (
    <article
      className={`candidate-card ${candidate.status} ${isActive ? 'active' : ''}`}
      id={`candidate-${candidate.id}`}
      onClick={onActivate}
      onFocus={onActivate}
      tabIndex={-1}
    >
      <div className="candidate-image-wrap">
        <img alt={`Candidate screenshot at ${candidate.timestamp_tc}`} src={absoluteApiUrl(candidate.image_url)} />
        <div className="candidate-overlay">
          <span className="candidate-timecode">{candidate.timestamp_tc}</span>
        </div>
      </div>
      <div className="candidate-body">
        <div className="candidate-headline">
          <div className="candidate-heading-copy">
            <strong className="candidate-title">{candidate.candidate_origin === 'manual' ? 'manual step' : 'candidate'} {candidate.detector_index}</strong>
            <div className="candidate-heading-meta">
              <span className={`candidate-status-copy ${candidate.status}`}>{candidate.status}</span>
              {candidate.candidate_origin === 'manual' ? <span className="candidate-origin-copy">manual</span> : null}
            </div>
          </div>
          <div className="candidate-decision-row">
            <CandidateDecisionButton
              intent="accepted"
              isActive={candidate.status === 'accepted'}
              label="Accept candidate"
              onClick={() => onSetStatus('accepted')}
            />
            <CandidateDecisionButton
              intent="rejected"
              isActive={candidate.status === 'rejected'}
              label="Reject candidate"
              onClick={() => onSetStatus('rejected')}
            />
            <CandidateDecisionButton
              intent="pending"
              isActive={candidate.status === 'pending'}
              label="Reset candidate to pending"
              onClick={() => onSetStatus('pending')}
            />
          </div>
        </div>

        <div className="candidate-meta-row">
          <details className="candidate-scores">
            <summary>scores</summary>
            <div className="candidate-scores-body">
              <span>
                change <strong className="info-text">{candidate.scene_score.toFixed(2)}</strong>
              </span>
              {typeof candidate.similarity_distance === 'number' && (
                <span>
                  similarity <strong className="warning-text">{candidate.similarity_distance.toFixed(2)}</strong>
                </span>
              )}
            </div>
          </details>
          <button className="candidate-annotation-toggle" onClick={onToggleAnnotation} type="button">
            {annotationToggleLabel}
          </button>
        </div>

        {similarLink && onJumpToSimilar && (
          <div className="candidate-secondary-row">
            <button
              className="inline-link-button candidate-similarity-link"
              onClick={onJumpToSimilar}
              title="Jump to the earlier matching scene."
              type="button"
            >
              {similarLink.label}
            </button>
          </div>
        )}

        {isAnnotationExpanded && (
          <div className="candidate-annotation-panel">
            <label className="candidate-field-group">
              <span>step title</span>
              <input
                className="candidate-field"
                onBlur={(event) => commitTextField('title', event.target.value)}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Optional custom label"
                value={title}
              />
            </label>

            <label className="candidate-field-group">
              <span>notes</span>
              <textarea
                className="candidate-field candidate-notes-field"
                onBlur={(event) => commitTextField('notes', event.target.value)}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Add observation, annotation note, or coding hint"
                value={notes}
              />
            </label>
          </div>
        )}
      </div>
    </article>
  );
}

export default App;
