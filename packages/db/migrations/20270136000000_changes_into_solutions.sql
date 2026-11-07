-- Changes become part of a process version (D53; docs/plans/capacity/eng-changes-into-solutions-brief.md, Part A).
--
-- An automation or augmentation (a "change": which part of which steps it takes away or speeds up, with adoption, ramp-up, tiers and a monthly cost)
-- used to be a workspace row (`capacity_changes`) that the Sandbox switched on from a month. It is now part of a solution's version of its process:
-- `solutions.step_changes`. The Sandbox runs it by picking that version on the company map, from a month (the version's month is the change's start).
--
-- What this does, in order:
--   1. `private.is_step_changes(jsonb)` (and `private.is_step_change`) and `solutions.step_changes jsonb not null default '[]'`, checked by it. Each element is
--      { id?, name, kind, effects, adoption, ramp_months, tiers?, cost_monthly? }: the shape `capacity_changes` checks, with an optional uuid `id`
--      (the engine's id for the change; the move keeps the old row's id). At most 40 changes, 100000 bytes.
--   2. `authenticated` may update `solutions.step_changes` (a column grant beside name, notes and status); row-level security still decides who.
--      The editor (Part B) writes it.
--   3. The move. For each `capacity_changes` row and each live, un-archived process whose LIVE version holds steps its effects point at, one solution:
--      named after the change, status `testing`, a copy of that live version (`steps`, `edges`, `base_revision_id`, as `save_solution` stores it),
--      `step_changes` = the one change with only the effects on that process's steps, `changed_step_ids` = those steps, and a `solution_issues` row
--      for the change's `issue_id` when the issue can take one (below). `created_at` and `created_by` are the change's.
--      - Effects on steps that are not in any live version (deleted, or only in a draft) are dropped. A change with none left makes no solution.
--        Both counts are in the notice.
--      - The issue link follows the app's own rules (private.solution_issues_before_insert): not a detection, and about the solution's process (its
--        `process_id` or one of its links). A link the rules refuse is skipped (counted); the solution is still made. The link is a record: the two
--        solution_issues insert triggers are off for it, so NO issue changes status and none logs a `solution_tested` event (an open issue stays open,
--        a resolved one stays resolved).
--   4. `capacity_changes` stays, READ-ONLY, for one release (a table comment says it goes): the insert and update policies are dropped (the select
--      and delete policies stay, so a workspace can still be cleaned up; foreign-key actions bypass row security). Nothing reads it after this
--      package. A backup restore sends no changes (`import_workspace_bundle` is not redefined: an empty section needs no row-level permission).
--
-- Safe on a database that holds real data: nothing is deleted or rewritten except the two dropped policies and the added column; the move only
-- inserts solutions and links, changing no issue; one transaction.
--
-- Preflight:    select count(*) from public.schema_migrations where version >= '20270136000000';   -- expect 0
--               select count(*) from public.capacity_changes;                                         -- how many changes there are to move
-- Post-apply checks (the notice says the same in numbers):
--               select count(*) from public.solutions where step_changes <> '[]';                      -- = solutions made (plus any made since)
--               select s.name, p.name as process, jsonb_array_length(s.step_changes) as changes
--                 from public.solutions s join public.processes p on p.id = s.process_id where s.step_changes <> '[]' order by 1;
--               -- every change is in exactly the solutions of the processes its (live) steps belong to:
--               select c.name, count(s.id) as solutions from public.capacity_changes c
--                 left join public.solutions s on s.workspace_id = c.workspace_id and s.step_changes -> 0 ->> 'id' = c.id::text group by 1 order by 1;
--               select count(*) from public.solution_issues l join public.solutions s on s.id = l.solution_id where s.step_changes <> '[]';
--               select policyname from pg_policies where tablename = 'capacity_changes';              -- expect read and delete only
-- ROLLBACK (as the table owner, one transaction; solutions made by hand since keep their rows but lose their step changes):
--   begin;
--   delete from public.solutions s where s.step_changes <> '[]' and s.step_changes -> 0 ? 'id'
--     and exists (select 1 from public.capacity_changes c where c.workspace_id = s.workspace_id and c.id::text = s.step_changes -> 0 ->> 'id');  -- the moved solutions (their links go with them)
--   revoke update (step_changes) on public.solutions from authenticated;
--   alter table public.solutions drop column step_changes;
--   drop function private.is_step_changes(jsonb);
--   drop function private.is_step_change(jsonb);
--   comment on table public.capacity_changes is null;
--   create policy "insert capacity_changes" on public.capacity_changes for insert to authenticated with check (public.can_edit_workspace(workspace_id));
--   create policy "update capacity_changes" on public.capacity_changes for update to authenticated using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
--   delete from public.schema_migrations where version = '20270136000000';
--   commit;

