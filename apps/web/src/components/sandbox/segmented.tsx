"use client";

// A segmented control for the Sandbox's toolbar and panels (docs/plans/ui-cleanup.md, `SegmentedControl`): `ui/toggle-group` with one option on.
// Each option stays a plain toggle button with `aria-pressed` (what the page has always said to a screen reader and what the tests read), not
// Radix's radio role; arrow keys still move between the options.

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  /** Extra attributes on the option's button (its `data-…` test hook). */
  attrs?: Record<`data-${string}`, string | number>;
  /** The option's accessible name, when its label alone is ambiguous on the page. */
  ariaLabel?: string;
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  className,
  ...rest
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange?: (v: T) => void;
  disabled?: boolean;
  className?: string;
} & ({ "aria-label": string } | { "aria-labelledby": string }) &
  Record<`data-${string}`, string | undefined>) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      role="group"
      value={String(value)}
      onValueChange={(v) => {
        if (!v || !onChange) return;
        const picked = options.find((o) => String(o.value) === v);
        if (picked) onChange(picked.value);
      }}
      disabled={disabled}
      className={cn("bg-panel", className)}
      {...rest}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={String(o.value)}
          value={String(o.value)}
          role="button"
          aria-checked={undefined}
          aria-pressed={o.value === value}
          aria-label={o.ariaLabel}
          className="text-xs tabular-nums aria-pressed:text-foreground"
          {...o.attrs}
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
