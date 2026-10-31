# P3: step base values and changes in the engine

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p3-changes`, from `claude/relaxed-babbage-51ysen`.
Sources:
- `docs/adr/0022-capacity-inputs.md`;
- `packages/engine/src/capacity-inputs.ts` (`stepParts`, `stepTimeFactor` and `changeRamp` are the definitions: use
  them, don't re-derive);
- requirements section 7 and D6–D8;
- the P3 row of `docs/plans/client-build-handover.md`;
- the P2 work already merged (`clients.ts`, `availability.ts`, the `personTime` output);
- `docs/engine-versioning.md`.

## The short version

`simulate` starts reading `EngineStep.split`, `EngineStep.tierMultiplier` and `EngineModel.changes`.
- A step's drawn hands-on time is multiplied, **after the draw**, by
  `stepTimeFactor(step, tierOfTheClient, changes, monthIndex, clientStepFactor)`.
- With none of these fields set, the factor is exactly 1 and every existing golden is byte-identical.
- `ENGINE_VERSION` 1.15.0 → **1.16.0**.
- The `capacity` golden moves, because `capacityModel()` has splits, tier multipliers and changes. Approve it with
  the reason stated.

## What to build (commit after each)

1. **Tier multiplier and client factor on every draw.**
   - Where P2 applies the client's `stepFactor` and `adhocHours`, apply `stepTimeFactor` instead. It includes the
     client factor, so don't apply that twice.
   - `adhocHours` replaces the base time **before** the split, as ADR note 7 says.
   - The tier is the client's service's `tier`. Pipeline work and work with no client uses no tier (multiplier 1) and
     no client factor.
   - Cache the factor per (step, tier, month, client factor). Most models have no new fields, so this path must cost
     about nothing when nothing is set; check with the perf tests.
2. **Changes over time.**
   - A change acts from its `startMonth` (1-based) and ramps over `rampMonths`, read with `changeRamp` by the month
     the hands-on time **starts** in.
   - `tiers` limits a change to clients of those tiers.
   - Months are the run's months, as P2's team time uses.
3. **What the changes free.** Add to the `personTime` output (and to the monthly series when it's asked for):
   - hands-on hours by part (automatable / augmentable / manual) per step, actual (after changes);
   - the same hours **before** changes (the baseline at the same draw), so "hours freed" is an exact difference;
   - hours freed per change. When two changes act on the same part, split the saving in the order the changes apply
     and document it.

   This serves A5 (hours freed per person) and A7 (which change frees the most).
4. **Rework, waits and routing stay as they are.** Changes only act on hands-on time. "Also changes rework or
   waiting" (section 7, optional) is out of scope: note it in the ADR as later.
5. **Check.** `checkCapacityInputs` already names bad splits and changes. Make sure every problem it names on a
   change is one the engine would otherwise mis-simulate, and add a test that a model with a bad split still runs
   (treated as all manual).
6. **Goldens.**
   - Run unapproved first. Only `capacity` may differ.
   - Approve with `golden:approve --bump "step splits, tier multipliers and changes (P3)"`.
   - Add the new outputs to the capacity golden's key outputs.
   - Update `docs/engine-versioning.md` and ADR 0022 (an "Engine 1.16.0" note: what P3 reads, the hours-freed
     definition, the ordering rule).

## Tests (hand-checked)

- **Section 7's example**, through `simulate`, with constant distributions so the draw is exact:
  - pacing 55 minutes, 70/20/10;
  - automation removes 90% with a 3-minute residual;
  - at adoption 1 the step takes 23.35 minutes; at 0.8, 29.68.
  - A 70-minute baseline moves the saving.
- A change starting in month 3 with a 2-month ramp acts at 0 / ⅓ / ⅔ / 1 in months 2–5.
- A tier-limited change leaves other tiers' clients alone.
- A tier multiplier of 1.5 on Tier 1 only makes a Tier 1 client's task take 1.5×.
- Hours freed per person add up to the total freed.
- Perf: the perf-tagged tests pass; report `capacityModel()`'s run time before and after.

## Out of scope

- The database, the editor and the Sandbox UI (P4, P7).
- `toEngineModel` (the mapping package).
- Rework and wait effects of changes.

## Done when

- `pnpm --filter @transpera-flow/engine test`, `lint` and `typecheck` pass.
- Goldens pass, with only `capacity` re-baselined.
- The report lists the hours-freed ordering rule and any deviation from `capacity-inputs.ts`.
