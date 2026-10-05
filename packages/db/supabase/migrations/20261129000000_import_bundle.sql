-- B14 (1/2, issue #167): upload a `transpera-process/2` file in one transaction, and mark the values an upload had to leave out.
--
-- 1. `public.import_process_bundle(p_workspace, p_nodes, p_adopt, p_extras)`: SECURITY INVOKER (RLS decides, as for every other
--    write the app makes as the signed-in user). It is `import_new_process` (20261128000000, which it calls) plus everything a
--    /2 file carries, so a failed upload leaves nothing behind (no half-made process, no orphan sources, no stray suggestions).
--    `p_nodes` and `p_adopt` are exactly what `import_new_process` takes. `p_extras` is a jsonb object, all keys optional:
--      * `sources`: [{id, kind, title, speakers[], recorded_at, body}], at most 50. The ids are chosen by the caller (the steps'
--        evidence cites them) and written FIRST, so the step rows that cite them are linked to them as they are inserted (the
--        `link_cited_sources` trigger of 20261124500000). Each is then linked to the new process (`source_links`, kind process),
--        so none shows "Not linked to anything yet".
--      * `first_principles`: the columns of `first_principles` (job_who ... measures), written to the new process's draft.
--      * `suggestions`: [{target_table, target_id, patch, evidence, note}], at most 300: company-model changes, written as
--        PENDING `suggestions` (the review path of 20261015000000 is the only way to apply one).
--      * `proposals`: [{kind, title, detail, payload, evidence, note, issue_id}], at most 50: proposed issues and solution
--        ideas, written as PENDING `suggestion_proposals` (20261124000000; accepting one goes through `review_proposals`).
--    Nothing company-level is applied: the function writes no role, person, client, service, setting or issue. Every table's
--    own checks, triggers and row-level security run as the caller, so a viewer or a stranger is refused whole.
--    Returns `{processes: [{process_id, revision_id, number}], sources, suggestions, proposals, first_principles}`.
--
-- 2. `private.clear_branch_odds()` and the trigger `clear_branch_odds` on `public.edges` (after update of probability): an upload
--    marks a step whose branches had no odds given (`steps.provenance.branch_odds.defaulted`), so "Missing for simulation" can
--    list it (packages/db/src/simulation-gaps.ts). The marker is taken off the step the moment anyone writes one of its branches'
--    probabilities, so the warning clears once the odds are filled in. The marker is a new key inside the existing `provenance`
--    jsonb: no column changes, nothing that reads provenance looks at keys it does not know, and publishing is not blocked by it.
--
-- STRICTLY ADDITIVE: two functions and one trigger. No table or column is changed.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   1. Neither function nor the trigger exists. Expect 0, 0, 0:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_process_bundle';
--        select count(*) from pg_proc where pronamespace = 'private'::regnamespace and proname = 'clear_branch_odds';
--        select count(*) from pg_trigger where tgname = 'clear_branch_odds' and not tgisinternal;
--   2. Nothing of ours is applied past this one (row 44, #177, 20261128500000, is applied and is independent). Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261129000000' and version < '20261140000000';
--   3. The import it calls and the tables it writes exist. Expect 1, then 6:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_new_process';
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('sources', 'source_links', 'first_principles', 'suggestions', 'suggestion_proposals', 'edges');
--   4. The atomic import migration (row 43) is applied. Expect 1:
--        select count(*) from supabase_migrations.schema_migrations where version = '20261128000000';
--
-- Post-apply grant check (authenticated may execute the import; anon and PUBLIC may not; the trigger function is private):
--        select routine_name, grantee, privilege_type from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'import_process_bundle' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 2;
--        select proname, proacl from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_process_bundle';
--        select tgname, tgenabled from pg_trigger where tgname = 'clear_branch_odds' and not tgisinternal;
--   Expect: one row, authenticated EXECUTE; the ACL has an `authenticated=X/...` entry and no `anon=` and no `=X/...` (an entry
--   with an empty grantee is PUBLIC); the trigger enabled ('O').
--
-- Rollback (run as one transaction; nothing existing was changed):
--
--   begin;
--   drop trigger if exists clear_branch_odds on public.edges;
--   drop function if exists private.clear_branch_odds();
--   drop function if exists public.import_process_bundle(uuid, jsonb, jsonb, jsonb);
--   delete from supabase_migrations.schema_migrations where version = '20261129000000';
--   commit;
--
-- Roll the app back (or redeploy the previous one) first: it calls the function. Processes, sources, suggestions and proposals
-- already uploaded stay as they are. A `branch_odds` key left in a step's provenance is ignored by everything.
--
-- Production data: none needed.

-- ---------------------------------------------------------------------------
-- The all-or-nothing /2 upload
-- ---------------------------------------------------------------------------

create function public.import_process_bundle(p_workspace uuid, p_nodes jsonb, p_adopt jsonb default '[]', p_extras jsonb default '{}') returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  extras jsonb := coalesce(p_extras, '{}');
  srcs jsonb;
  fp jsonb;
  sugg jsonb;
  props jsonb;
  top uuid;
  made jsonb;
  rev uuid;
  n_sources integer;
  n_suggestions integer;
  n_proposals integer;
  wrote_fp boolean := false;
begin
  if p_workspace is null or jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes) < 1 then
    raise exception 'import_process_bundle: p_nodes must be an array of processes' using errcode = '22023';
  end if;
  if jsonb_typeof(extras) is distinct from 'object' then
    raise exception 'import_process_bundle: p_extras must be an object' using errcode = '22023';
  end if;
  srcs := coalesce(extras -> 'sources', '[]');
  sugg := coalesce(extras -> 'suggestions', '[]');
  props := coalesce(extras -> 'proposals', '[]');
  fp := extras -> 'first_principles';
  if jsonb_typeof(srcs) is distinct from 'array' or jsonb_typeof(sugg) is distinct from 'array' or jsonb_typeof(props) is distinct from 'array'
    or (fp is not null and jsonb_typeof(fp) not in ('object', 'null')) then
    raise exception 'import_process_bundle: sources, suggestions and proposals must be arrays and first_principles an object' using errcode = '22023';
  end if;
  n_sources := jsonb_array_length(srcs);
  n_suggestions := jsonb_array_length(sugg);
  n_proposals := jsonb_array_length(props);
  if n_sources > 50 or n_suggestions > 300 or n_proposals > 50 then
    raise exception 'import_process_bundle: at most 50 sources, 300 suggestions and 50 proposals in one import' using errcode = '22023';
  end if;
  top := (p_nodes -> 0 ->> 'id')::uuid;

  -- Sources first: the steps that cite them are linked to them as they are written.
  insert into public.sources (id, workspace_id, kind, title, speakers, recorded_at, body)
  select (s ->> 'id')::uuid, p_workspace, coalesce(s ->> 'kind', 'transcript'), s ->> 'title',
    coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(s -> 'speakers') = 'array' then s -> 'speakers' else '[]'::jsonb end)), '{}'),
    nullif(s ->> 'recorded_at', '')::date, nullif(s ->> 'body', '')
  from jsonb_array_elements(srcs) s;

  -- The process, its draft, its steps and edges (and any child processes), as the atomic import writes them.
  made := public.import_new_process(p_workspace, p_nodes, p_adopt);
  rev := (made -> 0 ->> 'revision_id')::uuid;

  -- Every source of the file is evidence for the process it came with.
  insert into public.source_links (workspace_id, source_id, kind, process_id)
  select p_workspace, (s ->> 'id')::uuid, 'process', top from jsonb_array_elements(srcs) s
  on conflict do nothing;

  if fp is not null and jsonb_typeof(fp) = 'object' then
    insert into public.first_principles (workspace_id, process_id, revision_id, job_who, job_progress, job_situation, job_done, statements, requirements, deletes, improvements, why_problem, why_chain, root_cause, measures)
    -- A key the caller leaves out is the column's default (jsonb_populate_record gives null, which the columns refuse).
    select p_workspace, top, rev, coalesce(r.job_who, ''), coalesce(r.job_progress, ''), coalesce(r.job_situation, ''), coalesce(r.job_done, ''),
      coalesce(r.statements, '[]'::jsonb), coalesce(r.requirements, '[]'::jsonb), coalesce(r.deletes, '[]'::jsonb), coalesce(r.improvements, '[]'::jsonb),
      coalesce(r.why_problem, ''), coalesce(r.why_chain, '[]'::jsonb), coalesce(r.root_cause, ''), coalesce(r.measures, '[]'::jsonb)
    from jsonb_populate_record(null::public.first_principles, fp) r;
    wrote_fp := true;
  end if;

  -- Company facts wait as suggestions; the review path is the only way to apply one.
  insert into public.suggestions (workspace_id, target_table, target_id, patch, evidence, note)
  select p_workspace, x.target_table, x.target_id, x.patch, coalesce(x.evidence, '[]'::jsonb), x.note
  from jsonb_to_recordset(sugg) as x(target_table text, target_id uuid, patch jsonb, evidence jsonb, note text);

  -- Issues and ideas wait as proposals.
  insert into public.suggestion_proposals (workspace_id, kind, title, detail, payload, evidence, note, issue_id)
  select p_workspace, x.kind, x.title, x.detail, coalesce(x.payload, '{}'::jsonb), coalesce(x.evidence, '[]'::jsonb), x.note, x.issue_id
  from jsonb_to_recordset(props) as x(kind text, title text, detail text, payload jsonb, evidence jsonb, note text, issue_id uuid);

  return jsonb_build_object('processes', made, 'sources', n_sources, 'suggestions', n_suggestions, 'proposals', n_proposals, 'first_principles', wrote_fp);
end;
$$;

revoke all on function public.import_process_bundle(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_process_bundle(uuid, jsonb, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- A step's missing branch odds clear when anyone writes them
-- ---------------------------------------------------------------------------

create function private.clear_branch_odds() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Runs as the caller, who is editing the draft the step is in (the drafts-only guard on steps still applies).
  update public.steps s set provenance = s.provenance - 'branch_odds'
  where s.revision_id = new.revision_id and s.id = new.from_step_id and s.provenance ? 'branch_odds';
  return null;
end;
$$;

revoke all on function private.clear_branch_odds() from public, anon, authenticated;

create trigger clear_branch_odds after update of probability on public.edges
  for each row execute function private.clear_branch_odds();
