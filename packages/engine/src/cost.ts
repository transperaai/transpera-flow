// Cost per month (docs/analysis-rules.md, "Cost per month"; issue #108).
//
// Every insight gets an estimated cost per month in the workspace currency.
// The central idea is what a loss is worth: the revenue still to come at the
// moment it's lost, capped at 12 months (editable).
//
// - Before signing, a lost lead or deal is worth the deal value × the chance it
//   would still have signed from that step.
// - After signing, a churned client is worth its monthly fee × the tenure it had
//   left, from the month it churns.
// - Deal value is the service's monthly fee × typical tenure (the one-off price
//   for one-off services), capped.
//
// Everything here is pure: the same model and numbers give the same cost.
// Currency is only a label; the numbers are in whatever currency the model's
// prices are in.

import type { EngineClient, EngineModel, EngineService, EngineStep } from "./model";
import { flattenModel } from "./flatten";
import { routeFor } from "./simulate";
import { servicingStepIds } from "./servicing";
import { shadowPrice, type ShadowPriceOptions } from "./shadow-price";

/** Weeks in a month, as the rest of the product reads a month (52 / 12). */
export const WEEKS_PER_MONTH = 52 / 12;

/** The money settings (docs/analysis-rules.md "Editing the rules"). */
export interface CostConfig {
  /** A loss is worth at most this many months of revenue. */
  capMonths: number;
  /** How often one person is away in a year, for the single-point-of-failure cost. */
  absencesPerYear: number;
  /** The workspace currency (an ISO code such as "AUD"), for the amounts in the cost descriptions. Omitted: plain numbers. */
  currency?: string;
}

export const DEFAULT_COST_CONFIG: CostConfig = { capMonths: 12, absencesPerYear: 2 };

export type CostConfigInput = Partial<CostConfig>;

/** A whole amount of money in the currency ("A$45,600"); plain digits when there is none. Never compacted, so it reads the same everywhere. */
export function formatMoney(value: number, currency?: string): string {
  if (!currency) return value.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  return value.toLocaleString("en-GB", { style: "currency", currency, maximumFractionDigits: 0 });
}

export function resolveCostConfig(input: CostConfigInput = {}): CostConfig {
  return {
    ...(input.currency ? { currency: input.currency } : {}),
    capMonths: input.capMonths !== undefined && input.capMonths >= 0 ? input.capMonths : DEFAULT_COST_CONFIG.capMonths,
    absencesPerYear: input.absencesPerYear !== undefined && input.absencesPerYear >= 0 ? input.absencesPerYear : DEFAULT_COST_CONFIG.absencesPerYear,
  };
}

/** The estimated cost of one insight. Always an estimate; the screens say so. */
export interface IssueCost {
  /** Money a month, in the workspace currency; null when no money method applies. */
  perMonth: number | null;
  /** Working hours lost a month, when the insight has a time method rather than a money one. */
  hoursPerMonth: number | null;
  /** How it was worked out, in a sentence. */
  method: string;
  /** True when the figure needs people's pay and the model hides it (`model.payHidden`); the screens say so instead of "n/a". */
  payHidden?: true;
}

/** An insight with no cost: "n/a". */
export const noCost = (method: string): IssueCost => ({ perMonth: null, hoursPerMonth: null, method });

/** An insight whose cost depends on individual pay, which this caller may not see. */
export const payHiddenCost = (): IssueCost => ({
  perMonth: null,
  hoursPerMonth: null,
  method: "This cost depends on people's pay, which isn't shown to you.",
  payHidden: true,
});

/** Orders costs highest first: money, then time, then none. */
export function compareCostsDesc(a: IssueCost, b: IssueCost): number {
  const m = (b.perMonth ?? -1) - (a.perMonth ?? -1);
  if (m !== 0) return m;
  return (b.hoursPerMonth ?? -1) - (a.hoursPerMonth ?? -1);
}

/** A service's typical tenure in months; unbounded when a retainer never churns. */
const tenureOf = (s: Pick<EngineService, "tenureMonths">) => (s.tenureMonths > 0 ? s.tenureMonths : Infinity);

/** A service's deal value: monthly fee × typical tenure, capped; the one-off price for one-off services; nothing for hourly. */
export function dealValue(service: Pick<EngineService, "pricingModel" | "price" | "tenureMonths">, capMonths: number): number {
  if (service.pricingModel === "one_off") return service.price;
  if (service.pricingModel === "retainer") return service.price * Math.min(tenureOf(service), capMonths);
  return 0;
}

/** Months of revenue a client has left when it churns: the tenure it had left, capped. */
export function remainingTenure(tenureMonths: number, monthsActive: number, capMonths: number): number {
  return Math.max(0, Math.min(tenureMonths - monthsActive, capMonths));
}

/** What losing a client is worth after signing: its monthly fee × the tenure it had left, capped. */
export function churnLossValue(fee: number, tenureMonths: number, monthsActive: number, capMonths: number): number {
  return fee * remainingTenure(tenureMonths, monthsActive, capMonths);
}

