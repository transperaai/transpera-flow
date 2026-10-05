"use client";

// "Findings by process" (issue #173, B15): "Across the company" first, then one collapsed row per process with its rating,
// its top finding and its counts. Opening a row shows all of that process's findings, with Acknowledge and Dismiss as
// anywhere else (the page renders them, so this list stays free of the issue store). A row's rating is the process's, as
// the map and the Processes table give it (its confirmed open issues); the top finding carries its own.

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { isActiveStatus } from "@transpera-flow/db";
import { RatingPill as ProcessRatingPill } from "@/components/processes/rating";
import { Skeleton } from "@/components/ui/skeleton";
import { COMPANY_GROUP, type FindingGroup } from "@/lib/overview/by-process";
import { cn } from "@/lib/utils";
import { RatingPill } from "./rating-pill";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether an open row has anything to list: insights, or issues logged by hand that are still open. */
export const hasOpenFindings = (g: Pick<FindingGroup, "insights" | "issues">): boolean => g.insights.length > 0 || g.issues.some((i) => !i.detected_key && isActiveStatus(i.status));

/** "2 open issues · 3 new insights · 1 solution in progress", leaving out the zeros (all zero: "Nothing open"). */
export function countsLine(g: Pick<FindingGroup, "openIssues" | "newInsights" | "solutionsInProgress">): string {
  const parts = [
    g.openIssues ? count(g.openIssues, "open issue") : "",
    g.newInsights ? count(g.newInsights, "new insight") : "",
    g.solutionsInProgress ? `${count(g.solutionsInProgress, "solution")} in progress` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing open";
}

export function FindingsByProcess({
  groups,
  renderFindings,
  initiallyOpen = [],
}: {
  /** Null while the first run is simulating. */
  groups: FindingGroup[] | null;
  /** What an open row shows: all of that group's findings. */
  renderFindings: (group: FindingGroup) => ReactNode;
  initiallyOpen?: readonly string[];
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initiallyOpen));
  if (!groups)
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <ul className="flex flex-col overflow-hidden rounded-xl border bg-card" data-findings-by-process>
      {groups.map((g) => {
        const expanded = open.has(g.id);
        const company = g.id === COMPANY_GROUP;
        const panel = `findings-${g.id}`;
        return (
          <li key={g.id} className="border-b last:border-b-0" data-findings-group={company ? "company" : g.id} data-expanded={expanded}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={expanded ? panel : undefined}
              onClick={() => toggle(g.id)}
              className={cn(
                "grid w-full grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2 px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                "sm:grid-cols-[1rem_minmax(9rem,14rem)_minmax(0,1fr)_auto] sm:items-center sm:gap-x-4",
              )}
            >
              <ChevronRight aria-hidden className={cn("mt-0.5 size-4 text-muted-foreground transition-transform sm:mt-0", expanded && "rotate-90")} />
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-semibold">{g.name}</span>
                <ProcessRatingPill rating={g.rating} />
              </span>
              <span className="col-start-2 mt-1 min-w-0 truncate text-sm text-muted-foreground sm:col-start-auto sm:mt-0" data-top-finding>
                {g.top ? (
                  <>
                    <RatingPill rating={g.top.rating} className="mr-1.5 align-middle" />
                    <span className="text-foreground">{g.top.title}</span>
                  </>
                ) : company ? (
                  "Nothing found across the company in this run"
                ) : (
                  "Nothing found in this run"
                )}
              </span>
              <span className="col-start-2 mt-0.5 text-xs text-muted-foreground tabular-nums sm:col-start-auto sm:mt-0 sm:text-right" data-counts>
                {countsLine(g)}
              </span>
            </button>
            {expanded && (
              <div id={panel} role="region" aria-label={`${g.name}: findings`} className="border-t bg-background/40 px-4 py-3" data-findings-panel>
                {company && <p className="mb-2 text-xs text-muted-foreground">How busy each role and person is, clients and churn, and the forecast: findings tied to no single process.</p>}
                {hasOpenFindings(g) ? renderFindings(g) : <p className="text-sm text-muted-foreground">Nothing open.</p>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
