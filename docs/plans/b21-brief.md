# B21 build brief: restore bigger workspaces (#203)

Scoped 6 Oct 2026 against `main` at a883256 (after #205, #206, #207 and #209 merged). Read `docs/plans/builder-brief.md`
first; this brief adds to it and wins where they differ. Read `docs/plans/b10-2-brief.md` for how the restore works (B10
part 2b built it). Follow this brief strictly. If something doesn't match the code, **ask; don't guess.** Austin is asleep
for the overnight run, so every open question below has a default; take it.

## The short version

Today a restore is **one database call** (`public.import_workspace_bundle`) in **one transaction**, so it is all or
nothing. It was kept inside a 3 s budget (locally) because Supabase stops any statement by `authenticated` at 8 s, which
limited a restore to 50 processes, 500 steps, 1,000 edges, 300 issues, 1,000 clients and so on.

B21 keeps the single, all-or-nothing call, and makes it bigger and faster:

1. **Its own time limit.** The function declares `set statement_timeout = '40s'`. PostgREST applies a function's own
   settings to the call, after the role's settings, so this one function gets 40 s and everything else keeps 8 s. This
   was verified locally with PostgREST 14.1 (see the audit). The route's 60 s limit covers it.
2. **Two speedups, both measured:**
   - the id remap uses two plain `replace` calls instead of one `regexp_replace` (13× faster on a 22 MB plan);
   - a new index `audit_log (target_id)` turns the per-process "already logged?" scan in `log_process_import`
     (which grows with the size of the workspace) into an index lookup (1.07 s down to 0.02 s at 250 processes).
3. **About four times the limits** (table below). Every limit reached at once restores in about 7 s locally, against a
   new local budget of 15 s and the database's 40 s.
4. **Caps on the sections that had none:** client services, leave and the small company-model tables.
5. **Clearer failures:** a second restore into the same workspace while one runs is refused at once with "already
   running" (not after waiting out the timeout). The route won't start the database call once 15 s have gone, and the page
   no longer says "Nothing was restored" when it can't know.

No multi-call (chunked) restore: as the signed-in user it can't be all or nothing (see "Why not a chunked restore"). If the
live check shows Supabase is too slow even with 40 s, the limits come down; that is a safe failure, because a restore that
runs out of time writes nothing.

| | |
|---|---|
| Branch | `claude/b21-bigger-restores` (this brief is its first commit; build on it) |
| Migration | `20261215000000_bigger_restores` (one `create or replace` with the same signature, plus one index) |
| Apply file | `packages/db/scripts/apply/20261215000000_bigger_restores.sql` |
| Closes | #203 (`Closes #203`) |
| Engine | No change, no `ENGINE_VERSION` bump, no golden numbers move |

---

## Decisions (verbatim)

**Ticket #203** (the whole body, as filed):

> B10 part 2b (#39, PR #201) restores a workspace from a JSON backup in one all-or-nothing call, within a 3 s budget. Its
> limits are 75 processes, 750 steps, 1,500 edges, 200 sources, 600 issues, 500 people, 2,000 clients, and 300 scenarios
> and blocks, with caps on the link tables too.
>
> Export is allowed for much bigger workspaces (up to 250,000 rows per table). For now, a bundle that's over the restore
> limits exports with a plain warning that it can't be restored yet.
>
> The Opus review of #201 found that the main cost is the company-map sync, which runs once per restored process.
>
> **What to build**
> - Raise the restore limits so every workspace that exports can be restored. One way: run the company-map sync once per
>   restore instead of once per process, and profile what's left.
> - Remove the export warning once no exportable workspace is over the limits. Alternatively, keep a single high limit that
>   matches export.
>
> **Acceptance criteria**
> - [ ] A synthetic workspace at the export limits restores in one call within an agreed time budget (measure first, then
>   agree the budget).
> - [ ] The round trip still passes: the model is equal once ids are mapped back, and results are within run-to-run
>   variation.
> - [ ] The performance test covers every table at its limit, including the link tables.

(The ticket's numbers are out of date: `main` has 50 processes, 500 steps, 1,000 edges, 200 sources, 300 issues, 500
people, 1,000 clients and 300 scenarios and blocks. The audit below uses `main`.)

**Austin's answers on #39 (6 Oct), which still bind the restore:**

> 1. **Import:** (b). Each process is imported as a draft of its latest published version. History isn't restored, and no privileged restore migration is added.
> 2. **Company map:** (b). The new workspace keeps its own company map, which is laid out by default from the imported processes. The bundle still carries every version of the map for reference.
> 3. **Hidden clients:** included in the bundle. Emails and tokens stay out.
> 4. **Who can export and import:** agency admins, owners and editors only, for both. Members and viewers can't.

> - **Q1:** yes to the migration `import_workspace_bundle`. It is one SECURITY INVOKER function: not privileged, additive only, and it creates drafts only. It makes the restore all-or-nothing.
> - **Q2:** saved solutions aren't restored. They stay in the bundle file, and the import result lists them as not restored, so they can be rebuilt once the processes are published.

> **Decision.** The acceptance criterion becomes:
> 1. The restored engine model equals the source model, once ids are mapped back.
> 2. Headline results are within normal run-to-run variation.

**Overnight rules (`docs/HANDOVER.md` on `claude/handover-6oct-evening`, "Rules while Austin is away"):**

> - **Open questions:** take the brief's default. Record each default on the issue and under "Design calls Claude made,
>   for Austin to confirm". Never block waiting for an answer.
> - **Never weaken a test to get green.** A test that is flaky by chance gets made robust in its own small PR.

And from "Production migrations": "Additive only; verify after each". For this ticket, a replaced function is acceptable
only as `create or replace` with the same signature.

**What this brief reads into them:**
- The restore must stay **one SECURITY INVOKER function and one transaction** (Q1: "It makes the restore all-or-nothing";
  decision 1: no privileged restore). So: no SECURITY DEFINER helper, and no multi-call restore that can leave a
  half-filled workspace.
- "Every workspace that exports" can't be met literally: export stops at 250,000 rows per table and 600,000 in all, which
  is a guard against running out of memory, not a workspace size anyone has. At the measured cost (about 0.3 ms per row,
  growing with size) a one-call restore of 600,000 rows would take minutes. So B21 takes the ticket's alternative in
  spirit: restore limits sized from measurements, about 4× today's. Export keeps its warning above them (**Q1**, default).

---

## Audit: what exists today, with measurements

### The pieces (on `main` at a883256)

| Piece | File | Notes |
|---|---|---|
| The restore function | `packages/db/supabase/migrations/20261207000000_import_workspace_bundle.sql` | `public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text default null) returns jsonb`, plpgsql, SECURITY INVOKER, `set search_path = ''`. Steps: who → shape and limits (hard-coded numbers, lines 209–218) → advisory locks (blocking `pg_advisory_xact_lock` on `import_workspace_bundle:<ws>` and `import_new_process:<ws>`) → empty → placeholder check → **id remap with `regexp_replace` over the whole plan text** (line 306) → scenario skip → one `begin … exception` block per section, written set-based (`jsonb_populate_recordset`), except processes (a loop: insert, `open_draft`, layout) and the final `log` (a loop over `log_process_import`). Production row 54. Body md5 `968cbd0034a0bb1479b8ee0c9eaf7962` (29,716 characters). |
| Its apply file | `packages/db/scripts/apply/20261207000000_import_workspace_bundle.sql` | Style to copy (header, `begin; set local lock_timeout = '5s'; … commit;`). |
| Limits in TS | `packages/db/src/workspace-import.ts` lines 21–55 | `WORKSPACE_IMPORT_LIMITS`, `MAX_BACKUP_BYTES` (25 MB), `MAX_COMPRESSED_BYTES` (4 MB). Used by `checkWorkspaceBundle` (`WORK_CAP` early refusal at 2× a limit, then `limitProblems`), `restoreSizeWarning` (export's warning) and the `ImportSummary.measures` shape. |
| Export's ceilings | `packages/db/src/workspace-bundle.ts` | `MAX_TABLE_ROWS = 250_000`, `MAX_BUNDLE_ROWS = 600_000`; `restoreSizeWarning` adds `restore_warning` and `X-Backup-Warning` above the restore limits. |
| The route | `apps/web/src/app/w/[slug]/restore/bundle/route.ts` | `maxDuration = 60`. One `rpc("import_workspace_bundle")`. |
| Error words | `apps/web/src/lib/restore/errors.ts` | `57014` → 504 "too big … (the database ran out of time)"; `planDetail` parses `the plan is (over a limit|too big) (…)` from the function's message. |
| The page | `apps/web/src/components/restore/restore-backup.tsx` | Gzips in the browser, refuses over 4 MB, posts once; on a thrown `fetch` it says "Nothing was restored", which is wrong once a restore can run for 40 s (the connection can drop while the database commits). |
| Tests | `packages/db/test/workspace-import.test.ts` | `describe("limits")` (lines 777–830: one over each limit → `22023`), `syntheticPlan` (832–875) and `describe("performance")` (877–892: every limit at once, **budget 3,000 ms**). The round-trip block (195–378) was just reworked by #209; **don't touch it.** |
| Planner tests | `packages/db/test/workspace-import-plan.test.ts` | Limit cases read `WORKSPACE_IMPORT_LIMITS`, so they follow the new numbers; line 345 builds a string of `L.planBytes` characters. |
| Docs | `docs/supabase-notes.md` line 343 ("Time" row of the restore), `docs/production-migrations.md` row 54 | Update both. |

### How the cost was measured

Database `b21_scope` on the container's Postgres 16 (shared with other agents, so expect ±15% noise), built like the test
harness (auth and storage shims, Supabase default privileges, every migration, the seed). A copy of the function with
`raise notice` after each section (and the limit check switched off) timed every section. `set local track_functions = 'all'`
then `pg_stat_xact_user_functions`, read before the rollback, gave the time inside every trigger and RLS helper. Each run
was: an agency admin creates a workspace with `create_workspace`, restores a synthetic plan (the test's `syntheticPlan`
shape: 10 steps and 20 edges per process, one link, owner and source per issue, 3 roles), then rolls back. Times are the
call as the client sees it.

### Measurements

**At today's limits (×1, one call, 4.17 MB plan with 3,000,000 characters of source text): 1.99, 1.99, 2.17 s.**

| Section (×1) | Rows | Time | Per row |
|---|---|---|---|
| shape and limit checks | | 0.04 s | |
| id check and **remap** (`regexp_replace` over the plan text) | | 0.36–0.42 s | ≈ 0.09 s per MB of plan |
| people | 500 | 0.06–0.07 s | 0.13 ms |
| role assignments | 400 | 0.03–0.06 s | 0.09 ms |
| clients | 1,000 | 0.12–0.15 s | 0.13 ms |
| sources | 200 | 0.04–0.06 s | 0.2 ms |
| processes (insert, `open_draft`, map card) | 50 | 0.18–0.21 s | 3.9 ms |
| scenarios / blocks | 300 / 300 | 0.03 / 0.02 s | 0.1 / 0.05 ms |
| issues (with 1 link, 1 owner, 1 source each) | 300 | 0.29–0.39 s | 1.0 ms |
| steps (and 2 edges each) | 500 | 0.43–0.49 s | 0.9 ms |
| client assignments / skills / source links | 400 / 1,000 / 400 | 0.04 / 0.07–0.11 / 0.04 s | 0.1 / 0.08 / 0.1 ms |
| suggestions / proposals | 500 / 300 | 0.05 / 0.02 s | 0.1 / 0.05 ms |
| archive, import log | 3, 50 | 0.01, 0.03–0.04 s | |

Where the time goes at ×1 (self time): the function itself 0.86 s (the remap, the inserts, foreign-key checks),
`is_agency_admin` 11,575 calls 0.31 s (RLS: every inserted row re-checks `can_edit_workspace`), `audit_company_write` 0.18 s,
`log_issue_link_change` 0.08 s, `audit_mcp_write` 0.06 s, `company_map_apply` 0.09 s for all 50 processes. **No single
hot spot**: the cost is per-row triggers and RLS spread over many functions. The company-map sync is **not** the main
cost at today's size (0.09 s); #201's review saw it grow at 200 processes, which this audit confirms (below).

**Scaling, one dimension at a time:**

| Run | Total | Notes |
|---|---|---|
| 25 / 50 / 100 / 200 processes (10 steps, 20 edges each) | 0.44 / 0.77 / 1.34 / 2.77 s | about linear: ≈ 3.5 ms a process and 0.8 ms a step with its edges |
| 10 processes × 10 / 40 / 100 steps | 0.24 / 0.39 / 1.05 s | linear in steps |
| company model, issues and suggestions ×1 / ×4 (one process) | 1.0 / 4.0–4.5 s | issues grow faster than linear: 300 in 0.27 s, 1,200 in 1.7–1.85 s (0.9 → 1.4 ms each) |

**Every limit at once, larger (one call, limit check off):**

| Scale | Plan | Total | Biggest sections |
|---|---|---|---|
| ×5 | 20.9 MB | 12.2–17.2 s | issues 2.4–4.1 s, steps 2.3–2.9 s, remap 2.1–2.4 s, processes 1.1–1.4 s, import log 0.85–1.1 s |
| ×10 | 41.7 MB | 32.8–38.3 s | issues 8.2–10.1 s, remap 4.9–5.6 s, steps 4.5–5.5 s, processes 3.2–3.7 s, import log 2.8–3.0 s |

What grows faster than the rows (per call, ×1 → ×10): `log_process_import` 0.7 → 5.6 ms (its "already logged?" query
filters `audit_log` by `workspace_id` only, and every company-model row the restore writes adds an audit row, so it scans
tens of thousands of rows per process); `company_map_apply` 0.7 → 4 ms (it re-diffs the whole map each time, and also
updates its `audit_log` entry by a `workspace_id` scan); `log_issue_link_change` 0.09 → 0.3 ms and `link_issue_source`
0.14 → 0.5 ms (likely plans chosen for near-empty tables, which a fresh workspace's rows are in the transaction).

**Speedups tried:**

| Change | Result | Taken? |
|---|---|---|
| Remap with two plain `replace` calls instead of `regexp_replace` | On a 22.5 MB text: 1.30 s → 0.10 s. In the restore: ×1 remap 0.36–0.42 → 0.16 s; ×4 0.61–0.67 s | **Yes** |
| Index `audit_log (target_id)` | ×5: import log 1.07 s → 0.02 s; ×4: 0.03 s. (At ×10 the planner once ignored it on the fresh test database; production has real statistics.) | **Yes** |
| `set_config('enable_seqscan', 'off', true)` inside the restore | ×5 went from 14 s to **121 s** (`live_holder` 106 s) | **No** (never do this) |
| `analyze` before restoring | No change (the tables were tiny anyway) | No |

**With both speedups, every limit at once:** ×1 1.84 s; **×4 7.3 s and 6.6 s** (200 processes, 2,000 steps, 4,000
edges, 800 sources with 12,000,000 characters, 1,200 issues, 2,000 people, 4,000 clients, 1,200 scenarios and blocks,
2,000 suggestions, 1,200 proposals, 1,600 role assignments, 4,000 skills, 1,600 client assignments, 1,600 source links;
a 16.7 MB plan). At ×4: steps 1.7–1.9 s, issues 0.94–1.1 s, processes 0.67–0.78 s, remap 0.61–0.67 s, clients
0.41–0.57 s, everything else under 0.5 s.

**PostgREST honours a function's own `statement_timeout`** (PostgREST 14.1, binary from the GitHub release, against
`b21_scope`; a scratch role `b21_anon` with `alter role … set statement_timeout = '1s'`, as Supabase sets 8 s on
`authenticated`):

| Call | Answer |
|---|---|
| a function without its own setting, sleeping 0.1 s, returning `current_setting('statement_timeout')` | `"1s"` (the role's setting is applied) |
| the same, sleeping 2 s | `57014` "canceling statement due to statement timeout" |
| a function with `set statement_timeout = '5s'`, sleeping 2 s | `"5s"`: it ran past the role's 1 s |
| the same, sleeping 6 s | `57014` at 5 s: the function's own limit is enforced |

So a function's `set statement_timeout` overrides the role's for that call over PostgREST, and only for that call. It
has **not** been checked on Supabase itself (its PostgREST version and any gateway timeout); that is the live check in
"Done". Called from plain SQL (the db tests), a function's `set statement_timeout` does nothing to the running statement,
so the local tests can't see it.

**Found in passing (not this ticket):** deleting a workspace fails today, even as the superuser:
`delete from public.workspaces where slug = 'northbeam'` → `update or delete on table "roles" violates foreign key
constraint "steps_role_id_workspace_id_fkey" on table "steps"`. So "an agency admin deletes the half-restored workspace"
isn't available as a clean-up path either. Reported separately; don't fix it here.

### Why not a chunked restore (several calls)

Considered and rejected for this ticket (open question **Q5** records it):

- Each PostgREST request is its own transaction. Writing in several calls means a failure part-way leaves rows behind.
- Undoing them as the signed-in user isn't possible: `never_delete_clients` refuses to delete clients for `authenticated`
  while the workspace exists, `suggestions` and `suggestion_proposals` have no delete policy, and `audit_log` and
  `issue_events` are append-only. A SECURITY DEFINER clean-up would be the "privileged restore" Austin ruled out, and
  deleting the whole workspace currently fails (above).
- Staging the plan in a table and "finalising" in one call doesn't help: the finalising call does all the writing, so it
  has the same time limit.

One call with its own time limit keeps Austin's all-or-nothing rule and needs no new table, no new grant and no change to
any other function.

---

## What to build

### 1. Migration `packages/db/supabase/migrations/20261215000000_bigger_restores.sql`

Two statements, in this order, and nothing else:

```sql
create index if not exists audit_log_target_id_idx on public.audit_log (target_id);

create or replace function public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text default null) returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '40s'
as $$
  … the body of 20261207000000, copied exactly, with only the changes listed below …
$$;

revoke all on function public.import_workspace_bundle(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.import_workspace_bundle(uuid, jsonb, text) to authenticated;
```

(`create or replace` keeps the grants; the revoke and grant repeat them so the file states them. Don't touch the
`private.scenario_library()` grant.)

**Changes to the body, and only these** (copy the rest character for character; a diff of the two bodies must show only
these hunks):

(a) **Limits.** Replace the numbers in the limit check and its message with the new table below, and add the new caps
(`client_services`, `person_leave`, and the combined small company-model tables). Keep the message's shape exactly
`import_workspace_bundle: the plan is over a limit (<list>)`, because `planDetail` in `errors.ts` parses it. Update the
`max_plan_chars` constant to **26,214,400** (20 MiB × 1.25: the database measures the jsonb text, which has a space after
each colon and comma) and the "too big" message to `(at most 20 MB)`.

(b) **Remap.** Replace

```sql
  txt := regexp_replace(p_plan::text, '00000000-0000-4000-8000-(?!000000000000)([0-9a-f]{12})', prefix || '\1', 'g');
  txt := replace(txt, placeholder || '000000000000', p_workspace::text);
```

with

```sql
  -- Two plain replacements (a regular expression took 13 times as long on a big plan): every placeholder gets the fresh
  -- prefix, then rank 0 (the old workspace), now `<prefix>000000000000`, becomes the real workspace. The prefix is never
  -- all zeros (the loop above), so no other id can take rank 0's place.
  txt := replace(p_plan::text, placeholder, prefix);
  txt := replace(txt, prefix || '000000000000', p_workspace::text);
```

The result is identical to today's for every plan the planner makes, where a placeholder is always a whole id (the prefix
followed by 12 hex digits). The only difference: a free-text string holding the bare prefix `00000000-0000-4000-8000-`
not followed by 12 hex digits would now be rewritten too; no real text holds it, and the old code already rewrote it when
followed by hex. Keep the "ids" tests green untouched. Update the comment above it.

(c) **"Already running".** Replace the first, blocking lock

```sql
  perform pg_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || p_workspace::text, 0));
```

with a try-lock that refuses at once:

```sql
  if not pg_try_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || p_workspace::text, 0)) then
    raise exception 'A restore into this workspace is already running.' using errcode = '55P03', hint = 'busy';
  end if;
```

Keep the second lock (`import_new_process:`) blocking, as today: uploads are short. Today the second of two restores waits
and then finds the workspace not empty; with a 40 s restore it could wait out its own timeout and be told "too big".

(d) **The header comment of the function body**, if any line states a limit or "8 s": update it. Nothing else.

**No other change** to the function: same refusals in the same order, same sections, same return shape. Not even
reformatting.

#### The new limits

Sized at about 4× today's, from the ×4 measurement (6.6–7.3 s with the speedups). The extra caps are new (today these
sections have no cap at all).

| Limit (TS key / SQL) | Today | New | Plan section(s) |
|---|---|---|---|
| `processes` | 50 | **200** | `processes` |
| `steps` (in the versions restored) | 500 | **2,000** | sum of `processes[].steps` |
| `edges` | 1,000 | **4,000** | sum of `processes[].edges` |
| `sources` | 200 | **800** | `sources` |
| `sourceChars` | 3,000,000 | **6,000,000** | sum of `sources[].body` lengths |
| `issues` | 300 | **1,200** | `issues` |
| `people` | 500 | **2,000** | `people` |
| `clients` | 1,000 | **4,000** | `clients` |
| `scenarios` | 300 | **1,200** | `scenarios` |
| `blocks` | 300 | **1,200** | `blocks` |
| `suggestions` | 500 | **2,000** | `suggestions` |
| `proposals` | 300 | **1,200** | `proposals` |
| `personRoles` | 400 | **1,600** | `person_roles` |
| `personSkills` | 1,000 | **4,000** | `person_skills` |
| `clientAssignments` | 400 | **1,600** | `client_assignments` |
| `sourceLinks` | 400 | **4,000** | `source_links` (it also holds one `issue` link per issue source, which `link_issue_source` makes anyway, so 4× issues' worth) |
| `clientServices` (new) | none | **4,000** | `client_services` |
| `personLeave` (new) | none | **2,000** | `person_leave` |
| `companyOther` (new) | none | **2,000** | `lead_sources` + `seasonality` + `churn_drivers` + `market_conditions` + `market_schedule` + `services` + `service_servicing` + `client_groups`, counted together |
| `planBytes` | 10 MB | **20 MB** | the compact JSON plan (DB: 26,214,400 characters of jsonb text) |
| `backupBytes` / `compressedBytes` | 25 MB / 4 MB | unchanged | the file / the request (Vercel's request limit is 4.5 MB) |

`sourceChars` is 2×, not 4×: source text is prose, which gzips to about a third, so 12,000,000 characters would push a
real backup past the 4 MB request limit before any other limit. The request limit stays the real ceiling for text-heavy
workspaces; the page already says so ("too big to restore in one go").

**The performance test is the arbiter** (as in B10): every limit at once must restore in **under 15 s** locally. If it
doesn't, lower the limits (all by the same factor) until it does, and say so in the PR. **Never** raise the function's
timeout above 40 s, and never raise any other timeout.

#### Header comment of the migration

Copy the shape of `20261207000000_import_workspace_bundle.sql`'s header:

- Purpose: B21 (#203), bigger restores in the same one call; the decisions quoted (Q1 "It makes the restore
  all-or-nothing", decision 1).
- What changes and why, with the numbers from this brief's audit (×1 2.0 s; ×4 6.6–7.3 s after the speedups; remap 13×;
  import log 1.07 s → 0.02 s at 250 processes).
- The timeout: "`set statement_timeout = '40s'` on this function only. PostgREST applies a function's own settings
  after the role's, so this call gets 40 s and every other request by `authenticated` keeps Supabase's 8 s. Verified with
  PostgREST 14.1 locally; see `docs/supabase-notes.md`. The app's route allows 60 s and won't start the call after 15 s."
- "STRICTLY ADDITIVE: one index and one `create or replace` of `public.import_workspace_bundle` with the same signature,
  the same refusals, sections and result. It doesn't redefine `save_fields` or any other function, trigger or policy."
- ORDER: applies after `20261207000000` (row 54). Independent of rows 55–58.
- PREFLIGHT, POST-APPLY and ROLLBACK as below.

**Preflight** (read-only; each with its expected result):

```sql
-- 0. Row 54 is applied, and this one isn't. Expect 1, then 0:
select count(*) from supabase_migrations.schema_migrations where version = '20261207000000';
select count(*) from supabase_migrations.schema_migrations where version = '20261215000000';
-- 1. The function is still exactly the one 20261207000000 made (nothing later replaced it).
--    Expect 968cbd0034a0bb1479b8ee0c9eaf7962, false, {search_path=""}:
select md5(prosrc), prosecdef, proconfig from pg_proc where oid = 'public.import_workspace_bundle(uuid, jsonb, text)'::regprocedure;
-- 2. The index doesn't exist yet. Expect null:
select to_regclass('public.audit_log_target_id_idx');
-- 3. How big audit_log is (the index is built under a lock that blocks audit writes while it builds; the apply file sets
--    lock_timeout = 5s). Expect well under a million rows; record the numbers:
select count(*), pg_size_pretty(pg_total_relation_size('public.audit_log')) from public.audit_log;
-- 4. Nobody restoring right now (no long-running call of the function). Expect 0:
select count(*) from pg_stat_activity where query ilike '%import_workspace_bundle%' and pid <> pg_backend_pid();
```

**Post-apply checks:**

```sql
-- 1. Expect false, {search_path="",statement_timeout=40s}, and the new body's md5 (the builder computes it from the file and
--    writes the value here):
select prosecdef, proconfig, md5(prosrc) from pg_proc where oid = 'public.import_workspace_bundle(uuid, jsonb, text)'::regprocedure;
-- 2. Only authenticated may execute it (as row 54's post-apply checks 1 and 2). Expect one row, authenticated EXECUTE:
select routine_name, grantee, privilege_type from information_schema.routine_privileges
 where routine_schema = 'public' and routine_name = 'import_workspace_bundle' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 2;
-- 3. The index. Expect CREATE INDEX audit_log_target_id_idx ON public.audit_log USING btree (target_id):
select indexdef from pg_indexes where schemaname = 'public' and indexname = 'audit_log_target_id_idx';
-- 4. The row. Expect 1:
select count(*) from supabase_migrations.schema_migrations where version = '20261215000000';
```

**Rollback** (in the header, in full, one transaction). The function part is the **whole** `create function` statement of
`20261207000000_import_workspace_bundle.sql` with `create function` changed to `create or replace function` (that
restores its body and drops `statement_timeout` from its settings, because `create or replace` replaces them all). Write it
out in the header as SQL comment lines (generate them from the file with a script, `-- ` before every line; don't
retype it):

```sql
-- begin;
-- drop index if exists public.audit_log_target_id_idx;
-- create or replace function public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text default null) returns jsonb
-- language plpgsql
-- security invoker
-- set search_path = ''
-- as $$
-- … the 20261207000000 body, every line …
-- $$;
-- delete from supabase_migrations.schema_migrations where version = '20261215000000';
-- commit;
-- Then check: md5(prosrc) = '968cbd0034a0bb1479b8ee0c9eaf7962' and proconfig = {search_path=""}.
-- Roll the app back first: the app's limits must not be above the function's.
```

Add a test (below) that the commented rollback body, with the `-- ` prefixes removed, equals the 20261207000000 body.

#### Apply file `packages/db/scripts/apply/20261215000000_bigger_restores.sql`

As `scripts/apply/20261207000000_import_workspace_bundle.sql`: a header ("applies after row 54 (20261207000000); apply BEFORE
deploying the app, because the app's new limits need the function's"), `begin;`, `set local lock_timeout = '5s';`, the
migration SQL exactly, `insert into supabase_migrations.schema_migrations (version, name, statements) values
('20261215000000', 'bigger_restores', array[$mig$<the migration SQL>$mig$]);`, `commit;`. The existing test "has an
apply file that is the migration plus its schema_migrations row" shows how to check it; add the same check for this file.

Then `pnpm --filter @transpera-flow/db gen:bootstrap`. No `gen:types` change (same signature), no `gen:seed`.

### 2. TypeScript: `packages/db/src/workspace-import.ts`

- `WORKSPACE_IMPORT_LIMITS`: the new numbers and the three new keys (`clientServices`, `personLeave`, `companyOther`),
  `planBytes: 20 * 1024 * 1024`. Rewrite the doc comment above it: what it took before (keep one line of history), the
  ×4 measurement with the speedups, the 15 s local budget, the 40 s function limit, "the SQL function checks the same
  numbers".
- `ImportSummary.measures`: add `clientServices`, `personLeave`, `companyOther`; fill them in `planWorkspaceImport` from
  the plan (`plan.client_services.length`, `plan.person_leave.length`, and the sum of the eight small sections). Add them to
  the `empty` measures in `checkWorkspaceBundle`, to `limitProblems` ("client services", "leave entries", "other company
  settings rows") and to `restoreSizeWarning`'s list.
- `WORK_CAP` (the early refusal at 2× a limit) needs no new entries.
- Nothing else in the planner changes. Plans stay byte-for-byte the same for the same bundle.

### 3. The route and the page

**`apps/web/src/app/w/[slug]/restore/bundle/route.ts`:**
- Note `const started = Date.now()` first thing in `POST`.
- Just before `supabase.rpc("import_workspace_bundle", …)`: if `Date.now() - started > 15_000`, answer `503` with
  `{ message: SLOW_START_MESSAGE }` and don't call the database. (Reading, unzipping, checking and planning a 25 MB file
  takes a few seconds; 15 s + the function's 40 s stays inside the route's 60 s, so Vercel never cuts off a call the
  database then commits.)
- Read `status` from the rpc result too (`const { data, error, status } = …`). Pass it to `restoreFailure`.
- Update the header comment (one restore call may take up to 40 s; the 15 s rule and why).

**`apps/web/src/lib/restore/errors.ts`:**
- `SLOW_START_MESSAGE = "The server took too long to read the backup, so it didn't start the restore. Nothing was restored. Try again."`
- `BUSY_MESSAGE = "A restore into this workspace is already running. Wait a minute, then reload this page."` for hint
  `busy` → status 409. Check `busy` before the other hints.
- `restoreFailure(error, status?)`: when the rpc's HTTP `status` is 413 (the API gateway refused the request's size),
  return 413 with `"This backup is too big to send to the database in one go. Nothing was restored."`.
- `TOO_BIG_MESSAGE` stays as it is.

**`apps/web/src/components/restore/restore-backup.tsx`:**
- While restoring, under the button: "A big backup can take up to a minute. Keep this page open." (the button already
  says "Restoring…").
- When `fetch` throws, or the answer isn't JSON with a `message` (for example a gateway's HTML 504), say:
  "We lost the connection before the restore answered. It may still finish: reload this page in a minute. If the
  workspace then has processes, the restore worked; if not, nothing was restored." Never say "Nothing was restored" when
  the answer didn't come from the route. Answers from the route keep their own message.

### 4. Docs

- `docs/supabase-notes.md`: rewrite the restore's "Time" row (line 343): the new limits, ×4 at 6.6–7.3 s locally, the 15 s
  local budget, the function's own 40 s `statement_timeout`, verified with PostgREST 14.1 only. The live check (from
  "Done"). Add one sentence: if Supabase ignores the function's timeout, a big restore stops at 8 s with "too big", writes
  nothing, and the limits must come down (follow-up).
- `docs/production-migrations.md`: a new row after the last one, numbered next, **NOT applied**, in the style of row 54:
  what changes, the preflight results to fill in, the apply file, the rollback in one line.
- Don't edit `docs/HANDOVER.md` (the orchestrator keeps it).

---

## Patterns to copy

| What | Where |
|---|---|
| Migration and apply-file headers, preflight, post-apply checks, rollback | `20261207000000_import_workspace_bundle.sql` and its apply file |
| A `create or replace` of an existing function with the full old SQL as rollback | row 17 in `docs/production-migrations.md` (`20261017000000_health_patches`) |
| Error mapping and its tests | `apps/web/src/lib/restore/errors.ts`, `apps/web/test/restore-errors.test.ts` |
| Route tests with mocks | `apps/web/test/restore-route.test.ts` |
| Restoring as a committed user, counting, `failure`, `snapshot`, `newWorkspace`, `miniPlan` | `packages/db/test/workspace-import.test.ts` lines 1–190 |
| Exporting a workspace in a test | `exportOf` in the same file |

---

## Edge cases

- **Timeouts.** One call, one transaction: if it runs past 40 s, Postgres cancels it, it writes nothing, and the page says
  "too big to restore in one go (the database ran out of time)". If Supabase ignores the function's setting (live check
  fails), the same happens at 8 s: nothing written, a clear message. Never a half-restored workspace.
- **Partial failure.** Can't happen: a refused row anywhere rolls back everything (the "all or nothing" test stays).
- **The route's own limit.** The route doesn't start the call after 15 s, so the call (≤ 40 s) ends before Vercel's 60 s.
  If the browser loses the connection anyway (laptop sleeps, proxy timeout), the database may still commit: the page says
  so and asks for a reload (above). The restore page itself already refuses a non-empty workspace, so a reload shows
  "not empty" or the restored Overview.
- **Two restores into one workspace at once.** The second is refused at once with hint `busy` (409, "already running").
  After the first finishes, a new attempt is refused `not_empty`, as today.
- **A process upload during a restore.** It waits on the shared `import_new_process:` lock. Uploads have the role's 8 s,
  so one started during a long restore may time out ("too big"-style message from the upload path). Acceptable: the
  workspace is new and being restored.
- **Other people in the new workspace during a long restore.** Their writes that touch the company map's row (the
  restore holds `for no key update` on it from the first process on) wait and may time out at 8 s. Reads aren't blocked.
  Acceptable; say it in `docs/supabase-notes.md`.
