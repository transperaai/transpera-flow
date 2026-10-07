# C6 follow-up build brief: propose per-person times from a log that names people (#227)

Scoped 7 Oct 2026 against `origin/main` at `bf61be0e` (C6 #229 merged; production at row 67, `20261223000000`). Read
`docs/plans/builder-brief.md` first, then `docs/plans/c6-brief.md` (per-person times), `docs/plans/c2-2-brief.md` and
`docs/plans/c1-brief.md` (calibration and the import wizard). This brief adds to them and wins where they differ. Build
strictly from it. If something doesn't match the code, **ask; don't guess.** Every open question has a default: use it.

| | |
|---|---|
| Branch | `claude/c6-calibrate-factors` (this brief is its first commit; build on it) |
| Migration | `20261227000000_calibrate_capacity_factors.sql`, ledger row **71** |
| Apply file | `packages/db/scripts/apply/20261227000000_calibrate_capacity_factors.sql` |
| Closes | #227 (`Closes #227`) |
| Engine | A new pure module only (`person-times.ts`). `simulate` is not touched. **No `ENGINE_VERSION` bump**, no golden moves (as C2 2a). |

## The short version

On Settings → Historical data, a **stage history (step log)** or a **time log** can now name who did each visit. For
owners, editors and agency admins, with Per-person times switched on, calibration then measures **each person's
hands-on time on each step against that step's normal time** and proposes a per-person time (a factor, 0.5 to 2) with its
sample size. Fewer than 10 visits by that person on that step: flagged, not proposed. The person ticks what to apply; the
same Apply button and the same record-and-apply call write it, as a `measured` value linked to the dataset and the
calibration. Members and viewers never see a per-person proposal, and nothing is ranked or put side by side.

1. **Engine** `packages/engine/src/person-times.ts`: `proposePersonTimes(...)`, pure and deterministic.
2. **Import** (`packages/db/src/csv-import.ts`): the step log gains an optional **Person** column; time logs already have
   one. New pure helpers give the file's people and the per-person visits. The wizard gains "Match the people" (owners and
   editors only, switch on).
3. **Database** (migration): a new table `capacity_factor_proposals` that only owners, editors and agency admins read; full
   copies of the latest `record_calibration_import`, `apply_calibration`, `private.calibration_payload_problem` and
   `team_capacity`, each with marked `-- #227` lines (a `capacity_factor` kind; `team_capacity` gives each factor's
   measured item count, so the People page's ≥ 10 rule can show measured times).
4. **App**: a "Per-person times" part of the stage-history card, grouped per person, closed by default, never sorted by
   value; the People page and Settings say "measured from N visits".

Commit and push after each part: (1) engine module and tests; (2) `csv-import.ts` helpers and tests; (3) migration, apply
file, DB and PostgREST tests; (4) loaders, request checks, action; (5) wizard and panel, browser tests; (6) People page and
Settings lines; (7) docs.

---

## Decisions (verbatim)

**Austin, 7 Oct 2026 (relayed by the orchestrator):** Austin approved the C6 defaults and asked for "all the things you can
build", approving #227, #228 and #230.

**#227 (the whole body, as filed):**
> C6 (#198) lets owners and editors enter per-person times by hand. PRD 6.3.7 also wants them measured (at least 10
> completed items for that person-step) and shown once measured. That needs C2's step log (`datasets`,
> `record_calibration`) to have a person column. Then calibration can propose a time per person-step as a suggestion, with
> `provenance.factor.source = 'measured'`, and `personFactors` can set `measuredItems`. Never ranked or compared across
> people.

**The orchestrator's scope for #227 (7 Oct):**
> Extend C2/C1 calibration: when a step log or time log has a person column, estimate each person's hands-on time per
> step against the step's distribution, and propose factors with sample sizes and a minimum sample. Proposals go through
> the existing review and apply flow. Applied values get provenance `measured` linked to the dataset. Privacy: only owners
> and editors see or apply per-person proposals. Members never do. Nothing is ranked (PRD D20).

**#41 (C2), Austin, 6 Oct, decision 4:**
> 4. **Per-person times:** calibration proposes capacity factors only when the workspace has per-person times switched on.

**#41 acceptance criteria that apply here too:**
> - [ ] The diff view shows current, proposed and sample size, and supports selective apply
> - [ ] Applied values are `measured`, with `dataset_id` in provenance
> - [ ] Parameters with too small a sample are flagged and not proposed

**PRD §6.3.7:**
> The per-step capacity factor exists but is disabled by default per workspace. When enabled, it is only displayed once
> measured (minimum sample size: 10 completed items for that person-step) or explicitly entered; it is visible to the
> person themselves; and it is never presented as a ranking or against a role median.

**PRD D20:**
> Capacity, not performance: individual availability/skills/assignments; capacity factor off by default, shown only when
> measured, visible to the person, never ranked; no role-median benchmark. DPA clause in the retainer.

**#41 decision 3 / D27 (C1 brief):**
> **Inputs:** a clients CSV (`client, service, started, ended`) and a servicing log (`task, client, due, done`). Client ids
> are used for counting only and never stored (D27).

