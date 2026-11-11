"use client";

// One of the free-play Sandbox's charts (capacity build P7; the prototype's `lineChart`): a few lines month by month, today's path dashed in
// the colour of the line it is the path of, an optional goal line, and a legend with an entry for today's path. Drawn by hand in SVG from the theme's
// tokens (so light and dark follow), drawn at the width of its container (the shared `useElementWidth`) so its text stays at its real size in a
// grid column or on a phone, with the same numbers as a table for a screen reader.

import { useState, type ReactNode } from "react";
import { FloatingTip } from "@/components/ui/floating-tip";
import { labelIndexes, niceTicks } from "@/lib/overview/axis";
import { BASELINE_COLOUR, BASELINE_DASH, CATEGORICAL } from "@/lib/chart-colours";
import { useElementWidth } from "@/lib/use-element-width";

/** The series colours of every Sandbox chart, in order: the categorical slots (lib/chart-colours.ts). A single line (MRR) is slot 1. */
export const PLAY_SERIES_COLORS = CATEGORICAL;

export interface PlayChartSeries {
  name: string;
  values: (number | null)[];
  /** A CSS colour or token: "var(--cat-1)". */
  color: string;
  /** Today's path: thin, dashed and in the baseline neutral, whatever `color` says. */
  dashed?: boolean;
  /** Leave out of the legend (a dashed line shares its name with the line it is the path of). */
  hideFromLegend?: boolean;
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
  /** A taller drawing (a chart on a row of its own). The width always follows the container. */
  tall?: boolean;
  /** Extra lines under a month's values in the tooltip (clients won and lost). */
  tipExtra?: (month: number) => ReactNode;
}

export function PlayChart({ title, months, series, format, goal, min, todayLabel = "Today's path", tall = false, tipExtra }: PlayChartProps) {
  const [ref, measured] = useElementWidth<HTMLElement>();
  const W = Math.max(240, measured || 520);
  const compact = W < 420;
  const H = tall ? 280 : compact ? 200 : 220;
  const M = { l: compact ? 50 : 60, r: compact ? 10 : 14, t: 14, b: 28 };
  const [tip, setTip] = useState<{ i: number; at: { x: number; y: number } } | null>(null);
  const n = months.length;
  const values = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const extra = [goal?.value].filter((v): v is number => v !== undefined);
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
  // As many month labels as fit about 56px apart: every month of a year on a wide chart, fewer in a grid column or on a phone.
  const label = labelIndexes(n, Math.max(2, Math.min(n, Math.floor((W - M.l - M.r) / 56) + 1)));
  const nearest = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - M.l) / (W - M.l - M.r || 1)) * (n - 1));
    setTip({ i: Math.max(0, Math.min(n - 1, i)), at: { x: e.clientX, y: e.clientY } });
  };
  const today = (name: string) => series.find((s) => s.dashed && s.name === name);
  return (
    <figure ref={ref} className="m-0 flex min-w-0 flex-col gap-2" data-play-chart={title}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`${title}, month by month`}
        className="h-auto max-w-full touch-pan-y overflow-visible text-2xs"
        onPointerMove={nearest}
        onPointerDown={nearest}
        onPointerLeave={() => setTip(null)}
      >
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
            <line x1={M.l} x2={W - M.r} y1={y(goal.value)} y2={y(goal.value)} stroke="var(--fg-2)" strokeWidth={1} data-goal-line />
            <text x={W - M.r} y={y(goal.value) - 4} textAnchor="end" className="fill-fg-2">
              {goal.label}
            </text>
          </g>
        )}
        {label.map((i) => (
          <text key={i} x={x(i)} y={H - 7} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-muted-foreground">
            {months[i]}
          </text>
        ))}
        {tip && <line x1={x(tip.i)} x2={x(tip.i)} y1={M.t} y2={H - M.b} stroke="var(--fg-3)" strokeWidth={1} data-crosshair />}
        {series.map((s, i) => (
          <g key={i}>
            <path d={path(s.values)} fill="none" stroke={s.dashed ? BASELINE_COLOUR : s.color} strokeWidth={s.dashed ? 1.75 : 2.5} {...(s.dashed ? { strokeDasharray: BASELINE_DASH } : {})} data-line={s.dashed ? "today" : "changed"} data-series={s.name} />
            {!s.dashed && s.values[n - 1] != null && <circle cx={x(n - 1)} cy={y(s.values[n - 1]!)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />}
          </g>
        ))}
      </svg>
      {tip && (
        <FloatingTip at={tip.at} placement="side" className="min-w-40">
          <div data-play-tip className="flex flex-col gap-1">
            <div className="font-semibold">{months[tip.i]}</div>
            {series
              .filter((s) => !s.dashed)
              .map((s) => {
                const v = s.values[tip.i];
                const was = today(s.name)?.values[tip.i];
                return (
                  <div key={s.name} className="flex items-center justify-between gap-4 tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <i aria-hidden className="inline-block size-2 rounded-full" style={{ background: s.color }} />
                      {s.name}
                    </span>
                    <span>
                      <b className="font-semibold">{v == null ? "n/a" : format(v)}</b>
                      {was != null && <span className="text-muted-foreground"> (today {format(was)})</span>}
                    </span>
                  </div>
                );
              })}
            {tipExtra?.(tip.i)}
          </div>
        </FloatingTip>
      )}
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-legend>
        {legend.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block h-0.5 w-4 rounded-full" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        {hasToday && (
          <span className="inline-flex items-center gap-1.5" data-legend-today>
            <i aria-hidden className="inline-block h-0 w-4 border-t-2 border-dashed border-series-baseline" />
            {todayLabel}
          </span>
        )}
      </figcaption>
      <div className="sr-only">
        <table>
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
      </div>
    </figure>
  );
}
