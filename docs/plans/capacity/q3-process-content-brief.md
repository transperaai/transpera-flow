# Q3: process categories, no rating, leaner facts, capacity-shaped supporting data (Austin, 2 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q3-process-content`, from `claude/relaxed-babbage-51ysen`.
Migration range `20270126000000`–`20270126009999`.

## Changes

1. **Remove the process rating.**
   - Delete the Rating column on the Processes page, and the rating dot in the process switcher and anywhere else a
     *process* shows a rating.
   - Issues keep their own ratings on the Issues pages, and steps on the map keep their issue colours. Only the
     process-level roll-up goes.
   - Remove code and tests that only served it.
2. **Process categories** (decision D41; record it in `docs/plans/client-requirements.md`).
   - A new column `processes.category text`, check in (`sales`, `onboarding`, `routine_client_work`, `ad_hoc`,
     `internal`).
   - **Labels:** Sales, Onboarding, Routine client work, Ad hoc, Internal.
   - **Backfill:** pipeline processes become `sales`; servicing processes become `routine_client_work`, except a
     servicing process whose links use the ad-hoc driver or a Poisson recurrence, which becomes `ad_hoc`.
   - **Default for a new process:** from its kind, in the same way.
   - The engine kind (pipeline or servicing) is unchanged and stays underneath. Category is for people.
   - **Processes page:** the "Type" column shows the category, with a filter by category. Replace the "Sales pipeline
     is how new work comes in…" help with a short line per category.
   - **Process page "About":** Type shows the category, editable by the Owner and Agency admins through a select.
   - The workspace bundle, its restore, `save_fields`, the process file `transpera-process/2` (optional `category`) and
     the `process-file` skill all carry it.
   - **Example loader:** onboarding processes are `onboarding`, the ad-hoc request processes `ad_hoc`, the rest
     `routine_client_work`, and the pipeline `sales`.
   - **The full migration rules:**
     - full rollback SQL;
     - `copy-from-supabase` passes;
     - if you redefine `import_workspace_bundle` or `save_fields`, copy the latest bodies.
3. **Remove "Worth adding for capacity" entirely.**
   - Delete `capacityNotes` and its UI in `simulation-gaps.tsx`, the editor and the process page, and its tests.
   - Keep the **blockers** (`capacityBlockers`, "Missing for simulation"): those stop a run.
4. **Facts from the run, leaner.** Today it's data overload. On the process page:
   - Show **at most 3 facts**, worst first. Each is one plain sentence with a coloured dot, and at most one number in
     the sentence ("Only Karl can vet domains: if he's away, link work stops").
   - Below them, a "Show all N" disclosure for the rest, in the same one-line format.
   - Remove the extra badges, sub-figures and long explanations from each row. Keep hover lighting the step on the map.
   - If a fact's rule text is long, write a short sentence for each rule kind in one place, the fact formatter, rather
     than per row.
5. **Supporting data, capacity-shaped.** The panels, in this order:
   - **Hours a month this process takes, by role and by person:** who carries it. Use `personTime.stepHours` over this
     process's steps, from a run with `personTime` on. Show a bar per role, expandable to people. Include the total
     ("612 h a month").
   - **Heaviest steps:** steps ranked by hours a month, each with its work split bar (automatable / augmentable /
     manual) and its hours. At most 10, with "Show all".
   - **Time split per step:** keep as is (hands-on against waiting).
   - **Waiting:** keep the existing wait-by-step view, titled "Waiting on people and on others". If it overlaps the time
     split, keep both but make sure each says what it shows in one line.
   - **Key-person risk per step:** keep as is.
   - **Remove** the Cycle time spread and Rework loops panels, and their code and tests if nothing else uses them.

## Done when

- `pnpm lint && pnpm typecheck`, the processes page, process page, editor, process-file and db tests touched, and the
  web build pass. `copy-from-supabase` passes.
- Screenshots of the Processes page and a process page (facts and supporting data) on the example fixture, at
  1440 px, under `docs/plans/capacity/q3-shots/`.
- The report covers each item, and the facts sentence chosen for each rule kind.
