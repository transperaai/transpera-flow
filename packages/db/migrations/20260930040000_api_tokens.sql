-- Personal API tokens for the MCP server (docs/PRD.md §5, §7.1, §10; decision D12;
-- docs/adr/0002-mcp-acts-as-user-via-pre-request.md).
--
-- A token is shown to its owner once; only its SHA-256 hash is stored. A Data
-- API request that carries the token in the `x-api-token` header is switched,
-- by a PostgREST pre-request function, from `anon` to `authenticated` with the
-- token owner's claims, so every query runs as that user under RLS. The MCP
-- endpoint never uses the service-role key.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Lowercase hex SHA-256 of the token; the token itself is never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label text not null check (char_length(label) between 1 and 100),
  -- The MCP session's active workspace (set_active_workspace). Stored per
  -- token because the endpoint is stateless across serverless instances.
  active_workspace_id uuid references public.workspaces (id) on delete set null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- Fixed one-minute window for per-token rate limiting (use_api_token).
  rate_window_start timestamptz,
  rate_window_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create index on public.api_tokens (user_id);

create trigger set_updated_at before update on public.api_tokens for each row execute function public.set_updated_at();

-- Revoking is permanent.
create function public.api_tokens_keep_revoked() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'A revoked API token cannot be restored';
  end if;
  return new;
end;
$$;

create trigger keep_revoked before update on public.api_tokens
  for each row execute function public.api_tokens_keep_revoked();

-- Users see and manage only their own tokens. Column grants keep the hash and
-- the rate-limit counters out of reach of updates.
alter table public.api_tokens enable row level security;

create policy "read own api tokens" on public.api_tokens for select to authenticated
  using (user_id = auth.uid());
create policy "create own api tokens" on public.api_tokens for insert to authenticated
  with check (user_id = auth.uid() and revoked_at is null);
create policy "update own api tokens" on public.api_tokens for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.api_tokens from anon, authenticated;
grant select on public.api_tokens to authenticated;
grant insert (label, token_hash) on public.api_tokens to authenticated;
grant update (label, revoked_at, active_workspace_id) on public.api_tokens to authenticated;

-- ---------------------------------------------------------------------------
-- Token resolution. `private` is not an API-exposed schema.
-- ---------------------------------------------------------------------------

create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

create function private.hash_api_token(token text) returns text
language sql immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(token, 'UTF8')), 'hex');
$$;

-- The owner's JWT claims for a live token, or null. Security definer because
-- `anon` cannot read api_tokens or auth.users; it resolves exactly one token
-- and nothing else.
create function private.api_token_claims(token text) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sub', u.id,
    'role', 'authenticated',
    'aud', 'authenticated',
    'email', u.email,
    'app_metadata', coalesce(u.raw_app_meta_data, '{}'::jsonb),
    'api_token_id', t.id
  )
  from public.api_tokens t
  join auth.users u on u.id = t.user_id
  where t.token_hash = private.hash_api_token(token)
    and t.revoked_at is null
    and (u.banned_until is null or u.banned_until <= now());
$$;

revoke all on function private.hash_api_token(text) from public;
revoke all on function private.api_token_claims(text) from public;
grant execute on function private.api_token_claims(text) to anon;

-- PostgREST pre-request hook: runs before every Data API request, after
-- PostgREST has set the role and claims from the request's JWT.
--
-- No header: nothing changes. With `x-api-token` on an anonymous request, a
-- live token switches the transaction to `authenticated` with its owner's
-- claims; anything else is rejected with 401.
--
-- Deliberately NOT security definer and without a `set` clause: Postgres
-- forbids SET ROLE in security-definer functions, and a function-level `set`
-- would undo the transaction-local settings when the function returns. SET
-- ROLE is checked against the session user (PostgREST's `authenticator`, a
-- member of `authenticated`), so it works from `anon`. Every name is
-- schema-qualified instead of relying on search_path.
create function private.api_token_pre_request() returns void
language plpgsql
as $$
declare
  token text := nullif(pg_catalog.current_setting('request.headers', true), '')::json ->> 'x-api-token';
  claims jsonb;
begin
  if token is null then
    return;
  end if;
  if current_user <> 'anon' then
    raise sqlstate 'PGRST' using
      message = json_build_object('code', 'API_TOKEN', 'message', 'Send either a session or an API token, not both')::text,
      detail = json_build_object('status', 400, 'headers', json_build_object())::text;
  end if;
  claims := private.api_token_claims(token);
  if claims is null then
    raise sqlstate 'PGRST' using
      message = json_build_object('code', 'API_TOKEN', 'message', 'Invalid or revoked API token')::text,
      detail = json_build_object('status', 401, 'headers', json_build_object('WWW-Authenticate', 'Bearer'))::text;
  end if;
  perform pg_catalog.set_config('request.jwt.claims', claims::text, true);
  set local role authenticated;
end;
$$;

-- Every request runs the hook, whatever its role.
revoke all on function private.api_token_pre_request() from public;
grant execute on function private.api_token_pre_request() to anon, authenticated, service_role;

-- Register the hook. `authenticator` exists on Supabase (and in the CI
-- PostgREST test), not in the plain-Postgres test databases.
do $$
begin
  if exists (select from pg_roles where rolname = 'authenticator')
     and not exists (
       select from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
       where r.rolname = 'authenticator' and s.setdatabase = 0
         and 'pgrst.db_pre_request=private.api_token_pre_request' = any (s.setconfig)
     ) then
    alter role authenticator set pgrst.db_pre_request = 'private.api_token_pre_request';
  end if;
end;
$$;

notify pgrst, 'reload config';

-- ---------------------------------------------------------------------------
-- Per-request bookkeeping for the MCP endpoint: validates the token, records
-- last use and enforces the per-token rate limit (fixed one-minute window).
-- Called over the Data API with POST, so it may write (GET runs read-only).
-- `acting_as_user` reports whether the pre-request hook switched the caller to
-- the token's user, so the endpoint can refuse to run if the hook is missing.
-- ---------------------------------------------------------------------------

create function public.use_api_token(token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  t public.api_tokens;
begin
  update public.api_tokens a
  set last_used_at = now(),
      rate_window_start = case when a.rate_window_start is null or a.rate_window_start <= now() - interval '1 minute'
                               then now() else a.rate_window_start end,
      rate_window_count = case when a.rate_window_start is null or a.rate_window_start <= now() - interval '1 minute'
                               then 1 else a.rate_window_count + 1 end
  where a.token_hash = private.hash_api_token(token) and a.revoked_at is null
  returning a.* into t;

  if not found then
    raise sqlstate 'PGRST' using
      message = json_build_object('code', 'API_TOKEN', 'message', 'Invalid or revoked API token')::text,
      detail = json_build_object('status', 401, 'headers', json_build_object())::text;
  end if;

  return jsonb_build_object(
    'allowed', t.rate_window_count <= 120,
    'retry_after_seconds', greatest(0, ceil(extract(epoch from (t.rate_window_start + interval '1 minute' - now()))))::integer,
    'active_workspace_id', t.active_workspace_id,
    'acting_as_user', auth.uid() is not distinct from t.user_id
  );
end;
$$;

revoke all on function public.use_api_token(text) from public;
grant execute on function public.use_api_token(text) to anon, authenticated;
