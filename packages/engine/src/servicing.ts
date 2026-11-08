// Client servicing, health and churn (docs/PRD.md §6.3.5, decision D9; issue
// #19): the rules as pure functions, shared by the simulation, the detected
// issues and the app. Each active client (on the roster or won during the run)
// generates servicing tasks per its services' recurrences; a task done within
// its SLA lifts the client's health, a late one lowers it, one not done within
// twice the SLA (missed) lowers it more; and monthly churn rises as health
// falls.

import { effectiveDeliverables, tasksPerMonth } from "./capacity-inputs";
import type { EngineClient, EngineHealthRules, EngineModel, EngineService, EngineServicingLink, Recurrence } from "./model";

/** The PRD's estimated defaults (§6.3.5): start at 80; +2 on time, −5 late, −12 missed. */
export const DEFAULT_HEALTH_RULES: Required<EngineHealthRules> = { initial: 80, recover: 2, latePenalty: 5, missedPenalty: 12 };

/** The PRD's estimated churn sensitivity (§5 `services.churn_health_sensitivity`), which the database defaults to. */
export const DEFAULT_CHURN_SENSITIVITY = 3;

/** Health below which a client is at risk (docs/PRD.md §13). */
export const AT_RISK_HEALTH = 50;

/** Weeks in a month for recurrences and churn, as elsewhere in the engine. */
const WEEKS_PER_MONTH = 4.33;

/** The model's health rules with the defaults filled in. */
export function healthRules(model: Pick<EngineModel, "health">): Required<EngineHealthRules> {
  const h = model.health ?? {};
  const pick = (v: number | undefined, d: number) => (v !== undefined && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    initial: clampHealth(pick(h.initial, DEFAULT_HEALTH_RULES.initial)),
    recover: pick(h.recover, DEFAULT_HEALTH_RULES.recover),
    latePenalty: pick(h.latePenalty, DEFAULT_HEALTH_RULES.latePenalty),
    missedPenalty: pick(h.missedPenalty, DEFAULT_HEALTH_RULES.missedPenalty),
  };
}

export const clampHealth = (h: number) => Math.min(100, Math.max(0, h));

/**
 * Monthly churn probability of a client (docs/PRD.md §6.3.5):
 * `base × (1 + sensitivity × (100 − health) / 100)`, at most 1.
 */
export function churnProbability(base: number, sensitivity: number, health: number): number {
  return Math.min(1, Math.max(0, base * (1 + sensitivity * ((100 - clampHealth(health)) / 100))));
}

/** A client's churn sensitivity: the mean of its known services', 0 where a service has none. */
export function clientChurnSensitivity(model: EngineModel, client: Pick<EngineClient, "services">): number {
  const known = client.services.map((sid) => model.services?.[sid]).filter((sv) => sv !== undefined);
  if (!known.length) return 0;
  return known.reduce((sum, sv) => sum + (sv.churnSensitivity ?? 0), 0) / known.length;
}

/** A service's servicing links whose process the model has, with a usable recurrence and SLA. */
export function servicingLinks(model: Pick<EngineModel, "servicingProcesses">, service: EngineService): EngineServicingLink[] {
  const processes = model.servicingProcesses ?? {};
  return (service.servicing ?? []).filter((l) => l.process in processes && hasTasks(l.recurrence) && l.sla > 0);
}

/** Whether a recurrence can make tasks. A driver recurrence needs a client's deliverables to know, so it counts when its rate is usable. */
function hasTasks(r: Recurrence): boolean {
  return "driver" in r ? Number.isFinite(r.perMonth) && r.perMonth > 0 : tasksPerWeek(r) > 0;
}

/** True when a service's clients run at least one servicing process (so its fallback load doesn't apply). */
export function hasServicing(model: Pick<EngineModel, "servicingProcesses">, service: EngineService): boolean {
  return servicingLinks(model, service).length > 0;
}

/** True when any service of the model has servicing processes. */
export function modelHasServicing(model: EngineModel): boolean {
  return Object.values(model.services ?? {}).some((sv) => hasServicing(model, sv));
}

/** Tasks a week one client generates from a recurrence (0 for a malformed one). */
export function tasksPerWeek(r: Recurrence): number {
  // A driver recurrence needs the client's deliverables, which this can't see: see `tasksPerMonth` (capacity-inputs.ts).
  if ("driver" in r) return 0;
  const n = "poissonPerMonth" in r ? r.poissonPerMonth / WEEKS_PER_MONTH : r.every === "week" ? r.times : r.times / WEEKS_PER_MONTH;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Tasks a week one client generates from a servicing link's recurrence, drivers included (docs/adr/0022-capacity-inputs.md):
 * a driver recurrence reads the client's effective deliverables (its overrides, else the service's: `effectiveDeliverables`)
 * and turns `tasksPerMonth` into a week at this file's 4.33 weeks a month, so it runs on the same clock as `{ every: "month" }`.
 * `client` is undefined for a client with no overrides.
 */
export function clientTasksPerWeek(model: Pick<EngineModel, "services">, client: Pick<EngineClient, "overrides"> | undefined, serviceId: string, r: Recurrence): number {
  if (!("driver" in r)) return tasksPerWeek(r);
  const e = effectiveDeliverables(model, client, serviceId);
  const n = tasksPerMonth(r, e.deliverables, e.adhoc) / WEEKS_PER_MONTH;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Hours between tasks of a fixed recurrence; null for Poisson requests and for drivers (see `clientTasksPerWeek`). */
export function recurrenceInterval(r: Recurrence, hoursPerWeek: number): number | null {
  if ("poissonPerMonth" in r || "driver" in r) return null;
  return hoursPerWeek / tasksPerWeek(r);
}

/** Mean hours between Poisson requests. */
export function poissonMeanGap(r: Recurrence, hoursPerWeek: number): number {
  return hoursPerWeek / tasksPerWeek(r);
}

/** "monthly", "twice a week", "fortnightly", "about 3 a month (ad hoc)". */
export function recurrenceLabel(r: Recurrence): string {
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ""));
  if ("driver" in r) return `${n(r.perMonth)} a month per ${r.per && r.per !== 1 ? `${n(r.per)} ` : ""}${r.driver}`;
  if ("poissonPerMonth" in r) return `ad hoc, about ${n(r.poissonPerMonth)} a month`;
  const unit = r.every;
  if (r.times === 1) return unit === "week" ? "weekly" : "monthly";
  if (r.times === 0.5) return unit === "week" ? "fortnightly" : "every two months";
  if (r.times === 2) return `twice a ${unit}`;
  if (r.times > 0 && r.times < 1) return `every ${n(1 / r.times)} ${unit}s`;
  return `${n(r.times)} times a ${unit}`;
}

/** Ids of the steps that belong to servicing processes. */
export function servicingStepIds(model: Pick<EngineModel, "servicingProcesses">): Set<string> {
  const out = new Set<string>();
  for (const p of Object.values(model.servicingProcesses ?? {})) for (const id of p.steps) out.add(id);
  return out;
}
