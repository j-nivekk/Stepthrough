import type { CandidateFrame, CandidateStatus, RecordingSummary, RunSummary } from '../types';

export type SimilarLink = { targetId: string; label: string };
export type AnalysisTaskFilter = 'all' | 'active' | 'completed' | 'failed';
export type AnalysisPopoverKey = 'export' | 'load' | 'preset' | 'reset' | 'save';
export type CandidateFilter = CandidateStatus | 'all';
export type AnalysisHintKey =
  | 'analysis_engine'
  | 'analysis_preset'
  | 'allow_high_fps_sampling'
  | 'hybrid_advanced'
  | 'hybrid_min_dwell_ms'
  | 'hybrid_ocr_confirmation'
  | 'hybrid_sample_fps_override'
  | 'hybrid_settle_window_ms'
  | 'detector_mode'
  | 'extract_offset_ms'
  | 'load'
  | 'min_scene_gap_ms'
  | 'reset'
  | 'run'
  | 'sample_fps'
  | 'save'
  | 'tolerance';

export interface AnalysisTaskItem {
  recording: RecordingSummary;
  run: RunSummary;
}

export interface AnalysisTaskGroup {
  recording: RecordingSummary;
  runs: AnalysisTaskItem[];
}

export interface PendingManualMark {
  id: string;
  timestampMs: number;
}

export type ComparisonBadge = 'both' | 'timing_shifted' | 'left_only' | 'right_only';

export interface ComparisonRow {
  badge: ComparisonBadge;
  left: CandidateFrame | null;
  right: CandidateFrame | null;
  timeDeltaMs: number | null;
}

export const activeRunStatuses: RunSummary['status'][] = ['queued', 'running', 'awaiting_fallback'];
export const candidateFilters: CandidateFilter[] = ['all', 'pending', 'accepted', 'rejected'];
export const analysisTaskFilters: AnalysisTaskFilter[] = ['all', 'active', 'completed', 'failed'];

export function getAnalysisTaskStatusRank(status: RunSummary['status']): number {
  if (status === 'running') {
    return 0;
  }
  if (status === 'awaiting_fallback') {
    return 1;
  }
  if (status === 'queued') {
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

export function candidateMatchesFilter(candidate: CandidateFrame, filter: CandidateFilter): boolean {
  return filter === 'all' ? true : candidate.status === filter;
}

export function getNextCandidateFocusId(
  candidates: CandidateFrame[],
  currentCandidateId: string,
  filter: CandidateFilter,
): string | null {
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

export function buildCandidateComparison(
  leftCandidates: CandidateFrame[],
  rightCandidates: CandidateFrame[],
): ComparisonRow[] {
  const left = [...leftCandidates].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const right = [...rightCandidates].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const usedRightIds = new Set<string>();
  const rows: ComparisonRow[] = [];

  left.forEach((leftCandidate) => {
    let bestMatch: CandidateFrame | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    right.forEach((rightCandidate) => {
      if (usedRightIds.has(rightCandidate.id)) {
        return;
      }
      const delta = Math.abs(rightCandidate.timestamp_ms - leftCandidate.timestamp_ms);
      if (delta <= 750 && delta < bestDelta) {
        bestMatch = rightCandidate;
        bestDelta = delta;
      }
    });

    if (bestMatch) {
      usedRightIds.add(bestMatch.id);
      rows.push({
        badge: bestDelta > 250 ? 'timing_shifted' : 'both',
        left: leftCandidate,
        right: bestMatch,
        timeDeltaMs: bestDelta,
      });
      return;
    }

    rows.push({ badge: 'left_only', left: leftCandidate, right: null, timeDeltaMs: null });
  });

  right.forEach((rightCandidate) => {
    if (!usedRightIds.has(rightCandidate.id)) {
      rows.push({ badge: 'right_only', left: null, right: rightCandidate, timeDeltaMs: null });
    }
  });

  return rows;
}
