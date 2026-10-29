"use client";

// Where the time goes, drawn (sandbox G, phase 4): a 100% stacked bar per month, the categories in the workspace's order and then Idle,
// with work nobody was there to do as a hatched cap above the 100%. Plain SVG, as the Overview's charts are, and a list of bars per month on
// a phone. The same chart serves the Sandbox, its compare and the Overview.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatNumber, formatPercent } from "@/lib/format";
import { niceTicks } from "@/lib/overview/axis";
import { IDLE, NOT_SET, UNCOVERED, type TimeRow, type TimeView } from "@/lib/sandbox/time";

/** A fixed colour per default category, so a rename or a reorder never recolours it; categories the workspace added take the spare ones by their key. */
const FIXED: Record<string, string> = {
  client_job: "var(--accent)",
  client_upkeep: "var(--purpose-upkeep)",
  winning: "var(--purpose-winning)",
  required: "var(--purpose-required)",
  coordination: "var(--purpose-coordination)",
  fixing: "var(--rate-bad)",
  removable: "var(--purpose-removable)",
  [NOT_SET]: "var(--purpose-unset)",
  [IDLE]: "var(--panel-2)",
};
const SPARE = [1, 2, 3, 4, 5, 6].map((n) => `var(--purpose-spare-${n})`);
const HATCH = "repeating-linear-gradient(135deg, var(--fg-3) 0 1.5px, transparent 1.5px 4px)";

export function purposeColor(key: string): string {
  if (FIXED[key]) return FIXED[key]!;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SPARE[h % SPARE.length]!;
}

const fillOf = (r: TimeRow) => (r.kind === "uncovered" ? "url(#time-hatch)" : purposeColor(r.id));
const hours = (h: number) => `${formatNumber(h, h < 10 ? 1 : 0)} h`;

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

export function TimeLegend({ rows }: { rows: TimeRow[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" data-legend data-time-legend>
      {rows.map((r) => (
        <li key={r.id} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <i
            aria-hidden
            className="inline-block h-2.5 w-3.5 rounded-sm border border-line"
            style={r.kind === "uncovered" ? { backgroundImage: HATCH } : { background: fillOf(r) }}
          />
          {r.name}
        </li>
      ))}
    </ul>
  );
}

/** What a month's tooltip says. */
function monthBody(view: TimeView, m: number): ReactNode {
  const month = view.months[m]!;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="font-medium">{month.label}</p>
      {view.rows.map((r) => (
        <p key={r.id} className="flex justify-between gap-3 tabular-nums">
          <span className="text-muted-foreground">{r.name}</span>
          <span>
            {hours(r.hours[m]!.mean)}
            {r.kind === "uncovered" ? "" : `, ${formatPercent(r.share[m]!)}`}
          </span>
        </p>
      ))}
      {view.over[m] ? <p className="text-muted-foreground">More work than hours: overtime is capped.</p> : null}
    </div>
  );
}

const HEIGHT = 240;

