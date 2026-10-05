"use client";

// The forecast's monthly timeline (issue #35, B6): one row per role (or person) with how busy they are each month
// against the "Too busy" line, the client groups by service under them, the market conditions from the schedule as
// shaded months, and markers for planned hires, end dates and leave. Drawn by hand in SVG from the theme's tokens, as
// the Overview's charts are: one scale for every busy row and one for every client row, never two on one axis. Too
// busy months are marked with a dot and named in the tooltip and the table, so nothing rests on colour alone.
//
// It takes `TimelineData` (lib/forecast/timeline.ts), so any month-by-month run can draw it: the Overview's team load
// chart (B15) included.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { RATING_RULES, bandOf, isTooBusy, type MonthBusy, type Stat } from "@transpera-flow/engine";
import { formatNumber, formatPercent } from "@/lib/format";
import { labelIndexes } from "@/lib/overview/axis";
import type { TimelineData, TimelineMarker, TimelineRow } from "@/lib/forecast/timeline";

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

const ROW = 52;
const ROW_GAP = 12;
const TOP = 22;
const AXIS = 22;
const CLIENT_HEADER = 26;

type Cutoffs = readonly [number, number, number];

/** Rule 1's bands, as the alerts read them: Bad is "too busy", the top band Operational risk, in the rating colours. */
const toneOf = (v: number, cutoffs: Cutoffs) => {
  const band = bandOf(cutoffs, v, RATING_RULES.busy.upperInclusive);
  return band >= 3 ? "var(--rate-risk)" : band >= 2 ? "var(--rate-bad)" : null;
};

/** A legend entry: a swatch and a word, in text colour. */
export function TimelineLegendItem({ children, swatch }: { children: ReactNode; swatch: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {swatch}
      {children}
    </span>
  );
}

/** The legend: what every mark on the timeline means. */
export function TimelineLegend({ busyLine, hasMarkers, hasMarket, hasUncovered = false }: { busyLine: number; hasMarkers: boolean; hasMarket: boolean; hasUncovered?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" data-timeline-legend>
      <TimelineLegendItem swatch={<i aria-hidden className="h-0.5 w-4 rounded bg-accent" />}>Average</TimelineLegendItem>
      <TimelineLegendItem swatch={<i aria-hidden className="h-2.5 w-4 rounded-sm bg-accent/20" />}>10–90% range</TimelineLegendItem>
      <TimelineLegendItem swatch={<i aria-hidden className="w-4 border-t border-dashed border-fg-3" />}>{formatPercent(busyLine)} &ldquo;Too busy&rdquo; line</TimelineLegendItem>
      <TimelineLegendItem swatch={<i aria-hidden className="size-2.5 rounded-full border-2 border-panel bg-rate-bad ring-1 ring-rate-bad" />}>Too busy that month</TimelineLegendItem>
      {hasMarkers && (
        <>
          <TimelineLegendItem swatch={<span aria-hidden className="text-[10px] leading-none text-fg">▲</span>}>Starts</TimelineLegendItem>
          <TimelineLegendItem swatch={<span aria-hidden className="text-[10px] leading-none text-fg">▼</span>}>Leaves</TimelineLegendItem>
          <TimelineLegendItem swatch={<i aria-hidden className="h-1 w-4 rounded-full bg-fg-3" />}>On leave</TimelineLegendItem>
        </>
      )}
      {hasUncovered && (
        <TimelineLegendItem swatch={<i aria-hidden className="h-2.5 w-4 rounded-sm border border-rate-risk bg-rate-risk-soft" />}>No one to do the work</TimelineLegendItem>
      )}
      {hasMarket && <TimelineLegendItem swatch={<i aria-hidden className="h-2.5 w-4 rounded-sm border border-line-2 bg-[repeating-linear-gradient(135deg,var(--line-2)_0_2px,transparent_2px_5px)]" />}>Market condition</TimelineLegendItem>}
    </div>
  );
}

