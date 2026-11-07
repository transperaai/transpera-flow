# The Sandbox's results as charts (D54, Chat B)

Read `docs/plans/capacity/README.md`, D54 in `docs/plans/client-requirements.md`, and the `dataviz` skill first.

- **Branch.** `claude/ui-sandbox-results`, from `claude/relaxed-babbage-51ysen`. No migration.
- **The page.** `apps/web/src/components/sandbox/play-results.tsx` (with `play-chart.tsx` and `play-view.tsx`) shows
  the "What happens" card (`PlayVerdict` and the lines under it) and four line charts: Clients by department, Retainers
  a month, DLER by department, and Busy share of the five busiest teams.
- **Reusable.** `time-by-purpose.tsx` and `lib/sandbox/measures.ts` have the purpose and busy measures already worked
  out from a run's months.

1. **Remove the "What happens" card.** Its numbers move into the chart headers below. Keep its loading state as the
   charts' loading state.
2. **Who's overloaded, and when** (first, full width).
   - **Heatmap.** One row per team (every team, the busiest first) and one column per month, coloured by busy share.
     Use the same cut-offs as the Capacity page's ratings (green, amber, red). Each cell's tooltip gives the team,
     month and busy share, with "in 9 of 10 runs" where the page shows ranges today.
   - **The switch.** A This scene / Today switch above the heatmap flips which run it shows. It shows This scene by
     default.
   - **Paired bars.** Under the heatmap, for each month, the number of people over their line: today in grey, this
     scene in colour.
   - **Header.** "Worst month: N people over their line (M today)".
   - **It replaces** the "five busiest teams" line chart.
3. **Clients, retainers and DLER.** Three line charts in a row (stacked on a phone), each with today's path dashed.
   - **Clients by department.** Header: "144 clients by month 13 (+0)". Won and lost in the tooltip.
   - **Retainers a month.** Header: "A$599.2k a month (+A$0)".
   - **DLER by department,** against its goal line. Header: "DLER 6.9 by month 13 (6.9 today)". Viewers who can't see
     pay get today's "hidden" treatment.
4. **Where the time goes.**
   - Two donuts side by side, "Today" and "This scene". They show the team's hours by purpose (the workspace's purposes
     and their colours), the same order in both.
   - Beside them, the purposes that moved most, in hours a month, e.g. "Fixing −40 h · Coordination −12 h". When
     nothing moved: "The same as today."
5. **When nothing has changed** (today's path), the charts show only today, with no dashed copy. The heatmap's switch
   is hidden, and the headers carry the number without a change.
6. **Help.** Each card gets an (i) saying what it shows and how to read the dashed line. Remove help that was for the
   verdict card.

Screenshots to Austin before merging: today's path, and a scene with changes, at 1440 light and dark and at 400. Done
when `pnpm lint && pnpm typecheck && pnpm test` and the web build pass.
