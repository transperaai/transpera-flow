-- The process library on the company map (issue #164, B12; PRD D26 and D39; ADR 0014).
--
-- The company map's editor gets a "Process library": a panel that places a process on the map as a LINKED card (a `subprocess`
-- holder step whose `child_process_id` is the process). The database already says who may hold whom (`private.holder_allows`:
-- a parent-less, non-company process of the same workspace, held once per revision by `steps_one_holder_per_child`), and
-- placing writes only the map's own draft, never the placed process. What was missing is the other half: taking a card OFF the
-- map. 20261127500000 refused it for everyone signed in "until the process library". This migration lets an editor delete a
-- card of the company map in a DRAFT. That removes the link only: the process, its versions and its steps are untouched.
--
-- ONE FUNCTION REPLACED, NO TABLE OR COLUMN CHANGE (additive in effect: it refuses less, and only in a draft):
--
--   * `private.company_holder_guard` (full copy of 20261127500000's, changed): a signed-in person may delete a card of the company
--     map, or a group holding cards, when the version is a DRAFT. A card in a published or superseded version is still refused (so is
--     everything else that edits those: `edit_drafts_only`), and so is unlinking by UPDATE (`child_process_id` set to null or to
--     another process, including through `save_fields`): a card leaves the map by being deleted from a draft, and publishing makes
--     it so. A group with no card inside is not this guard's business (it never refused one). The triggers `company_holder_guard`, `company_group_guard` and `company_holder_update_guard` are unchanged.
--
-- Placing needs nothing new: a card is an ordinary insert into the map's draft (RLS: editors of the workspace), refused by
-- `check_step_nesting` if the process is another workspace's, the company map itself, or inside another process, and by the unique
-- index `steps_one_holder_per_child` if it is already on this draft. Publishing a draft that took a card off leaves the process
-- parent-less and off the map ("Not on any map"); nothing writes to it.
--
-- PREFLIGHT (read-only; each must return the stated result before applying):
--   select count(*) from information_schema.routines where routine_schema = 'private' and routine_name = 'company_holder_guard';  -- 1
--   select count(*) from pg_trigger where tgrelid = 'public.steps'::regclass and tgname in ('company_holder_guard', 'company_group_guard', 'company_holder_update_guard') and not tgisinternal;  -- 3
--   select count(*) from supabase_migrations.schema_migrations where version > '20261129500000';  -- 0 (nothing later is applied; if one is, re-check it against this guard)
--
-- POST-APPLY CHECK: in a draft of a company map, as an editor, `delete from steps where id = <a card>` succeeds; the same delete
-- in the published version, and `update steps set child_process_id = null where id = <a card>` in the draft, are refused.
--
-- ROLLBACK (the function goes back to 20261127500000's body; no data to undo, drafts that already lack a card keep lacking it):
--
--   begin;
--   create or replace function private.company_holder_guard() returns trigger
--   language plpgsql
--   set search_path = ''
--   as $fn$
--   begin
--     if current_user in ('authenticated', 'anon') and private.company_signed_in()
--        and exists (select 1 from public.process_revisions r join public.processes p on p.id = r.process_id where r.id = old.revision_id and p.is_company)
--        and exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
--       if old.kind = 'group' and not exists (
--         with recursive d(id) as (
--           select s.id from public.steps s where s.revision_id = old.revision_id and s.parent_step_id = old.id
--           union
--           select s.id from public.steps s join d on s.revision_id = old.revision_id and s.parent_step_id = d.id
--         )
--         select 1 from public.steps s join d on s.id = d.id where s.revision_id = old.revision_id and s.child_process_id is not null
--       ) then
--         return case when tg_op = 'UPDATE' then new else old end;
--       end if;
--       raise exception 'Removing processes from the map comes with the process library' using errcode = '55000';
--     end if;
--     return case when tg_op = 'UPDATE' then new else old end;
--   end;
--   $fn$;
--   delete from supabase_migrations.schema_migrations where version = '20261129500000';
--   commit;

create or replace function private.company_holder_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') and private.company_signed_in()
     and exists (select 1 from public.process_revisions r join public.processes p on p.id = r.process_id where r.id = old.revision_id and p.is_company)
     and exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    -- A card is taken off the map by deleting it from a DRAFT (the process library's "Remove from the map"): the link goes, the
    -- process is not touched. Unlinking by update is never offered, and nothing in a published version changes.
    if tg_op = 'DELETE' and exists (select 1 from public.process_revisions r where r.id = old.revision_id and r.status = 'draft') then
      return old;
    end if;
    -- A group with no card inside is not about the map's processes at all: leave it to the other rules (a published version is
    -- never edited: `edit_drafts_only` says so), as before this migration.
    if old.kind = 'group' and not exists (
      with recursive d(id) as (
        select s.id from public.steps s where s.revision_id = old.revision_id and s.parent_step_id = old.id
        union
        select s.id from public.steps s join d on s.revision_id = old.revision_id and s.parent_step_id = d.id
      )
      select 1 from public.steps s join d on s.id = d.id where s.revision_id = old.revision_id and s.child_process_id is not null
    ) then
      return old;
    end if;
    raise exception 'A process is taken off the company map by removing its card in a draft' using errcode = '55000';
  end if;
  return case when tg_op = 'UPDATE' then new else old end;
end;
$$;

revoke all on function private.company_holder_guard() from public, anon, authenticated;
