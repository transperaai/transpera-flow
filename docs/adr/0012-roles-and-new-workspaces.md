# 12. Roles are company-model facts, and agency admins create workspaces with one call

Date: 30 Sep 2026 · Status: accepted · Issue: #88 · Amends 0008 · Implements PRD §5 `roles`, §7.1

## Context

A new workspace could only be made with SQL, and once it existed nothing in the app or the MCP server could add a role,
so a process with steps for roles that didn't exist couldn't be imported. Roles were also the one company-model table
0008 left writable by API tokens ("process building may need them"). Nothing in the MCP server writes them, and roles
are facts about the company like people and services, so the same review applies.

## Decision

- **Roles are suggested, not written, over MCP.** `upsert_role({name, rename?, create?, evidence?, note?})` creates a
  suggestion like the other company tools, and accepting it creates or renames the role (`private.apply_suggestion`
  gained a `roles` branch; only `name` can be suggested). This reverses 0008's "Roles stay writable": the
  `needs_review` trigger is now on `roles` too, so a token can't insert, update or delete them. `roles` gained a
  `provenance` column so the generic apply path works unchanged. A role a step needs is suggested, accepted by a
  person, and then `import_process` can name it.
- **Deactivate rather than delete, enforced in the database.** `roles.active` (default true). An inactive role is
  hidden from pickers (a new person's role, a person's role list, a step's role) but whatever already names it keeps
  it, and it still simulates: its head-count and people still count. Deleting a role that a step (in any revision,
  superseded ones included), a person, a client assignment or a service's fallback load names fails with 23503 and
  "make it inactive instead". Before this, deleting one silently removed its `person_roles` and `client_assignments`.
  The `in_use` trigger (`before delete`, security definer so it sees rows RLS would hide) skips when
  `pg_trigger_depth() > 1`: deleting a workspace cascades to its roles from inside the workspace's own delete, and that
  must still work. Because `in_use` sorts before `needs_review`, a token deleting a role in use gets 23503, not 42501.
- **Names are unique per workspace**, ignoring case and surrounding spaces (`roles_workspace_name_key` on
  `lower(btrim(name))`), and 1 to 200 characters. The MCP tool checks the same rule case-insensitively, so it refuses a
  rename onto another role's name before storing a suggestion the database would fail at accept time.
- **`create_workspace(name, slug, settings)` is one atomic RPC.** It runs as the caller (security invoker), so RLS
  still decides both inserts. It refuses an API token (42501: workspaces are created in the app) and anyone who isn't an
  agency admin, validates the name and the three settings it accepts (`hours_per_week`, `horizon_weeks`, `currency`,
  with the bounds `set_company` uses), inserts the workspace with the defaults `WorkspaceSettings` needs (40 hours, 13
  weeks, GBP, and zeros for the interim demand and finance keys), and gives the creator a `manual` `agency_admin`
  membership. The defaults live in the database, not the app, so any caller gets a workspace the engine can read. The
  scenario library and audit entry come from the existing triggers. A `needs_review_insert` trigger on `workspaces`
  also stops a token inserting one directly through the Data API (the 0008 trigger covered update and delete only).
- **A new workspace opens.** `/w/<slug>` with nothing published no longer 404s: it shows the workspace's links, any
  unpublished processes, and how to get going (add roles, then import a process with Claude).

## Consequences

- Inactive roles still reach the simulation. Someone who wants a role out of the model removes its people and steps
  first; the alternative (dropping inactive roles from the engine model) would change results for anything that names
  one, so it is left for a later decision.
- `add_step`, `import_process`, `upsert_person` and `upsert_client` don't warn when they name an inactive role.
- The run snapshot (`ROLE_FIELDS` in `company.ts`) doesn't include `active`, so making a role inactive doesn't show as
  "model changed since this run" on old runs; its name and numbers still do.
- The migration is additive, but it takes brief ACCESS EXCLUSIVE locks on `roles` and `suggestions`, both tiny.

## Amendment, 28 Oct 2026 (migration 20270103000000)

`create_workspace` is still Owner-only, but it no longer gives the creator a membership: the Owner passes every policy by the flag, and a trigger on `workspaces` gives everyone the sign-in list names (Agency admins as `owner`, Viewers as `viewer`) a membership in the new workspace. See docs/adr/0020-three-roles.md.
