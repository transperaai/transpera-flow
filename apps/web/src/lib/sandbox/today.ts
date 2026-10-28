// "Today: ..." in the change dialog: what a lever stands at now, in the lever's own words, read from the live model the runs use
// (the same model, and the same fields, that `applyPatches` changes). It names no person's pay: a lever that stores one person's
// rate (`pay: "individual"`) shows nothing, and the others read a role's rate, a head count, an FTE or a fee. Pure: no React.

import { busiestRole, headcount, heaviestStep, type EngineModel } from "@transpera-flow/engine";
import type { SandboxLever } from "@transpera-flow/db";
import { formatNumber, formatWholeCurrency } from "@/lib/format";
import { percentText } from "./traffic";

const WEEKS_PER_MONTH = 52 / 12;
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** What a lever stands at today for the target picked, or null when there is nothing to say (a leave, a solution, nothing picked). */
export function todayValue(lever: SandboxLever, targetId: string | null, model: EngineModel, currency: string): string | null {
  if (lever.pay === "individual") return null;
  const money = (v: number) => formatWholeCurrency(v, currency);
  const roleId = lever.target === "role" ? (targetId === "@busiest" ? busiestRole(model) : targetId) : null;
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
    case "A6":
      return trafficToday(model);
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
