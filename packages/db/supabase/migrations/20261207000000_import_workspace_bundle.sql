-- B10 part 2b (issue #39): restore a workspace backup into a new, empty workspace, all or nothing.
--
-- Part 1 (PR #189) exports a `transpera-workspace/1` JSON backup; part 2a (PR #200) restricts export to agency admins, owners
-- and editors and checks and plans a restore in TypeScript (`packages/db/src/workspace-import.ts`). This migration adds the
-- one database function the restore needs.
--
-- Austin's decisions (6 Oct 2026, quoted on #39 and in docs/plans/b10-2-brief.md):
--   1. Every process arrives as a draft of its live version. History is not restored, and no privileged restore is added.
--   2. The new workspace keeps its own company map, laid out by default from the imported processes.
--   3. Hidden clients are included in the backup (emails and tokens stay out).
--   4. Only agency admins, owners and editors may export or import (`public.can_edit_workspace`).
--   5. One SECURITY INVOKER function, so the restore is all or nothing.
--   6. Saved solutions are not restored (`solutions_before_write` needs a published base version, and every restored process is
--      a draft). They stay in the file and the restore page lists them.
--
-- 1. `public.import_workspace_bundle(p_workspace, p_plan, p_label)`: SECURITY INVOKER, `search_path = ''`. It runs as the signed-in
--    user, so row-level security and every trigger still decide (drafts only, the company map's guards, the `needs_review` token
--    guard, issue numbering and history, `edit_drafts_only`). It creates DRAFTS ONLY, PUBLISHES NOTHING and WRITES NO HISTORY
--    (no version but a first draft per process, no issue events but the `created` entry each issue gets now). One call is one
--    statement and one transaction: a failure anywhere leaves nothing behind (a half-filled workspace could only be deleted by an
--    agency admin).
--    `p_plan` is what `planWorkspaceImport` makes (`transpera-workspace-import/1`): one entry per process (its live version's
--    steps, edges, layout and first principles), the company model, scenarios, blocks, sources, issues with their links, and
--    pending suggestions and proposals, each row cut down to the columns of `IMPORT_COLUMNS` (the allow-list below is the same
--    list, and a test compares them). `p_label` is the file name, shown as "Upload (<name>)" on what waits for review.
--    Refusals, in this order: an API token (42501, backups are restored in the app); anyone who can't `can_edit_workspace`
--    (42501); a plan of the wrong shape or over a limit (22023); a workspace that isn't empty (23514, hint `not_empty`); a
--    value in an id or reference column that isn't a placeholder id (22023). A failure while writing says which section
--    (`hint = 'section:<name>'`).
--    "Empty" means: no process but the company map (archived included), role, person, service, client group, client, lead
--    source, churn driver, market-schedule row, issue, source, block, solution, suggestion or proposal, no custom market
--    condition, and no scenario but the seeded library. Demand, lever and analysis-rule settings and the workspace settings may
--    already exist and are overwritten.
--    Lock: `pg_advisory_xact_lock` on `import_workspace_bundle:<workspace>` and on the key `import_new_process` takes, so two
--    restores take turns (the second finds the workspace not empty) and a process upload can't run alongside.
--    Ids: the plan holds placeholder ids `00000000-0000-4000-8000-<12 hex>`, whose last 12 digits are the rank of the old id
--    (rank 0 is the old workspace). The database makes the real ids: one random 20-hex prefix per restore replaces the
--    placeholder prefix throughout the plan text, once, and rank 0 becomes `p_workspace` (so a suggestion that targets the
--    workspace points at the real one). The engine sorts by id in many places, and the new ids sort exactly as the old ones did
--    (Postgres compares uuids bytewise). A caller can't choose a real id, so a refused insert can't reveal whether some id
--    exists elsewhere. The prefix is returned (`id_prefix`) so a test can map results back.
--    Writes, in this order (one `begin ... exception` block per section; the section named in the error): workspace settings
--    (an owner or agency admin writes them; an editor leaves one pending suggestion for an owner), the company model, sources
--    (BEFORE steps: the `link_cited_sources` trigger links a step to the sources it cites as the step is written), processes
--    (parents first, each opened as a draft with `open_draft`; archived ones are inserted unarchived for now), scenarios (one
--    equal to a row the workspace already has, by name and patch, is skipped and its children and issues are re-pointed at the
--    existing row), blocks, issues with links, owners and sources (BEFORE steps: `log_perception_gaps` inserts its issue `on
--    conflict do nothing`, so a restored perception-gap issue gets no duplicate), the steps, edges and first principles of every
--    draft (all processes exist first, so holder steps resolve whichever process they point at), services and everything that
--    points at processes, source links, pending suggestions and proposals (recorded as uploads while `transpera.importing` is
--    on), then the archived processes are archived and each process's import is logged (`log_process_import`).
--    Limits (the same numbers as `WORKSPACE_IMPORT_LIMITS`): 75 processes, 750 steps, 1,500 edges, 200 sources and
--    3,000,000 characters of their text, 600 issues, 500 people, 2,000 clients, 300 scenarios, 300 blocks, 500
--    suggestions, 300 proposals, 1,000 role assignments, 2,500 skills, 1,000 client assignments, 1,000 source links, and a plan of 10 MB (lower than the brief's starting values, which took 6 s at every limit at
--    once, over the 3 s budget; see the comment on WORKSPACE_IMPORT_LIMITS) (measured as the compact JSON the app sends; the database measures the
--    jsonb text, which carries a space after each colon and comma, so it allows 13,107,200 characters of it). Supabase gives
--    `authenticated` an 8 s `statement_timeout`: one restore is one statement, and the performance test in
--    packages/db/test/workspace-import.test.ts keeps every limit well inside it.
--    Returns `{id_prefix, processes: [{id, name, revision_id, archived}], counts: {<section>: n}, skipped: {<reason>: n},
--    settings: 'applied' | 'suggested' | 'none'}`.
--
-- 2. `grant execute on function private.scenario_library() to authenticated`: the "is the workspace empty" check compares its
--    scenarios with the seeded library, and an invoker function can't call a private function its caller may not execute (it
--    gives "permission denied", seen in the tests). The function is immutable and returns four fixed rows of text (the same ones
--    every workspace is seeded with), so the grant reveals nothing. (Its sibling private.cited_source_ids and others are granted
--    the same way.)
--
-- STRICTLY ADDITIVE: one function and one grant. It doesn't redefine `save_fields` or any existing function or trigger.
--
-- ORDER: apply after 20261206000000 (B1 slice 1, row 53, applied to production on 6 Oct 2026). Nothing later may be applied,
-- except possibly 20261207500000 (B1 2/3a, built in parallel, independent of this).
--
-- PREFLIGHT (read-only; run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each must return the stated result):
--   0. B1 (1/3) (row 53, 20261206000000) is applied, and nothing is later (but possibly 20261207500000). Expect 1, then 0 rows
--      or only 20261207500000:
--        select count(*) from supabase_migrations.schema_migrations where version = '20261206000000';
--        select version from supabase_migrations.schema_migrations where version > '20261206000000' order by 1;
--   1. Not created yet. Expect null:
--        select to_regprocedure('public.import_workspace_bundle(uuid, jsonb, text)');
--   2. What it calls exists. Expect 7 rows:
--        select proname from pg_proc where pronamespace = 'public'::regnamespace
--          and proname in ('open_draft', 'log_process_import', 'can_edit_workspace', 'can_manage_workspace', 'import_new_process', 'import_process_bundle', 'create_workspace');
--   3. The upload marker is honoured by both insert triggers. Expect two rows, both true:
--        select proname, prosrc like '%transpera.importing%' from pg_proc where pronamespace = 'private'::regnamespace
--          and proname in ('suggestions_before_write', 'suggestion_proposals_before_write');
--   4. 'upload' is an allowed created_via. Expect 2 rows mentioning 'upload':
--        select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('suggestions_created_via', 'suggestion_proposals_created_via');
--   5. The library and presets it compares against. Expect 4 and 4:
--        select count(*) from private.scenario_library();
--        select count(*) from private.market_presets();
--   6. Authenticated can't execute the library yet. Expect false (this migration grants it). If it is TRUE, production already had
--      that grant: do NOT revoke it in the rollback below (leave that line out).
--        select has_function_privilege('authenticated', 'private.scenario_library()', 'execute');
--
-- POST-APPLY CHECK (authenticated may execute it; anon and PUBLIC may not; it is not SECURITY DEFINER and has an empty search_path):
--   1. Expect one row, authenticated EXECUTE:
--        select routine_name, grantee, privilege_type from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'import_workspace_bundle' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 2;
--   2. Expect an ACL with an `authenticated=X/...` entry and no `anon=` and no `=X/...` (an empty grantee is PUBLIC):
--        select proname, proacl from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_workspace_bundle';
--   3. Expect false, {search_path=""}:
--        select prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_workspace_bundle';
--   4. Authenticated may execute the library (and anon may not). Expect true, false:
--        select has_function_privilege('authenticated', 'private.scenario_library()', 'execute'), has_function_privilege('anon', 'private.scenario_library()', 'execute');
--
-- Rollback (nothing existing was changed):
--   begin;
--   drop function if exists public.import_workspace_bundle(uuid, jsonb, text);
--   revoke execute on function private.scenario_library() from authenticated;   -- only if preflight 6 said false
--   delete from supabase_migrations.schema_migrations where version = '20261207000000';
--   commit;
-- Roll the app back first (it calls the function). Workspaces already restored stay as they are.
--
-- Production data: none needed.

create function public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text default null) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- The columns the restore accepts for each plan section: the same lists as IMPORT_COLUMNS (packages/db/src/workspace-import.ts).
  -- Everything else in a row is ignored; `workspace_id`, `created_by`, `updated_at` and every `*_by` are never read from the plan.
  allow constant jsonb := '{"roles":["id","name","color","default_cost_rate","headcount","ongoing_hours_per_client_week","active","provenance","created_at"],"people":["id","name","active","capacity_hours_week","cost_rate","end_date","fte","notes","start_date","provenance","created_at"],"person_roles":["person_id","role_id","created_at"],"person_leave":["id","person_id","start_date","end_date","note","created_at"],"lead_sources":["id","name","conversion_to_qualified","volume_week","provenance","created_at"],"seasonality":["id","month","multiplier","provenance","created_at"],"demand_settings":["growth_monthly","provenance","created_at"],"churn_drivers":["id","name","description","driver","enabled","example","month","value","weight","provenance","created_at"],"market_conditions":["id","name","churn","conv","cycle","hire","leads","pay","price","created_at"],"market_schedule":["id","condition_id","from_month","to_month","created_at"],"lever_settings":["hidden","created_at"],"analysis_rules":["settings","created_at"],"clients":["id","name","active","health","mrr","notes","start_date","provenance","created_at"],"sources":["id","kind","title","body","recorded_at","speakers","created_at"],"processes":["id","parent_process_id","name","kind","entity_name","description"],"steps":["id","assumption","child_process_id","conflict","cost_override","current_wip","dropoff_benchmark","expected_wait_hours","entry_step_id","kind","lost_per_day_waiting","name","notes","outcome","parent_step_id","person_id","provenance","replaced_by","rework_rate","rework_to_step_id","role_id","sla_hours","target_cycle_hours","tool","wait_dist","wait_hours","wait_params","work_dist","work_hours","work_params","x","y"],"edges":["id","condition_tag","from_step_id","label","probability","to_step_id"],"first_principles":["deletes","improvements","job_done","job_progress","job_situation","job_who","measures","requirements","root_cause","statements","why_chain","why_problem"],"scenarios":["id","parent_scenario_id","name","description","patch","created_at"],"blocks":["id","name","description","type","steps","created_at"],"issues":["id","client_id","created_at","detected_key","evidence","evidence_metrics","evidence_sources","owner_person_id","person_id","process_id","resolution","resolution_note","resolved_how","role_id","scenario_id","severity","source","status","step_id","target_goal","target_measure","target_now","title","type"],"services":["id","name","active","churn_health_sensitivity","churn_monthly_base","entry_process_id","fallback_ongoing_load","margin","mix_share","path_tags","price","pricing_model","tenure_months","provenance","created_at"],"service_servicing":["id","process_id","service_id","recurrence","sla_hours","provenance","created_at"],"client_groups":["id","service_id","client_count","churn_monthly","fee","starting_health","stay_months","provenance","created_at"],"client_services":["client_id","service_id","start_date","created_at"],"client_assignments":["client_id","role_id","person_id","created_at"],"person_skills":["person_id","step_id","efficiency","provenance","created_at"],"source_links":["id","insight_key","issue_id","kind","process_id","source_id","step_id"],"suggestions":["id","target_table","target_id","patch","evidence","note","created_at"],"proposals":["id","kind","title","detail","payload","evidence","note","issue_id","created_at"]}'::jsonb;
  -- The reference columns of the flat sections (IMPORT_REFS) and of steps (IMPORT_STEP_REFS). Every section that has an `id`
  -- column in `allow` is checked on `id` too.
  ref_cols constant text[] := array['person_roles.person_id','person_roles.role_id','person_leave.person_id','services.entry_process_id','service_servicing.service_id','service_servicing.process_id','client_groups.service_id','client_services.client_id','client_services.service_id','client_assignments.client_id','client_assignments.role_id','client_assignments.person_id','person_skills.person_id','person_skills.step_id','scenarios.parent_scenario_id','issues.client_id','issues.owner_person_id','issues.person_id','issues.process_id','issues.role_id','issues.scenario_id','issues.step_id','source_links.source_id','source_links.issue_id','source_links.process_id','source_links.step_id','proposals.issue_id','market_schedule.condition_id','suggestions.target_id'];
  step_ref_cols constant text[] := array['parent_step_id','entry_step_id','rework_to_step_id','person_id','role_id','child_process_id'];
  -- The order the sections are written in.
  sections constant text[] := array['settings','roles','people','person_roles','person_leave','lead_sources','seasonality','demand_settings','churn_drivers','market_conditions','market_schedule','lever_settings','analysis_rules','clients','sources','processes','scenarios','blocks','issues','steps','services','service_servicing','client_groups','client_services','client_assignments','person_skills','source_links','suggestions','proposals','archive','log'];
  list_sections constant text[] := array['roles','people','person_roles','person_leave','lead_sources','seasonality','churn_drivers','market_conditions','market_schedule','clients','sources','processes','scenarios','blocks','issues','services','service_servicing','client_groups','client_services','client_assignments','person_skills','source_links','suggestions','proposals'];
  one_sections constant text[] := array['settings','demand_settings','lever_settings','analysis_rules'];
  placeholder constant text := '00000000-0000-4000-8000-';
  placeholder_re constant text := '^00000000-0000-4000-8000-[0-9a-f]{12}$';
  max_plan_chars constant integer := 13107200;

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
    raise exception 'Only owners, editors and agency admins can restore a backup.' using errcode = '42501';
  end if;

  -- 2. Shape and limits.
  if p_plan is null or jsonb_typeof(p_plan) is distinct from 'object' or p_plan ->> 'format' is distinct from 'transpera-workspace-import/1' then
    raise exception 'import_workspace_bundle: p_plan is not a transpera-workspace-import/1 plan' using errcode = '22023';
  end if;
  if char_length(p_plan::text) > max_plan_chars then
    raise exception 'import_workspace_bundle: the plan is too big (at most 10 MB)' using errcode = '22023';
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
  if jsonb_array_length(p_plan -> 'processes') > 75 or step_total > 750 or edge_total > 1500
    or jsonb_array_length(p_plan -> 'sources') > 200 or chars > 3000000
    or jsonb_array_length(p_plan -> 'issues') > 600 or jsonb_array_length(p_plan -> 'people') > 500
    or jsonb_array_length(p_plan -> 'clients') > 2000 or jsonb_array_length(p_plan -> 'scenarios') > 300
    or jsonb_array_length(p_plan -> 'blocks') > 300 or jsonb_array_length(p_plan -> 'suggestions') > 500
    or jsonb_array_length(p_plan -> 'proposals') > 300
    or jsonb_array_length(p_plan -> 'person_roles') > 1000 or jsonb_array_length(p_plan -> 'person_skills') > 2500
    or jsonb_array_length(p_plan -> 'client_assignments') > 1000 or jsonb_array_length(p_plan -> 'source_links') > 1000 then
    raise exception 'import_workspace_bundle: the plan is over a limit (75 processes, 750 steps, 1500 edges, 200 sources of 3,000,000 characters, 600 issues, 500 people, 2000 clients, 300 scenarios, 300 blocks, 500 suggestions, 300 proposals, 1000 role assignments, 2500 skills, 1000 client assignments, 1000 source links)' using errcode = '22023';
  end if;
  -- A scenario without an id would make the replacement of a skipped one (below) return null, and the restore would write nothing and say it worked.
  if exists (select 1 from jsonb_array_elements(p_plan -> 'scenarios') s where jsonb_typeof(s.value -> 'id') is distinct from 'string') then
    raise exception 'import_workspace_bundle: every scenario needs an id' using errcode = '22023';
  end if;

  -- 3. Lock: one restore (or upload) at a time per workspace.
  perform pg_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || p_workspace::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('import_new_process:' || p_workspace::text, 0));

  -- 4. Empty.
  for tbl, col in
    select t.a, t.b from (values
      ('processes', 'not is_company'), ('roles', 'true'), ('people', 'true'), ('services', 'true'), ('client_groups', 'true'),
      ('clients', 'true'), ('lead_sources', 'true'), ('churn_drivers', 'true'), ('market_schedule', 'true'), ('issues', 'true'),
      ('sources', 'true'), ('blocks', 'true'), ('solutions', 'true'), ('suggestions', 'true'), ('suggestion_proposals', 'true'),
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
    select 1 from public.scenarios s where s.workspace_id = p_workspace
      and not exists (select 1 from private.scenario_library() l where l.name = s.name and l.patch = s.patch)
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

  -- The real ids: one random prefix per restore replaces the placeholder prefix (rank 0, the old workspace, is left for the next
  -- replace so a workspace id that happens to look like a placeholder can't be hit twice).
  loop
    prefix := substr(md5(gen_random_uuid()::text), 1, 20);
    exit when prefix <> '00000000000000000000';
  end loop;
  prefix := substr(prefix, 1, 8) || '-' || substr(prefix, 9, 4) || '-' || substr(prefix, 13, 4) || '-' || substr(prefix, 17, 4) || '-';
  txt := regexp_replace(p_plan::text, '00000000-0000-4000-8000-(?!000000000000)([0-9a-f]{12})', prefix || '\1', 'g');
  txt := replace(txt, placeholder || '000000000000', p_workspace::text);

  -- A scenario equal (name and patch) to one the workspace already has (the seeded library) is skipped: its children and the
  -- issues that use it are re-pointed at the existing row.
  for sc in select value from jsonb_array_elements((txt::jsonb) -> 'scenarios') loop
    select s.id into existing from public.scenarios s
    where s.workspace_id = p_workspace and s.name = sc ->> 'name' and s.patch = sc -> 'patch'
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
          if public.can_manage_workspace(p_workspace) then
            update public.workspaces set settings = settings || (pl -> 'settings') where id = p_workspace;
            settings_result := 'applied';
          else
            -- An editor can't write workspace-wide settings: one pending suggestion for an owner (the shape packages/mcp/src/suggesting.ts makes).
            perform set_config('transpera.importing', 'on', true);
            insert into public.suggestions (workspace_id, target_table, target_id, patch, evidence, note, import_source)
            values (p_workspace, 'workspaces', null, jsonb_build_object('set', pl -> 'settings'), '[]'::jsonb, 'Workspace settings from a backup.', label);
            perform set_config('transpera.importing', '', true);
            settings_result := 'suggested';
          end if;
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

      elsif sec = 'scenarios' then
        select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
        from jsonb_array_elements(pl -> 'scenarios') with ordinality r(value, ord)
        where not ((r.value ->> 'id')::uuid = any (skip_ids));
        n := jsonb_array_length(rows);
        if n > 0 then
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
          execute format('insert into public.scenarios (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.scenarios, $1)', cols) using rows, p_workspace;
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
        tbl := case sec when 'proposals' then 'suggestion_proposals' else sec end;
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
          if sec in ('suggestions', 'proposals') then
            perform set_config('transpera.importing', 'on', true);
            execute format('insert into public.%1$I (workspace_id, %2$s, import_source) select $2, %2$s, $3 from jsonb_populate_recordset(null::public.%1$I, $1)', tbl, cols)
              using rows, p_workspace, label;
            perform set_config('transpera.importing', '', true);
          else
            execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_recordset(null::public.%1$I, $1)%3$s', tbl, cols,
              case when sec = 'source_links' then ' on conflict do nothing' else '' end)
              using rows, p_workspace;
          end if;
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

revoke all on function public.import_workspace_bundle(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.import_workspace_bundle(uuid, jsonb, text) to authenticated;

grant execute on function private.scenario_library() to authenticated;
