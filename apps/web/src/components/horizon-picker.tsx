"use client";

// The time horizon picker (issue #123, A58; prototype: "Projection" segmented control): 1, 3, 6, 12 or 24 months.
// It picks how far ahead the simulation looks; the market schedule (A57) is read month by month over that span.
// The value is the run's length in weeks, so a workspace set to a length that isn't one of the options shows
// none selected and says how long it is.

import { useState } from "react";
import { Help } from "@/components/help";
import { HORIZON_MONTHS, horizonLabel, horizonWeeks } from "@/lib/horizon";
import { cn } from "@/lib/utils";

export function HorizonPicker({
  weeks,
  onChange,
  help = true,
  className,
  options = HORIZON_MONTHS,
  custom,
}: {
  /** The run's current length in weeks. */
  weeks: number;
  /** Told the months picked. */
  onChange: (months: number) => void;
  /** Show the (i) beside the label. The Overview leaves it out. Default true. */
  help?: boolean;
  className?: string;
  /** The months offered (default 1, 3, 6, 12, 24). The Sandbox offers 3, 6, 12, 24. */
  options?: readonly number[];
  /** Also offer a number field for any whole number of months in this range (the Sandbox: 1 to 24). Out of range is refused. */
  custom?: { min: number; max: number };
}) {
  const selected = options.find((m) => horizonWeeks(m) === weeks) ?? null;
  const months = Math.round((weeks * 12) / 52);
  const [typed, setTyped] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
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
        {options.map((m) => (
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
      {custom ? (
        <label className="flex items-center gap-1 text-muted-foreground">
          Custom
          <input
            type="number"
            inputMode="numeric"
            min={custom.min}
            max={custom.max}
            step={1}
            aria-label="Custom horizon in months"
            aria-invalid={refused || undefined}
            data-horizon-custom
            value={typed ?? (selected === null ? String(months) : "")}
            placeholder="months"
            onChange={(e) => {
              const text = e.target.value;
              setTyped(text);
              const n = Number(text);
              const ok = text.trim() !== "" && Number.isInteger(n) && n >= custom.min && n <= custom.max;
              setRefused(text.trim() !== "" && !ok);
              if (ok) onChange(n);
            }}
            onBlur={() => {
              setTyped(null);
              setRefused(false);
            }}
            className="h-7 w-16 rounded-md border border-border bg-background px-1.5 text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid]:border-destructive"
          />
          {refused ? (
            <span role="alert" className="text-destructive" data-horizon-refused>
              {custom.min} to {custom.max}
            </span>
          ) : null}
        </label>
      ) : (
        selected === null && <span className="text-muted-foreground">{weeks} weeks</span>
      )}
    </div>
  );
}
