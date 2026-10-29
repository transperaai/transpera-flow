// "Today: ..." in the change dialog: what a lever stands at now, in the lever's own words, read from the live model the runs use
// (the same model, and the same fields, that `applyPatches` changes). It names no person's pay: a lever that stores one person's
// rate (`pay: "individual"`) shows nothing, and the others read a role's rate, a head count, an FTE or a fee. Pure: no React.

import { CHURN_DRIVER_SPECS, CUSTOM_DRIVER_PREFIX, busiestRole, headcount, heaviestStep, type BuiltinChurnDriverId, type ChurnCause, type EngineModel } from "@transpera-flow/engine";
import type { SandboxLever } from "@transpera-flow/db";
import { formatNumber, formatWholeCurrency } from "@/lib/format";
import { percentText } from "./traffic";

const WEEKS_PER_MONTH = 52 / 12;
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** What the live run measured, for levers whose "today" is an outcome rather than an input (a conversion rate, a driver's chance). */
export interface TodayFacts {
  /** Share of finished opportunities that signed in the live run (0 to 1), or null when it did not run yet. */
  conversion?: number | null;
  /** The live run's churn causes (their measured chance and exposure). */
  causes?: readonly ChurnCause[];
  /** Hiring delay in force in the live model, whole months (0: none). */
  hireDelayMonths?: number;
}

const pct = (share: number, digits = 1) => `${formatNumber(share * 100, digits)}%`;

/**
 * What a lever stands at today for the target picked, or null when there is nothing to say (a leave, a solution, nothing picked).
 * Pay (brief B1): nothing here is one person's pay. C1 reads a role's rate, as Settings shows every member; D6 and D4 are hours, and a
 * lever that stores an individual's rate (`pay: "individual"`) says nothing.
 */
export function todayValue(lever: SandboxLever, targetId: string | null, model: EngineModel, currency: string, facts: TodayFacts = {}): string | null {
  if (lever.pay === "individual") return null;
  const money = (v: number) => formatWholeCurrency(v, currency);
  const roleId = lever.target === "role" || lever.target === "role_or_none" ? (targetId === "@busiest" ? busiestRole(model) : targetId) : null;
  const role = roleId ? model.roles[roleId] : undefined;
  const stepId = lever.target === "step" ? (targetId === "@heaviest" ? heaviestStep(model) : targetId) : null;
  const step = stepId ? model.steps.find((s) => s.id === stepId) : undefined;
  const person = lever.target === "person" && targetId ? model.people?.[targetId] : undefined;
  const service = (lever.target === "service" || lever.target === "service_or_none") && targetId ? model.services?.[targetId] : undefined;
  const pickedName = targetId?.startsWith("@") ? (role?.name ?? step?.name) : undefined;
  const picked = pickedName ? ` (${pickedName})` : "";
  switch (lever.id) {
    case "A1":
      return `about ${formatNumber(model.leadsPerWeek * WEEKS_PER_MONTH, 0)} opportunities a month`;
    case "A3":
      return facts.conversion != null ? `about ${pct(facts.conversion, 0)} of finished opportunities sign` : null;
    case "A5": {
      if (!service) return null;
      const r = service.priceRange;
      const unit = service.pricingModel === "hourly" ? " an hour" : service.pricingModel === "one_off" ? "" : " a month";
      return r && (r.low < service.price || r.high > service.price)
        ? `${money(Math.min(r.low, service.price))} – ${money(service.price)} – ${money(Math.max(r.high, service.price))}${unit}`
        : `${money(service.price)}${unit}, no range`;
    }
    case "A6":
      return trafficToday(model);
    case "B4": {
      if (!targetId) return null;
      // A driver the model has no row for runs as its default: late work and the market on at weight 1, the rest off.
      const spec = CHURN_DRIVER_SPECS[targetId as BuiltinChurnDriverId];
      const d = model.churnDrivers?.find((x) => x.id === targetId) ?? (spec ? { id: targetId, weight: 1, enabled: spec.defaultEnabled } : undefined);
      const name = targetId.startsWith(CUSTOM_DRIVER_PREFIX) ? d?.name : CHURN_DRIVER_SPECS[targetId as BuiltinChurnDriverId]?.name;
      if (!name) return null;
      if (d && d.enabled && d.effect != null) {
        const chance = d.chance != null ? `${pct(d.chance)} chance a month` : "measured chance";
        return `${name}: ${chance}, raises churn ${formatNumber(d.effect * 100, 0)}% for ${d.effectMonths ?? 3} months`;
      }
      const cause = facts.causes?.find((c) => c.id === targetId);
      const measured = cause?.chance != null ? `, measured chance ${pct(cause.chance)} a month` : "";
      return d && d.enabled ? `${name}: counted by its weight (${formatNumber(d.weight, 1)})${measured}` : `${name}: switched off${measured}`;
    }
    case "B5": {
      if (targetId && !service) return null;
      return `${money(service ? service.price : model.retainer)} a month`;
    }
    case "D6": {
      if (targetId && !role) return null;
      const members = Object.values(model.people ?? {}).filter((p) => !roleId || p.roles.includes(roleId));
      if (!members.length) return role ? `${people(role.count)}${picked}` : null;
      const fte = members.reduce((sum, p) => sum + p.capacity, 0) / model.hoursPerWeek;
      return `${formatNumber(fte, 1)} FTE across ${people(members.length)}${picked}`;
    }
    case "D9":
      return facts.hireDelayMonths ? `${facts.hireDelayMonths} month${facts.hireDelayMonths === 1 ? "" : "s"}` : "none: new hires start on their date";
    case "B1":
      return `${formatNumber(model.activeClients, 0)} clients`;
    case "B2": {
      if (targetId && !service) return null;
      return `${money(service ? service.price : model.retainer)} a month`;
    }
    case "B3":
      return `${formatNumber(model.churnMonthly * 100, 1)}% a month`;
    case "C1":
      return role ? `${money(role.cost)} an hour${picked}` : null;
    case "C2":
      return `${money(model.overheadMonthly ?? 0)} a month`;
    case "D1":
    case "D5":
      return role && roleId ? `${people(headcount(model, roleId))}${picked}` : null;
    case "D2":
    case "D4":
      return person ? `${formatNumber(person.capacity / model.hoursPerWeek, 2)} FTE` : null;
    case "E1":
      return step ? `${formatNumber(step.work, 2)} hours of hands-on time${picked}` : null;
    case "E2":
      return step ? `${formatNumber(step.wait, 2)} hours waiting${picked}` : null;
    case "E3":
      return step ? `done again ${formatNumber(step.rework * 100, 1)}% of the time${picked}` : null;
    default:
      return null;
  }
}

/** The traffic split now, "Paid ads 55%, SEO 45%"; null when the model has fewer than two types. */
export function trafficToday(model: Pick<EngineModel, "services">): string | null {
  const entries = Object.entries(model.services ?? {});
  if (entries.length < 2) return null;
  const total = entries.reduce((sum, [, s]) => sum + Math.max(0, s.mixShare), 0);
  if (!(total > 0)) return null;
  return entries.map(([, s]) => `${s.name} ${percentText(Math.max(0, s.mixShare) / total)}`).join(", ");
}
