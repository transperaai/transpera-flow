# B3 build brief: view-only share links with redacted snapshots (#32)

Scoped 6 Oct 2026 (overnight run) against `origin/main` at 0152329 (#205 merged) plus `claude/b1-3-agency-list` (#206,
`20261209000000_agency_list`), merged locally for the audit only. Read `docs/plans/builder-brief.md` first; this brief adds
to it and wins where they differ. Follow it strictly. If something here is unclear or doesn't match the code, **ask; don't
guess.** Austin is asleep for this run: every open question below has a default, and you take it.

## Read this first: what needs Austin, and what doesn't

- **No new secret, no paid service** as long as the defaults below hold. The ticket says restricted links are verified "by
  magic link". Austin decided on 30 Sep: **Google sign-in only** (magic link was removed), and Supabase's built-in email
  can't send sign-in links to outside visitors without custom SMTP (HANDOVER, "Other open items": *Custom SMTP for
  Supabase auth emails before inviting clients*), which would be a new paid service and a new secret. So **restricted links
  verify the visitor by Google sign-in** (Q1). Don't add magic link, don't touch Supabase auth settings.
- **Two design calls for Austin to confirm, not blocking** (take the defaults, record them on #32 and in the HANDOVER's
  "Design calls Claude made"):
  - **Q1:** Google sign-in instead of magic link (above). A visitor without a Google account for that address can't open
    a restricted link.
  - **Q2:** what the toggles reveal, given Austin's #30 rule "members and viewers get no pay data". Default: **People on**
    shows real names; **Financials on** shows role rates, margins, overhead and the cost of insights, but **never one
    person's pay**: individual cost rates never leave the database in any share link, and figures that need them show "—"
    exactly as they do for members.
- **One deviation from the ticket's wording, by design (Q4):** the ticket says "A Postgres function builds a redacted
  snapshot per link". Here the **Next.js server** builds it from the existing loaders (through the same redacted
  `team_capacity` shape members get), and **Postgres refuses to store** any snapshot that still contains a name, an email,
  pay or (with Financials off) a financial field, and serves it to visitors only through a SECURITY DEFINER function keyed
  by an unguessable token. The browser still never receives hidden data, which is the ticket's point (PRD §9, D12).
  Rebuilding ~15 TypeScript loaders in SQL would duplicate them and drift. Record this in a new ADR (0016).

## The short version

| What | Where |
|---|---|
| Table `share_links` (token hash, target, toggles, allowed emails, expiry, frozen redacted `snapshot`, revoked, opens) | migration `20261218000000_share_links` |
| `private.share_snapshot_problem(...)`: the server-side leak check, run by a BEFORE trigger on every insert and update | same |
| `public.share_team_capacity(ws, show_people)`: `team_capacity`'s shape for a share link (labels or names, **no pay for anyone**) | same |
| `public.open_share_link(token)`: the only way a visitor reads anything (anon and authenticated) | same |
| `packages/db/src/share.ts`: snapshot types, `loadShareData`, `redactShareSnapshot`, `shareSnapshotLeaks`, `shareReaderDb` | new |
| `ProcessBundle.payHidden?: true`, honoured by `toEngineModel` | `packages/db/src/types.ts`, `model.ts` |
| A **Share** button and dialog on Overview, a process page, an issue page and a solution page (owners and editors) | `apps/web/src/components/share/` |
| **Share links** page: list, update snapshot, revoke | `/w/[slug]/share` |
| The visitor's page, read only, same screens in a new `"share"` mode | `/s/[token]` |
| Restricted links: "Continue with Google", back to the link after sign-in | `apps/web/src/app/s/[token]/`, `auth/callback/route.ts` |

One branch, one PR: `claude/b3-share-links` (this brief is its first commit). `Closes #32`. Migration version
**`20261218000000`**, name **`share_links`**. No engine change, no `ENGINE_VERSION` bump, no golden moves.

Build in this order, **commit and push after each step**:
1. Migration + apply file + `database.types.ts` hand edits + bootstrap + DB tests (`share-links.test.ts`, role matrix).
2. `packages/db/src/share.ts` + `payHidden` on the bundle + pure tests (`share-snapshot.test.ts`, numbers-match test).
3. PostgREST e2e (`postgrest-share-links.test.ts`).
4. The visitor page and the `"share"` mode on the four screens + browser test.
5. Share dialog, list page, server actions, sidebar item + tests.
6. Restricted links: Google sign-in round trip.
7. Docs: ADR 0016, `docs/supabase-notes.md`, `docs/production-migrations.md` row, PRD D44.

---

## Decisions (verbatim)

