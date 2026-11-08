-- Cost per month (docs/analysis-rules.md "Cost per month"; issue #108).
--
-- New workspaces default to AUD. `public.create_workspace` is redefined as a
-- copy of the 20261021000000 version whose default settings carry
-- "currency":"AUD" instead of "GBP". Existing workspaces keep their currency
-- (nothing here touches `workspaces` rows), and a caller can still pass any
-- three-letter code.
--
-- (The step setting "lost per day of waiting" that costs the waiting insight is
-- A42's column, `steps.lost_per_day_waiting`, in 20261110000000.)
--
-- Strictly additive: a function replaced by a copy that differs only in the
-- default currency.
--
-- Preflight (run each with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--
--   1. The function is the 20261021000000 one (it has the 'GBP' default). Expect 1 row:
--        select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--        where n.nspname='public' and p.proname='create_workspace' and pg_get_functiondef(p.oid) like '%"currency":"GBP"%';
--   2. This migration is not applied yet. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261113000000';
--
-- Rollback (run as one transaction):
--
--   begin;
--   -- Restore the GBP default: the same function with "currency":"GBP".
--   create or replace function public.create_workspace(ws_name text, ws_slug text, ws_settings jsonb default '{}')
--   returns uuid
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   declare
--     ws uuid;
--     k text;
--     defaults constant jsonb := '{"hours_per_week":40,"horizon_weeks":13,"currency":"GBP","leads_per_week":0,"active_clients":0,"churn_monthly":0,"retainer":0}';
--   begin
--     if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
--       raise exception 'Workspaces are created in the app' using errcode = '42501';
--     end if;
--     if auth.uid() is null or not public.is_agency_admin() then
--       raise exception 'Only agency admins can create workspaces' using errcode = '42501';
--     end if;
--     if ws_name is null or char_length(btrim(ws_name)) not between 1 and 200 then
--       raise exception 'The name must be 1 to 200 characters' using errcode = '22023';
--     end if;
--     ws_settings := coalesce(ws_settings, '{}');
--     if jsonb_typeof(ws_settings) <> 'object' then
--       raise exception 'settings must be an object' using errcode = '22023';
--     end if;
--     for k in select jsonb_object_keys(ws_settings) loop
--       if k not in ('hours_per_week', 'horizon_weeks', 'currency') then
--         raise exception '% can''t be set when creating a workspace', k using errcode = '22023';
--       end if;
--     end loop;
--     if ws_settings ? 'hours_per_week' and not (
--       jsonb_typeof(ws_settings -> 'hours_per_week') = 'number'
--       and (ws_settings ->> 'hours_per_week')::numeric > 0 and (ws_settings ->> 'hours_per_week')::numeric <= 168) then
--       raise exception 'hours_per_week must be a number above 0 and at most 168' using errcode = '22023';
--     end if;
--     if ws_settings ? 'horizon_weeks' and not (
--       jsonb_typeof(ws_settings -> 'horizon_weeks') = 'number'
--       and (ws_settings ->> 'horizon_weeks')::numeric = trunc((ws_settings ->> 'horizon_weeks')::numeric)
--       and (ws_settings ->> 'horizon_weeks')::numeric between 1 and 104) then
--       raise exception 'horizon_weeks must be a whole number from 1 to 104' using errcode = '22023';
--     end if;
--     if ws_settings ? 'currency' and not (
--       jsonb_typeof(ws_settings -> 'currency') = 'string' and (ws_settings ->> 'currency') ~ '^[A-Z]{3}$') then
--       raise exception 'currency must be a three-letter code such as GBP' using errcode = '22023';
--     end if;
--
--     insert into public.workspaces (name, slug, settings)
--     values (btrim(ws_name), ws_slug, defaults || ws_settings)
--     returning id into ws;
--
--     insert into public.memberships (workspace_id, user_id, role, source)
--     values (ws, auth.uid(), 'agency_admin', 'manual');
--
--     return ws;
--   end;
--   $$;
--   delete from supabase_migrations.schema_migrations where version = '20261113000000';
--   commit;
--
-- Production data: none needed. Workspaces already created keep their currency.

-- ---------------------------------------------------------------------------
-- Creating a workspace: AUD by default
-- ---------------------------------------------------------------------------

-- Agency admins only, and not over an API token. Runs as the caller, so RLS
-- checks both inserts; `returning` passes the select policy for an admin.
create or replace function public.create_workspace(ws_name text, ws_slug text, ws_settings jsonb default '{}')
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ws uuid;
  k text;
  defaults constant jsonb := '{"hours_per_week":40,"horizon_weeks":13,"currency":"AUD","leads_per_week":0,"active_clients":0,"churn_monthly":0,"retainer":0}';
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Workspaces are created in the app' using errcode = '42501';
  end if;
  if auth.uid() is null or not public.is_agency_admin() then
    raise exception 'Only agency admins can create workspaces' using errcode = '42501';
  end if;
  if ws_name is null or char_length(btrim(ws_name)) not between 1 and 200 then
    raise exception 'The name must be 1 to 200 characters' using errcode = '22023';
  end if;
  ws_settings := coalesce(ws_settings, '{}');
  if jsonb_typeof(ws_settings) <> 'object' then
    raise exception 'settings must be an object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(ws_settings) loop
    if k not in ('hours_per_week', 'horizon_weeks', 'currency') then
      raise exception '% can''t be set when creating a workspace', k using errcode = '22023';
    end if;
  end loop;
  if ws_settings ? 'hours_per_week' and not (
    jsonb_typeof(ws_settings -> 'hours_per_week') = 'number'
    and (ws_settings ->> 'hours_per_week')::numeric > 0 and (ws_settings ->> 'hours_per_week')::numeric <= 168) then
    raise exception 'hours_per_week must be a number above 0 and at most 168' using errcode = '22023';
  end if;
  if ws_settings ? 'horizon_weeks' and not (
    jsonb_typeof(ws_settings -> 'horizon_weeks') = 'number'
    and (ws_settings ->> 'horizon_weeks')::numeric = trunc((ws_settings ->> 'horizon_weeks')::numeric)
    and (ws_settings ->> 'horizon_weeks')::numeric between 1 and 104) then
    raise exception 'horizon_weeks must be a whole number from 1 to 104' using errcode = '22023';
  end if;
  if ws_settings ? 'currency' and not (
    jsonb_typeof(ws_settings -> 'currency') = 'string' and (ws_settings ->> 'currency') ~ '^[A-Z]{3}$') then
    raise exception 'currency must be a three-letter code such as AUD' using errcode = '22023';
  end if;

  insert into public.workspaces (name, slug, settings)
  values (btrim(ws_name), ws_slug, defaults || ws_settings)
  returning id into ws;

  insert into public.memberships (workspace_id, user_id, role, source)
  values (ws, auth.uid(), 'agency_admin', 'manual');

  return ws;
end;
$$;

revoke all on function public.create_workspace(text, text, jsonb) from public, anon;
grant execute on function public.create_workspace(text, text, jsonb) to authenticated;
