import { useId, useState, type ReactNode } from 'react';
import { useElementWidth } from '../analysis/useElementWidth';

/** Two greys, checked against the administrators' page with the dataviz validator (ordinal, light end above 2:1). */
export const LIGHT_GREY = '#a6a6a6';
export const DARK_GREY = '#3f3f3f';

export interface ChartSeries {
  key: string;
  label: string;
  colour: string;
}

export interface ChartColumn {
  key: string;
  /** In the tooltip and the table. */
  label: string;
  /** Under the column; empty for columns between labels. */
  tick: string;
  values: Record<string, number>;
}

/** A round step for the value axis: 1, 2 or 5 times a power of ten, about four steps to the top. */
export function niceStep(max: number): number {
  const rough = Math.max(1, max / 4);
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((factor) => factor * power).find((step) => step >= rough) ?? 10 * power;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function toCsv(rows: Array<Array<string | number | boolean | null>>): string {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => {
            const text = cell === null ? '' : String(cell);
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          })
          .join(','),
      )
      .join('\n') + '\n'
  );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="usage-stat">
      <span className="usage-stat-label">{label}</span>
      <span className="usage-stat-value">{value}</span>
      {note ? <span className="usage-stat-note">{note}</span> : null}
    </div>
  );
}

/**
 * Columns with a tooltip on each and a table view. `nested`: every series grows from the baseline, the later ones
 * drawn inside the earlier (for a part of a whole, such as people making changes among people in the app).
 * `stacked`: the series sit on one another, with a 2px gap of the surface between them.
 */
export function ColumnChart({
  columns,
  format = (value) => value.toLocaleString(),
  height = 170,
  mode,
  series,
  title,
}: {
  columns: ChartColumn[];
  format?: (value: number) => string;
  /** Of the plot with its axis, in pixels. */
  height?: number;
  mode: 'nested' | 'stacked';
  series: ChartSeries[];
  title: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  const [frameRef, measured] = useElementWidth<HTMLDivElement>();
  const width = Math.max(280, measured);
  const top = 10;
  const bottom = 22;
  const left = 56;
  const plot = height - top - bottom;
  const columnTop = (column: ChartColumn) =>
    mode === 'stacked'
      ? series.reduce((sum, entry) => sum + (column.values[entry.key] ?? 0), 0)
      : Math.max(0, ...series.map((entry) => column.values[entry.key] ?? 0));
  const max = Math.max(1, ...columns.map(columnTop));
  const step = niceStep(max);
  const scaleTop = Math.ceil(max / step) * step;
  // a short chart gets fewer gridlines: the top and the middle
  const every = height < 140 && scaleTop / step > 2 ? Math.ceil(scaleTop / step / 2) : 1;
  const ticks = Array.from({ length: scaleTop / step + 1 }, (_, index) => index * step).filter((_, index, all) => index % every === 0 || index === all.length - 1);
  const band = (width - left) / Math.max(1, columns.length);
  const barWidth = Math.min(24, band - 2);
  const y = (value: number) => top + plot - (value / scaleTop) * plot;
  // Labels under the columns that would run into the one before are left out (about 6px a character).
  const labelled = new Set<number>();
  let lastLabel = -Infinity;
  columns.forEach((column, index) => {
    if (!column.tick) return;
    const centre = left + (index + 0.5) * band;
    const room = column.tick.length * 6 + 8;
    if (centre - lastLabel >= room) {
      labelled.add(index);
      lastLabel = centre;
    }
  });

  /** A column part from `from` to `to` (values); rounded at the top only when it is the column's top. */
  function part(x: number, from: number, to: number, rounded: boolean, colour: string, key: string) {
    if (to <= from) return null;
    const y0 = y(from);
    const y1 = y(to);
    const h = Math.max(1, y0 - y1);
    const r = rounded ? Math.min(4, h, barWidth / 2) : 0;
    const d = `M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + barWidth - r} Q${x + barWidth},${y0 - h} ${x + barWidth},${y0 - h + r} V${y0} Z`;
    return <path d={d} fill={colour} key={key} />;
  }

  function parts(column: ChartColumn, x: number) {
    if (mode === 'nested') {
      return series.map((entry) => part(x, 0, column.values[entry.key] ?? 0, true, entry.colour, entry.key));
    }
    const gap = (2 / plot) * scaleTop; // 2px of surface between stacked parts
    let base = 0;
    const shown = series.filter((entry) => (column.values[entry.key] ?? 0) > 0);
    return shown.map((entry, index) => {
      const value = column.values[entry.key] ?? 0;
      const from = base + (index ? gap : 0);
      base += value;
      return part(x, from, Math.max(from, base), index === shown.length - 1, entry.colour, entry.key);
    });
  }

  const describe = (column: ChartColumn) =>
    series.map((entry) => `${format(column.values[entry.key] ?? 0)} ${entry.label}`).join(', ');
  const shown = hovered === null ? null : columns[hovered];
  return (
    <figure className="usage-chart">
      <figcaption className="usage-chart-head">
        <span id={titleId}>{title}</span>
        <span className="usage-legend">
          {series.map((entry) => (
            <span key={entry.key}>
              <i style={{ background: entry.colour }} /> {entry.label}
            </span>
          ))}
          <button className="analysis-task-link subtle" onClick={() => setAsTable((value) => !value)} type="button">
            {asTable ? 'as a chart' : 'as a table'}
          </button>
        </span>
      </figcaption>
      {asTable ? (
        <table className="usage-table usage-table-compact">
          <thead>
            <tr>
              <th />
              {series.map((entry) => (
                <th key={entry.key}>{entry.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.key}>
                <td>{column.label}</td>
                {series.map((entry) => (
                  <td key={entry.key}>{format(column.values[entry.key] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="usage-chart-frame" ref={frameRef}>
          <svg aria-labelledby={titleId} className="usage-chart-svg" height={height} role="img" width={width}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="usage-grid" x1={left} x2={width} y1={y(tick)} y2={y(tick)} />
                <text className="usage-axis" textAnchor="end" x={left - 6} y={y(tick) + 3}>
                  {format(tick)}
                </text>
              </g>
            ))}
            {columns.map((column, index) => {
              const x = left + index * band + (band - barWidth) / 2;
              return (
                <g
                  aria-label={`${column.label}: ${describe(column)}`}
                  className={`usage-column ${hovered === index ? 'is-hovered' : ''}`}
                  key={column.key}
                  onBlur={() => setHovered(null)}
                  onFocus={() => setHovered(index)}
                  onPointerEnter={() => setHovered(index)}
                  onPointerLeave={() => setHovered((current) => (current === index ? null : current))}
                  role="img"
                  tabIndex={0}
                >
                  <rect className="usage-hit" height={plot + top} width={band} x={left + index * band} y={0} />
                  {parts(column, x)}
                  {column.tick && labelled.has(index) ? (
                    <text className="usage-axis" textAnchor="middle" x={x + barWidth / 2} y={height - 6}>
                      {column.tick}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {shown && hovered !== null ? (
            <div
              className="usage-tooltip"
              style={{ left: `${Math.min(88, Math.max(12, ((left + (hovered + 0.5) * band) / width) * 100))}%` }}
            >
              <span>
                {series.map((entry, index) => (
                  <span key={entry.key}>
                    {index ? ', ' : ''}
                    <strong>{format(shown.values[entry.key] ?? 0)}</strong> {entry.label}
                  </span>
                ))}
              </span>
              <span className="usage-tooltip-label">{shown.label}</span>
            </div>
          ) : null}
        </div>
      )}
    </figure>
  );
}
