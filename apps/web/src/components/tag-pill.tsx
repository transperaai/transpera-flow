// The small pill that names a process's category: on a card of the company map and in the process page's header (Q8), so both read the same.

import { cn } from "@/lib/utils";

export function TagPill({ tag, className }: { tag: string; className?: string }) {
  return (
    <span data-process-tag className={cn("inline-block max-w-full truncate rounded-full border border-line bg-panel px-2 text-2xs leading-4 font-medium text-fg-2", className)}>
      {tag}
    </span>
  );
}
