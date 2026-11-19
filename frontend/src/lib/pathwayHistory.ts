import type { CandidateChanges, CandidateFrame } from '../types';

/** What a change in the pathway can touch on a step: where it belongs, whether it is a pop-up, its row, its title. */
export type HistoryField = 'screen_link' | 'screen_kind' | 'pathway_row' | 'title';
const FIELDS: HistoryField[] = ['screen_link', 'screen_kind', 'pathway_row', 'title'];

/** A field of a step as it is stored: no say at all is null. */
type Stored = string | null;

export interface HistoryEntry {
  /** What was done, for the status line: "stacked Screen 5 onto Screen 3". */
  label: string;
  /** For each step the change touched: each field before and after it. */
  steps: Map<string, Partial<Record<HistoryField, { before: Stored; after: Stored }>>>;
}

/** How a change is stored: `auto` (and an empty title) is no say at all. */
function stored(field: HistoryField, value: string | undefined): Stored {
  if (value === undefined || value === '' || (field !== 'title' && value === 'auto')) return null;
  return value;
}

/** How a stored value is sent back. */
function sendable(field: HistoryField, value: Stored): string {
  return value ?? (field === 'title' ? '' : 'auto');
}

function current(candidate: CandidateFrame | undefined, field: HistoryField): Stored {
  const value = candidate?.[field] as string | null | undefined;
  return value === undefined || value === '' ? null : value;
}

/**
 * A change this browser is about to make, with the steps as they are now and as the change leaves them. `changes`
 * is what the change does to each step, also when the server does it for several at once (a merge): it is not sent
 * from here, only remembered.
 *
 * The history is this browser's own, kept in memory: in a shared account, everyone has theirs, and an undo takes
 * back only what this browser did.
 */
export function record(label: string, candidates: CandidateFrame[], changes: Array<[string, CandidateChanges]>): HistoryEntry {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const steps: HistoryEntry['steps'] = new Map();
  for (const [id, change] of changes) {
    const fields: Partial<Record<HistoryField, { before: Stored; after: Stored }>> = steps.get(id) ?? {};
    for (const field of FIELDS) {
      if (!(field in change)) continue;
      const before = fields[field]?.before ?? current(byId.get(id), field);
      fields[field] = { before, after: stored(field, change[field] as string | undefined) };
    }
    if (Object.keys(fields).length) steps.set(id, fields);
  }
  return { label, steps };
}

/**
 * The changes that take `entry` back: each field goes back to what it was, as long as it still is what this
 * browser made it. A field someone else changed since (in a shared account, on another computer) is left as they
 * left it, and counted, so the status line can say so.
 */
export function undoChanges(entry: HistoryEntry, candidates: CandidateFrame[]): { changes: Array<[string, CandidateChanges]>; kept: number } {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const changes: Array<[string, CandidateChanges]> = [];
  let kept = 0;
  for (const [id, fields] of entry.steps) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    const change: Record<string, string> = {};
    for (const field of FIELDS) {
      const values = fields[field];
      if (!values || values.before === values.after) continue;
      const now = current(candidate, field);
      if (now === values.before) continue; // already as it was
      if (now !== values.after) {
        kept += 1;
        continue;
      }
      change[field] = sendable(field, values.before);
    }
    if (Object.keys(change).length) changes.push([id, change as CandidateChanges]);
  }
  return { changes, kept };
}
