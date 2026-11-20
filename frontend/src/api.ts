import type {
  AdminUser,
  AdminUserChanges,
  AnalysisMetadata,
  CandidateChanges,
  CandidateFrame,
  CandidateStatus,
  ExportBundle,
  ExportMode,
  HealthResponse,
  LinkDetails,
  LivePresenceTarget,
  LiveState,
  Pathway,
  PathwayDetail,
  Project,
  ProjectDetail,
  RecordingDetail,
  RecordingSummary,
  RunDetail,
  RunSettings,
  RunSummary,
  SavedRunSettings,
  ProgressReport,
  ReportFilter,
  ServerSettings,
  ServerSettingsChanges,
  SessionInfo,
  TrafficReport,
  UsageEvent,
  UsageReport,
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
const CLIENT_HEADER = 'X-Stepthrough-Client';
/** This page, among the browsers and tabs of one shared account (they share the login cookie): sent with every
 *  change, so the server can tell the others which browser made it. */
export const CLIENT_ID = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
  byte.toString(16).padStart(2, '0'),
).join('');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // `include`: the session cookie also goes along when the development frontend runs on another port.
  const headers = new Headers(init?.headers);
  if (init?.method && init.method !== 'GET') headers.set(CLIENT_HEADER, CLIENT_ID);
  const response = await fetch(apiUrl(path), { credentials: 'include', ...init, headers });
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

export function updateProject(projectId: string, name: string, previousName: string): Promise<Project> {
  return request<Project>(`/projects/${projectId}`, jsonBody('PATCH', { name, previous_name: previousName }));
}

export function deleteProject(projectId: string): Promise<void> {
  return request<void>(`/projects/${projectId}`, { method: 'DELETE' });
}

export function getProject(projectId: string): Promise<ProjectDetail> {
  return request<ProjectDetail>(`/projects/${projectId}`);
}

/** Changes in a shared account since `after` (see backend/app/live.py); waits up to `wait` seconds for one. */
export function waitForChanges(after: number | null, epoch: string | null, signal: AbortSignal, wait = 25): Promise<LiveState> {
  const params = new URLSearchParams({ wait: String(wait) });
  if (after !== null && epoch) {
    params.set('after', String(after));
    params.set('epoch', epoch);
  }
  return request<LiveState>(`/me/live?${params}`, { signal });
}

/** What this browser is doing that the others of its shared account should see; `[]` when it stops. */
export function sendPresence(targets: LivePresenceTarget[], keepalive = false): Promise<void> {
  return request<void>('/me/presence', { ...jsonBody('PUT', { targets }), keepalive });
}

/** What this browser reports for the usage report (lib/usage.ts); ignored where usage is not recorded. */
export function sendUsage(events: UsageEvent[], keepalive = false): Promise<void> {
  return request<void>('/me/usage', { ...jsonBody('POST', { events }), keepalive });
}

/** The query of a report for `filter`, with this computer's time zone (minutes east of UTC), so that the report's
 * hours and days are the reader's own. */
function reportQuery(filter: ReportFilter): string {
  const query = new URLSearchParams({ tz: String(-new Date().getTimezoneOffset()) });
  if ('days' in filter.period) query.set('days', String(filter.period.days));
  else {
    query.set('start', filter.period.start);
    query.set('end', filter.period.end);
  }
  if (filter.tag) query.set('tag', filter.tag);
  return query.toString();
}

export function getTrafficReport(filter: ReportFilter): Promise<TrafficReport> {
  return request<TrafficReport>(`/admin/traffic?${reportQuery(filter)}`);
}

/** `long`: with a row for every account, day and measure, for the long CSV. */
export function getUsageReport(filter: ReportFilter, long = false): Promise<UsageReport> {
  return request<UsageReport>(`/admin/usage?${reportQuery(filter)}${long ? '&long=true' : ''}`);
}

export function getProgressReport(tag: string): Promise<ProgressReport> {
  return request<ProgressReport>(`/admin/progress${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`);
}

