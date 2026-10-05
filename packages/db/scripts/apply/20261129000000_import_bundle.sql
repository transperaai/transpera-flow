-- Production apply file for 20261129000000_import_bundle (B14 1/2, issue #167). Two functions and one trigger; needs
-- `import_new_process` (20261128000000, row 43) and the tables sources, source_links, first_principles, suggestions,
-- suggestion_proposals and edges (earlier migrations). Run the preflight in the migration's header first (expect 0, 0, 0; 0 rows;
-- 1, 6; 1). Row 44 (#177) is independent of this one.
--
-- Post-apply grant check: see the migration's header (authenticated EXECUTE on import_process_bundle; anon and PUBLIC nothing;
-- the clear_branch_odds trigger enabled on public.edges).

begin;
set local lock_timeout = '5s';

-- B14 (1/2, issue #167): upload a `transpera-process/2` file in one transaction, and mark the values an upload had to leave out.
--
-- 1. `public.import_process_bundle(p_workspace, p_nodes, p_adopt, p_extras)`: SECURITY INVOKER (RLS decides, as for every other
--    write the app makes as the signed-in user). It is `import_new_process` (20261128000000, which it calls) plus everything a
--    /2 file carries, so a failed upload leaves nothing behind (no half-made process, no orphan sources, no stray suggestions).
--    `p_nodes` and `p_adopt` are exactly what `import_new_process` takes. `p_extras` is a jsonb object, all keys optional:
--      * `sources`: [{ref, kind, title, speakers[], recorded_at, body}], at most 50, bodies at most 2,000,000 characters in all.
--        The database makes each source's id: `ref` is a placeholder uuid the caller put in the steps', suggestions' and
--        proposals' evidence, and it is replaced by the new id wherever it appears (the caller never chooses an id, so a
--        refused insert can't say whether some id exists). Sources are written FIRST, so the step rows that cite them are linked
--        to them as they are inserted (the
--        `link_cited_sources` trigger of 20261124500000). Each is then linked to the new process (`source_links`, kind process),
--        so none shows "Not linked to anything yet".
--      * `first_principles`: the columns of `first_principles` (job_who ... measures), written to the new process's draft.
--      * `import_source`: the file name or link, shown in the review queue as "Upload (<name>)".
--      * `suggestions`: [{target_table, target_id, patch, evidence, note}], at most 300: company-model changes, written as
--        PENDING `suggestions` (created_via `upload`; the review path of 20261015000000 is the only way to apply one).
--      * `proposals`: [{kind, title, detail, payload, evidence, note, issue_id}], at most 50: proposed issues and solution
--        ideas, written as PENDING `suggestion_proposals` (20261124000000; accepting one goes through `review_proposals`).
--    Nothing company-level is applied: the function writes no role, person, client, service, setting or issue. Every table's
--    own checks, triggers and row-level security run as the caller, so a viewer or a stranger is refused whole.
--    Returns `{processes: [{process_id, revision_id, number}], sources, suggestions, proposals, first_principles}`.
--
-- 2. `private.clear_branch_odds()` and the trigger `clear_branch_odds` on `public.edges` (after insert, update of probability,
--    delete): an upload marks a step whose branches had no odds given (`steps.provenance.branch_odds`, with the probabilities it
--    defaulted to), so "Missing for simulation" can list it (packages/db/src/simulation-gaps.ts). The marker is taken off when
--    the step's branch set changes, or when at most one of its branches still has its defaulted probability (the last can be
--    inferred), so the warning clears once the odds are filled in. It only ever touches a DRAFT, and never a step created in
--    the same transaction (the import's own edge inserts).
--
-- 3. Where an upload's suggestions and proposals came from: `created_via` also allows `upload` (check constraints widened;
--    existing rows all pass), a nullable `import_source` text column on `suggestions` and `suggestion_proposals`, and
--    `private.suggestion_proposals_before_write` (and `private.suggestions_before_write`, copies of the earlier definitions) records `upload` (and keeps
--    `import_source`) only while `transpera.importing` is on, which only `import_process_bundle` sets, and never lets it change. The marker is a new key inside the existing `provenance`
--    jsonb: no column changes, nothing that reads provenance looks at keys it does not know, and publishing is not blocked by it.
--
-- STRICTLY ADDITIVE: functions, one trigger, two nullable columns, two widened checks.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   1. Neither function nor the trigger exists, and the columns don't. Expect 0, 0, 0, 0:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_process_bundle';
--        select count(*) from pg_proc where pronamespace = 'private'::regnamespace and proname = 'clear_branch_odds';
--        select count(*) from pg_trigger where tgname = 'clear_branch_odds' and not tgisinternal;
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('suggestions', 'suggestion_proposals') and column_name = 'import_source';
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
--   -- first `create or replace` private.suggestion_proposals_before_write() (text from 20261124000000_suggestions_v2.sql) and private.suggestions_before_write() (20261015000000_suggestions.sql) (the column drop below needs them gone)
--   delete from public.suggestions where created_via = 'upload';
--   delete from public.suggestion_proposals where created_via = 'upload';
--   alter table public.suggestions drop column import_source, drop constraint suggestions_created_via, add constraint suggestions_created_via check (created_via in ('mcp'));
--   alter table public.suggestion_proposals drop column import_source, drop constraint suggestion_proposals_created_via, add constraint suggestion_proposals_created_via check (created_via in ('mcp', 'play_link'));
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
-- Where an upload's suggestions and proposals came from
-- ---------------------------------------------------------------------------

