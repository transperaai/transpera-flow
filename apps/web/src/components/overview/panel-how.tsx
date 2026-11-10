"use client";

// "How this works" for an Overview panel, as a small (?) in the panel's header instead of a line of text under every chart
// (docs/plans/ui-cleanup.md). The same words as the Capacity page's `How`. The text floats over the page instead of pushing the
// panel down; it stays inside `[data-how]` in the DOM (no portal) and is positioned `fixed`, so a card's `overflow-hidden` doesn't
// clip it. Escape, or a click elsewhere, closes it.

import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export interface HowText {
  works: ReactNode;
  tells: ReactNode;
}

export function PanelHow({ works, tells, className }: HowText & { className?: string }) {
  return (
    <span className={cn("inline-flex", className)} data-how>
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger
          title="How this works"
          className="grid size-6 cursor-pointer place-items-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-fg"
        >
          <CircleHelp aria-hidden className="size-4" />
          <span className="sr-only">How this works</span>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          collisionPadding={16}
          className="z-50 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-line bg-popover p-3 text-xs text-muted-foreground shadow-md outline-hidden"
          data-how-text
        >
          <p className="max-w-prose">{works}</p>
          <p className="mt-1.5 max-w-prose">
            <b className="font-semibold text-fg">What it tells you:</b> {tells}
          </p>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Root>
    </span>
  );
}

/** A panel header's right-hand side: its own controls or link, then the (?) last. */
export function PanelActions({ children, how }: { children?: ReactNode; how?: HowText }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      {how && <PanelHow {...how} />}
    </div>
  );
}
