// What the Sandbox's phase 3 levers do to the bundle and the model before a run (docs/plans/sandbox-p3-brief.md §5.4). Pure: no React, no
// database. Whole-run changes only; the same levers from a month are channels (./channels.ts).
//
//   * `applyBundleChanges`: a lead source's volume (A1 for one source) is a row of the bundle, so it is changed before the model is built.
//   * `applyModelChanges`: on the engine model after the patches, in change order: clients on the book and base churn for clients counted
//     per service or by name (B1, B3: the pooled count and churn do nothing there), a client value range (A5), a churn driver as a chance
//     (B4), and the price driver switched on for a price rise (B5, so the rise carries its churn).

import { qualifiedLeadsPerWeek } from "../model";
import { sandboxLever, type SandboxChange } from "../sandbox-levers";
import type { ProcessBundle } from "../types";
import {
  CUSTOM_DRIVER_PREFIX,
  DEFAULT_HEALTH_RULES,
  EFFECT_MONTHS,
  MAX_GROUP_CLIENTS,
  healthRules,
  type EngineChurnDriver,
  type EngineClient,
  type EngineClientGroup,
  type EngineModel,
} from "@transpera-flow/engine";
import type { ChangeProblem } from "./run";

/** `current` after an op: set to, multiplied by, or added to. */
export const combine = (current: number, op: SandboxChange["op"], value: number): number => (op === "set" ? value : op === "multiply" ? current * value : current + value);

/** A model with a client roster: clients named, or counted per service with any clients counted (the pooled count and churn do nothing there). */
export function hasClientRoster(model: Pick<EngineModel, "clients" | "clientGroups">): boolean {
  if (model.clients !== undefined) return true;
  return Object.values(model.clientGroups ?? {}).some((g) => g.count > 0);
}

/** Built-in drivers with no events: an effect on them does nothing. */
const NO_EVENTS = new Set(["tenure", "market"]);

const BASE_PROBLEM = "Pick a type to set this for: setting a number for every type at once isn't meaningful.";

/**
 * The bundle with the whole-run changes that are rows of it: a lead source's volume (A1 with a source). A source that is gone is
 * skipped and listed. Changes from a month are channels (./channels.ts).
 */
export function applyBundleChanges(bundle: ProcessBundle, changes: readonly SandboxChange[]): { bundle: ProcessBundle; problems: ChangeProblem[] } {
  const problems: ChangeProblem[] = [];
  let sources = bundle.leadSources;
  for (const c of changes) {
    if (c.lever !== "A1" || c.target === null || c.from !== undefined) continue;
    const list = sources ?? [];
    const at = list.findIndex((s) => s.id === c.target);
    if (at < 0) {
      problems.push({ changeId: c.id, message: "A lead source in this scenario is no longer there" });
      continue;
    }
    sources = list.map((s, i) => (i === at ? { ...s, volume_week: Math.max(0, combine(Number(s.volume_week), c.op, c.value)) } : s));
  }
  return { bundle: sources === bundle.leadSources ? bundle : { ...bundle, leadSources: sources }, problems };
}

/** The qualified leads a week one lead source brings (volume × conversion). */
export const sourceLeads = (s: { volume_week: number; conversion_to_qualified: number }): number => Number(s.volume_week) * Number(s.conversion_to_qualified);

/** All the bundle's qualified leads a week, or null with no lead sources. */
export const totalLeads = (bundle: Pick<ProcessBundle, "leadSources">): number | null => qualifiedLeadsPerWeek(bundle.leadSources ?? []);

/** The group a type would have if it had none yet: its price, base churn, stay and the starting health. */
function groupFrom(model: EngineModel, sid: string): EngineClientGroup {
  const sv = model.services![sid]!;
  return { count: 0, fee: sv.price, churnMonthly: sv.churnMonthly, stayMonths: sv.tenureMonths, health: healthRules(model).initial ?? DEFAULT_HEALTH_RULES.initial };
}

/** How many named clients take a type, active in the model. */
const namedCount = (model: EngineModel, sid: string): number => Object.values(model.clients ?? {}).filter((c) => c.services.includes(sid)).length;

