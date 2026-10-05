"use client";

// "What the analysis found" (issue #100, A35): a count per rating. The AI read is components/ai/ai-read.tsx (A46).

import { RATING_LABELS, type DetectedIssue, type Rating } from "@transpera-flow/engine";
import { Skeleton } from "@/components/ui/skeleton";
import { ratingCounts } from "@/lib/overview/findings";

/** The findings can't be Great (a Great result isn't a problem), so the counts are of the other three. */
const COUNTED: readonly Rating[] = ["risk", "bad", "good"];

export function RatingCounts({ findings }: { findings: readonly Pick<DetectedIssue, "rating">[] | null }) {
  if (!findings) return <Skeleton className="h-5 w-72 max-w-full" />;
  const counts = ratingCounts(findings).filter((c) => COUNTED.includes(c.rating));
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {counts.map((c, i) => (
        <span key={c.rating} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          <i aria-hidden className="size-2 rounded-full" style={{ background: `var(--rate-${c.rating})` }} />
          <b className="font-semibold text-foreground tabular-nums">{c.count}</b> {RATING_LABELS[c.rating].toLowerCase()}
        </span>
      ))}
    </p>
  );
}
