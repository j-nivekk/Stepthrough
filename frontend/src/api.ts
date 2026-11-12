import type {
  AdminUser,
  AdminUserChanges,
  AnalysisMetadata,
  CandidateFrame,
  ExportBundle,
  ExportMode,
  HealthResponse,
  LinkDetails,
  Project,
  ProjectDetail,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunSettings,
  RunSummary,
  SavedRunSettings,
  SessionInfo,
  UserImportResult,
  UserLink,
} from './types';

const configuredApiBase = import.meta.env.VITE_API_BASE_URL;

/**
 * Where the backend lives. Unset (the local app): the backend on port 8000. Set to an empty string (the Docker
 * image): the server this page was loaded from, so one build works on any domain.
 */
export const API_BASE =
  configuredApiBase === undefined ? 'http://127.0.0.1:8000' : configuredApiBase.trim() || window.location.origin;

// The base as a folder (ending in `/`), so a backend served under a path such as `https://example.org/backend/`
// keeps that path.
const API_ROOT = API_BASE.endsWith('/') ? API_BASE : `${API_BASE}/`;

/** A backend address for a path such as `/projects` or `/assets/projects/...`. The path is joined onto the base
 *  rather than resolved against it: `new URL('/projects', base)` would drop any path the base has. */
export function apiUrl(path: string): URL {
  return new URL(path.replace(/^\/+/, ''), API_ROOT);
}

/** The same address for a WebSocket (`ws:` or `wss:`). */
export function apiSocketUrl(path: string): string {
  return apiUrl(path).toString().replace(/^http/, 'ws');
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Sent on the window when a request finds that nobody is logged in (any more), so the login page can show. */
export const SIGNED_OUT_EVENT = 'stepthrough:signed-out';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // `include`: the session cookie also goes along when the development frontend runs on another port.
  const response = await fetch(apiUrl(path), { credentials: 'include', ...init });
  if (response.status === 204) {
    return undefined as T;
  }
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    const detail = typeof payload === 'string' ? payload : payload.detail;
    const message = typeof detail === 'string' ? detail : 'Request failed';
    // A wrong password at login is not a lost session.
    if (response.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

function jsonBody(method: string, payload: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

export function absoluteApiUrl(path: string): string {
  return apiUrl(path).toString();
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

/** The settings the logged-in person saved for new runs: their own defaults and theirs per project. */
export function getSavedRunSettings(): Promise<SavedRunSettings[]> {
  return request<SavedRunSettings[]>('/me/run-settings');
}

/** Save settings as the logged-in person's own defaults (`projectId` null) or as theirs for one project. */
export function saveRunSettings(projectId: string | null, settings: RunSettings): Promise<SavedRunSettings> {
  const path = projectId ? `/me/run-settings/projects/${projectId}` : '/me/run-settings/default';
  return request<SavedRunSettings>(path, jsonBody('PUT', settings));
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

export function getAnalysisMetadata(): Promise<AnalysisMetadata> {
  return request<AnalysisMetadata>('/analysis/metadata');
}

export function resetDatabase(): Promise<void> {
  return request<void>('/admin/reset-db', {
    method: 'POST',
    headers: { 'X-Stepthrough-Confirm': 'reset-database' },
  });
}

export function recheckOcr(): Promise<void> {
  return request<void>('/admin/recheck-ocr', { method: 'POST' });
}

export function getSession(): Promise<SessionInfo> {
  return request<SessionInfo>('/auth/session');
}

export function logIn(name: string, password: string): Promise<SessionInfo> {
  return request<SessionInfo>('/auth/login', jsonBody('POST', { name, password }));
}

export function logOut(): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST' });
}

export function getLinkDetails(token: string): Promise<LinkDetails> {
  return request<LinkDetails>('/auth/link', jsonBody('POST', { token }));
}

export function setPasswordWithLink(token: string, password: string): Promise<SessionInfo> {
  return request<SessionInfo>('/auth/link/password', jsonBody('POST', { token, password }));
}

export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request<void>(
    '/me/password',
    jsonBody('POST', { current_password: currentPassword, new_password: newPassword }),
  );
}

export function listUsers(): Promise<AdminUser[]> {
  return request<AdminUser[]>('/admin/users');
}

export function createUser(payload: {
  name: string;
  tags: string[];
  delete_after: string | null;
}): Promise<{ user: AdminUser; link: UserLink }> {
  return request('/admin/users', jsonBody('POST', payload));
}

export function importUsers(file: File, tags: string, deleteAfter: string): Promise<UserImportResult> {
  const formData = new FormData();
  formData.set('file', file);
  formData.set('tags', tags);
  formData.set('delete_after', deleteAfter);
  return request<UserImportResult>('/admin/users/import', { method: 'POST', body: formData });
}

export function updateUser(userId: string, changes: AdminUserChanges): Promise<AdminUser> {
  return request<AdminUser>(`/admin/users/${userId}`, jsonBody('PATCH', changes));
}

export function newUserLink(userId: string): Promise<UserLink> {
  return request<UserLink>(`/admin/users/${userId}/link`, { method: 'POST' });
}

export function deleteUser(userId: string): Promise<{ deleted_projects: string[] }> {
  return request(`/admin/users/${userId}`, { method: 'DELETE' });
}

/** Hand all of one account's projects to another (keeping each role). */
export function transferProjects(userId: string, toUserId: string): Promise<{ moved: number }> {
  return request(`/admin/users/${userId}/transfer-projects`, jsonBody('POST', { to_user_id: toUserId }));
}