/** Where a row is at its busiest, in words: "Peaks at 92% in Feb". */
function peakOf(row: TimelineRow, months: TimelineData["months"]): string {
  let best = -1;
  row.series.forEach((m, i) => {
    if (m && (best < 0 || m.mean > row.series[best]!.mean)) best = i;
  });
  return best < 0 ? "Not there" : `Peaks at ${formatPercent(row.series[best]!.mean)} in ${months[best]!.short}`;
}

export function ForecastTimeline({
  data,
  rows,
  cutoffs,
  label,
}: {
  data: TimelineData;
  /** Which busy rows to draw: by role, or by person. */
  rows: "roles" | "people";
  /** Rule 1's cut-offs (Good, Bad, Operational risk): the dashed line is where "Too busy" (Bad) starts. */
  cutoffs: Cutoffs;
  /** What the chart shows, for a screen reader. */
  label: string;
}) {
  const busyLine = cutoffs[1];
  const [ref, measured] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const hatch = `forecast-market-hatch-${useId().replace(/:/g, "")}`;
  const width = measured || 640;
  const compact = width < 520;
  const busy = rows === "roles" ? data.roles : data.people;
  const n = data.months.length;
  // Wide: names in a column on the left. Narrow: each name on a line above its row, so the months get the full width.
  const m = { l: compact ? 2 : 176, r: compact ? 40 : 48 };
  const head = compact ? 20 : 0;
  const rowH = ROW + head;
  const plotW = Math.max(40, width - m.l - m.r);
  const col = plotW / n;
  const x = (i: number) => m.l + (i + 0.5) * col;
  const top = useMemo(() => Math.max(1.1, busyLine + 0.15, ...busy.flatMap((r) => r.series.map((s) => (s ? s.p90 * 1.05 : 0)))), [busy, busyLine]);
  const rowTop = (r: number) => TOP + r * (rowH + ROW_GAP);
  /** The baseline of row r's plot. */
  const rowBase = (r: number) => rowTop(r) + rowH;
  const busyY = (r: number, v: number) => rowBase(r) - (Math.min(v, top) / top) * ROW;
  const clientsTop = TOP + busy.length * (rowH + ROW_GAP) + (data.clients.length ? CLIENT_HEADER : 0);
  const clientBase = (r: number) => clientsTop + r * (rowH + ROW_GAP) + rowH;
  const clientMax = Math.max(1, ...data.clients.flatMap((c) => c.series.map((s) => s.p90)));
  const clientY = (r: number, v: number) => clientBase(r) - (v / (clientMax * 1.1)) * ROW;
  const height = clientsTop + data.clients.length * (rowH + ROW_GAP) + AXIS;
  const labelled = new Set(labelIndexes(n, Math.max(2, Math.floor(plotW / (compact ? 64 : 60)) + 1)));
  /** A row's name and what it adds, on two lines (wide) or one (narrow). */
  const rowLabel = (r: number, top0: number, name: string, sub: string) =>
    compact ? (
      <text x={0} y={top0 + 13} className="fill-fg text-[12px] font-medium">
        {name}
        <tspan className="fill-fg-2 text-[11px] font-normal"> · {sub}</tspan>
      </text>
    ) : (
      <>
        <text x={0} y={top0 + 16} className="fill-fg text-[12px] font-medium">
          {name.length > 24 ? `${name.slice(0, 23)}…` : name}
        </text>
        <text x={0} y={top0 + 31} className="fill-fg-2 text-[11px]">
          {sub}
        </text>
      </>
    );

  /** A line through the months' values, broken where a month has none. */
  const linePath = (vals: (number | null)[], y: (v: number) => number) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  /** The 10-90% band, one closed shape per run of months with values. */
  const bandPath = (vals: ({ lo: number; hi: number } | null)[], y: (v: number) => number) => {
    const runs: number[][] = [];
    vals.forEach((v, i) => {
      if (!v) return;
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i);
      else runs.push([i]);
    });
    return runs
      .map((run) => {
        // A lone month is drawn as a short bar across its column.
        const pts = run.length === 1 ? [run[0]! - 0.3, run[0]! + 0.3].map((p) => ({ px: m.l + (p + 0.5) * col, v: vals[run[0]!]! })) : run.map((i) => ({ px: x(i), v: vals[i]! }));
        const up = pts.map((p, k) => `${k ? "L" : "M"}${p.px.toFixed(1)},${y(p.v.hi).toFixed(1)}`).join("");
        const down = [...pts].reverse().map((p) => `L${p.px.toFixed(1)},${y(p.v.lo).toFixed(1)}`).join("");
        return `${up}${down}Z`;
      })
      .join("");
  };

  const pointerMove = (clientX: number, left: number) => {
    const i = Math.floor((clientX - left - m.l) / col);
    setHover(i >= 0 && i < n ? i : null);
  };
  const shown = hover !== null ? data.months[hover] : null;

  const markerGlyph = (mk: TimelineMarker, r: number, k: number) => {
    const y0 = rowBase(r) + 2;
    if (mk.kind === "leave") {
      const a = m.l + mk.at * col;
      const b = m.l + mk.until * col;
      return (
        <g key={`${mk.personId}-${mk.kind}-${k}`}>
          <title>{`${mk.label}: ${mk.when}`}</title>
          <rect x={a} y={y0 + 1} width={Math.max(3, b - a)} height={3} rx={1.5} fill="var(--fg-3)" />
        </g>
      );
    }
    const cx = m.l + mk.at * col;
    const path = mk.kind === "hire" ? `M${cx - 4},${y0 + 7} L${cx + 4},${y0 + 7} L${cx},${y0} Z` : `M${cx - 4},${y0} L${cx + 4},${y0} L${cx},${y0 + 7} Z`;
    return (
      <g key={`${mk.personId}-${mk.kind}-${k}`}>
        <title>{`${mk.label}: ${mk.when}`}</title>
        <path d={path} fill="var(--fg)" stroke="var(--panel)" strokeWidth={1} />
      </g>
    );
  };

  return (
    <div ref={ref} className="relative" data-forecast-timeline>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        className="block overflow-visible"
        onPointerMove={(e) => pointerMove(e.clientX, e.currentTarget.getBoundingClientRect().left)}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
            <rect width="6" height="6" fill="var(--panel-2)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-2)" strokeWidth="2" />
          </pattern>
        </defs>
        {/* Market conditions: shaded months behind every row, named above. */}
        {data.market.map((band) => {
          const a = m.l + band.from * col;
          const w = (band.to - band.from + 1) * col;
          return (
            <g key={`${band.from}-${band.name}`} data-market-band>
              <title>{`${band.name}: ${data.months[band.from]!.long} to ${data.months[band.to]!.long}`}</title>
              <rect x={a} y={TOP - 4} width={w} height={height - TOP - AXIS + 4} fill={`url(#${hatch})`} opacity={0.7} />
              <line x1={a} x2={a} y1={TOP - 4} y2={height - AXIS} stroke="var(--line-2)" strokeWidth={1} />
              <text x={a + 3} y={12} className="fill-fg-2 text-[11px]">
                {w > 64 || !compact ? band.name : ""}
              </text>
            </g>
          );
        })}
        {/* Month columns: a faint rule at each labelled month. */}
        {data.months.map((mo, i) =>
          labelled.has(i) ? (
            <g key={mo.index}>
              <line x1={x(i)} x2={x(i)} y1={TOP - 4} y2={height - AXIS} stroke="var(--line)" strokeWidth={1} />
              <text x={x(i)} y={height - 7} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-fg-3 text-[11px]">
                {mo.short}
              </text>
            </g>
          ) : null,
        )}

        {busy.map((row, r) => {
          const y = (v: number) => busyY(r, v);
          const means = row.series.map((s) => (s ? s.mean : null));
          const last = [...row.series].reverse().find((s) => s) ?? null;
          return (
            <g key={row.id} data-row={row.id}>
              {rowLabel(r, rowTop(r), row.name, peakOf(row, data.months))}
              <line x1={m.l} x2={m.l + plotW} y1={rowBase(r)} y2={rowBase(r)} stroke="var(--line-2)" strokeWidth={1} />
              <line x1={m.l} x2={m.l + plotW} y1={y(busyLine)} y2={y(busyLine)} stroke="var(--fg-3)" strokeDasharray="4 3" strokeWidth={1} />
              {row.uncovered?.map((h, i) =>
                h !== null ? (
                  <g key={`uncovered-${i}`} data-uncovered={i}>
                    <title>{`${data.months[i]!.long}: no one in ${row.name} to do about ${formatNumber(h, 0)} hours of work a week`}</title>
                    <rect x={m.l + i * col + 1} y={rowBase(r) - ROW} width={Math.max(2, col - 2)} height={ROW} rx={3} fill="var(--rate-risk-soft)" stroke="var(--rate-risk)" strokeWidth={1} />
                  </g>
                ) : null,
              )}
              <path d={bandPath(row.series.map((s) => (s ? { lo: s.p10, hi: s.p90 } : null)), y)} fill="var(--accent)" fillOpacity={0.22} />
              <path d={linePath(means, y)} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {row.series.map((s, i) => {
                const tone = s ? toneOf(s.mean, cutoffs) : null;
                return tone ? <circle key={i} cx={x(i)} cy={y(s!.mean)} r={3.5} fill={tone} stroke="var(--panel)" strokeWidth={2} /> : null;
              })}
              {last && (
                <text x={m.l + plotW + 6} y={y(last.mean) + 4} className="fill-fg text-[11px] font-semibold tabular-nums">
                  {formatPercent(last.mean)}
                </text>
              )}
              {row.markers.map((mk, k) => markerGlyph(mk, r, k))}
              {!last && row.uncovered && (
                <text x={m.l + plotW + 6} y={rowBase(r) - ROW / 2 + 4} className="fill-fg text-[11px] font-semibold">
                  No one
                </text>
              )}
            </g>
          );
        })}

        {data.clients.length > 0 && (
          <text x={0} y={clientsTop - 10} className="fill-fg-2 text-[11px] font-semibold tracking-wide uppercase">
            Active clients
          </text>
        )}
        {data.clients.map((c, r) => {
          const y = (v: number) => clientY(r, v);
          const last = c.series[c.series.length - 1]!;
          const base = clientBase(r);
          return (
            <g key={c.id || "all"} data-client-row={c.id}>
              {rowLabel(r, base - rowH, c.name, `${formatNumber(c.series[0]!.mean, 0)} → ${formatNumber(last.mean, 0)}`)}
              <line x1={m.l} x2={m.l + plotW} y1={base} y2={base} stroke="var(--line-2)" strokeWidth={1} />
              <path d={bandPath(c.series.map((s) => ({ lo: s.p10, hi: s.p90 })), y)} fill="var(--accent)" fillOpacity={0.22} />
              <path d={linePath(c.series.map((s) => s.mean), y)} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <text x={m.l + plotW + 6} y={y(last.mean) + 4} className="fill-fg text-[11px] font-semibold tabular-nums">
                {formatNumber(last.mean, 0)}
              </text>
            </g>
          );
        })}

        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={TOP - 4} y2={height - AXIS} stroke="var(--fg-3)" strokeDasharray="3 3" pointerEvents="none" />
        )}
      </svg>
      {shown && hover !== null && (
        <div
          role="presentation"
          className="pointer-events-none absolute top-0 z-10 w-max max-w-64 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: x(hover) + 12 + 240 > width ? Math.max(0, x(hover) - 252) : x(hover) + 12 }}
        >
          <p className="font-medium">{shown.long}</p>
          {data.market.filter((b) => hover >= b.from && hover <= b.to).map((b) => (
            <p key={b.name} className="text-muted-foreground">
              Market: {b.name}
            </p>
          ))}
          <ul className="mt-1 flex flex-col gap-0.5">
            {busy.map((row) => {
              const s = row.series[hover];
              const undone = row.uncovered?.[hover] ?? null;
              return (
                <li key={row.id} className="flex justify-between gap-3 tabular-nums">
                  <span className="truncate">{row.name}</span>
                  <span>
                    {s ? (
                      <>
                        <b className="font-semibold">{formatPercent(s.mean)}</b>
                        <span className="text-muted-foreground"> ({formatPercent(s.p10)}–{formatPercent(s.p90)})</span>
                        {isTooBusy(s.mean, cutoffs) ? " too busy" : ""}
                      </>
                    ) : undone !== null ? (
                      <b className="font-semibold">no one, {formatNumber(undone, 0)} h/wk undone</b>
                    ) : (
                      <span className="text-muted-foreground">not there</span>
                    )}
                  </span>
                </li>
              );
            })}
            {data.clients.map((c) => (
              <li key={c.id || "all"} className="flex justify-between gap-3 tabular-nums">
                <span className="truncate">{c.name} clients</span>
                <span>{formatNumber(c.series[hover]!.mean, 0)}</span>
              </li>
            ))}
          </ul>
          {data.markers.filter((mk) => hover >= mk.from && hover <= mk.to).map((mk) => (
            <p key={`${mk.personId}-${mk.kind}-${mk.at}`} className="mt-1 text-muted-foreground">
              {mk.label}, {mk.when}
            </p>
          ))}
        </div>
      )}
      <TimelineTable data={data} busy={busy} cutoffs={cutoffs} />
    </div>
  );
}

