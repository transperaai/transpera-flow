-- PDF reports and the server-side robustness cache (docs/PRD.md §5
-- `robustness_results`, §6.5, §9 "PDF", §7.1 `export_report`; issue #28;
-- docs/adr/0010-pdf-reports.md).
--
-- A report is generated from a saved run: the server assembles its content
-- (every number and sentence, as JSON), prints it to PDF with headless
-- Chromium and stores both here. The PDF is kept in the row rather than in
-- Supabase Storage so the web app and the MCP server (which acts as the user
-- through the Data API only; ADR 0002) share one path. A "signed URL" is a
-- random 256-bit token whose SHA-256 is stored with an expiry; the download
-- route exchanges it for the PDF through `public.report_download`, the only
-- security definer function here, which returns one report for one live
-- token and nothing else.
--
-- Robustness checks run automatically for every scenario a report includes
-- and are cached job by job (the engine's `robustnessJobKey`), so a report
-- whose check ran out of time resumes where it stopped next time, and an
-- unchanged model and scenario cost nothing.
--
-- Strictly additive:
--   * a unique constraint `runs_id_workspace_key` on `runs (id, workspace_id)`
--     (for the composite foreign keys below);
--   * tables `robustness_results` and `reports` (RLS, grants, anon revoked,
--     `set_updated_at` on reports);
--   * function `public.report_download(text)`.
-- `save_fields` and `save_links` are unchanged.
--
-- Access: reports hold per-person utilisation, which the PRD (§2) shows to
-- agency admins, owners and editors only, so only they read, write or delete
-- reports. Anyone in the workspace reads cached robustness results (they
-- hold replication samples and no names); editors write and delete them.
--
-- Rollback (run as one transaction; newest migration first):
--
--   begin;
--   drop function if exists public.report_download(text);
--   drop table if exists public.reports, public.robustness_results;
--   alter table public.runs drop constraint if exists runs_id_workspace_key;
--   delete from supabase_migrations.schema_migrations where version = '20261019000000';
--   commit;
--
-- Rolling back deletes every stored report and cached robustness result.
-- Saved runs are untouched.
--
-- Production data: none needed.

alter table public.runs add constraint runs_id_workspace_key unique (id, workspace_id);

-- ---------------------------------------------------------------------------
-- Robustness cache
-- ---------------------------------------------------------------------------

-- One robustness job's result (both sides' per-replication samples), keyed as
-- the engine keys it: `v<version>|<model hash>|<scenario hash>|<parameter>|
-- <factor>|<seed>|<start>+<reps>`. `check_key` is the first three parts, so a
-- check loads every job it could reuse in one query.
create table public.robustness_results (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The run whose report computed it, if any.
  run_id uuid,
  check_key text not null constraint robustness_results_check_key check (char_length(check_key) between 5 and 200),
  cache_key text not null constraint robustness_results_cache_key check (
    char_length(cache_key) between 5 and 600 and starts_with(cache_key, check_key || '|')),
  results jsonb not null constraint robustness_results_results check (
    jsonb_typeof(results) = 'object' and octet_length(results::text) <= 200000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (workspace_id, cache_key),
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete set null (run_id)
);

create index on public.robustness_results (workspace_id, check_key);
create index on public.robustness_results (run_id);

alter table public.robustness_results enable row level security;

create policy "read robustness results" on public.robustness_results for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert robustness results" on public.robustness_results for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "delete robustness results" on public.robustness_results for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, delete on public.robustness_results to authenticated;
revoke all on public.robustness_results from anon;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  process_id uuid,
  -- The saved run every number came from.
  run_id uuid,
  title text not null constraint reports_title check (char_length(btrim(title)) between 1 and 300),
  -- What was asked for: sections, scenarios, replications.
  options jsonb not null default '{}' constraint reports_options check (jsonb_typeof(options) = 'object'),
  -- Every number and sentence the report prints (apps/web/src/lib/report/content.ts).
  content jsonb not null constraint reports_content check (
    jsonb_typeof(content) = 'object' and octet_length(content::text) <= 5000000),
  content_version int not null default 1,
  pdf bytea constraint reports_pdf check (octet_length(pdf) <= 20000000),
  pdf_generated_at timestamptz,
  -- The current download link: SHA-256 (hex) of its token, and when it stops working.
  link_hash text constraint reports_link_hash check (link_hash ~ '^[0-9a-f]{64}$'),
  link_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  constraint reports_link check ((link_hash is null) = (link_expires_at is null)),
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete set null (process_id),
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete set null (run_id)
);

create index on public.reports (workspace_id, created_at desc);
create index on public.reports (run_id);
create unique index reports_link_hash_key on public.reports (link_hash) where link_hash is not null;

create trigger set_updated_at before update on public.reports for each row execute function public.set_updated_at();

alter table public.reports enable row level security;

create policy "read reports" on public.reports for select to authenticated
  using (public.can_edit_workspace(workspace_id));
create policy "insert reports" on public.reports for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update reports" on public.reports for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete reports" on public.reports for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.reports to authenticated;
revoke all on public.reports from anon;

-- A download link's report: its PDF and content, for a live token only. The
-- token is 32 random bytes in base64url (43 characters); anything else, an
-- unknown token or an expired one returns no row.
create function public.report_download(token text)
returns table (id uuid, workspace_id uuid, title text, pdf bytea, content jsonb, expires_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select r.id, r.workspace_id, r.title, r.pdf, r.content, r.link_expires_at
  from public.reports r
  where token ~ '^[A-Za-z0-9_-]{43}$'
    and r.link_hash = encode(pg_catalog.sha256(convert_to(token, 'UTF8')), 'hex')
    and r.link_expires_at > now();
$$;

revoke all on function public.report_download(text) from public;
grant execute on function public.report_download(text) to anon, authenticated;
