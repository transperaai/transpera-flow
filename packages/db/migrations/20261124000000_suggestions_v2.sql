-- Suggestions v2: proposed issues and solution ideas (issue #117, ticket A52, slice 1 of 2; PRD §7.1c, §8 screen 8).
--
-- Everything AI proposes waits in Suggestions until someone acts on it. Company-model changes already do (the
-- `suggestions` table, migration 20261015000000, and its `review_suggestions`). This adds the other two kinds:
--
--   * a proposed issue: accepting it creates a real issue through `public.save_issue`, the same call the Acknowledge
--     dialog makes (A47), so it gets its number, its links and its `created` history entry; rejecting it records the
--     decision and takes it off the list;
--   * a solution idea: a plain-words idea for one issue, with the steps the AI would place. It is not built and not
--     simulated. Slice 1 stores and lists these and lets someone dismiss them. "Build it" (open the Editor in solution
--     mode with the steps placed) and the block map are slice 2, which is also where an idea gets its `built` outcome.
--     B4's play links (#33) will insert their visitors' proposals as solution ideas with `created_via = 'play_link'`
--     and the visitor's name and email, through their own rate-limited function; none of that plumbing exists yet.
--
-- Why a new table and not new kinds in `suggestions`: that table is company-model only (`target_table` and `patch` are
-- NOT NULL with checks, and the deployed app's review function applies any pending row's patch). Widening it would mean
-- rewriting constraints the running app depends on, and an old build would show a proposed issue as a broken
-- company-model change. A separate table changes nothing that exists, so this is strictly additive (expand only) and
-- safe before, during or after the deploy. Apply it BEFORE deploying this ticket's app, which reads the new table.
--
-- What is new:
--
--   * `public.suggestion_proposals`: workspace, `kind` (`issue` or `solution_idea`), a title, the idea or finding in
--     plain words (`detail`), `payload` (for an issue: `severity`, `type`, `links` [{process_id, step_id}],
--     `target_measure`, `target_now`, `target_goal`; for a solution idea: `steps` [the proposed steps: name, kind, role,
--     block_id ...], `edges`, `replaces_step_ids`, `expect`), cited `evidence`, the AI's reasoning (`note`), for a
--     solution idea the issue it is for (`issue_id`, a real foreign key: the idea goes when the issue does), who made
--     it (`created_via` mcp or play_link, `proposer_name`, `proposer_email`), its `status` (pending, accepted, rejected,
--     dismissed, built), and what accepting did (`applied`: {issue_id, number}).
--   * `public.review_proposals(ids, decision, note)`: accept or reject proposals as the signed-in user (security
--     invoker, so row-level security decides), one at a time, in the shape of `review_suggestions`. A solution idea is
--     "rejected" as `dismissed`; accepting one is refused (it is built in the Editor, slice 2). An API-token request
--     (the MCP server) can't review: a person decides.
--   * the payload is checked at insert: an issue's `severity` and `type` must be values `issues` accepts;
--   * accepting a proposed issue also links the sources its evidence cites (this workspace's), as Acknowledge does;
--   * a visitor's email (`proposer_email`) can't be read by the app's users: SELECT is granted on every other column;
--   * `private.suggestion_proposals_before_write`: a new proposal starts pending; a request with a signed-in user is
--     recorded as `mcp` with no visitor details (only a function with no user, such as B4's, can say `play_link`); what
--     was proposed never changes; the decision columns change only inside `review_proposals`. Deleting a user nulls
--     `created_by` or `reviewed_by` through the foreign key, and that one change is let through.
--
-- Row-level security as `suggestions`: everyone in the workspace reads; owners and editors (and the MCP server acting
-- as one) propose and review. Nobody deletes. Privileges: Supabase gives every new table full rights to anon and
-- authenticated, so this revokes them all and grants back insert, a column-wise select (not `proposer_email`) and an
-- UPDATE limited to the five decision columns.
--
-- Preflight (run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each should be as described):
--
--   1. The table does not exist yet. Expect 0:
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'suggestion_proposals';
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261124000000';
--   3. A47's save_issue and the policy helpers exist. Expect 4 rows:
--        select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('save_issue', 'can_read_workspace', 'can_edit_workspace', 'set_updated_at');
--   4. The tables it references exist. Expect 2 rows:
--        select table_name from information_schema.tables where table_schema = 'public' and table_name in ('issues', 'workspaces');
--
-- Post-apply grant check (authenticated must show table-level INSERT only, SELECT on every column but proposer_email, and
-- UPDATE on exactly the five decision columns; anon nothing at all):
--        select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'suggestion_proposals' and grantee in ('anon', 'authenticated') order by 1, 2;
--        select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'suggestion_proposals' and grantee = 'authenticated' and privilege_type = 'UPDATE' order by 1;
--        select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'suggestion_proposals' and grantee = 'authenticated' and privilege_type = 'SELECT' order by 1;
--   Expect: authenticated INSERT (table level); UPDATE columns applied, review_note, reviewed_at, reviewed_by, status; SELECT on
--   all columns but proposer_email; no anon rows.
--
-- Rollback (run as one transaction; nothing existing was changed, so there is nothing to put back):
--
--   begin;
--   drop function if exists public.review_proposals(uuid[], text, text);
--   drop table if exists public.suggestion_proposals;   -- its indexes, trigger and policies go with it
--   drop function if exists private.suggestion_proposals_before_write();
--   delete from supabase_migrations.schema_migrations where version = '20261124000000';
--   commit;
--
-- Rolling back deletes every pending and decided proposal. Issues that accepted proposals created stay.
--
-- Production data: none needed (no rows means nothing waiting).

create table public.suggestion_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null constraint suggestion_proposals_kind check (kind in ('issue', 'solution_idea')),
  title text not null constraint suggestion_proposals_title check (char_length(btrim(title)) between 1 and 200),
  -- The finding or the idea, in plain words.
  detail text constraint suggestion_proposals_detail check (char_length(detail) <= 5000),
  -- issue: {severity, type, links: [{process_id, step_id}], target_measure, target_now, target_goal}
  -- solution_idea: {steps: [...], edges: [...], replaces_step_ids: [...], expect}
  payload jsonb not null default '{}' constraint suggestion_proposals_payload check (coalesce(
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 100000
    and (kind <> 'solution_idea' or jsonb_typeof(payload -> 'steps') = 'array')
    and (kind <> 'issue' or not payload ? 'links' or jsonb_typeof(payload -> 'links') = 'array')
    -- A proposed issue's rating and type are the values `issues` accepts, so accepting it can't fail on them.
    and (kind <> 'issue' or not payload ? 'severity' or payload ->> 'severity' in ('critical', 'serious', 'warning', 'info'))
    and (kind <> 'issue' or not payload ? 'type' or payload ->> 'type' in (
      'bottleneck', 'spof', 'manual', 'delay', 'failure', 'idea', 'capacity', 'sla', 'churn_risk', 'perception_gap', 'broken_scenario')), false)),
  -- Citations, as in suggestions: [{source_id, speaker, quote, timestamp}].
  evidence jsonb not null default '[]' constraint suggestion_proposals_evidence check (
    jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 20 and octet_length(evidence::text) <= 50000),
  -- The proposer's reasoning, shown to the reviewer.
  note text constraint suggestion_proposals_note check (char_length(note) <= 2000),
  -- A solution idea is for one issue; a proposed issue is for none yet.
  issue_id uuid,
  status text not null default 'pending' constraint suggestion_proposals_status check (
    status in ('pending', 'accepted', 'rejected', 'dismissed', 'built')),
  created_via text not null default 'mcp' constraint suggestion_proposals_created_via check (created_via in ('mcp', 'play_link')),
  -- A play-link visitor's name and email (B4); null otherwise.
  proposer_name text constraint suggestion_proposals_proposer_name check (char_length(proposer_name) <= 200),
  proposer_email text constraint suggestion_proposals_proposer_email check (char_length(proposer_email) <= 320),
  -- What accepting did: {issue_id, number}.
  applied jsonb,
  review_note text constraint suggestion_proposals_review_note check (char_length(review_note) <= 2000),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  constraint suggestion_proposals_reviewed check ((status = 'pending') = (reviewed_at is null)),
  constraint suggestion_proposals_issue check ((kind = 'solution_idea') = (issue_id is not null)),
  foreign key (issue_id, workspace_id) references public.issues (id, workspace_id) on delete cascade
);

create index on public.suggestion_proposals (workspace_id, status, created_at desc);
create index on public.suggestion_proposals (issue_id) where issue_id is not null;

create trigger set_updated_at before update on public.suggestion_proposals
  for each row execute function public.set_updated_at();

-- New proposals start pending. Afterwards only a review may change them (once), and what was proposed never changes.
create function private.suggestion_proposals_before_write() returns trigger
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
      new.created_via := 'mcp';
      new.proposer_name := null;
      new.proposer_email := null;
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
    or new.created_via is distinct from old.created_via or new.proposer_name is distinct from old.proposer_name
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

create trigger before_write before insert or update on public.suggestion_proposals
  for each row execute function private.suggestion_proposals_before_write();

alter table public.suggestion_proposals enable row level security;

create policy "read proposals" on public.suggestion_proposals for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert proposals" on public.suggestion_proposals for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update proposals" on public.suggestion_proposals for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));

