import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { getRun } from '../../../api';
import { screenshotUrl } from '../../../lib/screenshots';
import { formatRunShortTimestamp } from '../../../lib/formatters';
import { compareRunSettings, compareRuns, isReviewed } from '../../../lib/runComparison';
import type { AnalysisMetadata, CandidateFrame, RecordingSummary, RunSummary } from '../../../types';

export interface CarryOverPair {
  source_candidate_id: string;
  target_candidate_id: string;
}

interface RunComparisonProps {
  recording: RecordingSummary;
  /** The runs of the recording; only finished ones can be compared. */
  runs: RunSummary[];
  leftRunId: string;
  rightRunId: string;
  analysisMetadata: AnalysisMetadata | null;
  carryOverPending: boolean;
  busyRunIds: string[];
  onChangeRuns: (leftRunId: string, rightRunId: string) => void;
  onClose: () => void;
  onReview: (runId: string) => void;
  onCarryOver: (sourceRunId: string, targetRunId: string, pairs: CarryOverPair[]) => void;
}

const COLOURS = { both: '#6b6b66', timing_shifted: '#cd6d1e', left_only: '#bf2725', right_only: '#48af7c' } as const;

/**
 * Two runs of one recording with different settings, side by side: what changed in the settings, where each
 * run found steps, and the steps only one of them found. From here the researcher moves on with one run, and
 * can bring the review of the other along, so that trying other settings does not cost the review.
 */
