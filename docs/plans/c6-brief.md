# C6 build brief: per-person times (capacity factors) (#198)

Scoped 6 Oct 2026 (night) against `origin/main` at 94820270 (B3 #215 merged, so `share_links` and `share_team_capacity`
exist). Read `docs/plans/builder-brief.md` first. This brief adds to it and wins where they differ. Build strictly from it.
If something here doesn't match the code, **ask; don't guess.** Every open question has a default: use it.

## The short version

One person can be faster or slower than their role's normal time on a step. An owner or editor types a **factor** for the
person: 1.0 is the role's normal time, 0.8 is 20% faster, 1.25 is 25% slower, from 0.5 to 2.0. There is one optional
factor for **every step** the person does (their default) and one optional factor **per step**, which wins over the
default. If neither is set, the factor is 1.0. The simulation multiplies the hands-on time that person takes on that step
by the factor.

1. **Switch.** The existing `settings.capacity_factor_enabled` key, off by default, gets a toggle in Settings → Simulation
   ("Per-person times"). Owners **and editors** can switch it. Today `save_fields('workspaces')` is owner-only, so a new
   SECURITY DEFINER function writes only this one key (the `save_health_rules` pattern).
2. **Storage.** A new table, `public.person_capacity_factors`. It is **not** `person_skills.efficiency`, because any
   `person_skills` row limits the person to the listed steps. Per-person read RLS (`can_see_person`), editor writes, and
   writes go through one SECURITY INVOKER compare-and-set function.
3. **Privacy.** `team_capacity` is redefined (a full copy plus one key). It returns every factor to those who see everyone,
   and only the caller's own factors to members and viewers. The engine reads factors **only** for a viewer who sees
   everyone, so a member's simulation uses everyone's normal time, with a note saying so. Share links never carry a factor:
   `share_team_capacity` is untouched, the redaction empties the list, and a new Postgres trigger refuses a snapshot that
   holds one.
4. **Engine.** `EnginePerson.capacityFactor?: { default?: number; steps?: Record<string, number> }`. Hands-on time is
   `st.work() × factor`, after the draw, so no random stream moves. `ENGINE_VERSION` 1.9.0 → **1.10.0** with
   `golden:approve --bump`. **No golden number moves:** no fixture has factors and the switch is off everywhere.
5. **Screens.** Factors are edited in **Settings → People, inside each person's detail** (the `<details>` row that already
   holds roles, skills and leave). The People page's person detail **shows** them read-only through the existing gate,
   `capacityFactorsShown`. Every factor and the switch get an (i). Factors are never ranked, never compared across people,
   never put in a table column, and never set against a role median.
6. **Backups.** The export holds the factor rows. A restore leaves them out and says so (Q2).

**One PR**, branch `claude/c6-capacity-factors` (this brief is already on it; run `git merge origin/main` first).
Migration `20261223000000_capacity_factors.sql`, plus the apply file. Commit and push after each part: (1) migration,
apply file and DB tests; (2) engine and goldens; (3) `packages/db` model, loaders, share and bundle; (4) app actions and
Settings UI; (5) People page; (6) browser tests; (7) docs. The PR says `Closes #198`.

---

## Decisions (verbatim)

**#198, Austin, 6 Oct (night), in reply to "what's C6":**
> Just add it in

This replaces his earlier parking decision (comment on #198, 6 Oct):
> Austin's decision on 6 Oct: per-person speed is **not wanted for now**. It's parked as **phase 2**, not to be built in
> Milestones B or C.

**The orchestrator's defaults for this ticket** (Austin accepts the scoper's defaults; each is **Claude's default, for
Austin to confirm**):
> - **Shape.** One factor per person per step, plus an optional per-person default. Range 0.5–2.0, where 1.0 is the role's
>   normal time and 0.8 means 20% faster. Missing means 1.0.
> - **Switch.** Off by default per workspace (`capacity_factor_enabled`, which exists already). Owners and editors switch
>   it on in Settings.
> - **Who sets it.** Entered by hand by owners and editors. No calibration proposal in this ticket; note it as a follow-up
>   for C2's step log when it names people.
> - **Who sees it.** This is per-person data, so B1's privacy rules apply. Owners, editors and agency admins see
>   everyone's. A member or viewer sees only their own, through the existing own-row patterns. `team_capacity` must not
>   expose others' factors to members; check 2a/2b's implementation. Factors are never ranked, never compared across
>   people, and never benchmarked against a role median (PRD D20).
> - **Where shown.** The B2 People page already has a capacity-factor gate (`capacityFactorsShown`) that currently shows
>   nothing; wire it in. Show the editing UI in the person detail. Every factor and the switch get an (i).
> - **Engine.** The service time a person takes on a step is multiplied by their factor. Use `det-math` only. Pick an
>   `ENGINE_VERSION` bump with `golden:approve --bump`; golden numbers must not move, because every fixture has no factors
>   and the feature is off. Check the performance targets.

The engine change uses no `log` or `exp`, only one IEEE multiplication, so nothing from `det-math.ts` is needed. Never
add `Math.log` or `Math.exp`.

**PRD D20:**
> Capacity, not performance: individual availability/skills/assignments; capacity factor off by default, shown only when
> measured, visible to the person, never ranked; no role-median benchmark. DPA clause in the retainer.

**PRD §6.3.7:**
> The per-step capacity factor exists but is disabled by default per workspace. When enabled, it is only displayed once
> measured (minimum sample size: 10 completed items for that person-step) or explicitly entered; it is visible to the
> person themselves; and it is never presented as a ranking or against a role median.

**PRD §2 (quoted in the B1 brief):**
> Per-person data (capacity, utilisation, capacity factor) is visible to `agency_admin`, `owner` and `editor`, **and to
> the person themselves**.

**#30 (B1), Austin, 6 Oct:**
> - **Their numbers:** everything else matches what an editor sees. The screens show members only their own row.

> Known limit, accepted: a member using browser dev tools can still read anonymous hours and leave dates.

**#39 (B10), Austin, 6 Oct (from HANDOVER):**
> a restored workspace's results match the original within run-to-run variation

**#32 (B3), Claude's design call (HANDOVER), and PRD §9's share-link table:**
> **no one person's pay is ever in a link**

> | People | People anonymised by role ("Strategist A"); capacity factors flattened to 1.0 | Real names, individual capacity factors |

Q1, Q2 and Q3 below say where this brief departs from the last three, and why.

---

## Audit: what exists on `origin/main`

