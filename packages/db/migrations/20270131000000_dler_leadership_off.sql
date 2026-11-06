-- DLER no longer counts directors and managers (capacity Q14, docs/plans/capacity/q14-people-roles-brief.md; decision D48).
--
-- What it does: sets `settings.dler_includes_leadership` to false in every workspace where it is true or missing. The key's check
-- (`workspaces_dler_includes_leadership`, boolean or null) is not touched. The app now reads a missing key as false, so this makes the
-- stored value say what the app does. A null counts as unset and becomes false too, so every
-- workspace ends with a boolean; a workspace already false is left alone.
--
-- Preflight: select count(*) from public.workspaces where coalesce(settings -> 'dler_includes_leadership', 'null'::jsonb) <> 'false'::jsonb;
--     Locks: one pass over public.workspaces (a few rows).
-- Post-apply checks: select settings -> 'dler_includes_leadership' as v, count(*) from public.workspaces group by 1; expect only false.
--
-- ROLLBACK (run as one transaction). The previous values are kept in a side table so each workspace gets its own back:
--
--   begin;
--   update public.workspaces w
--      set settings = case when b.prev is null then w.settings - 'dler_includes_leadership'
--                          else jsonb_set(w.settings, '{dler_includes_leadership}', b.prev) end
--     from private.dler_leadership_backup b where b.workspace_id = w.id;
--   drop table private.dler_leadership_backup;
--   commit;

create table private.dler_leadership_backup (
  workspace_id uuid primary key,
  prev jsonb -- null: the key was missing
);
revoke all on private.dler_leadership_backup from public;

insert into private.dler_leadership_backup (workspace_id, prev)
select id, settings -> 'dler_includes_leadership'
from public.workspaces
where coalesce(settings -> 'dler_includes_leadership', 'null'::jsonb) <> 'false'::jsonb;

update public.workspaces
set settings = jsonb_set(settings, '{dler_includes_leadership}', 'false'::jsonb)
where id in (select workspace_id from private.dler_leadership_backup);
