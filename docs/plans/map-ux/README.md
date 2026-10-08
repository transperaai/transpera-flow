# Map UX investigation scripts (8 Oct 2026)

Throwaway measurement scripts behind `docs/plans/map-ux-brief.md`. Run them with Node from `apps/web` (so `playwright-core`
resolves), against `next start` of a demo build (`NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= next build`)
or `next dev` for `renders.mjs`, with `CHROMIUM_PATH` set and `BASE` pointing at the server.

- `perf2.mjs`: frame intervals (p50, p95, max, frames over 25 ms) for zoom, fit and an Editor drag, CPU throttled 4x, median of 3.
- `renders.mjs`: which React components ran per interaction (dev build), through a stand-in DevTools hook.
- `trace.mjs`: main-thread time by kind (layout, paint, script) during playback or zoom.
- `lines.mjs`: line readability on each demo map: shared runs, shared end points, labels on labels or on other lines.
- `animation-experiment.diff`: the throwaway patch (zoom subscription moved into the controls and edge editor, stable
  React Flow handlers) whose before/after numbers are in the brief, section 2.3. Not type-clean as written (the
  `useStable` handlers lose their parameter types); the build types them properly.
