-- Settings -> Levers (issue #123, A58): which levers a workspace shows.
--
-- One row per workspace holds the ids of the lever kinds it has switched off
-- ("Time each step takes", "Prices", ...). Hidden levers don't appear as
-- sliders on process pages or in the Editor. The ids are checked by the app
-- (apps/web/src/lib/scenarios/lever-catalogue.ts), so adding a lever kind
-- later needs no migration. No row means every lever is shown.
--
-- Why a table and not `workspaces.settings`: that jsonb is written key by key
-- through `save_fields`, whose allow-list takes scalars, and a read-modify-write
-- of the whole document would lose a concurrent edit to another setting. A
-- row of its own saves the list in one atomic statement and needs no change to
-- `save_fields`.
--
-- Owners and editors change it; every member reads it (process pages hide the
-- sliders from everyone). Same policies as `analysis_rules`.
--
-- Strictly additive: table `public.lever_settings`, its `set_updated_at`
-- trigger, row-level security and four policies. `save_fields`, `save_links`
-- and every existing table are unchanged.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--
--   1. The table must not exist yet. Expect 0 rows:
--        select table_name from information_schema.tables
--        where table_schema = 'public' and table_name = 'lever_settings';
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261112000000';
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop table if exists public.lever_settings;   -- drops its trigger and policies with it
--   delete from supabase_migrations.schema_migrations where version = '20261112000000';
--   commit;
--
-- Production data: none needed (no row means every lever is shown).

create table public.lever_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  -- Ids of the lever kinds switched off. {} is every lever shown.
  hidden text[] not null default '{}'
    check (pg_catalog.cardinality(hidden) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create trigger set_updated_at before update on public.lever_settings
  for each row execute function public.set_updated_at();

alter table public.lever_settings enable row level security;

create policy "read lever settings" on public.lever_settings for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert lever settings" on public.lever_settings for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update lever settings" on public.lever_settings for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete lever settings" on public.lever_settings for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.lever_settings to authenticated;
revoke all on public.lever_settings from anon;
