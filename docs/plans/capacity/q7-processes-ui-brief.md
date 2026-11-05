# Q7: Processes page layout, and "Change type" picks the category (Austin, 5 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q7-processes-ui`, from `claude/relaxed-babbage-51ysen`.
No migration expected.

Austin's QA of the Processes page (`apps/web/src/components/processes/*`, `app/w/[slug]/processes/page.tsx`).
Screenshot before and after.

## Changes

1. **Header buttons, layered.** Today Company map, Edit company map, History, Upload and New process sit in one loose
   row. Make it two clear groups:
   - left, an outline button group for the company map: **Company map · Edit company map · History**. Edit only shows
     for editors; History only once the map is published.
   - right, the page's actions: **Upload process** (outline) and **New process** (primary).

   Same button component and size throughout. Keep the edit-mode colour on Edit company map if it has one. Wrap
   sensibly at narrow widths.
2. **A toolbar row above the table** holds the **In use / Archived** switch and the **category filter**, aligned on one
   line, with a little space under the header and above the table.
   - In use / Archived is a segmented control.
   - The category filter is a segmented control (All plus each category present, with counts) or a select. Pick
     whichever fits one line at 1440 px.
   - Nothing floats on its own.
3. **Columns:** every column's header and cells are centred, except **Process** and **Type**, which stay left-aligned.
4. **The ⋯ row menu** is wide enough that no item wraps ("Change type" included): give the menu a min-width and keep
   items on one line.
5. **"Change type" picks the category.**
   - The menu item opens a dialog to choose among the five categories (Sales, Onboarding, Routine client work, Ad hoc,
     Internal), each with its one-line help from `process-category.ts`. Saving sets `processes.category`, as the
     process page's Type select does.
   - The simulation setting (pipeline or client work) moves into a folded "How it's simulated" section in the same
     dialog. It shows which kind the process is, and keeps the existing kind change with its existing warnings and
     checks.
   - Wording: "Simulated as a sales pipeline (leads come in and are won or lost)" or "Simulated as client work (it
     repeats for every client)".
   - Only editors see the menu item, as today.

## Done when

- `pnpm lint && pnpm typecheck`, the processes page tests (including the browser ones), and the web build pass.
- Screenshots of the Processes page at 1440 and 400 px, and of the Change type dialog, under
  `docs/plans/capacity/q7-shots/`.
