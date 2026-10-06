# B1 build brief: roles and visibility (#30)

Scoped 5 Oct 2026 against `main` at 453d40c. Read `docs/plans/builder-brief.md` first; this brief adds to it and wins
where they differ. Follow it strictly. If something here is unclear or doesn't match the code, **ask; don't guess.**

## The short version

Most of B1 already exists. Access without email invites (#51, PR #55, ADR 0003), the five roles, the RLS helpers, Google
sign-in, the workspace switcher and the read-only UI for members and viewers have all shipped. What's left:

| Slice | What | Migration | Status |
|---|---|---|---|
| **B1 (1/3)** | Keep an owner; link any member to a person; role-matrix RLS tests; read-only UI audit; copyable invite message | `20261206000000_membership_guards` | **Build now** |
| **B1 (2/3)** | Per-person privacy: only admin, owner, editor and the person themselves see per-person data | version from the orchestrator | **Blocked on Q1** |
| **B1 (3/3)** | Agency workspace list with headline numbers | version from the orchestrator | Build after 1/3 (non-blocking defaults below) |

Each slice is its own branch and PR. 1/3 closes nothing. 3/3 closes #30 with `Closes #30` if 2/3 has merged; otherwise the
last one to merge does. B2 (#31) depends on 2/3 for "A member viewing People sees only their own record".

---

## Decisions (verbatim)

**Austin, 30 Sep (HANDOVER, "Decisions from Austin"):**
> **Google sign-in only** stays (the #4 ticket said magic link; the app has "Continue with Google").

So the acceptance criterion **"Google sign-in works alongside magic link" is superseded.** Don't add magic link. Google
sign-in already works (`apps/web/src/app/login/actions.ts`, `signInWithGoogle`).

**#30 comment (29 Sep 2026):**
> Access decision (29 Sep 2026, with Austin): **no email invites**. Staff join via Google/Microsoft sign-in using
> per-workspace **allowed domains** (auto-join as `member`) and a **pre-assigned email → role** list managed by
> agency_admin + owner. Split out as #51. For this ticket, read 'invite by email' as 'managed via #51'; the role/visibility
> RLS work here is unchanged. Google sign-in shipped in #48; magic link was removed.

**#51 (closed, PR #55):**
> Client staff get into their company's workspace by signing in with Google (Microsoft later). **No invitation emails.**

> Who manages the access list, domains and roles: **agency_admin and the workspace owner**. Editors cannot.

**ADR 0003:**
> Owners cannot grant, change or remove `agency_admin` memberships; `agency_admin` can't be pre-assigned.

**HANDOVER, "Other open items":**
> Custom SMTP for Supabase auth emails before inviting clients.

So the acceptance criterion **"Invite by email with a role; accepting creates the membership" is met by the access list**:
an owner adds an email and a role (and optionally a person) on Settings → Access, and signing in with Google *is*
accepting. That creates the membership (`public.resolve_my_access()` from `/auth/callback`). **Send no email.** 1/3 adds a
"Copy invite message" button so the owner can send the sign-in link themselves.

**PRD §2 (visibility rules, v1):**
> Per-person data (capacity, utilisation, capacity factor) is visible to `agency_admin`, `owner` and `editor`, **and to
> the person themselves**. `member` sees roles, their own record and the clients assigned to them only.

The ticket drops the last clause: "There are no per-client records any more … so there is no "assigned clients" rule."
Follow the ticket.

**PRD D20:**
> Capacity, not performance: individual availability/skills/assignments; capacity factor off by default, shown only when
> measured, visible to the person, never ranked; no role-median benchmark. DPA clause in the retainer.

**HANDOVER, design call Claude made (not yet confirmed):**
> Workspace name and currency are owner-only (#190).

Keep it. Editors change every other setting. "Only owners and editors … change Settings" in #30 is otherwise already true.

**ADR 0002 (MCP):** the MCP endpoint runs every query as the token's owner under RLS. **MCP needs no role code of its
own**: every RLS change here applies to API tokens automatically.

---

## Audit: what exists vs what #30 needs

Helpers today (`20260929000000_init.sql`, amended by `20260930030000_workspace_access.sql`):
`is_agency_admin()` (JWT `app_metadata.agency_admin`), `workspace_role(ws)` (SECURITY DEFINER, active memberships only),
`can_read_workspace` (admin or any active membership), `can_edit_workspace` (admin, agency_admin, owner, editor),
`can_manage_workspace` (admin, agency_admin, owner). Nearly every RPC is SECURITY INVOKER, so RLS decides. The SECURITY
DEFINER ones check roles themselves (`restore_version`, `reserve_ai_run`, `log_process_import`, `revision_history`,
`workspace_members`) or are scoped to the caller (`resolve_my_access`).

Legend: R = select, W = insert/update/delete. "edit" = `can_edit_workspace`, "read" = `can_read_workspace`, "manage" =
`can_manage_workspace`.

| Table / feature | Current | Required by #30 | Change | Slice |
|---|---|---|---|---|
| `people` | R read; W edit | R: edit, or own person; W edit | New select policy | 2/3 |
| `person_leave`, `person_skills`, `person_roles` | R read; W edit | Same as `people` (availability, skills and assignments are per-person, D20) | New select policies | 2/3 |
| `client_assignments` (`person_id` not null) | R read; W edit | Same as `people` (who looks after which client is an assignment) | New select policy | 2/3 |
| `runs`, `robustness_results` | R read; W edit | `results` holds per-person utilisation. Nothing in the redesigned workspace UI shows saved runs (only `/demo/larkspur` uses `SaveRunBar`) | R: edit only (default for Q4) | 2/3 |
| `suggestions` | R read; W edit | A suggestion with `target_table = 'people'` is a per-person change | R: edit, or `target_table <> 'people'`, or `target_id` = own person | 2/3 |
| Engine input for members (people, leave, skills, roles, assignments) | Read straight from the tables in `loadProcessBundle` and `loadClients` (`packages/db/src/queries.ts`) | Members still need correct company numbers | New RPC; see Q1 | 2/3 |
| `issues`, `issue_*`, `findings`, `ai_analyses`, `ai_runs` | R read; W edit (`issues` W also excludes `source='detected'`) | Members and viewers read only | None. Tests only | 1/3 |
| `solutions`, `solution_issues` | R read; W edit (column grants) | Same | None. Tests only | 1/3 |
| `blocks` | R read; W edit | Same | None. Tests only | 1/3 |
| `sources`, `source_links`, `storage.objects` (sources bucket) | R read; W edit | Same | None. Tests only | 1/3 |
| `suggestion_proposals`; `review_suggestions`, `review_proposals` (invoker) | R read; W edit | Only owners and editors act on Suggestions | None. Tests only | 1/3 |
| Settings tables: `ai_settings`, `lever_settings`, `churn_drivers`, `market_conditions`, `market_schedule`, `analysis_rules`, `demand_settings`, `client_groups`, `services`, `service_servicing`, `lead_sources`, `seasonality`, `roles`, `clients`, `client_services`, `calibrations`, `datasets` | R read; W edit | Only owners and editors change Settings | None. Tests only | 1/3 |
| `workspaces` | R read; update manage; insert/delete agency admin | Name and currency owner-only (design call above) | None. Tests only | 1/3 |
| `processes`, `process_revisions`, `steps`, `edges`; `open_draft`, `publish_process`, `save_solution`, `build_proposal`, `create_library_process` (invoker) | R read; W edit | Only owners and editors open the Editor and publish | None. Tests only | 1/3 |
| `memberships` | R read; W manage, never on `agency_admin` rows unless admin | Owners manage; the last owner can't be removed or demoted | **Owner guard trigger** | 1/3 |
| `workspace_access_emails`, `workspace_domains` | R/W manage | Same, plus the owner guard | **Owner guard trigger** on the list | 1/3 |
| Membership ↔ person link | `memberships.person_id` exists; set only from the access list (`reconcile_access`). Members who joined by domain or were added by hand can't be linked | Any member can be linked to their person | Access page: person picker on member rows; `public.my_person_id(ws)` | 1/3 |
| `audit_log` | R manage | Unchanged | None | — |
| Invite by email | Access list + Google sign-in (#51) | Met (see decisions) | "Copy invite message" button | 1/3 |
| Google sign-in | Done (#48) | Done; magic link superseded | None | — |
| Workspace switcher | Done: `components/shell/workspace-switcher.tsx`, fed by `listWorkspaces()` in `app/w/[slug]/layout.tsx`, "All workspaces" → `/` | Done | None | — |
| Agency workspace list | `/` (`app/page.tsx`): name cards only | Workspace, last-run headline numbers, open Operational risk issues, client groups at risk, last activity | New list for agency admins and a stored headline per workspace | 3/3 |
| Editor route | `workspace-editor-page.tsx`: `if (!canEdit \|\| live.process.archived_at) redirect(base);` | Done | Test only | 1/3 |
| Editor, Publish and Build solution buttons | Gated on `canEditWorkspace` → `mode="readonly"` on the process page, Overview, issue page, solution pages, processes, history, blocks, sources, forecast, settings, levers, AI and calibration; Suggestions passes `canEdit` | Hidden for members and viewers | Audit and source-text test; fix any gap found | 1/3 |
| People page and other per-person displays | Every reader sees everyone | Members see only their own row | UI filter; see 2/3 | 2/3 |
| Demo mode (`/demo`) | No auth; full editor view from fixtures | Unchanged | None (Q5) | — |

**Surprises worth knowing:**
- **Writes are already right.** Members and viewers can't write anything, and no RPC lets them. The only RLS gap is *reads*
  of per-person data. Every role already reads every per-person row.
- **The engine runs in the browser and needs every person's capacity.** `loadProcessBundle` reads `people`,
  `person_roles`, `person_skills`, `person_leave` (and `loadClients` reads `client_assignments`), and `resolvePeopleRows`
  in `packages/db/src/model.ts` turns them into the engine's `people`. If RLS hides those rows from a member, every number
  the member sees changes: Overview, process pages and solutions. That is Q1.
- **Nothing stores headline numbers.** `runs` has no writer in the redesigned workspace UI. Overview numbers are
  simulated in the browser on each visit, so "last-run headline numbers" needs a small stored snapshot (3/3).
- **No last-owner protection exists.** An owner can demote or remove the only owner, including themselves.

---

## B1 (1/3): keep an owner, link people, role-matrix tests

Branch `claude/b1-1-roles` from `main`. Migration version **`20261206000000`**, name `membership_guards`.

### Migration `packages/db/supabase/migrations/20261206000000_membership_guards.sql`

Strictly additive: two trigger functions, two triggers and one helper. It does **not** redefine `save_fields` (nothing
here touches it) or `reconcile_access`. Header comment: purpose, the rules below, preflight, post-apply checks and this
rollback:

```sql
-- Rollback:
--   drop trigger if exists keep_an_owner on public.memberships;
--   drop trigger if exists keep_an_owner on public.workspace_access_emails;
--   drop function if exists private.memberships_keep_owner();
--   drop function if exists private.access_emails_keep_owner();
--   drop function if exists public.my_person_id(uuid);
--   delete from supabase_migrations.schema_migrations where version = '20261206000000';
```

1. **`public.my_person_id(ws uuid) returns uuid`**: `language sql stable security definer set search_path = ''`. Body:
   `select m.person_id from public.memberships m where m.workspace_id = ws and m.user_id = auth.uid() and m.active`.
   It is SECURITY DEFINER for the same reason as `workspace_role`, so policies can call it without recursing.
   `revoke execute … from public, anon; grant execute … to authenticated;`. 2/3's policies use it; 1/3 uses it to say
   "You" on the Access page.

2. **`private.memberships_keep_owner()`**: trigger `keep_an_owner`, `before update or delete on public.memberships for
   each row`. `language plpgsql security invoker set search_path = ''`. Rules:
   - **Applies only to people.** Return at once unless `current_user = 'authenticated'` (a session or an API token, after
     the pre-request hook's `set local role authenticated`) **and** `not public.is_agency_admin()`. Reconciliation
     (`reconcile_access` and `reconcile_after_access_change` are SECURITY DEFINER, so they run as their owner), foreign-key
     cascades (deleting a workspace or an auth user) and SQL run as other roles, so they pass. Agency admins may leave a
     workspace with no owner (offboarding).
   - Refuse when `old.role = 'owner' and old.active`, the change removes that (`tg_op = 'DELETE'`, or
     `new.role <> 'owner'`, or `not new.active`), and no *other* active owner membership exists in `old.workspace_id`.
   - Raise with `raise exception 'workspace_keeps_an_owner: a workspace needs at least one owner' using errcode = '23514';`.
   - Return `old` for DELETE and `new` for UPDATE.
   - A workspace with no owner at all (agency-created, owner not yet added) is fine. The rule only stops going from one
     owner to none.

3. **`private.access_emails_keep_owner()`**: trigger `keep_an_owner`, `before update or delete on
   public.workspace_access_emails for each row`. `language plpgsql security definer set search_path = ''` (it reads
   `auth.users`). Rules:
   - Return at once if `pg_trigger_depth() > 1` (a workspace delete cascading) or `public.is_agency_admin()`.
   - Refuse (same exception) when `old.role = 'owner'`, the change removes that (DELETE, `new.role <> 'owner'` or
     `new.email <> old.email`), an active owner membership with `source = 'access_list'` exists in `old.workspace_id` for
     the user whose confirmed `lower(email) = old.email`, and no active owner membership exists for any other user in that
     workspace.
   - This is needed because removing a list row reconciles at trigger depth 2 as the function owner, which guard 2 lets
     through.

4. `revoke all on function private.memberships_keep_owner(), private.access_emails_keep_owner() from public, anon,
   authenticated;` as `20261205000000_analysis_findings.sql` does for `private.findings_before_write()` (triggers still
   fire: EXECUTE is checked when the trigger is created, not when it fires).

**Known gap, documented in the header and ADR note:** an owner who joined by *domain* and was promoted loses their
membership when the domain is removed. That reconciliation runs as the function owner, so it isn't guarded. That's rare,
and an agency admin can fix it. Don't build around it.

**Apply file** `packages/db/scripts/apply/20261206000000_membership_guards.sql`: `begin;`, the migration SQL, the
`insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261206000000',
'membership_guards', array[$mig$…$mig$]);` row, `commit;`. Copy the header style of
`scripts/apply/20261205000000_analysis_findings.sql` ("applies after row 52 (20261205000000, B17)").

**Preflight queries** (put them in the PR body and the migration header):

```sql
-- 0. Row 52 applied, nothing later.
select version from supabase_migrations.schema_migrations where version >= '20261205000000' order by 1;  -- only 20261205000000
-- 1. Nothing created yet.
select to_regprocedure('public.my_person_id(uuid)'), to_regprocedure('private.memberships_keep_owner()'),
       to_regprocedure('private.access_emails_keep_owner()');  -- all null
-- 2. The reconcile functions run as a role other than authenticated (guard 2 relies on it).
select proname, prosecdef, proowner::regrole from pg_proc
where proname in ('reconcile_access', 'reconcile_after_access_change', 'resolve_my_access');  -- prosecdef true, owner postgres
-- 3. Owners per workspace today (for the log; zero owners is allowed).
select w.slug, count(m.id) filter (where m.role = 'owner' and m.active) as owners
from public.workspaces w left join public.memberships m on m.workspace_id = w.id group by 1 order by 1;
```

Post-apply checks: both triggers exist and are enabled (`tgenabled::text = 'O'`); all three functions have
`proconfig = array['search_path=""']`; `my_person_id` is executable by `authenticated` and not by `anon`.

After the migration, run `pnpm --filter @transpera-flow/db gen:bootstrap` and `gen:types`. `gen:seed` is only needed if
fixtures change, and they shouldn't.

### App changes (1/3)

- **Link any member to a person.** In `apps/web/src/app/w/[slug]/settings/access/actions.ts`, add
  `setMemberPerson(slug, form)`: update `memberships.person_id` by `id`, the same shape as `setMemberRole`. In
  `access/page.tsx`, add the existing `PersonSelect` to each member row whose `source` is `domain` or `manual` (list rows
  already have one). Agency-admin rows stay uneditable for owners, as RLS already enforces. In both pickers, hide people
  already linked to another membership or list row. **No unique constraint in the database**: it would make
  `resolve_my_access` fail at sign-in on existing duplicates.
- **"You"**: on the Access page, mark the signed-in user's own row "(you)". Use `currentUserId()` from
  `lib/access-data.ts`.
- **Last-owner message.** In `apps/web/src/lib/access.ts`, have `accessErrorMessage` map `workspace_keeps_an_owner` to
  "A workspace needs at least one owner. Make someone else an owner first." Add a case to `apps/web/test/access.test.ts`.
- **Copy invite message.** On the pre-assigned email rows, add a small client button (copy the pattern of an existing
  copy-to-clipboard button: search `navigator.clipboard` in `apps/web/src/components`; ask if there's none). It copies:
  "You've been given access to <workspace> in Transpera Flow. Sign in with Google as <email> at <origin>/login." Give it
  an (i) (`components/help.tsx`): "Transpera Flow doesn't send emails. Send this to the person yourself." Example: "Copy
  it into a Slack message to Maya."
- **Read-only UI audit.** Check every page in this list as a member and as a viewer. Find any Edit, Publish, Build
  solution, Analyse, Accept, Dismiss, Upload, New or Delete control that shows. Gate it on `canEditWorkspace` in the
  existing way, `mode={canEdit ? "live" : "readonly"}`. Pages: Overview (`components/overview/workspace-overview.tsx`),
  Processes, Process page (`components/workspace-process-page.tsx`), Editor, History, first principles, Issues and the
  issue page, Solutions and the solution page, Block library, Suggestions, Sources, People, Forecast, Settings and its
  sub-pages. Report what you found in the PR, even if it's nothing.

### Tests (1/3)

- **New `packages/db/test/role-matrix.test.ts`**: the RLS matrix, using `createTestDb` and `createUser` from
  `packages/db/test/harness.ts`, the Northbeam seed ids from `../src`, and `db.as(claims, fn)` with `savepoint` around
  expected failures. Copy `solutions-privileges.test.ts` and `database.test.ts` "row-level security". Users: agency
  admin by JWT flag, `agency_admin` membership, owner, editor, member, viewer, and a signed-in user with no membership.
  For each role:
  - **Reads**: a row count above zero on `people`, `issues`, `findings`, `solutions`, `blocks`, `sources`,
    `suggestions`, `suggestion_proposals` and each settings table listed in the audit; the no-membership user gets zero.
    (2/3 changes the `people` expectations.)
  - **Writes**: insert, update and delete as each role, on one row of each of those tables. They succeed for agency
    admin, owner and editor, and are refused for member and viewer (42501, or zero rows affected for update and delete
    under RLS).
  - **RPCs** (member and viewer refused; editor allowed): `open_draft`, `publish_process`, `save_solution`, `save_issue`,
    `resolve_issue`, `review_suggestions`, `review_proposals`, `create_library_process`, `save_fields` (returns
    `not_found` under RLS: assert the status, as in `packages/mcp/test/postgrest-manual-entry.test.ts`).
  - **Workspace name and currency**: owner yes; editor, member and viewer no.
  - Keep the tests data-driven (a table of `[table, sample insert]`) so 2/3 can extend them.
- **Extend `packages/db/test/access.test.ts`** ("who can manage access"):
  - The last active owner can't demote, deactivate or delete themselves.
  - With a second owner, they can.
  - An agency admin can remove the last owner.
  - Removing the last owner's pre-assigned email is refused; with a second owner, it works.
  - Deleting a workspace with an owner still works (the cascade isn't guarded).
  - Deleting the auth user of the last owner works (cascade).
  - `resolve_my_access` still removes an access-list member whose email left the list (the existing test stays green).
  - Owners can link a domain member to a person.
  - `my_person_id` returns the linked person, null for an inactive membership, and is not executable by `anon`.
- **PostgREST** (`packages/mcp/test/`): add one case to `postgrest-manual-entry.test.ts`, or a new
  `postgrest-roles.test.ts` copying its setup (`token(…)`, `client(…)`). With an owner's API token, demoting the last
  owner fails with the guard's message, which proves the guard fires through the pre-request hook.
- **New `apps/web/test/role-gating.test.ts`**, a source-text test in the style of `archived-process-page.test.ts`. It
  asserts each page in the audit list passes `canEdit` into its `mode`, `editHref` or action props, and that
  `workspace-editor-page.tsx` redirects without `canEdit`.

### Done (1/3)

All of the above green locally (`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`).
Bootstrap and types regenerated. The apply file is written. Preflight queries are in the PR body. A line for
`docs/supabase-notes.md`: the owner guard relies on `current_user` being `authenticated` for Data API requests and the
function owner inside SECURITY DEFINER functions; verified on plain Postgres plus the PostgREST e2e. Screenshots of the
Access page (light and dark, 1440 and 400 px) need a Supabase session, so describe the change in text instead; demo mode
has no Access page.

---

## B1 (2/3): per-person privacy. Blocked on Q1

Don't start until Austin answers Q1. The spec below assumes **option A** (recommended). The orchestrator re-scopes it if
he picks something else.

**Who sees per-person data:** `public.can_see_people(ws)` = `can_edit_workspace(ws)` (agency admin, agency_admin
membership, owner, editor). `public.can_see_person(ws, person uuid)` = `can_see_people(ws) or person =
public.my_person_id(ws)`. Both are `stable`, with `set search_path = ''`.

**Migration** (version from the orchestrator; additive except replacing select policies, which has precedent:
`drop policy "manage memberships"` in `20260930030000_workspace_access.sql`):
- Replace the select policies:
  - `people`: `can_see_person(workspace_id, id)`.
  - `person_leave`, `person_skills`, `person_roles`, `client_assignments`: `can_see_person(workspace_id, person_id)`.
  - `runs`, `robustness_results`: `can_see_people(workspace_id)`.
  - `suggestions`: `can_read_workspace(workspace_id) and (target_table <> 'people' or can_see_people(workspace_id) or
    target_id = my_person_id(workspace_id))`.
  - The rollback recreates the old policies verbatim (copy the text from `pg_policies`).
- New `public.team_capacity(ws uuid) returns jsonb`, `security definer stable set search_path = ''`. It raises 42501
  unless `can_read_workspace(ws)` and returns
  `{people, person_roles, person_skills, person_leave, client_assignments}` with exactly the columns
  `loadProcessBundle` and `loadClients` read today, and never `email`, `notes` or a leave `note`. For a caller without
  `can_see_people(ws)`, every person except their own gets `name = 'Team member ' || n`, numbered by `id` order. Ids are
  unchanged, so the engine's results are byte-identical (`resolvePeopleRows` sorts by id).
- No `save_fields` change (members get no writes).

**App:**
- `packages/db/src/queries.ts`: `loadProcessBundle` and `loadClients` take people, the person tables and
  `client_assignments` from `team_capacity` (one path for every role). Regenerate types.
- A viewer context `{ seesEveryone: boolean; ownPersonId: string | null }`, loaded server-side once per page from
  `can_edit_workspace` and `my_person_id`.
- Per-person displays show everyone only when `seesEveryone`; otherwise only `ownPersonId`'s row, plus role-level
  figures. Find them with `grep -rln "\.people\b\|people=" apps/web/src`. At least: `components/people-page.tsx` (People
  page and absence test), `components/utilisation-bars.tsx`, `components/forecast/*`, the bottleneck panel, and
  `components/compare-view.tsx`.
- Facts that name a person (`apps/web/src/lib/ai/facts.ts`) are hidden from members unless they're about the member.
- `loadMemberNames` (`apps/web/src/lib/data.ts`) falls back to "A team member" for members, as it already does for
  unlinked users.
- MCP needs no code. `get_workspace_summary` returns only the member's own person under RLS.

**Tests:**
- Extend `role-matrix.test.ts`: member and viewer see zero rows from other people in each per-person table; a member
  linked to a person sees exactly that person; `team_capacity` gives a member the same ids and capacities as an editor,
  with pseudonymised names; and the database round-trip (`database.test.ts` "round-trips") still resolves the same
  engine model through `team_capacity`.
- A PostgREST case: a member token's `get_workspace_summary` lists one person.
- A browser test of the People page in member mode, using an existing harness (`apps/web/test/overview-page-harness`,
  `manual-harness`).

---

## B1 (3/3): agency workspace list

Branch from `main` after 1/3 merges. Version from the orchestrator.

**Migration:**
- New table `public.workspace_headlines`:
  - `workspace_id uuid primary key references workspaces on delete cascade`;
  - `computed_at timestamptz not null default now()`, `computed_by uuid default auth.uid()`;
  - `engine_version text not null`, `revision_ids uuid[] not null`, `horizon_weeks integer not null`;
  - `numbers jsonb not null`, with a check on its shape: `flow_efficiency` (0–1 or null), `processes_attention` (int),
    `processes_total` (int), `client_groups_at_risk` (int), `client_groups_total` (int).
- RLS: select `can_read_workspace`; insert and update `can_edit_workspace`; no delete. `revoke all from anon`. Copy the
  grants pattern of `20261205000000_analysis_findings.sql`.
- New `public.agency_workspace_list()`, `security invoker stable`, returning one row per workspace the caller can read:
  `id, name, slug, open_risk_issues` (`issues` with `severity = 'critical' and status in ('open','in_progress')`),
  `last_activity` (the greatest `updated_at` or `created_at` over `process_revisions`, `issues`, `findings`, `sources`,
  `solutions` and `audit_log`), and `numbers, computed_at` from `workspace_headlines`.

**App:**
- `apps/web/src/lib/overview/headline.ts` (pure): `headlineNumbers(model, result, groups)` returns the jsonb above.
  - Flow efficiency comes from `lib/overview/health.ts`.
  - Processes needing attention come from `processHealth(...).attention`.
  - Client groups at risk = `clientHealthSummary(model, result).groups.filter(g => g.rating === "risk").length` (engine
    `clients.ts`).
- In `components/overview/overview.tsx`, once the horizon run is done at the **workspace's default horizon** and
  `mode === "live"` (editor or above), call a new server action `recordHeadline` (`apps/web/src/app/w/[slug]/`). It
  upserts the row, skipping when the stored `revision_ids` and `engine_version` match and `computed_at` is under an hour
  old.
- In `apps/web/src/app/page.tsx`, for agency admins, replace the cards with a table: Workspace, Flow efficiency,
  Processes needing attention, Open Operational risk issues, Client groups at risk, Last activity. Use
  `components/ui/table` as the Access page does, and `RatingPill` (`components/overview/rating-pill.tsx`) wording.
  - With no headline, show "Open the Overview once to see these".
  - Show "as of <date>" from `computed_at`.
  - Give each column header an (i) with a plain description and an example.
  - Non-admins keep the current cards.

**Tests:** RLS on `workspace_headlines` (member and viewer can't write; readers read);
`agency_workspace_list` counts on Northbeam (seed: 0 critical issues, so insert one); a unit test of
`headlineNumbers`; a source-text or browser test that the admin table renders.

---

## Edge cases (all slices)

- **Last owner**: guarded (1/3), except for the domain-removal case documented above. Agency admins are exempt.
- **agency_admin can't be granted by owners**: already enforced (memberships policies, the list's role check). Keep the
  existing tests green. Don't add `agency_admin` to `ASSIGNABLE_ROLES`.
- **A member linked to a person**: one membership per person per workspace in the UI (pickers hide linked people), not
  in the database. A person deleted → `memberships.person_id` is set null (existing FK). A linked inactive person still
  counts as "own record". A viewer may be linked too, and then sees their own record (Q3).
- **Deactivated membership**: `workspace_role` already ignores it, so the user sees nothing, including their own record.
- **Agency admin by JWT flag with no membership**: `my_person_id` is null; `can_see_people` is true.
- **Demo mode**: no change. `/demo` stays the full editor view (Q5).
- **MCP tokens**: run as their owner under RLS (ADR 0002). Member and viewer tokens can read but every write tool fails
  under RLS, which is already true. After 2/3, their reads of per-person tables shrink to their own row, and simulations
  through `loadProcessBundle` use `team_capacity`. No MCP code changes; add the PostgREST cases above.
- **Realtime**: only `steps`, `edges` and `processes` are published (`20261007000000_realtime.sql`), so no per-person
  table leaks through Realtime.
- **AI analysis** sends per-person facts to Anthropic, but only editors and above can run it (`reserve_ai_run` checks
  `can_edit_workspace`). No change.

## Out of scope

- Magic link, email sending, SMTP, Microsoft sign-in.
- Members editing their own record (leave, skills). They read it only.
- Share links and the `viewer` share-link persona (B3, #32); play links (B4).
- Finishing the People page (B2, #31) beyond what 2/3 needs to hide other people.
- Redacting names inside free text (issue titles, findings, AI summaries, source text). They're shared team output.
- Any change to `save_fields`, the engine or golden numbers. No `ENGINE_VERSION` bump in any slice.

## Questions for Austin

**Blocking (2/3 only):**

**Q1. What may a member's browser receive about other people?** The engine runs in the browser and needs each person's
hours, roles, leave, skills, client assignments and cost rate to give the right numbers. Choose:
- **A (recommended):** members and viewers get those inputs under neutral labels ("Team member 3"), without names,
  emails or notes. The screens show only their own row. Everyone sees the same company numbers. Someone with browser dev
  tools could still read "Team member 3: 32 h a week, $45 an hour, away 3–14 Nov".
- **B:** members get role totals only, with no per-person rows at all. Their company numbers come out slightly different
  from an editor's.
- **C:** members get no per-person inputs and see no simulated numbers. They see maps, findings, issues and solutions,
  but not the Overview cards or charts.

**Non-blocking (the builder uses the default unless Austin says otherwise):**

- **Q2.** Should members see other people's names, e.g. issue owners or who wrote a solution? *Default: no. They see
  "Team member N" or "A team member". Only their own name shows.*
- **Q3.** Can a viewer be linked to a person and see their own record? *Default: yes. The rule is "the person
  themselves", whatever their role.*
- **Q4.** Saved runs (`runs`, `robustness_results`) carry per-person results and no current screen shows them to
  members. *Default: only owners and editors can read them.*
- **Q5.** Should demo mode get a "view as member" switch? *Default: no.*
- **Q6.** Which "last-run headline numbers" go on the agency list? *Default: flow efficiency and processes needing
  attention, from the Overview's cards, alongside open Operational risk issues, client groups at risk and last activity.
  The numbers are as of the last time an editor or admin opened that workspace's Overview.*
- **Q7.** Can an agency admin leave a workspace with no owner? *Default: yes (offboarding). Owners can't.*
