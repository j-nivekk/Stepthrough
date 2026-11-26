// Where the review of a run was left: the step last worked on, kept per run in this browser, so that opening the run
// again comes back to it. Only the most recent runs are kept.

const STORAGE_KEY = 'stepthrough.last-step.v1';
/** How many runs are remembered; the run left longest ago is forgotten first. */
export const LAST_STEP_RUNS = 100;

type Remembered = Record<string, string>;

function read(storage: Storage | undefined): Remembered {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The step of the run last worked on in this browser, if any. */
export function rememberedStep(runId: string, storage: Storage | undefined = browserStorage()): string | null {
  return read(storage)[runId] ?? null;
}

/** Keep the step as the one last worked on in its run; the run becomes the most recent one. */
export function rememberStep(runId: string, candidateId: string, storage: Storage | undefined = browserStorage()): void {
  const remembered = read(storage);
  const runs = Object.keys(remembered);
  if (remembered[runId] === candidateId && runs[runs.length - 1] === runId) return;
  delete remembered[runId];
  remembered[runId] = candidateId;
  const kept = Object.keys(remembered);
  for (const run of kept.slice(0, Math.max(0, kept.length - LAST_STEP_RUNS))) delete remembered[run];
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(remembered));
  } catch {
    // private windows and full storage: the review still works, it just starts at the top next time
  }
}

/** The step to come back to when a run opens: the one last worked on, unless that is the first step (the run
 *  starts there anyway) or no longer in the run. */
export function stepToReturnTo(runId: string, candidateIds: string[], storage?: Storage): string | null {
  const remembered = rememberedStep(runId, storage ?? browserStorage());
  if (!remembered || remembered === candidateIds[0] || !candidateIds.includes(remembered)) return null;
  return remembered;
}
