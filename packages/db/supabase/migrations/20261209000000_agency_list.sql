-- Agency workspace list, and editors change the Client health rules (issue #30, B1 part 3 of 3; docs/plans/b1-brief.md).
--
-- Strictly additive: one table and two functions. Nothing existing is changed. `save_fields`, the `workspaces` update policy
-- and every grant on an existing table stay exactly as they are.
--
--   * `public.workspace_headlines`: one row per workspace holding the headline numbers the agency list shows (flow
--     efficiency, processes needing attention, client groups at risk). The Overview computes them from its simulation run and
--     an editor's browser records them (`recordHeadline`); the list only reads them. Every reader of the workspace reads the
--     row; owners and editors insert and update it; nobody deletes (it goes with its workspace).
--   * `public.agency_workspace_list()` (SECURITY INVOKER, stable): one row per workspace the caller can read, with its open
--     Operational risk issues, its last activity and its stored headline numbers. RLS decides which workspaces and rows the
--     caller sees; `audit_log` is manage-only, so a caller who doesn't manage gets "last activity" without it.
--   * `public.save_health_rules(ws, base, changes)` (SECURITY DEFINER, empty search_path): owners AND editors save the four
--     Client health rules (`settings.health_initial`, `health_recover`, `health_late_penalty`, `health_missed_penalty`; each a
--     number 0 to 100, or null for the estimated default). Today these save through `save_fields('workspaces', ...)`, whose
--     update runs under the manage-only `update workspaces` policy, so an editor gets `not_found`. This function checks
--     `can_edit_workspace` itself and can write nothing but those four keys: any other key is refused (42501), so the name,
--     the currency and every other setting stay owner-only (Q9: widening the list later is one line here). It applies
--     `save_fields`' per-key rule (20261111000000): stored differs from base and from the new value -> a conflict, nothing
--     written for that key; stored differs from the new value -> patch; else nothing. The UPDATE still fires the workspaces
--     triggers: `stamp_settings_provenance` marks `settings.<key>` entered by `auth.uid()`, `audit_company` logs the caller as
--     actor, and `needs_review` refuses an API token at trigger depth 1, so MCP still can't change the company model
--     directly (D19). `auth.uid()` and `auth.jwt()` read the request's claims inside a SECURITY DEFINER function.
--
-- Returns `{"status": "saved" | "conflict" | "not_found", "row": {"settings": {<the keys asked for>}}, "conflicts": {...}}`;
-- `not_found` is what `save_fields` returns under RLS for a caller who can't write, so the app's handling carries over.
-- Errors: 22023 (`changes` empty or not an object, `base` not an object, a key with no base value), 42501 (a key that is not
-- one of the four), 23514 (a value that is not null or a number from 0 to 100).
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`; each must return the stated result):
--   0. Rows 53 to 55 applied (20261206000000, 20261207000000, 20261207500000) and nothing of ours later than this. Expect
--      those three versions, plus 20261207700000 (#205) and 20261208000000 (C2 part 2) only if they were applied first:
--        select version from supabase_migrations.schema_migrations where version >= '20261206000000' order by 1;
--   1. Nothing created yet. Expect null, null, null:
--        select to_regclass('public.workspace_headlines'), to_regprocedure('public.agency_workspace_list()'),
--               to_regprocedure('public.save_health_rules(uuid, jsonb, jsonb)');
--   2. The workspaces triggers the health-rule function relies on exist and are enabled. Expect 3 rows, all 'O':
--        select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.workspaces'::regclass
--          and tgname in ('stamp_settings_provenance', 'audit_company', 'needs_review');
--   3. The update policy is still manage-only (why the function is needed). Expect qual can_manage_workspace(id):
--        select qual from pg_policies where tablename = 'workspaces' and policyname = 'update workspaces';
--   4. The three helpers the table's policies call exist. Expect 3 rows:
--        select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
--          and proname in ('can_read_workspace', 'can_edit_workspace', 'set_updated_at');
--
-- POST-APPLY CHECK:
--   1. RLS on, and three policies on the table. Expect t, 3:
--        select relrowsecurity from pg_class where oid = 'public.workspace_headlines'::regclass;
--        select count(*) from pg_policies where schemaname = 'public' and tablename = 'workspace_headlines';
--   2. anon holds nothing on the table or either function; authenticated has SELECT, INSERT, UPDATE only. Expect no anon
--      rows, then f, f, t, t:
--        select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public'
--          and table_name = 'workspace_headlines' and grantee in ('anon', 'authenticated') order by 1, 2;
--        select has_function_privilege('anon', 'public.agency_workspace_list()', 'execute'),
--               has_function_privilege('anon', 'public.save_health_rules(uuid, jsonb, jsonb)', 'execute'),
--               has_function_privilege('authenticated', 'public.agency_workspace_list()', 'execute'),
--               has_function_privilege('authenticated', 'public.save_health_rules(uuid, jsonb, jsonb)', 'execute');
--   3. `save_health_rules` is SECURITY DEFINER with an empty search_path; `agency_workspace_list` is not (both have an empty search_path). Expect
--      (agency_workspace_list, f, {search_path=""}), (save_health_rules, t, {search_path=""}):
--        select proname, prosecdef, proconfig from pg_proc where proname in ('save_health_rules', 'agency_workspace_list')
--          and pronamespace = 'public'::regnamespace order by 1;
--   4. Then, on the real project: as an editor, change "Task on time" on Settings -> Client health, and check the change shows
--      in the owner's change log.
--
-- ROLLBACK (one transaction; nothing existing was changed, so nothing to put back):
--
--   begin;
--   drop function if exists public.save_health_rules(uuid, jsonb, jsonb);
--   drop function if exists public.agency_workspace_list();
--   drop table if exists public.workspace_headlines;
--   delete from supabase_migrations.schema_migrations where version = '20261209000000';
--   commit;

-- ---------------------------------------------------------------------------
-- Headline numbers per workspace
-- ---------------------------------------------------------------------------

create table public.workspace_headlines (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  computed_at timestamptz not null default now(),
  computed_by uuid references auth.users (id) on delete set null default auth.uid(),
  -- What the numbers were computed from: the engine, the published revisions of every process, and the horizon.
  engine_version text not null,
  revision_ids uuid[] not null,
  horizon_weeks integer not null check (horizon_weeks > 0),
  -- {"flow_efficiency": 0..1 or null, "processes_attention": n, "processes_total": n, "client_groups_at_risk": n,
  --  "client_groups_total": n}, the counts non-negative integers. The CASEs keep a wrong type a check failure (23514), not a
  -- cast error.
  numbers jsonb not null,
  constraint workspace_headlines_numbers check (
    jsonb_typeof(numbers) = 'object'
    and numbers ?& array['flow_efficiency', 'processes_attention', 'processes_total', 'client_groups_at_risk', 'client_groups_total']
    and case jsonb_typeof(numbers -> 'flow_efficiency')
      when 'null' then true
      when 'number' then (numbers ->> 'flow_efficiency')::numeric between 0 and 1
      else false
    end
    and case jsonb_typeof(numbers -> 'processes_attention')
      when 'number' then (numbers ->> 'processes_attention')::numeric >= 0
        and (numbers ->> 'processes_attention')::numeric = trunc((numbers ->> 'processes_attention')::numeric)
      else false
    end
    and case jsonb_typeof(numbers -> 'processes_total')
      when 'number' then (numbers ->> 'processes_total')::numeric >= 0
        and (numbers ->> 'processes_total')::numeric = trunc((numbers ->> 'processes_total')::numeric)
      else false
    end
    and case jsonb_typeof(numbers -> 'client_groups_at_risk')
      when 'number' then (numbers ->> 'client_groups_at_risk')::numeric >= 0
        and (numbers ->> 'client_groups_at_risk')::numeric = trunc((numbers ->> 'client_groups_at_risk')::numeric)
      else false
    end
    and case jsonb_typeof(numbers -> 'client_groups_total')
      when 'number' then (numbers ->> 'client_groups_total')::numeric >= 0
        and (numbers ->> 'client_groups_total')::numeric = trunc((numbers ->> 'client_groups_total')::numeric)
      else false
    end
  )
);

alter table public.workspace_headlines enable row level security;

create policy "read workspace headlines" on public.workspace_headlines for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert workspace headlines" on public.workspace_headlines for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update workspace headlines" on public.workspace_headlines for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));

-- Supabase gives a new table every right to anon and authenticated: take them all back, then grant what the policies use.
revoke all on public.workspace_headlines from anon, authenticated;
grant select, insert, update on public.workspace_headlines to authenticated;

-- ---------------------------------------------------------------------------
-- The agency's list of workspaces
-- ---------------------------------------------------------------------------

create function public.agency_workspace_list() returns table (
  id uuid,
  name text,
  slug text,
  open_risk_issues bigint,
  last_activity timestamptz,
  numbers jsonb,
  computed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    w.id,
    w.name,
    w.slug,
    (select count(*) from public.issues i
      where i.workspace_id = w.id and i.severity = 'critical' and i.status in ('open', 'in_progress')),
    -- greatest() ignores nulls; null only when the workspace has no activity at all.
    greatest(
      (select max(greatest(r.updated_at, r.created_at)) from public.process_revisions r where r.workspace_id = w.id),
      (select max(greatest(i.updated_at, i.created_at)) from public.issues i where i.workspace_id = w.id),
      (select max(greatest(f.updated_at, f.created_at)) from public.findings f where f.workspace_id = w.id),
      (select max(greatest(s.updated_at, s.created_at)) from public.sources s where s.workspace_id = w.id),
      (select max(greatest(o.updated_at, o.created_at)) from public.solutions o where o.workspace_id = w.id),
      (select max(a.created_at) from public.audit_log a where a.workspace_id = w.id)
    ),
    h.numbers,
    h.computed_at
  from public.workspaces w
  left join public.workspace_headlines h on h.workspace_id = w.id
  where public.can_read_workspace(w.id)
  order by w.name, w.id;
$$;

revoke execute on function public.agency_workspace_list() from public, anon;
grant execute on function public.agency_workspace_list() to authenticated;

-- ---------------------------------------------------------------------------
-- Editors change the Client health rules
-- ---------------------------------------------------------------------------

create function public.save_health_rules(ws uuid, base jsonb, changes jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed constant text[] := array['health_initial', 'health_recover', 'health_late_penalty', 'health_missed_penalty'];
  k text;
  v jsonb;
  stored jsonb;
  theirs jsonb;
  seen jsonb;
  patch jsonb := '{}';
  conflicts jsonb := '{}';
  result jsonb := '{}';
begin
  if base is null or jsonb_typeof(base) <> 'object' then
    raise exception 'save_health_rules: base must be a json object' using errcode = '22023';
  end if;
  if changes is null or jsonb_typeof(changes) <> 'object' or changes = '{}' then
    raise exception 'save_health_rules: changes must be a non-empty json object' using errcode = '22023';
  end if;

  for k, v in select * from jsonb_each(changes) loop
    if not (k = any (allowed)) then
      raise exception 'save_health_rules: % cannot be saved', k using errcode = '42501';
    end if;
    if not base ? k then
      raise exception 'save_health_rules: % has no base value', k using errcode = '22023';
    end if;
    if not (jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric between 0 and 100)) then
      raise exception 'save_health_rules: % must be null or a number from 0 to 100', k using errcode = '23514';
    end if;
  end loop;

  -- The same answer save_fields gives under RLS to a caller who can't write.
  if ws is null or not coalesce(public.can_edit_workspace(ws), false) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select w.settings into stored from public.workspaces w where w.id = ws for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  stored := coalesce(stored, '{}');

  for k, v in select * from jsonb_each(changes) loop
    seen := base -> k;
    theirs := coalesce(stored -> k, 'null');
    if theirs is distinct from seen and theirs is distinct from v then
      conflicts := conflicts || jsonb_build_object(k, theirs);
    elsif theirs is distinct from v then
      patch := patch || jsonb_build_object(k, v);
    end if;
  end loop;

  if patch <> '{}' then
    update public.workspaces w set settings = coalesce(w.settings, '{}') || patch where w.id = ws returning w.settings into stored;
  end if;

  for k in select jsonb_object_keys(changes) loop
    result := result || jsonb_build_object(k, coalesce(stored -> k, 'null'));
  end loop;

  return jsonb_build_object(
    'status', case when conflicts <> '{}' then 'conflict' else 'saved' end,
    'row', jsonb_build_object('settings', result),
    'conflicts', conflicts);
end;
$$;

revoke execute on function public.save_health_rules(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_health_rules(uuid, jsonb, jsonb) to authenticated;
