# 14. The company map is a stored process; a placed process is held by a link, never edited

Date: 2 Oct 2026 · Status: accepted · Issue: #163 (B11, slices 1 and 2 of 2) · Builds on PRD D26 and D39, migration 20261108000000 (nested processes) · Extended by B12 (#164, the process library; see the last two sections)

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
- **Removing a card was not offered, until the process library (B12, #164, last section).** Slice 2 refused it in the Editor and, with a
  trigger on `steps`, for anyone signed in, so the API could not do what the screen did not. B12 lifts that for a draft only.

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

## B12: the process library (#164)

Austin (5 Oct 2026): in the company map editor a "Process library" panel lists the workspace's processes; placing one puts a **linked**
card on the map and **never edits or copies the process**; a process is on the map at most once; several can be picked and added at once;
removing a card only unlinks it.

- **Placing is the insert of a holder step into the map's draft**, nothing else. `private.holder_allows` (a parent-less, non-company
  process of the same workspace, held by a company map), the composite foreign key on `child_process_id` (same workspace) and the unique
  index `steps_one_holder_per_child` (once per version) already say who may be placed, so placing needed no migration and the placed
  process's row, versions, steps and edges are not written (tested byte for byte, in the database, over PostgREST and in the browser).
  "At most once" is per map, and a process has one map (the workspace's company map), so it is once in the tree. A process that is held
  inside another (it has a parent) is shown greyed with where it sits, and the database refuses it too.
- **Removing is deleting the card from a draft**, which is the migration 20261129500000: `private.company_holder_guard` now lets an
  editor delete a card of the company map, or a group holding cards, **in a draft version**. Everything else the slice 2 guard refused is
  still refused: deleting a card of a published version, and unlinking by update (`child_process_id` set to null or another process,
  also through `save_fields`). Publishing the draft is what takes the process off the live map ("Not on the map" in the library); nothing
  writes to the process. Undo and redo cover both, and discarding the draft drops pending placements and removals.
- **Where cards land.** Each goes to the centre of what the person is looking at, or the nearest free place, as new steps do (QA wave 1,
  `nearestFreeSpot`); the next takes the next free place, so several added at once do not cover each other. A card the draft removed is
  still drawn where it was live (a struck-through ghost with Restore), and new cards keep clear of it too.
- **Restore keeps its rule.** `restore_version` still adds back to a restored map any top-level process the version did not hold, "so a
  restore never drops a process off the map" (slice 2). With the library a process can be off the map on purpose, so a restore puts it
  back at the bottom of its column (and says how many it added). This is left as it is: a deliberate removal is one more edit the person
  can repeat, and the alternative (telling "made since" from "taken off") needs a record that the map does not keep. Open question for
  Austin.
- **Not built in part 1:** templates and "New process", "+ Process" in ordinary editors, and the general relaxation of
  `holder_allows`. Part 2 (below) builds them.

## B12 part 2: the process library in every editor, and where "inside" comes from (#164)

Austin (2 Oct 2026): "when we are in the company editor (and any process editor) we can choose processes from a library". A placed
process is a **link** and placing **never edits it**; a process appears **at most once in the published tree**, across every map.

- **Any process may hold any other by a link.** `private.holder_allows` (migration 20261130000000) now allows any process of the same
  workspace other than the holder itself and other than a company map. It no longer reads `parent_process_id`. So a DRAFT may link a
  process that sits somewhere else; the rules are checked where they matter, on **publish**.
- **The company map is the default home, and gives way** (design change adopted in review of #188; **for Austin to confirm**). A
  process on the company map can be added from any editor's library ("On the company map — moves here when you publish"). When an
  ordinary process publishes a link to it, its card comes off the company map in the same transaction, as an ordinary system version
  of the map (the remove path the map's sync already has; an open draft of the map loses the card too). The placed process is still
  never written. When nothing holds it any more (the holder publishes without the link, or is deleted), it gets its card back on
  the company map, as a system version. Taking a card off the company map itself is a person's choice and leaves the process off
  ("Not on any map"). Two consequences to know: a child MCP's import CREATED inside another process (its `parent_process_id` set)
  does not come back to the map when its holder drops the link (the map's sync follows that column, which still names the parent);
  and when the map gives way, removing the card from the map's open draft also drops the handoff lines drawn to and from it there.
  Restoring an ordinary process keeps a link whose process now sits only on the company map (publishing it moves the process again);
  only a live ORDINARY holder elsewhere unlinks it. A live version must be a version of the process itself: the publish check
  ignores anything else (the version guard refuses it), so its message can't name another workspace's processes.
- **Publishing enforces "once" and "no loops".** A trigger on `processes` (`check_live_placements`, before `live_revision_id` changes,
  for every caller and road: publish, restore, the company map's system versions), for each process the new live version holds that
  the old one did not: refuses it holding, at any depth through live versions, the process being published ("... would sit inside
  itself"); takes it off the company map if the map holds it; and refuses it if another ORDINARY process holds it live ("Sales is
  already inside Onboarding. ..."). Links the old live version already had are not re-checked. Locks: the company map's row, then a
  per-workspace advisory lock (the map's own sync takes them in the same order, so they can't deadlock), so two drafts placing the
  same process can't both pass: the second waits and is refused. `give_back_placements` (after the pointer moves) and
  `give_back_on_delete` give cards back. A partial index on `steps(child_process_id)` serves "who holds this process".
- **Decision: "inside" is derived from live links; `parent_process_id` is legacy.** Where a process sits is the process whose LIVE
  version holds it (`public.process_placements`, a security-invoker view over `steps` and `processes`). `listProcesses` derives
  `parent_process_id` from it (the holder, or null when nothing holds it or the holder is the company map), so the app, the Processes
  list, the simulation (`model.ts` simulates through the holder step's link and no longer compares it with the column) and MCP's
  `get_process` and `list_processes` all mean the same thing. The column stays (migrations are additive) and nothing in the app writes
  it. We chose deriving over "keep the column in sync on publish" because it needs no data migration, cannot drift, and a draft's
  pending links never show as "inside" before they are published.
  - **MCP `import_process` follows the library's rule.** Linking an existing process (`child_process`) only writes the holder step:
    publishing moves it, and a company-map process gives way, as in the web app; one that sits inside an ordinary process is refused,
    naming where. It still writes the column for a process it CREATES inside another (that keeps the new process off the company
    map until the holder is published). Its checks read where a process sits as the live holder, or else that column. Until the
    holder is published, `get_process` says the child sits nowhere yet (deliberate; it used to read the column).
  - Processes whose column names a parent whose live version does not hold them (an import whose parent was never published) now read
    as top level / "Not on any map". Nothing is changed for them; publishing the parent puts them inside it. Migration preflight 7
    lists them.
- **The library everywhere.** "+ Process" in every editor's palette opens the same panel as on the company map: search; "Not on any
  map" first; then "On this map"; then one group per place ("On the company map", "On Onboarding"), greyed with a plain reason; then
  any process that holds this one ("Holds this process", greyed, since placing it would be a loop); templates; and "New process".
  Several can be ticked and added at once; each lands in view on a free spot. Removing deletes the holder step only (undoable);
  discarding the draft drops pending links.
- **New processes from the library sit nowhere.** Made the ordinary way, a new top-level process gets a card on the company map at once
  (the sync rule) and would then sit in two places. `public.create_library_process` (security invoker; editors only) inserts it as the
  caller with a transaction-local note that the map's sync reads to leave that one process alone; templates go through the same path
  (`createProcessFromTemplate`, the shared body of MCP's `create_from_template`). Nothing is published.
- **Plain messages in the editor.** A draft that links a process with no published version says "Publish 'X' first"; a link back to
  a process this one sits inside says it would put that process inside itself; a linked process with no next step says so (the
  engine's message calls it a group; the engine is unchanged).
- **Restore.** `restore_version` keeps a holder's link only while no OTHER process holds that process live; otherwise it unlinks it
  (ordinary process) or skips it (company map), as before. A restored company map no longer adds back a process another process
  links, live or in its draft (so one the library made and placed in a draft stays there).
- **Simulation is unchanged:** a held process is simulated through its holder step, so nested equals flattened, and seeded goldens are
  unchanged (tested).

## B19: archiving a process (#182)

Austin (5 Oct 2026): everything can be added by hand, including taking a process out of use. Processes are never deleted, so
"archive" is a soft delete (migration 20261204000000).

- **What it is.** `processes.archived_at` (and `archived_by`), set by an ordinary update as an editor (RLS: owners, editors and agency
  admins; viewers and anon change nothing). A trigger stamps `now()` and the caller; archiving again keeps the first stamp; restoring
  clears both; `archived_by` is never taken from the caller, and a new process never starts archived. `listProcesses` leaves archived processes out unless asked (`includeArchived`), so every list, the library, the
  Overview, the simulation and MCP's `list_processes` skip them. Their versions, history, issues and sources are kept, and the
  process still opens by its id (Processes, Archived, links to it).
- **The company map follows, as a system version.** Archiving takes the process's card off the company map ("Archived Sales"; an
  open draft of the map loses the card too); restoring puts it back at the bottom of its column ("Restored Sales"), through the map's
  existing sync (`private.company_map_apply`). A published version is never edited.
- **Decision: a process inside another ordinary process, or holding others, is refused, with a plain message naming them.** "Kickoff
  sits inside Onboarding. Take it out of Onboarding and publish, then archive it." / "Onboarding holds Kickoff. Take Kickoff out of
  Onboarding and publish, then archive it." The alternatives were to unlink it from its holder automatically (a system version of an
  ordinary process, which only the company map has today, and a silent change to someone's map) or to let the holder keep a link to
  an archived process (which the simulation would then have to skip, so the holder's numbers would change with no change to its
  map). Refusing keeps "an archived process is never part of the live tree" true without writing anyone's process, and the fix is
  one ordinary edit. The Processes page says so before asking the database. The company map itself can't be archived. For the same
  reason (the simulation must not change behind anyone's back) a pipeline that is a service's way in, or client work a service
  generates, is refused too, naming the services.
- **Archived means read only.** While archived, the database refuses opening a draft (even one already open), restoring a version,
  publishing (so a draft opened before the archive can't move what it links), writing steps or edges into a draft left open
  (discarding it is allowed), renaming it or changing its kind or place, a service starting to use it, and an import moving it; the app opens the process read only with a
  banner ("Archived on 3 Oct", Restore for editors) and no Edit or History actions.
- **Names.** An archived process gives its name up: names are unique among the processes in use (the app's checks, the library's
  `create_library_process` and the import's `import_new_process`). Restoring is refused while another process has the name (the
  import's rule, ignoring case and punctuation, under its lock); since an archived process can't be renamed, the other one is.
- **It can't come back in by another road.** `holder_allows` refuses placing an archived process in a draft ("Sales is archived:
  restore it from Processes (Archived) before placing it"); a draft that linked it before it was archived can't be published
  (`refuse_archived_placements`, on every road to a new live version); `restore_version` skips its card on a restored company map
  and unlinks it in a restored ordinary process; `company_add_holder` never gives it a card. Locks: archiving takes the same locks as
  a publish's placement check (the map's row, then the workspace's placement lock), so a publish placing it and the archive can't
  both pass.
- **Changing a process's kind** needs no migration: the map's sync already moves the card between the pipeline and client work
  columns as a system version. The app warns what changes for the simulation before saving, and refuses client work to pipeline
  while services still generate it (the database refuses it too), naming the services.
