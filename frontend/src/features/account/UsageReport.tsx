import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type CSSProperties } from 'react';
import { getUsageReport } from '../../api';
import { TUTORIAL_LESSON_NAMES } from '../../components/pathwayTutorial/PathwayTutorial';
import { downloadText } from '../../lib/accountLinks';
import type { ReportFilter, UsageReport as Report, UsageStage } from '../../types';
import { ColumnChart, DARK_GREY, LIGHT_GREY, Stat, toCsv, type ChartColumn, type ChartSeries } from './ColumnChart';
import { ReportFilters } from './ReportFilters';
import { keepLabel } from './ServerSettingsPanel';

const PEOPLE: ChartSeries[] = [
  { key: 'open', label: 'in the app', colour: LIGHT_GREY },
  { key: 'working', label: 'making changes', colour: DARK_GREY },
];

const STAGE_NAMES: Record<UsageStage, string> = {
  projects: 'the project list',
  import: 'importing videos',
  analysis: 'analysing and reviewing steps',
  pathway: 'the pathway',
};
const STAGES = Object.keys(STAGE_NAMES) as UsageStage[];

const CORRECTION_NAMES: Record<string, string> = {
  same_screen: 'the same screen as',
  new_screen: 'a new screen',
  automatic: 'back to automatic',
  popup: 'a pop-up',
  not_popup: 'not a pop-up',
  popup_automatic: 'pop-up back to automatic',
  return: 'returns to an earlier screen',
  no_return: 'return taken away',
};

/** The grid's shades, for minutes making changes on a day: checked with the dataviz validator (ordinal, one hue,
 * the light end above 2:1 against the admin page). No changes leaves a cell empty. */
const GRID_STEPS: Array<[number, string, string]> = [
  [1, '#a6a6a6', 'under 30 min'],
  [30, '#828282', '30 to 59 min'],
  [60, '#5f5f5f', '1 to 2 h'],
  [120, '#3f3f3f', '2 h or more'],
];

export interface ReportProps {
  filter: ReportFilter;
  onFilterChange: (filter: ReportFilter) => void;
  tags: string[];
}

