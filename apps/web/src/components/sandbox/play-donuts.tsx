"use client";

// "Where the time goes" in the Sandbox (D54; QA round 2, option C1): a stacked bar each for Today and This scene, of the team's hours a month by purpose
// (the workspace's purposes in its order and colours, the same order in both), the total hours under them, and the purposes that moved most. Plain
// HTML from the theme's tokens, with a table for a screen reader.

import { useState } from "react";
import { FloatingTip } from "@/components/ui/floating-tip";
import { purposeColor } from "@/components/sandbox/time-chart";
import { labelOn } from "@/lib/chart-colours";
import { formatNumber, formatPercent } from "@/lib/format";
import { signedHours, type PurposeMove, type PurposeSlice } from "@/lib/sandbox/play-results-data";
import { cn } from "@/lib/utils";

/** One run's hours a month by purpose as a bar of 100%: each purpose's share, labelled inside when it is wide enough. */
export function PurposeBar({ title, slices, order, strong = false }: { title: string; slices: PurposeSlice[]; order: readonly string[]; strong?: boolean }) {
  const [tip, setTip] = useState<{ s: PurposeSlice; at: { x: number; y: number } } | null>(null);
  const sorted = order.map((id) => slices.find((s) => s.id === id)).filter((s): s is PurposeSlice => !!s && s.hours > 0);
  const total = sorted.reduce((a, s) => a + s.hours, 0);
  const keys = slices.map((s) => s.id);
  return (
    <figure className="m-0 grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2" data-play-purpose-bar={title}>
      <figcaption className={cn("text-xs", strong ? "font-semibold" : "text-muted-foreground")}>{title}</figcaption>
      <div
        role="img"
        aria-label={`${title}: ${sorted.map((s) => `${s.name} ${formatNumber(s.hours, 0)} hours a month (${formatPercent(s.hours / (total || 1))})`).join(", ")}`}
        className="flex h-7 min-w-0 overflow-hidden rounded-md bg-panel-2"
        onPointerLeave={() => setTip(null)}
      >
        {sorted.map((s) => {
          const share = s.hours / (total || 1);
          const fill = purposeColor(s.id, keys);
          return (
            <span
              key={s.id}
              data-purpose-segment={s.id}
              className="flex min-w-0 items-center justify-center overflow-hidden border-r-2 border-panel text-2xs font-semibold tabular-nums last:border-r-0"
              style={{ width: `${share * 100}%`, background: fill, color: labelOn(fill) }}
              onPointerMove={(e) => setTip({ s, at: { x: e.clientX, y: e.clientY } })}
              onPointerDown={(e) => setTip({ s, at: { x: e.clientX, y: e.clientY } })}
            >
              {share >= 0.09 ? `${Math.round(share * 100)}%` : ""}
            </span>
          );
        })}
      </div>
      {tip && (
        <FloatingTip at={tip.at} placement="side">
          <div data-play-tip className="flex flex-col gap-0.5">
            <div className="font-semibold">{tip.s.name}</div>
            <div className="text-muted-foreground">{title}</div>
            <div>
              <b className="font-semibold">{formatNumber(tip.s.hours, 0)} h</b> a month, {formatPercent(tip.s.hours / (total || 1))}
            </div>
          </div>
        </FloatingTip>
      )}
      <div className="sr-only">
        <table>
          <caption>{title}: hours a month by purpose</caption>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id}>
                <th scope="row">{s.name}</th>
                <td>{formatNumber(s.hours, 0)} hours a month</td>
                <td>{formatPercent(s.hours / (total || 1))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

export function PurposeLegend({ slices }: { slices: PurposeSlice[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-legend data-time-legend>
      {slices.map((s) => (
        <li key={s.id} className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: purposeColor(s.id, slices.map((x) => x.id)) }} />
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
