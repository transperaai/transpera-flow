-- A saved Sandbox scenario can be shared (sandbox phase 5b, docs/plans/sandbox-p5-brief.md section 11; ADR 0016).
--
-- What it does (no row is changed):
--   1. `share_links_kind` also allows 'scenario' (a widening: every existing link passes). `target_id` is the `sandbox_scenarios.id`; view mode
--      only (the play-link check below the insert, `new.kind <> 'process'`, already refuses a play link of any other kind).
--   2. `private.share_links_before_write`: a full copy of the 20261221000000 body (the latest) with one more arm in the insert's target check:
--      a 'scenario' target must be a sandbox scenario of the link's workspace (refused 22023 "That isn't in this workspace." otherwise).
--   3. `private.share_snapshot_problem`: a full copy of the 20270114000000 body (the latest; phase 4 added 'purpose') with
--        a. six more non-text keys, each checked by FORMAT at every depth in step 1 (an object or array under it, or a string that isn't its
--           shape, makes the snapshot "not match the link"): lever ^[A-EX][0-9]$; target a uuid, @busiest, @heaviest, a health rule, a built-in
--           churn driver id or custom:<uuid>; from YYYY-MM or YYYY-MM-DD; parent_id and scenarioId a uuid; startDate YYYY-MM-DD. Numbers,
--           booleans and null hold no words and pass (a first-principles measure has a numeric `target`);
--        b. step 1b, for kind = 'scenario' only: `scenarios` is 1 to 6 objects (the shared scenario and the chain it builds on, root first, each
--           the parent of the next, the last the one in `scenarioId`) whose `changes` pass `private.is_sandbox_changes`; `bundle` an object,
--           `solutions` an array, `startDate` a date, `months` a whole number 1 to 24, `hiddenCostChanges` a whole number >= 0;
--        c. with People off a scenario link holds no D1 change with `params.name` ("The snapshot names a person.");
--        d. with Financials off it holds no change of lever C1 or C2 ("The snapshot contains costs or margins."). Their twins are
--           `redactShareSnapshot` and `shareSnapshotLeaks` (packages/db/src/share.ts).
--      The check for a person's name, a client's name, an email, pay, evidence and money in text (steps 2 to 7) is the one every kind has.
--   `open_share_link`, the grants and `share_links_no_speeds` are unchanged: a scenario link opens like any other and returns its `kind`.
--
-- Runs on a database full of real rows (the production copy imported at 20261231000000, then every later migration): a constraint
-- widening and two function replacements touch no row, and no stored snapshot is read again until it is next written.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270116000000';` expect 0, and 20270115000000 applied.
--     Record, for the post-apply comparison: select kind, count(*) from public.share_links group by 1 order by 1;
-- Post-apply checks (probes in a rolled-back transaction as an Owner or Agency admin; or as the superuser):
--     select pg_get_constraintdef(oid) from pg_constraint where conname = 'share_links_kind';   -- lists 'scenario'
--     -- The same counts by kind as the preflight. Every existing link still opens: select public.open_share_link(...) on one.
--     -- A clean scenario snapshot has no problem (null), and each refused shape is named. With <ws> a workspace, <id1> and <id2> uuids:
--     select private.share_snapshot_problem('<ws>', 'scenario', '{"v":1,"kind":"scenario","toggles":{"people":false,"financials":false},"workspaceName":"W","scenarioId":"<id1>","scenarios":[{"id":"<id1>","name":"S","description":null,"parent_id":null,"changes":[],"horizon_months":12}],"bundle":{},"solutions":[],"startDate":"2027-01-04","months":12,"hiddenCostChanges":0}'::jsonb, false, false);   -- null
--     -- the same with "target":"free text" inside a change, or "lever":["x"], or "months":13 -> "The snapshot doesn't match the link."
--     -- the same with People off and a D1 change {"params":{"name":"Sam"}} -> "The snapshot names a person."; with Financials off and a C2 change -> "The snapshot contains costs or margins."
-- Rollback (take a Neon branch just before `migrate` as the cutover runbook does; or by hand): refused while any scenario link exists
-- (`select count(*) from public.share_links where kind = 'scenario'` must be 0: delete those rows as the system first); then
-- `alter table public.share_links drop constraint share_links_kind; alter table public.share_links add constraint share_links_kind check (kind in ('overview', 'process', 'issue', 'solution'));`,
-- re-run the `share_snapshot_problem` body from 20270114000000_step_purpose.sql and the `share_links_before_write` body from
-- 20261221000000_play_links.sql, then delete the row from public.schema_migrations.

