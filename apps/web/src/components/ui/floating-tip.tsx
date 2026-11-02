"use client";

// One shared pop-up for pointer-following chart tooltips. It is drawn in a portal on `document.body` with fixed
// positioning from the pointer's client coordinates, so no ancestor's `overflow: hidden` or `auto` can cut it off.
// It flips to the other side of the pointer when it would run off the screen and is clamped inside the viewport.
// Hover text on a control uses the Radix Tooltip, and a click-pinned bubble uses the Popover; both already portal.

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** The gap between the pointer and the pop-up, and the least it keeps from the viewport's edge. */
const OFFSET = 12;
const MARGIN = 8;

export interface FloatingTipProps {
  /** The pointer's client coordinates (`e.clientX`, `e.clientY`); null hides the pop-up. */
  at: { x: number; y: number } | null;
  /** "above": centred over the pointer (below it when there is no room). "side": to its right (left when there is no room). */
  placement?: "above" | "side";
  className?: string;
  children: ReactNode;
}

/** Where a w by h box goes for a pointer at `at` in a viewport of `view`. Exported for tests. */
export function placeTip(at: { x: number; y: number }, size: { w: number; h: number }, view: { w: number; h: number }, placement: "above" | "side"): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  let left: number;
  let top: number;
  if (placement === "above") {
    left = at.x - size.w / 2;
    top = at.y - size.h - OFFSET;
    if (top < MARGIN) top = at.y + OFFSET;
  } else {
    left = at.x + OFFSET;
    if (left + size.w > view.w - MARGIN) left = at.x - size.w - OFFSET;
    top = at.y - size.h / 2;
  }
  return { left: clamp(left, MARGIN, view.w - size.w - MARGIN), top: clamp(top, MARGIN, view.h - size.h - MARGIN) };
}

export function FloatingTip({ at, placement = "above", className, children }: FloatingTipProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Measured and placed before the browser paints, so it never shows at the wrong spot.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !at) return;
    const { width, height } = el.getBoundingClientRect();
    const { left, top } = placeTip(at, { w: width, h: height }, { w: window.innerWidth, h: window.innerHeight }, placement);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });
  if (!at || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role="presentation"
      data-chart-tip
      className={cn("pointer-events-none fixed top-0 left-0 z-50 w-max max-w-64 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md", className)}
    >
      {children}
    </div>,
    document.body,
  );
}