-- 1. The shape of a solution's step changes. One change first (a CASE, so each test runs only after the ones before it passed), then the list.
create or replace function private.is_step_change(x jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(x) is distinct from 'object' then false
    when not coalesce(x ?& array['name', 'kind', 'effects', 'adoption', 'ramp_months'], false) then false
    when exists (select 1 from pg_catalog.jsonb_object_keys(x) k where k <> all (array['id', 'name', 'kind', 'effects', 'adoption', 'ramp_months', 'tiers', 'cost_monthly'])) then false
    when pg_catalog.jsonb_typeof(x -> 'name') is distinct from 'string' then false
    when pg_catalog.char_length(pg_catalog.btrim(x ->> 'name')) not between 1 and 200 then false
    when not coalesce((x ->> 'kind') = any (array['automation', 'augmentation']), false) then false
    when not private.is_step_change_effects(x -> 'effects') then false
    when pg_catalog.jsonb_array_length(x -> 'effects') < 1 then false
    when pg_catalog.jsonb_typeof(x -> 'adoption') is distinct from 'number' then false
    when not coalesce((x ->> 'adoption')::numeric between 0 and 1, false) then false
    when pg_catalog.jsonb_typeof(x -> 'ramp_months') is distinct from 'number' then false
    when not coalesce((x ->> 'ramp_months')::numeric between 0 and 24 and (x ->> 'ramp_months')::numeric = pg_catalog.trunc((x ->> 'ramp_months')::numeric), false) then false
    when x ? 'id' and (pg_catalog.jsonb_typeof(x -> 'id') is distinct from 'string'
         or (x ->> 'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then false
    when x ? 'tiers' and pg_catalog.jsonb_typeof(x -> 'tiers') <> 'null' and pg_catalog.jsonb_typeof(x -> 'tiers') <> 'array' then false
    when x ? 'tiers' and pg_catalog.jsonb_typeof(x -> 'tiers') = 'array' and (
           pg_catalog.jsonb_array_length(x -> 'tiers') not between 1 and 20
           or exists (select 1 from pg_catalog.jsonb_array_elements(x -> 'tiers') t where pg_catalog.jsonb_typeof(t.value) <> 'string')) then false
    when x ? 'cost_monthly' and pg_catalog.jsonb_typeof(x -> 'cost_monthly') <> 'null' and pg_catalog.jsonb_typeof(x -> 'cost_monthly') <> 'number' then false
    when x ? 'cost_monthly' and pg_catalog.jsonb_typeof(x -> 'cost_monthly') = 'number' and not ((x ->> 'cost_monthly')::numeric between 0 and 10000000) then false
    else true
  end;
$$;

create or replace function private.is_step_changes(c jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(c) is distinct from 'array' then false
    when pg_catalog.jsonb_array_length(c) > 40 then false
    when pg_catalog.octet_length(c::text) > 100000 then false
    else not exists (select 1 from pg_catalog.jsonb_array_elements(c) x where not private.is_step_change(x.value))
  end;
$$;

alter table public.solutions
  add column step_changes jsonb not null default '[]' constraint solutions_step_changes check (private.is_step_changes(step_changes));
comment on column public.solutions.step_changes is
  'Automations and augmentations in this version of the process (D53): [{ id?, name, kind, effects, adoption, ramp_months, tiers?, cost_monthly? }]. The Sandbox runs them from the month the version is picked.';

-- 2. The editor writes it (row-level security still decides who).
grant update (step_changes) on public.solutions to authenticated;

-- 3. The move.
do $$
declare
  n_changes integer;
  n_solutions integer := 0;
  n_no_process integer := 0;
  n_dropped integer := 0;
  n_linked integer := 0;
  n_skipped integer := 0;
  n_no_issue integer := 0;
begin
  select count(*) into n_changes from public.capacity_changes;

  -- One row per effect with the live process its step belongs to (null: the step is in no live version).
  create temporary table _cc_effects on commit drop as
  select c.id as change_id, e.ord, e.value as effect, p.id as process_id, p.live_revision_id
    from public.capacity_changes c
    cross join lateral pg_catalog.jsonb_array_elements(c.effects) with ordinality e(value, ord)
    left join lateral (
      select p.id, p.live_revision_id
        from public.steps s
        join public.processes p on p.id = s.process_id and p.live_revision_id = s.revision_id
       where s.id = (e.value ->> 'step')::uuid and p.workspace_id = c.workspace_id and p.archived_at is null and not p.is_company
    ) p on true;

  select count(*) into n_dropped from _cc_effects where process_id is null;
  select count(*) into n_no_process from public.capacity_changes c where not exists (select 1 from _cc_effects x where x.change_id = c.id and x.process_id is not null);

  create temporary table _cc_made (solution_id uuid primary key, issue_id uuid, process_id uuid, workspace_id uuid, created_by uuid) on commit drop;

  with groups as (
    select x.change_id, x.process_id, x.live_revision_id,
           pg_catalog.jsonb_agg(x.effect order by x.ord) as effects,
           pg_catalog.jsonb_agg(distinct x.effect ->> 'step') as step_ids
      from _cc_effects x
     where x.process_id is not null
     group by x.change_id, x.process_id, x.live_revision_id
  ), made as (
    insert into public.solutions (workspace_id, process_id, base_revision_id, name, steps, changed_step_ids, status, step_changes, created_at, created_by)
    select c.workspace_id, g.process_id, g.live_revision_id, c.name,
           pg_catalog.jsonb_build_object(
             'steps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) - 'revision_id' - 'workspace_id' - 'process_id' order by s.id) from public.steps s where s.revision_id = g.live_revision_id), '[]'::jsonb),
             'edges', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) - 'revision_id' - 'workspace_id' - 'process_id' order by e.id) from public.edges e where e.revision_id = g.live_revision_id), '[]'::jsonb),
             'entry_step_id', null),
           g.step_ids, 'testing',
           pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
             'id', c.id, 'name', c.name, 'kind', c.kind, 'effects', g.effects, 'adoption', c.adoption, 'ramp_months', c.ramp_months,
             'tiers', pg_catalog.to_jsonb(c.tiers), 'cost_monthly', c.cost_monthly)),
           c.created_at, c.created_by
      from groups g
      join public.capacity_changes c on c.id = g.change_id
     order by c.created_at, c.id, g.process_id
    returning id, workspace_id, process_id, created_by, step_changes -> 0 ->> 'id' as change_id
  )
  insert into _cc_made (solution_id, issue_id, process_id, workspace_id, created_by)
  select m.id, c.issue_id, m.process_id, m.workspace_id, m.created_by
    from made m join public.capacity_changes c on c.id = m.change_id::uuid;
  get diagnostics n_solutions = row_count;

  select count(*) into n_no_issue from _cc_made where issue_id is null;

  -- The links the app's rules take: not a detection, and about the solution's process.
  create temporary table _cc_links on commit drop as
  select m.solution_id, m.issue_id, m.workspace_id, m.created_by, i.status
    from _cc_made m
    join public.issues i on i.id = m.issue_id and i.workspace_id = m.workspace_id
   where i.source is distinct from 'detected'
     and (i.process_id = m.process_id or exists (select 1 from public.issue_links l where l.issue_id = i.id and l.workspace_id = i.workspace_id and l.process_id = m.process_id));
  select count(*) into n_skipped from _cc_made m where m.issue_id is not null and not exists (select 1 from _cc_links k where k.solution_id = m.solution_id);

  -- Linked as a record: the insert checks (applied by hand in _cc_links above) and the "tested" log are off, so no issue changes status or gets an event from this move.
  alter table public.solution_issues disable trigger solution_issues_before_insert;
  alter table public.solution_issues disable trigger solution_issue_tested;
  insert into public.solution_issues (solution_id, issue_id, workspace_id, created_by)
  select k.solution_id, k.issue_id, k.workspace_id, k.created_by from _cc_links k;
  get diagnostics n_linked = row_count;
  alter table public.solution_issues enable trigger solution_issues_before_insert;
  alter table public.solution_issues enable trigger solution_issue_tested;

  raise notice 'changes into solutions: % changes read; % solutions made; % issue links; % links skipped (detection or another process); % solutions with no issue; % effects dropped (step not in a live version); % changes with no solution',
    n_changes, n_solutions, n_linked, n_skipped, n_no_issue, n_dropped, n_no_process;
end;
$$;

-- 4. capacity_changes: read-only for one release.
drop policy "insert capacity_changes" on public.capacity_changes;
drop policy "update capacity_changes" on public.capacity_changes;
comment on table public.capacity_changes is
  'LEGACY, read-only, goes next release: automations and augmentations moved into solutions.step_changes (D53, migration 20270136000000). Nothing reads this table.';
