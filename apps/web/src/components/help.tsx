"use client";

// The (i) help button (issue #98): a small "i" that explains a setting, lever or rule in plain words, with an
// example. Hover or focus shows it; a click, tap, Enter or Space pins it open; Escape closes it. The button
// swallows its click, so putting it inside a switch's label or row never toggles the switch.

import { useId, useReducer, type MouseEvent, type PointerEvent } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HELP_CLOSED, helpStep, type HelpEvent } from "@/lib/shell/help-state";
import { cn } from "@/lib/utils";

export interface HelpProps {
  /** What it is about, for the button's accessible name: "Availability floor" gives "About Availability floor". */
  label: string;
  /** Plain English: what this does, in a sentence or two. */
  description: string;
  /** A concrete example, shown after "Example". */
  example: string;
  className?: string;
}

export function Help({ label, description, example, className }: HelpProps) {
  const [state, send] = useReducer(helpStep, HELP_CLOSED);
  const textId = useId();
  const mouse = (e: PointerEvent) => e.pointerType === "mouse" || e.pointerType === "pen";
  const activate = (e: MouseEvent) => {
    // Inside a label or a clickable row this must not toggle the control next to it.
    e.preventDefault();
    e.stopPropagation();
    send("activate");
  };
  const on = (event: HelpEvent) => () => send(event);
  return (
    <>
      {/* Always in the page, so a screen reader hears it whether or not the popover is open. */}
      <span id={textId} className="sr-only">
        {description} Example: {example}
      </span>
      <Popover open={state.open} onOpenChange={(o) => !o && send("outside")}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          aria-describedby={textId}
          data-slot="help"
          className={cn(
            "ml-1 inline-grid size-[18px] shrink-0 cursor-help place-items-center rounded-full border-[1.5px] border-fg-3 bg-panel align-middle font-serif text-2xs leading-none font-bold text-fg-2 italic",
            "outline-none hover:border-accent hover:bg-accent hover:text-accent-fg focus-visible:border-accent focus-visible:bg-accent focus-visible:text-accent-fg focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-accent data-[state=open]:bg-accent data-[state=open]:text-accent-fg",
            className,
          )}
          onClick={activate}
          onPointerEnter={(e) => mouse(e) && send("pointer-enter")}
          onPointerLeave={(e) => mouse(e) && send("pointer-leave")}
          onFocus={on("focus")}
          onBlur={on("blur")}
          onKeyDown={(e) => e.key === "Escape" && send("escape")}
        >
          <span aria-hidden>i</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="center"
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-24px)] gap-1.5 text-sm leading-snug font-normal tracking-normal normal-case"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={on("outside")}
      >
        <span>{description}</span>
        <span className="text-fg-2">
          <b className="mr-1 text-2xs font-semibold tracking-wider text-accent uppercase">Example</b>
          {example}
        </span>
      </PopoverContent>
    </Popover>
    </>
  );
}

/** A small label with its (i), for a control that is not drawn by one of the field components (an add form, a dialog). */
export function HelpLabel({ label, description, example, className }: HelpProps) {
  return (
    <span className={cn("flex items-center text-xs font-medium text-fg-2", className)}>
      {label}
      <Help label={label} description={description} example={example} />
    </span>
  );
}