alter table public.suggestions add column import_source text constraint suggestions_import_source check (char_length(import_source) <= 300);
alter table public.suggestion_proposals add column import_source text constraint suggestion_proposals_import_source check (char_length(import_source) <= 300);

alter table public.suggestions drop constraint suggestions_created_via,
  add constraint suggestions_created_via check (created_via in ('mcp', 'upload')) not valid;
alter table public.suggestions validate constraint suggestions_created_via;
alter table public.suggestion_proposals drop constraint suggestion_proposals_created_via,
  add constraint suggestion_proposals_created_via check (created_via in ('mcp', 'play_link', 'upload')) not valid;
alter table public.suggestion_proposals validate constraint suggestion_proposals_created_via;

-- SELECT on proposals is granted column by column (a visitor's email is left out): the new column is shown to everyone who can read.
grant select (import_source) on public.suggestion_proposals to authenticated;

create or replace function private.suggestion_proposals_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.applied := null;
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.created_by := auth.uid();
    -- A signed-in request (the app, or the MCP server with a token) can't pass as a visitor.
    if auth.uid() is not null then
      -- An upload (public.import_process_bundle) says so for the duration of its own statement; anything else is MCP.
      new.created_via := case when coalesce(current_setting('transpera.importing', true), '') = 'on' then 'upload' else 'mcp' end;
      new.proposer_name := null;
      new.proposer_email := null;
      if new.created_via <> 'upload' then new.import_source := null; end if;
    end if;
    return new;
  end if;
  -- Deleting a user sets `created_by` or `reviewed_by` to null through the foreign key's own trigger (depth 2 here).
  -- That, and nothing else, is let through.
  if pg_catalog.pg_trigger_depth() > 1
    and (to_jsonb(new) - 'created_by' - 'reviewed_by' - 'updated_at') = (to_jsonb(old) - 'created_by' - 'reviewed_by' - 'updated_at')
    and (new.created_by is null or new.created_by is not distinct from old.created_by)
    and (new.reviewed_by is null or new.reviewed_by is not distinct from old.reviewed_by) then
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id or new.kind is distinct from old.kind
    or new.title is distinct from old.title or new.detail is distinct from old.detail
    or new.payload is distinct from old.payload or new.evidence is distinct from old.evidence
    or new.note is distinct from old.note or new.issue_id is distinct from old.issue_id
    or new.created_via is distinct from old.created_via or new.import_source is distinct from old.import_source or new.proposer_name is distinct from old.proposer_name
    or new.proposer_email is distinct from old.proposer_email or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'A proposal can''t be changed, only accepted, rejected or dismissed' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.applied is distinct from old.applied
    or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
    or new.review_note is distinct from old.review_note then
    if old.status <> 'pending' or coalesce(current_setting('transpera.reviewing_proposals', true), '') <> 'on' then
      raise exception 'Proposals are decided with review_proposals' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;


-- The same rule for suggestions as for proposals: only the import path can record an upload, and where it came from never changes.
create or replace function private.suggestions_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.applied := null;
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.created_by := auth.uid();
    -- Only an upload (public.import_process_bundle, which turns `transpera.importing` on for its own statement) can say so.
    new.created_via := case when coalesce(current_setting('transpera.importing', true), '') = 'on' then 'upload' else 'mcp' end;
    if new.created_via <> 'upload' then new.import_source := null; end if;
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id or new.target_table is distinct from old.target_table
    or new.target_id is distinct from old.target_id or new.patch is distinct from old.patch
    or new.evidence is distinct from old.evidence or new.note is distinct from old.note
    or new.created_via is distinct from old.created_via or new.import_source is distinct from old.import_source or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'A suggestion can''t be changed, only accepted or rejected' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.applied is distinct from old.applied
    or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
    or new.review_note is distinct from old.review_note then
    if old.status <> 'pending' or coalesce(current_setting('transpera.reviewing', true), '') <> 'on' then
      raise exception 'Suggestions are accepted or rejected with review_suggestions' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- The all-or-nothing /2 upload
-- ---------------------------------------------------------------------------

create function public.import_process_bundle(p_workspace uuid, p_nodes jsonb, p_adopt jsonb default '[]', p_extras jsonb default '{}') returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  extras jsonb := coalesce(nullif(p_extras, 'null'::jsonb), '{}');
  srcs jsonb;
  fp jsonb;
  sugg jsonb;
  props jsonb;
  s jsonb;
  top uuid;
  made jsonb;
  rev uuid;
  fresh uuid;
  ref uuid;
  fresh_ids uuid[] := '{}';
  nodes_txt text;
  sugg_txt text;
  props_txt text;
  label text;
  n_sources integer;
  n_suggestions integer;
  n_proposals integer;
  body_chars bigint;
  wrote_fp boolean := false;
begin
  if p_workspace is null or jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes) < 1 then
    raise exception 'import_process_bundle: p_nodes must be an array of processes' using errcode = '22023';
  end if;
  if jsonb_typeof(extras) is distinct from 'object' then
    raise exception 'import_process_bundle: p_extras must be an object' using errcode = '22023';
  end if;
  -- A section that is JSON null is a section that is left out.
  srcs := coalesce(nullif(extras -> 'sources', 'null'::jsonb), '[]');
  sugg := coalesce(nullif(extras -> 'suggestions', 'null'::jsonb), '[]');
  props := coalesce(nullif(extras -> 'proposals', 'null'::jsonb), '[]');
  fp := nullif(extras -> 'first_principles', 'null'::jsonb);
  if jsonb_typeof(srcs) is distinct from 'array' or jsonb_typeof(sugg) is distinct from 'array' or jsonb_typeof(props) is distinct from 'array'
    or (fp is not null and jsonb_typeof(fp) is distinct from 'object') then
    raise exception 'import_process_bundle: sources, suggestions and proposals must be arrays and first_principles an object' using errcode = '22023';
  end if;
  n_sources := jsonb_array_length(srcs);
  n_suggestions := jsonb_array_length(sugg);
  n_proposals := jsonb_array_length(props);
  if n_sources > 50 or n_suggestions > 300 or n_proposals > 50 then
    raise exception 'import_process_bundle: at most 50 sources, 300 suggestions and 50 proposals in one import' using errcode = '22023';
  end if;
  select coalesce(sum(char_length(coalesce(x ->> 'body', ''))), 0) into body_chars from jsonb_array_elements(srcs) x;
  if body_chars > 2000000 then
    raise exception 'The sources'' text is too long: % characters in all, and one upload takes at most 2,000,000. Leave the text out of the longest sources.', body_chars using errcode = '22023';
  end if;
  label := left(nullif(extras ->> 'import_source', ''), 300);
  top := (p_nodes -> 0 ->> 'id')::uuid;
  nodes_txt := p_nodes::text;
  sugg_txt := sugg::text;
  props_txt := props::text;

  -- Sources first: the steps that cite them are linked to them as they are written. Each gets an id made here; the file's
  -- placeholder (`ref`) is replaced by it wherever the file cites the source.
  for s in select value from jsonb_array_elements(srcs) loop
    ref := (s ->> 'ref')::uuid;
    fresh := gen_random_uuid();
    insert into public.sources (id, workspace_id, kind, title, speakers, recorded_at, body)
    values (fresh, p_workspace, coalesce(s ->> 'kind', 'transcript'), s ->> 'title',
      coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(s -> 'speakers') = 'array' then s -> 'speakers' else '[]'::jsonb end)), '{}'),
      nullif(s ->> 'recorded_at', '')::date, nullif(s ->> 'body', ''));
    fresh_ids := fresh_ids || fresh;
    nodes_txt := replace(nodes_txt, ref::text, fresh::text);
    sugg_txt := replace(sugg_txt, ref::text, fresh::text);
    props_txt := replace(props_txt, ref::text, fresh::text);
  end loop;

  -- The process, its draft, its steps and edges (and any child processes), as the atomic import writes them.
  made := public.import_new_process(p_workspace, nodes_txt::jsonb, p_adopt);
  rev := (made -> 0 ->> 'revision_id')::uuid;

  -- Every source of the file is evidence for the process it came with.
  insert into public.source_links (workspace_id, source_id, kind, process_id)
  select p_workspace, f, 'process', top from unnest(fresh_ids) f
  on conflict do nothing;

  if fp is not null then
    -- A key the caller leaves out is the column's default (jsonb_populate_record gives null, which the columns refuse).
    insert into public.first_principles (workspace_id, process_id, revision_id, job_who, job_progress, job_situation, job_done, statements, requirements, deletes, improvements, why_problem, why_chain, root_cause, measures)
    select p_workspace, top, rev, coalesce(r.job_who, ''), coalesce(r.job_progress, ''), coalesce(r.job_situation, ''), coalesce(r.job_done, ''),
      coalesce(r.statements, '[]'::jsonb), coalesce(r.requirements, '[]'::jsonb), coalesce(r.deletes, '[]'::jsonb), coalesce(r.improvements, '[]'::jsonb),
      coalesce(r.why_problem, ''), coalesce(r.why_chain, '[]'::jsonb), coalesce(r.root_cause, ''), coalesce(r.measures, '[]'::jsonb)
    from jsonb_populate_record(null::public.first_principles, fp) r;
    wrote_fp := true;
  end if;

  -- Company facts wait as suggestions; the review path is the only way to apply one. The triggers record them as uploads while
  -- `transpera.importing` is on (set here, nowhere else), and it is off again after the proposals.
  perform set_config('transpera.importing', 'on', true);
  insert into public.suggestions (workspace_id, target_table, target_id, patch, evidence, note, created_via, import_source)
  select p_workspace, x.target_table, x.target_id, x.patch, coalesce(x.evidence, '[]'::jsonb), x.note, 'upload', label
  from jsonb_to_recordset(sugg_txt::jsonb) as x(target_table text, target_id uuid, patch jsonb, evidence jsonb, note text);

  -- Issues and ideas wait as proposals.
  insert into public.suggestion_proposals (workspace_id, kind, title, detail, payload, evidence, note, issue_id, import_source)
  select p_workspace, x.kind, x.title, x.detail, coalesce(x.payload, '{}'::jsonb), coalesce(x.evidence, '[]'::jsonb), x.note, x.issue_id, label
  from jsonb_to_recordset(props_txt::jsonb) as x(kind text, title text, detail text, payload jsonb, evidence jsonb, note text, issue_id uuid);
  perform set_config('transpera.importing', '', true);

  return jsonb_build_object('processes', made, 'sources', n_sources, 'suggestions', n_suggestions, 'proposals', n_proposals, 'first_principles', wrote_fp);
