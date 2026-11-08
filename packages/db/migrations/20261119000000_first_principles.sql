-- First principles per process version (issue #119, A54; docs/research/first-principles.md Part B).
--
-- A consultant strips a process back to seven short answers: the job it does, hard truths against assumptions,
-- requirements with a named owner, delete candidates, what to simplify, accelerate and automate, the root cause of
-- the biggest problem, and success measures. The analysis judges the process against them, and the "goals met" rule
-- (docs/analysis-rules.md rule 11) reads the success measures.
--
-- One row per process revision (a draft, the live version or an earlier one), so a published version keeps the
-- first principles it was published with and the History page can show how they changed. The seven answers are
-- stored as the research note's sketch has them: the job and the root cause as plain text columns, the lists the
-- rule checks read (truths and assumptions, requirements, delete candidates, improvements, success measures) as
-- jsonb arrays. The database checks that each part is the right kind of JSON and its size; the shape of the items
-- is held by the app (packages/engine/src/first-principles.ts), so adding a field later needs no migration.
--
-- Each jsonb part is also capped at 512 KB as text (the app's own largest list, 50 items of 2,000-character fields, is about
-- 310 KB: FP_MAX_JSON_BYTES in the engine), so no row can be made large. 
--
-- Edits go into the process's draft, like the steps and edges (docs/adr/0004-drafts-as-revisions.md): the existing
-- `edit_drafts_only` trigger refuses a write to a published or superseded revision. A draft opened from live starts
-- with no row; the app copies the live row into it on the first save, and reads the nearest earlier row for a
-- revision that has none. Everyone in the workspace reads; owners and editors write; `anon` has nothing. The same
-- policies as `lever_settings` and `client_groups`. MCP writes are audit-logged by the `audit_mcp` trigger, as for
-- sources and issues.
--
-- Strictly additive: a unique index on `process_revisions (id, process_id, workspace_id)` (so a row can name its revision AND
-- its process in one foreign key), table `public.first_principles`, its `set_updated_at`, `edit_drafts_only` and `audit_mcp`
-- triggers, row-level security and four policies. `save_fields`, `save_links`, `open_draft`, `publish_process` and
-- every existing table are unchanged.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--
--   1. The table must not exist yet. Expect 0 rows:
--        select table_name from information_schema.tables
--        where table_schema = 'public' and table_name = 'first_principles';
--   2. The three things it relies on exist. Expect 3 rows:
--        select proname from pg_proc where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
--        and proname in ('edit_drafts_only', 'audit_mcp_write', 'set_updated_at');
--   3. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261119000000';
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop table if exists public.first_principles;   -- drops its triggers, policies and indexes with it
--   drop index if exists public.process_revisions_id_process_workspace_key;
--   delete from supabase_migrations.schema_migrations where version = '20261119000000';
--   commit;
--
-- Production data: none needed (a process with no row has "not started").

-- A row's revision must belong to the row's process: one foreign key over all three ids.
create unique index process_revisions_id_process_workspace_key on public.process_revisions (id, process_id, workspace_id);

create table public.first_principles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  process_id uuid not null,
  revision_id uuid not null,

  -- 1. The job: who it is for, the progress they want, the situation, and what done looks like.
  job_who text not null default '' check (char_length(job_who) <= 2000),
  job_progress text not null default '' check (char_length(job_progress) <= 2000),
  job_situation text not null default '' check (char_length(job_situation) <= 2000),
  job_done text not null default '' check (char_length(job_done) <= 2000),

  -- 2. Truths and assumptions: [{text, kind: truth|assumption, source, test, linked_parameter}].
  statements jsonb not null default '[]'
    check (jsonb_typeof(statements) = 'array' and jsonb_array_length(statements) <= 50
      and octet_length(statements::text) <= 524288),
  -- 3. Requirements: [{text, owner_person_id, owner_text, why, verdict: keep|change|drop|challenge, step_id}].
  requirements jsonb not null default '[]'
    check (jsonb_typeof(requirements) = 'array' and jsonb_array_length(requirements) <= 50
      and octet_length(requirements::text) <= 524288),
  -- 4. Delete candidates: [{step_id, breaks_if_removed, agreed_by, added_back}].
  deletes jsonb not null default '[]'
    check (jsonb_typeof(deletes) = 'array' and jsonb_array_length(deletes) <= 50
      and octet_length(deletes::text) <= 524288),
  -- 5. Simplify, accelerate, automate: [{step_id, stage: simplify|accelerate|automate, text, scenario_id}].
  improvements jsonb not null default '[]'
    check (jsonb_typeof(improvements) = 'array' and jsonb_array_length(improvements) <= 50
      and octet_length(improvements::text) <= 524288),

  -- 6. The biggest problem, the chain of whys that follows it, and the root cause.
  why_problem text not null default '' check (char_length(why_problem) <= 2000),
  why_chain jsonb not null default '[]'
    check (jsonb_typeof(why_chain) = 'array' and jsonb_array_length(why_chain) <= 10
      and octet_length(why_chain::text) <= 524288),
  root_cause text not null default '' check (char_length(root_cause) <= 2000),

  -- 7. Success measures: [{id, text, kpi, comparator: atLeast|atMost, target, horizon}]. `kpi` is one of the
  -- engine's success numbers (SUCCESS_KPIS), or null when the simulation can't compute it.
  measures jsonb not null default '[]'
    check (jsonb_typeof(measures) = 'array' and jsonb_array_length(measures) <= 50
      and octet_length(measures::text) <= 524288),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),

  -- One record per revision.
  unique (revision_id),
  foreign key (revision_id, process_id, workspace_id) references public.process_revisions (id, process_id, workspace_id) on delete cascade
);

create index on public.first_principles (workspace_id);
create index on public.first_principles (process_id);

create trigger set_updated_at before update on public.first_principles
  for each row execute function public.set_updated_at();

-- A published or superseded revision is history: the same guard the steps and edges have.
create trigger edit_drafts_only before insert or update or delete on public.first_principles
  for each row execute function public.edit_drafts_only();

-- Writes made through the MCP server are audit-logged (actor_kind 'mcp'), as for sources and issues.
create trigger audit_mcp after insert or update or delete on public.first_principles
  for each row execute function private.audit_mcp_write();

alter table public.first_principles enable row level security;

create policy "read first_principles" on public.first_principles for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert first_principles" on public.first_principles for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update first_principles" on public.first_principles for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "delete first_principles" on public.first_principles for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.first_principles to authenticated;
revoke all on public.first_principles from anon;
