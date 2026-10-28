# 8. Company-model suggestions are applied by the database, and runs keep a snapshot to diff

Date: 30 Sep 2026 · Status: **Superseded: removed 28 Oct 2026, docs/plans/cut-list.md item 2** · Issue: #25 · Implements PRD §7.1c, D19 · Amended by 0012 (roles)

> Superseded. The Suggestions page, the `suggestions` and `suggestion_proposals` tables, their review functions and the MCP tools that wrote
> company facts were removed by migration `20270102000000_drop_suggestions.sql`. People, clients, services, demand and company settings are
> changed in the app only; MCP is read-only (ADR 0018). What stays from this ADR: runs keep a snapshot of the company model, and the
> change log (now Settings → Change log) reads `audit_log`. The text below is the record of what was decided then.

## Context

Humans record facts about the company (settings, services, people, clients, demand) and those edits apply live. The AI
must never change them without review: the MCP tools `set_company`, `upsert_service`, `upsert_person`, `upsert_client`
and `set_demand` create suggestions instead. Accepting one must apply it with provenance from its evidence. Everything is
audit-logged with the actor kind. Saved runs must show "model changed since this run" with a list of changes.

## Decision

- **Rule-based, no language model.** The suggestions come from the MCP client (Claude Code or Claude desktop, following
  the extraction prompt of §7.2). The server only resolves names, keeps the values that differ from the model, and
  stores them. No LLM is called by the app for this.
- **One suggestion per row changed**: `suggestions(target_table, target_id, patch, evidence, note)`. `patch.set` holds
  column values (settings keys for `workspaces`); people take `roles` and `leave`, clients `services` and
  `assignments`. `set_demand` makes one per lead source, month and growth, so each can be accepted on its own.
- **The database applies accepted suggestions**: `public.review_suggestions(ids, decision, note)` is security invoker,
  so RLS decides (owners for company settings, editors for the rest). Each suggestion runs in its own subtransaction:
  one that can't apply fails and stays pending while the rest go through. Accepted values get
  `provenance.<column> = {source: estimated, evidence, note, suggestion_id, assumption?}` (ADR 0007's shape).
  `workspaces`, `people` and `services` gained a `provenance` column (and the same `entered` stamping lead sources and
  clients have) so every suggestible value can carry it.
- **Enforced at the database, not only in the tools.** A trigger refuses company-model writes from API-token requests
  (`auth.jwt() ? 'api_token_id'`), and `review_suggestions` refuses them too, so a token used straight against the Data
  API can't bypass review. Roles stay writable (process building, #24, may need them).
- **Audit** by a security-definer trigger on every company-model table and on `suggestions`: actor kind `user` or
  `mcp`, changed columns only, the suggestion id when a write came from accepting one. Writes with no user (seed,
  migrations) aren't logged.
- **Runs keep a snapshot, and the diff is computed in TypeScript.** `runs.params_snapshot` is `snapshotModel()` of the
  company model plus each process's live revision, taken by the server when the run is saved. Opening a run compares
  it with a snapshot of the model now (`diffSnapshots`) and lists the differences in plain words. The demo mirrors
  the database's apply with `applySuggestion`, and a test keeps the two in step.

## Consequences

- The banner is exact about company facts and process revisions but not about *which* step changed in a new revision
  (the draft audit entry has that).
- Diffing snapshots rather than reading `audit_log` works for every member (the log is owner-only) and needs no joins,
  but a change made and undone between two runs doesn't show, which is what the banner should say anyway.
- Forecasts (#35) can reuse `snapshotModel`/`diffSnapshots` for their own banner.
