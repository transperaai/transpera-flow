-- References in place of uploads, and the logo in the database (supabase-exit-brief.md, step 4; rework-direction.md decision 5).
--
--   * A source's original is now a link: `sources.file_url` (an http(s) link, already there since the sources table). The uploaded
--     original that migration 20261204000000 added (`file_path`, `file_name`, `file_type`, `file_size`, with their checks, index
--     and guard trigger) is dropped, and so is every policy on `storage.objects` and every function that read it.
--   * A workspace's logo is a row of `public.workspace_logos` (PNG, JPEG or WebP, 256 KB at most), served by the app's route
--     `/api/branding/<workspace id>/logo`, which reads it through `public.workspace_logo(uuid)`: a SECURITY DEFINER function that
--     anon may call, because a share link's visitors see the logo (the public `branding` bucket was public too). The table's
--     rows are written by the people who could change the branding before: owners and agency admins (`can_manage_workspace`,
--     the rule `private.branding_logo_guard`'s upload policy enforced); everyone in the workspace reads them; anon reads nothing.
--   * `workspaces.branding` keeps `accent` and `accent_dark`; its `logo_path` key is removed from every row and from the shape check.
--
-- NOT DONE HERE: the `sources` and `branding` bucket rows and their objects are left alone (Supabase refuses to delete a bucket
-- with objects from SQL; step 7 lists the objects so they can be re-hosted as links, and copies the current logo into
-- workspace_logos). Nothing of the shims in legacy-shims.sql changes: older migrations still need them to apply.
--
-- ROLLBACK is not scripted: the dropped columns held the original files' names, which only Storage still has.

-- Storage policies first (they call private.storage_workspace and read sources.file_path).
drop policy if exists "sources: members read" on storage.objects;
drop policy if exists "sources: editors upload" on storage.objects;
drop policy if exists "sources: editors delete" on storage.objects;
drop policy if exists "branding: managers read" on storage.objects;
drop policy if exists "branding: managers upload" on storage.objects;
drop policy if exists "branding: managers delete" on storage.objects;

drop trigger if exists source_file_guard on public.sources;
drop function if exists private.source_file_guard();
drop trigger if exists branding_logo_guard on public.workspaces;
drop function if exists private.branding_logo_guard();
drop function if exists private.storage_workspace(text);

-- The uploaded original of a source.
drop index if exists public.sources_workspace_file_path;
alter table public.sources
  drop constraint if exists sources_file_all_or_none,
  drop constraint if exists sources_file_path_shape,
  drop constraint if exists sources_file_type,
  drop constraint if exists sources_file_size,
  drop constraint if exists sources_file_name_length;
alter table public.sources
  drop column file_path,
  drop column file_name,
  drop column file_type,
  drop column file_size;

-- The logo path in branding: remove the key, then forbid it.
update public.workspaces set branding = branding - 'logo_path' where branding ? 'logo_path';
alter table public.workspaces drop constraint workspaces_branding_shape;
alter table public.workspaces add constraint workspaces_branding_shape check (
  jsonb_typeof(branding) = 'object'
  and branding - array['accent', 'accent_dark'] = '{}'::jsonb
  and coalesce(jsonb_typeof(branding -> 'accent'), 'null') in ('null', 'string')
  and coalesce(branding ->> 'accent' ~ '^#[0-9a-f]{6}$', true)
  and coalesce(jsonb_typeof(branding -> 'accent_dark'), 'null') in ('null', 'string')
  and coalesce(branding ->> 'accent_dark' ~ '^#[0-9a-f]{6}$', true)
);

-- The logo itself. The app checks the content (magic bytes, pixel size, no SVG); Postgres checks the type, the size and that
-- `sha256` really is the bytes' hash (the route uses it as the ETag).
create table public.workspace_logos (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  mime text not null constraint workspace_logos_mime check (mime in ('image/png', 'image/jpeg', 'image/webp')),
  bytes bytea not null constraint workspace_logos_size check (octet_length(bytes) between 1 and 262144),
  sha256 text not null constraint workspace_logos_sha256 check (sha256 = encode(pg_catalog.sha256(bytes), 'hex')),
  updated_at timestamptz not null default now()
);

alter table public.workspace_logos enable row level security;

create policy "read workspace_logos" on public.workspace_logos for select to authenticated
  using (public.can_read_workspace(workspace_id));
create policy "insert workspace_logos" on public.workspace_logos for insert to authenticated
  with check (public.can_manage_workspace(workspace_id));
create policy "update workspace_logos" on public.workspace_logos for update to authenticated
  using (public.can_manage_workspace(workspace_id)) with check (public.can_manage_workspace(workspace_id));
create policy "delete workspace_logos" on public.workspace_logos for delete to authenticated
  using (public.can_manage_workspace(workspace_id));

revoke all on public.workspace_logos from public, anon, authenticated;
grant select, insert, update, delete on public.workspace_logos to authenticated;

-- What the logo route serves: the workspace's logo, or no row. Callable signed out (the logo shows on a share link).
create function public.workspace_logo(p_workspace uuid) returns table (mime text, bytes bytea, sha256 text)
language sql stable security definer
set search_path = ''
as $$
  select l.mime, l.bytes, l.sha256 from public.workspace_logos l where l.workspace_id = p_workspace;
$$;

revoke all on function public.workspace_logo(uuid) from public;
grant execute on function public.workspace_logo(uuid) to anon, authenticated;
