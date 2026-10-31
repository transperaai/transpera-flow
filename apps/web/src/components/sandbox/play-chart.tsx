// One of the free-play Sandbox's four charts (capacity build P7; the prototype's `lineChart`): a few lines month by month, today's path dashed in
// the colour of the line it is the path of, an optional goal line, and a legend with an entry for today's path. Drawn by hand in SVG from the theme's
// tokens (so light and dark follow), sized by its viewBox so it fits a phone, with the same numbers as a table for a screen reader.

import { labelIndexes, niceTicks } from "@/lib/overview/axis";

export interface PlayChartSeries {
  name: string;
  values: (number | null)[];
  /** A CSS colour or token: "var(--chart-1)". */
  color: string;
  /** Today's path: thin and dashed. */
  dashed?: boolean;
  /** Leave out of the legend (a dashed line shares its name with the line it is the path of). */
  hideFromLegend?: boolean;
  /** A line of its own for this series (a team's "too busy" line), drawn faint in the series' colour. */
  line?: number;
}

export interface PlayChartProps {
  title: string;
  months: string[];
  series: PlayChartSeries[];
  format: (v: number) => string;
  /** A dashed line across the chart: DLER's goal. */
  goal?: { value: number; label: string };
  /** Start the scale at this value (a busy share starts at 0). */
  min?: number;
  /** Name for the dashed lines in the legend. */
  todayLabel?: string;
}

const W = 520;
const H = 230;
const M = { l: 62, r: 14, t: 14, b: 28 };

export function PlayChart({ title, months, series, format, goal, min, todayLabel = "Today's path" }: PlayChartProps) {
  const n = months.length;
  const values = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const extra = [goal?.value, ...series.map((s) => s.line)].filter((v): v is number => v !== undefined);
  const all = [...values, ...extra];
  let lo = min ?? Math.min(...all, 0);
  let hi = Math.max(...all, lo + 1e-6);
  if (min === undefined) {
    const pad = (hi - lo) * 0.08;
    lo = values.length ? Math.min(...values, ...extra) - pad : 0;
    hi += pad;
  }
  if (hi - lo < 1e-9) {
    hi += 1;
    lo -= 1;
  }
  const ticks = niceTicks(lo, hi, 3);
  const y0 = Math.min(lo, ticks[0]!);
  const y1 = Math.max(hi, ticks[ticks.length - 1]!);
  const x = (i: number) => M.l + (n > 1 ? (i / (n - 1)) * (W - M.l - M.r) : 0);
  const y = (v: number) => M.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - M.t - M.b);
  const path = (vs: (number | null)[]) => {
    let d = "";
    let pen = false;
    vs.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const hasToday = series.some((s) => s.dashed);
  const legend = series.filter((s) => !s.dashed && !s.hideFromLegend);
  const label = labelIndexes(n, 4);
  return (
    <figure className="m-0 flex flex-col gap-2" data-play-chart={title}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, month by month`} className="h-auto w-full overflow-visible text-[11px]">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
            <text x={M.l - 6} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground">
              {format(v)}
            </text>
          </g>
        ))}
        {goal && (
          <g>
            <line x1={M.l} x2={W - M.r} y1={y(goal.value)} y2={y(goal.value)} stroke="var(--crit)" strokeDasharray="4 4" />
            <text x={W - M.r} y={y(goal.value) - 4} textAnchor="end" style={{ fill: "var(--crit)" }}>
              {goal.label}
            </text>
          </g>
        )}
        {series.map((s, i) =>
          s.line === undefined ? null : <line key={`l${i}`} x1={M.l} x2={W - M.r} y1={y(s.line)} y2={y(s.line)} stroke={s.color} strokeOpacity={0.45} strokeDasharray="1 4" strokeWidth={1.5} data-team-line={s.name} />,
        )}
        {label.map((i) => (
          <text key={i} x={x(i)} y={H - 7} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-muted-foreground">
            {months[i]}
          </text>
        ))}
        {series.map((s, i) => (
          <g key={i}>
            <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.5 : 2.5} {...(s.dashed ? { strokeDasharray: "5 4", opacity: 0.7 } : {})} data-line={s.dashed ? "today" : "changed"} data-series={s.name} />
            {!s.dashed && s.values[n - 1] != null && <circle cx={x(n - 1)} cy={y(s.values[n - 1]!)} r={3.5} fill={s.color} />}
          </g>
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-legend>
        {legend.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block h-0.5 w-4 rounded-full" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        {hasToday && (
          <span className="inline-flex items-center gap-1.5" data-legend-today>
            <i aria-hidden className="inline-block h-0 w-4 border-t-2 border-dashed border-fg-3" />
            {todayLabel}
          </span>
        )}
      </figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            {series.map((s, i) => (
              <th scope="col" key={i}>
                {s.name}
                {s.dashed ? ` (${todayLabel.toLowerCase()})` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((m, i) => (
            <tr key={m + i}>
              <th scope="row">{m}</th>
              {series.map((s, j) => (
                <td key={j}>{s.values[i] == null ? "" : format(s.values[i]!)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
