-- Sources must link (issue #118, ticket A53, slice 1 of 2; PRD §8 screen 12 "Sources").
-- Apply after A52's 20261124000000 (this one is numbered 20261124500000 to sort after it).
--
-- Every source (transcript, notes, screenshot) must be linked to at least one thing: a process, a step, an insight, an
-- issue or a solution. A source can have several links. Today a source is only "cited" by the step values whose
-- provenance names it (`steps.provenance.<column>.evidence[].source_id`), and an issue lists its sources in
-- `issue_sources` (A47); neither says what a source is evidence for in one place, and a source nobody cited just sits
-- there. This adds that place and flags the sources that are in it nowhere.
--
-- What is new:
--
--   * `public.source_links`: one row per (source, target). `kind` is process, step, insight, issue or solution, and the
--     matching target column is set (a check keeps exactly the right ones):
--         process   process_id
--         step      step_id (a step's stable id, no foreign key: steps are keyed by revision) and the process it is in
--         insight   insight_key (a detection's key, like `spof:step:<id>`; an insight is computed from a run and is
--                   only stored once acknowledged, so it has no table to point at)
--         issue     issue_id
--         solution  solution_id
--     A link goes when its source, process, issue or solution is deleted (cascade). A step link whose step is later
--     removed from every version stays as a row: the app shows it as "a step that was removed". The same target can be
--     linked to a source only once.
--   * `public.add_source(workspace, source, links)`: creates a source and its links in one transaction (security
--     invoker, so row-level security applies to every write) and refuses an empty list of links with a plain message,
--     so a source added through it is never unlinked. (The table itself still takes a source with no link: the MCP
--     server's `add_source` and every source made before this migration have none, and show as "Not linked to anything
--     yet" until someone links them.)
--   * `public.unlinked_source_count(workspace)`: how many of the workspace's sources have no link (the sidebar's count).
--   * A before-insert trigger that refuses a step link whose step is not in the named process of the workspace.
--   * Two after-write triggers that keep links in step with citations from now on, so a source someone cites is never
--     flagged "Not linked" next to "Cited by N values": `link_cited_sources` on `steps` (after insert or update of
--     `provenance`: a step link for every source the step's values cite, from the inspector, the MCP server or an import) and
--     `link_issue_source` on `issue_sources` (after insert: the issue link). Both insert with `on conflict do nothing`, run as
--     the caller (security invoker) and only ever ADD links: removing a citation or an `issue_sources` row does not remove the
--     link, because a link is the person's explicit statement that the source is evidence for that thing. `private.cited_source_ids`
--     reads the source ids out of a step's provenance for the one-off copy below and the trigger, so both use one rule.
--   * `sources.kind` gains `data` (a data export, a spreadsheet): the check is widened, nothing else about `sources` changes.
--
-- Row-level security as the other workspace tables: every member of the workspace reads, owners, editors and agency admins
-- add and remove links (`can_edit_workspace`), `anon` has no access. A link is never updated: to change what a source is
-- linked to, remove the link and add another, so `authenticated` has no UPDATE. The grants start from nothing because a
-- Supabase project gives every new public table full privileges to anon and authenticated: `revoke all` first, then only
-- what the app needs (select, delete, and insert of the target columns; `id`, `created_at` and `created_by` are set by
-- defaults, so a link cannot claim another author).
--
-- Existing data is copied, not moved, and nothing existing changes: every step value that cites a source becomes a step
-- link (`provenance.<column>.evidence[].source_id`, in every revision of every process, one link per source and step
-- however many values cite it), and every `issue_sources` row becomes an issue link. Citations of a source that no longer
-- exists, or that belongs to another workspace, are skipped (there is nothing to link). Source ids are matched without regard
-- to case and stored as the database spells a uuid (lower case). The old provenance and `issue_sources` stay as they are and
-- keep working; later slices read the links.
--
-- EXPAND ONLY: one table, its indexes, triggers, policies and grants, three trigger functions, one helper function and two
-- functions, and one widened check (`sources_kind` also allows `data`; every existing row still satisfies it). No existing
-- table, column or function is changed, and no row is rewritten.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   P1. The new table and functions do not exist yet. Expect 0 and 0:
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'source_links';
--        select count(*) from pg_proc where (pronamespace = 'public'::regnamespace and proname in ('add_source', 'unlinked_source_count'))
--          or (pronamespace = 'private'::regnamespace and proname in ('cited_source_ids', 'link_cited_sources', 'link_issue_source', 'source_links_before_insert'));
--   P2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261124500000';
--   P3. The tables it points at and the helpers it uses exist. Expect 6 and 3:
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('sources', 'processes', 'steps', 'issues', 'issue_sources', 'solutions');
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('can_read_workspace', 'can_edit_workspace', 'audit_mcp_write');
--   P4. (optional) How the sources are classed now: by kind, with how many are cited by a step or listed by an issue:
--        select s.kind, count(*) as sources,
--          count(*) filter (where exists (select 1 from public.issue_sources i where i.source_id = s.id)) as listed_by_an_issue
--          from public.sources s group by 1 order by 1;
--   P5. The step links the copy will make (one per workspace, process, step and source; citations of sources that don't exist or are
--       in another workspace give none). Note the number: after applying, `kind = 'step'` links must equal it:
--        select count(*) from (
--          select distinct st.workspace_id, st.process_id, st.id, src.id
--          from public.steps st
--          cross join lateral jsonb_each(case when jsonb_typeof(st.provenance) = 'object' then st.provenance else '{}'::jsonb end) as col(name, entry)
--          cross join lateral jsonb_array_elements(case when jsonb_typeof(col.entry -> 'evidence') = 'array' then col.entry -> 'evidence' else '[]'::jsonb end) as ev(value)
--          join public.sources src on src.workspace_id = st.workspace_id
--            and jsonb_typeof(ev.value) = 'object'
--            and src.id = case when (ev.value ->> 'source_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (ev.value ->> 'source_id')::uuid end
--        ) pairs;
--   P6. The issue links the copy will make (one per issue_sources row). After applying, `kind = 'issue'` links must equal it:
--        select count(*) from public.issue_sources;
--   P7. What could make the copy fail (the step link needs its process to exist in the workspace). Expect 0:
--        select count(*) from (
--          select distinct st.workspace_id, st.process_id, st.id, src.id
--          from public.steps st
--          cross join lateral jsonb_each(case when jsonb_typeof(st.provenance) = 'object' then st.provenance else '{}'::jsonb end) as col(name, entry)
--          cross join lateral jsonb_array_elements(case when jsonb_typeof(col.entry -> 'evidence') = 'array' then col.entry -> 'evidence' else '[]'::jsonb end) as ev(value)
--          join public.sources src on src.workspace_id = st.workspace_id
--            and jsonb_typeof(ev.value) = 'object'
--            and src.id = case when (ev.value ->> 'source_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (ev.value ->> 'source_id')::uuid end
--          where not exists (select 1 from public.processes p where p.id = st.process_id and p.workspace_id = st.workspace_id)
--        ) orphans;
--   P8. How many sources will be flagged "Not linked" right after applying (no step cites them and no issue lists them), by workspace:
--        select s.workspace_id, count(*) as will_be_unlinked from public.sources s
--          where not exists (select 1 from public.issue_sources i where i.source_id = s.id)
--            and not exists (
--              select 1 from public.steps st
--              cross join lateral jsonb_each(case when jsonb_typeof(st.provenance) = 'object' then st.provenance else '{}'::jsonb end) as col(name, entry)
--              cross join lateral jsonb_array_elements(case when jsonb_typeof(col.entry -> 'evidence') = 'array' then col.entry -> 'evidence' else '[]'::jsonb end) as ev(value)
--              where st.workspace_id = s.workspace_id and jsonb_typeof(ev.value) = 'object'
--                and lower(ev.value ->> 'source_id') = s.id::text)
--          group by 1 order by 1;
--
-- Post-apply check (authenticated must show DELETE and SELECT at table level, INSERT only on the listed columns, no UPDATE
-- anywhere; anon nothing; the step and issue link counts equal P5 and P6):
--        select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'source_links' and grantee in ('anon', 'authenticated') order by 1, 2;
--        select column_name, privilege_type from information_schema.column_privileges where table_schema = 'public' and table_name = 'source_links' and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE') order by 2, 1;
--        select kind, count(*) from public.source_links group by 1 order by 1;   -- 'step' = P5, 'issue' = P6
--        select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'sources_kind';   -- allows transcript, notes, data, screenshot
--
-- Rollback (run as one transaction; it loses every link, and with them every flag: sources are then cited by their
-- values and issues only, as before. It also REWRITES any source of kind `data` to `notes`, so the narrow check holds again):
--
--   begin;
--   drop trigger if exists link_cited_sources on public.steps;
--   drop trigger if exists link_issue_source on public.issue_sources;
--   drop function if exists public.add_source(uuid, jsonb, jsonb);
--   drop function if exists public.unlinked_source_count(uuid);
--   drop table if exists public.source_links;   -- its triggers, policies and indexes go with it
--   drop function if exists private.source_links_before_insert();
--   drop function if exists private.link_cited_sources();
--   drop function if exists private.link_issue_source();
--   drop function if exists private.cited_source_ids(jsonb);
--   update public.sources set kind = 'notes' where kind = 'data';
--   alter table public.sources drop constraint sources_kind,
--     add constraint sources_kind check (kind in ('transcript', 'notes', 'screenshot'));
--   delete from supabase_migrations.schema_migrations where version = '20261124500000';
--   commit;
--
-- Production data: none needed (the copy is part of the migration).

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

create table public.source_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source_id uuid not null,
  kind text not null constraint source_links_kind check (kind in ('process', 'step', 'insight', 'issue', 'solution')),
  -- The process linked, or the process a linked step is in.
  process_id uuid,
  -- A step's stable id (no foreign key: steps are keyed by revision; the trigger checks it).
  step_id uuid,
  -- A detection's key, the same shape as issues.detected_key.
  insight_key text constraint source_links_insight_key_shape check (insight_key ~ '^[a-z_]+:[a-z_]+:[^[:space:]]{1,200}$'),
  issue_id uuid,
  solution_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  -- Exactly the target columns of the kind, and no others.
  constraint source_links_target check (
    (kind = 'process' and process_id is not null and step_id is null and insight_key is null and issue_id is null and solution_id is null)
    or (kind = 'step' and process_id is not null and step_id is not null and insight_key is null and issue_id is null and solution_id is null)
    or (kind = 'insight' and insight_key is not null and process_id is null and step_id is null and issue_id is null and solution_id is null)
    or (kind = 'issue' and issue_id is not null and process_id is null and step_id is null and insight_key is null and solution_id is null)
    or (kind = 'solution' and solution_id is not null and process_id is null and step_id is null and insight_key is null and issue_id is null)
  ),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade,
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete cascade,
  foreign key (issue_id, workspace_id) references public.issues (id, workspace_id) on delete cascade,
  foreign key (solution_id, workspace_id) references public.solutions (id, workspace_id) on delete cascade
);

-- One link per source and target.
create unique index source_links_unique on public.source_links (
  source_id, kind,
  coalesce(process_id, '00000000-0000-0000-0000-000000000000'),
  coalesce(step_id, '00000000-0000-0000-0000-000000000000'),
  coalesce(issue_id, '00000000-0000-0000-0000-000000000000'),
  coalesce(solution_id, '00000000-0000-0000-0000-000000000000'),
  coalesce(insight_key, ''));
create index on public.source_links (workspace_id, source_id);
create index on public.source_links (workspace_id, kind, step_id);
create index on public.source_links (workspace_id, kind, process_id);
create index on public.source_links (workspace_id, kind, issue_id);
create index on public.source_links (workspace_id, kind, solution_id);
create index on public.source_links (workspace_id, kind, insight_key);

-- ---------------------------------------------------------------------------
-- Today's citations become links (a copy: provenance and issue_sources are untouched)
-- ---------------------------------------------------------------------------

-- The source ids a step's provenance cites (`provenance.<column>.evidence[].source_id`), as uuids, once each. A value that
-- is not a uuid is skipped; case does not matter (the uuid type spells it lower case). Used by the copy below and by the
-- trigger after it. Runs as the caller, who needs execute and the private schema's usage.
create function private.cited_source_ids(provenance jsonb) returns setof uuid
language sql
immutable
set search_path = ''
as $$
  select distinct case when (ev.value ->> 'source_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (ev.value ->> 'source_id')::uuid end
  from jsonb_each(case when pg_catalog.jsonb_typeof(provenance) = 'object' then provenance else '{}'::jsonb end) as col(name, entry)
  cross join lateral jsonb_array_elements(case when pg_catalog.jsonb_typeof(col.entry -> 'evidence') = 'array' then col.entry -> 'evidence' else '[]'::jsonb end) as ev(value)
  where pg_catalog.jsonb_typeof(ev.value) = 'object';
$$;

revoke all on function private.cited_source_ids(jsonb) from public, anon;
grant execute on function private.cited_source_ids(jsonb) to authenticated;

-- Every step value that cites a source: one step link per source and step, from every revision of every process.
insert into public.source_links (workspace_id, source_id, kind, process_id, step_id)
  select distinct st.workspace_id, src.id, 'step', st.process_id, st.id
  from public.steps st
  cross join lateral private.cited_source_ids(st.provenance) as cited(id)
  join public.sources src on src.workspace_id = st.workspace_id and src.id = cited.id
  on conflict do nothing;

-- Every source an issue already lists.
insert into public.source_links (workspace_id, source_id, kind, issue_id)
  select workspace_id, source_id, 'issue', issue_id from public.issue_sources
  on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Checks, now the data is in
-- ---------------------------------------------------------------------------

-- A step link must name a step of that process. Runs as the caller (security invoker): a member can read their
-- workspace's steps, and a stranger learns nothing from the message.
create function private.source_links_before_insert() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- (A step link with a missing column is left to the table's own shape check.)
  if new.kind = 'step' and new.step_id is not null and new.process_id is not null and not exists (
    select 1 from public.steps s where s.id = new.step_id and s.process_id = new.process_id and s.workspace_id = new.workspace_id
  ) then
    raise exception 'That step is not in that process.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.source_links_before_insert() from public, anon, authenticated;

create trigger source_links_before_insert before insert on public.source_links
  for each row execute function private.source_links_before_insert();

create trigger audit_mcp after insert or update or delete on public.source_links
  for each row execute function private.audit_mcp_write();

-- From now on a citation is a link. Whoever cites a source (the inspector, the MCP server, an import, a draft copied from the
-- live version) adds the step link in the same transaction, so a cited source is never flagged "Not linked". They only add:
-- taking a citation away does not take the link away, because a link is the person's own statement that the source is
-- evidence for that thing. Both run as the caller, so row-level security decides (an editor can write steps and links alike).
--
-- It runs on every save of a step's provenance, so it must be cheap when nothing new is cited: the ids are read into an array
-- once (a set-returning function with a SET clause can't be inlined, so joining it would make the planner guess a thousand
-- rows and scan every source), it returns at once when there are none or when every one was already cited before this update,
-- and otherwise looks the sources up by primary key.
create function private.link_cited_sources() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ids uuid[] := array(select c from private.cited_source_ids(new.provenance) as c where c is not null);
begin
  if cardinality(ids) = 0
    or (tg_op = 'UPDATE' and ids <@ array(select c from private.cited_source_ids(old.provenance) as c where c is not null)) then
    return null;
  end if;
  insert into public.source_links (workspace_id, source_id, kind, process_id, step_id)
  select new.workspace_id, src.id, 'step', new.process_id, new.id
  from public.sources src
  where src.id = any (ids) and src.workspace_id = new.workspace_id
  on conflict do nothing;
  return null;
end;
$$;

create function private.link_issue_source() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.source_links (workspace_id, source_id, kind, issue_id)
  values (new.workspace_id, new.source_id, 'issue', new.issue_id)
  on conflict do nothing;
  return null;
end;
$$;

revoke all on function private.link_cited_sources() from public, anon, authenticated;
revoke all on function private.link_issue_source() from public, anon, authenticated;

create trigger link_cited_sources after insert or update of provenance on public.steps
  for each row execute function private.link_cited_sources();
create trigger link_issue_source after insert on public.issue_sources
  for each row execute function private.link_issue_source();

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.source_links enable row level security;

create policy "read source_links" on public.source_links for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert source_links" on public.source_links for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "delete source_links" on public.source_links for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

-- A Supabase project gives every new public table full privileges to anon and authenticated: take them all away,
-- then give back only what the app needs. No UPDATE: a link is removed and added again.
revoke all on public.source_links from anon, authenticated;
grant select, delete on public.source_links to authenticated;
grant insert (workspace_id, source_id, kind, process_id, step_id, insight_key, issue_id, solution_id) on public.source_links to authenticated;

-- ---------------------------------------------------------------------------
-- Adding a source with its links, and counting the unlinked
-- ---------------------------------------------------------------------------

-- `p_source`: {kind, title, speakers[], recorded_at, body, file_url}. `p_links`: a non-empty array of
-- {kind, process_id?, step_id?, insight_key?, issue_id?, solution_id?}. The tables' own checks decide what is valid
-- (kind, title, lengths, the link's shape and target), so a bad value fails the whole call and nothing is saved.
create function public.add_source(p_workspace uuid, p_source jsonb, p_links jsonb) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_id uuid;
  link jsonb;
begin
  if pg_catalog.jsonb_typeof(p_links) is distinct from 'array' or pg_catalog.jsonb_array_length(p_links) = 0 then
    raise exception 'Link the source to at least one process, step, insight, issue or solution.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_links) > 50 then
    raise exception 'A source can be linked to at most 50 things when it is added.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_source) is distinct from 'object' then
    raise exception 'That source is not valid.' using errcode = '22023';
  end if;

  insert into public.sources (workspace_id, kind, title, speakers, recorded_at, body, file_url)
  values (
    p_workspace,
    coalesce(p_source ->> 'kind', 'transcript'),
    p_source ->> 'title',
    coalesce(array(select pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(p_source -> 'speakers') = 'array' then p_source -> 'speakers' else '[]'::jsonb end)), '{}'),
    nullif(p_source ->> 'recorded_at', '')::date,
    nullif(p_source ->> 'body', ''),
    nullif(p_source ->> 'file_url', ''))
  returning id into new_id;

  for link in select value from pg_catalog.jsonb_array_elements(p_links) loop
    insert into public.source_links (workspace_id, source_id, kind, process_id, step_id, insight_key, issue_id, solution_id)
    values (
      p_workspace,
      new_id,
      link ->> 'kind',
      nullif(link ->> 'process_id', '')::uuid,
      nullif(link ->> 'step_id', '')::uuid,
      nullif(link ->> 'insight_key', ''),
      nullif(link ->> 'issue_id', '')::uuid,
      nullif(link ->> 'solution_id', '')::uuid)
    -- The same thing named twice is one link.
    on conflict do nothing;
  end loop;
  return new_id;
end;
$$;

revoke all on function public.add_source(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.add_source(uuid, jsonb, jsonb) to authenticated;

-- How many of the workspace's sources are linked to nothing. Runs as the caller, so it counts what they can read.
create function public.unlinked_source_count(p_workspace uuid) returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer
  from public.sources s
  where s.workspace_id = p_workspace
    and not exists (select 1 from public.source_links l where l.source_id = s.id and l.workspace_id = s.workspace_id);
$$;

revoke all on function public.unlinked_source_count(uuid) from public, anon;
grant execute on function public.unlinked_source_count(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A fourth type of source: data (an export, a spreadsheet)
-- ---------------------------------------------------------------------------

-- Widening only: every existing row (transcript, notes, screenshot) still passes. Added NOT VALID and then validated, so the
-- table is locked only for the swap, not for the scan.
alter table public.sources drop constraint sources_kind,
  add constraint sources_kind check (kind in ('transcript', 'notes', 'data', 'screenshot')) not valid;
alter table public.sources validate constraint sources_kind;
