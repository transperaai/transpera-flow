// Zoom on the process map (issue #99). A small map is fitted to its panel; a big
// one is never shrunk below 70%, so its text stays readable, and the panel scrolls
// (pans) instead. Pure, so the calculation is tested without a browser.

export interface Box {
  width: number;
  height: number;
}

/** Fitting never goes below this: text stays readable and the map scrolls instead. */
export const MIN_FIT_ZOOM = 0.7;
/** Fitting never blows a small map up past this. */
export const MAX_FIT_ZOOM = 1.15;
/** The - and + buttons stay between these. */
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 1.8;
export const ZOOM_STEP = 0.15;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The zoom that fits `content` in `panel` (both in pixels), kept between 70% and 115%. */
export function fitZoom(content: Box, panel: Box): number {
  if (content.width <= 0 || content.height <= 0 || panel.width <= 0 || panel.height <= 0) return 1;
  return clamp(Math.min(panel.width / content.width, panel.height / content.height), MIN_FIT_ZOOM, MAX_FIT_ZOOM);
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_PADDING: Padding = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Where to put the map so `bounds` (in map units) is framed in `panel`: fitted (see `fitZoom`) and centred across when it
 * fits, or, when it is wider than the panel at 70%, pinned to the left so the rest is a scroll (drag) away. It starts at the
 * top, unless `middle`: then a map that fits down the panel is centred down it too (a panel of a fixed, tall height, such as
 * the Overview's company map or a map on the full screen, where hanging from the top would leave the foot empty).
 */
export function fitViewport(
  bounds: { x: number; y: number; width: number; height: number },
  panel: Box,
  pad: Padding = NO_PADDING,
  { middle = false }: { middle?: boolean } = {},
): { x: number; y: number; zoom: number } {
  const room: Box = { width: panel.width - pad.left - pad.right, height: panel.height - pad.top - pad.bottom };
  const zoom = fitZoom(bounds, room);
  // Across, a map that fits is centred; down, it hangs from the top, so a content-sized panel doesn't strand it in the middle.
  const spare = room.height - bounds.height * zoom;
  return {
    x: bounds.width * zoom <= room.width ? pad.left + (room.width - bounds.width * zoom) / 2 - bounds.x * zoom : pad.left - bounds.x * zoom,
    y: pad.top + (middle && spare > 0 ? spare / 2 : 0) - bounds.y * zoom,
    zoom,
  };
}

/** The next zoom after a click on - or +. */
export function stepZoom(zoom: number, direction: "in" | "out"): number {
  const next = zoom + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP);
  return Math.round(clamp(next, MIN_ZOOM, MAX_ZOOM) * 100) / 100;
}

/** "85%". */
export const zoomLabel = (zoom: number): string => `${Math.round(zoom * 100)}%`;

/**
 * The map area of a tall panel (`height="tall"`, the Overview's company map), as Tailwind classes so the server draws it at
 * its final size (no jump when the map loads) and its skeleton can match it: three quarters of the screen's height, between
 * 26 and 56 rem; on a phone (under 640 px) 60% of it, between 20 and 28 rem, so the page still scrolls past it.
 */
export const TALL_PANEL_CLASS = "h-[clamp(20rem,60svh,28rem)] sm:h-[clamp(26rem,75svh,56rem)]";

/** A map panel that follows its map is never shorter than this (rem 16) or taller than this (rem 40) in pixels. */
export const AUTO_HEIGHT = { min: 256, max: 640 } as const;

/**
 * How tall a panel should be to show `bounds` (map units) at the zoom that fits its width: the map's height at that
 * zoom plus the padding, kept between 16 and 40 rem, so a small map doesn't sit in a tall empty panel.
 */
export function autoPanelHeight(bounds: { width: number; height: number }, panelWidth: number, pad: Padding = NO_PADDING): number {
  const zoom = fitZoom({ width: bounds.width, height: 1 }, { width: panelWidth - pad.left - pad.right, height: 1e6 });
  return clamp(Math.round(bounds.height * zoom + pad.top + pad.bottom), AUTO_HEIGHT.min, AUTO_HEIGHT.max);
}
