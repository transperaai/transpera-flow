# Strip briefs (cut list items 1–3, 5–7, 9)

Opus brief, 28 Oct 2026. Source decisions: `docs/plans/cut-list.md` (Austin, 27–28 Oct). Built on the integration branch
`claude/supabase-migration-plan-mzchlf` **before** the cutover (Austin, 28 Oct: "make the changes then I'll QA").
Three builders run in parallel worktrees (S1, S2, S3), each owning the files listed. Opus merges and reviews.

## Rules for all three

- **Remove, don't hide.** Delete the code, routes, components, server actions, MCP tools, tests and types of a removed
  feature. Delete a test only when the feature it covers is gone, and list each one in the report. Tests of kept
  behaviour must still pass unchanged, or be updated where they referenced a removed thing, keeping their intent.
- **Migrations transform real data.** At cutover the production copy is imported at row 76 (`20261231000000`), then the
  remaining migrations run on it. So each strip migration must work on a database full of real rows: drop tables with
  `drop table if exists … cascade` only after checking what depends on them, and move data where the decision says
  so (S3).
  - S1 is `20270101000000_drop_in_app_ai.sql`.
  - S2 is `20270102000000_drop_suggestions.sql`.
  - S3 is `20270103000000_three_roles.sql`.
  - Drop dependent functions, policies, triggers, views and audit hooks too. Grep the migrations for each table and
    function name.
- **After changing SQL,** regenerate the types: `pnpm --filter @transpera-flow/db gen:types`. Generated files
  (`db-types.ts`, `json-columns.ts`, `function-types.ts`) will conflict between builders; Opus regenerates them at merge.
- **Docs.** Mark superseded ADRs ("Superseded: removed 28 Oct 2026, docs/plans/cut-list.md item N"). Add a dated note to
  `docs/PRD.md` where a requirement is removed, without rewriting history.
- **Done:** `pnpm lint && pnpm typecheck && pnpm test` green in the worktree, with
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres. The known `format.test.ts` ICU failure is ignored.
  Nothing removed is still reachable (grep for the names).

## S1. Remove in-app AI and findings (items 1, 3, 6)

**Owns:** `apps/web` (except `packages/mcp` and the role and access code, which belong to S2 and S3) and `packages/db`
for AI and findings.

- **Remove AI:**
  - the Analyse button and actions (`app/w/[slug]/ai-actions.ts`), `lib/ai/*`;
  - narration (`lib/narration/*`, `app/api/narrate`, `components/narration.tsx`, "Explain this run");
  - Settings → AI analysis;
  - the `@anthropic-ai/sdk` dependency, `ANTHROPIC_API_KEY` reads, and its docs and env entries;
  - the AI marks, AI cost lines, model and cost footers.
- **Remove findings:**
  - `public.findings`, findings actions (`findings-actions.ts`), "findings by hand", accept and dismiss, and the
    Overview's and process pages' findings lists.
  - Issues are logged directly by hand (the existing "new issue" path stays).
  - Keep the engine's **facts** as read-only evidence on the pages where they show today.
  - An issue that was acknowledged from a finding keeps its `detected_key`; nothing reads it as a finding any more.
- **Migration S1:**
  - drop `ai_analyses`, `ai_runs`, `ai_settings`, `narrations`, `findings`;
  - drop their functions, policies and triggers;
  - drop the AI-related workspace settings keys, if any.
  Check `reports` (PDF reports were removed in A32): drop it only if nothing reads it.
- **MCP:** leave `packages/mcp` alone; S2 removes the AI and findings tools there. If web code imports something S2
  deletes, keep your side compiling and say so.

## S2. Remove Suggestions; MCP read-only; play links keep only "try" (items 2, 5, 7)

**Owns:** `packages/mcp` (all of it), the Suggestions page (`app/w/[slug]/suggestions`, `suggestion-actions.ts`),
`lib/suggestions/*`, the share-link "send an idea" path (`app/s/[token]/actions.ts` `submitPlayIdea` and its UI), and
`packages/db` for suggestions and proposals.

- **Remove the Suggestions page,** its nav item and counts, its review actions, and the visitor-idea submission (play
  links stay: visitors move levers, nothing is saved). Keep the "model changed since this run" banner if it reads the
  audit log rather than suggestions; check.
