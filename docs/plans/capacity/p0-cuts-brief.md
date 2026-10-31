# P0: cuts and hides

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p0-cuts`, from `claude/relaxed-babbage-51ysen`.
Sources: D12, D21, D33 and `docs/plans/keep-cut-build.md` (the "Cut" and "Hide" rows).

## The short version

The client's app loses five things:
- first principles;
- every share link;
- the older process-level lever system;
- the `/demo` pages;
- Sources, from the menu.

Goal seek and "What matters most" leave the Sandbox screen, but their code stays. Nothing a user keeps (processes,
people, clients, scenarios, issues, solutions, blocks) changes, and no engine number moves.

## What to do, in this order (one commit each at least)

### 1. Move the bottleneck logic before deleting anything

`apps/web/src/components/bottleneck-panel.tsx` holds the logic that names the bottleneck and the work waiting on it
(A3).
- Move the pure part (no React) to `apps/web/src/lib/capacity/bottleneck.ts`, with unit tests that pin today's
  output on the Northbeam and Larkspur fixtures.
- P5's Capacity page will use it.
- If the logic is already a pure function in `packages/engine` (`bottlenecks.ts`), say so and only add the tests.

### 2. Cut first principles

Remove:
- the pages `w/[slug]/p/[processId]/first-principles` (and the `/demo` copy);
- `components/first-principles/*`, `workspace-first-principles-page.tsx` and the process page's first-principles card;
- every link and reference to them, including the editor, inspector, step inspector, overview, issues, the
  upload-process dialog and the skeletons;
- the MCP tool `get_first_principles` (`packages/mcp`), its tests and its line in any tool list or doc;
- `packages/db/src/first-principles.ts` and `packages/engine/src/first-principles.ts`, if nothing left uses them;
- their tests.

**Tables:** drop the first-principles tables in a migration (see "Migrations"). Check first that no other table
references them.

### 3. Cut every share link

Remove:
- the visitor page `app/s/[token]`;
- the link list `w/[slug]/share`;
- `share-actions.ts`, `lib/share/*` and `components/share/*` (the share dialog, shared view and play section);
- the share buttons on the overview, process, issue and solution pages;
- the Sandbox scenario share (`scenario-share-view.tsx` and its button);
- `packages/db/src/share*.ts` and `share-text.ts`;
- the share functions and tables (`share_links`, scenario share links from `20270116000000`, `share_team_capacity`,
  snapshot triggers) in a migration;
- anything in `proxy.ts` that only lets share visitors in.

**Careful:** `components/share/play-section.tsx` may be the map playback used elsewhere. If anything outside sharing
imports it, move it to `components/map/` instead of deleting it.

### 4. Cut the older process-level lever system

Remove:
- `scenario-panel.tsx`, `lever-panel.tsx`, `compare-view.tsx`, `robustness-check.tsx` and `process-view.tsx`;
- `settings/levers` (page and nav item) and `packages/db/src/lever-settings.ts`;
- `bottleneck-panel.tsx`, once item 1 is done;
- the `/demo` copies of these.

**Keep:**
- the Sandbox (`components/sandbox/*`) and its levers (`packages/db/src/sandbox-levers.ts`);
- solutions and solution compare (`solution-compare.tsx`);
- the engine's `robustness.ts` if solutions or the Sandbox use it.

**Check the people page:** `people-page.tsx` imports one of these components. Keep the people page working (P5
replaces it later). Inline or move what it needs.

If a lever setting lives in a table or a `workspaces.settings` key, leave the stored data alone. Stop reading it, and
note the key in the PR text for a later clean-up.

### 5. Remove `/demo`

- Delete `apps/web/src/app/demo/**` and every link to `/demo` (home page, login, sidebar, docs).
- **Keep** `packages/engine/src/fixtures/*` (Northbeam, Larkspur), `packages/db/src/fixtures/*` and every golden
  model: the engine's golden tests and many db tests use them (`docs/engine-versioning.md`).
- Remove only code that nothing but the demo routes imports. Check with `grep` before deleting a fixture helper.

### 6. Hide Sources

- Take Sources off the workspace menu.
- Keep `w/[slug]/sources` reachable by URL, and keep all its code and tables (Q3: hide, not cut).
- Remove the menu entry only. Leave links to Sources from other pages; if one sits in a main flow, list it in your
  report.

### 7. Hide goal seek and "What matters most" (D33)

- In `components/sandbox/sandbox-view.tsx`, stop rendering the goal-seek button and dialog and the tornado section.
- Keep `goal-seek-dialog.tsx`, `tornado.tsx`, `lib/sandbox/tornado.ts`, `goal-targets.ts` and `analysis-run.ts`, with
  their tests.
- Guard the hidden UI with one exported constant, `SANDBOX_ANALYSIS_SHOWN = false` in `lib/sandbox/`, so it comes
  back with one line.
- Adjust e2e and visual tests that click those controls. Don't delete the unit tests.

### 8. Docs

Update the docs that describe removed features: `README.md`, `docs/HANDOVER.md`, MCP tool lists, `docs/new-client.md`
if it mentions the demo or share links. Keep it short. Don't rewrite the PRD; add one line to its decision log if it
has one for cuts.

## Migrations

- One file, `packages/db/migrations/20270118000000_capacity_cuts.sql`.
- Drop the first-principles and share tables, functions, policies and triggers, in dependency order.
- The header comment holds full rollback SQL: the original `create` statements, copied from the migrations that made
  them.
- `packages/db/test/copy-from-supabase.test.ts` must pass. It imports a production-shaped copy and runs every later
  migration, so drops must not fail on real rows.
- Add a db test that the dropped objects are gone and that a workspace bundle export and restore still round-trips.
  `workspace-bundle.ts` and `workspace-import.ts` may carry share or first-principles rows. Remove them from the
  bundle, and make restore **ignore** them in older bundles. Don't reject an older bundle.
- Run `gen:types`, `gen:seed` and `gen:bootstrap`.

## Done when

- `grep -ri "first.principles\|share_link\|/demo\|lever-panel\|scenario-panel" apps packages` finds only:
  - migrations;
  - this brief;
  - the restore code that skips old rows;
  - the PRD history.
- The app builds (`pnpm --filter @transpera-flow/web build`), and `pnpm lint && pnpm typecheck && pnpm test` pass.
- Goldens are unchanged, and `ENGINE_VERSION` is still 1.14.0. This package moves no engine number. If one moves,
  stop and report.
- Your report lists every route and table removed, and every stored setting you stopped reading.
