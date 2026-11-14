import { buildCandidateComparison, type ComparisonRow } from './analysis';
import { formatRecordingTypeLabel, getEffectiveStableValues, sanitizeStableSettings } from './stableSettings';
import type { AnalysisMetadata, CandidateFrame, RunSummary, StableSettings } from '../types';

/**
 * Comparing two runs of one recording, made with different settings: which settings differ, which steps both
 * found, and what bringing the review of the one over to the other would do. The view is RunComparison.
 */

export interface SettingRow {
  key: string;
  label: string;
  value: string;
}

/** A run's settings as rows to set side by side, in the order of the parameters panel. */
export function describeRunSettings(stable: StableSettings | null | undefined, metadata?: AnalysisMetadata | null): SettingRow[] {
  // filled in where a run stored less (runs of older versions)
  const settings = sanitizeStableSettings(stable);
  const values = getEffectiveStableValues(settings, metadata);
  const onOff = (value: boolean) => (value ? 'on' : 'off');
  const regions = settings.ignore_regions;
  return [
    { key: 'type', label: 'recording type', value: formatRecordingTypeLabel(settings.recording_type) },
    { key: 'dwell', label: 'minimum time on screen', value: `${values.minDwellMs} ms` },
    { key: 'change', label: 'smallest change', value: `${values.minChangePercent.toFixed(2)} %` },
    {
      key: 'regions',
      label: 'ignore areas',
      // two runs with the same number of areas in other places differ too
      value: regions.length
        ? `${regions.length} (${regions.map((r) => [r.x, r.y, r.width, r.height].map((v) => v.toFixed(2)).join(' ')).join('; ')})`
        : 'none',
    },
    { key: 'statusbar', label: 'phone status bar', value: values.ignoreStatusBar ? 'ignore' : 'include' },
    { key: 'scroll', label: 'scrolling', value: settings.scroll_mode === 'merge' ? 'merge stops' : 'each stop' },
    { key: 'typing', label: 'group typing', value: onOff(settings.group_typing) },
    { key: 'opening', label: 'opening screen', value: onOff(settings.include_opening_screen) },
    { key: 'ocr', label: 'read text (ocr)', value: onOff(settings.enable_ocr) },
    { key: 'sensitivity', label: 'sensitivity', value: String(values.sensitivity) },
    { key: 'rate', label: 'analysis rate', value: `${values.sampleFps} fps` },
  ];
}

/** The settings of two runs, row by row, each marked when the runs differ in it. */
export function compareRunSettings(
  left: RunSummary,
  right: RunSummary,
  metadata?: AnalysisMetadata | null,
): Array<SettingRow & { right: string; changed: boolean }> {
  const rightRows = new Map(describeRunSettings(right.stable, metadata).map((row) => [row.key, row.value]));
  return describeRunSettings(left.stable, metadata).map((row) => {
    const other = rightRows.get(row.key) ?? row.value;
    return { ...row, right: other, changed: other !== row.value };
  });
}

/** Whether a step has been reviewed: decided on, titled or noted. */
export function isReviewed(candidate: CandidateFrame): boolean {
  return candidate.status !== 'pending' || Boolean(candidate.title) || Boolean(candidate.notes);
}

export interface RunComparisonResult {
  rows: ComparisonRow[];
  /** Pairs of steps that show the same moment, earlier run first: what the review is brought over along. */
  pairs: Array<{ source_candidate_id: string; target_candidate_id: string }>;
  counts: { both: number; moved: number; leftOnly: number; rightOnly: number };
  /** What bringing the review of the left run over to the right one would do. */
  carryOver: { reviewed: number; manual: number; lost: number };
}

export function compareRuns(left: CandidateFrame[], right: CandidateFrame[]): RunComparisonResult {
  // Steps added by hand have no counterpart among detected steps: the carry-over adds them again instead.
  const leftDetected = left.filter((candidate) => candidate.candidate_origin !== 'manual');
  const rightDetected = right.filter((candidate) => candidate.candidate_origin !== 'manual');
  const rows = buildCandidateComparison(leftDetected, rightDetected).sort(
    (a, b) => (a.left ?? a.right)!.timestamp_ms - (b.left ?? b.right)!.timestamp_ms,
  );
  const pairs = rows
    .filter((row) => row.left && row.right)
    .map((row) => ({ source_candidate_id: row.left!.id, target_candidate_id: row.right!.id }));
  const count = (badge: ComparisonRow['badge']) => rows.filter((row) => row.badge === badge).length;
  const manual = left.filter((candidate) => candidate.candidate_origin === 'manual');
  return {
    rows,
    pairs,
    counts: { both: count('both'), moved: count('timing_shifted'), leftOnly: count('left_only'), rightOnly: count('right_only') },
    carryOver: {
      reviewed: rows.filter((row) => row.left && row.right && isReviewed(row.left)).length,
      manual: manual.length,
      lost: rows.filter((row) => row.left && !row.right && isReviewed(row.left)).length,
    },
  };
}

/**
 * The two runs to compare first: the newest finished run, and the one before it that has the most accepted
 * steps (the review to bring over), the newer one on a tie. Runs listed newest first or in any order.
 */
export function defaultComparisonPair(runs: RunSummary[]): { left: string; right: string } | null {
  const done = runs.filter((run) => run.status === 'completed').sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (done.length < 2) return null;
  const [newest, ...earlier] = done;
  const reviewed = [...earlier].sort((a, b) => b.accepted_count - a.accepted_count)[0];
  return { left: reviewed.id, right: newest.id };
}
