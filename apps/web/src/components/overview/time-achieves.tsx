"use client";

// "What the time achieves" on the Overview (sandbox G, phase 4; redesigned to the Overview option TA1): the share of the team's hours that
// goes on client work, big, with a sparkline over the months, then one bar for the period by purpose. It reads the run the Overview already
// makes for its team load chart, so it costs no extra run.
//
// "Client work" is the two fixed purposes about clients: the client's job (`client_job`) and client upkeep (`client_upkeep`), whatever the
// workspace calls them. Both can be renamed but never removed, so the grouping holds in every workspace.

import Link from "next/link";
import { useMemo } from "react";
import type { MonthlyResult } from "@transpera-flow/engine";
import { CLIENT_JOB_PURPOSE, UPKEEP_PURPOSE, type PurposeCategory } from "@transpera-flow/db";
import { How } from "@/components/capacity/widgets";
import { timeAchievesHow } from "./how-texts";
import { purposeColor, TimeLegend } from "@/components/sandbox/time-chart";
import { formatNumber, formatPercent } from "@/lib/format";
import { timelineMonths } from "@/lib/forecast/timeline";
import { timeView } from "@/lib/sandbox/time";

/** The purposes that count as client work. */
export const CLIENT_WORK_PURPOSES: readonly string[] = [CLIENT_JOB_PURPOSE, UPKEEP_PURPOSE];

/** A line of the client-work share month by month, with a dot a month. */
function Sparkline({ values, label }: { values: readonly number[]; label: string }) {
  const W = 96;
  const H = 30;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(0.02, (hi - lo) * 0.2);
  const x = (i: number) => 4 + (i / Math.max(1, values.length - 1)) * (W - 8);
  const y = (v: number) => H - 4 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0" role="img" aria-label={label} data-client-sparkline>
      <title>{label}</title>
      <polyline points={values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} fill="none" className="stroke-cat-1" strokeWidth={2} />
      {values.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={2.5} className="fill-cat-1" />
      ))}
    </svg>
  );
}

export function TimeAchieves({
  monthly,
  hoursPerWeek,
  start,
  categories,
  sandboxHref,
  span,
  how = true,
}: {
  monthly: MonthlyResult;
  hoursPerWeek: number;
  start: string;
  categories: readonly PurposeCategory[];
  sandboxHref?: string;
  span: string;
  /** "How this works" under the chart; false when the panel shows it in its header. */
  how?: boolean;
}) {
  // Categories biggest first (so the biggest leads the bar and the legend), then Idle, then work nobody was there for.
  const view = useMemo(() => {
    const v = timeView(monthly, timelineMonths(start, monthly.months, hoursPerWeek), categories, { kind: "team" });
    const rank = (r: (typeof v.rows)[number]) => (r.kind === "uncovered" ? 2 : r.kind === "idle" ? 1 : 0);
    return { ...v, rows: [...v.rows].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? b.runShare - a.runShare : 0)) };
  }, [monthly, hoursPerWeek, start, categories]);
  if (!view.total.some((t) => t.mean > 0)) return <p className="text-sm text-muted-foreground" data-empty>The team has no hours in this run.</p>;

  const client = view.rows.filter((r) => r.kind === "category" && CLIENT_WORK_PURPOSES.includes(r.id));
  const period = client.reduce((a, r) => a + r.runShare, 0);
  const byMonth = view.months.map((_, m) => client.reduce((a, r) => a + (r.share[m] ?? 0), 0));
  const inBar = view.rows.filter((r) => r.kind !== "uncovered" && r.runShare > 0);
  return (
    <div className="flex flex-col gap-3" data-time-achieves>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-2xl leading-none font-semibold tabular-nums" data-client-share>
          {formatPercent(period)}
        </span>
        <span className="min-w-[10rem] flex-1 text-sm">of the team&apos;s hours go on client work over the next {span}</span>
        {byMonth.length > 1 && <Sparkline values={byMonth} label={`Client work share by month: ${view.months.map((mo, i) => `${mo.short} ${formatPercent(byMonth[i]!)}`).join(", ")}.`} />}
      </div>
      <div
        className="flex h-[18px] gap-0.5 overflow-hidden rounded-[5px]"
        role="img"
        aria-label={`The team's working time over the next ${span}: ${inBar.map((r) => `${r.name} ${formatPercent(r.runShare)}`).join(", ")}.`}
        data-period-bar
      >
        {inBar.map((r) => (
          <span
            key={r.id}
            className={r.kind === "idle" ? "block h-full min-w-[2px] shadow-[inset_0_0_0_1px_var(--line-2)]" : "block h-full min-w-[2px]"}
            style={{ flexGrow: r.runShare, flexBasis: 0, background: purposeColor(r.id, categories.map((c) => c.key)) }}
            title={`${r.name}: ${formatPercent(r.runShare)}, ${formatNumber(r.runHours, 0)} h over the ${span} (${view.months.map((mo, i) => `${mo.short} ${formatPercent(r.share[i] ?? 0)}`).join(", ")})`}
            data-part={r.id}
          />
        ))}
      </div>
      <TimeLegend rows={view.rows} shares />
      {how && <How {...timeAchievesHow(span, categories)} />}
      {sandboxHref ? (
        <p className="text-xs text-muted-foreground">
          <Link href={sandboxHref} className="underline">
            Open the Sandbox
          </Link>{" "}
          to see this by role or person, in hours, and to try a change.
        </p>
      ) : null}
    </div>
  );
}