export function RunComparison({
  recording,
  runs,
  leftRunId,
  rightRunId,
  analysisMetadata,
  carryOverPending,
  busyRunIds,
  onChangeRuns,
  onClose,
  onReview,
  onCarryOver,
}: RunComparisonProps) {
  const finished = useMemo(
    () => runs.filter((run) => run.status === 'completed').sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [runs],
  );
  // run numbers as in the tasks list: stored with each run, in the order the runs were made
  const numberOf = useMemo(() => {
    const ordered = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return new Map(ordered.map((run, index) => [run.id, run.run_number ?? index + 1]));
  }, [runs]);
  // a no-break space, so that a run's name never wraps apart
  const name = (runId: string) => `run\u00a0#${numberOf.get(runId) ?? '?'}`;

  const leftQuery = useQuery({ queryKey: ['run', leftRunId], queryFn: () => getRun(leftRunId) });
  const rightQuery = useQuery({ queryKey: ['run', rightRunId], queryFn: () => getRun(rightRunId) });
  const left = leftQuery.data;
  const right = rightQuery.data;
  const comparison = useMemo(() => (left && right ? compareRuns(left.candidates, right.candidates) : null), [left, right]);
  const settings = useMemo(
    () => (left && right ? compareRunSettings(left.summary, right.summary, analysisMetadata) : []),
    [left, right, analysisMetadata],
  );
  const changed = settings.filter((row) => row.changed);
  const duration = Math.max(1, recording.duration_ms);
  const same = leftRunId === rightRunId;
  const canCarryOver = Boolean(comparison && (comparison.carryOver.reviewed || comparison.carryOver.manual));

  const picker = (side: 'left' | 'right', value: string) => (
    <select
      aria-label={side === 'left' ? 'the run to compare from' : 'the run to compare with'}
      className="run-compare-select"
      onChange={(event) => (side === 'left' ? onChangeRuns(event.target.value, rightRunId) : onChangeRuns(leftRunId, event.target.value))}
      value={value}
    >
      {finished.map((run) => (
        <option key={run.id} value={run.id}>
          {name(run.id)}
          {run.name ? ` “${run.name}”` : ''}, {formatRunShortTimestamp(run.started_at ?? run.created_at)}, {run.accepted_count} accepted
        </option>
      ))}
    </select>
  );

  const reviewOf = (detail: typeof left) => {
    if (!detail) return '';
    const reviewed = detail.candidates.filter(isReviewed);
    const accepted = detail.candidates.filter((c) => c.status === 'accepted').length;
    const rejected = detail.candidates.filter((c) => c.status === 'rejected').length;
    const noted = detail.candidates.filter((c) => c.title || c.notes).length;
    const steps = `${detail.candidates.length} ${detail.candidates.length === 1 ? 'step' : 'steps'}`;
    return reviewed.length
      ? `${steps} · ${accepted} accepted · ${rejected} rejected · ${noted} with a title or notes`
      : `${steps} · not reviewed yet`;
  };

  const lane = (detail: typeof left, side: 'left' | 'right') => {
    if (!detail || !comparison) return null;
    const badgeOf = new Map<string, keyof typeof COLOURS>();
    for (const row of comparison.rows) {
      const candidate = side === 'left' ? row.left : row.right;
      if (candidate) badgeOf.set(candidate.id, row.badge);
    }
    return (
      <div className="run-compare-lane">
        <span className="run-compare-lane-label">{name(detail.summary.id)}</span>
        <div className="run-compare-lane-track">
          {detail.candidates.map((candidate) => {
            const badge = badgeOf.get(candidate.id);
            const manual = candidate.candidate_origin === 'manual';
            return (
              <span
                className={`run-compare-mark ${manual ? 'manual' : ''}`}
                key={candidate.id}
                style={{ left: `${(candidate.timestamp_ms / duration) * 100}%`, background: manual ? undefined : COLOURS[badge ?? 'both'] }}
                title={`${candidate.timestamp_tc}${manual ? ' · added by hand' : ''}${candidate.title ? ` · ${candidate.title}` : ''}`}
              />
            );
          })}
        </div>
      </div>
    );
  };

  const shot = (candidate: CandidateFrame | null, runId: string) =>
    candidate ? (
      <figure className="run-compare-shot">
        <img alt={`${name(runId)} at ${candidate.timestamp_tc}`} loading="lazy" src={screenshotUrl(candidate.image_url, 440)} />
        <figcaption>
          <b>{name(runId)}</b> {candidate.timestamp_tc.replace(/^00:/, '')}
          {isReviewed(candidate) ? (
            <span className="run-compare-reviewed">
              {' · '}
              {candidate.status !== 'pending' ? candidate.status : 'annotated'}
              {candidate.title ? `: ${candidate.title}` : ''}
            </span>
          ) : null}
        </figcaption>
      </figure>
    ) : (
      <div className="run-compare-shot empty">
        <span>not found by {name(runId)}</span>
      </div>
    );

  return (
    <section className="analysis-detail-section run-compare" id="analysis-run-compare" tabIndex={-1}>
      <div className="analysis-detail-header">
        <div className="analysis-detail-copy">
          <p className="analysis-section-eyebrow">compare runs</p>
          <h2>{recording.filename}</h2>
        </div>
        <div className="analysis-detail-side">
          <button className="analysis-task-link subtle" onClick={onClose} type="button">
            close
          </button>
        </div>
      </div>

      <div className="run-compare-runs">
        <div className="run-compare-run">
          {picker('left', leftRunId)}
          <p className="run-compare-meta">{reviewOf(left)}</p>
        </div>
        <span aria-hidden="true" className="run-compare-arrow">
          →
        </span>
        <div className="run-compare-run">
          {picker('right', rightRunId)}
          <p className="run-compare-meta">{reviewOf(right)}</p>
        </div>
      </div>

      {same ? (
        <p className="analysis-compare-guidance">choose two different runs.</p>
      ) : !left || !right || !comparison ? (
        <p className="analysis-compare-guidance">{leftQuery.isError || rightQuery.isError ? 'could not load the runs.' : 'loading the runs…'}</p>
      ) : (
        <>
          <div className="run-compare-settings">
            {changed.length ? (
              <table>
                <tbody>
                  {changed.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.label}</th>
                      <td>{row.value}</td>
                      <td aria-hidden="true">→</td>
                      <td>
                        <b>{row.right}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="run-compare-meta">both runs used the same settings.</p>
            )}
            {changed.length ? <p className="run-compare-meta">every other setting is the same.</p> : null}
          </div>

          <div className="run-compare-timeline">
            {lane(left, 'left')}
            {lane(right, 'right')}
            <div className="run-compare-legend">
              <span>
                <i style={{ background: COLOURS.both }} />
                found by both ({comparison.counts.both})
              </span>
              <span>
                <i style={{ background: COLOURS.timing_shifted }} />
                at another moment ({comparison.counts.moved})
              </span>
              <span>
                <i style={{ background: COLOURS.left_only }} />
                only {name(leftRunId)} ({comparison.counts.leftOnly})
              </span>
              <span>
                <i style={{ background: COLOURS.right_only }} />
                only {name(rightRunId)} ({comparison.counts.rightOnly})
              </span>
              {comparison.carryOver.manual ? (
                <span>
                  <i className="manual" />
                  added by hand ({comparison.carryOver.manual})
                </span>
              ) : null}
            </div>
          </div>

          {comparison.rows.some((row) => row.badge !== 'both') ? (
            <div className="run-compare-differences">
              {comparison.rows
                .filter((row) => row.badge !== 'both')
                .map((row) => (
                  <article className={`run-compare-card ${row.badge}`} key={`${row.left?.id ?? '-'}:${row.right?.id ?? '-'}`}>
                    <p className="run-compare-card-head">
                      <i style={{ background: COLOURS[row.badge] }} />
                      {row.badge === 'left_only'
                        ? `only ${name(leftRunId)}`
                        : row.badge === 'right_only'
                          ? `only ${name(rightRunId)}`
                          : `${((row.timeDeltaMs ?? 0) / 1000).toFixed(1)} s apart`}
                    </p>
                    <div className="run-compare-card-shots">
                      {shot(row.left, leftRunId)}
                      {shot(row.right, rightRunId)}
                    </div>
                  </article>
                ))}
            </div>
          ) : (
            <p className="run-compare-meta">both runs found the same steps.</p>
          )}

          {/* the way on from here: it stays at the bottom of the window while the differences scroll by, and settles
              below the last of them */}
          <div className="run-compare-actions">
            <div className="run-compare-action-row">
              {canCarryOver ? (
                <button
                  className="analysis-pill success"
                  disabled={carryOverPending || busyRunIds.includes(leftRunId) || busyRunIds.includes(rightRunId)}
                  onClick={() => onCarryOver(leftRunId, rightRunId, comparison.pairs)}
                  type="button"
                >
                  {carryOverPending ? 'bringing the review over…' : `review ${name(rightRunId)} with the review of ${name(leftRunId)}`}
                </button>
              ) : null}
              <button className="analysis-task-link subtle" onClick={() => onReview(rightRunId)} type="button">
                review {name(rightRunId)} as it is
              </button>
              <button className="analysis-task-link subtle" onClick={() => onReview(leftRunId)} type="button">
                back to {name(leftRunId)}
              </button>
            </div>
            {canCarryOver ? (
              <p className="run-compare-meta">
                {[
                  comparison.carryOver.reviewed
                    ? `${comparison.carryOver.reviewed} reviewed ${comparison.carryOver.reviewed === 1 ? 'step goes' : 'steps go'} to the matching ${comparison.carryOver.reviewed === 1 ? 'step' : 'steps'}`
                    : '',
                  comparison.carryOver.manual
                    ? `${comparison.carryOver.manual} ${comparison.carryOver.manual === 1 ? 'step' : 'steps'} added by hand ${comparison.carryOver.manual === 1 ? 'is' : 'are'} added again`
                    : '',
                  comparison.carryOver.lost
                    ? `${comparison.carryOver.lost} reviewed ${comparison.carryOver.lost === 1 ? 'step' : 'steps'} only ${name(leftRunId)} found stay${comparison.carryOver.lost === 1 ? 's' : ''} behind`
                    : '',
                ]
                  .filter(Boolean)
                  .join('; ')}
                . only what is still empty in {name(rightRunId)} is filled in.
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
