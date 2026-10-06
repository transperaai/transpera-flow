"use client";

// One series of the compare view (B7, issue #36): plan A (solid, accent) and plan B (dashed, edit colour) month by month,
// each with its 10-90% band, an optional reference line (the "Too busy" line), a tooltip with both values and the
// difference, and the same numbers as a table for a screen reader. Drawn by hand in SVG from the theme's tokens, as the
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

export interface PlanCompareChartProps {
  title: string;
  months: TimelineMonth[];
  a: (Stat | null)[];
  b: (Stat | null)[];
  nameA: string;
  nameB: string;
  /** How a value reads: "£48.2K", "3.4", "92%". */
  format: (v: number) => string;
  /** How a difference reads, signed: "+£1.2K". */
  formatDiff: (v: number) => string;
  /** A dashed line at this value, named: the "Too busy" line. */
  reference?: { value: number; label: string };
  /** Smallest top of the scale (a busy share never draws flatter than the line). */
  minTop?: number;
}

export function PlanCompareChart({ title, months, a, b, nameA, nameB, format, formatDiff, reference, minTop = 0 }: PlanCompareChartProps) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const width = measured || 560;
  const compact = width < 480;
  const m = { l: compact ? 50 : 60, r: compact ? 12 : 16, t: 12, b: 28 };
  const n = months.length;
  const all = [...a, ...b].filter((s): s is Stat => s !== null);
  const lo = Math.min(0, ...all.map((s) => s.p10));
  const hi = Math.max(minTop, reference?.value ?? 0, ...all.map((s) => s.p90), 0.0001);
  const ticks = niceTicks(lo, hi * 1.05, 3);
  const y0 = ticks[0]!;
  const y1 = ticks[ticks.length - 1]!;
  const x = (i: number) => m.l + (n > 1 ? (i / (n - 1)) * (width - m.l - m.r) : 0);
  const y = (v: number) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (HEIGHT - m.t - m.b);
  const line = (series: (Stat | null)[]) => {
    let d = "";
    let pen = false;
    series.forEach((s, i) => {
      if (!s) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(s.mean).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const band = (series: (Stat | null)[]) => {
    const runs: number[][] = [];
    series.forEach((s, i) => {
      if (!s) return;
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i);
      else runs.push([i]);
    });
    return runs
      .map((run) => {
        const pts = run.length === 1 ? [run[0]! - 0.25, run[0]! + 0.25].map((p) => ({ px: x(p), s: series[run[0]!]! })) : run.map((i) => ({ px: x(i), s: series[i]! }));
        const up = pts.map((p, k) => `${k ? "L" : "M"}${p.px.toFixed(1)},${y(p.s.p90).toFixed(1)}`).join("");
        const down = [...pts].reverse().map((p) => `L${p.px.toFixed(1)},${y(p.s.p10).toFixed(1)}`).join("");
        return `${up}${down}Z`;
      })
      .join("");
  };
  const labelled = new Set(labelIndexes(n, Math.max(2, Math.floor((width - m.l - m.r) / 56) + 1)));
  const lastA = [...a].reverse().find((s) => s) ?? null;
  const lastB = [...b].reverse().find((s) => s) ?? null;
  const summary = `${title}: ${nameA} ${lastA ? format(lastA.mean) : "no value"} and ${nameB} ${lastB ? format(lastB.mean) : "no value"} in ${months[n - 1]?.long ?? "the last month"}.`;
  const pointerMove = (clientX: number, left: number) => {
    const px = clientX - left;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  };
  const shown = hover !== null ? months[hover] : null;
  const sa = hover !== null ? a[hover] : null;
  const sb = hover !== null ? b[hover] : null;

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
        <path d={band(b)} fill="var(--edit)" fillOpacity={0.12} data-band="b" />
        <path d={band(a)} fill="var(--accent)" fillOpacity={0.18} data-band="a" />
        <path d={line(b)} fill="none" stroke="var(--edit)" strokeWidth={2.25} strokeDasharray="6 3" strokeLinejoin="round" strokeLinecap="round" data-line="b" />
        <path d={line(a)} fill="none" stroke="var(--accent)" strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" data-line="a" />
        {hover !== null ? (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={HEIGHT - m.b} stroke="var(--fg-3)" strokeDasharray="3 3" />
            {sa ? <circle cx={x(hover)} cy={y(sa.mean)} r={4} fill="var(--accent)" stroke="var(--panel)" strokeWidth={2} /> : null}
            {sb ? <circle cx={x(hover)} cy={y(sb.mean)} r={4} fill="var(--edit)" stroke="var(--panel)" strokeWidth={2} /> : null}
          </g>
        ) : null}
      </svg>
      {shown && hover !== null ? (
        <div
          role="presentation"
          className="pointer-events-none absolute top-1 z-10 w-max max-w-56 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: Math.min(Math.max(x(hover) - 80, 0), Math.max(0, width - 200)) }}
        >
          <p className="font-medium">{shown.long}</p>
          <p className="tabular-nums">
            {nameA}: {sa ? format(sa.mean) : "—"}
          </p>
          <p className="tabular-nums">
            {nameB}: {sb ? format(sb.mean) : "—"}
          </p>
          {sa && sb ? <p className="text-muted-foreground tabular-nums">Difference: {formatDiff(sb.mean - sa.mean)}</p> : null}
        </div>
      ) : null}
      <table className="sr-only">
        <caption>{title}, average and 10 to 90 percent range, for each plan</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">{nameA}</th>
            <th scope="col">{nameB}</th>
            <th scope="col">Difference</th>
          </tr>
        </thead>
        <tbody>
          {months.map((mo, i) => (
            <tr key={mo.index}>
              <th scope="row">{mo.long}</th>
              <td>{a[i] ? `${format(a[i]!.mean)} (${format(a[i]!.p10)} to ${format(a[i]!.p90)})` : "not there"}</td>
              <td>{b[i] ? `${format(b[i]!.mean)} (${format(b[i]!.p10)} to ${format(b[i]!.p90)})` : "not there"}</td>
              <td>{a[i] && b[i] ? formatDiff(b[i]!.mean - a[i]!.mean) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