/** A pathway figure was downloaded: for the usage and progress reports (the server decides whether it counts). */
export function notePathwayFigure(runId: string, format: 'svg' | 'png'): Promise<void> {
  return request<void>(`/runs/${runId}/pathway/figure`, jsonBody('POST', { format }));
}

export interface UploadOptions {
  /** Share of the file sent so far, 0 to 1. */
  onProgress?: (fraction: number) => void;
  /** Aborting it cancels the upload; the promise then rejects with an `AbortError`. */
  signal?: AbortSignal;
}

/** Upload a video into a project. Sent with XMLHttpRequest, because fetch cannot report upload progress. */
export function importRecording(projectId: string, file: File, filename?: string, options: UploadOptions = {}): Promise<RecordingSummary> {
  const formData = new FormData();
  formData.set('project_id', projectId);
  if (filename) {
    formData.set('filename', filename);
  }
  formData.set('file', file);
  return sendUpload<RecordingSummary>('/recordings/import', formData, options);
}

/** Bring the videos of a project file, with their runs, steps and phases, into a project (app/project_file.py). */
export function importProjectFile(projectId: string, file: File, options: UploadOptions = {}): Promise<RecordingSummary[]> {
  const formData = new FormData();
  formData.set('file', file);
  return sendUpload<RecordingSummary[]>(`/projects/${projectId}/project-file`, formData, options);
}

/** A new project from a project file, under the name it has there, with its videos, runs, steps and phases. */
export function importProjectFromFile(file: File, options: UploadOptions = {}): Promise<Project> {
  const formData = new FormData();
  formData.set('file', file);
  return sendUpload<Project>('/projects/project-file', formData, options);
}

/** Where a project's file downloads from: made as it downloads, videos included. */
export function projectFileUrl(projectId: string): string {
  return apiUrl(`/projects/${projectId}/project-file`).toString();
}

function sendUpload<T>(path: string, formData: FormData, options: UploadOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    if (options.signal?.aborted) {
      reject(new DOMException('upload cancelled', 'AbortError'));
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    const done = () => options.signal?.removeEventListener('abort', abort);
    xhr.open('POST', apiUrl(path).toString());
    // as `credentials: 'include'` in request(): the session cookie also goes to a backend on another port
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener('abort', () => {
      done();
      reject(new DOMException('upload cancelled', 'AbortError'));
    });
    xhr.addEventListener('error', () => {
      done();
      reject(new Error('the upload was interrupted. check the connection and retry.'));
    });
    xhr.addEventListener('load', () => {
      done();
      let payload: unknown = xhr.responseText;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        // not JSON: keep the text
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as T);
        return;
      }
      const detail = typeof payload === 'string' ? payload : (payload as { detail?: unknown } | null)?.detail;
      if (xhr.status === 401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
      reject(new ApiError(xhr.status, typeof detail === 'string' && detail ? detail : 'Request failed'));
    });
    xhr.send(formData);
  });
}

/** Whether an error is a cancelled request rather than a failure. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function updateRecording(recordingId: string, filename: string, previousFilename: string): Promise<RecordingSummary> {
  return request<RecordingSummary>(
    `/recordings/${recordingId}`, jsonBody('PATCH', { filename, previous_filename: previousFilename }),
  );
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

/** Forget the logged-in person's saved defaults (`projectId` null) or theirs for one project. */
export function forgetRunSettings(projectId: string | null): Promise<void> {
  const path = projectId ? `/me/run-settings/projects/${projectId}` : '/me/run-settings/default';
  return request<void>(path, { method: 'DELETE' });
}

export interface ReviewCarryOverResult {
  decisions: number;
  titles: number;
  notes: number;
  screen_choices: number;
  added_manual: number;
  unmatched: number;
}

/** Bring the review of `sourceRunId` over to `runId` (another run of the same recording), along `pairs`. */
export function carryOverReview(
  runId: string,
  sourceRunId: string,
  pairs: Array<{ source_candidate_id: string; target_candidate_id: string }>,
): Promise<ReviewCarryOverResult> {
  return request<ReviewCarryOverResult>(`/runs/${runId}/review-from`, jsonBody('POST', { source_run_id: sourceRunId, pairs }));
}

