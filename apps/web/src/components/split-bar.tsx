// The work split as a stacked bar (capacity P4, the prototype's `splitBar`): automatable, augmentable, stays manual, in the
// --auto / --aug / --man colours. Used on a step's map tile and in the inspector.

import type { StepSplit } from "@transpera-flow/db";
import { cn } from "@/lib/utils";

const pc = (v: number) => Math.round(v * 100);

/** The words for a screen reader and the hover title. */
export const splitTitle = (s: StepSplit): string => `Automatable ${pc(s.automatable)}% · Augmentable ${pc(s.augmentable)}% · Manual ${pc(s.manual)}%`;

export function SplitBar({ split, className }: { split: StepSplit; className?: string }) {
  const total = split.automatable + split.augmentable + split.manual || 1;
  const width = (v: number) => `${(v * 100) / total}%`;
  return (
    <div data-split-bar role="img" aria-label={splitTitle(split)} title={splitTitle(split)} className={cn("flex h-2 overflow-hidden rounded-full bg-panel-2", className)}>
      <i className="block h-full bg-auto" style={{ width: width(split.automatable) }} />
      <i className="block h-full bg-aug" style={{ width: width(split.augmentable) }} />
      <i className="block h-full bg-man" style={{ width: width(split.manual) }} />
    </div>
  );
}

/** The key to the three colours. */
export function SplitLegend({ className }: { className?: string }) {
  const item = (colour: string, label: string) => (
    <span className="inline-flex items-center gap-1">
      <i aria-hidden className={cn("size-2 rounded-full", colour)} />
      {label}
    </span>
  );
  return (
    <p className={cn("flex flex-wrap gap-x-3 text-xs text-fg-2", className)}>
      {item("bg-auto", "Automatable")}
      {item("bg-aug", "Augmentable")}
      {item("bg-man", "Stays manual")}
    </p>
  );
}
