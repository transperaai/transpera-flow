# Q19: cut Branding, Historical data and the Change log from Settings (Austin, 7 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/ui-settings-cuts`, from `claude/relaxed-babbage-51ysen`. Migrations in
Chat B's range: `20270200000000`–`20270200009999`. Decisions D70–D72 (`docs/plans/client-requirements.md`, already written).

Austin: remove the branding (logo and colours are hardcoded before deploy), remove historical data, remove the change log. This is
a full removal, end to end: pages, components, actions, lib, engine code, database tables and functions, tests and docs. Austin
agreed that Chat B does the engine and database deletions for this package (it is deletion only).

Work in the chunks below, in order, and commit after each. After every chunk `pnpm lint && pnpm typecheck` must pass.

## 1. Change log (D72)

Remove:
- `app/w/[slug]/settings/changes/` (page and loading);
- `components/change-log.tsx`;
- `lib/change-log/audit.ts`;
- `loadChangeLogPage` and its types in `lib/company-data.ts`;
- the "Change log" row on the Settings hub (`settings/page.tsx`);
- `/settings/changes` in the Settings nav highlight (`lib/shell/nav.ts`);
- the `changes` segment in `lib/monitoring/scrub.ts`'s allowlist;
- `test/change-log.test.ts`.

**Keep** `public.audit_log`, every trigger and function that writes it, and everything that reads it:
- `revision_history` (a version's author and publish note);
- `restore_version`;
- `log_process_import`;
- `map_cards_removed`;
- `agency_workspace_list`'s "Last activity".

The per-process History page (`p/[processId]/history`) and workspace backup/restore are untouched.

## 2. Branding (D70)

Remove:
- `app/w/[slug]/settings/branding/` (page and actions);
- `app/api/branding/[workspaceId]/logo/route.ts`;
- `components/branding/`;
- `lib/branding/` (all of it);
- the `<style data-brand>` injection and `logoUrl` plumbing in `app/w/[slug]/layout.tsx` → `WorkspaceShell` → `app-sidebar.tsx` → `workspace-switcher.tsx`;
- `loadLogoSha` and `branding` in `loadWorkspaceHead` (`lib/data.ts`);
- the Settings hub row;
- the skeleton and loading mentions;
- the `branding` segment in `scrub.ts`.

The workspace switcher always shows the monogram tile (first letter of the workspace name, `bg-accent text-accent-fg`).
`tokens.css` stays as it is: its teal is the default. Keep `--logo-tile` only if something else uses it; otherwise remove it and
its `globals.css` mapping.

Database, in a new migration `20270200000000_drop_branding_and_calibration.sql` (one file for chunks 2 and 4):
- drop the `audit_logo` trigger and `private.audit_workspace_logo_write`;
- drop `public.workspace_logo(uuid)` and table `public.workspace_logos`;
- drop the `workspaces_branding_shape` check and column `workspaces.branding`.

In `packages/db`:
- remove `loadWorkspaceLogo`, `loadWorkspaceLogoSha`, `saveWorkspaceLogo` and `deleteWorkspaceLogo` and their exports;
- fix the comment on `can_manage_workspace` in a `create or replace` only if you redefine it anyway (don't redefine it just for a comment).

`packages/db/scripts/copy-from-supabase/` copies logos: remove that part, keep the rest working, and keep
`copy-from-supabase.test.ts` green (see "Tests" for how).

Tests to remove:
- web: `branding-actions`, `branding-browser` and `branding-harness/`, `branding-contrast`, `branding-logo-route`, `branding-logo`, `branding-style`;
- db: `branding.test.ts`, `workspace-logos.test.ts`.

Tests to trim: the branding cases in `shell-nav.test.ts`, `role-matrix.test.ts`, `raw-colours.test.ts`, `fresh-workspace-fixture.ts`, `loading-coverage`, `map-tile` and the `q11b` shots harness.

## 3. Historical data: the web app (D71)

Remove:
- `app/w/[slug]/settings/calibration/` (page and actions);
- `components/calibration/`;
- `lib/calibration/`;
- `workers/csv-import.worker.ts` and `workers/churn-calibration.worker.ts`, with their registration in the build (`next.config.ts` or wherever workers are listed);
- the Settings hub row and `/settings/calibration` in the nav highlight;
- the `calibration` segment in `scrub.ts`.

The Settings hub calls `loadLatestChecks` for the churn drivers section. Remove that call and the "measured checks" column or line in
`churn-drivers-settings.tsx`; the churn drivers themselves stay.

Tests to remove:
- web: `calibration`, `client-calibration`, `csv-import-browser` and its harness, `import-request`, `import-view`.

## 4. Historical data: db and engine (D71)

- **Engine:** remove `packages/engine/src/calibration.ts`, `client-calibration.ts` and `person-times.ts` (if only calibration uses
  it), their exports, and their tests.
  - `robustness.ts` treats measured values as fixed. Keep that rule only if `measured` values can still exist after step 5 below.
    By default they can't, so remove the special case and its test lines.
  - No golden may move. If one does, stop and report.
  - Calibration is not part of a run, so `ENGINE_VERSION` does not change. Note that in `docs/engine-versioning.md` if it lists the
    calibration API.
- **db package:** remove `src/calibration.ts`, `client-calibration.ts`, `csv-import.ts`, the `@transpera-flow/db/calibration`
  export (package.json `exports` and any tsconfig paths), and their tests:
  - `calibration`, `calibration-log`, `client-calibration`, `client-calibration-log`, `capacity-factor-calibration`, `csv-import`, `dataset-imports`;
  - the mcp DB-function tests `db-calibration`, `db-client-calibration`, `db-capacity-factor-calibration`, `db-dataset-imports`.
- **Migration** (same file as chunk 2):
  - Drop `public.apply_calibration`, `public.record_calibration`, `public.record_client_calibration`, `public.record_dataset`,
    `public.record_calibration_import` (every overload), and their private helpers (`private.calibrations_before_write`,
    `private.calibration_payload_problem` and any other used only by them).
  - Drop tables `public.capacity_factor_proposals`, `public.calibrations`, `public.datasets`.
  - Before dropping anything, check what else references each one (`team_capacity`, `import_workspace_bundle`, the backup bundle,
    share snapshots, RLS helpers). Redefine those without the reference, copying the latest body. The latest body of a function is
    in the newest migration that defines it.
- **Measured values become ordinary values:**
  - In the migration, rewrite every stored `provenance` entry with `source = 'measured'` to `source = 'entered'`, and drop its
    `dataset_id` and `calibration_id` keys. This covers steps (live, draft and superseded revisions), lead sources, client groups
    and anything else that carries the provenance shape.
  - Rewrite per-person capacity factors with source `measured` to `entered`.
  - Then remove `measured` from `ProvenanceSource` (`packages/db/src/types.ts` and `apps/web/src/lib/editor/provenance.ts`), and the
    "Measured" badge branches in `evidence.tsx`, `step-base-values.tsx`, `lib/editor/base-values.ts` and `lib/demand.ts`.
  - **Do not touch `StepSourceLabel`'s `"measured"`**: that is a label a person picks for a step's source (interview, calculator,
    measured, estimate), not calibration.
- Run `gen:types`. Update `json-columns.ts` and `function-types.ts` through it, not by hand.

## 5. The Capacity "time to serve" bars

`components/capacity/capacity-view.tsx` labels the `StackBar` segments with raw purpose keys ("client_job"). Map each key to the
workspace's purpose name (`workspacePurposes` from `@transpera-flow/db`, as the Sandbox's `time.ts` does), with "Not set" for an
unknown key. Add a test.

## 6. Docs

- PRD: in §5 and §8.1 (branding), §6.6 (calibration) and the change-log mentions, mark each as cut by D70, D71 and D72 in one line.
  Don't rewrite the sections.
- `docs/plans/keep-cut-build.md`: change the three "Keep" rows to "Cut (D70/D71/D72)".
- `docs/supabase-notes.md` only if something was verified on plain Postgres only.

## Tests

- `copy-from-supabase.test.ts` (the P0 rule) and `purpose-migration`/`import_workspace_bundle` tests must pass on the new migration.
- Add a migration test (db) for each of these:
  - the tables and functions are gone;
  - a measured provenance entry becomes entered;
  - backup/restore of a workspace still works;
  - `revision_history` still returns authors and notes.
- Full `pnpm lint && pnpm typecheck && pnpm test` with Postgres, and the web build.
- `grep -rn "branding\|calibrat\|change-log\|changeLog\|csv-import\|workspace_logo" apps packages --include=*.ts --include=*.tsx --include=*.sql`
  outside old migrations, and list in your report every hit that remains, with why.

## Screenshots

From the existing browser harnesses, at 1440 light: the Settings hub without the three rows, the sidebar's workspace tile, and the
Capacity time-to-serve card with named segments. Save them under `docs/plans/capacity/q19-shots/`.
