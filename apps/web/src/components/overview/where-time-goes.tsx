"use client";

// "Where the time goes" on the Overview (the Overview option WT1): one stacked bar per department of its people's hours a month in a
// simulation of today's clients, by process or by purpose, every name in the same colour in every bar (the Capacity page's palette).
// Hover a segment for its hours; the bar's label reads them all out.

import { useMemo, useState } from "react";
import { SectionCard } from "@/components/page-kit";
import { Skeleton } from "@/components/ui/skeleton";
import { purposeColours } from "@/lib/capacity/purposes";
import { formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DepartmentFigure } from "./department-cards";
import { PanelActions } from "./panel-how";

type By = "process" | "purpose";
const f0 = (v: number) => formatNumber(v, 0);

const WHERE_HOW = {
  works:
    "Every hour each department's people spend on steps in a simulation of today's clients, a month, grouped by the process the step is in or by what it achieves (its purpose). Hand-holding is its own part. A name keeps its colour in every bar; hover a segment for its hours.",
  tells: "What each department's hours are spent on, and how the departments compare.",
};

export function WhereTimeGoes({ rows, failed, className }: { rows: readonly DepartmentFigure[]; failed: boolean; className?: string }) {
  const [by, setBy] = useState<By>("process");
  const ready = rows.length > 0 && rows.every((r) => r.run);
  const bars = useMemo(() => (ready ? rows.map((r) => ({ id: r.id, name: r.name, ...r.run!.time[by] })) : []), [ready, rows, by]);
  const colours = useMemo(() => purposeColours(bars.map((b) => b.parts.map((p) => ({ key: p.name, name: p.name, value: p.hours })))), [bars]);
  const answer = bars
    .filter((b) => b.parts.length)
    .map((b) => `${b.name} spends most on ${b.parts[0]!.name} (${formatPercent(b.parts[0]!.share)})`)
    .join("; ");
  return (
    <SectionCard
      id="where-time-goes"
      section="where-time-goes"
      level={3}
      title="Where the time goes"
      className={className}
      description={ready ? (answer ? `${answer}.` : "No hours in the run.") : failed ? "Can't be worked out until the simulation runs." : "Working out where the time goes, from a simulation of today's clients…"}
      action={
        <PanelActions how={ready ? WHERE_HOW : undefined}>
        <div role="group" aria-label="Group the time" className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs" data-time-by>
          {(["process", "purpose"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={by === k}
              onClick={() => setBy(k)}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                by === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "process" ? "By process" : "By purpose"}
            </button>
          ))}
        </div>
        </PanelActions>
      }
    >
      {ready ? (
        <div className="flex flex-col gap-3" data-time>
          <div className="flex flex-col gap-3">
            {bars.map((b) => (
              <div key={b.id} className="flex flex-col gap-1" data-department-time={b.name}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <b className="font-semibold">{b.name}</b>
                  <span className="text-xs text-muted-foreground tabular-nums" data-time-total>
                    {f0(b.total)} h a month
                  </span>
                </div>
                {b.parts.length ? (
                  <div
                    className="flex h-4 gap-0.5 overflow-hidden rounded-[5px]"
                    role="img"
                    aria-label={`${b.name}, hours a month ${by === "process" ? "by process" : "by purpose"}: ${b.parts.map((p) => `${p.name} ${f0(p.hours)} h (${formatPercent(p.share)})`).join(", ")}.`}
                  >
                    {b.parts.map((p) => (
                      <span
                        key={p.name}
                        className="block h-full min-w-[2px]"
                        style={{ flexGrow: p.hours, flexBasis: 0, background: colours.get(p.name) }}
                        title={`${p.name}: ${f0(p.hours)} h a month (${formatPercent(p.share)})`}
                        data-part={p.name}
                        data-hours={Math.round(p.hours)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No hours in the run.</p>
                )}
              </div>
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground" data-legend>
            {[...colours].map(([name, colour]) => (
              <li key={name} className="flex items-center gap-1.5">
                <i aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: colour }} />
                {name}
              </li>
            ))}
          </ul>
        </div>
      ) : failed ? null : (
        <Skeleton className="h-24 w-full" aria-busy="true" />
      )}
    </SectionCard>
  );
}
