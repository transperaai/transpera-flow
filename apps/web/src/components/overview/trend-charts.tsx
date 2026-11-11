"use client";

// The Overview's trend charts (issue #173, B15), drawn by hand in SVG and CSS from the theme's tokens like the other
// Overview charts: thin marks with a 2px gap between touching ones, solid hairline grids, text in text colours, a legend for
// two or more series, a tooltip on hover and the same numbers in a table only a screen reader sees.
//
// - Open issues: the count and the operational risks, one bar by rating (the rating colours, which mean something) and the top processes.
// - Time split by process: hands-on against waiting, as shares of each process's elapsed time, slowest first.
// - Issues opened versus resolved per month.
// - Before and after per solution, one measure at a time (never two scales on one axis).
//
// This module is loaded on its own (next/dynamic), after the map and the cards.

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { How } from "@/components/capacity/widgets";
import { OPEN_ISSUES_HOW, TIME_SPLIT_HOW } from "./how-texts";
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
// Open issues (the Overview option OI1): the count, the operational risks, one bar by rating and the processes with the most
// ---------------------------------------------------------------------------------------------------------------------

/** How many processes "Most in" names before "and N more". */
export const TOP_PROCESSES = 3;

export function OpenIssuesSummary({
  byRating,
  byProcess,
  how = true,
}: {
  byRating: { rating: Rating; count: number }[];
  byProcess: { id: string; name: string; count: number; href?: string }[];
  /** "How this works" under the chart; false when the panel shows it in its header. */
  how?: boolean;
}) {
  const total = byRating.reduce((a, c) => a + c.count, 0);
  if (total === 0) return <p className="text-sm text-muted-foreground" data-empty>No open issues. Acknowledged insights and issues logged by hand show here while they are open.</p>;
  const risks = byRating.find((r) => r.rating === "risk")?.count ?? 0;
  const shown = byRating.filter((c) => c.count > 0);
  const ranked = byProcess.filter((p) => p.count > 0).sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, TOP_PROCESSES);
  const more = ranked.length - top.length;
  return (
    <div className="flex flex-col gap-3" data-open-issues>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <p>
          <span className="text-2xl leading-none font-semibold tabular-nums" data-open-total>
            {total}
          </span>{" "}
          <span className="text-sm text-muted-foreground">open</span>
        </p>
        <p data-risks>
          <span className={cn("text-xl leading-none font-semibold tabular-nums", risks > 0 ? "text-rate-risk" : "text-fg")}>{risks}</span>{" "}
          <span className="text-sm">{risks === 1 ? "operational risk" : "operational risks"}</span>
        </p>
      </div>
      <div className="flex h-4 gap-0.5 overflow-hidden rounded-[5px]" role="img" aria-label={`${total} open issues: ${shown.map((s) => `${s.count} ${RATING_LABELS[s.rating]}`).join(", ")}.`} data-rating-bar>
        {shown.map((s) => (
          <span
            key={s.rating}
            className="block h-full min-w-[3px]"
            style={{ flexGrow: s.count, flexBasis: 0, background: `var(--rate-${s.rating})` }}
            title={`${RATING_LABELS[s.rating]}: ${s.count} (${formatPercent(s.count / total)})`}
            data-arc={s.rating}
          />
        ))}
      </div>
      <Legend items={shown.map((s) => ({ key: s.rating, label: `${s.count} ${RATING_LABELS[s.rating]}`, swatch: swatch(`var(--rate-${s.rating})`) }))} />
      {top.length > 0 && (
        <p className="text-sm" data-by-process>
          <b className="font-semibold">Most in:</b>{" "}
          {top.map((p, i) => (
            <span key={p.id}>
              {i > 0 && " · "}
              {p.href ? (
                <Link href={p.href} className="text-accent hover:underline">
                  {p.name}
                </Link>
              ) : (
                p.name
              )}{" "}
              <span className="tabular-nums">{p.count}</span>
            </span>
          ))}
          {more > 0 && <span className="text-muted-foreground"> and {more} more</span>}
        </p>
      )}
      {how && <How {...OPEN_ISSUES_HOW} />}
      <div className="sr-only">
        <table>
          <caption>Open issues by rating and by process</caption>
          <tbody>
            {byRating.map((s) => (
              <tr key={s.rating}>
                <th scope="row">{RATING_LABELS[s.rating]}</th>
                <td>{s.count}</td>
              </tr>
            ))}
            {ranked.map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.name}</th>
                <td>{p.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Time split by process
// ---------------------------------------------------------------------------------------------------------------------

export const TIME_SPLIT_LEGEND = [
  { key: "handsOn", label: "Hands-on", swatch: swatch("var(--cat-1)") },
  { key: "person", label: "Waiting for one of our people", swatch: swatch("var(--series-other)") },
  { key: "others", label: "Waiting on the client or others", swatch: swatch(HATCH, "border border-fg-3") },
];

/** Slowest first: the smallest hands-on share (most of the time waiting) at the top. */
export const slowestFirst = <R extends { share: number }>(rows: readonly R[]): R[] => [...rows].sort((a, b) => a.share - b.share);

export function TimeSplitChart({
  rows: given,
  months,
  how = true,
}: {
  rows: ProcessTimeSplit[];
  /** The run's length in months, for hours a month in the tooltip. */
  months: number;
  /** "How this works" under the chart; false when the panel shows it in its header. */
  how?: boolean;
}) {
  const [tip, showTip, hideTip] = useTip();
  if (!given.length) return <p className="text-sm text-muted-foreground" data-empty>No work went through any process in this run.</p>;
  const rows = slowestFirst(given);
  const perMonth = (h: number) => `${formatNumber(h / Math.max(months, 1e-9), h / months < 10 ? 1 : 0)} h`;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm" data-time-split-answer>
        <b className="font-semibold">Slowest: {rows[0]!.name}</b>, worked on {formatPercent(rows[0]!.share)} of the time work is in it.
      </p>
      <Legend items={TIME_SPLIT_LEGEND} />
      <ul className="grid grid-cols-1 gap-x-10 gap-y-2 @3xl:grid-cols-2" data-time-split>
        {rows.map((r) => {
          const total = totalOf(r);
          const parts = [
            { key: "handsOn", v: r.handsOn, style: { background: "var(--cat-1)" } },
            { key: "person", v: r.waitingForPerson, style: { background: "var(--series-other)" } },
            { key: "others", v: r.waitingOnOthers, style: { backgroundImage: HATCH, boxShadow: "inset 0 0 0 1px var(--fg-3)" } },
          ];
          const body = (
            <>
              <p className="font-medium">{r.name}</p>
              <p className="tabular-nums">
                {formatPercent(r.share)} hands-on: {perMonth(r.handsOn)} a month
              </p>
              <p className="text-muted-foreground tabular-nums">
                Waiting for one of our people {perMonth(r.waitingForPerson)}, on the client or others {perMonth(r.waitingOnOthers)}
              </p>
            </>
          );
          return (
            <li
              key={r.id}
              className="grid grid-cols-[minmax(6rem,14rem)_minmax(0,1fr)_5.5rem] items-center gap-3 text-sm"
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
              <span className="text-right text-xs whitespace-nowrap tabular-nums">
                <b className="font-semibold">{formatPercent(r.share)}</b> working
              </span>
            </li>
          );
        })}
      </ul>
      {how && <How {...TIME_SPLIT_HOW} />}
      <Tip tip={tip} />
      <div className="sr-only">
        <table>
          <caption>Hands-on against waiting, by process, in hours a month</caption>
          <thead>
            <tr>
              <th scope="col">Process</th>
              <th scope="col">Hands-on share</th>
              <th scope="col">Hands-on</th>
              <th scope="col">Waiting for one of our people</th>
              <th scope="col">Waiting on the client or others</th>
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
    </div>
  );
}
