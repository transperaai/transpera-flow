-- What a step achieves (sandbox phase 4, docs/plans/sandbox-p4-brief.md; engine 1.14.0).
--
-- What it does (it writes NO step row and no workspace row except to drop a settings.purposes that is not a valid list):
--   1. `public.steps.purpose`: what the step's hands-on time achieves, a key of the workspace's category list. Null means
--      Automatic: `resolvePurpose` (packages/db/src/purposes.ts) works it out each time (a chosen key wins, then the process's
--      first-principles delete list, then the sale side of a pipeline or the process kind). A nullable column with no default
--      rewrites no row and fires no trigger; `open_draft` copies every column and `revision_changes` diffs it, so a purpose is a draft
--      change to publish. Allowed: the six default keys or c + 8 lower-case hex (a category the workspace added). "client_upkeep"
--      (client hours not drawn as steps) is a category but not a step's purpose.
--   2. `private.is_purpose_list` and `workspaces_purposes`: `settings.purposes` is absent or null (the defaults) or a list of 5 to 12
--      {key, name, description}: unique keys, unique names ignoring case and spaces (1 to 60 characters), descriptions up to 200, and
--      the five fixed categories present (client_job, client_upkeep, winning, fixing, removable). A value that is neither is removed
--      first, so the constraint validates.
--   3. `private.share_snapshot_problem`: a full copy of the 20270104000000 body with only 'purpose' added to non_text_keys (a key, never
--      words). SHARE_NON_TEXT_REASONS (packages/db/src/share.ts) is its twin.
--   4. `public.import_workspace_bundle`: a full copy of the 20270112000000 body with only "purpose" added to allow.steps
--      (IMPORT_COLUMNS in packages/db/src/workspace-import.ts is its twin). `create or replace` keeps its grants.
--
-- Runs on a database full of real rows (the production copy imported at 20261231000000, then every later migration): adding a nullable
-- column rewrites nothing, and the constraint has no row to fail after step 2's clean-up.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270114000000';` expect 0, and 20270112000000 applied.
--     Record, for the post-apply comparison: select count(*), max(updated_at) from public.steps;
--     select count(*) from public.workspaces where settings ? 'purposes';
-- Post-apply checks:
--     -- Same step count and updated_at as the preflight, and no purpose written. Expect the count, the timestamp, 0:
--     select count(*), max(updated_at), count(purpose) from public.steps;
--     -- Every workspace passes. Expect 0:
--     select count(*) from public.workspaces where settings ? 'purposes' and jsonb_typeof(settings -> 'purposes') <> 'null' and not private.is_purpose_list(settings -> 'purposes');
--     select conname, convalidated from pg_constraint where conname in ('steps_purpose_key', 'workspaces_purposes');
-- Rollback (take a Neon branch just before `migrate` as the cutover runbook does; or by hand): drop the constraints
-- (`alter table public.workspaces drop constraint workspaces_purposes; alter table public.steps drop constraint steps_purpose_key;`),
-- `drop function private.is_purpose_list(jsonb);`, `alter table public.steps drop column purpose;`, re-run the
-- `import_workspace_bundle` body from 20270112000000_churn_chances_and_fee_ranges.sql and the `share_snapshot_problem` body from
-- 20270104000000_strip_followups.sql, then delete the row from public.schema_migrations.

-- Marks any write as the system's, as the migrations since 20270103000000_three_roles.sql do.
select set_config('transpera.actor_kind', 'system', true);

-- 1. What each step achieves. Null = Automatic.
alter table public.steps add column purpose text;
alter table public.steps add constraint steps_purpose_key check (
  purpose is null or purpose ~ '^(client_job|required|winning|coordination|fixing|removable|c[0-9a-f]{8})$');
comment on column public.steps.purpose is
  'What the step achieves: a key of the workspace''s settings.purposes (null: Automatic). Sandbox phase 4.';

-- 2. The workspace's categories. CASE, not AND, so nothing reads an array that isn't one.
create function private.is_purpose_list(v jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(v) <> 'array' then false
    when jsonb_array_length(v) not between 5 and 12 then false
    when exists (
      select 1 from jsonb_array_elements(v) e
      where jsonb_typeof(e) <> 'object'
         or (e - array['key', 'name', 'description']) <> '{}'::jsonb
         or coalesce(jsonb_typeof(e -> 'key'), 'null') <> 'string'
         or coalesce(jsonb_typeof(e -> 'name'), 'null') <> 'string'
         or coalesce(jsonb_typeof(e -> 'description'), 'string') <> 'string') then false
    else
      not exists (
        select 1 from jsonb_array_elements(v) e
        where (e ->> 'key') !~ '^(client_job|client_upkeep|required|winning|coordination|fixing|removable|c[0-9a-f]{8})$'
           or char_length(btrim(e ->> 'name')) not between 1 and 60
           or char_length(coalesce(e ->> 'description', '')) > 200)
      and (select count(distinct e ->> 'key') from jsonb_array_elements(v) e) = jsonb_array_length(v)
      and (select count(distinct lower(btrim(e ->> 'name'))) from jsonb_array_elements(v) e) = jsonb_array_length(v)
      and (select count(*) from jsonb_array_elements(v) e
           where e ->> 'key' in ('client_job', 'client_upkeep', 'winning', 'fixing', 'removable')) = 5
  end
$$;

-- Nothing writes the key before this, but a restore merges settings wholesale: drop anything that isn't a valid list or null.
update public.workspaces w
set settings = w.settings - 'purposes'
where w.settings ? 'purposes'
  and jsonb_typeof(w.settings -> 'purposes') <> 'null'
  and not private.is_purpose_list(w.settings -> 'purposes');

alter table public.workspaces add constraint workspaces_purposes check (
  case
    when not (settings ? 'purposes') then true
    when jsonb_typeof(settings -> 'purposes') = 'null' then true
    else private.is_purpose_list(settings -> 'purposes')
  end) not valid;
alter table public.workspaces validate constraint workspaces_purposes;

-- 3. Share snapshots: `purpose` is a key, never words (the steps_purpose_key check). The 20270104000000 body, 'purpose' added to non_text_keys.
CREATE OR REPLACE FUNCTION private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
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
    'user_verdict', 'verdict', 'wait_dist', 'work_dist', 'workspace_id'];
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

-- 4. Restores carry it: the 20270112000000 body of public.import_workspace_bundle, "purpose" added to allow.steps, nothing else changed.
CREATE OR REPLACE FUNCTION public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET statement_timeout TO '40s'
AS $$
declare
  -- The columns the restore accepts for each plan section: the same lists as IMPORT_COLUMNS (packages/db/src/workspace-import.ts).
  -- Everything else in a row is ignored; `workspace_id`, `created_by`, `updated_at` and every `*_by` are never read from the plan.
  -- #228: person_capacity_factors is in this list, in ref_cols, in sections and in list_sections.
  allow constant jsonb := '{"roles":["id","name","color","default_cost_rate","headcount","ongoing_hours_per_client_week","active","provenance","created_at"],"people":["id","name","active","capacity_hours_week","cost_rate","end_date","fte","notes","start_date","provenance","created_at"],"person_roles":["person_id","role_id","created_at"],"person_leave":["id","person_id","start_date","end_date","note","created_at"],"lead_sources":["id","name","conversion_to_qualified","volume_week","provenance","created_at"],"seasonality":["id","month","multiplier","provenance","created_at"],"demand_settings":["growth_monthly","provenance","created_at"],"churn_drivers":["id","name","description","driver","enabled","example","month","value","weight","chance","effect","effect_months","provenance","created_at"],"market_conditions":["id","name","churn","conv","cycle","hire","leads","pay","price","created_at"],"market_schedule":["id","condition_id","from_month","to_month","created_at"],"lever_settings":["hidden","created_at"],"analysis_rules":["settings","created_at"],"clients":["id","name","active","health","mrr","notes","start_date","provenance","created_at"],"sources":["id","kind","title","body","recorded_at","speakers","created_at"],"processes":["id","parent_process_id","name","kind","entity_name","description"],"steps":["id","assumption","child_process_id","conflict","cost_override","current_wip","dropoff_benchmark","expected_wait_hours","entry_step_id","kind","lost_per_day_waiting","name","notes","outcome","parent_step_id","person_id","provenance","purpose","replaced_by","rework_rate","rework_to_step_id","role_id","sla_hours","target_cycle_hours","tool","wait_dist","wait_hours","wait_params","work_dist","work_hours","work_params","x","y"],"edges":["id","condition_tag","from_step_id","label","probability","to_step_id"],"first_principles":["deletes","improvements","job_done","job_progress","job_situation","job_who","measures","requirements","root_cause","statements","why_chain","why_problem"],"sandbox_scenarios":["id","parent_id","name","description","changes","horizon_months","start_date","created_at"],"blocks":["id","name","description","type","steps","created_at"],"issues":["id","client_id","created_at","detected_key","evidence","evidence_metrics","evidence_sources","owner_person_id","person_id","process_id","resolution","resolution_note","resolved_how","role_id","scenario_id","severity","source","status","step_id","target_goal","target_measure","target_now","title","type"],"services":["id","name","active","churn_health_sensitivity","churn_monthly_base","entry_process_id","fallback_ongoing_load","margin","mix_share","path_tags","price","price_high","price_low","pricing_model","tenure_months","provenance","created_at"],"service_servicing":["id","process_id","service_id","recurrence","sla_hours","provenance","created_at"],"client_groups":["id","service_id","client_count","churn_monthly","fee","starting_health","stay_months","provenance","created_at"],"client_services":["client_id","service_id","start_date","created_at"],"client_assignments":["client_id","role_id","person_id","created_at"],"person_skills":["person_id","step_id","efficiency","provenance","created_at"],"person_capacity_factors":["person_id","step_id","factor","provenance"],"source_links":["id","insight_key","issue_id","kind","process_id","source_id","step_id"]}'::jsonb;
  -- The reference columns of the flat sections (IMPORT_REFS) and of steps (IMPORT_STEP_REFS). Every section that has an `id`
  -- column in `allow` is checked on `id` too.
  -- #228
  ref_cols constant text[] := array['person_roles.person_id','person_roles.role_id','person_leave.person_id','services.entry_process_id','service_servicing.service_id','service_servicing.process_id','client_groups.service_id','client_services.client_id','client_services.service_id','client_assignments.client_id','client_assignments.role_id','client_assignments.person_id','person_skills.person_id','person_skills.step_id','sandbox_scenarios.parent_id','issues.client_id','issues.owner_person_id','issues.person_id','issues.process_id','issues.role_id','issues.scenario_id','issues.step_id','source_links.source_id','source_links.issue_id','source_links.process_id','source_links.step_id','market_schedule.condition_id','person_capacity_factors.person_id','person_capacity_factors.step_id'];
  step_ref_cols constant text[] := array['parent_step_id','entry_step_id','rework_to_step_id','person_id','role_id','child_process_id'];
  -- The order the sections are written in.
  -- #228
  sections constant text[] := array['settings','roles','people','person_roles','person_leave','lead_sources','seasonality','demand_settings','churn_drivers','market_conditions','market_schedule','lever_settings','analysis_rules','clients','sources','processes','sandbox_scenarios','blocks','issues','steps','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links','archive','log'];
  -- #228
  list_sections constant text[] := array['roles','people','person_roles','person_leave','lead_sources','seasonality','churn_drivers','market_conditions','market_schedule','clients','sources','processes','sandbox_scenarios','blocks','issues','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links'];
  one_sections constant text[] := array['settings','demand_settings','lever_settings','analysis_rules'];
  placeholder constant text := '00000000-0000-4000-8000-';
  placeholder_re constant text := '^00000000-0000-4000-8000-[0-9a-f]{12}$';
  max_plan_chars constant integer := 19660800;

  pl jsonb;
  txt text;
  prefix text;
  label text := left(nullif(btrim(coalesce(p_label, '')), ''), 300);
  sec text;
  col text;
  tbl text;
  rows jsonb;
  node jsonb;
  sc jsonb;
  cols text;
  sets text;
  n integer;
  total integer;
  existing uuid;
  skip_ids uuid[] := '{}';
  skipped jsonb := '{}';
  counts jsonb := '{}';
  proc uuid;
  rev uuid;
  draft jsonb;
  revs jsonb := '{}';
  made jsonb := '[]';
  arch uuid[] := '{}';
  step_total integer := 0;
  edge_total integer := 0;
  settings_result text := 'none';
  what text;
  has_rows boolean;
  bad integer;
  chars bigint;
begin
  -- 1. Who. Before the plan is read, so a refusal says nothing about it.
  if coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id' then
    raise exception 'Backups are restored in the app.' using errcode = '42501';
  end if;
  if p_workspace is null or not coalesce(public.can_edit_workspace(p_workspace), false) then
    raise exception 'Only Agency admins and the Owner can restore a backup.' using errcode = '42501';
  end if;

  -- 2. Shape and limits.
  if p_plan is null or jsonb_typeof(p_plan) is distinct from 'object' or p_plan ->> 'format' is distinct from 'transpera-workspace-import/1' then
    raise exception 'import_workspace_bundle: p_plan is not a transpera-workspace-import/1 plan' using errcode = '22023';
  end if;
  -- #228: a plan made before per-person times were restored (an app deployed before this migration) has no such section:
  -- it restores as an empty one.
  if not p_plan ? 'person_capacity_factors' then
    p_plan := p_plan || '{"person_capacity_factors": []}'::jsonb;
  end if;
  if char_length(p_plan::text) > max_plan_chars then
    raise exception 'import_workspace_bundle: the plan is too big (at most 15 MB)' using errcode = '22023';
  end if;
  foreach sec in array list_sections loop
    if jsonb_typeof(p_plan -> sec) is distinct from 'array' then
      raise exception 'import_workspace_bundle: % must be a list', sec using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_plan -> sec) e where jsonb_typeof(e.value) is distinct from 'object') then
      raise exception 'import_workspace_bundle: every row of % must be an object', sec using errcode = '22023';
    end if;
  end loop;
  foreach sec in array one_sections loop
    if p_plan -> sec is not null and jsonb_typeof(p_plan -> sec) not in ('object', 'null') then
      raise exception 'import_workspace_bundle: % must be an object or null', sec using errcode = '22023';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(p_plan -> 'processes') p
    where jsonb_typeof(p.value -> 'steps') is distinct from 'array' or jsonb_typeof(p.value -> 'edges') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(p.value -> 'steps') e where jsonb_typeof(e.value) is distinct from 'object')
      or exists (select 1 from jsonb_array_elements(p.value -> 'edges') e where jsonb_typeof(e.value) is distinct from 'object')
      or (p.value -> 'first_principles' is not null and jsonb_typeof(p.value -> 'first_principles') not in ('object', 'null'))
      or (p.value -> 'layout' is not null and jsonb_typeof(p.value -> 'layout') not in ('object', 'null'))
  ) then
    raise exception 'import_workspace_bundle: every process needs lists of steps and edges' using errcode = '22023';
  end if;
  select coalesce(sum(jsonb_array_length(p.value -> 'steps')), 0), coalesce(sum(jsonb_array_length(p.value -> 'edges')), 0)
    into step_total, edge_total from jsonb_array_elements(p_plan -> 'processes') p;
  select coalesce(sum(char_length(coalesce(s.value ->> 'body', ''))), 0) into chars from jsonb_array_elements(p_plan -> 'sources') s;
  if jsonb_array_length(p_plan -> 'processes') > 150 or step_total > 1500 or edge_total > 3000
    or jsonb_array_length(p_plan -> 'sources') > 600 or chars > 4500000
    or jsonb_array_length(p_plan -> 'issues') > 900 or jsonb_array_length(p_plan -> 'people') > 1500
    or jsonb_array_length(p_plan -> 'clients') > 3000 or jsonb_array_length(p_plan -> 'sandbox_scenarios') > 900
    or jsonb_array_length(p_plan -> 'blocks') > 900
    or jsonb_array_length(p_plan -> 'person_roles') > 1200 or jsonb_array_length(p_plan -> 'person_skills') > 3000
    or jsonb_array_length(p_plan -> 'client_assignments') > 1200 or jsonb_array_length(p_plan -> 'source_links') > 3000
    or jsonb_array_length(p_plan -> 'client_services') > 3000 or jsonb_array_length(p_plan -> 'person_leave') > 1500
    -- #228
    or jsonb_array_length(p_plan -> 'person_capacity_factors') > 3000
    or jsonb_array_length(p_plan -> 'lead_sources') + jsonb_array_length(p_plan -> 'seasonality') + jsonb_array_length(p_plan -> 'churn_drivers')
      + jsonb_array_length(p_plan -> 'market_conditions') + jsonb_array_length(p_plan -> 'market_schedule') + jsonb_array_length(p_plan -> 'services')
      + jsonb_array_length(p_plan -> 'service_servicing') + jsonb_array_length(p_plan -> 'client_groups') > 1500 then
    -- #228
    raise exception 'import_workspace_bundle: the plan is over a limit (150 processes, 1500 steps, 3000 edges, 600 sources of 4,500,000 characters, 900 issues, 1500 people, 3000 clients, 900 scenarios, 900 blocks, 1200 role assignments, 3000 skills, 1200 client assignments, 3000 source links, 3000 client services, 1500 leave entries, 1500 other company settings rows, 3000 per-person times)' using errcode = '22023';
  end if;
  -- A scenario without an id would make the replacement of a skipped one (below) return null, and the restore would write nothing and say it worked.
  if exists (select 1 from jsonb_array_elements(p_plan -> 'sandbox_scenarios') s where jsonb_typeof(s.value -> 'id') is distinct from 'string') then
    raise exception 'import_workspace_bundle: every scenario needs an id' using errcode = '22023';
  end if;

  -- 3. Lock: one restore (or upload) at a time per workspace.
  if not pg_try_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || p_workspace::text, 0)) then
    raise exception 'A restore into this workspace is already running.' using errcode = '55P03', hint = 'busy';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('import_new_process:' || p_workspace::text, 0));

  -- 4. Empty.
  for tbl, col in
    select t.a, t.b from (values
      ('processes', 'not is_company'), ('roles', 'true'), ('people', 'true'), ('services', 'true'), ('client_groups', 'true'),
      ('clients', 'true'), ('lead_sources', 'true'), ('churn_drivers', 'true'), ('market_schedule', 'true'), ('issues', 'true'),
      ('sources', 'true'), ('blocks', 'true'), ('solutions', 'true'),
      ('market_conditions', 'preset is null')
    ) as t(a, b)
  loop
    execute format('select exists (select 1 from public.%I where workspace_id = $1 and %s)', tbl, col) into has_rows using p_workspace;
    if has_rows then
      what := replace(tbl, '_', ' ');
      exit;
    end if;
  end loop;
  if what is null and exists (
    select 1 from public.sandbox_scenarios s where s.workspace_id = p_workspace
      and not exists (select 1 from private.sandbox_library() l where l.name = s.name and private.sandbox_changes_shape(l.changes) = private.sandbox_changes_shape(s.changes))
  ) then
    what := 'scenarios of its own';
  end if;
  if what is not null then
    raise exception 'This workspace isn''t empty: it already has %. Backups restore only into a new, empty workspace.', what
      using errcode = '23514', hint = 'not_empty';
  end if;

  -- 5. Ids: every id and reference column of the plan holds a placeholder (or null) before anything is replaced.
  foreach sec in array list_sections loop
    if sec = 'processes' then continue; end if;
    for col in
      select c from (
        select 'id' as c where allow -> sec ? 'id'
        union all select split_part(r, '.', 2) from unnest(ref_cols) r where split_part(r, '.', 1) = sec
      ) q
    loop
      select count(*) into bad from jsonb_array_elements(p_plan -> sec) r
      where r.value -> col is not null and jsonb_typeof(r.value -> col) <> 'null'
        and (jsonb_typeof(r.value -> col) <> 'string' or (r.value ->> col) !~ placeholder_re);
      if bad > 0 then
        raise exception 'import_workspace_bundle: % holds an id that is not a placeholder in %', col, sec using errcode = '22023';
      end if;
    end loop;
  end loop;
  select count(*) into bad from jsonb_array_elements(p_plan -> 'issues') i
  where exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) x
      where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
    or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) x
      where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
    or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
      where jsonb_typeof(l.value) <> 'object'
        or (l.value ->> 'process_id') !~ placeholder_re
        or (jsonb_typeof(l.value -> 'step_id') <> 'null' and l.value ->> 'step_id' is not null and (l.value ->> 'step_id') !~ placeholder_re));
  if bad > 0 then
    raise exception 'import_workspace_bundle: an issue link, owner or source holds an id that is not a placeholder' using errcode = '22023';
  end if;
  select count(*) into bad from jsonb_array_elements(p_plan -> 'processes') p
  where (p.value ->> 'id') is null or (p.value ->> 'id') !~ placeholder_re
    or (jsonb_typeof(p.value -> 'parent_process_id') <> 'null' and p.value ->> 'parent_process_id' is not null and (p.value ->> 'parent_process_id') !~ placeholder_re)
    or exists (
      select 1 from jsonb_array_elements(p.value -> 'steps') s, unnest(array['id'] || step_ref_cols) c
      where s.value -> c is not null and jsonb_typeof(s.value -> c) <> 'null' and (jsonb_typeof(s.value -> c) <> 'string' or (s.value ->> c) !~ placeholder_re))
    or exists (
      select 1 from jsonb_array_elements(p.value -> 'edges') e, unnest(array['id', 'from_step_id', 'to_step_id']) c
      where e.value -> c is not null and jsonb_typeof(e.value -> c) <> 'null' and (jsonb_typeof(e.value -> c) <> 'string' or (e.value ->> c) !~ placeholder_re));
  if bad > 0 then
    raise exception 'import_workspace_bundle: a process, step or edge holds an id that is not a placeholder' using errcode = '22023';
  end if;

  -- The real ids: one random prefix per restore replaces the placeholder prefix.
  loop
    prefix := substr(md5(gen_random_uuid()::text), 1, 20);
    exit when prefix <> '00000000000000000000';
  end loop;
  prefix := substr(prefix, 1, 8) || '-' || substr(prefix, 9, 4) || '-' || substr(prefix, 13, 4) || '-' || substr(prefix, 17, 4) || '-';
  -- Two plain replacements (a regular expression took 13 times as long on a big plan): every placeholder gets the fresh
  -- prefix, then rank 0 (the old workspace), now `<prefix>000000000000`, becomes the real workspace. The prefix is never
  -- all zeros (the loop above), so no other id can take rank 0's place.
  txt := replace(p_plan::text, placeholder, prefix);
  txt := replace(txt, prefix || '000000000000', p_workspace::text);

  -- A scenario equal (name and changes) to one the workspace already has (the seeded library) is skipped: its children and the
  -- issues that use it are re-pointed at the existing row.
  for sc in select value from jsonb_array_elements((txt::jsonb) -> 'sandbox_scenarios') loop
    select s.id into existing from public.sandbox_scenarios s
    where s.workspace_id = p_workspace and s.name = sc ->> 'name' and private.sandbox_changes_shape(s.changes) = private.sandbox_changes_shape(sc -> 'changes')
    order by s.id limit 1;
    if found then
      txt := replace(txt, sc ->> 'id', existing::text);
      skip_ids := skip_ids || existing;
    end if;
  end loop;
  pl := txt::jsonb;
  txt := null;
  skipped := jsonb_build_object('scenarios', cardinality(skip_ids));

  -- 6. Write.
  foreach sec in array sections loop
    begin
      n := 0;
      if sec = 'settings' then
        if jsonb_typeof(pl -> 'settings') = 'object' and pl -> 'settings' <> '{}'::jsonb then
          -- Whoever may restore (can_edit_workspace, checked first) manages the workspace too, so the settings are applied.
          update public.workspaces set settings = settings || (pl -> 'settings') where id = p_workspace;
          settings_result := 'applied';
        end if;
        continue;
      end if;

      if sec in ('demand_settings', 'lever_settings', 'analysis_rules') then
        -- One row per workspace: written over any row the workspace already has.
        if jsonb_typeof(pl -> sec) = 'object' then
          select string_agg(quote_ident(c), ', '), string_agg(format('%1$I = excluded.%1$I', c), ', ') into cols, sets
          from jsonb_array_elements_text(allow -> sec) c where (pl -> sec) ? c;
          if cols is not null then
            execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_record(null::public.%1$I, $1) on conflict (workspace_id) do update set %3$s', sec, cols, sets)
              using pl -> sec, p_workspace;
            n := 1;
          end if;
        end if;

      elsif sec = 'market_schedule' then
        -- A row that points at one of the backup's presets points at this workspace's preset with the same key.
        insert into public.market_schedule (workspace_id, id, condition_id, from_month, to_month, created_at)
        select p_workspace, coalesce(x.id, gen_random_uuid()),
          coalesce(x.condition_id, (select m.id from public.market_conditions m where m.workspace_id = p_workspace and m.preset = r.value ->> 'condition_preset')),
          x.from_month, x.to_month, coalesce(x.created_at, now())
        from jsonb_array_elements(pl -> 'market_schedule') with ordinality r(value, ord)
        cross join lateral jsonb_populate_record(null::public.market_schedule, r.value) x
        order by r.ord;
        get diagnostics n = row_count;

      elsif sec = 'processes' then
        -- Every process first (parents first, as the plan is ordered), each opened as a draft, so a holder step can point at any of them.
        for node in select value from jsonb_array_elements(pl -> 'processes') loop
          proc := (node ->> 'id')::uuid;
          insert into public.processes (id, workspace_id, name, kind, entity_name, description, source, parent_process_id)
          values (proc, p_workspace, node ->> 'name', node ->> 'kind', node ->> 'entity_name', node ->> 'description', 'import', (node ->> 'parent_process_id')::uuid);
          draft := public.open_draft(proc);
          if draft ->> 'status' is distinct from 'ok' then
            raise exception 'could not open a draft of %', node ->> 'name' using errcode = '42501';
          end if;
          rev := (draft ->> 'revision_id')::uuid;
          revs := revs || jsonb_build_object(proc::text, rev);
          if jsonb_typeof(node -> 'layout') = 'object' then
            update public.process_revisions set layout = node -> 'layout' where id = rev;
          end if;
          if coalesce((node ->> 'archived')::boolean, false) then
            arch := arch || proc;
          end if;
          made := made || jsonb_build_object('id', proc, 'name', node ->> 'name', 'revision_id', rev, 'archived', coalesce((node ->> 'archived')::boolean, false));
          n := n + 1;
        end loop;

      elsif sec = 'sandbox_scenarios' then
        select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
        from jsonb_array_elements(pl -> 'sandbox_scenarios') with ordinality r(value, ord)
        where not ((r.value ->> 'id')::uuid = any (skip_ids));
        n := jsonb_array_length(rows);
        if n > 0 then
          -- A row without a horizon gets the default (populating a record from json would give it null, not the column default).
          select jsonb_agg(case when r.value ? 'horizon_months' and jsonb_typeof(r.value -> 'horizon_months') = 'number' then r.value else r.value || '{"horizon_months": 12}'::jsonb end order by r.ord)
            into rows from jsonb_array_elements(rows) with ordinality r(value, ord);
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
          -- One statement, so the parent foreign key (no action) is checked at its end, whatever the order of the rows.
          execute format('insert into public.sandbox_scenarios (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.sandbox_scenarios, $1)', cols) using rows, p_workspace;
        end if;

      elsif sec = 'issues' then
        rows := pl -> 'issues';
        n := jsonb_array_length(rows);
        if n > 0 then
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
          -- In plan order: the trigger numbers them 1, 2, 3 ... in the old order.
          execute format('insert into public.issues (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.issues, $1)', cols) using rows, p_workspace;
          -- `issue_seed_links` and `link_issue_source` may have added some already.
          insert into public.issue_links (issue_id, workspace_id, process_id, step_id)
          select (i.value ->> 'id')::uuid, p_workspace, (l.value ->> 'process_id')::uuid, (l.value ->> 'step_id')::uuid
          from jsonb_array_elements(rows) i
          cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
          on conflict do nothing;
          insert into public.issue_owners (issue_id, person_id, workspace_id)
          select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
          from jsonb_array_elements(rows) i
          cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) o
          on conflict do nothing;
          insert into public.issue_sources (issue_id, source_id, workspace_id)
          select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
          from jsonb_array_elements(rows) i
          cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) o
          on conflict do nothing;
        end if;

      elsif sec = 'steps' then
        -- The steps and edges of each draft (an entry step is set once all the steps are in), then its first principles.
        for node in select value from jsonb_array_elements(pl -> 'processes') loop
          proc := (node ->> 'id')::uuid;
          rev := (revs ->> proc::text)::uuid;
          select coalesce(jsonb_agg(s.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'entry_step_id', null, 'created_by', auth.uid())), '[]'::jsonb)
            into rows from jsonb_array_elements(node -> 'steps') s;
          if jsonb_array_length(rows) > 0 then
            select string_agg(quote_ident(k), ', ') into cols from (
              select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
              where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'steps') ? k
            ) q;
            execute format('insert into public.steps (%1$s) select %1$s from jsonb_populate_recordset(null::public.steps, $1)', cols) using rows;
            update public.steps st set entry_step_id = (s.value ->> 'entry_step_id')::uuid
            from jsonb_array_elements(node -> 'steps') s
            where st.revision_id = rev and st.id = (s.value ->> 'id')::uuid and s.value ->> 'entry_step_id' is not null;
            n := n + jsonb_array_length(rows);
          end if;
          select coalesce(jsonb_agg(e.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'created_by', auth.uid())), '[]'::jsonb)
            into rows from jsonb_array_elements(node -> 'edges') e;
          if jsonb_array_length(rows) > 0 then
            select string_agg(quote_ident(k), ', ') into cols from (
              select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
              where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'edges') ? k
            ) q;
            execute format('insert into public.edges (%1$s) select %1$s from jsonb_populate_recordset(null::public.edges, $1)', cols) using rows;
          end if;
          if jsonb_typeof(node -> 'first_principles') = 'object' then
            select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> 'first_principles') c where (node -> 'first_principles') ? c;
            if cols is not null then
              execute format('insert into public.first_principles (workspace_id, process_id, revision_id, %1$s) select $2, $3, $4, %1$s from jsonb_populate_record(null::public.first_principles, $1)', cols)
                using node -> 'first_principles', p_workspace, proc, rev;
            end if;
          end if;
        end loop;
        counts := counts || jsonb_build_object('edges', edge_total);

      elsif sec = 'archive' then
        if cardinality(arch) > 0 then
          update public.processes set archived_at = now() where id = any (arch);
          get diagnostics n = row_count;
        end if;

      elsif sec = 'log' then
        for node in select value from jsonb_array_elements(made) loop
          perform public.log_process_import((node ->> 'id')::uuid, 'Restored from a workspace backup' || coalesce(' (' || label || ')', ''));
          n := n + 1;
        end loop;

      else
        -- A flat section: one insert, the plan's order, only the columns of the allow-list that the rows carry.
        tbl := sec;
        rows := pl -> sec;
        if sec = 'market_conditions' then
          -- The presets are read-only and the workspace has them already: the plan carries custom conditions only, and no `preset`.
          null;
        elsif sec = 'source_links' then
          -- A step link needs its step in the process's restored draft (the trigger refuses it otherwise).
          select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
          from jsonb_array_elements(rows) with ordinality r(value, ord)
          where r.value ->> 'kind' is distinct from 'step' or exists (
            select 1 from public.steps s where s.workspace_id = p_workspace and s.process_id = (r.value ->> 'process_id')::uuid and s.id = (r.value ->> 'step_id')::uuid);
          skipped := skipped || jsonb_build_object('step_links', jsonb_array_length(pl -> sec) - jsonb_array_length(rows));
        end if;
        n := jsonb_array_length(rows);
        if n > 0 then
          -- A source link's id can't be given by a signed-in caller (the insert grant on the table is by column, and leaves `id`
          -- and `created_at` out): the database makes it.
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c) and not (sec = 'source_links' and c = 'id');
          if cols is null then
            raise exception 'the rows have none of the columns a restore accepts' using errcode = '22023';
          end if;
          execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_recordset(null::public.%1$I, $1)%3$s', tbl, cols,
            case when sec = 'source_links' then ' on conflict do nothing' else '' end)
            using rows, p_workspace;
        end if;
      end if;
      counts := counts || jsonb_build_object(sec, n);
    exception when others then
      raise exception 'import_workspace_bundle: % could not be restored: %', sec, sqlerrm using errcode = sqlstate, hint = 'section:' || sec;
    end;
  end loop;

  return jsonb_build_object('id_prefix', prefix, 'processes', made, 'counts', counts, 'skipped', skipped, 'settings', settings_result);
end;
$$;
