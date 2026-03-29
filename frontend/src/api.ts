import type {
  CandidateFrame,
  ExportBundle,
  ExportMode,
  HealthResponse,
  Project,
  ProjectDetail,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunSettings,
  RunSummary,
} from './types';

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000';

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, API_BASE), init);
  if (response.status === 204) {
    return undefined as T;
  }
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    const message = typeof payload === 'string' ? payload : payload.detail ?? 'Request failed';
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export function absoluteApiUrl(path: string): string {
  return new URL(path, API_BASE).toString();
}

export function listProjects(): Promise<Project[]> {
  return request<Project[]>('/projects');
}

export function createProject(name: string): Promise<Project> {
  return request<Project>('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function updateProject(projectId: string, name: string): Promise<Project> {
  return request<Project>(`/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteProject(projectId: string): Promise<void> {
  return request<void>(`/projects/${projectId}`, { method: 'DELETE' });
}

export function getProject(projectId: string): Promise<ProjectDetail> {
  return request<ProjectDetail>(`/projects/${projectId}`);
}

export function importRecording(projectId: string, file: File, filename?: string): Promise<RecordingSummary> {
  const formData = new FormData();
  formData.set('project_id', projectId);
  if (filename) {
    formData.set('filename', filename);
  }
  formData.set('file', file);
  return request<RecordingSummary>('/recordings/import', {
    method: 'POST',
    body: formData,
  });
}

export function updateRecording(recordingId: string, filename: string): Promise<RecordingSummary> {
  return request<RecordingSummary>(`/recordings/${recordingId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  });
}

export function deleteRecording(recordingId: string): Promise<void> {
  return request<void>(`/recordings/${recordingId}`, { method: 'DELETE' });
}

export function getRecording(recordingId: string): Promise<RecordingDetail> {
  return request<RecordingDetail>(`/recordings/${recordingId}`);
}

export function createRun(recordingId: string, settings: RunSettings): Promise<RunSummary> {
  return request<RunSummary>(`/recordings/${recordingId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

export function createManualRun(recordingId: string): Promise<RunSummary> {
  return request<RunSummary>(`/recordings/${recordingId}/runs/manual`, { method: 'POST' });
}

export function getRun(runId: string): Promise<RunDetail> {
  return request<RunDetail>(`/runs/${runId}`);
}

export function abortRun(runId: string): Promise<RunSummary> {
  return request<RunSummary>(`/runs/${runId}/cancel`, { method: 'POST' });
}



export function deleteRun(runId: string): Promise<void> {
  return request<void>(`/runs/${runId}`, { method: 'DELETE' });
}

export function updateCandidate(
  candidateId: string,
  payload: Partial<Pick<CandidateFrame, 'status' | 'title' | 'notes'>>,
): Promise<CandidateFrame> {
  return request<CandidateFrame>(`/candidates/${candidateId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function createManualCandidate(runId: string, timestampMs: number): Promise<CandidateFrame> {
  return request<CandidateFrame>(`/runs/${runId}/candidates/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp_ms: timestampMs }),
  });
}

export function exportRun(runId: string, mode: ExportMode = 'accepted'): Promise<ExportBundle> {
  return request<ExportBundle>(`/runs/${runId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

export function health(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export function resetDatabase(): Promise<void> {
  return request<void>('/admin/reset-db', { method: 'POST' });
}

export function recheckOcr(): Promise<void> {
  return request<void>('/admin/recheck-ocr', { method: 'POST' });
}
