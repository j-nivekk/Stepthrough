import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { getUsageReport } from '../../api';
import { TUTORIAL_LESSON_NAMES } from '../../components/pathwayTutorial/PathwayTutorial';
import { downloadText } from '../../lib/accountLinks';
import type { UsageReport as Report } from '../../types';
import { ColumnChart, DARK_GREY, LIGHT_GREY, Stat, toCsv, type ChartColumn, type ChartSeries } from './ColumnChart';

const PEOPLE: ChartSeries[] = [
  { key: 'open', label: 'in the app', colour: LIGHT_GREY },
  { key: 'working', label: 'making changes', colour: DARK_GREY },
];

export const PERIODS: Array<[number, string]> = [
  [1, '24 hours'],
  [7, '7 days'],
  [14, '14 days'],
];

export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function hours(minutes: number): string {
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

function downloads(report: Report) {
  const stamp = report.until.slice(0, 10);
  return [
    {
      label: 'accounts',
      run: () =>
        downloadText(
          `stepthrough-usage-accounts-${stamp}.csv`,
          toCsv([
            ['account', 'shared', 'browsers', 'minutes in the app', 'minutes making changes', 'logins', 'projects', 'uploads',
              'minutes uploaded', 'analyses', 'analyses failed', 'accepted', 'rejected', 'titles and notes', 'steps added',
              'reviews carried over', 'screens merged', 'exports', 'figures', 'tutorial browsers', 'tutorial finished'],
            ...report.accounts.map((row) => [
              row.name, row.shared, row.browsers, row.open_minutes, row.working_minutes, row.logins, row.projects, row.uploads,
              row.upload_minutes, row.analyses, row.analyses_failed, row.accepted, row.rejected, row.annotations, row.steps_added,
              row.carried_over, row.merges, row.exports, row.figures, row.tutorial_browsers, row.tutorial_finished,
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
  ];
}

/** The usage report for the teaching team (backend/app/usage.py), on the administrators' page. */
export function UsageReport() {
  const [days, setDays] = useState(7);
  const reportQuery = useQuery({
    queryKey: ['usage-report', days],
    queryFn: () => getUsageReport(days),
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  });
  const report = reportQuery.data;
  const keep = report?.keep_days ?? 14;

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
    const every = list.length > 10 ? 2 : 1;
    return list.map((day, index) => ({
      key: day.date,
      label: dayLabel(day.date, true),
      tick: index % every === 0 ? dayLabel(day.date) : '',
      values: { open: day.open, working: day.working },
    }));
  }, [report]);

  if (reportQuery.isError) {
    return <p className="analysis-guidance-copy usage-message">{reportQuery.error.message.toLocaleLowerCase()}</p>;
  }
  if (!report) return <p className="entry-empty-copy usage-message">loading…</p>;

  const { totals, tutorial } = report;
  const decided = totals.accepted + totals.rejected;
  const opened = Math.max(1, tutorial.opened);
  return (
    <div className={`usage-report ${reportQuery.isFetching ? 'is-refreshing' : ''}`}>
      <div className="usage-filters">
        <div className="analysis-task-filter-tabs">
          {PERIODS.filter(([value]) => value <= keep || value === 1).map(([value, label]) => (
            <button
              className={`analysis-task-filter-button ${days === value ? 'active' : ''}`}
              key={value}
              onClick={() => setDays(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <span className="usage-downloads">
          download (csv):
          {downloads(report).map((download) => (
            <button className="analysis-task-link subtle" key={download.label} onClick={download.run} type="button">
              {download.label}
            </button>
          ))}
        </span>
      </div>

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
        <Stat label="exports" note={plural(totals.figures, 'pathway figure', 'pathway figures')} value={totals.exports} />
        <Stat label="opened the tutorial" note={`${tutorial.finished} solved all ${tutorial.lessons.length} lessons`} value={tutorial.opened} />
      </div>

      <ColumnChart
        columns={hourColumns}
        mode="nested"
        series={PEOPLE}
        title="people at each hour of the day (each counted once a day)"
      />
      <ColumnChart columns={dayColumns} mode="nested" series={PEOPLE} title="people each day" />

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
              <span
                aria-label={`${lesson.solved} of ${tutorial.opened} solved it`}
                className="usage-meter"
                role="img"
              >
                <span style={{ width: `${(lesson.solved / opened) * 100}%` }} />
              </span>
              <span className="usage-lesson-figure">
                {lesson.solved} of {lesson.reached} solved it{lesson.show_me ? `; show me used ${plural(lesson.show_me, 'time', 'times')}` : ''}
              </span>
            </li>
          ))}
        </ol>
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
                <th>logins</th>
                <th>videos</th>
                <th>analyses</th>
                <th>accepted</th>
                <th>rejected</th>
                <th>titles and notes</th>
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
                  </td>
                  <td>{row.browsers}</td>
                  <td>{hours(row.open_minutes)}</td>
                  <td>{hours(row.working_minutes)}</td>
                  <td>{row.logins}</td>
                  <td>{row.uploads}</td>
                  <td>{row.analyses}</td>
                  <td>{row.accepted}</td>
                  <td>{row.rejected}</td>
                  <td>{row.annotations}</td>
                  <td>{row.exports}</td>
                  <td>
                    {row.tutorial_browsers ? `${row.tutorial_browsers} opened, ${row.tutorial_finished} solved all` : 'not opened'}
                  </td>
                </tr>
              ))}
              {!report.accounts.length ? (
                <tr>
                  <td className="usage-empty" colSpan={12}>
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
        that are not administrators: when someone is in the app (in {report.slot_minutes}-minute slots), what they do
        (such as an analysis, a decision or an export) and how far the tutorial goes; never names, addresses, files or
        what anyone writes. kept for {plural(keep, 'day', 'days')} (admin panel, under server), then deleted.
      </p>
    </div>
  );
}
