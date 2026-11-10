"use client";

// The one row above a list's table (Q9; the Processes page has the same shape): search on the left, filter dropdowns beside it, a "Clear
// filters" link when any filter is on, and the page's main action pushed to the right. It wraps onto more rows on a narrow screen.
// Everything in it is a view control, so it stays usable on a phone (`data-allow-on-phone`).

import { ChevronDown, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function Toolbar({ children, className, label = "Filter the list" }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role="toolbar" aria-label={label} data-list-toolbar data-allow-on-phone className={cn("flex flex-wrap items-center gap-x-2 gap-y-2", className)}>
      {children}
    </div>
  );
}

export function ToolbarSearch({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) {
  return (
    <div className="relative w-full min-w-0 sm:w-64" data-toolbar-search>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder={placeholder} className="pl-8" />
    </div>
  );
}

export function ClearFilters({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" data-clear-filters onClick={onClick} className="h-8 px-1 text-sm font-medium text-accent hover:underline">
      Clear filters
    </button>
  );
}

export interface FilterOption {
  value: string;
  label: string;
  /** How many rows have it; left out when the list can't count them (rows that load a page at a time). */
  count?: number;
  /** A colour dot before the label (a CSS colour). */
  dot?: string;
}

/**
 * A multi-select filter: a button naming the filter (and how many choices are on) that opens a list of tick boxes with the number of
 * rows each would show. Nothing ticked means no filter.
 */
export function FilterMenu({
  name,
  options,
  selected,
  onChange,
  help,
}: {
  name: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  help?: ReactNode;
}) {
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" data-filter={name.toLowerCase()} data-on={selected.length ? "true" : "false"}>
          {name}
          {selected.length > 0 && <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold text-accent-fg tabular-nums">{selected.length}</span>}
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-0.5 p-1.5" data-filter-menu={name.toLowerCase()}>
        <div className="px-2 py-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{name}</div>
        {options.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} data-option={o.value} />
            {o.dot && <i aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: o.dot }} />}
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.count !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{o.count}</span>}
          </label>
        ))}
        {/* After the options, so opening the menu doesn't focus the (i) and pop its text over them. */}
        {help && <div className="flex items-center justify-end px-1 pt-0.5 text-xs text-muted-foreground">What is this?{help}</div>}
      </PopoverContent>
    </Popover>
  );
}
