# P2b: the database feeds the capacity inputs to the engine

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p2b-mapping`, from `claude/relaxed-babbage-51ysen`.
Migration versions `20270121000000`–`20270121009999`, if you need one; you shouldn't.

Sources:
- `docs/adr/0022-capacity-inputs.md`, for the engine fields;
- P1's report in [transperaai/transpera-flow#256](https://github.com/transperaai/transpera-flow/pull/256), for the
  database columns and their mapping;
- `packages/db/src/capacity-setup.ts`;
- `packages/db/src/model.ts` (`toEngineModel`);
- `packages/engine/src/fixtures/capacity.ts`.

## The short version

`toEngineModel` maps P1's Set up data to the engine fields that engine 1.16.0 reads.
- The new mapping applies **only to a workspace that has at least one tier service** (a service with a department
  and a tier). Every other workspace, and every fixture and seed, gives a deep-equal model to today's, proven by
  P1's `engine-model-snapshot.test.ts`.
- P4 is building in parallel. It maps **step** fields (split, tier multiplier, `toClientManager`, sources) and driver
  recurrences. Don't touch those.

## 1. Mapping (in a tier workspace)

| Database | Engine |
|---|---|
| `services.department_id`, `tier_id` | `EngineService.department` (department id) and `tier` (`tiers.key`) |
| `services` deliverables and `adhoc_chance`/`adhoc_requests` | `deliverables`, `adhoc`. A null column is left out (missing, not 0). |
| named `clients` overrides | `overrides`: deliverable keys, `adhocChance`, `adhocRequests`, `adhocHours`, `stepFactor` |
| `clients.hand_holding_hours` | `handHoldingHours[role]`, where role is the client's manager's client-facing role |
| the client's assignment to a client-facing role | `EngineClient.manager` (that person) |
| counted clients | `clientMix: "groups-add"`. Each tier service's group count = `client_groups.client_count` + the sum of `person_portfolio` for it. |
| `person_portfolio` | `EnginePerson.portfolio[serviceId]` |
| `people.reserved_share` | `reservedShare` (omit when 0) |
| `people.ramp`, else `settings.ramp_default` | `ramp`. **Only for a person whose start date falls inside the run**; everyone else has none, so today's staff aren't ramped. |
| `person_tiers` | `tiers` (keys). No rows means every tier, as P1's screens read it. |
| `roles.unit` | `unit.label` |
| — | `placeNewClients: "least-busy"` |

**Won clients.** New clients from lead flow land in tier services by the services' `mix_share`, as today. Check that a
starter workspace splits wins by the prototype's department × tier mix.

## 2. Least-busy placement uses the full step time (engine)

P3 left `plannedHours` (least-busy placement in `simulate.ts`) using the plain step `work` × the client factor. Make
it use `stepTimeFactor`, so tier multipliers and changes count.
- This moves the `capacity` golden only. Bump with `golden:approve --bump "least-busy placement counts tier
  multipliers and changes"` to 1.17.0.
- Every other baseline must stay byte-identical.

## 3. An example workspace for building and testing (made-up data)

`packages/db/src/fixtures/capacity-example.ts` and a script
`pnpm --filter @transpera-flow/db capacity:example --workspace <slug>`.
- It loads the prototype's `base()` example into an **empty** workspace: departments, tiers and deliverables, roles,
  the 27 people with portfolios and tiers, the 13 named clients with overrides, and "taking both" counts.
- It also loads the servicing processes and steps, as `fixtures/capacity.ts` builds them. Use P4's step columns when
  they're merged. Until then, steps without splits are fine, and add the splits in a follow-up commit when the
  orchestrator says P4 is in.
- Refuse a non-empty workspace.
- This is the data P5 develops and tests the Capacity page against. It is made up, so it can be committed. It is
  **never** loaded into the client's deployment.

## Tests

- **Mapping:** one test per row of the table above.
- **Non-tier workspaces unchanged:** the snapshot test, plus a workspace with a tier service and none of the new
  values set.
- **The example workspace:**
  - maps to a model with no `capacityProblems`;
  - simulates;
  - its people's busy shares are within 15 percentage points of the engine fixture `capacityModel()`. Report the
    differences: they show where the database model and the fixture disagree.
- **Engine:** `plannedHours` with a tier multiplier and a change places a client differently; goldens only
  `capacity`.

## Done when

- `pnpm lint && pnpm typecheck` pass.
- The db and engine suites pass.
- The web suite passes for files touching `model.ts`.
- The report lists any P1 column that couldn't be mapped, and the busy-share comparison.
