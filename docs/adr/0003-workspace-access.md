# 3. Workspace access by allowed domain and pre-assigned email

Date: 29 Sep 2026 · Status: accepted · Issue: #51 (replaces "invite by email" in #30)

## Context

Client staff sign in with Google. We don't want invitation emails (deliverability, SMTP, expiring links). Each workspace
needs a way to say who may get in and with what role, managed by the workspace owner or an agency admin, without ever
giving the app the service-role key.

## Decision

- Two per-workspace lists: **allowed domains** (`workspace_domains`, a domain belongs to at most one workspace) and
  **pre-assigned emails** (`workspace_access_emails`: email → role, optional person record). Only `can_manage_workspace`
  (agency admin or owner) can read or change them, enforced by RLS.
- **Resolution** is a narrowly scoped `SECURITY DEFINER` function, `public.resolve_my_access()`, that only reconciles the
  caller (`auth.uid()`). The app calls it from `/auth/callback` after every sign-in, and again from `/` when a signed-in
  user sees no workspace. It is idempotent. Order:
  1. confirmed email on the pre-assigned list → exactly that role (`source = 'access_list'`);
  2. otherwise Google `hd` claim **and** confirmed email domain both equal an allowed domain → `member` (`source = 'domain'`);
  3. otherwise nothing → holding page.
- **Where `hd` comes from.** Supabase Auth reads Google's ID token and stores the hosted-domain claim as
  `custom_claims.hd` in both `auth.users.raw_user_meta_data` and `auth.identities.identity_data` (GoTrue
  `parseGoogleIDToken`). We read it **only from `auth.identities`**: `user_metadata` is writable by the user through
  `auth.updateUser`, so trusting it would let anyone claim a domain. Personal Google accounts (including ones created
  with a work address) have no `hd` and never join by domain. GoTrue only keeps `hd` when Google returns an ID token, so
  the login action adds the `openid` scope; without an ID token GoTrue falls back to the userinfo endpoint, drops `hd`,
  and domain join fails closed. Microsoft (later) should use the tenant ID the same way.
- **Free-mail domains** (gmail.com, outlook.com, …) are rejected by a check constraint (`is_free_mail_domain`); people
  on them go on the pre-assigned list.
- `memberships` gains `source` (`manual` | `access_list` | `domain`), `active` and `person_id`. Resolution never touches
  `manual` rows (e.g. `make-agency-admin.sql`) and never reactivates an inactive row, so "Remove access" on a domain
  member sticks. The list is authoritative for listed people's role; a domain member's promotion is kept.
- **Removal is immediate.** Triggers on the two lists re-run reconciliation for affected users, and RLS reads
  `memberships` on every request (`workspace_role()` now ignores inactive rows), so removal takes effect on the next
  request, not just the next sign-in.
- **Audit.** Triggers write every insert/update/delete on `memberships`, `workspace_domains` and
  `workspace_access_emails` to `audit_log` (PRD §5 shape; no foreign keys so entries outlive what they describe).
  Automatic joins are recorded with `actor_kind = 'system'`.
- Owners cannot grant, change or remove `agency_admin` memberships; `agency_admin` can't be pre-assigned.

## Consequences

- Google Workspace users on a *secondary* domain have `hd` = the primary domain, so they don't match a domain join for
  the secondary domain; add them by email (or we relax the rule later).
- `workspace_members(ws)` is a second `SECURITY DEFINER` function so the Access page can show emails and last sign-in
  from `auth.users`, returning nothing unless the caller manages the workspace.
- Existing sessions revoked from the list keep a valid JWT but see nothing through RLS; there is no session kill.

## Addendum: a workspace keeps an owner (issue #30, migration 20261206000000)

- A signed-in person (or an API token) can't demote, deactivate or delete a workspace's **last active owner**, themselves
  included, nor remove or re-role the pre-assigned email row that made them one. Two `keep_an_owner` triggers (on
  `memberships` and `workspace_access_emails`) raise `workspace_keeps_an_owner` (23514); the Access page shows "A workspace
  needs at least one owner. Make someone else an owner first."
- Agency admins (the JWT flag) are exempt, so a workspace can be left with no owner when offboarding. A workspace with no
  owner at all is allowed; the rule only stops going from one owner to none.
- The membership guard applies only when `current_user = 'authenticated'`. Reconciliation (SECURITY DEFINER), foreign-key
  cascades and SQL run as other roles pass.
- The guard also refuses changing the last owner's `source` or `workspace_id` (otherwise they could change their own source
  and let `resolve_my_access` drop them), takes a per-workspace advisory lock so two owners can't demote each other at the
  same moment, and (list guard) applies only to people (`current_user = 'authenticated'`), so support SQL as another role passes.
- **Known gaps (follow-ups):** an owner who joined by *domain* and was then promoted loses their membership when the domain
  is removed, and an owner who deletes the domain they joined by does the same, because that reconciliation runs as the
  function owner and isn't guarded. That is rare, and an agency admin can fix it.
- `public.my_person_id(ws)` returns the person record linked to the caller's active membership. Any member can be linked to
  a person on the Access page (not only people on the pre-assigned list). One membership per person is a rule of the page,
  not the database: a unique constraint would make `resolve_my_access` fail at sign-in on existing duplicates.

## Addendum: per-person privacy (migration 20261207500000)

Austin's decision of 6 Oct 2026 (issue #30, option A').

- **The rule.** Agency admins (the JWT flag), `agency_admin` members, owners and editors see every person, as before
  (`public.can_see_people(ws)` is `can_edit_workspace(ws)`). A member or viewer sees only the person their membership is
  linked to (`public.can_see_person(ws, person)`, using `my_person_id`). The select policies on `people`, `person_roles`,
  `person_skills`, `person_leave` and `client_assignments` use `can_see_person`. Saved runs and robustness results (which
  hold per-person utilisation) are read by those who see everyone only. A suggestion about a person is hidden from those who
  can't see that person, and `ai_runs` (which stores who ran an analysis) is read by those who see people, or by the runner.
  `revision_history` shows a person's name only to those who can see that person; the app says "A team member" for null.
  Writes are unchanged: members and viewers never wrote.
- **`team_capacity(ws)`** (SECURITY DEFINER) is how a caller gets the whole team's simulation inputs: people, roles held,
  skills, leave and client assignments, with the real ids. Callers who see everyone get the stored values. Everyone else gets
  "Team member N" labels (their own person keeps their name), `provenance` `{}`, and each person's own cost rate replaced by
  the average for their role, weighted by hours (a person in k roles counts 1/k in each). It never returns email, notes,
  leave notes or skill efficiency. `loadProcessBundle`, `loadClients` and `loadCompanyModel` read the team only through it,
  so a member's numbers are an editor's except overtime cost (the only number person rates feed, apart from the cost figures
  on detected issues).
- **The k = 3 pool.** A role is averaged only when at least three active people with a rate hold it, otherwise the
  workspace average (again only with three), otherwise no rate, and the engine then uses the role's default rate. With
  one or two people the "average" would be their pay.
- **Labels** are the person's rank by `(created_at, id)` over all people, active or not: adding a person appends a number,
  deactivating one changes nothing. Deleting a person renumbers those created after them (people are normally deactivated).
- **Accepted limit.** A member using browser dev tools can still read anonymous hours and leave dates, because the browser
  simulates. Option C, a per-workspace "no simulated numbers for members" setting, is a possible follow-up, not part of this.
- An unlinked member or viewer sees no person rows and all labels. MCP needs no code: tokens run as their owner under RLS.
