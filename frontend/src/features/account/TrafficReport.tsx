import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getTrafficReport } from '../../api';
import { downloadText } from '../../lib/accountLinks';
import type { TrafficKind, TrafficReport as Report } from '../../types';
import { ColumnChart, DARK_GREY, LIGHT_GREY, Stat, formatBytes, toCsv, type ChartColumn, type ChartSeries } from './ColumnChart';
import { ReportFilters } from './ReportFilters';
import { dayLabel, keptNote, plural, tickEvery, type ReportProps } from './UsageReport';

const DIRECTIONS: ChartSeries[] = [
  { key: 'out', label: 'downloaded', colour: DARK_GREY },
  { key: 'in', label: 'uploaded', colour: LIGHT_GREY },
];

const KIND_NAMES: Record<TrafficKind, string> = {
  uploads: 'video uploads',
  media: 'videos and screenshots',
  exports: 'exports',
  live: 'live updates',
  data: 'other data',
  app: "the app's own files",
};
const KINDS = Object.keys(KIND_NAMES) as TrafficKind[];

function busiest(start: string): string {
  const at = new Date(`${start}:00`);
  return `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${start.slice(11, 13)}:00`;
}

function downloads(report: Report) {
  const stamp = `${report.start}-to-${report.end}${report.tag ? `-${report.tag}` : ''}`;
  return [
    {
      label: 'accounts',
      run: () =>
        downloadText(
          `stepthrough-traffic-accounts-${stamp}.csv`,
          toCsv([
            ['account', 'shared', 'administrator', 'bytes downloaded', 'bytes uploaded', 'requests', ...KINDS.map((kind) => `bytes: ${KIND_NAMES[kind]}`)],
            ...report.accounts.map((row) => [
              row.name, row.shared, row.admin, row.bytes_out, row.bytes_in, row.requests, ...KINDS.map((kind) => row.categories[kind] ?? 0),
            ]),
          ]),
        ),
    },
    {
      label: 'days',
      run: () =>
        downloadText(
          `stepthrough-traffic-days-${stamp}.csv`,
          toCsv([
            ['date', 'bytes downloaded', 'bytes uploaded', 'requests'],
            ...report.days_list.map((day) => [day.date, day.bytes_out, day.bytes_in, day.requests]),
          ]),
        ),
    },
    {
      label: 'hours',
      run: () =>
        downloadText(
          `stepthrough-traffic-hours-${stamp}.csv`,
          toCsv([
            ['hour (local)', 'bytes downloaded', 'bytes uploaded'],
            ...report.hours.map((hour) => [`${String(hour.hour).padStart(2, '0')}:00`, hour.bytes_out, hour.bytes_in]),
          ]),
        ),
    },
  ];
}