**C1 brief Q4 (the default this ticket changes):**
> **Person columns** (time logs, deal owner, ticket assignee). *Default: they can be mapped (#40 lists "person") and are
> shown as "Person 1, 2…" in the preview. They are never stored, never matched to people and not used, because per-person
> times are #198 (parked).*

**C6's defaults, confirmed by Austin (comment on #198, 7 Oct):**
> - Factors are off per workspace, and only owners and editors switch them on and set them.
> - Owners, editors and agency admins see everyone's factors. A member sees only their own.
> - Members simulate everyone at normal speed, so their numbers can differ slightly from an editor's.
> - Factors never reach share or play links, AI or MCP.

---

## Audit: what exists on `origin/main`

| Thing | State | #227 change |
|---|---|---|
| Engine calibration | `packages/engine/src/calibration.ts`: `calibrate(input)` proposes `work` (mean of `hours` per task step someone works on, n ≥ `CALIBRATION_MIN_SAMPLE` = 10), wait, rework, routing, arrivals. Steps matched by `norm(name)`; a name two steps share matches neither (L223–232, inline). `StepLogRow` (L86) has no person. | Extract the name matching into an exported helper; `StepLogRow.person?`; a new module |
| Import kinds | `packages/db/src/csv-import.ts`: `STEP_LOG_COLS` (L90) has no person column; `TIME_LOGS` has optional `person` (L114, help "Never shown, kept or matched to people."). `timeLogToStepLog` (L682) merges consecutive entries of a job on one task, ignoring person. `applyNameMapCounted` (L986) matches step names on entries, then merges. A `person` column is stored in `column_map` **by position** ("Column 4", L339–347), never by name. | Add a step-log person column; new helpers; help text |
| Wizard | `components/calibration/import-wizard.tsx`: "Match the names" (L604) for the kind's name column; `ImportReady` (L56). Preview labels person values "Person 1…" (C1). | "Match the people" |
| Panel | `components/calibration/calibration-panel.tsx`: `ImportWizard id="cal-log" kinds={["step_log","deals","time_logs"]}` (L202); `calibrate(calibrationInput(stored, rows))`; Apply calls `applyCalibration` (L122) with `results` and `keys`. View helpers `lib/calibration/view.ts` (`initiallySelected`, `selectable`, `applySummary` L81: every non-`arrivals:` key counts as a step change "into the draft"). | A per-person part; summary words |
| Request checks | `lib/calibration/request.ts`: `KEY` regex (L29) allows work/wait/rework/routing/arrivals; `storedResults` (L40) keeps `...rest` of `results`. | Factor keys and proposals, checked apart |
| Action | `app/w/[slug]/settings/calibration/actions.ts` `applyCalibration` → `rpc("record_calibration_import", …)` (C1). | Pass factor proposals |
| Loader | `lib/calibration/data.ts` `loadCalibrationPage`: `stored` (`calibrationRows(live, draft)`), last 5 calibrations (`applied: applied_keys.length`). `live` is a `ProcessBundle` loaded through `team_capacity`, so it has `viewer`, `people` (real names only for those who see everyone), `personRoles`, `personSkills`, `personCapacityFactors`. | `personTimes` setup |
| `record_calibration_import` | `20261216000000_dataset_imports.sql` L256–297 (C1, row 62). SECURITY INVOKER, `search_path = ''`. Inserts the dataset and the calibration (`results = p_results`), then `apply_calibration(cal, p_keys)` (which refuses an API token and needs 1–2000 keys). Body md5 **`f1a66685c4bbaeb3c212e5babeea9a6e`**. | Full copy + `-- #227` lines |
| `apply_calibration` | Latest `20261208000000_client_calibration.sql` L178–433 (row 57; C1 didn't touch it). Looks a key up in `cal.results -> 'proposals'`; branches `arrivals`, `churn` (live) and step kinds (draft); `stamp` = `{source: measured, at, dataset_id, calibration_id, by}`. md5 **`28fcf1c8c13a5f2e4b4b9c5d7f3feadb`**. | Full copy + a lookup hunk and a `capacity_factor` branch |
| `private.calibration_payload_problem` | Latest `20261208000000` L88–168. md5 **`d4da9751d6d050289a7dc5f07eb3c414`**. Granted to authenticated. | Full copy + a `capacity_factor` kind |
| `public.team_capacity` | Latest `20261223000000_capacity_factors.sql` L366–427 (C6). Factor items `{person_id, step_id, workspace_id, factor, source}`. md5 **`a8dcb5d1bddaf549ecef591a3c1b5ae0`** (C6's post-apply). | Full copy + an `items` key per factor |
| `calibrations` RLS | **Everyone in the workspace reads** `results` and `applied_keys` (`20261202000000` L190: `can_read_workspace`). Insert: editors. Update: `applied_keys` only, inside `apply_calibration` (trigger). | So per-person proposals **can't** live in `results`; and applied keys must not name a person |
| `person_capacity_factors` | C6: `stamp_provenance('factor')` keeps a provenance set in the same statement (so `measured` stays measured); `audit_company`; `needs_review` (API tokens refused); RLS write `can_edit_workspace`. | Written by the new branch |
| Display gate | `apps/web/src/lib/people.ts` `capacityFactorsShown` (L170): shown when entered, or measured with `measuredItems >= 10`; `personFactors` (L228) sets `measuredItems: 0`, so a measured time would be **hidden**. | Read `items` |
| `can_see_people(ws)` | `= can_edit_workspace(ws)`: agency admins, owners, editors (`20261207500000` L116). | The read rule of the new table |
| Other migrations in flight | #230 (`20261225000000`) replaces `private.audit_company_write` (the change log names the step; it already appends " (measured)" for measured entries). #228 (`20261226000000`) replaces `import_workspace_bundle` (restores factor rows with their provenance). **Neither touches any function this ticket replaces.** | Independent |

**Privacy consequence (the reason for the new table):** `calibrations.results` and `calibrations.applied_keys` are read by
members. So: per-person proposals go to `capacity_factor_proposals` (read by owners, editors and agency admins only);
`results` holds **no person id, name or per-person number**; and an applied factor key in `applied_keys` is
`factor:<proposal row id>`, an id members can't resolve, never `factor:<person>:<step>`.

---

## Part 1: engine (`packages/engine/src/person-times.ts`)

Export from `packages/engine/src/index.ts`. Pure, deterministic, no `Math.log`/`Math.exp`, no clock, no I/O.

**Refactor first (behaviour identical, `calibration.test.ts` green unchanged):** move `calibrate`'s step-name matching
(L223–227: `norm`, the map where a name two steps share maps to null) into an exported
`stepIdsByName(steps: readonly { id: string; name: string }[]): Map<string, string | null>` and `normStepName(s)` in
`calibration.ts`, and use them in `calibrate`.

**`StepLogRow`** gains `person?: string | null` with the doc "Who did the visit: the file's name for them while reading,
a person id once matched (#227). Used only for per-person times; never stored." Optional, so nothing else changes.

```ts
export const PERSON_TIME_MIN = 0.5;
export const PERSON_TIME_MAX = 2;

export interface PersonTimesPerson {
  id: string;
  /** Step ids this person can do (their skills if any, otherwise their roles' steps): the C6 rule, `stepsPersonCanDo`. */
  canDo: readonly string[];
  /** Their stored times now: the "Every step" one and one per step, with where each came from. */
  every: { factor: number; source: "entered" | "measured" } | null;
  steps: Readonly<Record<string, { factor: number; source: "entered" | "measured" }>>;
}

export interface PersonTimesInput {
  steps: readonly CalibrationStep[];   // calibrationInput(stored, rows).steps
  rows: readonly StepLogRow[];         // `person` holds a person id, or null (no one matched, or a visit by several people)
  people: readonly PersonTimesPerson[]; // in the order the page lists them (the roster); never re-sorted
  minSample?: number;                   // default CALIBRATION_MIN_SAMPLE (10, PRD §6.3.7)
}

export interface PersonTimeProposal {
  key: string;                       // `factor:<personId>:<stepId>`
  kind: "capacity_factor";
  target: { table: "person_capacity_factors"; id: string; step_id: string }; // id: the person
  personId: string;
  stepId: string;
  subject: string;                   // the step's name
  n: number;                         // their visits with hands-on hours at this step
  stepN: number;                     // all visits with hands-on hours at this step
  enough: boolean;
  current: number | null;            // their stored time on this step, or null
  currentSource: "entered" | "measured" | null;
  every: number | null;              // their "Every step" time, or null
  measured: number | null;           // their mean ÷ the step's mean, 3 places, before limiting to 0.5–2; null when blocked
  proposed: number | null;           // limited to 0.5–2, 2 places; null when blocked
  limited: boolean;                  // measured was outside 0.5–2
  within: boolean;                   // |measured − 1| ≤ 2 standard errors: inside visit-to-visit spread
  changed: boolean;                  // proposed !== round(current ?? every ?? 1, 2)
  blocked: string | null;
  note: string;
  set: { factor: number } | null;
  before: { factor: number | null } | null;
}

export function proposePersonTimes(input: PersonTimesInput): { proposals: PersonTimeProposal[]; minSample: number };
```

**The estimate** ("against the step's distribution", Q1):
1. Match each row's `step` with `stepIdsByName(input.steps)`; unmatched rows are ignored here (`calibrate` reports them).
2. Eligible steps: `kind === "task" && worked && !holder` (exactly `calibrate`'s work rule).
3. For an eligible step s: its visits are the matched rows with `hours !== null && hours >= 0`; `stepN` = their count;
   `M` = their mean (every visit, whoever did it, named or not). This is the same mean `calibrate`'s `work` proposal
   proposes for the step, so a person's time is relative to the step's normal time as measured from the same log.
4. For each person p (input order) and each eligible step s (`input.steps` order) where p has at least one visit:
   `n` = p's visits at s (`row.person === p.id`), `m` = their mean, `cv` = their coefficient of variation (`meanAndCv`,
   moved or copied from `calibration.ts`).
5. Blocked, in this order (`measured`, `proposed`, `set`, `before` null; `changed` false):
   - s not in `p.canDo`: "Not one of the steps this person does (Settings → People), so it wouldn't be used."
   - `n < minSample`: "Too few to measure: {n} of the {min} needed." (the C2 words)
   - `stepN < minSample`: "The step has {stepN} logged visits with hands-on hours; {min} are needed to know its normal time."
   - `n === stepN`: "Every logged visit at this step is theirs, so the step's normal time is already their time."
   - `M <= 0`: "The step's logged hands-on hours are all zero."
6. Otherwise `r = m / M`; `measured = round(r, 3)`; `proposed = round(min(2, max(0.5, r)), 2)`; `limited = r < 0.5 || r > 2`;
   `se = r × cv / √n`; `within = |r − 1| ≤ 2 × se` (so a cv of 0 makes `within` true only at exactly 1);
   `changed = proposed !== round(current ?? every ?? 1, 2)`; `set = { factor: proposed }`; `before = { factor: current }`.
7. `note` (numbers and the step only; **never a person's name, never another person**):
   "{n} of the step's {stepN} logged visits. Their hands-on time is {measured, 2 places} × the step's normal time."
   Then, when `limited`: " Per-person times go from 0.5 to 2, so {proposed} is proposed." When `within`: " That is within
   the usual spread from visit to visit."
8. Proposals come out in person order, then step order. **Never sorted by value.**

---

## Part 2: import (`packages/db/src/csv-import.ts`)

- **Step log person column.** Append to `STEP_LOG_COLS`:
  `col("person", "Person", false, "person", ["person", "user", "team member", "employee", "staff", "done by", "worked by", "assignee", "assigned to", "owner"], "Who did the visit. Owners and editors can match it to your people to measure per-person times (with Per-person times switched on). Never kept.", "A team member")`.
  `STEP_LOG_COLUMNS` and `parseStepLog` in `calibration.ts` **don't change** (C2's legacy parser and its tests stay as
  they are). In `readerFor("step_log")`, wrap `readStepLogRow`: when the row is read and `cell("person")` is non-empty,
  refuse over 200 characters ("The person is over 200 characters.") and set `row.person` to it. A row without a person
  gets no `person` key, so existing outputs are byte for byte the same.
- **Time logs' person help** becomes: "Who logged the time. Owners and editors can match it to your people to measure
  per-person times (with Per-person times switched on). Never kept." Deals' owner and jobs' assignee keep their text.
- `export const PERSON_TIME_KINDS: readonly ImportKind[] = ["step_log", "time_logs"];` (the kinds with hands-on hours).
- `export function personValues(read: ImportRead): { value: string; rows: number }[]`: the distinct people of the file
  (`read.rows[].person` for step logs, `read.entries[].person` for time logs, else `[]`), most rows first, then by value, at
  most `MAX_IMPORT_NAMES` (500). No change to `readImport` or `ImportRead`.
- `export function applyNameMapEntries(read: ImportRead, map): TimeLogRow[] | null`: the time-log entries kept by the
  step-name map, renamed to the model's names (the first half of `applyNameMapCounted`'s entries branch); null for other
  kinds. `applyNameMapCounted` may call it; its output must not change.
- `export function timeLogPersonVisits(entries: readonly TimeLogRow[]): StepLogRow[]`: `timeLogToStepLog`'s merging,
  exactly, plus `person` on each visit: the entries' person when every entry of the visit names the same non-empty person,
  else null (a visit by several people, or no one named). `timeLogToStepLog` itself doesn't change.
- `importDetails` and `ImportDetails` don't change: no person value, match or count is stored.

---

## Part 3: migration `20261227000000_calibrate_capacity_factors.sql`

**Additive except four `create or replace`s**, each a full copy of the latest body (generate the copy from the file with a
script; never retype) with only the `-- #227` lines below. Same signatures, settings and grants. It does not touch
`save_fields`, `record_calibration`, `record_client_calibration`, the `calibrations` trigger, any policy or grant on an
existing table, or `share_team_capacity`.

### 3a. Table `public.capacity_factor_proposals`

```sql
create table public.capacity_factor_proposals (
  id uuid primary key default gen_random_uuid(),
  calibration_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  person_id uuid not null,
  -- Step ids are stable across a process's versions (as person_capacity_factors.step_id); no foreign key.
  step_id uuid not null,
  -- The proposal as computed (PersonTimeProposal): current, proposed, sample sizes, note. Frozen once written.
  proposal jsonb not null constraint capacity_factor_proposals_proposal check (
    jsonb_typeof(proposal) = 'object' and proposal ->> 'kind' = 'capacity_factor'
    and proposal -> 'target' ->> 'table' = 'person_capacity_factors'
    and proposal -> 'target' ->> 'id' = person_id::text and proposal -> 'target' ->> 'step_id' = step_id::text
    and octet_length(proposal::text) <= 10000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (calibration_id, person_id, step_id),
  foreign key (calibration_id, workspace_id) references public.calibrations (id, workspace_id) on delete cascade,
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade
);
create index on public.capacity_factor_proposals (workspace_id);

-- The MCP server (an API token) can't write them, as for the company model.
create trigger needs_review before insert on public.capacity_factor_proposals
  for each row execute function private.company_needs_review();

alter table public.capacity_factor_proposals enable row level security;
-- Per-person data: owners, editors and agency admins only. Never members or viewers, not even their own (#227).
create policy "read capacity_factor_proposals" on public.capacity_factor_proposals for select to authenticated
  using (public.can_see_people(workspace_id));
create policy "insert capacity_factor_proposals" on public.capacity_factor_proposals for insert to authenticated
  with check (public.can_see_people(workspace_id));
revoke all on public.capacity_factor_proposals from anon, authenticated;
grant select, insert on public.capacity_factor_proposals to authenticated;
```
No update or delete for anyone (frozen, like `calibrations`). Not in the Realtime publication.

### 3b. `private.calibration_payload_problem` (copy of `20261208000000` L88–168)

Before the final `return null;`:
```sql
  -- #227: a person's time on a step, a multiple of the step's normal time, within what person_capacity_factors allows.
  if kind = 'capacity_factor' then
    if (case when jsonb_typeof(setv -> 'factor') = 'number' then (setv ->> 'factor')::numeric not between 0.5 and 2 else true end) then
      return 'factor is not a per-person time from 0.5 to 2';
    end if;
    if coalesce(jsonb_typeof(beforev -> 'factor'), 'null') not in ('number', 'null') then
      return 'the earlier factor is not a number';
    end if;
    return null;
  end if;
```
Keep row 57's `revoke all … from public, anon;` and `grant execute … to authenticated;`.

### 3c. `public.apply_calibration` (copy of `20261208000000` L178–433)

- Declarations, after `cg public.client_groups; -- C2 part 2`:
  ```sql
  pcf public.person_capacity_factors; -- #227
  step_ref uuid; -- #227
  raced boolean; -- #227
  ```
- **Lookup.** Replace the one line
  `select p into prop from jsonb_array_elements(cal.results -> 'proposals') p where p ->> 'key' = k limit 1;` with:
  ```sql
    -- #227: a per-person proposal is kept apart, where only owners, editors and agency admins read it; its key is its row id.
    if k like 'factor:%' then
      select f.proposal into prop from public.capacity_factor_proposals f where f.calibration_id = cal.id and 'factor:' || f.id::text = k;
    else
      select p into prop from jsonb_array_elements(cal.results -> 'proposals') p where p ->> 'key' = k limit 1;
    end if;
  ```
  (A member can't read the table, so their factor keys are `not_proposed`; they are already refused earlier because they
  can't update the calibration.)
- **Branch**, right after the `churn` branch's `end if;` and before the `if pkind not in ('work', …)` line:
  ```sql
    -- #227: a person's time on a step, measured from a log that names people: live, as a person's edit, kept `measured`
    -- (provenance set in the same statement, so stamp_provenance keeps it). Only while Per-person times are switched on.
    if pkind = 'capacity_factor' and prop -> 'target' ->> 'table' = 'person_capacity_factors' then
      begin
        step_ref := (prop -> 'target' ->> 'step_id')::uuid;
      exception when others then
        step_ref := null;
      end;
      if step_ref is null then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_proposed'));
        continue;
      end if;
      if not exists (select 1 from public.workspaces w where w.id = cal.workspace_id and w.settings -> 'capacity_factor_enabled' = 'true'::jsonb) then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'switched_off'));
        continue;
      end if;
      if not exists (select 1 from public.people pe where pe.id = target_id and pe.workspace_id = cal.workspace_id)
         or not exists (select 1 from public.steps s where s.id = step_ref and s.workspace_id = cal.workspace_id) then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'not_found'));
        continue;
      end if;
      select * into pcf from public.person_capacity_factors f where f.person_id = target_id and f.step_id = step_ref for update;
      if pcf.factor is distinct from (beforev ->> 'factor')::numeric then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      entry := stamp || jsonb_build_object('n', prop -> 'n');
      raced := false;
      if pcf.person_id is null then
        begin
          insert into public.person_capacity_factors (person_id, workspace_id, step_id, factor, provenance)
          values (target_id, cal.workspace_id, step_ref, (setv ->> 'factor')::numeric, jsonb_build_object('factor', entry));
        exception when unique_violation then
          raced := true;
        end;
      else
        update public.person_capacity_factors f
        set factor = (setv ->> 'factor')::numeric, provenance = f.provenance || jsonb_build_object('factor', entry)
        where f.person_id = target_id and f.step_id = step_ref;
      end if;
      if raced then
        results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'changed'));
        continue;
      end if;
      done := done || k;
      results := results || jsonb_build_array(jsonb_build_object('key', k, 'status', 'applied'));
      continue;
    end if;
  ```
  `pcf` is null-filled when no row is found, so "no time stored" matches `before.factor` null. `stamp` already carries
  `source: measured`, `dataset_id`, `calibration_id`, `at`, `by`. Keep row 57's revoke and grant lines.

### 3d. `public.record_calibration_import` (copy of `20261216000000` L256–297)

The whole new body (only the `-- #227` lines are new; everything else is C1's, character for character):

```sql
declare
  ds uuid;
  cal uuid;
  out jsonb;
  -- #227: per-person proposals travel in p_results.capacity_factors and are kept apart from the calibration's results,
  -- which everyone in the workspace reads.
  factors jsonb := case when jsonb_typeof(p_results -> 'capacity_factors') = 'array' then p_results -> 'capacity_factors' else '[]'::jsonb end;
  keys text[]; -- #227
begin
  if p_kind is null or p_kind not in ('step_log', 'deals', 'time_logs') then
    raise exception 'That kind of file isn''t calibrated against a process' using errcode = '22023';
  end if;
  -- #227: only owners, editors and agency admins, only with Per-person times switched on (#41 decision 4).
  if jsonb_array_length(factors) > 0 then
    if not coalesce(public.can_see_people(p_workspace), false) then
      raise exception 'Only owners and editors can apply per-person times' using errcode = '42501';
    end if;
    if jsonb_array_length(factors) > 2000 then
      raise exception 'Give at most 2000 per-person times' using errcode = '22023';
    end if;
    if not exists (select 1 from public.workspaces w where w.id = p_workspace and w.settings -> 'capacity_factor_enabled' = 'true'::jsonb) then
      raise exception 'Per-person times are switched off in this workspace' using errcode = '22023';
    end if;
  end if;
  <C1's comment and the datasets insert, unchanged>
  insert into public.calibrations (workspace_id, dataset_id, process_id, results)
  values (p_workspace, ds, p_process, p_results - 'capacity_factors') -- #227: never per-person data in what members read
  returning id into cal;
  -- #227: each per-person proposal where only owners, editors and agency admins read it; a ticked `factor:<person>:<step>` becomes
  -- `factor:<its row id>`, so the calibration's applied keys (which members read) name no person.
  insert into public.capacity_factor_proposals (calibration_id, workspace_id, person_id, step_id, proposal)
  select cal, p_workspace, (f.value -> 'target' ->> 'id')::uuid, (f.value -> 'target' ->> 'step_id')::uuid, f.value
  from jsonb_array_elements(factors) f;
  keys := array(
    select coalesce((select 'factor:' || x.id::text from public.capacity_factor_proposals x
                     where x.calibration_id = cal and u.k = 'factor:' || x.person_id::text || ':' || x.step_id::text), u.k)
    from unnest(p_keys) with ordinality u(k, o) order by u.o);
  out := public.apply_calibration(cal, keys);
  -- #227: and back to the page's own keys.
  if out ? 'results' then
    out := out || jsonb_build_object('results', coalesce((
      select jsonb_agg(case when x.id is null then r.value
                            else r.value || jsonb_build_object('key', 'factor:' || x.person_id::text || ':' || x.step_id::text) end order by r.o)
      from jsonb_array_elements(out -> 'results') with ordinality r(value, o)
      left join public.capacity_factor_proposals x on x.calibration_id = cal and r.value ->> 'key' = 'factor:' || x.id::text), '[]'::jsonb));
  end if;
  return out || jsonb_build_object('calibration_id', cal, 'dataset_id', ds);
end;
```
A null `p_keys` gives an empty `keys`, and `apply_calibration` refuses it with 22023, as today. Keep C1's revoke and grant.

### 3e. `public.team_capacity` (copy of `20261223000000` L366–427)

In the C6 `person_capacity_factors` item, add one key after `'source', …`:
```sql
        -- #227: how many visits a measured time rests on (PRD §6.3.7 shows a measured time only from 10); null when entered.
        'items', case when f.provenance -> 'factor' ->> 'source' = 'measured' and jsonb_typeof(f.provenance -> 'factor' -> 'n') = 'number'
          then round((f.provenance -> 'factor' ->> 'n')::numeric)::int end,
```
Still never `provenance` itself, never `created_by`. Same visibility rule (everyone's for those who see everyone, the
caller's own otherwise). `share_team_capacity` is untouched (no factors at all).

### 3f. Header (C6's style)

- Purpose, the decisions quoted, the privacy design (the new table; `results` and `applied_keys` carry no person).
- **What changes:** the table; the four replaced functions with their md5s; "STRICTLY ADDITIVE apart from four `create
  or replace`s with the same signatures, each a full copy of its latest body plus marked lines."
- **ORDER:** after `20261223000000` (row 67), `20261216000000` (row 62) and `20261208000000` (row 57). Independent of #230
  (`20261225000000`) and #228 (`20261226000000`), which replace other functions; this file sorts last of the three, so
  if it is applied before either, that one is renumbered above it. **Apply BEFORE deploying the app** (the page sends
  `capacity_factors`; the old `record_calibration_import` would store them in `results`, which members read). Say this
  in capitals in the header and the PR.
- **PREFLIGHT** (read-only, one at a time):
  0. Rows 57, 62 and 67 applied, nothing at or past this one: `select version from supabase_migrations.schema_migrations where version in ('20261208000000', '20261216000000', '20261223000000') or version >= '20261227000000' order by 1;` Expect the three.
  1. The four bodies are as expected. Expect `public.apply_calibration 28fcf1c8c13a5f2e4b4b9c5d7f3feadb`,
     `private.calibration_payload_problem d4da9751d6d050289a7dc5f07eb3c414`,
     `public.record_calibration_import f1a66685c4bbaeb3c212e5babeea9a6e`,
     `public.team_capacity a8dcb5d1bddaf549ecef591a3c1b5ae0`:
     `select n.nspname || '.' || p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('public', 'apply_calibration'), ('private', 'calibration_payload_problem'), ('public', 'record_calibration_import'), ('public', 'team_capacity')) order by 1;`
  2. Nothing created yet. Expect null: `select to_regclass('public.capacity_factor_proposals');`
  3. No calibration so far holds a person-level key (sanity; expect 0): `select count(*) from public.calibrations where results ? 'capacity_factors' or exists (select 1 from unnest(applied_keys) k where k like 'factor:%');`
  4. For the log: workspaces with the switch on (`select slug from public.workspaces where settings -> 'capacity_factor_enabled' = 'true'::jsonb;`).
- **POST-APPLY CHECK:** RLS on, two policies (select and insert, both `can_see_people`); `authenticated` has only SELECT
  and INSERT on the table, `anon` nothing; the trigger `needs_review`; the four functions' `prosecdef`/`proconfig` as
  before (`apply_calibration` f, `record_calibration_import` f, `calibration_payload_problem` f, `team_capacity` t; all
  `{search_path=""}`) and their new md5s (computed by the builder, written in); `anon` can't execute the three public
  ones; smoke test, rolled back, as the Northbeam owner: `team_capacity(...) -> 'person_capacity_factors'` is `[]`.
  Live check (Austin): switch Per-person times on, read a time log with a person column on Historical data, match the
  people, apply one per-person time; Settings → People shows it "measured from N visits"; a member sees no per-person
  part on Historical data.
- **ROLLBACK** in the `-- ROLLBACK (` block `header-rollback.ts` parses (every line `--   ` plus SQL, **blank lines inside
  bodies written `--   `**): `begin;` the four previous `create or replace function … $$;` statements in full with their
  revoke/grant lines (generated from 20261208000000 ×2, 20261216000000 and 20261223000000), `drop table if exists
  public.capacity_factor_proposals;`, `delete from supabase_migrations.schema_migrations where version = '20261227000000';`,
  `commit;`. "Roll the app back first. Times already applied stay, measured; their `calibration_id` still names the
  calibration, whose per-person proposals are gone."

Apply file: `begin;`, `set local lock_timeout = '5s';`, the migration SQL, the `schema_migrations` insert (name
`'calibrate_capacity_factors'`, `array[$mig$…$mig$]`), `commit;` (C6's apply-file style). Then `gen:bootstrap`, and
hand-edit `packages/db/src/database.types.ts` for the new table (Row/Insert/Update/Relationships in the generator's
format, as #205–#207 and C6 did; no function signature changes). No `gen:seed`. Row 71 in
`docs/production-migrations.md`, "not yet applied".

---

## Part 4: types, loaders, request checks, action

**`packages/db/src/types.ts`:** `PersonCapacityFactorRow.items?: number | null` ("How many visits a measured time rests
on; null or absent when entered (#227)"). **`queries.ts`** `loadTeam`: map `items: r.items == null ? null : Number(r.items)`.
**`model.ts`:** export `hidesPay` (unchanged body) for the loader below.

**`apps/web/src/lib/data.ts`** (`loadWorkspaceSettings`, L493–517): map `items` from `provenance.factor.n` when the source
is measured, like `source`.

**New `apps/web/src/lib/calibration/person-times.ts`** (framework-free):
```ts
export type PersonTimesSetup =
  | { state: "hidden" }  // members, viewers: nothing per-person is shown or computed
  | { state: "off" }     // owners, editors, agency admins with the switch off
  | { state: "on"; people: { id: string; name: string }[]; persons: PersonTimesPerson[] };
export function personTimesSetup(live: ProcessBundle, steps: readonly StepRow[]): PersonTimesSetup;
```
- `hidden` when `hidesPay(live)`; `off` when the switch isn't `true`; else `on`.
- `people`: active people (`active !== false`) in the bundle's order, `{ id, name }`.
- `persons`: for each of them, `canDo` = `stepsPersonCanDo(p.id, steps, live.personSkills, live.personRoles).map(s => s.id)`
  (import from `lib/people.ts`), `every` and `steps` from `live.personCapacityFactors` (source `measured` or `entered`).
- Also: `initiallyTickedFactor(p) = Boolean(p.set) && p.changed && !p.within && !p.limited && p.currentSource !== "entered"`;
  `groupByPerson(proposals, people)` → `[{ person, proposals }]` in the people order, persons with no proposal left out;
  `factorKeyRe = /^factor:<uuid>:<uuid>$/i`.

**`lib/calibration/data.ts`** (`loadCalibrationPage`): add `personTimes: personTimesSetup(live, (draft ?? live).steps)`.
In `history`, count `applied` from keys **not** starting `factor:`, and add `perPersonApplied` (the `factor:` keys'
count) only when `personTimes.state !== "hidden"`, else 0.

**`lib/calibration/request.ts`:**
- `storedResults` also removes `capacity_factors`, `capacityFactors` and `personTimes` keys (defence: per-person data never
  goes into `results`).
- `parseApplyRequest` accepts an optional `capacityFactors` array (at most 2000). Each item is **rebuilt** by a new
  `storedFactorProposal(input)` from known fields only (never `...spread`): `key` (matches the factor regex and equals
  `factor:${target.id}:${target.step_id}`), `kind: "capacity_factor"`, `target {table: "person_capacity_factors", id, step_id}`
  (uuids), `personId`, `stepId` (equal to the target's), `subject` (≤ 200 chars), `n`, `stepN` (integers ≥ 0), `enough`,
  `limited`, `within`, `changed` (booleans), `current`, `every`, `measured`, `proposed` (finite numbers or null; `proposed`
  within 0.5–2), `currentSource` ("entered" | "measured" | null), `blocked` and `note` (strings ≤ 500 or null), `set`
  (`{factor}` within 0.5–2, or null), `before` (`{factor: number | null}` or null). A bad item refuses the request ("The
  per-person times aren't valid.").
- Keys: a ticked factor key is good when it matches the regex and is the key of a rebuilt item with `set`.
- `ApplyRequest.capacityFactors: StoredFactorProposal[]` (empty when none).

**`actions.ts` `applyCalibration`:** `p_results: r.capacityFactors.length ? { ...r.results, capacity_factors: r.capacityFactors } : r.results`.
Error words: 42501 → the existing "Only owners and editors can apply calibration here."; a 22023 whose message contains
"switched off" → "Per-person times are switched off in this workspace. Switch them on in Settings → Simulation, then
apply again." `refresh()` as now.

**`lib/calibration/view.ts`:** `ApplyStatus` gains `"switched_off"` ("per-person times are switched off"). `applySummary`:
`factor:` keys count apart: "{n} per-person time(s) set." (live, not the draft); the step count and `editor` flag
(calibration-panel L146) exclude `factor:` keys.

---

## Part 5: wizard and panel

**`import-wizard.tsx`:** new optional prop `people?: readonly { id: string; name: string }[] | null` ("Owners, editors and
agency admins with Per-person times on: the people a person column is matched to. Null or absent: no matching, and person
values stay labelled 'Person 1…'.").
- When `people` is given, `kind` is in `PERSON_TIME_KINDS`, the person column is matched, and `personValues(read)` is not
  empty: a "Match the people" section after "Match the names", in the same layout: one row per value ("{value} ({rows}
  rows)") → a select of `people` names plus "Leave out", defaulted by `suggestNameMap` over names (an ambiguous name
  matches no one). Heading (i): description "Each name in the file is matched to one of your people, to measure their
  time on each step. Only owners and editors see this. Names in the file are never kept." Example: "Sam P. → Sam Patel".
  Over 500 values: the same note as names.
- `ImportReady.personMap: Record<string, string | null> | null` (file value → person id; null when no matching).
- `ImportReady.personRows: StepLogRow[] | null`: for time logs `timeLogPersonVisits(applyNameMapEntries(read, nameMap))`,
  for step logs the kept rows; each row's `person` replaced by `personMap[value] ?? null`. Null without matching.
- Members (no `people`) see exactly what they see today.

**`calibration-panel.tsx`:** new prop `personTimes: PersonTimesSetup`.
- Pass `people={personTimes.state === "on" ? personTimes.people : null}` to the wizard.
- When `state === "on"` and `ready.personRows`: `proposePersonTimes({ steps: input.steps, rows: ready.personRows, people: personTimes.persons })`
  in a `useMemo`. Tick with `initiallyTickedFactor`.
- When `state === "off"` and the person column is matched: one muted line: "This log names people. Switch Per-person
  times on in Settings → Simulation to measure each person's time on each step." with a link to `${base}/settings#simulation`
  (use the Simulation section's real anchor).
- When `state === "hidden"`: nothing, and nothing per-person is computed.
- **The "Per-person times" section** (`<section data-person-times aria-labelledby=…>`), under the proposal groups, before
  Apply. Heading "Per-person times" with (i): description "How long each person takes on a step compared with the step's
  normal time, from the log's hands-on hours. Only owners and editors see this. Times are never ranked or compared
  across people. 1 is the normal time, 0.8 is 20% faster, 1.25 is 25% slower." Example: "Sam's 14 Kickoff visits took
  0.8 of the step's normal time: tick it to set his Kickoff time to 0.8." Then:
  - one `<details>` per person (`groupByPerson`), **closed by default**, summary "{name}: {k} step(s) measured" (k = their
    proposals with `set`), people in the roster order;
  - inside, one row per step, in step order: the step name; "Now: {current} × normal" with a source badge, or "Now:
    {every} × normal (every step)", or "Now: normal"; "Measured: {proposed} × normal ({factorWords})"; "{n} visits"; the
    note; a tick box when `selectable` (`set && changed`), else the blocked reason in muted text;
  - **no table with people as rows or columns, no sort control, no totals or averages across people.**
- Apply sends `capacityFactors: proposals.filter(p => p.set)` (all with a value, ticked or not, so the record holds what
  was proposed) and the ticked factor keys among `keys`. Demo mode: as for other proposals ("Demo: nothing is saved").
- The demo pages pass `{ state: "hidden" }` (Q9). The live page passes `data.personTimes`.
- History lines: "Applied {applied}" as now, plus " and {perPersonApplied} per-person time(s)" when non-zero.

---

## Part 6: People page and Settings

- `lib/people.ts` `personFactors`: `measuredItems: f.source === "measured" ? Number(f.items ?? 0) : 0`. Update the
  doc comments of `capacityFactorsShown` ("nothing measures them yet" is no longer true).
- `components/people-page.tsx` L514: after "(20% faster)", for a measured factor, " · measured from {n} visits".
- Settings (`capacity-factors-field.tsx` / `people-settings.tsx`): under a field whose stored value is measured, a muted
  "Measured from {n} visits" line. Editing it by hand turns it `entered` (the trigger does that already).
- The People page still shows a measured time only with `items >= 10` (the existing gate). Calibration never proposes
  under 10, so applied times always show.

---

## Patterns to copy

| What | Copy from |
|---|---|
| Estimator style, `meanAndCv`, `tooFew` wording | `packages/engine/src/calibration.ts` |
| A frozen, editor-readable side table with RLS and grants | `calibrations` in `20261202000000_calibration.sql` (but select/insert through `can_see_people`) |
| A `create or replace` full copy plus marked lines, with md5 preflight and runnable rollback | `20261208000000_client_calibration.sql` (two replaced functions) and C6's `team_capacity` |
| An apply branch writing live with measured provenance | the `churn` branch of `apply_calibration` |
| Request rebuilding from known fields | `storedClientResults` in `lib/calibration/client-request.ts` |
| Name-matching UI | "Match the names" in `import-wizard.tsx` |
| Per-person privacy tests | `team-capacity.test.ts`, `role-matrix.test.ts` (`reads: "editors"`), `person-privacy-source.test.ts` |
| DB and PostgREST calibration tests | `packages/db/test/dataset-imports.test.ts`, `packages/mcp/test/postgrest-dataset-imports.test.ts` |
| Browser harness with real workers | `apps/web/test/csv-import-harness/entry.tsx`, `csv-import-browser.test.ts` |

---

## Edge cases

- **Hands-on hours missing** (a step log without `hours`, or a stage history from deals): nothing per-person is proposed
  (no hands-on time). Durations from started to finished are never used: they include waiting.
- **Time logs:** a visit merged from entries by several people (or with no one named) is not any one person's: it counts
  in the step's normal time and in no one's (`person` null). Say how many in the section: "{k} visits were by more than one
  person or named no one, so they count only toward each step's normal time."
- **Names:** a file name that matches two people (same name after normalising) matches neither; "Leave out" drops that
  name's visits from per-person times only (they still count for the step). Inactive people aren't offered.
- **A person who can't do the step:** blocked with its reason; never applied.
- **A step done only by one person:** blocked ("Every logged visit at this step is theirs …").
- **Outside 0.5–2:** proposed at the bound, `limited`, never ticked to start with, the note says so.
- **Within the spread:** proposed but not ticked to start with.
- **An entered time already stored:** compared (`current`, `currentSource: "entered"`), never ticked to start with;
  applying it replaces it with a measured one (the person ticks it).
- **"Every step" times:** never proposed (Q5); an existing one shows as "Now: … (every step)" and counts for `changed`.
- **Draft vs live:** per-person times are live (like lead volumes and churn); steps compared are the draft's when there is
  one (`calibrationRows`), and step ids are stable across versions.
- **Switch turned off between reading and applying:** `record_calibration_import` refuses (22023, the message above) when
  factor proposals are sent; for a later apply of an existing calibration, each factor key gets `switched_off`.
- **Two editors:** compare-and-set on `before.factor`; a changed or raced row gives `changed`.
- **Members and viewers:** the page computes nothing per-person (`hidden`), the wizard shows no people matching, the
  request can't carry factor proposals past the database (42501), the table's RLS hides proposals, `results` holds no
  person data, `applied_keys` hold row ids only. Their own applied time shows to them on the People page (C6), measured.
- **AI, MCP, share and play links:** unchanged (C6): factors never reach them. `team_capacity`'s new `items` key is
  emptied with the rest by the share redaction (`personCapacityFactors: []`).
- **Change log:** the applied time is an insert or update of `person_capacity_factors`, logged by `audit_company`; with
  #230 it reads "Sam Patel: per-person time on Kickoff set (measured)".
- **Restore (#228):** restored rows keep their provenance, so `items` survives; `capacity_factor_proposals` and
  calibrations are not in backups.
- **Workspace delete (#225):** the new table's keys cascade; run `workspace-delete.test.ts`.

---

## Tests

**Engine** (new `packages/engine/test/person-times.test.ts`, hand-built steps and rows as `calibration.test.ts`):
1. Two people on one step, 12 visits each, hours 2 and 3 (M = 2.5): proposals 0.8 and 1.2, `n` 12, `stepN` 24; the note
   has no name and no other person's number.
2. Each blocked reason, in order (can't do, under 10, step under 10, all visits theirs, zero hours).
3. Limited at 0.5 and 2; `within` true for a small difference with a wide spread, false for a clear one.
4. `changed` against a stored step time, against "Every step" only, and against nothing (1).
5. Output order follows the people and steps given, whatever the values (shuffle values; the order stays).
6. Determinism (deep-equal on a second call); rows in any order give the same result.
7. `calibrate`'s output is byte-identical before and after the `stepIdsByName` refactor (existing tests unchanged, plus one
   `JSON.stringify` comparison on a fixture).

**Import** (`packages/db/test/csv-import.test.ts`, add): the step-log person column is suggested from "Person", "Done
by", "Assignee"; a step-log read without it has no `person` key (byte-identical rows); `personValues` for step logs and
time logs; `applyNameMapEntries`; `timeLogPersonVisits` (A by Sam, A by Sam → one visit, Sam; A by Sam, A by Jo → one
visit, null; `timeLogToStepLog` unchanged); `importDetails` of a file with a person column still contains no person value
(extend the privacy test with the step-log kind).

**Database** (new `packages/db/test/capacity-factor-calibration.test.ts`, the harness and Northbeam ids of
`dataset-imports.test.ts`):
1. As an editor with the switch on: `record_calibration_import` with two factor proposals (one ticked) stores the
   calibration with **no** `capacity_factors` key and no person id anywhere in `results::text`; two
   `capacity_factor_proposals` rows; the ticked one applied: `person_capacity_factors` row with the factor and
   `provenance.factor` = `{source: measured, dataset_id, calibration_id, n, at, by}`; `applied_keys` holds
   `factor:<row id>` (not a person id); the returned `results` use the page's key `factor:<person>:<step>`.
2. Applying over an entered time updates it and makes it measured; a stale `before` gives `changed`; a person or step from
   another workspace gives `not_found`; a factor of 2.5 gives `invalid`; switch off → the record call 22023, and
   `apply_calibration` on an existing calibration gives `switched_off`.
3. Refused: a member's and a viewer's call with factor proposals → 42501 and nothing recorded; an API token → 42501.
4. A member and a viewer read 0 rows of `capacity_factor_proposals`; an editor and an agency admin read them; nobody can
   update or delete them.
5. `team_capacity`: a measured time has `items` = its `n`; an entered one `items` null; the member sees only their own
   (C6's matrix, extended); no `provenance` key.
6. Step-kind and arrivals calibrations behave as before (`calibration.test.ts`, `dataset-imports.test.ts`,
   `client-calibration.test.ts` green unchanged).
7. Each replaced function: the live md5 equals this migration's body, the header states it; each new body with the
   `-- #227` lines removed (and the one replaced line restored) equals its previous body (C6's body-diff style).
8. Header rollback in a rolled-back transaction: the four md5s are back to the preflight values and the table is gone.
9. Apply file test. `role-matrix.test.ts`: the table with `reads: "editors"` and insert cases; nobody updates or deletes it.
   `share-field-classes.test.ts`: classify the new table `"unused"`.

**Existing tests to update (not loosen):** `capacity-factors.test.ts` L395–402 compares the **live** `team_capacity` md5
with C6's post-apply value: keep the check that C6's header states the md5 of C6's body, and compare the live md5 with the
latest migration defining it (this one). `team-capacity.test.ts` L126: the factor keys gain `items`.

**PostgREST** (new `packages/mcp/test/postgrest-capacity-factor-calibration.test.ts`, copy
`postgrest-dataset-imports.test.ts`): an editor reads a time log with a person column, matches people, computes
proposals with `proposePersonTimes`, records and applies one; a member reads the calibration row and finds no person id
in it and no rows in `capacity_factor_proposals`.

**App unit** (`apps/web/test/calibration.test.ts`, add): `storedResults` drops `capacity_factors`; `parseApplyRequest`
rebuilds factor proposals and refuses a bad one, a key for another person than its target, and a proposal outside
0.5–2; `applySummary` counts factor keys apart and words `switched_off`; `initiallyTickedFactor`; `groupByPerson` keeps the
people order; `personTimesSetup` gives `hidden` for a member bundle, `off` with the switch off, `on` otherwise.
`people.test.ts`: a measured row with `items` 12 is shown, with `items` 4 is not.

**Source tests** (the C6 style): no file under `apps/web/src` sorts per-person proposals by value (no
`sort(` whose comparator reads `proposed`, `measured` or `factor`); `calibration-panel.tsx` renders the per-person part
only under `state === "on"`.

**Browser** (`csv-import-browser.test.ts`, the harness gains `personTimes` and Northbeam people):
1. Editor, switch on, a time log with a person column: "Match the people" appears with suggestions; after "Use these
   rows" the "Per-person times" section shows one closed `<details>` per person; opening one shows the step rows with
   "Measured: … × normal"; Apply records them (assert the request carries `capacityFactors` and the factor keys, and
   `results` has no person id).
2. Editor, switch off: the "Switch Per-person times on" line, no section, no matching.
3. Member (`hidden`): no "Match the people", no section, and the page text contains none of the file's person names and
   no "× normal".
4. No page errors; at 400 px no horizontal scroll with a person open.
Screenshots per builder-brief (light and dark, 1440 and 400 px) of the section with one person open, from the harness.

---

## Out of scope

- Proposing "Every step" times (Q5); proposing from deals, jobs or servicing logs (no hands-on hours).
- Showing a person's proposals to that person (Q7).
- Storing any person name from a file, or remembering people matches between imports (C1 Q7's rule).
- Any ranking, team average, comparison view or chart of per-person times. **Never.**
- Re-running a past calibration's per-person proposals from its history (the existing history has no re-apply).
- MCP tools; share and play links; AI.
- `record_calibration` (row 50), `record_client_calibration`, `save_fields`, the `calibrations` trigger, engine
  simulation, goldens.
- #228 and #230 work; they are separate branches.

## Done when

- [ ] Engine `person-times.ts` with tests; `calibrate` unchanged in output.
- [ ] Import helpers and the step-log person column, with tests; existing import tests unchanged.
- [ ] Migration `20261227000000_calibrate_capacity_factors.sql`: header (decisions, privacy design, order, preflight 0–4
      with the four md5s, post-apply with the new md5s, runnable full rollback). Apply file. `bootstrap.sql` regenerated,
      `database.types.ts` hand-edited. Row 71 in `docs/production-migrations.md`, "not yet applied".
- [ ] Owners and editors with the switch on see, tick and apply per-person times; applied ones are `measured` with the
      dataset and calibration, and show "measured from N visits" in Settings and on the People page.
- [ ] Members and viewers never see a per-person proposal, and nothing members can read holds one (tested in the DB,
      over PostgREST and in the browser).
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build` green locally.
- [ ] Docs: PRD §6.3.7 "Measured in #227" note (the 10-visit rule, owners and editors only, the side table); §6.6 one line;
      PRD D45 (C1's decisions) gains a line that person columns of step logs and time logs are now matched for per-person
      times by owners and editors (#227), superseding Q4 there; `CONTEXT.md` "Per-person time" entry gains "measured".
- [ ] PR body: Summary, Evidence, Merge Danger ("APPLY BEFORE DEPLOYING THE APP"); `Closes #227`; "Defaults taken".

---

## Open questions (each with the default the builder uses)

**Q1. "Against the step's distribution": against what exactly?** **Default: the mean hands-on time of all the step's
visits in the same log** (the value `calibrate` proposes as the step's work time). So the times of everyone in the log
average back to the step's normal time, and a person's time stays right whether or not the step's own work time is
applied. The alternative, the model's current work hours, mixes "the step's time is off" with "this person differs".

**Q2. Which files.** **Default: stage histories (step logs) with the new Person column, and time logs.** Deals and jobs
have no hands-on hours.

**Q3. Minimum sample.** **Default: 10 visits by the person on the step (PRD §6.3.7), and 10 visits at the step in all.**

**Q4. Noise.** **Default: propose anything with enough visits, but don't pre-tick one within two standard errors of 1, one
outside 0.5–2 (proposed at the bound), or one replacing an entered time.**

**Q5. "Every step" times.** **Default: not proposed.** Per-step times only; a person's average over steps would mix steps
of different lengths.

**Q6. Where proposals are kept.** **Default: a new table read only by owners, editors and agency admins**, because
`calibrations` is read by every member. Applied keys are row ids.

**Q7. Does the person see their own proposal?** D20 says a factor is visible to the person. **Default: no: proposals are
owners' and editors' only (as instructed); the person sees the applied time, marked measured, on their People page.**

**Q8. Switch.** **Default: proposals only with Per-person times switched on (#41 decision 4), checked in the page, at
record time and at apply time.**

**Q9. The demo.** **Default: no per-person part in the demo** (`hidden`): its switch is off and its samples aren't
matched to Northbeam's people. Browser tests use the harness.

**Q10. History counts members can see.** **Default: members see the applied count without per-person times**; owners and
editors see " and N per-person times".
