"use client";

// "Who's overloaded, and when" (D54): a heatmap of every team by month, coloured by busy share against the team's line (the Capacity page's cut-offs:
// green under, amber within ten points, red at or over), a This scene / Today switch for which run it shows, and under it paired bars of the people over
// their line each month (today grey, this scene in colour). Plain HTML grid and SVG from the theme's tokens, with the numbers as a table for a screen reader.

import { useState } from "react";
import { FloatingTip } from "@/components/ui/floating-tip";
import { formatPercent } from "@/lib/format";
import { busyTone, type BusyTone, type HeatRow } from "@/lib/sandbox/play-results-data";
import { cn } from "@/lib/utils";

const TINT: Record<BusyTone, string> = {
  ok: "color-mix(in srgb, var(--good) 30%, transparent)",
  warn: "color-mix(in srgb, var(--warn) 50%, transparent)",
  bad: "color-mix(in srgb, var(--crit) 68%, transparent)",
};
const WORDS: Record<BusyTone, string> = { ok: "under the line", warn: "close to the line", bad: "over the line" };

export type HeatView = "scene" | "today";

export function Heatmap({ rows, months, view }: { rows: HeatRow[]; months: string[]; view: HeatView }) {
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
          {months.map((m, i) => (
            <span key={i} role="columnheader" className={cn("truncate text-center text-2xs", i % 2 === 1 && "max-sm:invisible")}>
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
                  className="flex h-8 items-center justify-center rounded-[3px] text-2xs tabular-nums"
                  style={{ background: tone ? TINT[tone] : "var(--panel-2)" }}
                  onPointerMove={(e) => setTip({ row: r, m, at: at(e) })}
                  onPointerDown={(e) => setTip({ row: r, m, at: at(e) })}
                  onPointerLeave={() => setTip(null)}
                >
                  {v === null ? <span className="sr-only">no one there</span> : <span className="max-md:sr-only">{Math.round(v * 100)}</span>}
                  {tone === "bad" && <i aria-hidden className="hidden size-1.5 rounded-full bg-crit max-md:block" />}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-legend data-heat-legend>
        {(["ok", "warn", "bad"] as const).map((t) => (
          <li key={t} className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block h-2.5 w-3.5 rounded-[3px]" style={{ background: TINT[t] }} />
            {t === "ok" ? "Under the line" : t === "warn" ? "Within 10 points of it" : "At or over the line"}
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
      <table className="sr-only">
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
  );
}

const W = 520;
const H = 120;
const M = { l: 34, r: 6, t: 8, b: 22 };

/** For each month, the people over their line: today in grey, this scene in colour. Only today's bar when `scene` is null. */
export function OverBars({ months, today, scene }: { months: string[]; today: number[]; scene: number[] | null }) {
  const [tip, setTip] = useState<{ m: number; at: { x: number; y: number } } | null>(null);
  const n = months.length;
  const top = Math.max(1, ...today, ...(scene ?? []));
  const ticks = top <= 4 ? Array.from({ length: top + 1 }, (_, i) => i) : [0, Math.ceil(top / 2), top];
  const slot = (W - M.l - M.r) / n;
  const y = (v: number) => M.t + (1 - v / top) * (H - M.t - M.b);
  const bar = scene ? slot * 0.34 : slot * 0.5;
  return (
    <figure className="m-0 flex flex-col gap-1" data-play-over-bars>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="People over their line, month by month" className="h-auto w-full text-[11px]" onPointerLeave={() => setTip(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
            <text x={M.l - 6} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground">
              {v}
            </text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = M.l + slot * (i + 0.5);
          const bars = scene ? [{ v: today[i]!, x: cx - bar - 1, fill: "var(--fg-3)", k: "today" }, { v: scene[i]!, x: cx + 1, fill: "var(--chart-1)", k: "scene" }] : [{ v: today[i]!, x: cx - bar / 2, fill: "var(--fg-3)", k: "today" }];
          return (
            <g key={i}>
              {bars.map((b) => (
                <rect key={b.k} data-over-bar={b.k} x={b.x} y={y(b.v)} width={bar} height={Math.max(0, y(0) - y(b.v))} fill={b.fill} rx={2} />
              ))}
              {(i === 0 || i === n - 1 || (n > 6 && i % 3 === 0)) && (
                <text x={cx} y={H - 6} textAnchor="middle" className="fill-muted-foreground">
                  {m}
                </text>
              )}
              <rect x={cx - slot / 2} y={M.t} width={slot} height={H - M.t - M.b} fill="transparent" onPointerMove={(e) => setTip({ m: i, at: { x: e.clientX, y: e.clientY } })} onPointerDown={(e) => setTip({ m: i, at: { x: e.clientX, y: e.clientY } })} />
            </g>
          );
        })}
      </svg>
      {tip && (
        <FloatingTip at={tip.at} placement="side">
          <div data-play-tip className="flex flex-col gap-0.5">
            <div className="font-semibold">{months[tip.m]}</div>
            {scene && (
              <div className="flex items-center gap-1.5">
                <i aria-hidden className="inline-block size-2 rounded-sm" style={{ background: "var(--chart-1)" }} />
                This scene: <b className="font-semibold">{scene[tip.m]}</b>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <i aria-hidden className="inline-block size-2 rounded-sm" style={{ background: "var(--fg-3)" }} />
              Today: <b className="font-semibold">{today[tip.m]}</b>
            </div>
            <div className="text-muted-foreground">people over their line</div>
          </div>
        </FloatingTip>
      )}
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-legend>
        <span>People over their line</span>
        {scene && (
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: "var(--chart-1)" }} />
            This scene
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: "var(--fg-3)" }} />
          Today
        </span>
      </figcaption>
      <table className="sr-only">
        <caption>People over their line, by month</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            {scene && <th scope="col">This scene</th>}
            <th scope="col">Today</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m, i) => (
            <tr key={i}>
              <th scope="row">{m}</th>
              {scene && <td>{scene[i]}</td>}
              <td>{today[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
