"use client";

// Controls and legend for the process map (issue #99): zoom in, zoom out, fit and full screen on the map, and the four
// rating colours (plus the red badge) with their plain names.

import type { CSSProperties } from "react";
import { ControlButton, Controls, useStore } from "@xyflow/react";
import { Maximize2, Minimize2, Minus, Plus, Scan } from "lucide-react";
import { RATING_LABELS } from "@transpera-flow/engine";
import { LEGEND_ORDER, RATING_STYLE } from "@/lib/map/rating";
import { MAX_ZOOM, MIN_ZOOM, zoomLabel } from "@/lib/map/zoom";

/**
 * The buttons on the map itself (issue #99, moved onto the map for Austin's "centre the screen" ask): zoom in, zoom out, fit
 * (frame the whole map, never smaller than 70%), and, where offered, full screen; the zoom under them. React Flow's own
 * `Controls` panel with our buttons in it (its built-in zoom and fit would bypass the map's framing, and its lock toggle is
 * not wanted), styled from the tokens in `styles/map-controls.css`. Reading actions, so they stay on a phone.
 *
 * The only part of the map that reads the zoom (issue #249): so a zoom or fit animation re-renders these buttons, not the
 * canvas, its tiles or its lines. Inside the map's ReactFlowProvider.
 */
export function MapViewControls({
  onOut,
  onFit,
  onIn,
  fullscreen = null,
  className,
  style,
}: {
  onOut: () => void;
  onFit: () => void;
  onIn: () => void;
  /** The full-screen toggle and whether the map is on the full screen now; null leaves the button out. */
  fullscreen?: { on: boolean; toggle: () => void } | null;
  className?: string;
  style?: CSSProperties;
}) {
  const zoom = useStore((s) => s.transform[2]);
  // At the smallest or largest zoom the button does nothing.
  const canOut = zoom > MIN_ZOOM + 0.001;
  const canIn = zoom < MAX_ZOOM - 0.001;
  return (
    <Controls
      position="bottom-right"
      showZoom={false}
      showFitView={false}
      showInteractive={false}
      aria-label="Map view"
      className={className}
      style={style}
    >
      <ControlButton onClick={onIn} disabled={!canIn} aria-label="Zoom in" title="Zoom in" data-map-zoom="in">
        <Plus aria-hidden />
      </ControlButton>
      <ControlButton onClick={onOut} disabled={!canOut} aria-label="Zoom out" title="Zoom out" data-map-zoom="out">
        <Minus aria-hidden />
      </ControlButton>
      <ControlButton onClick={onFit} aria-label="Fit the map to view" title="Fit the map to view (never smaller than 70%)" data-map-zoom="fit">
        <Scan aria-hidden />
      </ControlButton>
      {fullscreen && (
        <ControlButton
          onClick={fullscreen.toggle}
          aria-label={fullscreen.on ? "Exit full screen" : "Full screen"}
          aria-pressed={fullscreen.on}
          title={fullscreen.on ? "Exit full screen (Esc)" : "Show the map on the full screen"}
          data-map-zoom="fullscreen"
        >
          {fullscreen.on ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
        </ControlButton>
      )}
      <span className="map-controls-zoom" aria-live="polite" title="Current zoom" data-map-zoom-level>
        {zoomLabel(zoom)}
      </span>
    </Controls>
  );
}

/** Short names for narrow screens; the full ones are what a screen reader and a wide screen get. */
const SHORT = { risk: "Risk", bad: "Bad", good: "Good", great: "Great" } as const;

function Item({ color, full, short, title, round = false }: { color: string; full: string; short: string; title: string; round?: boolean }) {
  return (
    <li className="inline-flex items-center gap-1.5" title={title}>
      <i aria-hidden className={`size-2.5 ${round ? "rounded-full" : "rounded-[3px]"}`} style={{ background: color }} />
      <span className="sr-only sm:not-sr-only">{full}</span>
      <span aria-hidden className="sm:hidden">
        {short}
      </span>
    </li>
  );
}

/** What the colours on the map mean. `badge`: the red count of confirmed issues is shown too. */
export function MapLegend({ badge }: { badge: boolean }) {
  return (
    <ul aria-label="Map colours" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-2">
      {LEGEND_ORDER.map((r) => (
        <Item key={r} color={RATING_STYLE[r].stripe} full={RATING_LABELS[r]} short={SHORT[r]} title={RATING_STYLE[r].hint} />
      ))}
      <Item color="var(--line-2)" full="Nothing to fix" short="None" title="Steps with no confirmed issue are not coloured: insights stay off the map until someone acknowledges them." />
      {badge && (
        <Item
          color="var(--crit)"
          round
          full="Confirmed issues"
          short="Issues"
          title="The red number on a step is its confirmed issues. Insights nobody has acknowledged yet are not counted."
        />
      )}
    </ul>
  );
}
