import { Skeleton } from "@/components/ui/skeleton";
import { TALL_PANEL_CLASS } from "@/lib/map/zoom";

/**
 * What stands in for a process map while its code or data loads: the canvas frame (as `ProcessCanvas` draws it), a toolbar
 * strip and four step-card shapes in a row, joined by lines. `height` is the map area in px, `"fill"` for as tall as
 * the space given (the Editor), or `"tall"` for the Overview's company map (`TALL_PANEL_CLASS`, the same height the map
 * takes, so nothing moves when it arrives). `nested` leaves out the status wrapper, for a skeleton that is already one.
 */
export function MapSkeleton({ height = 360, nested = false }: { height?: number | "fill" | "tall"; nested?: boolean }) {
  const fill = height === "fill";
  const tall = height === "tall";
  return (
    <div
      {...(nested ? {} : { role: "status", "aria-label": "Loading the map", "data-loading": "map" })}
      className={`relative isolate flex min-w-0 flex-col rounded-lg border bg-card ${fill ? "min-h-[24rem] flex-1" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-2" aria-hidden>
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-20" />
      </div>
      <div
        className={`relative flex min-h-0 items-center justify-center overflow-hidden px-3 ${fill ? "flex-1" : tall ? TALL_PANEL_CLASS : ""}`}
        style={fill || tall ? undefined : { height }}
        aria-hidden
        data-map-area
      >
        <div className="flex flex-wrap items-center justify-center gap-y-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center">
              {i > 0 && <span className="w-8 border-t border-line-2 max-sm:hidden" />}
              <Skeleton className="h-14 w-40 rounded-token max-sm:mx-2" />
            </div>
          ))}
        </div>
      </div>
      {!nested && <span className="sr-only">Loading the map…</span>}
    </div>
  );
}

/**
 * The chip over a drawn map while its first run computes (issue #44). It sits where the diff legend does; the two never show
 * together, because a diff only exists in the Editor after a run.
 */
export function FirstRunStatus() {
  return (
    <p
      role="status"
      aria-live="polite"
      data-first-run
      className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5 rounded-token border border-line bg-panel/95 px-2 py-1 text-[11px] text-fg-2 shadow-token"
    >
      <i aria-hidden className="size-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
      Running the first simulation…
    </p>
  );
}
