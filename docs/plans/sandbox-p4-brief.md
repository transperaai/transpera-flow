# Sandbox phase 4: time and what it achieves (build brief)

Opus brief, 28 Oct 2026. Source: `docs/plans/sandbox-design.md` §G "Time and what it achieves" (Austin, 28 Oct; the default
categories are accepted for now) and build order phase 4. Built on `claude/supabase-migration-plan-mzchlf` **after phase 3**
(churn drivers as chances, client value ranges, price rise, monthly channels: its own brief, written at the same time). Assume
phase 3's engine changes are in. Phase 4's engine change is small and separate: one optional step field and one monthly output
that only adds up hours already counted. **No existing simulated number may move.** Read `CLAUDE.md`, `apps/web/AGENTS.md`,
`docs/engine-versioning.md`, `docs/research/first-principles.md` (Part B, field 4) and the phase 1 and 2 briefs first.

**Phase 4 in one line:** each step gets a purpose (one of the workspace's categories); the engine reports hands-on hours per
purpose, rework hours, client hours, idle hours and the hours available, per role, per person and per month; the Sandbox (and
its compare) and the Overview show where working time goes, as hours and as % of the whole capacity.

## What exists today (verified)

- **Steps** (`public.steps`, `StepRow` in `packages/db/src/types.ts`) belong to a revision; ids are stable across revisions.
  `open_draft` copies every column of the live steps into the draft (`jsonb_populate_record`, so a new column comes along) and
  `private.revision_changes` (20261006000000_drafts.sql) diffs every column except bookkeeping ones, so a purpose change is a draft
  change to publish. Published and superseded steps are fixed for signed-in users (`public.edit_drafts_only`); owner-run
  migrations pass it. Steps also carry `set_updated_at`, `flag_conflicts`, `audit_mcp` and other triggers.
- **`save_fields`** (last redefined in 20261111000000_client_groups.sql) already edits `steps` and `workspaces` column by column,
  and one key of a jsonb column (`settings.<key>`), with compare-and-set on `base`. A new `steps` column needs no change to it.
- **Process kinds** are `pipeline` and `servicing` (check in 20260929000000_init.sql; labels "Sales pipeline" and "Client work",
  `PROCESS_KIND_LABELS` in `apps/web/src/lib/processes/admin.ts`). A pipeline can hold delivery steps between the sale decision
  and its Won end (Larkspur: `onboard` → `workshop`, `content_plan`, `web_design`, `web_build` → `launch` → `won`).
- **First principles** (`public.first_principles`, 20261119000000_first_principles.sql) are one row per revision; a revision with
  no row inherits the nearest earlier one (`resolveFirstPrinciples`, `loadFirstPrinciplesFor` in
  `packages/db/src/first-principles.ts`). `deletes` is `[{step_id, breaks_if_removed, agreed_by, added_back}]`
  (`FpDeleteCandidate`, `packages/engine/src/first-principles.ts`); `added_back: true` means "tried, put back". The Delete card is
  in `apps/web/src/components/first-principles/step-bodies.tsx`. `ProcessBundle` carries no first principles.
- **Engine work accounting** (`packages/engine/src/simulate.ts`, `runOnce`):
  - `startService` draws `handsOn` (× the person's `capacityFactor`; after phase 3, × the step-work channel too), and when
    `mon` is set spreads it into `mon.personWork[p.idx]` and, when the step's role is a model role (`st.acc`), `mon.roleWork[acc.r]`
    over [t, t + dur], clipped to [0, H] by `spread`.
  - **Rework** is the engine's repeat passes: `repeatLoop(st.loops, st.loopSlots, e.lp)` (same-step redos and back-edges,
    `packages/engine/src/loops.ts`). Today it is summed whole, at the pass's start, only when `t >= 0`, into `L.roleHours` and
    `reworkRoles` (→ `ReplicationResult.rework.roleHours`, `SimulationResult.rework`), by `st.s.role ?? p.person.roles[0]`, never
    per month or per person.
  - Ongoing (fallback) client hours are not steps: `monthlyOngoing` adds `p.load` to `personWork`/`roleWork`; hours falling in
    someone's leave go to their role's others in `monthlyOut`. `roleUncovered` is work nobody of the role was there to do.
  - `MonthlyReplication.personCapacity`/`roleCapacity` are hours available (capacity less leave, before `from`, after `until`);
    `personOvertime`/`roleOvertime` are overtime hours. `MonthBusy` (`monthlyResult`, `busyRows`) is work ÷ (available +
    overtime), in hours **a week**.
- **Golden harness** (`packages/engine/test/golden.ts`): models take `options?: SimulateOptions`; `keyOutputs` adds
  `monthlyMeans` for monthly models (`northbeam-money` is the only one). `ENGINE_VERSION` is 1.11.0; phase 3 bumps it.
- **`toEngineModel`** (`packages/db/src/model.ts`) builds `EngineStep`s in `resolveGraph` (pipeline, held child processes) and
  `engineServicing` (servicing processes), then `flattenModel` (keeps unknown step fields: `{ ...rest, next }`). `ModelOptions` has
  `startDate` and `planned`. `applyPatches` mutates steps in place, so a step field survives patches.
- **Where runs are monthly:** the Sandbox (`useSimulation(built.model, 30, 1, { monthly: true, monthStarts })` in
  `components/sandbox/sandbox-view.tsx`, segments through `sharedSimPool()`, `spliceMonthly`), the Overview's `horizonSim`
  (`components/overview/overview.tsx`, already monthly, feeding "Time split by process" and team load) and the People page's
  `ForecastPanel`. The process page (`components/process-page.tsx`, `useSimulation(model)`) and the editor are not monthly.
- **People page:** "How busy" (whole-run share per person, P90; `ownRowsOnly` gives a Viewer only their own row) and
  `ForecastPanel` (month by month). There is no per-person "what the time is spent on" view.
- **Settings:** one page (`app/w/[slug]/settings/page.tsx`) with sections, plus sub-pages Branding, Levers, Historical data,
  Change log. **There is no Settings → Processes.** The process admin page is `/w/[slug]/processes` (rename, kind, archive).
- **Viewers:** `team_capacity` labels other people "Team member N"; the app then shows "A team member" for anyone the viewer may
  not see (`namedForViewer`, `ownRowsOnly`, `apps/web/src/lib/viewer.ts`; Austin, 6 Oct). The Sandbox uses `namedForViewer`.
- **Share snapshots** are default-deny on strings: every string under a key not in `SHARE_NON_TEXT_REASONS`
  (`packages/db/src/share.ts`) is free text, and `share-field-classes.test.ts` fails on an unclassified string column. The SQL
  twin is `non_text_keys` in `private.share_snapshot_problem` (last re-created in 20270104000000_strip_followups.sql).
- **Restores:** `IMPORT_COLUMNS.steps` (`packages/db/src/workspace-import.ts`) and the `allow` list in
  `public.import_workspace_bundle` (last re-created in 20270109000000_sandbox_scenarios.sql) must list every restored column.
- **MCP:** `get_process` returns `bundle.steps` (`selectAll`, so a new column appears raw); `get_workspace_summary` returns
  `ws.settings` whole (`packages/mcp/src/tools.ts`).

## Where phase 3 and phase 4 meet

Phase 3 merges first. Phase 4 rebases on it and adapts; it never hand-merges baselines.

| Seam | Phase 3 | Phase 4 |
|---|---|---|
| `simulate.ts` `startService` | Step-work channel multiplies the drawn hands-on time | Books the purpose and rework hours from the **final** `handsOn` (after the factor and the channel), in the existing `if (mon)` block. Moves the `repeatLoop` call out of the `t >= 0` guard (pure; no number moves) |
| `simulate.ts` `mon` block, `monthlyOut`, `monthlyResult` | New monthly series (churn by driver, price rise) | Adds four arrays and the `time` block. Rebase: keep both sets of fields |
| `simulate.ts` capacity | Hours channel changes hours available per month | Reads `personCapacity`/`roleCapacity` as `monthlyOut` returns them, so the channel flows through untouched |
| `model.ts` `EngineStep`, `MonthlyReplication`, `MonthlyResult` | Its new fields | `EngineStep.purpose`, the four replication fields, `MonthlyResult.time`, `TimeSplit` |
| `test/golden.ts`, `golden/*.json`, `versions.json`, `version.ts` | Bumps to its minor (1.12.0 expected) | Adds `larkspur-time` and the `time` keys for it only; approves the next minor after phase 3's. Re-run `golden:approve` after rebasing |
| `apps/web/src/lib/forecast/splice.ts` | Its new series | `time` as flows |
| `lib/sandbox/compare.ts`, `sandbox-compare.tsx`, `sandbox-view.tsx`, `lib/forecast/help.ts` | Price-rise trade-off and churn views | A "Where the time goes" section |
| Migrations | Its files, after 20270111000000_sandbox_fix.sql | One file, **after the last phase 3 migration** |
| `private.share_snapshot_problem`, `public.import_workspace_bundle` | Re-creates them only if it adds a column or key | Copies the **latest** body (phase 3's if it re-created one), adds its one item |
| `docs/engine-versioning.md` | Its section | A new section after phase 3's |

## 1. Data (`packages/db`)

### 1.1 `steps.purpose`: a column, null meaning Automatic

A **nullable text column** on `public.steps`, not a key in `provenance` or another jsonb: it is a plain property of a step, edited
like `tool`, diffed by `revision_changes`, copied by `open_draft`, restored, and read by MCP. `null` means **Automatic**: the
purpose is worked out each time by one pure function, `resolvePurpose` (§1.3). A key the workspace list no longer has is read as
Automatic too.

**Why Automatic and not a backfill (recommended; open question 1).** Writing a value into every existing step would rewrite
history rows (published and superseded revisions), fire `set_updated_at` on every step (moving `updated_at` under open
editors), and leave every later creation path (editor, blocks, process files, imports, the company map, solutions) to set a
default itself. With Automatic, nothing is written, every path is covered, and a step added to a process's delete list in First
principles becomes "Could be removed" at once, as the design asks ("a step marked delete defaults to Could be removed"). A chosen
purpose always wins.

Allowed values: the six default keys or `c` + 8 lower-case hex (a category the workspace added, §1.2). Never words someone
typed, so it is classified non-text for share snapshots.

### 1.2 The workspace's category list: `workspaces.settings.purposes`

A key of `workspaces.settings` (not a new table): it is a short list, edited whole by an Agency admin, saved through
`save_fields` with compare-and-set on the whole list (`settings.purposes`, `base` = the list as loaded), merged by a restore
(`settings || …`), and absent for every workspace today, which **means the defaults** (no backfill).

```ts
// packages/db/src/purposes.ts (new; exported from index.ts)
export interface PurposeCategory { key: string; name: string; description: string }
export const PURPOSE_KEY = /^(client_job|required|winning|coordination|fixing|removable|c[0-9a-f]{8})$/;
/** Can be renamed, described and moved; never deleted: the Automatic rules, rework and client hours need them. */
export const FIXED_PURPOSES = ["client_job", "winning", "fixing", "removable"] as const;
export const DEFAULT_PURPOSES: readonly PurposeCategory[] = [
  { key: "client_job",   name: "Moves the client's job forward", description: "The work the client pays for." },
  { key: "required",     name: "Required",                       description: "Compliance and admin that must be done." },
  { key: "winning",      name: "Winning work",                   description: "Sales and onboarding." },
  { key: "coordination", name: "Coordination",                   description: "Hand-offs, meetings and chasing." },
  { key: "fixing",       name: "Fixing",                         description: "Rework and corrections." },
  { key: "removable",    name: "Could be removed",               description: "Steps the first principles mark to delete." },
];
export const MAX_PURPOSES = 12;
/** The stored list, or the defaults when absent, null or (defensively) invalid. */
export function workspacePurposes(settings: WorkspaceSettings): PurposeCategory[];
/** The save's check, mirroring private.is_purpose_list exactly (one table of cases runs through both). */
export function parsePurposes(input: unknown): { ok: true; purposes: PurposeCategory[] } | { ok: false; error: string };
export function newPurposeKey(): string; // "c" + 8 hex from crypto.getRandomValues, re-drawn on a clash
```

Shape: an array of 4 to 12 objects `{key, name, description}` and nothing else; keys match `PURPOSE_KEY` and are unique; names
are 1–60 characters after trimming and unique ignoring case and surrounding spaces; descriptions 0–200 characters; the four
`FIXED_PURPOSES` keys are present. `WorkspaceSettings` (`src/types.ts`) gains `purposes?: PurposeCategory[] | null`.

- **Rename:** changes `name` (and `description`); the key stays, so every step follows.
- **Reorder:** array order is the display and stacking order everywhere. Idle and uncovered always come last and are not
  categories.
- **Add:** a new key from `newPurposeKey()`; up to 12.
- **Delete** (`required`, `coordination` and added ones only): the key leaves the list. Steps that chose it are **not
  rewritten** (published steps can't be, and a draft rewrite would be a silent edit); they read as Automatic, and the inspector
  says "Its category was deleted: Automatic is used. Pick another." The delete confirm counts the steps (live and draft) that chose
  it, from a read of `steps.purpose` in the workspace.
- `WorkspaceSettings.purposes` is not pay and not people: everyone in the workspace reads it.

### 1.3 Resolving a step's purpose

```ts
export type PurposeSource = "chosen" | "first_principles" | "process_kind" | "deleted_category";
export function resolvePurpose(
  step: Pick<StepRow, "id" | "purpose">,
  processKind: string,                    // the step's own process ("pipeline" | "servicing")
  deleteCandidates: ReadonlySet<string>,  // its process's FP delete step ids, added_back excluded
  keys: ReadonlySet<string>,              // the workspace list's keys
): { key: string; source: PurposeSource };
```

1. `step.purpose` is in `keys` → it (`chosen`).
2. The step is in its process's first-principles `deletes` with `added_back` false → `removable` (`first_principles`).
3. Its process is `servicing` → `client_job`; otherwise (`pipeline`) → `winning` (`process_kind`). (`deleted_category` instead
   of `process_kind`/`first_principles` when step 1 failed on a stored key that is no longer listed.)

Rule 3 follows the design's own words ("Winning work: sales and onboarding"; client work is what the client pays for) and the
orchestration ask. Delivery drawn inside a pipeline (Larkspur's website build) therefore starts as Winning work until someone sets
it; open question 2 asks Austin whether post-sale pipeline steps should default to "Moves the client's job forward" instead (that
needs the engine's sale-side reach: `outcomeReach` in `simulate.ts`, exported through a pure helper; no number moves).

**Delete candidates in the bundle.** `ProcessBundle` gains `deleteCandidates?: Record<string, string[]>` (process id → step ids,
`added_back` excluded), filled by a new `loadDeleteCandidates(db, parts: { processId: string; revisionId: string }[])` in
`packages/db/src/first-principles.ts` (one read of `first_principles` and `process_revisions` for those processes, then
`resolveFirstPrinciples` per revision, so inheritance holds). It is **not** loaded by `loadProcessBundle` (share links and MCP
runs stay as they are); callers that show purposes add it: `{ ...bundle, deleteCandidates }`. A bundle without it skips rule 2.

**Into the engine model.** `ModelOptions.purposes?: boolean`. When true, `toEngineModel` sets `purpose` on every working
`EngineStep` before `flattenModel`, looking each step up in `bundle.steps` and every `otherProcesses[].steps` (its row, so its
`process_id`) and that part's `process.kind`. When false or omitted the model is **exactly today's** (so `larkspur.test.ts`,
`database.test.ts`, the MCP runs and every saved-run comparison are untouched). Purpose never changes a number (§2), so passing it
is safe wherever a monthly run is drawn: `forecastModel` (`lib/forecast/forecast.ts`), `scenarioModel` (`lib/sandbox/run.ts`,
the `toEngineModel(bundle, { startDate, planned: true })` call) and the Overview's model (`overview.tsx`, the `toEngineModel(bundle)`
that feeds `horizonModel`). `runKey` is the model's JSON, so a changed purpose re-runs (cheap) and never serves a stale split.

### 1.4 Migration `packages/db/migrations/<after the last phase 3 migration>_step_purpose.sql`

Timestamp after the last phase 3 migration (the newest today is 20270111000000_sandbox_fix.sql). Runs on real data (the
production copy imported at 20261231000000, then every later migration). Header comment as the strip migrations: what, why,
preflight, rollback. **It writes no step row.**

```sql
select set_config('transpera.actor_kind', 'system', true);

-- 1. What each step achieves (sandbox G). Null = Automatic (resolvePurpose in packages/db/src/purposes.ts): a chosen key wins,
--    then the process's first-principles delete list, then the process kind. A nullable column with no default rewrites no row
--    and fires no trigger; open_draft copies it (every column) and revision_changes counts it as a change.
alter table public.steps add column purpose text;
alter table public.steps add constraint steps_purpose_key check (
  purpose is null or purpose ~ '^(client_job|required|winning|coordination|fixing|removable|c[0-9a-f]{8})$');
comment on column public.steps.purpose is
  'What the step achieves: a key of the workspace''s settings.purposes (null: Automatic). Sandbox phase 4.';

-- 2. The workspace's categories: settings.purposes is absent (the defaults), null (the defaults) or a valid list.
--    CASE, not AND, so nothing reads an array that isn't one.
create function private.is_purpose_list(v jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(v) <> 'array' then false
    when jsonb_array_length(v) not between 4 and 12 then false
    when exists (
      select 1 from jsonb_array_elements(v) e
      where jsonb_typeof(e) <> 'object'
         or (e - array['key', 'name', 'description']) <> '{}'::jsonb
         or coalesce(jsonb_typeof(e -> 'key'), 'null') <> 'string'
         or coalesce(jsonb_typeof(e -> 'name'), 'null') <> 'string'
         or coalesce(jsonb_typeof(e -> 'description'), 'string') <> 'string') then false
    else
      not exists (
        select 1 from jsonb_array_elements(v) e
        where (e ->> 'key') !~ '^(client_job|required|winning|coordination|fixing|removable|c[0-9a-f]{8})$'
           or char_length(btrim(e ->> 'name')) not between 1 and 60
           or char_length(coalesce(e ->> 'description', '')) > 200)
      and (select count(distinct e ->> 'key') from jsonb_array_elements(v) e) = jsonb_array_length(v)
      and (select count(distinct lower(btrim(e ->> 'name'))) from jsonb_array_elements(v) e) = jsonb_array_length(v)
      and (select count(*) from jsonb_array_elements(v) e
           where e ->> 'key' in ('client_job', 'winning', 'fixing', 'removable')) = 4
  end
$$;

-- Nothing writes the key today, but a restore merges settings wholesale: drop anything that isn't a valid list or null.
update public.workspaces w
set settings = w.settings - 'purposes'
where w.settings ? 'purposes'
  and jsonb_typeof(w.settings -> 'purposes') <> 'null'
  and not private.is_purpose_list(w.settings -> 'purposes');

alter table public.workspaces add constraint workspaces_purposes check (
  case
    when not (settings ? 'purposes') then true
    when jsonb_typeof(settings -> 'purposes') = 'null' then true
    else private.is_purpose_list(settings -> 'purposes')
  end) not valid;
alter table public.workspaces validate constraint workspaces_purposes;

-- 3. Share snapshots: `purpose` is a key, never words (the steps_purpose_key check). The latest body of
--    private.share_snapshot_problem (20270104000000_strip_followups.sql, or phase 3's if it re-created it) with 'purpose'
--    added to non_text_keys, nothing else changed.
create or replace function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
returns text language plpgsql /* the latest body verbatim, with 'purpose' in non_text_keys */ as $$ $$;

-- 4. Restores carry it: the latest body of public.import_workspace_bundle (20270109000000_sandbox_scenarios.sql, or later)
--    with "purpose" appended to the "steps" array of `allow`, nothing else changed.
create or replace function public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text default null)
returns jsonb language plpgsql /* the latest body verbatim, with "purpose" in allow.steps */ as $$ $$;
```

The two placeholders are the only non-literal SQL: the builder pastes the full latest bodies (check `proconfig`, grants and
`security` match the original with `\df+`). Rollback: drop `workspaces_purposes`, `private.is_purpose_list`,
`steps_purpose_key` and the column; re-run the two previous bodies. Then `pnpm --filter @transpera-flow/db gen:types` and
`gen:seed`. `create_workspace` needs no change (it refuses the key). `save_fields` needs no change. The check function in a
constraint is plain-Postgres behaviour to confirm on Neon (record in `docs/supabase-notes.md` if only checked locally).

**App copies kept in step:** `StepRow.purpose: string | null` (hand-written type) and every StepRow literal (`newStepRow` in
`apps/web/src/lib/editor/commands.ts`, the fixtures in `packages/db/src/fixtures/*`, process-import builders: `purpose: null`);
`IMPORT_COLUMNS.steps` gains `"purpose"`; `SHARE_NON_TEXT_REASONS.purpose = "steps.purpose: one of six fixed keys or c + 8 hex,
enforced by steps_purpose_key"`. Blocks (`BlockStep`) carry it as a step field; a block inserted into another workspace keeps a
`c…` key that list lacks, which reads as Automatic. Process files (transpera-process/2) do not carry it (out of scope).

## 2. Engine (`packages/engine`)

**Recommendation: the engine is given the mapping** (a purpose key on each step), not asked for hours per step × person.
Per step × person × month is the larger output (40 steps × 25 people × 24 months per replication, before Stats) and still
can't give a range per category without per-replication sums; per purpose it is ~8 keys, the ranges are exact, and the engine
stays blind to what the keys mean (opaque strings; rework and client hours are reported separately, never folded into a key).

### 2.1 Types (`model.ts`)

```ts
// EngineStep
/** What the step achieves (sandbox G): an opaque key the app maps to a category. Omitted: "". Reporting only: never changes the run. */
purpose?: string;

// MonthlyReplication (totals over the month, hands-on hours, spread over the time worked as personWork is)
/** First-pass hands-on hours by purpose key, then role id / person id. Repeat passes are in `rework…`, never here. */
purposeRoleWork: Record<string, Record<string, number[]>>;
purposePersonWork: Record<string, Record<string, number[]>>;
/** Hands-on hours on repeat passes (rework loops' repeat passes, as `rework.roleHours` counts them), whatever the step's purpose. */
reworkRoleWork: Record<string, number[]>;
reworkPersonWork: Record<string, number[]>;

// MonthlyResult
/** Where working time goes (sandbox G), hours in the month (not a week). */
time: {
  /** Purpose keys on the model's steps, in first-seen step order; "" when a step has none. */
  purposes: string[];
  roles: Record<string, TimeSplit>;
  people: Record<string, TimeSplit>;
  /** Everyone together: the sum over people (so no hours are counted twice for people in two roles), uncovered summed over roles. */
  team: TimeSplit;
};

export interface TimeSplit {
  purpose: Record<string, Stat[]>;  // first-pass hands-on hours per key
  rework: Stat[];                   // repeat-pass hands-on hours
  ongoing: Stat[];                  // client hours not drawn as steps: max(0, work − Σ purpose − rework)
  idle: Stat[];                     // max(0, hours − work)
  hours: Stat[];                    // hours available + overtime worked: the 100%
  uncovered: Stat[] | null;         // work nobody was there to do (roles and team); null for people
}
```

Per replication and month: `work` is `personWork`/`roleWork` (as the busy share uses), `hours` = capacity + overtime, so
Σ purpose + rework + ongoing + idle = max(hours, work). Each `Stat` is over replications (`stat`), as everything else monthly.
Export `TimeSplit` from `index.ts`.

### 2.2 Where in `simulate.ts`

| Change | Place |
|---|---|
| `purposeKeys` (first-seen order over `model.steps`, `s.purpose ?? ""`) and `StepState.pu` (its index), set where `stepStates` are built (beside `beforeSale`) | `runOnce`, step state construction |
| `mon.purposeRole` `Float64Array(nPu × nR × nM)`, `mon.purposePerson` `(nPu × nP × nM)`, `mon.reworkRole` `(nR × nM)`, `mon.reworkPerson` `(nP × nM)` | the `const mon = sampleMonthly ? {…}` block |
| `const rep = st.loops.length && e.lp ? repeatLoop(st.loops, st.loopSlots, e.lp) : null` once; the existing rework sums keep their `t >= 0` guard (`if (rep && t >= 0)`) | `startService`, replacing the inline call |
| In the existing `if (mon)`: `rep` → `spread(mon.reworkPerson, p.idx, t, t + dur, handsOn)` and, `if (acc)`, `spread(mon.reworkRole, acc.r, …)`; else `spread(mon.purposePerson, st.pu * nP + p.idx, …)` and, `if (acc)`, `spread(mon.purposeRole, st.pu * nR + acc.r, …)` | `startService` |
| Rows out by key, role id and person id (every key and id present, zeros included) | `monthlyOut` |
| `time` (per role from `roleWork`, `roleCapacity`, `roleOvertime`, `roleUncovered`; per person from `personWork`, `personCapacity`, `personOvertime`; `team` from per-replication sums over people) | `monthlyResult` |

Role attribution is the step's role (`acc`), the same as `roleWork`, so a role's split adds up to its busy share's work. A step
with no model role (pinned person, no role) counts for the person only, as today. The warm-up and a job straddling H count only
their in-window part (`spread` clips), so nothing is reset in `startMeasuring`. Rework per month therefore differs slightly from
`rework.roleHours` (counted whole at the pass's start): documented, not reconciled.

**Nothing here draws a random number, reorders an existing sum or changes an event**, so every number a golden model keeps is
unchanged, and a model with `purpose` on every step gives byte-identical results except `monthly.time` (a test, §6).

### 2.3 ENGINE version and golden

1. New fixture `larkspurWithPurposes()` in `packages/engine/src/fixtures/larkspur.ts`: `larkspurModel()` with purposes by step id
   (ids are the `larkspur-data.ts` keys): `triage`, `pitch`, `concepts`, `decision`, `onboard` → `winning`; `workshop`,
   `social_setup`, `content_plan`, `web_design`, `web_build`, `cal_social`, `cal_design`, `adhoc_design` → `client_job`; `launch`
   → `coordination`; `cal_approve` → `required`; `cal_plan` → `removable`. Larkspur has 10–30% rework, leave, a part-timer,
   overtime and servicing, so every row of `TimeSplit` is non-zero.
2. Golden model `larkspur-time` in `test/golden.ts`, `options: { monthly: true }`. `keyOutputs` adds
   `time: timeMeans(r.monthly)` **only when a model step has `purpose`**, so `northbeam-money`'s baseline is unchanged:
   `team` (means per month of every key, rework, ongoing, idle, hours, uncovered) and per role the run's Σ of monthly means.
3. `pnpm --filter @transpera-flow/engine golden:approve "Time and what it achieves (sandbox phase 4): EngineStep.purpose and MonthlyResult.time (first-pass hands-on hours by purpose, rework, client hours, idle and hours available, per role, person and team); larkspur-time golden model. No existing simulated number moved."`
   It bumps to the next minor after phase 3's. **The printed diff must be only the new model** (and `engineVersion`); anything
   else moved is a bug.
4. `browser-determinism.test.ts` picks up the new model and must pass.
5. `docs/engine-versioning.md`: a section "Time by purpose (engine 1.x.0, sandbox phase 4)" with §2.1–2.2's rules, the rework
   timing difference, the 100% definition, and the performance table (§7). Add the model to "What is locked".

## 3. App-side reading (`apps/web/src/lib/sandbox/time.ts`, pure, new)

```ts
export interface TimeRow { id: string; name: string; kind: "category" | "idle" | "uncovered"; hours: Stat[]; share: number[]; runHours: number; runShare: number }
export interface TimeView { months: TimelineMonth[]; rows: TimeRow[]; over: boolean[] /* work above hours that month */; notes: string[] }
export function timeView(
  monthly: MonthlyResult, months: TimelineMonth[], categories: readonly PurposeCategory[],
  scope: { kind: "team" } | { kind: "role"; id: string } | { kind: "person"; id: string } | { kind: "others"; except: string },
): TimeView;
```

- One row per category in list order. `fixing` = its purpose hours **+ rework** (rework always counts as Fixing).
  `client_job` = its purpose hours **+ ongoing** (open question 3). A key not in the list (a deleted category on an unpublished
  model, or `""`) goes to a row "Not set" (normally empty: §1.3 always gives a key).
- Then **Idle** and, for team and roles, **Uncovered**. `share` = mean hours ÷ mean `hours` (ratio of means, as conversion's
  mean); Σ of categories + idle is 100%; uncovered is shown beside, as "+N h nobody was there for", outside the 100%. A month where
  work exceeds hours: idle 0, the categories sum above 100%, `over[m]` true and the UI says "more work than hours: overtime capped".
- Whole run: `runHours` = Σ monthly means, `runShare` = Σ hours ÷ Σ `hours`; no range (as phase 2's profit tile). Ranges are per
  month.
- `others` (Viewer, §5): team minus their own person, month by month on the means.
- `spliceMonthly` (`lib/forecast/splice.ts`): `time` is all flows (month m from the segment holding m; keys and ids are the union,
  a missing one is a zero series; `purposes` the union in first-seen order).

## 4. UI

### 4.1 Editor: the purpose picker, one step and several

- **Step inspector** (`components/step-inspector.tsx`), for working steps (`working`), in the section with Rework, after "Tool":
  a `SelectField` "What it achieves", options = the workspace's categories in order, `noneLabel` "Automatic: <resolved name>",
  saved with `field("purpose")` (one undoable edit; `save_fields` compare-and-set as every field). Help: description "What this
  step's hands-on time achieves. The Sandbox adds up working time by these, so you can see how much goes on the client's job,
  on winning work, on fixing, and on steps that could go. Rework on any step always counts as Fixing.", example "“Send weekly
  status email” is Coordination; “Write the monthly report” moves the client's job forward." Hint under it when Automatic, by
  source: "Listed to delete in First principles", "Client work process" / "Sales pipeline process", or "Its category was
  deleted". Holders, starts and ends show nothing (no hands-on time).
- **Several at once:** with two or more steps selected, `components/editor/inspector.tsx` (the "N steps selected" note) adds the
  same select, "What they achieve" (blank when they differ). New `setStepPurposes(bundle, ids, purpose): Edit | null` in
  `lib/editor/commands.ts`: one `update` op with one `RowChange` per working step whose value differs (as `moveSteps` batches),
  label "Changed what N steps achieve", one undo. Holders in the selection are skipped and said so.
- `lib/editor/describe.ts` `fieldLabel("purpose")` = "What it achieves" and `describeValue` shows the category name (or
  "Automatic"), so the draft panel and History read well. The editor needs the categories and `deleteCandidates` on its bundle:
  load them in the process page's and editor's loaders (`lib/process-page/data.ts`, `app/w/[slug]/p/[processId]/edit/page.tsx`)
  with `loadDeleteCandidates` for the draft or live revision shown.
- **First principles, Delete card** (`step-bodies.tsx`): one line under the list: "Steps listed here count as “Could be removed”
  in the Sandbox's time split, unless a step's purpose is chosen in the editor."
- Phone: read-only, as the editor is.

### 4.2 Settings for the list

New sub-page **Settings → Purposes**, `app/w/[slug]/settings/purposes/page.tsx` (modelled on `settings/levers/page.tsx`), linked by
a "Purposes" button beside "Levers" in the Settings page's `actions`. Component `components/purposes/purposes-settings.tsx`
(mode `live` | `readonly`): the categories in order, each with name and description fields, move up/down buttons (and keyboard),
Delete (not on the four fixed; confirm names the count of steps that chose it and says they fall back to Automatic), "Add a
category" (up to 12), and "Reset to the defaults" (keeps keys still chosen by steps only if they are default keys; confirm).
Saver `savePurposes(workspaceId, base, value)` in `settings/actions.ts`, modelled on `saveOverheadMonthly`: `parsePurposes`, then
`saveField("workspaces", { id }, "settings.purposes", base, value)`; a conflict shows the stored list to keep or overwrite.
Agency admins and the Owner edit (`canManage`); Viewers see it read-only. Page help: "What the work of each step achieves. A
step's purpose is set in the editor; Automatic uses the first principles (a step listed to delete is “Could be removed”) and
then the process: sales pipelines are Winning work, client work moves the client's job forward." A "used by N steps" count per
category is a nice-to-have, not required.

### 4.3 The Sandbox

`components/sandbox/sandbox-view.tsx`, a new section **"Where the time goes"** (`components/sandbox/time-by-purpose.tsx`), after
"Month by month" and before `ForecastMoney`, for the run on screen (No changes or the open scenario, spliced):

- Scope switch: **Team** (default), **By role** (a role picker), **By person** (a person picker; §5 for Viewers).
- A 100% stacked bar per month (categories in list order, then Idle; Uncovered as a hatched cap above 100%, roles and team only),
  drawn as `TimeSplitChart` draws its stacks (`components/overview/trend-charts.tsx`, plain SVG, `niceTicks`), with the legend
  and a phone layout of one bar per row.
- A table, months as columns plus "Whole run": per row hours (mean, with the 10–90% range in the tooltip) and %. Under it the
  notes: "Rework on any step counts as Fixing.", "Client hours not drawn as steps count as Moves the client's job forward."
  (open question 3), the overtime note when `over` is set, and for a Viewer the capacity-factor note that exists today.
- A link "Change categories" to Settings → Purposes (admins) and "Set a step's purpose in the editor".
- Help text in `SANDBOX_HELP` (`lib/forecast/help.ts`), plain words (D34), with an example: "In March, 18% of the team's hours
  went on Fixing: 62 hours redoing proposals and designs."

No new lever (design §G): every process and people lever moves the split. "Removing" a Could-be-removed step is E1 (step time
set 0) or E6 (a solution that deletes it), so it is already possible.

### 4.4 Compare

`lib/sandbox/compare.ts` `compareSandbox` gains (team scope):

```ts
time: { rows: CompareRow[] /* one per category, then Idle and Uncovered: hours a month, diff vs column 0 */; shares: number[][] /* column × row, whole-run % */ };
totals.fixingHours: CompareTile; totals.removableHours: CompareTile; // Σ monthly means over the run
```

`sandbox-compare.tsx`: a section "Where the time goes" with one whole-run 100% bar per column (No changes first), then the rows
with each column's hours a month and its difference in hours and percentage points from No changes ("Fixing −14 h a month,
−3 pts"). Two tiles join the existing ones: "Hours fixing over the run" and "Hours on steps that could be removed". A column that
failed shows its error as today.

### 4.5 Process page and Overview (recommended)

- **Overview: yes.** `horizonSim` is already monthly, so the split costs no extra run. A `ChartCard` "What the time achieves"
  (team, whole horizon, the stacked bar per month) beside "Time split by process" (a different thing: hands-on against waiting;
  don't reuse the name), with a link to the Sandbox. Needs the Overview's model built with `purposes: true` and its bundle with
  `deleteCandidates` (load in `components/overview/workspace-overview.tsx` beside `loadLiveProcess`). Same for `/demo`'s Overview
  from the demo bundle (no delete candidates unless the demo FP seed has some).
- **Process page: not in phase 4.** Its run is the 13-week whole-run simulation without months; adding the split there means a
  second monthly run or a whole-run accumulator in the engine. The editor shows each step's purpose; the Sandbox and Overview
  show the split. Open question 8.
- **People page:** unchanged (it has "How busy" and the monthly `ForecastPanel`; a per-person split could later reuse
  `ForecastPanel`'s monthly run).

## 5. Privacy (B1)

The split shows hours, never pay, so `payHidden` changes nothing in it.

| | Owner, Agency admin | Viewer |
|---|---|---|
| Team, by role | yes | yes |
| By person | everyone, by name | **their own row by name, and "Everyone else"** (scope `others`); no other individual rows |
| Settings → Purposes | edit | read |
| Purpose in the editor | edit | read (the process page and editor are read-only for them as today) |

Recommended, consistent with "How busy" (`ownRowsOnly`) and Austin's 6 Oct rule (own name, "A team member" for others). Showing
each other person as "Team member N" (the labels `team_capacity` already gives) would be more useful but changes that rule: open
question 5, **for Austin**. In a one-person role, "By role" shows that person's split; the same is true of busy shares today.
Viewers' numbers use no capacity factors (`usesCapacityFactors`), as on the Sandbox today. Share links show no time split in
phase 4.

## 6. MCP (read tools)

- **`get_process`:** steps already carry the raw `purpose` (null = Automatic). Add `purpose_categories` (`workspacePurposes`) and,
  per step, `purpose_resolved: { key, name, source }` (`resolvePurpose` with `loadDeleteCandidates` for the revision returned).
  Description: "…; each step's purpose (what its hands-on time achieves) and the workspace's purpose categories."
- **`get_workspace_summary`:** add `purpose_categories` (the list, defaults when unset). `settings` already includes a stored list.
- `run_scenario` is unchanged (no monthly output). `packages/mcp/test/read-only.test.ts` must pass unchanged; snapshot tests of
  `get_process` and the summary gain the keys.

## 7. Performance

Per hands-on start: one `repeatLoop` call that was already made when `t >= 0` (now also during the warm-up, only for steps in a
loop) and two `spread` calls like the existing `personWork`/`roleWork` ones; per replication O(keys × (roles + people) × months)
in `monthlyOut` and `monthlyResult`. Only monthly runs pay anything.

- Measure before and after, same machine, alone, best of 3: `pnpm --filter @transpera-flow/engine test:perf`,
  `pnpm --filter @transpera-flow/web test:perf` (`horizon-performance.test.ts`'s monthly cases) and `sandbox-performance.test.ts`.
  **Budget: no case more than 5% slower, or 10 ms, whichever is larger.** Record both in the engine-versioning section.
- `MonthlyResult` grows by about keys × (roles + people + 1) × months × 3 numbers (Larkspur at 24 months: ~10k); check the worker
  message for the 40-step, 25-person model stays under 1 MB.
- If over budget: guard the purpose spreads on a run-level `hasPurpose` (any step with a key) and skip `purposePerson` when only
  `""` exists.

## 8. Tests

**Engine** (`packages/engine/test/`):
- New `time.test.ts`: (1) `simulate(model)` and `simulate(withPurposes(model))`, monthly, are deep-equal after deleting
  `monthly.time` (and kpis, steps, roles, people untouched) for Northbeam seeded, Larkspur and `northbeam-money`;
  (2) per person and month, Σ purpose + rework + ongoing + idle = max(hours, work) on the means, per replication exactly;
  (3) `team` = Σ people; a role's purpose + rework + ongoing = its `roleWork`; (4) a model with no loops has rework 0; a redo at
  50% gives rework ≈ first passes at that step; (5) a step with no `purpose` lands under `""`; (6) `payHidden` changes nothing in
  `time`; (7) a nested model gives the same `time` as it drawn flat; (8) patches (`applyPatches`) keep `purpose`;
  (9) rework per month ≤ `rework.roleHours` over the window, the difference only passes straddling H.
- Golden: §2.3; every existing baseline unchanged.

**DB** (`packages/db/test/`):
- New `purposes.test.ts`: `resolvePurpose` (chosen wins; delete candidate; `added_back` ignored; servicing → client_job,
  pipeline → winning; deleted key → Automatic with `deleted_category`); `workspacePurposes` (absent, null, valid, invalid);
  `parsePurposes` and `private.is_purpose_list` agree on one table of cases (3 and 13 items, a missing fixed key, duplicate key,
  duplicate name ignoring case, a 61-character name, an extra field, a `c` key with 7 hex, a non-array).
- `model.test.ts`: without `purposes` the model deep-equals today's; with it, steps of the pipeline, a held child process and a
  servicing process get the right keys; `deleteCandidates` absent skips rule 2.
- `first-principles.test.ts`: `loadDeleteCandidates` uses an inherited row and leaves out `added_back`.
- New `purpose-migration.test.ts`: build to the migration before this one (the runner's up-to option), with published, superseded
  and draft steps and workspaces whose `settings.purposes` is a valid list, `null`, `"junk"` and a list missing `fixing`; run the
  rest; expect every step's `purpose` null and `updated_at` unchanged, the valid list and null kept, the other two removed; then
  `save_fields` on `steps.purpose` refuses `"Sales"` and `"c123"` (23514), accepts `"winning"` on a draft and is refused on a
  published revision (55000); `open_draft` copies a set purpose; `revision_changes` lists the step as changed; a restore round-trips
  `purpose` and refuses a bad `settings.purposes`.
- `share-field-classes.test.ts` passes with `purpose` classified; the SQL and TS non-text lists still equal.
- `workspace-import*.test.ts`: `purpose` in the plan and restored. `json-columns.test.ts`, `function-types.test.ts` after
  `gen:types`.

**Web** (`apps/web/test/`):
- New `sandbox-time.test.ts`: `timeView` for team, role, person and `others`; rework into Fixing; ongoing into the client-job row;
  idle and uncovered; shares sum to 100% without overtime; `over` set when work exceeds hours; a renamed and a reordered list.
- `sandbox-run.test.ts`: `spliceMonthly` splices `time` as flows. `sandbox-compare.test.ts`: the time rows, shares and tiles.
- Editor: `setStepPurposes` (one edit, undo restores each step, holders skipped); `describeValue` for purpose.
- Settings action: `savePurposes` refuses an invalid list, a Viewer (42501 → message) and a stale base (conflict).
- MCP: `get_process` and `get_workspace_summary` snapshots with the new keys.
- `stories-coverage.test.ts`: stories for `time-by-purpose.tsx` and `purposes-settings.tsx`.
- Browser (`sandbox-browser.test.ts`, harness): the section shows for team, a role and a person; compare shows a bar per column;
  a Viewer sees their own row and "Everyone else" only; 1440, 640 and 400 px; no console errors. Editor browser case: set a purpose,
  set two at once, undo.

`pnpm lint && pnpm typecheck && pnpm test` green with `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres` (the
known `format.test.ts` ICU failure aside).

## 9. Docs

PRD §6.4 (outputs: time by purpose) and §13 (definitions: purpose, Automatic, hands-on hours by purpose, rework hours, client
hours, idle, uncovered, the 100%), each with a dated note "Added <date>, sandbox phase 4"; `docs/engine-versioning.md` (§2.3);
`docs/production-migrations.md` gets the row; `CONTEXT.md` gains "Purpose (of a step)" and "Automatic".

## Out of scope

A lever for purposes; per-step purpose overrides in a scenario; the process page and People page showing the split; purposes in
process files (transpera-process/2), blocks' own UI and share links; a whole-run 10–90% range (needs per-replication run sums);
classifying waits (no hands-on time); auto-detecting Coordination or Required steps; the requirements' `drop` verdict as a
source of "Could be removed"; MCP `list_scenarios`/`run_scenario` monthly output (phase 5); Austin's later category list.

## Done when

- Every existing golden value is unchanged; `larkspur-time` is approved at the next minor after phase 3's, with the ledger and
  the engine-versioning section.
- The migration runs on a fresh database and at base-then-migrate with real-shaped rows (test), and on a throwaway Neon branch of
  Preview: count steps before and after (same), confirm no `steps.updated_at` moved and the constraint holds.
- In the Sandbox, as an Agency admin, a workspace shows hours and % per category, idle and uncovered, per month and over the
  run, for the team, a role and a person; a scenario that halves rework at a step moves hours out of Fixing in compare; a step
  listed to delete in First principles shows as "Could be removed" with no edit; renaming and reordering in Settings → Purposes
  changes the labels and order everywhere without a re-run; a Viewer sees their own row and Everyone else.
- The Overview shows "What the time achieves" with no extra run.
- Performance within budget and recorded; `pnpm lint && pnpm typecheck && pnpm test` green; generated files regenerated.

## Open questions (recommended defaults)

1. **Stored backfill or Automatic.** *Default: Automatic (null), resolved by `resolvePurpose`; the migration writes no step.*
   A backfill rewrites history rows and every step's `updated_at`, needs every creation path to set a default, and goes stale when
   the delete list changes.
2. **Default for steps not listed to delete.** *Default: by process kind: sales pipeline → Winning work, client work → Moves the
   client's job forward* (the design calls onboarding Winning work). **For Austin:** should pipeline steps after the sale (delivery
   drawn inside a pipeline, as Larkspur's website build) default to "Moves the client's job forward" instead? It costs a pure
   sale-side helper, no number moves.
3. **Client hours not drawn as steps** (roles' hours per client, services' fallback load) can be a large share. *Default: counted
   as "Moves the client's job forward", with a note under the chart.* **For Austin:** or shown as their own row, "Client hours
   (not mapped)"?
4. **Leave.** *Default: the 100% is hours available (leave and before/after dates taken off) plus overtime worked;* leave is not
   a row. Alternative: contracted hours as the 100%, with a Leave row.
5. **Viewers and other people.** *Default: their own row by name and "Everyone else".* **For Austin:** each other person as
   "Team member N"? That changes the 6 Oct rule ("A team member" for everyone else).
6. **Which categories are fixed.** *Default: Moves the client's job forward, Winning work, Fixing and Could be removed can be
   renamed but not deleted;* Required, Coordination and added ones can be deleted (steps that chose one fall back to Automatic).
7. **What the engine is given.** *Default: an opaque `purpose` key per step,* hands-on hours by key × role/person × month, rework,
   ongoing, idle, hours and uncovered as `Stat`s. Not per step × person (bigger, and no exact ranges per category).
8. **Process page.** *Default: not in phase 4* (its run isn't monthly); the Overview gets the split for the live model at no cost.
9. **Bulk.** *Default: yes,* through the editor's multi-selection as one undoable edit; no bulk screen outside the editor.
10. **Whole-run range.** *Default: none* (Σ monthly means, as the profit tile); ranges are per month.
11. **Work above hours** (overtime capped). *Default: idle 0, the categories may sum above 100%, flagged in the month.*
12. **Requirements marked "drop"** with a `step_id`. *Default: not a source of "Could be removed"* (the design names the delete
    list only).

## Decisions (Austin, 29 Oct: "defaults")

These override the recommended defaults above where they differ. Every other open question takes its recommended
default.

1. **Pipeline steps after the sale** (the step where the sale is won, and every step after it on the won path) default
   to **"Moves the client's job forward"**. Steps before the sale default to "Winning work". This is still subject to a
   first-principles "delete", which gives "Could be removed".
2. **Ongoing client hours not drawn as steps** get **their own row, "Client upkeep"**, as a fixed category: renameable,
   not deletable. They are not counted under "Moves the client's job forward".
3. **Viewers per person:** their own row by name plus **"Everyone else"** (today's rule).
4. **Austin, 30 Oct: the deciding step counts as Winning work.** The step where the sale is decided (for example Northbeam's and
   Larkspur's "Client decision") now defaults to **"Winning work"**; only steps **after** it on the won path default to "Moves the
   client's job forward". Every other rule is unchanged (a chosen purpose wins; a first-principles delete gives "Could be removed";
   no lost end means nothing is after the sale). This amends decision 1 above.
5. **Austin, 30 Oct: no "Everyone else" for Viewers in teams of 2 or fewer.** When the run's split covers 2 or fewer people,
   "Everyone else" would be one identifiable colleague, so a Viewer gets only "You" and the note "Everyone else isn't shown in a
   team this small." Admins and the Owner are unchanged. This amends decision 3 above. (Compare, the Overview card, CSV, print and
   MCP are team-level or role-level only for everyone, so nothing changes there.)
