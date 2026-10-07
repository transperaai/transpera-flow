# C6 follow-up build brief: restore per-person times from a backup (#228)

Scoped 7 Oct 2026 against `origin/main` at `bf61be0e` (C6 #229 merged; production at row 67, `20261223000000`). Read
`docs/plans/builder-brief.md` first, then `docs/plans/b10-2-brief.md` (how a restore works), `docs/plans/b21-brief.md`
(its limits, 40 s timeout and performance test) and `docs/plans/c6-brief.md` (per-person times). This brief adds to them
and wins where they differ. Build strictly from it. If something doesn't match the code, **ask; don't guess.** Every open
question has a default: use it.

| | |
|---|---|
| Branch | `claude/c6-restore-factors` (this brief is its first commit; build on it) |
| Migration | `20261226000000_restore_capacity_factors.sql`, ledger row **70** |
| Apply file | `packages/db/scripts/apply/20261226000000_restore_capacity_factors.sql` |
| Closes | #228 (`Closes #228`) |
| Engine | No change. No `ENGINE_VERSION` bump. No golden number moves. |

## The short version

C6 exports `person_capacity_factors` in a backup but the restore leaves them out ("Stays in the file: N per-person
times …", plus a warning when the switch was on). So a restored workspace that used per-person times simulates
differently from the original, which breaks Austin's B10 rule. #228 restores them:

1. **Planner** (`packages/db/src/workspace-import.ts`): a new plan section `person_capacity_factors`
   (`person_id`, `step_id`, `factor`, `provenance`), ids mapped by the existing placeholder remap. A time on a step that
   isn't restored is left out and counted. A new limit `capacityFactors: 3000`. The left-out line and the C6 warning go;
   a "Will be restored: N per-person times" line comes.
2. **Function** (`public.import_workspace_bundle`, a `create or replace` that is a full copy of B21's body,
   `20261215000000`): the section in its allow-list, reference columns, section order and limit check. It is written by
   the existing flat-section path (one set-based insert), after `person_skills`. Same signature, SECURITY INVOKER, same 40 s
   `statement_timeout`, same refusals, all or nothing. A plan without the section (an app deployed before this migration)
   still restores, as an empty section.
3. **Tests**: a round trip with per-person times switched on whose restored engine model equals the source's (factors
   included, ids mapped back) and whose headline results are within run-to-run variation; the B21 performance test with
   factors at their limit, inside the 15 s budget.

Commit and push after each part: (1) planner and its unit tests; (2) migration, apply file, DB tests; (3) app words, docs.

---

## Decisions (verbatim)

**Austin, 7 Oct 2026 (relayed by the orchestrator):** Austin approved the C6 defaults and asked for "all the things you can
build", approving #227, #228 and #230.

**#228 (the whole body, as filed):**
> C6 (#198): the workspace export holds `person_capacity_factors`, but `import_workspace_bundle` leaves them out (a restore
> lists them as left out and warns when the switch was on). Restoring them needs a new section in that SECURITY DEFINER
> function (a full copy of its latest body), so a restored workspace's results match the original (#39).

(The function is SECURITY **INVOKER**, not DEFINER: B10 Q1 and decision 1 require that. It stays invoker.)

**C6 brief, Q2 (the default this ticket follows up):**
> Restoring factors means a new section in `import_workspace_bundle`: a full copy of a 400-line SECURITY DEFINER function.
> **Default: the export keeps them, the restore leaves them out and says so (and warns when the switch was on). This is an
> exception to #39's "results match", for workspaces using factors. Follow-up ticket to restore them.**

**#39 (B10), Austin, 6 Oct:**
> **Decision.** The acceptance criterion becomes:
> 1. The restored engine model equals the source model, once ids are mapped back.
> 2. Headline results are within normal run-to-run variation.

> - **Q1:** yes to the migration `import_workspace_bundle`. It is one SECURITY INVOKER function: not privileged, additive
>   only, and it creates drafts only. It makes the restore all-or-nothing.

> 4. **Who can export and import:** agency admins, owners and editors only, for both. Members and viewers can't.

**B21 (#203) rules that still bind** (b21-brief.md): one call, one transaction; `set statement_timeout = '40s'` on this
function only ("**Never** raise the function's timeout above 40 s, and never raise any other timeout"); "**The performance
test is the arbiter**: every limit at once must restore in **under 15 s** locally."

**C6's defaults, confirmed by Austin (comment on #198, 7 Oct):**
> - Factors are off per workspace, and only owners and editors switch them on and set them.
> - Owners, editors and agency admins see everyone's factors. A member sees only their own.
> - A restore leaves factors out (#228).

(The last line is what this ticket reverses, as #228 asks.)

**PRD D20:**
> Capacity, not performance: individual availability/skills/assignments; capacity factor off by default, shown only when
> measured, visible to the person, never ranked; no role-median benchmark. DPA clause in the retainer.

---

## Audit: what exists on `origin/main`

| Thing | State | #228 change |
|---|---|---|
| `public.import_workspace_bundle(uuid, jsonb, text)` | Latest body: `20261215000000_bigger_restores.sql` L494–908 (B21). SECURITY INVOKER, `proconfig {search_path="",statement_timeout=40s}`, only `authenticated` executes. Body md5 **`32b64f2ad9be79d0044f640e4a4d2ed2`** (30,568 characters; matches row 61's post-apply record). Nothing later replaces it (`grep -l "function public.import_workspace_bundle" packages/db/supabase/migrations` → 20261207000000, 20261215000000). | `create or replace`, full copy plus the marked hunks below |
| Its structure | Constants `allow` (jsonb allow-list, must equal `IMPORT_COLUMNS`), `ref_cols`, `step_ref_cols`, `sections` (write order), `list_sections` (must be arrays), `one_sections`. A flat section is written by the generic `else` branch (L864–898): `jsonb_populate_recordset(null::public.<t>, rows)` with only the allow-listed columns the rows carry, inside a per-section `begin … exception` that re-raises with `hint = 'section:<name>'`. | One new flat section; no new branch |
| The table | `person_capacity_factors (person_id, workspace_id, step_id null = "Every step", factor 0.5–2, provenance, created_at, updated_at, created_by)`; no primary key; partial unique indexes `(person_id, step_id) where step_id is not null` and `(person_id) where step_id is null`; FK `(person_id, workspace_id) → people` on delete cascade; **no FK on `step_id`**. Triggers: `set_updated_at`, `stamp_provenance('factor')` (on INSERT, keeps a given `provenance.factor`, else stamps `entered`), `audit_company`, `needs_review`. RLS insert: `can_edit_workspace`. | Rows inserted by the restore as the caller |
| Planner | `workspace-import.ts`: `NO_ID_TABLES` already has `person_capacity_factors` (C6), so the checker accepts its rows; `IMPORT_COLUMNS` has no entry; the plan has no section; L764–767 the warning; L814–825 the left-out line; L12 header "Not restored … per-person times". `IMPORT_REFS` modes: `require` (null or unknown → row dropped), `null` (unknown → cleared), **`drop` (null kept, unknown → row dropped)**. | Add the section |
| Export | `workspace-bundle.ts` L47 `person_capacity_factors: T("person_capacity_factors", "person_id", "step_id")`, `select *`, so rows carry `factor` (numeric: a string or number in JSON; see edge cases) and `provenance`. Export is editors only (RLS on the table: `can_see_person`, which is everyone's for editors). | None |
| Engine model | `toEngineModel` sets `EnginePerson.capacityFactor` only when `usesCapacityFactors(bundle)` (switch on and the viewer sees everyone), from `bundle.personCapacityFactors`, step ids filtered to the model's steps, 1s dropped, keys in sorted id order. A factor draws no random number. | None |
| Tests | `packages/db/test/workspace-import.test.ts` (the round trip L195–376, reworked by #209: **don't edit that block**; "SQL and TS agree" L745 reads `allow` and `ref_cols` from `prosrc`); `workspace-import-large.test.ts` (B21: 15 s budget, every table at its limit; L505 compares the **live** md5 with 20261215's body, which this ticket changes); `synthetic-plan.ts`; `workspace-import-plan.test.ts` L666–712 (C6: "kept in the file, left out of the restore"). | Extend / replace as below |
| App words | `apps/web/src/lib/restore/errors.ts` `SECTION_WORDS` (L21) has no entry for the new section. | Add one |
| Docs | `docs/PRD.md` L348 ends "A backup exports them; a restore leaves them out and says so." | Update |
| Other migrations in flight | #230 (`20261225000000`) replaces `private.audit_company_write`; #227 (`20261227000000`) replaces `apply_calibration`, `calibration_payload_problem`, `record_calibration_import`, `team_capacity`. **None touches `import_workspace_bundle` or `workspace-import.ts`.** #227 writes `measured` factors whose provenance names a dataset; see edge cases. | Independent |

---

## Part 1: the planner (`packages/db/src/workspace-import.ts`)

- **`IMPORT_COLUMNS.person_capacity_factors = cols("person_capacity_factors", "person_id", "step_id", "factor", "provenance")`.**
  No `created_at`: nothing orders factors by it (loaders order by person and step).
- **`IMPORT_REFS.person_capacity_factors = [R("person_id", "people", "require"), R("step_id", "steps", "drop")]`.** `drop`
  keeps a null step (the "Every step" row) and drops a row whose step isn't in a restored version (the live version, or
  the draft of a never-published process). `resolveRefs`' `note` counts them, so the existing "N per-person times pointed
  at something that isn't in the backup or isn't restored, and were left out." warning appears (add
  `person_capacity_factors: "per-person times"` to `LABELS`).
- **`ImportPlan.person_capacity_factors: Row[]`**, built with `flat("person_capacity_factors", company("person_capacity_factors"), IMPORT_REFS.person_capacity_factors)`,
  then `factor` normalised to a JS number (`Number(row.factor)`; the export may carry a numeric as a string). Keep the
  bundle's order. Place the key after `person_skills` in the object literal.
- **Checker** (`shapeProblem`, after the company-model table check): every `company_model.person_capacity_factors` row has
  a uuid `person_id`, a `step_id` that is null or a uuid, and a `factor` that is a finite number (or numeric string) from
  0.5 to 2; and no `(person_id, step_id)` pair repeats (null counts as one value). Otherwise return
  `"a per-person time isn't valid"` / `"a per-person time repeats"`, which become "The backup is damaged: …, so nothing
  was restored."
- **Limit** `WORKSPACE_IMPORT_LIMITS.capacityFactors: 3000` with a doc line ("Per-person times (#228): one 'Every step'
  and one per step a person does; sized like skills."). `ImportSummary.measures.capacityFactors` (from the plan), in the
  `empty` measures, `limitProblems` ("per-person times"), `restoreSizeWarning`'s list.
- **Summary:** remove the `capacity_factors` left-out line and the "This backup has per-person times switched on …"
  warning. Add `person_capacity_factors` to the `restored` keys list (label "per-person times" from `LABELS`).
- Rewrite the header's "Not restored" sentence (L10–13): per-person times are restored now (#228).
- `assertOnlyPlaceholders` needs nothing new: it walks every array section with `IMPORT_REFS`.
- Plans for bundles **without** factors gain `"person_capacity_factors": []` and nothing else. Everything else in a plan is
  byte for byte the same as before.

## Part 2: migration `20261226000000_restore_capacity_factors.sql`

Exactly one statement plus its grants:

```sql
create or replace function public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text default null) returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '40s'
as $$
  … 20261215000000's body, copied character for character (generate it from the file), with ONLY the hunks below …
$$;

revoke all on function public.import_workspace_bundle(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.import_workspace_bundle(uuid, jsonb, text) to authenticated;
```

**The hunks** (mark each with `-- #228` on the line above, except inside the one-line constants, where the comment goes
on the line above the constant):

(a) **`allow`**: add `"person_capacity_factors":["person_id","step_id","factor","provenance"]` to the JSON. The "SQL and
    TS agree" test compares it with `IMPORT_COLUMNS` (arrays in the same order).

(b) **`ref_cols`**: append `'person_capacity_factors.person_id','person_capacity_factors.step_id'`. The id check (step 5)
    then accepts a placeholder or null in both and refuses anything else (22023).

(c) **`sections`**: insert `'person_capacity_factors'` right after `'person_skills'` (people and steps are written by
    then; no FK on `step_id`).

(d) **`list_sections`**: insert `'person_capacity_factors'` right after `'person_skills'`.

(e) **A plan made before #228** has no such key, and the list check would refuse it ("must be a list"). Right after the
    format check (the `if p_plan is null or … 'transpera-workspace-import/1'` block), add:
    ```sql
      -- #228: a plan made before per-person times were restored (an app deployed before this migration) has no such section:
      -- it restores as an empty one.
      if not p_plan ? 'person_capacity_factors' then
        p_plan := p_plan || '{"person_capacity_factors": []}'::jsonb;
      end if;
    ```

(f) **Limit**: add `or jsonb_array_length(p_plan -> 'person_capacity_factors') > 3000` to the limit check (before the
    `companyOther` sum), and append `, 3000 per-person times` to the end of the message's list, keeping the message's
    shape `import_workspace_bundle: the plan is over a limit (<list>)` (`planDetail` in `errors.ts` parses it).

**Nothing else.** Same refusals in the same order, same sections otherwise, same return shape; the section's count
appears in `counts.person_capacity_factors` by the generic path. The flat path writes `workspace_id = p_workspace` and
only the allow-listed columns, so `created_by` is the caller (the column default) and `created_at`/`updated_at` are now.

### Why the rows behave

- **RLS:** insert needs `can_edit_workspace`, which the function already required of the caller.
- **`stamp_provenance('factor')`** keeps `provenance.factor` as given on INSERT; a row whose provenance has no `factor`
  entry is stamped `entered` by the caller, now.
- **`needs_review`** refuses an API token; the function already refuses tokens first.
- **`audit_company`** logs one insert per row (as for skills). With #230 applied the diff names the step.
- **Unique indexes:** the checker refuses a repeated pair, so a valid plan can't collide.

### Header (copy the shape of `20261215000000_bigger_restores.sql`)

- Purpose: #228, the decisions quoted (B10 Q1 and the round-trip decision; C6 Q2's default this reverses).
- What changes (the six hunks) and "STRICTLY ADDITIVE: one `create or replace` of `public.import_workspace_bundle` with
  the same signature, settings, refusals and result; one more section. It doesn't redefine `save_fields` or any other
  function, trigger or policy."
- **ORDER:** after `20261223000000` (row 67: the table) and `20261215000000` (row 61: the body copied). Independent of
  #230 (`20261225000000`) and #227 (`20261227000000`); if #227 is applied first, renumber this file above it (HANDOVER
  "Migration order"). **Apply BEFORE deploying the app.** The old function writes only the sections in its `sections`
  constant and ignores any other key, so the new app's plan against the old function would restore without the times and
  without saying so. Say exactly that in the header.
- **PREFLIGHT** (read-only, one at a time):
  0. Rows 61 and 67 applied, nothing at or past this one. Expect both, and nothing `>= '20261226000000'`:
     `select version from supabase_migrations.schema_migrations where version in ('20261215000000', '20261223000000') or version >= '20261226000000' order by 1;`
  1. The function is B21's. Expect `32b64f2ad9be79d0044f640e4a4d2ed2, f, {search_path="",statement_timeout=40s}`:
     `select md5(prosrc), prosecdef, proconfig from pg_proc where oid = 'public.import_workspace_bundle(uuid, jsonb, text)'::regprocedure;`
  2. The table and its triggers. Expect `person_capacity_factors`, then `audit_company, needs_review, set_updated_at, stamp_provenance`:
     `select to_regclass('public.person_capacity_factors');`
     `select tgname from pg_trigger where tgrelid = 'public.person_capacity_factors'::regclass and not tgisinternal order by 1;`
  3. Nobody restoring now (B21's preflight 4). Expect 0.
- **POST-APPLY CHECK:** md5 (the builder computes it and writes it in), `f`, `{search_path="",statement_timeout=40s}`;
  only `authenticated` executes (B21's post-apply 2); the row is in `schema_migrations`. Live check (Austin, on a
  preview): export a workspace with per-person times switched on and a few times set, restore it into a new workspace,
  publish, and see the same times in Settings → People.
- **ROLLBACK** in the `-- ROLLBACK (` block that `packages/db/test/header-rollback.ts` parses (every line `--   ` plus
  the SQL, **including blank lines inside the body, written `--   `**): `begin;`, B21's whole `create or replace function
  public.import_workspace_bundle … $$;` statement (with its `set statement_timeout = '40s'`, so the setting stays), the
  revoke and grant, `delete from supabase_migrations.schema_migrations where version = '20261226000000';`, `commit;`.
  Generated from the 20261215 file, not retyped. "Roll the app back first: an old app's plans restore under either
  function, but the new app's factors would be dropped silently by the old one. Workspaces restored meanwhile keep their
  factors."

Apply file: as `scripts/apply/20261215000000_bigger_restores.sql` (header, `begin;`, `set local lock_timeout = '5s';`,
the migration SQL, the `schema_migrations` insert with name `'restore_capacity_factors'` and `array[$mig$…$mig$]`,
`commit;`). It is large: `prod-sql.sh -f` reads it with `jq --rawfile` (row 61's note). Then `gen:bootstrap`. No
`gen:types` (same signature), no `gen:seed`. Row 70 in `docs/production-migrations.md` as "not yet applied", in row 61's
style.

## Part 3: app and docs

- `apps/web/src/lib/restore/errors.ts`: `SECTION_WORDS.person_capacity_factors = "the per-person times"`.
- `apps/web/test/restore-errors.test.ts`: `section:person_capacity_factors` → "Couldn't restore the per-person times…".
- The restore page's lists come from the summary, so "Will be restored" shows "N per-person times" with no UI change.
  Check `components/restore/restore-backup.tsx` for any sentence that says per-person times stay in the file; if one
  exists, remove it (none was found in the audit).
- `docs/PRD.md` L348: "A backup exports them and a restore brings them back (#228)."
- `docs/supabase-notes.md`: only if something is verified only on plain Postgres (the timing of the at-limits restore
  is: add one line to the restore's "Time" row with the new measured time).

---

## Patterns to copy

| What | Copy from |
|---|---|
| A replaced restore function with a runnable full rollback | `20261215000000_bigger_restores.sql` (header), C6's `team_capacity` rollback (the `--   ` format `header-rollback.ts` reads) |
| "differs from the old body only where the brief says" | `workspace-import-large.test.ts` L534 (`strip`, `bodyOf`) |
| Round-trip helpers: `newWorkspace`, `member`, `restoreAs`, `bundleOf`, `loadPipeline`, `backToOld`, the headline t-test | `workspace-import.test.ts` L1–376 |
| At-limits performance and per-table counts | `workspace-import-large.test.ts` L259–345 and `synthetic-plan.ts` |
| Planner unit tests (`makeBundle`, `recount`, `planOf`, `clone`) | `workspace-import-plan.test.ts` |
| Apply-file test | `workspace-import-large.test.ts` L557 |

---

## Edge cases

- **A time on a step that isn't restored** (only in an older version, or in a newer unpublished draft): dropped by the
  planner and counted in the "pointed at something … left out" warning. It was never used by the engine.
- **A time on a step the person can't do** (but the step is restored): restored as is (stored, unused, "Not used now"
  in Settings), as in the source.
- **"Every step" rows** (`step_id` null): kept by the `drop` mode.
- **Inactive people, people past their end date:** their times are restored (the person is).
- **Switch:** `capacity_factor_enabled` is a workspace setting, restored with the settings: applied for an owner or agency
  admin, one pending suggestion for an editor (B10 Q4). An editor's restore has the times but the switch stays off until
  an owner accepts the suggestion (or an editor switches it on in Settings → Simulation). Say so in the PR; no change.
- **Provenance:** carried. `entered` times keep their `at` and `by` (the source workspace's user id, as `people`'s
  provenance already is). `measured` times (#227) keep `dataset_id` and `calibration_id`, which point at the source
  workspace's records (datasets and calibrations aren't in a backup), exactly as a step's measured provenance does today.
  The People page counts measured items from the provenance, so they still show.
- **`factor` as a string:** Postgres `numeric` exports as a JSON number through PostgREST, but test both a number and a
  numeric string; the planner sends a number.
- **A plan from an older app** (no section): restores, with no times (hunk e). A plan from the new app against the old
  function: the old function ignores the key and restores without times (apply first; see the header).
- **Privacy:** only agency admins, owners and editors export or restore, and each of them sees everyone's times. Members
  and viewers can't call the function. Nothing about times reaches a share link (unchanged).
- **Size and time:** 3,000 rows at about 0.1–0.15 ms each (four triggers, an RLS check) add about 0.3–0.5 s at the
  limits. The 15 s local budget still decides; if the large test goes over, lower `capacityFactors` (not the others) and
  say so.
- **Two restores at once, not empty, ids, all or nothing:** unchanged; the new section is inside the same transaction and
  the same `begin … exception` pattern (hint `section:person_capacity_factors`).

---

## Tests

**Planner** (`packages/db/test/workspace-import-plan.test.ts`): **replace** the C6 describe "per-person times in a backup
(C6): kept in the file, left out of the restore" (L666–712) with "per-person times in a backup (#228): restored":
1. A bundle with a default and a step time checks clean; the plan's `person_capacity_factors` holds both, with
   placeholder `person_id` and `step_id` (or null), `factor` numbers, `provenance` kept; no `workspace_id`,
   `created_by`, `created_at`.
2. The order of ids is kept (placeholders sort as the old ids did).
3. A time on a step only in an older version is dropped, with the warning naming "per-person times".
4. The summary's `restored` has "per-person times" with the count; `leftOut` has no `capacity_factors` line; the C6
   warning is gone, with the switch on or off.
5. The switch is still restored like any setting (keep the existing test).
6. Damaged: a factor of 2.5, of "abc", a `person_id` that isn't a uuid, and a repeated pair (two defaults for one person)
   each give "The backup is damaged: …". A numeric string "0.85" is accepted and planned as 0.85.
7. Limits: `capacityFactors` at the limit is fine, one over is an error naming "per-person times".
8. A bundle with no factors plans `person_capacity_factors: []` and is otherwise unchanged: compare a pre-#228 plan
   fixture's JSON with the key removed (build it in the test from `makeBundle()`).

**Round trip with per-person times** (new `packages/db/test/workspace-import-factors.test.ts`, its own `createTestDb`;
don't edit #209's block in `workspace-import.test.ts`; copy the helpers it needs, or move them into a shared
`test/restore-helpers.ts` **only if** `workspace-import.test.ts` then imports them with no other change):
1. In Northbeam: switch `capacity_factor_enabled` on; as an editor, `save_capacity_factor` an "Every step" 0.9 for one
   person, and step times (0.8, 1.25) for two people on steps they can do (look them up with the C6 rule: skills, else
   role steps), plus one time on a step the person can't do.
2. Export as an editor, `JSON.parse(JSON.stringify(...))`, check, plan, restore into a new workspace as its owner, publish
   every process (copy the publishing loop).
3. Load both with a copy of `loadPipeline` that also reads `personCapacityFactors` in `team_capacity`'s shape
   (`select person_id, step_id, workspace_id, factor::float8 as factor, coalesce(provenance -> 'factor' ->> 'source', 'entered') as source from person_capacity_factors where workspace_id = $1 order by person_id, step_id nulls first`).
4. **The model:** `toEngineModel(after)` mapped back with `backToOld` equals `toEngineModel(before)`, and at least three
   people in it have `capacityFactor` (so the comparison isn't vacuous). Also: the restored workspace's
   `person_capacity_factors` rows, mapped back, equal the source's (`factor`, `step_id`, `provenance.factor.source`).
5. **Headline results:** the same two-sample t-test as #209's (RUNS 16, |t| ≤ 6, seeds 42… and 1042…). Copy it with its
   comment; don't loosen it.
6. **The rule bites:** the same restore with the factor rows removed from the plan gives a model **different** from the
   source's (so step 4 would catch a restore that lost them).
7. As an **editor** restoring: the times are restored and the switch arrives as part of the pending settings suggestion.

**Function** (new `packages/db/test/workspace-import-factors-sql.test.ts`, or the same new file):
1. A plan without the `person_capacity_factors` key restores (as before #228) with no times.
2. A real (non-placeholder) uuid in `person_capacity_factors.person_id` or `.step_id` → 22023, nothing written.
3. One over 3,000 → 22023 with the limits sentence ending ", 3000 per-person times)".
4. A factor of 3 in a hand-made plan → the restore fails with hint `section:person_capacity_factors`, and every table is
   unchanged (copy "all or nothing").
5. An API token, a member, a viewer → 42501, nothing written (unchanged; one case is enough).
6. Settings: `prosecdef` false, `proconfig` `{search_path="",statement_timeout=40s}`, only `authenticated` executes; the
   live md5 equals the md5 of **this** migration's body, and its header contains it.
7. **Body diff:** 20261226's body with the six hunks taken out equals 20261215's body (copy `strip`'s approach).
8. **Header rollback** in a rolled-back transaction: afterwards the md5 is `32b64f2a…`, `proconfig` still has
   `statement_timeout=40s`, and a plan with factors restores without them (the old function ignores the key).
9. The apply file is the migration plus its row in one transaction.

**Existing tests to update (not loosen):**
- `workspace-import-large.test.ts` L505–506 compares the live body with 20261215's: change it to the **latest** migration
  that defines the function (20261226), keeping the check. The other B21 tests read files and stay as they are.
- `synthetic-plan.ts`: add `person_capacity_factors` at exactly `L.capacityFactors` rows (one default per person, then
  step times on distinct steps per person, no repeated pair); `workspace-import-large.test.ts`'s per-table count list
  gains `["person_capacity_factors", L.capacityFactors]`, and its measures loop gains `capacityFactors`. The every-limit
  restore must stay under the 15 s budget: record the before and after times in the PR.
- `workspace-import.test.ts` "limits" `it.each`: add `["per-person times", (p) => { p.person_capacity_factors = rows(L.capacityFactors + 1); }]`.
  The "SQL and TS agree" test needs no edit (it reads `IMPORT_COLUMNS` and `IMPORT_REFS`).
- `apps/web/test/restore-errors.test.ts`: the new section words.

Run everything: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`, with your own
database names if another agent's Postgres is running.

---

## Out of scope

- Restoring anything else not restored today (history, solutions, calibrations and datasets, findings).
- Letting an editor's restore write `capacity_factor_enabled` directly (Q4).
- Re-linking a measured time's `dataset_id` to anything in the new workspace.
- Any change to export, the share links, the engine, `team_capacity` or `save_capacity_factor`.
- Raising any other limit or the 40 s timeout.
- #227 and #230 work; they are separate branches.

## Done when

- [ ] Planner: the section, refs, checker rules, limit, summary lines; the C6 left-out line and warning gone.
- [ ] Migration `20261226000000_restore_capacity_factors.sql` with header (decisions, order, preflight 0–3 with md5
      `32b64f2a…`, post-apply with the new md5, runnable full rollback). Apply file. `bootstrap.sql` regenerated. Row 70 in
      `docs/production-migrations.md`, "not yet applied".
- [ ] The round trip with per-person times passes (model equal, headline t-test), and so does #209's round trip,
      untouched.
- [ ] The every-limit performance test passes inside 15 s with factors at their limit; times in the PR.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build` green locally.
- [ ] PR body: Summary, Evidence (preflight, the timings, the round trip), Merge Danger ("apply BEFORE deploying the app;
      the old function would drop the new section silently"); `Closes #228`; "Defaults taken".

---

## Open questions (each with the default the builder uses)

**Q1. The limit.** **Default: 3,000 per-person times**, the same as skills (people are capped at 1,500, so two times a
person on average). Lower it if the 15 s budget needs.

**Q2. A time on a step that isn't restored.** **Default: leave it out and count it** (the engine never used it; there is
no step to show it against). The alternative, keeping it as a stored "Not used now" row, would restore a reference to a
step that doesn't exist in the new workspace.

**Q3. Provenance.** **Default: carry it as exported**, so measured times stay measured (with their item counts) and
entered ones keep when and by whom, as `people` and steps already do. Their `dataset_id` points at the source workspace.

**Q4. An editor's restore and the switch.** **Default: unchanged**: the switch travels with the other settings as one
pending suggestion for an owner. Restoring it directly for editors would make the settings section mixed.

**Q5. Plans without the section.** **Default: accept them as an empty section** (hunk e), so an app deployed before the
migration keeps working.
