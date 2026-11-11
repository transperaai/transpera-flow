# 24. One workspace per deployment (multi-tenancy hidden, not removed)

Date: 11 Nov 2026 · Status: accepted · rework-direction decision 1 · builds on 0020

## Context

Each client gets their own deployment: one Vercel project and one Neon database ([new-client.md](../new-client.md)). A client's
deployment holds one workspace, yet the app still behaved as a multi-tenant system: the home page listed workspaces, the sidebar
had a switcher with "All workspaces", the Owner could keep making workspaces, and MCP needed the right workspace chosen.

Removing the machinery (workspaces as tenants, memberships, cross-workspace RLS) would touch the schema, every policy, backup and
restore, MCP and the example loaders, for no gain to a client. A demo or QA deployment also still wants several workspaces.

## Decision

**Hide multi-tenancy in the product; keep it in the data.** Nothing in the database changes: the schema, row-level security,
memberships, the three roles (0020), `/w/[slug]` URLs, backup and restore, MCP's `list_workspaces` and `set_active_workspace`, and
the example loaders stay as they are.

- **Home (`/`).** With exactly one visible workspace it redirects to `/w/<slug>`. With none it stays the bootstrap page (the Owner
  makes the first workspace; anyone else is told to ask). With two or more it stays the list (the Owner's agency table).
- **Sidebar.** With one workspace the switcher is the workspace name alone: no menu, no "All workspaces". Links back to `/` (the
  header logo, the not-found page) land in the workspace through the redirect.
- **New workspace.** `createWorkspace` refuses a second workspace unless `ALLOW_MULTIPLE_WORKSPACES=true`; the first is always
  allowed. The home page offers the button only when another may be made. The check counts the workspaces the signed-in user can
  see; only the Owner can create one (`create_workspace`) and the Owner sees all of them, so that is the deployment's count. The
  database itself does not enforce the limit.
- **MCP.** With no `workspace` argument and no (visible) active workspace, a tool uses the only workspace and says so in its
  assumptions; with two or more it still answers `no_active_workspace`.

## Consequences

- A demo or QA deployment sets `ALLOW_MULTIPLE_WORKSPACES=true` and behaves as before.
- Two concurrent creates on an empty deployment could both succeed (the check is in app code, not a constraint). With one Owner
  per deployment this is accepted; a deployment that ends up with two shows the list again.
- Removing multi-tenancy for real stays possible later; nothing here makes it harder.
