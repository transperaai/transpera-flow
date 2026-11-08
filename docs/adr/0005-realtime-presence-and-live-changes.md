# 5. Presence and live changes: Postgres Changes for data, Presence and Broadcast for people

Date: 7 Oct 2026 · Status: Superseded: live editing removed (26 Oct 2026, docs/plans/rework-direction.md decision 6) · Issue: #10 · Implements PRD §4.1 (concurrent editing), D14

## Context

Two people editing one process must not overwrite each other silently. Saves are already per-field compare-and-set
(ADR 0001) and go into the process's draft (ADR 0004). This adds: who else is viewing the process ("Tom is viewing Lead
to Cash"), other people's saved changes appearing without a reload, and naming Tom in the keep-mine / keep-theirs
prompt. MCP edits will later follow the same rules, so whatever pushes changes must not depend on the saving browser.

Two ways to push saved rows to other editors:

- **Postgres Changes** on `steps` and `edges` (filtered by `revision_id`) and `processes`. Needs the tables in the
  `supabase_realtime` publication (a migration). Supabase checks every change against each listener's RLS, and any
  writer is covered: a browser, the MCP server acting as the user, SQL. Costs one authorization query per change per
  listener, which the docs say matters above roughly 3,000 subscribers to the same changes; we will have a handful.
  Deletes can't be filtered server-side (without `replica identity full`) and RLS doesn't apply to them, so each
  listener receives every step or edge delete in the project as bare primary keys.
- **Broadcast** from the saving browser after each save. No migration and cheaper per message, but a change made
  anywhere else (MCP, SQL, a tab that closes before sending) never arrives, and the channel's authorization, not the
  table's RLS, decides who sees the data. Broadcast-from-database triggers fix the first point but add triggers on
  hot tables and `realtime.messages` policies that mirror every table policy.

## Decision

- **Data: Postgres Changes.** Migration `20261007000000_realtime.sql` adds `steps`, `edges` and `processes` to the
  publication (guarded, so plain Postgres is untouched). The editor listens on a channel per revision:
  inserts and updates filtered by `revision_id`, deletes unfiltered and filtered in the client by the `(revision_id, id)`
  key they carry, and updates to its `processes` row (a draft opened, published or discarded changes
  `draft_revision_id` / `live_revision_id`). Replica identity stays default.
- **People: Presence and Broadcast** on a private channel `process:<id>` (Realtime Authorization). Policies on
  `realtime.messages` let anyone who can read the workspace join and track presence, and editors broadcast. Each tab
  tracks `{userId, name, email, view: live|draft, since}` and re-tracks on every (re)join. After each save a tab
  broadcasts a small note ("Ana saved `work_hours` = 4 on step X"); others use it only to put a name to a change they
  receive from the database. A change with no note (MCP, a lost message) is "Someone else".
- **Catch-up.** When the revision feed (re)joins, or the process row changes, the page asks the database which
  revisions are live and draft and reloads the edited revision's rows (from the browser, as the user), then merges
  them. So missed messages, a draft someone else opened (edits now go into it), published (it becomes live, history is
  cleared as after our own publish) or discarded (back to live) are all handled the same way.
- **Merging** (`lib/realtime/merge.ts`, framework-free, unit tested) never touches the undo history. Changes arrive in
  commit order and our own saves come back too, so each queued save of ours expects an echo per field: the echo is
  consumed, any other value for that field before the echo is older than our save and skipped (shown after all if our
  save fails), and fields with no echo pending take the stored value, which is also the base the next compare-and-set
  checks. Fields in conflict update "theirs", or drop the conflict when the stored value now matches ours.
  Provenance entries (`provenance.<column>`) merge like any field, so a value arrives with its provenance.
- **In-progress edits.** Inputs keep what the user is typing when a remote change arrives. On commit, if the stored
  value is no longer the one editing started from, the editor raises a keep-mine / keep-theirs conflict instead of
  saving over it; "keep mine" re-runs the edit on top of theirs, as an ordinary undoable edit.
- **Undo.** Remote changes are not undoable locally. Undo applies the inverse of *our* edit as a compare-and-set save
  whose base is our value; if someone has since changed that field, the save is a conflict ("Tom changed this to 7h;
  keep yours or theirs?"), never an overwrite. Undoing a field of a row someone deleted reports that the item is gone.
- The Realtime wiring is a port (`lib/realtime/transport.ts`) with two thin adapters: Supabase, and memory. `/demo`
  uses the memory one with a simulated colleague, Tom, who saves through the same in-memory database, can edit the
  selected step (optionally in 5 seconds, to catch you mid-typing) and can beat your next save to show a conflict.

## Consequences

- MCP edits appear live with no extra work; they are unnamed until the MCP server also sends notes.
- Every tab holds one websocket and two channels. Usage estimate against the Pro plan is in `docs/supabase-notes.md`:
  well inside the included 5M messages and 500 peak connections for an agency.
- Deletes of any step or edge in the project reach every open editor as primary keys (ids only). Tolerable at our
  volume; if it isn't, switch to Broadcast-from-database for deletes.
- If the project is set to allow only private channels, the revision feed (a public channel carrying only
  RLS-checked Postgres Changes) needs its own `realtime.messages` policy first.
- Realtime can't run locally or in CI: the merge core, the sync, and the Supabase adapter (against a fake client) are
  unit tested; the migration is tested against a stand-in for the publication and `realtime.messages`.
