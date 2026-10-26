-- Named people as resources (docs/PRD.md §5, §6.3.3). People are modelled for
-- capacity, not performance: no efficiency is exposed yet (§6.3.7).

create table public.people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  email text,
  fte numeric not null default 1 check (fte > 0 and fte <= 1.5),
  -- Null means fte × the workspace's hours per week.
  capacity_hours_week numeric check (capacity_hours_week > 0),
  cost_rate numeric check (cost_rate >= 0),
  active boolean not null default true,
  start_date date,
  end_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (id, workspace_id),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table public.person_roles (
  person_id uuid not null,
  role_id uuid not null,
  workspace_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (person_id, role_id),
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade,
  foreign key (role_id, workspace_id) references public.roles (id, workspace_id) on delete cascade
);

-- Steps a person can perform. A person with no rows here can do every step of their roles.
create table public.person_skills (
  person_id uuid not null,
  step_id uuid not null,
  workspace_id uuid not null,
  -- Capacity factor (off by default per workspace; §6.3.7). Not used by the engine yet.
  efficiency numeric not null default 1 check (efficiency > 0),
  provenance jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (person_id, step_id),
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade
);

create table public.person_leave (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null,
  workspace_id uuid not null,
  start_date date not null,
  end_date date not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  foreign key (person_id, workspace_id) references public.people (id, workspace_id) on delete cascade,
  check (end_date >= start_date)
);

-- Pinned assignee on a step.
alter table public.steps
  add foreign key (person_id, workspace_id) references public.people (id, workspace_id);

create index on public.people (workspace_id);
create index on public.person_roles (workspace_id);
create index on public.person_skills (workspace_id);
create index on public.person_leave (person_id);

create trigger set_updated_at before update on public.people for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.person_leave for each row execute function public.set_updated_at();

alter table public.people enable row level security;
alter table public.person_roles enable row level security;
alter table public.person_skills enable row level security;
alter table public.person_leave enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['people', 'person_roles', 'person_skills', 'person_leave'] loop
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

grant select, insert, update, delete on public.people, public.person_roles, public.person_skills, public.person_leave to authenticated;
revoke all on public.people, public.person_roles, public.person_skills, public.person_leave from anon;
