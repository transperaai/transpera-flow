-- Production apply file for 20261224500000_share_money_rule (a B3 follow-up, issue #32). ONE replaced function:
-- `private.share_snapshot_problem` (a full copy of B4's body, 20261221000000, with step 7's number-before-code money rule tightened,
-- `color` and `plan` taken off its list of keys that are no text, and a whole hex colour under `color` skipped as no text).
-- This is row 69 of docs/production-migrations.md; apply it after row 68 (20261224000000, applied) and row 67 (20261223000000, C6),
-- else renumber per HANDOVER. Preflight, post-apply checks and rollback are in the migration's own header, repeated below.
-- Apply it before or with the app change (the app's rule hides at least what this one refuses). Sets `lock_timeout` to 5 s.

begin;
set local lock_timeout = '5s';

-- Share links: the money rule no longer hides dates, versions and standard codes; `color` and `plan` are free text (B3 follow-ups,
-- issue #32; the optional findings of the B3 verification on PR #215, approved by Austin on 7 Oct, and the review of PR #233;
-- docs/adr/0016-share-links.md).
--
-- With Financials off a share link hides money in text, and the database refuses a snapshot that still holds some. The rule for a
-- number followed by a currency code accepted a hyphen or a slash between them, and any number, so it also caught text that is no
-- money: "2026-10-06-CAD" read "2026-10-[amount hidden]", and "ISO 4217-GBP", "Windows 10-USD", "v1.2/EUR" and "page 3/GBP" were
-- hidden too. Now:
--   * a SPACE between the number and the code: unchanged ("1,200 GBP", "1e6 gbp", "4,100-4,500 GBP");
--   * a HYPHEN or a SLASH between them ("4100-GBP", "4100/GBP"): the amount before the code is not glued to a letter or a digit,
--     nor to a digit and a dot or comma ("v1.2"), nor to a digit and a hyphen or slash ("2026-10-06") unless it has 3 or more
--     digits, thousands groups or an exponent (a range's second amount). A sign or a separator after a letter or a space counts
--     ("-4100-GBP", "x/4100-GBP"); a range is matched whole ("4,100-4,500-GBP", "4100/4500/GBP"). A plain number (no groups, no
--     exponent) right after "iso" or "rfc" is a standard's number; a plain 1- or 2-digit one right after a version word
--     (JOIN_VERSION_WORDS in packages/db/src/money.ts: "windows", "version", "v" ...) is a version, whole or decimal ("v 1.2"); and a
--     WHOLE 1- or 2-digit one right after a place word (JOIN_PLACE_WORDS: "page", "row", "part" ...) is a place in a document. A
--     decimal after a place word is money ("page 12.50-GBP", "row 99,99-EUR");
--   * a code BEFORE the number ("GBP-4100", "GBP/4100", "usd-1e6"), symbols ("£4.1k", "4,512€") and amounts in words ("quid"):
--     unchanged.
-- The app applies the same rule (`shareMoneyRegex`); a test keeps the word lists equal, and one list of texts runs through both
-- and through the rule before this change. The new rule matches a subset of what the old one matched (every text it refuses, the
-- old one refused), so no snapshot the database accepts today is refused after this.
--
-- `color` (roles) and `plan` (workspaces) leave the list of keys that are no text: the database checks neither value (no check
-- constraint), so a name typed into one skipped the name checks. They are free text now, in the app (`SHARE_NON_TEXT_REASONS`) and
-- here: checked like any other string. Neither is engine input, so no number moves. Strictly more is checked: a stored snapshot
-- with a person's or a client's name in a role's colour or the plan would be refused at its next Update copy (preflight 3 counts
-- them; expect none). A `color` value that is a whole hex colour (`#rgb` to `#rrggbbaa`) is no text, so a colour whose letters spell
-- a name ("#ada123" and a person called Ada) is neither hidden nor refused; the app's SHARE_HEX_COLOR is the same rule.
--
-- What this REPLACES, with `create or replace`, the same signature, language, volatility, security flag and `set search_path = ''`,
-- as a full copy of the body named, changing only the lines marked `-- B3 follow-up` (a test checks it):
--   * private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)   from 20261221000000_play_links.sql (B4, row 66, the newest):
--     one line of step 7's money pattern (the number before a code) becomes a space-only form and a hyphen-or-slash form, two
--     lines of `non_text_keys` lose `color` and `plan`, and the two lines that gather free text skip a whole hex colour under `color`.
-- Nothing is added or dropped. No row is changed. No policy or grant changes. No engine change, no golden number moves.
--
-- ORDER: after 20261224000000 (row 68, applied), 20261223000000 (C6, row 67), 20261221000000 (B4, row 66) and every earlier row; this is
-- row 69. Renumber at merge if anything later merges first. It depends only on B4's body of the function it replaces.
--
-- PREFLIGHT (read-only; `prod-sql.sh -c`, one query at a time):
--   0. Row 68 is the latest applied, nothing at or past this one. Expect 20261221000000, 20261223000000 and 20261224000000 (the latest), and nothing >= '20261224500000':
--        select version from supabase_migrations.schema_migrations where version >= '20261221000000' order by 1;
--   1. The replaced function is as reviewed (B4's post-apply 5). Expect exactly one row:
--        select n.nspname, p.proname, md5(p.prosrc), p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('private','share_snapshot_problem')) order by 1, 2;
--        private | share_snapshot_problem | 76ac6261c43393b9fb36615d727af8fc | f
--      Any other md5 means production isn't what this migration copies: stop and report.
--   2. The helpers its body calls exist. Expect 4 non-null values:
--        select to_regprocedure('private.share_norm(text)'), to_regprocedure('private.share_strings(jsonb)'), to_regprocedure('private.share_name_tokens(uuid, text)'), to_regprocedure('private.lever_kind_ids()');
--   3. Role colours and plans hold no letters but a hex colour's, so making them free text refuses no link. Expect 0, 0:
--        select (select count(*) from public.roles where color is not null and color !~ '^#[0-9a-fA-F]{3,8}$'), (select count(*) from public.workspaces where plan !~ '^[a-z_]+$');
--      Anything else: list them; a value that is a person's or a client's name would make that link's next Update copy fail.
--
-- POST-APPLY CHECK:
--   1. The new body, not SECURITY DEFINER, empty search_path, stable. Expect private | share_snapshot_problem | <md5> | f | t | s with md5
--      644d3a5cb3b9c171f4f81e962b8eab2e:
--        select n.nspname, p.proname, md5(p.prosrc), p.prosecdef, p.proconfig = array['search_path=""'], p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('private','share_snapshot_problem'));
--   2. Still private. Expect f, f:
--        select has_function_privilege('anon', 'private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)', 'execute'), has_function_privilege('authenticated', 'private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)', 'execute');
--   3. Smoke test (read-only: the function is stable and writes nothing). On Northbeam, a Financials-off overview snapshot whose text
--      is a date, a standard's code, a product, a version and a page with a currency code passes (null), and one with a negative
--      amount, a hyphenated range and a decimal after a place word is refused. Expect null, then The snapshot contains costs or margins.:
--        select private.share_snapshot_problem((select id from public.workspaces where slug = 'northbeam'), 'overview', '{"v":1,"kind":"overview","toggles":{"people":false,"financials":false},"note":"2026-10-06-CAD, ISO 4217-GBP, Windows 10-USD, v1.2/EUR, page 3/GBP"}'::jsonb, false, false);
--        select private.share_snapshot_problem((select id from public.workspaces where slug = 'northbeam'), 'overview', '{"v":1,"kind":"overview","toggles":{"people":false,"financials":false},"note":"about -4100-GBP, or 4,100-4,500-GBP a month, page 12.50-GBP"}'::jsonb, false, false);
--
-- ROLLBACK (one transaction; redeploy the app from before this change first, or an Update copy that keeps one of the forms above
-- would be refused by the old rule). Stored snapshots stay as they are and still open. The full previous body (B4's) is pasted, so
-- after it preflight 1's md5 comes back. A test runs this block on a test database:
--   begin;
--   create or replace function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
--   returns text
--   language plpgsql stable
--   set search_path = ''
--   as $$
--   declare
--     -- The keys whose strings are NOT free text: ids, dates, enums and selectors the engine reads (keep equal to SHARE_NON_TEXT_KEYS in
--     -- packages/db/src/share.ts). Any other string is free text, so a key nobody classified is checked, not skipped (default deny).
--     non_text_keys constant text[] := array['agreed_by', 'kpi', 'ai_key', 'analysis_id', 'archived_at', 'archived_by', 'at', 'auto_verdict',
--       'base_revision_id', 'by', 'child_process_id', 'client_id', 'color', 'comparator', 'condition_id', 'created_at',
--       'created_by', 'currency', 'dataset_id', 'decided_at', 'decided_by', 'detected_key', 'dismissed_revision_id',
--       'draft_revision_id', 'driver', 'end_date', 'entry_process_id', 'entry_step_id', 'every', 'file_url',
--       'from_step_id', 'id', 'import_source', 'input_hash', 'insight_key', 'issueId', 'issue_id', 'key', 'kind',
--       'linked_parameter', 'live_revision_id', 'market_pending_at', 'model', 'model_hash', 'op', 'origin', 'outcome',
--       'owner_ids', 'owner_person_id', 'parent_process_id', 'parent_scenario_id', 'parent_step_id', 'path',
--       'person_id', 'plan', 'preset', 'pricing_model', 'process_id', 'proposed_via', 'published_at', 'published_by',
--       'rating', 'recorded_at', 'replaced_by', 'replaces_step_ids', 'resolution', 'resolved_at', 'resolved_how',
--       'resolved_solution_id', 'reviewed_at', 'reviewed_by', 'revision_id', 'rework_to_step_id', 'role_id', 'run_id',
--       'scenario_id', 'service_id', 'severity', 'slug', 'solutionId', 'solution_id', 'source_id', 'source_ids',
--       'stage', 'start_date', 'started_at', 'status', 'step_id', 'suggestion_id', 'timestamp', 'to_step_id', 'type',
--       'hiddenLevers',  -- B4: the kinds a play link hides: known kind ids only, checked in step 1 below
--       'updated_at', 'updated_by', 'user_id', 'user_verdict', 'verdict', 'wait_dist', 'work_dist', 'workspace_id'];
--     everything text;
--     free text;
--     ft text[];
--     nm record;
--     parts text[];
--     joined text;
--     latin constant text := U&'[a-z\00C0-\024F\1E00-\1EFF]';
--     script constant text := U&'^[\1100-\11FF\AC00-\D7AF\3040-\30FF\3400-\4DBF\4E00-\9FFF\F900-\FAFF]{2,}$';
--   begin
--     -- 1. The snapshot is the link's.
--     if snap is null or jsonb_typeof(snap) <> 'object'
--        or snap -> 'v' is distinct from '1'::jsonb
--        or snap -> 'kind' is distinct from to_jsonb(kind)
--        or jsonb_typeof(snap -> 'toggles') is distinct from 'object'
--        or snap -> 'toggles' -> 'people' is distinct from to_jsonb(show_people)
--        or snap -> 'toggles' -> 'financials' is distinct from to_jsonb(show_financials)  -- B4
--        -- B4 begin
--        -- The kinds a play link hides. Not free text: only known kind ids (so the key can't smuggle a name).
--        -- (CASE, not OR: Postgres doesn't promise to stop before jsonb_array_length on a non-array)
--        -- The key is a non-text key at ANY depth, so it may appear only once, at the top: a copy nested elsewhere would skip the name checks.
--        or jsonb_array_length(jsonb_path_query_array(snap, 'strict $.**.hiddenLevers')) > (case when snap ? 'hiddenLevers' then 1 else 0 end)
--        or (snap ? 'hiddenLevers' and case when jsonb_typeof(snap -> 'hiddenLevers') <> 'array' then true else (
--            jsonb_array_length(snap -> 'hiddenLevers') > 30
--            or exists (select 1 from jsonb_array_elements(snap -> 'hiddenLevers') h
--                       where jsonb_typeof(h) <> 'string' or not (h #>> '{}' = any (private.lever_kind_ids())))
--            or (select count(distinct h) from jsonb_array_elements(snap -> 'hiddenLevers') h) <> jsonb_array_length(snap -> 'hiddenLevers')) end)
--        -- B4 end
--        then  -- B4
--       return 'The snapshot doesn''t match the link.';
--     end if;
--     -- Every string value, normalised ONCE (the \x01 between them is no space and no letter, so nothing matches across two values),
--     -- and the free-text ones on their own. A bare uuid is skipped before it costs a normalisation.
--     select string_agg(n.v, E'\x01'), string_agg(n.v, E'\x01') filter (where n.k is null or n.k <> all (non_text_keys))
--       into everything, free
--       from (select s.k, private.share_norm(s.v) as v from private.share_strings(snap) as s
--             where s.v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') as n;
--     everything := coalesce(everything, '');
--     free := coalesce(free, '');
--   
--     -- 2. No email address, in any string value. The part before the @ ends in a letter, digit or one of _ % + - (so
--     -- `roles.@busiest.headcount`, a scenario's selector, is not one).
--     if everything ~* '[a-z0-9._%+-]*[a-z0-9_%+-]@[a-z0-9.-]+\.[a-z]{2,}' then
--       return 'The snapshot contains an email address.';
--     end if;
--   
--     -- 3. No pay, for anyone, whatever the toggles (Austin, 6 Oct: no pay data). A string counts as a value.
--     if jsonb_path_exists(snap, 'lax $.**.cost_rate ? (@ != null)') then
--       return 'The snapshot contains a person''s pay.';
--     end if;
--   
--     -- 4. No evidence notes: provenance of any JSON type (an empty object or null is fine), and quotes from sources cited as facts.
--     if jsonb_path_exists(snap, 'lax $.**.provenance.*')
--        or jsonb_path_exists(snap, 'strict $.**.provenance ? (@.type() != "object" && @.type() != "null")')
--        or jsonb_path_exists(snap, 'lax $.**.facts ? (@.kind == "quote")') then
--       return 'The snapshot contains evidence notes.';
--     end if;
--   
--     -- 5. Clients are always anonymised, by the whole of the name: its words (stop words left out) one after another in free text
--     -- with at most three non-letters between, or run together; never by one word of it ("Group review" is no client).
--     select array_agg(distinct t) into ft from regexp_split_to_table(free, '[^[:alpha:]]+') as t where t <> '';
--     ft := coalesce(ft, '{}');
--     for nm in select private.share_norm(v.name) as name
--               from (select c.name from public.clients c where c.workspace_id = ws
--                     union
--                     select pg_catalog.translate(c.name, U&'\00E4\00F6\00FC\00C4\00D6\00DC', 'aouAOU') from public.clients c where c.workspace_id = ws) as v loop
--       parts := array(select x from unnest(regexp_split_to_array(nm.name, '[^[:alpha:]]+')) as x
--                      where x <> '' and x not in ('the', 'and', 'for', 'ltd', 'inc', 'llc', 'plc'));
--       joined := array_to_string(parts, '');
--       continue when cardinality(parts) = 0 or char_length(joined) < (case when joined ~ latin then 3 else 2 end)
--                  or joined in ('team', 'member', 'client', 'hidden', 'email', 'amount');
--       if joined = any (ft) or (joined ~ script and strpos(free, joined) > 0) then
--         return 'The snapshot names a client.';
--       end if;
--       if cardinality(parts) > 1 and parts <@ ft
--          and free ~ ('(^|[^[:alpha:]])' || array_to_string(parts, '(([^[:alpha:]]{1,3}(and|the|for|ltd|inc|llc|plc)){0,2}[^[:alpha:]]{1,3})') || '($|[^[:alpha:]])') then
--         return 'The snapshot names a client.';
--       end if;
--     end loop;
--   
--     -- 6. People are labels unless People is on: no token of a person's name (first name, surname, any part) in free text, so a name
--     -- token can't survive next to a "Team member N" label either; and no Han, Kana or Hangul part of a name anywhere in it.
--     if not show_people and (
--          exists (select 1 from regexp_split_to_table(free, '[^[:alpha:]]+') as w (tok)
--                   where w.tok in (select private.share_name_tokens(ws, 'person')))
--       or exists (select 1 from private.share_name_tokens(ws, 'script') as s (part) where strpos(free, s.part) > 0)) then
--       return 'The snapshot names a person.';
--     end if;
--   
--     -- 7. Financials off: no costs, margins or overhead. A number stored as a string counts; so does a role-rate change inside a
--     -- scenario or a solution's lever changes (the visitor's browser would price work at the real rate); so does money in text.
--     if not show_financials and (
--          jsonb_path_exists(snap, 'lax $.**.default_cost_rate ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
--       or jsonb_path_exists(snap, 'lax $.**.margin ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
--       or jsonb_path_exists(snap, 'lax $.**.cost_override ? (@ != null)')
--       or jsonb_path_exists(snap, 'lax $.**.overhead_monthly')
--       or jsonb_path_exists(snap, 'lax $.**.target_margin')
--       or jsonb_path_exists(snap, 'lax $.**.path ? (@ like_regex "cost_rate$")')
--       or everything ~* ('[£$€¥₹][[:space:]]*[0-9]|[0-9][[:space:]]*[£€¥₹]'
--         || '|(^|[^a-z0-9])(gbp|usd|eur|aud|nzd|cad|rs\.?)[[:space:]/-]*[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?([^a-z0-9]|$)'
--         || '|(^|[^a-z0-9])[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?[[:space:]/-]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'
--         || '|[0-9]([[:space:]]*(k|m|bn))?[[:space:]]*(pounds?|dollars?|euros?|quid|sterling)([^a-z]|$)')) then
--       return 'The snapshot contains costs or margins.';
--     end if;
--   
--     return null;
--   end;
--   $$;
--   delete from supabase_migrations.schema_migrations where version = '20261224500000';
--   commit;
--
-- Production data: none needed.

create or replace function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  -- The keys whose strings are NOT free text: ids, dates, enums and selectors the engine reads (keep equal to SHARE_NON_TEXT_KEYS in
  -- packages/db/src/share.ts). Any other string is free text, so a key nobody classified is checked, not skipped (default deny).
  non_text_keys constant text[] := array['agreed_by', 'kpi', 'ai_key', 'analysis_id', 'archived_at', 'archived_by', 'at', 'auto_verdict',
    'base_revision_id', 'by', 'child_process_id', 'client_id', 'comparator', 'condition_id', 'created_at',  -- B3 follow-up: not color (free text)
    'created_by', 'currency', 'dataset_id', 'decided_at', 'decided_by', 'detected_key', 'dismissed_revision_id',
    'draft_revision_id', 'driver', 'end_date', 'entry_process_id', 'entry_step_id', 'every', 'file_url',
    'from_step_id', 'id', 'import_source', 'input_hash', 'insight_key', 'issueId', 'issue_id', 'key', 'kind',
    'linked_parameter', 'live_revision_id', 'market_pending_at', 'model', 'model_hash', 'op', 'origin', 'outcome',
    'owner_ids', 'owner_person_id', 'parent_process_id', 'parent_scenario_id', 'parent_step_id', 'path',
    'person_id', 'preset', 'pricing_model', 'process_id', 'proposed_via', 'published_at', 'published_by',  -- B3 follow-up: not plan (free text)
    'rating', 'recorded_at', 'replaced_by', 'replaces_step_ids', 'resolution', 'resolved_at', 'resolved_how',
    'resolved_solution_id', 'reviewed_at', 'reviewed_by', 'revision_id', 'rework_to_step_id', 'role_id', 'run_id',
    'scenario_id', 'service_id', 'severity', 'slug', 'solutionId', 'solution_id', 'source_id', 'source_ids',
    'stage', 'start_date', 'started_at', 'status', 'step_id', 'suggestion_id', 'timestamp', 'to_step_id', 'type',
    'hiddenLevers',  -- B4: the kinds a play link hides: known kind ids only, checked in step 1 below
    'updated_at', 'updated_by', 'user_id', 'user_verdict', 'verdict', 'wait_dist', 'work_dist', 'workspace_id'];
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
     then  -- B4
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
    or exists (select 1 from private.share_name_tokens(ws, 'script') as s (part) where strpos(free, s.part) > 0)) then
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

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261224500000', 'share_money_rule', array[$mig$-- Share links: the money rule no longer hides dates, versions and standard codes; `color` and `plan` are free text (B3 follow-ups,
-- issue #32; the optional findings of the B3 verification on PR #215, approved by Austin on 7 Oct, and the review of PR #233;
-- docs/adr/0016-share-links.md).
--
-- With Financials off a share link hides money in text, and the database refuses a snapshot that still holds some. The rule for a
-- number followed by a currency code accepted a hyphen or a slash between them, and any number, so it also caught text that is no
-- money: "2026-10-06-CAD" read "2026-10-[amount hidden]", and "ISO 4217-GBP", "Windows 10-USD", "v1.2/EUR" and "page 3/GBP" were
-- hidden too. Now:
--   * a SPACE between the number and the code: unchanged ("1,200 GBP", "1e6 gbp", "4,100-4,500 GBP");
--   * a HYPHEN or a SLASH between them ("4100-GBP", "4100/GBP"): the amount before the code is not glued to a letter or a digit,
--     nor to a digit and a dot or comma ("v1.2"), nor to a digit and a hyphen or slash ("2026-10-06") unless it has 3 or more
--     digits, thousands groups or an exponent (a range's second amount). A sign or a separator after a letter or a space counts
--     ("-4100-GBP", "x/4100-GBP"); a range is matched whole ("4,100-4,500-GBP", "4100/4500/GBP"). A plain number (no groups, no
--     exponent) right after "iso" or "rfc" is a standard's number; a plain 1- or 2-digit one right after a version word
--     (JOIN_VERSION_WORDS in packages/db/src/money.ts: "windows", "version", "v" ...) is a version, whole or decimal ("v 1.2"); and a
--     WHOLE 1- or 2-digit one right after a place word (JOIN_PLACE_WORDS: "page", "row", "part" ...) is a place in a document. A
--     decimal after a place word is money ("page 12.50-GBP", "row 99,99-EUR");
--   * a code BEFORE the number ("GBP-4100", "GBP/4100", "usd-1e6"), symbols ("£4.1k", "4,512€") and amounts in words ("quid"):
--     unchanged.
-- The app applies the same rule (`shareMoneyRegex`); a test keeps the word lists equal, and one list of texts runs through both
-- and through the rule before this change. The new rule matches a subset of what the old one matched (every text it refuses, the
-- old one refused), so no snapshot the database accepts today is refused after this.
--
-- `color` (roles) and `plan` (workspaces) leave the list of keys that are no text: the database checks neither value (no check
-- constraint), so a name typed into one skipped the name checks. They are free text now, in the app (`SHARE_NON_TEXT_REASONS`) and
-- here: checked like any other string. Neither is engine input, so no number moves. Strictly more is checked: a stored snapshot
-- with a person's or a client's name in a role's colour or the plan would be refused at its next Update copy (preflight 3 counts
-- them; expect none). A `color` value that is a whole hex colour (`#rgb` to `#rrggbbaa`) is no text, so a colour whose letters spell
-- a name ("#ada123" and a person called Ada) is neither hidden nor refused; the app's SHARE_HEX_COLOR is the same rule.
--
-- What this REPLACES, with `create or replace`, the same signature, language, volatility, security flag and `set search_path = ''`,
-- as a full copy of the body named, changing only the lines marked `-- B3 follow-up` (a test checks it):
--   * private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)   from 20261221000000_play_links.sql (B4, row 66, the newest):
--     one line of step 7's money pattern (the number before a code) becomes a space-only form and a hyphen-or-slash form, two
--     lines of `non_text_keys` lose `color` and `plan`, and the two lines that gather free text skip a whole hex colour under `color`.
-- Nothing is added or dropped. No row is changed. No policy or grant changes. No engine change, no golden number moves.
--
-- ORDER: after 20261224000000 (row 68, applied), 20261223000000 (C6, row 67), 20261221000000 (B4, row 66) and every earlier row; this is
-- row 69. Renumber at merge if anything later merges first. It depends only on B4's body of the function it replaces.
--
-- PREFLIGHT (read-only; `prod-sql.sh -c`, one query at a time):
--   0. Row 68 is the latest applied, nothing at or past this one. Expect 20261221000000, 20261223000000 and 20261224000000 (the latest), and nothing >= '20261224500000':
--        select version from supabase_migrations.schema_migrations where version >= '20261221000000' order by 1;
--   1. The replaced function is as reviewed (B4's post-apply 5). Expect exactly one row:
--        select n.nspname, p.proname, md5(p.prosrc), p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('private','share_snapshot_problem')) order by 1, 2;
--        private | share_snapshot_problem | 76ac6261c43393b9fb36615d727af8fc | f
--      Any other md5 means production isn't what this migration copies: stop and report.
--   2. The helpers its body calls exist. Expect 4 non-null values:
--        select to_regprocedure('private.share_norm(text)'), to_regprocedure('private.share_strings(jsonb)'), to_regprocedure('private.share_name_tokens(uuid, text)'), to_regprocedure('private.lever_kind_ids()');
--   3. Role colours and plans hold no letters but a hex colour's, so making them free text refuses no link. Expect 0, 0:
--        select (select count(*) from public.roles where color is not null and color !~ '^#[0-9a-fA-F]{3,8}$'), (select count(*) from public.workspaces where plan !~ '^[a-z_]+$');
--      Anything else: list them; a value that is a person's or a client's name would make that link's next Update copy fail.
--
-- POST-APPLY CHECK:
--   1. The new body, not SECURITY DEFINER, empty search_path, stable. Expect private | share_snapshot_problem | <md5> | f | t | s with md5
--      644d3a5cb3b9c171f4f81e962b8eab2e:
--        select n.nspname, p.proname, md5(p.prosrc), p.prosecdef, p.proconfig = array['search_path=""'], p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('private','share_snapshot_problem'));
--   2. Still private. Expect f, f:
--        select has_function_privilege('anon', 'private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)', 'execute'), has_function_privilege('authenticated', 'private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)', 'execute');
--   3. Smoke test (read-only: the function is stable and writes nothing). On Northbeam, a Financials-off overview snapshot whose text
--      is a date, a standard's code, a product, a version and a page with a currency code passes (null), and one with a negative
--      amount, a hyphenated range and a decimal after a place word is refused. Expect null, then The snapshot contains costs or margins.:
--        select private.share_snapshot_problem((select id from public.workspaces where slug = 'northbeam'), 'overview', '{"v":1,"kind":"overview","toggles":{"people":false,"financials":false},"note":"2026-10-06-CAD, ISO 4217-GBP, Windows 10-USD, v1.2/EUR, page 3/GBP"}'::jsonb, false, false);
--        select private.share_snapshot_problem((select id from public.workspaces where slug = 'northbeam'), 'overview', '{"v":1,"kind":"overview","toggles":{"people":false,"financials":false},"note":"about -4100-GBP, or 4,100-4,500-GBP a month, page 12.50-GBP"}'::jsonb, false, false);
--
-- ROLLBACK (one transaction; redeploy the app from before this change first, or an Update copy that keeps one of the forms above
-- would be refused by the old rule). Stored snapshots stay as they are and still open. The full previous body (B4's) is pasted, so
-- after it preflight 1's md5 comes back. A test runs this block on a test database:
--   begin;
--   create or replace function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
--   returns text
--   language plpgsql stable
--   set search_path = ''
--   as $$
--   declare
--     -- The keys whose strings are NOT free text: ids, dates, enums and selectors the engine reads (keep equal to SHARE_NON_TEXT_KEYS in
--     -- packages/db/src/share.ts). Any other string is free text, so a key nobody classified is checked, not skipped (default deny).
--     non_text_keys constant text[] := array['agreed_by', 'kpi', 'ai_key', 'analysis_id', 'archived_at', 'archived_by', 'at', 'auto_verdict',
--       'base_revision_id', 'by', 'child_process_id', 'client_id', 'color', 'comparator', 'condition_id', 'created_at',
--       'created_by', 'currency', 'dataset_id', 'decided_at', 'decided_by', 'detected_key', 'dismissed_revision_id',
--       'draft_revision_id', 'driver', 'end_date', 'entry_process_id', 'entry_step_id', 'every', 'file_url',
--       'from_step_id', 'id', 'import_source', 'input_hash', 'insight_key', 'issueId', 'issue_id', 'key', 'kind',
--       'linked_parameter', 'live_revision_id', 'market_pending_at', 'model', 'model_hash', 'op', 'origin', 'outcome',
--       'owner_ids', 'owner_person_id', 'parent_process_id', 'parent_scenario_id', 'parent_step_id', 'path',
--       'person_id', 'plan', 'preset', 'pricing_model', 'process_id', 'proposed_via', 'published_at', 'published_by',
--       'rating', 'recorded_at', 'replaced_by', 'replaces_step_ids', 'resolution', 'resolved_at', 'resolved_how',
--       'resolved_solution_id', 'reviewed_at', 'reviewed_by', 'revision_id', 'rework_to_step_id', 'role_id', 'run_id',
--       'scenario_id', 'service_id', 'severity', 'slug', 'solutionId', 'solution_id', 'source_id', 'source_ids',
--       'stage', 'start_date', 'started_at', 'status', 'step_id', 'suggestion_id', 'timestamp', 'to_step_id', 'type',
--       'hiddenLevers',  -- B4: the kinds a play link hides: known kind ids only, checked in step 1 below
--       'updated_at', 'updated_by', 'user_id', 'user_verdict', 'verdict', 'wait_dist', 'work_dist', 'workspace_id'];
--     everything text;
--     free text;
--     ft text[];
--     nm record;
--     parts text[];
--     joined text;
--     latin constant text := U&'[a-z\00C0-\024F\1E00-\1EFF]';
--     script constant text := U&'^[\1100-\11FF\AC00-\D7AF\3040-\30FF\3400-\4DBF\4E00-\9FFF\F900-\FAFF]{2,}$';
--   begin
--     -- 1. The snapshot is the link's.
--     if snap is null or jsonb_typeof(snap) <> 'object'
--        or snap -> 'v' is distinct from '1'::jsonb
--        or snap -> 'kind' is distinct from to_jsonb(kind)
--        or jsonb_typeof(snap -> 'toggles') is distinct from 'object'
--        or snap -> 'toggles' -> 'people' is distinct from to_jsonb(show_people)
--        or snap -> 'toggles' -> 'financials' is distinct from to_jsonb(show_financials)  -- B4
--        -- B4 begin
--        -- The kinds a play link hides. Not free text: only known kind ids (so the key can't smuggle a name).
--        -- (CASE, not OR: Postgres doesn't promise to stop before jsonb_array_length on a non-array)
--        -- The key is a non-text key at ANY depth, so it may appear only once, at the top: a copy nested elsewhere would skip the name checks.
--        or jsonb_array_length(jsonb_path_query_array(snap, 'strict $.**.hiddenLevers')) > (case when snap ? 'hiddenLevers' then 1 else 0 end)
--        or (snap ? 'hiddenLevers' and case when jsonb_typeof(snap -> 'hiddenLevers') <> 'array' then true else (
--            jsonb_array_length(snap -> 'hiddenLevers') > 30
--            or exists (select 1 from jsonb_array_elements(snap -> 'hiddenLevers') h
--                       where jsonb_typeof(h) <> 'string' or not (h #>> '{}' = any (private.lever_kind_ids())))
--            or (select count(distinct h) from jsonb_array_elements(snap -> 'hiddenLevers') h) <> jsonb_array_length(snap -> 'hiddenLevers')) end)
--        -- B4 end
--        then  -- B4
--       return 'The snapshot doesn''t match the link.';
--     end if;
--     -- Every string value, normalised ONCE (the \x01 between them is no space and no letter, so nothing matches across two values),
--     -- and the free-text ones on their own. A bare uuid is skipped before it costs a normalisation.
--     select string_agg(n.v, E'\x01'), string_agg(n.v, E'\x01') filter (where n.k is null or n.k <> all (non_text_keys))
--       into everything, free
--       from (select s.k, private.share_norm(s.v) as v from private.share_strings(snap) as s
--             where s.v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') as n;
--     everything := coalesce(everything, '');
--     free := coalesce(free, '');
--   
--     -- 2. No email address, in any string value. The part before the @ ends in a letter, digit or one of _ % + - (so
--     -- `roles.@busiest.headcount`, a scenario's selector, is not one).
--     if everything ~* '[a-z0-9._%+-]*[a-z0-9_%+-]@[a-z0-9.-]+\.[a-z]{2,}' then
--       return 'The snapshot contains an email address.';
--     end if;
--   
--     -- 3. No pay, for anyone, whatever the toggles (Austin, 6 Oct: no pay data). A string counts as a value.
--     if jsonb_path_exists(snap, 'lax $.**.cost_rate ? (@ != null)') then
--       return 'The snapshot contains a person''s pay.';
--     end if;
--   
--     -- 4. No evidence notes: provenance of any JSON type (an empty object or null is fine), and quotes from sources cited as facts.
--     if jsonb_path_exists(snap, 'lax $.**.provenance.*')
--        or jsonb_path_exists(snap, 'strict $.**.provenance ? (@.type() != "object" && @.type() != "null")')
--        or jsonb_path_exists(snap, 'lax $.**.facts ? (@.kind == "quote")') then
--       return 'The snapshot contains evidence notes.';
--     end if;
--   
--     -- 5. Clients are always anonymised, by the whole of the name: its words (stop words left out) one after another in free text
--     -- with at most three non-letters between, or run together; never by one word of it ("Group review" is no client).
--     select array_agg(distinct t) into ft from regexp_split_to_table(free, '[^[:alpha:]]+') as t where t <> '';
--     ft := coalesce(ft, '{}');
--     for nm in select private.share_norm(v.name) as name
--               from (select c.name from public.clients c where c.workspace_id = ws
--                     union
--                     select pg_catalog.translate(c.name, U&'\00E4\00F6\00FC\00C4\00D6\00DC', 'aouAOU') from public.clients c where c.workspace_id = ws) as v loop
--       parts := array(select x from unnest(regexp_split_to_array(nm.name, '[^[:alpha:]]+')) as x
--                      where x <> '' and x not in ('the', 'and', 'for', 'ltd', 'inc', 'llc', 'plc'));
--       joined := array_to_string(parts, '');
--       continue when cardinality(parts) = 0 or char_length(joined) < (case when joined ~ latin then 3 else 2 end)
--                  or joined in ('team', 'member', 'client', 'hidden', 'email', 'amount');
--       if joined = any (ft) or (joined ~ script and strpos(free, joined) > 0) then
--         return 'The snapshot names a client.';
--       end if;
--       if cardinality(parts) > 1 and parts <@ ft
--          and free ~ ('(^|[^[:alpha:]])' || array_to_string(parts, '(([^[:alpha:]]{1,3}(and|the|for|ltd|inc|llc|plc)){0,2}[^[:alpha:]]{1,3})') || '($|[^[:alpha:]])') then
--         return 'The snapshot names a client.';
--       end if;
--     end loop;
--   
--     -- 6. People are labels unless People is on: no token of a person's name (first name, surname, any part) in free text, so a name
--     -- token can't survive next to a "Team member N" label either; and no Han, Kana or Hangul part of a name anywhere in it.
--     if not show_people and (
--          exists (select 1 from regexp_split_to_table(free, '[^[:alpha:]]+') as w (tok)
--                   where w.tok in (select private.share_name_tokens(ws, 'person')))
--       or exists (select 1 from private.share_name_tokens(ws, 'script') as s (part) where strpos(free, s.part) > 0)) then
--       return 'The snapshot names a person.';
--     end if;
--   
--     -- 7. Financials off: no costs, margins or overhead. A number stored as a string counts; so does a role-rate change inside a
--     -- scenario or a solution's lever changes (the visitor's browser would price work at the real rate); so does money in text.
--     if not show_financials and (
--          jsonb_path_exists(snap, 'lax $.**.default_cost_rate ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
--       or jsonb_path_exists(snap, 'lax $.**.margin ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
--       or jsonb_path_exists(snap, 'lax $.**.cost_override ? (@ != null)')
--       or jsonb_path_exists(snap, 'lax $.**.overhead_monthly')
--       or jsonb_path_exists(snap, 'lax $.**.target_margin')
--       or jsonb_path_exists(snap, 'lax $.**.path ? (@ like_regex "cost_rate$")')
--       or everything ~* ('[£$€¥₹][[:space:]]*[0-9]|[0-9][[:space:]]*[£€¥₹]'
--         || '|(^|[^a-z0-9])(gbp|usd|eur|aud|nzd|cad|rs\.?)[[:space:]/-]*[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?([^a-z0-9]|$)'
--         || '|(^|[^a-z0-9])[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?[[:space:]/-]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'
--         || '|[0-9]([[:space:]]*(k|m|bn))?[[:space:]]*(pounds?|dollars?|euros?|quid|sterling)([^a-z]|$)')) then
--       return 'The snapshot contains costs or margins.';
--     end if;
--   
--     return null;
--   end;
--   $$;
--   delete from supabase_migrations.schema_migrations where version = '20261224500000';
--   commit;
--
-- Production data: none needed.

create or replace function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  -- The keys whose strings are NOT free text: ids, dates, enums and selectors the engine reads (keep equal to SHARE_NON_TEXT_KEYS in
  -- packages/db/src/share.ts). Any other string is free text, so a key nobody classified is checked, not skipped (default deny).
  non_text_keys constant text[] := array['agreed_by', 'kpi', 'ai_key', 'analysis_id', 'archived_at', 'archived_by', 'at', 'auto_verdict',
    'base_revision_id', 'by', 'child_process_id', 'client_id', 'comparator', 'condition_id', 'created_at',  -- B3 follow-up: not color (free text)
    'created_by', 'currency', 'dataset_id', 'decided_at', 'decided_by', 'detected_key', 'dismissed_revision_id',
    'draft_revision_id', 'driver', 'end_date', 'entry_process_id', 'entry_step_id', 'every', 'file_url',
    'from_step_id', 'id', 'import_source', 'input_hash', 'insight_key', 'issueId', 'issue_id', 'key', 'kind',
    'linked_parameter', 'live_revision_id', 'market_pending_at', 'model', 'model_hash', 'op', 'origin', 'outcome',
    'owner_ids', 'owner_person_id', 'parent_process_id', 'parent_scenario_id', 'parent_step_id', 'path',
    'person_id', 'preset', 'pricing_model', 'process_id', 'proposed_via', 'published_at', 'published_by',  -- B3 follow-up: not plan (free text)
    'rating', 'recorded_at', 'replaced_by', 'replaces_step_ids', 'resolution', 'resolved_at', 'resolved_how',
    'resolved_solution_id', 'reviewed_at', 'reviewed_by', 'revision_id', 'rework_to_step_id', 'role_id', 'run_id',
    'scenario_id', 'service_id', 'severity', 'slug', 'solutionId', 'solution_id', 'source_id', 'source_ids',
    'stage', 'start_date', 'started_at', 'status', 'step_id', 'suggestion_id', 'timestamp', 'to_step_id', 'type',
    'hiddenLevers',  -- B4: the kinds a play link hides: known kind ids only, checked in step 1 below
    'updated_at', 'updated_by', 'user_id', 'user_verdict', 'verdict', 'wait_dist', 'work_dist', 'workspace_id'];
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
     then  -- B4
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
    or exists (select 1 from private.share_name_tokens(ws, 'script') as s (part) where strpos(free, s.part) > 0)) then
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
$$;$mig$]);

commit;
