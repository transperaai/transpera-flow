// A lever change in words (B4): what a visitor's idea, the Send dialog and the Editor's "Lever changes" box show for one patch.
// Pure. Names come from the reader's own workspace (or the snapshot's, for a visitor), never from the patch: a patch holds only ids.

import type { ScenarioPatch } from "@transpera-flow/engine";
import { formatWholeCurrency } from "@/lib/format";

/** The names a patch's ids resolve to, by id. `people` is filled only for a reader who sees everyone (B1 2b); otherwise "a team member". */
export interface LeverNames {
  steps?: Readonly<Record<string, string>>;
  roles?: Readonly<Record<string, string>>;
  services?: Readonly<Record<string, string>>;
  people?: Readonly<Record<string, string>>;
}

const MINUS = "−";

/** A relative change as ±%: ×0.8 is "−20%", ×1.25 is "+25%", ×1 is "no change". */
export function percentChange(factor: number): string {
  const pct = Math.round((factor - 1) * 1000) / 10;
  if (pct === 0) return "no change";
  return `${pct < 0 ? MINUS : "+"}${Math.abs(pct)}%`;
}

const num = (v: number, digits = 2) => String(Math.round(v * 10 ** digits) / 10 ** digits);
const share = (v: number) => `${num(v * 100, 1)}%`;
const hours = (v: number) => `${num(v, 1)} h`;

/** One change in words, e.g. "Leads per week: 12", "Hands-on time on Check fit: −20%", "Strategist: 3 people". */
export function describeLeverChange(patch: ScenarioPatch, names: LeverNames = {}, currency = "GBP"): string {
  const { path, op, value } = patch;
  const multiply = op === "multiply";
  switch (path) {
    case "demand.leads_per_week":
      return `Leads per week: ${num(value)}`;
    case "demand.active_clients":
      return `Active clients: ${num(value, 0)}`;
    case "demand.churn_monthly":
      return `Monthly churn: ${share(value)}`;
    case "finances.retainer":
      return `Monthly retainer: ${formatWholeCurrency(value, currency)}`;
  }
  const m = /^(services|roles|people|steps)\.([^.]+)\.(price|headcount|fte|work_hours|wait_hours|rework_rate)$/.exec(path);
  if (!m) return "A change this version can't describe";
  const [, family, id, field] = m as unknown as [string, string, string, string];
  const change = (set: string) => (multiply ? percentChange(value) : set);
  switch (`${family}.${field}`) {
    case "services.price":
      return `Price of ${names.services?.[id] ?? "a service that has gone"}: ${formatWholeCurrency(value, currency)}`;
    case "roles.headcount":
      return `${names.roles?.[id] ?? "A role that has gone"}: ${num(value, 0)} ${value === 1 ? "person" : "people"}`;
    case "people.fte":
      return `Hours for ${names.people?.[id] ?? "a team member"}: ${num(value)} FTE`;
    case "steps.work_hours":
      return `Hands-on time on ${names.steps?.[id] ?? "a step that has gone"}: ${change(hours(value))}`;
    case "steps.wait_hours":
      return `Wait before ${names.steps?.[id] ?? "a step that has gone"}: ${change(hours(value))}`;
    case "steps.rework_rate":
      return `Rework on ${names.steps?.[id] ?? "a step that has gone"}: ${change(share(value))}`;
    default:
      return "A change this version can't describe";
  }
}

/** Every change, in words, in order. */
export const describeLeverChanges = (patches: readonly ScenarioPatch[], names: LeverNames = {}, currency = "GBP"): string[] => patches.map((p) => describeLeverChange(p, names, currency));
