-- Solutions as their own thing (issue #114, ticket A49; decisions D18 amended by D25, D22).
--
-- A solution is a separate copy of a process with changed steps, plus optional lever changes. A process can have many.
-- One solution can solve several issues, with an automatic verdict against each issue's target and the user's own
-- verdict. Drafts stay single (D18): a process still has one live version and at most one draft, and a solution never
-- touches either. It is its own row, with its own copy of the steps.
--
-- What is new:
--
--   * `public.solutions`: workspace, the process it changes, the revision it was copied from (`base_revision_id`), its
--     name, the copy as one jsonb document (`steps`, the same shape as a block's bundle: `{steps, edges, entry_step_id}`,
--     step and edge rows without their revision, workspace and process; the whole map as the solution has it, so it can
--     be drawn and simulated without the revision it came from), `changed_step_ids` (the steps it added or changed, by
--     stable step id, so the map can show what is new), `lever_changes` (an array of scenario patches, "more leads",
--     "faster proposals"), the author and the date.
--   * `public.solution_issues`: which issues a solution solves. One row per (solution, issue), holding the automatic
--     verdict (`auto_verdict`: pass or fail against the issue's target, from the simulation; null when the target text
--     could not be turned into a number the simulation computes), how often it holds across the simulation's runs
--     (`holds_pct`, 0 to 100), a line saying what it was checked against, the user's own verdict (`user_verdict`) and
--     notes. Both tables carry the workspace and key their foreign keys on it, so a link cannot cross workspaces.
--   * Linking a solution to an issue moves the issue to Testing solutions and logs a `solution_tested` event. It reuses
--     A47's mechanism rather than a second one: an Open issue is updated to the stored status `in_progress` (see
--     packages/db/src/issue-status.ts), and A47's `issue_log` trigger writes the event; this migration's trigger then adds
--     the solution to that event's detail. An issue already being tested keeps its status, and a
--     `solution_tested` event is written for the new link in the same table.
--   * `public.save_solution(...)`: creates a solution and its links in one transaction (security invoker, so row-level
--     security applies to every write), so a solution is never saved without the link the person asked for.
--
-- Row-level security as the other workspace tables: every member of the workspace reads, owners, editors and agency
-- admins write (`can_edit_workspace`), `anon` has no access. Updates are limited by column grants: a solution's name and
-- notes, a link's user verdict and notes; everything else (the copy, the base revision, which issue, the automatic verdict)
-- is fixed when it is saved, so a link cannot be rewritten without the history logging it.
--
-- Checks in the database (before-insert triggers, so they hold for every writer, with plain messages):
--   * a solution's base revision must be a published or superseded revision of its process, never a draft. A draft can be
--     discarded, and a solution pointing at one would block that (D18: drafts stay single and are never a solution's base).
--     A superseded one is allowed so that publishing a new version while someone is mid-edit doesn't make their save fail;
--   * the checks run as the caller (security invoker), after a plain "you cannot edit this workspace" refusal, so someone outside
--     the workspace learns nothing about another workspace's issues or revisions from the error text;
--   * an issue can be linked only if it is about the solution's process (its own process, or one of its links), is not a
--     detection, and is still open or being tested (not resolved, won't fix or dismissed).
--
-- STRICTLY ADDITIVE: two tables, their indexes, triggers, policies, three trigger functions and one function. No existing
-- table, column, constraint or function is changed. It needs A47's `issue_events` and `issues` (applied before this) and
-- the `can_read_workspace`, `can_edit_workspace` and `set_updated_at` helpers. It creates the unique index on
-- process_revisions (id, process_id, workspace_id) only if A54 has not already.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   1. The new tables do not exist yet. Expect 0:
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('solutions', 'solution_issues');
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261122000000';
--   3. A47 is applied (its history table exists). Expect 1:
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'issue_events';
--   4. The helpers the policies and triggers use exist. Expect 3 rows:
--        select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('can_read_workspace', 'can_edit_workspace', 'set_updated_at');
--
-- Post-apply check (authenticated must show select, insert and delete only, with no table-level UPDATE; anon nothing):
--        select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name in ('solutions', 'solution_issues') order by 1, 2;
--        select table_name, column_name, grantee from information_schema.column_privileges where table_schema = 'public' and table_name in ('solutions', 'solution_issues') and privilege_type = 'UPDATE' and grantee = 'authenticated';
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop function if exists public.save_solution(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb);
--   drop table if exists public.solution_issues;   -- its trigger, policies and indexes go with it
--   drop function if exists private.solution_issue_tested();
--   drop function if exists private.solution_issues_before_insert();
--   drop table if exists public.solutions;         -- its trigger, policies and indexes go with it
--   drop function if exists private.solutions_before_write();
--   delete from supabase_migrations.schema_migrations where version = '20261122000000';
--   commit;
--
-- (The unique index process_revisions_id_process_workspace_key belongs to A54's migration and is left alone.)
-- Rolling back loses every solution and its verdicts; issues keep the status they were moved to and their history.
-- Production data: none needed (no rows means no solutions).

-- ---------------------------------------------------------------------------
-- Solutions
-- ---------------------------------------------------------------------------

create unique index if not exists process_revisions_id_process_workspace_key on public.process_revisions (id, process_id, workspace_id);

create table public.solutions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The process the solution changes.
  process_id uuid not null,
  -- The revision of that process the copy was made from (the live version when it was started).
  base_revision_id uuid not null,
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 200),
  notes text not null default '' check (pg_catalog.length(notes) <= 4000),
  -- The copy of the map: { "steps": [...], "edges": [...], "entry_step_id": null }. Stored apart from every draft (D18).
  steps jsonb not null
    check (
      pg_catalog.jsonb_typeof(steps) = 'object'
      and coalesce(pg_catalog.jsonb_typeof(steps -> 'steps'), '') = 'array'
      and coalesce(pg_catalog.jsonb_typeof(steps -> 'edges'), '') = 'array'
      and pg_catalog.octet_length(steps::text) <= 1000000
    ),
  -- Stable ids of the steps the solution added or changed against its base revision.
  changed_step_ids jsonb not null default '[]'
    check (pg_catalog.jsonb_typeof(changed_step_ids) = 'array' and pg_catalog.jsonb_array_length(changed_step_ids) <= 2000),
  -- Lever changes: an array of scenario patches ({"path": ..., "op": ..., "value": ...}), applied on top of the steps.
  lever_changes jsonb not null default '[]'
    check (pg_catalog.jsonb_typeof(lever_changes) = 'array' and pg_catalog.jsonb_array_length(lever_changes) <= 200
      and pg_catalog.octet_length(lever_changes::text) <= 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id),
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete cascade,
  -- No action (not restrict): deleting the process deletes its revisions and its solutions in one statement.
  foreign key (base_revision_id, process_id, workspace_id) references public.process_revisions (id, process_id, workspace_id)
);

create index on public.solutions (workspace_id, process_id);
create index on public.solutions (base_revision_id);

create trigger set_updated_at before update on public.solutions
  for each row execute function public.set_updated_at();

-- A solution's base is a published (or since superseded) revision of its process, never a draft (D18): discarding a draft
-- deletes its revision, which a solution pointing at it would block. Security invoker: it reads only what the caller can read, and
-- a caller who can't edit the workspace gets a plain permission error first (a session always has a user; a plain database
-- connection, as in migrations and tests, has none and is not asked).
create function private.solutions_before_write() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is not null and not coalesce(public.can_edit_workspace(new.workspace_id), false) then
    raise exception 'solutions: you cannot edit this workspace' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.process_revisions r
    where r.id = new.base_revision_id and r.process_id = new.process_id and r.workspace_id = new.workspace_id and r.status in ('published', 'superseded')
  ) then
    raise exception 'solutions: the base revision must be a published version of the process' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.solutions_before_write() from public, anon, authenticated;

