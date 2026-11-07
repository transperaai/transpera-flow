# Q17: the company map drives the simulation (Austin, 7 Nov: D51)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q17-company-run`, from `claude/relaxed-babbage-51ysen`.
Migration range `20270134000000`–`20270134009999`, if needed. Engine changes follow `docs/engine-versioning.md`.

## The decision (record as D51 in `docs/plans/client-requirements.md`; amend D50)

- **The company map drives the run.** The processes on a company map version are what's simulated, and its hand-off
  lines route work between them. A company map version, live, draft or earlier, is then a real scene: adding a separate
  onboarding process, dropping one, rewiring a hand-off.
- **There is no "One process" scope.** The Sandbox simulates the whole company only (it amends D50). Nothing for it is
  built; make sure no partial UI or URL param for it remains.

## Today (read `packages/db/src/model.ts` `toEngineModel`)

- The run is built from the workspace's sales pipeline process, the processes it holds (`heldProcesses`, child
  processes in subprocess steps), and every servicing process linked to a service (`engineServicing`).
- The company map (`process.is_company`, its steps are "holders" of whole processes, its edges are hand-off lines) is a
  picture only; `toEngineModel` refuses it.
- Q16's Sandbox select lists company map revisions (`listCompanyRevisions`, `loadCompanyPartRevision`), but they change
  only the picture.

## Phase 1: design note first, then STOP

Write `docs/adr/0023-company-map-drives-the-run.md` (short). Commit it. **Stop and report**, with a summary in your final
message; the orchestrator will review and reply before you build. The note must answer:

1. **Which processes run.** Exactly those held by the chosen company map revision's cards.
   - What happens to a servicing process linked to a tier service but not on the map: excluded, with a warning?
   - What about a pipeline process not on the map, or a map with no pipeline?
2. **What a hand-off line means in the engine.** Use the existing `EngineEnd.handoff` and pipeline-to-servicing wiring
   where they fit. For example, a line from the pipeline's won end to an onboarding process starts that process for
   each won client. Say what lines the engine can't honour, and how the app warns about them.
3. **Equality with today.** For a workspace whose live company map holds every process today's run uses, wired as today,
   the model must be **deep-equal** to today's `toEngineModel` output: goldens byte-identical, `ENGINE_VERSION`
   unchanged unless the engine itself changes.
   - State how that's proven: the snapshot tests over the Northbeam, Larkspur and example seeds.
   - State what happens to a workspace whose live map is missing a process today's run includes. Recommended: the live
     company map run keeps today's behaviour until someone publishes a company map version, so nothing existing moves.
4. **Process versions on top.** Q16's per-process version swaps (solutions from a month) still apply to processes on the
   map.
5. **Where it's used.**
   - The Sandbox's "Company map" select becomes real.
   - Capacity and the Overview keep using the live company map, so they read the same as the Sandbox's default.
   - The draft is runnable in the Sandbox, so an unpublished company map can be tested.
6. **The engine.** Does it need a change, such as a process started by a hand-off from another process's end, beyond
   what it supports today? If so, describe it as an optional field (unset means no change), with its golden.

## Phase 2: build (only after the orchestrator replies)

Implement the note.
- A single entry, e.g. `companyEngineModel(companyRevisionBundle, processBundles, options)`, used by the Sandbox, with
  today's path calling it with the live map.
- Validation messages, in plain words, for lines the engine can't honour and processes missing from the map.
- Update the Sandbox select's note (remove "only changes the picture").
- Tests:
  - deep-equality with today's model on every seed;
  - a revision that drops a process;
  - one that adds a hand-off;
  - the draft run.

## Done when

- `pnpm lint && pnpm typecheck && pnpm test` and the web build pass.
- Goldens are unchanged unless the note says why and `golden:approve --bump` records it.

## Phase 2 go-ahead (orchestrator, 7 Nov)

The design note `docs/adr/0023-company-map-drives-the-run.md` is **approved as written**. Build it; where this section and
the note differ, this section wins. Start a fresh `claude/cap-q17-company-run` from `claude/relaxed-babbage-51ysen` (the
note is already on it). Commit after each numbered item.

1. **Decisions.** Write D51 in `docs/plans/client-requirements.md` (the two bullets above, pointing at ADR 0023) and amend
   D50: no "One process" scope. Set ADR 0023's status to `accepted`, and in 0014 add a line that 0023 amends it.
2. **Migration `20270134000000_map_drives_run.sql`.**
   - `processes.map_drives_run boolean not null default true`, meaningful on company map rows only.
   - Backfill `false` for each company map whose workspace has any company map revision with `published_by` not null.
   - A trigger on `process_revisions`: when a company map revision becomes `published` with `published_by` not null (a
     person's publish, a person's restore included), set its process's `map_drives_run = true`. System-made versions
     (`published_by` null) leave it. Never set it back to `false`.
   - Database tests: the backfill on both kinds of workspace, a person's publish flips it, a system-made version doesn't.
   - Run `gen:types` and commit the output.
3. **`companyBundle` and `companyEngineModel`** in `packages/db/src` (next to `model.ts`; a new file is fine), exactly as
   note sections 1–3: sales pipeline choice, `otherProcesses` cut and order, the optional `handoffs` list that
   `toEngineModel` reads, forks follow the first line by process order, shares and conditions ignored, loops cut at the
   closing line, lost ends in a handed-to process mapped as `done`, handed-to steps counted as after-sale in
   `resolveAll`. Every note in sections 1–2 is a returned value (`{ kind, message }`), worded as the note words it.
4. **Equality proof**, as note section 3: the snapshot test over Northbeam and Larkspur and every variant through
   `companyEngineModel` with `defaultCompanyPart`, against the existing snapshot entries (the snapshot file must not
   change), and a database test for `capacity:example` and the seeded workspaces through the loader.
5. **Engine: "Win new clients" through a hand-off** (note section 6). When the pipeline has no after-sale step and the won
   sink's end has a `handoff`, the injected client enters there. Pinned in `packages/engine/test/won-clients.test.ts`.
   Run the goldens unapproved: if none moves, `ENGINE_VERSION` stays. If any moves, stop and report before approving.
6. **The loader seam** (note section 5): when `map_drives_run`, the default bundle (no process id) is built through
   `companyBundle` with the live map, for Capacity, the Overview, issues, solutions' verdicts, Set up, share-link
   snapshots and MCP. A process page is unchanged. Test: for a map-driven workspace with a card taken off, Capacity's and
   the Sandbox's default models are deep-equal.
7. **The Sandbox.** The "Company map" select runs the chosen revision (live default, the open draft, earlier versions);
   the map revision goes into the changed path and its run key. Process-version swaps list processes from the company
   bundle and skip ones not on the map with the reworded problem (note section 4). The note under the select drops "only
   changes the picture" and lists the run's notes, the fork note included, in plain words; while `map_drives_run` is
   false on the live map, show the "The run still includes it until a company map version is published" note. Keep
   page changes to the Sandbox's map card and its notes (Chat B owns the rest of the page).
8. **No "One process" scope**: confirm no `?scope=` / `?process=` handling or UI for it remains in the Sandbox; remove any.
9. **Help**: the (i) on the Sandbox's Company map select says the map decides what is simulated once a person publishes
   a version, and that cycle time stops at the win.
10. **Tests from the brief**: deep-equality on every seed (item 4), a revision that drops a process, one that adds a
    pipeline-to-pipeline hand-off (the handed-to steps run and count as after-sale), a fork, a loop, and the draft run.

Report as the shared rules say, with the golden result stated plainly.
