"use client";

// Facts from the run (issue #175, B17; decision D40): what the engine measured, shown as evidence. A fact is not a
// finding: nobody acknowledges or dismisses it, and it never reaches the map. AI reads these to propose findings, and
// each finding cites the ones it rests on. Hovering a fact lights up its step on the page's map.

import { useState } from "react";
import type { DetectedIssue } from "@transpera-flow/engine";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { headline, sourceOf } from "@/lib/insights/insights";
import { PayHidden } from "@/components/pay-hidden";
import { IssueCostText } from "@/components/money-hidden";

const DOT: Record<string, string> = { risk: "var(--rate-risk)", bad: "var(--rate-bad)", good: "var(--rate-good)", great: "var(--rate-great)" };

export function FactsList({
  facts,
  currency,
  stepName,
  onLight,
  initialLimit = 6,
}: {
  /** The run's facts, worst first; null while the run isn't in. */
  facts: readonly DetectedIssue[] | null;
  currency: string;
  stepName: (id: string) => string | null;
  onLight?: (stepIds: string[] | null) => void;
  initialLimit?: number;
}) {
  const [all, setAll] = useState(false);
  if (!facts)
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  if (!facts.length) return <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Nothing stands out in the latest run.</p>;
  const shown = all ? facts : facts.slice(0, initialLimit);
  return (
    <div className="flex flex-col gap-2" data-facts>
      <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
        {shown.map((f) => {
          const where = f.stepId ? stepName(f.stepId) : null;
          const said = headline(f.evidence);
          const light = f.stepId ? [f.stepId] : null;
          return (
            <li
              key={f.key}
              data-fact={f.key}
              tabIndex={light ? 0 : undefined}
              onMouseEnter={() => onLight?.(light)}
              onMouseLeave={() => onLight?.(null)}
              onFocus={() => onLight?.(light)}
              onBlur={() => onLight?.(null)}
              className="flex min-w-0 flex-col gap-0.5 px-4 py-2.5 text-sm outline-none focus-visible:bg-muted/50"
            >
              <span className="flex min-w-0 items-start gap-2">
                <i aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: DOT[f.rating] }} />
                <span className="min-w-0">
                  <span className="font-medium">{f.title}</span>
                  {said && said !== f.title && <span className="text-muted-foreground"> {said}</span>}
                </span>
              </span>
              <span className="flex flex-wrap gap-x-2.5 pl-4 text-xs text-muted-foreground">
                <span>{sourceOf(f).name}</span>
                {where && <span>{where}</span>}
                {f.cost.payHidden ? (
                  <PayHidden />
                ) : (
                  (f.cost.perMonth != null || f.cost.hoursPerMonth != null) && (
                    <span className="tabular-nums">
                      <IssueCostText cost={f.cost} currency={currency} />
                    </span>
                  )
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {facts.length > initialLimit && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${facts.length} facts`}
        </Button>
      )}
    </div>
  );
}