- **Restores into different workspaces at the same time.** Independent (per-workspace locks, the per-workspace issue
  counter). Each holds one PostgREST connection for its duration.
- **The empty-workspace rule.** Unchanged (checked after the locks, before anything is written). A restore that timed out
  wrote nothing, so the workspace is still empty and can be restored again, for example after the limits come down.
- **Memory.** A 20 MB plan is held as text and jsonb a few times over inside the function (about 100–150 MB at most). Part
  of the live check: watch the Supabase dashboard's memory during the at-limits restore.
- **Plans at exactly a limit** pass; one over fails `22023` with the limits sentence (the route shows "It is over a limit
  of a restore (…)").
- **Backups made before B21** restore as before (the plan format doesn't change).
- **Export.** Unchanged ceilings (250,000 a table, 600,000 in all). Its warning now shows only above the new limits (Q1).

---

## Tests

All new database tests go in **new files**, so nothing collides with the round-trip block #209 reworked.

**Move, don't copy:** cut `syntheticPlan` (lines 832–875) and `describe("performance")` (877–892) out of
`packages/db/test/workspace-import.test.ts` and put the generator in a new helper `packages/db/test/synthetic-plan.ts`
(exported, no `describe`). Leave every other line of `workspace-import.test.ts` as it is, except the `limits` describe below.

**`packages/db/test/synthetic-plan.ts`:** `syntheticPlan(L)` extended so every section has rows, each capped one at its
limit:
- everything it has today, plus `person_leave` (`L.personLeave`), `client_services` (`L.clientServices`: one service per
  client, cycling over the services), `services`, `service_servicing`, `client_groups`, `lead_sources`, `seasonality` (12),
  `churn_drivers`, custom `market_conditions` and `market_schedule` (one row pointing at a preset with
  `condition_preset`), together exactly `L.companyOther`;
- `settings`, `demand_settings`, `lever_settings`, `analysis_rules` set (not null);
- one `first_principles` object per process;
- steps with `person_id` on some, `provenance` evidence citing a source id on some (so `link_cited_sources` runs), and one
  holder step (`child_process_id`) pointing at another process;
- issues with links, owners and sources as today; `source_links` of every kind the plan allows (`process`, `step`,
  `issue`), the total exactly `L.sourceLinks`;
- `scenarios` take `L.scenarios − 4` when `options.forExport` is set (the new workspace's 4 library scenarios count too,
  once exported). Take the column names from `IMPORT_COLUMNS`; check a value against the table's checks before using it.

**New `packages/db/test/workspace-import-large.test.ts`** (`createTestDb({ supabaseDefaultPrivileges: true })`, a
committed `as` helper as in `workspace-import.test.ts`):

1. **Every limit at once, inside the budget.** `syntheticPlan(WORKSPACE_IMPORT_LIMITS)`; assert the compact JSON is under
   `planBytes`; time the restore as an agency admin; `console.log` the time and plan size; **expect < 15,000 ms**. Then
   assert per table that the rows are there: processes, steps, edges (of non-company processes), people, clients, issues,
   `issue_links`, `issue_owners`, `issue_sources`, sources, scenarios (plan's minus skipped), blocks, suggestions,
   proposals, `person_roles`, `person_skills`, `person_leave`, `client_services`, `client_assignments`, `source_links` by
   kind, and the eight small tables. This is the ticket's "every table at its limit, including the link tables".
2. **A workspace at the limits exports without the warning and checks clean.** Restore
   `syntheticPlan(L, { forExport: true })`, export it as an editor (copy `exportOf`), `JSON.parse(JSON.stringify(…))`;
   `restoreSizeWarning(bundle)` is `null`; `checkWorkspaceBundle(bundle)` is `ok` with no errors; and each
   `summary.measures` value is at most its limit (equal for processes, steps, edges, issues, people, clients, the link
   tables). If a measure differs from the plan's count (auto-made `issue` source links, the library scenarios), shape the
   synthetic so it lands exactly; say how in a comment. If `process.env.B21_BACKUP_OUT` is set, write the bundle there (for
   the live check); never in CI.
3. **One over the new caps.** For `clientServices`, `personLeave` and `companyOther`: one row over → `22023` with the
   limits sentence, and `snapshot` unchanged.
4. **The remap is the same as before.** For the Mini plan and the synthetic plan: every restored id equals
   `id_prefix + rank` (read `id_prefix` from the result), every reference column points at a restored row, rank 0 became the
   workspace (a suggestion targeting `workspaces` points at it), and a uuid typed into free text is unchanged. (The
   existing "ids" tests must also stay green untouched.)
5. **Busy.** Two connections: the first opens a transaction and takes
   `pg_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || ws, 0))` (standing in for a running restore); the
   second calls the restore → `55P03`, hint `busy`, at once (well under 1 s), nothing written. Release; a restore then works.
6. **The function's settings.** `proconfig` is `{search_path="",statement_timeout=40s}`, `prosecdef` false, and only
   `authenticated` may execute it.
7. **The index.** `audit_log_target_id_idx` exists on `audit_log (target_id)`.
8. **The migration's rollback is the old function.** Read the header of `20261215000000_bigger_restores.sql`, take the
   commented rollback's function body (strip `-- `), and compare it with the body in `20261207000000_import_workspace_bundle.sql`:
   equal. Its md5 is `968cbd0034a0bb1479b8ee0c9eaf7962`.
9. **The new body differs from the old only where this brief says.** Compare the two bodies line by line after removing
   the limit check, `max_plan_chars`, the remap lines, the first lock and comments: equal. (Cheap insurance against a
   copy error.)
10. **The apply file** is the migration plus its row in one transaction (as the existing test for 20261207000000).

**`packages/db/test/workspace-import.test.ts`:** in `describe("limits")`, add `client services`, `leave entries` and
`other company rows` to the `it.each` list (one over → `22023`). Nothing else changes in this file apart from the move above.

**`packages/db/test/workspace-import-plan.test.ts`:** the limit cases already follow the constants; add cases for the three
new measures (at the limit ok, one over an error naming it). Check line 345 still works with `planBytes` at 20 MB (it
builds a 20 MB string: if that makes the test slow, build it once).

**`apps/web/test/restore-errors.test.ts`:** `busy` → 409 `BUSY_MESSAGE`; status 413 → the "send to the database" message;
the existing cases unchanged.

**`apps/web/test/restore-route.test.ts`:** with `Date.now` stubbed to jump past 15 s after the body is read, the route
answers 503 `SLOW_START_MESSAGE` and never calls the rpc; under 15 s it calls it; the rpc's 413 status is mapped.

**`apps/web/test/restore-browser.test.ts`** (or the harness test that covers the component): while restoring, the "up to
a minute" line shows; a `post` that throws, and one that answers an HTML 504, show the "lost the connection" message and
not "Nothing was restored".

**The round trip** (`describe("a restore is a round trip")`) must pass unchanged for Northbeam and Larkspur: that is the
ticket's second acceptance criterion, and the speedups must not move any id.

**PostgREST** (`packages/mcp/test/postgrest-restore.test.ts`): unchanged cases stay green. Don't try to test the timeout
there (it needs a role setting on a shared role); it is in `docs/supabase-notes.md` and the live check.

Run everything: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`, with your own
database names if another agent's Postgres is running (see `builder-brief.md`).

---

## Out of scope

- A chunked or resumable restore across several calls (Q5).
- Changing any trigger, RLS policy or helper (`is_agency_admin`, the audit and issue triggers) to make rows cheaper. RLS
  helpers are 15–20% of the time; changing them touches every request in the app.
- Running the company-map sync once per restore instead of once per process. At the new limits it costs 0.67–0.78 s for
  200 processes and stays linear once `audit_log` has the index; skipping it would mean changing
  `private.company_map_membership`.
- Dropping the `issue` source links that `link_issue_source` recreates from the plan (a small saving; changes the plan).
- Export's ceilings and its warning wording (Q1).
- Fixing workspace deletion (reported separately).
- Any engine change; no `ENGINE_VERSION` bump.
- `docs/HANDOVER.md`.

---

## Done

- All green locally, including the round trip for both golden workspaces and the new performance test (record its time
  and the plan size in the PR).
- The migration, the apply file and `bootstrap.sql` regenerated; preflight 0–4 in the PR body with their expected
  results; the new body's md5 written into post-apply check 1.
- `docs/supabase-notes.md` and `docs/production-migrations.md` updated (the row NOT applied).
- PR body (the `pr` skill): Summary, Evidence (the measurements table from this brief and your own at-limits time),
  Merge Danger (apply BEFORE deploy; the live check). `Closes #203`.
- **Live check after applying (orchestrator):** on a preview deploy, an agency admin creates a workspace and restores the
  at-limits backup (`B21_BACKUP_OUT=…` from test 2, gzipped under 4 MB). Record: the time, that it succeeded (if it took
  over 8 s, that proves the function's timeout is honoured), the Supabase memory graph, and that a Northbeam backup still
  restores. If it fails with "ran out of time" at about 8 s, Supabase ignores the function's setting: open a follow-up to
  lower the limits (×1.5 of today's fits 3 s) and leave this merged; nothing is ever half-restored.

---

## Open questions (each with the default the builder takes)

**Q1. Export above the new limits.** Export allows up to 250,000 rows a table; no restore can take that. Keep export's
ceilings and its plain warning above the new restore limits, or lower export to the restore limits so every export
restores? *Default: keep export as it is, with the warning (now only for workspaces about 4× bigger than before). Lowering
export would stop the biggest workspaces from being backed up at all.*

**Q2. A longer time limit for this one function.** B10's brief said "don't raise any timeout". This gives only
`import_workspace_bundle` 40 s (every other request keeps 8 s), so the restore stays one all-or-nothing call. *Default:
yes, 40 s.*

**Q3. How much bigger.** *Default: about 4× (table above), which restores in about 7 s locally against a 15 s local budget
and the 40 s limit, leaving room for Supabase's slower machines. Calibrate after the live check: if the at-limits restore
takes under 10 s on Supabase, a later ticket can raise them again.*

**Q4. If Supabase ignores the function's timeout** (the live check stops at about 8 s). *Default: nothing is written, the
page says "too big"; lower the limits in a small follow-up PR (to about 1.5× today's) and record it. No other change.*

**Q5. A chunked restore for workspaces bigger still.** It can't be all or nothing as the signed-in user (clients can't be
deleted, suggestions have no delete, history is append-only), and deleting a workspace currently fails. *Default: not in
B21. If Austin wants it, a separate ticket decides between a SECURITY DEFINER "discard" (against decision 1) and a
workspace marked "restore didn't finish" that an agency admin deletes (after workspace deletion is fixed).*

**Q6. Caps on the sections that had none** (client services, leave, the small company-model tables). *Default: add them
(4,000, 2,000, 2,000), so every section of a plan has a limit and the performance test covers each one.*

**Q7. The "already running" refusal.** *Default: refuse a second concurrent restore into the same workspace at once (409),
instead of letting it wait up to 40 s.*

---

## Appendix: reproducing the measurements

1. `create database b21_scope;` then load, in order, `packages/db/test/sql/auth-shim.sql`, `storage-shim.sql`, `alter default
   privileges in schema public grant all on tables to anon, authenticated, service_role;`, every migration in file-name
   order and `packages/db/supabase/seed.sql` (what `createTestDb` does).
2. Make a copy of the function with `raise notice 'B21 % % %', sec, n, clock_timestamp() - t0` after each section's
   `counts := …` line (and after the checks, the empty check and the remap), and with the limit check off. Install it as
   `public.import_workspace_bundle` in `b21_scope` only.
3. In a pg client: `begin`; insert an `auth.users` row with `raw_app_meta_data = {"agency_admin": true}`; `set local
   track_functions = 'all'`; `set local role authenticated`; set `request.jwt.claims`; `create_workspace`; time
   `import_workspace_bundle(ws, <syntheticPlan at a scale>, 'x.json')`; collect the notices; `reset role`; read
   `pg_stat_xact_user_functions` ordered by `self_time`; `rollback`.
4. PostgREST: `PGRST_DB_URI=postgres://authenticator:authenticator@localhost:5432/b21_scope PGRST_DB_SCHEMAS=<schema>
   PGRST_DB_ANON_ROLE=<a scratch role with a role-level statement_timeout> PGRST_JWT_SECRET=<32+ characters> postgrest`, and
   two functions that `pg_sleep` and return `current_setting('statement_timeout')`, one with `set statement_timeout`. The
   anon role needs USAGE on `private` and EXECUTE on `private.api_token_pre_request()` (the pre-request hook the migrations
   register on `authenticator`). A database-scoped role setting (`alter role … in database …`) was **not** applied by
   PostgREST 14.1 in this test; a role-wide one was.
5. Drop the database afterwards.