-- Marks any write as the system's, as the migrations since 20270103000000_three_roles.sql do.
select set_config('transpera.actor_kind', 'system', true);

-- 1. A scenario can be shared. Widening: every row passes.
alter table public.share_links drop constraint share_links_kind;
alter table public.share_links add constraint share_links_kind check (kind in ('overview', 'process', 'issue', 'solution', 'scenario'));

-- 2. The write trigger: the 20261221000000 body, one more arm in the insert's target check.
create or replace function private.share_links_before_write() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  ok boolean;
  problem text;
begin
  -- A foreign-key action (a deleted user nulls created_by / revoked_by) runs one trigger level deeper than a direct write.
  -- It may change those two columns to null and nothing else.
  if tg_op = 'UPDATE' and pg_catalog.pg_trigger_depth() > 1
     and (to_jsonb(new) - 'created_by' - 'revoked_by') = (to_jsonb(old) - 'created_by' - 'revoked_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.revoked_by is null or new.revoked_by = old.revoked_by) then
    return new;
  end if;

  -- 1. No API tokens (the MCP server): share links are made in the app. `open_share_link` only counts opens on a row, and
  -- an API-token caller may open a link like anyone, so a counter-only update is not refused.
  if coalesce(auth.jwt(), '{}') ? 'api_token_id'
     and (tg_op = 'INSERT' or new.snapshot is distinct from old.snapshot or new.label is distinct from old.label
          or new.revoked_at is distinct from old.revoked_at or new.engine_version is distinct from old.engine_version) then
    raise exception 'Share links are made in the app.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    -- 2. Stamp the caller; nothing the caller sends for these counts.
    new.created_by := auth.uid();
    new.created_at := now();
    new.snapshot_at := now();
    new.opens := 0;
    new.last_opened_at := null;
    new.revoked_at := null;
    new.revoked_by := null;
    -- B4 begin
    -- A play link shares a process, and its snapshot says which levers the workspace hides (the kinds are checked by
    -- share_snapshot_problem, below).
    if new.mode = 'play' and (new.kind <> 'process' or jsonb_typeof(new.snapshot -> 'hiddenLevers') is distinct from 'array') then
      raise exception 'Only a process can be shared for trying changes.' using errcode = '22023';
    end if;
    -- B4 end
    if new.expires_at is not null and new.expires_at <= now() then
      raise exception 'The end date must be in the future.' using errcode = '22023';
    end if;
    ok := case new.kind
      when 'overview' then true
      when 'process' then exists (
        select 1 from public.processes p
        where p.id = new.target_id and p.workspace_id = new.workspace_id and p.live_revision_id is not null
          and p.archived_at is null and not p.is_company)
      when 'issue' then exists (
        select 1 from public.issues i where i.id = new.target_id and i.workspace_id = new.workspace_id)
      when 'solution' then exists (
        select 1 from public.solutions s where s.id = new.target_id and s.workspace_id = new.workspace_id)
      -- 5b: a saved Sandbox scenario of this workspace.
      when 'scenario' then exists (
        select 1 from public.sandbox_scenarios s where s.id = new.target_id and s.workspace_id = new.workspace_id)
      else false end;
    if not ok then
      raise exception 'That isn''t in this workspace.' using errcode = '22023';
    end if;
    -- An issue or a solution of an archived process shows that process (every process an issue is on, its own or linked): refused
    -- like the process itself, with its own message.
    if new.kind in ('issue', 'solution') and (
         (new.kind = 'issue' and exists (
            select 1 from public.processes p
            where p.workspace_id = new.workspace_id and p.archived_at is not null
              and (p.id = (select i.process_id from public.issues i where i.id = new.target_id)
                or p.id in (select l.process_id from public.issue_links l where l.issue_id = new.target_id and l.process_id is not null))))
      or (new.kind = 'solution' and exists (
            select 1 from public.solutions s join public.processes p on p.id = s.process_id
            where s.id = new.target_id and p.archived_at is not null))) then
      raise exception 'An archived process can''t be shared. Restore it first.' using errcode = '22023';
    end if;
  else
    -- 3. Update. A revoked link stays revoked: no change at all.
    if old.revoked_at is not null then
      raise exception 'This link was turned off.' using errcode = '22023';
    end if;
    if new.workspace_id is distinct from old.workspace_id or new.token_hash is distinct from old.token_hash
       or new.kind is distinct from old.kind or new.target_id is distinct from old.target_id
       or new.mode is distinct from old.mode or new.show_people is distinct from old.show_people
       or new.show_financials is distinct from old.show_financials or new.allowed_emails is distinct from old.allowed_emails
       or new.expires_at is distinct from old.expires_at or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'A link''s settings can''t be changed. Make a new link.' using errcode = '22023';
    end if;
    -- B4 begin
    -- A play link's new snapshot must still carry the list (Update copy rebuilds it through loadShareData, which always adds it).
    if new.mode = 'play' and new.snapshot is distinct from old.snapshot
       and jsonb_typeof(new.snapshot -> 'hiddenLevers') is distinct from 'array' then
      raise exception 'Only a process can be shared for trying changes.' using errcode = '22023';
    end if;
    -- B4 end
    if new.revoked_at is not null then
      new.revoked_at := now();
      new.revoked_by := auth.uid();
    else
      new.revoked_by := old.revoked_by;
    end if;
    if new.snapshot is distinct from old.snapshot then
      new.snapshot_at := now();
    else
      new.snapshot_at := old.snapshot_at;
    end if;
  end if;

  -- 4. The leak check: on insert and whenever the snapshot changes.
  if tg_op = 'INSERT' or new.snapshot is distinct from old.snapshot then
    problem := private.share_snapshot_problem(new.workspace_id, new.kind, new.snapshot, new.show_people, new.show_financials);
    if problem is not null then
      raise exception '%', problem using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- 3. The leak check: the 20270114000000 body, with the scenario rules (see the header).
create or replace function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $$
declare
  -- The keys whose strings are NOT free text: ids, dates, enums and selectors the engine reads (keep equal to SHARE_NON_TEXT_KEYS in
  -- packages/db/src/share.ts). Any other string is free text, so a key nobody classified is checked, not skipped (default deny).
  non_text_keys constant text[] := array['agreed_by', 'kpi', 'archived_at', 'archived_by', 'at', 'auto_verdict',
    'base_revision_id', 'by', 'child_process_id', 'client_id', 'comparator', 'condition_id', 'created_at', 'created_by',
    'currency', 'dataset_id', 'detected_key', 'dismissed_revision_id', 'draft_revision_id', 'driver', 'end_date',
    'entry_process_id', 'entry_step_id', 'every', 'file_url', 'from_step_id', 'id', 'import_source', 'insight_key', 'issueId',
    'issue_id', 'kind', 'linked_parameter', 'live_revision_id', 'op', 'outcome', 'owner_ids', 'owner_person_id',
    'parent_process_id', 'parent_scenario_id', 'parent_step_id', 'path', 'person_id', 'preset', 'pricing_model', 'process_id',
    'published_at', 'published_by', 'purpose', 'recorded_at', 'replaced_by', 'replaces_step_ids', 'resolution', 'resolved_at',
    'resolved_how', 'resolved_solution_id', 'reviewed_at', 'reviewed_by', 'revision_id', 'rework_to_step_id', 'role_id',
    'scenario_id', 'service_id', 'severity', 'slug', 'solutionId', 'solution_id', 'source_id', 'source_ids', 'stage',
    'start_date', 'status', 'step_id', 'suggestion_id', 'timestamp', 'to_step_id', 'type', 'hiddenLevers', 'updated_at',
    'user_verdict', 'verdict', 'wait_dist', 'work_dist', 'workspace_id',
    -- Scenario links (sandbox phase 5b): each is checked by FORMAT at every depth in step 1, so free text cannot hide under one.
    'from', 'lever', 'parent_id', 'scenarioId', 'startDate', 'target'];
  everything text;
  free text;
  ft text[];
  nm record;
  parts text[];
  joined text;
  latin constant text := U&'[a-z\00C0-\024F\1E00-\1EFF]';
  script constant text := U&'^[\1100-\11FF\AC00-\D7AF\3040-\30FF\3400-\4DBF\4E00-\9FFF\F900-\FAFF]{2,}$';
begin
  -- 1. The snapshot is the link's.
  if snap is null or jsonb_typeof(snap) <> 'object'
     or snap -> 'v' is distinct from '1'::jsonb
     or snap -> 'kind' is distinct from to_jsonb(kind)
     or jsonb_typeof(snap -> 'toggles') is distinct from 'object'
     or snap -> 'toggles' -> 'people' is distinct from to_jsonb(show_people)
     or snap -> 'toggles' -> 'financials' is distinct from to_jsonb(show_financials)  -- B4
     -- B4 begin
     -- The kinds a play link hides. Not free text: only known kind ids (so the key can't smuggle a name).
     -- (CASE, not OR: Postgres doesn't promise to stop before jsonb_array_length on a non-array)
     -- The key is a non-text key at ANY depth, so it may appear only once, at the top: a copy nested elsewhere would skip the name checks.
     or jsonb_array_length(jsonb_path_query_array(snap, 'strict $.**.hiddenLevers')) > (case when snap ? 'hiddenLevers' then 1 else 0 end)
     or (snap ? 'hiddenLevers' and case when jsonb_typeof(snap -> 'hiddenLevers') <> 'array' then true else (
         jsonb_array_length(snap -> 'hiddenLevers') > 30
         or exists (select 1 from jsonb_array_elements(snap -> 'hiddenLevers') h
                    where jsonb_typeof(h) <> 'string' or not (h #>> '{}' = any (private.lever_kind_ids())))
         or (select count(distinct h) from jsonb_array_elements(snap -> 'hiddenLevers') h) <> jsonb_array_length(snap -> 'hiddenLevers')) end)
     -- B4 end
     -- 5b begin: a scenario link's keys are non-text keys at ANY depth, so each is checked by format wherever it sits: an object or an
     -- array under it, or a string that is not the key's shape, is refused (a number, a boolean and null hold no words). STRICT, so an
     -- array is itself the item tested (lax mode would unwrap it and let an array of legal strings pass).
     or jsonb_path_exists(snap, 'strict $.**.lever ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^[A-EX][0-9]$")))')
     or jsonb_path_exists(snap, 'strict $.**.target ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@busiest|@heaviest|initial|recover|late_penalty|missed_penalty|late|resp|onb|rework|load|handoff|results|tenure|price|market|custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")))')
     or jsonb_path_exists(snap, 'strict $.**.from ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])(-[0-9]{2})?$")))')
     or jsonb_path_exists(snap, 'strict $.**.parent_id ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")))')
     or jsonb_path_exists(snap, 'strict $.**.scenarioId ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")))')
     or jsonb_path_exists(snap, 'strict $.**.startDate ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}$")))')
     -- 5b end
     then  -- B4
    return 'The snapshot doesn''t match the link.';
  end if;

  -- 1b. A scenario link's own shape (sandbox phase 5b): the scenario and the chain it builds on (1 to 6, root first, each the parent of
  -- the next, the last the shared one), their changes as the database stores them, the frozen start and horizon, the hidden count.
  -- CASE, so nothing reads a value that is not the type it expects.
  if kind = 'scenario' and (
       case
         when jsonb_typeof(snap -> 'scenarios') is distinct from 'array' or jsonb_array_length(snap -> 'scenarios') not between 1 and 6 then true
         when exists (
           select 1 from jsonb_array_elements(snap -> 'scenarios') s
           where jsonb_typeof(s) <> 'object'
              or jsonb_typeof(s -> 'id') is distinct from 'string' or (s ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              or jsonb_typeof(s -> 'name') is distinct from 'string'
              or jsonb_typeof(s -> 'changes') is distinct from 'array'
              or not private.is_sandbox_changes(s -> 'changes')) then true
         when exists (
           select 1 from jsonb_array_elements(snap -> 'scenarios') with ordinality as s (v, n)
           where (n = 1 and jsonb_typeof(s.v -> 'parent_id') not in ('null') and s.v -> 'parent_id' is not null)
              or (n > 1 and (s.v ->> 'parent_id') is distinct from (snap -> 'scenarios' -> (n::int - 2) ->> 'id'))) then true
         when (select count(distinct s ->> 'id') from jsonb_array_elements(snap -> 'scenarios') s) <> jsonb_array_length(snap -> 'scenarios') then true
         when (snap ->> 'scenarioId') is distinct from (snap -> 'scenarios' -> (jsonb_array_length(snap -> 'scenarios') - 1) ->> 'id') then true
         when jsonb_typeof(snap -> 'bundle') is distinct from 'object' or jsonb_typeof(snap -> 'solutions') is distinct from 'array' then true
         when jsonb_typeof(snap -> 'startDate') is distinct from 'string' or (snap ->> 'startDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then true
         when jsonb_typeof(snap -> 'months') is distinct from 'number' or (snap ->> 'months') !~ '^([1-9]|1[0-9]|2[0-4])$' then true
         when jsonb_typeof(snap -> 'hiddenCostChanges') is distinct from 'number' or (snap ->> 'hiddenCostChanges') !~ '^[0-9]{1,4}$' then true
         else false
       end) then
    return 'The snapshot doesn''t match the link.';
  end if;
  -- Every string value, normalised ONCE (the \x01 between them is no space and no letter, so nothing matches across two values),
  -- and the free-text ones on their own. A bare uuid is skipped before it costs a normalisation.
  select string_agg(n.v, E'\x01'), string_agg(n.v, E'\x01') filter (where (n.k is null or n.k <> all (non_text_keys))  -- B3 follow-up
      and not (n.k is not distinct from 'color' and n.raw ~ '^#[0-9a-fA-F]{3,8}$'))  -- B3 follow-up: a whole hex colour is no text
    into everything, free
    from (select s.k, s.v as raw, private.share_norm(s.v) as v from private.share_strings(snap) as s  -- B3 follow-up
          where s.v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') as n;
  everything := coalesce(everything, '');
  free := coalesce(free, '');

  -- 2. No email address, in any string value. The part before the @ ends in a letter, digit or one of _ % + - (so
  -- `roles.@busiest.headcount`, a scenario's selector, is not one).
  if everything ~* '[a-z0-9._%+-]*[a-z0-9_%+-]@[a-z0-9.-]+\.[a-z]{2,}' then
    return 'The snapshot contains an email address.';
  end if;

  -- 3. No pay, for anyone, whatever the toggles (Austin, 6 Oct: no pay data). A string counts as a value.
  if jsonb_path_exists(snap, 'lax $.**.cost_rate ? (@ != null)') then
    return 'The snapshot contains a person''s pay.';
  end if;

  -- 4. No evidence notes: provenance of any JSON type (an empty object or null is fine), and quotes from sources cited as facts.
  if jsonb_path_exists(snap, 'lax $.**.provenance.*')
     or jsonb_path_exists(snap, 'strict $.**.provenance ? (@.type() != "object" && @.type() != "null")')
     or jsonb_path_exists(snap, 'lax $.**.facts ? (@.kind == "quote")') then
    return 'The snapshot contains evidence notes.';
  end if;

  -- 5. Clients are always anonymised, by the whole of the name: its words (stop words left out) one after another in free text
  -- with at most three non-letters between, or run together; never by one word of it ("Group review" is no client).
  select array_agg(distinct t) into ft from regexp_split_to_table(free, '[^[:alpha:]]+') as t where t <> '';
  ft := coalesce(ft, '{}');
  for nm in select private.share_norm(v.name) as name
            from (select c.name from public.clients c where c.workspace_id = ws
                  union
                  select pg_catalog.translate(c.name, U&'\00E4\00F6\00FC\00C4\00D6\00DC', 'aouAOU') from public.clients c where c.workspace_id = ws) as v loop
    parts := array(select x from unnest(regexp_split_to_array(nm.name, '[^[:alpha:]]+')) as x
                   where x <> '' and x not in ('the', 'and', 'for', 'ltd', 'inc', 'llc', 'plc'));
    joined := array_to_string(parts, '');
    continue when cardinality(parts) = 0 or char_length(joined) < (case when joined ~ latin then 3 else 2 end)
               or joined in ('team', 'member', 'client', 'hidden', 'email', 'amount');
    if joined = any (ft) or (joined ~ script and strpos(free, joined) > 0) then
      return 'The snapshot names a client.';
    end if;
    if cardinality(parts) > 1 and parts <@ ft
       and free ~ ('(^|[^[:alpha:]])' || array_to_string(parts, '(([^[:alpha:]]{1,3}(and|the|for|ltd|inc|llc|plc)){0,2}[^[:alpha:]]{1,3})') || '($|[^[:alpha:]])') then
      return 'The snapshot names a client.';
    end if;
  end loop;

  -- 6. People are labels unless People is on: no token of a person's name (first name, surname, any part) in free text, so a name
  -- token can't survive next to a "Team member N" label either; and no Han, Kana or Hangul part of a name anywhere in it.
  if not show_people and (
       exists (select 1 from regexp_split_to_table(free, '[^[:alpha:]]+') as w (tok)
                where w.tok in (select private.share_name_tokens(ws, 'person')))
    or exists (select 1 from private.share_name_tokens(ws, 'script') as s (part) where strpos(free, s.part) > 0)
    -- A scenario link's hire: a D1 change keeps no `params.name` (a candidate's name; the visitor reads "New <role>").
    or (kind = 'scenario' and exists (
          select 1 from jsonb_array_elements(snap -> 'scenarios') s, jsonb_array_elements(s -> 'changes') c
          where c ->> 'lever' = 'D1' and c ? 'params' and (c -> 'params') ? 'name'))) then
    return 'The snapshot names a person.';
  end if;

  -- 7. Financials off: no costs, margins or overhead. A number stored as a string counts; so does a role-rate change inside a
  -- scenario or a solution's lever changes (the visitor's browser would price work at the real rate); so does money in text.
  if not show_financials and (
       jsonb_path_exists(snap, 'lax $.**.default_cost_rate ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
    or jsonb_path_exists(snap, 'lax $.**.margin ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
    or jsonb_path_exists(snap, 'lax $.**.cost_override ? (@ != null)')
    or jsonb_path_exists(snap, 'lax $.**.overhead_monthly')
    or jsonb_path_exists(snap, 'lax $.**.target_margin')
    or jsonb_path_exists(snap, 'lax $.**.path ? (@ like_regex "cost_rate$")')
    -- A scenario link's role-cost and overheads changes (lever C1, C2): an amount of cost. They are dropped, and counted in hiddenCostChanges.
    or (kind = 'scenario' and exists (
          select 1 from jsonb_array_elements(snap -> 'scenarios') s, jsonb_array_elements(s -> 'changes') c
          where c ->> 'lever' in ('C1', 'C2')))
    or everything ~* ('[£$€¥₹][[:space:]]*[0-9]|[0-9][[:space:]]*[£€¥₹]'
      || '|(^|[^a-z0-9])(gbp|usd|eur|aud|nzd|cad|rs\.?)[[:space:]/-]*[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?([^a-z0-9]|$)'
      || '|(^|[^a-z0-9])[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?[[:space:]]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'  -- B3 follow-up
      -- A hyphen or a slash before the code: not the end of a date, a version or a standard's, product's or document's number  -- B3 follow-up
      -- (`shareMoneyRegex` in packages/db/src/money.ts has the same rule and words; a test keeps them equal). An amount or a range  -- B3 follow-up
      -- not glued to a letter, a digit, or a digit and . , - or /; a plain number not after a standard's word (iso 4217), and  -- B3 follow-up
      -- with 1 or 2 digits not after a version word (windows 10, v 1.2), nor, when whole, after a place word (page 3):  -- B3 follow-up
      || '|(?<![a-z0-9])(?<![0-9][.,])(?<![0-9][/-])'  -- B3 follow-up
      || '(([0-9]+(\.[0-9]+)?e[+-]?[0-9]+|[0-9]{1,3}( [0-9]{3})+([.,][0-9]+)?|[0-9]{1,3}([.,][0-9]{3})+([.,][0-9]+)?|[0-9]+([.,][0-9]+)?)([[:space:]]*(k|m|bn))?[[:space:]]*[/-][[:space:]]*)?'  -- B3 follow-up
      || '([0-9]+(\.[0-9]+)?e[+-]?[0-9]+|[0-9]{1,3}( [0-9]{3})+([.,][0-9]+)?|([0-9]{1,3}([.,][0-9]{3})+([.,][0-9]+)?)[.,]?|(?<!(^|[^a-z])(iso|rfc)[[:space:]]+)[0-9]{3,}([.,][0-9]+)?[.,]?'  -- B3 follow-up
      || '|(?<!(^|[^a-z])(iso|rfc)[[:space:]]+)(?<!(^|[^a-z])(windows|win|ios|android|macos|office|version|ver|v|build|release|rev|revision)[[:space:]]+)(?<!(^|[^a-z])(page|pages|p|pp|chapter|ch|section|sec|clause|para|paragraph|article|appendix|annex|row|column|col|table|figure|fig|vol|volume|part|phase|sprint|ticket|slide)[[:space:]]+)[0-9]{1,2}[.,]?'  -- B3 follow-up
      || '|(?<!(^|[^a-z])(iso|rfc)[[:space:]]+)(?<!(^|[^a-z])(windows|win|ios|android|macos|office|version|ver|v|build|release|rev|revision)[[:space:]]+)[0-9]{1,2}[.,][0-9]+[.,]?)'  -- B3 follow-up
      || '([[:space:]]*(k|m|bn))?[[:space:]]*[/-][[:space:]]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'  -- B3 follow-up
      -- ... or glued to a digit and a hyphen or slash when it can't be a date's last part (a range's second amount):  -- B3 follow-up
      || '|(?<=[0-9][/-])([0-9]+(\.[0-9]+)?e[+-]?[0-9]+|[0-9]{1,3}( [0-9]{3})+([.,][0-9]+)?|([0-9]{1,3}([.,][0-9]{3})+([.,][0-9]+)?)[.,]?|[0-9]{3,}([.,][0-9]+)?[.,]?)([[:space:]]*(k|m|bn))?[[:space:]]*[/-][[:space:]]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'  -- B3 follow-up
      || '|[0-9]([[:space:]]*(k|m|bn))?[[:space:]]*(pounds?|dollars?|euros?|quid|sterling)([^a-z]|$)')) then
    return 'The snapshot contains costs or margins.';
  end if;

  return null;
end;
$$;

