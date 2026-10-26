-- Workspace access without invitations (issue #51, docs/adr/0003-workspace-access.md).
--
-- Each workspace lists allowed email domains and pre-assigned email -> role
-- entries. After every sign-in the app calls public.resolve_my_access(), which
-- reconciles the caller's memberships:
--   1. a pre-assigned email gets exactly that role;
--   2. otherwise a managed Google account whose hosted domain (`hd`) and
--      confirmed email both match an allowed domain joins as `member`;
--   3. otherwise nothing (the app shows a holding page).
-- Changes to the lists are applied to affected users straight away by
-- triggers, and every access change is written to audit_log.

-- ---------------------------------------------------------------------------
-- Memberships: where a membership came from, deactivation, person link
-- ---------------------------------------------------------------------------

alter table public.memberships
  -- manual: created by hand (e.g. make-agency-admin.sql); never touched by resolution.
  -- access_list: from a pre-assigned email; its role follows the list entry.
  -- domain: from an allowed domain; joins as member, can be promoted afterwards.
  add column source text not null default 'manual' check (source in ('manual', 'access_list', 'domain')),
  -- Inactive memberships grant nothing. Resolution never reactivates them.
  add column active boolean not null default true,
  add column person_id uuid,
  add foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete set null (person_id);

-- Only active memberships count.
create or replace function public.workspace_role(ws uuid) returns public.membership_role
language sql stable security definer
set search_path = ''
as $$
  select m.role from public.memberships m where m.workspace_id = ws and m.user_id = auth.uid() and m.active;
$$;

-- Owners manage memberships but cannot grant, change or remove agency_admin ones.
drop policy "manage memberships" on public.memberships;
create policy "insert memberships" on public.memberships for insert to authenticated
  with check (public.can_manage_workspace(workspace_id) and (role <> 'agency_admin' or public.is_agency_admin()));
create policy "update memberships" on public.memberships for update to authenticated
  using (public.can_manage_workspace(workspace_id) and (role <> 'agency_admin' or public.is_agency_admin()))
  with check (public.can_manage_workspace(workspace_id) and (role <> 'agency_admin' or public.is_agency_admin()));
create policy "delete memberships" on public.memberships for delete to authenticated
  using (public.can_manage_workspace(workspace_id) and (role <> 'agency_admin' or public.is_agency_admin()));

-- ---------------------------------------------------------------------------
-- Allowed domains and pre-assigned emails
-- ---------------------------------------------------------------------------

-- Consumer mail providers: anyone can get an address there, so they can never
-- be an allowed domain. Contractors on these go on the pre-assigned list.
create function public.is_free_mail_domain(domain text) returns boolean
language sql immutable
set search_path = ''
as $$
  select lower(domain) = any (array[
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk',
    'msn.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
    'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com',
    'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com',
    'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io', 'btinternet.com', 'sky.com', 'virginmedia.com',
    'bigpond.com', 'optusnet.com.au', 'comcast.net', 'verizon.net', 'att.net'
  ]);
$$;

create table public.workspace_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  domain text not null
    constraint workspace_domains_domain_format
      check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
    constraint workspace_domains_not_free_mail check (not public.is_free_mail_domain(domain)),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  -- A domain belongs to one company, so to at most one workspace.
  constraint workspace_domains_domain_key unique (domain)
);

create table public.workspace_access_emails (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null
    constraint workspace_access_emails_email_format check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- agency_admin comes from the JWT claim, not from a list.
  role public.membership_role not null default 'member'
    constraint workspace_access_emails_role_check check (role <> 'agency_admin'),
  person_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  constraint workspace_access_emails_workspace_email_key unique (workspace_id, email),
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete set null (person_id)
);

create index on public.workspace_domains (workspace_id);
create index on public.workspace_access_emails (email);
create trigger set_updated_at before update on public.workspace_access_emails
  for each row execute function public.set_updated_at();

alter table public.workspace_domains enable row level security;
alter table public.workspace_access_emails enable row level security;

-- Managed (and seen) by agency admins and the workspace's owners only.
do $$
declare
  t text;
