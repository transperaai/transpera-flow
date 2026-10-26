// How often the map's tiles and lines render, for the browser test that zooming re-renders none of them (issue #249: every
// zoom frame used to re-render the whole canvas, which made zoom and fit choppy). Off unless a test sets
// `window.__mapRenderCounts = {}` first; then each tile and line adds one to its kind on each render.

export type RenderKind = "canvas" | "tile" | "edge";

export function countRender(kind: RenderKind): void {
  const counts = (globalThis as { __mapRenderCounts?: Partial<Record<RenderKind, number>> }).__mapRenderCounts;
  if (counts) counts[kind] = (counts[kind] ?? 0) + 1;
}
