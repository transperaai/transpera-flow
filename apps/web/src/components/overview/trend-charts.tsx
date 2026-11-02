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

import { useState, type ReactNode } from "react";
import { FloatingTip } from "@/components/ui/floating-tip";
import { RATING_LABELS, type Rating } from "@transpera-flow/engine";
import { formatNumber, formatPercent } from "@/lib/format";
import { totalOf, type ProcessTimeSplit } from "@/lib/overview/health";
import { cn } from "@/lib/utils";

interface TipState {
  x: number;
  y: number;
  body: ReactNode;
}

/**
 * A tooltip that follows the pointer: `show` from a mark's pointer move, `hide` on leave, and `<Tip>` draws it in a portal
 * on the page (FloatingTip), so no card or scrolling box around the chart can cut it off.
 */
function useTip(): [TipState | null, (e: React.PointerEvent, body: ReactNode) => void, () => void] {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = (e: React.PointerEvent, body: ReactNode) => setTip({ x: e.clientX, y: e.clientY, body });
  const hide = () => setTip(null);
  return [tip, show, hide];
}

function Tip({ tip }: { tip: TipState | null }) {
  return (
    <FloatingTip at={tip} className="max-w-56">
      {tip?.body}
    </FloatingTip>
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
  const [tip, showTip, hideTip] = useTip();
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
    <div className="flex flex-col gap-4">
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
  const [tip, showTip, hideTip] = useTip();
  if (!rows.length) return <p className="text-sm text-muted-foreground" data-empty>No work went through any process in this run.</p>;
  const perMonth = (h: number) => `${formatNumber(h / Math.max(months, 1e-9), h / months < 10 ? 1 : 0)} h`;
  return (
    <div className="flex flex-col gap-3">
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
