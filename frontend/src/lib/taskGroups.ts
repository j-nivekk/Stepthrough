import type { RunSummary } from '../types';

/**
 * How the tasks list remembers which videos' runs are folded away:
 * - `collapsed`: groups folded by hand (persisted in localStorage).
 * - `focusedRecordingId`: the video picked in the videos list (or on entry); every other video folds for the time
 *   being, unless opened by hand (`openedBesideFocus`). Picking a run directly in the tasks list does not touch
 *   `focusedRecordingId`, so the tasks list stays as-is instead of collapsing other groups out from under the user.
 */
export interface TaskGroupFoldState {
  collapsed: Set<string>;
  focusedRecordingId: string | null;
  openedBesideFocus: Set<string>;
}

export function createTaskGroupFoldState(
  collapsed: Iterable<string>,
  focusedRecordingId: string | null = null,
): TaskGroupFoldState {
  const nextCollapsed = new Set(collapsed);
  if (focusedRecordingId) {
    nextCollapsed.delete(focusedRecordingId);
  }
  return {
    collapsed: nextCollapsed,
    focusedRecordingId,
    openedBesideFocus: new Set(),
  };
}

export function isTaskGroupCollapsed(state: TaskGroupFoldState, recordingId: string): boolean {
  if (state.collapsed.has(recordingId)) {
    return true;
  }
  return Boolean(
    state.focusedRecordingId &&
      recordingId !== state.focusedRecordingId &&
      !state.openedBesideFocus.has(recordingId),
  );
}

/**
 * Focusing a video from the video list shows its runs and folds every other video's runs again.
 * Clearing focus (no video selected) releases the temporary fold while keeping groups folded by hand.
 */
export function focusVideoGroup(state: TaskGroupFoldState, recordingId: string | null): TaskGroupFoldState {
  if (!recordingId) {
    return {
      collapsed: new Set(state.collapsed),
      focusedRecordingId: null,
      openedBesideFocus: new Set(),
    };
  }
  const nextCollapsed = new Set(state.collapsed);
  nextCollapsed.delete(recordingId);
  return {
    collapsed: nextCollapsed,
    focusedRecordingId: recordingId,
    openedBesideFocus: new Set(),
  };
}

/**
 * Folding or opening one video's group by hand. Folding a group that is already folded by video-list focus simply
 * drops it from `openedBesideFocus` instead of saving it into the persisted `collapsed` set.
 */
export function setTaskGroupCollapsed(
  state: TaskGroupFoldState,
  recordingId: string,
  collapsed: boolean,
): TaskGroupFoldState {
  const nextOpened = new Set(state.openedBesideFocus);
  if (!collapsed) {
    if (state.focusedRecordingId && recordingId !== state.focusedRecordingId) {
      nextOpened.add(recordingId);
    }
  } else {
    nextOpened.delete(recordingId);
  }

  const foldsViaFocus = Boolean(state.focusedRecordingId && recordingId !== state.focusedRecordingId);
  const shouldPersistCollapsed = collapsed && !foldsViaFocus;
  const nextCollapsed = new Set(state.collapsed);
  if (shouldPersistCollapsed) {
    nextCollapsed.add(recordingId);
  } else {
    nextCollapsed.delete(recordingId);
  }

  return {
    collapsed: nextCollapsed,
    focusedRecordingId: state.focusedRecordingId,
    openedBesideFocus: nextOpened,
  };
}

/** Ensures a video's group is open (e.g. a newly started or compared run) without folding any other open group. */
export function revealTaskGroup(state: TaskGroupFoldState, recordingId: string): TaskGroupFoldState {
  return setTaskGroupCollapsed(state, recordingId, false);
}

export interface RunReviewSummary {
  total: number;
  accepted: number;
  rejected: number;
  reviewed: number;
  pending: number;
  acceptedPct: number;
  rejectedPct: number;
  /** Compact text label shown next to the bar, and on its own at smaller widths. */
  label: string;
  /** Full breakdown for hover tooltips and assistive technology. */
  tooltip: string;
}

/** How far a finished run has been reviewed: accepted, rejected, and undecided (pending) steps. */
export function summarizeRunReview(
  run: Pick<RunSummary, 'candidate_count' | 'accepted_count' | 'rejected_count'>,
): RunReviewSummary | null {
  const accepted = Math.max(0, run.accepted_count ?? 0);
  const rejected = Math.max(0, run.rejected_count ?? 0);
  const total = Math.max(0, run.candidate_count ?? 0, accepted + rejected);
  if (total === 0) {
    return null;
  }
  const reviewed = accepted + rejected;
  const pending = Math.max(0, total - reviewed);
  const acceptedPct = (accepted / total) * 100;
  const rejectedPct = (rejected / total) * 100;
  const stepWord = total === 1 ? 'step' : 'steps';
  return {
    total,
    accepted,
    rejected,
    reviewed,
    pending,
    acceptedPct,
    rejectedPct,
    label: `${reviewed}/${total} reviewed`,
    tooltip: `${reviewed} of ${total} ${stepWord} reviewed: ${accepted} accepted, ${rejected} rejected, ${pending} pending`,
  };
}
