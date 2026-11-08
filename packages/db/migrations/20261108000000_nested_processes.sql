-- Processes inside processes (docs/plans/redesign-plan.md A37; issue #102).
--
-- A step can hold its own steps. It is either a GROUP (a box of steps inside
-- one process: `kind = 'group'`, its steps point at it with `parent_step_id`)
-- or a CHILD PROCESS (`kind = 'subprocess'` with `child_process_id`; the child
-- is a process of its own, with its own page, versions and first principles,
-- whose `parent_process_id` is the holder's process). Nesting can go any depth.
-- The company map is the root: its steps are the processes with no parent, so
-- it needs no row. The engine simulates only the leaf steps (flattenModel in
-- packages/engine), so a group or child process changes the picture, not the
-- numbers.
--
-- Strictly additive:
--   * `public.processes.parent_process_id` (null for every existing process),
--     its composite foreign key (same workspace; deleting the parent makes the
--     child top-level again), checks `processes_not_own_parent`, and the
--     trigger `parent_is_acyclic` with `private.check_process_parent`;
--   * `public.steps.parent_step_id`, `entry_step_id` and `child_process_id`
--     (null for every existing step), their foreign keys, the checks
--     `steps_nesting_shape` and `steps_holder_has_no_work`, the unique index
--     `steps_one_holder_per_child`, and the constraint trigger
--     `nesting_is_a_tree` with `private.check_step_nesting`;
--   * the `steps_kind_check` check is widened to accept 'group' (a superset,
--     so every existing row still passes; Postgres can only widen a check by
--     dropping and re-adding it, in one transaction).
-- `open_draft` copies every column, so the new ones carry into drafts, and
-- `save_fields` is unchanged (the app and MCP write the new columns by insert).
--
-- The rules:
--   * A group or holder step has no work of its own (no role, person, hours,
--     rework, SLA or WIP): the engine would ignore them, so they are refused.
--   * A step sits in a group of its own revision, never in itself or below
--     itself; start and end steps stay at the top level of their process.
--   * A group's `entry_step_id` is one of its own steps. Checked when the
--     transaction commits, so a group and its steps can be written in any order.
--   * A child process's parent is the holder's process, so the holder graph
--     and the process tree can't disagree and no process can sit inside itself.
--
-- Preflight: none needed (adds nullable columns; every existing row passes).
--
-- Rollback (newest first; run in one transaction):
--
--   begin;
--   drop trigger nesting_is_a_tree on public.steps;
--   drop function private.check_step_nesting();
--   drop index public.steps_one_holder_per_child;
--   drop index public.steps_revision_parent_idx;
--   alter table public.steps
--     drop constraint steps_holder_has_no_work,
--     drop constraint steps_nesting_shape,
--     drop constraint steps_parent_step_fk,
--     drop constraint steps_entry_step_fk,
--     drop constraint steps_child_process_fk,
--     drop column parent_step_id,
--     drop column entry_step_id,
--     drop column child_process_id;
--   -- Refuses if a 'group' step exists: delete (or change) those steps first.
--   alter table public.steps drop constraint steps_kind_check;
--   alter table public.steps add constraint steps_kind_check
--     check (kind in ('task', 'wait', 'decision', 'subprocess', 'start', 'end'));
--   drop trigger parent_is_acyclic on public.processes;
--   drop function private.check_process_parent();
--   drop index public.processes_parent_idx;
--   alter table public.processes
--     drop constraint processes_not_own_parent,
--     drop constraint processes_parent_fk,
--     drop column parent_process_id;
--   delete from supabase_migrations.schema_migrations where version = '20261108000000';
--   commit;

-- ---------------------------------------------------------------------------
-- Child processes: the process tree
-- ---------------------------------------------------------------------------

alter table public.processes
  add column parent_process_id uuid,
  add constraint processes_parent_fk foreign key (parent_process_id, workspace_id)
    references public.processes (id, workspace_id) on delete set null (parent_process_id),
  add constraint processes_not_own_parent check (parent_process_id is null or parent_process_id <> id);

create index processes_parent_idx on public.processes (parent_process_id) where parent_process_id is not null;

create function private.check_process_parent() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A child process hangs from the step that holds it: moving it away from the process that holds it would leave
  -- that step pointing at a process that is no longer its child. Unlink the holder step first. Only live and draft
  -- revisions count: a superseded revision is history, and the loader reports it if it is ever simulated. (Deleting
  -- the parent process also lands here, through the foreign key's set null; the parent is gone by then, so that is
  -- allowed.)
  if tg_op = 'UPDATE' and old.parent_process_id is not null and old.parent_process_id is distinct from new.parent_process_id
     and exists (select 1 from public.processes p where p.id = old.parent_process_id)
     and exists (
       select 1 from public.steps s join public.process_revisions r on r.id = s.revision_id
       where s.child_process_id = new.id and r.process_id = old.parent_process_id and r.status in ('draft', 'published')
     ) then
    raise exception 'Process % is held by a step of its parent; remove that step before moving the process', new.name using errcode = '23514';
  end if;
  if new.parent_process_id is null then
    return new;
  end if;
  -- Walk up from the new parent: reaching this process means a loop.
  if exists (
    with recursive up(id) as (
      select new.parent_process_id
      union
      select p.parent_process_id from public.processes p join up on p.id = up.id where p.parent_process_id is not null
    )
    select 1 from up where id = new.id
  ) then
    raise exception 'A process cannot sit inside itself (%)', new.name using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger parent_is_acyclic before insert or update of parent_process_id on public.processes
  for each row execute function private.check_process_parent();

-- ---------------------------------------------------------------------------
-- Groups and holders: steps inside steps
-- ---------------------------------------------------------------------------

alter table public.steps drop constraint steps_kind_check;
alter table public.steps add constraint steps_kind_check
  check (kind in ('task', 'wait', 'decision', 'subprocess', 'group', 'start', 'end'));

alter table public.steps
  add column parent_step_id uuid,
  add column entry_step_id uuid,
  add column child_process_id uuid,
  -- Deferred, so a group and its steps can be inserted in any order within one transaction.
  add constraint steps_parent_step_fk foreign key (revision_id, parent_step_id)
    references public.steps (revision_id, id) on delete cascade deferrable initially deferred,
  add constraint steps_entry_step_fk foreign key (revision_id, entry_step_id)
    references public.steps (revision_id, id) on delete set null (entry_step_id) deferrable initially deferred,
  add constraint steps_child_process_fk foreign key (child_process_id, workspace_id)
    references public.processes (id, workspace_id) on delete set null (child_process_id),
  add constraint steps_nesting_shape check (
    (parent_step_id is null or (parent_step_id <> id and kind not in ('start', 'end')))
    and (entry_step_id is null or (kind = 'group' and entry_step_id <> id))
    and (child_process_id is null or kind = 'subprocess')
  ),
  -- The engine simulates the leaf steps only: a box or a child process has no work of its own to ignore.
  add constraint steps_holder_has_no_work check (
    not (kind = 'group' or child_process_id is not null)
    or (role_id is null and person_id is null and work_hours = 0 and wait_hours = 0 and rework_rate = 0
        and sla_hours is null and current_wip is null)
  );

create index steps_revision_parent_idx on public.steps (revision_id, parent_step_id) where parent_step_id is not null;
-- A child process sits in one step of one revision (otherwise its steps would be simulated twice).
create unique index steps_one_holder_per_child on public.steps (revision_id, child_process_id) where child_process_id is not null;

create function private.check_step_nesting() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cur public.steps;
  holder public.steps;
  entry public.steps;
  child public.processes;
  owner uuid;
begin
  -- Deferred: by commit the row may have been changed again or deleted, so check what is there now, not the row
  -- this event saw.
  select * into cur from public.steps s where s.revision_id = new.revision_id and s.id = new.id;
  if not found then
    return null;
  end if;

  if cur.parent_step_id is not null then
    select * into holder from public.steps s where s.revision_id = cur.revision_id and s.id = cur.parent_step_id;
    if holder.id is null or holder.kind <> 'group' then
      raise exception 'Step % can only sit inside a group', cur.name using errcode = '23514';
    end if;
    if exists (
      with recursive up(id) as (
        select cur.parent_step_id
        union
        select s.parent_step_id from public.steps s join up on s.revision_id = cur.revision_id and s.id = up.id where s.parent_step_id is not null
      )
      select 1 from up where id = cur.id
    ) then
      raise exception 'Step % cannot sit inside itself', cur.name using errcode = '23514';
    end if;
  end if;

  if cur.entry_step_id is not null then
    select * into entry from public.steps s where s.revision_id = cur.revision_id and s.id = cur.entry_step_id;
    if entry.id is null or entry.parent_step_id is distinct from cur.id then
      raise exception 'The first step of group % must be one of its own steps', cur.name using errcode = '23514';
    end if;
  end if;

  -- A step that is some group's first step stays in that group.
  if exists (select 1 from public.steps g where g.revision_id = cur.revision_id and g.entry_step_id = cur.id and g.id is distinct from cur.parent_step_id) then
    raise exception 'Step % is the first step of a group, so it must stay in that group (or change the group''s first step)', cur.name using errcode = '23514';
  end if;

  if cur.child_process_id is not null then
    select * into child from public.processes p where p.id = cur.child_process_id;
    -- The step's process comes from its revision, not from the step's own (denormalised) process_id.
    select r.process_id into owner from public.process_revisions r where r.id = cur.revision_id;
    if child.parent_process_id is distinct from owner then
      raise exception 'Process % must be a child of this step''s process to sit in step %', child.name, cur.name using errcode = '23514';
    end if;
  end if;

  -- A group that stops being a group can't leave steps inside it.
  if cur.kind <> 'group'
     and exists (select 1 from public.steps s where s.revision_id = cur.revision_id and s.parent_step_id = cur.id) then
    raise exception 'Step % holds steps, so it must stay a group', cur.name using errcode = '23514';
  end if;
  return null;
end;
$$;

-- Deferred to commit, so the rows a statement group writes may reference each other in any order.
create constraint trigger nesting_is_a_tree after insert or update of kind, parent_step_id, entry_step_id, child_process_id on public.steps
  deferrable initially deferred for each row execute function private.check_step_nesting();
