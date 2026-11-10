"use client";

// "Team load by role" on the Overview (Q1 item 20; redesigned to the Overview option TL1): the action first, a red "Start hiring now" (or
// "Hire by <month>") when a role goes over its utilisation threshold, then one compact row per role with a cell for each month showing the
// percentage, green, amber or red against that role's own utilisation threshold. No hire and leave markers, no market bands and no
// uncovered-hours overlay: those live in the Sandbox.

import Link from "next/link";
import type { HiringAdvice } from "@transpera-flow/db";
import { How, toneOf, type Tone } from "@/components/capacity/widgets";
import { formatPercent } from "@/lib/format";
import type { TimelineMonth, TimelineRow } from "@/lib/forecast/timeline";
import { cn } from "@/lib/utils";

/** One hiring call: the action ("Start hiring now" or "Hire by Jan 27") and why ("SEO managers go over their utilisation threshold from Mar 27."). */
export interface HiringCall {
  action: string;
  why: string;
}

/**
 * The hiring calls from the Capacity page's hiring advice, soonest first: one for each role that goes over its utilisation threshold in the
 * run. None when no role does.
 */
export function hiringCalls(advice: readonly Pick<HiringAdvice, "name" | "overFrom" | "hireBy">[], monthName: (i: number) => string): HiringCall[] {
  return advice
    .filter((a) => a.overFrom !== null)
    .sort((a, b) => a.hireBy! - b.hireBy! || a.overFrom! - b.overFrom!)
    .map((a) => ({
      action: a.hireBy! <= 0 ? "Start hiring now" : `Hire by ${monthName(a.hireBy!)}`,
      why: `${a.name} ${a.overFrom === 0 ? "are over their utilisation threshold now" : `go over their utilisation threshold from ${monthName(a.overFrom!)}`}.`,
    }));
}

/** "How this works" for the team load: in its panel's header on the Overview. */
export const teamLoadHow = (span: string) => ({
  works: `How busy each role is, month by month over the next ${span}, in a simulation with planned hires and leave, against the role's own utilisation threshold. When a role goes over, the hire is due that month less the time it takes to hire (the Capacity page's hiring advice): "Start hiring now" when that is already here.`,
  tells: "Which team runs out of room first, and when to start hiring so the new person arrives in time.",
});

/** What a cell looks like at each tone: the percentage on a soft colour, a warning ringed, over in solid red. */
const CELL: Record<Tone, string> = {
  ok: "bg-good-soft text-fg",
  warn: "bg-warn-soft text-fg ring-1 ring-inset ring-warn",
  bad: "bg-crit text-crit-fg",
};

export function TeamLoad({
  rows,
  months,
  lines,
  fallbackLine,
  advice,
  span,
  sandboxHref,
  how = true,
}: {
  rows: readonly TimelineRow[];
  months: readonly TimelineMonth[];
  /** Each role's line, by role id; a role without one is held to `fallbackLine`. */
  lines: Readonly<Record<string, number>>;
  fallbackLine: number;
  /** The Capacity page's hiring advice for the same run; null when the workspace has no Set up data (then the sentence is worked out from the rows). */
  advice: readonly HiringAdvice[] | null;
  span: string;
  sandboxHref?: string;
  /** "How this works" under the chart; false when the panel shows it in its header. */
  how?: boolean;
}) {
  const lineOf = (id: string) => lines[id] ?? fallbackLine;
  const derived = rows.map((r) => {
    const first = r.series.findIndex((m) => m !== null && m.mean >= lineOf(r.id));
    return { name: r.name, overFrom: first < 0 ? null : first, hireBy: first < 0 ? null : first - 2 };
  });
  const calls = hiringCalls(advice ?? derived, (i) => months[i]?.short ?? `month ${i + 1}`);
  return (
    <div className="flex flex-col gap-3" data-team-load>
      {calls.length ? (
        <div role="note" className="flex flex-col gap-1 rounded-token border-l-4 border-crit bg-crit-soft px-3 py-2 text-sm" data-todo data-hire-callout>
          {calls.map((c) => (
            <p key={c.why}>
              <b className="font-semibold">{c.action}:</b> {c.why}
            </p>
          ))}
        </div>
      ) : (
        <p className="rounded-token border-l-4 border-good bg-good-soft px-3 py-2 text-sm" data-todo>
          No team goes over its utilisation threshold in the next {span}.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] border-separate border-spacing-y-1 text-xs" aria-label={`How busy each role is per month over the next ${span}, against its own utilisation threshold.`}>
          <thead>
            <tr>
              <th className="pr-3 text-left font-medium text-muted-foreground">
                <span className="sr-only">Role</span>
              </th>
              {months.map((m) => (
                <th key={m.index} scope="col" className="px-0.5 text-center font-medium text-muted-foreground">
                  {m.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const line = lineOf(r.id);
              return (
                <tr key={r.id} data-role={r.name}>
                  <th scope="row" className="max-w-[14rem] truncate pr-3 text-left font-medium">
                    {r.name}
                  </th>
                  {months.map((m, i) => {
                    const busy = r.series[i]?.mean ?? null;
                    const tone: Tone | null = busy === null ? null : toneOf(busy, line);
                    const words = busy === null ? "nobody in the role" : `${formatPercent(busy)} busy, against a utilisation threshold of ${formatPercent(line)}`;
                    return (
                      <td key={m.index} className="px-0.5">
                        <span
                          tabIndex={0}
                          role="img"
                          aria-label={`${r.name}, ${m.label}: ${words}`}
                          title={`${m.label}: ${words}`}
                          data-tone={tone ?? "none"}
                          data-busy={busy === null ? undefined : Math.round(busy * 100)}
                          className={cn(
                            "flex h-6 min-w-10 items-center justify-center rounded-sm text-2xs font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            tone ? CELL[tone] : "bg-panel-2 text-fg-3",
                          )}
                        >
                          <span aria-hidden>{busy === null ? "–" : formatPercent(busy)}</span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <i aria-hidden className={cn("size-2.5 rounded-sm", CELL.ok)} /> under the utilisation threshold
        </span>
        <span className="inline-flex items-center gap-1">
          <i aria-hidden className={cn("size-2.5 rounded-sm", CELL.warn)} /> within 10 points
        </span>
        <span className="inline-flex items-center gap-1">
          <i aria-hidden className={cn("size-2.5 rounded-sm", CELL.bad)} /> at or over
        </span>
        {sandboxHref && (
          <Link href={sandboxHref} className="underline">
            Open the Sandbox
          </Link>
        )}
      </p>
      {how && <How {...teamLoadHow(span)} />}
    </div>
  );
}
