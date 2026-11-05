# Q8: the process page, redesigned (Austin, 5 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q8-process-page`, from `claude/relaxed-babbage-51ysen`.
No migration expected.

Austin: "the page is a mess and disconnected". Sections float, and each has its own style. Redesign
`apps/web/src/components/process-page.tsx` (and what it renders) into one consistent card system, top to bottom. Keep
every feature and every server action. This changes layout and presentation, not behaviour.

## Layout (one column, the page's max width, a consistent gap between cards, the app's Card component throughout)

1. **Header card.** Replaces the floating "About this process" row and the version pill.
   - **Left:** the process name as the page title, with **pills** for its category (Q3) and department (Q4), using the
     same pill component as the company map's category tag.
   - **Under it, one muted line:** "4 steps · 2 roles · Version 3". For a draft: "Draft, not published yet". For an
     older version, the existing read-only notice.
   - **Right, a button group:** History · Edit (editors only) · Export, the same button component and size.
   - **Editing:** a small pencil beside the pills opens a popover with the Type (category) and Department selects, for
     the Owner and Agency admins. It uses the existing server actions. Readers see the pills only.
   - Remove the old About block.
2. **Process map card.** Full width.
   - **Card header:** the title "Process map" and the toolbar: Swimlanes, Fit, zoom, and a **"Key" button** that opens
     the rating colour legend in a popover. Today the legend is a long row.
   - **The canvas** fills the card body at a sensible height (taller on desktop, shorter on phones).
   - **The playback bar** (Play, Stop, speed, scrubber) docks inside the card's bottom edge.
   - No extra borders inside the card. Keep "Missing for simulation" blockers as a compact alert inside the card's top.
3. **"What the run shows" card.** Facts from the run and Supporting data, combined.
   - **First,** the headline sentence (Q3's `headlineText`), large.
   - **Then two columns** (one on phones): left, **Facts** (Q3's leaner list: three, then "Show all N"); right, **Hours a
     month by role and person**.
   - **Then a row of three equal-height panels** (stacked on phones): **Heaviest steps**, **Time split per step**,
     **Key-person risk per step**. Each panel has a title, a one-line description and its content, in the same style.
   - **Loading and empty states** use skeletons and one plain sentence each.
4. **Issues and solutions card.**
   - **Card header:** "Issues and solutions", the counts ("3 open · 1 in progress · 2 resolved"), and a **"Log an
     issue"** button (editors). Use whatever logging flow exists today.
   - **Each issue is a row:** rating dot, title, the step it sits on (a link that lights it on the map), a status pill,
     the owner, and, inline under it, its linked changes (name and hours freed, if P8's figure is cheap to show; else
     the count) and its solutions (name and stage). The row opens the issue page.
   - **"Other improvements"** (solutions not linked to an issue) is a subsection in the same card.
   - **Empty state:** an icon, one sentence on what goes here ("Log the problems you find on this map, then link
     solutions and Sandbox changes to them."), and the Log an issue button. Not grey text in a dashed box.
5. **Hidden Sources** (P0) stays reachable by `#sources`, at the bottom, and unchanged.

## Rules

- Use existing components (Card, Button, Badge or pill, Popover, Skeleton) and the theme tokens. No new colours.
- Light and dark. At 400 px nothing scrolls sideways: the map card's toolbar wraps, and the button groups wrap or
  collapse.
- Keep every existing `data-*` hook the tests use, or update the tests to the new structure without loosening what
  they assert.

## Done when

- `pnpm lint && pnpm typecheck`, the process page tests (`process-page*`, `map-browser`, `process-admin-browser`, the
  issues on-page tests, help and role-gating) and the web build pass.
- Screenshots of the process page for the example agency's "Performance: Pacing and hygiene, per channel" process (or
  the fixture's equivalent), with and without issues, at 1440 px light and dark and at 400 px light, under
  `docs/plans/capacity/q8-shots/`.
