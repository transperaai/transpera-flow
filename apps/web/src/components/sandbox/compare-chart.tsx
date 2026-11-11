"use client";

// One measure of the compare view (docs/plans/sandbox-p1-brief.md §4): up to four series ("No changes", then the scenarios, each its
// own colour and dash) month by month, each with its 10-90% band, an optional reference line (the "Too busy" line), a tooltip with every value and the
// difference from the first, and the same numbers as a table for a screen reader. Drawn by hand in SVG from the theme's tokens, as the
// timeline is, and sized from its container so it works at phone width.

import { useState } from "react";
import type { Stat } from "@transpera-flow/engine";
import { FloatingTip } from "@/components/ui/floating-tip";
import { labelIndexes, niceTicks } from "@/lib/overview/axis";
import type { TimelineMonth } from "@/lib/forecast/timeline";
import { BASELINE_COLOUR, BASELINE_DASH, CATEGORICAL } from "@/lib/chart-colours";
import { useElementWidth } from "@/lib/use-element-width";

const HEIGHT = 190;


/**
 * How each column is drawn, in order (lib/chart-colours.ts): "No changes" is today's path, the baseline neutral, dashed; the scenarios take
 * the categorical slots 1, 2 and 3, solid. The legend uses the same.
 */
export const SERIES_STYLES = [
  { color: BASELINE_COLOUR, dash: BASELINE_DASH as string | undefined, swatch: "h-0! rounded-none! border-t-2 border-dashed border-series-baseline" },
  { color: CATEGORICAL[0], dash: undefined, swatch: "bg-cat-1" },
  { color: CATEGORICAL[1], dash: undefined, swatch: "bg-cat-2" },
  { color: CATEGORICAL[2], dash: undefined, swatch: "bg-cat-3" },
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
  /** Column 0 is "No changes" (today's path, the dashed baseline). False: the columns are plain series, slot 1 first (a forecast's one line). */
  firstIsBaseline?: boolean;
  /** Draw at this width instead of measuring the container (the print summary is hidden on screen, so has nothing to measure); it still shrinks to fit. */
  fixedWidth?: number;
}

export function CompareChart({ title, months, series, format, formatDiff = (v) => format(v), reference, minTop = 0, fixedWidth, firstIsBaseline = true }: CompareChartProps) {
  const style = (k: number) => SERIES_STYLES[firstIsBaseline ? k : k + 1] ?? SERIES_STYLES[SERIES_STYLES.length - 1];
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [tipAt, setTipAt] = useState<{ x: number; y: number } | null>(null);
  const width = fixedWidth ?? (measured || 560);
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
        width={fixedWidth ? undefined : width}
        height={fixedWidth ? undefined : HEIGHT}
        {...(fixedWidth ? { viewBox: `0 0 ${width} ${HEIGHT}`, style: { width: "100%", height: "auto" } } : {})}
        role="img"
        aria-label={summary}
        className="block overflow-visible"
        onPointerMove={(e) => {
          pointerMove(e.clientX, e.currentTarget.getBoundingClientRect().left);
          setTipAt({ x: e.clientX, y: e.clientY });
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="fill-fg-3 text-2xs tabular-nums">
              {format(t)}
            </text>
          </g>
        ))}
        {months.map((mo, i) =>
          labelled.has(i) ? (
            <text key={mo.index} x={x(i)} y={HEIGHT - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-fg-3 text-2xs">
              {mo.short}
              {mo.partial ? "*" : ""}
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
          <path key={`band-${k}`} d={band(s.values)} fill={style(k).color} fillOpacity={0.12} data-band={k} />
        ))}
        {[...series].map((s, k) => ({ s, k })).reverse().map(({ s, k }) => (
          <path key={`line-${k}`} d={line(s.values)} fill="none" stroke={style(k).color} strokeWidth={2.25} strokeDasharray={style(k).dash} strokeLinejoin="round" strokeLinecap="round" data-line={k} />
        ))}
        {hover !== null ? (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={HEIGHT - m.b} stroke="var(--fg-3)" strokeDasharray="3 3" />
            {series.map((s, k) => (s.values[hover] ? <circle key={k} cx={x(hover)} cy={y(s.values[hover]!.mean)} r={4} fill={style(k).color} stroke="var(--panel)" strokeWidth={2} /> : null))}
          </g>
        ) : null}
      </svg>
      <FloatingTip at={shown ? tipAt : null} placement="side">
        {shown && hover !== null ? (
          <>
          <p className="font-medium">{shown.label}</p>
        {shown.partial ? <p className="text-muted-foreground">Part month</p> : null}
        {series.map((s, k) => (
          <p key={k} className="tabular-nums">
            {s.name}: {s.values[hover] ? format(s.values[hover]!.mean) : "—"}
            {k > 0 && base && s.values[hover] ? <span className="text-muted-foreground"> ({formatDiff(s.values[hover]!.mean - base.mean)})</span> : null}
          </p>
        ))}
          </>
        ) : null}
      </FloatingTip>
      <div className="sr-only">
        <table>
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
                <th scope="row">{mo.label}</th>
                {series.map((s, k) => (
                  <td key={k}>{s.values[i] ? `${format(s.values[i]!.mean)} (${format(s.values[i]!.p10)} to ${format(s.values[i]!.p90)})` : "not there"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
