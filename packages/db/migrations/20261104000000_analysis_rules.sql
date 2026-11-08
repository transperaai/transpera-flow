-- Settings -> Analysis rules (docs/analysis-rules.md "Editing the rules"; issue #109).
--
-- One row per workspace holds its analysis rules: which rules are on, their
-- cut-offs, overrides, the two escalator switches and the money settings and
-- defaults. The document is one generic jsonb column (`settings`), sparse: it
-- holds only what differs from the agreed defaults, and its shape is checked
-- by the app (packages/engine/src/analysis-settings.ts), so adding a money
-- setting later needs no migration. No row means all defaults.
--
-- Owners and editors change it; every member reads it (the issues pages rate
-- the latest run with it). Same policies as `demand_settings`.
--
-- Strictly additive: table `public.analysis_rules`, its `set_updated_at`
-- trigger, row-level security and four policies. `save_fields`, `save_links`
-- and every existing table are unchanged.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--
--   1. The table must not exist yet. Expect 0 rows:
--        select table_name from information_schema.tables
--        where table_schema = 'public' and table_name = 'analysis_rules';
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261104000000';
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop table if exists public.analysis_rules;   -- drops its trigger and policies with it
--   delete from supabase_migrations.schema_migrations where version = '20261104000000';
--   commit;
--
-- Production data: none needed (no row means the defaults).

create table public.analysis_rules (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  -- The rules document. {} is all defaults.
  settings jsonb not null default '{}'
    check (jsonb_typeof(settings) = 'object' and pg_catalog.octet_length(settings::text) <= 200000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create trigger set_updated_at before update on public.analysis_rules
  for each row execute function public.set_updated_at();

alter table public.analysis_rules enable row level security;

create policy "read analysis rules" on public.analysis_rules for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert analysis rules" on public.analysis_rules for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update analysis rules" on public.analysis_rules for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete analysis rules" on public.analysis_rules for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.analysis_rules to authenticated;
revoke all on public.analysis_rules from anon;
