"use client";

// "Team load by role" on the Overview (Q1 item 20), simplified: what to do first, in the Capacity page's words, then one compact row per role with a cell for each month,
// green, amber or red against that role's own line. The percentage is in each cell's tooltip and read out for focus. No hire and leave markers, no market bands and no
// uncovered-hours overlay: those live in the Sandbox.

import Link from "next/link";
import type { HiringAdvice } from "@transpera-flow/db";
import { TONE_BG, toneOf, type Tone } from "@/components/capacity/widgets";
import { formatPercent } from "@/lib/format";
import type { TimelineMonth, TimelineRow } from "@/lib/forecast/timeline";
import { cn } from "@/lib/utils";

/**
 * The "What to do" sentences from the Capacity page's hiring advice: "Performance managers: over the line from Mar 27. Start hiring by Jan 27.",
 * or, with nobody over, "No team goes over its line in the next 3 months." (`span` is "3 months").
 */
export function whatToDo(advice: readonly Pick<HiringAdvice, "name" | "overFrom" | "hireBy">[], monthName: (i: number) => string, span: string): string[] {
  const over = advice.filter((a) => a.overFrom !== null);
  if (!over.length) return [`No team goes over its utilisation threshold in the next ${span}.`];
  return over.map((a) => {
    const from = a.overFrom === 0 ? "over the utilisation threshold now" : `over the utilisation threshold from ${monthName(a.overFrom!)}`;
    const hire = a.hireBy! <= 0 ? "Start hiring now" : `Start hiring by ${monthName(a.hireBy!)}`;
    return `${a.name}: ${from}. ${hire}.`;
  });
}

export function TeamLoad({
  rows,
  months,
  lines,
  fallbackLine,
  advice,
  span,
  sandboxHref,
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
}) {
  const lineOf = (id: string) => lines[id] ?? fallbackLine;
  const derived = rows.map((r) => {
    const first = r.series.findIndex((m) => m !== null && m.mean >= lineOf(r.id));
    return { name: r.name, overFrom: first < 0 ? null : first, hireBy: first < 0 ? null : first - 2 };
  });
  const sentences = whatToDo(advice ?? derived, (i) => months[i]?.short ?? `month ${i + 1}`, span);
  return (
    <div className="flex flex-col gap-3" data-team-load>
      <ul className="flex flex-col gap-1 text-sm" data-todo>
        {sentences.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
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
                          className={cn("block h-6 min-w-8 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", tone ? TONE_BG[tone] : "bg-panel-2")}
                        />
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
          <i aria-hidden className="size-2.5 rounded-sm bg-good" /> under the utilisation threshold
        </span>
        <span className="inline-flex items-center gap-1">
          <i aria-hidden className="size-2.5 rounded-sm bg-warn" /> within 10 points
        </span>
        <span className="inline-flex items-center gap-1">
          <i aria-hidden className="size-2.5 rounded-sm bg-crit" /> at or over
        </span>
        {sandboxHref && (
          <Link href={sandboxHref} className="underline">
            Open the Sandbox
          </Link>
        )}
      </p>
    </div>
  );
}
