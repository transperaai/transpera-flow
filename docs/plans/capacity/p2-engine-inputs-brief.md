# P2: the engine reads the capacity inputs

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p2-engine`, from `claude/relaxed-babbage-51ysen`.
Sources:
- `docs/adr/0022-capacity-inputs.md`, which is the contract: field names, meanings, and the per-process mapping;
- `packages/engine/src/capacity-inputs.ts` and `capacity-check.ts`, which hold the definitions you must use, not
  re-derive;
- `packages/engine/src/fixtures/capacity.ts`;
- `docs/engine-versioning.md`;
- the P2 row of `docs/plans/client-build-handover.md`.

## The short version

`simulate` starts reading the P2 half of the new fields. With none of them set, every existing golden stays
byte-identical. `capacityModel()` becomes a golden, and `ENGINE_VERSION` goes 1.14.0 → **1.15.0** through
`golden:approve --bump`. The step work split, tier multipliers and changes are **P3's**, not yours. Leave
`EngineStep.split`, `tierMultiplier` and `EngineModel.changes` unread.

## What to build (commit after each)

1. **Driver recurrences.** A servicing link with `{ perMonth, driver, per }` makes tasks for each client, named or
   counted, at `tasksPerMonth(recurrence, effectiveDeliverables(...))`.
   - **Non-ad-hoc drivers:** spaced evenly through the month, as `{ every: "month", times }` is today, including
     fractional values. Reuse today's code path, with the per-client rate.
   - **`"adhoc"`:** each client-month, draw Bernoulli(`chance`). If the client asks, draw Poisson(`requests`) tasks
     placed uniformly in the month.
   - Draw both from **new** random streams keyed so no existing stream moves (see `random.ts`).
   - Update `tasksPerWeek` / `recurrenceInterval` callers that would treat a driver as "no tasks", so loads and
     labels are right.
2. **Named and counted together.** `clientMix: "groups-add"` builds group clients **in addition to** `clients`.
   `"groups-replace"` or omitted keeps today's code untouched (`withClientGroups` in `clients.ts`). Client keys must
   stay unique and `groupServiceOf` must still work.
3. **Portfolios and the client's manager.**
   - `EnginePerson.portfolio[serviceId] = n` assigns n of that group's clients to the person. Fill in person order,
     deterministically. The remainder stays unassigned, as today.
   - A named client's `manager` is its manager.
   - A step with `toClientManager: true` queues for the client's manager, whatever their role. With no manager, it
     goes to `role`'s pool, as today.
   - Leave and end dates fall back to the pool, as assignments do today.
   - The manager's busy share counts the work as **theirs** (`PersonResult`), and as their **own** role's work.
4. **Per-client overrides.**
   - `overrides` feed `effectiveDeliverables` (item 1).
   - `adhocHours` scales the drawn hands-on times of the client's ad-hoc process steps, so their mean total is
     `adhocHours`. Scale after the draw.
   - `stepFactor` (a number, or a number per step) multiplies the client's drawn times, also after the draw.
   - `handHoldingHours[role]` adds that many hours a month to the client's assignee in the role (the manager for the
     client-facing role). Use the same mechanism as `fallbackOngoing` load, but on top of the servicing tasks, not
     instead of them.
5. **Team time and ramp.** Effective capacity in a month is capacity × `availableShare(person, month, monthHours)`.
   - The per-person monthly capacity factor in `channels.ts` (`capacity`) is the existing path for this. Compose with
     it rather than adding a second one.
   - Utilisation's denominator must use the reduced hours, so busy share reads as the prototype defines it.
   - `availabilityFloor` keeps its own meaning.
6. **Placing won clients.** `placeNewClients: "least-busy"` assigns each won retainer, per needed role, to the
   available person with the lowest busy share so far who serves the service's `tier` (`EnginePerson.tiers`).
   - Omitted means today's round-robin, unchanged.
   - The won client's manager is the person placed in the step's role for `toClientManager` steps.
7. **Where each person's time goes, by step.** The Capacity page links each item to its step (D32). Add an
   **optional** output, asked for like the monthly series, of mean hands-on hours a month per person per step, plus
   the client count per person per service.
   - Asked for: it costs nothing to the existing outputs.
   - Not asked for: no allocation.
8. **Check before run.** Export `capacityProblems(model)`, which calls `checkCapacityInputs`. `simulate` doesn't throw
   on problems; the web layer shows them (P5). Add the problems to `broken.ts`'s missing-for-simulation list if that
   is the existing place where such lists live; say which you chose.
9. **Goldens.**
   - Add `capacity` (`capacityModel()`, monthly series on, 30 replications, seed 1) to the goldens. Add the item 7
     output to its key outputs.
   - `golden:approve --bump` to 1.15.0, and a `versions.json` entry: "capacity inputs (P2): new golden; no existing
     number moved".
   - **Every existing baseline must be byte-identical.** If one moves, find out why before you approve anything, and
     report it.
   - Update `docs/engine-versioning.md`'s table.
   - Add `capacityModel()` to `browser-determinism.test.ts` if that test lists the goldens explicitly.

## Tests (hand-checked where possible)

- Ad hoc: over many replications, the mean tasks per client-month matches `chance × requests` within sampling error.
- A per-1,000-words process at 4,000 words makes 4 tasks a month.
- A per-channel process makes 4 tasks a month for a client with 4 channels.
- A named client's override wins over its tier's value.
- `groups-add` holds named and counted clients together; `groups-replace` matches today exactly.
- Portfolio counts land on the right person, and `toClientManager` work shows in that person's busy share.
- Ramp `[0.4, 0.6, 0.8]` and team time lower available hours in the right months.
- `least-busy` placement never picks someone who doesn't serve the tier.
- Performance: `capacityModel()` runs within the time targets the performance tests use for Northbeam seeded. If it
  can't, report the time.

## Out of scope

- The work split, tier multipliers and changes (P3).
- `toEngineModel` and anything in `packages/db` or `apps/web`. The database mapping is a separate package once P1 is
  merged.

## Done when

- `pnpm --filter @transpera-flow/engine test`, `pnpm lint` and `pnpm typecheck` pass.
- The goldens pass with only the new `capacity` baseline added.
- The report lists any place where the behaviour had to differ from ADR 0022, and the run time of `capacityModel()`.
