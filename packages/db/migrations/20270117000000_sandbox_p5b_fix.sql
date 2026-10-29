-- Sandbox phase 5b review fixes (docs/plans/sandbox-p5-brief.md section 11; ADR 0016).
--
-- What it does (no row is changed):
--   1. `private.share_snapshot_problem`: a full copy of the 20270116000000 body (the latest) with step 7's patch rule widened. With Financials
--      off, a `path` ending in `overhead_monthly` is refused as well as one ending in `cost_rate`. A Sandbox scenario whose changes are all
--      whole-run patches is listed on the process page (and so in a process or Overview link's `scenarios[].patch`); its C2 change (overheads a
--      month) is the patch `{"path": "finances.overhead_monthly", "value": <the amount>}`, which neither twin caught, so the amount reached a
--      Financials-off link. The app now drops it (`isCostPatch`, packages/db/src/share.ts) as it drops a role rate; this is the database's twin.
--   `open_share_link`, `share_links_before_write`, the grants and the constraints are unchanged.
--
-- Runs on a database full of real rows (the production copy imported at 20261231000000, then every later migration): one function replacement,
-- no row read or written. A stored snapshot is checked again only when it is next written (Update copy): an existing Financials-off link whose
-- copy holds an overheads patch keeps opening, and its Update copy now rebuilds without it (the app drops it before the check).
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270117000000';` expect 0, and 20270116000000 applied.
--     Optional, to know which stored copies hold the amount (Update copy, or revoke and re-make, each of them):
--     select id, kind from public.share_links where not show_financials and revoked_at is null
--       and jsonb_path_exists(snapshot, 'lax $.**.path ? (@ like_regex "overhead_monthly$")');
-- Post-apply checks (as the superuser, with <ws> any workspace id):
--     select private.share_snapshot_problem('<ws>', 'overview', '{"v":1,"kind":"overview","toggles":{"people":false,"financials":false},"scenarios":[{"patch":[{"path":"finances.overhead_monthly","op":"set","value":9000}]}]}'::jsonb, false, false);
--       -- "The snapshot contains costs or margins."
--     -- the same with "path":"steps.x.work_hours" -> null; and with Financials on (toggles and the last argument true) -> null.
-- Rollback (take a Neon branch just before `migrate` as the cutover runbook does; or by hand): re-run the `share_snapshot_problem` body from
-- 20270116000000_scenario_share_links.sql, then delete the row from public.schema_migrations.

-- Marks any write as the system's, as the migrations since 20270103000000_three_roles.sql do.
select set_config('transpera.actor_kind', 'system', true);

-- 1. The leak check: the 20270116000000 body, with the overheads patch refused when Financials is off.
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
  -- scenario or a solution's lever changes (the visitor's browser would price work at the real rate), and an overheads change; so does money in text.
  if not show_financials and (
       jsonb_path_exists(snap, 'lax $.**.default_cost_rate ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
    or jsonb_path_exists(snap, 'lax $.**.margin ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
    or jsonb_path_exists(snap, 'lax $.**.cost_override ? (@ != null)')
    or jsonb_path_exists(snap, 'lax $.**.overhead_monthly')
    or jsonb_path_exists(snap, 'lax $.**.target_margin')
    -- 5b review: an overheads change too (a Sandbox scenario's whole-run C2 change is the patch `finances.overhead_monthly`).
    or jsonb_path_exists(snap, 'lax $.**.path ? (@ like_regex "(cost_rate|overhead_monthly)$")')
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