begin
  foreach t in array array['workspace_domains', 'workspace_access_emails'] loop
    execute format(
      'create policy "read %1$s" on public.%1$I for select to authenticated using (public.can_manage_workspace(workspace_id))', t);
    execute format(
      'create policy "insert %1$s" on public.%1$I for insert to authenticated with check (public.can_manage_workspace(workspace_id))', t);
    execute format(
      'create policy "update %1$s" on public.%1$I for update to authenticated using (public.can_manage_workspace(workspace_id)) with check (public.can_manage_workspace(workspace_id))', t);
    execute format(
      'create policy "delete %1$s" on public.%1$I for delete to authenticated using (public.can_manage_workspace(workspace_id))', t);
  end loop;
end;
$$;

grant select, insert, update, delete on public.workspace_domains, public.workspace_access_emails to authenticated;
revoke all on public.workspace_domains, public.workspace_access_emails from anon;

-- ---------------------------------------------------------------------------
-- Audit log (docs/PRD.md §5)
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  -- No foreign keys: entries outlive the workspaces and users they mention.
  workspace_id uuid,
  actor_id uuid,
  actor_kind text not null default 'user' check (actor_kind in ('user', 'mcp', 'system')),
  action text not null,
  target_table text not null,
  target_id uuid,
  diff jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index on public.audit_log (workspace_id, created_at desc);

alter table public.audit_log enable row level security;
create policy "read audit_log" on public.audit_log for select to authenticated
  using (public.can_manage_workspace(workspace_id));
-- Written only by SECURITY DEFINER triggers; no client writes.
grant select on public.audit_log to authenticated;
revoke insert, update, delete, truncate on public.audit_log from authenticated;
revoke all on public.audit_log from anon;

-- Records inserts, updates and deletes on the access tables. Resolution sets
-- `transpera.actor_kind` to 'system' so automatic joins are told apart from
-- an owner's edits.
create function public.audit_access_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  row_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  row_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  target jsonb := coalesce(row_new, row_old);
  kind text := coalesce(nullif(current_setting('transpera.actor_kind', true), ''), 'user');
begin
  if tg_op = 'UPDATE' and row_old - 'updated_at' = row_new - 'updated_at' then
    return null;
  end if;
  insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
  values (
    (target ->> 'workspace_id')::uuid,
    auth.uid(),
    case when auth.uid() is null and kind = 'user' then 'system' else kind end,
    lower(tg_op),
    tg_table_name,
    (target ->> 'id')::uuid,
    jsonb_strip_nulls(jsonb_build_object('old', row_old, 'new', row_new))
  );
  return null;
end;
$$;

create trigger audit after insert or update or delete on public.memberships
  for each row execute function public.audit_access_change();
create trigger audit after insert or update or delete on public.workspace_domains
  for each row execute function public.audit_access_change();
create trigger audit after insert or update or delete on public.workspace_access_emails
  for each row execute function public.audit_access_change();

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- True when the user signed in with a Google account managed by `domain`:
-- the ID token's hosted-domain claim, which Supabase Auth stores as
-- identity_data.custom_claims.hd on the Google identity, equals the domain,
-- and so does the user's confirmed email. Personal Google accounts have no
-- `hd`, so they never qualify. auth.identities is written only by Supabase
-- Auth; user_metadata is editable by the user and must not be trusted here.
create function public.qualifies_for_domain(uid uuid, domain text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join auth.identities i on i.user_id = u.id and i.provider = 'google'
    where u.id = uid
      and u.email_confirmed_at is not null
      and lower(split_part(u.email, '@', 2)) = domain
      and lower(i.identity_data -> 'custom_claims' ->> 'hd') = domain
  );
$$;

