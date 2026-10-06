# B5 build brief: client branding (#34)

Scoped 6 Oct 2026 (overnight run) against `main` at f4bafec. Read `docs/plans/builder-brief.md` first; this brief adds to
it and wins where they differ. Follow it strictly. If something here is unclear or doesn't match the code, **ask; don't
guess.** Austin is asleep for this run: every open question at the end has a **default**, and you build the default.

**No new secret and no paid service.** Logos go in a new bucket on the existing Supabase project's Storage. Supabase image
transforms (a paid feature) are not used, and neither is Next's image optimiser.

## The short version

An owner (or agency admin) opens **Settings → Branding**, uploads a logo and picks an accent colour. The app shell for
that workspace then uses that accent instead of the Transpera teal-blue, and shows the logo in the workspace tile at the
top of the sidebar. A colour that doesn't reach WCAG AA contrast in the light theme, or (as derived or as overridden) in the
dark theme, is refused at save time with the nearest passing colour suggested ("Use #0b6e8a"). A workspace with no
branding looks exactly as it does today.

| Piece | What |
|---|---|
| Migration `20261214000000_client_branding` | `workspaces.branding jsonb not null default '{}'` with a shape check; a logo guard trigger; a **public** `branding` bucket (512 KB, PNG/JPEG/WebP) with three storage policies for owners and agency admins. Additive. **`save_fields` is NOT redefined** (it already accepts `workspaces` and any column). |
| `apps/web/src/lib/branding/*` | Pure contrast maths (WCAG 2.x relative luminance, OKLCH ↔ sRGB), accent validation and the suggested fix, the derived dark accent, the CSS the shell injects, and the logo file check. |
| Settings → Branding page | Logo upload/remove, accent colour with live contrast readout, optional dark-theme override, preview in both themes. |
| App shell | `app/w/[slug]/layout.tsx` injects the workspace's tokens; the workspace switcher tile shows the logo. |
| Share links (B3, #32) and the PDF | Not built here. See "Share links" and "PDF and report colours" below. |

One branch (`claude/b5-client-branding`), one PR, `Closes #34`.

---

## Decisions (verbatim)

**#34 (the ticket):**
> The client's workspace and report look like theirs. In workspace settings, upload a logo and set an accent colour and
> report colours. The accent is validated for WCAG AA contrast in both light and dark themes at save time, and is rejected
> with a suggested adjustment if it fails. Branding applies to the app shell, share links and the PDF report (PRD §8.1
> Client branding).
>
> - [ ] Logo upload goes to Supabase Storage, with size and type limits
> - [ ] The accent colour is rejected if it fails AA contrast in either theme, and a passing alternative is suggested (tests)
> - [ ] Branding shows in the app shell, share links and the PDF
> - [ ] Workspaces without branding fall back to the default tokens

**PRD §8.1:**
> **Client branding (v1).** Workspace-level logo, accent colour and report colours. Accent validated for contrast on both
> themes at save time.

> **Accessibility floor.** WCAG AA contrast, full keyboard operation of canvas and rail, focus rings visible, ARIA on custom
> nodes.

**PRD §5 (data model):** `workspaces … branding jsonb (logo_url, accent, report_colors)`.

**PRD D22 (redesign, supersedes the PDF part of the ticket):**
> Reports (pages, PDF route, print stylesheet, `export_report` tool, nav item), the Clients page, the Scenarios page, the
> Runs page, and the Track and Run fix buttons. "Explain this run" stays. The `reports` tables stay, unused. Ticket A32.

and PRD §9: *"Amended by D22: the PDF report, report route and `export_report` tool are removed."* So **there is no PDF to
brand** and "report colours" have nothing to colour (see Q2).

**PRD D33:** the look is Austin's shadcn preset (Inter, teal-blue brand, neutral greys). The brand accent replaces the
teal-blue only; fonts, neutrals and status colours stay.

**`docs/plans/redesign-plan.md`:** "**B5** #34 Client branding | **Keep** | Unchanged."

**HANDOVER, "Design calls Claude made, for Austin to confirm":**
> Workspace name and currency are owner-only (#190).

Branding follows the same rule (Q1): owners and agency admins change it, everyone in the workspace sees it.

**HANDOVER, "Waiting on Austin" (B19's live check):**
> a real source file upload works and Supabase sets `storage.objects.owner_id`

That's still unconfirmed on production, so **nothing in this ticket relies on `owner_id`**. The policies key on the
workspace folder and the caller's role only.

**HANDOVER, "How we work":** MCP acts as the user, never with the service-role key (D12). The `needs_review` trigger
already refuses any MCP (API token) write to `workspaces`, so MCP can't change branding. Leave it that way.

---

## Audit: what exists vs what #34 needs

| Need | Exists today | Gap |
|---|---|---|
| Somewhere to store branding | `workspaces` has `name, slug, plan, settings, provenance`; **no `branding` column** (PRD §5 planned one) | New column + shape check |
| Saving it | `public.save_fields` (latest copy in `20261111000000_client_groups.sql`) already lists `workspaces` and saves `column.key` of any jsonb column; `workspaces` update RLS is `can_manage_workspace` (owner, agency admin) | Nothing in SQL. A server action like `saveWorkspaceCurrency` |
| Logo storage | B19's private `sources` bucket and policies (`20261204000000`), `private.storage_workspace(name)` (authenticated has EXECUTE) | New bucket + 3 policies, reusing `storage_workspace` |
| Upload pattern | `apps/web/src/lib/sources/upload.ts` (browser → Storage as the user) + `attachSourceFile` in `app/w/[slug]/source-actions.ts` (server reads it back, checks content, keeps or removes) | Copy for the logo |
| Tokens | `apps/web/src/styles/tokens.css`: `--accent`, `--accent-soft`, `--accent-fg` in `:root`, in `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and in `:root[data-theme="dark"]`. `--primary`, `--ring`, `--sidebar-primary`, `--sidebar-ring` alias `var(--accent)`; React Flow's `--xy-*` read `var(--accent)` | Override the three on `:root` per theme; the aliases follow |
| Where accent shows | ~130 class uses: `bg-accent text-accent-fg` buttons, `text-accent` links and icons on `bg`/`panel`/`panel-2`, `bg-accent-soft text-accent` badges (e.g. the sidebar's AI count), focus rings (`:focus-visible { outline: 2px solid var(--accent) }`) | So the accent is **small text** on four surfaces: it needs 4.5:1, not 3:1 |
| Theme switch | No toggle; `data-theme` is never set, so the theme follows the OS | Both themes still need values |
| Shell | `app/w/[slug]/layout.tsx` (server) → `WorkspaceShell` (client) → `AppSidebar` → `WorkspaceSwitcher` (32 px monogram tile, `bg-accent text-accent-fg`) | Logo in that tile; style injected in the layout |
| Workspace head | `loadWorkspaceHead(slug)` in `apps/web/src/lib/data.ts` (`select("id, name, slug")`, React `cache`) | Add `branding` |
| Settings | `app/w/[slug]/settings/page.tsx` (+ `ai/`, `access/` sub-pages linked as outline buttons), `workspace-details.tsx`, `workspace-actions.ts` | New `settings/branding/` sub-page |
| Change log | `describeAuditEntry` in `apps/web/src/lib/suggestions/audit.ts`: a `workspaces` update describes only `settings` keys and `name`; anything else reads "Company settings updated" | Describe branding changes |
| Colour library | None in `apps/web` (no culori etc.) | Write the maths (≈150 lines); **don't add a dependency** |
| PDF report | Removed by D22 (A32); `reports` tables unused | Nothing to brand |
| Share links | Not built (B3 #32, scoped in parallel on `claude/b3-share-links`) | Helpers B3 can use; see below |
| Bundle export/import (B10) | `packages/db/src/workspace-bundle.ts` selects `id, name, slug, plan, settings, provenance` explicitly | Not carried (Q10) |

Defaults pass the check (computed from tokens.css, sRGB rounded to hex): light accent `#007595` is 5.06:1 on `--bg`
`#fafafa`, 5.28 on `--panel` `#ffffff`, 4.84 on `--panel-2` `#f5f5f5`, 4.59 on `--accent-soft` `#ddf3f9`, 5.07 with
`--accent-fg`; dark accent `#00b8db` is 8.37 / 7.58 / 6.40 (`#262626`) / 5.68 (`#0a3341`) / 7.62. A test must keep it so.

**Why one colour can't serve both themes:** text at 4.5:1 on `#fafafa` needs relative luminance ≤ ≈0.17; at 4.5:1 on
`#0a0a0a` it needs ≥ ≈0.19. No colour does both. So the stored accent is the **light-theme** accent, and the dark-theme
accent is **derived** from it (same hue, lighter) unless the owner sets their own (Q5). Both are checked.

---

## Data model and migration

### `packages/db/supabase/migrations/20261214000000_client_branding.sql`

Number: `20261214000000` (given). Migrations apply in file-name order; if anything numbered later merges first, renumber
before merging (HANDOVER). The SQL below was run against plain Postgres 16 with the storage shim while scoping: the check
accepts and refuses as listed, and `save_fields('workspaces', {id}, {"branding.accent": …})` saves.

Header (write it in the house style of `20261204000000`; every item below must be in it):

- What it adds (the bullets of this section) and **STRICTLY ADDITIVE**: one new column with a constant default (no table
  rewrite on PG ≥ 11), one validated check (every row is `'{}'`, which passes; `workspaces` is tiny), one function and
  trigger, one bucket row, three storage policies. No existing column, policy, grant or function changes. **`save_fields`
  is not redefined.**
- **ORDER:** apply after the migration before it in `packages/db/supabase/migrations` at merge time.
- **PREFLIGHT** (read-only, one file at a time with `prod-sql.sh -f`; it returns only the last statement):
  0. The previous migration in the repo at merge time is the latest applied, and nothing later is. Expect its version, then 0:
     `select max(version) from supabase_migrations.schema_migrations;`
     `select count(*) from supabase_migrations.schema_migrations where version >= '20261214000000';`
  1. Nothing this creates exists yet. Expect 0 rows from each:
     `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'branding';`
     `select conname from pg_constraint where conname = 'workspaces_branding_shape';`
     `select proname from pg_proc where pronamespace = 'private'::regnamespace and proname = 'branding_logo_guard';`
     `select id from storage.buckets where id = 'branding';`
     `select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'branding:%';`
  2. The policies already on `storage.objects` are only B19's three (anything else could widen access to the new bucket).
     Expect exactly `sources: editors delete`, `sources: editors upload`, `sources: members read`:
     `select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1;`
  3. What the policies call is there. Expect 1 row (`authenticated`), then 2 rows:
     `select grantee from information_schema.routine_privileges where routine_schema = 'private' and routine_name = 'storage_workspace' and grantee = 'authenticated';`
     `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('can_manage_workspace', 'save_fields');`
  4. Storage has RLS on, and the bucket table takes the columns we insert. Expect true, then 5 rows:
     `select relrowsecurity from pg_class where oid = 'storage.objects'::regclass;`
     `select column_name from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name in ('id', 'name', 'public', 'file_size_limit', 'allowed_mime_types');`
  5. The triggers on `workspaces` are the eight known ones (`audit_company`, `company_map_new_workspace`, `needs_review`,
     `needs_review_insert`, `seed_market_presets`, `seed_scenario_library`, `set_updated_at`, `stamp_settings_provenance`):
     `select tgname from pg_trigger where tgrelid = 'public.workspaces'::regclass and not tgisinternal order by 1;`
- **POST-APPLY CHECK:**
  1. Column: `jsonb`, not null, default `'{}'::jsonb`; every workspace unbranded. Expect 1 row, then 0:
     `select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'branding';`
     `select count(*) from public.workspaces where branding <> '{}'::jsonb;`
  2. Check validated. Expect `t`: `select convalidated from pg_constraint where conname = 'workspaces_branding_shape';`
  3. Trigger enabled. Expect 1 row, `O`: `select tgname, tgenabled::text from pg_trigger where tgname = 'branding_logo_guard';`
  4. Bucket. Expect 1 row: `true, 524288, 3`:
     `select public, file_size_limit, cardinality(allowed_mime_types) from storage.buckets where id = 'branding';`
  5. Three policies for `{authenticated}`: SELECT, INSERT, DELETE (no UPDATE):
     `select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'branding:%' order by cmd;`
  6. The function: empty search_path; no EXECUTE for anon, authenticated or PUBLIC. Expect `{search_path=""}`, then 0 rows:
     `select proconfig from pg_proc where pronamespace = 'private'::regnamespace and proname = 'branding_logo_guard';`
     `select grantee from information_schema.routine_privileges where routine_schema = 'private' and routine_name = 'branding_logo_guard' and grantee in ('anon', 'authenticated', 'PUBLIC');`
  7. The row: `select version, name from supabase_migrations.schema_migrations where version = '20261214000000';`
- **ROLLBACK** (redeploy a build from before it FIRST; one transaction. Saved branding is lost; logos stay in the bucket
  until it's emptied from the Storage dashboard, because a bucket with objects can't be deleted from SQL):
  ```sql
  begin;
  drop policy if exists "branding: managers read" on storage.objects;
  drop policy if exists "branding: managers upload" on storage.objects;
  drop policy if exists "branding: managers delete" on storage.objects;
  -- Only once the bucket is empty (empty it from the dashboard first): delete from storage.buckets where id = 'branding';
  drop trigger if exists branding_logo_guard on public.workspaces;
  drop function if exists private.branding_logo_guard();
  alter table public.workspaces drop constraint if exists workspaces_branding_shape;
  alter table public.workspaces drop column if exists branding;
  commit;
  ```

Body:

```sql
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
```

### Alongside the migration

- **Apply file** `packages/db/scripts/apply/20261214000000_client_branding.sql`: `begin;`, the migration SQL, the
  `insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261214000000', 'client_branding', array[$mig$…$mig$]);`
  row, `commit;` (copy the shape of `20261207700000_saved_text_privacy.sql`).
- `pnpm --filter @transpera-flow/db gen:bootstrap` (never by hand). `gen:seed` only if the seed changes (it shouldn't).
- **Hand-edit** `packages/db/src/database.types.ts` (`gen:types` needs the linked project): `workspaces.Row.branding: Json`,
  `Insert.branding?: Json`, `Update.branding?: Json`, alphabetical (first, before `created_at`).
- `docs/production-migrations.md`: a new row (next number at merge time) marked **NOT applied**.
- `docs/supabase-notes.md`: a "Client branding (#34, migration 20261214000000)" section, verified only against plain
  Postgres and the storage shim, with these live checks:
  - [ ] The migration can write to `storage` (as B19's did; if refused, create the bucket in the dashboard: public, 512 KB,
        the three types, and run the three `create policy` statements in the SQL editor).
  - [ ] As an owner, upload a PNG logo in Settings → Branding: it shows in the sidebar. As an editor, the upload is refused
        (403) and the page is read-only.
  - [ ] Signed out, the logo's public URL loads (`/storage/v1/object/public/branding/…`), served as `image/png` (or the
        type uploaded). Record whether the response carries `X-Content-Type-Options: nosniff`.
  - [ ] A file over 512 KB, and a file declared as `image/svg+xml`, are refused by the bucket.
  - [ ] Replacing and removing a logo deletes the old object (Storage dashboard).
  - [ ] Sweep of abandoned uploads (an upload whose check never ran is still public under a random name):
        `select name, created_at from storage.objects o where bucket_id = 'branding' and created_at < now() - interval '1 hour' and not exists (select 1 from public.workspaces w where w.branding ->> 'logo_path' = o.name);`
  - [ ] A deleted workspace's logo stays in the bucket (the same sweep lists it).

---

## App: exact files and functions

All new code under `apps/web/src/lib/branding/` is **framework-free** (no React, no Next, no `server-only`) so the browser,
the server actions and tests share it. No raw hex in components: hex lives only in `lib/branding/` (data) and in the
generated CSS string.

### 1. `apps/web/src/lib/branding/contrast.ts` (new, pure)

```ts
export type Theme = "light" | "dark";
export type Hex = `#${string}`; // always normalised: lower case, 6 digits

/** "#ABC", "abc", "#AABBCC" → "#aabbcc"; anything else → null. Accept 3 or 6 hex digits, optional '#', trims. */
export function normaliseHex(input: unknown): Hex | null;
/** WCAG 2.x relative luminance from 8-bit sRGB (0.04045 threshold, 2.4 exponent). */
export function relativeLuminance(hex: Hex): number;
/** (L1 + 0.05) / (L2 + 0.05), larger over smaller. */
export function contrastRatio(a: Hex, b: Hex): number;
/** OKLCH (L 0–1, C, h degrees) → hex, reducing chroma until it is inside sRGB (never clipping channels). */
export function oklchToHex(l: number, c: number, h: number): Hex;
export function hexToOklch(hex: Hex): { l: number; c: number; h: number };

/** The theme surfaces an accent sits on, as hex, mirrored from tokens.css (a test re-derives them from tokens.css). */
export const SURFACES: Record<Theme, { bg: Hex; panel: Hex; panel2: Hex }>; // light #fafafa #ffffff #f5f5f5; dark #0a0a0a #171717 #262626
/** The defaults, for the "Reset" button's preview and the tests. */
export const DEFAULT_ACCENT: Record<Theme, Hex>; // light #007595, dark #00b8db

export const MIN_CONTRAST = 4.5; // WCAG AA, normal text: the accent is used as small text (links, badges, icons)

/** The three tokens an accent sets in one theme. */
export function accentTokens(accent: Hex, theme: Theme): { accent: Hex; accentFg: Hex; accentSoft: Hex };
/** Every pair that must reach MIN_CONTRAST, with its ratio, worst first. */
export function accentChecks(accent: Hex, theme: Theme): { pair: "bg" | "panel" | "panel2" | "soft" | "fg"; ratio: number }[];
export type AccentVerdict =
  | { ok: true; worst: number }
  | { ok: false; worst: number; against: "bg" | "panel" | "panel2" | "soft" | "fg"; suggestion: Hex };
export function checkAccent(accent: Hex, theme: Theme): AccentVerdict;
/** The nearest passing colour: same hue (and chroma where sRGB allows), lightness moved darker (light) or lighter (dark). */
export function suggestAccent(accent: Hex, theme: Theme): Hex;
/** The dark-theme accent made from a light-theme one: same hue, the smallest lightness ≥ the light one's that passes. */
export function deriveDarkAccent(light: Hex): Hex;
/** A non-blocking note when the accent is close to a colour with a fixed meaning (Q9). */
export function reservedClash(accent: Hex, theme: Theme): "editing" | "critical" | "warning" | "good" | null;
```

Rules:
- **`accentTokens`**: `accentSoft` = OKLCH(l 0.95, c = min(c·0.25, 0.04), same h) in light; OKLCH(0.30, min(c·0.35, 0.06), h)
  in dark (the defaults are 0.95/0.025 and 0.30/0.05). `accentFg` = whichever of `#ffffff` and `#0a0a0a` contrasts more
  with the accent (light defaults to white text, dark to near-black, as today).
- **`accentChecks`** pairs: accent vs `bg`, `panel`, `panel2`, `soft` (its own derived soft), and `accentFg` vs accent. All
  must be ≥ 4.5. The focus ring is covered: 4.5 > the 3:1 non-text minimum.
- **`suggestAccent`**: OKLCH lightness in steps of 0.005 (darker for light, lighter for dark) from the input's own
  lightness; at each step reduce chroma until in gamut; return the first that passes `checkAccent`. Terminates (black
  passes light, white passes dark). A passing input returns itself. Deterministic.
- **`deriveDarkAccent`**: `suggestAccent(light, "dark")`, but starting from max(light's L, 0.6) so a dark-theme accent is
  never darker than its light one.
- **`reservedClash`**: OKLab distance < 0.08 from the theme's `--edit`, `--crit`, `--warn` or `--good` (mirror those four
  per theme in a constant next to `SURFACES`). Never refuses.
- Use `Math.pow`, `Math.cbrt`, `Math.cos` etc. freely: this is app code, not the engine (the `det-math.ts` rule is the
  engine's only).

### 2. `apps/web/src/lib/branding/branding.ts` (new, pure)

```ts
export interface Branding { accent: Hex | null; accentDark: Hex | null; logoPath: string | null }
/** The stored jsonb → Branding. Anything malformed (wrong type, bad hex, a path outside `<workspaceId>/`) reads as null. */
export function readBranding(raw: unknown, workspaceId: string): Branding;
/** What the shell applies: per theme, the three tokens, or null to keep the defaults. Re-checks contrast (render-time guard). */
export function resolveBranding(b: Branding): { light: AccentTokens | null; dark: AccentTokens | null };
/** The CSS the layout injects, or null when nothing is branded. */
export function brandingCss(b: Branding): string | null;
/** The logo's public URL from NEXT_PUBLIC_SUPABASE_URL, or null. */
export function logoUrl(path: string | null, supabaseUrl: string | undefined): string | null;
export const LOGO_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;
```

- **Render-time guard (important):** `resolveBranding` re-runs `checkAccent`. A stored accent that fails (written by an owner
  straight through PostgREST, or after a future token change) is **ignored** for that theme and the default stays. The dark
  theme uses `accentDark` if set and passing, else `deriveDarkAccent(accent)` if `accent` is set, else null. So contrast is
  guaranteed on screen whatever is stored; the database checks shape only (Q11).
- **`brandingCss`** emits exactly three blocks, mirroring tokens.css's selectors so specificity matches:
  ```css
  :root{--accent:#…;--accent-fg:#…;--accent-soft:#…}
  @media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--accent:#…;--accent-fg:#…;--accent-soft:#…}}
  :root[data-theme="dark"]{--accent:#…;--accent-fg:#…;--accent-soft:#…}
  ```
  (omit the light block if `light` is null, the two dark blocks if `dark` is null; null if both are). Only `Hex` values
  that came out of `normaliseHex` are interpolated, so nothing else can reach the CSS. A test asserts the output matches
  `/^[:a-z0-9#\-;{}()\[\]="\s@,]*$/i`.
- `--primary`, `--ring`, `--sidebar-primary`, `--sidebar-ring` and React Flow's `--xy-*` follow automatically (they are
  `var(--accent)`). **Don't** change `--token` (playback), `--chart-*`, `--edit`, the status or rating colours.

### 3. `apps/web/src/lib/branding/logo-check.ts` (new, pure)

```ts
export const MAX_LOGO_BYTES = 524_288; // 512 KB (the bucket's limit too)
export const LOGO_MIN_PX = 16, LOGO_MAX_PX = 2048;
export type LogoType = "png" | "jpg" | "webp";
export const LOGO_MIME: Record<LogoType, string>; // image/png, image/jpeg, image/webp
export type LogoCheck = { ok: true; type: LogoType; width: number; height: number } | { ok: false; error: string };
/** By content (magic bytes), never by name or declared type. */
export function checkLogo(bytes: Uint8Array): LogoCheck;
```

- **PNG**: signature `89 50 4E 47 0D 0A 1A 0A`, then `IHDR` width/height (big-endian at 16 and 20). Refuse if an `acTL`
  chunk appears before the first `IDAT` (animated PNG).
- **JPEG**: `FF D8 FF`; walk markers to the first SOF0–SOF15 (excluding C4, C8, CC) for height/width; refuse if none found.
- **WebP**: `RIFF` … `WEBP`; `VP8 ` (14-bit width/height at 26–29), `VP8L` (14-bit fields after the 0x2F signature) or `VP8X`
  (24-bit width−1/height−1 at 24–29; refuse if the animation flag, bit 1 of byte 20, is set).
- Size 1..512 KB; each side 16..2048 px. Anything else, including SVG, GIF, HEIC, AVIF, a truncated header: refused.
- Error wording (plain): "Use a PNG, JPG or WebP image. SVG isn't accepted because it can carry scripts." / "That image is
  over 512 KB." / "That image is too large: up to 2048 × 2048 pixels." / "That image is too small: at least 16 pixels each
  side." / "Use a still image, not an animation." / "That file isn't an image we can read."

### 4. `apps/web/src/lib/branding/upload.ts` (new, browser)

Copy `apps/web/src/lib/sources/upload.ts`: `uploadWorkspaceLogo(workspaceId, file): Promise<LogoResult>`:
`checkLogo` first (same words), then `supabase.storage.from("branding").upload(`${workspaceId}/${crypto.randomUUID()}.${type}`, file, { contentType: LOGO_MIME[type], upsert: false, cacheControl: "31536000" })`
(names are never reused, so a year's cache is safe), map 413 → "That image is over 512 KB.", 403 → "Only workspace owners
can change the branding.", then call the server action `attachWorkspaceLogo`.

### 5. `apps/web/src/app/w/[slug]/settings/branding/actions.ts` (new, `"use server"`)

Copy the shape of `settings/workspace-actions.ts` (`invalid`, `signedOut`, `signedIn()`, `refresh()` on save) and of
`attachSourceFile` (read back, check, keep or remove).

```ts
/** The light- or dark-theme accent. Null resets it (light: Transpera's default; dark: derived from the light one). Owners only. */
export async function saveBrandAccent(workspaceId: string, theme: Theme, base: string | null, value: string | null): Promise<SaveOutcome<string | null>>;
/** Keep a logo the browser just uploaded; deletes it on any refusal, and deletes the logo it replaces once kept. */
export async function attachWorkspaceLogo(workspaceId: unknown, path: unknown, base: unknown): Promise<LogoResult>;
/** Remove the logo (save null, then delete the object). */
export async function removeWorkspaceLogo(workspaceId: unknown, base: unknown): Promise<LogoResult>;
```

- `saveBrandAccent`: `isId(workspaceId)`, theme is `"light" | "dark"`, `base` string|null, `value` string|null. Normalise
  with `normaliseHex`; a non-null value that doesn't normalise → `invalid`. Run `checkAccent(value, theme)`; on failure
  return `{ status: "error", message }` **without calling the database**, where message is e.g. *"Too light to read on a
  white page: 2.9:1, and text needs 4.5:1. Try #0b6e8a, the nearest darker shade."* (dark: "Too dark to read on the dark
  page … the nearest lighter shade."; `fg` failure: "Button text can't be read on this colour …"). Then
  `saveField("workspaces", { id: workspaceId }, theme === "light" ? "branding.accent" : "branding.accent_dark", base, value)`.
- `attachWorkspaceLogo`: `path` must match `LOGO_PATH` **and** start with `${workspaceId}/` (else `invalid`, and remove
  nothing). Signed-in client; `storage.from("branding").download(path)` as the user; size ≤ `MAX_LOGO_BYTES`; `checkLogo`;
  the extension in the path must equal the checked type (else refuse). Refusals and errors remove the upload. Then
  `saveField("workspaces", { id }, "branding.logo_path", base, path)`; on `conflict` / `not_found` / `error` remove the new
  upload and return that outcome's message; on `saved`, remove `base` if it was a different path, then `refresh()`.
  Return `{ status: "ok", path, url: logoUrl(path, process.env.NEXT_PUBLIC_SUPABASE_URL) }`.
- `removeWorkspaceLogo`: `saveField(…, "branding.logo_path", base, null)`; on `saved` remove `base` from the bucket.
- Never use the service-role key (D12; the eslint rule covers `lib/supabase/**`).

### 6. `apps/web/src/app/w/[slug]/settings/branding/page.tsx` (new, server)

Copy `settings/ai/page.tsx`: `loadWorkspaceHead(slug)` (now with `branding`), `canManageWorkspace(head.id)`, render
`<BrandingSettings mode={canManage ? "live" : "readonly"} workspaceId … branding={readBranding(head.branding, head.id)}
logoUrl={…} name={head.name} saveAccent={saveBrandAccent} />`. Inside `<Page title="Branding" eyebrow="Settings">` like the
other sub-pages (check `settings/access/page.tsx` for the back link they use).

In `settings/page.tsx`, add an outline button **Branding** to `actions`, before Levers.

### 7. `apps/web/src/components/branding/branding-settings.tsx` (new, client)

Writes come in as props (server actions, or stand-ins in the browser harness), as `WorkspaceDetails` does.

- **Logo** section: the logo as the sidebar shows it (32 px tile) and larger (96 px) on a light and a dark panel; buttons
  **Upload logo** (hidden `<input type="file" accept="image/png,image/jpeg,image/webp">`) and **Remove**; hint "PNG, JPG or
  WebP, up to 512 KB and 2048 × 2048 pixels. A square logo with a transparent background works best."; progress and error
  text in an `aria-live="polite"` region. (i) help: "Your logo, shown at the top of the sidebar for everyone in this
  workspace." Example: "A 256 × 256 PNG of the company mark."
- **Accent colour** section: `<input type="color">` plus a hex text box (both edit the same value; save on change/blur via
  `useField` from `lib/fields/field-controller.ts`, so conflicts work like every other field). Live readout under it:
  "Light theme: 5.1:1 on the page. Passes." and "Dark theme (automatic): #4cc3e0, 7.2:1. Passes." On failure: the error text
  and a **Use #0b6e8a** button that saves the suggestion. **Reset to default** saves null. A disclosure "Use a different
  colour in dark mode" reveals the same field for `accent_dark` with **Use automatic** (saves null). `reservedClash` shows a
  soft note, e.g. "This is close to the purple that marks editing screens; people may misread it." (i) help: "The colour of
  buttons, links and highlights in this workspace. It must be readable on light and dark backgrounds." Example: "A brand
  purple like #7a1fa2; dark mode then uses a lighter shade of it." (Don't print a computed hex in help text.)
- **Preview**: a primary button, a link, the AI count badge and a focused input, on light and dark panels side by side. The
  preview sets the tokens as inline custom properties on its own wrapper (`style={{ "--accent": … }}`); it is the only
  place that does (portals aren't involved).
- Read-only mode: everything disabled, hint "Only workspace owners can change this." (same words as Workspace details).
- Wording follows D34: plain, an (i) per setting with a description and an example.

### 8. Shell: `apps/web/src/app/w/[slug]/layout.tsx`, `lib/data.ts`, `components/shell/*`

- `loadWorkspaceHead`: `select("id, name, slug, branding")`; return type `Pick<WorkspaceRow, "id" | "name" | "slug" | "branding">`.
  Check every caller still typechecks (it's widely used).
- `layout.tsx`: `const branding = readBranding(workspace.branding, workspace.id)`; `const css = brandingCss(branding)`;
  render `{css && <style data-brand="">{css}</style>}` **before** `<WorkspaceShell …>` (a fragment), so it applies on the
  full-screen Editor too (which skips the sidebar), and pass `logoUrl={logoUrl(branding.logoPath, process.env.NEXT_PUBLIC_SUPABASE_URL)}`.
  - Use a **plain** `<style>` (no `href`, no `precedence`). React 19 hoists a `<style precedence>` into `<head>` and never
    removes it, so moving from a branded workspace to an unbranded one would keep the old colours. A plain one renders in
    place and goes when the layout unmounts or re-renders for another slug. The browser test proves this.
- `ShellProps` (live variant) gets `logoUrl: string | null`; `AppSidebar` passes it to `WorkspaceSwitcher` as `logo`.
- `WorkspaceSwitcher`: with `logo`, the 32 px tile shows
  `<img src={logo} alt="" className="size-full object-contain p-0.5" />` on `bg-logo-tile ring-1 ring-line` instead of the
  monogram (the button's `aria-label` already names the workspace, so the image is decorative: `alt=""`). Add
  `{/* eslint-disable-next-line @next/next/no-img-element -- a small public logo; no optimiser, no remotePatterns */}`.
  `onError` falls back to the monogram (a deleted object must not show a broken image).
- `tokens.css`: add `--logo-tile: #ffffff;` in `:root` (not overridden in dark: a logo always sits on white, Q8) and
  `--color-logo-tile: var(--logo-tile);` in `globals.css`'s `@theme inline`.
- The Transpera mark and the "Transpera Flow" name in the sidebar header stay (Q7).
- Demo (`/demo`) is never branded.

### 9. Change log: `apps/web/src/lib/suggestions/audit.ts`

In the `workspaces` branch of `describeAuditEntry`, before the settings loop's return: if `oldRow.branding` or
`newRow.branding` differs, push "accent colour #aaa → #bbb" / "dark-mode accent → automatic" / "logo changed" / "logo
added" / "logo removed" (never print the storage path). The line reads "Branding: …" when only branding changed, else
joins into "Company settings: …".

### Share links (B3, #32): interaction, no dependency

B3 is being scoped in parallel and is not on `main`. Branding holds no personal or financial data, so a share snapshot may
carry it unredacted. **B5 doesn't depend on B3:**
- If B3's share route **is on `main` when you start**, render the same `<style>` (via `brandingCss`) and the logo
  (`logoUrl`) on it, reading branding from B3's snapshot payload or its workspace head; ask before changing B3's SQL.
- If not (the likely case), do nothing for share links and **add to the PR body and to a comment on #32**: "B5 is merged:
  share pages should add `branding` (`accent`, `accent_dark`, `logo_path`) to the snapshot and render
  `brandingCss(readBranding(…))` and `logoUrl(…)`. The logo is in a public bucket, so an anonymous visitor can load it."

### PDF and report colours

Nothing to build: D22 removed the PDF report. Don't add `report_colors` (Q2). Say so in the PR, and tick the PDF part of
the acceptance criterion as "superseded by D22".

---

## Patterns to copy

| For | Copy |
|---|---|
| Migration header, storage bucket + policies, storage guard trigger | `packages/db/supabase/migrations/20261204000000_process_admin_source_files.sql` (lines 1–130 and 770–846) |
| Apply file | `packages/db/scripts/apply/20261207700000_saved_text_privacy.sql` |
| Browser upload, then a server check that keeps or removes | `apps/web/src/lib/sources/upload.ts`, `attachSourceFile` in `apps/web/src/app/w/[slug]/source-actions.ts` |
| Owner-only field actions | `apps/web/src/app/w/[slug]/settings/workspace-actions.ts` |
| Read-only vs live settings sub-page | `apps/web/src/app/w/[slug]/settings/ai/page.tsx` |
| Field with conflict handling | `useField` in `apps/web/src/lib/fields/field-controller.ts`; `TextField` in `components/fields.tsx` |
| Storage policy tests | `packages/db/test/source-files.test.ts` (its `as`, `refused`, `upload` helpers) |
| Role tests | the "workspace name and currency" block in `packages/db/test/role-matrix.test.ts` |
| Server action tests with a fake Supabase | `apps/web/test/source-file-actions.test.ts` |
| Browser harness tests | `apps/web/test/manual-entry-browser.test.ts` + `manual-harness/entry.tsx` |

---

## Edge cases

- **Contrast in both themes.** Light accent checked against `#fafafa`, `#ffffff`, `#f5f5f5`, its soft tint and its button
  text; dark likewise against `#0a0a0a`, `#171717`, `#262626`. A colour that passes light usually fails dark: that's why
  dark is derived. A custom dark accent that fails is refused with a lighter suggestion.
- **Very saturated colours** (`#ff00ff`, `#00ff00`): the suggestion reduces chroma only as far as sRGB requires; hue kept.
- **Greys and black/white**: a grey accent is allowed if it passes (`#595959` passes light). `#000000` passes light; its
  derived dark is a light grey. Hue is undefined for greys: keep C = 0.
- **Hex input**: `ABC`, `#abc`, `#AABBCC`, spaces → normalised; `#abcd`, `rgb(…)`, names (`red`), `#gg0000`, empty → "Enter a
  colour as six hex digits, like #0b6e8a." Empty with Reset is null.
- **Stored but invalid** (PostgREST write, or tokens change later): the render-time guard drops it; Settings shows the
  stored value with the failing readout so an owner can fix it.
- **Clashes** with editing purple, critical red, warning amber, good green: soft note, never refused (Q9).
- **Logo types**: PNG, JPEG, WebP only. **SVG refused** (script and external-reference risk when opened directly on the
  storage origin). GIF, AVIF, HEIC refused. Animated PNG/WebP refused. Content is checked by magic bytes on the server; the
  declared type and the file name are never trusted; a PNG renamed `.jpg` is stored as `.png`.
- **Logo size**: ≤ 512 KB (bucket and app), 16–2048 px each side (decompression-bomb guard: a 512 KB PNG can declare 20000
  px). Wide wordmarks are allowed; `object-contain` letterboxes them in the square tile, and the preview shows how.
- **Dark mode logos**: shown on a white tile in both themes (Q8), so a dark logo stays visible.
- **Abandoned upload** (tab closed between upload and attach): public under a random name; the sweep lists it.
- **Concurrent edits**: two owners saving the accent → the usual keep-mine/keep-theirs prompt (`useField`). A logo attach
  that conflicts removes the new upload and says "Someone else changed the logo. Reload to see it."
- **Workspace switch**: branded → unbranded must restore the defaults without a reload (plain `<style>`, browser test).
- **MCP**: refused by the existing `needs_review` trigger (an `api_token_id` caller can't update `workspaces`). Test it.
- **Import/restore (B10)**: a restored workspace starts unbranded (Q10); the import inserts `workspaces` without
  `branding`, so the default `'{}'` applies. Check `workspace-import.test.ts` still passes.
- **Reduced motion**: nothing animates.
- **Keyboard**: the colour input, hex box, disclosure, Use/Reset/Upload/Remove buttons are all reachable and labelled;
  the file input is triggered by a real `<button>`.

---

## Tests

Run everything in `builder-brief.md` ("Before opening the PR"). New and changed tests:

**`packages/db/test/branding.test.ts` (new; harness `createTestDb`, storage shim):**
- New and existing workspaces have `branding = '{}'`.
- Shape: accepts `{}`, `{"accent": "#0b6e8a"}`, `{"accent": null, "accent_dark": "#aabbcc"}`, a logo path in its own folder
  (with the object present); refuses `#FFF`, `#abc`, `5`, an unknown key, a non-object, a logo path in another
  workspace's folder, `.svg`, a nested folder (each `23514`).
- Guard: a logo path with no object → `42501` "Upload the logo first…"; with the object → saved; the superuser (no JWT)
  passes; unchanged path on another update → no check.
- RLS via `save_fields('workspaces', {id}, …, {"branding.accent": …})`: owner and agency admin (JWT flag and membership)
  `saved`; editor, member, viewer, stranger `not_found`; an MCP caller (`api_token_id` claim) refused by `needs_review`.
- Storage: owner uploads `<ws>/<uuid>.png` → ok; editor, member, viewer, other workspace's owner → refused; bad names
  (`.svg`, `<ws>/x/<uuid>.png`, non-uuid) refused; owner selects and deletes; editor can't select or delete; anon can't
  select or insert; there is no update policy (an update as owner affects 0 rows).
- An accent change writes an `audit_log` row for `workspaces` naming the actor.

**`packages/db/test/role-matrix.test.ts`:** a "branding" block beside "workspace name and currency": the three manager
callers change `branding`, the four others don't.

**`apps/web/test/branding-contrast.test.ts` (new):**
- Luminance and ratio of known pairs: white/black 21:1; `#777777` on white ≈ 4.48 (fails); `#767676` ≈ 4.54 (passes).
- `SURFACES` and `DEFAULT_ACCENT` equal what tokens.css's oklch values convert to (parse tokens.css, so a token change
  breaks this test, not production).
- Both defaults pass every pair (numbers as in the audit).
- `#ffff00` (light) fails; its suggestion passes, keeps hue within 3° (after hex rounding), and one step lighter fails (nearest).
- `#000080` (dark) fails; its suggestion is lighter and passes.
- `deriveDarkAccent` passes for 200 hues × 3 lightnesses (a seeded loop) and never comes out darker than its input.
- A passing colour's suggestion is itself; `normaliseHex` cases; `accentFg` is white on a dark accent, near-black on a light.
- `reservedClash("#6d3fc4","light") === "editing"`; a teal returns null.

**`apps/web/test/branding-style.test.ts` (new):** `brandingCss({})` is null; light only → one block; light + derived dark →
three blocks with the right selectors; a stored failing accent is dropped for that theme only; `readBranding` turns
`"#fff;}body{display:none"`, a path from another workspace and wrong types into null; output matches the safe-character
regex; `logoUrl` builds `${url}/storage/v1/object/public/branding/<path>` and is null without a path or URL.

**`apps/web/test/branding-logo.test.ts` (new):** tiny fixtures built in the test (byte arrays, no binary files): a
16×16 PNG, a 2048×1 PNG, a 2049×10 PNG (refused), a 15×15 PNG (refused), an APNG (`acTL` before `IDAT`, refused), a JPEG
with SOF0, a JPEG with no SOF (refused), WebP `VP8 `, `VP8L`, `VP8X` still and animated (refused), an SVG string, a GIF, a
truncated PNG, 512 KB + 1 bytes (refused), empty.

**`apps/web/test/branding-actions.test.ts` (new, fake Supabase as in `source-file-actions.test.ts`):** a failing accent is
refused with the suggestion in the message and **no rpc call**; a passing one saves `branding.accent` lower-cased; the
dark theme saves `branding.accent_dark`; null resets; attach refuses a path outside the workspace's folder without removing
anything; refuses bad content and removes the upload; refuses an extension that doesn't match the content; on success
saves and removes the old logo; on conflict removes the new upload; remove saves null then deletes.

**`apps/web/test/suggestions.test.ts`:** branding change-log lines (accent, dark automatic, logo added/changed/removed; no
path printed).

**`apps/web/test/branding-browser.test.ts` + `branding-harness/entry.tsx` (new, Chromium):**
- Owner: type `#ffff00` → error text and a "Use #…" button; click it → the stand-in save receives the suggestion and the
  readout passes. Reset → null. Dark disclosure → the dark field works and "Use automatic" saves null.
- Viewer: every control disabled, the hint shown.
- `<style>` from `brandingCss` mounted: `getComputedStyle(documentElement)` `--accent` and `--primary` equal the brand
  value; with `page.emulateMedia({ colorScheme: "dark" })` they equal the dark value; unmount → the defaults again.
- The switcher with a logo renders the `<img>`; a broken URL falls back to the monogram. No console errors.

**`apps/web/test/shell-nav.test.ts`:** the live shell passes `logoUrl` through (null keeps the monogram).

Screenshots (builder brief): the Branding page in light and dark at 1440 and 400 px (harness), and the sidebar with a
logo and a brand accent. Put what you checked in the PR's Evidence.

---

## Out of scope

- The PDF report and "report colours" (removed by D22; Q2).
- Share-page wiring if B3 isn't on `main` (see "Share links").
- Branding in the JSON bundle export/restore (Q10).
- White-labelling the product: the "Transpera Flow" name and mark, the login page, emails, favicon, page titles (Q7).
- Fonts, chart colours, role colours, status colours, the Editor's purple.
- SVG logos, a separate dark-mode logo, image resizing or transforms.
- Logos on the agency "All workspaces" list.
- A theme toggle.
- Enforcing contrast inside Postgres (Q11).

## Done

- [ ] Migration `20261214000000_client_branding.sql` with full header (preflight, post-apply, rollback), apply file,
      `bootstrap.sql` regenerated, `database.types.ts` hand-edited, production-migrations row (NOT applied),
      supabase-notes section.
- [ ] An owner or agency admin uploads a PNG/JPEG/WebP logo ≤ 512 KB, 16–2048 px; it shows in the sidebar tile in both
      themes; replace and remove delete the old object. Editors, members and viewers see the page read-only.
- [ ] An accent failing 4.5:1 on any light surface, its soft tint or its button text is refused with the nearest passing
      colour offered; the dark accent (derived or custom) likewise. Tests prove both.
- [ ] Branding applies to every page of the workspace, the Editor included, in light and dark; an unbranded workspace is
      pixel-identical to today (no `<style data-brand>` rendered); switching workspaces swaps or clears it without a reload.
- [ ] A stored accent that fails is ignored on screen (render-time guard).
- [ ] The change log describes branding changes.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` and the web build pass; screenshots and evidence in the PR.
- [ ] PR body: `Closes #34`; the migration and apply file; the share-link note (and the #32 comment if B3 isn't merged);
      the PDF criterion marked superseded by D22; the defaults taken below, listed for Austin.

---

## Open questions (each with a default; build the default)

- **Q1. Who edits branding?** *Default: owners and agency admins (the `workspaces` update policy, as for name and currency,
  #190).* Everyone in the workspace sees it. Editors can't: branding is the client's identity, not the model.
- **Q2. Report colours.** The PDF is gone (D22), and nothing else is a "report". *Default: don't store them; drop from the
  ticket.* If Austin wants share pages or charts tinted later, that's a new ticket.
- **Q3. SVG logos.** *Default: refused.* PNG/JPEG/WebP only. A sanitiser is a dependency and a risk for little gain.
- **Q4. Public or private bucket.** *Default: public*, so anonymous share-link visitors (B3) can load it and signed links
  never expire mid-session. A logo is the company's public mark; names are random uuids under the workspace id. Uploads
  and deletes stay owners/agency admins only.
- **Q5. One accent or two.** *Default: one light-theme accent; the dark one is derived (same hue, lighter) unless the
  owner sets their own under "Use a different colour in dark mode".* One colour can't pass AA on both backgrounds.
- **Q6. Which contrast level.** *Default: 4.5:1 (AA normal text) against every surface the accent sits on, its soft tint
  and its button text*, because the accent is used as small text. 3:1 would let link text fail AA.
- **Q7. White label.** *Default: no.* The Transpera mark and name stay in the sidebar header; the client's logo replaces
  the workspace monogram.
- **Q8. Dark-mode logos.** *Default: one logo, always on a white tile.* No second upload.
- **Q9. Colours close to editing purple or the status colours.** *Default: a soft warning, never a refusal.*
- **Q10. Bundle export/restore.** *Default: not carried*; a restored workspace starts unbranded (the logo is a file, not
  in the bundle). Note it as a follow-up in the handover.
- **Q11. Contrast in the database.** *Default: no.* The app refuses at save time and ignores a failing value at render;
  Postgres checks only the shape. Only owners and agency admins can write it, and only to their own workspace.
- **Q12. Share links.** *Default: wire them only if B3 is on `main` when you start; otherwise leave the note on #32.*
- **Q13. The Editor.** *Default: branded too* (the `<style>` sits in the workspace layout, outside the shell). The
  Editor's own purple is unchanged.
