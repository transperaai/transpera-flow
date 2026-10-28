"use client";

// One measure of the compare view (docs/plans/sandbox-p1-brief.md §4): up to four series ("No changes", then the scenarios, each its
// own colour and dash) month by month, each with its 10-90% band, an optional reference line (the "Too busy" line), a tooltip with every value and the
// difference from the first, and the same numbers as a table for a screen reader. Drawn by hand in SVG from the theme's tokens, as the
// timeline is, and sized from its container so it works at phone width.

import { useEffect, useRef, useState } from "react";
import type { Stat } from "@transpera-flow/engine";
import { labelIndexes, niceTicks } from "@/lib/overview/axis";
import type { TimelineMonth } from "@/lib/forecast/timeline";

const HEIGHT = 190;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** How each column is drawn, in order: "No changes" first. The legend uses the same. */
export const SERIES_STYLES = [
  { color: "var(--accent)", dash: undefined, swatch: "bg-accent" },
  { color: "var(--edit)", dash: "6 3", swatch: "bg-edit" },
  { color: "var(--chart-3)", dash: "2 3", swatch: "bg-chart-3" },
  { color: "var(--chart-4)", dash: "8 3 2 3", swatch: "bg-chart-4" },
] as const;

export interface CompareSeries {
  name: string;
  values: (Stat | null)[];
}

export interface CompareChartProps {
  title: string;
  months: TimelineMonth[];
  /** Column 0 is "No changes"; differences are against it. */
  series: CompareSeries[];
  /** How a value reads: "£48.2K", "3.4", "92%". */
  format: (v: number) => string;
  /** How a difference reads, signed: "+£1.2K". Not needed for one series. */
  formatDiff?: (v: number) => string;
  /** A dashed line at this value, named: the "Too busy" line. */
  reference?: { value: number; label: string };
  /** Smallest top of the scale (a busy share never draws flatter than the line). */
  minTop?: number;
}

export function CompareChart({ title, months, series, format, formatDiff = (v) => format(v), reference, minTop = 0 }: CompareChartProps) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const width = measured || 560;
  const compact = width < 480;
  const m = { l: compact ? 50 : 60, r: compact ? 12 : 16, t: 12, b: 28 };
  const n = months.length;
  const all = series.flatMap((s) => s.values).filter((s): s is Stat => s !== null);
  const lo = Math.min(0, ...all.map((s) => s.p10));
  const hi = Math.max(minTop, reference?.value ?? 0, ...all.map((s) => s.p90), 0.0001);
  const ticks = niceTicks(lo, hi * 1.05, 3);
  const y0 = ticks[0]!;
  const y1 = ticks[ticks.length - 1]!;
  const x = (i: number) => m.l + (n > 1 ? (i / (n - 1)) * (width - m.l - m.r) : 0);
  const y = (v: number) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (HEIGHT - m.t - m.b);
  const line = (values: (Stat | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((s, i) => {
      if (!s) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(s.mean).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const band = (values: (Stat | null)[]) => {
    const runs: number[][] = [];
    values.forEach((s, i) => {
      if (!s) return;
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i);
      else runs.push([i]);
    });
    return runs
      .map((run) => {
        const pts = run.length === 1 ? [run[0]! - 0.25, run[0]! + 0.25].map((p) => ({ px: x(p), s: values[run[0]!]! })) : run.map((i) => ({ px: x(i), s: values[i]! }));
        const up = pts.map((p, k) => `${k ? "L" : "M"}${p.px.toFixed(1)},${y(p.s.p90).toFixed(1)}`).join("");
        const down = [...pts].reverse().map((p) => `L${p.px.toFixed(1)},${y(p.s.p10).toFixed(1)}`).join("");
        return `${up}${down}Z`;
      })
      .join("");
  };
  const labelled = new Set(labelIndexes(n, Math.max(2, Math.floor((width - m.l - m.r) / 56) + 1)));
  const lastOf = (values: (Stat | null)[]) => [...values].reverse().find((s) => s) ?? null;
  const summary = `${title}: ${series.map((s) => `${s.name} ${lastOf(s.values) ? format(lastOf(s.values)!.mean) : "no value"}`).join(", ")} in ${months[n - 1]?.long ?? "the last month"}.`;
  const pointerMove = (clientX: number, left: number) => {
    const px = clientX - left;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  };
  const shown = hover !== null ? months[hover] : null;
  const base = hover !== null ? series[0]?.values[hover] : null;

  return (
    <div ref={ref} className="relative" data-compare-chart={title}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={summary}
        className="block overflow-visible"
        onPointerMove={(e) => pointerMove(e.clientX, e.currentTarget.getBoundingClientRect().left)}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="fill-fg-3 text-[11px] tabular-nums">
              {format(t)}
            </text>
          </g>
        ))}
        {months.map((mo, i) =>
          labelled.has(i) ? (
            <text key={mo.index} x={x(i)} y={HEIGHT - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-fg-3 text-[11px]">
              {mo.short}
            </text>
          ) : null,
        )}
        {reference ? (
          <g>
            <title>{reference.label}</title>
            <line x1={m.l} x2={width - m.r} y1={y(reference.value)} y2={y(reference.value)} stroke="var(--fg-3)" strokeDasharray="4 3" strokeWidth={1} />
          </g>
        ) : null}
        {[...series].map((s, k) => ({ s, k })).reverse().map(({ s, k }) => (
          <path key={`band-${k}`} d={band(s.values)} fill={SERIES_STYLES[k]!.color} fillOpacity={k === 0 ? 0.18 : 0.1} data-band={k} />
        ))}
        {[...series].map((s, k) => ({ s, k })).reverse().map(({ s, k }) => (
          <path key={`line-${k}`} d={line(s.values)} fill="none" stroke={SERIES_STYLES[k]!.color} strokeWidth={2.25} strokeDasharray={SERIES_STYLES[k]!.dash} strokeLinejoin="round" strokeLinecap="round" data-line={k} />
        ))}
        {hover !== null ? (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={HEIGHT - m.b} stroke="var(--fg-3)" strokeDasharray="3 3" />
            {series.map((s, k) => (s.values[hover] ? <circle key={k} cx={x(hover)} cy={y(s.values[hover]!.mean)} r={4} fill={SERIES_STYLES[k]!.color} stroke="var(--panel)" strokeWidth={2} /> : null))}
          </g>
        ) : null}
      </svg>
      {shown && hover !== null ? (
        <div
          role="presentation"
          className="pointer-events-none absolute top-1 z-10 w-max max-w-64 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: Math.min(Math.max(x(hover) - 80, 0), Math.max(0, width - 220)) }}
        >
          <p className="font-medium">{shown.long}</p>
          {series.map((s, k) => (
            <p key={k} className="tabular-nums">
              {s.name}: {s.values[hover] ? format(s.values[hover]!.mean) : "—"}
              {k > 0 && base && s.values[hover] ? <span className="text-muted-foreground"> ({formatDiff(s.values[hover]!.mean - base.mean)})</span> : null}
            </p>
          ))}
        </div>
      ) : null}
      <table className="sr-only">
        <caption>{title}, average and 10 to 90 percent range, for each column</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            {series.map((s, k) => (
              <th key={k} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((mo, i) => (
            <tr key={mo.index}>
              <th scope="row">{mo.long}</th>
              {series.map((s, k) => (
                <td key={k}>{s.values[i] ? `${format(s.values[i]!.mean)} (${format(s.values[i]!.p10)} to ${format(s.values[i]!.p90)})` : "not there"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