-- Supabase's default privileges give anon and authenticated everything on a new table: take it all back, then grant
-- only what is used. No delete (a decided proposal is the record), and UPDATE only on the decision columns.
-- A visitor's email (B4) is not readable by the app's users: SELECT is granted column by column, leaving it out. B4 decides
-- who may see it and how.
revoke all on public.suggestion_proposals from anon, authenticated;
grant insert on public.suggestion_proposals to authenticated;
grant select (id, workspace_id, kind, title, detail, payload, evidence, note, issue_id, status, created_via, proposer_name,
  applied, review_note, reviewed_by, reviewed_at, created_at, updated_at, created_by) on public.suggestion_proposals to authenticated;
grant update (status, applied, review_note, reviewed_by, reviewed_at) on public.suggestion_proposals to authenticated;

-- Accept or reject proposals, as the signed-in user. Each is handled on its own: one that can't be applied is reported
-- and left pending, and the others still go through. Returns [{id, status, message?, applied?}] in the order given,
-- where status is accepted, rejected, dismissed, not_found (not visible or not editable), already_reviewed or failed.
create function public.review_proposals(ids uuid[], decision text, note text default null) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  pid uuid;
  p public.suggestion_proposals;
  outcome jsonb;
  saved jsonb;
  new_status text;
  results jsonb := '[]';
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Proposals are reviewed by a person in the app, not over the API' using errcode = '42501';
  end if;
  if decision is null or decision not in ('accept', 'reject') then
    raise exception 'decision must be accept or reject' using errcode = '22023';
  end if;
  if ids is null or cardinality(ids) = 0 or cardinality(ids) > 500 then
    raise exception 'Give between 1 and 500 proposals' using errcode = '22023';
  end if;

  foreach pid in array ids loop
    p := null;
    -- RLS: a proposal the user can't update is not found.
    -- Every column but the visitor's email, which this role can't read (position matters: it is the table's order).
    select x.id, x.workspace_id, x.kind, x.title, x.detail, x.payload, x.evidence, x.note, x.issue_id, x.status, x.created_via,
      x.proposer_name, null::text, x.applied, x.review_note, x.reviewed_by, x.reviewed_at, x.created_at, x.updated_at, x.created_by
      into p from public.suggestion_proposals x where x.id = pid for update;
    if p.id is null then
      results := results || jsonb_build_array(jsonb_build_object('id', pid, 'status', 'not_found'));
      continue;
    end if;
    if p.status <> 'pending' then
      results := results || jsonb_build_array(jsonb_build_object('id', pid, 'status', 'already_reviewed', 'current', p.status));
      continue;
    end if;

    begin
      outcome := null;
      if decision = 'accept' then
        if p.kind <> 'issue' then
          raise exception 'A solution idea is built in the Editor, not accepted' using errcode = '22023';
        end if;
        -- The Acknowledge path: the same call the dialog makes, as this user (a new manual issue with what it touches).
        saved := public.save_issue(
          p.workspace_id,
          jsonb_strip_nulls(jsonb_build_object(
            'title', p.title,
            'type', coalesce(p.payload ->> 'type', 'manual'),
            'severity', coalesce(p.payload ->> 'severity', 'warning'),
            'evidence', p.detail,
            'target_measure', p.payload ->> 'target_measure',
            'target_now', p.payload ->> 'target_now',
            'target_goal', p.payload ->> 'target_goal',
            'source', 'manual')),
          null,
          coalesce(p.payload -> 'links', '[]'),
          null,
          -- The sources it cites, as Acknowledge links them (only this workspace's).
          array(
            select distinct src.id from jsonb_array_elements(p.evidence) e
            join public.sources src on src.workspace_id = p.workspace_id and src.id::text = lower(e ->> 'source_id')));
        outcome := jsonb_build_object('issue_id', saved ->> 'id', 'number', saved -> 'number');
      end if;
      new_status := case when decision = 'accept' then 'accepted' when p.kind = 'solution_idea' then 'dismissed' else 'rejected' end;
      perform set_config('transpera.reviewing_proposals', 'on', true);
      update public.suggestion_proposals x
        set status = new_status,
            applied = outcome,
            review_note = nullif(btrim(review_proposals.note), ''),
            reviewed_by = auth.uid(),
            reviewed_at = now()
      where x.id = pid;
      perform set_config('transpera.reviewing_proposals', '', true);
      results := results || jsonb_build_array(
        jsonb_build_object('id', pid, 'status', new_status)
        || case when outcome is null then '{}'::jsonb else jsonb_build_object('applied', outcome) end);
    exception when others then
      perform set_config('transpera.reviewing_proposals', '', true);
      results := results || jsonb_build_array(jsonb_build_object('id', pid, 'status', 'failed', 'code', sqlstate, 'message', sqlerrm));
    end;
  end loop;
  return results;
end;
$$;

revoke all on function public.review_proposals(uuid[], text, text) from public, anon;
grant execute on function public.review_proposals(uuid[], text, text) to authenticated;
