# C6 follow-up build brief: the change log names the step of a per-person time (#230)

Scoped 7 Oct 2026 against `origin/main` at `bf61be0e` (C6 #229 merged; production at row 67, `20261223000000`). Read
`docs/plans/builder-brief.md` first, then `docs/plans/c6-brief.md` (what C6 built). This brief adds to them and wins where
they differ. Build strictly from it. If something here doesn't match the code, **ask; don't guess.** Every open question
has a default: use it.

| | |
|---|---|
| Branch | `claude/c6-audit-step` (this brief is its first commit; build on it) |
| Migration | `20261225000000_audit_factor_step.sql`, ledger row **69** |
| Apply file | `packages/db/scripts/apply/20261225000000_audit_factor_step.sql` |
| Closes | #230 (`Closes #230`) |
| Engine | No change. No `ENGINE_VERSION` bump. No golden number moves. |

## The short version

Today the owner's change log (Suggestions → "Recent changes to the company model") says "Sam Patel: a per-person time
changed" and can't say which step, because `private.audit_company_write` adds `step_id` to the diff only for
`person_skills`, and an UPDATE's diff holds only the columns that changed (`factor`, `provenance`).

1. **Database.** Replace `private.audit_company_write()` with a full copy of its latest body (the only definition,
   `20261015000000_suggestions.sql` L240) plus **two lines**, marked `-- #230`: for `person_capacity_factors`, the diff gains
   `step_id` (the row's step) or `every_step: true` (the row is the person's "Every step" time). Nothing changes for any
   other table.
2. **App.** `describeAuditEntry` names the step: "Sam Patel: per-person time on Kickoff changed", "Sam Patel: per-person
   time for every step set". Never the number. The Suggestions page loads the step names the log needs. Skills get the same
   step name (Q3).

Commit and push after each part: (1) migration, apply file, DB tests; (2) app text, loader, unit tests; (3) docs.

---

## Decisions (verbatim)

**Austin, 7 Oct 2026 (relayed by the orchestrator):** Austin approved the C6 defaults and asked for "all the things you can
build", approving #227, #228 and #230.

**#230 (the whole body, as filed):**
> `private.audit_company_write` (20261015000000_suggestions.sql) adds `step_id` to the diff only for `person_skills`. On an
> update of a `person_capacity_factors` row the diff holds only `factor` and `provenance`, so the owner's change log can't
> tell "Every step" from a particular step. Fix: add `person_capacity_factors` to the `step_id` case in a new migration that
> redefines the function (a full copy of its latest body plus that line), then say the step in the change-log text
> (`apps/web/src/lib/suggestions/audit.ts`; never the number). Found in the review of #229; not additive, so left out of C6.

**The C6 brief's change-log rule (c6-brief.md, Part 3):**
> The entry reads `${who}: a per-person time ${set | removed | changed}`. It never states the number in text (the diff holds
> it, and only managers read the log).

**C6's defaults, confirmed by Austin (comment on #198, 7 Oct):**
> - Factors are off per workspace, and only owners and editors switch them on and set them.
> - Owners, editors and agency admins see everyone's factors. A member sees only their own.

**PRD D20:**
> Capacity, not performance: individual availability/skills/assignments; capacity factor off by default, shown only when
> measured, visible to the person, never ranked; no role-median benchmark. DPA clause in the retainer.

**HANDOVER, "Production migrations":** "Additive only; verify after each … Anything destructive … needs Austin's go-ahead
first." A `create or replace` of a function with the same signature, as a full copy of its latest body, is the accepted
pattern (rows 17, 57, 61, 67).

---

## Audit: what exists on `origin/main`

| Thing | State | #230 change |
|---|---|---|
| `private.audit_company_write()` | SECURITY DEFINER, `search_path = ''`, returns trigger. **Defined once**, `20261015000000_suggestions.sql` L240–293; nothing later redefines it. Body md5 **`e936352b8a20cdd8fd374756e4fa4439`** (2,130 characters; computed from the file with the same method that reproduces row 54's and row 61's recorded md5s). `revoke all … from public, anon, authenticated` (L295). | `create or replace`, full copy plus two marked lines |
| Its `jsonb_strip_nulls(jsonb_build_object(...))` diff | `old`, `new` (whole rows on INSERT/DELETE, only changed columns on UPDATE), `role_id` (person_roles, client_assignments), `service_id` (client_services), `step_id` (**person_skills only**), `suggestion_id`, `api_token_id`. `jsonb_strip_nulls` strips nulls **at every depth**, so an INSERT/DELETE of a "Every step" row has no `step_id` inside `new`/`old` either. | add `step_id` for `person_capacity_factors`, and `every_step: true` when its `step_id` is null |
| Tables whose `audit_company` trigger runs it (**18**) | `20261015000000` loop: workspaces, roles, services, people, person_roles, person_skills, person_leave, clients, client_services, client_assignments, lead_sources, seasonality, demand_settings, suggestions. Then `service_servicing` (`20261016000000` L154), `client_groups` (`20261111000000` L108), `churn_drivers` (`20261116000000` L128), `person_capacity_factors` (`20261223000000` L197). | Every one keeps exactly today's diff except `person_capacity_factors` (test it, below) |
| `target` inside the function | Declared from the **whole** row (`coalesce(row_new, row_old)` before `row_new` is narrowed to the changed columns), so `target -> 'step_id'` is the row's step even on an UPDATE that changed only `factor`. For a null column `target -> 'step_id'` is JSON `null`. | Read it there |
| Change-log text | `apps/web/src/lib/suggestions/audit.ts` L105–109: skills "a skill added/removed/changed"; factors "a per-person time set/removed/changed". `AuditEntry.diff` type L15 has no `step_id`. | Name the step |
| Who calls it | `components/suggestions-review.tsx` L340 `ChangeLog({ entries, model, people })` → L361 `describeAuditEntry(e, model)`. Page: `app/w/[slug]/suggestions/page.tsx` L45. Loader: `lib/company-data.ts` `loadSuggestionsPage` L118 (reads `audit_log` only when `can_manage_workspace`: owners and agency admins). | Pass step names |
| Tests | `apps/web/test/suggestions.test.ts` L99–131 ("the change log", the C6 case at L124). `packages/db/test/capacity-factors.test.ts` L205–229 checks the factor audit rows with `toMatchObject` (extra keys don't break it). No test asserts an audit_company diff with `toEqual` (`grep -n "diff).toEqual" packages/db/test` shows only process-history entries, which another function writes). | Extend |
| Other migrations in flight | #228 (`20261226000000`) replaces `import_workspace_bundle`; #227 (`20261227000000`) replaces `apply_calibration`, `calibration_payload_problem`, `record_calibration_import` and `team_capacity`. **None touches `audit_company_write` or `audit.ts`.** Both write `person_capacity_factors` rows, which this trigger logs: with #230 applied their entries name the step too. | Independent |

---

## Part 1: migration `20261225000000_audit_factor_step.sql`

One statement and its revoke, nothing else:

```sql
create or replace function private.audit_company_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
  … the body of 20261015000000_suggestions.sql L244–292, copied character for character, with ONLY the change below …
$$;

revoke all on function private.audit_company_write() from public, anon, authenticated;
```

**The change** (and nothing else: not even reformatting). In the `jsonb_build_object` of the diff, replace the line

```sql
      'step_id', case when tg_table_name = 'person_skills' then target -> 'step_id' end,
```

with

```sql
      -- #230: a per-person time names its step, or says it is the person's time for every step (its step_id is null, which
      -- jsonb_strip_nulls would otherwise drop at every depth).
      'step_id', case when tg_table_name in ('person_skills', 'person_capacity_factors') then target -> 'step_id' end,
      'every_step', case when tg_table_name = 'person_capacity_factors' and target -> 'step_id' = 'null'::jsonb then 'true'::jsonb end,
```

For `person_skills` the expression gives exactly what it gives today. For the other 16 tables both new expressions are
SQL null and `jsonb_strip_nulls` removes them, so their diffs are unchanged.

Generate the copy with a script from the 20261015 file (don't retype it), then apply the edit. A test (below) proves the
new body is the old one plus exactly these lines.

### Header (copy the style of `20261223000000_capacity_factors.sql`)

- Purpose: #230; the decision quoted; what the change log gains.
- "One `create or replace` of `private.audit_company_write()`, same signature, SECURITY DEFINER, `search_path = ''` and
  grants; a full copy of its only definition (20261015000000) plus two marked lines. Shared by 18 tables (list them);
  only `person_capacity_factors` diffs change. It doesn't redefine `save_fields` or anything else."
- **ORDER:** after `20261223000000` (row 67, which made `person_capacity_factors`). Independent of #228 (`20261226000000`)
  and #227 (`20261227000000`). If either is applied first, this file must be renumbered above it (HANDOVER "Migration order").
- **PREFLIGHT** (read-only, `prod-sql.sh -c`, one at a time):
  0. Row 67 applied, nothing at or past this one. Expect `20261223000000` among the rows and nothing `>= '20261225000000'`:
     `select version from supabase_migrations.schema_migrations where version >= '20261223000000' order by 1;`
  1. The function is still 20261015000000's. Expect `e936352b8a20cdd8fd374756e4fa4439, t, {search_path=""}`:
     `select md5(prosrc), prosecdef, proconfig from pg_proc where oid = 'private.audit_company_write()'::regprocedure;`
  2. The 18 triggers that call it, all enabled. Expect 18 rows, all `O`:
     `select c.relname, t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgfoid = 'private.audit_company_write()'::regprocedure and not t.tgisinternal order by 1;`
  3. For the log: how many factor entries exist (they keep their old diffs). Expect a small number:
     `select action, count(*) from public.audit_log where target_table = 'person_capacity_factors' group by 1 order by 1;`
- **POST-APPLY CHECK:**
  1. Expect `t, {search_path=""}` and the new md5 (the builder computes it from the file and writes it here).
  2. `has_function_privilege` for `anon` and `authenticated` on it: both `f`.
  3. Still 18 triggers, all `O` (preflight 2 again).
  4. Smoke test, rolled back, as the Northbeam owner (as C6's post-apply 6): `begin; set local role authenticated;` set the
     claims; `select public.save_capacity_factor('<person id>', '<a step id>', null, 0.8)`, then
     `select public.save_capacity_factor('<person id>', '<the step id>', 0.8, 0.9)`; `reset role;` then
     `select action, diff -> 'step_id', diff -> 'every_step' from public.audit_log where target_table = 'person_capacity_factors' and created_at = now() order by action;`
     Expect `insert` and `update`, both with the step id and no `every_step`. `rollback;`.
  5. On the real project (Austin's live check): an editor changes one factor; the owner's change log names the step.
- **ROLLBACK** (one transaction, in the `-- ROLLBACK (` block that `packages/db/test/header-rollback.ts` parses: every line
  `--   ` plus the SQL, **including blank lines inside the body, which must be `--   ` with the three spaces**, or the
  parser stops there):
  ```
  begin;
  create or replace function private.audit_company_write() returns trigger … 20261015000000's whole statement … $$;
  revoke all on function private.audit_company_write() from public, anon, authenticated;
  delete from supabase_migrations.schema_migrations where version = '20261225000000';
  commit;
  ```
  Written out in full (generated from the 20261015 file, not a pointer). Entries logged while #230 was applied keep their
  `step_id` / `every_step`; the app reads them either way.

Apply file: `begin;`, `set local lock_timeout = '5s';`, the migration SQL, the `schema_migrations` insert (version
`'20261225000000'`, name `'audit_factor_step'`, `array[$mig$<the migration SQL>$mig$]`), `commit;`; header in the style of
`scripts/apply/20261223000000_capacity_factors.sql` ("Apply BEFORE deploying the app" is not needed: the app reads either
diff; say "apply any time after row 67"). Then `pnpm --filter @transpera-flow/db gen:bootstrap`. No `gen:types` (no
signature change), no `gen:seed`. Add row 69 to `docs/production-migrations.md` as "not yet applied", in row 67's style.

---

## Part 2: app

### `apps/web/src/lib/suggestions/audit.ts`

- `AuditEntry.diff` gains `step_id?: string; every_step?: boolean`.
- `describeAuditEntry(e, model, stepNames: Readonly<Record<string, string>> = {})`. A third, optional argument, so every
  existing call and test still compiles.
- A local helper `stepOf(e)`: `e.diff.step_id ?? e.diff.new?.step_id ?? e.diff.old?.step_id` when it is a string, else
  null. And `stepWords(e)`:
  - for `person_capacity_factors`:
    - `e.diff.every_step === true` → `"for every step"`;
    - a step id → `` `on ${stepNames[id] ?? "a step no longer in any process"}` ``;
    - neither, and the action is `insert` or `delete` → `"for every step"` (the whole row was logged, and a null `step_id`
      was stripped, so an absent one means "Every step"; this also names old entries);
    - neither, on an `update` → `null` (an entry logged before #230: the step isn't known).
  - for `person_skills`: a step id → `` `${stepNames[id] ?? "a step no longer in any process"}` ``, else null.
- Text (never the factor, never a comparison with anyone else):
  - factors: `` `${who}: per-person time ${words} ${verb}` `` with `verb` = set / removed / changed, e.g. "Sam Patel:
    per-person time on Kickoff set", "Sam Patel: per-person time for every step changed". When `words` is null, keep
    today's "Sam Patel: a per-person time changed".
  - Add " (measured)" at the end when `e.diff.new?.provenance` has `factor.source === "measured"` (#227 writes measured
    times; until then nothing has it). Read it defensively (`provenance` is `unknown`).
  - skills: "Sam Patel: skill Kickoff added" (removed / changed); without a step id, today's "Sam Patel: a skill added"
    (Q3).
- Update the comment at L107.

### `apps/web/src/lib/company-data.ts` (`loadSuggestionsPage`)

After the audit log is read (owners and agency admins only), collect the step ids of entries whose `target_table` is
`person_capacity_factors` or `person_skills` (`stepOf` above: export it from `audit.ts` as `auditStepId`). If any:

```ts
supabase.from("steps").select("id, name, created_at").eq("workspace_id", ws).in("id", ids).order("created_at", { ascending: false })
```

Step ids are stable across versions, so one id has a row per revision: keep the **first** name per id (the newest). At
most 50 entries, so at most 50 ids. `SuggestionsPageData` gains `stepNames: Record<string, string>` (`{}` when there is no
log). No other query changes.

### `apps/web/src/components/suggestions-review.tsx` and `app/w/[slug]/suggestions/page.tsx`

`ChangeLog` takes `stepNames` and passes it as the third argument. The page passes `data.stepNames`.

---

## Patterns to copy

| What | Copy from |
|---|---|
| A `create or replace` that is a full copy of the latest body, with the old body as runnable rollback | `20261223000000_capacity_factors.sql` (`team_capacity`) and its tests in `capacity-factors.test.ts` (header rollback, L405–432) |
| Header, preflight with md5, post-apply, apply file | `20261223000000_capacity_factors.sql` and `scripts/apply/20261223000000_capacity_factors.sql` |
| A body-diff test ("differs only where the brief says") | `workspace-import-large.test.ts` "differs from the old body only where the brief says" and `bodyOf` |
| Change-log tests | `apps/web/test/suggestions.test.ts` L99–131 |
| Audit rows in a DB test | `capacity-factors.test.ts` L205–229 |

---

## Edge cases

- **Old entries** (before #230): inserts and deletes name the step or "every step" (the whole row is in `new`/`old`);
  updates keep "a per-person time changed". Never guess the step of an old update.
- **A step id whose step is gone** from every revision (deleted with a draft that was discarded): "a step no longer in any
  process".
- **A step renamed** across versions: the newest revision's name.
- **An UPDATE that moves a row to another step** (possible through PostgREST, not through `save_capacity_factor`): `target`
  is the new row, so `step_id` is the new step; `old.step_id` holds the previous one. The text names the new step. Accept.
- **A person deleted**: the factor rows cascade, and cascades run at trigger depth > 1, so they aren't logged (unchanged).
- **The other 17 tables**: identical diffs (test).
- **Privacy**: the log is read only by owners and agency admins (`audit_log` read policy, `can_manage_workspace`), who see
  everyone's times anyway. Step names are not personal. The number still never appears in text.
- **MCP**: an API token can't write factors (`needs_review`), so `actor_kind` is always `user` here. Unchanged.

---

## Tests

**Database** (new `packages/db/test/audit-factor-step.test.ts`, the `createTestDb` harness and the Northbeam ids, as
`capacity-factors.test.ts`):
1. As an editor, `save_capacity_factor` insert, update and delete on a step, and on "Every step" (step null): the six
   `audit_log` rows have `diff.step_id` = the step (and no `every_step`) for the step rows, and `diff.every_step = true`
   (and no `step_id`) for the default rows, for each of insert, update and delete.
2. **Nothing else moved:** one write per other audited table that has an easy write (a person's `fte`, a role's name, a
   `person_skills` insert, a `person_roles` insert, a `client_services` insert, a lead source's volume, a workspace
   setting through `save_fields`): the diff has exactly today's keys. Compare each diff with `toEqual` against the
   expected object written out in the test. `person_skills` still has `step_id`; nobody else has
   `step_id` or `every_step`.
3. **The function.** `prosecdef` true, `proconfig` `{search_path=""}`, anon and authenticated can't execute it; the live
   md5 equals the md5 of the new migration's body, and the migration header contains that md5.
4. **The body diff.** The new body with the two `-- #230` lines (and the comment above them) taken out, and the one changed
   line put back, equals 20261015000000's body exactly. And the old body's md5 is `e936352b8a20cdd8fd374756e4fa4439`.
5. **Header rollback.** Inside a transaction that is rolled back: run `headerRollback("20261225000000_audit_factor_step.sql")`;
   the live md5 is `e936352b…` again; an UPDATE of a factor then logs no `step_id` (today's behaviour). Precedent:
   `capacity-factors.test.ts` L405.
6. **Apply file** is the migration plus its row in one transaction (copy the test in `workspace-import.test.ts` L756).
7. `capacity-factors.test.ts`, `suggestions.test.ts` (db), `mcp-audit.test.ts` and `role-matrix.test.ts` stay green
   **unchanged**.

**App unit** (`apps/web/test/suggestions.test.ts`, extend "the change log"):
- The C6 case keeps passing where it has no step (old update entries) and gains: insert with `diff.step_id` → "Sam Patel:
  per-person time on Kickoff set"; update with `diff.every_step` → "…for every step changed"; delete with
  `old.step_id` and no top-level key → "…on Kickoff removed"; insert with no step anywhere → "…for every step set"; an
  unknown step id → "…on a step no longer in any process"; `provenance.factor.source = "measured"` → ends " (measured)".
  Use Northbeam step ids and a `stepNames` map built from the fixture.
- No text contains the factor (0.8, 1.3) or any other person's name.
- Skills: "Sam Patel: skill Kickoff added" with a step; today's text without one.
- `auditStepId` reads `diff.step_id`, then `new.step_id`, then `old.step_id`.

**Loader** (`apps/web/test/…`): if a test of `loadSuggestionsPage` with a mocked Supabase exists, add the step names case;
if none exists, don't build one (the unit tests and the DB test cover it). Say which in the PR.

No browser test is needed (text only). Run the Suggestions browser tests (`suggestions-play-browser.test.ts`) to see they
still pass.

---

## Out of scope

- Any other table's diff, or any other trigger, policy or function (`company_needs_review`, `stamp_provenance`,
  `save_capacity_factor`).
- Re-writing old audit entries to add the step (`audit_log` is append-only).
- Showing factor values in the change log text (never), or the change log to editors or members.
- An MCP tool for the change log.
- #227 and #228 work; they are separate branches.

## Done when

- [ ] Migration `20261225000000_audit_factor_step.sql`: header with the decisions, the 18 tables, preflight 0–3 (md5
      `e936352b…`), post-apply 1–5 with the new md5 filled in, runnable full rollback. Apply file. `bootstrap.sql`
      regenerated. Row 69 in `docs/production-migrations.md`, "not yet applied".
- [ ] The DB tests above, including "nothing else moved" for the other tables and the body-diff test.
- [ ] The change log names the step (or "every step") for per-person times and skills, never the number.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build` green locally (known ICU
      failures aside).
- [ ] PR body (the `pr` skill): Summary, Evidence (preflight/post-apply text, test names), Merge Danger ("replaces a
      trigger function shared by 18 tables; the diff of 17 is proven unchanged"); `Closes #230`; the defaults below as
      "Defaults taken".

---

## Open questions (each with the default the builder uses)

**Q1. Redefine the shared function, or give `person_capacity_factors` its own audit trigger?** A dedicated function would
be a 50-line copy that drifts from the shared one, and swapping the table's trigger is a drop and create. **Default:
redefine the shared function with two marked lines; the "nothing else moved" test proves the other 17 tables are
unaffected.**

**Q2. How "Every step" is told apart.** `jsonb_strip_nulls` removes a null `step_id`. **Default: an explicit
`every_step: true` key for factor rows whose step is null**, rather than a sentinel string in `step_id`.

**Q3. Name the step for skills too?** The diff has had `step_id` for skills since 20261015; the text never used it.
**Default: yes**, "Sam Patel: skill Kickoff added", since the same step-name lookup serves both.

**Q4. Mark measured times?** #227 will write `measured` factors. **Default: append " (measured)"** when the entry's new
provenance says so; harmless before #227.

**Q5. Old update entries.** **Default: keep "a per-person time changed"** for an update logged before #230; never guess.
