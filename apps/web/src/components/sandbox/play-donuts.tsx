"use client";

// "Where the time goes" in the Sandbox (D54): two donuts, Today and This scene, of the team's hours a month by purpose (the workspace's purposes in its
// order and colours, the same order in both), and beside them the purposes that moved most. Plain SVG from the theme's tokens, with a table for a
// screen reader.

import { useState } from "react";
import { FloatingTip } from "@/components/ui/floating-tip";
import { purposeColor } from "@/components/sandbox/time-chart";
import { formatNumber, formatPercent } from "@/lib/format";
import { signedHours, type PurposeMove, type PurposeSlice } from "@/lib/sandbox/play-results-data";

const R = 46;
const STROKE = 20;
const C = 2 * Math.PI * R;

export function Donut({ title, slices, order }: { title: string; slices: PurposeSlice[]; order: readonly string[] }) {
  const [tip, setTip] = useState<{ s: PurposeSlice; at: { x: number; y: number } } | null>(null);
  const sorted = order.map((id) => slices.find((s) => s.id === id)).filter((s): s is PurposeSlice => !!s && s.hours > 0);
  const total = sorted.reduce((a, s) => a + s.hours, 0);
  const starts = sorted.map((_, i) => (sorted.slice(0, i).reduce((a, s) => a + s.hours, 0) / (total || 1)) * C);
  return (
    <figure className="m-0 flex min-w-0 flex-col items-center gap-1" data-play-donut={title}>
      <svg viewBox="0 0 120 120" role="img" aria-label={`${title}: ${sorted.map((s) => `${s.name} ${formatNumber(s.hours, 0)} hours a month`).join(", ")}`} className="h-auto w-full max-w-40" onPointerLeave={() => setTip(null)}>
        <g transform="rotate(-90 60 60)">
          {total === 0 && <circle cx={60} cy={60} r={R} fill="none" stroke="var(--panel-2)" strokeWidth={STROKE} />}
          {sorted.map((s, i) => {
            const len = (s.hours / total) * C;
            const gap = sorted.length > 1 ? Math.min(2, len / 2) : 0;
            return (
              <circle
                key={s.id}
                data-donut-slice={s.id}
                cx={60}
                cy={60}
                r={R}
                fill="none"
                stroke={purposeColor(s.id)}
                strokeWidth={STROKE}
                strokeDasharray={`${Math.max(0, len - gap)} ${C - Math.max(0, len - gap)}`}
                strokeDashoffset={-starts[i]!}
                onPointerMove={(e) => setTip({ s, at: { x: e.clientX, y: e.clientY } })}
                onPointerDown={(e) => setTip({ s, at: { x: e.clientX, y: e.clientY } })}
              />
            );
          })}
        </g>
        <text x={60} y={58} textAnchor="middle" className="fill-foreground text-[15px] font-semibold">
          {formatNumber(total, 0)}
        </text>
        <text x={60} y={72} textAnchor="middle" className="fill-muted-foreground text-[8px]">
          hours a month
        </text>
      </svg>
      <figcaption className="text-sm font-medium">{title}</figcaption>
      {tip && (
        <FloatingTip at={tip.at} placement="side">
          <div data-play-tip className="flex flex-col gap-0.5">
            <div className="font-semibold">{title}</div>
            <div className="flex items-center gap-1.5">
              <i aria-hidden className="inline-block size-2 rounded-sm" style={{ background: purposeColor(tip.s.id) }} />
              {tip.s.name}
            </div>
            <div>
              <b className="font-semibold">{formatNumber(tip.s.hours, 0)} h</b> a month ({formatPercent(total > 0 ? tip.s.hours / total : 0)})
            </div>
          </div>
        </FloatingTip>
      )}
      <table className="sr-only">
        <caption>{title}: hours a month by purpose</caption>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.id}>
              <th scope="row">{s.name}</th>
              <td>{formatNumber(s.hours, 0)} h</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function PurposeLegend({ slices }: { slices: PurposeSlice[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-legend data-time-legend>
      {slices.map((s) => (
        <li key={s.id} className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: purposeColor(s.id) }} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

/** "Fixing −40 h · Coordination −12 h", or "The same as today." */
export function MovedLine({ moves }: { moves: PurposeMove[] }) {
  if (!moves.length)
    return (
      <p className="text-sm text-muted-foreground" data-purpose-moves>
        The same as today.
      </p>
    );
  return (
    <div className="flex flex-col gap-1" data-purpose-moves>
      <p className="text-xs text-muted-foreground">Moved most, hours a month</p>
      <p className="text-sm font-medium">
        {moves.map((m, i) => (
          <span key={m.id}>
            {i > 0 && <span className="text-muted-foreground"> · </span>}
            {m.name} <span className="tabular-nums">{signedHours(m.delta)}</span>
          </span>
        ))}
      </p>
    </div>
  );
}
