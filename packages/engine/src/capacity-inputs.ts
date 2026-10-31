// What the capacity inputs mean (docs/adr/0022-capacity-inputs.md; docs/plans/capacity/p23-interface-brief.md).
//
// Pure functions, so the engine (P2, P3) and the app's derived figures share one definition of each new field. Since
// engine 1.15.0 the run reads `effectiveDeliverables`, `tasksPerMonth` and `availableShare` (P2); `stepParts` and
// `stepTimeFactor` are P3's and are not read yet. The fields are optional, and with all of them unset every function here
// gives the answer the engine already gives (a factor of exactly 1, full availability, the old recurrences).
//
// Time: a month is 52/12 weeks, as in demand.ts and market.ts. Hours are working hours, as everywhere in the engine; a step's
// mean `work` is in hours and so are the parts `stepParts` returns. Month indexes are 0-based (0 is the first month of the
// run); `EngineStepChange.startMonth` is 1-based, as people say it ("starts in month 2").
//
// The prototype (docs/prototypes/client-capacity-app.PROTOTYPE.html: `availH`, `activeChanges`, `parts`, `freqOf`) is the
// reference for the arithmetic. Where the engine's model of time can't agree with it, the ADR says so.

import type { DeliverableKey, EngineClient, EngineModel, EnginePerson, EngineStep, EngineStepChange, Recurrence, ServiceAdhoc, TierDeliverables } from "./model";

/** Weeks in a month for the capacity inputs (52 / 12), as demand.ts and market.ts read a month. */
export const CAPACITY_WEEKS_PER_MONTH = 52 / 12;

/** Every deliverable key, in the order the app lists them. */
export const DELIVERABLE_KEYS: readonly DeliverableKey[] = ["words", "links", "techHours", "meetings", "builds", "creativeSets", "channels"];

/** A client's values on one service once its overrides are applied. */
export interface EffectiveDeliverables {
  /** Every key filled in: the override, else the tier's, else 0. */
  deliverables: Required<TierDeliverables>;
  /** The ad-hoc rule: the override, else the tier's, else none (chance 0, requests 0). */
  adhoc: ServiceAdhoc;
  /** Hands-on hours per ad-hoc request when the client has its own; undefined means the ad-hoc process's step time. */
  adhocHours?: number;
}

/** A number the inputs can use: finite and not negative. Anything else counts as 0 (the check names it). */
const usable = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The client's values on a service: its own override, else the tier's, else 0. `client` is undefined for a counted client
 * (no overrides). A service the model doesn't have gives all 0.
 */
export function effectiveDeliverables(model: Pick<EngineModel, "services">, client: Pick<EngineClient, "overrides"> | null | undefined, serviceId: string): EffectiveDeliverables {
  const sv = model.services?.[serviceId];
  const o = client?.overrides;
  const deliverables = {} as Required<TierDeliverables>;
  for (const k of DELIVERABLE_KEYS) deliverables[k] = usable(o?.[k] ?? sv?.deliverables?.[k]);
  const adhoc = { chance: usable(o?.adhocChance ?? sv?.adhoc?.chance), requests: usable(o?.adhocRequests ?? sv?.adhoc?.requests) };
  return o?.adhocHours !== undefined ? { deliverables, adhoc, adhocHours: usable(o.adhocHours) } : { deliverables, adhoc };
}

/**
 * Expected tasks a month one client generates from a recurrence, for every variant (the old ones included):
 * - `{ every: "week", times }`: `times` × 52/12; `{ every: "month", times }`: `times`;
 * - `{ poissonPerMonth }`: that number;
 * - `{ perMonth, driver, per }`: `perMonth × value ÷ (per ?? 1)`, where `value` is the deliverable named by `driver`, or for
 *   `"adhoc"` the expected requests `chance × requests`. A driver of 0, or a malformed number, gives 0.
 *
 * (`tasksPerWeek` in servicing.ts is the same for the old variants but reads a month as 4.33 weeks, the churn tick's
 * convention; the difference is 0.08%.)
 */
