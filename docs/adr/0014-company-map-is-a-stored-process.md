# 14. The company map is a stored process; a placed process is held by a link, never edited

Date: 2 Oct 2026 · Status: accepted · Issue: #163 (B11, slices 1 and 2 of 2) · Builds on PRD D26 and D39, migration 20261108000000 (nested processes) · Relaxed later by B12 (#164)

## Context

PRD §3 and D26 say "the company map is the root process", but until now it was only a way of drawing: the Overview
computed it on the fly (`apps/web/src/lib/overview/company-map.ts`) with a fake id, computed positions and made-up
lines from every pipeline to every servicing process. Nothing stored it, so it could not be edited, versioned or
restored. Austin (2 Oct): you can make individual processes, but the company map is where it makes sense, because you can
see the whole picture; it needs editing, history and versions.

## Decision

- **One company process per workspace**, marked `processes.is_company` (a boolean, not a new `kind`: it is none of
  pipeline or servicing). A partial unique index allows one per workspace; a check keeps it parent-less; a trigger stops
  anyone signed in creating one, flipping the marker or deleting it (deleting the workspace still removes it).
- **Its live revision holds the map.** One `subprocess` holder step per process on the map, `child_process_id` pointing at
  the placed process, `x` and `y` its position; the edges between holders are **handoff lines** (a label on an edge is the
  line's label). Groups on the map are ordinary groups. All of it is layout: the engine never sees the company process
  (`listProcesses` leaves it out of every list of processes, and `toEngineModel` refuses a bundle of it), so golden
  outputs do not move. Handoffs are **visual only** for now (D39).
- **Top-level linkage: the least invasive option.** A top-level process keeps `parent_process_id = null`. "On the
  company map" means "held by a holder step in the company process's revision". Every existing "top-level = no parent"
  check (`company-map.ts`, `model.ts`, `queries.ts`, the step inspector, the Processes list) stays true. The alternative,
  setting `parent_process_id` to the company process, would have rewritten all of them.
- **Placing a process on a map is a link held only by the map.** The placed process row is never written: no parent, no
  flag, no `updated_at` change. The link lives in the target's revision (its draft, then live once published), so edits to
  the placed process show through the link, and taking it off the map (deleting the holder) leaves it untouched. A
  trigger on `processes` keeps the map's *own* rows in step (a new top-level process gets a holder at the bottom of its
  column and a handoff line to each holder of the other kind; a deleted or nested one loses its holder; a rename renames
  the holder). It writes only the company map's steps and edges.
- **The holder rule is one function: `private.holder_allows(owner, child)`.** `check_step_nesting` calls it. Today it
  allows (a) a child process held by its parent, and (b) a parent-less, non-company process held by a company process. A
  process is therefore held **once** in the whole tree: a process with a parent is refused on the company map, and a
  parent-less one is refused inside an ordinary process (no double counting). **B12 (#164) generalises this** (any process
  may hold others, with a map being just a process whose holders are placed by link): change `holder_allows`, and add the
  "at most once in the published tree" check where it is relaxed. Nothing else needs to move.
- **Backfill and seeds.** The migration gives every existing workspace a company process with a published revision 1
  whose holders reproduce today's computed layout (`packages/db/src/company-map.ts`, `defaultCompanyPart`, is the same
  algorithm in TypeScript; a test checks the SQL and TypeScript agree on Northbeam and Larkspur) and today's
  pipeline-to-servicing lines. A trigger on `workspaces` gives new workspaces one. The seed lays the map out after every
  process is published (`private.relayout_company_map`); the demo (no database) builds it with `defaultCompanyPart`.
- **The Processes list excludes it**, and the Overview is its home: the sidebar and the Processes page already link "Company
  map" to the Overview, which draws it. Slice 2 adds "Edit company map" there (the editor on the company process with
  drafts, publish, history and handoff lines).

## Consequences

- The Overview reads stored positions and lines; opening a card pushes its neighbours aside at draw time (positions on
  the map are for closed cards, as before).
- Anything that lists processes must go through `listProcesses` (which excludes the company map unless asked) or
  filter `is_company`. MCP `get_workspace_summary` and `get_process` show the map; every other tool refuses it.
- **Slice 2 (B11 2/2, migration 20261127500000) lifts the lock for editors.** `open_draft`, saving, `publish_process`, `discard_draft` and
  `restore_version` work on the company map for anyone who may edit the workspace; the guards still refuse renaming it, changing its
  kind or parent, deleting it, making it a process's parent, a null or foreign live pointer, and `duplicate_version` (a copy of a map is
  not a process). The editor is the existing one on the company process (`/w/[slug]/p/<companyId>/edit`, reached from "Edit company map"
  on the Overview): cards are moved, joined by **handoff lines** (a line with an optional label; it has a full share and no tag, and the
  simulation never reads it) and put in groups; there is nothing to simulate, no blocks and no first principles. The Overview draws the
  labels. The map's History lists versions with what changed and no numbers; restore is offered, duplicate is not.
