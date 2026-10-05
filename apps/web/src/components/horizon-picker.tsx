"use client";

// The time horizon picker (issue #123, A58; prototype: "Projection" segmented control): 1, 3, 6, 12 or 24 months.
// It picks how far ahead the simulation looks; the market schedule (A57) is read month by month over that span.
// The value is the run's length in weeks, so a workspace set to a length that isn't one of the options shows
// none selected and says how long it is.

import { Help } from "@/components/help";
import { HORIZON_MONTHS, horizonLabel, horizonWeeks, monthsForWeeks } from "@/lib/horizon";
import { cn } from "@/lib/utils";

export function HorizonPicker({
  weeks,
  onChange,
  help = true,
  className,
}: {
  /** The run's current length in weeks. */
  weeks: number;
  /** Told the months picked. */
  onChange: (months: number) => void;
  /** Show the (i) beside the label. The Overview leaves it out. Default true. */
  help?: boolean;
  className?: string;
}) {
  const selected = monthsForWeeks(weeks);
  return (
    <div className={cn("flex items-center gap-2 text-xs", className)}>
      <span className="flex items-center font-medium text-fg-2">
        Projection
        {help && (
          <Help
            label="Projection"
            description="How far ahead the simulation looks. Longer shows slower effects such as clients leaving and market changes, but takes a little longer to run."
            example="6m shows the next 6 months. 24m shows two years, including a market change planned for month 18."
          />
        )}
      </span>
      <div role="group" aria-label="Time horizon" className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
        {HORIZON_MONTHS.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={selected === m}
            aria-label={horizonLabel(m)}
            title={`${horizonLabel(m)} (${horizonWeeks(m)} weeks)`}
            onClick={() => onChange(m)}
            className={cn(
              "rounded-md px-2.5 py-1 font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected === m ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {m}m
          </button>
        ))}
      </div>
      {selected === null && <span className="text-muted-foreground">{weeks} weeks</span>}
    </div>
  );
}
