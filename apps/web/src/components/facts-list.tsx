"use client";

// Facts from the run (issue #175, B17; decision D40; leaner in Q3): what the engine measured, as read-only evidence. A fact is not an
// issue: nobody acknowledges or dismisses it, and it never reaches the map (log an issue by hand when one matters). The three worst
// show first, each one plain sentence with a coloured dot (lib/insights/fact-sentence.ts); the rest sit behind "Show all N" in the
// same one-line format. Hovering a fact lights up its step on the page's map.

import { useState } from "react";
import { RATING_LABELS, type DetectedIssue } from "@transpera-flow/engine";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { factSentence, type FactNames } from "@/lib/insights/fact-sentence";

const DOT: Record<string, string> = { risk: "var(--rate-risk)", bad: "var(--rate-bad)", good: "var(--rate-good)", great: "var(--rate-great)" };

/** How many facts show before "Show all". */
export const FACTS_SHOWN = 3;

export function FactsList({
  facts,
  names,
  onLight,
  initialLimit = FACTS_SHOWN,
}: {
  /** The run's facts, worst first; null while the run isn't in. */
  facts: readonly DetectedIssue[] | null;
  names: FactNames;
  onLight?: (stepIds: string[] | null) => void;
  initialLimit?: number;
}) {
  const [all, setAll] = useState(false);
  if (!facts)
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
        <p className="text-sm text-fg-2">Simulating…</p>
      </div>
    );
  if (!facts.length) return <p className="text-sm text-fg-2">Nothing stands out in the latest run.</p>;
  const shown = all ? facts : facts.slice(0, initialLimit);
  return (
    <div className="flex flex-col gap-2" data-facts>
      <ul className="flex flex-col divide-y divide-line">
        {shown.map((f) => {
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
              className="flex min-w-0 items-start gap-2 py-2.5 text-sm outline-none first:pt-0 focus-visible:bg-muted/50"
            >
              <i aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: DOT[f.rating] }} />
              <span className="min-w-0">
                <span className="sr-only">{RATING_LABELS[f.rating]}: </span>
                {factSentence(f, names)}
              </span>
            </li>
          );
        })}
      </ul>
      {facts.length > initialLimit && (
        <Button variant="ghost" size="sm" className="self-start" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${facts.length}`}
        </Button>
      )}
    </div>
  );
}
