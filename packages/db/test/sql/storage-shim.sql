-- Minimal stand-in for the parts of Supabase Storage the migrations rely on, so the `sources` bucket and its policies on
-- `storage.objects` can be tested against plain Postgres. Mirrors the columns, grants and row-level security a Supabase
-- project has (storage.buckets, storage.objects, storage.foldername). Supabase's Storage API runs its queries on these tables
-- as the caller's role (`authenticated` with the JWT's claims, or `anon`), so a query here as `authenticated` with
-- `request.jwt.claims` set is what an upload, download or delete through the API does in the database. The API's own checks
-- (the bucket's size limit and MIME types) are not emulated: the app re-checks both on the server. Test-only: never run
-- against a Supabase project (which has the real schema).

create schema storage;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  owner_id text,
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  user_metadata jsonb,
  version text,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);

-- As Supabase defines it: every folder of the name, without the file.
create function storage.foldername(name text) returns text[]
language plpgsql
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets to anon, authenticated, service_role;
grant all on storage.objects to anon, authenticated, service_role;