/**
 * B1 on a roster: clients counted per service change their `count` (0 to 2,000, whole); named clients can only be added, as synthetic
 * average clients of the type (the mean fee and health of its named clients, or the type's price and the starting health), who are
 * shared out by role like group clients. Taking named clients away is refused: make them inactive in Settings, Clients.
 */
function clientsOnTheBook(model: EngineModel, c: SandboxChange, problems: ChangeProblem[]): EngineModel {
  if (!hasClientRoster(model)) {
    problems.push({ changeId: c.id, message: "Your clients are counted as one pool, so there is no type to point at. Count them per service in Settings, Clients." });
    return model;
  }
  const services = model.services ?? {};
  if (c.target !== null && !(c.target in services)) {
    problems.push({ changeId: c.id, message: "A service in this scenario is no longer there" });
    return model;
  }
  if (c.target === null && c.op === "set") {
    problems.push({ changeId: c.id, message: BASE_PROBLEM });
    return model;
  }
  const groups = model.clientGroups;
  if (groups && Object.values(groups).some((g) => g.count > 0)) {
    const next: Record<string, EngineClientGroup> = { ...groups };
    for (const sid of c.target !== null ? [c.target] : Object.keys(groups)) {
      const g = next[sid] ?? groupFrom(model, sid);
      const count = Math.min(MAX_GROUP_CLIENTS, Math.max(0, Math.round(combine(g.count, c.op, c.value))));
      next[sid] = { ...g, count };
    }
    return { ...model, clientGroups: next, activeClients: Object.values(next).reduce((a, g) => a + g.count, 0) };
  }
  // Named clients: only add.
  const clients: Record<string, EngineClient> = { ...model.clients };
  let refused = false;
  for (const sid of c.target !== null ? [c.target] : Object.keys(services)) {
    const have = namedCount(model, sid);
    const want = Math.min(MAX_GROUP_CLIENTS, Math.max(0, Math.round(combine(have, c.op, c.value))));
    if (want < have) {
      refused = true;
      continue;
    }
    const mine = Object.values(model.clients ?? {}).filter((x) => x.services.includes(sid));
    const mrr = mine.length ? mine.reduce((a, x) => a + (Number(x.mrr) || 0), 0) / mine.length : services[sid]!.price;
    const health = mine.length ? mine.reduce((a, x) => a + (x.health ?? healthRules(model).initial), 0) / mine.length : healthRules(model).initial;
    for (let i = 1; i <= want - have; i++) {
      clients[c.target !== null ? `sandbox:${c.id}:${i}` : `sandbox:${c.id}:${sid}:${i}`] = { name: `${services[sid]!.name} (added) ${i}`, services: [sid], mrr, health, assignments: {} };
    }
  }
  if (refused) problems.push({ changeId: c.id, message: "Named clients can't be removed here: make them inactive in Settings, Clients." });
  return { ...model, clients, activeClients: Object.keys(clients).length };
}

