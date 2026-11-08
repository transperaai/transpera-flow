-- Block library (issue #116, ticket A51): a block is a saved bundle of steps that can be reused in any
-- process or solution. Built by hand in the Editor's block mode, or saved from a group of steps ("manual"),
-- or made by the AI ideas of A52 ("ai").
--
-- One row per block, per workspace. `steps` holds the bundle as one jsonb document:
--
--   { "steps": [ ...step rows without revision_id, workspace_id and process_id... ],
--     "edges": [ ...edge rows without those three... ],
--     "entry_step_id": "<id of the top-level step the block is entered at, or null>" }
--
-- Groups, at any depth, are steps of kind `group` with `parent_step_id` set, as in a process. The ids inside the
-- bundle are local to it: inserting a block into a process gives every step and edge a fresh id (the app does that),
-- so a block never shares an id with a live step. The app checks the shape of the bundle; the database checks only
-- that it is an object with `steps` and `edges` arrays and is not huge (it is read on every page of the library).
--
-- Why a jsonb document and not rows in `steps`: a block belongs to no process revision, steps have a revision
-- foreign key, and a block is always read and written whole.
--
-- Row-level security as the other workspace tables (client_groups, lever_settings): every member of the workspace
-- reads, owners and editors write; `anon` has no access.
--
-- Strictly additive: table `public.blocks`, its index, `set_updated_at` trigger, row-level security and four
-- policies. `save_fields`, `save_links` and every existing table are unchanged.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--
--   1. The table must not exist yet. Expect 0 rows:
--        select table_name from information_schema.tables where table_schema = 'public' and table_name = 'blocks';
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261117000000';
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop table if exists public.blocks;   -- drops its index, trigger and policies with it
--   delete from supabase_migrations.schema_migrations where version = '20261117000000';
--   commit;
--
-- Production data: none needed (no rows means an empty library).

create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 200),
  description text not null default '' check (pg_catalog.length(description) <= 2000),
  -- By hand (built or saved by a person) or made by the AI ideas.
  type text not null default 'manual' check (type in ('manual', 'ai')),
  -- The bundle of steps, edges and groups (see above).
  steps jsonb not null
    check (
      pg_catalog.jsonb_typeof(steps) = 'object'
      and coalesce(pg_catalog.jsonb_typeof(steps -> 'steps'), '') = 'array'
      and coalesce(pg_catalog.jsonb_typeof(steps -> 'edges'), '') = 'array'
      and pg_catalog.octet_length(steps::text) <= 1000000
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create index on public.blocks (workspace_id);

create trigger set_updated_at before update on public.blocks
  for each row execute function public.set_updated_at();

alter table public.blocks enable row level security;

create policy "read blocks" on public.blocks for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert blocks" on public.blocks for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update blocks" on public.blocks for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete blocks" on public.blocks for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.blocks to authenticated;
revoke all on public.blocks from anon;
