-- Client branding (issue #34, B5; PRD §8.1 "Client branding"): a workspace's logo and accent colour.
--
--   * `workspaces.branding` jsonb, not null, default '{}', with a shape check (`workspaces_branding_shape`): at most the keys
--     `accent` (the light-theme accent, lower-case #rrggbb), `accent_dark` (an optional dark-theme accent; null: the app derives
--     it) and `logo_path` (`<this workspace's id>/<uuid>.<png|jpg|webp>`, the object's name in the `branding` bucket).
--   * `private.branding_logo_guard` and its trigger `branding_logo_guard` (before insert, or update of `branding`, on
--     `workspaces`): for anyone signed in, a new `logo_path` must name an object of the `branding` bucket. It does not compare
--     `owner_id` (unconfirmed on production, docs/HANDOVER.md); the upload policy already limits the folder to the workspace's
--     owners and agency admins.
--   * Supabase Storage: a PUBLIC bucket `branding` (512 KB a file; PNG, JPEG and WebP only) and three policies on
--     `storage.objects` (read, upload, delete) for owners and agency admins of the workspace in the object's first folder.
--     No update: a logo is replaced by a new name. Anon: nothing through the API (the public URL doesn't use the policies).
--   * Contrast is NOT checked in Postgres: the app refuses a failing accent at save time and ignores one at render time.
--
-- STRICTLY ADDITIVE: one new column with a constant default (no table rewrite on PG >= 11), one validated check (every row is
-- '{}', which passes; `workspaces` is tiny), one function and trigger, one bucket row, three storage policies. No existing
-- column, policy, grant or function changes. `save_fields` is NOT redefined (it already accepts `workspaces` and any column).
--
-- ORDER: apply after the migration before it in packages/db/supabase/migrations at merge time (renumber if anything numbered
-- later merges first).
--
-- PREFLIGHT (read-only, one file at a time with prod-sql.sh -f; it returns only the last statement):
--   0. The previous migration in the repo at merge time is the latest applied, and nothing later is. Expect its version, then 0:
--        select max(version) from supabase_migrations.schema_migrations;
--        select count(*) from supabase_migrations.schema_migrations where version >= '20261214000000';
--   1. Nothing this creates exists yet. Expect 0 rows from each:
--        select column_name from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'branding';
--        select conname from pg_constraint where conname = 'workspaces_branding_shape';
--        select proname from pg_proc where pronamespace = 'private'::regnamespace and proname = 'branding_logo_guard';
--        select id from storage.buckets where id = 'branding';
--        select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'branding:%';
--   2. The policies already on storage.objects are only B19's three (anything else could widen access to the new bucket).
--      Expect exactly `sources: editors delete`, `sources: editors upload`, `sources: members read`:
--        select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1;
--   3. What the policies call is there. Expect 1 row (authenticated), then 2 rows:
--        select grantee from information_schema.routine_privileges where routine_schema = 'private' and routine_name = 'storage_workspace' and grantee = 'authenticated';
--        select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('can_manage_workspace', 'save_fields');
--   4. Storage has RLS on, and the bucket table takes the columns we insert. Expect true, then 5 rows:
--        select relrowsecurity from pg_class where oid = 'storage.objects'::regclass;
--        select column_name from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name in ('id', 'name', 'public', 'file_size_limit', 'allowed_mime_types');
--   5. The triggers on workspaces are the eight known ones (audit_company, company_map_new_workspace, needs_review,
--      needs_review_insert, seed_market_presets, seed_scenario_library, set_updated_at, stamp_settings_provenance):
--        select tgname from pg_trigger where tgrelid = 'public.workspaces'::regclass and not tgisinternal order by 1;
--
-- POST-APPLY CHECK:
--   1. Column: jsonb, not null, default '{}'::jsonb; every workspace unbranded. Expect 1 row, then 0:
--        select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'branding';
--        select count(*) from public.workspaces where branding <> '{}'::jsonb;
--   2. Check validated. Expect t:
--        select convalidated from pg_constraint where conname = 'workspaces_branding_shape';
--   3. Trigger enabled. Expect 1 row, O:
--        select tgname, tgenabled::text from pg_trigger where tgname = 'branding_logo_guard';
--   4. Bucket. Expect 1 row: true, 524288, 3:
--        select public, file_size_limit, cardinality(allowed_mime_types) from storage.buckets where id = 'branding';
--   5. Three policies for {authenticated}: SELECT, INSERT, DELETE (no UPDATE):
--        select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'branding:%' order by cmd;
--   6. The function: empty search_path; no EXECUTE for anon, authenticated or PUBLIC. Expect {search_path=""}, then 0 rows:
--        select proconfig from pg_proc where pronamespace = 'private'::regnamespace and proname = 'branding_logo_guard';
--        select grantee from information_schema.routine_privileges where routine_schema = 'private' and routine_name = 'branding_logo_guard' and grantee in ('anon', 'authenticated', 'PUBLIC');
--   7. The row:
--        select version, name from supabase_migrations.schema_migrations where version = '20261214000000';
--
-- ROLLBACK (redeploy a build from before it FIRST; one transaction. Saved branding is lost; logos stay in the bucket until it
-- is emptied from the Storage dashboard, because a bucket with objects can't be deleted from SQL):
--
--   begin;
--   drop policy if exists "branding: managers read" on storage.objects;
--   drop policy if exists "branding: managers upload" on storage.objects;
--   drop policy if exists "branding: managers delete" on storage.objects;
--   -- Only once the bucket is empty (empty it from the dashboard first): delete from storage.buckets where id = 'branding';
--   drop trigger if exists branding_logo_guard on public.workspaces;
--   drop function if exists private.branding_logo_guard();
--   alter table public.workspaces drop constraint if exists workspaces_branding_shape;
--   alter table public.workspaces drop column if exists branding;
--   commit;

-- Branding (issue #34): the light-theme accent, an optional dark-theme accent (null: derived by the app), and the logo's
-- object name in the `branding` bucket. Hex is lower case; the app normalises before saving.
alter table public.workspaces add column branding jsonb not null default '{}'::jsonb;

alter table public.workspaces add constraint workspaces_branding_shape check (
  jsonb_typeof(branding) = 'object'
  and branding - array['accent', 'accent_dark', 'logo_path'] = '{}'::jsonb
  and coalesce(jsonb_typeof(branding -> 'accent'), 'null') in ('null', 'string')
  and coalesce(branding ->> 'accent' ~ '^#[0-9a-f]{6}$', true)
  and coalesce(jsonb_typeof(branding -> 'accent_dark'), 'null') in ('null', 'string')
  and coalesce(branding ->> 'accent_dark' ~ '^#[0-9a-f]{6}$', true)
  and coalesce(jsonb_typeof(branding -> 'logo_path'), 'null') in ('null', 'string')
  -- `<this workspace's id>/<uuid>.<png|jpg|webp>`: only a logo in the workspace's own folder.
  and coalesce(branding ->> 'logo_path' ~ ('^' || id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'), true)
);

-- A workspace keeps only a logo that is in the bucket: nobody points it at a name with nothing behind it. Unlike B19's
-- source guard this does NOT compare `owner_id` (unconfirmed on production; HANDOVER): the upload policy already limits
-- the folder to the workspace's owners and agency admins. Security definer: it reads `storage.objects`.
create function private.branding_logo_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  path text := new.branding ->> 'logo_path';
begin
  if path is null or (tg_op = 'UPDATE' and path is not distinct from (old.branding ->> 'logo_path')) then
    return new;
  end if;
  -- Only for someone signed in (or anon): the operator and the migrations pass (as in private.source_file_guard).
  if auth.uid() is null and coalesce(current_setting('role', true), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'branding' and o.name = path) then
    raise exception 'Upload the logo first: the workspace keeps only a logo uploaded for it' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.branding_logo_guard() from public, anon, authenticated;

create trigger branding_logo_guard before insert or update of branding on public.workspaces
  for each row execute function private.branding_logo_guard();

-- A PUBLIC bucket (Q4): a logo is shown to everyone in the workspace and, later, to share-link visitors (B3) who aren't
-- signed in, so it's read by its public URL, never through row-level security. Names are `<workspace id>/<random uuid>.<ext>`,
-- never reused, so a cached copy never goes stale. Storage refuses a file over 512 KB or with another declared type; the
-- app checks the real content on the server and deletes anything else.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 524288, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- Owners and agency admins of the workspace in the object's first folder: read through the API (the server reads an upload
-- back to check it; `remove` needs it), upload, delete. No update: a logo is replaced by a new name. Anon: nothing through
-- the API (the public URL doesn't go through these).
create policy "branding: managers read" on storage.objects for select to authenticated
  using (bucket_id = 'branding' and private.storage_workspace(objects.name) is not null
    and public.can_manage_workspace(private.storage_workspace(objects.name)));

create policy "branding: managers upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'branding' and private.storage_workspace(objects.name) is not null
    and public.can_manage_workspace(private.storage_workspace(objects.name))
    and objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$');

create policy "branding: managers delete" on storage.objects for delete to authenticated
  using (bucket_id = 'branding' and private.storage_workspace(objects.name) is not null
    and public.can_manage_workspace(private.storage_workspace(objects.name)));