export function tasksPerMonth(r: Recurrence, deliverables: Required<TierDeliverables>, adhoc: ServiceAdhoc): number {
  let n: number;
  if ("driver" in r) {
    const value = r.driver === "adhoc" ? usable(adhoc.chance) * usable(adhoc.requests) : usable(deliverables[r.driver]);
    const per = r.per === undefined ? 1 : r.per;
    n = per > 0 && Number.isFinite(per) ? (r.perMonth * value) / per : 0;
  } else if ("poissonPerMonth" in r) n = r.poissonPerMonth;
  else n = r.every === "week" ? r.times * CAPACITY_WEEKS_PER_MONTH : r.times;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The month index a person's `from` falls in. `monthHours` is the hours in one month (`CAPACITY_WEEKS_PER_MONTH ×
 * hoursPerWeek`; market.ts `marketMonthHours`). Without `from` (or before the run) it is 0.
 */
function startMonthOf(person: Pick<EnginePerson, "from">, monthHours: number | undefined): number {
  if (person.from === undefined || !(person.from > 0) || !monthHours || !(monthHours > 0)) return 0;
  return Math.floor(person.from / monthHours);
}

/**
 * The share of full capacity a person has in a month because they are new: `ramp[k]` for the k-th month from the month their
 * `from` falls in, then 1. No `ramp`: 1. A month before they start: 1 here too (`from` already keeps them out of the work;
 * this is only the ramp). Entries are clamped to 0-1.
 */
export function rampShare(person: Pick<EnginePerson, "from" | "ramp">, monthIndex: number, monthHours?: number): number {
  const ramp = person.ramp;
  if (!ramp || ramp.length === 0) return 1;
  const k = monthIndex - startMonthOf(person, monthHours);
  if (k < 0 || k >= ramp.length) return 1;
  const v = ramp[k]!;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/**
 * The share of a person's hours that goes to client work in a month: `(1 − reservedShare) × rampShare`. Leave is not in it:
 * the engine takes leave windows off in hours, as it does today.
 */
export function availableShare(person: Pick<EnginePerson, "from" | "ramp" | "reservedShare">, monthIndex: number, monthHours?: number): number {
  const reserved = Number.isFinite(person.reservedShare) ? Math.min(1, Math.max(0, person.reservedShare!)) : 0;
  return (1 - reserved) * rampShare(person, monthIndex, monthHours);
}

/** A step's mean hands-on time in its three parts, in hours. */
export interface StepParts {
  automatable: number;
  augmentable: number;
  manual: number;
  /** The three added: what the step takes now. */
  total: number;
  /** The mean `work` × the tier multiplier: the time before any change. */
  base: number;
}

/** How far a change has got in a month (0-based index): 0 before its start, then `min(1, (m − start + 1) ÷ (ramp + 1))` (the prototype's `activeChanges`), 1 with no ramp. */
export function changeRamp(change: Pick<EngineStepChange, "startMonth" | "rampMonths">, monthIndex: number): number {
  const month = monthIndex + 1;
  if (month < change.startMonth) return 0;
  if (!(change.rampMonths > 0)) return 1;
  return Math.min(1, (month - change.startMonth + 1) / (change.rampMonths + 1));
}

/** Whether a change is in force in a month, for a client of this tier. */
function applies(change: EngineStepChange, tierKey: string | undefined, monthIndex: number): boolean {
  if (monthIndex + 1 < change.startMonth) return false;
  return !change.tiers || (tierKey !== undefined && change.tiers.includes(tierKey));
}

/**
 * A step's mean time in its three parts, for a client of a tier, in a month (D6, D7, D8; requirements section 7):
 * - base = `work` × the tier multiplier (a tier not listed, or no tier: 1), split by `split`;
 * - each change in force (started, and its `tiers` filter allows this tier) acts in the order given, with
 *   adoption × ramp = `ad`:
 *   - automation: `a × (1 − remove × ad) + residual × ad`;
 *   - augmentation: `g ÷ (1 + (factor − 1) × ad)`;
 * - a step with no `split` is all manual, and no change touches it.
 *
 * As in the prototype, an effect acts only on a part that has time left (automatable and augmentable above 0).
 */
export function stepParts(step: Pick<EngineStep, "id" | "work" | "split" | "tierMultiplier">, tierKey: string | undefined, changes: readonly EngineStepChange[] | undefined, monthIndex: number): StepParts {
  const mult = tierKey !== undefined ? step.tierMultiplier?.[tierKey] : undefined;
  const base = step.work * (mult !== undefined && Number.isFinite(mult) ? mult : 1);
  if (!step.split) return { automatable: 0, augmentable: 0, manual: base, total: base, base };
  let a = base * step.split.automatable;
  let g = base * step.split.augmentable;
  const n = base * step.split.manual;
  for (const c of changes ?? []) {
    if (!applies(c, tierKey, monthIndex)) continue;
    const ad = c.adoption * changeRamp(c, monthIndex);
    for (const e of c.effects) {
      if (e.step !== step.id) continue;
      if (e.part === "automatable") {
        if (a > 0) a = a * (1 - e.remove * ad) + (e.residualHours ?? 0) * ad;
      } else if (g > 0) g = g / (1 + (e.factor - 1) * ad);
    }
  }
  return { automatable: a, augmentable: g, manual: n, total: a + g + n, base };
}

/**
 * The number P3 multiplies a drawn time by: `stepParts(...).total ÷ work`, times the client's own factor (`stepFactor`: a
 * number for every step, or per step id; a step not listed is 1). Exactly 1 when no new field is set. A step with no `work`
 * has nothing to scale: the client's factor alone.
 */
export function stepTimeFactor(
  step: Pick<EngineStep, "id" | "work" | "split" | "tierMultiplier">,
  tierKey: string | undefined,
  changes: readonly EngineStepChange[] | undefined,
  monthIndex: number,
  clientStepFactor?: number | Record<string, number>,
): number {
  const own = clientStepFactor === undefined ? 1 : typeof clientStepFactor === "number" ? clientStepFactor : (clientStepFactor[step.id] ?? 1);
  if (!(step.work > 0)) return own;
  return (stepParts(step, tierKey, changes, monthIndex).total / step.work) * own;
}