create trigger solutions_before_write before insert or update of base_revision_id, process_id, workspace_id on public.solutions
  for each row execute function private.solutions_before_write();

create table public.solution_issues (
  solution_id uuid not null,
  issue_id uuid not null,
  workspace_id uuid not null,
  -- Pass or fail against the issue's target, from the simulation. Null: the target could not be checked (see auto_note).
  auto_verdict text check (auto_verdict in ('pass', 'fail')),
  -- How often it holds across the simulation's runs, in percent (the share of runs that meet the target).
  holds_pct integer check (holds_pct between 0 and 100),
  -- What it was checked against, in words: "Wait at Check fit: 3.1 h against under 4 hours".
  auto_note text not null default '' check (pg_catalog.length(auto_note) <= 1000),
  -- The user's own verdict, which is the final call, and their notes.
  user_verdict text check (user_verdict in ('pass', 'fail')),
  user_notes text not null default '' check (pg_catalog.length(user_notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  primary key (solution_id, issue_id),
  foreign key (solution_id, workspace_id) references public.solutions (id, workspace_id) on delete cascade,
  foreign key (issue_id, workspace_id) references public.issues (id, workspace_id) on delete cascade
);

create index on public.solution_issues (workspace_id, issue_id);

create trigger set_updated_at before update on public.solution_issues
  for each row execute function public.set_updated_at();

-- What may be linked: an issue about the solution's process that is still being worked on. Runs before row-level security
-- looks at the row, so the refusal says what is wrong (to someone who can edit the workspace, and so may read the issue).
create function private.solution_issues_before_insert() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  iss record;
  sol_process uuid;
begin
  if auth.uid() is not null and not coalesce(public.can_edit_workspace(new.workspace_id), false) then
    raise exception 'solutions: you cannot edit this workspace' using errcode = '42501';
  end if;
  select i.status, i.source, i.process_id into iss from public.issues i where i.id = new.issue_id and i.workspace_id = new.workspace_id;
  select s.process_id into sol_process from public.solutions s where s.id = new.solution_id and s.workspace_id = new.workspace_id;
  if iss is null or sol_process is null then
    return new;  -- the foreign keys refuse it
  end if;
  if iss.source = 'detected' then
    raise exception 'solutions: that issue is only a detection, so it cannot be linked' using errcode = '23514';
  end if;
  if iss.status not in ('open', 'in_progress') then
    raise exception 'solutions: that issue is closed, so it cannot be linked' using errcode = '23514';
  end if;
  if iss.process_id is distinct from sol_process and not exists (
    select 1 from public.issue_links l where l.issue_id = new.issue_id and l.workspace_id = new.workspace_id and l.process_id = sol_process
  ) then
    raise exception 'solutions: that issue is about another process' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.solution_issues_before_insert() from public, anon, authenticated;

create trigger solution_issues_before_insert before insert on public.solution_issues
  for each row execute function private.solution_issues_before_insert();

-- ---------------------------------------------------------------------------
-- Linking moves the issue to Testing solutions and logs it, through A47's mechanism
-- ---------------------------------------------------------------------------

create function private.solution_issue_tested() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  st text;
  sol_name text;
  extra jsonb;
  ev_id uuid;
begin
  select i.status into st from public.issues i where i.id = new.issue_id and i.workspace_id = new.workspace_id for update;
  -- A dismissed insight is not an issue: nothing to log.
  if st is null or st = 'dismissed' then
    return null;
  end if;
  select s.name into sol_name from public.solutions s where s.id = new.solution_id and s.workspace_id = new.workspace_id;
  extra := jsonb_build_object('solution_id', new.solution_id, 'solution', sol_name,
    'auto_verdict', new.auto_verdict, 'holds_pct', new.holds_pct);
  if st = 'open' then
    -- Open becomes Testing solutions (stored `in_progress`). A47's issue_log trigger writes the `solution_tested` event
    -- for that change; the solution is added to its detail.
    update public.issues set status = 'in_progress' where id = new.issue_id and workspace_id = new.workspace_id;
    select e.id into ev_id from public.issue_events e
      where e.issue_id = new.issue_id and e.kind = 'solution_tested' and e.tx = txid_current() order by e.seq desc limit 1;
  end if;
  if ev_id is not null then
    update public.issue_events set detail = detail || extra where id = ev_id;
  else
    -- Already being tested: the status stays, and the new link is still a solution tested.
    insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
      values (new.issue_id, new.workspace_id, 'solution_tested', auth.uid(), extra);
  end if;
  return null;
end;
$$;
revoke all on function private.solution_issue_tested() from public, anon, authenticated;

create trigger solution_issue_tested after insert on public.solution_issues
  for each row execute function private.solution_issue_tested();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.solutions enable row level security;
alter table public.solution_issues enable row level security;

create policy "read solutions" on public.solutions for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert solutions" on public.solutions for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update solutions" on public.solutions for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete solutions" on public.solutions for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

create policy "read solution_issues" on public.solution_issues for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert solution_issues" on public.solution_issues for insert to authenticated
  with check (public.can_edit_workspace(workspace_id)
    and not exists (select 1 from public.issues i where i.id = issue_id and i.source = 'detected'));
create policy "update solution_issues" on public.solution_issues for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete solution_issues" on public.solution_issues for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

-- Updates only to what a person edits later; the copy, the base, the issue and the automatic verdict are fixed once saved.
-- Supabase gives every new public table full privileges for anon, authenticated and service_role, so revoke first (as 20260930040000
-- does for api_tokens); a column grant only restricts anything once the table-level UPDATE is gone.
revoke all on public.solutions, public.solution_issues from anon, authenticated;
grant select, insert, delete on public.solutions, public.solution_issues to authenticated;
grant update (name, notes) on public.solutions to authenticated;
grant update (user_verdict, user_notes) on public.solution_issues to authenticated;

-- ---------------------------------------------------------------------------
-- save_solution: a solution and the issues it solves, in one transaction
-- ---------------------------------------------------------------------------

-- p_links is [{"issue_id": uuid, "auto_verdict": "pass"|"fail"|null, "holds_pct": 0..100|null, "auto_note": text}, ...].
-- Everything after p_steps is optional. Security invoker: row-level security applies to every write, and the caller must
-- be able to edit the workspace (checked first, so a viewer's save fails loudly). Returns the solution row as jsonb.
-- Nothing of the process, its live version or its draft is read for update or written.
create function public.save_solution(
  p_workspace uuid, p_process uuid, p_base_revision uuid, p_name text, p_steps jsonb,
  p_changed jsonb default '[]', p_levers jsonb default '[]', p_links jsonb default '[]')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  link jsonb;
  out jsonb;
begin
  if not coalesce(public.can_edit_workspace(p_workspace), false) then
    raise exception 'solutions: you cannot edit this workspace' using errcode = '42501';
  end if;
  if p_links is not null and jsonb_typeof(p_links) <> 'array' then
    raise exception 'solutions: links must be an array' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.process_revisions r
    where r.id = p_base_revision and r.process_id = p_process and r.workspace_id = p_workspace and r.status in ('published', 'superseded')
  ) then
    raise exception 'solutions: the base revision must be a published version of the process' using errcode = '23514';
  end if;
  insert into public.solutions (workspace_id, process_id, base_revision_id, name, steps, changed_step_ids, lever_changes)
    values (p_workspace, p_process, p_base_revision, p_name, p_steps, coalesce(p_changed, '[]'), coalesce(p_levers, '[]'))
    returning id into v_id;
  for link in select * from jsonb_array_elements(coalesce(p_links, '[]')) loop
    insert into public.solution_issues (solution_id, issue_id, workspace_id, auto_verdict, holds_pct, auto_note)
      values (v_id, (link ->> 'issue_id')::uuid, p_workspace, link ->> 'auto_verdict', (link ->> 'holds_pct')::integer,
        coalesce(link ->> 'auto_note', ''));
  end loop;
  select to_jsonb(s) into out from public.solutions s where s.id = v_id;
  return out;
end;
$$;
revoke all on function public.save_solution(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_solution(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb) to authenticated;
