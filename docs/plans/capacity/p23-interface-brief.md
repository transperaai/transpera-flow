# P2/P3 interface: the engine inputs for the capacity app

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p23-interface`, from `claude/relaxed-babbage-51ysen`.
Sources:
- the "Definitions the prototype settled" table in `docs/plans/client-build-handover.md`;
- requirements sections 4, 6 and 7, and D5–D8, D13, D17, D26, D27, D32;
- the prototype's calculator: `freqOf`, `parts`, `clientLoad`, `loads` and `availH` in
  `docs/prototypes/client-capacity-app.PROTOTYPE.html` (lines ~235–532).

## What this package is

It is the **agreement** that lets P1 (database and Set up) and P2/P3 (engine behaviour) be built apart. It delivers
four things:
1. the new optional fields on `EngineModel` and its parts;
2. the pure functions that define what each field means;
3. a check that names bad inputs;
4. an ADR.

**It changes no simulation behaviour.** `simulate.ts` doesn't read any new field yet. `ENGINE_VERSION` stays 1.14.0
and every golden is byte-identical. P2 and P3 make the engine read these fields later.

## Principles (keep all of them)

1. **Every new field is optional.** With it unset, P2/P3 must run exactly as today. Say so in each doc comment, as the
   existing fields do ("Omitted: … as before this field existed").
2. **Tiers are services.** A service is one tier of one department: "Organic Tier 1", "Performance Tier 2". Tiers are
   shared by both departments (prototype: "Tiers are shared by both departments"), but each department's tier has its
   own values.
3. **A tier's deliverables drive step frequency; steps don't hard-code counts.** A servicing link's recurrence can
   read a client's deliverable value.
4. **A future time is derived, never typed** (requirements section 7). A change acts on parts of a step's time, and
   adoption ramps from a start month.
5. **Random streams don't move.** The new behaviour scales a drawn time after the draw, the way the capacity factor
   does (`EnginePerson.capacityFactor`). It adds tasks only from new streams.
6. **Engine units are working hours.** Words, links, ticket hours and tasks are labels and rates for display, and
   are turned into step hours outside the engine.

## 1. The fields (put them in `packages/engine/src/model.ts`, documented like the existing ones)

Names are the recommended ones. You may rename them for consistency with the file, but **list every rename in the
ADR**: P1 maps database columns to these names.

### Tiers and departments: `EngineService`

| Field | Type | Meaning |
|---|---|---|
| `department` | `string?` | Department id this tier belongs to (Organic, Performance). Reporting and assignment only. |
| `tier` | `string?` | Tier key shared across departments (`"T1"`). Step tier multipliers and change filters key on it. |
| `deliverables` | `TierDeliverables?` | Per client a month: `words`, `links`, `techHours`, `meetings`, `builds`, `creativeSets`, `channels` (each `number?`). |
| `adhoc` | `{ chance: number; requests: number }?` | D26: the share of clients who ask in a month (0–1), and the requests from a client who asks. |

Fee is `price` and base churn is `churnMonthly`, as today. The price-rise churn rate (D36) is **not** in this package;
P7 adds it.

### Clients: `EngineClient` (named) and counted clients

| Field | Type | Meaning |
|---|---|---|
| `overrides` | `ClientOverrides?` | A named client's own values, each replacing its tier's: any `TierDeliverables` key, `adhoc.chance`, `adhoc.requests`, `adhocHours` (hands-on hours per request, replacing the ad-hoc process's time), `stepFactor` (× on every step's time for this client, or a `Record<stepId, number>`). |
| `handHoldingHours` | `Record<roleId, number>?` | Unplanned hours a month for this client, per role, done by the client's assignee in that role. Load like `fallbackOngoing`, on top of the servicing tasks. |

Clients who take two services ("also takes") are one `EngineClient` with two `services`, **as today**. Each service's
deliverables apply.

**Named and counted together:**
- New `EngineModel.clientMix?: "groups-replace" | "groups-add"`.
- `"groups-replace"` (the default) is today's rule: groups replace the named roster.
- `"groups-add"`: groups are unnamed clients **in addition to** the named ones.

**Portfolios:** new `EnginePerson.portfolio?: Record<serviceId, number>`.
- It means that many of the service's counted clients are assigned to this person, in each of the person's roles that
  the service's servicing steps use.
- The group's remainder (count minus the sum of portfolios) stays unassigned and shared, as today.
- A sum above the count is an input error, reported by the check below.

**Counted "taking both":** not an engine input. It only feeds the derived "unique clients" figure. Say so in the ADR.

### Frequency: `Recurrence`

Add one variant:

```ts
| { perMonth: number; driver: DeliverableKey | "adhoc"; per?: number }
```

- Tasks a month are `perMonth × value ÷ (per ?? 1)`.
- `value` is the client's effective deliverable (override, else tier).
- For `"adhoc"`, the value is `chance × requests`. Arrivals are Bernoulli(chance) a month, then that many requests;
  this is P2's choice of draw, documented here.
- Words use `per: 1000`.
- Every other driver is spaced evenly in the month, like `{ every: "month", times }`.
- A driver of 0 means no tasks.
- `channels` as a driver gives "per channel" steps (pacing, PPC hygiene).

The prototype puts a frequency on each step. The engine keeps frequency on the servicing link, so a step with its own
driver lives in its own servicing process ("Content, per 1,000 words", "Links, per link"). Write this mapping in the
ADR as the decision, with the prototype's steps `o1`–`o15` and `p1`–`p13` grouped as an example.

### Who does the work

| Field | Type | Meaning |
|---|---|---|
| `EngineStep.toClientManager` | `boolean?` | The step goes to **the client's manager**: the person who holds the client in their portfolio or assignments, whatever their role (a director or a manager). Falls back to `role`'s pool if the client has none. Steps for a shared team keep `role`; pinned steps keep `person`. (D32) |
| `EngineClient.manager` | `string?` | Person id of the client's manager, for named clients. Counted clients get theirs from `portfolio`. |
| `EnginePerson.reservedShare` | `number?` | Team time (0–1): the share of their hours kept for leading, mentoring and reviews. Available hours × (1 − share). |
| `EnginePerson.ramp` | `number[]?` | Share of full capacity in each month from `from`, e.g. `[0.4, 0.6, 0.8]`, then 1. Omitted: full from the start. |
| `EnginePerson.tiers` | `string[]?` | Tier keys they can serve. Used to place won clients. |
| `EngineModel.placeNewClients` | `"round-robin" \| "least-busy"?` | How won clients are assigned. Default `"round-robin"` (today). `"least-busy"`: the least-busy person who serves the tier, in each needed role (handover: "Room as assigned today"). |
| `EngineRole.unit` | `{ label: string; perHour?: number }?` | D27 display unit ("words", "links", "ticket hours", "tasks", "set-ups and incidents"). `perHour` is blank until Joe keys it (D35). Reporting only. |

### Step base values and changes (P3's half)

| Field | Type | Meaning |
|---|---|---|
| `EngineStep.split` | `{ automatable: number; augmentable: number; manual: number }?` | Shares of hands-on time, summing to 1 (D6). |
| `EngineStep.tierMultiplier` | `Record<tierKey, number>?` | × on time for a client of that tier (D7). Missing tier: 1. |
| `EngineStep.sources` | `Partial<Record<"work" \| "split" \| "tierMultiplier", SourceLabel>>?` | `"interview" \| "calculator" \| "measured" \| "estimate"`. Reporting only. |
| `EngineModel.changes` | `EngineStepChange[]?` | Automations and augmentations (below). |

```ts
interface EngineStepChange {
  id: string;
  name: string;
  kind: "automation" | "augmentation";
  effects: (
    | { step: string; part: "automatable"; remove: number; residualHours?: number }
    | { step: string; part: "augmentable"; factor: number }
  )[];
  adoption: number;     // 0–1 (D8)
  startMonth: number;   // 1-based month of the run it starts
  rampMonths: number;   // months to full effect; 0 = at once
  tiers?: string[];     // only clients of these tiers; omitted = all
  issueId?: string;     // the issue it fixes (P8); reporting only
}
```

## 2. The definitions (new file `packages/engine/src/capacity-inputs.ts`, exported from `index.ts`)

These are pure functions, so P2, P3 and the web's derived figures share one meaning. Each needs unit tests with hand
checks. Use the prototype's numbers as fixtures.

- `effectiveDeliverables(model, client, serviceId)` gives the client's values: override, else tier, else 0. Also the
  effective `adhoc`.
- `tasksPerMonth(recurrence, deliverables, adhoc, hoursPerWeek)` gives the expected tasks a month for every
  `Recurrence` variant, the old ones included. Use 52/12 weeks a month.
- `rampShare(person, monthIndex)` and `availableShare(person, monthIndex)`. The second is `(1 − reservedShare) × ramp`;
  leave stays where it is today.
- `stepParts(step, tierKey, changes, monthIndex)` gives `{ automatable, augmentable, manual, total, base }` in hours,
  for the step's mean `work`, applying:
  - the tier multiplier;
  - each active change's adoption, ramped as `min(1, (m − start + 1) / (ramp + 1))` (the prototype's `activeChanges`);
  - automation: `a × (1 − remove × ad) + residual × ad`;
  - augmentation: `g ÷ (1 + (factor − 1) × ad)`.

  A step with no `split` returns everything as `manual`, and changes have no effect on it.
- `stepTimeFactor(step, tierKey, changes, monthIndex, clientStepFactor?)` returns `total ÷ (mean work)`: the number P3
  will multiply a drawn time by. It is exactly 1 when no new field is set.

**Test the section 7 worked example exactly:**
- pacing of 55 minutes, split 70/20/10;
- automation removes 90%, with a 3-minute residual;
- adoption 80%;
- the result is about 23 minutes.

Also test that a corrected baseline of 70 minutes moves the saving.

## 3. The check (`checkCapacityInputs(model): Problem[]`)

Plain-English problems, the way `broken.ts` names them, for:
- a split that doesn't sum to 1 (±0.001);
- a negative or non-finite value;
- adoption outside 0–1;
- a change on an unknown step;
- an `augmentable` effect with factor < 1;
- portfolios summing above a group's count;
- `toClientManager` on a step with no role;
- a `driver` recurrence on a service with no deliverables.

Don't wire it into `simulate`; P2 decides where it runs.

## 4. The ADR

Write `docs/adr/0022-capacity-inputs.md`, short:
- the decision;
- each field and why it sits where it does;
- the per-step-frequency → per-process mapping;
- what stays out of the engine: salary, DLER, contractor and offshore labels, role line and rule of thumb, "taking
  both" counts. These are database-only and feed the derived figures.

## 5. A golden for later

Add a fixture builder, `capacityModel()`, in `packages/engine/src/fixtures/capacity.ts`, beside Northbeam. It is the
prototype's example agency, using the new fields, with no confidential data: the prototype's data is made up. Don't
add it to the goldens yet; P2 does that once the engine reads the fields. A test that `checkCapacityInputs` returns no
problems for it is enough.

## Done when

- `pnpm lint && pnpm typecheck && pnpm test` pass.
- The goldens are byte-identical, `ENGINE_VERSION` is unchanged, and `simulate.ts` and `flatten.ts` are untouched.
  Check with `git diff --stat`.
- The report lists the final field names, the renames, and any point where the prototype's calculator and the
  engine's model of time can't agree. The prototype has no queues; the engine does.
