# Q16: the Sandbox is the company map plus versions, levers and results (Austin, 7 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q16-sandbox-map`, from `claude/relaxed-babbage-51ysen`. No
migration expected.

Austin: the Sandbox's grid of per-process cards (map version and from selects, per-step block pickers, "No solutions for
this process yet", "No blocks yet…") isn't what he envisaged. The Sandbox should show the **company process map** and let
you **load a different version** of a process (today's map, or a new map you made), which is how you test scenes. Then
the levers and the results. A brainstorm on the results follows, so leave the results as they are.

## Changes (`components/sandbox/play-*.tsx`, `app/w/[slug]/sandbox`)

1. **The company map replaces the processes panel.**
   - It's the same canvas the Overview uses (lanes by department, category tags, playback, Fit), in a `SectionCard`
     titled "Company map", showing this run.
   - **Clicking a process card** opens a small popover: "Version": **Today**, or each map made for that process (its
     solutions by name, with their status pill, plus its open draft if there is one and the Sandbox can run drafts), and
     "From" (a month, default the first month).
   - **The choice** feeds the existing map-version state (P7's E6 / `play.versions`, and Q12's `?solution=` keeps
     working).
   - **A process on a new version** gets a badge on its card ("New version: <name>") and an accent outline.
   - **Above the map, one line:** "2 processes on new versions" with each as a removable chip, and "Reset to today".
     With none: "All processes on today's map. Click a process to load another version."
   - **Remove** the per-process cards, the per-step block pickers and every "No solutions / No blocks" line.
2. **Automations become a lever group.**
   - In the levers card, a group "Automation and augmentation": the workspace's changes (`capacity_changes`), each a row
     with an on/off switch, the step(s) it acts on in muted text, and a "From" month.
   - Keep the Changes editor (add, edit, remove), reachable from the group's header ("Manage").
   - The same state as today's block swaps drives the run, so results are unchanged for the same choices.
3. **Layout:**
   - the page header (Q11a);
   - then the Company map card, full width;
   - then two columns: Levers on the left (sticky on desktop); results ("What happens" and the four charts) on the
     right, unchanged.
   - Phone: stacked.
4. **Keep:** free play (levers reset on leaving), export, `SANDBOX_SCENARIOS_SHOWN` and `SANDBOX_ANALYSIS_SHOWN` as they
   are, and every lever.

## Done when

- `pnpm lint && pnpm typecheck`, the sandbox and play tests (browser ones included), `server-client-boundary`, and the
  web build pass.
- A browser test:
  - pick a solution for a process, then see the badge, the chip and the run using it;
  - reset to today;
  - toggle an automation.
- Screenshots on the example agency, at 1440 px light and dark and at 400 px, under `docs/plans/capacity/q16-shots/`,
  showing a version popover and one swapped process.
