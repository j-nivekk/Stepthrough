// Shared accounts: what a change from another browser means for this one (see backend/app/live.py and
// features/live/LiveProvider.tsx, which applies it). Pure functions, so they can be tested without a browser.

import type { CandidateChanges, CandidateFrame, LiveBusy, LiveEvent, LivePresence, RunDetail, SessionUser } from '../types';

/** Whether many people may be signed in to this account at once: the `shared` tag, or `visitor` (a shared account
 *  with limits); never an administrator. */
export function isSharedAccount(user: SessionUser | null | undefined): boolean {
  return Boolean(user && !user.is_admin && (user.tags.includes('shared') || user.tags.includes('visitor')));
}

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
    case 'candidate':
      // Any change to a task is also its project's and its own last change (who and when, in the lists).
      keys.push(['projects']);
      if (recordingId) keys.push(['recording', recordingId]);
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

/** A step with a change this browser makes, as the server will save it (backend/app/main.py, update_candidate):
 *  shown at once, before the server answers. `auto` clears a say; the text a shared account began from (previous_*)
 *  is only checked, not saved. */
export function applyCandidateChanges(candidate: CandidateFrame, changes: CandidateChanges): CandidateFrame {
  const next: CandidateFrame = { ...candidate };
  if (changes.status !== undefined) next.status = changes.status;
  if (changes.title !== undefined) next.title = changes.title;
  if (changes.notes !== undefined) next.notes = changes.notes;
  if (changes.screen_link !== undefined) next.screen_link = changes.screen_link === 'auto' ? null : changes.screen_link;
  if (changes.screen_kind !== undefined) next.screen_kind = changes.screen_kind === 'auto' ? null : changes.screen_kind;
  if (changes.pathway_row !== undefined) next.pathway_row = changes.pathway_row === 'auto' ? null : changes.pathway_row;
  if (changes.returns_to !== undefined) next.returns_to = changes.returns_to === 'auto' ? null : changes.returns_to;
  return next;
}

/** A run with several of its steps set to one decision, as the server will save them (the bulk change). */
export function withCandidateStatuses(detail: RunDetail | undefined, candidateIds: string[], status: CandidateFrame['status']): RunDetail | undefined {
  if (!detail) return detail;
  const chosen = new Set(candidateIds);
  if (!detail.candidates.some((item) => chosen.has(item.id) && item.status !== status)) return detail;
  return {
    ...detail,
    candidates: detail.candidates.map((item) => (chosen.has(item.id) && item.status !== status ? { ...item, status } : item)),
  };
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

/** Project files other browsers of the account are bringing in from the list of projects, with how far they are. */
export function projectImportsElsewhere(presence: LivePresence[], ownClient: string): UploadElsewhere[] {
  const imports: UploadElsewhere[] = [];
  for (const entry of presence) {
    if (entry.client === ownClient) continue;
    entry.targets.forEach((target, index) => {
      if (target.kind === 'importing_project') {
        imports.push({ key: `${entry.client}-${index}`, name: target.name, progress: target.progress });
      }
    });
  }
  return imports;
}

/** What other browsers are doing to a task that rewrites it, such as adding a step by hand. */
export function busyElsewhere(busy: LiveBusy[], runId: string | null, ownClient: string): LiveBusy[] {
  return runId ? busy.filter((entry) => entry.run_id === runId && entry.by !== ownClient) : [];
}

/** Tasks something is being done to in another browser, for the tasks list. */
export function busyRunIds(busy: LiveBusy[], ownClient: string): string[] {
  return [...new Set(busy.filter((entry) => entry.by !== ownClient).map((entry) => entry.run_id))];
}
