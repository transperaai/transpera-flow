-- Walking skeleton schema (docs/PRD.md §5, §10): workspaces, memberships and
-- the tables needed to load and simulate a process. Every table carries
-- workspace_id and is protected by row-level security.

-- ---------------------------------------------------------------------------
-- Types and helpers
-- ---------------------------------------------------------------------------

create type public.membership_role as enum ('agency_admin', 'owner', 'editor', 'member', 'viewer');

create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  plan text not null default 'agency',
  -- hours_per_week, horizon_weeks, currency, ... Interim demand fields
  -- (leads_per_week, active_clients, churn_monthly, retainer) live here until
  -- lead sources, services and the client roster land.
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.membership_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (workspace_id, user_id)
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  color text,
  default_cost_rate numeric not null default 0 check (default_cost_rate >= 0),
  -- Interim until named people replace head-counts.
  headcount integer not null default 1 check (headcount >= 0),
  -- Interim until the client roster and servicing processes land.
  ongoing_hours_per_client_week numeric not null default 0 check (ongoing_hours_per_client_week >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id)
);

create table public.processes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  kind text not null default 'pipeline' check (kind in ('pipeline', 'servicing')),
  entity_name text not null default 'item',
  description text,
  live_revision_id uuid,
  draft_revision_id uuid,
  source text not null default 'manual' check (source in ('manual', 'template', 'mcp', 'import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id)
);

create table public.process_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  process_id uuid not null,
  number integer not null check (number > 0),
  status text not null default 'draft' check (status in ('draft', 'published', 'superseded')),
  layout jsonb not null default '{}',
  published_at timestamptz,
  published_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (process_id, number),
  unique (id, workspace_id),
  foreign key (process_id, workspace_id) references public.processes (id, workspace_id) on delete cascade
);

alter table public.processes
  add foreign key (live_revision_id) references public.process_revisions (id) on delete set null deferrable initially deferred,
  add foreign key (draft_revision_id) references public.process_revisions (id) on delete set null deferrable initially deferred;

-- Step ids are stable across revisions, so the key is (revision_id, id).
create table public.steps (
  id uuid not null default gen_random_uuid(),
  revision_id uuid not null,
  workspace_id uuid not null,
  process_id uuid not null,
  name text not null,
  kind text not null default 'task' check (kind in ('task', 'wait', 'decision', 'subprocess', 'start', 'end')),
  outcome text check (outcome in ('won', 'lost', 'done')),
  role_id uuid,
  person_id uuid,
  work_hours numeric not null default 0 check (work_hours >= 0),
  work_dist text not null default 'lognormal' check (work_dist in ('constant', 'triangular', 'lognormal')),
  work_params jsonb not null default '{}',
  wait_hours numeric not null default 0 check (wait_hours >= 0),
  wait_dist text not null default 'lognormal' check (wait_dist in ('constant', 'triangular', 'lognormal')),
  wait_params jsonb not null default '{}',
  rework_rate numeric not null default 0 check (rework_rate >= 0 and rework_rate <= 1),
  rework_to_step_id uuid,
  tool text,
  notes text,
  sla_hours numeric check (sla_hours >= 0),
  current_wip integer check (current_wip >= 0),
  cost_override numeric,
  x numeric not null default 0,
  y numeric not null default 0,
  provenance jsonb not null default '{}',
  assumption boolean not null default false,
  conflict boolean not null default false,
  replaced_by uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  primary key (revision_id, id),
  foreign key (revision_id, workspace_id) references public.process_revisions (id, workspace_id) on delete cascade,
  foreign key (role_id, workspace_id) references public.roles (id, workspace_id),
  check ((kind = 'end') = (outcome is not null))
);

create table public.edges (
  id uuid not null default gen_random_uuid(),
  revision_id uuid not null,
  workspace_id uuid not null,
  process_id uuid not null,
  from_step_id uuid not null,
  to_step_id uuid not null,
  probability numeric not null default 1 check (probability >= 0 and probability <= 1),
  condition_tag text,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  primary key (revision_id, id),
  foreign key (revision_id, workspace_id) references public.process_revisions (id, workspace_id) on delete cascade,
  foreign key (revision_id, from_step_id) references public.steps (revision_id, id) on delete cascade,
  foreign key (revision_id, to_step_id) references public.steps (revision_id, id) on delete cascade
);

create index on public.memberships (user_id);
create index on public.roles (workspace_id);
create index on public.processes (workspace_id);
create index on public.process_revisions (process_id);
create index on public.steps (workspace_id);
create index on public.edges (workspace_id);

create trigger set_updated_at before update on public.workspaces for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.memberships for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.roles for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.processes for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.process_revisions for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.steps for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.edges for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Access helpers. Agency admins are marked by an `agency_admin` flag in the
-- user's app_metadata (only settable with the service role) and see every
-- workspace; everyone else needs a membership.
-- ---------------------------------------------------------------------------

create function public.is_agency_admin() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'agency_admin')::boolean, false);
$$;

create function public.workspace_role(ws uuid) returns public.membership_role
language sql stable security definer
set search_path = ''
as $$
  select m.role from public.memberships m where m.workspace_id = ws and m.user_id = auth.uid();
$$;

create function public.can_read_workspace(ws uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select public.is_agency_admin() or public.workspace_role(ws) is not null;
$$;

create function public.can_edit_workspace(ws uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select public.is_agency_admin() or public.workspace_role(ws) in ('agency_admin', 'owner', 'editor');
$$;

create function public.can_manage_workspace(ws uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select public.is_agency_admin() or public.workspace_role(ws) in ('agency_admin', 'owner');
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.roles enable row level security;
alter table public.processes enable row level security;
alter table public.process_revisions enable row level security;
alter table public.steps enable row level security;
alter table public.edges enable row level security;

create policy "read workspaces" on public.workspaces for select to authenticated
  using (public.can_read_workspace(id));
create policy "create workspaces" on public.workspaces for insert to authenticated
  with check (public.is_agency_admin());
create policy "update workspaces" on public.workspaces for update to authenticated
  using (public.can_manage_workspace(id)) with check (public.can_manage_workspace(id));
create policy "delete workspaces" on public.workspaces for delete to authenticated
  using (public.is_agency_admin());

create policy "read memberships" on public.memberships for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "manage memberships" on public.memberships for all to authenticated
  using (public.can_manage_workspace(workspace_id)) with check (public.can_manage_workspace(workspace_id));

do $$
declare
  t text;
begin
  foreach t in array array['roles', 'processes', 'process_revisions', 'steps', 'edges'] loop
    execute format(
      'create policy "read %1$s" on public.%1$I for select to authenticated using (public.can_read_workspace(workspace_id))', t);
    execute format(
      'create policy "insert %1$s" on public.%1$I for insert to authenticated with check (public.can_edit_workspace(workspace_id))', t);
    execute format(
      'create policy "update %1$s" on public.%1$I for update to authenticated using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id))', t);
    execute format(
      'create policy "delete %1$s" on public.%1$I for delete to authenticated using (public.can_edit_workspace(workspace_id))', t);
  end loop;
end;
$$;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;
