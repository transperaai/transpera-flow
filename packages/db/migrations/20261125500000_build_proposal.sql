-- Build a solution idea (issue #117, ticket A52, slice 2 of 2; PRD §7.1c).
--
-- "Build it" on a solution idea opens the Editor in solution mode with the idea's steps placed. Saving turns it into a real
-- solution through `public.save_solution` (A49), and the idea is marked `built`, in the same transaction, so an idea is never
-- built twice and a solution is never saved without the idea knowing. This adds the one function that does both:
--
--   * `public.build_proposal(p_proposal, p_workspace, p_process, p_base_revision, p_name, p_steps, p_changed, p_levers,
--     p_links)`: security invoker, so row-level security applies to everything it writes. It locks the proposal (it must be a
--     pending solution idea of that workspace), calls `save_solution` with the rest, then sets the proposal to `built` with
--     `applied = {solution_id}` and who and when. The decision columns change only here and in `review_proposals`: the guard
--     trigger (`private.suggestion_proposals_before_write`) is unchanged. An API-token request (the MCP server) can't build: a
--     person decides, as with `review_proposals`. The solution must be linked to the idea's own issue (`p_links` must name it), so
--     an idea can't be marked built by a solution that has nothing to do with it; `save_solution` then checks that issue is about
--     the solution's process.
--
-- The solution's origin is recorded on the idea (`applied.solution_id`), not on `solutions`, so the solutions table is not
-- touched. A solution made from an AI idea is one whose id is in `suggestion_proposals.applied ->> 'solution_id'` with status
-- `built`: A50's "Type: AI block" label can read it from there.
--
-- STRICTLY ADDITIVE: one function. No table, column, constraint, trigger or existing function is changed. Needs 20261122000000
-- (`save_solution`) and 20261124000000 (`suggestion_proposals`).
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   1. The function does not exist yet. Expect 0:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'build_proposal';
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261125500000';
--   3. The migrations it builds on are applied (solutions, suggestions_v2, source_links, and the one at 20261125000000). Expect 4 rows:
--        select version from supabase_migrations.schema_migrations where version in ('20261122000000', '20261124000000', '20261124500000', '20261125000000') order by 1;
--   4. save_solution and suggestion_proposals exist. Expect 2 rows:
--        select proname from pg_proc where pronamespace = 'public'::regnamespace and proname = 'save_solution'
--        union all select table_name from information_schema.tables where table_schema = 'public' and table_name = 'suggestion_proposals';
--   5. The table's columns, in order. Expect id,workspace_id,kind,title,detail,payload,evidence,note,issue_id,status,created_via,proposer_name,proposer_email,applied,review_note,reviewed_by,reviewed_at,created_at,updated_at,created_by:
--        select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'suggestion_proposals';
--   6. The two functions this one relies on are as reviewed. Expect save_solution 73793c55eefd0e3dd9d4ca7a3ff027e4 and suggestion_proposals_before_write 2ca045826e8dbfdb797d2147d8a84b8e:
--        select proname, md5(prosrc) from pg_proc where proname in ('save_solution', 'suggestion_proposals_before_write') order by 1;
--
-- Post-apply grant check (authenticated may execute it; anon and PUBLIC may not):
--        select grantee, privilege_type from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'build_proposal' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1;
--        select proacl from pg_proc where pronamespace = 'public'::regnamespace and proname = 'build_proposal';
--   Expect: one row, authenticated EXECUTE; and an ACL with an `authenticated=X/...` entry and no `anon=` and no `=X/...` (an entry with
--   an empty grantee is PUBLIC).
--
-- Rollback (run as one transaction; nothing existing was changed):
--
--   begin;
--   drop function if exists public.build_proposal(uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb);
--   delete from supabase_migrations.schema_migrations where version = '20261125500000';
--   commit;
--
-- Ideas already built stay `built` and keep their `applied.solution_id`; solutions they made stay.
--
-- Production data: none needed.

create function public.build_proposal(
  p_proposal uuid, p_workspace uuid, p_process uuid, p_base_revision uuid, p_name text, p_steps jsonb, p_changed jsonb,
  p_levers jsonb, p_links jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kind text;
  v_status text;
  v_issue uuid;
  result jsonb;
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Ideas are built by a person in the app, not over the API' using errcode = '42501';
  end if;
  select x.kind, x.status, x.issue_id into v_kind, v_status, v_issue
    from public.suggestion_proposals x where x.id = p_proposal and x.workspace_id = p_workspace for update;
  if not found then
    raise exception 'build_proposal: no such idea' using errcode = '42501';
  end if;
  if v_kind <> 'solution_idea' then
    raise exception 'build_proposal: only a solution idea can be built' using errcode = '22023';
  end if;
  if v_status <> 'pending' then
    raise exception 'build_proposal: that idea has already been dealt with' using errcode = '22023';
  end if;
  -- The solution must be for the idea's own issue: otherwise any solution could be passed off as built from it.
  if jsonb_typeof(p_links) is distinct from 'array' or not exists (
    select 1 from jsonb_array_elements(p_links) l where l ->> 'issue_id' = v_issue::text) then
    raise exception 'build_proposal: the solution must be linked to the idea''s issue' using errcode = '22023';
  end if;

  -- The solution, as A49 saves it (its own checks and row-level security apply).
  result := public.save_solution(p_workspace, p_process, p_base_revision, p_name, p_steps, p_changed, p_levers, p_links);

  perform set_config('transpera.reviewing_proposals', 'on', true);
  update public.suggestion_proposals x
    set status = 'built', applied = jsonb_build_object('solution_id', result ->> 'id'), reviewed_by = auth.uid(), reviewed_at = now()
  where x.id = p_proposal;
  perform set_config('transpera.reviewing_proposals', '', true);
  return result;
end;
$$;

revoke all on function public.build_proposal(uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.build_proposal(uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb) to authenticated;
