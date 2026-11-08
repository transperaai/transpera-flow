"use client";

import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** The theme token a pill is drawn in (`--auto`, `--warn`, `--good`, `--fg-3`, `--line-2`, ...). */
export type PillTone = string;

export interface PillOption<V extends string = string> {
  value: V;
  label: string;
  tone: PillTone;
}

const BASE = "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap text-foreground";
const tint = (tone: PillTone) => `color-mix(in srgb, var(--${tone}) 18%, transparent)`;

/**
 * A status as a pill: a dot in the status's colour on a soft tint of it, with the words in the normal text colour so it reads in light and
 * dark. The one pill the Issues list, the Issue page and the Solution page share; `value` becomes `data-status`.
 */
export function StatusPill({ label, tone, value, className }: { label: string; tone: PillTone; value?: string; className?: string }) {
  return (
    <span data-status={value} className={cn(BASE, className)} style={{ background: tint(tone) }}>
      <i aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: `var(--${tone})` }} />
      {label}
    </span>
  );
}

/**
 * The same pill as a dropdown: pressing it lists the choices and choosing one calls `onChange` at once (the caller saves). Readers get
 * the plain pill. `name` says what the pill is for ("Status"), to a screen reader.
 */
export function StatusPillMenu<V extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  name: string;
  value: V;
  options: readonly PillOption<V>[];
  onChange: (next: V) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value) ?? { value, label: value, tone: "fg-3" };
  if (disabled) return <StatusPill label={current.label} tone={current.tone} value={value} className={className} />;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-status={value}
          data-status-menu={name.toLowerCase()}
          aria-label={`${name}: ${current.label}. Change`}
          className={cn(BASE, "cursor-pointer hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", className)}
          style={{ background: tint(current.tone) }}
        >
          <i aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: `var(--${current.tone})` }} />
          {current.label}
          <ChevronDown aria-hidden className="size-3 text-fg-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 gap-0.5 p-1.5" data-status-options={name.toLowerCase()}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            data-option={o.value}
            aria-pressed={o.value === value}
            onClick={() => {
              setOpen(false);
              if (o.value !== value) onChange(o.value);
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
          >
            <i aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: `var(--${o.tone})` }} />
            <span className="flex-1">{o.label}</span>
            {o.value === value && <Check aria-hidden className="size-3.5 text-fg-2" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
