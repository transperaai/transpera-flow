-- Stand-ins for the Supabase Storage and Realtime objects that migrations 1-72 touch, so they apply unchanged on Neon and
-- plain Postgres. Step 4 (References replace uploads) and step 5 (drop Realtime) add migrations that drop what depends on
-- them. Idempotent. Nothing here emulates the services themselves: the Storage API's size and MIME checks, and
-- Realtime's delivery, do not exist outside Supabase.

-- Storage: the `sources` bucket and its policies on storage.objects (20261204000000_process_admin_source_files.sql).
create schema if not exists storage;

create table if not exists storage.buckets (
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

create table if not exists storage.objects (
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
create or replace function storage.foldername(name text) returns text[]
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

-- @realtime-shim
-- Realtime: the `supabase_realtime` publication, and realtime.messages with realtime.topic(), which Realtime Authorization
-- checks policies against (it sets `realtime.topic` for the channel being joined, then tries a select / insert on
-- realtime.messages as the user). migrations/20261007000000_realtime.sql does nothing without the publication.
do $$
begin
  if not exists (select from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;


create schema if not exists realtime;
grant usage on schema realtime to authenticated;

create table if not exists realtime.messages (
  id bigserial primary key,
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean default false,
  inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to authenticated;
grant usage on sequence realtime.messages_id_seq to authenticated;

create or replace function realtime.topic() returns text
language sql stable
as $$
  select nullif(current_setting('realtime.topic', true), '')::text;
$$;
