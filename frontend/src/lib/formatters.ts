import type { Project, RecordingSummary, RunPhase, RunSummary } from '../types';

const phaseLabels: Record<RunPhase, string> = {
  queued: 'queued',
  probing: 'preparing',
  primary_scan: 'scanning scene changes',
  primary_extract: 'extracting candidate screenshots',
  awaiting_fallback: 'awaiting fallback',
  fallback_scan: 'fallback scan',
  fallback_extract: 'fallback extract',
  exporting: 'exporting assets',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'aborted',
};

function formatLowercaseLocaleText(value: string): string {
  return value.toLocaleLowerCase();
}

const commonAspectRatios = [
  { height: 9, label: '16:9', width: 16 },
  { height: 16, label: '9:16', width: 9 },
  { height: 3, label: '4:3', width: 4 },
  { height: 4, label: '3:4', width: 3 },
  { height: 2, label: '3:2', width: 3 },
  { height: 3, label: '2:3', width: 2 },
  { height: 1, label: '1:1', width: 1 },
  { height: 9, label: '19.5:9', width: 19.5 },
  { height: 19.5, label: '9:19.5', width: 9 },
  { height: 9, label: '18:9', width: 18 },
  { height: 18, label: '9:18', width: 9 },
  { height: 4, label: '5:4', width: 5 },
  { height: 5, label: '4:5', width: 4 },
];

export function formatPercent(progress: number): string {
  return `${Math.round(progress * 100)}%`;
}

export function formatPhase(phase: RunPhase): string {
  return phaseLabels[phase] ?? phase;
}

export function formatRunTiming(run: RunSummary): string {
  if (run.status === 'completed' && run.completed_at) {
    return `finished ${formatLowercaseLocaleText(new Date(run.completed_at).toLocaleString())}`;
  }
  if (run.status === 'cancelled' && run.completed_at) {
    return `aborted ${formatLowercaseLocaleText(new Date(run.completed_at).toLocaleString())}`;
  }
  if (run.status === 'failed' && run.completed_at) {
    return `failed ${formatLowercaseLocaleText(new Date(run.completed_at).toLocaleString())}`;
  }
  if (run.started_at) {
    return `started ${formatLowercaseLocaleText(new Date(run.started_at).toLocaleString())}`;
  }
  return `created ${formatLowercaseLocaleText(new Date(run.created_at).toLocaleString())}`;
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

export function formatProjectSummary(project: Project): string {
  const videoLabel = `${project.recording_count} ${project.recording_count === 1 ? 'video' : 'videos'}`;
  const runLabel = `${project.run_count} ${project.run_count === 1 ? 'run' : 'runs'}`;
  return `${videoLabel} • ${runLabel} • ${formatProjectActivity(project.last_activity_at)}`;
}

export function formatProjectCounts(project: Project): string {
  const videoLabel = `${project.recording_count} ${project.recording_count === 1 ? 'video' : 'videos'}`;
  const runLabel = `${project.run_count} ${project.run_count === 1 ? 'run' : 'runs'}`;
  return `${videoLabel} • ${runLabel}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

export function formatAspectRatio(width: number, height: number): string {
  if (!width || !height) {
    return 'unknown';
  }

  const normalizedRatio = width / height;
  const closestCommonRatio = commonAspectRatios.find(
    (ratio) => Math.abs(normalizedRatio - ratio.width / ratio.height) <= 0.03,
  );
  if (closestCommonRatio) {
    return closestCommonRatio.label;
  }

  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

export function formatRecordingContextBadge(recording: RecordingSummary): string {
  return `${recording.width}×${recording.height} · ${formatAspectRatio(recording.width, recording.height)}`;
}

export function formatRunShortTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  const now = new Date();
  const includeYear = date.getFullYear() !== now.getFullYear();
  return formatLowercaseLocaleText(
    date.toLocaleString([], {
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      ...(includeYear ? { year: 'numeric' as const } : {}),
    }),
  );
}

export function formatRelativeTime(timestamp: string, nowMs: number): string {
  const parsedTimestamp = new Date(timestamp).getTime();
  if (Number.isNaN(parsedTimestamp)) {
    return timestamp;
  }

  const deltaMs = Math.max(0, nowMs - parsedTimestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (deltaMs < minuteMs) {
    return 'just now';
  }
  if (deltaMs < hourMs) {
    return `${Math.floor(deltaMs / minuteMs)}m ago`;
  }
  if (deltaMs < dayMs) {
    return `${Math.floor(deltaMs / hourMs)}h ago`;
  }
  if (deltaMs < 7 * dayMs) {
    return `${Math.floor(deltaMs / dayMs)}d ago`;
  }
  return formatRunShortTimestamp(timestamp);
}