/** B3 on a roster: the base churn of the clients counted per service, or of a type's named clients; a type, or every type. */
function baseChurn(model: EngineModel, c: SandboxChange, problems: ChangeProblem[]): EngineModel {
  const services = model.services ?? {};
  if (c.target !== null && !(c.target in services)) {
    problems.push({ changeId: c.id, message: "A service in this scenario is no longer there" });
    return model;
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const ids = c.target !== null ? [c.target] : Object.keys(services);
  const nextServices = { ...services };
  for (const sid of ids) nextServices[sid] = { ...nextServices[sid]!, churnMonthly: clamp(combine(services[sid]!.churnMonthly, c.op, c.value)) };
  let groups = model.clientGroups;
  if (groups) {
    groups = { ...groups };
    for (const sid of ids) if (groups[sid]) groups[sid] = { ...groups[sid]!, churnMonthly: clamp(combine(groups[sid]!.churnMonthly, c.op, c.value)) };
  }
  return { ...model, services: nextServices, ...(groups ? { clientGroups: groups } : {}) };
}

/** The driver `id` as the model has it (or its default, switched on). */
function driverEntry(model: EngineModel, id: string): { drivers: EngineChurnDriver[]; at: number } {
  const drivers = [...(model.churnDrivers ?? [])];
  let at = drivers.findIndex((d) => d.id === id);
  if (at < 0) {
    at = drivers.length;
    drivers.push({ id, weight: 1, enabled: true });
  }
  return { drivers, at };
}

/** Whether a churn driver id names a driver the workspace has: a built-in, or one of your own that is still there. */
export function driverExists(model: EngineModel, bundle: Pick<ProcessBundle, "churnDrivers">, id: string): boolean {
  if (!id.startsWith(CUSTOM_DRIVER_PREFIX)) return ["late", "resp", "onb", "rework", "load", "handoff", "results", "tenure", "price", "market"].includes(id);
  return (model.churnDrivers ?? []).some((d) => d.id === id) || (bundle.churnDrivers ?? []).some((d) => `${CUSTOM_DRIVER_PREFIX}${d.id}` === id);
}

/** The price driver on for a rise (so it carries its churn), unless it is already in chance mode (the user's own setting then stands). */
export function withPriceDriver(model: EngineModel): EngineModel {
  const current = model.churnDrivers?.find((d) => d.id === "price");
  if (current && current.effect !== undefined && current.effect !== null) return model;
  if (current?.enabled) return model;
  const { drivers, at } = driverEntry(model, "price");
  drivers[at] = { ...drivers[at]!, enabled: true };
  return { ...model, churnDrivers: drivers };
}

/**
 * The model with the whole-run changes that are edits of it, in change order (a parent's first). A change whose target is gone is
 * skipped and listed. `bundle` supplies what the model lacks (your own drivers).
 */
export function applyModelChanges(
  model: EngineModel,
  changes: readonly SandboxChange[],
  bundle: Pick<ProcessBundle, "churnDrivers">,
  /** The price driver on although these changes hold no price rise: the without-rise run of a price rise's pair, which must differ from the scenario only by the rise. */
  forcePriceDriver = false,
): { model: EngineModel; problems: ChangeProblem[] } {
  const problems: ChangeProblem[] = [];
  // A price rise (any time) switches the price driver on, so the rise carries its churn; first, so the driver is the same in a pair's two runs.
  let m = forcePriceDriver || changes.some((c) => c.lever === "B5") ? withPriceDriver(model) : model;
  for (const c of changes) {
    const lever = sandboxLever(c.lever);
    if (!lever) continue;
    if (c.from !== undefined) continue;
    switch (c.lever) {
      case "B1":
        // A pooled model's count is a patch (applyPatches); a type or a roster is an edit.
        if (c.target !== null || hasClientRoster(m)) m = clientsOnTheBook(m, c, problems);
        break;
      case "B3":
        if (hasClientRoster(m) || c.target !== null) m = baseChurn(m, c, problems);
        break;
      case "A5": {
        const sv = m.services?.[c.target ?? ""];
        const low = c.params?.low ?? c.value;
        const high = c.params?.high ?? c.value;
        if (!sv) {
          problems.push({ changeId: c.id, message: "A service in this scenario is no longer there" });
          break;
        }
        const rest = { ...sv };
        delete rest.priceRange;
        m = { ...m, services: { ...m.services, [c.target!]: { ...rest, price: c.value, ...(low < c.value || high > c.value ? { priceRange: { low, high } } : {}) } } };
        break;
      }
      case "B4": {
        const id = c.target ?? "";
        if (NO_EVENTS.has(id)) {
          problems.push({ changeId: c.id, message: "Early tenure and market conditions don't have chances: change their weight in Settings." });
          break;
        }
        if (!driverExists(m, bundle, id)) {
          problems.push({ changeId: c.id, message: "A churn driver in this scenario is no longer there" });
          break;
        }
        const { drivers, at } = driverEntry(m, id);
        drivers[at] = { ...drivers[at]!, enabled: true, chance: c.params?.chance ?? null, effect: c.value, effectMonths: c.params?.months ?? EFFECT_MONTHS.default };
        m = { ...m, churnDrivers: drivers };
        break;
      }
    }
  }
  return { model: m, problems };
}
