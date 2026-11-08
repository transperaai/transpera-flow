-- Copperleaf Marketing (QA): the fictional agency for the timed extraction run
-- (issue #27; docs/extraction/qa/README.md). It adds one workspace and touches
-- nothing else. It stops with an error, changing nothing, if the slug
-- `copperleaf-qa` already exists. Every Owner gets an owner
-- (Agency admin) membership so the workspace shows in their list.
--
-- Run it once in the Supabase SQL editor. To remove the workspace again, or to
-- start over, run reset-workspace.sql first.

begin;

do $$
declare
  ws uuid;
  r_md uuid; r_ad uuid; r_pm uuid; r_fin uuid;
  p_grace uuid; p_tom uuid; p_ellie uuid; p_kofi uuid; p_nadia uuid;
  s_ppc uuid; s_social uuid;
  c_ashgrove uuid; c_brambleway uuid; c_corran uuid;
begin
  if exists (select 1 from public.workspaces where slug = 'copperleaf-qa') then
    raise exception 'The workspace copperleaf-qa already exists. Run reset-workspace.sql first if you want a fresh one.';
  end if;

  insert into public.workspaces (name, slug, settings)
  values ('Copperleaf Marketing (QA)', 'copperleaf-qa',
          -- The engine reads every key below (the same defaults as create_workspace).
          '{"hours_per_week": 37.5, "currency": "GBP", "horizon_weeks": 13, "overtime_cap": 0,
            "leads_per_week": 0, "active_clients": 0, "churn_monthly": 0, "retainer": 0}')
  returning id into ws;

  -- Four roles. There is deliberately no Designer role.
  insert into public.roles (workspace_id, name, headcount) values (ws, 'Managing director', 1) returning id into r_md;
  insert into public.roles (workspace_id, name, headcount) values (ws, 'Account director', 1) returning id into r_ad;
  insert into public.roles (workspace_id, name, headcount) values (ws, 'Paid media specialist', 2) returning id into r_pm;
  insert into public.roles (workspace_id, name, headcount) values (ws, 'Finance', 1) returning id into r_fin;

  insert into public.people (workspace_id, name, fte) values (ws, 'Grace Adeyemi', 1) returning id into p_grace;
  insert into public.people (workspace_id, name, fte) values (ws, 'Tom Whitfield', 1) returning id into p_tom;
  insert into public.people (workspace_id, name, fte) values (ws, 'Ellie Marsh', 1) returning id into p_ellie;
  insert into public.people (workspace_id, name, fte) values (ws, 'Kofi Mensah', 1) returning id into p_kofi;
  insert into public.people (workspace_id, name, fte) values (ws, 'Nadia Sharp', 1) returning id into p_nadia;
  insert into public.person_roles (person_id, role_id, workspace_id) values
    (p_grace, r_md, ws), (p_tom, r_ad, ws), (p_ellie, r_pm, ws), (p_kofi, r_pm, ws), (p_nadia, r_fin, ws);

  insert into public.services (workspace_id, name, pricing_model, price) values (ws, 'PPC management', 'retainer', 2800) returning id into s_ppc;
  insert into public.services (workspace_id, name, pricing_model, price) values (ws, 'Paid social', 'retainer', 2200) returning id into s_social;

  insert into public.clients (workspace_id, name, mrr) values (ws, 'Ashgrove Garden Centre', 3000) returning id into c_ashgrove;
  insert into public.clients (workspace_id, name, mrr) values (ws, 'Brambleway Farm Shop', 1800) returning id into c_brambleway;
  insert into public.clients (workspace_id, name, mrr) values (ws, 'Corran Physio', 2500) returning id into c_corran;
  insert into public.client_services (client_id, service_id, workspace_id) values
    (c_ashgrove, s_ppc, ws), (c_brambleway, s_social, ws), (c_corran, s_ppc, ws);
  insert into public.client_assignments (client_id, role_id, person_id, workspace_id) values
    (c_ashgrove, r_ad, p_tom, ws), (c_ashgrove, r_pm, p_ellie, ws);

  insert into public.lead_sources (workspace_id, name, volume_week) values (ws, 'Website enquiries', 6), (ws, 'Referrals', 1);
  insert into public.demand_settings (workspace_id, growth_monthly) values (ws, 0)
  on conflict (workspace_id) do update set growth_monthly = 0;

  insert into public.memberships (workspace_id, user_id, role)
  select ws, id, 'owner' from auth.users where (raw_app_meta_data ->> 'agency_admin')::boolean is true
  on conflict (workspace_id, user_id) do nothing;
end $$;

commit;
