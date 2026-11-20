import { useQuery } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import { getProgressReport } from '../../api';
import { downloadText } from '../../lib/accountLinks';
import type { ProgressAccount, ProgressProject, ProgressStage } from '../../types';
import { ColumnChart, DARK_GREY, Stat, toCsv, type ChartColumn } from './ColumnChart';
import { ReportFilters, localDate } from './ReportFilters';
import { plural, tickEvery, type ReportProps } from './UsageReport';

const STAGE_NAMES: Record<ProgressStage, string> = {
  videos: 'videos',
  analysed: 'analysed',
  reviewed: 'reviewed',
  described: 'described',
  pathway: 'pathway figure',
  exported: 'exported',
};
const STAGE_HINTS: Record<ProgressStage, string> = {
  videos: 'a video is uploaded',
  analysed: 'an analysis of a video is complete',
  reviewed: 'every video has an analysis with no undecided steps, and some steps are accepted',
  described: 'every accepted step has a title or notes',
  pathway: 'a pathway figure was downloaded',
  exported: 'the steps were exported',
};
const ALL_STAGES = Object.keys(STAGE_NAMES) as ProgressStage[];

const SETTING_NAMES: Record<string, string> = {
  recording_type: 'recording type',
  min_dwell_ms: 'minimum time on screen',
  min_change_percent: 'smallest change',
  ignore_regions: 'ignore areas',
  ignore_status_bar: 'phone status bar',
  scroll_mode: 'scrolling',
  group_typing: 'group typing',
  include_opening_screen: 'opening screen',
  enable_ocr: 'read text',
  sensitivity: 'sensitivity',
  sample_fps: 'frames looked at',
};

/** Days without a change after which a group that is not done needs a look. */
const QUIET_DAYS = 7;
const PATHWAY_KEY = 'stepthrough.progress.pathway-counts';

function loadPathwayCounts(): boolean {
  try {
    return window.localStorage.getItem(PATHWAY_KEY) !== 'no';
  } catch {
    return true;
  }
}

function savePathwayCounts(value: boolean) {
  try {
    window.localStorage.setItem(PATHWAY_KEY, value ? 'yes' : 'no');
  } catch {
    // only a convenience
  }
}