/** How much goes in and out of the server, per kind, account and time (backend/app/traffic.py). */
export function TrafficReport({ filter, onFilterChange, tags }: ReportProps) {
  const reportQuery = useQuery({
    queryKey: ['traffic-report', filter],
    queryFn: () => getTrafficReport(filter),
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  });
  const report = reportQuery.data;

  const hourColumns = useMemo<ChartColumn[]>(
    () =>
      (report?.hours ?? []).map((hour) => ({
        key: String(hour.hour),
        label: `${String(hour.hour).padStart(2, '0')}:00 to ${String((hour.hour + 1) % 24).padStart(2, '0')}:00, all days`,
        tick: hour.hour % 3 === 0 ? String(hour.hour).padStart(2, '0') : '',
        values: { out: hour.bytes_out, in: hour.bytes_in },
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
      values: { out: day.bytes_out, in: day.bytes_in },
    }));
  }, [report]);

  const filters = (
    <ReportFilters filter={filter} onChange={onFilterChange} tags={tags}>
      {report ? (
        <span className="usage-downloads">
          download (csv):
          {downloads(report).map((download) => (
            <button className="analysis-task-link subtle" key={download.label} onClick={download.run} type="button">
              {download.label}
            </button>
          ))}
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

  const { totals } = report;
  const largestKind = Math.max(1, ...report.categories.map((kind) => kind.bytes_in + kind.bytes_out));
  const people = report.accounts.filter((row) => row.id && !row.admin);
  return (
    <div className={`usage-report ${reportQuery.isFetching ? 'is-refreshing' : ''}`}>
      {filters}

      <div className="usage-stats">
        <Stat label="downloaded" note="answers, as sent over the network" value={formatBytes(totals.bytes_out)} />
        <Stat label="uploaded" note="mostly videos" value={formatBytes(totals.bytes_in)} />
        <Stat label="requests" value={totals.requests.toLocaleString()} />
        <Stat
          label="busiest hour"
          note={report.busiest_hour ? busiest(report.busiest_hour.start) : 'nothing yet'}
          value={report.busiest_hour ? formatBytes(report.busiest_hour.bytes) : '0 B'}
        />
        <Stat
          label="per account"
          note={`on average, over ${plural(people.length, 'account', 'accounts')} that are not administrators`}
          value={formatBytes(
            people.length ? people.reduce((sum, row) => sum + row.bytes_in + row.bytes_out, 0) / people.length : 0,
          )}
        />
      </div>

      <div className="usage-row">
        <ColumnChart
          columns={hourColumns}
          format={formatBytes}
          mode="stacked"
          series={DIRECTIONS}
          title="traffic at each hour of the day, all days together"
        />
        <ColumnChart columns={dayColumns} format={formatBytes} mode="stacked" series={DIRECTIONS} title="traffic each day" />
      </div>

      <section className="usage-section usage-section-narrow">
        <p className="usage-section-head">by kind, downloaded and uploaded together</p>
        <ol className="usage-lessons">
          {KINDS.map((kind) => {
            const entry = report.categories.find((item) => item.category === kind);
            const bytes = entry ? entry.bytes_in + entry.bytes_out : 0;
            return (
              <li className="usage-lesson" key={kind}>
                <span className="usage-lesson-name">{KIND_NAMES[kind]}</span>
                <span aria-label={`${formatBytes(bytes)} of ${KIND_NAMES[kind]}`} className="usage-meter" role="img">
                  <span style={{ width: `${(bytes / largestKind) * 100}%` }} />
                </span>
                <span className="usage-lesson-figure">
                  {formatBytes(bytes)} in {plural(entry?.requests ?? 0, 'request', 'requests')}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="usage-section">
        <p className="usage-section-head">by account, largest first</p>
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>account</th>
                <th>downloaded</th>
                <th>uploaded</th>
                <th>requests</th>
                {KINDS.map((kind) => (
                  <th key={kind}>{KIND_NAMES[kind]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.accounts.map((row) => (
                <tr key={row.id ?? 'nobody'}>
                  <td>
                    {row.name}
                    {row.shared ? <span className="usage-tag">shared</span> : null}
                    {row.admin ? <span className="usage-tag">admin</span> : null}
                  </td>
                  <td>{formatBytes(row.bytes_out)}</td>
                  <td>{formatBytes(row.bytes_in)}</td>
                  <td>{row.requests.toLocaleString()}</td>
                  {KINDS.map((kind) => (
                    <td key={kind}>{row.categories[kind] ? formatBytes(row.categories[kind]) : ''}</td>
                  ))}
                </tr>
              ))}
              {!report.accounts.length ? (
                <tr>
                  <td className="usage-empty" colSpan={4 + KINDS.length}>
                    no traffic yet in this period.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <p className="analysis-parameter-annotation usage-privacy">
        every request is counted as it goes over the network (compressed), for the account logged in, administrators
        included; requests before a login count for nobody. kept as totals per hour, account and kind, never single
        requests, addresses or files; {keptNote(report.keep_days)} (admin panel, under server).
      </p>
    </div>
  );
}
