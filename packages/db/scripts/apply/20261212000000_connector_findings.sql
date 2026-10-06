-- Production apply file for 20261212000000_connector_findings (B20, issue #197). Strictly additive: one nullable column
-- (`findings.proposed_via`), one partial index and one function redefined (`private.findings_before_write`); applies after
-- row 58 (20261209000000, B1 3/3, #30). Preflight, post-apply checks and rollback (with the old function body in full)
-- are in the migration's own header, repeated below. Apply BEFORE deploying the app (it selects `findings.proposed_via`).

begin;
set local lock_timeout = '5s';

-- Claude outside the app proposes findings (issue #197, B20; Austin's decision 3 on #175, 6 Oct 2026; the MCP tool
-- `propose_finding`, docs/adr/0015-analysis-findings.md addendum).
--
-- Claude connected over MCP may PROPOSE a finding into the analysis review list. It is stored as an AI finding (origin 'ai':
-- Claude is AI) that is proposed, with no analysis or run, and `proposed_via = 'connector'`. A person still accepts, edits or
-- dismisses it in the app, exactly as they do an AI finding; Accept, "AI, edited", Acknowledge as issue and the map feed all
-- work unchanged.
--
-- STRICTLY ADDITIVE: one nullable column, one partial index, and one function redefined (`private.findings_before_write`).
-- No data is rewritten; no table, grant, policy or trigger is created or dropped (the trigger `findings_before_write` keeps
-- pointing at the function by name).
--
--   * `public.findings.proposed_via` (text, nullable, check: null or 'connector'). Null for everything that exists. The
--     trigger stamps it on insert from the request's JWT claims (an API token's request carries `api_token_id`, as
--     `private.api_token_claims` reads it), never from what the client sent, and it never changes afterwards.
--   * `findings_connector_recent` (workspace_id, created_at) where proposed_via = 'connector': the caps below count recent
--     connector proposals per workspace.
--   * `private.findings_before_write`: the 20261205000000 body plus these rules, which apply only to a request made with an
--     API token (a session is unaffected, except that it can't forge the key prefix):
--       - a token may only INSERT a connector proposal: origin 'ai', status 'proposed', no analysis, no run. It can't add a
--         finding by hand (born accepted), can't write an analysis-backed AI finding and can't UPDATE any finding (no
--         accept, dismiss or edit over the API). The check uses pg_trigger_depth() = 1, as `suggestions` does, so foreign-key
--         actions (created_by set to null when a user is deleted) still pass;
--       - the key is computed here: 'ai:connector:' + sha256 of the place and the normalised title (Unicode NFKC, curly
--         quotes straightened, lower case, any run of white space (a no-break space too) one space, trailing punctuation
--         and spaces dropped), so the unique index `findings_ai_key` refuses the same proposal twice (23505), whatever its
--         status: a dismissal stands, and a trailing full stop, a no-break space or a curly apostrophe doesn't beat it;
--       - at most 100 connector proposals per workspace in 24 hours and 50 waiting for review (54000), counted under an
--         advisory lock (as `reserve_ai_run`);
--       - the 15-minute "analysis you ran" rule is skipped for a connector insert; a connector finding is never "proposed
--         again" by a later in-app run; `proposed_via` can't change;
--       - a session can't send a key with the connector prefix (23514).
--   The insert branch already records who (`created_by`, the token's owner) and when (`created_at`).
--
-- Roles need no new code: `insert findings` is `can_edit_workspace` (agency admin, owner, editor); members and viewers get
-- 42501 from row-level security. Members and viewers read connector findings as they read every finding (the app names people
-- by labels, B1 2b, #30).
--
-- Applies after row 58 (20261209000000, B1 3/3, #30), the latest when this was written; it touches nothing they do. The previous definition of the function is the one in
-- 20261205000000_analysis_findings.sql (B1 2b only disabled and re-enabled the trigger). Its md5 (prosrc) on a database built
-- from every migration before this one: 8f5d4dc6a13d64841a9c2611a9889241.
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -f <file>`, one query per file):
--   1. Nothing at or past this version, and the previous row is the latest. Expect only versions below 20261212000000, and
--      the highest to be 20261209000000 (row 58, the previous row of docs/production-migrations.md) unless something later
--      than it has been applied and logged since:
--        select version from supabase_migrations.schema_migrations where version >= '20261205000000' order by 1;
--   2. The column doesn't exist yet. Expect 0:
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'findings' and column_name = 'proposed_via';
--   3. The function body is the one this migration copied. Expect (psql prints proconfig this way)
--      8f5d4dc6a13d64841a9c2611a9889241|f|{"search_path=\"\""}:
--        select md5(prosrc), prosecdef, proconfig from pg_proc where proname = 'findings_before_write';
--   4. No key uses the new prefix. Expect 0:
--        select count(*) from public.findings where ai_key like 'ai:connector:%';
--   5. The two triggers are there and enabled. Expect 2 rows, both O:
--        select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.findings'::regclass and not tgisinternal order by 1;
--   6. The helpers exist. Expect one row, both non-null:
--        select to_regprocedure('auth.jwt()'), to_regprocedure('pg_catalog.hashtextextended(text, bigint)');
--
-- POST-APPLY CHECKS:
--   1. Preflight 2 returns 1, and:
--        select data_type, is_nullable from information_schema.columns where table_name = 'findings' and column_name = 'proposed_via';
--      Expect: text, YES.
--   2. select pg_get_constraintdef(oid) from pg_constraint where conname = 'findings_proposed_via';
--      Expect: the check (proposed_via IS NULL OR proposed_via = 'connector').
--   3. select indexdef from pg_indexes where indexname = 'findings_connector_recent';   -- present, partial
--   4. select prosecdef, proconfig, prosrc like '%ai:connector:%' and prosrc like '%api_token_id%' from pg_proc where proname = 'findings_before_write';
--      Expect: f, {search_path=""}, t.
--   5. Preflight 5 unchanged (2 rows, both O).
--   6. select count(*) from public.findings where proposed_via is not null;   -- 0
--   7. The schema_migrations row for 20261212000000 is present.
--
-- ROLLBACK (one transaction; redeploy the app from before B20 first, since it selects `proposed_via`):
--
--   begin;
--   -- The 20261205000000 body of private.findings_before_write, in full:
--   create or replace function private.findings_before_write() returns trigger
--   language plpgsql
--   set search_path = ''
--   as $$
--   declare
--     uid uuid := auth.uid();
--     -- An update where a later run proposes a proposed or superseded AI finding again (new text, facts, analysis and run).
--     again boolean := false;
--   begin
--     if new.process_id is not null and not exists (select 1 from public.processes p where p.id = new.process_id and p.workspace_id = new.workspace_id) then
--       raise exception 'findings: the process must be one of the workspace''s' using errcode = '23514';
--     end if;
--     -- Every source it cites is one of its workspace's (read under the caller's RLS, so another workspace's never counts).
--     if cardinality(new.source_ids) > 0 and (tg_op = 'INSERT' or new.source_ids is distinct from old.source_ids) and exists (
--       select 1 from unnest(new.source_ids) as c (id)
--       where not exists (select 1 from public.sources s where s.id = c.id and s.workspace_id = new.workspace_id)
--     ) then
--       raise exception 'findings: every source cited must be one of the workspace''s' using errcode = '23514';
--     end if;
--   
--     if tg_op = 'UPDATE' then
--       again := old.origin = 'ai' and new.origin = 'ai' and new.status = 'proposed' and old.status in ('proposed', 'superseded')
--         and new.run_id is not null and new.run_id is distinct from old.run_id;
--     end if;
--   
--     -- An AI finding (proposed now, or again) comes from an analysis the caller wrote in the last 15 minutes, by that
--     -- analysis's run. Signed-in callers only; the system (uid null) is trusted.
--     if (tg_op = 'INSERT' and new.origin = 'ai') or again then
--       if new.status <> 'proposed' then
--         raise exception 'findings: an AI finding starts as proposed' using errcode = '23514';
--       end if;
--       if uid is not null and not exists (
--         select 1 from public.ai_analyses a
--         where a.id = new.analysis_id and a.workspace_id = new.workspace_id and a.created_by = uid
--           and a.run_id = new.run_id and a.updated_at > now() - interval '15 minutes'
--       ) then
--         raise exception 'findings: an AI finding must come from an analysis you ran in the last 15 minutes' using errcode = '42501';
--       end if;
--     end if;
--   
--     if tg_op = 'INSERT' then
--       new.created_by := coalesce(uid, new.created_by);
--       new.created_at := now();
--       new.updated_by := uid;
--       new.updated_at := now();
--       new.edited := false;
--       if new.origin = 'ai' then
--         new.decided_by := null;
--         new.decided_at := null;
--       else
--         if new.status <> 'accepted' or new.analysis_id is not null or new.run_id is not null then
--           raise exception 'findings: a finding added by hand starts accepted and cites no analysis' using errcode = '23514';
--         end if;
--         new.decided_by := uid;
--         new.decided_at := now();
--       end if;
--       return new;
--     end if;
--   
--     -- UPDATE
--     if new.workspace_id is distinct from old.workspace_id
--       or new.origin is distinct from old.origin
--       or new.ai_key is distinct from old.ai_key
--       or new.created_at is distinct from old.created_at
--       or (new.created_by is distinct from old.created_by and new.created_by is not null)
--       or (not again and new.analysis_id is distinct from old.analysis_id and new.analysis_id is not null)
--       or (not again and new.run_id is distinct from old.run_id and new.run_id is not null) then
--       raise exception 'findings: workspace, origin, key, analysis, run and creator cannot be changed' using errcode = '23514';
--     end if;
--   
--     if again then
--       -- What the later run wrote replaces the proposal; nobody has decided it, and nobody has edited it (an edit accepts).
--       new.edited := false;
--       new.decided_by := null;
--       new.decided_at := null;
--     else
--       if new.origin = 'ai' and new.facts is distinct from old.facts then
--         raise exception 'findings: the facts an AI finding cites stay as they were cited' using errcode = '23514';
--       end if;
--       if new.status is distinct from old.status then
--         if new.status = 'proposed' then
--           raise exception 'findings: a finding cannot go back to proposed' using errcode = '23514';
--         end if;
--         if old.status = 'superseded' then
--           raise exception 'findings: a later analysis replaced this proposal, so it can''t be decided; analyse again' using errcode = '23514';
--         end if;
--         if new.status = 'superseded' and (old.status <> 'proposed' or old.origin <> 'ai') then
--           raise exception 'findings: only a proposed AI finding is superseded' using errcode = '23514';
--         end if;
--         new.decided_by := coalesce(uid, new.decided_by);
--         new.decided_at := now();
--       else
--         new.decided_by := case when uid is null then new.decided_by else old.decided_by end;
--         new.decided_at := old.decided_at;
--       end if;
--       -- Set here only: an AI finding whose words, rating, kind, place or sources a person changed reads as edited.
--       new.edited := old.edited or (old.origin = 'ai' and (
--         new.title is distinct from old.title or new.evidence is distinct from old.evidence or new.why is distinct from old.why
--         or new.rating is distinct from old.rating or new.type is distinct from old.type or new.step_id is distinct from old.step_id
--         or new.process_id is distinct from old.process_id or new.source_ids is distinct from old.source_ids));
--     end if;
--     if uid is not null then
--       new.updated_by := uid;
--     end if;
--     return new;
--   end;
--   $$;
--   revoke all on function private.findings_before_write() from public, anon, authenticated;
--   drop index if exists public.findings_connector_recent;
--   alter table public.findings drop column if exists proposed_via;
--   delete from supabase_migrations.schema_migrations where version = '20261212000000';
--   commit;
--
-- Rolled back, connector proposals stay as ordinary AI proposals (ai_key 'ai:connector:...', no analysis); people can still
-- accept or dismiss them. (`create or replace` keeps the trigger and its grants.)

alter table public.findings
  add column proposed_via text constraint findings_proposed_via check (proposed_via is null or proposed_via = 'connector');

-- The connector's caps count recent proposals per workspace.
create index findings_connector_recent on public.findings (workspace_id, created_at) where proposed_via = 'connector';

create or replace function private.findings_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  -- An API token's request carries api_token_id in its claims (private.api_token_claims); the client can't set claims.
  via_token boolean := coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id';
  -- An update where a later run proposes a proposed or superseded AI finding again (new text, facts, analysis and run).
  again boolean := false;
  -- The title as the key reads it (connector proposals).
  norm text;
begin
  -- Over the API a person reviews findings in the app: no accept, dismiss or edit. (Depth 1 lets foreign-key actions through.)
  if tg_op = 'UPDATE' and via_token and pg_catalog.pg_trigger_depth() = 1 then
    raise exception 'findings: a person reviews findings in the app, not over the API' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    -- The database says whether it came through the connector, never the client.
    new.proposed_via := case when via_token then 'connector' end;
    if via_token then
      if new.origin <> 'ai' or new.status <> 'proposed' or new.analysis_id is not null or new.run_id is not null then
        raise exception 'findings: over the connector a finding can only be proposed; a person accepts it in the app' using errcode = '42501';
      end if;
      -- One proposal per place and title: the unique index findings_ai_key refuses it again, whatever its status. The title is
      -- normalised so punctuation, a no-break space or curly quotes can't make a new key: NFKC (a no-break space becomes a
      -- space), curly quotes straight, lower case, white space to one space, trailing punctuation and spaces dropped. Labels,
      -- never names (B1 2b). The tool's own check (titleKey in packages/mcp/src/finding-proposal.ts) does the same.
      norm := pg_catalog.btrim(pg_catalog.lower(pg_catalog.translate(normalize(new.title, NFKC), '‘’“”', '''''""')));
      norm := pg_catalog.btrim(pg_catalog.regexp_replace(norm, '[[:space:]]+', ' ', 'g'));
      norm := pg_catalog.btrim(pg_catalog.regexp_replace(norm, '[]).!?,;:''"–—-]+$', ''));
      new.ai_key := 'ai:connector:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        coalesce(new.process_id::text, 'company') || '|' || norm,
        'UTF8')), 'hex');
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('findings_connector:' || new.workspace_id::text, 0));
      if (select pg_catalog.count(*) from public.findings f where f.workspace_id = new.workspace_id and f.proposed_via = 'connector'
          and f.created_at > pg_catalog.now() - interval '24 hours') >= 100 then
        raise exception 'findings: this workspace has had 100 findings proposed over the connector in the last 24 hours' using errcode = '54000';
      end if;
      if (select pg_catalog.count(*) from public.findings f where f.workspace_id = new.workspace_id and f.proposed_via = 'connector'
          and f.status = 'proposed') >= 50 then
        raise exception 'findings: 50 findings proposed over the connector are waiting for review; review them in the app first' using errcode = '54000';
      end if;
    elsif new.ai_key like 'ai:connector:%' then
      raise exception 'findings: that key is kept for findings proposed over the connector' using errcode = '23514';
    end if;
  end if;

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
      and new.run_id is not null and new.run_id is distinct from old.run_id and old.proposed_via is null;
  end if;

  -- An AI finding (proposed now, or again) comes from an analysis the caller wrote in the last 15 minutes, by that
  -- analysis's run. Signed-in callers only; the system (uid null) is trusted. A connector proposal has no analysis.
  if (tg_op = 'INSERT' and new.origin = 'ai' and not via_token) or again then
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
    or new.proposed_via is distinct from old.proposed_via
    or new.created_at is distinct from old.created_at
    or (new.created_by is distinct from old.created_by and new.created_by is not null)
    or (not again and new.analysis_id is distinct from old.analysis_id and new.analysis_id is not null)
    or (not again and new.run_id is distinct from old.run_id and new.run_id is not null) then
    raise exception 'findings: workspace, origin, key, how it was proposed, analysis, run and creator cannot be changed' using errcode = '23514';
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

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261212000000', 'connector_findings', array[$mig$-- Claude outside the app proposes findings (issue #197, B20; Austin's decision 3 on #175, 6 Oct 2026; the MCP tool
-- `propose_finding`, docs/adr/0015-analysis-findings.md addendum).
--
-- Claude connected over MCP may PROPOSE a finding into the analysis review list. It is stored as an AI finding (origin 'ai':
-- Claude is AI) that is proposed, with no analysis or run, and `proposed_via = 'connector'`. A person still accepts, edits or
-- dismisses it in the app, exactly as they do an AI finding; Accept, "AI, edited", Acknowledge as issue and the map feed all
-- work unchanged.
--
-- STRICTLY ADDITIVE: one nullable column, one partial index, and one function redefined (`private.findings_before_write`).
-- No data is rewritten; no table, grant, policy or trigger is created or dropped (the trigger `findings_before_write` keeps
-- pointing at the function by name).
--
--   * `public.findings.proposed_via` (text, nullable, check: null or 'connector'). Null for everything that exists. The
--     trigger stamps it on insert from the request's JWT claims (an API token's request carries `api_token_id`, as
--     `private.api_token_claims` reads it), never from what the client sent, and it never changes afterwards.
--   * `findings_connector_recent` (workspace_id, created_at) where proposed_via = 'connector': the caps below count recent
--     connector proposals per workspace.
--   * `private.findings_before_write`: the 20261205000000 body plus these rules, which apply only to a request made with an
--     API token (a session is unaffected, except that it can't forge the key prefix):
--       - a token may only INSERT a connector proposal: origin 'ai', status 'proposed', no analysis, no run. It can't add a
--         finding by hand (born accepted), can't write an analysis-backed AI finding and can't UPDATE any finding (no
--         accept, dismiss or edit over the API). The check uses pg_trigger_depth() = 1, as `suggestions` does, so foreign-key
--         actions (created_by set to null when a user is deleted) still pass;
--       - the key is computed here: 'ai:connector:' + sha256 of the place and the normalised title (Unicode NFKC, curly
--         quotes straightened, lower case, any run of white space (a no-break space too) one space, trailing punctuation
--         and spaces dropped), so the unique index `findings_ai_key` refuses the same proposal twice (23505), whatever its
--         status: a dismissal stands, and a trailing full stop, a no-break space or a curly apostrophe doesn't beat it;
--       - at most 100 connector proposals per workspace in 24 hours and 50 waiting for review (54000), counted under an
--         advisory lock (as `reserve_ai_run`);
--       - the 15-minute "analysis you ran" rule is skipped for a connector insert; a connector finding is never "proposed
--         again" by a later in-app run; `proposed_via` can't change;
--       - a session can't send a key with the connector prefix (23514).
--   The insert branch already records who (`created_by`, the token's owner) and when (`created_at`).
--
-- Roles need no new code: `insert findings` is `can_edit_workspace` (agency admin, owner, editor); members and viewers get
-- 42501 from row-level security. Members and viewers read connector findings as they read every finding (the app names people
-- by labels, B1 2b, #30).
--
-- Applies after row 58 (20261209000000, B1 3/3, #30), the latest when this was written; it touches nothing they do. The previous definition of the function is the one in
-- 20261205000000_analysis_findings.sql (B1 2b only disabled and re-enabled the trigger). Its md5 (prosrc) on a database built
-- from every migration before this one: 8f5d4dc6a13d64841a9c2611a9889241.
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -f <file>`, one query per file):
--   1. Nothing at or past this version, and the previous row is the latest. Expect only versions below 20261212000000, and
--      the highest to be 20261209000000 (row 58, the previous row of docs/production-migrations.md) unless something later
--      than it has been applied and logged since:
--        select version from supabase_migrations.schema_migrations where version >= '20261205000000' order by 1;
--   2. The column doesn't exist yet. Expect 0:
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'findings' and column_name = 'proposed_via';
--   3. The function body is the one this migration copied. Expect (psql prints proconfig this way)
--      8f5d4dc6a13d64841a9c2611a9889241|f|{"search_path=\"\""}:
--        select md5(prosrc), prosecdef, proconfig from pg_proc where proname = 'findings_before_write';
--   4. No key uses the new prefix. Expect 0:
--        select count(*) from public.findings where ai_key like 'ai:connector:%';
--   5. The two triggers are there and enabled. Expect 2 rows, both O:
--        select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.findings'::regclass and not tgisinternal order by 1;
--   6. The helpers exist. Expect one row, both non-null:
--        select to_regprocedure('auth.jwt()'), to_regprocedure('pg_catalog.hashtextextended(text, bigint)');
--
-- POST-APPLY CHECKS:
--   1. Preflight 2 returns 1, and:
--        select data_type, is_nullable from information_schema.columns where table_name = 'findings' and column_name = 'proposed_via';
--      Expect: text, YES.
--   2. select pg_get_constraintdef(oid) from pg_constraint where conname = 'findings_proposed_via';
--      Expect: the check (proposed_via IS NULL OR proposed_via = 'connector').
--   3. select indexdef from pg_indexes where indexname = 'findings_connector_recent';   -- present, partial
--   4. select prosecdef, proconfig, prosrc like '%ai:connector:%' and prosrc like '%api_token_id%' from pg_proc where proname = 'findings_before_write';
--      Expect: f, {search_path=""}, t.
--   5. Preflight 5 unchanged (2 rows, both O).
--   6. select count(*) from public.findings where proposed_via is not null;   -- 0
--   7. The schema_migrations row for 20261212000000 is present.
--
-- ROLLBACK (one transaction; redeploy the app from before B20 first, since it selects `proposed_via`):
--
--   begin;
--   -- The 20261205000000 body of private.findings_before_write, in full:
--   create or replace function private.findings_before_write() returns trigger
--   language plpgsql
--   set search_path = ''
--   as $$
--   declare
--     uid uuid := auth.uid();
--     -- An update where a later run proposes a proposed or superseded AI finding again (new text, facts, analysis and run).
--     again boolean := false;
--   begin
--     if new.process_id is not null and not exists (select 1 from public.processes p where p.id = new.process_id and p.workspace_id = new.workspace_id) then
--       raise exception 'findings: the process must be one of the workspace''s' using errcode = '23514';
--     end if;
--     -- Every source it cites is one of its workspace's (read under the caller's RLS, so another workspace's never counts).
--     if cardinality(new.source_ids) > 0 and (tg_op = 'INSERT' or new.source_ids is distinct from old.source_ids) and exists (
--       select 1 from unnest(new.source_ids) as c (id)
--       where not exists (select 1 from public.sources s where s.id = c.id and s.workspace_id = new.workspace_id)
--     ) then
--       raise exception 'findings: every source cited must be one of the workspace''s' using errcode = '23514';
--     end if;
--   
--     if tg_op = 'UPDATE' then
--       again := old.origin = 'ai' and new.origin = 'ai' and new.status = 'proposed' and old.status in ('proposed', 'superseded')
--         and new.run_id is not null and new.run_id is distinct from old.run_id;
--     end if;
--   
--     -- An AI finding (proposed now, or again) comes from an analysis the caller wrote in the last 15 minutes, by that
--     -- analysis's run. Signed-in callers only; the system (uid null) is trusted.
--     if (tg_op = 'INSERT' and new.origin = 'ai') or again then
--       if new.status <> 'proposed' then
--         raise exception 'findings: an AI finding starts as proposed' using errcode = '23514';
--       end if;
--       if uid is not null and not exists (
--         select 1 from public.ai_analyses a
--         where a.id = new.analysis_id and a.workspace_id = new.workspace_id and a.created_by = uid
--           and a.run_id = new.run_id and a.updated_at > now() - interval '15 minutes'
--       ) then
--         raise exception 'findings: an AI finding must come from an analysis you ran in the last 15 minutes' using errcode = '42501';
--       end if;
--     end if;
--   
--     if tg_op = 'INSERT' then
--       new.created_by := coalesce(uid, new.created_by);
--       new.created_at := now();
--       new.updated_by := uid;
--       new.updated_at := now();
--       new.edited := false;
--       if new.origin = 'ai' then
--         new.decided_by := null;
--         new.decided_at := null;
--       else
--         if new.status <> 'accepted' or new.analysis_id is not null or new.run_id is not null then
--           raise exception 'findings: a finding added by hand starts accepted and cites no analysis' using errcode = '23514';
--         end if;
--         new.decided_by := uid;
--         new.decided_at := now();
--       end if;
--       return new;
--     end if;
--   
--     -- UPDATE
--     if new.workspace_id is distinct from old.workspace_id
--       or new.origin is distinct from old.origin
--       or new.ai_key is distinct from old.ai_key
--       or new.created_at is distinct from old.created_at
--       or (new.created_by is distinct from old.created_by and new.created_by is not null)
--       or (not again and new.analysis_id is distinct from old.analysis_id and new.analysis_id is not null)
--       or (not again and new.run_id is distinct from old.run_id and new.run_id is not null) then
--       raise exception 'findings: workspace, origin, key, analysis, run and creator cannot be changed' using errcode = '23514';
--     end if;
--   
--     if again then
--       -- What the later run wrote replaces the proposal; nobody has decided it, and nobody has edited it (an edit accepts).
--       new.edited := false;
--       new.decided_by := null;
--       new.decided_at := null;
--     else
--       if new.origin = 'ai' and new.facts is distinct from old.facts then
--         raise exception 'findings: the facts an AI finding cites stay as they were cited' using errcode = '23514';
--       end if;
--       if new.status is distinct from old.status then
--         if new.status = 'proposed' then
--           raise exception 'findings: a finding cannot go back to proposed' using errcode = '23514';
--         end if;
--         if old.status = 'superseded' then
--           raise exception 'findings: a later analysis replaced this proposal, so it can''t be decided; analyse again' using errcode = '23514';
--         end if;
--         if new.status = 'superseded' and (old.status <> 'proposed' or old.origin <> 'ai') then
--           raise exception 'findings: only a proposed AI finding is superseded' using errcode = '23514';
--         end if;
--         new.decided_by := coalesce(uid, new.decided_by);
--         new.decided_at := now();
--       else
--         new.decided_by := case when uid is null then new.decided_by else old.decided_by end;
--         new.decided_at := old.decided_at;
--       end if;
--       -- Set here only: an AI finding whose words, rating, kind, place or sources a person changed reads as edited.
--       new.edited := old.edited or (old.origin = 'ai' and (
--         new.title is distinct from old.title or new.evidence is distinct from old.evidence or new.why is distinct from old.why
--         or new.rating is distinct from old.rating or new.type is distinct from old.type or new.step_id is distinct from old.step_id
--         or new.process_id is distinct from old.process_id or new.source_ids is distinct from old.source_ids));
--     end if;
--     if uid is not null then
--       new.updated_by := uid;
--     end if;
--     return new;
--   end;
--   $$;
--   revoke all on function private.findings_before_write() from public, anon, authenticated;
--   drop index if exists public.findings_connector_recent;
--   alter table public.findings drop column if exists proposed_via;
--   delete from supabase_migrations.schema_migrations where version = '20261212000000';
--   commit;
--
-- Rolled back, connector proposals stay as ordinary AI proposals (ai_key 'ai:connector:...', no analysis); people can still
-- accept or dismiss them. (`create or replace` keeps the trigger and its grants.)

alter table public.findings
  add column proposed_via text constraint findings_proposed_via check (proposed_via is null or proposed_via = 'connector');

-- The connector's caps count recent proposals per workspace.
create index findings_connector_recent on public.findings (workspace_id, created_at) where proposed_via = 'connector';

create or replace function private.findings_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  -- An API token's request carries api_token_id in its claims (private.api_token_claims); the client can't set claims.
  via_token boolean := coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id';
  -- An update where a later run proposes a proposed or superseded AI finding again (new text, facts, analysis and run).
  again boolean := false;
  -- The title as the key reads it (connector proposals).
  norm text;
begin
  -- Over the API a person reviews findings in the app: no accept, dismiss or edit. (Depth 1 lets foreign-key actions through.)
  if tg_op = 'UPDATE' and via_token and pg_catalog.pg_trigger_depth() = 1 then
    raise exception 'findings: a person reviews findings in the app, not over the API' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    -- The database says whether it came through the connector, never the client.
    new.proposed_via := case when via_token then 'connector' end;
    if via_token then
      if new.origin <> 'ai' or new.status <> 'proposed' or new.analysis_id is not null or new.run_id is not null then
        raise exception 'findings: over the connector a finding can only be proposed; a person accepts it in the app' using errcode = '42501';
      end if;
      -- One proposal per place and title: the unique index findings_ai_key refuses it again, whatever its status. The title is
      -- normalised so punctuation, a no-break space or curly quotes can't make a new key: NFKC (a no-break space becomes a
      -- space), curly quotes straight, lower case, white space to one space, trailing punctuation and spaces dropped. Labels,
      -- never names (B1 2b). The tool's own check (titleKey in packages/mcp/src/finding-proposal.ts) does the same.
      norm := pg_catalog.btrim(pg_catalog.lower(pg_catalog.translate(normalize(new.title, NFKC), '‘’“”', '''''""')));
      norm := pg_catalog.btrim(pg_catalog.regexp_replace(norm, '[[:space:]]+', ' ', 'g'));
      norm := pg_catalog.btrim(pg_catalog.regexp_replace(norm, '[]).!?,;:''"–—-]+$', ''));
      new.ai_key := 'ai:connector:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        coalesce(new.process_id::text, 'company') || '|' || norm,
        'UTF8')), 'hex');
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('findings_connector:' || new.workspace_id::text, 0));
      if (select pg_catalog.count(*) from public.findings f where f.workspace_id = new.workspace_id and f.proposed_via = 'connector'
          and f.created_at > pg_catalog.now() - interval '24 hours') >= 100 then
        raise exception 'findings: this workspace has had 100 findings proposed over the connector in the last 24 hours' using errcode = '54000';
      end if;
      if (select pg_catalog.count(*) from public.findings f where f.workspace_id = new.workspace_id and f.proposed_via = 'connector'
          and f.status = 'proposed') >= 50 then
        raise exception 'findings: 50 findings proposed over the connector are waiting for review; review them in the app first' using errcode = '54000';
      end if;
    elsif new.ai_key like 'ai:connector:%' then
      raise exception 'findings: that key is kept for findings proposed over the connector' using errcode = '23514';
    end if;
  end if;

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
      and new.run_id is not null and new.run_id is distinct from old.run_id and old.proposed_via is null;
  end if;

  -- An AI finding (proposed now, or again) comes from an analysis the caller wrote in the last 15 minutes, by that
  -- analysis's run. Signed-in callers only; the system (uid null) is trusted. A connector proposal has no analysis.
  if (tg_op = 'INSERT' and new.origin = 'ai' and not via_token) or again then
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
    or new.proposed_via is distinct from old.proposed_via
    or new.created_at is distinct from old.created_at
    or (new.created_by is distinct from old.created_by and new.created_by is not null)
    or (not again and new.analysis_id is distinct from old.analysis_id and new.analysis_id is not null)
    or (not again and new.run_id is distinct from old.run_id and new.run_id is not null) then
    raise exception 'findings: workspace, origin, key, how it was proposed, analysis, run and creator cannot be changed' using errcode = '23514';
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
$mig$]);

commit;
