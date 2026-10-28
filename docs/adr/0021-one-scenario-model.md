# 21. One scenario model: the Sandbox

Date: 28 Oct 2026 · Status: accepted · Amends 0003's scenarios and the plans of D46 · docs/plans/sandbox-design.md, docs/plans/sandbox-p1-brief.md

## Context

Two tables did one job. `scenarios` held patches (the process page's what-ifs, run by the engine from the first week);
`forecast_plans` held markers (hires, leave, a solution live from a month, run as spliced segments on the Forecast page).
Neither could hold the other's change, and nothing compared them.

## Decision

- **One table, `sandbox_scenarios`.** A row is a name, a description, an optional parent (`parent_id`: "build on"), a horizon
  (1 to 24 months, saved with the scenario) and `changes`, a list of `{ id, lever, target, op, value, from?, params? }`.
  `scenarios` and `forecast_plans` are dropped after a migration copies every row with its id.
- **One registry of levers** (`packages/db/src/sandbox-levers.ts`), mirrored in SQL (`private.sandbox_levers()`,
  `is_sandbox_change(s)`) and kept equal by a test that runs one table of cases through both. A lever is one registry entry plus one
  value rule. Phase 1 has A1, A6, B1, B2, B3, C1 (kept, not offered), C2 (overheads a month, phase 2), D1 to D5, E1 to E3 and E6; X1 to X3
  keep what the process page's sliders could save.
- **Three ways a change reaches the engine, no engine change.** A whole-run change is a patch (`applyPatches`). A person over time
  (hire, leaver, leave, FTE) edits the people the model is built from. A change from a month, or a solution going live, runs as an
  extra segment and the segments' monthly numbers are spliced (`spliceMonthly`, D46). At most six distinct capped change months
  (seven runs), four solutions, 200 changes, five levels of parents.
- **Build on, not copy.** A child's effective changes are its parent's first. A parent others build on cannot be deleted; the
  refusal names them. The migration reads the old `parent_scenario_id` ("copied from") as no parent, because the copy already holds
  the patches.
- **Who.** Viewers read, open, run and compare; Agency admins and the Owner write. Phone is read-only. No lever stores one person's pay.
- **The process page** keeps listing the simple whole-run scenarios and links to the Sandbox; it refuses a broken patch where the
  Sandbox skips it and lists it.
- **Alerts** keep `ANALYSIS_DEFAULTS` (D40 unchanged).

## Consequences

- `private.is_scenario_patch` stays (`save_solution` checks a solution's lever changes with it); only the table's check went.
- A restore reads `sandbox_scenarios`; a backup from before this migration is converted by `planSandboxScenarios`.
- A new lever is a registry entry, a row in `private.sandbox_levers()`, and a value rule in `valueProblem` and `is_sandbox_change`.
- The shared simulation pool keeps 40 finished runs, so a compare of four columns reuses runs between switches.