| Thing | State | C6 change |
|---|---|---|
| `workspaces.settings.capacity_factor_enabled` | A key only. It is in the suggestions allow-list (`20261021000000_roles_and_workspaces.sql` L181; `packages/db/src/suggestions.ts` L32; `packages/mcp/src/suggestion-tools.ts` L99) and in `COMPANY_FIELDS.workspaces` (`packages/db/src/company.ts` L89, "Capacity factors"). It is **not** in the `WorkspaceSettings` type (`packages/db/src/types.ts` L24). Nothing reads it except `capacityFactorsShown`. | Add to `WorkspaceSettings`; a toggle; read by `toEngineModel` |
| Who can write settings | `save_fields('workspaces', …)` runs under `"update workspaces"` = `can_manage_workspace` (owners and agency admins). Editors get `not_found`. `save_health_rules` (`20261209000000_agency_list.sql` L205) is the precedent for an editor-writable key. | New `public.save_capacity_factor_switch` |
| `person_skills.efficiency` | `numeric not null default 1 check (> 0)`, unused. **Any `person_skills` row limits the person to the listed steps** (`EnginePerson.skills`, `eligibility.ts`). `team_capacity` never returns it. The import allow-list carries it. | **Unusable** for factors: a factor on a step would also limit who can do what. Leave it alone. |
| `person_skills` / per-person RLS | `"read person_skills"` uses `public.can_see_person(workspace_id, person_id)` (`20261207500000_per_person_privacy.sql`). That header says: "Reused later by C2 for its per-person factors table: keep name and signature." | Same policy on the new table |
| `team_capacity(ws)` | SECURITY DEFINER, defined **only** in `20261207500000_per_person_privacy.sql` L185–241 (no later redefinition; `20261207700000` doesn't touch it). It lists its columns explicitly, so a new column or table is invisible until added. | `create or replace` with one new key, `person_capacity_factors` |
| `share_team_capacity(ws, show_people)` | B3 (`20261220000000_share_links.sql` L591). A separate function with `team_capacity`'s shape and no pay. `shareReaderDb` (`packages/db/src/share.ts` L146) swaps `team_capacity` for it. | **Untouched**: no factors key, so a link's bundles parse to `[]` |
| Share snapshot | `OverviewShare.live` is a whole `ProcessBundle` (`share.ts` L68). `redactShareSnapshot` / `shareSnapshotLeaks` redact and check it in TS. `private.share_snapshot_problem` checks it in Postgres (pay, emails, names, evidence, money). | Empty the factor list in redaction, report it in leaks, and add a new Postgres trigger that refuses factor keys |
| `save_fields` | Latest definition: `20261111000000_client_groups.sql` L152. The allow-list has `people`, not any factor table. | **Not redefined.** Writes go through the new function. |
| People page | `components/people-page.tsx` L447–449: `PersonDetailBlock` calls `capacityFactorsShown(bundle.workspace.settings, [])` and renders `<div data-capacity-factors />` only when it's non-empty. `lib/people.ts` L162–173: the gate and `CAPACITY_FACTOR_MIN_ITEMS = 10`. Tests: `apps/web/test/people.test.ts` L155–176; `people-browser.test.ts` L214–220 ("shows no capacity factor anywhere, even with the setting on (C6 is parked)"). | Wire in; change that browser test (below) |
| Settings → People | `app/w/[slug]/settings/people-settings.tsx`: `PersonRow` is a `<details>` per person with fields, roles, skills (`ChecklistField` over `data.steps`) and `Leave`. `SimulationSettings` holds the availability floor and overtime cap (owner-only). Data: `loadWorkspaceSettings` (`lib/data.ts` L420). | Factor editor in `PersonRow`; toggle in `SimulationSettings` |
| Engine | `startService` (`packages/engine/src/simulate.ts` L2023): `const handsOn = st.work(); dur = handsOn / frac;`. `PersonState` (L531). `stepStates` entries have `mi` (0…n−1). `EnginePerson` (`model.ts` L31). `ENGINE_VERSION = "1.9.0"`. | Multiply after the draw |
| `toEngineModel` people | `resolvePeopleRows` (`packages/db/src/model.ts` L648). Pay is dropped when `hidesPay(bundle)`. AI uses `payFreeBundle` / `neutralBundle` (`apps/web/src/lib/ai/neutral.ts`), which set `viewer.seesEveryone = false`. | Add `capacityFactor` only when `usesCapacityFactors(bundle)` |
| Backups | Export: `BUNDLE_TABLES` (`packages/db/src/workspace-bundle.ts` L39) uses `select *` per table. Restore: `checkWorkspaceBundle` / `planWorkspaceImport` (`workspace-import.ts`) and `public.import_workspace_bundle` (latest: `20261215000000_bigger_restores.sql` L494). The restore skips unknown settings keys with a warning. `SETTING_KEYS` is a `Record<keyof WorkspaceSettings, true>`. | Export the rows; the restore leaves them out with a "left out" line (Q2) |
| Audit / MCP guards | `private.audit_company_write` and `private.company_needs_review` triggers on the person tables (`20261015000000_suggestions.sql` L240, L218). `public.stamp_provenance(variadic cols)` stamps `entered`. | Same three triggers on the new table |
| Change log text | `apps/web/src/lib/suggestions/audit.ts` L25, L75, L104 describe person-table entries | Add the new table |

Nothing else covers this. There are no `capacity_factor` columns anywhere, no factor table, and no calibration of
per-person times. C2's step log (`datasets`, `record_calibration`) has no person column.

---

## Part 1: migration `20261223000000_capacity_factors.sql`

**Additive**, with one exception: `create or replace` of `public.team_capacity`, with the same signature, return type
and grants (a full copy plus one key). Nothing else existing changes: not `save_fields`, not
`share_team_capacity`, not `private.share_snapshot_problem`, not `import_workspace_bundle`, and no existing policy or grant.

### 1a. Table

```sql
create table public.person_capacity_factors (
  person_id uuid not null,
  workspace_id uuid not null,
  -- Null: the person's factor for every step they do (their default). A step id: that step only (wins over the default).
  -- Step ids are stable across a process's versions (as person_skills.step_id); no foreign key, as for person_skills.
  step_id uuid,
  -- Their time on the step as a multiple of the role's normal time: 0.8 is 20% faster, 1.25 is 25% slower.
  factor numeric not null check (factor >= 0.5 and factor <= 2),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade
);
-- One default and one factor per step, per person (two partial indexes: a null step_id is the default).
create unique index person_capacity_factors_step on public.person_capacity_factors (person_id, step_id) where step_id is not null;
create unique index person_capacity_factors_default on public.person_capacity_factors (person_id) where step_id is null;
create index on public.person_capacity_factors (workspace_id);
```

There is no primary key. The two partial unique indexes are the identity. This avoids `NULLS NOT DISTINCT`, which would
need Postgres 15. `audit_company_write` falls back to `person_id` as `target_id`, which is what the change log wants.

Triggers (copy the existing calls):
- `set_updated_at` before update: `public.set_updated_at()`.
- `stamp_provenance` before insert or update: `public.stamp_provenance('factor')`, so `provenance.factor` is
  `{source: 'entered', at, by}`.
- `audit_company` after insert or update or delete: `private.audit_company_write()`.
- `needs_review` before insert or update or delete: `private.company_needs_review()`. MCP (an API token) can't write
  factors.

RLS (enable it) and grants:
```sql
create policy "read person_capacity_factors" on public.person_capacity_factors for select to authenticated
  using (public.can_see_person(workspace_id, person_id));
create policy "insert person_capacity_factors" on public.person_capacity_factors for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update person_capacity_factors" on public.person_capacity_factors for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete person_capacity_factors" on public.person_capacity_factors for delete to authenticated
  using (public.can_edit_workspace(workspace_id));
grant select, insert, update, delete on public.person_capacity_factors to authenticated;
revoke all on public.person_capacity_factors from anon;
```
The table isn't added to the Realtime publication: the screens `refresh()`.

### 1b. `public.save_capacity_factor(person uuid, step uuid, base numeric, value numeric) returns jsonb`

`language plpgsql security invoker set search_path = ''`. Compare-and-set for one factor, so RLS decides who writes.
`step` null means the default. `value` null removes the factor (back to 1.0, or to the default for a step).

1. If `value` is not null and not between 0.5 and 2: raise 23514 `'save_capacity_factor: a factor is from 0.5 to 2'`.
2. `select workspace_id into ws from public.people where id = person`. RLS applies: a member sees only their own person.
   If none is found, or `not coalesce(public.can_edit_workspace(ws), false)`, return `{"status": "not_found"}`.
3. If `step` is not null and no `public.steps` row has `id = step and workspace_id = ws`: raise 22023
   `'save_capacity_factor: that step is not in this workspace'`.
4. `select factor into stored from public.person_capacity_factors where person_id = person and step_id is not distinct
   from step for update`.
5. If `stored is distinct from base and stored is distinct from value`, return `{"status": "conflict", "theirs": stored}`
   (JSON null when there is no row). Otherwise, if `stored is distinct from value`:
   - value null: delete the row;
   - row exists: update `factor`;
   - no row: insert `(person, ws, step, value)`. On `unique_violation`, re-read and return `conflict` with what is stored
     now. Don't loop.
6. Return `{"status": "saved", "value": <stored after the write, or null>}`.

`revoke execute … from public, anon; grant execute … to authenticated;`. The UPDATE/INSERT/DELETE fire `needs_review`
at depth 1, so an API token is refused (42501) even through this function. Test that.

### 1c. `public.save_capacity_factor_switch(ws uuid, base jsonb, changes jsonb) returns jsonb`

**A copy of `public.save_health_rules`** (`20261209000000_agency_list.sql` L205–271), with the same result shape,
errcodes, `can_edit_workspace` check, `for update` lock and conflict rule. Change only these:
- `allowed constant text[] := array['capacity_factor_enabled'];`
- the value check: `jsonb_typeof(v) in ('null', 'boolean')`. Otherwise raise 23514
  `'save_capacity_factor_switch: % must be true, false or null'`.
- **null and false are the same** (absent means off): compare `coalesce(nullif(stored -> k, 'null'), 'false')`,
  `coalesce(nullif(base -> k, 'null'), 'false')` and `coalesce(nullif(v, 'null'), 'false')`, and write `v` as given.
- error message prefix `save_capacity_factor_switch:`.

SECURITY DEFINER, `search_path = ''`, `revoke … from public, anon`, `grant … to authenticated`. The UPDATE still fires
`stamp_settings_provenance`, `audit_company` and `needs_review` (MCP refused), as in the original.

### 1d. `public.team_capacity(ws)`: full copy plus one key

`create or replace function public.team_capacity(ws uuid) returns jsonb`. Copy **20261207500000's body exactly**
(L185–238, the only definition), and change one thing, marked `-- C6`: add this key to the `jsonb_build_object`:

```sql
    -- C6: per-person times. Everyone's for those who see everyone; only the caller's own person's otherwise (none when
    -- unlinked). Never provenance (it holds who entered it); `source` says entered or measured.
    'person_capacity_factors', coalesce((select jsonb_agg(jsonb_build_object('person_id', f.person_id, 'step_id', f.step_id,
        'workspace_id', f.workspace_id, 'factor', f.factor,
        'source', coalesce(f.provenance -> 'factor' ->> 'source', 'entered'))
        order by f.person_id, f.step_id nulls first)
      from public.person_capacity_factors f
      where f.workspace_id = ws and (everyone or (own is not null and f.person_id = own))), '[]'::jsonb)
```

Keep the grants (create or replace does). Update the function's header comment in the new migration, not the old one.
The shape comment gains `person_capacity_factors: [{person_id, step_id, workspace_id, factor, source}]`.

### 1e. Share links refuse per-person times

A new trigger, so B3's functions stay as they are:

```sql
create function private.share_links_no_speeds() returns trigger
language plpgsql set search_path = ''
as $$
begin
  -- C6: no link carries anyone's per-person times, whatever its toggles (D20: only the person and owners and editors see them).
  if new.snapshot is not null and (
       jsonb_path_exists(new.snapshot, 'lax $.**.personCapacityFactors[*]')
    or jsonb_path_exists(new.snapshot, 'lax $.**.person_capacity_factors[*]')
    or jsonb_path_exists(new.snapshot, 'lax $.**.capacityFactor')) then
    raise exception 'The snapshot contains per-person times.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.share_links_no_speeds() from public, anon, authenticated;
create trigger share_links_no_speeds before insert or update of snapshot on public.share_links
  for each row execute function private.share_links_no_speeds();
```

`share_links_before_write` raises its leak problems with errcode 23514 and the problem as the message (L575), so this
matches. Check that the app's share action shows this message the way it shows B3's leak refusals. An empty
`personCapacityFactors: []` passes (`[*]` of an empty array yields nothing): test it.

### 1f. Header

The migration header must hold, in B3's style:
- **What it adds** (the list above) and **ORDER**: after `20261220000000` (B3, needed: `share_links`), `20261221000000`
  (B4) and `20261222000000` (the bug fix). If either of those two hasn't been applied when C6 is, renumber per HANDOVER.
- **PREFLIGHT** (read-only, `prod-sql.sh -c`):
  0. `select version from supabase_migrations.schema_migrations where version >= '20261220000000' order by 1;`
     Expect 20261220000000 (and 20261221000000 / 20261222000000 if applied), and nothing >= 20261223000000.
  1. Nothing exists yet. Expect null ×4: `to_regclass('public.person_capacity_factors')`,
     `to_regprocedure('public.save_capacity_factor(uuid, uuid, numeric, numeric)')`,
     `to_regprocedure('public.save_capacity_factor_switch(uuid, jsonb, jsonb)')`,
     `to_regprocedure('private.share_links_no_speeds()')`.
  2. `team_capacity` is 20261207500000's. Expect one row `t, f`:
     `select prosrc like '%Team member%', prosrc like '%person_capacity_factors%' from pg_proc where pronamespace =
     'public'::regnamespace and proname = 'team_capacity';`
  3. Helpers exist. Expect 7 rows: `can_see_person`, `can_edit_workspace`, `set_updated_at`, `stamp_provenance` (public);
     `audit_company_write`, `company_needs_review` (private); and `to_regclass('public.share_links')` not null.
  4. The workspaces triggers the switch function relies on are enabled. Expect 3 rows, all `O` (copy of agency_list's
     preflight 2).
  5. For the log: workspaces that already have the key. Expect 0. If any has `true`, nothing moves, because there are no
     factors yet: `select slug, settings -> 'capacity_factor_enabled' from public.workspaces where settings ?
     'capacity_factor_enabled';`
- **POST-APPLY CHECK:**
  1. `relrowsecurity` true. Four policies; the select qual mentions `can_see_person`.
  2. anon has no table grant. authenticated has SELECT, INSERT, UPDATE, DELETE.
  3. `prosecdef, proconfig`: `save_capacity_factor` (f, `{search_path=""}`), `save_capacity_factor_switch` (t, same),
     `team_capacity` (t, same), `share_links_no_speeds` (f, same).
  4. `has_function_privilege` anon false and authenticated true for the two public functions.
  5. Triggers on the table: `set_updated_at`, `stamp_provenance`, `audit_company`, `needs_review`. On `share_links`:
     `share_links_no_speeds`. Both partial unique indexes exist.
  6. Smoke test, rolled back, as an agency admin (copy 20261207500000's): `public.team_capacity('<northbeam id>') ->
     'person_capacity_factors'` is `[]`.
  7. On the real project: an editor switches Per-person times on in Settings → Simulation and sets one factor. The owner's
     change log names them. Switch it off again.
- **ROLLBACK** (one transaction, parsed by `packages/db/test/header-rollback.ts`, so use its `-- ROLLBACK (` heading
  and three-space indented lines):
  ```
  begin;
  drop trigger if exists share_links_no_speeds on public.share_links;
  drop function if exists private.share_links_no_speeds();
  drop function if exists public.save_capacity_factor_switch(uuid, jsonb, jsonb);
  drop function if exists public.save_capacity_factor(uuid, uuid, numeric, numeric);
  -- team_capacity: the whole `create function public.team_capacity ... $$;` statement of 20261207500000 with
  -- `create or replace` (written out in full here, so the test can run it)
  drop table if exists public.person_capacity_factors;
  delete from supabase_migrations.schema_migrations where version = '20261223000000';
  commit;
  ```
  Write the full `team_capacity` body inside the rollback, not a pointer. A header-rollback test (below) runs it.

Apply file: `packages/db/scripts/apply/20261223000000_capacity_factors.sql`: `begin;`, the migration SQL, the
`schema_migrations` insert (HANDOVER "Applying a migration"), then `commit;`. Then `gen:bootstrap`, and hand-edit
`packages/db/src/database.types.ts`, matching the generator's format (table Row/Insert/Update/Relationships and the two
new Functions), because `gen:types` needs a linked machine (precedent: #205–#207). `gen:seed` must show no diff, since no
fixture changes. Add the row to `docs/production-migrations.md` as "not yet applied".

---

## Part 2: engine

`packages/engine/src/model.ts`, on `EnginePerson`:

```ts
  /**
   * Per-person time (capacity factor; PRD §6.3.7, D20; C6, #198): the hands-on time they take on a step is the drawn time ×
   * the factor. 1 is the role's normal time, 0.8 is 20% faster. `steps` wins over `default`; a step in neither is 1.
   * Omitted: 1 everywhere. Only for steps they can do (a factor on any other step is never used).
   */
  capacityFactor?: { default?: number; steps?: Record<string, number> };
```

`packages/engine/src/simulate.ts`:
- `PersonState` gains `factors: Float64Array | null`, indexed by `StepState.mi`.
- Build it where `people` is mapped (L874): `factorsFor(person, stepList)` returns `null` when `capacityFactor` is absent
  or every resolved value is exactly 1. Otherwise it returns an array where `[st.mi] = steps[id] ?? default ?? 1`. Throw
  `Error("<name>'s per-person time must be a number above 0")` for a value that is not finite or is ≤ 0. The engine
  accepts any positive number; the database limits 0.5–2.
- `startService` L2030: `const drawn = st.work(); const handsOn = p.factors ? drawn * p.factors[st.mi]! : drawn;`.
  Everything after it (`dur`, `handsOnSum`, busy and servicing hours, `spread`, loops) already uses `handsOn`. Draw first,
  always: the factor never changes how many numbers a stream gives.
- Check every other place that builds or copies an `EnginePerson` (`grep -rn "EnginePerson" packages/engine/src
  packages/db/src apps/web/src`). It must keep `capacityFactor`: spreads do, explicit field lists don't. `resolvePeople`'s
  role-count people and scenario hires (`scenario.ts` L337) have none, which is correct.
- Analytic estimates stay at the role's normal time: `scenario.ts` `stepHours` (the `@busiest` / `@heaviest` selectors),
  `simulate.ts` L2471 (work at unstaffed steps), the `issues.ts` text "hands-on X h". Don't change them; add a one-line
  comment at `stepHours`.

Version: `pnpm --filter @transpera-flow/engine golden:approve --bump "EnginePerson gains an optional capacityFactor (per-person times, C6 #198): hands-on time × the person's factor. No fixture has one, so no simulated number moved."`
→ `1.10.0`. The ledger digest must equal 1.9.0's (`sha256:8ebb2e03…`). If any golden number moves, stop: the change is
wrong. `browser-determinism.test.ts` must pass untouched.

Performance: the hot path gains one null check per service start. Run the `perf`-tagged tests
(`apps/web/test/scenarios.test.ts`: < 150 ms pipeline-only, < 250 ms seeded; `new-rules.test.ts` absence pass), and put
the before/after times in the PR. Also time one Northbeam-seeded run where every person has a default of 0.9 and two step
factors (in a test, not a golden). It must stay under 250 ms.

---

## Part 3: `packages/db`

**Types** (`types.ts`):
- `WorkspaceSettings.capacity_factor_enabled?: boolean`, with a doc comment: "Per-person times (C6): off unless true."
- `export interface PersonCapacityFactorRow { person_id: string; workspace_id: string; step_id: string | null; factor: number; source: string }`.
  This is the shape `team_capacity` gives. The Settings loader maps table rows into it.
- `ProcessBundle.personCapacityFactors?: PersonCapacityFactorRow[]`. It is optional, so fixtures, the demo and B3/B4
  snapshots without it still type-check.
- `types.ts` has an `Assert<Matches<…>>` table (L1168). Add nothing there for the jsonb shape.

**`queries.ts`**:
- `TeamInputs.personCapacityFactors: PersonCapacityFactorRow[]` from `(t.person_capacity_factors ?? []).map(r => ({ ...r,
  factor: Number(r.factor) }))`. `share_team_capacity` has no such key, so a link's team gets `[]`.
- `loadProcessBundle` passes `personCapacityFactors: team.personCapacityFactors`. **Never** read the table directly in
  any loader that feeds a `ProcessBundle`. A direct read would bypass `shareReaderDb` and put an editor's factors into a
  snapshot.
- Update `loadTeam`'s doc comment.

**`model.ts`**:
- `export function usesCapacityFactors(bundle: ProcessBundle): boolean`, true when
  `bundle.workspace.settings.capacity_factor_enabled === true && !hidesPay(bundle)`. `hidesPay` (L215) is
  `payHidden === true || (viewer && !viewer.seesEveryone)`, so it covers members, viewers and share-link bundles (which
  set `payHidden`). A bundle with no `viewer` (the demo, fixtures) sees everyone. `payFreeBundle` / `neutralBundle` (AI)
  set `seesEveryone: false`, so AI never reads factors, and an analysis's base hash doesn't change when a factor does.
- `export function speedsNormalisedFor(bundle): boolean`: the switch is on and `!usesCapacityFactors(bundle)`. This drives
  the member note.
- `resolvePeopleRows`: when `usesCapacityFactors(bundle)`, take the person's rows from `bundle.personCapacityFactors`.
  `default` is the row with `step_id === null`, when its factor `!== 1`. `steps` holds the rows whose `step_id` is in
  `stepIds` (as skills are filtered) and whose factor `!== 1`, with keys inserted in sorted id order. Set
  `capacityFactor` only when one of them is non-empty. Use the `...(cond ? {…} : {})` style of the neighbouring fields.

**`share.ts`**:
- `redactShareSnapshot`: every `ProcessBundle` it touches gets `personCapacityFactors: []` (defence in depth; it is
  already empty).
- `shareSnapshotLeaks`: a new leak kind for any non-empty `personCapacityFactors` or any `capacityFactor` key, anywhere.
- Classify the new table in `packages/db/test/share-field-classes.test.ts` as `"unused"`. It won't compile until you do.
- No change to `SHARE_NON_TEXT_KEYS` (factors are numbers; `step_id`/`person_id` are already there).

**`workspace-bundle.ts`** (export): `person_capacity_factors: T("person_capacity_factors", "person_id", "step_id")` in
`BUNDLE_TABLES` and in `companyKeys`. Check that `step_id` null orders and pages correctly through the `TableReader`
(nulls last is fine). If paging by a nullable column breaks, order by `person_id, created_at` and say so in the PR.

**`workspace-import.ts`** (restore, Q2):
- Add `person_capacity_factors` to `NO_ID_TABLES`, so `checkWorkspaceBundle` accepts rows without `id`.
- **Do not** add it to `IMPORT_COLUMNS`/the plan. In `leftOut`, add
  `line("capacity_factors", cm.person_capacity_factors?.length ?? 0, "per-person times (enter them again after the restore; until then everyone works at their role's normal time)")`.
- When the backup has factors **and** `settings.capacity_factor_enabled === true`, also push a warning: "This backup has
  per-person times switched on. They aren't restored, so results will differ from the original until you enter them
  again."
- `SETTING_KEYS` gains `capacity_factor_enabled: true` (the type forces it). The switch itself is restored like any setting.
- Update the file's "Not restored" header line.

**`company.ts`**: change the label `capacity_factor_enabled` from "Capacity factors" to "Per-person times".

**`suggestions/audit` text** (`apps/web/src/lib/suggestions/audit.ts`): add `person_capacity_factors` to its table list
and person-table branch. The entry reads `${who}: a per-person time ${set | removed | changed}`. It never states the
number in text (the diff holds it, and only managers read the log).

---

## Part 4: app writes and Settings

`apps/web/src/lib/fields/server.ts`:
- `saveCapacityFactorSwitch(workspaceId, base: boolean | null, value: boolean)`: a copy of `saveHealthRule`, calling
  `save_capacity_factor_switch` with key `capacity_factor_enabled`.
- `saveCapacityFactor(personId, stepId: string | null, base: number | null, value: number | null): Promise<SaveOutcome<number | null>>`:
  calls `save_capacity_factor` and maps `saved` / `conflict` (`theirs`) / `not_found`, and errors through `errorOutcome`.

`apps/web/src/app/w/[slug]/settings/actions.ts`:
- `saveCapacityFactorsEnabled(workspaceId, base, value)`. Check `isId`, `typeof value === "boolean"`, base boolean or
  null, and `signedIn()`. Call the server helper and `refresh()` on saved, because the Settings page shows or hides the
  factor editors.
- `savePersonCapacityFactor(personId, stepId | null, base, value)`. Check `isId(personId)`, `stepId === null ||
  isId(stepId)`, `value === null || (number(value) && value >= 0.5 && value <= 2)`, base null or a finite number, and
  `signedIn()`. Round `value` to 2 decimals before sending.

`loadWorkspaceSettings` (`lib/data.ts`):
- Add `supabase.from("person_capacity_factors").select("person_id, step_id, workspace_id, factor, provenance").eq("workspace_id", ws)`
  (RLS: everyone's for editors, own for members). Map rows to `PersonCapacityFactorRow` (`source` from
  `provenance.factor.source ?? "entered"`). Expose them as `WorkspaceSettingsData.personCapacityFactors`. This page
  isn't a share source, so a direct read is fine here.

`people-settings.tsx`:
- **`SimulationSettings`**: add a `ToggleField` "Per-person times", `value={settings.capacity_factor_enabled === true}`,
  saver `(base, next) => saveCapacityFactorsEnabled(workspace.id, base, next)`, `disabled={!data.canEdit}`, and the hint
  "Only owners and editors can change this." when disabled. The other two fields stay owner-only. Fix the section
  description: "Limits on how the simulation treats people's time." (i):
  - description: "Let owners and editors say that one person takes more or less time than their role's normal time on
    some steps. Off: everyone in a role works at the role's normal time. Each person sees only their own times; they are
    never ranked or compared across people. Members' and viewers' simulations always use the role's normal time."
  - example: "Maya has run kickoffs for years and takes about 0.8 of the normal time on Kickoff, 20% faster. Switch this
    on and set 0.8 on Kickoff in her detail under People."
- **`PersonRow`**: after Skills, before Leave, add `<CapacityFactors>` when `settings.capacity_factor_enabled === true`.
  When the switch is off and the person has stored factors, show one muted line instead: "Per-person times are off, so
  these aren't used." Show no values. When it is off and they have none, show nothing.
- **`CapacityFactors`** (new, in the same file or `capacity-factors-field.tsx` beside it): a `<fieldset>` with the legend
  "Time on each step" and an (i):
  - description: "How long this person takes compared with their role's normal time. 1 is normal, 0.8 is 20% faster,
    1.25 is 25% slower; from 0.5 to 2. Blank uses their time for every step, or the normal time. The simulation
    multiplies the hands-on time they spend on the step by this. Only owners and editors set it; the person sees their own."
  - example: "Every step 1, Kickoff 0.8: Maya's kickoffs take 20% less time than the role's normal; everything else
    takes the normal time."
  - The first `NumberField` is "Every step" (the default): optional, `min 0.5`, `max 2`, `step 0.05`, placeholder
    "1 (normal)", with an (i): "This person's time on every step they do, unless a step below says otherwise." /
    "0.9: about 10% faster on everything."
  - Then one optional `NumberField` per step the person can do, in `data.steps` order (never sorted by value). The steps
    they can do are their `person_skills` steps if they have any, otherwise the steps whose `role_id` is one of their
    roles. Label: the step name, with the role as sublabel if the field supports it. Placeholder: "Same as every step"
    when a default is set, else "1 (normal)". Give each field an (i): "<step>: this person's time on this step compared
    with the role's normal time." / "0.8: 20% faster on <step>."
  - Then "Not used now": stored rows whose `step_id` isn't among those steps (a role or skill changed, the step left the
    live process). List the step name, or "A step no longer in a live process", with its value and a **Remove** button
    that saves `null`. Give the heading an (i).
  - Each field's saver is `savePersonCapacityFactor(p.id, stepId, base, next)`. Every field shows a muted
    "20% faster" / "25% slower" / "normal time" after the value, from one pure helper (`factorWords` below).
  - `disabled` follows `!data.canEdit`. A member opening their own row sees their factors read-only.
  - Don't add factors to the `<summary>` line. The collapsed list must not put factors side by side.

`apps/web/src/lib/people.ts`:
- `export function factorWords(f: number): string`: `"normal time"` at 1, `"N% faster"` below, `"N% slower"` above, with
  N = `Math.round(Math.abs(1 − f) × 100)`.
- `export interface ShownFactor { stepId: string | null; stepName: string; factor: number; measuredItems: number; entered: boolean }`.
- `export function personFactors(bundle: ProcessBundle, personId: string, stepNames: Map<string, string>): ShownFactor[]`.
  It uses the person's rows from `bundle.personCapacityFactors`, keeps the default (named "Every step") and the steps in
  `stepNames`, and sorts them with the default first, then in the process's step order (the order of `stepNames`),
  **never by value**. Set `entered = source !== "measured"` and `measuredItems = 0` (nothing is measured yet).
- Update `capacityFactorsShown`'s doc comment (no longer "nothing stores a factor yet").

---

## Part 5: People page

`components/people-page.tsx` `PersonDetailBlock`:
- `const factors = capacityFactorsShown(bundle.workspace.settings, personFactors(bundle, person.id, stepNames))`, with
  `stepNames` built from `bundle.steps` and `bundle.otherProcesses?.flatMap(o => o.steps)` in that order.
- When non-empty, render `<div data-capacity-factors>` with the label "Time on each step" and the same (i) text as
  Settings. Below it, one line per factor: "Every step: 0.9 × normal (10% faster)", "Kickoff: 0.8 × normal (20% faster)".
- The detail only opens for rows the viewer may see (`ownRowsOnly` already filters the table), and the bundle holds only
  the viewer's own factors for a member. Both guards stay.
- **No factor in the How busy table, the absence card, the team card or anywhere outside one person's detail.**
- When `speedsNormalisedFor(bundle)` is true (a member, switch on), show one muted line under the How busy card's heading:
  "Per-person times are on in this workspace. Your numbers use each role's normal time, so they can differ a little from
  what owners and editors see." Give it an (i) that says why: "Each person's times are visible only to them and to owners
  and editors." Put the same line on the Forecast page (`components/forecast/…`, where the forecast's figures start).
  Nowhere else.

---

## Edge cases

- **A factor on a step the person can't do** (not in their roles or skills, or the step left the live process): stored,
  never used. `toEngineModel` drops ids outside the model's steps, and the engine only reads a factor when that person
  serves that step. Settings lists it under "Not used now" with Remove. The People page doesn't show it.
- **A step pinned to the person** (`steps.person_id`) with no role: Settings doesn't list it (its steps query needs a
  role). The person's "Every step" default still applies to it in the engine. Mention it in the PR; don't widen the query.
- **A person on leave**: no new work starts during leave (unchanged). The factor applies to whatever they do work on.
  Leave markers in a B7 plan add leave and don't touch factors.
- **Inactive person, or past their end date**: not in the model, so their factors are unused. The rows are kept. Deleting
  the person cascades.
- **Switch off with factors stored**: nothing is shown and the engine ignores them. Switching back on brings them back
  unchanged. Switching off never deletes.
- **The forecast** (`planned: true`): factors apply to every real person, including one whose start date is later. B7
  plan **hires** are synthetic people with no factor, so they get 1.0. A **compared plan** uses the same factors in both
  runs.
- **Scenarios and levers**: a lever on a step's work hours scales the role's normal time, and the factor multiplies the
  result. Scenario hires get 1.0. The `@busiest` / `@heaviest` selectors use role-level estimates without factors
  (documented, unchanged).
- **Robustness**: factors are entered values and aren't perturbed. Spreads must keep `capacityFactor` (test).
- **Absence test**: the same model, so it uses the factors for editors and none for members.
- **Members and viewers**: their simulations use normal times for everyone, including themselves, with the note. Their
  bundle holds only their own factor rows, which they see in their People detail and their Settings row. A member
  linked to nobody gets `[]`. A member's dev tools show their own factors and nobody else's (unlike hours and leave,
  which B1 accepted). Saved runs are editor-only (`can_see_people`), so a member never reads a factored run.
- **Headline numbers** (`workspace_headlines`, read by members): an editor's browser records them from a factored run.
  They are workspace aggregates (flow efficiency, counts) and can't isolate one person's factor. Accept, and say so in the
  PR.
- **AI analysis and narration**: AI reads `payFreeBundle`, so no factor reaches Anthropic or the base hash. The facts
  digest comes from the page's run, so with the switch on, an analysis saved from an editor's page may show "out of
  date" to a member and the reverse (Q4).
- **Share links (B3) and play links (B4)**: snapshot bundles come through `share_team_capacity` (no factors) and
  `redactShareSnapshot` (empties the list), and Postgres refuses any factor key. A visitor's numbers use everyone's
  normal time, whatever the People toggle (Q3). B4 inherits this: its brief should say so.
- **MCP**: no new tool. `needs_review` refuses an API token writing the table, including through
  `save_capacity_factor`. `set_company` can still *suggest* `capacity_factor_enabled` (an existing allow-list entry), and
  an owner approves it as before. MCP simulations run as the token's user, so an editor's token simulates with factors.
  MCP outputs per-person utilisation (existing) but never a factor. The token's `get_workspace_summary` people list is
  unchanged.
- **Restore (B10/B21)**: the export holds the rows (editors only, through RLS). The restore leaves them out, with the
  left-out line and, when they were switched on, the warning (Q2). The switch itself is restored.
- **Change log**: managers see "Maya: a per-person time set" entries. Audit diffs hold the number. Only owners and agency
  admins read `audit_log`.
- **Two editors, same field**: compare-and-set gives the second a conflict with the stored value (the field controller
  already handles `conflict`). Two inserts racing on an empty row: the loser gets `conflict`.
- **0.5 / 2.0 bounds, and 1.0**: inclusive. A typed 1 is stored and is harmless (`toEngineModel` drops it). Blank deletes
  the row.

---

## Tests

**Database** (`packages/db/test/capacity-factors.test.ts`, the `createTestDb` harness, Northbeam people):
1. The table: the check refuses 0.49, 2.01 and 0. A second default or a second row for the same step → 23505. A person
   delete cascades.
2. `save_capacity_factor`, as an editor: insert (default, then step), update, a stale base gives `conflict` with
   `theirs`, null deletes, a value out of range gives 23514, a step from another workspace gives 22023, and an unknown
   person gives `not_found`. Provenance gets `factor.source = 'entered'`. An audit row is written.
3. Refused: a member, a viewer and a non-member get `not_found` and nothing changes. An API-token caller (the
   `api_token_id` claim, as `mcp-audit.test.ts` does) gets 42501.
4. `save_capacity_factor_switch`: an editor and an owner save true. A member gets `not_found`. A key other than
   `capacity_factor_enabled` gives 42501. `"yes"` gives 23514. Base `false` against absent saves (null = false). A stale
   base gives `conflict`. Provenance `settings.capacity_factor_enabled` is stamped.
5. **`team_capacity` privacy matrix** (extend `team-capacity.test.ts`). Rows for Jess (the member's own person) and two
   others, one default and one step each:
   - an editor and an agency admin get all of them;
   - the member gets only Jess's;
   - a member linked to nobody and a viewer linked to someone else get only their own or `[]`;
   - no item has `provenance` or `created_by`.
   Everything else in the function's output equals the pre-C6 output: compare against the rolled-back old body, or
   snapshot the other keys.
6. **Role matrix** (`role-matrix.test.ts`): add `person_capacity_factors` to `TABLES` with `reads: "per-person"`,
   insert/update/delete cases against `person.spare`, and a seeded row per role's linked person (as `person_skills` at
   L379). Add `save_capacity_factor` and `save_capacity_factor_switch` to `RPCS` with refusal `{ status: "not_found" }`.
7. **Share links**: as an editor, a link insert whose snapshot has `personCapacityFactors: [{…}]` → refused with the new
   message. A `capacityFactor` key nested in `live.people…` → refused. `personCapacityFactors: []` → accepted.
   `share_team_capacity` output has no `person_capacity_factors` key. Add these to `share-links.test.ts`.
8. **Header rollback**: run `headerRollback("20261223000000_capacity_factors.sql")` in a rolled-back transaction after
   the migration. Afterwards the table and functions are gone and `team_capacity` has no `person_capacity_factors` key.
   Precedent: other `*.test.ts` using `header-rollback.ts`.
9. **`toEngineModel`** (`model.test.ts`):
   - switch off → no `capacityFactor` on anyone;
   - switch on and an editor viewer → default and steps as stored, with 1s dropped and steps outside the model dropped;
   - viewer `seesEveryone: false` → none;
   - `payFreeBundle` (copy its one line into the test) → none;
   - `analysisBaseHash`-style equality: changing a factor doesn't change `toEngineModel(neutralBundle(b))`.
10. **Share snapshot** (`share-snapshot.test.ts`): a raw snapshot built from an editor's bundle that carries factors comes
    out of `redactShareSnapshot` with `[]`. `shareSnapshotLeaks` reports a non-empty list.
11. **Bundles**: `workspace-bundle.test.ts` exports the rows. `workspace-import-plan.test.ts`: a bundle with factors
    checks clean, the plan has no factor section, `leftOut` has the line, and the warning appears only with the switch on.

**Engine** (`packages/engine/test/capacity-factor.test.ts`):
1. `capacityFactor: { default: 1 }`, and `{ steps: { x: 1 } }`, give a result **byte-identical** (`JSON.stringify`) to no
   factor.
2. A one-step, one-person, constant-time model at low load: factor 0.5 halves the person's busy hours and the step's
   `avgHandsOn`. Arrivals are identical (same streams).
3. A step factor beats the default.
4. A factor on a step the person can't do changes nothing (byte-identical).
5. Factors survive `absenceTest` and `robustness` (results differ from no-factor runs in the expected direction; no
   throw).
6. 0, −1, NaN and Infinity throw with the person's name.
7. Monotone: at the same seed, a person's utilisation with 0.8 ≤ with 1 ≤ with 1.25 on their busiest step (fixed seed,
   moderate load, so it's deterministic).
8. Goldens: unchanged. The ledger gains 1.10.0 with 1.9.0's digest.

**App unit** (`apps/web/test/people.test.ts`):
- `factorWords` (0.8, 1, 1.25, 0.5, 2).
- `personFactors`: default first, then step order, never by value; it drops unknown steps.
- `capacityFactorsShown` with real rows (entered → shown when on).
- `speedsNormalisedFor`.
- The existing `capacityFactorsShown` tests stay.

**Source tests**:
- `person-privacy-source.test.ts`: the People page still filters with `ownRowsOnly` at least twice.
- New, in the same style: no file under `apps/web/src` sorts by `factor` (`/sort\([^)]*factor/` doesn't match), and
  `people-page.tsx` doesn't read `personCapacityFactors` outside `PersonDetailBlock`.

**Browser** (Chromium, as `people-browser.test.ts`; extend `people-harness/entry.tsx`'s `mountPeople` with
`factors?: PersonCapacityFactorRow[]`):
- **Replace** "shows no capacity factor anywhere, even with the setting on (C6 is parked)" with:
  - switch **off** plus factors: no "Time on each step" text anywhere, no `[data-capacity-factors]`;
  - switch **on**, viewer everyone: open a person with factors → "Every step: 0.9 × normal (10% faster)" and the step
    line; open a person without → nothing; the How busy table's header and cells contain no "×" or "faster";
  - switch **on**, viewer own (member): the harness gives only their own rows. Their detail shows them, the member note
    is visible, and the page text contains no other person's factor value. Seed a distinctive 1.35 for someone else and
    assert it never appears.
  - Every case: no console errors.
- **Settings** (new harness or an existing Settings browser test; ask if none exists): an editor sees the toggle enabled,
  and the factor fields after the switch is on. A member's own row shows read-only fields. An owner sees the floor and
  cap enabled and an editor sees them disabled (unchanged).
- **Share**: in the existing share browser/harness test, a snapshot from a bundle with factors renders and the page text
  contains no "× normal".
- Screenshots per builder-brief: Settings → Simulation and a person's detail, and People with a detail open, light and
  dark, 1440 and 400 px. If the `visual` job fails because of the People/Settings stories, push `[visual-update]`.

**Perf**: the `perf` tests above pass, with times in the PR.

---

## Patterns to copy

| What | Copy from |
|---|---|
| Editor-writable settings key | `public.save_health_rules` (`20261209000000_agency_list.sql`) and `saveHealthRule` (`lib/fields/server.ts` L96) |
| Per-person RLS | `"read person_skills"` (`20261207500000_per_person_privacy.sql` L144) |
| Company triggers | `20261015000000_suggestions.sql` L77 (`stamp_provenance`), L300–312 |
| Migration header, preflight, post-apply, rollback | `20261209000000_agency_list.sql` and `20261220000000_share_links.sql` |
| Compare-and-set returning status | `save_fields` (`20261111000000`) and `saveOrInsert` (`settings/actions.ts` L377) |
| Settings field with (i) | `people-settings.tsx` `NumberField` usages |
| Gate and own-row display | `capacityFactorsShown`, `ownRowsOnly`, `people-browser.test.ts` |
| `--bump` with no numbers moving | B1 1.7.0, B7 1.9.0 (`golden/versions.json`) |
| Share leak test | `share-links.test.ts`, `share-snapshot.test.ts` |
| Role matrix additions | `role-matrix.test.ts` `person_skills` entry |

---

## Out of scope

- **Calibration proposing factors** from a step log that names people (≥ 10 items per person-step, PRD §6.3.7). That is
  a follow-up for C2's step log once it has a person column. Open it as a ticket and mention it in the PR.
  `measuredItems` stays 0.
- Restoring factors from a backup (Q2's follow-up: add a section to `import_workspace_bundle`).
- Factors on fallback ongoing load (hours per client by role) or servicing task hours outside steps. Only step hands-on
  time is affected. Servicing **process** steps are steps, so they are affected.
- Recording factors in a saved run's `params_snapshot` (the switch is already recorded through `COMPANY_FIELDS`).
- Any ranking, comparison, team average or role-median view of factors. **Never.**
- An MCP tool to read or set factors. A process-file (`transpera-process/2`) field for them. C1 CSV import of them.
- Showing factors on the canvas, Overview, insights or issues.
- `person_skills.efficiency`: leave it (unused; dropping it isn't additive).
- Using `NULLS NOT DISTINCT`, redefining `save_fields`, `share_team_capacity`, `share_snapshot_problem` or
  `import_workspace_bundle`.

## Done when

- [ ] Migration `20261223000000_capacity_factors.sql` with header (what, order, preflight, post-apply, full rollback
      including `team_capacity`'s old body). The apply file exists, bootstrap is regenerated, types are hand-edited, the
      `production-migrations.md` row is added, and `gen:seed` shows no diff.
- [ ] Owners and editors switch Per-person times in Settings → Simulation, with an (i). Members and viewers can't.
- [ ] Owners and editors set "Every step" and per-step factors (0.5–2) in Settings → People → a person, each with an (i).
      Stale ones are listed under "Not used now" with Remove.
- [ ] The engine multiplies hands-on time by the factor. ENGINE 1.10.0 via `--bump`, goldens unchanged, browser
      determinism and perf tests green, and perf times in the PR.
- [ ] `team_capacity` returns factors only to those who see everyone, and the member's own factors otherwise. Role
      matrix and privacy tests are green. A member's simulation uses normal times and shows the note.
- [ ] The People page detail shows the viewer-visible factors through `capacityFactorsShown`, with nothing outside the
      detail and no ordering by value. The browser tests are rewritten as above.
- [ ] Share links never carry factors (TS redaction, the leak check and the Postgres trigger, each tested).
- [ ] The export carries factor rows. The restore lists them as left out and warns when the switch was on.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build` are green locally (known ICU
      failures aside), screenshots are described in the PR, and the follow-up ticket for calibration is opened.
- [ ] Docs:
  - PRD §6.3.7: a short "Built in C6 (#198)" note naming the table, the switch, members' normal times and share links.
  - `CONTEXT.md`: a "Per-person time (capacity factor)" entry, if `CONTEXT.md` has a glossary.
  - This brief's open questions copied to the PR as "Defaults taken".

---

## Open questions (each with the default the builder uses)

**Q1. What do members and viewers simulate with?** Running everyone's factors in a member's browser means sending them
there, so they could read them in dev tools. That breaks "visible to the person" (D20). It also differs from B1, which
accepted anonymous hours and leave in dev tools. **Default (Claude's, for Austin to confirm): members' and viewers'
simulations use every role's normal time, including for themselves, with a one-line note on People and Forecast.** This
departs from B1's "everything else matches what an editor sees" only when the switch is on. The alternative is to send
anonymised factors (by "Team member N") to members and accept the dev-tools exposure.

**Q2. Restoring a backup.** Restoring factors means a new section in `import_workspace_bundle`: a full copy of a
400-line SECURITY DEFINER function. **Default: the export keeps them, the restore leaves them out and says so (and warns
when the switch was on). This is an exception to #39's "results match", for workspaces using factors. Follow-up ticket to
restore them.**

**Q3. Share links with People on.** PRD §9 says "individual capacity factors" with People on. Under D20 a link visitor is
neither the person nor an owner or editor. **Default: never in any link; a visitor's numbers use normal times.** This
matches the "no pay ever" call for B3.

**Q4. AI analysis staleness.** With the switch on, an analysis saved from an editor's page reads facts from a factored
run, so a member may see it as "out of date" (and the reverse). **Default: accept it. AI never reads factors (it
reads the member-shaped model), and the base hash doesn't move when a factor does.**

**Q5. Name on screen.** **Default: "Per-person times"**, with each value shown as "0.8 × normal (20% faster)". The
change-log label changes from "Capacity factors" to "Per-person times". "Capacity factor" stays in code and the PRD.

**Q6. Range and precision.** **Default: 0.5 to 2.0 inclusive, entered in steps of 0.05, stored to 2 decimals.**

**Q7. Who switches it.** Every other simulation setting is owner-only (`save_fields('workspaces')`). **Default: owners
and editors (as instructed), through a dedicated function that can write only this key.** The floor and cap stay
owner-only.

**Q8. Which steps a factor can be set on.** **Default: the steps the person can do (skills, else their roles' steps) in
live processes, plus "Every step". Pinned role-less steps take the default only.**
