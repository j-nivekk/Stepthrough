// Shared accounts: what a change from another browser means for this one (see backend/app/live.py and
// features/live/LiveProvider.tsx, which applies it). Pure functions, so they can be tested without a browser.

import type { CandidateFrame, LiveBusy, LiveEvent, LivePresence, RunDetail } from '../types';

export type QueryKeyPrefix = readonly unknown[];

/** The cached data a change makes out of date, as query key prefixes. A step's own change is patched in place
 *  first (see patchCandidate); these then bring what is derived from it (accepted steps, the pathway) up to date. */
export function staleQueries(event: LiveEvent): QueryKeyPrefix[] {
  const { project_id: projectId, recording_id: recordingId, run_id: runId } = event;
  const keys: QueryKeyPrefix[] = [];
  switch (event.kind) {
    case 'projects':
    case 'project_deleted':
      keys.push(['projects']);
      if (projectId) keys.push(['project', projectId]);
      break;
    case 'project':
      // a video added, renamed, deleted, or ready: the list shows how many there are
      keys.push(['projects']);
      if (projectId) keys.push(['project', projectId]);
      if (recordingId) keys.push(['recording', recordingId]);
      break;
    case 'recording':
      // a task started or deleted
      keys.push(['projects']);
      if (projectId) keys.push(['project', projectId]);
      if (recordingId) keys.push(['recording', recordingId]);
      if (runId) keys.push(['run', runId]);
      break;
    case 'run':
      if (recordingId) keys.push(['recording', recordingId]);
      if (runId) keys.push(['run', runId], ['pathway', runId]);
      break;
    case 'candidate':
      if (runId) keys.push(['run', runId], ['pathway', runId]);
      break;
    case 'settings':
      keys.push(['saved-run-settings']);
      break;
    default:
      break;
  }
  return keys;
}

/** A run with one of its steps as it is now; the same object when the step is not in it (nothing to patch). */
export function patchCandidate(detail: RunDetail | undefined, candidate: CandidateFrame): RunDetail | undefined {
  if (!detail || !detail.candidates.some((item) => item.id === candidate.id)) return detail;
  return { ...detail, candidates: detail.candidates.map((item) => (item.id === candidate.id ? candidate : item)) };
}

/** The browser whose claim on a step's title and notes holds: the first to begin editing it (ties go by name, so
 *  every browser comes to the same answer). Null when nobody is editing it. */
export function stepEditor(presence: LivePresence[], runId: string, candidateId: string): string | null {
  let holder: { client: string; since: number } | null = null;
  for (const entry of presence) {
    for (const target of entry.targets) {
      if (target.kind !== 'editing' || target.run_id !== runId || target.candidate_id !== candidateId) continue;
      const since = target.since ?? Number.POSITIVE_INFINITY;
      if (!holder || since < holder.since || (since === holder.since && entry.client < holder.client)) {
        holder = { client: entry.client, since };
      }
    }
  }
  return holder?.client ?? null;
}

export interface UploadElsewhere {
  key: string;
  name: string;
  progress: number | null;
}

/** Videos another browser of the account is uploading into a project. */
export function uploadsElsewhere(presence: LivePresence[], projectId: string | null, ownClient: string): UploadElsewhere[] {
  if (!projectId) return [];
  const uploads: UploadElsewhere[] = [];
  for (const entry of presence) {
    if (entry.client === ownClient) continue;
    entry.targets.forEach((target, index) => {
      if (target.kind === 'uploading' && target.project_id === projectId) {
        uploads.push({ key: `${entry.client}-${index}`, name: target.name, progress: target.progress });
      }
    });
  }
  return uploads;
}

/** What other browsers are doing to a task that rewrites it, such as adding a step by hand. */
export function busyElsewhere(busy: LiveBusy[], runId: string | null, ownClient: string): LiveBusy[] {
  return runId ? busy.filter((entry) => entry.run_id === runId && entry.by !== ownClient) : [];
}

/** Tasks something is being done to in another browser, for the tasks list. */
export function busyRunIds(busy: LiveBusy[], ownClient: string): string[] {
  return [...new Set(busy.filter((entry) => entry.by !== ownClient).map((entry) => entry.run_id))];
}
