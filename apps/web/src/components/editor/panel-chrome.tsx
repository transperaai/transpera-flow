"use client";

// The controls on the Editor's side panels: the button that folds a panel to a narrow rail (and opens it again), and the
// handle on the inspector's inner edge that drags its width. Both are for wide screens only: under 1024px the panels stack
// above and below the map and are always open.

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { INSPECTOR_MAX, INSPECTOR_MIN } from "./use-panel-layout";

/** The fold button at the top of a side panel. Folded, the panel is a rail holding just this (and a dot when something there needs a look). */
export function PanelToggle({ side, collapsed, onToggle, label, alert = false }: { side: "left" | "right"; collapsed: boolean; onToggle: () => void; label: string; alert?: boolean }) {
  const Icon = side === "left" ? (collapsed ? PanelLeftOpen : PanelLeftClose) : collapsed ? PanelRightOpen : PanelRightClose;
  const action = `${collapsed ? "Show" : "Hide"} the ${label}`;
  return (
    <div className={cn("hidden h-10 shrink-0 items-center px-1.5 lg:flex", collapsed ? "justify-center" : side === "left" ? "justify-end" : "justify-start")}>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onToggle} aria-label={action} title={action} aria-expanded={!collapsed} data-panel-toggle={label} className="relative text-muted-foreground">
        <Icon aria-hidden />
        {collapsed && alert && <span aria-hidden className="absolute top-0.5 right-0.5 size-2 rounded-full bg-crit" />}
      </Button>
    </div>
  );
}

const STEP = 16;

/** The drag handle on the inspector's left edge: drag, or focus it and use the arrow keys, between 320 and 420px. */
export function PanelResizer({ width, onWidth }: { width: number; onWidth: (px: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The handle is on the panel's left edge: dragging left widens it.
    onWidth(drag.current.width + (drag.current.x - e.clientX));
  };
  const end = () => {
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") onWidth(width + STEP);
    else if (e.key === "ArrowRight") onWidth(width - STEP);
    else if (e.key === "Home") onWidth(INSPECTOR_MIN);
    else if (e.key === "End") onWidth(INSPECTOR_MAX);
    else return;
    e.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Inspector width"
      aria-valuemin={INSPECTOR_MIN}
      aria-valuemax={INSPECTOR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      data-panel-resizer
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none hover:bg-edit/30 focus-visible:bg-edit/40 lg:block"
    />
  );
}