end;
$$;

revoke all on function public.import_process_bundle(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_process_bundle(uuid, jsonb, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- A step's missing branch odds clear when its branches are filled in
-- ---------------------------------------------------------------------------

create function private.clear_branch_odds() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rev uuid := case when tg_op = 'DELETE' then old.revision_id else new.revision_id end;
  from_step uuid := case when tg_op = 'DELETE' then old.from_step_id else new.from_step_id end;
  marker jsonb;
  untouched integer;
begin
  -- History is never touched: only a draft's step is looked at.
  if not exists (select 1 from public.process_revisions r where r.id = rev and r.status = 'draft') then
    return null;
  end if;
  -- A step made in this very transaction is the import (or a copy of a version) still writing its edges.
  select s.provenance -> 'branch_odds' into marker from public.steps s
  where s.revision_id = rev and s.id = from_step and s.created_at < now();
  if marker is null then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    -- Branches that still have the probability the upload gave them by default: with one or none left, the last is inferred.
    select count(*) into untouched from public.edges e
    where e.revision_id = rev and e.from_step_id = from_step
      and (marker -> 'was' ->> e.to_step_id::text) is not null
      and (marker -> 'was' ->> e.to_step_id::text)::numeric = e.probability;
    if untouched > 1 then
      return null;
    end if;
  end if;
  -- Runs as the caller, who is editing the draft the step is in (the drafts-only guard on steps still applies).
  update public.steps s set provenance = s.provenance - 'branch_odds'
  where s.revision_id = rev and s.id = from_step;
  return null;
end;
$$;

revoke all on function private.clear_branch_odds() from public, anon, authenticated;

create trigger clear_branch_odds after insert or delete or update of probability on public.edges
  for each row execute function private.clear_branch_odds();

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261129000000', 'import_bundle', array[$mig$-- B14 (1/2, issue #167): upload a `transpera-process/2` file in one transaction, and mark the values an upload had to leave out.
--
-- 1. `public.import_process_bundle(p_workspace, p_nodes, p_adopt, p_extras)`: SECURITY INVOKER (RLS decides, as for every other
--    write the app makes as the signed-in user). It is `import_new_process` (20261128000000, which it calls) plus everything a
--    /2 file carries, so a failed upload leaves nothing behind (no half-made process, no orphan sources, no stray suggestions).
--    `p_nodes` and `p_adopt` are exactly what `import_new_process` takes. `p_extras` is a jsonb object, all keys optional:
--      * `sources`: [{ref, kind, title, speakers[], recorded_at, body}], at most 50, bodies at most 2,000,000 characters in all.
--        The database makes each source's id: `ref` is a placeholder uuid the caller put in the steps', suggestions' and
--        proposals' evidence, and it is replaced by the new id wherever it appears (the caller never chooses an id, so a
--        refused insert can't say whether some id exists). Sources are written FIRST, so the step rows that cite them are linked
--        to them as they are inserted (the
--        `link_cited_sources` trigger of 20261124500000). Each is then linked to the new process (`source_links`, kind process),
--        so none shows "Not linked to anything yet".
--      * `first_principles`: the columns of `first_principles` (job_who ... measures), written to the new process's draft.
--      * `import_source`: the file name or link, shown in the review queue as "Upload (<name>)".
--      * `suggestions`: [{target_table, target_id, patch, evidence, note}], at most 300: company-model changes, written as
--        PENDING `suggestions` (created_via `upload`; the review path of 20261015000000 is the only way to apply one).
--      * `proposals`: [{kind, title, detail, payload, evidence, note, issue_id}], at most 50: proposed issues and solution
--        ideas, written as PENDING `suggestion_proposals` (20261124000000; accepting one goes through `review_proposals`).
--    Nothing company-level is applied: the function writes no role, person, client, service, setting or issue. Every table's
--    own checks, triggers and row-level security run as the caller, so a viewer or a stranger is refused whole.
--    Returns `{processes: [{process_id, revision_id, number}], sources, suggestions, proposals, first_principles}`.
--
-- 2. `private.clear_branch_odds()` and the trigger `clear_branch_odds` on `public.edges` (after insert, update of probability,
--    delete): an upload marks a step whose branches had no odds given (`steps.provenance.branch_odds`, with the probabilities it
--    defaulted to), so "Missing for simulation" can list it (packages/db/src/simulation-gaps.ts). The marker is taken off when
--    the step's branch set changes, or when at most one of its branches still has its defaulted probability (the last can be
--    inferred), so the warning clears once the odds are filled in. It only ever touches a DRAFT, and never a step created in
--    the same transaction (the import's own edge inserts).
--
-- 3. Where an upload's suggestions and proposals came from: `created_via` also allows `upload` (check constraints widened;
--    existing rows all pass), a nullable `import_source` text column on `suggestions` and `suggestion_proposals`, and
--    `private.suggestion_proposals_before_write` (and `private.suggestions_before_write`, copies of the earlier definitions) records `upload` (and keeps
--    `import_source`) only while `transpera.importing` is on, which only `import_process_bundle` sets, and never lets it change. The marker is a new key inside the existing `provenance`
--    jsonb: no column changes, nothing that reads provenance looks at keys it does not know, and publishing is not blocked by it.
--
-- STRICTLY ADDITIVE: functions, one trigger, two nullable columns, two widened checks.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   1. Neither function nor the trigger exists, and the columns don't. Expect 0, 0, 0, 0:
--        select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_process_bundle';
--        select count(*) from pg_proc where pronamespace = 'private'::regnamespace and proname = 'clear_branch_odds';
--        select count(*) from pg_trigger where tgname = 'clear_branch_odds' and not tgisinternal;
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('suggestions', 'suggestion_proposals') and column_name = 'import_source';
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
--   -- first `create or replace` private.suggestion_proposals_before_write() (text from 20261124000000_suggestions_v2.sql) and private.suggestions_before_write() (20261015000000_suggestions.sql) (the column drop below needs them gone)
--   delete from public.suggestions where created_via = 'upload';
--   delete from public.suggestion_proposals where created_via = 'upload';
--   alter table public.suggestions drop column import_source, drop constraint suggestions_created_via, add constraint suggestions_created_via check (created_via in ('mcp'));
--   alter table public.suggestion_proposals drop column import_source, drop constraint suggestion_proposals_created_via, add constraint suggestion_proposals_created_via check (created_via in ('mcp', 'play_link'));
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
-- Where an upload's suggestions and proposals came from
-- ---------------------------------------------------------------------------

alter table public.suggestions add column import_source text constraint suggestions_import_source check (char_length(import_source) <= 300);
alter table public.suggestion_proposals add column import_source text constraint suggestion_proposals_import_source check (char_length(import_source) <= 300);

alter table public.suggestions drop constraint suggestions_created_via,
  add constraint suggestions_created_via check (created_via in ('mcp', 'upload')) not valid;
alter table public.suggestions validate constraint suggestions_created_via;
alter table public.suggestion_proposals drop constraint suggestion_proposals_created_via,
  add constraint suggestion_proposals_created_via check (created_via in ('mcp', 'play_link', 'upload')) not valid;
alter table public.suggestion_proposals validate constraint suggestion_proposals_created_via;

-- SELECT on proposals is granted column by column (a visitor's email is left out): the new column is shown to everyone who can read.
grant select (import_source) on public.suggestion_proposals to authenticated;

create or replace function private.suggestion_proposals_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.applied := null;
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.created_by := auth.uid();
    -- A signed-in request (the app, or the MCP server with a token) can't pass as a visitor.
    if auth.uid() is not null then
      -- An upload (public.import_process_bundle) says so for the duration of its own statement; anything else is MCP.
      new.created_via := case when coalesce(current_setting('transpera.importing', true), '') = 'on' then 'upload' else 'mcp' end;
      new.proposer_name := null;
      new.proposer_email := null;
      if new.created_via <> 'upload' then new.import_source := null; end if;
    end if;
    return new;
  end if;
  -- Deleting a user sets `created_by` or `reviewed_by` to null through the foreign key's own trigger (depth 2 here).
  -- That, and nothing else, is let through.
  if pg_catalog.pg_trigger_depth() > 1
    and (to_jsonb(new) - 'created_by' - 'reviewed_by' - 'updated_at') = (to_jsonb(old) - 'created_by' - 'reviewed_by' - 'updated_at')
    and (new.created_by is null or new.created_by is not distinct from old.created_by)
    and (new.reviewed_by is null or new.reviewed_by is not distinct from old.reviewed_by) then
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id or new.kind is distinct from old.kind
    or new.title is distinct from old.title or new.detail is distinct from old.detail
    or new.payload is distinct from old.payload or new.evidence is distinct from old.evidence
    or new.note is distinct from old.note or new.issue_id is distinct from old.issue_id
    or new.created_via is distinct from old.created_via or new.import_source is distinct from old.import_source or new.proposer_name is distinct from old.proposer_name
    or new.proposer_email is distinct from old.proposer_email or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'A proposal can''t be changed, only accepted, rejected or dismissed' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.applied is distinct from old.applied
    or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
    or new.review_note is distinct from old.review_note then
    if old.status <> 'pending' or coalesce(current_setting('transpera.reviewing_proposals', true), '') <> 'on' then
      raise exception 'Proposals are decided with review_proposals' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;


-- The same rule for suggestions as for proposals: only the import path can record an upload, and where it came from never changes.
create or replace function private.suggestions_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.applied := null;
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.created_by := auth.uid();
    -- Only an upload (public.import_process_bundle, which turns `transpera.importing` on for its own statement) can say so.
    new.created_via := case when coalesce(current_setting('transpera.importing', true), '') = 'on' then 'upload' else 'mcp' end;
    if new.created_via <> 'upload' then new.import_source := null; end if;
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id or new.target_table is distinct from old.target_table
    or new.target_id is distinct from old.target_id or new.patch is distinct from old.patch
    or new.evidence is distinct from old.evidence or new.note is distinct from old.note
    or new.created_via is distinct from old.created_via or new.import_source is distinct from old.import_source or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'A suggestion can''t be changed, only accepted or rejected' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.applied is distinct from old.applied
    or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
    or new.review_note is distinct from old.review_note then
    if old.status <> 'pending' or coalesce(current_setting('transpera.reviewing', true), '') <> 'on' then
      raise exception 'Suggestions are accepted or rejected with review_suggestions' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- The all-or-nothing /2 upload
-- ---------------------------------------------------------------------------

create function public.import_process_bundle(p_workspace uuid, p_nodes jsonb, p_adopt jsonb default '[]', p_extras jsonb default '{}') returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  extras jsonb := coalesce(nullif(p_extras, 'null'::jsonb), '{}');
  srcs jsonb;
  fp jsonb;
  sugg jsonb;
  props jsonb;
  s jsonb;
  top uuid;
  made jsonb;
  rev uuid;
  fresh uuid;
  ref uuid;
  fresh_ids uuid[] := '{}';
  nodes_txt text;
  sugg_txt text;
  props_txt text;
  label text;
  n_sources integer;
  n_suggestions integer;
  n_proposals integer;
  body_chars bigint;
  wrote_fp boolean := false;
begin
  if p_workspace is null or jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes) < 1 then
    raise exception 'import_process_bundle: p_nodes must be an array of processes' using errcode = '22023';
  end if;
  if jsonb_typeof(extras) is distinct from 'object' then
    raise exception 'import_process_bundle: p_extras must be an object' using errcode = '22023';
  end if;
  -- A section that is JSON null is a section that is left out.
  srcs := coalesce(nullif(extras -> 'sources', 'null'::jsonb), '[]');
  sugg := coalesce(nullif(extras -> 'suggestions', 'null'::jsonb), '[]');
  props := coalesce(nullif(extras -> 'proposals', 'null'::jsonb), '[]');
  fp := nullif(extras -> 'first_principles', 'null'::jsonb);
  if jsonb_typeof(srcs) is distinct from 'array' or jsonb_typeof(sugg) is distinct from 'array' or jsonb_typeof(props) is distinct from 'array'
    or (fp is not null and jsonb_typeof(fp) is distinct from 'object') then
    raise exception 'import_process_bundle: sources, suggestions and proposals must be arrays and first_principles an object' using errcode = '22023';
  end if;
  n_sources := jsonb_array_length(srcs);
  n_suggestions := jsonb_array_length(sugg);
  n_proposals := jsonb_array_length(props);
  if n_sources > 50 or n_suggestions > 300 or n_proposals > 50 then
    raise exception 'import_process_bundle: at most 50 sources, 300 suggestions and 50 proposals in one import' using errcode = '22023';
  end if;
  select coalesce(sum(char_length(coalesce(x ->> 'body', ''))), 0) into body_chars from jsonb_array_elements(srcs) x;
  if body_chars > 2000000 then
    raise exception 'The sources'' text is too long: % characters in all, and one upload takes at most 2,000,000. Leave the text out of the longest sources.', body_chars using errcode = '22023';
  end if;
  label := left(nullif(extras ->> 'import_source', ''), 300);
  top := (p_nodes -> 0 ->> 'id')::uuid;
  nodes_txt := p_nodes::text;
  sugg_txt := sugg::text;
  props_txt := props::text;

  -- Sources first: the steps that cite them are linked to them as they are written. Each gets an id made here; the file's
  -- placeholder (`ref`) is replaced by it wherever the file cites the source.
  for s in select value from jsonb_array_elements(srcs) loop
    ref := (s ->> 'ref')::uuid;
    fresh := gen_random_uuid();
    insert into public.sources (id, workspace_id, kind, title, speakers, recorded_at, body)
    values (fresh, p_workspace, coalesce(s ->> 'kind', 'transcript'), s ->> 'title',
      coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(s -> 'speakers') = 'array' then s -> 'speakers' else '[]'::jsonb end)), '{}'),
      nullif(s ->> 'recorded_at', '')::date, nullif(s ->> 'body', ''));
    fresh_ids := fresh_ids || fresh;
    nodes_txt := replace(nodes_txt, ref::text, fresh::text);
    sugg_txt := replace(sugg_txt, ref::text, fresh::text);
    props_txt := replace(props_txt, ref::text, fresh::text);
  end loop;

  -- The process, its draft, its steps and edges (and any child processes), as the atomic import writes them.
  made := public.import_new_process(p_workspace, nodes_txt::jsonb, p_adopt);
  rev := (made -> 0 ->> 'revision_id')::uuid;

  -- Every source of the file is evidence for the process it came with.
  insert into public.source_links (workspace_id, source_id, kind, process_id)
  select p_workspace, f, 'process', top from unnest(fresh_ids) f
  on conflict do nothing;

  if fp is not null then
    -- A key the caller leaves out is the column's default (jsonb_populate_record gives null, which the columns refuse).
    insert into public.first_principles (workspace_id, process_id, revision_id, job_who, job_progress, job_situation, job_done, statements, requirements, deletes, improvements, why_problem, why_chain, root_cause, measures)
    select p_workspace, top, rev, coalesce(r.job_who, ''), coalesce(r.job_progress, ''), coalesce(r.job_situation, ''), coalesce(r.job_done, ''),
      coalesce(r.statements, '[]'::jsonb), coalesce(r.requirements, '[]'::jsonb), coalesce(r.deletes, '[]'::jsonb), coalesce(r.improvements, '[]'::jsonb),
      coalesce(r.why_problem, ''), coalesce(r.why_chain, '[]'::jsonb), coalesce(r.root_cause, ''), coalesce(r.measures, '[]'::jsonb)
    from jsonb_populate_record(null::public.first_principles, fp) r;
    wrote_fp := true;
  end if;

  -- Company facts wait as suggestions; the review path is the only way to apply one. The triggers record them as uploads while
  -- `transpera.importing` is on (set here, nowhere else), and it is off again after the proposals.
  perform set_config('transpera.importing', 'on', true);
  insert into public.suggestions (workspace_id, target_table, target_id, patch, evidence, note, created_via, import_source)
  select p_workspace, x.target_table, x.target_id, x.patch, coalesce(x.evidence, '[]'::jsonb), x.note, 'upload', label
  from jsonb_to_recordset(sugg_txt::jsonb) as x(target_table text, target_id uuid, patch jsonb, evidence jsonb, note text);

  -- Issues and ideas wait as proposals.
  insert into public.suggestion_proposals (workspace_id, kind, title, detail, payload, evidence, note, issue_id, import_source)
  select p_workspace, x.kind, x.title, x.detail, coalesce(x.payload, '{}'::jsonb), coalesce(x.evidence, '[]'::jsonb), x.note, x.issue_id, label
  from jsonb_to_recordset(props_txt::jsonb) as x(kind text, title text, detail text, payload jsonb, evidence jsonb, note text, issue_id uuid);
  perform set_config('transpera.importing', '', true);

  return jsonb_build_object('processes', made, 'sources', n_sources, 'suggestions', n_suggestions, 'proposals', n_proposals, 'first_principles', wrote_fp);
