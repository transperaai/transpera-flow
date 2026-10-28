# 20. Three roles: Owner, Agency admin, Viewer

Date: 28 Oct 2026 · Status: accepted · Supersedes 0003 · Amends 0012 · docs/plans/cut-list.md item 9, strip brief S3

## Context

Access had two layers: a deployment-wide sign-in list (admin, editor, viewer) and per-workspace roles (agency_admin, owner, editor,
member, viewer) from per-workspace email lists and domain joins. With the multi-tenant machinery stripped, that was far more than
a handful of client deployments need.

## Decision

- **Three roles.**

  | Product word | Sign-in list (`deployment_access.role`) | `memberships.role` | Claim |
  |---|---|---|---|
  | Owner (Austin) | `owner` | none needed | `app_metadata.agency_admin = true` (`public.is_agency_admin()`) |
  | Agency admin | `agency_admin` | `owner` | |
  | Viewer | `viewer` | `viewer` | |

  The names `is_agency_admin()` and `agency_admin` (claim, `agencyAdmin` in code) kept their spelling and now mean the Owner.
  A membership's `owner` means Agency admin. `membership_role` still has five labels (Postgres can't drop one); a check
  constraint allows only `owner` and `viewer`.
- **What they can do.** The Owner does everything. An Agency admin edits everything (`can_edit_workspace`,
  `can_manage_workspace`), sees every person and individual pay (`can_see_people`), uses the sandbox, creates share links and
  manages who can sign in, except Owner rules. A Viewer reads everything except individual pay (B1 privacy, ADR 0003's addenda)
  and edits nothing. Editors and owners were one role in practice for everything but workspace settings, branding and the
  audit log, and those now belong to Agency admins too.
- **Who can sign in is the only access list.** Owners and Agency admins read it; an Agency admin changes `agency_admin` and
  `viewer` rules only (row-level security), so only an Owner makes or removes an Owner. `ACCESS_ADMIN_EMAILS` names Owners.
- **The sync is the source of truth.** `private.sync_deployment_access` runs at sign-in and makes the person's membership in
  every workspace match the list, raising or lowering it, and reactivating a deactivated one. A trigger on `workspaces` does the
  same for everyone already on the list when a workspace is made. The Owner gets the flag and no membership.
- **Memberships are not written by people.** `authenticated` can update `memberships.person_id` only (Settings > Access links a
  sign-in to a person record); inserts, deletes and role changes come from the sync.
- **Gone:** `workspace_access_emails`, `workspace_domains`, `reconcile_access`, `reconcile_after_access_change`,
  `resolve_my_access`, `qualifies_for_domain`, the keep-an-owner guard, the invite message.

## Consequences

- Removing someone from the list ends their session and API tokens at the next request (unchanged), but leaves their old
  membership rows; the members list hides anyone the list no longer names.
- A restore's "settings as a pending suggestion for an owner" path can no longer be reached (every restorer manages).
  `import_workspace_bundle` still carries the branch, and its refusal still says "owners, editors and agency admins".
- The enum labels `agency_admin`, `editor` and `member` stay in the type until it is rebuilt.
