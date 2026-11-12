import { queryOptions } from '@tanstack/react-query';
import type { Pathway, PathwayDetail, RunDetail } from '../types';

/** Keep a chart steady while its edits load, but never carry it over to another run or grouping mode. */
export function pathwayQueryOptions(
  run: RunDetail,
  detail: PathwayDetail,
  fetchPathway: (runId: string, detail: PathwayDetail, signal?: AbortSignal) => Promise<Pathway>,
) {
  const runId = run.summary.id;
  return queryOptions({
    queryKey: ['pathway', runId, detail, run.candidates],
    queryFn: ({ signal }) => fetchPathway(runId, detail, signal),
    enabled: run.accepted_steps.length > 0,
    placeholderData: (previous, query) =>
      query?.queryKey[1] === runId && query.queryKey[2] === detail ? previous : undefined,
  });
}