end;
$$;

revoke all on function public.import_process_bundle(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_process_bundle(uuid, jsonb, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- A step's missing branch odds clear when its branches are filled in
-- ---------------------------------------------------------------------------

create function private.clear_branch_odds() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rev uuid := case when tg_op = 'DELETE' then old.revision_id else new.revision_id end;
  from_step uuid := case when tg_op = 'DELETE' then old.from_step_id else new.from_step_id end;
  marker jsonb;
  untouched integer;
begin
  -- History is never touched: only a draft's step is looked at.
  if not exists (select 1 from public.process_revisions r where r.id = rev and r.status = 'draft') then
    return null;
  end if;
  -- A step made in this very transaction is the import (or a copy of a version) still writing its edges.
  select s.provenance -> 'branch_odds' into marker from public.steps s
  where s.revision_id = rev and s.id = from_step and s.created_at < now();
  if marker is null then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    -- Branches that still have the probability the upload gave them by default: with one or none left, the last is inferred.
    select count(*) into untouched from public.edges e
    where e.revision_id = rev and e.from_step_id = from_step
      and (marker -> 'was' ->> e.to_step_id::text) is not null
      and (marker -> 'was' ->> e.to_step_id::text)::numeric = e.probability;
    if untouched > 1 then
      return null;
    end if;
  end if;
  -- Runs as the caller, who is editing the draft the step is in (the drafts-only guard on steps still applies).
  update public.steps s set provenance = s.provenance - 'branch_odds'
  where s.revision_id = rev and s.id = from_step;
  return null;
end;
$$;

revoke all on function private.clear_branch_odds() from public, anon, authenticated;

create trigger clear_branch_odds after insert or delete or update of probability on public.edges
  for each row execute function private.clear_branch_odds();
$mig$]);

commit;
