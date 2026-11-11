"use client";

// "Who's overloaded, and when" (D54; QA round 2, option A1): a heatmap of every team by month, coloured by busy share against the team's utilisation
// threshold (the Capacity page's cut-offs: green under, amber within ten points, red at or over), with the worst month's column outlined. The card above
// it names that month. A This scene / Today switch picks which run it shows. Plain HTML grid and SVG from the theme's tokens, with the numbers as a table for a screen reader.

import { useState } from "react";
import { FloatingTip } from "@/components/ui/floating-tip";
import { formatPercent } from "@/lib/format";
import { busyTone, type BusyTone, type HeatRow } from "@/lib/sandbox/play-results-data";
import { cn } from "@/lib/utils";

/** The status tokens, as the Overview's team load draws the same cut-offs: a soft green, a soft amber ringed, solid red with its own text colour. */
const TINT: Record<BusyTone, string> = {
  ok: "var(--good-soft)",
  warn: "var(--warn-soft)",
  bad: "var(--crit)",
};
const CELL: Record<BusyTone, string> = { ok: "text-fg", warn: "text-fg ring-1 ring-inset ring-warn", bad: "text-crit-fg" };
const WORDS: Record<BusyTone, string> = { ok: "under the utilisation threshold", warn: "close to the utilisation threshold", bad: "over the utilisation threshold" };

export type HeatView = "scene" | "today";

export function Heatmap({ rows, months, view, worst = null }: { rows: HeatRow[]; months: string[]; view: HeatView; worst?: number | null }) {
  const [tip, setTip] = useState<{ row: HeatRow; m: number; at: { x: number; y: number } } | null>(null);
  const grid = { display: "grid", gridTemplateColumns: `minmax(4.5rem, 7.5rem) repeat(${months.length}, minmax(0, 1fr))` } as const;
  const at = (e: React.PointerEvent) => ({ x: e.clientX, y: e.clientY });
  return (
    <div className="min-w-0" data-play-heatmap data-heat-view={view}>
      <div role="table" aria-label="Busy share of every team, month by month" className="flex flex-col gap-0.5 text-xs">
        <div role="row" className="grid items-end gap-0.5 text-muted-foreground" style={grid}>
          <span role="columnheader" className="sr-only">
            Team
          </span>
          <span aria-hidden />
          {months.map((m, i) => (
            <span key={i} role="columnheader" data-worst-month={i === worst ? "" : undefined} className={cn("overflow-visible text-center text-2xs whitespace-nowrap", i % 3 !== 0 && i !== worst && "max-sm:invisible", i === worst && "font-bold text-fg")}>
              {m}
            </span>
          ))}
        </div>
        {rows.map((r) => (
          <div key={r.id} role="row" className="grid items-stretch gap-0.5" style={grid} data-heat-row={r.id}>
            <span role="rowheader" className="flex items-center truncate pr-1 font-medium" title={r.name}>
              <span className="truncate">{r.name}</span>
            </span>
            {r.busy.map((v, m) => {
              const tone = v === null ? null : busyTone(v, r.line);
              return (
                <span
                  key={m}
                  role="cell"
                  data-heat-cell={tone ?? "none"}
                  data-worst-month={m === worst ? "" : undefined}
                  className={cn("flex h-8 items-center justify-center rounded-[3px] text-2xs tabular-nums", tone ? CELL[tone] : "text-fg-3", m === worst && "outline-2 -outline-offset-1 outline-fg")}
                  style={{ background: tone ? TINT[tone] : "var(--panel-2)" }}
                  onPointerMove={(e) => setTip({ row: r, m, at: at(e) })}
                  onPointerDown={(e) => setTip({ row: r, m, at: at(e) })}
                  onPointerLeave={() => setTip(null)}
                >
                  {v === null ? <span className="sr-only">no one there</span> : <span className="max-md:sr-only">{Math.round(v * 100)}</span>}
                  {tone === "bad" && <i aria-hidden className="hidden size-1.5 rounded-full bg-crit-fg max-md:block" />}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-legend data-heat-legend>
        {(["ok", "warn", "bad"] as const).map((t) => (
          <li key={t} className="inline-flex items-center gap-1.5">
            <i aria-hidden className={cn("inline-block h-2.5 w-3.5 rounded-[3px]", t === "warn" && "ring-1 ring-inset ring-warn")} style={{ background: TINT[t] }} />
            {t === "ok" ? "Under the utilisation threshold" : t === "warn" ? "Within 10 points of it" : "At or over the utilisation threshold"}
          </li>
        ))}
      </ul>
      {tip && (
        <FloatingTip at={tip.at} placement="side">
          <div data-play-tip className="flex flex-col gap-0.5">
            <div className="font-semibold">{tip.row.name}</div>
            <div className="text-muted-foreground">{months[tip.m]}</div>
            {tip.row.busy[tip.m] == null ? (
              <div>Nobody there</div>
            ) : (
              <>
                <div>
                  <b className="font-semibold">{formatPercent(tip.row.busy[tip.m]!)}</b> busy, {WORDS[busyTone(tip.row.busy[tip.m]!, tip.row.line)]} ({formatPercent(tip.row.line)})
                </div>
                {tip.row.p90[tip.m] != null && <div className="text-muted-foreground">In 9 of 10 runs, {formatPercent(tip.row.p90[tip.m]!)} or less</div>}
              </>
            )}
          </div>
        </FloatingTip>
      )}
      <div className="sr-only">
        <table>
          <caption>Busy share by team and month</caption>
          <thead>
            <tr>
              <th scope="col">Team</th>
              {months.map((m, i) => (
                <th key={i} scope="col">
                  {m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.name}</th>
                {r.busy.map((v, m) => (
                  <td key={m}>{v === null ? "" : `${formatPercent(v)} (${WORDS[busyTone(v, r.line)]})`}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