-- Brings one user's memberships in line with the access lists. Idempotent.
-- Memberships with source 'manual' are never touched; inactive ones are never
-- reactivated.
create function public.reconcile_access(uid uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  user_email text;
begin
  select lower(u.email) into user_email from auth.users u where u.id = uid and u.email_confirmed_at is not null;

  -- 1. Pre-assigned email: exactly the listed role (takes over a domain membership).
  insert into public.memberships as m (workspace_id, user_id, role, source, person_id)
  select e.workspace_id, uid, e.role, 'access_list', e.person_id
  from public.workspace_access_emails e
  where user_email is not null and e.email = user_email
  on conflict (workspace_id, user_id) do update
    set role = excluded.role, source = 'access_list', person_id = coalesce(excluded.person_id, m.person_id)
    where m.source <> 'manual'
      and (m.role, m.source, m.person_id) is distinct from
          (excluded.role, 'access_list', coalesce(excluded.person_id, m.person_id));

  -- 2. Allowed domain: member, unless already a member some other way.
  insert into public.memberships (workspace_id, user_id, role, source)
  select d.workspace_id, uid, 'member', 'domain'
  from public.workspace_domains d
  where public.qualifies_for_domain(uid, d.domain)
  on conflict (workspace_id, user_id) do nothing;

  -- 3a. Dropped from the list but still on an allowed domain: back to member.
  update public.memberships m
  set source = 'domain', role = 'member'
  where m.user_id = uid and m.source = 'access_list'
    and not exists (
      select 1 from public.workspace_access_emails e
      where e.workspace_id = m.workspace_id and e.email = user_email)
    and exists (
      select 1 from public.workspace_domains d
      where d.workspace_id = m.workspace_id and public.qualifies_for_domain(uid, d.domain));

  -- 3b. No basis left: remove. Inactive domain memberships stay as a block.
  delete from public.memberships m
  where m.user_id = uid
    and (
      (m.source = 'access_list' and not exists (
        select 1 from public.workspace_access_emails e
        where e.workspace_id = m.workspace_id and e.email = user_email))
      or (m.source = 'domain' and m.active and not exists (
        select 1 from public.workspace_domains d
        where d.workspace_id = m.workspace_id and public.qualifies_for_domain(uid, d.domain)))
    );
end;
$$;

-- Called by the app after every sign-in (and when a signed-in user has no
-- workspace). Resolves the caller only, and returns their active memberships.
create function public.resolve_my_access()
returns table (workspace_id uuid, role public.membership_role, source text)
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  perform set_config('transpera.actor_kind', 'system', true);
  perform public.reconcile_access(uid);
  perform set_config('transpera.actor_kind', '', true);
  return query
    select m.workspace_id, m.role, m.source from public.memberships m where m.user_id = uid and m.active;
end;
$$;

-- List and domain edits apply to affected users immediately, so removal takes
-- effect on their next request rather than their next sign-in.
create function public.reconcile_after_access_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid;
  ws uuid := coalesce(case when tg_op <> 'DELETE' then new.workspace_id end, old.workspace_id);
begin
  if tg_table_name = 'workspace_access_emails' then
    for uid in
      select u.id from auth.users u
      where lower(u.email) in (
        case when tg_op <> 'DELETE' then new.email end,
        case when tg_op <> 'INSERT' then old.email end)
    loop
      perform public.reconcile_access(uid);
    end loop;
  else
    for uid in
      select u.id from auth.users u
      where lower(split_part(u.email, '@', 2)) in (
        case when tg_op <> 'DELETE' then new.domain end,
        case when tg_op <> 'INSERT' then old.domain end)
      union
      select m.user_id from public.memberships m where m.workspace_id = ws and m.source = 'domain'
    loop
      perform public.reconcile_access(uid);
    end loop;
  end if;
  return null;
end;
$$;

create trigger reconcile after insert or update or delete on public.workspace_access_emails
  for each row execute function public.reconcile_after_access_change();
create trigger reconcile after insert or update or delete on public.workspace_domains
  for each row execute function public.reconcile_after_access_change();

-- Members of a workspace with their email and last sign-in, for the Access
-- page. auth.users is not readable by clients, so this is SECURITY DEFINER
-- and returns nothing unless the caller manages the workspace.
create function public.workspace_members(ws uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  email text,
  role public.membership_role,
  source text,
  active boolean,
  person_id uuid,
  last_sign_in_at timestamptz,
  created_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  select m.id, m.user_id, u.email, m.role, m.source, m.active, m.person_id, u.last_sign_in_at, m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.workspace_id = ws and public.can_manage_workspace(ws)
  order by u.email;
$$;

-- Functions are executable by PUBLIC by default; expose only the two entry points.
revoke execute on function public.qualifies_for_domain(uuid, text) from public, anon, authenticated;
revoke execute on function public.reconcile_access(uuid) from public, anon, authenticated;
revoke execute on function public.resolve_my_access() from public, anon;
revoke execute on function public.workspace_members(uuid) from public, anon;
grant execute on function public.resolve_my_access() to authenticated;
grant execute on function public.workspace_members(uuid) to authenticated;
