"use client";

// The Overview's trend charts (issue #173, B15), drawn by hand in SVG and CSS from the theme's tokens like the other
// Overview charts: thin marks with a 2px gap between touching ones, solid hairline grids, text in text colours, a legend for
// two or more series, a tooltip on hover and the same numbers in a table only a screen reader sees.
//
// - Open issues: a donut by rating (the rating colours, which mean something) and bars by process (one colour).
// - Time split by process: hands-on against waiting, as shares of each process's elapsed time.
// - Issues opened versus resolved per month.
// - Before and after per solution, one measure at a time (never two scales on one axis).
//
// This module is loaded on its own (next/dynamic), after the map and the cards.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { RATING_LABELS, type Rating } from "@transpera-flow/engine";
import { formatNumber, formatPercent } from "@/lib/format";
import { niceTicks } from "@/lib/overview/axis";
import { totalOf, type MonthCount, type ProcessTimeSplit } from "@/lib/overview/health";
import type { SolutionImpact } from "@/lib/overview/impact";
import { cn } from "@/lib/utils";

/** The width of an element, following it as it resizes (0 until it is measured). */
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

interface TipState {
  x: number;
  y: number;
  body: ReactNode;
}

/**
 * A tooltip that follows the pointer inside a `relative` box: `show` from a mark's pointer move (it measures the box then),
 * `hide` on leave, and `<Tip>` draws it.
 */
function useTip(): [React.RefObject<HTMLDivElement | null>, TipState | null, (e: React.PointerEvent, body: ReactNode) => void, () => void] {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const show = (e: React.PointerEvent, body: ReactNode) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    // Kept inside the box: a tooltip near an edge doesn't hang off it.
    const x = Math.min(Math.max(e.clientX - rect.left, 70), Math.max(70, rect.width - 70));
    setTip({ x, y: e.clientY - rect.top, body });
  };
  const hide = () => setTip(null);
  return [box, tip, show, hide];
}

