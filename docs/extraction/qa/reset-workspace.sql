-- Remove the Copperleaf Marketing (QA) workspace and everything in it: its
-- processes, sources, issues, memberships and company model
-- (issue #27; docs/extraction/qa/README.md). It touches only the workspace whose
-- slug is `copperleaf-qa`, and does nothing if there isn't one. API tokens that
-- pointed at it keep working and simply have no active workspace.
--
-- Run it in the Supabase SQL editor.

begin;

do $$
declare
  ws uuid;
begin
  select id into ws from public.workspaces where slug = 'copperleaf-qa';
  if ws is null then
    raise notice 'No workspace copperleaf-qa; nothing to remove.';
    return;
  end if;

  delete from public.workspaces where id = ws;
end $$;

commit;
