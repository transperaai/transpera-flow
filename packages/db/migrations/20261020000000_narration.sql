-- Narration (docs/PRD.md §5 `narrations`, §7.3, decision D15; issue #29;
-- docs/adr/0011-narration.md).
--
-- The report's executive summary and the "explain this run" action may be
-- drafted by Claude (server-side only), and every number in a draft is
-- matched against the figures it was given; a draft that fails twice falls
-- back to the templated text. Each outcome is recorded here and doubles as
-- the cache: one row per workspace, target (the run the text describes),
-- purpose and input hash (SHA-256 of exactly what the model was sent, which
-- covers the scenarios and sections a report compares). An unchanged run
-- therefore never pays for a second draft. The app re-checks cached text
-- against the facts before using it, so a row edited by hand can't smuggle a
-- figure into a report.
--
-- Strictly additive:
--   * table `narrations` (RLS, grants, anon revoked, `set_updated_at`).
-- `save_fields` and `save_links` are unchanged.
--
-- Access: an executive summary can name people with their utilisation (PRD
-- §2 shows that to editors, owners and agency admins only), so summaries are
-- read by editors only; explanations of a run (role-level figures, like the
-- run itself) by anyone in the workspace. Editors write. `edited_by`, when
-- set, must be the user making the change.
--
-- Rollback (run as one transaction; newest migration first):
--
--   begin;
--   drop table if exists public.narrations;
--   delete from supabase_migrations.schema_migrations where version = '20261020000000';
--   commit;
--
-- Rolling back deletes every cached narration; reports keep the summary they
-- printed (it lives in `reports.content`).
--
-- Production data: none needed.

create table public.narrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- What the text describes: a saved run (the report's run for a summary). "comparison" is kept for the PRD's compare view.
  target text not null constraint narrations_target check (target in ('run', 'comparison')),
  target_id uuid not null,
  purpose text not null constraint narrations_purpose check (purpose in ('summary', 'explain')),
  input_hash text not null constraint narrations_input_hash check (input_hash ~ '^[0-9a-f]{64}$'),
  -- The model that drafted it (null when none was reachable).
  model text constraint narrations_model check (char_length(model) <= 100),
  -- The text that prints: the checked narration, or the templated fallback. Paragraphs separated by a blank line.
  text text not null constraint narrations_text check (char_length(text) between 1 and 20000),
  validated boolean not null,
  fallback boolean not null,
  fallback_kind text constraint narrations_fallback_kind check (fallback_kind in ('invalid', 'refused', 'timeout', 'error', 'unavailable')),
  fallback_reason text constraint narrations_fallback_reason check (char_length(fallback_reason) <= 2000),
  -- Numbers in the text, each matched to a fact.
  checked int not null default 0 constraint narrations_checked check (checked >= 0),
  -- Drafts the check rejected, with the numbers that failed: [{paragraphs, problems: [{text, reason}]}].
  rejected jsonb not null default '[]' constraint narrations_rejected check (
    jsonb_typeof(rejected) = 'array' and octet_length(rejected::text) <= 60000),
  -- Tokens per request, for cost: [{inputTokens, outputTokens, cacheReadTokens}].
  usage jsonb not null default '[]' constraint narrations_usage check (jsonb_typeof(usage) = 'array' and octet_length(usage::text) <= 4000),
  edited_by uuid references auth.users (id) on delete set null,
  edited_by_name text constraint narrations_edited_by_name check (char_length(edited_by_name) <= 200),
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  constraint narrations_outcome check (
    (validated and not fallback and fallback_kind is null) or (not validated and fallback and fallback_kind is not null)),
  unique (workspace_id, target, target_id, purpose, input_hash)
);

create index on public.narrations (workspace_id, created_at desc);
create index on public.narrations (target_id);

create trigger set_updated_at before update on public.narrations for each row execute function public.set_updated_at();

alter table public.narrations enable row level security;

create policy "read narrations" on public.narrations for select to authenticated
  using (public.can_edit_workspace(workspace_id) or (purpose = 'explain' and public.can_read_workspace(workspace_id)));
create policy "insert narrations" on public.narrations for insert to authenticated
  with check (public.can_edit_workspace(workspace_id) and (edited_by is null or edited_by = auth.uid()));
create policy "update narrations" on public.narrations for update to authenticated
  using (public.can_edit_workspace(workspace_id))
  with check (public.can_edit_workspace(workspace_id) and (edited_by is null or edited_by = auth.uid()));
create policy "delete narrations" on public.narrations for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

grant select, insert, update, delete on public.narrations to authenticated;
revoke all on public.narrations from anon;
