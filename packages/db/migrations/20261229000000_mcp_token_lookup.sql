-- MCP token checks in app code (docs/adr/0018-mcp-tokens-checked-in-app-code.md, superseding 0002).
--
-- /api/mcp hashes the bearer token (SHA-256, lowercase hex, as private.hash_api_token does) and calls this function as
-- `anon`. It is the whole of what the PostgREST pre-request hook and public.use_api_token did, in one call: it resolves
-- one live token to its owner, stamps last use, counts the request in the token's one-minute window, and returns what
-- the app needs to build the owner's claims. Nothing for a revoked token, an unknown hash, or a banned owner.
--
-- Security definer because `anon` can read neither api_tokens nor auth.users. It takes the hash, so the token itself
-- never reaches SQL, and it returns identity and rate-limit state only (no token hash, no other user data).

create function public.mcp_token_lookup(p_token_hash text)
returns table (
  user_id uuid,
  token_id uuid,
  email text,
  agency_admin boolean,
  active_workspace_id uuid,
  allowed boolean,
  retry_after_seconds integer
)
language plpgsql volatile security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  t public.api_tokens;
  u auth.users;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select * into u
  from auth.users x
  where x.id = (select a.user_id from public.api_tokens a where a.token_hash = p_token_hash and a.revoked_at is null)
    and (x.banned_until is null or x.banned_until <= now());
  if not found then
    return;
  end if;

  update public.api_tokens a
  set last_used_at = now(),
      rate_window_start = case when a.rate_window_start is null or a.rate_window_start <= now() - interval '1 minute'
                               then now() else a.rate_window_start end,
      rate_window_count = case when a.rate_window_start is null or a.rate_window_start <= now() - interval '1 minute'
                               then 1 else a.rate_window_count + 1 end
  where a.token_hash = p_token_hash and a.revoked_at is null
  returning a.* into t;
  if not found then
    return;
  end if;

  return query select
    t.user_id,
    t.id,
    u.email::text,
    coalesce(u.raw_app_meta_data ->> 'agency_admin' = 'true', false),
    t.active_workspace_id,
    t.rate_window_count <= 120,
    greatest(0, ceil(extract(epoch from (t.rate_window_start + interval '1 minute' - now()))))::integer;
end;
$$;

revoke all on function public.mcp_token_lookup(text) from public;
grant execute on function public.mcp_token_lookup(text) to anon;
