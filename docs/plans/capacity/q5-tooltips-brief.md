# Q5: hover pop-ups are never cut off by their widget (Austin, 2 Nov, system-wide)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q5-tooltips`, from `claude/relaxed-babbage-51ysen`. No
migration.

**The problem.** Some widgets show a pop-up on hover (chart tooltips, help (i) bubbles, cell details). It is clipped at
the widget's edge, because it is positioned inside a container with `overflow: hidden` or `auto` (cards, chart frames,
scrolling tables). Austin wants every hover pop-up free to extend outside its widget, everywhere in the app.

## What to do

1. **Inventory every hover or focus pop-up in `apps/web/src`.** Places to look:
   - `ui/tooltip.tsx` (Radix, already portalled);
   - `ui/popover.tsx`;
   - `help.tsx`;
   - hand-built chart tooltips (`overview/charts.tsx`, `overview/trend-charts.tsx`, `overview/team-load.tsx`,
     `sandbox/time-chart.tsx`, `sandbox/compare-chart.tsx` and the Sandbox's free-play charts, `forecast/forecast-timeline.tsx`,
     `capacity/*`, `kpi-strip.tsx`, `insights.tsx`);
   - the map's hover cards in `process-canvas.tsx`;
   - anything else with hover state or absolutely positioned bubbles.

   List them all in the report, with what each was doing.
2. **One shared way to show a pop-up.**
   - Render it in a portal to `document.body`, positioned against its anchor (the hovered element or the pointer).
   - It flips and shifts to stay on screen, and is not clipped by any ancestor.
   - Prefer the existing Radix primitives (Tooltip for hover text; Popover for click), which already portal and handle
     collisions.
   - For pointer-following chart tooltips, add one small shared component, `ui/floating-tip.tsx`: a portal plus fixed
     positioning from the pointer's client coordinates, clamped to the viewport, with a little offset. Use it in every
     chart.
   - Keep each pop-up's content, styling, delay and keyboard behaviour as it is today. Keep focus-triggered pop-ups
     working for keyboard users, and keep `aria-describedby` and `role="tooltip"` where they exist.
3. **Replace each clipped pop-up** with the shared one. Native SVG `<title>` tooltips are drawn by the browser, which
   already never clips them: leave those alone.
4. **Dark mode and z-index:** pop-ups render above the sidebar, dialogs' backdrops, and the map, using the same z-index
   tokens the Radix tooltip uses.
5. **Test:**
   - a browser test that, for a chart tooltip and a help (i) bubble inside an `overflow: hidden` card near the card's
     right and bottom edges, the pop-up is fully visible on screen and is not a descendant of the card;
   - the existing tooltip-content assertions stay green.

**In parallel:** Q3 (process page, Processes page) and Q4 (company map lanes) are building. Touch their files only where a
pop-up lives, keep the change to the pop-up, and expect small merges.

## Done when

- `pnpm lint && pnpm typecheck`, the browser tests of every component you touched, and the web build pass.
- The report has the inventory, what changed in each place, and anything left as is, with the reason.