- **Removing a card is not offered.** Adding and removing processes from a map comes with the process library (B12, #164). Until then a
  card cannot be deleted: the Editor refuses it (and says why), and a trigger on `steps` refuses it for anyone signed in, so the API
  cannot do what the screen does not. (Not for the system, `restore_version`, or the cascades of deleting a draft, a process or a workspace.)

## The sync rule (the three slice 1 blockers, decided)

Slice 1 left the map in step with the processes by reconciling it: any top-level process with no holder got one, any subprocess step with
no child was deleted, and it edited the live revision, and a draft, in place. That cannot stand once people edit the map: it would delete
what they draw, put back what they took out, and rewrite published versions.

- **Events, not reconciliation.** A change to the set or names of top-level processes is an *event*: a process is created, deleted, nested
  under another, taken out of one, renamed, or changed from pipeline to servicing. Sync reacts to each event for **that process only**. It
  never deletes a step except the holder of the process the event is about, never adds a holder except for it, and never looks at what
  else is missing. Subprocess or group steps a person drew are left alone; a holder a person took out of a draft is not put back by an
  unrelated event. (Blocker 1.)
- **Published versions are never edited.** Each event is applied to the live revision as a **new published version made by the system**:
  a copy of live (same step and edge ids), the old live one superseded, `published_by` null, number one above every version, and an audit
  entry `publish` by `system` whose diff carries a `note` ("Added Sales", "Renamed Sales to Sales v2", "Removed Sales from the map: it
  now sits inside another process", "Sales is now a servicing process", "Removed Sales"). History reads the note, so it says what happened
  and who (the system) instead of showing a version that silently changed. An event live already reflects makes no version. (Blocker 3.)
- **An open draft gets the same change**, so it keeps agreeing with live where the person has not changed it: a holder is added only if
  the draft has none for that process, a rename only touches a holder still called what the process was called, and a move to the other
  column only touches a holder still where it was. What the person moved, renamed or drew is theirs. Publishing the draft then carries
  its own number (above the system versions) and its changes with it.
- **A kind change moves the card** to the bottom of the other column and keeps every line: handoff lines belong to the people who draw
  them, so sync no longer rebuilds them. A new process still gets default lines to each card of the other kind, as the Overview always drew
  them; those are ordinary lines from then on.
- **Restoring a version of the company map keeps its links.** `restore_version` now uses `private.holder_allows(owner, child)` (the one
  place that says who may hold whom) instead of "child's parent is this process", so a holder keeps its `child_process_id`. A holder whose
  process is gone (its link was set null when the process was deleted) or now sits inside another process is left out with its lines and
  counted (`skipped_holders`); top-level processes the version did not hold are added back at the bottom of their column (`added_holders`),
  so a restore never drops a process off the map; cards take the process's current name. The History dialog says so in plain words.
  (Blocker 2.)
- `private.relayout_company_map` is for the seed and the backfill only: it starts the map over as one version 1 (and removes the log
  entries of the versions it dropped). The app never calls it.
- The sync is applied inside the statement that changes the process (a trigger, security definer, with a lock on the map so two processes
  made together each get their own place and version). A workspace being deleted is skipped.

## Review fixes (same slice)

- **Nothing takes a card off the map**, by any road: a trigger refuses, for anyone signed in, deleting a card, unlinking one (`child_process_id`
  set to null or another process, including through `save_fields`) and deleting a group with a card anywhere inside it (a cascade
  would not reach the guard on the card). The system, `restore_version` and the cascades of deleting a draft, process or workspace are not refused.
- **History is kept.** An editor may only insert a draft, delete a draft, and move a status draft to published or published to superseded (what
  `publish_process`, `restore_version` and `discard_draft` do); the live pointer may only name the published version and the draft pointer a draft.
  Ordinary processes have the same hole from before this work; it is not widened or closed here.
- **An untouched draft stays equal to live.** An event is mirrored into a draft by copying the very rows live got (same ids and places), so the
  draft's diff against live is only what the person did, and restore does not ask "replace your draft?" over nothing.
- **Bulk is one version.** Events of one transaction share one system version (it extends the one this transaction already made; nobody outside
  it can see that version, so this is not editing history). 60 processes made together are one version, "Added A; Added B; …" (cut at 300
  characters), not 60 copies of the map.
- **A live rename or move overrides what a person did to that card in live.** Only a system version can; the draft keeps the person's. Accepted:
  the card is named after its process and sits in its column until the person moves it again.
- **Restore keeps placeholders.** Deleting a process records its cards (`map_cards_removed` in the audit log, by step id, the same in every
  version); restore skips those and keeps a subprocess step nobody linked.
- **Races.** `check_step_nesting` takes the map's row (`for no key update`, as does the sync) when it checks a card of the map, so a card added
  while another transaction nests its process is checked after that transaction, not before.

## Alternatives not taken

- *Edit live in place and keep the history honest some other way* (an `edited_at`, or a log of changes): published versions are meant to
  be immutable (`edit_drafts_only`); a version that changes after publishing breaks restore, diffs and the audit trail.
- *Only mirror into a draft, and publish it later*: nobody would publish "Added Sales" by hand; the Overview would not show a new process
  until someone did.
- *Reconcile on every event* (as slice 1 did): rejected above.

