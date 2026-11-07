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