/** The chart: one 100% bar per month. `label` is the alt text. */
export function TimeChart({ view, label }: { view: TimeView; label: string }) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{ x: number; y: number; m: number } | null>(null);
  const width = measured || 640;
  const n = view.months.length;
  const m = { l: 40, r: 8, t: 10, b: 28 };
  const bars = view.rows.filter((r) => r.kind !== "uncovered");
  const cap = view.rows.find((r) => r.kind === "uncovered");
  // The most any month reaches: 100%, or the work above it, or the hatched cap.
  const top = Math.max(
    1,
    ...view.months.map((_, i) => {
      const used = bars.reduce((a, r) => a + (r.hours[i]?.mean ?? 0), 0);
      const total = view.total[i]!.mean;
      return total > 0 ? Math.max(used, total + (cap?.hours[i]?.mean ?? 0)) / total : 1;
    }),
  );
  const ticks = niceTicks(0, Math.min(top, 1.5) * 100, 4).filter((t) => t <= Math.ceil(top * 100 + 1));
  const ymax = Math.max(ticks[ticks.length - 1]! / 100, 1);
  const y = (v: number) => m.t + (1 - v / ymax) * (HEIGHT - m.t - m.b);
  const slot = (width - m.l - m.r) / Math.max(1, n);
  const bar = Math.min(44, Math.max(6, slot - 6));
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((width - m.l) / 52))));
  return (
    <div ref={ref} className="relative" data-time-chart>
      <svg width={width} height={HEIGHT} role="img" aria-label={label} className="hidden sm:block">
        <defs>
          <pattern id="time-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
            <rect width="6" height="6" fill="var(--panel)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--fg-3)" strokeWidth="2" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={y(t / 100)} y2={y(t / 100)} stroke="var(--line)" strokeWidth={1} />
            <text x={m.l - 6} y={y(t / 100) + 4} textAnchor="end" className="fill-fg-3 text-[11px] tabular-nums">
              {t}%
            </text>
          </g>
        ))}
        {view.months.map((mo, i) => {
          const total = view.total[i]!.mean;
          const cx = m.l + slot * (i + 0.5);
          let acc = 0;
          const segs = bars.map((r) => {
            const h = total > 0 ? r.hours[i]!.mean / total : 0;
            const seg = { r, y0: acc, y1: acc + h };
            acc += h;
            return seg;
          });
          const upper = total > 0 && cap ? cap.hours[i]!.mean / total : 0;
          return (
            <g
              key={mo.index}
              data-month={mo.index}
              data-over={view.over[i] ? "true" : undefined}
              onPointerMove={(e) => {
                const rect = ref.current?.getBoundingClientRect();
                if (rect) setTip({ x: Math.min(Math.max(e.clientX - rect.left, 90), Math.max(90, rect.width - 90)), y: e.clientY - rect.top, m: i });
              }}
              onPointerLeave={() => setTip(null)}
            >
              <rect x={cx - slot / 2} y={m.t} width={slot} height={HEIGHT - m.t - m.b} fill="transparent" />
              {segs.map(({ r, y0, y1 }) =>
                y1 > y0 ? <rect key={r.id} x={cx - bar / 2} y={y(y1)} width={bar} height={Math.max(0, y(y0) - y(y1))} fill={fillOf(r)} stroke="var(--panel)" strokeWidth={0.5} data-row={r.id} /> : null,
              )}
              {upper > 0 && cap ? <rect x={cx - bar / 2} y={y(acc + upper)} width={bar} height={Math.max(0, y(acc) - y(acc + upper))} fill="url(#time-hatch)" stroke="var(--fg-3)" strokeWidth={0.5} data-row={UNCOVERED} /> : null}
              {view.over[i] ? <circle cx={cx} cy={m.t + 3} r={3} fill="var(--crit)" data-over-dot /> : null}
              {i % every === 0 || i === n - 1 ? (
                <text x={cx} y={HEIGHT - 8} textAnchor="middle" className="fill-fg-3 text-[11px]">
                  {mo.short}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {/* A phone: one bar per month, in rows. */}
      <ul className="flex flex-col gap-1.5 sm:hidden" data-time-rows>
        {view.months.map((mo, i) => (
          <li key={mo.index} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2 text-xs" data-month={mo.index}>
            <span className="text-muted-foreground">{mo.short}</span>
            <span aria-hidden className="flex h-3.5 overflow-hidden rounded-sm">
              {bars.map((r) => (r.hours[i]!.mean > 0 ? <span key={r.id} className="block h-full min-w-px" style={{ flexGrow: r.hours[i]!.mean, flexBasis: 0, background: fillOf(r) }} /> : null))}
            </span>
          </li>
        ))}
      </ul>
      {tip ? (
        <div role="presentation" data-chart-tip className="pointer-events-none absolute z-10 w-max max-w-64 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md" style={{ left: tip.x, top: tip.y }}>
          {monthBody(view, tip.m)}
        </div>
      ) : null}
    </div>
  );
}

/** One whole-run 100% bar: a compare column's, or the Overview's summary. */
export function TimeBar({ rows, label }: { rows: { id: string; name: string; share: number; kind: TimeRow["kind"] }[]; label: string }) {
  const bars = rows.filter((r) => r.kind !== "uncovered");
  const total = bars.reduce((a, r) => a + r.share, 0) || 1;
  return (
    <span role="img" aria-label={label} className="flex h-4 overflow-hidden rounded-sm border border-line" data-time-bar>
      {bars.map((r) => (r.share > 0 ? <span key={r.id} title={`${r.name}: ${formatPercent(r.share)}`} className="block h-full min-w-px" style={{ flexGrow: r.share / total, flexBasis: 0, background: purposeColor(r.id) }} /> : null))}
    </span>
  );
}