/** A client's loss value: its monthly fee × the tenure it had left on its longest-tenured service. */
export function clientLossValue(model: EngineModel, client: EngineClient, capMonths: number): number {
  const tenures = client.services.flatMap((sid) => (model.services?.[sid] ? [tenureOf(model.services[sid]!)] : []));
  const tenure = tenures.length ? Math.max(...tenures) : model.churnMonthly > 0 ? 1 / model.churnMonthly : Infinity;
  return churnLossValue(client.mrr, tenure, client.monthsActive ?? 0, capMonths);
}

/** The services a model sells with their share of arrivals (normalised); the implicit retainer when it has none. */
export function serviceMix(model: EngineModel): { id: string | null; service: EngineService; share: number }[] {
  const given = Object.entries(model.services ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const entries: [string | null, EngineService][] = given.length
    ? given
    : [
        [
          null,
          {
            name: "Retainer",
            pricingModel: "retainer",
            price: model.retainer,
            margin: 0,
            tenureMonths: model.churnMonthly > 0 ? 1 / model.churnMonthly : 0,
            churnMonthly: model.churnMonthly,
            mixShare: 1,
            pathTags: [],
          },
        ],
      ];
  const total = entries.reduce((sum, [, s]) => sum + Math.max(0, s.mixShare), 0);
  return entries.map(([id, service]) => ({ id, service, share: total > 0 ? Math.max(0, service.mixShare) / total : 1 / entries.length }));
}

/** The average deal value across the services mix. */
export function averageDealValue(model: EngineModel, capMonths: number): number {
  return serviceMix(model).reduce((sum, m) => sum + m.share * dealValue(m.service, capMonths), 0);
}

/**
 * The chance an item at each step still signs: the probability of reaching a
 * `won` end by the step's routing for a service with these path tags (a lost
 * end, or one that never ends, counts 0). Rework repeats a step but doesn't
 * change where the item ends up, so it doesn't count.
 */
export function chanceToSignByStep(nested: EngineModel, tags: readonly string[]): Record<string, number> {
  // Groups are drawn away first: a nested model gives the chance of the same model drawn flat (flatten.ts).
  const model = flattenModel(nested);
  const chance: Record<string, number> = {};
  for (const s of model.steps) chance[s.id] = 0;
  const routes = new Map(model.steps.map((s) => [s.id, routeFor(s.next, [...tags])]));
  /** The value of arriving at `to`, following a hand-off to its step. */
  const valueOf = (to: string, depth = 0): number => {
    if (to === model.sinks.won) return 1;
    if (to === model.sinks.lost) return 0;
    if (to in chance) return chance[to]!;
    const end = model.ends?.[to];
    if (!end) return 0;
    if (end.outcome === "won") return 1;
    return end.handoff && depth < 8 ? valueOf(end.handoff, depth + 1) : 0;
  };
  // Value iteration: a step's chance is the weighted chance of where it goes next. Converges for any routing.
  for (let i = 0; i < 2000; i++) {
    let delta = 0;
    for (const s of model.steps) {
      const route = routes.get(s.id)!;
      let v = 0;
      for (const e of route.next) v += (route.total > 0 ? e.p / route.total : 0) * valueOf(e.to);
      delta = Math.max(delta, Math.abs(v - chance[s.id]!));
      chance[s.id] = v;
    }
    if (delta < 1e-12) break;
  }
  return chance;
}

/**
 * What losing one item at a step is worth. Before signing: the deal value ×
 * the chance it would still have signed from that step (weighted across the
 * services mix). Servicing steps are after signing: the client is already
 * won, so a loss there is worth the whole deal value.
 */
export function lossValueAtStep(model: EngineModel, step: Pick<EngineStep, "id">, capMonths: number): number {
  const servicing = servicingStepIds(model).has(step.id);
  let sum = 0;
  for (const m of serviceMix(model)) {
    const chance = servicing ? 1 : (chanceToSignByStep(model, m.service.pathTags)[step.id] ?? 0);
    sum += m.share * dealValue(m.service, capMonths) * chance;
  }
  return sum;
}

/**
 * Extra wins a quarter (wins only, not other completions) that one more person
 * in each of these roles would bring (the shadow price's mean), for `detectIssues`' "too busy" cost. Each is an
 * extra replication set (shadow-price.ts), so name only the roles worth it.
 */
export function shadowPricesFor(model: EngineModel, roleIds: readonly string[], options: ShadowPriceOptions = {}): Record<string, number> {
  const out: Record<string, number> = {};
  const now = options.now ?? (() => performance.now());
  const deadline = options.timeBudgetMs === undefined ? Infinity : now() + options.timeBudgetMs;
  for (const id of [...new Set(roleIds)].sort()) {
    // One time budget for all the roles together: each run gets what is left (at least one pair always runs).
    const left = deadline === Infinity ? undefined : Math.max(0, deadline - now());
    const sp = shadowPrice(model, id, { ...options, count: "wins", ...(left === undefined ? {} : { timeBudgetMs: left }), now });
    if (sp) out[id] = sp.perQuarter.mean;
  }
  return out;
}

/** The chance an item at a step still signs, across the services mix. */
export function chanceToSign(model: EngineModel, stepId: string): number {
  let sum = 0;
  for (const m of serviceMix(model)) sum += m.share * (chanceToSignByStep(model, m.service.pathTags)[stepId] ?? 0);
  return sum;
}
