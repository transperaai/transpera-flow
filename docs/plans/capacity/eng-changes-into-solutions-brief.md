# Changes become part of a process version (D53)

Read `docs/plans/capacity/README.md`, D53 and D51 in `docs/plans/client-requirements.md`, and ADR 0023 first.

- **Branch.** `claude/eng-changes-into-solutions`, from `claude/relaxed-babbage-51ysen`.
- **Start after** `claude/eng-editor-model` is merged.
- **Migration range.** `20270136000000`–`20270136009999`.
- **Engine changes** follow `docs/engine-versioning.md`.

## Today

- **Changes** (`capacity_changes`; `packages/db/src/capacity-changes.ts`; `toEngineStepChange`) are workspace rows:
  name, kind, `effects` (per step: automatable `remove` / `residualHours`, or augmentable `factor`), `adoption`,
  `ramp_months`, `tiers`, `cost_monthly` and `issue_id`.
  - The Sandbox lists them as switches with a "From" month (`components/sandbox/play-levers.tsx`, "Automation and
    augmentation").
  - The dialog that makes them is `play-change-dialog.tsx`.
  - The editor marks their steps (`changeStepIds`).
- **Solutions** (`solutions`, `solution_issues`) are a copied process (`steps`, `base_revision_id`) with
  `lever_changes`.
  - The Sandbox runs a solution by picking it as a process's version on the company map (Q16, `withSolution`).

## Part A: the data (Chat A)

1. **Migration.**
   - Add `solutions.step_changes jsonb not null default '[]'`. It holds a list of
     `{ name, kind, effects, adoption, ramp_months, tiers, cost_monthly }`, checked in the same way `capacity_changes`
     checks them today.
   - Move each existing change into solutions:
     - For each process that its effects' steps belong to (at that process's live revision), make one solution: named
       after the change, status `testing`, with a copy of the live steps, the effects for that process's steps, and a
       `solution_issues` row for its `issue_id`.
     - Effects on steps that no longer exist are dropped, counted in the migration's notice.
   - Keep `capacity_changes` read-only for one release (a comment says it goes). Nothing reads it after this package.
   - Write the post-apply checks and the rollback, and add a `docs/supabase-notes.md` entry. Run `gen:types`.
   - Update the workspace bundle, import and export (`workspace-bundle.ts`, `workspace-import.ts`) and the
     `capacity:example` fixtures.
2. **Running it.**
   - When the Sandbox runs a solution (`withSolution` and the scene's per-process versions), that solution's
     `step_changes` become the model's `EngineStepChange`s, starting at the version's month.
   - The engine input is the same as a switched-on change today.
   - Live runs (Capacity, the Overview) carry no step changes, as today with every switch off.
   - **Equality test.** For the capacity example, a Sandbox run with change X switched on from month m, before the
     migration, must equal a run after it with X's solution picked from month m: the same model and the same results.
   - **Goldens** run unapproved, and `ENGINE_VERSION` stays.
3. **Remove the levers' "Automation and augmentation" section.**
   - Remove it, with its run-key parts, the `play.blocks` month entries and its share-link and URL state.
   - Remove `capacity-change-actions.ts` and the dialog's Sandbox entry point. Part B reuses the dialog's fields in the
     editor.
   - The issue page's and the solution page's lists of what was tried show the moved solutions in their place.
4. **MCP.** Any tool that lists or toggles changes now reads `solutions.step_changes`. Update the tool descriptions.

## Part B: the editor (Chat B, after part A and `ui-editor-simplify`)

- **"Automate…" and "Augment…" on a step.** In the step panel, when the editor is open on a solution's version, a Step
  shows them. They take the same fields as today's dialog (share removed, minutes of checking left, speed-up, adoption,
  ramp-up, tiers, monthly cost), saved into the solution's `step_changes`.
- **On the live process,** the panel says "Make a solution to try an automation", which starts one from this process.
- **On the canvas,** a step with a change keeps today's mark.

Done when `pnpm lint && pnpm typecheck && pnpm test` and the web build pass.