function shortDate(moment: string): string {
  return new Date(moment).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function daysSince(moment: string | null, now: number): number | null {
  return moment ? Math.floor((now - new Date(moment).getTime()) / 86_400_000) : null;
}

interface Judged {
  account: ProgressAccount;
  /** The project furthest on (the latest changed, of those as far): the one the account is judged by. */
  main: ProgressProject | null;
  reachedCount: number;
  done: boolean;
  /** When the account first reached each stage, in any of its projects. */
  reachedAt: Record<ProgressStage, string | null>;
  lastChange: string | null;
  flags: string[];
}

function judge(account: ProgressAccount, stages: ProgressStage[], now: number): Judged {
  const count = (project: ProgressProject) => stages.filter((stage) => project.reached[stage]).length;
  const main =
    [...account.projects].sort(
      (left, right) => count(right) - count(left) || (right.last_change ?? '').localeCompare(left.last_change ?? ''),
    )[0] ?? null;
  const reachedAt = Object.fromEntries(
    ALL_STAGES.map((stage) => {
      const dates = account.projects.map((project) => project.reached[stage]).filter((date): date is string => Boolean(date));
      return [stage, dates.length ? dates.sort()[0] : null];
    }),
  ) as Record<ProgressStage, string | null>;
  const changes = account.projects.map((project) => project.last_change).filter((change): change is string => Boolean(change)).sort();
  const lastChange = changes.length ? changes[changes.length - 1] : null;
  const reachedCount = main ? count(main) : 0;
  const done = reachedCount === stages.length;
  const flags: string[] = [];
  if (!main || !main.videos) flags.push('not started');
  const quiet = daysSince(lastChange, now);
  if (!done && main?.videos && quiet !== null && quiet >= QUIET_DAYS) flags.push(`no change for ${quiet} days`);
  const failed = account.projects.reduce((sum, project) => sum + project.failed_unretried, 0);
  if (failed) flags.push(`latest analysis of ${plural(failed, 'video', 'videos')} failed`);
  return { account, main, reachedCount, done, reachedAt, lastChange, flags };
}

function StageCell({ project, stage, counted }: { project: ProgressProject; stage: ProgressStage; counted: boolean }) {
  const reached = project.reached[stage];
  const decided = project.accepted + project.rejected;
  let share: number | null = null;
  let text = '';
  let title = STAGE_HINTS[stage];
  if (stage === 'videos') {
    text = project.videos ? `${plural(project.videos, 'video', 'videos')}, ${Math.round(project.video_minutes)} min` : 'none yet';
  } else if (stage === 'analysed') {
    share = project.videos ? project.videos_analysed / project.videos : null;
    text = project.runs
      ? `${project.videos_analysed} of ${project.videos} videos; ${plural(project.runs, 'analysis', 'analyses')}${project.runs_failed ? `, ${project.runs_failed} failed` : ''}`
      : 'no analysis yet';
    if (project.settings_changed.length) {
      title += `. settings changed: ${project.settings_changed.map((key) => SETTING_NAMES[key] ?? key).join(', ')}`;
    }
  } else if (stage === 'reviewed') {
    share = decided + project.pending ? decided / (decided + project.pending) : null;
    text = decided + project.pending ? `${decided} of ${decided + project.pending} steps decided` : 'no steps yet';
    title += `. ${project.accepted} accepted, ${project.rejected} rejected${project.added ? `, ${project.added} added by hand` : ''}`;
  } else if (stage === 'described') {
    share = project.accepted ? project.described / project.accepted : null;
    text = project.accepted ? `${project.described} of ${project.accepted} accepted steps` : 'no accepted steps yet';
  } else if (stage === 'pathway') {
    text = project.corrections ? plural(project.corrections, 'correction', 'corrections') : 'no corrections';
  } else {
    text = reached ? '' : 'not yet';
  }
  return (
    <td className={`progress-cell ${reached ? 'is-reached' : ''} ${counted ? '' : 'is-not-counted'}`} title={title}>
      <span className="progress-mark">{reached ? `✓ ${shortDate(reached)}` : share !== null ? `${Math.round(share * 100)}%` : '–'}</span>
      {share !== null && !reached ? (
        <span aria-hidden="true" className="usage-meter progress-meter">
          <span style={{ width: `${share * 100}%` }} />
        </span>
      ) : null}
      {text ? <span className="progress-text">{text}</span> : null}
    </td>
  );
}

function csv(judged: Judged[], stages: ProgressStage[]): string {
  return toCsv([
    ['account', 'tags', 'project', 'videos', 'video minutes', 'videos analysed', 'analyses', 'analyses failed', 'settings changed',
      'steps found', 'steps added', 'accepted', 'rejected', 'undecided', 'accepted with title or notes', 'pathway corrections',
      ...ALL_STAGES.map((stage) => `reached: ${STAGE_NAMES[stage]}`), 'last change', `done (${stages.map((stage) => STAGE_NAMES[stage]).join(', ')})`],
    ...judged.flatMap(({ account }) =>
      (account.projects.length ? account.projects : [null]).map((project) =>
        project
          ? [account.name, [...(account.visitor ? ['visitor'] : []), ...account.tags].join(' '), project.name, project.videos, project.video_minutes, project.videos_analysed, project.runs,
              project.runs_failed, project.settings_changed.map((key) => SETTING_NAMES[key] ?? key).join('; '), project.found, project.added,
              project.accepted, project.rejected, project.pending, project.described, project.corrections,
              ...ALL_STAGES.map((stage) => project.reached[stage] ?? ''), project.last_change ?? '',
              stages.every((stage) => project.reached[stage])]
          : [account.name, [...(account.visitor ? ['visitor'] : []), ...account.tags].join(' '), '', ...Array(13).fill(''), ...ALL_STAGES.map(() => ''), '', false],
      ),
    ),
  ]);
}

/** The Monday of the week a date falls in, as YYYY-MM-DD. */
function weekOf(moment: Date): string {
  const day = new Date(moment);
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return localDate(day);
}

/** How many accounts had reached each stage by the end of each week, from the first project to this week. */
function weeksOfStages(judged: Judged[], stages: ProgressStage[]): Record<ProgressStage, ChartColumn[]> {
  const starts = judged.flatMap(({ account }) => account.projects.map((project) => project.created_at)).sort();
  const result = {} as Record<ProgressStage, ChartColumn[]>;
  if (!starts.length) {
    for (const stage of stages) result[stage] = [];
    return result;
  }
  const weeks: string[] = [];
  const cursor = new Date(`${weekOf(new Date(starts[0]))}T12:00:00`);
  const thisWeek = weekOf(new Date());
  while (localDate(cursor) <= thisWeek) {
    weeks.push(localDate(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  const every = tickEvery(weeks.length);
  for (const stage of stages) {
    const dates = judged.map((entry) => entry.reachedAt[stage]).filter((date): date is string => Boolean(date)).map((date) => localDate(new Date(date)));
    result[stage] = weeks.map((week, index) => {
      const end = new Date(`${week}T12:00:00`);
      end.setDate(end.getDate() + 6);
      const last = localDate(end);
      const label = new Date(`${week}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return {
        key: week,
        label: `by the end of the week of ${label}`,
        tick: index % every === 0 ? label : '',
        values: { reached: dates.filter((date) => date <= last).length },
      };
    });
  }
  return result;
}

/** How far each account has got with its projects (backend/app/progress.py), read from the projects themselves. */
export function ProgressReport({ filter, onFilterChange, tags }: ReportProps) {
  const reportQuery = useQuery({
    queryKey: ['progress-report', filter.tag],
    queryFn: () => getProgressReport(filter.tag),
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  });
  const report = reportQuery.data;
  const [pathwayCounts, setPathwayCounts] = useState(loadPathwayCounts);
  const [sort, setSort] = useState<'progress' | 'name' | 'quiet'>('progress');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const stages = useMemo(() => ALL_STAGES.filter((stage) => pathwayCounts || stage !== 'pathway'), [pathwayCounts]);
  const now = report ? new Date(report.generated_at).getTime() : Date.now();

  const judged = useMemo(() => {
    const list = (report?.accounts ?? []).map((account) => judge(account, stages, now));
    const byName = (left: Judged, right: Judged) => left.account.name.localeCompare(right.account.name);
    if (sort === 'name') return list.sort(byName);
    if (sort === 'quiet') return list.sort((left, right) => (left.lastChange ?? '').localeCompare(right.lastChange ?? '') || byName(left, right));
    return list.sort((left, right) => left.reachedCount - right.reachedCount || (left.lastChange ?? '').localeCompare(right.lastChange ?? '') || byName(left, right));
  }, [report, stages, sort, now]);
  const weeks = useMemo(() => weeksOfStages(judged, stages), [judged, stages]);

  const filters = (
    <ReportFilters filter={filter} onChange={onFilterChange} showPeriod={false} tags={tags}>
      <div aria-label="what counts as done" className="usage-filter-group" role="group">
        <span className="pathway-control-label">pathway figure</span>
        <div className="analysis-task-filter-tabs">
          {([true, false] as const).map((value) => (
            <button
              aria-pressed={pathwayCounts === value}
              className={`analysis-task-filter-button ${pathwayCounts === value ? 'active' : ''}`}
              key={String(value)}
              onClick={() => {
                setPathwayCounts(value);
                savePathwayCounts(value);
              }}
              title={value ? 'a group is done once it has also downloaded a pathway figure' : 'a group can be done without a pathway figure'}
              type="button"
            >
              {value ? 'counts toward done' : 'not needed'}
            </button>
          ))}
        </div>
      </div>
      {report ? (
        <span className="usage-downloads">
          download (csv):
          <button
            className="analysis-task-link subtle"
            onClick={() => downloadText(`stepthrough-progress-${localDate()}${filter.tag ? `-${filter.tag}` : ''}.csv`, csv(judged, stages))}
            type="button"
          >
            projects
          </button>
        </span>
      ) : null}
    </ReportFilters>
  );

  if (reportQuery.isError) {
    return (
      <div className="usage-report">
        {filters}
        <p className="analysis-guidance-copy usage-message">{reportQuery.error.message.toLocaleLowerCase()}</p>
      </div>
    );
  }
  if (!report) return <p className="entry-empty-copy usage-message">loading…</p>;

  const total = judged.length;
  const doneCount = judged.filter((entry) => entry.done).length;
  const notStarted = judged.filter((entry) => entry.flags.includes('not started')).length;
  const needLook = judged.filter((entry) => entry.flags.some((flag) => flag !== 'not started')).length;
  const reachedBy = (stage: ProgressStage) => judged.filter((entry) => entry.reachedAt[stage]).length;
  const columns = 4 + ALL_STAGES.length;

  function projectRow(project: ProgressProject, key: string, nested: boolean, entry: Judged) {
    const projectDone = stages.every((stage) => project.reached[stage]);
    const quiet = daysSince(project.last_change, now);
    return (
      <tr className={nested ? 'progress-project' : ''} key={key}>
        <th scope="row">
          {nested ? (
            <span className="progress-project-name">{project.name}</span>
          ) : (
            <>
              <span className="progress-account">{entry.account.name}</span>
              {entry.account.visitor ? <span className="usage-tag">visitor</span> : null}
              {entry.account.tags.map((tag) => (
                <span className="usage-tag" key={tag}>
                  {tag}
                </span>
              ))}
              <span className="progress-project-name">
                {project.name}
                {entry.account.projects.length > 1 ? (
                  <button
                    aria-expanded={open.has(entry.account.id)}
                    className="analysis-task-link subtle"
                    onClick={() =>
                      setOpen((current) => {
                        const next = new Set(current);
                        if (next.has(entry.account.id)) next.delete(entry.account.id);
                        else next.add(entry.account.id);
                        return next;
                      })
                    }
                    type="button"
                  >
                    {open.has(entry.account.id) ? 'hide the others' : `and ${plural(entry.account.projects.length - 1, 'other project', 'other projects')}`}
                  </button>
                ) : null}
              </span>
            </>
          )}
        </th>
        {ALL_STAGES.map((stage) => (
          <StageCell counted={stages.includes(stage)} key={stage} project={project} stage={stage} />
        ))}
        <td className={projectDone ? 'progress-done' : ''}>{projectDone ? 'done' : `${stages.filter((stage) => project.reached[stage]).length} of ${stages.length}`}</td>
        <td>{project.last_change ? (quiet === 0 ? 'today' : quiet === 1 ? 'yesterday' : `${quiet} days ago`) : ''}</td>
        <td className="progress-flags">{nested ? '' : entry.flags.join('; ')}</td>
      </tr>
    );
  }

  return (
    <div className={`usage-report ${reportQuery.isFetching ? 'is-refreshing' : ''}`}>
      {filters}

      <div className="usage-stats">
        <Stat label="groups" note={filter.tag ? `with the tag ${filter.tag}` : 'accounts that are not administrators'} value={total} />
        <Stat
          label="done"
          note={pathwayCounts ? 'through export, pathway figure included' : 'through export; no pathway figure needed'}
          value={`${doneCount} of ${total}`}
        />
        <Stat label="not started" note="no video uploaded yet" value={notStarted} />
        <Stat label="need a look" note={`no change for ${QUIET_DAYS} days or more, or a failed analysis`} value={needLook} />
      </div>

      <div className="usage-row">
        <section className="usage-section">
          <p className="usage-section-head">how many groups have reached each stage</p>
          <ol className="usage-lessons">
            {ALL_STAGES.map((stage) => (
              <li className={`usage-lesson ${stages.includes(stage) ? '' : 'is-not-counted'}`} key={stage} title={STAGE_HINTS[stage]}>
                <span className="usage-lesson-name">{STAGE_NAMES[stage]}</span>
                <span aria-label={`${reachedBy(stage)} of ${total} groups`} className="usage-meter" role="img">
                  <span style={{ width: `${total ? (reachedBy(stage) / total) * 100 : 0}%` }} />
                </span>
                <span className="usage-lesson-figure">
                  {reachedBy(stage)} of {total}
                  {stages.includes(stage) ? '' : ', not counted toward done'}
                </span>
              </li>
            ))}
          </ol>
          <p className="analysis-parameter-annotation">
            read from the projects as they are now, so it covers the whole course, whatever the keeping time of usage. a
            group with several projects counts at the one furthest on.
          </p>
        </section>
        <section className="usage-section">
          <p className="usage-section-head">groups at each stage, week by week</p>
          <div className="usage-small-multiples">
            {stages.map((stage) => (
              <ColumnChart
                columns={weeks[stage]}
                height={110}
                key={stage}
                mode="nested"
                series={[{ key: 'reached', label: 'groups', colour: DARK_GREY }]}
                title={STAGE_NAMES[stage]}
              />
            ))}
          </div>
        </section>
      </div>

      <section className="usage-section">
        <div className="usage-section-head progress-head">
          <span>by group</span>
          <span className="analysis-task-filter-tabs">
            {(
              [
                ['progress', 'least done first'],
                ['quiet', 'quietest first'],
                ['name', 'by name'],
              ] as const
            ).map(([value, label]) => (
              <button
                className={`analysis-task-filter-button ${sort === value ? 'active' : ''}`}
                key={value}
                onClick={() => setSort(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        <div className="usage-table-scroll">
          <table className="usage-table progress-table">
            <thead>
              <tr>
                <th>group and project</th>
                {ALL_STAGES.map((stage) => (
                  <th className={stages.includes(stage) ? '' : 'is-not-counted'} key={stage} title={STAGE_HINTS[stage]}>
                    {STAGE_NAMES[stage]}
                  </th>
                ))}
                <th>stages</th>
                <th>last change</th>
                <th>needs a look</th>
              </tr>
            </thead>
            <tbody>
              {judged.map((entry) =>
                entry.main ? (
                  <Fragment key={entry.account.id}>
                    {projectRow(entry.main, entry.main.id, false, entry)}
                    {open.has(entry.account.id)
                      ? entry.account.projects
                          .filter((project) => project.id !== entry.main?.id)
                          .map((project) => projectRow(project, project.id, true, entry))
                      : null}
                  </Fragment>
                ) : (
                  <tr key={entry.account.id}>
                    <th scope="row">
                      <span className="progress-account">{entry.account.name}</span>
                      {entry.account.visitor ? <span className="usage-tag">visitor</span> : null}
                      {entry.account.tags.map((tag) => (
                        <span className="usage-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                      <span className="progress-project-name">no project yet</span>
                    </th>
                    <td className="usage-empty" colSpan={ALL_STAGES.length + 2} />
                    <td className="progress-flags">{entry.flags.join('; ')}</td>
                  </tr>
                ),
              )}
              {!judged.length ? (
                <tr>
                  <td className="usage-empty" colSpan={columns}>
                    no groups{filter.tag ? ` with the tag ${filter.tag}` : ''} yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <p className="analysis-parameter-annotation usage-privacy">
        each video counts with its analysis that has the most decisions. a stage shows the date it was reached as well as
        the projects can tell: for reviewed and described, the last change to the steps once they were done. read from the
        projects of accounts that are not administrators: counts and dates only, never what anyone wrote.
      </p>
    </div>
  );
}
