# B1 build brief: roles and visibility (#30)

Scoped 5 Oct 2026 against `main` at 453d40c. Updated 6 Oct with Austin's answers to Q1–Q7, with what 1/3 actually built
(PR #199, `claude/b1-1-roles`; row 53 applied), and with Client health rules for editors (3/3). Read
`docs/plans/builder-brief.md` first; this brief adds to it and wins where they differ. Follow it strictly. If something
here is unclear or doesn't match the code, **ask; don't guess.**

## The short version

Most of B1 already exists. Access without email invites (#51, PR #55, ADR 0003), the five roles, the RLS helpers, Google
sign-in, the workspace switcher and the read-only UI for members and viewers have all shipped. What's left:

| Slice | What | Migration | Status |
|---|---|---|---|
| **B1 (1/3)** | Keep an owner; link any member to a person; role-matrix RLS tests; read-only UI audit; copyable invite message | `20261206000000_membership_guards` | **Built** (PR #199; row 53 applied 6 Oct) |
| **B1 (2a)** | Per-person privacy in the database: select policies, `team_capacity` (neutral labels, no pay), every `packages/db` loader switched to it | `20261207500000_per_person_privacy` | **Build after #199 merges** |
| **B1 (2b)** | Per-person privacy on screen: members see only their own row, "A team member" for others | none | Build after 2a merges |
| **B1 (3/3)** | Agency workspace list with headline numbers; editors change Client health rules | `20261209000000_agency_list` | Build after #199 merges (independent of 2/3) |

Each slice is its own branch and PR. 1/3 and 2a close nothing; the last of 2b and 3/3 to merge says `Closes #30`. B2 (#31) depends on 2b for "A member viewing People sees only their own record".

---

## Decisions (verbatim)

**Austin, 6 Oct, posted on #30 (answers to Q1–Q7):**
> Austin's decision on 6 Oct for B1 (2/3), per-person privacy (Q1 in `docs/plans/b1-brief.md`): **A'**, a variation of
> option A.
>
> - **What members and viewers receive:** the per-person simulation inputs under neutral labels ("Team member 3"). This
>   covers hours, roles, leave, skills and client assignments. Names, emails and notes are left out.
> - **Cost rates:** each person's own rate is replaced by their **role's average cost rate, weighted by hours**. Pay
>   can't be read from the browser, and role cost totals stay the same or very close.
> - **Their numbers:** everything else matches what an editor sees. The screens show members only their own row.
> - **Names (Q2):** members see their own name, and "A team member" for anyone else, e.g. issue owners and solution
>   authors.
> - **Q3–Q7:** the brief's defaults stand.
>
> Known limit, accepted: a member using browser dev tools can still read anonymous hours and leave dates. A
> per-workspace "no simulated numbers for members" setting (option C) is a possible later follow-up, not part of this
> ticket.

**Austin, 6 Oct, later the same day, posted on #30: members and viewers get no pay data.** It **replaces the "Cost rates"
bullet above** (role averages) and Q8 (the k = 3 pool and the company-wide fallback). The rest of A' stands.
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
> - Owners, editors and agency admins see everything, as before.

The worked example from the review: with a role average of 76.3625 over four people and 60.6667 over three of them, the
fourth person's rate is `4 × 76.3625 − 3 × 60.6667 = 123.45`. Any scheme that shows averages over groups that overlap
lets a member subtract one from the other.

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

Keep it. Editors change every other setting. That was *not* fully true: Settings → Client health rules (and three other
settings keys, Q9) save through `save_fields('workspaces')`, whose update needs `can_manage_workspace`, so they are
owner-only today. 3/3 opens the Client health rules to editors.

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
| `people` | R read; W edit | R: edit, or own person; W edit | New select policy (`can_see_person`) | 2a |
| `person_leave`, `person_skills`, `person_roles` | R read; W edit | Same as `people` (availability, skills and assignments are per-person, D20) | New select policies | 2a |
| `client_assignments` (`person_id` not null) | R read; W edit | Same as `people` (who looks after which client is an assignment) | New select policy | 2a |
| `runs`, `robustness_results` | R read; W edit | `results` holds per-person utilisation. Nothing in the redesigned workspace UI shows saved runs (only `/demo/larkspur` uses `SaveRunBar`) | R: edit only (Q4) | 2a |
| `suggestions` | R read; W edit | A suggestion with `target_table = 'people'` is a per-person change | R: edit, or `target_table <> 'people'`, or `target_id` = own person | 2a |
| Engine input for members (people, leave, skills, roles, assignments) | Read straight from the tables in `loadProcessBundle` and `loadClients` (`packages/db/src/queries.ts`) | Members still need correct company numbers | `team_capacity` (Q1 = A'), used by `loadProcessBundle`, `loadClients`, `loadCompanyModel` | 2a |
| `issues`, `issue_*`, `findings`, `ai_analyses` | R read; W edit (`issues` W also excludes `source='detected'`) | Members and viewers read only | None. Tests only | 1/3 |
| `solutions`, `solution_issues` | R read; W edit (column grants) | Same | None. Tests only | 1/3 |
| `blocks` | R read; W edit | Same | None. Tests only | 1/3 |
| `sources`, `source_links`, `storage.objects` (sources bucket) | R read; W edit | Same | None. Tests only | 1/3 |
| `suggestion_proposals`; `review_suggestions`, `review_proposals` (invoker) | R read; W edit | Only owners and editors act on Suggestions | None. Tests only | 1/3 |
| Settings tables: `ai_settings`, `lever_settings`, `churn_drivers`, `market_conditions`, `market_schedule`, `analysis_rules`, `demand_settings`, `client_groups`, `services`, `service_servicing`, `lead_sources`, `seasonality`, `roles`, `clients`, `client_services`, `calibrations`, `datasets` | R read; W edit | Only owners and editors change Settings | None. Tests only | 1/3 |
| `ai_runs` | R read; no writes (`reserve_ai_run` only) | `user_name` names whoever ran an analysis (Q2) | R: edit, or own runs | 2a |
| `revision_history` (definer) | Returns the publisher's person name to every reader | Q2: "A team member" for others | Name only when `can_see_person` | 2a |
| `workspaces` | R read; update manage; insert/delete agency admin | Name and currency owner-only (design call above) | None. Tests only | 1/3 |
| `workspaces.settings` Client health rules | Saved through `save_fields` → owner-only | Editors change Settings | `save_health_rules` (definer, four keys) | 3/3 |
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
| People page and other per-person displays | Every reader sees everyone | Members see only their own row; "A team member" for others | `lib/viewer.ts`; see 2b | 2b |
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

**Status: built** (PR #199, about to merge; row 53 applied to production on 6 Oct). Kept below for reference. What landed
differs from this spec in ways 2/3 and 3/3 rely on:
- `my_person_id(ws)` is as specified (SECURITY DEFINER, active memberships only, `authenticated` only).
- **One person per membership is enforced server-side**: `setMemberPerson` checks `personLinkProblem`
  (`apps/web/src/lib/access.ts`) before linking, and the pickers hide linked people. There is still no database
  constraint, so 2a's preflight checks production for duplicates.
- The list guard reads `auth.users` through a fourth function, `private.list_owner_is_last(uuid, text)`. Both guards
  return early unless `current_user = 'authenticated'`, also refuse changing the last owner's `source` or
  `workspace_id`, and take a per-workspace advisory lock.
- `packages/db/test/role-matrix.test.ts` is data-driven (`TABLES`, `ROLES`, `RPCS`); 2a and 3/3 extend it.
- ADR 0003 has an addendum and `docs/supabase-notes.md` a "Keeping an owner" entry; 2a and 3/3 add theirs beside them.

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

## B1 (2/3): per-person privacy

Austin answered Q1 (**A'**) and Q2 on 6 Oct (quoted under Decisions). This section is the spec. **Build it as two PRs**:

| PR | What | Migration |
|---|---|---|
| **2a** | Database (helpers, select policies, `team_capacity`, `revision_history` author names) and every loader in `packages/db` switched to `team_capacity`. DB, PostgREST and engine-equality tests. | `20261207500000_per_person_privacy` |
| **2b** | Web: the viewer helper, own-row-only per-person displays, "A team member" naming, Settings for members, a browser test. | none |

2a is safe to ship alone: after it, a member's browser gets only neutral labels and no pay, and pages list
"Team member 3" rows where they listed names. 2b then trims the screens to the member's own row. Branch 2a as
`claude/b1-2a-privacy` from `main` (after PR #199 has merged); branch 2b as `claude/b1-2b-privacy-ui` from `main` after 2a
merges.

**Who sees what, in one line:** agency admins, `agency_admin` members, owners and editors see every person as today.
Members and viewers see their own person's rows (when their membership is linked to a person, Q3), and get everyone's
simulation inputs only through `team_capacity`: neutral labels and no cost rates (only their own).

### 2a: migration `packages/db/supabase/migrations/20261207500000_per_person_privacy.sql`

Version **`20261207500000`** (B10 2b holds `20261207000000`; this doesn't depend on it). Additive except: nine select
policies are dropped and re-created under the same names (precedent: `drop policy "manage memberships"` in
`20260930030000_workspace_access.sql`), and `public.revision_history` is replaced with the same signature and result
columns. It does **not** touch `save_fields`, any insert/update/delete policy, or any grant on a table.

Header comment, in the style of `20261206000000_membership_guards.sql`: purpose; the rules in this section; the
**known limit Austin accepted** (dev tools can still read anonymous hours and leave dates); preflight; post-apply checks;
rollback.

**1. Helpers** (both `language sql stable security invoker set search_path = ''`; `revoke execute … from public, anon;
grant execute … to authenticated;`). C2 (2c) will reuse `can_see_person` for its per-person factors table, so keep these
names and signatures exactly.

```sql
create function public.can_see_people(ws uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select public.can_edit_workspace(ws);
$$;

create function public.can_see_person(ws uuid, person uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select public.can_see_people(ws) or (person is not null and person = public.my_person_id(ws));
$$;
```

`my_person_id` is 1/3's (SECURITY DEFINER, active memberships only), so a deactivated member sees nothing, and an agency
admin by JWT flag (no membership) gets null from it but true from `can_see_people`.

**2. Select policies.** Drop and re-create each one, same name, `for select to authenticated`:

| Table | Policy name | New `using` |
|---|---|---|
| `people` | `read people` | `public.can_see_person(workspace_id, id)` |
| `person_roles` | `read person_roles` | `public.can_see_person(workspace_id, person_id)` |
| `person_skills` | `read person_skills` | `public.can_see_person(workspace_id, person_id)` |
| `person_leave` | `read person_leave` | `public.can_see_person(workspace_id, person_id)` |
| `client_assignments` | `read client_assignments` | `public.can_see_person(workspace_id, person_id)` |
| `runs` | `read runs` | `public.can_see_people(workspace_id)` (Q4) |
| `robustness_results` | `read robustness results` | `public.can_see_people(workspace_id)` (Q4) |
| `suggestions` | `read suggestions` | `public.can_read_workspace(workspace_id) and (target_table <> 'people' or public.can_see_person(workspace_id, target_id))` |
| `ai_runs` | `read ai_runs` | `public.can_read_workspace(workspace_id) and (public.can_see_people(workspace_id) or user_id = auth.uid())` |

Every old `using` is `public.can_read_workspace(workspace_id)` (from `20260929010000_people.sql`,
`20261012000000_clients.sql`, `20261015000000_suggestions.sql`, `20261019000000_reports.sql` and
`20261121000000_ai_analysis.sql`); preflight 3 proves it before you drop them.

Why each extra one:
- `suggestions`: a suggestion with `target_table = 'people'` is a change to one person (a new person has a null
  `target_id`, and `can_see_person(ws, null)` is `can_see_people(ws)`).
- `ai_runs`: `user_name` is a stored copy of the name of whoever ran an analysis; `packages/db/src/ai.ts` `withRunBy`
  shows it as "run by Maya Collins" on the findings and AI review panels. Q2 says members don't see other people's names.
  Members can't run analyses (`reserve_ai_run` checks `can_edit_workspace`), so they read none and the panels say
  "Reviewed by AI." with no name. The daily limit is counted inside `reserve_ai_run` (SECURITY DEFINER), so it isn't
  affected.

**3. `public.team_capacity(ws uuid) returns jsonb`.** The one way any caller gets the whole team's simulation inputs.
`language plpgsql stable security definer set search_path = ''`; `revoke execute … from public, anon; grant execute …
to authenticated;`. SECURITY DEFINER because it must read rows the caller's RLS hides; it checks the caller itself.

- Raises `team_capacity: you cannot read this workspace` with errcode `42501` unless `can_read_workspace(ws)`.
- `sees_everyone = can_see_people(ws)`, `own_person_id = my_person_id(ws)`.
- **For a caller who sees everyone**, every value is the stored one (real names, real cost rates, provenance): editors'
  numbers don't move.
- **For everyone else** (members, viewers):
  - **Name**: the caller's own person keeps their name (Q2). Every other person is `'Team member ' || n`, where `n` is the
    person's rank in the workspace by `(created_at, id)` over **all** people, active or not. So the number never changes
    between loads, adding a person appends a number, and deactivating someone doesn't renumber anyone. Only deleting a
    person renumbers the people created after them (people are normally deactivated, not deleted; accepted).
  - **Cost rate**: null for everyone except the caller's own person, who sees their own (the people policy already lets
    them read their own row). No averages and nothing derived from rates (6 Oct, "no pay"; see below).
  - **Provenance**: `{}`.
- Never returns `email`, `notes`, a leave `note`, `person_skills.efficiency` or `person_skills.provenance`.

**No pay for members and viewers, exactly** (this replaces the role-average rule of Q8):
- `team_capacity` returns `cost_rate` as stored for callers who see everyone, and as **null for everyone else except the
  caller's own person**. There is no averaging, no pool, no fallback and no `hours_per_week` lookup in the function.
- **What depends on a person's rate** (grep the engine for `person.cost` / `p.cost` / `people[...].cost`):
  - `simulate.ts`: `overtimeCost`, each person's overtime hours × their rate (the KPI "Overtime cost");
  - `issues.ts`: the cost of a person's "too busy" issue when overtime is added, the cost of rework at a step held by a
    named person, and the cost of spare capacity of a named person;
  - `overtime-issues.ts`: the cost, evidence sentence and `overtime_cost` metric of a named person's overtime issue.
  Labour cost uses `roles.default_cost_rate`, which every member already reads, so it is unchanged.
- **How the engine marks them unavailable.** `EngineModel.payHidden` (set by `toEngineModel` when the bundle's `viewer`
  does not see everyone). With it, `kpi.overtimeCost` is **null** (not 0), and the issue costs above are
  `{ perMonth: null, hoursPerMonth: null, payHidden: true }`; the overtime issue leaves out its cost sentence and
  `overtime_cost`. No person's rate is ever used, and a missing one is never swapped for a role's default. Without the
  flag (every caller who sees everyone, demo, goldens) nothing changes: the golden baselines don't move.
- **On screen**: "—" with an (i) ("Only owners and editors see costs that depend on people's pay.") where a figure is
  `payHidden`: the Overtime cost tile, an issue's cost in the insight list, the register and the facts list. MCP marks
  `cost.pay_hidden: true` and returns `per_month` null.
- **Every other simulated number is identical to an editor's.** (The one ordering effect: issues are ordered by rating
  first and cost second, so two issues of the same rating can swap places when one of their costs is unavailable.)

Write it as one statement, along these lines (keep the names, the order and the rules; tidy the SQL as you like):

```sql
create function public.team_capacity(ws uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  everyone boolean;
  own uuid;
  result jsonb;
begin
  if ws is null or not public.can_read_workspace(ws) then
    raise exception 'team_capacity: you cannot read this workspace' using errcode = '42501';
  end if;
  everyone := public.can_see_people(ws);
  own := public.my_person_id(ws);

  with p as (
    select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.cost_rate, pe.active, pe.start_date,
           pe.end_date, pe.provenance,
           row_number() over (order by pe.created_at, pe.id) as n
    from public.people pe where pe.workspace_id = ws
  ),
  shown as (
    select p.*,
      case when everyone or p.id = own then p.name else 'Team member ' || p.n end as shown_name,
      -- No pay for anyone but the caller's own person (and those who see everyone).
      case when everyone or p.id = own then p.cost_rate end as shown_rate
    from p
  )
  select jsonb_build_object(
    'sees_everyone', everyone,
    'own_person_id', own,
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
        'capacity_hours_week', s.capacity_hours_week, 'cost_rate', s.shown_rate, 'active', s.active,
        'start_date', s.start_date, 'end_date', s.end_date,
        'provenance', case when everyone then s.provenance else '{}'::jsonb end)
      order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
    'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
        'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
      from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
    'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
        'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
      from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
    'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
        'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
        order by l.person_id, l.start_date, l.id)
      from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
    'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
        'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
      from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
```

Return shape (document it in the header and on the TypeScript type):

```
{ sees_everyone: boolean, own_person_id: uuid | null,
  people: [{id, workspace_id, name, fte, capacity_hours_week, cost_rate, active, start_date, end_date, provenance}],
  person_roles: [{person_id, role_id, workspace_id}],
  person_skills: [{person_id, step_id, workspace_id}],
  person_leave: [{id, person_id, workspace_id, start_date, end_date}],
  client_assignments: [{client_id, role_id, person_id, workspace_id}] }
```

These are exactly the columns `loadProcessBundle`, `loadClients` and `loadCompanyModel` read today. Dates come back as
`YYYY-MM-DD` strings and numerics as JSON numbers, as PostgREST returns them. Ids are the real ids, so pinned steps,
assignments and issue owners still resolve.

**4. `public.revision_history`**: `create or replace` with the same signature, result columns and grants. Copy the
definition from `20261127500000_company_map_editing.sql` (the latest) and change only the author line, marked
`-- B1 (2/3)`:

```sql
    coalesce(case when public.can_see_person(r.workspace_id, per.id) then per.name end,
             case when public.can_manage_workspace(r.workspace_id) then u.email end),
```

A member then gets null for another person's version, and `authorLabel` (`apps/web/src/lib/history/versions.ts`) already
says "A team member" for null. Their own versions keep their name.

**Rollback** (in the header; run as one transaction):

```sql
-- begin;
--   drop policy "read people" on public.people;
--   create policy "read people" on public.people for select to authenticated using (public.can_read_workspace(workspace_id));
--   -- the same pair for person_roles, person_skills, person_leave, client_assignments ("read <table>"),
--   -- runs ("read runs"), robustness_results ("read robustness results"), suggestions ("read suggestions") and
--   -- ai_runs ("read ai_runs"): each back to using (public.can_read_workspace(workspace_id))
--   -- revision_history: re-run the `create function public.revision_history ... $$;` block from
--   -- 20261127500000_company_map_editing.sql with `create` changed to `create or replace` (same signature, grants kept)
--   drop function public.team_capacity(uuid);
--   drop function public.can_see_person(uuid, uuid);
--   drop function public.can_see_people(uuid);
--   delete from supabase_migrations.schema_migrations where version = '20261207500000';
-- commit;
```

Write all nine policy pairs out in full in the header; the comment lines above are only shorthand for this brief.

**Apply file** `packages/db/scripts/apply/20261207500000_per_person_privacy.sql`: `begin;`, `set local lock_timeout =
'5s';` (dropping a policy takes a brief exclusive lock on its table; copy the line from
`scripts/apply/20261204000000_process_admin_source_files.sql`), the migration SQL, the `insert into
supabase_migrations.schema_migrations (version, name, statements) values ('20261207500000', 'per_person_privacy',
array[$mig$…$mig$]);` row, `commit;`. Header: "applies after row 53 (20261206000000, B1 1/3)".

**Preflight** (read-only; in the header and the PR body):

```sql
-- 0. Row 53 applied, nothing at or after this version. Expect 20261206000000 (and 20261207000000 if B10 2b went first), nothing >= 20261207500000:
select version from supabase_migrations.schema_migrations where version >= '20261206000000' order by 1;
-- 1. my_person_id exists; nothing of this migration does. Expect not null, null, null, null:
select to_regprocedure('public.my_person_id(uuid)'), to_regprocedure('public.can_see_people(uuid)'),
       to_regprocedure('public.can_see_person(uuid, uuid)'), to_regprocedure('public.team_capacity(uuid)');
-- 2. revision_history is 20261127500000's. Expect one row: true, true
select pg_get_function_result(oid) like '%note text%', prosrc not like '%can_see_person%'
from pg_proc where pronamespace = 'public'::regnamespace and proname = 'revision_history';
-- 3. The nine select policies are as this migration expects. Expect 9 rows, each qual public.can_read_workspace(workspace_id) / can_read_workspace(workspace_id):
select tablename, policyname, qual from pg_policies
where schemaname = 'public' and cmd = 'SELECT' and (tablename, policyname) in (
  ('people', 'read people'), ('person_roles', 'read person_roles'), ('person_skills', 'read person_skills'),
  ('person_leave', 'read person_leave'), ('client_assignments', 'read client_assignments'), ('runs', 'read runs'),
  ('robustness_results', 'read robustness results'), ('suggestions', 'read suggestions'), ('ai_runs', 'read ai_runs'))
order by 1;
-- 4. No person is linked to two active memberships (1/3 enforces it in setMemberPerson, not the database). Expect no rows;
--    if any, two people would see the same record: unlink one on Settings → Access before applying.
select workspace_id, person_id, count(*) from public.memberships
where person_id is not null and active group by 1, 2 having count(*) > 1;
-- 5. For the log: members and viewers who will see their own record, per workspace.
select w.slug, count(*) filter (where m.person_id is not null) as linked, count(*) as members_and_viewers
from public.workspaces w join public.memberships m on m.workspace_id = w.id
where m.active and m.role in ('member', 'viewer') group by 1 order by 1;
```

**Post-apply checks:**
- Re-run preflight 3: the five per-person tables and `suggestions` now mention `can_see_person`; `runs`,
  `robustness_results` and `ai_runs` mention `can_see_people`.
- `select proname, prosecdef, proconfig from pg_proc where proname in ('can_see_people', 'can_see_person',
  'team_capacity', 'revision_history');` gives `prosecdef` false, false, true, true and `{search_path=""}` on all four.
- `has_function_privilege('authenticated', …, 'execute')` true and `has_function_privilege('anon', …, 'execute')` false
  for the three new functions.
- `select prosrc like '%can_see_person%' from pg_proc where proname = 'revision_history';` is true.
- Smoke test, rolled back. Production Northbeam has no owner (row 53's log), so act as an agency admin (any user id;
  the flag is in the claims):
  `begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<user id>","role":"authenticated","app_metadata":{"agency_admin":true}}', true); select (public.team_capacity('<northbeam id>') ->> 'sees_everyone'), jsonb_array_length(public.team_capacity('<northbeam id>') -> 'people'); rollback;`
  Expect `true` and Northbeam's head count.

After the migration: `pnpm --filter @transpera-flow/db gen:bootstrap` and `gen:types`. No fixture changes, so no
`gen:seed`. Add a row to `docs/production-migrations.md` with the next free number (B10 2b may take 54).

### 2a: `packages/db` loaders (the call sites)

Grep for every table: `grep -rnE 'from\("(people|person_roles|person_skills|person_leave|client_assignments|runs|robustness_results|ai_runs)"\)' apps packages --include=*.ts --include=*.tsx`
(excluding tests and `database.types.ts`). Every hit is listed here with what to do. If you find one not listed,
**ask**.

**Switch to `team_capacity`** (these feed the engine or name people across the whole team):

1. **New in `packages/db/src/queries.ts`:**

   ```ts
   /** Who is looking: whether they see every person, and the person record linked to their membership (B1 2/3). */
   export interface Viewer { seesEveryone: boolean; ownPersonId: string | null }

   export interface TeamInputs {
     viewer: Viewer;
     people: PersonRow[];
     personRoles: PersonRoleRow[];
     personSkills: PersonSkillRow[];
     personLeave: PersonLeaveRow[];
     clientAssignments: ClientAssignmentRow[];
   }

   /** The whole team's simulation inputs, as `public.team_capacity` gives them to the caller (labels and no pay for members). */
   export async function loadTeam(db: Db, workspaceId: string): Promise<TeamInputs>
   ```

   It calls `db.rpc("team_capacity", { ws: workspaceId })`, throws on error, and maps the snake_case keys to the fields
   above (one cast, with a comment naming the function's documented shape). Export both types and `loadTeam` from
   `packages/db/src/index.ts`.
2. **`ProcessBundle`** (`packages/db/src/types.ts`) and **`CompanyModel`** (`packages/db/src/company.ts`) get an optional
   `viewer?: Viewer`. Absent means "sees everyone" (demo fixtures, tests and the golden models need no change).
3. **`loadProcessBundle`** (queries.ts ~L210): replace the `people`, `person_roles`, `person_skills` and `person_leave`
   queries with one `loadTeam(db, ws)`. Pass the result to `loadClients` (next item) so it isn't called twice. Set
   `people`, `personRoles`, `personSkills`, `personLeave` and `viewer` from it.
4. **`loadClients(db, workspaceId, team?: TeamInputs)`** (queries.ts ~L146): `clientAssignments` comes from
   `team.clientAssignments`, or from `(await loadTeam(db, workspaceId)).clientAssignments` when no `team` is passed. Drop
   the direct `client_assignments` query. Its callers: `loadProcessBundle`, `loadCompanyModel`, and
   `loadWorkspaceClients` (`apps/web/src/lib/data.ts`), which needs no change.
5. **`loadCompanyModel`** (queries.ts ~L826): the same as `loadProcessBundle`. Its `people` stay ordered as the function
   returns them (by name for those who see everyone, which is today's `order("name")`). Set `viewer`. `PERSON_COLUMNS`
   is then unused: delete it.
6. Check that nothing hashes or snapshots a whole `ProcessBundle` or `CompanyModel` (`grep -rn "JSON.stringify(bundle\|hash" packages/db/src apps/web/src/lib`),
   so the new `viewer` field changes no stored hash. `snapshotModel` (`company.ts`) builds its own object; leave it.

These two loaders cover every engine input: the web (`apps/web/src/lib/data.ts` `loadLiveProcess`,
`loadProcessForEditing`, `loadProcessVersion`, `loadSolutionBase`; `lib/solutions/server-verdict.ts`; `lib/ai/service.ts`;
`lib/history/data.ts` through `loadProcessBySlug`; `lib/company-data.ts`; `app/w/[slug]/suggestion-actions.ts`;
`app/w/[slug]/run-actions.ts`) and MCP (`tools.ts` `get_process`/`run_scenario`, `analysis-tools.ts`,
`building-tools.ts`, `first-principles-tools.ts`, `import-file.ts`, `file-extras.ts`, `suggestion-tools.ts`). None of
those files needs an edit for 2a.

**Keep reading the tables directly (RLS now gives members and viewers their own rows only). This is intended:**

| Call site | Why it stays |
|---|---|
| `apps/web/src/lib/data.ts` `loadMemberNames` (`people` id, name) | Q2 for free: a member now reads only their own person, so every other author (solutions, findings, issues, the process page's "published by") falls back to the existing "A team member". Update its doc comment to say so. |
| `apps/web/src/lib/data.ts` `loadWorkspaceSettings` (`people` with email and notes, `person_roles`, `person_skills`, `person_leave` with note, `client_assignments`) | The Settings → People editor. A member sees only their own record (B2 wants exactly that). 2b fixes the role usage counts. |
| `apps/web/src/lib/access-data.ts` (`people` id, name) | Access page: owners and agency admins only. |
| `apps/web/src/app/w/[slug]/settings/actions.ts`, `client-actions.ts` | Editor writes. |
| `apps/web/src/app/w/[slug]/run-actions.ts`, `lib/narration/explain.ts`, `queries.ts` `loadRuns`/`loadRun` (`runs`) | Editors only after Q4; a member's "Explain this run" gets `not_found`, which it already handles. |
| `packages/db/src/ai.ts` `withRunBy` (`ai_runs`) | Members read no runs, so `run_by` is null for them. |
| `packages/db/src/workspace-bundle.ts` (export) | A member's export (scope "published") holds only their own person. That's right for privacy. Note it in the PR for B10. |
| `packages/mcp/src/tools.ts` `get_workspace_summary` (`people` id, name, fte, hours, active) | A member token lists only their own person (or none). |
| `packages/mcp/src/analysis-tools.ts` (L399, L475), `building-tools.ts` (L847), `import-file.ts` (L66) (`people` id, name) | Name lookups. A member can name only themselves; the write tools are refused under RLS anyway. |

**MCP for member and viewer tokens:** no code change. Reads of the per-person tables shrink to the token owner's own
rows. Simulations (`run_scenario`, `get_process` KPIs, the analysis tools) go through `loadProcessBundle`, so they use
`team_capacity`: the same numbers as an editor except the costs that depend on pay (unavailable), with per-person results under "Team member N". That
is the same data A' already gives the browser (the accepted limit). Write tools are refused as before.

### 2a: tests

**Extend `packages/db/test/role-matrix.test.ts`** (it is data-driven for this):
- **Callers.** Link `member` to one Northbeam person and `viewer` to another (`northbeamPersonIds`; set
  `memberships.person_id` as the superuser in `beforeAll`). Add a caller `"member, no person"` (an unlinked member) to
  `ROLES` with `{ writes: false, reads: true }`.
- **Move the per-person tables out of `TABLES`' reads.** Give `TableCase` a `reads: "everyone" | "per-person" |
  "editors"` field (default `"everyone"`). Mark `people` `"per-person"`. Add write-only cases (insert/update/delete,
  seeded as the superuser) for `person_roles`, `person_skills`, `person_leave` and `client_assignments`, all
  `"per-person"`. Add `runs` and `robustness_results` as `"editors"`. The reads test then expects:
  - `"everyone"`: as today;
  - `"per-person"`: callers who see everyone read every row (the superuser's count); `member` and `viewer` read exactly
    the rows of their linked person (`people`: 1; the link tables: that person's rows; at least one, so seed one each for
    both linked people); `"member, no person"` and the no-membership user read 0;
  - `"editors"`: editors and above read > 0; member, viewer, `"member, no person"` and the stranger read 0.
  - The write expectations don't change for any table.
- **`suggestions`**: seed (as superuser) one `people` suggestion for the member's person and one for another person. The
  member reads the first, not the second, and still reads the non-people seed row. An editor reads all three.
- **`ai_runs`**: seed two rows as the superuser, one with `user_id` = the editor and one with `user_id` = the member.
  Editor and owner read both; the member reads only their own; the viewer reads none.
- **`team_capacity`**:
  - Every reader gets the same `people` ids, `person_roles`, `person_skills`, `person_leave` (without `note`) and
    `client_assignments` as the superuser reads from the tables.
  - Editor and above get `sees_everyone: true` and the real names and rates.
  - `member` gets `sees_everyone: false`, `own_person_id` = their person, their own real name, and
    `/^Team member \d+$/` for everyone else.
  - No row has `email`, `notes`, `note` or `efficiency`. Non-seers get `provenance` `{}`.
  - The labels are stable: they're the same on two calls, and after the superuser inserts a new person every existing
    label is unchanged and the new one gets the highest number. They're also unchanged when someone else is
    deactivated.
  - The no-membership user gets 42501. `anon` has no execute right (add it to the existing anon test).
- **`revision_history`**: publish a version as the editor (linked to a third person). The member gets `author_name` null
  for it; the editor and owner get the name; the editor sees their own name.

**New `packages/db/test/team-capacity.test.ts`** (its own `createTestDb`; Larkspur, which has a person in two roles, a
person with 30 hours, skills and leave):
- **Setup** as the superuser: give cost rates to several people (including Hana, who holds two roles) and set one more
  rated person inactive. Link a member to Jess.
- **Rates.** A member's `team_capacity` has `cost_rate` null for everyone but Jess (her own); an editor and an agency admin
  get the stored rates. A member with no linked person gets no rate at all, and the function's source holds no averaging
  code.
- **Simulation numbers equal an editor's.** Build two `ProcessBundle`s for Larkspur's pipeline: the editor's (rows read
  as the editor, as `database.test.ts` `loadSeeded` does) and the member's (the same, with `people`, `personRoles`,
  `personSkills`, `personLeave` and `clientAssignments` replaced by the member's `team_capacity` output). Run
  `toEngineModel(…, { startDate: "2026-10-05" })` and then `simulate(model, 30, 1)` (`@transpera-flow/engine`).
  - The two results are deep-equal after you delete `overtimeCost` from `kpi` and `cost` from every `resolvedPeople`
    entry, and relabel the names. The member's `kpi.overtimeCost` is **null** (the editor's is a number above 0).
  - Detected issues: the same keys, ratings, titles and everything else, apart from the issues whose cost needs pay,
    which are `payHidden` with a null cost (Larkspur's overtime issue is one).
  - Run it once more with Northbeam (no person rates), where the results are deep-equal with only the names removed.
- **Round trip.** Add a case to `database.test.ts` "round-trips": the admin's bundle built from `team_capacity`
  resolves to the same engine model as `northbeamBundle()` (and `larkspurBundle()`).

**PostgREST** (extend `packages/mcp/test/postgrest-roles.test.ts`; session JWTs as in `postgrest-findings.test.ts`
`jwt(sub)`):
- **No response a member can get contains any cost rate**: give every other person a rate, then check `team_capacity`,
  `people` (all columns, and filtered by rate), `loadProcessBundle` and the MCP tools a member's token can call
  (`get_workspace_summary`, `get_bottlenecks`, `get_facts`, `list_findings`, `list_issues`, `get_process`) for any of
  those numbers or any non-null `cost_rate`.
- `loadProcessBundle` through supabase-js as a linked member returns `viewer: { seesEveryone: false, ownPersonId }`, the
  editor's people ids, and labels.
- A member's API token: `get_workspace_summary` lists exactly one person (their own). Call the handler as
  `postgrest.test.ts` does, or assert on `from("people")` through the token client.

**Docs (2a):**
- An addendum in `docs/adr/0003-workspace-access.md`, "Per-person privacy (migration 20261207500000)". It covers the
  rule, `team_capacity`, why members get no pay, labels, the accepted limit, and option C as a possible follow-up.
- An entry in `docs/supabase-notes.md`. `team_capacity` and the policies rely on `auth.uid()` and `auth.jwt()` inside
  SECURITY DEFINER functions under the Data API (the same as `workspace_role`). Verified on plain Postgres and PostgREST
  only. Checks on the real project: as a linked member, Settings → People shows one person, and the Overview's numbers
  match an editor's.

### 2a: done

`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build` green, including PostgREST. Bootstrap
and types regenerated; the apply file written; preflight in the PR body; the production-migrations row added. No
`ENGINE_VERSION` bump and no golden changes (editors' numbers can't move: the round-trip proves it). The PR says what a
member sees between 2a and 2b ("Team member N" rows on per-person screens).

### 2b: the screens (no migration)

**`apps/web/src/lib/viewer.ts`** (new, pure, unit-tested in `apps/web/test/viewer.test.ts`):

```ts
import type { Viewer } from "@transpera-flow/db";
export const SEES_EVERYONE: Viewer = { seesEveryone: true, ownPersonId: null };
/** The bundle's viewer; a bundle without one (the demo, fixtures) sees everyone. */
export function viewerOf(x: { viewer?: Viewer } | null | undefined): Viewer;
export function canSeePerson(v: Viewer, personId: string | null | undefined): boolean; // seesEveryone, or it's their own
/** "A team member" for anyone the viewer can't see (Q2). */
export function personName(v: Viewer, personId: string, name: string): string;
/** The same list with other people's names replaced by "A team member", for building name maps. */
export function namedForViewer<P extends { id: string; name: string }>(v: Viewer, people: readonly P[]): P[];
/** Only the viewer's own row, unless they see everyone. */
export function ownRowsOnly<T>(v: Viewer, rows: readonly T[], personIdOf: (row: T) => string): T[];
```

**Per-person displays: members see only their own row** (`ownRowsOnly`). Role-level figures and team totals stay:
- `components/people-page.tsx`: the "How busy each person is" table (`HowBusy`'s rows). `TeamCard` keeps the whole-team
  counts, computed before filtering. With no own row, the table says "Your sign-in isn't linked to a person, so there's
  no row of yours to show. Ask an owner to link you on Settings → Access."
- `components/utilisation-bars.tsx`: the "people" view (L62–L120).
- `components/compare-view.tsx`: the "people" view (L92–L104).
- `components/forecast/forecast-view.tsx` and `forecast-timeline.tsx` (`rows="people"`), and
  `components/forecast/forecast-panel.tsx` L86: the people rows, through `lib/forecast/timeline.ts`'s `people` rows.
- `lib/scenarios/levers.ts` L92 (the per-person levers): only the viewer's own person (a member may still try "what if
  I worked 0.8").

**Other people's names read "A team member"** (`namedForViewer` where the map is built, `personName` for one name):
- `components/issues/issue-page.tsx` L107 (`personName` map: issue owners) and L102 (the form options; read-only for
  members, but build them from `namedForViewer` too).
- `components/issues-page.tsx` L96 (`peopleNames`, also used by `lib/issues/csv.ts`).
- `components/process-issues.tsx` L183–L189, and the `people` it passes to `components/issues-register.tsx`.
- `components/process-page.tsx` L344 (the names map).
- `components/process-canvas.tsx` L348 ("pinned to …") and L1746 (`who`).
- `lib/process-page/about.ts` L83.
- `components/first-principles/first-principles-card.tsx` L60 and `first-principles-flow.tsx` L110 (requirement
  owners).
- `lib/churn-drivers.ts` L217 (`valuePerson`), `lib/scenarios/scenarios.ts` L59, `lib/scenarios/broken.ts` L76.
- Editor-only screens (`step-inspector`, `node-menu`, `node-inline-editor`, `lib/editor/*`, Settings pickers,
  `acknowledge-dialog`) are unreachable for members (1/3's role gating), so leave them.
- Engine-made text keeps the neutral label ("Overloaded: Account manager (Team member 3)" in a detected issue or a
  forecast marker). That's a label, not a name. Don't post-process engine strings.

**Settings for members** (`apps/web/src/lib/data.ts` `loadWorkspaceSettings` and `app/w/[slug]/settings/*`):
- The People section already shows only the member's own record (RLS). Its description line ("N active") counts what it
  shows. Change it for non-editors to "Your record. Owners and editors see the whole team."
- `roleUsage` (`lib/roles.ts`): take `personRoles` and `assignments` from `loadTeam` instead of the RLS reads, so "Used
  by 3 people" stays right for members.
- `clients-settings.tsx` L182: an assigned person not in `props.people` shows "A team member".

**Tests (2b):**
- `apps/web/test/viewer.test.ts`: the helpers, including a missing `viewer` (sees everyone) and a member with no person
  (no rows).
- A browser test of the People page as a member: a new `apps/web/test/people-harness/entry.tsx` copying
  `findings-harness`. It renders `PeoplePage` with `larkspurBundle()` given `viewer: { seesEveryone: false,
  ownPersonId: <Jess> }` and the other names set to "Team member N". Assert:
  - the busy table has exactly one row, Jess;
  - the team card counts the whole team;
  - "A team member" or "Team member" never appears in that table;
  - no console errors at 1440 and 400 px.
- A source-text test (style of `role-gating.test.ts`): each file in the two lists above imports from `@/lib/viewer`.

**Done (2b):** all green; screenshots of the People page as a member in demo-harness form (light and dark, 1440 and 400
px) described in the PR; B2 (#31) unblocked ("A member viewing People sees only their own record").

### Out of scope for 2/3

- Members editing their own record; per-person data in free text (issue titles, findings, AI summaries, sources);
  `reports` and `narrations` (readable as before; no workspace screen shows them; follow-up if they come back);
  `scenarios` patches that name a person's FTE.
- Option C (a per-workspace "no simulated numbers for members" setting): a possible follow-up, not this ticket.
- Any change to `save_fields`, the engine, golden numbers or `ENGINE_VERSION`.

---

## B1 (3/3): agency workspace list, and editors change client-health rules

Branch `claude/b1-3-agency-list` from `main` after 1/3 (PR #199) merges. It doesn't depend on 2/3. Migration version
**`20261209000000`**, name `agency_list` (C2 2b holds `20261208000000`). The last of 2b and 3/3 to merge says
`Closes #30`.

### Migration `packages/db/supabase/migrations/20261209000000_agency_list.sql`

Strictly additive: one table, two functions.

**1. `public.workspace_headlines`** (as before):
- `workspace_id uuid primary key references public.workspaces on delete cascade`;
- `computed_at timestamptz not null default now()`, `computed_by uuid references auth.users on delete set null default
  auth.uid()`;
- `engine_version text not null`, `revision_ids uuid[] not null`, `horizon_weeks integer not null`;
- `numbers jsonb not null`, with a check on its shape: `flow_efficiency` (a number 0–1, or null),
  `processes_attention`, `processes_total`, `client_groups_at_risk` and `client_groups_total` (non-negative integers).
- RLS: select `can_read_workspace`; insert and update `can_edit_workspace`; no delete. `revoke all … from anon`; `grant
  select, insert, update … to authenticated`. Copy the grants pattern of `20261205000000_analysis_findings.sql`.

**2. `public.agency_workspace_list()`**, `security invoker stable set search_path = ''`, returning one row per workspace
the caller can read:
- `id, name, slug`;
- `open_risk_issues`: `issues` with `severity = 'critical' and status in ('open', 'in_progress')`;
- `last_activity`: the greatest `updated_at` or `created_at` over `process_revisions`, `issues`, `findings`, `sources`,
  `solutions` and `audit_log`;
- `numbers, computed_at` from `workspace_headlines`.

`audit_log` is manage-only under RLS, so a caller who doesn't manage gets activity without it. That's fine: the list is
for agency admins. `revoke … from public, anon; grant … to authenticated`.

**3. `public.save_health_rules(ws uuid, base jsonb, changes jsonb) returns jsonb`: editors change Settings → Client
health.**

*Today:* `saveHealthSetting` (`apps/web/src/app/w/[slug]/settings/servicing-actions.ts` L82) saves each rule as
`saveField("workspaces", { id }, "settings.<key>", base, value)`. That goes through `save_fields('workspaces', …)`, whose
row lock and `UPDATE` run under RLS, and the `update workspaces` policy needs `can_manage_workspace`. An editor gets
`not_found`, and `HealthSettings` (`servicing-settings.tsx` L157) disables the fields with "Only workspace owners can
change this." The ticket says editors change Settings, and the 30 Sep design call keeps only the name and currency for
owners.

The keys are the four in `HEALTH_SETTINGS` (`apps/web/src/lib/servicing.ts` L49): `health_initial`, `health_recover`,
`health_late_penalty`, `health_missed_penalty`. Each is a number 0–100, or null for the estimated default. They are
stored as keys of `workspaces.settings`; a null is stored as a JSON null, as `save_fields` does.

**It must be SECURITY DEFINER, not invoker:** an invoker function's `UPDATE public.workspaces` is still refused by the
manage-only update policy. Don't widen that policy or `save_fields`. The function checks `can_edit_workspace` itself
and can write nothing but these four keys. `language plpgsql security definer set search_path = ''`. Behaviour:
- `changes` must be a non-empty object and `base` an object, else 22023 (as `save_fields`).
- Every key of `changes` must be one of the four, else `raise exception 'save_health_rules: % cannot be saved', k using
  errcode = '42501'`. Every key needs a `base` value (22023).
- Every value is JSON null or a number from 0 to 100 inclusive, else errcode `23514` (the app shows "That value isn't
  allowed here.").
- Unless `ws is not null and public.can_edit_workspace(ws)`, return `{"status": "not_found"}` (what `save_fields`
  returns under RLS, so `saveField`'s handling and the role-matrix pattern carry over).
- `select settings … from public.workspaces where id = ws for update`. A missing workspace returns `not_found`.
- Per key, exactly `save_fields`' rule (`20261111000000_client_groups.sql` L230–L239), comparing JSON values:
  - stored ≠ base and stored ≠ new → a conflict `{key: stored}`;
  - stored ≠ new → patch it;
  - otherwise nothing.
- With a patch, `update public.workspaces set settings = coalesce(settings, '{}') || patch where id = ws returning
  settings`. The existing triggers then still do their jobs:
  - `stamp_settings_provenance` marks `settings.<key>` entered, by `auth.uid()`;
  - `audit_company` logs it with the caller as actor;
  - `needs_review` refuses an API token at trigger depth 1, so MCP still can't change the company model directly (D19).
    `auth.uid()` and `auth.jwt()` read the request's claims inside a SECURITY DEFINER function, as `workspace_role`
    relies on.
- Return `{"status": "saved" | "conflict", "row": {"settings": {<only the four keys present>}}, "conflicts": {...}}`.
- `revoke execute … from public, anon; grant execute … to authenticated`.

**Rollback** (header): `drop function if exists public.save_health_rules(uuid, jsonb, jsonb); drop function if exists
public.agency_workspace_list(); drop table if exists public.workspace_headlines; delete from
supabase_migrations.schema_migrations where version = '20261209000000';`

**Apply file** `packages/db/scripts/apply/20261209000000_agency_list.sql`, as for 2a.

**Preflight:**

```sql
-- 0. Row 53 applied; nothing at or after this version.
select version from supabase_migrations.schema_migrations where version >= '20261206000000' order by 1;
-- 1. Nothing created yet. Expect null, null, null:
select to_regclass('public.workspace_headlines'), to_regprocedure('public.agency_workspace_list()'),
       to_regprocedure('public.save_health_rules(uuid, jsonb, jsonb)');
-- 2. The workspaces triggers the health-rule function relies on exist and are enabled. Expect 3 rows, 'O':
select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.workspaces'::regclass
  and tgname in ('stamp_settings_provenance', 'audit_company', 'needs_review');
-- 3. The update policy is still manage-only (why the function is needed). Expect qual can_manage_workspace(id):
select qual from pg_policies where tablename = 'workspaces' and policyname = 'update workspaces';
```

**Post-apply:**
- RLS is on for `workspace_headlines` and it has three policies.
- `anon` holds nothing on the table or either function.
- `save_health_rules` has `prosecdef` true and `proconfig` `{search_path=""}`; `agency_workspace_list` has `prosecdef`
  false.

Then `gen:bootstrap` and `gen:types`, and the production-migrations row.

### App (3/3)

**Health rules:**
- `apps/web/src/lib/fields/server.ts`: add `saveHealthRule(workspaceId: string, key: HealthSetting, base: number |
  null, value: number | null): Promise<SaveOutcome<number | null>>`. It calls `rpc("save_health_rules", { ws, base:
  { [key]: base }, changes: { [key]: value } })` and maps the result as `saveField` does (`readField(result.row,
  "settings." + key)`).
- `servicing-actions.ts` `saveHealthSetting` calls it instead of `saveField`. Update the file's header comment ("health
  rules are workspace settings, which owners change" becomes "which owners and editors change").
- `servicing-settings.tsx` `HealthSettings`: gate on `canEdit` (from `WorkspaceSettingsData`), not `canManage`. The hint
  for others becomes "You can view these; owners and editors can change them." (the wording of
  `demand-settings.tsx`).

**Agency list (as before):**
- `apps/web/src/lib/overview/headline.ts` (pure): `headlineNumbers(model, result, groups)` returns the jsonb above.
  - Flow efficiency comes from `lib/overview/health.ts`.
  - Processes needing attention come from `processHealth(...).attention`.
  - Client groups at risk = `clientHealthSummary(model, result).groups.filter(g => g.rating === "risk").length`.
- In `components/overview/overview.tsx`, once the horizon run is done at the workspace's default horizon and
  `mode === "live"` (editor or above), call a new server action `recordHeadline` (`apps/web/src/app/w/[slug]/`). It
  upserts the row, and skips when the stored `revision_ids` and `engine_version` match and `computed_at` is under an hour
  old.
- In `apps/web/src/app/page.tsx`, for agency admins, replace the cards with a table: Workspace, Flow efficiency,
  Processes needing attention, Open Operational risk issues, Client groups at risk, Last activity.
  - Use `components/ui/table` as the Access page does, and the wording of `RatingPill`
    (`components/overview/rating-pill.tsx`).
  - With no headline, show "Open the Overview once to see these".
  - Show "as of <date>" from `computed_at`.
  - Give each column header an (i) with a plain description and an example.
  - Non-admins keep the current cards.

### Tests (3/3)

- **`role-matrix.test.ts`**:
  - Add `save_health_rules` to `RPCS`: refusal `{ status: "not_found" }`; owner and editor allowed. The call is `select
    public.save_health_rules($1, '{"health_recover": <current>}', '{"health_recover": 7}') as r`, reading the current
    value first.
  - A `describe("client health rules")`:
    - the editor saves `health_recover` 7: the status is `saved`, `settings.health_recover` is 7,
      `provenance -> 'settings.health_recover' ->> 'source'` is `entered` with `by` = the editor, and an `audit_log` row
      names the editor;
    - null restores the default (the stored value becomes JSON null);
    - a stale base gives `conflict` with the stored value;
    - 101 and "7" (a string) give 23514;
    - `currency`, `name`, `hours_per_week` and `availability_floor` as keys give 42501 for the editor *and* the owner;
    - the editor still can't rename the workspace or change the currency (the existing tests stay green);
    - `anon` has no execute right.
- **PostgREST** (`postgrest-roles.test.ts`): an editor's **session** saves a rule; an editor's **API token** is refused
  with the "changes only by review" message (`needs_review`).
- **`workspace_headlines`**: member and viewer can't insert or update; every reader reads.
- **`agency_workspace_list`**: counts on Northbeam (the seed has 0 critical issues, so insert one).
- **Unit**: a unit test of `headlineNumbers`.
- **Source text**:
  - the admin table renders (source text or browser);
  - `HealthSettings` gates on `canEdit` and `saveHealthSetting` calls `saveHealthRule`.

### Done (3/3)

All green; bootstrap and types regenerated; the apply file; preflight in the PR body; `docs/supabase-notes.md` gets a
line for `save_health_rules`. It relies on `auth.uid()` inside a SECURITY DEFINER function, and on `needs_review`
refusing API tokens there. Check on the real project that an editor can change "Task on time" on Settings → Client
health and that the change shows in the owner's change log. Screenshot the Client health section as an editor and as a
member, described in text.

---

## Edge cases (all slices)

- **Last owner**: guarded (1/3), except the domain-removal gap in ADR 0003. Agency admins are exempt (Q7).
- **agency_admin can't be granted by owners**: already enforced (memberships policies, the list's role check). Keep the
  existing tests green. Don't add `agency_admin` to `ASSIGNABLE_ROLES`.
- **One person per membership**: enforced server-side by `setMemberPerson` (`personLinkProblem`, 1/3) and the pickers,
  not by a database constraint (it would break `resolve_my_access` at sign-in on existing duplicates). 2a's preflight 4
  checks production has no duplicates. If two active memberships ever share a person, both see that record. A person
  deleted → `memberships.person_id` is set null (existing FK).
- **A viewer linked to a person** sees their own record, as a member does (Q3).
- **Unlinked member or viewer**: sees no per-person rows, all labels, and the company numbers. The People page says how
  to get linked.
- **Deactivated membership**: `workspace_role` and `my_person_id` ignore it, so the user sees nothing.
- **Agency admin by JWT flag with no membership**: `my_person_id` is null; `can_see_people` is true.
- **Inactive person**: still labelled (labels count every person), never in a rate pool.
- **A role with few rated people**: nothing special any more: members get no rates at all (Q8 is replaced, 6 Oct).
- **Demo mode**: no change. `/demo` is the full editor view (Q5); its bundles have no `viewer`.
- **MCP tokens**: run as their owner under RLS (ADR 0002). See 2a's MCP paragraph. Health rules can't be changed through
  MCP (`needs_review`), as before.
- **Realtime**: only `steps`, `edges` and `processes` are published (`20261007000000_realtime.sql`), so no per-person
  table leaks through Realtime.
- **AI analysis** sends per-person facts to Anthropic, but only editors and above can run it (`reserve_ai_run`), and
  `lib/ai/facts.ts` already aliases names. No change.

## Out of scope

- Magic link, email sending, SMTP, Microsoft sign-in.
- Members editing their own record (leave, skills). They read it only.
- Share links and the `viewer` share-link persona (B3, #32); play links (B4).
- Finishing the People page (B2, #31) beyond what 2b needs to hide other people.
- Redacting names inside free text (issue titles, findings, AI summaries, source text). They're shared team output.
- Option C (per-workspace "no simulated numbers for members"): a later follow-up.
- Making the other owner-only settings editable (Q9).
- Any change to `save_fields`, the engine or golden numbers. No `ENGINE_VERSION` bump in any slice.

## Questions for Austin

**Answered:**

- **Q1 → A'** (6 Oct, #30). Members and viewers get the per-person simulation inputs under neutral labels, with names,
  emails and notes left out. **Cost rates: first the role's hours-weighted average, then, the same day, none at all**
  (see Decisions: no pay for members and viewers). Their numbers otherwise match an editor's, except the costs that
  depend on pay, which show "—". The screens show them only their own row. Quoted in full under Decisions. Spec: 2a and
  2b.
- **Q2 → their own name, "A team member" for anyone else** (6 Oct). Spec: 2a (`revision_history`, `ai_runs`,
  `loadMemberNames` through RLS) and 2b.
- **Q3–Q7 → the defaults** (6 Oct):
  - Q3: a linked viewer sees their own record;
  - Q4: only owners and editors read saved runs;
  - Q5: no demo "view as member";
  - Q6: the agency list's headline numbers as listed;
  - Q7: an agency admin may leave a workspace with no owner.

The originals, for the record:
- **Q1.** What may a member's browser receive about other people? (A: neutral labels; B: role totals only; C: no
  simulated numbers.)
- **Q2.** Should members see other people's names?
- **Q3.** Can a viewer be linked to a person and see their own record?
- **Q4.** Who reads saved runs?
- **Q5.** A demo "view as member" switch?
- **Q6.** Which headline numbers go on the agency list?
- **Q7.** Can an agency admin leave a workspace with no owner?

**Open (not blocking; the builder uses the default unless Austin says otherwise):**

- **Q8. Small roles would show pay. Replaced (6 Oct): members and viewers get no pay at all.** The k = 3 pool and the
  company-wide fallback proposed here were not enough: overlapping averages leak an exact rate by subtraction (see
  Decisions), and any average gives a rate away over time as people join or leave.
- **Q9. Other owner-only settings.** Besides the name and currency, four more settings save through the same owner-only
  path today:
  - the availability floor and the overtime cap (Settings → People);
  - the client-health benchmark low and high (Settings → Client groups).

  3/3 opens only the four Client health rules to editors, as asked. *Default: leave those four owner-only for now.
  Adding them later is one line in `save_health_rules`' allow-list (rename it `save_editor_settings` then).*

Nothing is blocking.
