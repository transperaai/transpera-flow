# Q4: department lanes on the company map, category tags on its cards (Austin, 2 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q4-company-lanes`, from `claude/relaxed-babbage-51ysen`.
Migration range `20270127000000`–`20270127009999`.

**In parallel:** Q3 is adding `processes.category` (migration `20270126…`) and changing the Processes page and the process
page. Don't touch those pages, except the one "Department" field in item 2. Expect to merge Q3 when the orchestrator says
it has landed, then show its category as the tag in item 3.

## Changes

1. **A process's department.**
   - Add `processes.department_id uuid null` (FK to `departments`, same workspace).
   - A null department is worked out like this:
     - from the departments of the tier services its servicing links use, when they are all one department;
     - otherwise it means "Sales and whole business": the pipeline, internal processes, and anything serving both
       departments or none.
   - Write the derivation as a pure function, with tests.
   - Carry the column in the workspace bundle and its restore, `save_fields`, and the process file (optional).
   - Follow the full migration rules: rollback SQL, `copy-from-supabase` passes, and copy the latest
     `import_workspace_bundle` and `save_fields` bodies. If Q3 has merged first, rebuild on its body.
2. **Override on the process page.** In "About this process", a "Department" select:
   - the workspace's departments, plus "Sales and whole business";
   - editable by the Owner and Agency admins;
   - showing the worked-out value as the default.

   Keep this to the one field (Q3 owns the rest of the page).
3. **Company map lanes by department.**
   - On the company map (the Overview and the company map editor), lay the process cards in horizontal lanes in this
     order:
     - Sales and whole business;
     - then each department, in its `sort` order.
   - Lanes are labelled bands like the process map's role lanes. Reuse that rendering.
   - On the Overview they are always on. In the editor they show by default, and dragging a card into another lane does
     **not** change its department: the department is set on the process page.
   - Positions inside a lane follow the map's stored x and y. If cards would overlap a lane edge, keep the stored layout
     and size the lanes to fit.
   - Keep Q1's controls (Fit frames everything, Stop, speeds, horizon) working, with lanes included in Fit.
4. **Category tag on each process card** (after Q3 merges): a small pill with the category label (Sales, Onboarding,
   Routine client work, Ad hoc, Internal). Until Q3 is in, leave the slot empty.

## Done when

- `pnpm lint && pnpm typecheck`, the map, overview, editor and company-map tests, and the web build pass.
  `copy-from-supabase` passes.
- A browser test shows the lanes on the Overview in the right order, with each card in its lane.
- Screenshots of the Overview company map with lanes, light and dark, at 1440 px, on the example fixture, under
  `docs/plans/capacity/q4-shots/`.
