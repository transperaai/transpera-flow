-- Issues v2: data (issue #112, ticket A47). An issue is a problem someone confirmed, from acknowledging an insight
-- or added by hand. This migration reshapes the register's data; the Acknowledge dialog (apps/web) writes it.
--
-- STRICTLY ADDITIVE (expand only). It drops, renames and rewrites nothing that exists: the `issues_status` check, the
-- existing status values, `private.issues_before_write` and its trigger are all left exactly as they are, so the
-- deployed app and MCP server keep working before, during and after this is applied, in either order with the deploy.
-- A later "contract" migration (rewrite the stored statuses, tighten the check) is future work that needs Austin's
-- go-ahead; see docs/production-migrations.md.
--
-- What is new, all next to the existing `issues` table:
--
--   * `issue_links`: what an issue touches. A row with a null `step_id` is the whole process; rows with a `step_id`
--     are steps (a step's stable id, so no foreign key: steps are keyed by revision; `save_issue` checks each is a step
--     of the link's process in the workspace). An issue may touch several steps, even in different processes.
--     `issues.process_id` and `issues.step_id` stay, as the first link, for compatibility; `save_issue` keeps them in
--     step, and a trigger seeds the links of an issue inserted any other way from those columns.
--   * `issue_owners`: several owners, people. `issues.owner_person_id` stays as the first owner, and a trigger seeds an
--     issue inserted any other way from it.
--   * `issue_sources`: linked sources. (`issues.evidence_sources` stays, unused by new code.)
--   * `issues.target_measure`, `target_now`, `target_goal`: "Wait at Check fit", "1.4 d", "under 4 hours". Free text.
--   * Statuses, held as the values the check already allows plus one new column:
--         shown               status         resolution
--         Open                open           null
--         Testing solutions   in_progress    null
--         Resolved            done           null
--         Won't fix           done           'wont_fix'
--         (dismissed insight) dismissed      null
--     `issues.resolution` (null, or 'wont_fix') is new; a trigger clears it unless the status is `done`. The app and the
--     MCP server map between the two in one place (packages/db/src/issue-status.ts); `save_issue` takes the shown names
--     and stores the old spellings plus the resolution. `resolved_at` is set for `done` and `dismissed` as it always was.
--     `dismissed` is not an issue a person sees: it is what A45 stores for an insight someone dismissed (a tracked row,
--     so the insight stays gone). The register, the map, the counts and the insight list leave it out, and nothing in the
--     app lets a person pick it; `save_issue` only sets it on a row that carries a detection key.
--   * `issues.number`: a stable number per workspace (Issue #12), assigned by a new BEFORE INSERT/UPDATE trigger
--     (`issues_number`) from `private.issue_counters` (one row per workspace; the upsert's row lock makes concurrent
--     inserts take turns). Never reused, even after a delete, and can't be changed. A dismissed insight is not an issue,
--     so it has no number (null) and uses none up; it gets one if it is acknowledged later. The number is taken before
--     a conflict is known, so an `INSERT ... ON CONFLICT DO NOTHING` that does nothing still uses one: expect a gap there
--     (a rolled-back insert gives its number back, as the counter row is part of the transaction).
--   * `issues.dismissed_revision_id`: the process's live revision a dismissed insight was dismissed against. A
--     dismissal lasts until the process's next published version: the app lists a dismissed insight again once its
--     process has a different live revision and the analysis still detects it, and a re-dismiss writes the new revision
--     here. Null means "before any version" (the process had never been published): it expires on the first publish.
--     The trigger clears it when the row stops being dismissed.
--   * `issue_events`: the history log. created, edited, solution_tested, resolved, reopened, each with a date (`at`)
--     and who (`actor`, null for a system change), and a `detail` (changed fields, status from and to, and the links,
--     owners and sources added or removed). A dismissed insight writes none (it is not an issue yet); acknowledging it
--     writes `created`. Written only by triggers (security definer) on `issues` and on the three link tables, so every
--     change logs whichever way it is made and nobody can edit or forge a row. A link change inside a transaction that
--     already logged the issue is added to that event's detail instead of a second event.
--   * `public.save_issue(...)`: one call that creates or edits an issue with its links, owners and sources in one
--     transaction (so one history entry), as the signed-in user (security invoker: RLS applies).
--
-- Severity: the `severity` column already holds the four ratings (critical = Operational risk, serious = Bad, warning =
-- Good could improve, info = Great; engine `ratingOfStored`, A41). No data changes; the migration test checks it.
--
-- Existing issues are migrated in place, additively: their step and process become `issue_links` rows (a step's process
-- looked up from `steps` when the issue didn't name one), their owner an `issue_owners` row, their cited sources
-- `issue_sources` rows, they get numbers in the order they were logged (oldest first; a dismissed one gets none), and
-- each gets a `created` event at its `created_at` (plus `resolved` at `resolved_at` for the closed ones). A migrated
-- dismissed row takes the live revision of its process (`dismissed_revision_id`) where that can be worked out. No
-- existing column value changes, so nothing is lost.
--
-- `save_fields` is not redefined: `issues` is already in its allow-list, and an edit through it logs too.
--
-- Preflight (run first, each should be as described):
--   1. The new tables do not exist yet. Expect 0:
--        select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('issue_links', 'issue_owners', 'issue_sources', 'issue_events');
--   2. Nothing of ours is applied past this one. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261120000000';
--   3. A look at what will be migrated (counts per status and how many name a step or an owner):
--        select status, count(*), count(step_id) as with_step, count(owner_person_id) as with_owner from public.issues group by 1;
--
-- Rollback (run as one transaction; nothing existing was changed, so there is nothing to put back and nothing is mapped
-- to `dismissed`; it loses the history log, the extra links, owners and sources, targets, numbers and resolutions):
--
--   begin;
--   drop function if exists public.save_issue(uuid, jsonb, uuid, jsonb, uuid[], uuid[]);
--   drop table if exists public.issue_events, public.issue_sources, public.issue_owners, public.issue_links;
--   drop trigger if exists issue_log on public.issues;
--   drop trigger if exists audit_mcp on public.issue_links;  -- (and the other two; dropping the tables below drops them too)
--   drop trigger if exists issue_seed_links on public.issues;
--   drop trigger if exists issues_number on public.issues;
--   drop function if exists private.log_issue_change();
--   drop function if exists private.log_issue_link_change();
--   drop function if exists private.seed_issue_links();
--   drop function if exists private.issues_v2_before_write();
--   drop function if exists private.issue_ui_status(text, text);
--   drop table if exists private.issue_counters;
--   drop function if exists private.next_issue_number(uuid);
--   alter table public.issues drop constraint if exists issues_target_lengths, drop constraint if exists issues_resolution,
--     drop constraint if exists issues_workspace_number_key;
--   alter table public.issues drop column number, drop column target_measure, drop column target_now, drop column target_goal,
--     drop column dismissed_revision_id, drop column resolution;
--   delete from supabase_migrations.schema_migrations where version = '20261120000000';
--   commit;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.issues
  add column number integer,
  add column resolution text,
  add column target_measure text,
  add column target_now text,
  add column target_goal text,
  add column dismissed_revision_id uuid,
  add constraint issues_resolution check (resolution in ('wont_fix')),
  add constraint issues_dismissed_revision_fkey foreign key (dismissed_revision_id, workspace_id)
    references public.process_revisions (id, workspace_id) on delete set null (dismissed_revision_id),
  add constraint issues_target_lengths check (
    char_length(target_measure) <= 200 and char_length(target_now) <= 200 and char_length(target_goal) <= 200);

-- ---------------------------------------------------------------------------
-- Numbers
-- ---------------------------------------------------------------------------

create table private.issue_counters (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  last_number integer not null
);
revoke all on private.issue_counters from public, anon, authenticated;

-- The row lock taken by the upsert makes concurrent inserts for one workspace take turns.
create function private.next_issue_number(ws uuid) returns integer
language sql
security definer
set search_path = ''
as $$
  insert into private.issue_counters (workspace_id, last_number) values (ws, 1)
  on conflict (workspace_id) do update set last_number = private.issue_counters.last_number + 1
  returning last_number;
$$;
revoke all on function private.next_issue_number(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A new write trigger (the existing `issues_before_write` is untouched and runs first): the number, the resolution and
-- the dismissal's revision. Security definer, so the writer needs no access to the private counter table.
-- ---------------------------------------------------------------------------

create function private.issues_v2_before_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A dismissed insight is not an issue: no number until it is acknowledged. A number the writer supplies is ignored.
    new.number := case when new.status <> 'dismissed' then private.next_issue_number(new.workspace_id) end;
  elsif old.number is not null then
    if new.number is distinct from old.number then
      raise exception 'issues: the number cannot be changed' using errcode = '23514';
    end if;
  else
    new.number := case when new.status <> 'dismissed' then private.next_issue_number(new.workspace_id) end;
  end if;
  -- Won't fix is a kind of done, and a dismissal's revision means something only while the row is dismissed.
  if new.status <> 'done' then
    new.resolution := null;
  end if;
  if new.status <> 'dismissed' then
    new.dismissed_revision_id := null;
  elsif new.dismissed_revision_id is null and (tg_op = 'INSERT' or old.status <> 'dismissed') then
    -- Dismissed without saying against which version (the deployed app before this change, or a plain insert): it is
    -- dismissed against the live revision of its process (its process, else its step's), where there is one. A process
    -- that has never been published has none: null then means "before any version".
    select p.live_revision_id into new.dismissed_revision_id from public.processes p
      where p.workspace_id = new.workspace_id
        and p.id = coalesce(new.process_id, (select s.process_id from public.steps s where s.id = new.step_id and s.workspace_id = new.workspace_id limit 1));
  end if;
  return new;
end;
$$;
revoke all on function private.issues_v2_before_write() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Link tables
-- ---------------------------------------------------------------------------

create table public.issue_links (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null,
  workspace_id uuid not null,
  -- The process the step is in; the process itself when step_id is null. Null only for a step whose process isn't known.
  process_id uuid,
  -- A step's stable id (no foreign key: steps are keyed by revision). Null: the whole process.
  step_id uuid,
  created_at timestamptz not null default now(),
  constraint issue_links_something check (process_id is not null or step_id is not null),
  foreign key (issue_id, workspace_id) references public.issues (id, workspace_id) on delete cascade,
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete cascade
);
create unique index issue_links_unique on public.issue_links
  (issue_id, coalesce(process_id, '00000000-0000-0000-0000-000000000000'), coalesce(step_id, '00000000-0000-0000-0000-000000000000'));
create index on public.issue_links (workspace_id, step_id);
create index on public.issue_links (workspace_id, process_id);

create table public.issue_owners (
  issue_id uuid not null,
  person_id uuid not null,
  workspace_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (issue_id, person_id),
  foreign key (issue_id, workspace_id) references public.issues (id, workspace_id) on delete cascade,
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade
);
create index on public.issue_owners (workspace_id, person_id);

create table public.issue_sources (
  issue_id uuid not null,
  source_id uuid not null,
  workspace_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (issue_id, source_id),
  foreign key (issue_id, workspace_id) references public.issues (id, workspace_id) on delete cascade,
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index on public.issue_sources (workspace_id, source_id);

-- ---------------------------------------------------------------------------
-- History
-- ---------------------------------------------------------------------------

create table public.issue_events (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null,
  workspace_id uuid not null,
  -- The order they happened in (`at` can tie inside one transaction).
  seq bigint generated always as identity,
  kind text not null constraint issue_events_kind check (kind in ('created', 'edited', 'solution_tested', 'resolved', 'reopened')),
  at timestamptz not null default clock_timestamp(),
  -- Who did it; null for a change made outside a signed-in session, or by a user since deleted.
  actor uuid references auth.users (id) on delete set null,
  -- What changed: {"fields": [...]} for an edit, {"from": "...", "to": "..."} for a status change (the statuses as shown),
  -- {"linked": {"steps"|"owners"|"sources": {"added": [...], "removed": [...]}}} for what an issue touches, who owns it
  -- and its sources.
  detail jsonb not null default '{}' constraint issue_events_detail_shape check (jsonb_typeof(detail) = 'object'),
  -- The transaction that wrote it: a link change inside it is added to this entry instead of making another.
  tx bigint default txid_current(),
  foreign key (issue_id, workspace_id) references public.issues (id, workspace_id) on delete cascade
);
create index on public.issue_events (issue_id, seq);
create index on public.issue_events (workspace_id, at);

-- A stored status as it is shown (see packages/db/src/issue-status.ts).
create function private.issue_ui_status(status text, resolution text) returns text
language sql
immutable
set search_path = ''
as $$
  select case status
    when 'in_progress' then 'testing'
    when 'done' then case when resolution = 'wont_fix' then 'wont_fix' else 'resolved' end
    else status
  end;
$$;
revoke all on function private.issue_ui_status(text, text) from public, anon, authenticated;

-- Every change to an issue logs: one trigger on the row, one on each link table. Security definer, so the log is
-- written whoever the caller is and nobody else can write it.
create function private.log_issue_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  fields text[];
  ui_old text;
  ui_new text;
begin
  if tg_op = 'INSERT' then
    -- A dismissed insight is not an issue: nothing to log until it is acknowledged.
    if new.status <> 'dismissed' then
      insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
        values (new.id, new.workspace_id, 'created', auth.uid(), jsonb_build_object('status', private.issue_ui_status(new.status, new.resolution)));
    end if;
    return null;
  end if;
  if old.status = 'dismissed' then
    -- Dismissed again (a new revision), or acknowledged: the issue is born now.
    if new.status <> 'dismissed' then
      insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
        values (new.id, new.workspace_id, 'created',
          auth.uid(), jsonb_build_object('status', private.issue_ui_status(new.status, new.resolution), 'acknowledged', true));
    end if;
    return null;
  end if;

  -- process_id, step_id and owner_person_id mirror the link tables, which log their own changes.
  select coalesce(array_agg(f order by f), '{}') into fields from (
    select 'title' f where new.title is distinct from old.title
    union all select 'type' where new.type is distinct from old.type
    union all select 'severity' where new.severity is distinct from old.severity
    union all select 'evidence' where new.evidence is distinct from old.evidence
    union all select 'scenario_id' where new.scenario_id is distinct from old.scenario_id
    union all select 'role_id' where new.role_id is distinct from old.role_id
    union all select 'person_id' where new.person_id is distinct from old.person_id
    union all select 'client_id' where new.client_id is distinct from old.client_id
    union all select 'target_measure' where new.target_measure is distinct from old.target_measure
    union all select 'target_now' where new.target_now is distinct from old.target_now
    union all select 'target_goal' where new.target_goal is distinct from old.target_goal
  ) changed;

  ui_old := private.issue_ui_status(old.status, old.resolution);
  ui_new := private.issue_ui_status(new.status, new.resolution);
  if ui_new is distinct from ui_old then
    insert into public.issue_events (issue_id, workspace_id, kind, actor, detail) values (
      new.id, new.workspace_id,
      case
        when ui_new = 'testing' and ui_old = 'open' then 'solution_tested'
        when ui_new in ('resolved', 'wont_fix') and ui_old not in ('resolved', 'wont_fix') then 'resolved'
        when ui_old in ('resolved', 'wont_fix') and ui_new in ('open', 'testing') then 'reopened'
        else 'edited'
      end,
      auth.uid(), jsonb_build_object('from', ui_old, 'to', ui_new));
  end if;
  if cardinality(fields) > 0 then
    insert into public.issue_events (issue_id, workspace_id, kind, actor, detail)
      values (new.id, new.workspace_id, 'edited', auth.uid(), jsonb_build_object('fields', to_jsonb(fields)));
  end if;
  return null;
end;
$$;
revoke all on function private.log_issue_change() from public, anon, authenticated;

create trigger issue_log after insert or update on public.issues
  for each row execute function private.log_issue_change();

-- A change to what an issue touches, who owns it or its sources. It is added to the detail of the entry this
-- transaction already wrote for the issue (a create, or an edit of fields or status through save_issue), or, when there
-- is none, written as an 'edited' entry of its own. Nothing is logged for a dismissed insight or an issue being deleted.
create function private.log_issue_link_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  j jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  row_issue uuid := (j ->> 'issue_id')::uuid;
  row_workspace uuid := (j ->> 'workspace_id')::uuid;
  what text := tg_argv[0];
  dir text := case when tg_op = 'DELETE' then 'removed' else 'added' end;
  item jsonb := case what
    when 'steps' then jsonb_build_object('process_id', j -> 'process_id', 'step_id', j -> 'step_id')
    when 'owners' then j -> 'person_id'
    else j -> 'source_id'
  end;
  ev_id uuid;
  d jsonb;
begin
  if not exists (select 1 from public.issues where id = row_issue and status <> 'dismissed') then
    return null;
  end if;
  select e.id, e.detail into ev_id, d from public.issue_events e where e.issue_id = row_issue and e.tx = txid_current() order by e.seq desc limit 1;
  d := coalesce(d, '{}');
  if d -> 'linked' is null then
    d := d || jsonb_build_object('linked', '{}'::jsonb);
  end if;
  if d -> 'linked' -> what is null then
    d := jsonb_set(d, array['linked', what], '{}'::jsonb);
  end if;
  d := jsonb_set(d, array['linked', what, dir], coalesce(d #> array['linked', what, dir], '[]'::jsonb) || jsonb_build_array(item));
  if ev_id is null then
    insert into public.issue_events (issue_id, workspace_id, kind, actor, detail) values (row_issue, row_workspace, 'edited', auth.uid(), d);
  else
    update public.issue_events set detail = d where id = ev_id;
  end if;
  return null;
end;
$$;
revoke all on function private.log_issue_link_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Migrate the existing issues (the log triggers are not on yet, and the old triggers see no update: nothing existing is
-- changed, so no spurious history and no new updated_at)
-- ---------------------------------------------------------------------------

-- Numbers, oldest first (a dismissed insight has none). `updated_at` is not touched: the trigger that sets it is paused
-- for these two updates and switched back on.
alter table public.issues disable trigger set_updated_at;

with ranked as (
  select id, row_number() over (partition by workspace_id order by created_at, id) as n from public.issues where status <> 'dismissed'
)
update public.issues i set number = ranked.n from ranked where i.id = ranked.id;
insert into private.issue_counters (workspace_id, last_number)
  select workspace_id, max(number) from public.issues where number is not null group by workspace_id;
alter table public.issues add constraint issues_workspace_number_key unique (workspace_id, number);

-- A dismissed insight stays dismissed until its process's next published version: it is dismissed against the live
-- revision of the process it is on now (its process, else its step's), where there is one.
update public.issues i set dismissed_revision_id = p.live_revision_id
  from public.processes p
  where i.status = 'dismissed' and p.workspace_id = i.workspace_id and p.live_revision_id is not null
    and p.id = coalesce(i.process_id, (select s.process_id from public.steps s where s.id = i.step_id and s.workspace_id = i.workspace_id limit 1));

alter table public.issues enable trigger set_updated_at;

-- What each touches: its step (with the step's process when the issue didn't name one), else its process.
insert into public.issue_links (issue_id, workspace_id, process_id, step_id)
  select i.id, i.workspace_id,
    coalesce(i.process_id, (select s.process_id from public.steps s where s.id = i.step_id and s.workspace_id = i.workspace_id limit 1)),
    i.step_id
  from public.issues i
  where i.step_id is not null or i.process_id is not null
  on conflict do nothing;

insert into public.issue_owners (issue_id, person_id, workspace_id)
  select id, owner_person_id, workspace_id from public.issues where owner_person_id is not null
  on conflict do nothing;

-- Sources the old evidence_sources citations name, where the source still exists.
insert into public.issue_sources (issue_id, source_id, workspace_id)
  select distinct i.id, s.id, i.workspace_id
  from public.issues i
  cross join lateral jsonb_array_elements(i.evidence_sources) as e(value)
  join public.sources s on s.workspace_id = i.workspace_id
    and jsonb_typeof(e.value) = 'object'
    and (e.value ->> 'source_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and s.id = (e.value ->> 'source_id')::uuid
  on conflict do nothing;

-- Their history so far: created, and resolved for the closed ones. (actor: the creator; the resolver isn't recorded.)
insert into public.issue_events (issue_id, workspace_id, kind, at, actor, detail, tx)
  select id, workspace_id, 'created', created_at, created_by,
    jsonb_build_object('status', private.issue_ui_status(status, resolution), 'migrated', true), null
  from public.issues where status <> 'dismissed';
insert into public.issue_events (issue_id, workspace_id, kind, at, actor, detail, tx)
  select id, workspace_id, 'resolved', resolved_at, null, jsonb_build_object('to', private.issue_ui_status(status, resolution), 'migrated', true), null
  from public.issues where status = 'done' and resolved_at is not null;

-- ---------------------------------------------------------------------------
-- Triggers on issues and the link tables, now the data is in
-- ---------------------------------------------------------------------------

-- Fires after the existing `issues_before_write` (triggers run in name order).
create trigger issues_number before insert or update on public.issues
  for each row execute function private.issues_v2_before_write();

create trigger issue_log after insert on public.issue_links
  for each row execute function private.log_issue_link_change('steps');
create trigger issue_log_delete after delete on public.issue_links
  for each row execute function private.log_issue_link_change('steps');
create trigger issue_log after insert on public.issue_owners
  for each row execute function private.log_issue_link_change('owners');
create trigger issue_log_delete after delete on public.issue_owners
  for each row execute function private.log_issue_link_change('owners');
create trigger issue_log after insert on public.issue_sources
  for each row execute function private.log_issue_link_change('sources');
create trigger issue_log_delete after delete on public.issue_sources
  for each row execute function private.log_issue_link_change('sources');

-- An issue inserted any way other than save_issue (a perception gap `log_perception_gaps` logs, a direct insert, the
-- seed) still gets the link and owner rows its `process_id`, `step_id` and `owner_person_id` say, when it has none.
create function private.seed_issue_links() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.process_id is not null or new.step_id is not null)
     and not exists (select 1 from public.issue_links where issue_id = new.id) then
    insert into public.issue_links (issue_id, workspace_id, process_id, step_id)
      values (
        new.id, new.workspace_id,
        coalesce(new.process_id, (select s.process_id from public.steps s where s.id = new.step_id and s.workspace_id = new.workspace_id limit 1)),
        new.step_id)
      on conflict do nothing;
  end if;
  if new.owner_person_id is not null and not exists (select 1 from public.issue_owners where issue_id = new.id) then
    insert into public.issue_owners (issue_id, person_id, workspace_id) values (new.id, new.owner_person_id, new.workspace_id) on conflict do nothing;
  end if;
  return null;
end;
$$;
revoke all on function private.seed_issue_links() from public, anon, authenticated;

-- Named to run after `issue_log`, so the issue's `created` entry is there for the links to be added to.
create trigger issue_seed_links after insert on public.issues
  for each row execute function private.seed_issue_links();

-- MCP writes are audited like the peers (steps, edges, sources, scenarios, issues).
create trigger audit_mcp after insert or update or delete on public.issue_links
  for each row execute function private.audit_mcp_write();
create trigger audit_mcp after insert or update or delete on public.issue_owners
  for each row execute function private.audit_mcp_write();
create trigger audit_mcp after insert or update or delete on public.issue_sources
  for each row execute function private.audit_mcp_write();

-- ---------------------------------------------------------------------------
-- Row-level security: the issues policies, for every new table
-- ---------------------------------------------------------------------------

-- Everyone in the workspace reads; editors, owners and agency admins change what an issue links to (not the rows
-- of a detected issue, which are the engine's). Nobody writes the history through the API.
alter table public.issue_links enable row level security;
alter table public.issue_owners enable row level security;
alter table public.issue_sources enable row level security;
alter table public.issue_events enable row level security;

create policy "read issue_links" on public.issue_links for select to authenticated using (public.can_read_workspace(workspace_id));
create policy "read issue_owners" on public.issue_owners for select to authenticated using (public.can_read_workspace(workspace_id));
create policy "read issue_sources" on public.issue_sources for select to authenticated using (public.can_read_workspace(workspace_id));
create policy "read issue_events" on public.issue_events for select to authenticated using (public.can_read_workspace(workspace_id));

create policy "insert issue_links" on public.issue_links for insert to authenticated
  with check (public.can_edit_workspace(workspace_id)
    and not exists (select 1 from public.issues i where i.id = issue_id and i.source = 'detected'));
create policy "delete issue_links" on public.issue_links for delete to authenticated
  using (public.can_edit_workspace(workspace_id)
    and not exists (select 1 from public.issues i where i.id = issue_id and i.source = 'detected'));
create policy "insert issue_owners" on public.issue_owners for insert to authenticated
  with check (public.can_edit_workspace(workspace_id)
    and not exists (select 1 from public.issues i where i.id = issue_id and i.source = 'detected'));
create policy "delete issue_owners" on public.issue_owners for delete to authenticated
  using (public.can_edit_workspace(workspace_id)
    and not exists (select 1 from public.issues i where i.id = issue_id and i.source = 'detected'));
create policy "insert issue_sources" on public.issue_sources for insert to authenticated
  with check (public.can_edit_workspace(workspace_id)
    and not exists (select 1 from public.issues i where i.id = issue_id and i.source = 'detected'));
create policy "delete issue_sources" on public.issue_sources for delete to authenticated
  using (public.can_edit_workspace(workspace_id)
    and not exists (select 1 from public.issues i where i.id = issue_id and i.source = 'detected'));

grant select, insert, delete on public.issue_links, public.issue_owners, public.issue_sources to authenticated;
grant select on public.issue_events to authenticated;
revoke all on public.issue_links, public.issue_owners, public.issue_sources, public.issue_events from anon;

-- ---------------------------------------------------------------------------
-- save_issue: create or edit an issue with its links, owners and sources, in one transaction
-- ---------------------------------------------------------------------------

-- p_id null (or left out) creates; otherwise edits that issue. Everything after p_fields is optional, so a client that
-- names its arguments (PostgREST) can leave out what it doesn't set. p_fields holds only the columns to set (the
-- allow-list below). `status` takes the names as shown (open, testing, resolved, wont_fix, dismissed) or the stored ones,
-- and the function stores the stored spelling and the resolution. `dismissed` is only for a row that carries a detection
-- key. p_links is [{"process_id": uuid|null, "step_id": uuid|null}, ...]: whole process (no step) or steps, not both,
-- and each step must be a step of that process in this workspace (a step with no process named takes its own).
-- p_owners and p_sources are arrays of ids. For all three, null leaves the existing set alone and an array replaces it
-- (only the differences are written, so an unchanged save writes no history). Returns the issue row. Security invoker:
-- row-level security applies to every write, and the caller must be able to edit the workspace (checked first, so a
-- viewer's save fails loudly instead of changing nothing).
create function public.save_issue(
  p_workspace uuid, p_fields jsonb, p_id uuid default null, p_links jsonb default null, p_owners uuid[] default null, p_sources uuid[] default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  settable constant text[] := array['title', 'type', 'severity', 'evidence', 'status', 'scenario_id', 'role_id', 'person_id',
    'client_id', 'target_measure', 'target_now', 'target_goal', 'dismissed_revision_id'];
  creatable constant text[] := array['source', 'detected_key', 'evidence_metrics'];
  field text;
  cols text;
  v_issue uuid := p_id;
  v_links jsonb;
  st text;
  key_known boolean;
  lk record;
  step_process uuid;
  first_link record;
  result jsonb;
begin
  if jsonb_typeof(p_fields) is distinct from 'object' then
    raise exception 'save_issue: fields must be an object' using errcode = '22023';
  end if;
  if not coalesce(public.can_edit_workspace(p_workspace), false) then
    raise exception 'save_issue: you cannot change issues in this workspace' using errcode = '42501';
  end if;
  for field in select jsonb_object_keys(p_fields) loop
    if not (field = any (settable) or (p_id is null and field = any (creatable))) then
      raise exception 'save_issue: % cannot be set', field using errcode = '42501';
    end if;
  end loop;
  if p_links is not null and jsonb_typeof(p_links) <> 'array' then
    raise exception 'save_issue: links must be an array' using errcode = '22023';
  end if;

  if p_id is null then
    if not p_fields ? 'title' then
      raise exception 'save_issue: a title is required' using errcode = '22023';
    end if;
    -- An issue logged without a type is an audit finding.
    if not p_fields ? 'type' then
      p_fields := p_fields || '{"type": "manual"}';
    end if;
  elsif not exists (select 1 from public.issues where id = p_id and workspace_id = p_workspace) then
    raise exception 'save_issue: no such issue' using errcode = '42501';
  end if;

  -- Statuses as shown are stored as the older spellings plus a resolution.
  if p_fields ? 'status' then
    st := p_fields ->> 'status';
    if st = 'dismissed' then
      key_known := case when p_id is null then (p_fields ->> 'detected_key') is not null
        else (select detected_key is not null from public.issues where id = p_id) end;
      if not coalesce(key_known, false) then
        raise exception 'save_issue: only an insight can be dismissed' using errcode = '22023';
      end if;
      -- An issue someone acknowledged (it has a number) is not dismissed again: only an insight still dismissed, or one
      -- that never became an issue, can be.
      if p_id is not null and not exists (select 1 from public.issues where id = p_id and (status = 'dismissed' or number is null)) then
        raise exception 'save_issue: an acknowledged issue cannot be dismissed' using errcode = '22023';
      end if;
    end if;
    p_fields := p_fields || case st
      when 'testing' then '{"status": "in_progress", "resolution": null}'::jsonb
      when 'resolved' then '{"status": "done", "resolution": null}'::jsonb
      when 'wont_fix' then '{"status": "done", "resolution": "wont_fix"}'::jsonb
      else jsonb_build_object('status', st, 'resolution', null)
    end;
  end if;

  -- What it touches: whole process or steps, never both, and every step a step of that process in this workspace.
  if p_links is not null then
    if exists (select 1 from jsonb_array_elements(p_links) e where (e ->> 'step_id') is null)
       and exists (select 1 from jsonb_array_elements(p_links) e where (e ->> 'step_id') is not null) then
      raise exception 'save_issue: link the whole process or pick steps, not both' using errcode = '22023';
    end if;
    v_links := '[]'::jsonb;
    for lk in select (e.v ->> 'process_id')::uuid as process_id, (e.v ->> 'step_id')::uuid as step_id
             from jsonb_array_elements(p_links) with ordinality as e(v, ord) order by e.ord loop
      if lk.process_id is null and lk.step_id is null then
        raise exception 'save_issue: a link needs a process or a step' using errcode = '22023';
      end if;
      step_process := lk.process_id;
      if lk.step_id is not null then
        select s.process_id into step_process from public.steps s
          where s.id = lk.step_id and s.workspace_id = p_workspace and (lk.process_id is null or s.process_id = lk.process_id) limit 1;
        if step_process is null then
          raise exception 'save_issue: step % is not a step of that process in this workspace', lk.step_id using errcode = '22023';
        end if;
      end if;
      -- The same link given twice is one link.
      if not v_links @> jsonb_build_array(jsonb_build_object('process_id', step_process, 'step_id', lk.step_id)) then
        v_links := v_links || jsonb_build_array(jsonb_build_object('process_id', step_process, 'step_id', lk.step_id));
      end if;
    end loop;
  end if;

  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(p_fields) as k;

  if p_id is null then
    execute format(
      'insert into public.issues (workspace_id, %1$s) select $1, %1$s from jsonb_populate_record(null::public.issues, $2) returning id',
      cols)
    into v_issue using p_workspace, p_fields;
  elsif cols is not null then
    execute format(
      'update public.issues set (%1$s) = (select %1$s from jsonb_populate_record(null::public.issues, $3)) where id = $1 and workspace_id = $2',
      cols)
    using p_id, p_workspace, p_fields;
  end if;

  if v_links is not null then
    delete from public.issue_links l where l.issue_id = v_issue and not exists (
      select 1 from jsonb_to_recordset(v_links) as n(process_id uuid, step_id uuid)
      where n.process_id is not distinct from l.process_id and n.step_id is not distinct from l.step_id);
    insert into public.issue_links (issue_id, workspace_id, process_id, step_id)
      select v_issue, p_workspace, n.process_id, n.step_id
      from jsonb_to_recordset(v_links) as n(process_id uuid, step_id uuid)
      where not exists (select 1 from public.issue_links l where l.issue_id = v_issue
        and l.process_id is not distinct from n.process_id and l.step_id is not distinct from n.step_id);
    -- The compatibility columns: the first link given.
    select (e.v ->> 'process_id')::uuid as process_id, (e.v ->> 'step_id')::uuid as step_id into first_link
      from jsonb_array_elements(v_links) with ordinality as e(v, ord) order by e.ord limit 1;
    update public.issues set process_id = first_link.process_id, step_id = first_link.step_id where id = v_issue;
  end if;

  if p_owners is not null then
    delete from public.issue_owners o where o.issue_id = v_issue and not (o.person_id = any (p_owners));
    insert into public.issue_owners (issue_id, person_id, workspace_id)
      select v_issue, p, p_workspace from (select distinct unnest(p_owners) as p) u on conflict do nothing;
    update public.issues set owner_person_id = p_owners[1] where id = v_issue;
  end if;

  if p_sources is not null then
    delete from public.issue_sources s where s.issue_id = v_issue and not (s.source_id = any (p_sources));
    insert into public.issue_sources (issue_id, source_id, workspace_id)
      select v_issue, p, p_workspace from (select distinct unnest(p_sources) as p) u on conflict do nothing;
  end if;

  select to_jsonb(i) into result from public.issues i where i.id = v_issue;
  return result;
end;
$$;

revoke all on function public.save_issue(uuid, jsonb, uuid, jsonb, uuid[], uuid[]) from public, anon;
grant execute on function public.save_issue(uuid, jsonb, uuid, jsonb, uuid[], uuid[]) to authenticated;
