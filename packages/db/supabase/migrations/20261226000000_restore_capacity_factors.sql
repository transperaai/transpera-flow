-- #228 (C6 follow-up): restore per-person times from a backup.
--
-- C6 (#198, migration 20261223000000, row 67) exports `person_capacity_factors` in a backup, but `import_workspace_bundle` left them out
-- (a restore listed them as left out, and warned when the switch was on). So a restored workspace that used per-person times simulated
-- differently from the original. This migration restores them, so a restored workspace's results match the original's (#39).
--
-- The decisions this follows:
--   #39 (B10), Austin, 6 Oct 2026: "The acceptance criterion becomes: 1. The restored engine model equals the source model, once ids are
--       mapped back. 2. Headline results are within normal run-to-run variation."
--   #39 Q1: "yes to the migration `import_workspace_bundle`. It is one SECURITY INVOKER function: not privileged, additive only, and it
--       creates drafts only. It makes the restore all-or-nothing." (The function stays SECURITY INVOKER, in one transaction.)
--   C6 brief Q2 (the default this reverses): "the export keeps them, the restore leaves them out and says so (and warns when the switch was
--       on). This is an exception to #39's "results match", for workspaces using factors. Follow-up ticket to restore them." That ticket is #228.
--   B21 (#203), which still binds: one call, one transaction; `set statement_timeout = '40s'` on this function only (never raise it, and
--       never raise any other timeout); every limit at once must restore in under 15 s locally (the performance test is the arbiter).
--
-- What changes (`public.import_workspace_bundle(uuid, jsonb, text)`; the body is a full copy of 20261215000000's, md5
-- 32b64f2ad9be79d0044f640e4a4d2ed2, plus six hunks, each marked `-- #228` on the line above it):
--   (a) `allow`: the section `person_capacity_factors` with the columns person_id, step_id, factor, provenance (the same list as
--       IMPORT_COLUMNS in packages/db/src/workspace-import.ts).
--   (b) `ref_cols`: `person_capacity_factors.person_id` and `person_capacity_factors.step_id`, so step 5's id check accepts a placeholder or
--       null in both and refuses anything else (22023).
--   (c) `sections`: `person_capacity_factors` right after `person_skills` (people and steps are written by then; the table has no FK on
--       `step_id`). It is written by the existing flat-section path: one set-based insert, inside the per-section `begin ... exception` that
--       re-raises with hint `section:person_capacity_factors`.
--   (d) `list_sections`: the same place.
--   (e) A plan made before this migration (an app deployed before it) has no such key, and the list check would refuse it ("must be a
--       list"): right after the format check it gets an empty section.
--   (f) The limit check: more than 3000 per-person times is refused, and the message ends ", 3000 per-person times)" (`planDetail` in
--       apps/web/src/lib/restore/errors.ts parses it).
-- Same signature, SECURITY INVOKER, same `search_path` and 40 s `statement_timeout`, same refusals in the same order, same result; the
-- section's count appears in `counts.person_capacity_factors`. The flat path writes `workspace_id = p_workspace` and only the allow-listed
-- columns, so `created_by` is the caller (the column default) and `created_at` and `updated_at` are now. The table's triggers run as for any
-- insert: `stamp_provenance('factor')` keeps a given `provenance.factor` (else stamps `entered` by the caller, now), `needs_review` refuses an
-- API token (the function refuses tokens first), `audit_company` logs one insert per row, and the two partial unique indexes can't collide
-- because the planner refuses a repeated (person, step) pair.
-- The function itself checks, for this section: the id check (step 5) admits only placeholders or null in `person_id` and `step_id`, so no
-- id of another workspace gets in; `person_id` must then be a person restored into this workspace (the foreign key on (person_id,
-- workspace_id)); the factor is checked by the table's own constraint, 0.5 to 2, the range `save_capacity_factor` checks (23514 either way).
-- A placeholder `step_id` that names no restored step is not refused (the table has no foreign key on `step_id`, as for `person_skills`,
-- whose restore doesn't check it either): the planner drops such a row, and an editor can store such a row directly through the API
-- anyway; the engine ignores a time on a step that isn't in the model.
-- Provenance: `provenance.factor` is kept as the backup holds it, which is `source` and `at` only: the export removes every account id
-- (`by` included; packages/db/src/workspace-bundle.ts `ACCOUNT_KEY`), as for every other restored provenance.
--
-- STRICTLY ADDITIVE: one `create or replace` of `public.import_workspace_bundle` with the same signature, settings, refusals and result; one
-- more section. It doesn't redefine `save_fields` or any other function, trigger or policy.
--
-- ORDER: after row 70 (20261225000000, #230, applied), the latest on production; it also needs row 67 (20261223000000: the table) and
-- row 61 (20261215000000: the body copied), both applied. Ledger row 71. Rows 68 (20261224000000), 69 (20261224500000) and 70 touch
-- neither this function nor the table's shape. Independent of #227 (20261227000000); if #227 is applied first, renumber this file above
-- it (HANDOVER "Migration order"). Apply BEFORE deploying the app.
-- The old function writes only the sections in its `sections` constant and ignores any other key, so the new app's plan against the old
-- function would restore WITHOUT the per-person times and without saying so.
--
-- PREFLIGHT (read-only; `bash packages/db/scripts/prod-sql.sh -c "..."`, one query at a time):
--   0. Rows 61 and 67 are applied, rows 68 to 70 are the latest, and nothing is at or past this one. Expect exactly five rows,
--      20261215000000, 20261223000000, 20261224000000, 20261224500000, 20261225000000 (so nothing >= 20261226000000):
--        select version from supabase_migrations.schema_migrations where version in ('20261215000000', '20261223000000') or version >= '20261224000000' order by 1;
--   1. The function is B21's. Expect 32b64f2ad9be79d0044f640e4a4d2ed2, f, {search_path="",statement_timeout=40s}:
--        select md5(prosrc), prosecdef, proconfig from pg_proc where oid = 'public.import_workspace_bundle(uuid, jsonb, text)'::regprocedure;
--   2. The table and its triggers exist. Expect `person_capacity_factors`, then the four names audit_company, needs_review, set_updated_at, stamp_provenance:
--        select to_regclass('public.person_capacity_factors');
--        select tgname from pg_trigger where tgrelid = 'public.person_capacity_factors'::regclass and not tgisinternal order by 1;
--   3. Nobody is restoring right now (B21's preflight 4; an idle pooled connection still holds its last query, so only backends that aren't idle count). Expect 0:
--        select count(*) from pg_stat_activity where query ilike '%import_workspace_bundle%' and state <> 'idle' and pid <> pg_backend_pid();
--
-- POST-APPLY CHECKS:
--   1. The function is this migration's, with the body md5 fca39a6d6727b1f6e7d3bf585400e1f0: expect that md5, then f, then {search_path="",statement_timeout=40s}:
--        select md5(prosrc), prosecdef, proconfig from pg_proc where oid = 'public.import_workspace_bundle(uuid, jsonb, text)'::regprocedure;
--   2. Only authenticated may execute it (B21's post-apply 2). Expect one row, authenticated EXECUTE:
--        select routine_name, grantee, privilege_type from information_schema.routine_privileges
--         where routine_schema = 'public' and routine_name = 'import_workspace_bundle' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 2;
--   3. The row. Expect 1:
--        select count(*) from supabase_migrations.schema_migrations where version = '20261226000000';
--   4. Smoke test, ROLLED BACK: one `do` block (one `prod-sql.sh -c` call) that, as an agency admin, creates a workspace, restores a
--      one-person plan with an "Every step" time of 0.8 into it, reads the stored row, and then raises an error so that everything it
--      did is rolled back. Put a real agency admin's user id in the claims (`select id from auth.users where (raw_app_meta_data ->>
--      'agency_admin')::boolean;`). Expect exactly this ERROR (any other error is a failure), then 0 from the check after it:
--        SMOKE TEST ROLLED BACK: restored 1, factor 0.8, step every step, source entered
--        do $smoke$
--        declare
--          ws uuid;
--          r jsonb;
--          f record;
--        begin
--          perform set_config('role', 'authenticated', true);
--          perform set_config('request.jwt.claims', '{"sub":"<agency admin user id>","role":"authenticated","app_metadata":{"agency_admin":true}}', true);
--          ws := public.create_workspace('Smoke test 228', 'smoke-test-228-' || substr(md5(clock_timestamp()::text), 1, 8));
--          r := public.import_workspace_bundle(ws, '{"format":"transpera-workspace-import/1","roles":[],"people":[{"id":"00000000-0000-4000-8000-000000000001","name":"Smoke person"}],"person_roles":[],"person_leave":[],"lead_sources":[],"seasonality":[],"churn_drivers":[],"market_conditions":[],"market_schedule":[],"clients":[],"sources":[],"processes":[],"scenarios":[],"blocks":[],"issues":[],"services":[],"service_servicing":[],"client_groups":[],"client_services":[],"client_assignments":[],"person_skills":[],"person_capacity_factors":[{"person_id":"00000000-0000-4000-8000-000000000001","step_id":null,"factor":0.8,"provenance":{"factor":{"source":"entered","at":"2026-10-01T00:00:00Z"}}}],"source_links":[],"suggestions":[],"proposals":[]}'::jsonb, 'smoke test');
--          select c.factor, c.step_id, c.provenance -> 'factor' ->> 'source' as source into f from public.person_capacity_factors c where c.workspace_id = ws;
--          raise exception 'SMOKE TEST ROLLED BACK: restored %, factor %, step %, source %', r -> 'counts' ->> 'person_capacity_factors', f.factor, coalesce(f.step_id::text, 'every step'), f.source;
--        end
--        $smoke$;
--        select count(*) from public.workspaces where name = 'Smoke test 228';
--   5. Live check (Austin, on a preview): export a workspace with per-person times switched on and a few times set, restore it into a new
--      workspace, publish, and see the same times in Settings -> People. (An editor's restore brings the times, but the switch arrives as a
--      pending settings suggestion for an owner, as for every setting.)
--
-- ROLLBACK (one transaction; B21's whole `create or replace function` statement of 20261215000000, with its `set statement_timeout = '40s'`
-- so the setting stays, then the grants and the removal of this row. Roll the app back first: an old app's plans restore under either
-- function, but the new app's factors would be dropped silently by the old one. Workspaces restored meanwhile keep their factors):
--   begin;
--   create or replace function public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text default null) returns jsonb
--   language plpgsql
--   security invoker
--   set search_path = ''
--   set statement_timeout = '40s'
--   as $$
--   declare
--     -- The columns the restore accepts for each plan section: the same lists as IMPORT_COLUMNS (packages/db/src/workspace-import.ts).
--     -- Everything else in a row is ignored; `workspace_id`, `created_by`, `updated_at` and every `*_by` are never read from the plan.
--     allow constant jsonb := '{"roles":["id","name","color","default_cost_rate","headcount","ongoing_hours_per_client_week","active","provenance","created_at"],"people":["id","name","active","capacity_hours_week","cost_rate","end_date","fte","notes","start_date","provenance","created_at"],"person_roles":["person_id","role_id","created_at"],"person_leave":["id","person_id","start_date","end_date","note","created_at"],"lead_sources":["id","name","conversion_to_qualified","volume_week","provenance","created_at"],"seasonality":["id","month","multiplier","provenance","created_at"],"demand_settings":["growth_monthly","provenance","created_at"],"churn_drivers":["id","name","description","driver","enabled","example","month","value","weight","provenance","created_at"],"market_conditions":["id","name","churn","conv","cycle","hire","leads","pay","price","created_at"],"market_schedule":["id","condition_id","from_month","to_month","created_at"],"lever_settings":["hidden","created_at"],"analysis_rules":["settings","created_at"],"clients":["id","name","active","health","mrr","notes","start_date","provenance","created_at"],"sources":["id","kind","title","body","recorded_at","speakers","created_at"],"processes":["id","parent_process_id","name","kind","entity_name","description"],"steps":["id","assumption","child_process_id","conflict","cost_override","current_wip","dropoff_benchmark","expected_wait_hours","entry_step_id","kind","lost_per_day_waiting","name","notes","outcome","parent_step_id","person_id","provenance","replaced_by","rework_rate","rework_to_step_id","role_id","sla_hours","target_cycle_hours","tool","wait_dist","wait_hours","wait_params","work_dist","work_hours","work_params","x","y"],"edges":["id","condition_tag","from_step_id","label","probability","to_step_id"],"first_principles":["deletes","improvements","job_done","job_progress","job_situation","job_who","measures","requirements","root_cause","statements","why_chain","why_problem"],"scenarios":["id","parent_scenario_id","name","description","patch","created_at"],"blocks":["id","name","description","type","steps","created_at"],"issues":["id","client_id","created_at","detected_key","evidence","evidence_metrics","evidence_sources","owner_person_id","person_id","process_id","resolution","resolution_note","resolved_how","role_id","scenario_id","severity","source","status","step_id","target_goal","target_measure","target_now","title","type"],"services":["id","name","active","churn_health_sensitivity","churn_monthly_base","entry_process_id","fallback_ongoing_load","margin","mix_share","path_tags","price","pricing_model","tenure_months","provenance","created_at"],"service_servicing":["id","process_id","service_id","recurrence","sla_hours","provenance","created_at"],"client_groups":["id","service_id","client_count","churn_monthly","fee","starting_health","stay_months","provenance","created_at"],"client_services":["client_id","service_id","start_date","created_at"],"client_assignments":["client_id","role_id","person_id","created_at"],"person_skills":["person_id","step_id","efficiency","provenance","created_at"],"source_links":["id","insight_key","issue_id","kind","process_id","source_id","step_id"],"suggestions":["id","target_table","target_id","patch","evidence","note","created_at"],"proposals":["id","kind","title","detail","payload","evidence","note","issue_id","created_at"]}'::jsonb;
--     -- The reference columns of the flat sections (IMPORT_REFS) and of steps (IMPORT_STEP_REFS). Every section that has an `id`
--     -- column in `allow` is checked on `id` too.
--     ref_cols constant text[] := array['person_roles.person_id','person_roles.role_id','person_leave.person_id','services.entry_process_id','service_servicing.service_id','service_servicing.process_id','client_groups.service_id','client_services.client_id','client_services.service_id','client_assignments.client_id','client_assignments.role_id','client_assignments.person_id','person_skills.person_id','person_skills.step_id','scenarios.parent_scenario_id','issues.client_id','issues.owner_person_id','issues.person_id','issues.process_id','issues.role_id','issues.scenario_id','issues.step_id','source_links.source_id','source_links.issue_id','source_links.process_id','source_links.step_id','proposals.issue_id','market_schedule.condition_id','suggestions.target_id'];
--     step_ref_cols constant text[] := array['parent_step_id','entry_step_id','rework_to_step_id','person_id','role_id','child_process_id'];
--     -- The order the sections are written in.
--     sections constant text[] := array['settings','roles','people','person_roles','person_leave','lead_sources','seasonality','demand_settings','churn_drivers','market_conditions','market_schedule','lever_settings','analysis_rules','clients','sources','processes','scenarios','blocks','issues','steps','services','service_servicing','client_groups','client_services','client_assignments','person_skills','source_links','suggestions','proposals','archive','log'];
--     list_sections constant text[] := array['roles','people','person_roles','person_leave','lead_sources','seasonality','churn_drivers','market_conditions','market_schedule','clients','sources','processes','scenarios','blocks','issues','services','service_servicing','client_groups','client_services','client_assignments','person_skills','source_links','suggestions','proposals'];
--     one_sections constant text[] := array['settings','demand_settings','lever_settings','analysis_rules'];
--     placeholder constant text := '00000000-0000-4000-8000-';
--     placeholder_re constant text := '^00000000-0000-4000-8000-[0-9a-f]{12}$';
--     max_plan_chars constant integer := 19660800;
--   
--     pl jsonb;
--     txt text;
--     prefix text;
--     label text := left(nullif(btrim(coalesce(p_label, '')), ''), 300);
--     sec text;
--     col text;
--     tbl text;
--     rows jsonb;
--     node jsonb;
--     sc jsonb;
--     cols text;
--     sets text;
--     n integer;
--     total integer;
--     existing uuid;
--     skip_ids uuid[] := '{}';
--     skipped jsonb := '{}';
--     counts jsonb := '{}';
--     proc uuid;
--     rev uuid;
--     draft jsonb;
--     revs jsonb := '{}';
--     made jsonb := '[]';
--     arch uuid[] := '{}';
--     step_total integer := 0;
--     edge_total integer := 0;
--     settings_result text := 'none';
--     what text;
--     has_rows boolean;
--     bad integer;
--     chars bigint;
--   begin
--     -- 1. Who. Before the plan is read, so a refusal says nothing about it.
--     if coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id' then
--       raise exception 'Backups are restored in the app.' using errcode = '42501';
--     end if;
--     if p_workspace is null or not coalesce(public.can_edit_workspace(p_workspace), false) then
--       raise exception 'Only owners, editors and agency admins can restore a backup.' using errcode = '42501';
--     end if;
--   
--     -- 2. Shape and limits.
--     if p_plan is null or jsonb_typeof(p_plan) is distinct from 'object' or p_plan ->> 'format' is distinct from 'transpera-workspace-import/1' then
--       raise exception 'import_workspace_bundle: p_plan is not a transpera-workspace-import/1 plan' using errcode = '22023';
--     end if;
--     if char_length(p_plan::text) > max_plan_chars then
--       raise exception 'import_workspace_bundle: the plan is too big (at most 15 MB)' using errcode = '22023';
--     end if;
--     foreach sec in array list_sections loop
--       if jsonb_typeof(p_plan -> sec) is distinct from 'array' then
--         raise exception 'import_workspace_bundle: % must be a list', sec using errcode = '22023';
--       end if;
--       if exists (select 1 from jsonb_array_elements(p_plan -> sec) e where jsonb_typeof(e.value) is distinct from 'object') then
--         raise exception 'import_workspace_bundle: every row of % must be an object', sec using errcode = '22023';
--       end if;
--     end loop;
--     foreach sec in array one_sections loop
--       if p_plan -> sec is not null and jsonb_typeof(p_plan -> sec) not in ('object', 'null') then
--         raise exception 'import_workspace_bundle: % must be an object or null', sec using errcode = '22023';
--       end if;
--     end loop;
--     if exists (
--       select 1 from jsonb_array_elements(p_plan -> 'processes') p
--       where jsonb_typeof(p.value -> 'steps') is distinct from 'array' or jsonb_typeof(p.value -> 'edges') is distinct from 'array'
--         or exists (select 1 from jsonb_array_elements(p.value -> 'steps') e where jsonb_typeof(e.value) is distinct from 'object')
--         or exists (select 1 from jsonb_array_elements(p.value -> 'edges') e where jsonb_typeof(e.value) is distinct from 'object')
--         or (p.value -> 'first_principles' is not null and jsonb_typeof(p.value -> 'first_principles') not in ('object', 'null'))
--         or (p.value -> 'layout' is not null and jsonb_typeof(p.value -> 'layout') not in ('object', 'null'))
--     ) then
--       raise exception 'import_workspace_bundle: every process needs lists of steps and edges' using errcode = '22023';
--     end if;
--     select coalesce(sum(jsonb_array_length(p.value -> 'steps')), 0), coalesce(sum(jsonb_array_length(p.value -> 'edges')), 0)
--       into step_total, edge_total from jsonb_array_elements(p_plan -> 'processes') p;
--     select coalesce(sum(char_length(coalesce(s.value ->> 'body', ''))), 0) into chars from jsonb_array_elements(p_plan -> 'sources') s;
--     if jsonb_array_length(p_plan -> 'processes') > 150 or step_total > 1500 or edge_total > 3000
--       or jsonb_array_length(p_plan -> 'sources') > 600 or chars > 4500000
--       or jsonb_array_length(p_plan -> 'issues') > 900 or jsonb_array_length(p_plan -> 'people') > 1500
--       or jsonb_array_length(p_plan -> 'clients') > 3000 or jsonb_array_length(p_plan -> 'scenarios') > 900
--       or jsonb_array_length(p_plan -> 'blocks') > 900 or jsonb_array_length(p_plan -> 'suggestions') > 1500
--       or jsonb_array_length(p_plan -> 'proposals') > 900
--       or jsonb_array_length(p_plan -> 'person_roles') > 1200 or jsonb_array_length(p_plan -> 'person_skills') > 3000
--       or jsonb_array_length(p_plan -> 'client_assignments') > 1200 or jsonb_array_length(p_plan -> 'source_links') > 3000
--       or jsonb_array_length(p_plan -> 'client_services') > 3000 or jsonb_array_length(p_plan -> 'person_leave') > 1500
--       or jsonb_array_length(p_plan -> 'lead_sources') + jsonb_array_length(p_plan -> 'seasonality') + jsonb_array_length(p_plan -> 'churn_drivers')
--         + jsonb_array_length(p_plan -> 'market_conditions') + jsonb_array_length(p_plan -> 'market_schedule') + jsonb_array_length(p_plan -> 'services')
--         + jsonb_array_length(p_plan -> 'service_servicing') + jsonb_array_length(p_plan -> 'client_groups') > 1500 then
--       raise exception 'import_workspace_bundle: the plan is over a limit (150 processes, 1500 steps, 3000 edges, 600 sources of 4,500,000 characters, 900 issues, 1500 people, 3000 clients, 900 scenarios, 900 blocks, 1500 suggestions, 900 proposals, 1200 role assignments, 3000 skills, 1200 client assignments, 3000 source links, 3000 client services, 1500 leave entries, 1500 other company settings rows)' using errcode = '22023';
--     end if;
--     -- A scenario without an id would make the replacement of a skipped one (below) return null, and the restore would write nothing and say it worked.
--     if exists (select 1 from jsonb_array_elements(p_plan -> 'scenarios') s where jsonb_typeof(s.value -> 'id') is distinct from 'string') then
--       raise exception 'import_workspace_bundle: every scenario needs an id' using errcode = '22023';
--     end if;
--   
--     -- 3. Lock: one restore (or upload) at a time per workspace.
--     if not pg_try_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || p_workspace::text, 0)) then
--       raise exception 'A restore into this workspace is already running.' using errcode = '55P03', hint = 'busy';
--     end if;
--     perform pg_advisory_xact_lock(hashtextextended('import_new_process:' || p_workspace::text, 0));
--   
--     -- 4. Empty.
--     for tbl, col in
--       select t.a, t.b from (values
--         ('processes', 'not is_company'), ('roles', 'true'), ('people', 'true'), ('services', 'true'), ('client_groups', 'true'),
--         ('clients', 'true'), ('lead_sources', 'true'), ('churn_drivers', 'true'), ('market_schedule', 'true'), ('issues', 'true'),
--         ('sources', 'true'), ('blocks', 'true'), ('solutions', 'true'), ('suggestions', 'true'), ('suggestion_proposals', 'true'),
--         ('market_conditions', 'preset is null')
--       ) as t(a, b)
--     loop
--       execute format('select exists (select 1 from public.%I where workspace_id = $1 and %s)', tbl, col) into has_rows using p_workspace;
--       if has_rows then
--         what := replace(tbl, '_', ' ');
--         exit;
--       end if;
--     end loop;
--     if what is null and exists (
--       select 1 from public.scenarios s where s.workspace_id = p_workspace
--         and not exists (select 1 from private.scenario_library() l where l.name = s.name and l.patch = s.patch)
--     ) then
--       what := 'scenarios of its own';
--     end if;
--     if what is not null then
--       raise exception 'This workspace isn''t empty: it already has %. Backups restore only into a new, empty workspace.', what
--         using errcode = '23514', hint = 'not_empty';
--     end if;
--   
--     -- 5. Ids: every id and reference column of the plan holds a placeholder (or null) before anything is replaced.
--     foreach sec in array list_sections loop
--       if sec = 'processes' then continue; end if;
--       for col in
--         select c from (
--           select 'id' as c where allow -> sec ? 'id'
--           union all select split_part(r, '.', 2) from unnest(ref_cols) r where split_part(r, '.', 1) = sec
--         ) q
--       loop
--         select count(*) into bad from jsonb_array_elements(p_plan -> sec) r
--         where r.value -> col is not null and jsonb_typeof(r.value -> col) <> 'null'
--           and (jsonb_typeof(r.value -> col) <> 'string' or (r.value ->> col) !~ placeholder_re);
--         if bad > 0 then
--           raise exception 'import_workspace_bundle: % holds an id that is not a placeholder in %', col, sec using errcode = '22023';
--         end if;
--       end loop;
--     end loop;
--     select count(*) into bad from jsonb_array_elements(p_plan -> 'issues') i
--     where exists (
--         select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) x
--         where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
--       or exists (
--         select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) x
--         where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
--       or exists (
--         select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
--         where jsonb_typeof(l.value) <> 'object'
--           or (l.value ->> 'process_id') !~ placeholder_re
--           or (jsonb_typeof(l.value -> 'step_id') <> 'null' and l.value ->> 'step_id' is not null and (l.value ->> 'step_id') !~ placeholder_re));
--     if bad > 0 then
--       raise exception 'import_workspace_bundle: an issue link, owner or source holds an id that is not a placeholder' using errcode = '22023';
--     end if;
--     select count(*) into bad from jsonb_array_elements(p_plan -> 'processes') p
--     where (p.value ->> 'id') is null or (p.value ->> 'id') !~ placeholder_re
--       or (jsonb_typeof(p.value -> 'parent_process_id') <> 'null' and p.value ->> 'parent_process_id' is not null and (p.value ->> 'parent_process_id') !~ placeholder_re)
--       or exists (
--         select 1 from jsonb_array_elements(p.value -> 'steps') s, unnest(array['id'] || step_ref_cols) c
--         where s.value -> c is not null and jsonb_typeof(s.value -> c) <> 'null' and (jsonb_typeof(s.value -> c) <> 'string' or (s.value ->> c) !~ placeholder_re))
--       or exists (
--         select 1 from jsonb_array_elements(p.value -> 'edges') e, unnest(array['id', 'from_step_id', 'to_step_id']) c
--         where e.value -> c is not null and jsonb_typeof(e.value -> c) <> 'null' and (jsonb_typeof(e.value -> c) <> 'string' or (e.value ->> c) !~ placeholder_re));
--     if bad > 0 then
--       raise exception 'import_workspace_bundle: a process, step or edge holds an id that is not a placeholder' using errcode = '22023';
--     end if;
--   
--     -- The real ids: one random prefix per restore replaces the placeholder prefix.
--     loop
--       prefix := substr(md5(gen_random_uuid()::text), 1, 20);
--       exit when prefix <> '00000000000000000000';
--     end loop;
--     prefix := substr(prefix, 1, 8) || '-' || substr(prefix, 9, 4) || '-' || substr(prefix, 13, 4) || '-' || substr(prefix, 17, 4) || '-';
--     -- Two plain replacements (a regular expression took 13 times as long on a big plan): every placeholder gets the fresh
--     -- prefix, then rank 0 (the old workspace), now `<prefix>000000000000`, becomes the real workspace. The prefix is never
--     -- all zeros (the loop above), so no other id can take rank 0's place.
--     txt := replace(p_plan::text, placeholder, prefix);
--     txt := replace(txt, prefix || '000000000000', p_workspace::text);
--   
--     -- A scenario equal (name and patch) to one the workspace already has (the seeded library) is skipped: its children and the
--     -- issues that use it are re-pointed at the existing row.
--     for sc in select value from jsonb_array_elements((txt::jsonb) -> 'scenarios') loop
--       select s.id into existing from public.scenarios s
--       where s.workspace_id = p_workspace and s.name = sc ->> 'name' and s.patch = sc -> 'patch'
--       order by s.id limit 1;
--       if found then
--         txt := replace(txt, sc ->> 'id', existing::text);
--         skip_ids := skip_ids || existing;
--       end if;
--     end loop;
--     pl := txt::jsonb;
--     txt := null;
--     skipped := jsonb_build_object('scenarios', cardinality(skip_ids));
--   
--     -- 6. Write.
--     foreach sec in array sections loop
--       begin
--         n := 0;
--         if sec = 'settings' then
--           if jsonb_typeof(pl -> 'settings') = 'object' and pl -> 'settings' <> '{}'::jsonb then
--             if public.can_manage_workspace(p_workspace) then
--               update public.workspaces set settings = settings || (pl -> 'settings') where id = p_workspace;
--               settings_result := 'applied';
--             else
--               -- An editor can't write workspace-wide settings: one pending suggestion for an owner (the shape packages/mcp/src/suggesting.ts makes).
--               perform set_config('transpera.importing', 'on', true);
--               insert into public.suggestions (workspace_id, target_table, target_id, patch, evidence, note, import_source)
--               values (p_workspace, 'workspaces', null, jsonb_build_object('set', pl -> 'settings'), '[]'::jsonb, 'Workspace settings from a backup.', label);
--               perform set_config('transpera.importing', '', true);
--               settings_result := 'suggested';
--             end if;
--           end if;
--           continue;
--         end if;
--   
--         if sec in ('demand_settings', 'lever_settings', 'analysis_rules') then
--           -- One row per workspace: written over any row the workspace already has.
--           if jsonb_typeof(pl -> sec) = 'object' then
--             select string_agg(quote_ident(c), ', '), string_agg(format('%1$I = excluded.%1$I', c), ', ') into cols, sets
--             from jsonb_array_elements_text(allow -> sec) c where (pl -> sec) ? c;
--             if cols is not null then
--               execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_record(null::public.%1$I, $1) on conflict (workspace_id) do update set %3$s', sec, cols, sets)
--                 using pl -> sec, p_workspace;
--               n := 1;
--             end if;
--           end if;
--   
--         elsif sec = 'market_schedule' then
--           -- A row that points at one of the backup's presets points at this workspace's preset with the same key.
--           insert into public.market_schedule (workspace_id, id, condition_id, from_month, to_month, created_at)
--           select p_workspace, coalesce(x.id, gen_random_uuid()),
--             coalesce(x.condition_id, (select m.id from public.market_conditions m where m.workspace_id = p_workspace and m.preset = r.value ->> 'condition_preset')),
--             x.from_month, x.to_month, coalesce(x.created_at, now())
--           from jsonb_array_elements(pl -> 'market_schedule') with ordinality r(value, ord)
--           cross join lateral jsonb_populate_record(null::public.market_schedule, r.value) x
--           order by r.ord;
--           get diagnostics n = row_count;
--   
--         elsif sec = 'processes' then
--           -- Every process first (parents first, as the plan is ordered), each opened as a draft, so a holder step can point at any of them.
--           for node in select value from jsonb_array_elements(pl -> 'processes') loop
--             proc := (node ->> 'id')::uuid;
--             insert into public.processes (id, workspace_id, name, kind, entity_name, description, source, parent_process_id)
--             values (proc, p_workspace, node ->> 'name', node ->> 'kind', node ->> 'entity_name', node ->> 'description', 'import', (node ->> 'parent_process_id')::uuid);
--             draft := public.open_draft(proc);
--             if draft ->> 'status' is distinct from 'ok' then
--               raise exception 'could not open a draft of %', node ->> 'name' using errcode = '42501';
--             end if;
--             rev := (draft ->> 'revision_id')::uuid;
--             revs := revs || jsonb_build_object(proc::text, rev);
--             if jsonb_typeof(node -> 'layout') = 'object' then
--               update public.process_revisions set layout = node -> 'layout' where id = rev;
--             end if;
--             if coalesce((node ->> 'archived')::boolean, false) then
--               arch := arch || proc;
--             end if;
--             made := made || jsonb_build_object('id', proc, 'name', node ->> 'name', 'revision_id', rev, 'archived', coalesce((node ->> 'archived')::boolean, false));
--             n := n + 1;
--           end loop;
--   
--         elsif sec = 'scenarios' then
--           select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
--           from jsonb_array_elements(pl -> 'scenarios') with ordinality r(value, ord)
--           where not ((r.value ->> 'id')::uuid = any (skip_ids));
--           n := jsonb_array_length(rows);
--           if n > 0 then
--             select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
--             where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
--             execute format('insert into public.scenarios (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.scenarios, $1)', cols) using rows, p_workspace;
--           end if;
--   
--         elsif sec = 'issues' then
--           rows := pl -> 'issues';
--           n := jsonb_array_length(rows);
--           if n > 0 then
--             select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
--             where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
--             -- In plan order: the trigger numbers them 1, 2, 3 ... in the old order.
--             execute format('insert into public.issues (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.issues, $1)', cols) using rows, p_workspace;
--             -- `issue_seed_links` and `link_issue_source` may have added some already.
--             insert into public.issue_links (issue_id, workspace_id, process_id, step_id)
--             select (i.value ->> 'id')::uuid, p_workspace, (l.value ->> 'process_id')::uuid, (l.value ->> 'step_id')::uuid
--             from jsonb_array_elements(rows) i
--             cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
--             on conflict do nothing;
--             insert into public.issue_owners (issue_id, person_id, workspace_id)
--             select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
--             from jsonb_array_elements(rows) i
--             cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) o
--             on conflict do nothing;
--             insert into public.issue_sources (issue_id, source_id, workspace_id)
--             select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
--             from jsonb_array_elements(rows) i
--             cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) o
--             on conflict do nothing;
--           end if;
--   
--         elsif sec = 'steps' then
--           -- The steps and edges of each draft (an entry step is set once all the steps are in), then its first principles.
--           for node in select value from jsonb_array_elements(pl -> 'processes') loop
--             proc := (node ->> 'id')::uuid;
--             rev := (revs ->> proc::text)::uuid;
--             select coalesce(jsonb_agg(s.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'entry_step_id', null, 'created_by', auth.uid())), '[]'::jsonb)
--               into rows from jsonb_array_elements(node -> 'steps') s;
--             if jsonb_array_length(rows) > 0 then
--               select string_agg(quote_ident(k), ', ') into cols from (
--                 select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
--                 where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'steps') ? k
--               ) q;
--               execute format('insert into public.steps (%1$s) select %1$s from jsonb_populate_recordset(null::public.steps, $1)', cols) using rows;
--               update public.steps st set entry_step_id = (s.value ->> 'entry_step_id')::uuid
--               from jsonb_array_elements(node -> 'steps') s
--               where st.revision_id = rev and st.id = (s.value ->> 'id')::uuid and s.value ->> 'entry_step_id' is not null;
--               n := n + jsonb_array_length(rows);
--             end if;
--             select coalesce(jsonb_agg(e.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'created_by', auth.uid())), '[]'::jsonb)
--               into rows from jsonb_array_elements(node -> 'edges') e;
--             if jsonb_array_length(rows) > 0 then
--               select string_agg(quote_ident(k), ', ') into cols from (
--                 select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
--                 where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'edges') ? k
--               ) q;
--               execute format('insert into public.edges (%1$s) select %1$s from jsonb_populate_recordset(null::public.edges, $1)', cols) using rows;
--             end if;
--             if jsonb_typeof(node -> 'first_principles') = 'object' then
--               select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> 'first_principles') c where (node -> 'first_principles') ? c;
--               if cols is not null then
--                 execute format('insert into public.first_principles (workspace_id, process_id, revision_id, %1$s) select $2, $3, $4, %1$s from jsonb_populate_record(null::public.first_principles, $1)', cols)
--                   using node -> 'first_principles', p_workspace, proc, rev;
--               end if;
--             end if;
--           end loop;
--           counts := counts || jsonb_build_object('edges', edge_total);
--   
--         elsif sec = 'archive' then
--           if cardinality(arch) > 0 then
--             update public.processes set archived_at = now() where id = any (arch);
--             get diagnostics n = row_count;
--           end if;
--   
--         elsif sec = 'log' then
--           for node in select value from jsonb_array_elements(made) loop
--             perform public.log_process_import((node ->> 'id')::uuid, 'Restored from a workspace backup' || coalesce(' (' || label || ')', ''));
--             n := n + 1;
--           end loop;
--   
--         else
--           -- A flat section: one insert, the plan's order, only the columns of the allow-list that the rows carry.
--           tbl := case sec when 'proposals' then 'suggestion_proposals' else sec end;
--           rows := pl -> sec;
--           if sec = 'market_conditions' then
--             -- The presets are read-only and the workspace has them already: the plan carries custom conditions only, and no `preset`.
--             null;
--           elsif sec = 'source_links' then
--             -- A step link needs its step in the process's restored draft (the trigger refuses it otherwise).
--             select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
--             from jsonb_array_elements(rows) with ordinality r(value, ord)
--             where r.value ->> 'kind' is distinct from 'step' or exists (
--               select 1 from public.steps s where s.workspace_id = p_workspace and s.process_id = (r.value ->> 'process_id')::uuid and s.id = (r.value ->> 'step_id')::uuid);
--             skipped := skipped || jsonb_build_object('step_links', jsonb_array_length(pl -> sec) - jsonb_array_length(rows));
--           end if;
--           n := jsonb_array_length(rows);
--           if n > 0 then
--             -- A source link's id can't be given by a signed-in caller (the insert grant on the table is by column, and leaves `id`
--             -- and `created_at` out): the database makes it.
--             select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
--             where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c) and not (sec = 'source_links' and c = 'id');
--             if cols is null then
--               raise exception 'the rows have none of the columns a restore accepts' using errcode = '22023';
--             end if;
--             if sec in ('suggestions', 'proposals') then
--               perform set_config('transpera.importing', 'on', true);
--               execute format('insert into public.%1$I (workspace_id, %2$s, import_source) select $2, %2$s, $3 from jsonb_populate_recordset(null::public.%1$I, $1)', tbl, cols)
--                 using rows, p_workspace, label;
--               perform set_config('transpera.importing', '', true);
--             else
--               execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_recordset(null::public.%1$I, $1)%3$s', tbl, cols,
--                 case when sec = 'source_links' then ' on conflict do nothing' else '' end)
--                 using rows, p_workspace;
--             end if;
--           end if;
--         end if;
--         counts := counts || jsonb_build_object(sec, n);
--       exception when others then
--         raise exception 'import_workspace_bundle: % could not be restored: %', sec, sqlerrm using errcode = sqlstate, hint = 'section:' || sec;
--       end;
--     end loop;
--   
--     return jsonb_build_object('id_prefix', prefix, 'processes', made, 'counts', counts, 'skipped', skipped, 'settings', settings_result);
--   end;
--   $$;
--   
--   revoke all on function public.import_workspace_bundle(uuid, jsonb, text) from public, anon, authenticated;
--   grant execute on function public.import_workspace_bundle(uuid, jsonb, text) to authenticated;
--   delete from supabase_migrations.schema_migrations where version = '20261226000000';
--   commit;

create or replace function public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text default null) returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '40s'
as $$
declare
  -- The columns the restore accepts for each plan section: the same lists as IMPORT_COLUMNS (packages/db/src/workspace-import.ts).
  -- Everything else in a row is ignored; `workspace_id`, `created_by`, `updated_at` and every `*_by` are never read from the plan.
  -- #228: person_capacity_factors is in this list, in ref_cols, in sections and in list_sections.
  allow constant jsonb := '{"roles":["id","name","color","default_cost_rate","headcount","ongoing_hours_per_client_week","active","provenance","created_at"],"people":["id","name","active","capacity_hours_week","cost_rate","end_date","fte","notes","start_date","provenance","created_at"],"person_roles":["person_id","role_id","created_at"],"person_leave":["id","person_id","start_date","end_date","note","created_at"],"lead_sources":["id","name","conversion_to_qualified","volume_week","provenance","created_at"],"seasonality":["id","month","multiplier","provenance","created_at"],"demand_settings":["growth_monthly","provenance","created_at"],"churn_drivers":["id","name","description","driver","enabled","example","month","value","weight","provenance","created_at"],"market_conditions":["id","name","churn","conv","cycle","hire","leads","pay","price","created_at"],"market_schedule":["id","condition_id","from_month","to_month","created_at"],"lever_settings":["hidden","created_at"],"analysis_rules":["settings","created_at"],"clients":["id","name","active","health","mrr","notes","start_date","provenance","created_at"],"sources":["id","kind","title","body","recorded_at","speakers","created_at"],"processes":["id","parent_process_id","name","kind","entity_name","description"],"steps":["id","assumption","child_process_id","conflict","cost_override","current_wip","dropoff_benchmark","expected_wait_hours","entry_step_id","kind","lost_per_day_waiting","name","notes","outcome","parent_step_id","person_id","provenance","replaced_by","rework_rate","rework_to_step_id","role_id","sla_hours","target_cycle_hours","tool","wait_dist","wait_hours","wait_params","work_dist","work_hours","work_params","x","y"],"edges":["id","condition_tag","from_step_id","label","probability","to_step_id"],"first_principles":["deletes","improvements","job_done","job_progress","job_situation","job_who","measures","requirements","root_cause","statements","why_chain","why_problem"],"scenarios":["id","parent_scenario_id","name","description","patch","created_at"],"blocks":["id","name","description","type","steps","created_at"],"issues":["id","client_id","created_at","detected_key","evidence","evidence_metrics","evidence_sources","owner_person_id","person_id","process_id","resolution","resolution_note","resolved_how","role_id","scenario_id","severity","source","status","step_id","target_goal","target_measure","target_now","title","type"],"services":["id","name","active","churn_health_sensitivity","churn_monthly_base","entry_process_id","fallback_ongoing_load","margin","mix_share","path_tags","price","pricing_model","tenure_months","provenance","created_at"],"service_servicing":["id","process_id","service_id","recurrence","sla_hours","provenance","created_at"],"client_groups":["id","service_id","client_count","churn_monthly","fee","starting_health","stay_months","provenance","created_at"],"client_services":["client_id","service_id","start_date","created_at"],"client_assignments":["client_id","role_id","person_id","created_at"],"person_skills":["person_id","step_id","efficiency","provenance","created_at"],"person_capacity_factors":["person_id","step_id","factor","provenance"],"source_links":["id","insight_key","issue_id","kind","process_id","source_id","step_id"],"suggestions":["id","target_table","target_id","patch","evidence","note","created_at"],"proposals":["id","kind","title","detail","payload","evidence","note","issue_id","created_at"]}'::jsonb;
  -- The reference columns of the flat sections (IMPORT_REFS) and of steps (IMPORT_STEP_REFS). Every section that has an `id`
  -- column in `allow` is checked on `id` too.
  -- #228
  ref_cols constant text[] := array['person_roles.person_id','person_roles.role_id','person_leave.person_id','services.entry_process_id','service_servicing.service_id','service_servicing.process_id','client_groups.service_id','client_services.client_id','client_services.service_id','client_assignments.client_id','client_assignments.role_id','client_assignments.person_id','person_skills.person_id','person_skills.step_id','scenarios.parent_scenario_id','issues.client_id','issues.owner_person_id','issues.person_id','issues.process_id','issues.role_id','issues.scenario_id','issues.step_id','source_links.source_id','source_links.issue_id','source_links.process_id','source_links.step_id','proposals.issue_id','market_schedule.condition_id','suggestions.target_id','person_capacity_factors.person_id','person_capacity_factors.step_id'];
  step_ref_cols constant text[] := array['parent_step_id','entry_step_id','rework_to_step_id','person_id','role_id','child_process_id'];
  -- The order the sections are written in.
  -- #228
  sections constant text[] := array['settings','roles','people','person_roles','person_leave','lead_sources','seasonality','demand_settings','churn_drivers','market_conditions','market_schedule','lever_settings','analysis_rules','clients','sources','processes','scenarios','blocks','issues','steps','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links','suggestions','proposals','archive','log'];
  -- #228
  list_sections constant text[] := array['roles','people','person_roles','person_leave','lead_sources','seasonality','churn_drivers','market_conditions','market_schedule','clients','sources','processes','scenarios','blocks','issues','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links','suggestions','proposals'];
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
    raise exception 'Only owners, editors and agency admins can restore a backup.' using errcode = '42501';
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
    or jsonb_array_length(p_plan -> 'clients') > 3000 or jsonb_array_length(p_plan -> 'scenarios') > 900
    or jsonb_array_length(p_plan -> 'blocks') > 900 or jsonb_array_length(p_plan -> 'suggestions') > 1500
    or jsonb_array_length(p_plan -> 'proposals') > 900
    or jsonb_array_length(p_plan -> 'person_roles') > 1200 or jsonb_array_length(p_plan -> 'person_skills') > 3000
    or jsonb_array_length(p_plan -> 'client_assignments') > 1200 or jsonb_array_length(p_plan -> 'source_links') > 3000
    or jsonb_array_length(p_plan -> 'client_services') > 3000 or jsonb_array_length(p_plan -> 'person_leave') > 1500
    -- #228
    or jsonb_array_length(p_plan -> 'person_capacity_factors') > 3000
    or jsonb_array_length(p_plan -> 'lead_sources') + jsonb_array_length(p_plan -> 'seasonality') + jsonb_array_length(p_plan -> 'churn_drivers')
      + jsonb_array_length(p_plan -> 'market_conditions') + jsonb_array_length(p_plan -> 'market_schedule') + jsonb_array_length(p_plan -> 'services')
      + jsonb_array_length(p_plan -> 'service_servicing') + jsonb_array_length(p_plan -> 'client_groups') > 1500 then
    -- #228
    raise exception 'import_workspace_bundle: the plan is over a limit (150 processes, 1500 steps, 3000 edges, 600 sources of 4,500,000 characters, 900 issues, 1500 people, 3000 clients, 900 scenarios, 900 blocks, 1500 suggestions, 900 proposals, 1200 role assignments, 3000 skills, 1200 client assignments, 3000 source links, 3000 client services, 1500 leave entries, 1500 other company settings rows, 3000 per-person times)' using errcode = '22023';
  end if;
  -- A scenario without an id would make the replacement of a skipped one (below) return null, and the restore would write nothing and say it worked.
  if exists (select 1 from jsonb_array_elements(p_plan -> 'scenarios') s where jsonb_typeof(s.value -> 'id') is distinct from 'string') then
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