/** The same numbers as a table, for a screen reader. */
function TimelineTable({ data, busy, cutoffs }: { data: TimelineData; busy: TimelineRow[]; cutoffs: Cutoffs }) {
  const cell = (s: MonthBusy | null, undone: number | null) =>
    s
      ? `${formatPercent(s.mean)} (${formatPercent(s.p10)} to ${formatPercent(s.p90)})${isTooBusy(s.mean, cutoffs) ? ", too busy" : ""}${undone !== null ? `, ${formatNumber(undone, 0)} hours a week with no one to do them` : ""}`
      : undone !== null
        ? `no one there, ${formatNumber(undone, 0)} hours a week undone`
        : "not there";
  const count = (s: Stat) => formatNumber(s.mean, 0);
  return (
    <table className="sr-only">
      <caption>How busy each is per month, average and 10 to 90 percent range, and active clients by service</caption>
      <thead>
        <tr>
          <th scope="col">Month</th>
          {busy.map((r) => (
            <th key={r.id} scope="col">
              {r.name}
            </th>
          ))}
          {data.clients.map((c) => (
            <th key={c.id || "all"} scope="col">
              {c.name} clients
            </th>
          ))}
          <th scope="col">Market</th>
          <th scope="col">Planned</th>
        </tr>
      </thead>
      <tbody>
        {data.months.map((mo, i) => (
          <tr key={mo.index}>
            <th scope="row">{mo.long}</th>
            {busy.map((r) => (
              <td key={r.id}>{cell(r.series[i] ?? null, r.uncovered?.[i] ?? null)}</td>
            ))}
            {data.clients.map((c) => (
              <td key={c.id || "all"}>{count(c.series[i]!)}</td>
            ))}
            <td>{data.market.find((b) => i >= b.from && i <= b.to)?.name ?? "Stable"}</td>
            <td>
              {data.markers
                .filter((mk) => i >= mk.from && i <= mk.to)
                .map((mk) => `${mk.label}, ${mk.when}`)
                .join("; ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
