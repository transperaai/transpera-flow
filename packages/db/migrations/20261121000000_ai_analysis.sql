-- AI analysis (issue #111, A46; docs/analysis-rules.md "What AI does", docs/adr/0013-ai-analysis.md).
--
-- AI runs alongside the rules: it reads a published version's results, rule findings, first principles and (if the
-- workspace lets it) linked sources, and writes a short "AI read of this run", insights marked AI, and a review of the
-- first principles. Every number in what it writes is checked against the run before it is stored (the narration check,
-- docs/adr/0011-narration.md); this migration only stores the outcome and bounds the cost.
--
-- Three tables and one function:
--
--   * `ai_settings`: one row per workspace with the five switches on Settings -> AI analysis. No row means the defaults
--     (the column defaults). Written per switch (an upsert of one column), so two people flipping different switches
--     can't undo each other. `market_pending_at` debounces the market-change trigger (see below); it is not a switch.
--   * `ai_runs`: an append-only log of every model run that was started, one row per run, written only by
--     `reserve_ai_run`. It is what the daily cap and the per-process cooldown count, so they hold whatever else is done:
--     re-runs, failed runs, deleted analyses. Authenticated users can read it and cannot insert, update or delete.
--   * `ai_analyses`: one row per process revision (a published or superseded version): the read, the insights, the
--     first-principles review, the number check's counts and the model. Stored so a page view never calls the model;
--     a re-run replaces the row. Each row names the run that wrote it (`run_id`), and so who ran it.
--   * `reserve_ai_run(workspace, process, trigger)`: SECURITY DEFINER, with an empty search_path. Justification: the
--     cost bound must not be something an editor can reset, so `ai_runs` has no write grant for `authenticated`, and
--     the one thing that may add a row is this function. It writes no AI content: it checks `can_edit_workspace` for
--     the caller, takes a per-workspace advisory lock (so two parallel reservations can't both squeeze under the cap),
--     refuses at 40 runs in 24 hours for the workspace or a second run of the same process within 60 seconds, and
--     otherwise inserts the run (recording the caller's id and the name of the person linked to their membership, which an
--     invoker can't be trusted to supply) and returns its id.
--
-- Access: every member reads; owners and editors write the switches and the analyses as themselves. A trigger stamps
-- `ai_analyses.created_by` with the caller (it can't be forged) and refuses a row whose `run_id` is not a run the caller
-- reserved for that process, so an editor can only store an analysis against a reservation they paid for. No delete for
-- `authenticated` (analyses go with their revision or workspace). `anon` has nothing.
--
-- Known limit: any editor can still write arbitrary text into an analysis of their own reserved run, through PostgREST
-- with their own session, because the server writes with the user's own credentials and the database can't check the
-- text. The fix is a server-side writer with a service-role key (a production config change; note that `auth.uid()` is
-- null under service_role, so that writer needs its own branch in the stamp trigger); until then the AI read shows who
-- ran it. See ADR 0013.
--
-- Strictly additive: three tables, one function, triggers, row-level security and policies. `save_fields`,
-- `publish_process` and every existing table are unchanged.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--
--   1. The tables and function must not exist yet. Expect 0 rows:
--        select table_name from information_schema.tables
--        where table_schema = 'public' and table_name in ('ai_settings', 'ai_analyses', 'ai_runs');
--        select proname from pg_proc where (pronamespace = 'public'::regnamespace and proname = 'reserve_ai_run')
--          or (pronamespace = 'private'::regnamespace and proname = 'ai_analyses_stamp');
--   (After applying: select proacl from pg_proc where proname = 'reserve_ai_run' must not list anon or public;
--    select grantee, privilege_type from information_schema.role_table_grants where table_name = 'ai_runs'
--    must show authenticated SELECT only, and nothing for anon.)
--   2. The unique index first_principles added on process_revisions exists. Expect 1 row:
--        select indexname from pg_indexes where indexname = 'process_revisions_id_process_workspace_key';
--   3. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261121000000';
--
-- Rollback (run as one transaction):
--
--   begin;
--   drop function if exists public.reserve_ai_run(uuid, uuid, text);
--   drop table if exists public.ai_analyses;
--   drop table if exists public.ai_runs;
--   drop table if exists public.ai_settings;
--   drop function if exists private.ai_analyses_stamp();
--   delete from supabase_migrations.schema_migrations where version = '20261121000000';
--   commit;
--
-- Production data: none needed (no row means the defaults, and no analysis yet).

create table public.ai_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  -- Review each version when it is published.
  review_on_publish boolean not null default true,
  -- Review the live versions again when the market conditions change.
  review_on_market boolean not null default true,
  -- Suggest issues, which land in Suggestions (A52; stored now, used when A52 lands).
  suggest_issues boolean not null default true,
  -- Suggest solution ideas that use blocks from the library (A49; stored now, used when A49 lands).
  suggest_solutions boolean not null default true,
  -- Read the sources linked to a process, and quote them. Off until someone turns it on: it sends interview text to the model.
  read_sources boolean not null default false,
  -- A market change was made at this time and its review hasn't started: each change moves it, and the one run that
  -- claims it (sets it back to null) is the last change's, so a burst of edits makes one run, not one per edit.
  market_pending_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create trigger set_updated_at before update on public.ai_settings
  for each row execute function public.set_updated_at();

alter table public.ai_settings enable row level security;

create policy "read ai_settings" on public.ai_settings for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert ai_settings" on public.ai_settings for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update ai_settings" on public.ai_settings for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
grant select, insert, update on public.ai_settings to authenticated;
revoke delete, truncate on public.ai_settings from authenticated;
revoke all on public.ai_settings from anon;

-- Every started run, append-only. Only reserve_ai_run writes it.
create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Null once the process is deleted: the run still counts against the workspace's cap (the cap counts by workspace_id), so deleting a
  -- process can't reset it.
  process_id uuid references public.processes (id) on delete set null,
  trigger text not null check (trigger in ('publish', 'market', 'manual')),
  -- Who started it, and the name to show for them: the name of the person linked to their membership in this workspace
  -- (People settings), or null. Never an email and never user metadata, which every member can read here and a user can edit.
  user_id uuid references auth.users (id) on delete set null,
  user_name text check (user_name is null or char_length(user_name) <= 200),
  started_at timestamptz not null default now()
);

create index on public.ai_runs (workspace_id, started_at);
create index on public.ai_runs (process_id, started_at);

alter table public.ai_runs enable row level security;

create policy "read ai_runs" on public.ai_runs for select to authenticated
  using (public.can_read_workspace(workspace_id));

-- Read only: no insert, update or delete for authenticated (no policy and no grant). reserve_ai_run is the one writer.
revoke all on public.ai_runs from anon, authenticated;
grant select on public.ai_runs to authenticated;

create function public.reserve_ai_run(p_workspace uuid, p_process uuid, p_trigger text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  used integer;
  recent timestamptz;
  new_id uuid;
  who text;
begin
  if uid is null or p_trigger is null or p_trigger not in ('publish', 'market', 'manual') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if not coalesce(public.can_edit_workspace(p_workspace), false) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if not exists (select 1 from public.processes where id = p_process and workspace_id = p_workspace) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- One reservation at a time per workspace, so the count below can't be raced past.
  perform pg_advisory_xact_lock(hashtextextended('ai_runs:' || p_workspace::text, 0));

  select count(*) into used from public.ai_runs
    where workspace_id = p_workspace and started_at > now() - interval '24 hours';
  if used >= 40 then
    return jsonb_build_object('status', 'limit', 'limit', 40);
  end if;

  select max(started_at) into recent from public.ai_runs
    where process_id = p_process and started_at > now() - interval '60 seconds';
  if recent is not null then
    return jsonb_build_object('status', 'cooldown', 'retry_after_seconds', greatest(1, ceil(extract(epoch from (recent + interval '60 seconds' - now())))::integer));
  end if;

  -- As revision_history does: the person linked to the caller's membership, else nothing.
  select per.name into who
    from public.memberships m
    join public.people per on per.id = m.person_id and per.workspace_id = m.workspace_id
    where m.user_id = uid and m.workspace_id = p_workspace;
  insert into public.ai_runs (workspace_id, process_id, trigger, user_id, user_name)
    values (p_workspace, p_process, p_trigger, uid, left(who, 200))
    returning id into new_id;
  return jsonb_build_object('status', 'ok', 'id', new_id);
end;
$$;

revoke all on function public.reserve_ai_run(uuid, uuid, text) from public, anon;
grant execute on function public.reserve_ai_run(uuid, uuid, text) to authenticated;

create table public.ai_analyses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  process_id uuid not null,
  revision_id uuid not null,

  -- ok: the model wrote it and it passed the number check. unavailable: no API key or the day's limit. failed: the
  -- model refused, timed out, or every draft cited figures that aren't in the run. `reason` says which, in words.
  status text not null check (status in ('ok', 'unavailable', 'failed')),
  reason text check (reason is null or char_length(reason) <= 2000),
  -- What started it.
  trigger text not null check (trigger in ('publish', 'market', 'manual')),

  -- The AI read: a list of paragraphs (strings).
  summary jsonb not null default '[]'
    check (jsonb_typeof(summary) = 'array' and jsonb_array_length(summary) <= 8 and octet_length(summary::text) <= 65536),
  -- The AI insights that passed the number check, each in the shape of an engine finding (key, type, rating, title,
  -- evidence, step_id ...; apps/web/src/lib/ai/types.ts).
  insights jsonb not null default '[]'
    check (jsonb_typeof(insights) = 'array' and jsonb_array_length(insights) <= 30 and octet_length(insights::text) <= 262144),
  -- The AI's review of the first principles: [{step, level, text}].
  review jsonb not null default '[]'
    check (jsonb_typeof(review) = 'array' and jsonb_array_length(review) <= 40 and octet_length(review::text) <= 131072),

  -- Numbers found in what was kept, each matched to a figure of the run; and items dropped for an unmatched number.
  checked integer not null default 0 check (checked >= 0),
  dropped integer not null default 0 check (dropped >= 0),
  -- The facts the model was given, hashed with the prompt version: the same hash means nothing needs re-running.
  input_hash text not null check (char_length(input_hash) <= 100),
  model text check (model is null or char_length(model) <= 200),
  usage jsonb not null default '[]' check (jsonb_typeof(usage) = 'array' and jsonb_array_length(usage) <= 10),

  -- The run that wrote it (reserve_ai_run), so the page can say who ran it.
  run_id uuid not null unique references public.ai_runs (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Stamped by the trigger below with the caller: never what the client sent.
  created_by uuid not null default auth.uid(),

  -- One analysis per version.
  unique (revision_id),
  foreign key (revision_id, process_id, workspace_id) references public.process_revisions (id, process_id, workspace_id) on delete cascade
);

create index on public.ai_analyses (workspace_id, updated_at);
create index on public.ai_analyses (process_id);

create trigger set_updated_at before update on public.ai_analyses
  for each row execute function public.set_updated_at();

-- security invoker: reads ai_runs under the caller's own RLS (members read it).
create function private.ai_analyses_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := auth.uid();
  if not exists (
    select 1 from public.ai_runs r
    where r.id = new.run_id and r.user_id = auth.uid() and r.process_id = new.process_id and r.workspace_id = new.workspace_id
      -- A reservation is for use now: an old one can't be kept and spent later.
      and r.started_at > now() - interval '15 minutes'
  ) then
    raise exception 'ai_analyses: run_id must be a run you reserved for this process in the last 15 minutes' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger ai_analyses_stamp before insert or update on public.ai_analyses
  for each row execute function private.ai_analyses_stamp();

alter table public.ai_analyses enable row level security;

create policy "read ai_analyses" on public.ai_analyses for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert ai_analyses" on public.ai_analyses for insert to authenticated
  with check (public.can_edit_workspace(workspace_id) and created_by = auth.uid());
create policy "update ai_analyses" on public.ai_analyses for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id) and created_by = auth.uid());

-- No delete for authenticated: an analysis goes with its revision or workspace.
grant select, insert, update on public.ai_analyses to authenticated;
revoke delete, truncate on public.ai_analyses from authenticated;
revoke all on public.ai_analyses from anon;