function Tip({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  return (
    <div
      role="presentation"
      data-chart-tip
      className="pointer-events-none absolute z-10 w-max max-w-56 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.body}
    </div>
  );
}

export function Legend({ items }: { items: { key: string; label: string; swatch: ReactNode }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" data-legend>
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          {i.swatch}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

const HATCH = "repeating-linear-gradient(135deg, var(--fg-3) 0 1.5px, transparent 1.5px 4px)";
const swatch = (background: string, extra?: string) => <i aria-hidden className={cn("inline-block h-2.5 w-3.5 rounded-sm", extra)} style={{ background }} />;

// ---------------------------------------------------------------------------------------------------------------------
// Open issues: by rating (donut) and by process (bars)
// ---------------------------------------------------------------------------------------------------------------------

const DONUT = 132;
const RING = 16;

/** One arc of the donut, from angle a0 to a1 (radians, 0 at the top, clockwise). */
function arc(a0: number, a1: number, r: number, c: number): string {
  const p = (a: number) => [c + r * Math.sin(a), c - r * Math.cos(a)] as const;
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

export function IssuesDonut({ byRating, byProcess }: { byRating: { rating: Rating; count: number }[]; byProcess: { id: string; name: string; count: number }[] }) {
  const [tipBox, tip, showTip, hideTip] = useTip();
  const total = byRating.reduce((a, c) => a + c.count, 0);
  if (total === 0) return <p className="text-sm text-muted-foreground" data-empty>No open issues. Acknowledged insights and issues logged by hand show here while they are open.</p>;
  const shown = byRating.filter((c) => c.count > 0);
  const c = DONUT / 2;
  const r = c - RING / 2;
  // A 2px gap between arcs, as an angle at the ring's middle.
  const gap = shown.length > 1 ? 2 / r : 0;
  const arcs = shown.map((s, i) => {
    const before = shown.slice(0, i).reduce((a, x) => a + x.count, 0);
    const a0 = (before / total) * Math.PI * 2 + gap / 2;
    const a1 = ((before + s.count) / total) * Math.PI * 2 - gap / 2;
    return { ...s, d: shown.length === 1 ? null : arc(a0, Math.max(a0 + 0.001, a1), r, c) };
  });
  const top = Math.max(1, ...byProcess.map((p) => p.count));
  return (
    <div ref={tipBox} className="relative grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)]">
      <div className="flex items-center gap-4">
        <svg width={DONUT} height={DONUT} role="img" aria-label={`${total} open issues: ${shown.map((s) => `${s.count} ${RATING_LABELS[s.rating]}`).join(", ")}.`} className="shrink-0" data-donut>
          {arcs.map((a) =>
            a.d ? (
              <path
                key={a.rating}
                d={a.d}
                fill="none"
                stroke={`var(--rate-${a.rating})`}
                strokeWidth={RING}
                data-arc={a.rating}
                onPointerMove={(e) => showTip(e, `${RATING_LABELS[a.rating]}: ${a.count} (${formatPercent(a.count / total)})`)}
                onPointerLeave={hideTip}
              />
            ) : (
              <circle key={a.rating} cx={c} cy={c} r={r} fill="none" stroke={`var(--rate-${a.rating})`} strokeWidth={RING} data-arc={a.rating} />
            ),
          )}
          <text x={c} y={c - 2} textAnchor="middle" className="fill-fg font-heading text-[22px] font-semibold">
            {total}
          </text>
          <text x={c} y={c + 15} textAnchor="middle" className="fill-fg-3 text-[11px]">
            open
          </text>
        </svg>
        <ul className="flex flex-col gap-1 text-xs" aria-hidden>
          {byRating.map((s) => (
            <li key={s.rating} className="flex items-center gap-1.5 text-muted-foreground">
              <i className="size-2.5 rounded-full" style={{ background: `var(--rate-${s.rating})` }} />
              <b className="w-5 text-right font-semibold text-foreground tabular-nums">{s.count}</b>
              {RATING_LABELS[s.rating]}
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">By process</p>
        <ul className="flex flex-col gap-1.5" data-by-process>
          {byProcess.map((p) => (
            <li key={p.id} className="grid grid-cols-[minmax(5rem,9rem)_minmax(0,1fr)_2rem] items-center gap-2 text-sm">
              <span className="truncate" title={p.name}>
                {p.name}
              </span>
              <span className="relative h-3">
                {p.count > 0 && (
                  <span
                    className="absolute inset-y-0 left-0 rounded-r-[4px] bg-accent"
                    style={{ width: `${(p.count / top) * 100}%`, minWidth: 3 }}
                    onPointerMove={(e) => showTip(e, `${p.name}: ${p.count} open`)}
                    onPointerLeave={hideTip}
                  />
                )}
              </span>
              <span className="text-right text-xs tabular-nums">{p.count}</span>
            </li>
          ))}
        </ul>
      </div>
      <Tip tip={tip} />
      <table className="sr-only">
        <caption>Open issues by rating and by process</caption>
        <tbody>
          {byRating.map((s) => (
            <tr key={s.rating}>
              <th scope="row">{RATING_LABELS[s.rating]}</th>
              <td>{s.count}</td>
            </tr>
          ))}
          {byProcess.map((p) => (
            <tr key={p.id}>
              <th scope="row">{p.name}</th>
              <td>{p.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Time split by process
// ---------------------------------------------------------------------------------------------------------------------

export const TIME_SPLIT_LEGEND = [
  { key: "handsOn", label: "Hands-on", swatch: swatch("var(--accent)") },
  { key: "person", label: "Waiting for a person", swatch: swatch("color-mix(in oklab, var(--fg-3) 70%, transparent)") },
  { key: "others", label: "Waiting on others", swatch: swatch(HATCH, "border border-fg-3") },
];

export function TimeSplitChart({ rows, months }: { rows: ProcessTimeSplit[]; /** The run's length in months, for hours a month in the tooltip. */ months: number }) {
  const [tipBox, tip, showTip, hideTip] = useTip();
  if (!rows.length) return <p className="text-sm text-muted-foreground" data-empty>No work went through any process in this run.</p>;
  const perMonth = (h: number) => `${formatNumber(h / Math.max(months, 1e-9), h / months < 10 ? 1 : 0)} h`;
  return (
    <div ref={tipBox} className="relative flex flex-col gap-3">
      <Legend items={TIME_SPLIT_LEGEND} />
      <ul className="flex flex-col gap-2" data-time-split>
        {rows.map((r) => {
          const total = totalOf(r);
          const parts = [
            { key: "handsOn", v: r.handsOn, style: { background: "var(--accent)" } },
            { key: "person", v: r.waitingForPerson, style: { background: "color-mix(in oklab, var(--fg-3) 70%, transparent)" } },
            { key: "others", v: r.waitingOnOthers, style: { backgroundImage: HATCH, boxShadow: "inset 0 0 0 1px var(--fg-3)" } },
          ];
          const body = (
            <>
              <p className="font-medium">{r.name}</p>
              <p className="tabular-nums">
                {formatPercent(r.share)} hands-on: {perMonth(r.handsOn)} a month
              </p>
              <p className="text-muted-foreground tabular-nums">
                Waiting for a person {perMonth(r.waitingForPerson)}, on others {perMonth(r.waitingOnOthers)}
              </p>
            </>
          );
          return (
            <li
              key={r.id}
              className="grid grid-cols-[minmax(5rem,9rem)_minmax(0,1fr)_4.5rem] items-center gap-2 text-sm"
              data-process={r.id}
              onPointerMove={(e) => showTip(e, body)}
              onPointerLeave={hideTip}
            >
              <span className="truncate" title={r.name}>
                {r.name}
              </span>
              <span aria-hidden className="flex h-3.5 gap-0.5">
                {parts.map((p) => (p.v > 0 ? <span key={p.key} className="block h-full min-w-px first:rounded-l-[4px] last:rounded-r-[4px]" style={{ flexGrow: p.v / total, flexBasis: 0, ...p.style }} /> : null))}
              </span>
              <span className="text-right text-xs tabular-nums">
                <b className="font-semibold">{formatPercent(r.share)}</b> working
              </span>
            </li>
          );
        })}
      </ul>
      <Tip tip={tip} />
      <table className="sr-only">
        <caption>Hands-on against waiting, by process, in hours a month</caption>
        <thead>
          <tr>
            <th scope="col">Process</th>
            <th scope="col">Hands-on share</th>
            <th scope="col">Hands-on</th>
            <th scope="col">Waiting for a person</th>
            <th scope="col">Waiting on others</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.name}</th>
              <td>{formatPercent(r.share)}</td>
              <td>{perMonth(r.handsOn)}</td>
              <td>{perMonth(r.waitingForPerson)}</td>
              <td>{perMonth(r.waitingOnOthers)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Issues opened versus resolved
// ---------------------------------------------------------------------------------------------------------------------

const OR_HEIGHT = 200;

export function OpenedResolvedChart({ months }: { months: MonthCount[] }) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const [tipBox, tip, showTip, hideTip] = useTip();
  const width = measured || 480;
  const any = months.some((m) => m.opened || m.resolved);
  const m = { l: 30, r: 8, t: 10, b: 24 };
  const ticks = niceTicks(0, Math.max(2, ...months.map((x) => Math.max(x.opened, x.resolved))), 3);
  const top = ticks[ticks.length - 1]!;
  const y = (v: number) => m.t + (1 - v / top) * (OR_HEIGHT - m.t - m.b);
  const slot = (width - m.l - m.r) / months.length;
  const bar = Math.min(18, Math.max(4, (slot - 14) / 2));
  return (
    <div ref={ref} className="relative flex flex-col gap-2">
      <div ref={tipBox} className="relative">
      <Legend
        items={[
          { key: "opened", label: "Opened", swatch: swatch("var(--accent)") },
          { key: "resolved", label: "Resolved", swatch: swatch("var(--rate-great)") },
        ]}
      />
      {!any && <p className="text-sm text-muted-foreground" data-empty>No issues were opened or resolved in the last {months.length} months.</p>}
      <svg width={width} height={OR_HEIGHT} role="img" aria-label={`Issues opened and resolved each month: ${months.map((x) => `${x.label} ${x.opened} opened, ${x.resolved} resolved`).join("; ")}.`} className="block" data-opened-resolved>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={m.l - 6} y={y(t) + 4} textAnchor="end" className="fill-fg-3 text-[11px] tabular-nums">
              {t}
            </text>
          </g>
        ))}
        {months.map((mo, i) => {
          const cx = m.l + slot * (i + 0.5);
          const cols = [
            { key: "opened", v: mo.opened, fill: "var(--accent)", x: cx - bar - 1 },
            { key: "resolved", v: mo.resolved, fill: "var(--rate-great)", x: cx + 1 },
          ];
          return (
            <g
              key={mo.month}
              data-month={mo.month}
              onPointerMove={(e) => showTip(e, `${mo.label}: ${mo.opened} opened, ${mo.resolved} resolved`)}
              onPointerLeave={hideTip}
            >
              <rect x={cx - slot / 2} y={m.t} width={slot} height={OR_HEIGHT - m.t - m.b} fill="transparent" />
              {cols.map((c) =>
                c.v > 0 ? (
                  <path
                    key={c.key}
                    d={column(c.x, y(c.v), bar, y(0) - y(c.v))}
                    fill={c.fill}
                  />
                ) : null,
              )}
              <text x={cx} y={OR_HEIGHT - 6} textAnchor="middle" className="fill-fg-3 text-[11px]">
                {mo.label}
              </text>
            </g>
          );
        })}
        <line x1={m.l} x2={width - m.r} y1={y(0)} y2={y(0)} stroke="var(--line-2, var(--line))" strokeWidth={1} />
      </svg>
      <Tip tip={tip} />
      </div>
      <table className="sr-only">
        <caption>Issues opened and resolved each month</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Opened</th>
            <th scope="col">Resolved</th>
          </tr>
        </thead>
        <tbody>
          {months.map((mo) => (
            <tr key={mo.month}>
              <th scope="row">{mo.label}</th>
              <td>{mo.opened}</td>
              <td>{mo.resolved}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A column from the baseline up: square at the baseline, a 4px rounded top (less when it is short). */
function column(x: number, top: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const b = top + h;
  return `M${x},${b} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${b} Z`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Before and after per solution
// ---------------------------------------------------------------------------------------------------------------------

type Measure = "hours" | "cycle";

export function BeforeAfterChart({ impacts, hoursPerWeek }: { impacts: SolutionImpact[]; hoursPerWeek: number }) {
  const [measure, setMeasure] = useState<Measure>("hours");
  const [tipBox, tip, showTip, hideTip] = useTip();
  if (!impacts.length)
    return (
      <p className="text-sm text-muted-foreground" data-empty>
        No solution has a verdict yet. Build a solution from an issue; once it has been checked, its before and after show here.
      </p>
    );
  const day = hoursPerWeek / 5;
  const value = (n: SolutionImpact["before"]) => (measure === "hours" ? n.handsOnPerMonth : n.cycleHours === null ? null : n.cycleHours / day);
  const unit = (v: number) => (measure === "hours" ? `${formatNumber(v, v < 10 ? 1 : 0)} h` : `${formatNumber(v, v < 10 ? 1 : 0)} d`);
  const top = Math.max(1e-9, ...impacts.flatMap((i) => [value(i.before) ?? 0, value(i.after) ?? 0]));
  const label = measure === "hours" ? "Hands-on hours a month" : "Time to complete, in working days";
  return (
    <div ref={tipBox} className="relative flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Legend
          items={[
            { key: "before", label: "Before", swatch: swatch("color-mix(in oklab, var(--fg-3) 70%, transparent)") },
            { key: "after", label: "After", swatch: swatch("var(--accent)") },
          ]}
        />
        <div role="group" aria-label="Measure" className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
          {(
            [
              ["hours", "Hours a month"],
              ["cycle", "Time to complete"],
            ] as const
          ).map(([k, text]) => (
            <button
              key={k}
              type="button"
              aria-pressed={measure === k}
              onClick={() => setMeasure(k)}
              className={cn("rounded-md px-2.5 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", measure === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      <ul className="flex flex-col gap-3" data-before-after aria-label={label}>
        {impacts.map((i) => {
          const b = value(i.before);
          const a = value(i.after);
          const change = b !== null && a !== null ? a - b : null;
          return (
            <li key={i.id} className="flex flex-col gap-1" data-solution={i.id}>
              <p className="flex min-w-0 items-center gap-2 text-sm">
                <span className="truncate font-medium">{i.name}</span>
                {i.implemented && <span className="rounded-full border px-1.5 text-2xs text-muted-foreground">Implemented</span>}
                {change !== null && Math.abs(change) > 1e-9 && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {change < 0 ? "−" : "+"}
                    {unit(Math.abs(change))}
                  </span>
                )}
              </p>
              {(
                [
                  ["before", b, "color-mix(in oklab, var(--fg-3) 70%, transparent)"],
                  ["after", a, "var(--accent)"],
                ] as const
              ).map(([side, v, fill]) => (
                <span key={side} className="grid grid-cols-[3rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{side === "before" ? "Before" : "After"}</span>
                  <span className="relative h-2.5">
                    {v !== null && v > 0 && (
                      <span
                        className="absolute inset-y-0 left-0 rounded-r-[4px]"
                        style={{ width: `${(v / top) * 100}%`, minWidth: 3, background: fill }}
                        onPointerMove={(e) => showTip(e, `${i.name}, ${side}: ${unit(v)}`)}
                        onPointerLeave={hideTip}
                      />
                    )}
                  </span>
                  <span className="text-right tabular-nums">{v === null ? "None done" : unit(v)}</span>
                </span>
              ))}
            </li>
          );
        })}
      </ul>
      <Tip tip={tip} />
      <table className="sr-only">
        <caption>{label}, before and after each solution</caption>
        <thead>
          <tr>
            <th scope="col">Solution</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {impacts.map((i) => (
            <tr key={i.id}>
              <th scope="row">{i.name}</th>
              <td>{value(i.before) === null ? "None done" : unit(value(i.before)!)}</td>
              <td>{value(i.after) === null ? "None done" : unit(value(i.after)!)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
