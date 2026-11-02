# Q1: Overview fixes from Austin's QA (2 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q1-overview`, from `claude/relaxed-babbage-51ysen`. No
migration expected.

Austin's QA notes on the Overview (`apps/web/src/components/overview/*`, `department-cards.tsx`, the company map
components it uses). Some map controls are shared with the process page and the Sandbox: change them everywhere they
appear, and keep those pages' tests green.

## Changes

1. **Page header.** Under the workspace name, show only "Last updated <date and time>" and the number of processes
   ("12 processes"). Remove every other line there.
2. **Whole business first.** The whole-business row moves above the department cards.
3. **No "Clients per employee" on the department cards.** Clients aren't spread evenly across employees. Remove the
   figure from both department cards. Keep `perEmployee` in `capacity-figures.ts`: revenue per employee still uses it.
   Record this as decision D39 in `docs/plans/client-requirements.md` (it amends D22).
4. **DLER subtext.** Remove "goal 4.5" from the DLER subtext on the Overview. Keep the figure itself as it is; Austin
   is deciding what "average" should mean.
5. **"At or over their line" card.**
   - Title it "Past their busy line".
   - The value is the count.
   - The subtext says what the line is: "Busy above 85%". If the department's roles have different lines, use the
     range, e.g. "Busy above 80–85% (each role's line)".
   - No names: the busy list below names them.
6. **Busiest people shows everyone.** Every active person in the department, sorted busiest first, each with the busy
   bar against their line and the percentage, as today. Not only the top 6. If the list is long, keep it in the card at
   its natural height. Don't add a scroll box.
7. **History and All processes buttons** look like the Export button: same component, variant and size.
8. **History is reachable from where it's expected.**
   - Austin reports that History can only be reached from the Overview, while the link sends people to Processes. Find
     where the company map's History lives and where each History link points.
   - Fix the links so History opens directly from the Overview button, and from the Processes page and each process
     page.
   - Say in the report what was wrong.
9. **Overview simulation horizon: 1, 3 or 6 months only.**
   - Replace the Overview's horizon choices with 1 month, 3 months and 6 months. Default: 3 months, or the nearest of
     those to today's default.
   - Next to it, add a link-button "Simulate further in the Sandbox" that opens the Sandbox.
   - The Sandbox and process pages keep their own horizons.
10. **Expand button glitch.** The map's expand (full screen) button misbehaves while the simulation is playing.
    Reproduce it in the browser harness (play, then expand, then collapse), fix it, and add a test.
11. **Fit fits everything.** The map's Fit button must fit every node and edge on screen (React Flow `fitView` over all
    nodes, with padding), not only the start node. Check it with nested groups and child processes, and add a test that
    every node's box is inside the viewport after Fit.
12. **Playback controls.**
    - Remove the "Exit playback" button on the right.
    - Add a Stop button (a square icon, label "Stop") on the left next to Play and Replay. It stops playback and returns
      the map to its normal, non-playing view, which is what Exit playback did.
13. **Speed choices:** "1 hour per second", "1 day per second", "1 week per second", "1 month per second", in that
    order. A day and a week are working time, using the workspace's hours per week, as the scrubber's units are today.
    Pick the default nearest to today's.
14. **Remove two charts:** "Issues opened and resolved" and "Before and after, per solution". Delete their components
    and tests if nothing else uses them.

## Don't change yet (Austin is deciding)

- DLER as an "average" (item 4 only removes the goal text).
- "By process", "What the time achieves" and "Team load by role".

## Done when

- `pnpm lint && pnpm typecheck`, the Overview, map, process-page and sandbox tests, and the web build pass.
- Screenshots of the Overview at 1440 px, light and dark, on the `capacityModel()` fixture or the example harness, saved
  under `docs/plans/capacity/q1-shots/`.
- The report covers each numbered item, and item 8's cause.
