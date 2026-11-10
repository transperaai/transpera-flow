-- A block a solution holds a copy of can't be deleted, enforced in the database (security review: deleteBlock check-then-delete race).
--
-- `deleteBlock` (apps/web/src/app/w/[slug]/block-actions.ts) read the workspace's solutions, refused when one held a copy of the
-- block (a step whose `provenance.block` is the block's id), and then deleted it in a separate statement. A solution saved between
-- the two kept a copy of a block that was then gone. The rule now lives here, with row locks that order the two writes.
--
-- What it does:
--   1. `private.solution_block_ids(steps jsonb)`: the distinct block ids a solution's copy names (`steps.steps[*].provenance.block`,
--      strings only), as blockOfStep (apps/web/src/lib/blocks/blocks.ts) reads them. Immutable, no table access.
--   2. A BEFORE DELETE trigger on `public.blocks` (`private.refuse_used_block_delete`, security definer, so it sees every solution of
--      the workspace whatever the caller's row-level security): raises SQLSTATE 23503 'block is used by a solution: ...' when a
--      solution of the block's workspace holds a copy of it. Skipped when the workspace itself is gone (deleting a workspace cascades
--      to its blocks and solutions together). The delete has the block's row locked before the trigger runs, and each statement in the
--      trigger sees every committed solution.
--   3. A BEFORE INSERT OR UPDATE OF steps trigger on `public.solutions` (`private.lock_solution_blocks`, security definer): takes
--      FOR KEY SHARE on the blocks the new copy names. A solution being saved therefore waits for a block delete in progress (and then
--      finds it gone), and a block delete waits for a solution save in progress (and then sees the solution and refuses). Key share
--      does not block block updates (renames, edits), only deletes.
--   No data changes: existing rows are not touched; nothing is refused that the app did not already refuse.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270203000100';` expect 0, and 20270203000000 applied.
--     Locks: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on `blocks` and `solutions` briefly.
-- Post-apply checks: select tgname from pg_trigger where tgname in ('refuse_used_block_delete', 'lock_solution_blocks'); expect 2 rows.
--
-- ROLLBACK (run as one transaction):
--
--   begin;
--   drop trigger refuse_used_block_delete on public.blocks;
--   drop trigger lock_solution_blocks on public.solutions;
--   drop function private.refuse_used_block_delete();
--   drop function private.lock_solution_blocks();
--   drop function private.solution_block_ids(jsonb);
--   delete from public.schema_migrations where version = '20270203000100';
--   commit;

create function private.solution_block_ids(steps jsonb) returns uuid[]
language sql immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct (s -> 'provenance' ->> 'block')::uuid), '{}')
  from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(steps -> 'steps') = 'array' then steps -> 'steps' else '[]'::jsonb end) s
  where pg_catalog.jsonb_typeof(s -> 'provenance' -> 'block') = 'string'
    and (s -> 'provenance' ->> 'block') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

create function private.refuse_used_block_delete() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  used text;
begin
  -- Deleting the workspace takes its blocks and solutions with it.
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;
  select string_agg(s.name, ', ' order by s.name) into used
  from public.solutions s
  where s.workspace_id = old.workspace_id and old.id = any (private.solution_block_ids(s.steps));
  if used is not null then
    raise exception 'block is used by a solution: %', used using errcode = '23503';
  end if;
  return old;
end;
$$;

create trigger refuse_used_block_delete before delete on public.blocks
  for each row execute function private.refuse_used_block_delete();

create function private.lock_solution_blocks() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform 1 from public.blocks b where b.id = any (private.solution_block_ids(new.steps)) for key share;
  return new;
end;
$$;

create trigger lock_solution_blocks before insert or update of steps on public.solutions
  for each row execute function private.lock_solution_blocks();

revoke all on function private.solution_block_ids(jsonb) from public;
revoke all on function private.refuse_used_block_delete() from public;
revoke all on function private.lock_solution_blocks() from public;
