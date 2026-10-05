-- B13 follow-ups (issue #166): an import that is all or nothing, and a limit on link fetches.
--
-- 1. `public.import_new_process(p_workspace, p_nodes, p_adopt)`: SECURITY INVOKER (RLS decides, as for every other write the
--    app makes as the signed-in user). Today an upload writes the process, its draft, its steps and its edges in separate
--    requests, so a failure part-way leaves a half-made process that then blocks a retry by name. This writes the new process,
--    its draft and its steps and edges (and those of any child processes the import creates, and the existing processes it
--    moves inside a step) in ONE transaction, from a plan the caller has already computed and checked. `p_nodes` is a jsonb
--    array, parents first, each `{id, parent_id, name, kind, entity_name, description, steps: [...], edges: [...]}`; `p_adopt` is
--    `[{id, parent_id}]`. Steps and edges are rows of those tables as the app would insert them; their revision, workspace and
--    process columns are set here, and a group's first step is set after all its steps are in. The draft is opened through
--    `public.open_draft`, so everything that runs on a normal write (triggers, audit, company-map checks, RLS) runs here too.
--    Returns `[{process_id, revision_id, number}]`, one per node. Nothing existing is changed except the parent of an adopted
--    process.
--
-- 2. `public.take_link_fetch()`: a per-user limit on fetching a page by link (the upload's link preview), 10 a minute. SECURITY
--    DEFINER with an empty search_path, so it can only touch the caller's own counter (`auth.uid()`; not signed in is refused)
--    in `private.link_fetch_limits`, a table clients cannot read or write. Fixed window: the first fetch opens a minute, the
--    eleventh inside it is refused. Returns 0 when the fetch is allowed (and counted), else the seconds until the next
--    allowed one. Works on any host (the count is in Postgres, not in a server's memory). One row per user, never more.
--
-- STRICTLY ADDITIVE: one table (private), two functions. Nothing existing is changed.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   1. Neither function nor the table exists. Expect 0, 0:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('import_new_process', 'take_link_fetch');
--        select count(*) from pg_class where relnamespace = 'private'::regnamespace and relname = 'link_fetch_limits';
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261128000000';
--   3. What the import relies on exists (open_draft, can_edit_workspace). Expect 2:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('open_draft', 'can_edit_workspace');
--   4. The private schema exists. Expect 1:
--        select count(*) from pg_namespace where nspname = 'private';
--
-- Post-apply grant check (authenticated may execute both; anon and PUBLIC may not; clients have nothing on the table):
--        select routine_name, grantee, privilege_type from information_schema.routine_privileges where routine_schema = 'public' and routine_name in ('import_new_process', 'take_link_fetch') and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1, 2;
--        select proname, proacl from pg_proc where pronamespace = 'public'::regnamespace and proname in ('import_new_process', 'take_link_fetch');
--        select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'private' and table_name = 'link_fetch_limits' and grantee in ('anon', 'authenticated', 'PUBLIC');
--   Expect: two rows, authenticated EXECUTE for each; each ACL has an `authenticated=X/...` entry and no `anon=` and no `=X/...`
--   (an entry with an empty grantee is PUBLIC); no rows from the last query.
--
-- Rollback (run as one transaction; nothing existing was changed):
--
--   begin;
--   drop function if exists public.import_new_process(uuid, jsonb, jsonb);
--   drop function if exists public.take_link_fetch();
--   drop table if exists private.link_fetch_limits;
--   delete from supabase_migrations.schema_migrations where version = '20261128000000';
--   commit;
--
-- Roll the app back (or redeploy the previous one) first: it calls both. Processes already imported stay as they are.
--
-- Production data: none needed.

-- ---------------------------------------------------------------------------
-- All-or-nothing import
-- ---------------------------------------------------------------------------

create function public.import_new_process(p_workspace uuid, p_nodes jsonb, p_adopt jsonb default '[]') returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  node jsonb;
  adopt jsonb;
  draft jsonb;
  rev uuid;
  proc uuid;
  rows_json jsonb;
  cols text;
  revisions jsonb := '{}';
  result jsonb := '[]';
begin
  if p_workspace is null or jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes) not between 1 and 200
    or jsonb_typeof(coalesce(p_adopt, '[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_adopt, '[]')) > 200 then
    raise exception 'import_new_process: p_nodes must be an array of 1 to 200 processes and p_adopt an array' using errcode = '22023';
  end if;

  -- 1. Every process and its draft, parents first (a child names its parent).
  for node in select value from jsonb_array_elements(p_nodes) loop
    proc := (node ->> 'id')::uuid;
    insert into public.processes (id, workspace_id, name, kind, entity_name, description, source, parent_process_id)
    values (proc, p_workspace, node ->> 'name', node ->> 'kind', node ->> 'entity_name', node ->> 'description', 'import', (node ->> 'parent_id')::uuid);
    draft := public.open_draft(proc);
    if draft ->> 'status' is distinct from 'ok' then
      raise exception 'import_new_process: could not open a draft' using errcode = '42501';
    end if;
    revisions := revisions || jsonb_build_object(proc::text, draft ->> 'revision_id');
    result := result || jsonb_build_object('process_id', proc, 'revision_id', draft ->> 'revision_id', 'number', (draft ->> 'number')::int);
  end loop;

  -- 2. Existing processes that move inside a step of the new ones.
  for adopt in select value from jsonb_array_elements(coalesce(p_adopt, '[]')) loop
    update public.processes p set parent_process_id = (adopt ->> 'parent_id')::uuid
    where p.id = (adopt ->> 'id')::uuid and p.workspace_id = p_workspace;
    if not found then
      raise exception 'import_new_process: a process to move inside another was not found' using errcode = '42501';
    end if;
  end loop;

  -- 3. Each process's steps (a group's first step is set once they are all in), then its edges.
  for node in select value from jsonb_array_elements(p_nodes) loop
    proc := (node ->> 'id')::uuid;
    rev := (revisions ->> proc::text)::uuid;

    select coalesce(jsonb_agg(s.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'entry_step_id', null)), '[]')
      into rows_json from jsonb_array_elements(coalesce(node -> 'steps', '[]')) s;
    if jsonb_array_length(rows_json) > 0 then
      select string_agg(quote_ident(k), ', ') into cols from (select distinct jsonb_object_keys(r.value) k from jsonb_array_elements(rows_json) r) q;
      execute format('insert into public.steps (%1$s) select %1$s from jsonb_populate_recordset(null::public.steps, $1)', cols) using rows_json;
      update public.steps st set entry_step_id = (s.value ->> 'entry_step_id')::uuid
      from jsonb_array_elements(node -> 'steps') s
      where st.revision_id = rev and st.id = (s.value ->> 'id')::uuid and s.value ->> 'entry_step_id' is not null;
    end if;

    select coalesce(jsonb_agg(e.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc)), '[]')
      into rows_json from jsonb_array_elements(coalesce(node -> 'edges', '[]')) e;
    if jsonb_array_length(rows_json) > 0 then
      select string_agg(quote_ident(k), ', ') into cols from (select distinct jsonb_object_keys(r.value) k from jsonb_array_elements(rows_json) r) q;
      execute format('insert into public.edges (%1$s) select %1$s from jsonb_populate_recordset(null::public.edges, $1)', cols) using rows_json;
    end if;
  end loop;

  return result;
end;
$$;

revoke all on function public.import_new_process(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_new_process(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- A limit on link fetches, per user
-- ---------------------------------------------------------------------------

create table private.link_fetch_limits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  window_start timestamptz not null default now(),
  hits integer not null default 0
);

alter table private.link_fetch_limits enable row level security;
revoke all on private.link_fetch_limits from public, anon, authenticated;

-- 0 when this fetch is allowed (and counted); otherwise the whole seconds until the next one is.
create function public.take_link_fetch() returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  max_hits constant integer := 10;
  window_len constant interval := interval '1 minute';
  r private.link_fetch_limits;
begin
  if uid is null then
    raise exception 'take_link_fetch: sign in first' using errcode = '42501';
  end if;
  insert into private.link_fetch_limits as l (user_id, window_start, hits) values (uid, now(), 1)
  on conflict (user_id) do update set
    window_start = case when l.window_start <= now() - window_len then now() else l.window_start end,
    hits = case when l.window_start <= now() - window_len then 1 else l.hits + 1 end
  returning * into r;
  if r.hits <= max_hits then
    return 0;
  end if;
  return greatest(1, ceil(extract(epoch from (r.window_start + window_len - now()))))::integer;
end;
$$;

revoke all on function public.take_link_fetch() from public, anon, authenticated;
grant execute on function public.take_link_fetch() to authenticated;