export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function hours(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h`;
}

function seconds(value: number | null): string {
  if (value === null) return 'none yet';
  return value < 90 ? `${Math.round(value)} s` : `${(value / 60).toFixed(1)} min`;
}

export function dayLabel(date: string, long = false): string {
  const day = new Date(`${date}T12:00:00`);
  return day.toLocaleDateString(undefined, long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric' });
}

/** Every so many columns gets a label, so that about a dozen fit under a chart. */
export function tickEvery(count: number): number {
  return Math.max(1, Math.ceil(count / 12));
}

function shade(minutes: number): string | null {
  let colour: string | null = null;
  for (const [from, step] of GRID_STEPS) if (minutes >= from) colour = step;
  return colour;
}

export function keptNote(keep: number | null): string {
  return keep === null ? 'kept until an administrator chooses a shorter time' : `kept for ${keepLabel(keep)}, then deleted`;
}

function downloads(report: Report, filter: ReportFilter) {
  const stamp = `${report.start}-to-${report.end}${report.tag ? `-${report.tag}` : ''}`;
  return [
    {
      label: 'accounts',
      run: () =>
        downloadText(
          `stepthrough-usage-accounts-${stamp}.csv`,
          toCsv([
            ['account', 'shared', 'visitor', 'browsers', 'minutes in the app', 'minutes making changes', 'days with changes', 'logins',
              'projects', 'uploads', 'minutes uploaded', 'analyses', 'analyses failed', 'accepted', 'rejected', 'titles and notes',
              'steps added', 'reviews carried over', 'runs duplicated', 'projects downloaded', 'projects imported', 'screens merged', 'pathway corrections', 'comparisons', 'exports', 'figures',
              'tutorial browsers', 'tutorial finished', ...STAGES.map((stage) => `minutes: ${STAGE_NAMES[stage]}`)],
            ...report.accounts.map((row) => [
              row.name, row.shared, Boolean(row.visitor), row.browsers, row.open_minutes, row.working_minutes, row.active_days, row.logins, row.projects,
              row.uploads, row.upload_minutes, row.analyses, row.analyses_failed, row.accepted, row.rejected, row.annotations,
              row.steps_added, row.carried_over, row.duplicates ?? 0, row.project_downloads ?? 0, row.project_imports ?? 0, row.merges, row.corrections, row.comparisons, row.exports, row.figures,
              row.tutorial_browsers, row.tutorial_finished, ...STAGES.map((stage) => row.stage_minutes[stage]),
            ]),
          ]),
        ),
    },
    {
      label: 'days',
      run: () =>
        downloadText(
          `stepthrough-usage-days-${stamp}.csv`,
          toCsv([
            ['date', 'browsers in the app', 'browsers making changes', 'accounts', 'logins', 'analyses', 'steps decided'],
            ...report.days_list.map((day) => [day.date, day.open, day.working, day.accounts, day.logins, day.analyses, day.decisions]),
          ]),
        ),
    },
    {
      label: 'hours',
      run: () =>
        downloadText(
          `stepthrough-usage-hours-${stamp}.csv`,
          toCsv([
            ['hour (local)', 'browsers in the app', 'browsers making changes'],
            ...report.hours.map((hour) => [`${String(hour.hour).padStart(2, '0')}:00`, hour.open, hour.working]),
          ]),
        ),
    },
    {
      label: 'everything, one row per account, day and measure',
      run: async () => {
        const full = await getUsageReport(filter, true);
        downloadText(`stepthrough-usage-long-${stamp}.csv`, toCsv([['account', 'date', 'measure', 'amount'], ...(full.long ?? [])]));
      },
    },
  ];
}

/** The usage report for the teaching team (backend/app/usage.py), on the administrators' page. */
export function UsageReport({ filter, onFilterChange, tags }: ReportProps) {
  const reportQuery = useQuery({
    queryKey: ['usage-report', filter],
    queryFn: () => getUsageReport(filter),
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  });
  const report = reportQuery.data;
  const [downloadError, setDownloadError] = useState('');

  const hourColumns = useMemo<ChartColumn[]>(
    () =>
      (report?.hours ?? []).map((hour) => ({
        key: String(hour.hour),
        label: `${String(hour.hour).padStart(2, '0')}:00 to ${String((hour.hour + 1) % 24).padStart(2, '0')}:00`,
        tick: hour.hour % 3 === 0 ? String(hour.hour).padStart(2, '0') : '',
        values: { open: hour.open, working: hour.working },
      })),
    [report],
  );
  const dayColumns = useMemo<ChartColumn[]>(() => {
    const list = report?.days_list ?? [];
    const every = tickEvery(list.length);
    return list.map((day, index) => ({
      key: day.date,
      label: dayLabel(day.date, true),
      tick: index % every === 0 ? dayLabel(day.date) : '',
      values: { open: day.open, working: day.working },
    }));
  }, [report]);

  const filters = (
    <ReportFilters filter={filter} onChange={onFilterChange} tags={tags}>
      {report ? (
        <span className="usage-downloads">
          download (csv):
          {downloads(report, filter).map((download) => (
            <button
              className="analysis-task-link subtle"
              key={download.label}
              onClick={() => {
                setDownloadError('');
                Promise.resolve(download.run()).catch((error: Error) => setDownloadError(error.message.toLocaleLowerCase()));
              }}
              type="button"
            >
              {download.label}
            </button>
          ))}
          {downloadError ? <span className="users-error">{downloadError}</span> : null}
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

  const { totals, tutorial } = report;
  const decided = totals.accepted + totals.rejected;
  const opened = Math.max(1, tutorial.opened);
  const stageTotal = Math.max(1, ...STAGES.map((stage) => totals.stage_minutes[stage]));
  const corrections = Object.entries(totals.corrections_by_choice).filter(([, count]) => count);
  // The grid's cells are wider for a short period. Its day labels (about 6px a character) are spaced so that none
  // runs into the next, counted back from the last day so that today always has one.
  const dayCount = report.days_list.length;
  const dayCell = dayCount <= 14 ? 28 : dayCount <= 31 ? 20 : 14;
  const labelWidth = Math.max(1, ...report.days_list.map((day) => dayLabel(day.date).length)) * 6 + 8;
  const gridEvery = Math.max(1, Math.ceil(labelWidth / (dayCell + 2)));
  return (
    <div className={`usage-report ${reportQuery.isFetching ? 'is-refreshing' : ''}`}>
      {filters}

      <div className="usage-stats">
        <Stat
          label="people"
          note={`in ${plural(totals.accounts, 'account', 'accounts')}; each login in a browser counts`}
          value={totals.browsers}
        />
        <Stat
          label="logins"
          note={totals.login_failures ? `and ${plural(totals.login_failures, 'wrong password', 'wrong passwords')}` : 'no wrong passwords'}
          value={totals.logins}
        />
        <Stat
          label="analyses"
          note={`usually took ${seconds(totals.analysis_median_seconds)} after waiting ${seconds(totals.analysis_wait_median_seconds)}${totals.analyses_failed ? `; ${totals.analyses_failed} failed` : ''}`}
          value={totals.analyses}
        />
        <Stat label="steps decided" note={`${totals.accepted} accepted, ${totals.rejected} rejected`} value={decided} />
        <Stat
          label="pathway corrections"
          note={corrections.length ? corrections.map(([choice, count]) => `${count} ${CORRECTION_NAMES[choice] ?? choice}`).join(', ') : 'none yet'}
          value={totals.corrections}
        />
        <Stat label="exports" note={plural(totals.figures, 'pathway figure', 'pathway figures')} value={totals.exports} />
        <Stat label="opened the tutorial" note={`${tutorial.finished} solved all ${tutorial.lessons.length} lessons`} value={tutorial.opened} />
      </div>

      <div className="usage-row">
        <ColumnChart
          columns={hourColumns}
          mode="nested"
          series={PEOPLE}
          title="people at each hour of the day (each counted once a day)"
        />
        <ColumnChart columns={dayColumns} mode="nested" series={PEOPLE} title="people each day" />
      </div>

      <div className="usage-row">
        <section className="usage-section">
          <p className="usage-section-head">time in the app, by the page open</p>
          <ol className="usage-lessons">
            {STAGES.map((stage) => (
              <li className="usage-lesson" key={stage}>
                <span className="usage-lesson-name">{STAGE_NAMES[stage]}</span>
                <span aria-label={`${hours(totals.stage_minutes[stage])} on ${STAGE_NAMES[stage]}`} className="usage-meter" role="img">
                  <span style={{ width: `${(totals.stage_minutes[stage] / stageTotal) * 100}%` }} />
                </span>
                <span className="usage-lesson-figure">{hours(totals.stage_minutes[stage])}</span>
              </li>
            ))}
          </ol>
          <p className="analysis-parameter-annotation">
            all browsers together. the run comparison was opened {plural(totals.comparisons, 'time', 'times')}, the
            pathway's boxes switched {plural(totals.boxes_switched, 'time', 'times')} and the guide opened{' '}
            {plural(totals.guide_opened, 'time', 'times')}.
          </p>
        </section>

        <section className="usage-section">
          <p className="usage-section-head">
            pathway tutorial: {plural(tutorial.invited, 'browser', 'browsers')} invited, {tutorial.opened} opened it
            {Object.keys(tutorial.opened_from).length
              ? ` (${Object.entries(tutorial.opened_from).map(([from, count]) => `${count} from the ${from === 'about' ? 'about panel' : from}`).join(', ')})`
              : ''}
            {tutorial.median_minutes !== null ? `, usually for ${Math.round(tutorial.median_minutes)} min` : ''}
          </p>
          <ol className="usage-lessons">
            {tutorial.lessons.map((lesson) => (
              <li className="usage-lesson" key={lesson.lesson}>
                <span className="usage-lesson-name">
                  {lesson.lesson}. {TUTORIAL_LESSON_NAMES[lesson.lesson - 1] ?? ''}
                </span>
                <span aria-label={`${lesson.solved} of ${tutorial.opened} solved it`} className="usage-meter" role="img">
                  <span style={{ width: `${(lesson.solved / opened) * 100}%` }} />
                </span>
                <span className="usage-lesson-figure">
                  {lesson.solved} of {lesson.reached} solved it{lesson.show_me ? `; show me used ${plural(lesson.show_me, 'time', 'times')}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="usage-section">
        <p className="usage-section-head">
          minutes making changes, per account and day
          <span className="usage-days-legend">
            {GRID_STEPS.map(([from, colour, label]) => (
              <span key={from}>
                <i style={{ background: colour }} /> {label}
              </span>
            ))}
            <span>
              <i className="usage-days-none" /> none
            </span>
          </span>
        </p>
        <div className="usage-table-scroll">
          <table className="usage-days-grid" style={{ '--day-cell': `${dayCell}px` } as CSSProperties}>
            <thead>
              <tr>
                <th />
                {report.days_list.map((day, index) => (
                  <th key={day.date} scope="col" title={dayLabel(day.date, true)}>
                    {(dayCount - 1 - index) % gridEvery === 0 ? <span>{dayLabel(day.date)}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.accounts.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.name}</th>
                  {row.worked.map((minutes, index) => {
                    const colour = shade(minutes);
                    const label = `${row.name}, ${dayLabel(report.days_list[index].date, true)}: ${minutes ? `${minutes} min making changes` : 'no changes'}`;
                    return (
                      <td aria-label={label} key={report.days_list[index].date} title={label}>
                        {colour ? <span style={{ background: colour }} /> : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!report.accounts.length ? (
                <tr>
                  <td className="usage-empty" colSpan={report.days_list.length + 1}>
                    nobody yet in this period.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="usage-section">
        <p className="usage-section-head">by account</p>
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>account</th>
                <th title="logins in separate browsers: the people working under the account">people</th>
                <th>in the app</th>
                <th>making changes</th>
                <th title="days on which changes were made">days</th>
                <th>logins</th>
                <th>videos</th>
                <th>analyses</th>
                <th>accepted</th>
                <th>rejected</th>
                <th>titles and notes</th>
                <th>pathway corrections</th>
                <th>importing</th>
                <th>analysing and reviewing</th>
                <th>pathway</th>
                <th>exports</th>
                <th>tutorial</th>
              </tr>
            </thead>
            <tbody>
              {report.accounts.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.name}
                    {row.shared ? <span className="usage-tag">shared</span> : null}
                    {row.visitor ? <span className="usage-tag">visitor</span> : null}
                  </td>
                  <td>{row.browsers}</td>
                  <td>{hours(row.open_minutes)}</td>
                  <td>{hours(row.working_minutes)}</td>
                  <td>{row.active_days}</td>
                  <td>{row.logins}</td>
                  <td>{row.uploads}</td>
                  <td>{row.analyses}</td>
                  <td>{row.accepted}</td>
                  <td>{row.rejected}</td>
                  <td>{row.annotations}</td>
                  <td>{row.corrections}</td>
                  <td>{hours(row.stage_minutes.import)}</td>
                  <td>{hours(row.stage_minutes.analysis)}</td>
                  <td>{hours(row.stage_minutes.pathway)}</td>
                  <td>{row.exports}</td>
                  <td>
                    {row.tutorial_browsers ? `${row.tutorial_browsers} opened, ${row.tutorial_finished} solved all` : 'not opened'}
                  </td>
                </tr>
              ))}
              {!report.accounts.length ? (
                <tr>
                  <td className="usage-empty" colSpan={17}>
                    nobody yet in this period.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <p className="analysis-parameter-annotation usage-privacy">
        people are counted by their login in each browser, so everyone working under one shared account counts as a person of
        their own (someone who logs in on two browsers, or logs out and in again, counts twice). recorded on this server for accounts
        that are not administrators: when someone is in the app (in {report.slot_minutes}-minute slots) and on which page, what they
        do (such as an analysis, a decision, a correction or an export) and how far the tutorial goes; never names, addresses, files or
        what anyone writes. {keptNote(report.keep_days)} (admin panel, under server).
      </p>
    </div>
  );
}
