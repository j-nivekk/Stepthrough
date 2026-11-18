import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getServerSettings } from '../../api';
import type { ReportFilter, ReportPeriod } from '../../types';

/** The usual periods, in whole days up to today; 0 is everything kept. */
const PERIODS: Array<[number, string]> = [
  [1, 'today'],
  [7, '7 days'],
  [14, '14 days'],
  [28, '4 weeks'],
  [56, '8 weeks'],
  [0, 'everything kept'],
];

/** A local date as YYYY-MM-DD. */
export function localDate(moment: Date = new Date()): string {
  return `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, '0')}-${String(moment.getDate()).padStart(2, '0')}`;
}

function daysAgo(days: number): string {
  const moment = new Date();
  moment.setDate(moment.getDate() - days);
  return localDate(moment);
}

export function describePeriod(period: ReportPeriod): string {
  if ('days' in period) return PERIODS.find(([days]) => days === period.days)?.[1] ?? `${period.days} days`;
  return `${period.start} to ${period.end}`;
}

/**
 * Above each report of the admin panel: the period (left out for progress, which is read from the projects as they
 * are now), the class (accounts with one tag), and whatever the report adds at the end, such as its downloads.
 */
export function ReportFilters({
  children,
  filter,
  onChange,
  showPeriod = true,
  tags,
}: {
  children?: ReactNode;
  filter: ReportFilter;
  onChange: (filter: ReportFilter) => void;
  showPeriod?: boolean;
  tags: string[];
}) {
  const settingsQuery = useQuery({ queryKey: ['server-settings'], queryFn: getServerSettings });
  const keep = settingsQuery.data?.usage_keep_days.value;
  const custom = !('days' in filter.period);
  const setPeriod = (period: ReportPeriod) => onChange({ ...filter, period });

  return (
    <div className="usage-filters">
      {showPeriod ? (
        <div aria-label="period" className="usage-filter-group" role="group">
          <div className="analysis-task-filter-tabs">
            {PERIODS.filter(([days]) => days <= 1 || keep === undefined || keep === null || days <= keep).map(([days, label]) => (
              <button
                aria-pressed={'days' in filter.period && filter.period.days === days}
                className={`analysis-task-filter-button ${'days' in filter.period && filter.period.days === days ? 'active' : ''}`}
                key={days}
                onClick={() => setPeriod({ days })}
                type="button"
              >
                {label}
              </button>
            ))}
            <button
              aria-pressed={custom}
              className={`analysis-task-filter-button ${custom ? 'active' : ''}`}
              onClick={() => !custom && setPeriod({ start: daysAgo(27), end: localDate() })}
              type="button"
            >
              from… to…
            </button>
          </div>
          {!('days' in filter.period) ? (
            <span className="usage-dates">
              <input
                aria-label="first day"
                className="users-control"
                max={filter.period.end}
                onChange={(event) => event.target.value && setPeriod({ start: event.target.value, end: (filter.period as { end: string }).end })}
                type="date"
                value={filter.period.start}
              />
              <span>to</span>
              <input
                aria-label="last day"
                className="users-control"
                max={localDate()}
                min={filter.period.start}
                onChange={(event) => event.target.value && setPeriod({ start: (filter.period as { start: string }).start, end: event.target.value })}
                type="date"
                value={filter.period.end}
              />
            </span>
          ) : null}
        </div>
      ) : null}
      <label className="usage-filter-group usage-class">
        <span className="pathway-control-label">class</span>
        <select className="users-control usage-class-select" onChange={(event) => onChange({ ...filter, tag: event.target.value })} value={filter.tag}>
          <option value="">every account</option>
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
      </label>
      {children}
    </div>
  );
}
