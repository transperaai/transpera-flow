-- A tighter MCP rate limit for the tools that simulate (security review: "MCP rate limiting").
--
-- Every /api/mcp request counts against its token's 120 a minute (`public.mcp_token_lookup`, 20261229000000). That suits the cheap
-- reads, but a simulation tool call (run_scenario, compare_scenarios, check_robustness, get_bottlenecks, get_facts, list_issues with
-- detections) runs the engine on the server for up to tens of seconds, so 120 a minute could keep many function instances busy.
--
-- What it does:
--   1. `api_tokens.sim_window_start timestamptz null` and `api_tokens.sim_window_count integer not null default 0`: a second fixed
--      one-minute window, for simulation calls only. Not granted to `authenticated` for insert or update (the table's column grants
--      stay as they were), so only the function below changes them. Every existing row gets 0 and null; no other data changes.
--   2. `public.mcp_simulation_use(integer)`, security definer, execute for `authenticated` only: for the API token in the caller's claims
--      (`auth.jwt() ->> 'api_token_id'`, which only the MCP handler sets) that belongs to `auth.uid()` and isn't revoked, counts one
--      simulation and returns `{allowed, retry_after_seconds, limit}`; `allowed` is false past `p_per_minute` (default 10, which
--      packages/mcp passes; held to 1 to 120) in the window. Called by
--      packages/mcp before a simulation tool runs; a refused call returns `rate_limited` and runs nothing. A browser session (no
--      token in its claims) or a token of someone else gets `{allowed: false}` with no row changed.
--   Not changed: `mcp_token_lookup` and its 120 a minute, which still applies to every request, simulations included.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270203000300';` expect 0, and 20270203000200 applied.
--     Locks: adding a nullable column and a column with a constant default rewrites nothing (a brief ACCESS EXCLUSIVE on api_tokens).
-- Post-apply checks: select count(*) from public.api_tokens where sim_window_count <> 0; expect 0.
--     select has_function_privilege('anon', 'public.mcp_simulation_use(integer)', 'execute'); expect false.
--
-- ROLLBACK (run as one transaction; deploy the previous packages/mcp first, which doesn't call the function):
--
--   begin;
--   drop function public.mcp_simulation_use(integer);
--   alter table public.api_tokens drop column sim_window_start, drop column sim_window_count;
--   delete from public.schema_migrations where version = '20270203000300';
--   commit;

alter table public.api_tokens
  add column sim_window_start timestamptz,
  add column sim_window_count integer not null default 0;
comment on column public.api_tokens.sim_window_count is 'Simulation tool calls in the token''s current one-minute window (public.mcp_simulation_use).';

create function public.mcp_simulation_use(p_per_minute integer default 10) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  -- The caller (packages/mcp) passes its limit; at least 1 and never more than the 120 a minute every request has.
  per_minute constant integer := greatest(1, least(coalesce(p_per_minute, 10), 120));
  token_id uuid;
  t public.api_tokens;
begin
  begin
    token_id := (auth.jwt() ->> 'api_token_id')::uuid;
  exception when invalid_text_representation then
    token_id := null;
  end;
  if token_id is null or auth.uid() is null then
    return jsonb_build_object('allowed', false, 'retry_after_seconds', 60, 'limit', per_minute);
  end if;

  update public.api_tokens a
  set sim_window_start = case when a.sim_window_start is null or a.sim_window_start <= now() - interval '1 minute'
                              then now() else a.sim_window_start end,
      sim_window_count = case when a.sim_window_start is null or a.sim_window_start <= now() - interval '1 minute'
                              then 1 else a.sim_window_count + 1 end
  where a.id = token_id and a.user_id = auth.uid() and a.revoked_at is null
  returning a.* into t;
  if not found then
    return jsonb_build_object('allowed', false, 'retry_after_seconds', 60, 'limit', per_minute);
  end if;

  return jsonb_build_object(
    'allowed', t.sim_window_count <= per_minute,
    'retry_after_seconds', greatest(1, ceil(extract(epoch from (t.sim_window_start + interval '1 minute' - now()))))::integer,
    'limit', per_minute);
end;
$$;

revoke all on function public.mcp_simulation_use(integer) from public, anon;
grant execute on function public.mcp_simulation_use(integer) to authenticated;