**#32 (the ticket), "What to build":**
> Owners and editors create token-based share links with a mode (view for now) and an expiry. A link shares a snapshot of
> one of: **Overview** (A35, #100), **a process page** (A38, #103), **an issue page** (A48, #113) or **a solution page**
> (A50, #115). The snapshot is read-only and uses the same screens and plain wording.
>
> Two independent toggles, both off by default:
>
> - **People:** off means people are anonymised by role ("Strategist A") and capacity factors are flattened.
> - **Financials:** off means cost rates are replaced by a role-average blended rate, margins and overhead are hidden,
>   costs per month on insights are hidden, and headline numbers show revenue only.
>
> The Clients toggle is dropped: named clients are hidden in the redesign and client groups carry no personal data.
>
> A Postgres function builds a redacted snapshot per link, so the browser never receives hidden data. If either toggle is
> on, the link must list allowed emails (the visitor verifies by magic link) and must have an expiry. Links can be revoked
> (PRD §9 Share links, decision D12).

**#32 acceptance criteria:**
> - Share links can be created from Overview, a process page, an issue page and a solution page, and listed and revoked in one place
> - Saving a link with any toggle on and no allowed emails or expiry is rejected (DB constraint and UI)
> - The snapshot payload for each toggle combination contains no hidden fields (tests inspect the raw payload, not the UI)
> - Restricted links require magic-link verification of an allowed email
> - Expired and revoked links return nothing
> - Headline numbers, ratings and the bottleneck on a redacted view match the unredacted run
> - Every setting, lever and rule on this screen has an (i) with a plain-English description and an example
> - Wording follows the prototype's plain language

**Austin, 6 Oct, on #30 (supersedes two of the ticket's lines):**
> Austin's decision on 6 Oct: **members and viewers get no pay data.** This replaces the cost part of A' and the brief's
> Q8 (role averages with a company-wide fallback).
>
> **Why.** The Opus review of #202 showed that overlapping averages let a member recover one person's exact rate by
> subtraction. One example: a role average plus a fallback company-wide average. Any average also gives a rate away over
> time when people join or leave.
>
> - `team_capacity` returns no cost rate for members and viewers, and nothing derived from rates.
> - Figures that depend on individual pay show "—" for them, with a short (i): "Only owners and editors see costs that
>   depend on people's pay." That's overtime cost and the cost attached to detected issues.
> - Everything else matches an editor's numbers exactly.

> - **What members and viewers receive:** the per-person simulation inputs under neutral labels ("Team member 3"). This
>   covers hours, roles, leave, skills and client assignments. Names, emails and notes are left out.

So, **for share links:** "a role-average blended rate" is **not** used (averages leak pay by subtraction); people are
labelled **"Team member N"** (the `team_capacity` numbering), not "Strategist A". The orchestrator's instruction for this
ticket: *"Redaction must follow #30's rules: no pay, no names beyond labels."*

**Austin, 30 Sep (HANDOVER, "Decisions from Austin"):**
> **Google sign-in only** stays (the #4 ticket said magic link; the app has "Continue with Google").

**PRD §9, Share links (D22 kept them):**
> - Token-based. `play` mode runs the engine client-side, so the browser receives a model snapshot. **The server builds a
>   redacted snapshot per link; the browser never receives data a toggle hides.**
>
> | Toggle (default off) | Off | On |
> |---|---|---|
> | People | People anonymised by role ("Strategist A"); capacity factors flattened to 1.0 | Real names, individual capacity factors |
> | Financials | Cost rates replaced by a role-average blended rate; margins and overhead hidden; KPIs show revenue only | Real rates, margins, overhead |
> | Clients | Clients anonymised ("Client 7"); health aggregated ("3 clients at risk") | Real client names and per-client health |
>
> - If any toggle is on: `allowed_emails` must be non-empty (visitor verifies by magic link) and `expires_at` is required.
> - View-only links get the same redaction applied to stored run results.
> - The only write a play link can make is a scenario submission (name, email, note, patch against redacted IDs), via a
>   rate-limited Postgres function into `scenario_submissions`. IDs are mapped back server-side on accept.

**PRD D12:**
> Server builds redacted snapshots; independent People/Financials/Clients toggles, default off; any toggle on requires
> allowed emails + expiry. MCP acts as the user under RLS, never with the service-role key.

**`docs/plans/redesign-plan.md`, B3 row:**
> Snapshots cover Overview, a process, an issue and a solution. Toggles become People and Financials; the Clients toggle is
> dropped.

**#33 (B4, builds on this):**
> A share link in `play` mode loads the redacted snapshot and runs the engine client-side with the visible levers enabled
> (Settings → Levers, A58, #123); nothing is saved. [...] Submission goes through a rate-limited Postgres function; it is
> the only write a play link can make. [...] Build it (opens the Editor in solution mode with the changes placed, redacted
> IDs mapped back to real ones server-side)

**HANDOVER, "Rules while Austin is away":** take the brief's default for open questions; stop and skip anything needing a
new secret, a paid service, or a design decision only Austin can make; never weaken a test.

**ADR 0010 (precedent for a token link):** "Signed URL = a random 256-bit token, base64url, whose SHA-256 is stored [...]
exchanges it through [...] a narrow security definer function that returns one report for one live token (granted to
`anon`); the proxy lets that path through without a session."

---

## Audit: what exists vs what #32 needs

| Area | Today | Needed | Change |
|---|---|---|---|
| `share_links` table | Doesn't exist (PRD §8 sketches it). `workspace-bundle.ts` already promises backups "never hold [...] share links" | Table, RLS, constraint, leak check | New (migration) |
| Token links | `reports.link_hash` + `public.report_download(token)` (20261019000000, unused since D22) | Same pattern | Copy it |
| Team inputs without pay | `public.team_capacity(ws)` (20261207500000): labels and null rates **for members**; editors get everything | A share link built by an editor must get labels (People off) and **no rate for anyone** | New `share_team_capacity(ws, show_people)` |
| `payHidden` | `toEngineModel` sets `payHidden` when `bundle.viewer && !viewer.seesEveryone` (`packages/db/src/model.ts:284, 672`) | People on needs names (`seesEveryone: true`) **and** hidden pay | `ProcessBundle.payHidden?: true`, OR-ed in |
| "—" for pay figures | `components/pay-hidden.tsx` (`PayHidden`), used by `kpi-strip.tsx`, `insights.tsx` (×2), `findings/facts-list.tsx`, `issues-register.tsx` | Same, plus "money hidden" when Financials off | New `MoneyHidden` next to it |
| Name scrubbing | `labelNames(text, labels, people)` in `packages/db/src/person-labels.ts` (full names any case; unique first names ≥ 3 letters as written) | Free text in a People-off snapshot | Reuse |
| Findings naming | `nameFinding(row, who)` | Accepted findings in a snapshot | Reuse with the snapshot's viewer |
| Issues for a reader | `loadIssuesForReader(db, ws)` (`can_see_people` rpc decides key masking) | Same | Via `shareReaderDb` |
| Page loaders | `apps/web/src/lib/data.ts`, `lib/overview/data.ts`, `lib/ai/data.ts`: each calls `createClient()` itself | The snapshot builder must load with a wrapped `Db` | Move `loadLiveParts`' body into `packages/db` (below); call `packages/db` loaders directly |
| Screen modes | `"live" \| "demo" \| "readonly"` on `Overview`, `ProcessView` (`EditMode`), `IssuePage`, `SolutionPage`, `useIssues`, `useFindings`, `connect()`, `AiMode`, `linking.tsx` … | A mode that is read only **and** makes no server or Realtime call | Add `"share"` |
| Public paths | `proxy.ts`: `PUBLIC_PATHS = ["/login", "/auth", "/demo", "/privacy"]` | `/s/...` reachable signed out | Add `"/s"` |
| Sign-in return | `signInWithGoogle()` → `/auth/callback` → always `/` | Back to `/s/<token>` | Short-lived cookie |
| Nav | `lib/shell/nav.ts` `groups()` `extra.{settings,access,levers,ai}` | "Share links" for owners and editors | `extra.share` |
| Prototype | `apps/web/prototype/app-flow.html` has **no** share screen | Wording | Use the wording in this brief |
| MCP | No share tools | None (out of scope); refuse API tokens in the trigger | Trigger |

**Surprises worth knowing:**
- **Ids feed the engine's random streams** (HANDOVER, #207 note: "ids feed the random streams, so exact seed equality is
  impossible" after a restore). Replacing ids in a snapshot would move every number and break "match the unredacted run".
  So snapshots keep **real ids** (random uuids carry no data). B4's "map redacted ids back" becomes "check each id belongs
  to the workspace" (Q5).
- **Client names are in every bundle** (`bundle.clients[].name`, `notes`; D27 hides them on screen but they still reach the
  browser today for every reader). Snapshots always relabel them "Client N" and drop notes (the dropped Clients toggle
  means "always off").
- **Provenance holds evidence quotes** (ADR 0007) that can name people and clients. Snapshots empty every `provenance`.
- **`loadMemberNames` reads `people` directly** (`lib/data.ts`); in an editor's session it returns real names. Never call
  it for a snapshot: pass `{}` (the screens then say "A team member").
- The Overview's `mode === "live"` effect records headline numbers (`recordHeadline`, B1 3/3). `"share"` must never do it.
- `connect()` (`lib/realtime/connect.ts`) opens a Supabase Realtime channel for `"live"` and `"readonly"`. `"share"` must
  use the in-memory backend with no transport and no colleague.

---

## Data model and migration

File: `packages/db/supabase/migrations/20261218000000_share_links.sql`. **Strictly additive**: one table, one trigger
function, three functions, one trigger. Nothing existing is changed: not `save_fields`, not `team_capacity`, no existing
policy or grant.

**Order:** after whatever B2 (#31) adds (expected `20261210000000`) and after `20261209000000` (#206) and `20261208000000`
(#207). If any of those lands with a later version, this one is renumbered (HANDOVER, "Migration order").

### Table `public.share_links`

```sql
create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Lowercase hex SHA-256 of the token; the token itself is never stored (shown once, like an API token).
  token_hash text not null constraint share_links_token_hash check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null constraint share_links_kind check (kind in ('overview', 'process', 'issue', 'solution')),
  -- The process, issue or solution shared; null for the Overview. Not a foreign key (it points at one of three tables).
  target_id uuid,
  mode text not null default 'view' constraint share_links_mode check (mode in ('view', 'play')),
  show_people boolean not null default false,
  show_financials boolean not null default false,
  allowed_emails text[] not null default '{}',
  expires_at timestamptz,
  label text constraint share_links_label check (label is null or char_length(btrim(label)) between 1 and 120),
  snapshot jsonb not null,
  snapshot_at timestamptz not null default now(),
  engine_version text not null constraint share_links_engine_version check (char_length(engine_version) between 1 and 32),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  opens integer not null default 0,
  last_opened_at timestamptz,
  constraint share_links_target check ((kind = 'overview') = (target_id is null)),
  -- PRD §9 / D12: any toggle on needs allowed emails and an expiry.
  constraint share_links_restricted check (
    (not show_people and not show_financials) or (cardinality(allowed_emails) > 0 and expires_at is not null)),
  constraint share_links_emails check (private.share_emails_ok(allowed_emails)),
  constraint share_links_snapshot_size check (octet_length(snapshot::text) <= 5242880)
);
create unique index share_links_token_hash_key on public.share_links (token_hash);
create index share_links_workspace_idx on public.share_links (workspace_id, created_at desc);
```

`private.share_emails_ok(text[]) returns boolean` (immutable, `set search_path = ''`): at most 50 entries, each
`= lower(btrim(e))` and matching `'^[^@\s]+@[^@\s]+\.[^@\s]+$'` (the `workspace_access_emails` rule), no duplicates.
Define it **before** the table.

**RLS and grants** (owners, editors, agency admins only; members, viewers and anon nothing):
```sql
alter table public.share_links enable row level security;
create policy "read share links" on public.share_links for select to authenticated using (public.can_edit_workspace(workspace_id));
create policy "create share links" on public.share_links for insert to authenticated with check (public.can_edit_workspace(workspace_id));
create policy "update share links" on public.share_links for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
-- No delete policy: links are revoked, never deleted (they go with their workspace).
revoke all on public.share_links from anon, authenticated;   -- Supabase re-grants new tables to anon by default
grant select (id, workspace_id, kind, target_id, mode, show_people, show_financials, allowed_emails, expires_at, label,
  snapshot_at, engine_version, created_by, created_at, revoked_at, revoked_by, opens, last_opened_at)
  on public.share_links to authenticated;                      -- not token_hash, not snapshot
grant insert (workspace_id, token_hash, kind, target_id, show_people, show_financials, allowed_emails, expires_at, label,
  snapshot, engine_version) on public.share_links to authenticated;   -- not mode: 'view' only until B4
grant update (label, snapshot, engine_version, revoked_at) on public.share_links to authenticated;
```
No `audit` trigger (it would copy the multi-megabyte snapshot into `audit_log`); `created_by`/`revoked_by` record who.

### Trigger `share_links_before_write` (BEFORE INSERT OR UPDATE, `private.share_links_before_write()`, SECURITY DEFINER, `set search_path = ''`)

1. **No API tokens:** `if coalesce(auth.jwt(), '{}') ? 'api_token_id' then raise ... errcode '42501'` ("Share links are
   made in the app."). Same test as `20261015000000_suggestions.sql:523`.
2. **Insert:** stamp `created_by := auth.uid()`, `created_at := now()`, `snapshot_at := now()`, `opens := 0`,
   `last_opened_at := null`, `revoked_at := null`, `revoked_by := null`. Refuse `mode <> 'view'` (22023, "Play links come
   later."; B4 replaces this function). Refuse `expires_at <= now()` (22023). Check the target belongs to the workspace
   (22023 "That isn't in this workspace."): `process` → `processes` row with this `workspace_id`, a `live_revision_id`,
   `archived_at is null`, `not is_company`; `issue` → `issues`; `solution` → `solutions`.
3. **Update:** `workspace_id, token_hash, kind, target_id, mode, show_people, show_financials, allowed_emails, expires_at,
   created_by, created_at` may not change (22023; column grants already stop `authenticated`, this stops definer paths).
   A revoked link stays revoked: `old.revoked_at is not null` → refuse any change except the counters written by
   `open_share_link` (which never touches a revoked row anyway; simplest: refuse every update of a revoked row, 22023 "This
   link was turned off."). When `revoked_at` goes from null to not null: `revoked_at := now()`, `revoked_by := auth.uid()`.
   When `snapshot` changes: `snapshot_at := now()`.
4. **Leak check** on insert and whenever `snapshot` changes:
   `problem := private.share_snapshot_problem(new.workspace_id, new.kind, new.snapshot, new.show_people, new.show_financials)`;
   if not null, `raise exception '%', problem using errcode = '23514'`.

### `private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean) returns text`

`language plpgsql stable`, `set search_path = ''`, execute revoked from public (only the definer trigger calls it).
Returns null when clean, else a plain message naming **what** leaked, never the leaked value itself (no name, no email in
the message). Checks, in order:

| # | Check | Applies | Message |
|---|---|---|---|
| 1 | `jsonb_typeof(snap) = 'object'`, `snap->>'v' = '1'`, `snap->>'kind' = kind`, `(snap->'toggles'->>'people')::boolean = show_people`, same for `financials` | always | "The snapshot doesn't match the link." |
| 2 | `snap::text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'` | always | "The snapshot contains an email address." |
| 3 | `jsonb_path_exists(snap, 'lax $.**.cost_rate ? (@ != null)')` | always (no pay, Q2) | "The snapshot contains a person's pay." |
| 4 | `jsonb_path_exists(snap, 'lax $.**.provenance.*')` | always | "The snapshot contains evidence notes." |
| 5 | Any **client** name of `ws` (`clients.name`, `char_length(btrim(name)) >= 3`) found in `snap::text` with no letter or digit either side; single-word names matched case-sensitively (`~`), multi-word case-insensitively (`~*`); regex-escape the name | always (clients are always anonymised) | "The snapshot names a client." |
| 6 | Same as 5 for every **person** of `ws` (`people.name`, active or not) | `not show_people` | "The snapshot names a person." |
| 7 | `jsonb_path_exists(snap, 'lax $.**.default_cost_rate ? (@ != 0)')`, `'lax $.**.margin ? (@ != 0)'`, `'lax $.**.overhead_monthly'`, `'lax $.**.target_margin'` | `not show_financials` | "The snapshot contains costs or margins." |

Boundary pattern (both 5 and 6): `'(^|[^[:alnum:]])' || escaped || '($|[^[:alnum:]])'` where
`escaped := regexp_replace(btrim(name), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')`. Names shorter than 3 characters are not
checked (same floor as `labelNames`). The TypeScript side (`redactShareSnapshot`) also scrubs **unique first names**; the
database checks **full names** only (first names would refuse links over common words like "Will" or "Mark").

Test each row's jsonpath on a plain Postgres 16 first; if a `lax $.**` form doesn't behave as written, use the `strict`
form or a recursive SQL walk, and note it in `docs/supabase-notes.md`.

### `public.share_team_capacity(ws uuid, show_people boolean) returns jsonb`

SECURITY DEFINER, `stable`, `set search_path = ''`. Copy `public.team_capacity`'s body from
`20261207500000_per_person_privacy.sql` with exactly these changes:
- Guard: `if ws is null or show_people is null or not public.can_edit_workspace(ws) then raise ... errcode '42501'`
  (only those who may make links).
- `everyone := show_people; own := null;` (no "own person" in a share link).
- `name`: real when `show_people`, else `'Team member ' || n` (same `row_number() over (order by created_at, id)` over all
  people, active or not, so labels match what members see).
- `cost_rate`: **always null.**
- `provenance`: **always `'{}'`.**
- Order: as `team_capacity` orders for `everyone` (by name, then `n`) when `show_people`, else by `n`.
- Returns the same keys: `sees_everyone` (= `show_people`), `own_person_id` (null), `people`, `person_roles`,
  `person_skills`, `person_leave`, `client_assignments`.

`revoke execute ... from public, anon; grant execute ... to authenticated;`

### `public.open_share_link(token text) returns jsonb`

SECURITY DEFINER, **volatile** (it counts opens), `set search_path = ''`. Granted to `anon` and `authenticated`, revoked
from public.

```
if token is null or token !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
select * into l from public.share_links
  where token_hash = encode(pg_catalog.sha256(pg_catalog.convert_to(token, 'UTF8')), 'hex')
    and revoked_at is null and (expires_at is null or expires_at > now()) and mode = 'view';
if not found then return null; end if;          -- unknown, expired and revoked all look the same: nothing
if l.show_people or l.show_financials then
  if auth.uid() is null then return jsonb_build_object('status', 'sign_in'); end if;
  select lower(u.email) into e from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null;
  if e is null or not (e = any (l.allowed_emails)) then return jsonb_build_object('status', 'not_allowed'); end if;
end if;
update public.share_links set opens = opens + 1, last_opened_at = now() where id = l.id;
return jsonb_build_object('status', 'ok', 'kind', l.kind, 'mode', l.mode, 'show_people', l.show_people,
  'show_financials', l.show_financials, 'snapshot_at', l.snapshot_at, 'expires_at', l.expires_at, 'snapshot', l.snapshot);
```
Never return `workspace_id`, `token_hash`, `allowed_emails`, `created_by` or `label`. `sign_in` and `not_allowed` carry
nothing else. The counter update runs inside the definer function; the trigger allows it (it changes no guarded column,
and the row is not revoked).

### Migration header (write all of it)

Purpose; the rules above; `ORDER`; **PREFLIGHT** (read-only, `prod-sql.sh -c`, one file at a time):
0. Latest applied versions; expect nothing `>= '20261218000000'`:
   `select version from supabase_migrations.schema_migrations where version >= '20261207500000' order by 1;`
1. Nothing created yet. Expect null ×5:
   `select to_regclass('public.share_links'), to_regprocedure('public.open_share_link(text)'), to_regprocedure('public.share_team_capacity(uuid, boolean)'), to_regprocedure('private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)'), to_regprocedure('private.share_emails_ok(text[])');`
2. Helpers exist. Expect 3 rows: `can_edit_workspace`, `team_capacity`, `can_read_workspace` in `public`.
3. `pg_catalog.sha256` and jsonpath work. Expect `t, t`:
   `select encode(pg_catalog.sha256('x'::bytea), 'hex') ~ '^[0-9a-f]{64}$', jsonb_path_exists('{"a":{"cost_rate":1}}', 'lax $.**.cost_rate ? (@ != null)');`
4. `auth.users.email_confirmed_at` exists. Expect 1:
   `select count(*) from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at';`
5. For the log: people and clients whose names the check will look for (≥ 3 characters), per workspace:
   `select w.slug, (select count(*) from public.people p where p.workspace_id = w.id and char_length(btrim(p.name)) >= 3), (select count(*) from public.clients c where c.workspace_id = w.id and char_length(btrim(c.name)) >= 3) from public.workspaces w order by 1;`

**POST-APPLY CHECK:**
1. RLS on and three policies. Expect `t`, `3`.
2. anon holds nothing on the table; authenticated has column-level SELECT/INSERT/UPDATE only (list them):
   `information_schema.role_table_grants` and `column_privileges` for `share_links`.
3. Function privileges. Expect `t, t, f, t, f, f`:
   `has_function_privilege('anon','public.open_share_link(text)','execute')`, `('authenticated', same)`,
   `('anon','public.share_team_capacity(uuid, boolean)','execute')`, `('authenticated', same)`,
   `('authenticated','private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)','execute')`,
   `('anon', same)`.
4. `prosecdef` and `proconfig`: `open_share_link` t, `share_team_capacity` t, `share_links_before_write` t,
   `share_snapshot_problem` f; all `{search_path=""}`.
5. Smoke test, **rolled back**, as an agency admin on Northbeam (production Northbeam has no owner):
   `begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated","app_metadata":{"agency_admin":true}}', true);`
   insert a link with token hash of a known 43-char token and a minimal clean snapshot
   (`{"v":1,"kind":"overview","toggles":{"people":false,"financials":false}}`, `engine_version '1.8.0'`) → succeeds;
   the same with `"x":"<a real person's full name>"` → 23514 "The snapshot names a person."; then
   `set local role anon; select public.open_share_link('<token>') ->> 'status';` → `ok`; `rollback;`.

**ROLLBACK** (one transaction; nothing existing changed):
```sql
begin;
drop function if exists public.open_share_link(text);
drop function if exists public.share_team_capacity(uuid, boolean);
drop table if exists public.share_links;
drop function if exists private.share_links_before_write();
drop function if exists private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean);
drop function if exists private.share_emails_ok(text[]);
delete from supabase_migrations.schema_migrations where version = '20261218000000';
commit;
```

**Apply file:** `packages/db/scripts/apply/20261218000000_share_links.sql`: header comment (copy the pattern of
`packages/db/scripts/apply/20261209000000_agency_list.sql`: what, order, "apply BEFORE deploying the app"), `begin;`,
`set local lock_timeout = '5s';`, the migration SQL, the `insert into supabase_migrations.schema_migrations (version,
name, statements) values ('20261218000000', 'share_links', array[$mig$<the migration SQL>$mig$]);`, `commit;`.

Then: `pnpm --filter @transpera-flow/db gen:bootstrap` (never by hand); hand-edit `packages/db/src/database.types.ts`
(the table's Row/Insert/Update and the two public functions' Args/Returns, in the generator's alphabetical order, as #206
did), since `gen:types` needs the linked project.

---

## Snapshot: exactly what it holds

`packages/db/src/share.ts` (new, exported from `index.ts`). Pure except `loadShareData`.

```ts
export const SHARE_SNAPSHOT_VERSION = 1;
export type ShareKind = "overview" | "process" | "issue" | "solution";
export interface ShareToggles { people: boolean; financials: boolean }

interface ShareSnapshotBase {
  v: 1;
  kind: ShareKind;
  toggles: ShareToggles;
  workspaceName: string;
  /** Every bundle in the snapshot: viewer set, payHidden true, people/clients/roles/services/settings redacted. */
}
export interface OverviewShare extends ShareSnapshotBase { kind: "overview"; live: ProcessBundle; parts: ProcessPart[];
  company: ProcessPart | null; issues: IssueRow[]; solutions: SolutionsData; solutionBases: Record<string, { steps: StepRow[]; edges: EdgeRow[] }>;
  findings: FindingRow[]; firstPrinciples: FirstPrinciples | null }
export interface ProcessShare extends ShareSnapshotBase { kind: "process"; bundle: ProcessBundle; processes: { id: string; name: string; parentId: string | null }[];
  scenarios: ScenarioRow[]; issues: IssueRow[]; liveRevisions: Record<string, string>; solutions: SolutionsData; findings: FindingRow[];
  firstPrinciples: FirstPrinciples | null }
export interface IssueShare extends ShareSnapshotBase { kind: "issue"; issueId: string; bundle: ProcessBundle; issues: IssueRow[];
  processes: { id: string; name: string }[]; liveRevisions: Record<string, string>; solutions: SolutionsData }
export interface SolutionShare extends ShareSnapshotBase { kind: "solution"; solutionId: string; bundle: ProcessBundle; solutions: SolutionsData;
  issues: IssueRow[]; processes: { id: string; name: string }[]; compareBase: { steps: StepRow[]; edges: EdgeRow[] } | null; movedOn: boolean }
export type ShareSnapshot = OverviewShare | ProcessShare | IssueShare | SolutionShare;
```
(`SolutionsData`, `ProcessPart` live in apps/web today: move the **types** to `packages/db/src/types.ts` if they aren't there,
and re-export from the app modules so nothing else changes. Use the exact prop types the four pages pass.)

**Mirror each page's composition** (the page file is the spec; copy its data, not its editor-only extras):

| Kind | Mirror | Leave out (never in any snapshot) |
|---|---|---|
| overview | `components/overview/workspace-overview.tsx` | sources, AI views (`ai`), `aiSettings`, `companyEditHref`/history/bundle hrefs, earlier map versions; findings are **accepted only** (`loadFindings(db, ws, ["accepted"])`); `solutionBases`: every solution whose `base_revision_id` ≠ its process's live revision (don't import `solutionsToCompare` from the app) |
| process | `components/workspace-process-page.tsx` (live version only) | sources, AI views, `ideaIssueIds`, `lastChange`, `memberNames`, `viewerId`, draft and earlier versions, `processPicker` |
| issue | `app/w/[slug]/issues/[number]/page.tsx` | sources, `events` (history names people), `ideas`, `memberNames`, `viewerId`, `buildHref` |
| solution | `app/w/[slug]/solutions/[id]/page.tsx` | sources, `memberNames`, `viewerId`; `solutions` filtered to this solution and its links |

Refuse to build (return a plain error to the dialog): an unpublished or archived process, the company map process itself
("Share the Overview instead."), an issue or solution that isn't found.

### `shareReaderDb(db: Db, toggles: ShareToggles): Db`

A `Proxy` over the editor's `Db` that changes exactly two rpc calls and nothing else:
- `rpc("team_capacity", { ws })` → `db.rpc("share_team_capacity", { ws, show_people: toggles.people })`;
- `rpc("can_see_people", ...)` → resolves `{ data: toggles.people, error: null }`.
Every other call passes through. Unit-test both redirections and the pass-through.

### `loadShareData(db: Db, workspace, target: { kind; id: string | null }, toggles): Promise<ShareSnapshot>`

Loads through `shareReaderDb(db, toggles)` with `packages/db` loaders only (`loadProcessBundle`, `loadProcessBySlug`,
`loadIssuesForReader`, `loadSolutions`, `loadSolutionIssues`, `listProcesses`, `loadLiveRevisionIds`, `loadScenarios`,
`loadFindings`, `loadFirstPrinciplesFor`, `loadLiveCompanyPart`, and `loadLiveParts`, whose body moves from
`apps/web/src/lib/overview/data.ts` into `packages/db/src/queries.ts` as `loadLiveParts(db, ws)`; the app function keeps
its name and delegates). Findings are named with `nameFinding(row, { viewer, people })` using the snapshot bundle's
viewer and people. Then returns `redactShareSnapshot(raw, toggles, secrets)` where `secrets` (real names and ids of people
and clients) is read with the **unwrapped** editor `db` (`team_capacity` for people; `clients` table for clients) and is
**never** put in the snapshot.

### `redactShareSnapshot(raw, toggles, secrets): ShareSnapshot` (pure)

Applied to **every** `ProcessBundle`-shaped object in the snapshot (`live`, `bundle`, each of `parts`, `company`, each of
`otherProcesses`, anything else carrying `workspace`/`people`). Typed, field by field:

| Field | People off | People on | Financials off | Financials on |
|---|---|---|---|---|
| `viewer` | `{ seesEveryone: false, ownPersonId: null }` | `{ seesEveryone: true, ownPersonId: null }` | – | – |
| `payHidden` | `true` | `true` | – | – |
| `people[].name` | "Team member N" (from `share_team_capacity`) | real | – | – |
| `people[].cost_rate`, `provenance` | null, `{}` | null, `{}` | – | – |
| `clients[].name`, `notes`, `provenance` | "Client N" (rank by `created_at, id` over all clients), null, `{}` | same (always) | – | – |
| `roles[].default_cost_rate` | – | – | `0` | kept |
| `services[].margin` | – | – | `0` (engine: "carried for reporting, not used by the KPIs yet") | kept |
| `workspace.settings` | – | – | drop `overhead_monthly`, `target_margin` | kept |
| `workspace.provenance`, every `provenance` | `{}` | `{}` | | |
| `workspace.slug` | `""` | `""` | | |

Then one generic pass over **every string** in the snapshot:
- any email address → `"[email hidden]"` (always);
- People off: `labelNames(text, labels, people)` with the people's real names → their "Team member N" label;
- always: the same for clients' real names → "Client N";
- Financials off: money amounts → `"[amount hidden]"`: currency symbol forms (`£`, `$`, `€`, `A$`, `US$`) followed by a
  number with optional `,`/`.` and `k`/`m`/`bn`, and number + ISO code (`GBP|USD|EUR|AUD|NZD|CAD`). (Q9)

Finally set `v`, `kind`, `toggles`, `workspaceName`.

### `shareSnapshotLeaks(snapshot, secrets, toggles): string[]` (pure)

The TypeScript twin of `share_snapshot_problem`, plus first names: walk the JSON and return a list of problems (never the
leaked values): non-null `cost_rate` anywhere; non-empty `provenance`; an email; a person's full name or unique first
name (≥ 3 letters, `labelNames`' rule) when People off; a client name; and with Financials off `default_cost_rate` ≠ 0,
`margin` ≠ 0, `overhead_monthly`/`target_margin` present, a money amount in text. The server action calls it after
redacting and refuses to save when it isn't empty (the database checks again).

### `ProcessBundle.payHidden`

`packages/db/src/types.ts`: add to `ProcessBundle`
`/** Pay is hidden even though the viewer may see everyone (a share link, B3). */ payHidden?: true;`.
`packages/db/src/model.ts`: add `function hidesPay(b: ProcessBundle): boolean { return b.payHidden === true || (!!b.viewer && !b.viewer.seesEveryone); }`
and use it at lines 284 and 672 (and any other **pay** decision on `seesEveryone` in `packages/db/src`: grep; there are
14 `seesEveryone` uses across db and web, most are about whose **row/name** shows; change only the pay ones). No golden
moves (no fixture sets `payHidden`); run `pnpm --filter @transpera-flow/engine test` and the golden check to prove it.

---

## The app

### Visitor page `apps/web/src/app/s/[token]/page.tsx` (Server Component)

- `await connection()`; `const { token } = await props.params;` (Next 16: params are async; read
  `node_modules/next/dist/docs/` for `connection`, `notFound` and `generateMetadata` before writing).
- `const db = await createClient();` (anon, or the signed-in visitor) → `db.rpc("open_share_link", { token })`.
  - `null` or error → `notFound()`; `app/s/[token]/not-found.tsx` says **"This link has expired or been turned off."**
    and "Ask whoever sent it for a new one." (No hint which.)
  - `sign_in` → `<ShareSignIn token>`: "This link is only for the people it was shared with. Sign in with Google using
    the email address it was sent to." Button **Continue with Google**.
  - `not_allowed` → "This link wasn't shared with **{your email}**." Link **Sign in with a different account**
    (`/auth/signout`, then back here). Read the email from `db.auth.getUser()`, never from the link.
  - `ok` → check `snapshot.v === 1` (else "This link needs to be made again. Ask whoever sent it for a new one.") and
    render `<SharedView data={...} />`.
- **This file imports nothing from `@/lib/data`, `@/lib/overview/data`, `@/lib/ai/data` or any `createClient`-based
  loader** (a source-text test checks it). The snapshot is the only data the page passes on.
- `generateMetadata` → `{ title: "Shared view", robots: { index: false, follow: false } }`.
- `apps/web/next.config.ts` `headers()`: for `source: "/s/:path*"`: `Referrer-Policy: no-referrer`,
  `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`.
- `apps/web/src/proxy.ts`: add `"/s"` to `PUBLIC_PATHS`.

### `SharedView` (`apps/web/src/components/share/shared-view.tsx`, client)

A frame with no sidebar or workspace switcher: top bar with the workspace name, **"Shared view · read only"**, "As of
{snapshot date}" and, when set, "Link works until {date}"; one line per hidden toggle:
- People off: "People are shown as Team member 1, 2, 3." (i)
- Financials off: "Costs, margins and overhead are hidden. Revenue is shown." (i)
Then the screen for its kind, with `mode="share"`, empty hrefs (in-page links to other pages render as plain text), no
source linking (a no-op scope, like `DemoSourceLinkingScope` but linking nothing), and a `ShareContext`
(`{ financials: boolean }`). Footer: "Made with Transpera Flow". If a screen needs a provider `WorkspaceShell` gives
(sidebar context, tooltip), add `mode="share"` to `WorkspaceShell` that renders the providers and the header but **no nav
groups, no switcher, no counts**; don't fork the screens.

### Mode `"share"` on the four screens

Add `"share"` to the mode unions in: `components/overview/overview.tsx`, `components/process-view.tsx` (`EditMode`),
`components/issues/issue-page.tsx`, `components/solutions/solution-page.tsx`, `components/issues-page.tsx`,
`components/sources/linking.tsx`, `lib/issues/use-issues.ts`, `lib/findings/use-findings.ts`, `lib/realtime/connect.ts`,
`lib/ai/types.ts` (`AiMode`), and whatever the typecheck then names. Add `apps/web/src/lib/mode.ts`:
```ts
export type ScreenMode = "live" | "demo" | "readonly" | "share";
/** Nothing on screen can be changed. */ export const isReadOnly = (m: ScreenMode) => m === "readonly" || m === "share";
/** Reads and writes go to the server (Supabase, server actions, Realtime). */ export const usesServer = (m: ScreenMode) => m === "live" || m === "readonly";
```
Then grep every `mode === "readonly"`, `mode !== "readonly"`, `mode === "live"`, `mode !== "live"`, `mode === "demo"`,
`mode !== "demo"` in the components these screens render and decide each one with the helpers:
- edit controls, Analyse, Accept/Dismiss, Log an issue, Build solution, + Link, Restore, Editor links → hidden for
  `isReadOnly`;
- stores: `useIssues`/`useFindings` → the in-memory store (as `"demo"`), never `liveIssueStore`;
- `connect("share", …)` → `{ backend: new MemoryDraftBackend(live, null), transport: null, colleague: null }` (as
  `connectScratch`);
- the Overview's `recordHeadline` effect: `mode === "live"` only (it already is; keep it so);
- `useSuccessMeasures(…, mode === "demo")` and any other "demo" special case: share behaves like readonly **without**
  server calls; where demo shows sample-only extras (the simulated colleague, tours), share shows none.

**Money with Financials off** (`useShareFinancialsHidden()` from `ShareContext`, false outside a share): where a component
already shows `<PayHidden />` for pay (`kpi-strip.tsx`, `insights.tsx` ×2, `findings/facts-list.tsx`,
`issues-register.tsx`), also show `<MoneyHidden />` for **any money cost of an insight or issue** (`cost.perMonth`) and
the **Overtime cost** KPI. Hours (`cost.hoursPerMonth`) stay. Revenue figures (New MRR, Billed, LTV added, Lost revenue,
the MRR chart) stay. Then grep the four screens for `formatIssueCost`, `formatMoney`, `money(` and gate any other
cost/margin/overhead figure the same way. `components/money-hidden.tsx`, next to `pay-hidden.tsx`:
```ts
export const MONEY_HIDDEN_HELP = { label: "Money hidden", description: "This shared view hides costs, margins and overhead. Revenue is still shown.", example: "The cost of an issue shows —, but New MRR shows £12.4k." } as const;
```

### Making links: `apps/web/src/app/w/[slug]/share-actions.ts` (`"use server"`)

- `createShareLink(slug, input: { kind, targetId, people, financials, emails: string, expiresOn: string | null, label })`
  → `{ status: "ok", url } | { status: "error", message }`:
  1. `canEditWorkspace(ws)` else error "Only owners and editors can share."
  2. Validate (same rules as the DB): emails split on commas/whitespace/newlines, trimmed, lower-cased, de-duplicated, ≤ 50,
     each valid; `expiresOn` a date after today (the link works until 23:59:59 UTC that day); any toggle on → at least one email and an expiry ("Add at least one email address." / "Choose
     when the link stops working."). Label ≤ 120.
  3. `const db = await createClient()`; `loadShareData(db, workspace, target, toggles)`; `shareSnapshotLeaks(...)` must be
     empty (else log the problem kinds and return "Couldn't make a safe copy of this page. Nothing was shared.").
  4. Token: `randomBytes(32).toString("base64url")` (43 chars); hash: SHA-256 hex (`node:crypto`).
  5. Insert (`token_hash`, …, `snapshot`, `engine_version: ENGINE_VERSION`). Map 23514 to "Couldn't make a safe copy of
     this page. Nothing was shared." and the constraint names to the messages above.
  6. URL: `${origin}/s/${token}`; origin from `headers()` as `signInWithGoogle` does. Return it **once**; it is never
     stored or shown again (Q6).
- `refreshShareLink(slug, id)`: reload the row's kind/target/toggles, rebuild, `update share_links set snapshot,
  engine_version`. Errors: target gone ("That page no longer exists, so the link keeps its last copy."), revoked.
- `revokeShareLink(slug, id)`: `update share_links set revoked_at = now()`.
- `revalidatePath(`/w/${slug}/share`)` after each.

### Share dialog `apps/web/src/components/share/share-dialog.tsx` (client)

A **Share** button (owners/editors only, i.e. `mode === "live"`) on: the Overview header, the process page header (live
version, not archived, not the company map), the issue page and the solution page. Fields, each with an (i)
(`components/help.tsx`):

| Field | Default | (i) description | (i) example |
|---|---|---|---|
| **What's shared** (read only) | "The Overview" / "{process}" / "Issue #N" / "{solution}" | "Anyone with the link sees a read-only copy of this page as it is now. They can't change anything." | "Send the Overview to a new hire's manager." |
| **Show people's names** (switch) | off | "Off: everyone is shown as Team member 1, 2, 3. On: real names. Pay is never shared." | "Off: 'Team member 3 is too busy'. On: 'Sam Rivera is too busy'." |
| **Show costs and margins** (switch) | off | "Off: only revenue is shown; costs, margins, overhead and the cost of each issue are hidden. On: they're shown, except anything that depends on one person's pay." | "Off: an issue's cost shows —. On: '£4.1k a month'." |
| **Who can open it** (textarea; shown and required when a switch is on) | empty | "Only these people can open the link, after signing in with Google using that email address." | "sam@northbeam.co, ops@northbeam.co" |
| **Link works until** (date) | 30 days from today; "No end date" allowed only with both switches off | "The link stops working at the end of this day." | "30 days from today." |
| **Name** (optional) | empty | "Only you and other editors see this, on Share links." | "For Northbeam's board, October." |

Button **Create link**. After success the dialog shows the URL in a read-only field with **Copy link** and: "Copy it now:
you won't see this link again. You can turn it off any time on Share links." and a link to `/w/[slug]/share`. Errors show
inline in plain words.

### List `apps/web/src/app/w/[slug]/share/page.tsx`

Owners/editors (others: `notFound()`). Title **Share links**, intro: "Read-only copies of pages you've shared. A link
shows the page as it was when you made it." Table (newest first): **What** (Overview / process name / Issue #N / solution
name; "(deleted)" when the target is gone), **Name**, **Shows** ("Team member labels" or "Names"; "Revenue only" or "Costs
and margins"), **Who** ("Anyone with the link" or "N people", the emails in a tooltip), **Works until**, **Opened** ("3
times, last 5 Oct" / "Not yet"), **Made by** (via `loadMemberNames`: this page is editors-only), **Status** (Active /
Expired / Turned off), actions **Update copy** (i: "The link shows the page as it was when you made it. Update it to show
today's version. The link stays the same.") and **Turn off** (i: "Stops the link working for everyone, straight away. It
can't be turned back on."; confirm). Empty state: "Nothing shared yet. Use Share on the Overview, a process, an issue or a
solution." Sidebar: `lib/shell/nav.ts` `extra.share` → item `{ key: "share", label: "Share links", path: "/share", icon:
"share" }` after Access, shown when the viewer can edit (gate it as `extra.settings` is gated in
`app/w/[slug]/layout.tsx`; add a lucide `Share2` icon to `app-sidebar.tsx`'s map). Demo: no Share button, no item.

### Restricted links: sign-in round trip

- `apps/web/src/app/s/[token]/actions.ts`: `signInToOpen(token)`: validate `^[A-Za-z0-9_-]{43}$`, set cookie
  `tf_after_sign_in=/s/<token>` (`httpOnly`, `secure` in production, `sameSite: "lax"`, `path: "/"`, `maxAge: 600`), then
  the same OAuth call as `signInWithGoogle` (factor the shared part into one helper in `app/login/actions.ts`).
- `apps/web/src/app/auth/callback/route.ts`: after a successful exchange (and `resolve_my_access` as now), read the
  cookie **before** clearing the query; if it matches `^/s/[A-Za-z0-9_-]{43}$`, redirect there instead of `/`; always
  delete the cookie. Anything else is ignored (no open redirect). Don't use a `next` query parameter: Supabase's redirect
  allow-list would need changing (Austin's dashboard).
- Signing out from the `not_allowed` page: `/auth/signout` then back to the link (check what the route supports; if it only
  goes to `/login`, the copy says "then open the link again").

---

## Patterns to copy

| What | From |
|---|---|
| Token link, hash, anon definer function | `20261019000000_reports.sql` (`link_hash`, `report_download`), ADR 0010 |
| Team inputs function | `public.team_capacity` in `20261207500000_per_person_privacy.sql` |
| Trigger stamping the caller, refusing forged columns | `private.workspace_headlines_stamp` in `20261209000000_agency_list.sql` |
| Refusing API tokens | `20261015000000_suggestions.sql` line 223/523 (`auth.jwt() ? 'api_token_id'`) |
| Kept-revoked rule | `public.api_tokens_keep_revoked()` in `20260930040000_api_tokens.sql` |
| Email format | `workspace_access_emails_email_format` in `20260930030000_workspace_access.sql` |
| Migration header, apply file | `20261209000000_agency_list.sql` and its apply file |
| Members' numbers equal editors' | `packages/db/test/team-capacity.test.ts` ("Larkspur: a member's numbers equal an editor's exactly…") |
| Role matrix | `packages/db/test/role-matrix.test.ts` (`TABLES`, `ROLES`, `RPCS`) |
| PostgREST e2e with anon/authenticated JWTs | `packages/mcp/test/postgrest-roles.test.ts`, `postgrest-db.ts`, `helpers.ts` (`signJwt`) |
| Browser harness | `apps/web/test/restore-browser.test.ts` + `restore-harness/entry.tsx`, `overview-browser.test.ts` |
| Read-only screens with in-memory stores | the `"demo"` branches of `useIssues`, `useFindings`, `connect()` |
| "—" with (i) | `components/pay-hidden.tsx` |

---

## Edge cases

- **Expired, revoked, unknown, malformed token** → the same `notFound()` page. A revoked link stays off (trigger).
- **Expiry passes while a visitor has the page open**: they keep what they loaded; the next load is "expired". Fine.
- **Restricted link, visitor signed in to the app as a workspace member** with an allowed email → sees the snapshot like
  anyone (not their member view). With another email → `not_allowed`.
- **Email case**: stored lower-case; compared with `lower(auth.users.email)`; only confirmed emails count.
- **Visitor signs in with Google for the first time**: `resolve_my_access` runs as for anyone (they join nothing unless
  listed), and `/auth/callback` sends them back to the link. They land on `/` only if the cookie is missing.
- **The target changes after the link is made**: the link shows its copy until **Update copy**. Deleted target: the
  copy stays; Update copy explains why it can't.
- **Person deleted or renamed after the copy**: the copy is frozen; labels in it stay consistent with each other.
- **A typed issue title or step note names a person** ("Ask Sam"): People off → "Ask Team member 2" (`labelNames`). A
  first name shared by two people isn't replaced by `labelNames`, so after it runs, replace any remaining shared first
  name (≥ 3 letters, as written) with "a team member" (Q11), and have `shareSnapshotLeaks` check shared first names too.
- **Short names** (< 3 characters) are not scrubbed or checked (same floor as B1 2b). Accepted.
- **A client name that is a common word** ("Blue"): single-word names are matched case-sensitively in both checks.
- **Money in free text with Financials off** ("costs £4,100 a month") → "[amount hidden]"; revenue in text is hidden too
  (simple and safe).
- **Snapshot too large** (> 5 MB): the constraint refuses; the dialog says "This page is too big to share." Assert in
  tests that Northbeam's and Larkspur's Overview snapshots are under 2 MB, and log their sizes in the PR.
- **Engine updated after the copy** (`ENGINE_VERSION` bump): the visitor's browser simulates the copy with today's
  engine; numbers can move as they would for editors. Shown nowhere; `engine_version` is stored for diagnosis.
- **Snapshot format changes later**: bump `SHARE_SNAPSHOT_VERSION`; old links say "needs to be made again".
- **An editor loses edit rights**: their links keep working (owner/editors can revoke them). `created_by` is set null if
  the user is deleted.
- **Workspace deleted** → links cascade away.
- **Backups** (`workspace-bundle.ts`) never include share links (already documented); restore ignores them.
- **MCP / API token** creating or updating a link → 42501.
- **Signed-out visitor and the simulation worker**: check the engine worker script loads under `/s/...` for a signed-out
  browser (proxy matcher); the browser test covers it.
- **Referrer leak**: links on the shared page to external sites must not send the token (`Referrer-Policy: no-referrer`).
- **Search engines**: `noindex`.

---

## Tests

### DB (plain Postgres; `packages/db/test/share-links.test.ts`, and extend `role-matrix.test.ts`)

- Role matrix: add `share_links` to `TABLES` (read/insert/update: owner, editor, agency_admin yes; member, viewer no; no
  delete for anyone) and `open_share_link`, `share_team_capacity` to `RPCS` (anon: open only).
- Constraint: People on with no emails → 23514 `share_links_restricted`; with emails, no expiry → 23514; Financials on,
  same two; both off with neither → ok.
- Emails: upper case, bad format, duplicate, 51 entries → refused.
- Trigger: `created_by` forged → stamped to caller; `mode = 'play'` → 22023; expiry in the past → 22023; target in
  another workspace (each of the three kinds) → 22023; unpublished/archived/company process → 22023; API-token claims →
  42501; revoke stamps `revoked_at`/`revoked_by`; un-revoke and any update of a revoked row → refused; guarded columns
  unchanged by a definer path.
- Leak check, one test per row of the table above (each refused with its message and 23514; message contains no name or
  email): email anywhere; non-null `cost_rate` at depth (even with both toggles on); non-empty `provenance`; a client's
  name; a person's full name with People off (any case for two words; exact case for one word) and allowed with People on;
  each financial field with Financials off and allowed with it on; `v`/`kind`/toggles mismatch; > 5 MB.
- `open_share_link`: anon + valid open link → `ok`, returns exactly the listed keys, `opens` 1 then 2; unknown, malformed,
  expired, revoked → null; restricted + anon → `{"status":"sign_in"}` only; restricted + signed-in unlisted →
  `not_allowed`; listed but unconfirmed email → `not_allowed`; listed `Sam@X.example` signing in as `sam@x.example` →
  `ok`. Anon can't `select` from `share_links` (permission denied).
- `share_team_capacity` on Larkspur (it has rates; set them as `team-capacity.test.ts` does): editor, `false` → every name
  "Team member N" (same N as `team_capacity` gives a member), every `cost_rate` null, provenance `{}`; editor, `true` →
  real names, rates still null; member/viewer → 42501; anon → no execute.

### Pure (`packages/db/test/share-snapshot.test.ts`)

- `shareReaderDb`: redirects the two rpcs, passes everything else through unchanged.
- `redactShareSnapshot` on fixture-built raw snapshots of **all four kinds × all four toggle combinations**, for Northbeam
  and Larkspur (`demoBundle()`-style fixtures; give Larkspur people rates, emails and notes and clients notes and
  provenance first, so there is something to leak): `JSON.stringify(snapshot)` contains no email, no person's full or
  unique first name (People off), no client name, no non-null `cost_rate`, no non-empty `provenance`, and (Financials off)
  no `overhead_monthly`/`target_margin`, `default_cost_rate` all 0, `margin` all 0, no money amount; with toggles on, the
  names/role rates/margins **are** there (so the test proves something). `shareSnapshotLeaks` returns `[]` for each, and
  returns the right problem kinds for a hand-made leaky copy of each.
- **Numbers match** (copy the team-capacity Larkspur test): editor bundle vs the People-off, Financials-off snapshot's
  bundle: `simulate(model, 30, 1)` → equal `bnRole`; equal `kpi.mrrAdded`, `kpi.billed`, `kpi.ltvAdded`,
  `kpi.lostRevenue`, `clientsAtRisk`, `clientsChurned`; `detectIssues` → the same keys with the same ratings; overtime
  cost null; costs that need pay `payHidden`. Same for People on / Financials on. If any rating or the bottleneck moves
  because role rates are 0 or margins are 0, **stop and report** (don't change the redaction to make it pass).
- `payHidden`: a bundle with `viewer.seesEveryone: true` and `payHidden: true` gives `model.payHidden === true` and no
  person `cost`; goldens unchanged.

### PostgREST e2e (`packages/mcp/test/postgrest-share-links.test.ts`, skipped without `POSTGREST_URL`)

As an editor JWT on Larkspur (with rates, emails, notes seeded): `loadShareData` + `redactShareSnapshot` for each kind
and each toggle combination → insert through PostgREST → `open_share_link` as an **anon** JWT (and as an allowed signed-in
JWT for restricted ones) → assert on the **raw JSON returned by PostgREST**: no names (People off), no emails, no pay, no
financial fields (Financials off). A hand-made leaky snapshot inserted through PostgREST → 400 with code 23514. A member
JWT → insert refused, select returns nothing. An API-token request → 42501. This is the acceptance test "tests inspect the
raw payload".

### Web (`apps/web/test/`)

- `share-source.test.ts` (source text): `app/s/[token]/page.tsx` imports no `createClient`-based loader and calls only
  `open_share_link`; `proxy.ts` lists `/s`; `next.config.ts` sets the three headers for `/s/:path*`.
- `share-actions.test.ts`: input validation (emails parsing, toggle-on rules, expiry, label) as a pure function
  `parseShareInput` exported from `lib/share/input.ts`; the callback's cookie check (`afterSignInPath(cookie)`) accepts
  only `/s/<43 chars>`.
- `share-browser.test.ts` (Chromium harness): `SharedView` for an Overview, a process, an issue and a solution copy built
  from the Northbeam fixture with People off and Financials off: renders without console errors; makes **no network
  request** outside the harness origin (`page.on("request")`); has no Edit, Analyse, Accept, Dismiss, Log an issue, Build,
  + Link or Share buttons; shows "Team member"; shows "—" with the money (i) for an issue cost; shows New MRR. Then the
  `ShareDialog`: switching People on makes "Who can open it" required; Create with no emails shows "Add at least one
  email address."; success shows the URL once with Copy link. Screenshots light/dark at 1440 and 400 px (builder-brief).

Run everything per `builder-brief.md` (Postgres, Chromium, `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter
@transpera-flow/web build`).

---

## Out of scope

- **Play mode** (B4, #33): `mode` accepts `'play'` in the table check, but the trigger refuses it and the insert grant
  omits `mode`. B4 replaces the trigger function, adds the grant, enables levers in `SharedView`, and adds the submission
  function. Snapshots already carry full engine inputs (redacted), so B4 needs no new snapshot fields for levers; it will
  need `lever_settings` (add it to the process/overview snapshot then).
- Magic link, custom SMTP, emailing links. The owner copies the link and sends it.
- Sharing sources, AI summaries, AI ideas, issue history, drafts, earlier versions, Forecast, People, Settings.
- MCP tools for share links.
- Branding on the shared page (B5, #34).
- Per-visitor analytics beyond the open count; IP logging.
- Editing a link's toggles, emails or expiry (make a new link and turn the old one off).

## Done criteria

- [ ] Migration `20261218000000_share_links` with full header (preflight, post-apply, rollback); apply file; bootstrap
      regenerated; `database.types.ts` hand-edited; row added to `docs/production-migrations.md` as **NOT applied**.
- [ ] Share button on Overview, process, issue and solution pages (owners/editors); Share links page lists, updates and
      turns off links; sidebar item.
- [ ] Toggle on without emails or expiry refused by the DB constraint and the dialog.
- [ ] Raw-payload tests (pure and PostgREST) pass for every kind × toggle combination; the DB refuses leaky snapshots.
- [ ] Restricted links need Google sign-in with an allowed, confirmed email; the round trip returns to the link.
- [ ] Expired, revoked and unknown links show "This link has expired or been turned off."
- [ ] Numbers-match test passes (bottleneck, revenue KPIs, ratings).
- [ ] Every field in the dialog and every action on the list has an (i) with a description and an example.
- [ ] No `ENGINE_VERSION` change; goldens untouched.
- [ ] ADR `docs/adr/0016-share-links.md` (server-built frozen snapshots checked by Postgres; real ids; Google
      verification; no pay ever; what is left out). `docs/supabase-notes.md`: the jsonpath and regex checks, anon calling
      a definer function over PostgREST, `auth.users.email_confirmed_at` for Google users, anon re-grant on new tables.
      PRD §13: a D44 row "Share links (B3)" summarising Q1–Q12 as "Claude's defaults, for Austin to confirm".
- [ ] `pnpm lint && pnpm typecheck && pnpm test` and the web build green locally; draft PR with `Closes #32`, the
      migration and apply file paths, and the preflight queries in the body.

## Open questions (each with the default the builder takes)

| # | Question | Default |
|---|---|---|
| Q1 | Magic link (the ticket) or Google sign-in for restricted links? | **Google sign-in** (Austin, 30 Sep; magic link needs custom SMTP, a new paid service). |
| Q2 | What do the toggles reveal, given "no pay" (#30)? | People on: real names. Financials on: role rates, margins, overhead, insight costs; **never individual pay** ("—" as for members). |
| Q3 | Frozen copy or live data on each visit? | **Frozen** at creation, with **Update copy**. |
| Q4 | Who builds the snapshot? | The Next server from the existing loaders; **Postgres checks** it on every write and serves it by token (ADR 0016). |
| Q5 | Redacted ids? | **Real ids** (they seed the random streams; uuids carry no data). B4 checks ids belong to the workspace instead of mapping. |
| Q6 | Can the link be copied again later? | **No**: shown once, only its hash stored (as API tokens and ADR 0010). |
| Q7 | What is left out of every snapshot? | Sources, AI summaries, proposed findings, AI ideas, issue history, author names, drafts, earlier versions, provenance, emails, notes. |
| Q8 | Expiry for open links? | Optional; the dialog pre-fills 30 days. Restricted links must have one. |
| Q9 | Money in free text with Financials off? | Replaced by "[amount hidden]" (revenue too). |
| Q10 | Clients? | Always "Client N", notes dropped (the Clients toggle is gone). |
| Q11 | A first name two people share, in free text, People off? | Replaced by "a team member" (not refused). |
| Q12 | MCP? | Refused (42501); no tools. |
| Q13 | Where is the list? | `/w/[slug]/share`, sidebar "Share links" for owners and editors. |
| Q14 | Count opens? | Yes: a count and the last time; nothing about who. |

## Amendments after the Opus review (#215)

Names: any case, any white space between the words, a surname of 3+ letters on its own; a lone first name stays an accepted limit (app only, as written). Quotes from sources are dropped from findings. Role-rate patches are dropped with Financials off. Restricted links need a Google identity. Issue order with Financials off is rating then key. See docs/adr/0016-share-links.md.
