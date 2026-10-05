-- Analysis rework: engine facts as evidence, AI findings on demand, findings by hand (issue #175, B17; decision D40 in
-- docs/PRD.md, docs/adr/0015-analysis-findings.md).
--
-- The engine's rule results stop being findings: they are shown as evidence ("facts") and are never stored. A FINDING is
-- what someone or AI concludes from them: a rating, the process (or the whole company) and step it is about, a title, the
-- evidence, why it matters, and the facts and sources it rests on. AI findings arrive PROPOSED when someone presses
-- "Analyse"; a person accepts (after editing, if they like) or dismisses each one. A person can also add findings by hand.
-- Only accepted findings show on the Overview and the process pages, and from there one can be acknowledged as an issue
-- exactly as an insight was (D24, D38): the issue carries `detected_key = 'finding:<origin>:<id>'`.
--
-- STRICTLY ADDITIVE: one new table, one new trigger function, one new nullable column. Nothing existing is changed or
-- dropped. The analysis rules table (`analysis_rules`, D35) is left as it is, unread by the app since D40; the AI switches
-- `review_on_publish` and `review_on_market` stay in `ai_settings`, unused now that analysis runs only on demand.
--
--   * `public.ai_analyses.model_hash` (text, nullable): a hash of what the analysis read, written by the app: the engine
--     model at a fixed start date, the first principles, the scope, the prompt version, the Anthropic model, whether AI
--     reads sources and the quotes and source ids it was given, then (after a dot) the run's facts by key and rating. A page
--     compares it with what it has now and marks the analysis out of date when any part differs. Rows written before this
--     have none, and are compared by version only.
--   * `public.findings`: workspace; `process_id` (null: across the company); `step_id` (a step's stable id, no foreign key:
--     steps belong to versions); `origin` ('ai' or 'manual'); `status` ('proposed', 'accepted', 'dismissed' or
--     'superseded': a proposal a later analysis didn't make again); `rating` (the four ratings); `type` (the nine kinds an
--     AI finding may be filed under); `title`, `evidence`, `why`; `facts` (the cited facts and quotes, as written when
--     cited: [{kind, key, text}]); `source_ids` (sources cited); `ai_key` (an AI finding's stable key, so the same finding
--     isn't proposed twice); `analysis_id` (the analysis that proposed it) and `run_id` (the run that last proposed it:
--     analyses are kept one per version, so a second run on the same version keeps the analysis id but not the run);
--     `edited` (an AI finding a person has changed, so the page doesn't call their words AI's); who made, changed and
--     decided it, and when.
--   * `private.findings_before_write` (trigger, SECURITY INVOKER, empty search_path) stamps who and when (never what the
--     client sent) and holds the rules the policies can't:
--       - an AI finding starts proposed and must cite an analysis in the same workspace written by the caller in the last
--         15 minutes, and that analysis's run (as `ai_analyses` checks its run), so an editor can't write "AI" findings by
--         hand through PostgREST except as the result of an analysis they ran (the remaining forgery risk is ADR 0013's);
--       - a finding added by hand starts accepted and cites no analysis or run;
--       - `workspace_id`, `origin`, `ai_key`, `created_by` and `created_at` never change; `analysis_id` and `run_id` only
--         to null, or when a later run proposes a proposed or superseded AI finding again (checked as on insert);
--       - the facts an AI finding cites stay as cited; changing what an AI finding says marks it `edited` (set here only);
--       - nothing goes back to proposed except by being proposed again; only a proposed AI finding is superseded, and a
--         superseded one is neither accepted nor dismissed;
--       - its process is one of its workspace's, and every source it cites is one of its workspace's.
--
-- Row-level security: every member reads (viewers too; the pages show viewers accepted findings only); owners and editors
-- insert and update; nobody deletes (dismiss instead). Privileges: Supabase gives a new table every right to anon and
-- authenticated, so this revokes them and grants back select, insert and update to authenticated. anon: nothing.
--
-- Production data: none needs aligning. Insights acknowledged before this are tracked issues and stay exactly as they are
-- (the pages show them as accepted findings, linked to their issue); dismissed insights stay dismissed issue rows; rule
-- results were never stored, so there is nothing to convert or retire.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each must return the stated result):
--   1. Nothing of ours is applied past this one, and nothing named `findings` exists yet. Expect 0 rows, then 0:
--        select version from supabase_migrations.schema_migrations where version >= '20261205000000';
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'findings';
--   2. Apply after row 51 of docs/production-migrations.md (20261204000000, B19 part 2, #194). Expect 1:
--        select count(*) from supabase_migrations.schema_migrations where version = '20261204000000';
--   3. The column is new and the helpers it calls exist. Expect 0, then 3 rows:
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'ai_analyses' and column_name = 'model_hash';
--        select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname in ('can_read_workspace', 'can_edit_workspace', 'set_updated_at');
--
-- POST-APPLY CHECK (authenticated: SELECT, INSERT and UPDATE on findings; anon: nothing; RLS on; the trigger enabled; the
-- function not SECURITY DEFINER with an empty search_path):
--        select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'findings' and grantee in ('anon', 'authenticated') order by 1, 2;
--        select relrowsecurity from pg_class where oid = 'public.findings'::regclass;
--        select tgname, tgenabled from pg_trigger where tgrelid = 'public.findings'::regclass and not tgisinternal order by 1;
--        select prosecdef, proconfig from pg_proc where proname = 'findings_before_write';
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'ai_analyses' and column_name = 'model_hash';
--   Expect: authenticated INSERT, SELECT, UPDATE (no anon row); t; findings_before_write and set_updated_at, both O;
--   f, {search_path=""}; 1.
--
-- ROLLBACK (one transaction; nothing existing was changed, so nothing to put back):
--
--   begin;
--   drop table if exists public.findings;   -- its indexes, triggers and policies go with it
--   drop function if exists private.findings_before_write();
--   alter table public.ai_analyses drop column if exists model_hash;
--   delete from supabase_migrations.schema_migrations where version = '20261205000000';
--   commit;
--
-- Rolling back deletes every finding (proposed, accepted and by hand). Issues acknowledged from findings stay, with their
-- `finding:` key pointing at nothing (the pages list them as issues).

alter table public.ai_analyses
  add column model_hash text check (model_hash is null or char_length(model_hash) <= 100);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Null: across the company, in no single process.
  process_id uuid references public.processes (id) on delete cascade,
  step_id uuid,
  origin text not null check (origin in ('ai', 'manual')),
  status text not null check (status in ('proposed', 'accepted', 'dismissed', 'superseded')),
  rating text not null check (rating in ('risk', 'bad', 'good', 'great')),
  type text not null check (type in ('bottleneck', 'spof', 'manual', 'delay', 'failure', 'idea', 'capacity', 'sla', 'churn_risk')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  evidence text not null default '' check (char_length(evidence) <= 2000),
  why text not null default '' check (char_length(why) <= 2000),
  -- The facts and quotes it rests on, as they read when cited: [{kind: 'fact' | 'quote', key, text}].
  facts jsonb not null default '[]'
    check (jsonb_typeof(facts) = 'array' and jsonb_array_length(facts) <= 30 and octet_length(facts::text) <= 32768),
  source_ids uuid[] not null default '{}' check (cardinality(source_ids) <= 20),
  ai_key text check (ai_key is null or char_length(ai_key) <= 200),
  analysis_id uuid references public.ai_analyses (id) on delete set null,
  run_id uuid references public.ai_runs (id) on delete set null,
  edited boolean not null default false,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  -- An AI finding has its key; one by hand has none.
  constraint findings_ai_key_origin check ((origin = 'ai') = (ai_key is not null))
);

-- The same AI finding is proposed once per process (or once across the company).
create unique index findings_ai_key on public.findings (workspace_id, coalesce(process_id, '00000000-0000-0000-0000-000000000000'::uuid), ai_key)
  where ai_key is not null;
create index on public.findings (workspace_id, status);
create index on public.findings (process_id);
create index on public.findings (analysis_id);
create index on public.findings (run_id);

create function private.findings_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  -- An update where a later run proposes a proposed or superseded AI finding again (new text, facts, analysis and run).
  again boolean := false;
begin
  if new.process_id is not null and not exists (select 1 from public.processes p where p.id = new.process_id and p.workspace_id = new.workspace_id) then
    raise exception 'findings: the process must be one of the workspace''s' using errcode = '23514';
  end if;
  -- Every source it cites is one of its workspace's (read under the caller's RLS, so another workspace's never counts).
  if cardinality(new.source_ids) > 0 and (tg_op = 'INSERT' or new.source_ids is distinct from old.source_ids) and exists (
    select 1 from unnest(new.source_ids) as c (id)
    where not exists (select 1 from public.sources s where s.id = c.id and s.workspace_id = new.workspace_id)
  ) then
    raise exception 'findings: every source cited must be one of the workspace''s' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    again := old.origin = 'ai' and new.origin = 'ai' and new.status = 'proposed' and old.status in ('proposed', 'superseded')
      and new.run_id is not null and new.run_id is distinct from old.run_id;
  end if;

  -- An AI finding (proposed now, or again) comes from an analysis the caller wrote in the last 15 minutes, by that
  -- analysis's run. Signed-in callers only; the system (uid null) is trusted.
  if (tg_op = 'INSERT' and new.origin = 'ai') or again then
    if new.status <> 'proposed' then
      raise exception 'findings: an AI finding starts as proposed' using errcode = '23514';
    end if;
    if uid is not null and not exists (
      select 1 from public.ai_analyses a
      where a.id = new.analysis_id and a.workspace_id = new.workspace_id and a.created_by = uid
        and a.run_id = new.run_id and a.updated_at > now() - interval '15 minutes'
    ) then
      raise exception 'findings: an AI finding must come from an analysis you ran in the last 15 minutes' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(uid, new.created_by);
    new.created_at := now();
    new.updated_by := uid;
    new.updated_at := now();
    new.edited := false;
    if new.origin = 'ai' then
      new.decided_by := null;
      new.decided_at := null;
    else
      if new.status <> 'accepted' or new.analysis_id is not null or new.run_id is not null then
        raise exception 'findings: a finding added by hand starts accepted and cites no analysis' using errcode = '23514';
      end if;
      new.decided_by := uid;
      new.decided_at := now();
    end if;
    return new;
  end if;

  -- UPDATE
  if new.workspace_id is distinct from old.workspace_id
    or new.origin is distinct from old.origin
    or new.ai_key is distinct from old.ai_key
    or new.created_at is distinct from old.created_at
    or (new.created_by is distinct from old.created_by and new.created_by is not null)
    or (not again and new.analysis_id is distinct from old.analysis_id and new.analysis_id is not null)
    or (not again and new.run_id is distinct from old.run_id and new.run_id is not null) then
    raise exception 'findings: workspace, origin, key, analysis, run and creator cannot be changed' using errcode = '23514';
  end if;

  if again then
    -- What the later run wrote replaces the proposal; nobody has decided it, and nobody has edited it (an edit accepts).
    new.edited := false;
    new.decided_by := null;
    new.decided_at := null;
  else
    if new.origin = 'ai' and new.facts is distinct from old.facts then
      raise exception 'findings: the facts an AI finding cites stay as they were cited' using errcode = '23514';
    end if;
    if new.status is distinct from old.status then
      if new.status = 'proposed' then
        raise exception 'findings: a finding cannot go back to proposed' using errcode = '23514';
      end if;
      if old.status = 'superseded' then
        raise exception 'findings: a later analysis replaced this proposal, so it can''t be decided; analyse again' using errcode = '23514';
      end if;
      if new.status = 'superseded' and (old.status <> 'proposed' or old.origin <> 'ai') then
        raise exception 'findings: only a proposed AI finding is superseded' using errcode = '23514';
      end if;
      new.decided_by := coalesce(uid, new.decided_by);
      new.decided_at := now();
    else
      new.decided_by := case when uid is null then new.decided_by else old.decided_by end;
      new.decided_at := old.decided_at;
    end if;
    -- Set here only: an AI finding whose words, rating, kind, place or sources a person changed reads as edited.
    new.edited := old.edited or (old.origin = 'ai' and (
      new.title is distinct from old.title or new.evidence is distinct from old.evidence or new.why is distinct from old.why
      or new.rating is distinct from old.rating or new.type is distinct from old.type or new.step_id is distinct from old.step_id
      or new.process_id is distinct from old.process_id or new.source_ids is distinct from old.source_ids));
  end if;
  if uid is not null then
    new.updated_by := uid;
  end if;
  return new;
end;
$$;

revoke all on function private.findings_before_write() from public, anon, authenticated;

create trigger findings_before_write before insert or update on public.findings
  for each row execute function private.findings_before_write();

create trigger set_updated_at before update on public.findings
  for each row execute function public.set_updated_at();

alter table public.findings enable row level security;

create policy "read findings" on public.findings for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert findings" on public.findings for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update findings" on public.findings for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));

revoke all on public.findings from anon, authenticated;
grant select, insert, update on public.findings to authenticated;