- **Make MCP fully read-only.**
  - **Keep:** `list_workspaces`, `set_active_workspace` (a token preference), `get_workspace_summary`, `get_process`,
    `get_first_principles`, `get_facts`, `get_bottlenecks`, `list_issues`, `list_solutions`, `list_sources`,
    `list_templates`, and `run_scenario`, which simulates without saving (check it writes nothing).
  - **Remove** every tool that writes: `add_source`, `import_source`, `link_source`, `add_step`, `update_step`,
    `remove_step`, `set_routing`, `save_fields`, `open_draft`, `publish_process`, `create_process`,
    `create_from_template`, `create_library_process`, `import_process`, `import_new_process`, `import_process_bundle`,
    `update_first_principles`, `log_issue`, `propose_issue`, `propose_finding`, `propose_solution_idea`, `review_note`,
    `save_scenario`, `set_company`, `set_demand`, `upsert_client`, `upsert_person`, `upsert_role`, `upsert_service`.
  - **Remove** the AI and suggestion reads: `get_analysis`, `list_findings`, `list_proposals`, `list_suggestions`.
  - Remove the now-unused helpers (`building.ts`, `proposing.ts`, `suggesting.ts`, `import-file.ts` and so on, if
    nothing kept uses them). Update the MCP tool descriptions and the extraction skill
    (`.claude/skills/process-file` or wherever the MCP write flow is documented) so nothing tells Claude to write
    through MCP.
  - The web app's "Upload process" uses some MCP import code: keep what the web upload needs, moved under `apps/web`
    or `packages/db` if it lived in `packages/mcp`.
- **Migration S2:**
  - drop `suggestions`, `suggestion_proposals` and their functions (`review_suggestions`, `submit_play_proposal`, …),
    policies and triggers;
  - drop `capacity_factor_proposals` **only if** it is fed only by MCP or suggestions (check the calibration flow
    first; if the in-app calibration uses it, keep it);
  - leave `mcp_token_lookup` and the token tables alone.
- ADR 0008 is superseded. ADR 0018 is updated to say MCP is read-only.

## S3. Three roles: Owner, Agency admin, Viewer (item 9)

**Owns:** `packages/db` access and roles (deployment access, memberships, the `can_*` functions, the role matrix tests),
`apps/web/src/lib/auth/*`, `lib/access-data.ts`, `lib/deployment-*.ts`, `app/w/[slug]/settings/access/*`, role labels
and role checks across `apps/web`.

- **The model.**
  - **Owner** (Austin) = today's agency admin flag. Everything.
  - **Agency admin** = an `owner` membership in every workspace. Edits everything, uses the sandbox, creates share
    links, **manages who can sign in**, **sees pay**.
  - **Viewer** = a `viewer` membership. Reads everything except individual pay (B1 privacy), and can't edit.
  - The per-workspace roles `editor` and `member` go away as choices.
- **Who can sign in** becomes the only access list.
  - `deployment_access.role` values become `owner`, `agency_admin` and `viewer` (migrate `admin` → `owner`,
    `editor` → `agency_admin`, `viewer` → `viewer`).
  - Agency admins (not only Owners) can read and write it, but only Owners can add or remove an `owner` rule.
  - `ACCESS_ADMIN_EMAILS` → Owner.
  - The sign-in sync makes an `owner` membership for agency admins and a `viewer` membership for viewers in every
    workspace. It lowers an existing membership to match the list, which is a change from "never lower": the list is now
    the single source of truth.
- **Remove the per-workspace access machinery:**
  - per-workspace email lists and domain joins (`workspace_access_emails`, `workspace_domains`, `reconcile_access`'s
    list and domain paths, and the invite UI in Settings → Access);
  - keep `memberships` as the internal table RLS reads.
- **Migration S3:**
  - map existing memberships: `editor` → `owner`, `member` → `viewer`;
  - map `deployment_access` roles;
  - drop the per-workspace access tables and functions;
  - tighten the role check on `memberships` to `owner` or `viewer`;
  - update every `can_*` function and policy that names `editor` or `member`, so behaviour matches the model above.
  Pay visibility: owners and agency admins see pay; viewers don't (today editors see pay and members don't, so check
  the B1 functions).
- **UI.** Role names read "Owner", "Agency admin", "Viewer" everywhere. Settings → Access shows "Who can sign in" with
  the three roles. Remove role pickers for the old roles.
- **Tests.** Rewrite the role-matrix tests (`packages/db/test/role-matrix.test.ts`, `access.test.ts`,
  `deployment-access.test.ts`, the web role-gating tests) for the three roles. Cover pay visibility for each role, an
  agency admin managing sign-in, an agency admin unable to add an Owner, and the sync lowering a membership.

## After the merge (Opus)

- **Copy tooling:**
  - `copy:import` accepts a target at `COPY_BASE_VERSION` (`20261231000000`), not only at head;
  - the README's cutover becomes: migrate up to the base → import → verify → `migrate` (runs S1–S3 on the real data) →
    re-check;
  - `migrate` gets an `--up-to` flag.
- Re-run the rehearsal on a Neon branch with the real export, through to head.
- Reset the preview database the same way, so Austin's QA sees the stripped app on real data.
