"use client";

// "What the time achieves" on the Overview (sandbox G, phase 4): the team's working time by purpose over the horizon, month by month. It reads the
// run the Overview already makes for its team load chart, so it costs no extra run.

import Link from "next/link";
import { useMemo } from "react";
import type { MonthlyResult } from "@transpera-flow/engine";
import type { PurposeCategory } from "@transpera-flow/db";
import { TimeChart, TimeLegend } from "@/components/sandbox/time-chart";
import { formatPercent } from "@/lib/format";
import { timelineMonths } from "@/lib/forecast/timeline";
import { timeView } from "@/lib/sandbox/time";

export function TimeAchieves({ monthly, hoursPerWeek, start, categories, sandboxHref, span }: { monthly: MonthlyResult; hoursPerWeek: number; start: string; categories: readonly PurposeCategory[]; sandboxHref?: string; span: string }) {
  const view = useMemo(() => timeView(monthly, timelineMonths(start, monthly.months, hoursPerWeek), categories, { kind: "team" }), [monthly, hoursPerWeek, start, categories]);
  if (!view.total.some((t) => t.mean > 0)) return <p className="text-sm text-muted-foreground" data-empty>The team has no hours in this run.</p>;
  return (
    <div className="flex flex-col gap-3" data-time-achieves>
      <TimeLegend rows={view.rows} />
      <TimeChart view={view} label={`What the team's time achieves each month over the next ${span}: ${view.rows.filter((r) => r.runShare > 0).map((r) => `${r.name} ${formatPercent(r.runShare)}`).join(", ")}.`} />
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
