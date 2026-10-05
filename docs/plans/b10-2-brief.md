# B10 part 2 build brief: restore a workspace backup (#39)

Scoped 6 Oct 2026 against `main` at f2ef84f. Read `docs/plans/builder-brief.md` first; this brief adds to it and wins
where they differ. Follow it strictly. If something here is unclear or doesn't match the code, **ask; don't guess.**

## The short version

Part 1 (PR #189, 8a99756) exports a `transpera-workspace/1` JSON backup. Part 2 restores one into a **new, empty
workspace**, and restricts export to the roles Austin named.

| Slice | What | Migration | Status |
|---|---|---|---|
| **B10 (2a)** | Export restricted to agency admins, owners and editors; the pure checker and planner (`checkWorkspaceBundle`, `planWorkspaceImport`) with the order-preserving id remap; their unit tests | none | **Build now** |
| **B10 (2b)** | `import_workspace_bundle` RPC, the restore route and page, the round-trip, role and PostgREST tests | `20261207000000_import_workspace_bundle` | **Blocked on Q1 and Q2** |

Each slice is its own branch and PR: `claude/b10-2a-import-plan` and `claude/b10-2b-restore`, both from `main`. 2a closes
nothing. 2b closes #39 (`Closes #39`).

**Don't conflict with B1.** B1 (1/3) is being built on `claude/b1-1-roles` (migration `20261206000000`). It adds
`packages/db/test/role-matrix.test.ts`, changes the Access page, `apps/web/src/lib/access.ts` and may touch
`components/overview/workspace-overview.tsx` in its read-only audit. Don't edit those files except
`workspace-overview.tsx` (one prop, below); put every test of yours in new files. Merge `origin/main` before opening each
PR. Your migration sorts after B1's, so it must also be applied after it.

---

## Decisions (verbatim)

**Austin's answers on 6 Oct, as recorded on #39:**

> 1. **Import:** (b). Each process is imported as a draft of its latest published version. History isn't restored, and no privileged restore migration is added.
> 2. **Company map:** (b). The new workspace keeps its own company map, which is laid out by default from the imported processes. The bundle still carries every version of the map for reference.
> 3. **Hidden clients:** included in the bundle. Emails and tokens stay out.
> 4. **Who can export and import:** agency admins, owners and editors only, for both. Members and viewers can't.
>
> Point 4 changes part 1: today viewers can export published content. Part 2 will restrict export to the same three roles.

**The option (b) Austin picked for question 1, as the builder offered it on #39 (5 Oct):**

> (b) No migration: import creates each process as a **draft** (latest published version only, history not restored),
> consistent with B13/B14, using the existing `import_process_bundle`. Round-trip test then compares results after
> publishing; history and older versions are in the bundle but not re-created.

**Ticket #39 acceptance criteria that part 2 must meet:**

> - [ ] Importing a bundle into a fresh workspace reproduces identical simulation results at the same seed (round-trip test)
> - [ ] Import rejects bundles with an unknown schema version, with a clear error

**ADR 0014, "History is kept":**

> An editor may only insert a draft, delete a draft, and move a status draft to published or published to superseded (what
> `publish_process`, `restore_version` and `discard_draft` do)

**ADR 0012:** `create_workspace` "refuses an API token … and anyone who isn't an agency admin". New workspaces are made by
agency admins only. This brief doesn't change that (see "Where import lives").

"Agency admins, owners and editors" is exactly `public.can_edit_workspace(ws)` (agency admin by JWT flag, an
`agency_admin` membership, `owner`, `editor`). Use it for both export and import. Don't write a new role helper.

---

## Why 2b needs a migration (read this, then Q1)

Option (b) was offered as "no migration, using `import_process_bundle`". Scoping found that the existing functions can't
restore a whole workspace all-or-nothing:

1. **One transaction per request.** Every Supabase call is its own transaction. `import_process_bundle` /
   `import_new_process` take exactly **one** top-level process (with its children) per call ("only the first process has
   no parent"). Northbeam has several top-level processes. The company model, issues, sources, scenarios and blocks have no
   bulk RPC at all. Without a new function, a restore is dozens of calls, and a failure part-way leaves a half-filled
   workspace that only an agency admin can delete (`delete workspaces` is `is_agency_admin()` only).
2. **Holder steps cross processes.** Since B12 an ordinary process can hold a parent-less process by a link
   (`steps.child_process_id`, composite FK). Every process must exist before any process's steps are written, which
   `import_new_process` (processes and steps per call) can't do across calls.

The fix is **one SECURITY INVOKER function**, `public.import_workspace_bundle`. It is *not* privileged: it runs as the
signed-in user, so row-level security and every existing trigger still decide (drafts only, company-map guards, the
`needs_review` token guard, issue numbering and history, `edit_drafts_only`). It creates drafts only and publishes
nothing. That matches Austin's "no privileged restore migration", but not the literal "no migration" of option (b). Hence
**Q1**. If Austin says no migration at all, see "Fallback if Q1 is no" at the end.

---

## What is restored and what is not

Restore = one new process per bundle process (company map excluded), **as a draft of its live version**, plus the company
model, issues, sources, scenarios, blocks and pending suggestions. Ids are new (see "Id remapping").

| Bundle section | Restored as | Not restored / notes |
|---|---|---|
| `workspace.name`, `slug`, `plan` | — | The new workspace keeps its own. |
| `workspace.settings` | Caller can manage (`can_manage_workspace`: agency admin, owner): `settings = settings || <bundle keys>`. An editor: **one pending suggestion** (`target_table 'workspaces'`, `target_id null`, `patch {set: {...}}`, the shape `packages/mcp/src/suggesting.ts` `proposal("workspaces", null, { set }, prov)` makes) for an owner to accept (Q4) | Only keys of `WorkspaceSettings` (`packages/db/src/types.ts`); unknown keys are dropped with a warning. `provenance` is stamped by the existing trigger. |
| `company_model.roles` | Rows | |
| `people` | Rows | `email` was never exported. |
| `person_roles`, `person_leave` | Rows | |
| `person_skills` | Rows (after steps) | `step_id` remapped. |
| `services`, `service_servicing` | Rows (after processes) | |
| `client_groups` | Rows (after services) | |
| `clients`, `client_services`, `client_assignments` | Rows, `active` as exported | The export adds `hidden: true` to every client (D27). It isn't a column: drop it. Named clients still simulate when active (D42), so they must be restored exactly. |
| `lead_sources`, `seasonality`, `churn_drivers` | Rows | |
| `demand_settings`, `lever_settings`, `analysis_rules` | Upsert the one row per workspace | |
| `market_conditions` | Custom rows (`preset is null`) inserted | The four presets are read-only and the new workspace already has them (`seed_market_presets`): never insert or update a preset row. |
| `market_schedule` | Rows | A row pointing at a bundle preset points at the target's preset with the same `preset` key. |
| `processes` (not `is_company`) | New process, `source 'import'`, a draft opened with `open_draft`; the draft gets the **live** version's steps, edges, `layout` and first principles | Older, superseded and draft versions stay in the file (decision 1). A newer unpublished draft is not restored (listed). A never-published process restores its draft (Q6). Archived processes are restored, then archived (Q7). Revision numbers start at 1. |
| `processes` (`is_company`) | — | Decision 2: the new workspace keeps its own map. Its sync trigger adds a card for each new top-level process, in one system version (ADR 0014, "Bulk is one version"). Cards show once a process is published. |
| `scenarios` | Rows, parents first | A bundle scenario equal (name and patch) to one the new workspace already has (the seeded library) is skipped. |
| `blocks` | Rows | |
| `sources` | Rows with `body` (the text) | `file_path`, `file_name`, `file_type`, `file_size` are cleared: the bundle has no file bytes, and `source_file_guard` refuses a path the caller didn't upload (Q10). |
| `source_links` | Rows (`on conflict do nothing`) | Dropped: `kind 'solution'` (no solutions, Q2), and `kind 'step'` links to a step that isn't in the restored draft (the trigger refuses them). |
| `issues` + `links`, `owner_ids`, `source_ids` | Rows with their final status, in `number` order | Numbers are given again by the trigger (1, 2, 3 … in the old order). `issue_events` is not restored: each issue gets one `created` entry now (and `resolved_at` becomes now; the trigger forces it). Rows with `source = 'detected'` are refused by RLS: left out, so a dismissed insight shows again (Q8). `dismissed_revision_id` and `resolved_solution_id` become null. |
| `issues.events` | — | History isn't restored (decision 1). |
| `solutions`, `solution_issues` | **— (Q2)** | `solutions_before_write` requires a *published* base revision, and every restored process is a draft. Default: left out and listed. |
| `suggestions`, `suggestion_proposals` | **Pending** ones restored as pending, `created_via 'upload'`, `import_source` = the file name | Decided ones are history: left out (Q9). The insert triggers force `pending` anyway. A pending `solution_idea` whose issue isn't restored is left out. |
| `counts`, `about`, `exported_at`, `engine_version`, `scope` | Checked, not stored | |
| Never in a bundle | — | Members, emails, API tokens, share links, access lists, AI settings and keys, runs, AI analyses, findings (B17), narrations, calibrations and datasets (C2). Say so on the restore page. |

Every restored row gets the new workspace's id, and `created_by` is the caller (or null where the trigger sets it). No
`*_by` value from the file is ever written.

---

## Id remapping

Ids must be new (the source workspace usually still exists in the same database) and **their order must be kept**: the
engine sorts by id in many places (`byIdAsc` throughout `packages/db/src/model.ts`; `Object.keys(...).sort()` in
`packages/engine/src/clients.ts`, `forecast.ts`, `cost.ts`, `churn-drivers.ts`), so random new ids change which random
draw goes to which person or step, and the round-trip at the same seed fails.

**The rule (2a, pure TypeScript in `planWorkspaceImport`):**

1. Collect every id in the bundle: the `id` of every row of every section (processes, every version, every step and edge
   of every version, issues, sources, people, roles, …), plus `workspace.id`. Step and edge ids are stable across versions,
   so each maps once.
2. Sort them (lower-case strings), and give the *n*-th one the **placeholder** `00000000-0000-4000-8000-` + `n` as 12
   lower-case hex digits. Placeholders sort in the same order as the old ids.
3. Serialise the plan and replace every uuid-shaped substring (`/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi`)
   that is in the map with its placeholder. This covers ids inside jsonb and strings: steps' `provenance` evidence (source
   ids), `replaced_by`, scenario patch paths (`steps.<id>.work_hours`), `issues.detected_key` and
   `source_links.insight_key` (`perception_gap:step:<id>.work_hours`), blocks' and suggestions' payloads. A uuid that is
   not a bundle id (free text) is left alone. This is the same text replacement `import_process_bundle` does for source
   refs.
4. `workspace.id` maps to the placeholder like the others; the RPC never trusts it (it writes `p_workspace` itself).

**In the RPC (2b):** the database, not the caller, picks the real ids. It generates one random 20-hex prefix per restore
(`substr(md5(gen_random_uuid()::text), 1, 20)`), and replaces `00000000-0000-4000-8000-` with that prefix (formatted
`xxxxxxxx-xxxx-xxxx-xxxx-`) throughout the plan text, once, before reading it. Because the prefix is shared and the last
12 digits are the rank, the new ids sort exactly as the old ones did (Postgres compares uuids bytewise, which matches
lower-case string order). It returns the prefix, so a test can map results back. A caller can't choose a real id, so a
refused insert can't reveal whether some id exists elsewhere (the reason `import_process_bundle` makes source ids itself).

The plan must contain **no** uuid other than placeholders. `planWorkspaceImport` asserts this, and the RPC refuses a plan
with any other uuid-shaped string in an id or foreign-key column (`22023`). Market-schedule rows that point at a preset
carry `condition_preset: 'boom'` instead of a `condition_id`, and the RPC resolves it.

---

## B10 (2a): restrict export, check and plan a restore

Branch `claude/b10-2a-import-plan` from `main`. No migration.

### Export restricted (decision 4)

- `apps/web/src/app/w/[slug]/export/bundle/route.ts`: after reading the workspace, if `can_edit_workspace` isn't `true`,
  return `403` with `{ message: "Only owners, editors and agency admins can export the workspace." }`. Read nothing else
  first. A non-member still gets the existing `404` (RLS hides the workspace). Then call `exportWorkspaceBundle` with
  `canEdit: true`. Update the header comment.
- `components/overview/workspace-overview.tsx`: pass `bundleHref` only when `canEdit` (`bundleHref={canEdit ? … : undefined}`).
  One line; nothing else in that file.
- `packages/db/src/workspace-bundle.ts`: change `about` to: "A Transpera Flow workspace backup. Restore it into a new,
  empty workspace from that workspace's Overview: each process comes back as a draft of its latest published version.
  Rows keep their ids and column names. Named clients are hidden in the product and kept here, flagged hidden. People's
  emails, members, tokens and who made or changed anything are never included. The tables are read one after another while
  people may be editing, so a bundle taken during edits can mix moments: exported_at is when the reading began." Leave
  the `scope` field and the viewer branch of `exportWorkspaceBundle` as they are (old viewer bundles still exist; the
  checker accepts them), but update its doc comment to say the route no longer calls it for viewers.
- Image export and the issues CSV are unchanged (Q3).
- Tests: extend `apps/web/test/export-bundle-route.test.ts`: `canEdit: false` → 403 with that message, and
  `exportWorkspaceBundle` is never called; `canEdit: true` → 200 and the options passed have `canEdit: true`. Add a
  source-text test (new file `apps/web/test/export-gating.test.ts`, the style of `archived-process-page.test.ts`) that
  `workspace-overview.tsx` passes `bundleHref` only under `canEdit`.

### The checker and planner: new `packages/db/src/workspace-import.ts`

Pure: no I/O, so the browser previews with it and the server re-checks with it. Export it from `packages/db/src/index.ts`
and add a subpath export `@transpera-flow/db/workspace-import` the way `@transpera-flow/db/process-file` is exported
(check `packages/db/package.json`), so the client bundle doesn't pull in `pg`.

```ts
export const WORKSPACE_IMPORT_LIMITS = { … };            // see "Size limits"
export interface BundleCheck {
  ok: boolean;
  errors: string[];        // plain sentences; any error blocks the restore
  warnings: string[];      // shown, don't block
  summary: ImportSummary;  // what would be restored and what is left out, with counts
}
export function checkWorkspaceBundle(value: unknown): BundleCheck;
export interface ImportPlan { … }                           // the RPC's p_plan, placeholders only
export function planWorkspaceImport(bundle: WorkspaceBundle, options: { canManage: boolean }): { plan: ImportPlan; summary: ImportSummary; placeholderOf: Map<string, string> };
```

`checkWorkspaceBundle` (in this order; stop at the first of the first four):

1. Not an object → "This isn't a Transpera Flow workspace backup. Choose the .json file that Export → JSON backup made."
2. `format` is `transpera-process/1` or `transpera-process/2` → "This is a process file, not a workspace backup. Upload it
   from Processes → Upload process."
3. `format` starts with `transpera-workspace/` but isn't `transpera-workspace/1` → "This backup is in a format this
   version of Transpera Flow can't read (<format>). It may have been made by a newer version." (acceptance criterion).
4. Any other or missing `format` → the message of 1.
5. Shape: `workspace.id` a uuid; `company_model` an object of arrays; `processes`, `scenarios`, `solutions`,
   `solution_issues`, `blocks`, `issues`, `sources`, `source_links`, `suggestions`, `suggestion_proposals` arrays; each
   process has a `versions` array; every row that has an `id` column has a uuid `id`; no id repeats within a table (step
   and edge ids repeat across versions, but not within one version). Error: "The backup is damaged: <what>, so nothing was
   restored."
6. Every row's `workspace_id`, where present, equals `workspace.id`. Error: "The backup mixes rows from more than one
   workspace."
7. `counts` agree with the sections (the same keys the exporter writes). Error: "The backup looks cut short or edited: it
   says <n> <things> but holds <m>."
8. Exactly one process has `is_company: true`; if none, warn "No company map in the backup; the new one is laid out from
   the processes." If more than one, error (damaged).
9. Limits (below). Error naming the number and the limit, e.g. "The backup has 2,400 steps in the versions it would
   restore; a restore takes at most 2,000."
10. Warnings: `engine_version` differs from `ENGINE_VERSION` ("This backup was made with engine <x>; this is <y>. Numbers
    may differ slightly."); `scope === "published"` ("This backup was made by a viewer: it has no drafts and no pending
    suggestions."); every left-out category with a count (solutions, decided suggestions, detections, unpublished drafts,
    step links to steps no longer in the process, history entries, file originals).

References that point at nothing in the bundle (an issue link to a process not exported, a skill to a step not in any
version) are **dropped with a warning**, not errors: the source database already allowed them.

`planWorkspaceImport` builds the plan from the live version of each process (`versions.find(v => v.live)`; for a
never-published process, the draft) and the sections above, applies the "Not restored" rules, sorts `processes` parents
first (by `parent_process_id`) and `scenarios` parents first, sorts `issues` by `number` (nulls last, then `created_at`),
then remaps ids. Each row keeps only the columns the RPC accepts for its table (the allow-lists below; same constant in TS
and, by a test, in SQL). It also returns the `summary` the page shows.

**Plan shape (`ImportPlan`, the RPC's `p_plan`):**

```jsonc
{
  "format": "transpera-workspace-import/1",
  "settings": { "hours_per_week": 40, … } | null,   // WorkspaceSettings keys only
  "roles": [], "people": [], "person_roles": [], "person_leave": [],
  "lead_sources": [], "seasonality": [], "demand_settings": {} | null, "churn_drivers": [],
  "market_conditions": [], "market_schedule": [],    // schedule rows: condition_id OR condition_preset
  "lever_settings": {} | null, "analysis_rules": {} | null,
  "clients": [],
  "sources": [],                                     // no file_* columns
  "processes": [{ "id", "parent_process_id", "name", "kind", "entity_name", "description",
                  "archived": false, "layout": {}, "steps": [], "edges": [], "first_principles": {} | null }],
  "scenarios": [], "blocks": [],
  "issues": [{ …row, "links": [{process_id, step_id}], "owner_ids": [], "source_ids": [] }],
  "services": [], "service_servicing": [], "client_groups": [], "client_services": [], "client_assignments": [],
  "person_skills": [], "source_links": [],
  "suggestions": [], "proposals": []
}
```

**Column allow-lists** (everything else is dropped; `workspace_id`, `created_by`, `updated_at` and every `*_by` are never
sent). Carry `created_at` on company-model rows, scenarios, blocks, sources and issues, because several loaders order by
`created_at` then `id` (`client_groups`, `churn_drivers`, `market_conditions`, `scenarios`, `blocks`). **Don't** carry
`created_at` on steps or edges: `private.clear_branch_odds` tells the import's own edges from later edits by
`created_at < now()`. Take the column lists from `packages/db/src/database.types.ts` `Row` types minus those; list them as
one exported constant `IMPORT_COLUMNS` so the SQL test can compare.

### Tests (2a)

New `packages/db/test/workspace-import-plan.test.ts` (pure, no database):

- Every message in the checker list, one case each, including the unknown-version case (acceptance criterion) and a
  process file.
- A real export: build it the way `workspace-bundle.test.ts` does (needs Postgres; put that case in
  `workspace-import-plan-db.test.ts` if you'd rather keep the pure file pure), `JSON.parse(JSON.stringify(bundle))`, then
  `checkWorkspaceBundle` is ok and the summary counts match the source tables minus the left-out rows.
- **Order is kept**: for every table, sorting the old ids and sorting their placeholders gives the same permutation.
- No uuid other than a placeholder survives in the plan (scan the serialised plan).
- Ids inside strings are mapped: a scenario path, a `detected_key`, an `insight_key`, a step's evidence source id,
  `replaced_by`.
- Free text holding a uuid that isn't a bundle id is untouched.
- The `hidden` flag is gone from clients; `email` never appears; no `*_by` key at any depth.
- Live version chosen; a never-published process gives its draft; archived flag carried; company map excluded;
  scenarios equal to the seeded library are marked for skipping (the plan carries them; the RPC skips by comparing).
- Limits: one case per limit, at the limit (ok) and one over (error).
- A `scope: "published"` bundle checks ok with the warning.

### Done (2a)

All green locally (`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`). PR body says
what changed for viewers and members (they lose the JSON backup item and get 403 from the route).

---

## B10 (2b): the restore

Branch `claude/b10-2b-restore` from `main` after 2a merges. **Don't start until Austin answers Q1 and Q2.** The spec
assumes the defaults (Q1: one invoker function; Q2: solutions left out).

### Where import lives, and who creates the workspace

- **Creating the workspace is unchanged**: an agency admin creates it on the home page (`app/page.tsx`, `NewWorkspaceForm`
  → `create_workspace`) and, if someone else will restore it, adds them as owner or editor in Settings → Access. Owners
  and editors can't create workspaces (ADR 0012), so for them "import" means restoring into a workspace an agency admin
  set up. Say so on the page (below).
- **Entry point**: the empty Overview. In `components/overview/workspace-overview.tsx`, `EmptyOverview` gets a
  `canRestore` prop (true when `canEditWorkspace(ws)` and the workspace is empty) and shows a card: heading "Restore a
  backup", text "Fill this new workspace from a JSON backup another workspace exported.", an (i) (`components/help.tsx`)
  with description "Every process comes back as a draft of its latest published version. Publish each to see its numbers.
  Older versions, history and solutions stay in the file." and example "Restore northbeam-workspace-2026-10-05.json into a
  new workspace made for Northbeam.", and a link to `/w/<slug>/restore`. `EmptyOverview` is only shown with no published
  process; a workspace with drafts only is not empty by the rule below, so the card hides itself after a restore.
- **The page**: `apps/web/src/app/w/[slug]/restore/page.tsx` (server). Not signed in → the proxy already redirects. Can't
  edit → "Only owners, editors and agency admins can restore a backup." Not empty → "Backups restore only into an empty
  workspace. Ask an agency admin to create a new workspace, then restore it there." Demo mode → "Restoring needs a
  connected workspace; the demo has none." Otherwise render the client component.
- **The client component** `components/restore/restore-backup.tsx`:
  1. File input (`accept=".json,application/json"`). Over `MAX_BACKUP_BYTES` → refuse before reading, with the size.
  2. Read as text, `JSON.parse` (error: "That file isn't valid JSON."), `checkWorkspaceBundle`. Show errors, warnings
     and the summary: two short lists, "Will be restored" (processes as drafts, people, roles, issues, sources, … with
     counts) and "Stays in the file" (older versions, history, solutions, decided suggestions, … with counts). Say what is
     never in a backup (members, emails, tokens, AI settings, findings, calibration).
  3. "Restore" (disabled with errors). Gzip the text in the browser (`new Blob([text]).stream().pipeThrough(new
     CompressionStream("gzip"))`), over `MAX_COMPRESSED_BYTES` → "This backup is too big to restore in one go." POST it to
     the route with `Content-Type: application/gzip` and the file name in `X-Backup-Name` (URI-encoded).
  4. On success, `router.push(`/w/${slug}`)` with a notice (copy the cookie-notice pattern of `lib/processes/upload-notice.ts`):
     "Restored <n> processes as drafts. Publish each one to see its numbers." On failure, show the message.
- **The route**: `apps/web/src/app/w/[slug]/restore/bundle/route.ts`, `POST`, `maxDuration = 60`. A Route Handler, not a
  Server Action: Server Actions cap bodies at 1 MB, and Vercel caps any request at 4.5 MB.
  - Order: env (503 as the export route) → session (401) → `Origin` header must equal the request's own origin (403
    "Refused.", against cross-site posts) → workspace by slug under RLS (404) → `can_edit_workspace` (403, message above)
    → body size (`Content-Length` and the bytes read) ≤ `MAX_COMPRESSED_BYTES` (413) → gunzip with `DecompressionStream`,
    counting bytes and aborting past `MAX_BACKUP_BYTES` (413; a gzip bomb stops there) → `JSON.parse` (400) →
    `checkWorkspaceBundle` (400 with its errors) → `can_manage_workspace` → `planWorkspaceImport` → `rpc("import_workspace_bundle", …)`.
  - Map RPC errors to messages (`lib/restore/errors.ts`, unit-tested): `42501` → the role message; hint `not_empty` →
    the not-empty message; hint `section:<name>` → "Couldn't restore <section in words>: <the database's message>.";
    `57014` (statement timeout) → "This backup is too big to restore in one go (the database ran out of time). Nothing was
    restored."; anything else → "The restore failed. Nothing was restored. Try again." Never echo SQL.
  - `200 { processes: [{id, name}], counts, leftOut, settings: "applied" | "suggested" }`. `Cache-Control: private, no-store`.

### Migration `packages/db/supabase/migrations/20261207000000_import_workspace_bundle.sql`

Strictly additive: one function. It doesn't redefine `save_fields` or any existing function or trigger.

`public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text default null) returns jsonb`,
`language plpgsql security invoker set search_path = ''`. `revoke all … from public, anon, authenticated; grant execute …
to authenticated;`.

Copy the structure and style of `import_process_bundle` (20261129000000) and `import_new_process` (20261128000000, as
amended by 20261204000000). In order:

1. **Who.** Refuse an API token (`coalesce(auth.jwt(), '{}') ? 'api_token_id'` → `42501`, "Backups are restored in the
   app."), as `create_workspace` does. Refuse unless `public.can_edit_workspace(p_workspace)` (`42501`, "Only owners,
   editors and agency admins can restore a backup."). Check both before reading the plan.
2. **Shape.** `p_plan ->> 'format' = 'transpera-workspace-import/1'`, sections of the right jsonb types, and the limits
   again (same numbers as `WORKSPACE_IMPORT_LIMITS`), else `22023`.
3. **Lock.** `pg_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || p_workspace::text, 0))` and also the
   `import_new_process:` key that `import_new_process` takes, so an upload can't run alongside.
4. **Empty.** Refuse (`raise … using errcode = '23514', hint = 'not_empty'`, "This workspace isn't empty: …") when any of
   these has a row for `p_workspace`: `processes` other than `is_company` (archived included), `roles`, `people`,
   `services`, `client_groups`, `clients`, `lead_sources`, `churn_drivers`, `market_schedule`, `issues`, `sources`,
   `blocks`, `solutions`, `suggestions`, `suggestion_proposals`, `market_conditions` with `preset is null`, or
   `scenarios` not equal (name and patch) to a row of `private.scenario_library()`. `demand_settings`, `lever_settings`,
   `analysis_rules` and the workspace's settings may already exist: they are overwritten.
5. **Ids.** Replace the placeholder prefix with a fresh one (see "Id remapping") in `p_plan::text`, once. Refuse any
   uuid-shaped value in an id or foreign-key field that doesn't start with the new prefix (`22023`).
6. **Write, in this order**, each section inside `begin … exception when others then raise exception
   'import_workspace_bundle: % could not be restored: %', '<section>', sqlerrm using errcode = sqlstate, hint =
   'section:<section>'; end;` (one block per section, not per row). Every insert lists its columns explicitly from the
   allow-list (`jsonb_populate_recordset(null::public.<t>, …)` then `select <cols>`) and sets `workspace_id = p_workspace`.
   1. Settings: if `public.can_manage_workspace(p_workspace)`, `update public.workspaces set settings = settings || <keys>`;
      otherwise one `suggestions` row (with `transpera.importing` on, so it is `upload` with `import_source = p_label`).
   2. `roles`, `people`, `person_roles`, `person_leave`, `lead_sources`, `seasonality`, `demand_settings` (upsert on
      `workspace_id`), `churn_drivers`, custom `market_conditions`, `market_schedule` (resolve `condition_preset` to the
      workspace's preset row), `lever_settings` and `analysis_rules` (upsert), `clients`.
   3. `sources`, with the file columns null. Before steps: the `link_cited_sources` trigger links a step to the sources it
      cites as the step is written.
   4. `processes`, parents first: insert as `import_new_process` does (`source 'import'`, `parent_process_id`), then
      `public.open_draft(id)` (must return `status 'ok'`); set the draft's `layout`. Archived ones are inserted unarchived
      for now.
   5. `scenarios` (parents first; skip one equal to an existing row), `blocks`.
   6. `issues` in plan order, then `issue_links`, `issue_owners`, `issue_sources` (`on conflict do nothing`: the
      `issue_seed_links` trigger and `link_issue_source` already add some). Issues go **before steps** so that
      `log_perception_gaps` (which inserts a perception-gap issue `on conflict (workspace_id, detected_key) do nothing`
      when a step has an unresolved conflict) finds the restored issue and adds no duplicate.
   7. Steps and edges of each draft, as `import_new_process` writes them (entry steps set after all steps are in), then
      the draft's `first_principles` row.
   8. `services`, `service_servicing`, `client_groups`, `client_services`, `client_assignments`, `person_skills`.
   9. `source_links` that pass the trigger's rule (`on conflict do nothing`; skip step links whose step isn't in that
      process's restored draft, and count them).
   10. Pending `suggestions` and `proposals`, between `set_config('transpera.importing', 'on', true)` and `''`, as
       `import_process_bundle` does.
   11. Archive the archived ones: `update public.processes set archived_at = now() where id = any (…)` (the guard stamps
       `archived_by`; the map's sync takes the card off in the same system version).
   12. `public.log_process_import(id, 'Restored from a workspace backup' || coalesce(' (' || p_label || ')', ''))` for each
       process (it requires `source 'import'`, `created_by = auth.uid()`, under ten minutes old, and not logged yet).
7. Return `{ id_prefix, processes: [{id, name, revision_id, archived}], counts: {<section>: n}, skipped: {<reason>: n},
   settings: 'applied' | 'suggested' }`.

Header comment (copy the shape of `20261129000000_import_bundle.sql`): purpose; the decisions quoted; "security invoker,
creates drafts only, publishes nothing, writes no history"; the order and why (sources before steps, issues before steps);
the id rule; limits and the 8 s `statement_timeout` for `authenticated`; preflight; post-apply checks; rollback:

```sql
-- Rollback (nothing existing was changed):
--   begin;
--   drop function if exists public.import_workspace_bundle(uuid, jsonb, text);
--   delete from supabase_migrations.schema_migrations where version = '20261207000000';
--   commit;
-- Roll the app back first (it calls the function). Workspaces already restored stay as they are.
```

**Apply file** `packages/db/scripts/apply/20261207000000_import_workspace_bundle.sql`: `begin;`, the migration SQL, the
`insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261207000000',
'import_workspace_bundle', array[$mig$…$mig$]);` row, `commit;`. Header "applies after 20261206000000 (B1 1/3)", in the style
of `scripts/apply/20261205000000_analysis_findings.sql`.

**Preflight** (in the header and the PR body):

```sql
-- 0. B1 (1/3) applied, nothing later. Expect only 20261206000000 (and earlier):
select version from supabase_migrations.schema_migrations where version >= '20261206000000' order by 1;
-- 1. Not created yet. Expect null:
select to_regprocedure('public.import_workspace_bundle(uuid, jsonb, text)');
-- 2. What it calls exists. Expect 7 rows:
select proname from pg_proc where pronamespace = 'public'::regnamespace
  and proname in ('open_draft', 'log_process_import', 'can_edit_workspace', 'can_manage_workspace', 'import_new_process', 'import_process_bundle', 'create_workspace');
-- 3. The upload marker is honoured by both insert triggers. Expect two rows, both true:
select proname, prosrc like '%transpera.importing%' from pg_proc where pronamespace = 'private'::regnamespace
  and proname in ('suggestions_before_write', 'suggestion_proposals_before_write');
-- 4. 'upload' is an allowed created_via. Expect 2 rows mentioning 'upload':
select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('suggestions_created_via', 'suggestion_proposals_created_via');
-- 5. The library and presets it compares against. Expect 4 and 4:
select count(*) from private.scenario_library(); select count(*) from private.market_presets();
```

Post-apply: `authenticated` has EXECUTE, `anon` and PUBLIC don't (the `routine_privileges` and `proacl` checks of
20261129000000); `proconfig = array['search_path=""']`; `prosecdef` is false.

Then `pnpm --filter @transpera-flow/db gen:bootstrap` and `gen:types`. No `gen:seed` (fixtures don't change).

### Size limits

| Limit | Value | Where |
|---|---|---|
| Backup file (raw, and decompressed on the server) | 25 MB (`MAX_BACKUP_BYTES`) | browser, route |
| Compressed request body | 4 MB (`MAX_COMPRESSED_BYTES`; Vercel's limit is 4.5 MB) | browser, route |
| Serialised plan | 10 MB | `planWorkspaceImport`, RPC |
| Processes restored | 200 | checker, RPC |
| Steps / edges in the restored versions | 2,000 / 4,000 | checker, RPC |
| Sources / their text | 300 / 5,000,000 characters in all | checker, RPC |
| Issues | 2,000 |  |
| People / clients | 1,000 / 5,000 |  |
| Scenarios / blocks / suggestions / proposals | 500 / 500 / 1,000 / 500 |  |

These are starting values. **The performance test is the arbiter**: a synthetic plan at every limit must restore in under
3 s on the container's Postgres (Supabase's `authenticated` role has an 8 s `statement_timeout`, and one RPC is one
statement). If it doesn't, lower the limits until it does and say so in the PR. Don't raise any timeout.

### Tests (2b)

**New `packages/db/test/workspace-import.test.ts`** (`createTestDb`, `createUser`, `db.as(claims, fn)`, savepoints around
expected failures; copy `import-bundle.test.ts` and `workspace-bundle.test.ts`):

- **Round-trip (acceptance criterion), for Northbeam and for Larkspur.**
  1. Export the seeded workspace as its editor (as `workspace-bundle.test.ts` does), `JSON.parse(JSON.stringify(…))`.
  2. An agency admin creates a new workspace with `create_workspace` and adds an `owner` membership for a test user.
  3. As that owner: `checkWorkspaceBundle` ok → `planWorkspaceImport(…, { canManage: true })` → `import_workspace_bundle`.
  4. As the owner, publish every restored process with `publish_process` (children before parents; if an order is
     refused, find the order that works, and say which in the PR).
  5. Load each process's bundle from both workspaces the way `database.test.ts` `loadSeeded` does (parameterise it; don't
     edit `database.test.ts`), `toEngineModel(bundle, { startDate: "2026-10-05" })`, and `simulate(model, 30, 42)`.
  6. Map the restored ids back to the old ones (`id_prefix` + the plan's placeholders) by text replacement over the
     serialised model and result, and assert **both are equal** to the source's (`toEqual`). Also `toEqual` on the engine
     models before simulating, so a failure says whether the model or the run differs.
  7. Row counts per table equal the source's minus the documented left-outs.
- **What is left out is left out**: no solutions, no `issue_events` beyond one `created` (and `resolved` / `solution_tested`
  the triggers add) per issue, revision numbers start at 1, only drafts exist (no `published` revision of a restored
  process before step 4), no file columns on sources, no decided suggestions.
- **Company map**: the new workspace's map has one card per restored top-level, non-archived process, made in **one**
  system version; the bundle's map rows are nowhere.
- **A process held by a link inside an ordinary process (B12)**: after publishing, it isn't on the company map as well
  (the "gives way" rule, #188). If publishing is refused instead, stop and ask.
- **Archived process**: restored, archived, off the map, not simulated.
- **Perception gaps**: a step with an unresolved conflict and its restored issue gives exactly one issue.
- **Scenarios**: the seeded library isn't duplicated.
- **Editor**: as an `editor` of the new workspace the restore succeeds, and the workspace settings arrive as one pending
  suggestion (`created_via 'upload'`, `import_source` = the label); the owner accepts it with `review_suggestions` and the
  settings match.
- **Roles**: agency admin (JWT flag), `agency_admin` membership, owner, editor succeed; member, viewer and a signed-in
  non-member get `42501` and **nothing is written** (count rows in every table before and after); `anon` can't execute.
- **Not empty**: into Northbeam → `not_empty`, nothing written. Into a new workspace with one role added → `not_empty`.
  Twice in a row → the second fails `not_empty`.
- **All or nothing**: a plan with a bad row in the *last* section (e.g. a suggestion with an unknown `target_table`)
  fails with `hint = 'section:suggestions'`, and every table is unchanged (processes, map versions and audit log
  included).
- **Ids**: a plan with a real (non-placeholder) uuid in an id column → `22023`; two restores of one backup into two new
  workspaces both succeed with different ids.
- **Performance**: the synthetic plan at every limit, timed (see "Size limits").
- **SQL and TS agree**: the function's column lists equal `IMPORT_COLUMNS` (read them from `pg_proc.prosrc` or test by
  inserting a plan with every allowed column).

**PostgREST** (`packages/mcp/test/postgrest-restore.test.ts`, copying `postgrest-import-v2.test.ts`'s setup): an owner's
session restores a small plan through `/rest/v1/rpc/import_workspace_bundle`; the same call with an owner's **API token**
is refused (42501, which PostgREST may answer as 401: see `docs/supabase-notes.md`, suggestions row).

**App** (`apps/web/test/`):

- `restore-route.test.ts` (mock like `export-bundle-route.test.ts`): 503 demo, 401 signed out, 403 bad `Origin`, 404
  unknown workspace, 403 member/viewer (the RPC isn't called), 413 over 4 MB compressed, 413 when decompressing passes
  25 MB (a gzip bomb), 400 invalid JSON, 400 unknown format with the checker's message, 200 passes `canManage` correctly,
  each RPC error mapped to its message and no SQL text in any body.
- `restore-errors.test.ts`: the error mapper.
- A browser test of the restore page with a small fixture bundle (use an existing harness, e.g. `overview-page-harness`):
  pick the file, the summary shows, Restore posts gzip (assert the request), the error shows for an unknown version.
- Screenshots: demo mode has no restore, so render the client component in the harness and screenshot it (light and
  dark, 1440 and 400 px) with a summary and with an error.

### Done (2b)

- All green locally (`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`), including the
  round-trip for both golden workspaces.
- Bootstrap and types regenerated; the apply file written; preflight in the PR body.
- `docs/supabase-notes.md` gains a row: the restore is verified on plain Postgres 16 and PostgREST only. Live checks:
  restore a Northbeam backup into a new workspace on a preview deploy; time it; check a plan near 10 MB isn't refused by
  the API gateway's request size limit and finishes inside the 8 s timeout; check the notice and the drafts list.
- `CONTEXT.md`: add **Backup** ("A JSON file of a whole workspace, made by Export → JSON backup and restored into a new,
  empty workspace. Each process comes back as a draft of its latest published version; history, older versions and
  solutions stay in the file. _Avoid_: bundle (in the UI), snapshot"). The UI says "backup" and "restore", never "bundle"
  or "import".
- PR body: the "left out" table above, what changed for viewers and members, and the migration.

---

## Edge cases

- **Empty, defined.** See step 4 of the RPC. A workspace an agency admin just created passes (company map, scenario
  library, market presets only). A workspace with a single role, process or issue doesn't.
- **Two restores at once** into one workspace: the advisory lock serialises them; the second fails `not_empty`.
- **An upload during a restore**: the shared `import_new_process:` lock key serialises it.
- **Viewer-made backups** (`scope: "published"`): accepted with a warning.
- **A process never published**: its draft is restored (Q6). **A newer draft than live**: live is restored, the draft is
  dropped and counted.
- **Archived processes**: restored then archived (Q7). Names: an archived process may share a name with one in use; the
  RPC inserts rows directly (no name check), so this doesn't clash.
- **Nested and linked processes**: all processes exist before any step, so holder steps (`child_process_id`) resolve
  whichever process they point at.
- **Services and client work** point at restored processes (`entry_process_id`, `service_servicing.process_id`); the
  `servicing_link_kind` trigger still checks kinds.
- **Issues resolved by a solution**: `resolved_how` stays `solution`, `resolved_solution_id` is null (the check allows it).
  An issue "Testing solutions" keeps that status with no solution.
- **Dismissed rows** that aren't `source = 'detected'` come back dismissed with `dismissed_revision_id` null, which means
  "before any version": the dismissal ends at the first publish, so the insight may show again. Accept it; say it in the
  summary.
- **Scenarios that name steps or people** (`steps.<id>…`) are remapped; one naming a step that isn't in the restored draft
  shows "needs attention", as it would have in the source.
- **Engine version differs**: a warning only.
- **Workspace settings as an editor**: a pending suggestion; until an owner accepts it, the new workspace simulates with
  its own defaults (the summary and the notice say so).
- **Currency** is owner-only (#190): it is in the settings, so it follows the same rule.
- **Source files**: originals aren't in the backup; the text is.
- **Realtime**: only `steps`, `edges` and `processes` are published; a restore sends many change events to anyone already
  viewing the new workspace. Harmless.
- **MCP**: no restore tool; the RPC refuses API tokens.
- **Demo mode**: no restore (503 and a page message), as for export.

## Out of scope

- Restoring history, older versions, version numbers, issue history, who did what, or decided suggestions (decision 1).
- Replacing the new workspace's company map with the backup's (decision 2).
- Restoring into a workspace that isn't empty, merging, or partial restore.
- Creating the workspace from the restore page; letting owners or editors create workspaces.
- An MCP tool for backup or restore; restoring members, access lists, tokens, AI settings, findings, calibration.
- A "Publish all" button (Q11).
- Exporting more than part 1 does (findings, calibrations): a follow-up if Austin wants them in backups.
- Any change to the engine or golden numbers; no `ENGINE_VERSION` bump.

---

## Questions for Austin

**Blocking (2b only; 2a can be built now):**

**Q1. May the restore add one non-privileged database function?** You picked option (b), which was offered as "no
migration". A whole workspace can't be restored all-or-nothing with the existing functions: they take one top-level
process per call, and each call is its own transaction. The proposal is one function that runs as the signed-in person,
so every existing permission and rule still applies; it creates drafts only, publishes nothing and writes no history.
*Proposed default: yes, add it (`20261207000000`).* If no, see the fallback below.

**Q2. What happens to solutions?** A solution must be built on a published version, and every restored process is a
draft, so the database refuses restored solutions. Choose:
- **A (proposed default):** solutions stay in the file and aren't restored. Issues keep their status ("Testing solutions",
  "Resolved by a solution") without the link. The restore page lists them.
- **B:** a follow-up "Bring back solutions" step after publishing, which re-reads the same file and rebuilds each solution
  on the newly published version. A separate ticket.
- **C:** the restore publishes each process straight away, so solutions can come back. That reverses decision 1.

**Non-blocking (the builder uses the default unless Austin says otherwise):**

- **Q3.** Does "export" in decision 4 also cover the map image (PNG/SVG) and the issues CSV, which show only what's on
  screen? *Default: no, only the JSON backup.*
- **Q4.** When an editor restores, workspace-wide settings (hours a week, horizon, currency) can't be written by an editor.
  *Default: they arrive as one pending suggestion an owner accepts; until then the workspace uses its defaults.*
- **Q5.** Should agency admins get "Create from a backup" on the new-workspace form? *Default: no; create, then restore.*
- **Q6.** A process that was never published has no "latest published version". *Default: restore its draft.*
- **Q7.** Archived processes. *Default: restore them, then archive them again.*
- **Q8.** Dismissed detections (stored as detections) can't be written by anyone. *Default: left out; the insight shows
  again until dismissed.*
- **Q9.** Decided suggestions and proposals are history. *Default: left out; pending ones come back pending, marked as from
  the backup.*
- **Q10.** Source originals (PDFs, spreadsheets) aren't in a backup, only their text. *Default: restore the text; the
  source shows no file to download.*
- **Q11.** Publishing many drafts one by one is slow. *Default: no "Publish all" button in this ticket.*

---

## Fallback if Q1 is no

No migration. The route makes ordered calls instead of one: the company model with direct inserts, then
`import_process_bundle` once per top-level process tree. A tree whose holder points at a process from a later tree is
written in a second pass (steps inserted into the draft). Issues, scenarios, blocks and source links are direct inserts.
**It isn't all-or-nothing.** On a failure the route stops, and the page says "The restore stopped part-way. Ask an agency
admin to delete this workspace, then create a new one and try again." The round-trip and role tests stay the same; the
all-or-nothing test becomes "a failure leaves the workspace marked as not empty and says so". The orchestrator re-scopes
2b in detail if Austin picks this.
