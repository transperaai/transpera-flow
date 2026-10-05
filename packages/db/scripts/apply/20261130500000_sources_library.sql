-- Production apply file for 20261130500000_sources_library (B18, issue #176). Additive: one widened check (`sources_kind`), the table
-- `public.user_tours` and the function `public.search_sources`. Preflight, post-apply check and rollback are in the migration's own
-- header, repeated below. Apply BEFORE deploying the app (the library calls the function; the tour reads the table).

begin;
set local lock_timeout = '5s';

-- The Sources library and the editor tour (issue #176, B18).
--
-- STRICTLY ADDITIVE: one widened check, one new table with its policies, and one new function. Nothing existing is rewritten.
--
--   * `sources_kind` allows `sop`, `spreadsheet` and `other` besides `transcript`, `notes`, `data` and `screenshot`. Every existing
--     row still satisfies it and none is changed.
--   * `public.user_tours` (new table): which written tours of the editor a person has dismissed, so a tour never shows again for
--     them on any device. One row per person and tour (`process`: the process editor, `company`: the company map editor). A row
--     means "dismissed". RLS: a signed-in person reads, writes and deletes only their own rows; nobody else's, and anon nothing.
--   * `public.search_sources(...)` (new function, SECURITY INVOKER so the sources' RLS decides what is seen): one page of the
--     workspace's sources for the library. It matches every word of the search against the title, the speakers and the text (the
--     words are values, never built into SQL), filters by kind, by process and by "linked to nothing", sorts, and returns each row
--     WITHOUT its full text (a short excerpt instead, around the first match when the text matched) plus the number of rows that
--     match in all, so the page can say "Showing 50 of 213" and ask for more. The full text is read when a source is opened.
--
-- PREFLIGHT (read-only; each must return the stated result before applying):
--   select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'user_tours';  -- 0
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'search_sources';  -- 0
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'sources_kind';  -- allows transcript, notes, data, screenshot
--   select count(*) from supabase_migrations.schema_migrations where version > '20261130500000';  -- 0 (nothing later is applied)
--
-- POST-APPLY CHECK:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'sources_kind';  -- also allows sop, spreadsheet, other
--   select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'user_tours' and grantee in ('anon', 'PUBLIC');  -- no rows
--   select grantee from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'search_sources' and grantee in ('anon', 'PUBLIC');  -- no rows
--   select relrowsecurity from pg_class where oid = 'public.user_tours'::regclass;  -- true
--
-- ROLLBACK (run in this order; roll the app back first: it calls the function and reads the table. Tour dismissals are lost, so
-- everyone sees each tour once more. Sources of the new kinds must be changed or deleted first, or the check cannot be narrowed):
--
--   begin;
--   drop function if exists public.search_sources(uuid, text, text, uuid, boolean, text, integer, integer);
--   drop table if exists public.user_tours;
--   alter table public.sources drop constraint sources_kind,
--     add constraint sources_kind check (kind in ('transcript', 'notes', 'data', 'screenshot'));
--   delete from supabase_migrations.schema_migrations where version = '20261130500000';
--   commit;

-- ---------------------------------------------------------------------------
-- The kinds of source
-- ---------------------------------------------------------------------------

alter table public.sources drop constraint sources_kind,
  add constraint sources_kind check (kind in ('transcript', 'notes', 'sop', 'spreadsheet', 'data', 'screenshot', 'other')) not valid;
alter table public.sources validate constraint sources_kind;

-- ---------------------------------------------------------------------------
-- Tours a person has dismissed
-- ---------------------------------------------------------------------------

create table public.user_tours (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tour text not null constraint user_tours_tour check (tour in ('process', 'company')),
  dismissed_at timestamptz not null default now(),
  primary key (user_id, tour)
);

alter table public.user_tours enable row level security;
revoke all on public.user_tours from public, anon, authenticated;
grant select, insert, update, delete on public.user_tours to authenticated;

create policy "read own tours" on public.user_tours for select to authenticated
  using (user_id = (select auth.uid()));
create policy "insert own tours" on public.user_tours for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "update own tours" on public.user_tours for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own tours" on public.user_tours for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- One page of the library
-- ---------------------------------------------------------------------------

create function public.search_sources(
  p_workspace uuid,
  p_search text default null,
  p_kind text default null,
  p_process uuid default null,
  p_unlinked boolean default false,
  p_sort text default 'newest',
  p_limit integer default 50,
  p_offset integer default 0
) returns table (
  id uuid,
  workspace_id uuid,
  kind text,
  title text,
  speakers text[],
  recorded_at date,
  file_url text,
  created_at timestamptz,
  updated_at timestamptz,
  excerpt text,
  has_body boolean,
  total bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with words as (
    -- At most 10 words of at most 100 characters; each is compared as plain text (strpos), so `%`, `_` and quotes mean nothing special.
    select left(w, 100) as w
    from regexp_split_to_table(left(btrim(coalesce(p_search, '')), 300), '\s+') w
    where w <> ''
    limit 10
  ),
  hits as (
    select s.*,
      (select min(strpos(lower(coalesce(s.body, '')), lower(w.w))) filter (where strpos(lower(coalesce(s.body, '')), lower(w.w)) > 0) from words w) as at
    from public.sources s
    where s.workspace_id = p_workspace
      and (p_kind is null or s.kind = p_kind)
      and (p_process is null or exists (select 1 from public.source_links l where l.source_id = s.id and l.process_id = p_process))
      and (not coalesce(p_unlinked, false) or not exists (select 1 from public.source_links l where l.source_id = s.id))
      and not exists (
        select 1 from words w
        where strpos(lower(s.title), lower(w.w)) = 0
          and strpos(lower(array_to_string(s.speakers, ' ')), lower(w.w)) = 0
          and strpos(lower(coalesce(s.body, '')), lower(w.w)) = 0
      )
  )
  select h.id, h.workspace_id, h.kind, h.title, h.speakers, h.recorded_at, h.file_url, h.created_at, h.updated_at,
    left(regexp_replace(substr(coalesce(h.body, ''), greatest(coalesce(h.at, 1) - 40, 1), 400), '\s+', ' ', 'g'), 160) as excerpt,
    h.body is not null and btrim(h.body) <> '' as has_body,
    count(*) over () as total
  from hits h
  order by
    case when p_sort = 'oldest' then coalesce(h.recorded_at, h.created_at::date) end asc,
    case when p_sort = 'title' then lower(h.title) end asc,
    case when p_sort = 'title-desc' then lower(h.title) end desc,
    case when p_sort not in ('oldest', 'title', 'title-desc') then coalesce(h.recorded_at, h.created_at::date) end desc,
    lower(h.title), h.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.search_sources(uuid, text, text, uuid, boolean, text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_sources(uuid, text, text, uuid, boolean, text, integer, integer) to authenticated;

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261130500000', 'sources_library', array[$mig$-- The Sources library and the editor tour (issue #176, B18).
--
-- STRICTLY ADDITIVE: one widened check, one new table with its policies, and one new function. Nothing existing is rewritten.
--
--   * `sources_kind` allows `sop`, `spreadsheet` and `other` besides `transcript`, `notes`, `data` and `screenshot`. Every existing
--     row still satisfies it and none is changed.
--   * `public.user_tours` (new table): which written tours of the editor a person has dismissed, so a tour never shows again for
--     them on any device. One row per person and tour (`process`: the process editor, `company`: the company map editor). A row
--     means "dismissed". RLS: a signed-in person reads, writes and deletes only their own rows; nobody else's, and anon nothing.
--   * `public.search_sources(...)` (new function, SECURITY INVOKER so the sources' RLS decides what is seen): one page of the
--     workspace's sources for the library. It matches every word of the search against the title, the speakers and the text (the
--     words are values, never built into SQL), filters by kind, by process and by "linked to nothing", sorts, and returns each row
--     WITHOUT its full text (a short excerpt instead, around the first match when the text matched) plus the number of rows that
--     match in all, so the page can say "Showing 50 of 213" and ask for more. The full text is read when a source is opened.
--
-- PREFLIGHT (read-only; each must return the stated result before applying):
--   select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'user_tours';  -- 0
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'search_sources';  -- 0
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'sources_kind';  -- allows transcript, notes, data, screenshot
--   select count(*) from supabase_migrations.schema_migrations where version > '20261130500000';  -- 0 (nothing later is applied)
--
-- POST-APPLY CHECK:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'sources_kind';  -- also allows sop, spreadsheet, other
--   select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'user_tours' and grantee in ('anon', 'PUBLIC');  -- no rows
--   select grantee from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'search_sources' and grantee in ('anon', 'PUBLIC');  -- no rows
--   select relrowsecurity from pg_class where oid = 'public.user_tours'::regclass;  -- true
--
-- ROLLBACK (run in this order; roll the app back first: it calls the function and reads the table. Tour dismissals are lost, so
-- everyone sees each tour once more. Sources of the new kinds must be changed or deleted first, or the check cannot be narrowed):
--
--   begin;
--   drop function if exists public.search_sources(uuid, text, text, uuid, boolean, text, integer, integer);
--   drop table if exists public.user_tours;
--   alter table public.sources drop constraint sources_kind,
--     add constraint sources_kind check (kind in ('transcript', 'notes', 'data', 'screenshot'));
--   delete from supabase_migrations.schema_migrations where version = '20261130500000';
--   commit;

-- ---------------------------------------------------------------------------
-- The kinds of source
-- ---------------------------------------------------------------------------

alter table public.sources drop constraint sources_kind,
  add constraint sources_kind check (kind in ('transcript', 'notes', 'sop', 'spreadsheet', 'data', 'screenshot', 'other')) not valid;
alter table public.sources validate constraint sources_kind;

-- ---------------------------------------------------------------------------
-- Tours a person has dismissed
-- ---------------------------------------------------------------------------

create table public.user_tours (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tour text not null constraint user_tours_tour check (tour in ('process', 'company')),
  dismissed_at timestamptz not null default now(),
  primary key (user_id, tour)
);

alter table public.user_tours enable row level security;
revoke all on public.user_tours from public, anon, authenticated;
grant select, insert, update, delete on public.user_tours to authenticated;

create policy "read own tours" on public.user_tours for select to authenticated
  using (user_id = (select auth.uid()));
create policy "insert own tours" on public.user_tours for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "update own tours" on public.user_tours for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own tours" on public.user_tours for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- One page of the library
-- ---------------------------------------------------------------------------

create function public.search_sources(
  p_workspace uuid,
  p_search text default null,
  p_kind text default null,
  p_process uuid default null,
  p_unlinked boolean default false,
  p_sort text default 'newest',
  p_limit integer default 50,
  p_offset integer default 0
) returns table (
  id uuid,
  workspace_id uuid,
  kind text,
  title text,
  speakers text[],
  recorded_at date,
  file_url text,
  created_at timestamptz,
  updated_at timestamptz,
  excerpt text,
  has_body boolean,
  total bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with words as (
    -- At most 10 words of at most 100 characters; each is compared as plain text (strpos), so `%`, `_` and quotes mean nothing special.
    select left(w, 100) as w
    from regexp_split_to_table(left(btrim(coalesce(p_search, '')), 300), '\s+') w
    where w <> ''
    limit 10
  ),
  hits as (
    select s.*,
      (select min(strpos(lower(coalesce(s.body, '')), lower(w.w))) filter (where strpos(lower(coalesce(s.body, '')), lower(w.w)) > 0) from words w) as at
    from public.sources s
    where s.workspace_id = p_workspace
      and (p_kind is null or s.kind = p_kind)
      and (p_process is null or exists (select 1 from public.source_links l where l.source_id = s.id and l.process_id = p_process))
      and (not coalesce(p_unlinked, false) or not exists (select 1 from public.source_links l where l.source_id = s.id))
      and not exists (
        select 1 from words w
        where strpos(lower(s.title), lower(w.w)) = 0
          and strpos(lower(array_to_string(s.speakers, ' ')), lower(w.w)) = 0
          and strpos(lower(coalesce(s.body, '')), lower(w.w)) = 0
      )
  )
  select h.id, h.workspace_id, h.kind, h.title, h.speakers, h.recorded_at, h.file_url, h.created_at, h.updated_at,
    left(regexp_replace(substr(coalesce(h.body, ''), greatest(coalesce(h.at, 1) - 40, 1), 400), '\s+', ' ', 'g'), 160) as excerpt,
    h.body is not null and btrim(h.body) <> '' as has_body,
    count(*) over () as total
  from hits h
  order by
    case when p_sort = 'oldest' then coalesce(h.recorded_at, h.created_at::date) end asc,
    case when p_sort = 'title' then lower(h.title) end asc,
    case when p_sort = 'title-desc' then lower(h.title) end desc,
    case when p_sort not in ('oldest', 'title', 'title-desc') then coalesce(h.recorded_at, h.created_at::date) end desc,
    lower(h.title), h.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.search_sources(uuid, text, text, uuid, boolean, text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_sources(uuid, text, text, uuid, boolean, text, integer, integer) to authenticated;
$mig$]);

commit;