/** Name a run, or with '' take its name away; `previousName` is the name this browser showed ('' for none). */
export function updateRun(runId: string, name: string, previousName: string): Promise<RunSummary> {
  return request<RunSummary>(`/runs/${runId}`, jsonBody('PATCH', { name, previous_name: previousName }));
}

/** Duplicate a completed run with its settings, steps, screenshots, review decisions and phases. */
export function duplicateRun(runId: string): Promise<RunSummary> {
  return request<RunSummary>(`/runs/${runId}/duplicate`, { method: 'POST' });
}

export function createManualRun(recordingId: string): Promise<RunSummary> {
  return request<RunSummary>(`/recordings/${recordingId}/runs/manual`, { method: 'POST' });
}

export function getRun(runId: string, signal?: AbortSignal): Promise<RunDetail> {
  return request<RunDetail>(`/runs/${runId}`, { signal });
}

export function getRunPathway(runId: string, detail: PathwayDetail, signal?: AbortSignal): Promise<Pathway> {
  return request<Pathway>(`/runs/${runId}/pathway?detail=${detail}`, { signal });
}

/** Stack one box onto another; returns the steps it linked (rejected ones included), for an undo. */
export function mergePathwayScreens(runId: string, sourceId: string, targetId: string, detail: PathwayDetail): Promise<{ changed: string[] }> {
  return request<{ changed: string[] }>(`/runs/${runId}/pathway/merge`, jsonBody('POST', {
    source_candidate_id: sourceId, target_candidate_id: targetId, detail,
  }));
}

/** The steps a phase runs from and to, by the ids of their candidates. */
export interface PhaseSteps {
  first_step: string;
  last_step: string;
}

/** Where a phase starts in the recording; an empty name starts a stretch outside every phase. */
export interface PhaseBoundary {
  start_ms: number;
  name: string;
}

/** Name the steps from `first_step` to `last_step` as one phase ('' takes them out of every phase); `replacing` is
 *  the stretch the phase had before, when it is being changed. Answers with every phase after the change. */
export function setRunPhase(runId: string, phase: PhaseSteps & { name: string; replacing?: PhaseSteps | null }): Promise<{ phases: PhaseBoundary[] }> {
  return request<{ phases: PhaseBoundary[] }>(`/runs/${runId}/phases`, jsonBody('PUT', phase));
}

/** Put every phase back as it was (an undo), as long as they are still `expected`; refused (409) when someone else
 *  changed them since. */
export function restoreRunPhases(runId: string, phases: PhaseBoundary[], expected: PhaseBoundary[]): Promise<{ phases: PhaseBoundary[] }> {
  return request<{ phases: PhaseBoundary[] }>(`/runs/${runId}/phases/all`, jsonBody('PUT', { phases, expected }));
}

export function abortRun(runId: string): Promise<RunSummary> {
  return request<RunSummary>(`/runs/${runId}/cancel`, { method: 'POST' });
}



export function deleteRun(runId: string): Promise<void> {
  return request<void>(`/runs/${runId}`, { method: 'DELETE' });
}

export function updateCandidate(
  candidateId: string,
  payload: CandidateChanges,
): Promise<CandidateFrame> {
  return request<CandidateFrame>(`/candidates/${candidateId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Accept, reject or reset several steps of one task in one go. */
export function setCandidateStatuses(runId: string, candidateIds: string[], status: CandidateStatus): Promise<void> {
  return request<void>(`/runs/${runId}/candidates/status`, jsonBody('POST', { candidate_ids: candidateIds, status }));
}

export function createManualCandidate(runId: string, timestampMs: number): Promise<CandidateFrame> {
  return request<CandidateFrame>(`/runs/${runId}/candidates/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp_ms: timestampMs }),
  });
}

export function exportRun(runId: string, mode: ExportMode | 'auto' = 'accepted'): Promise<ExportBundle> {
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

export function getServerSettings(): Promise<ServerSettings> {
  return request<ServerSettings>('/admin/server-settings');
}

export function updateServerSettings(changes: ServerSettingsChanges): Promise<ServerSettings> {
  return request<ServerSettings>('/admin/server-settings', jsonBody('PATCH', changes));
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
