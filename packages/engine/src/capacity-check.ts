// The input check for the capacity fields (docs/adr/0022-capacity-inputs.md): names what is wrong in plain English, the way
// broken.ts names a broken scenario. Pure and deterministic. It is not wired into `simulate`: P2 decides where it runs (the
// app before a run, the MCP tools, the editor's "missing for simulation" list). A model with none of the capacity fields set
// has no problems.

import type { EngineModel } from "./model";

export type CapacityProblemCode =
  | "bad_number"
  | "split_not_one"
  | "adoption_out_of_range"
  | "change_unknown_step"
  | "augmentation_slower"
  | "portfolio_over_count"
  | "manager_step_without_role"
  | "driver_without_deliverables";

/** One thing wrong with the capacity inputs. */
export interface CapacityProblem {
  code: CapacityProblemCode;
  /** Where, as a path a person can find: `services.orgT1.deliverables.words`. */
  where: string;
  /** What is wrong and what to do, in plain English. */
  message: string;
}

/** How far a split's shares may be from adding to 1. */
export const SPLIT_TOLERANCE = 0.001;

/** Everything wrong with the capacity inputs of a model, in a stable order (services, clients, people, roles, steps, changes). */
export function checkCapacityInputs(model: EngineModel): CapacityProblem[] {
  const out: CapacityProblem[] = [];
  const add = (code: CapacityProblemCode, where: string, message: string) => out.push({ code, where, message });

  /** A number that must be finite, at least `min` and, when given, at most `max`. Unset is fine. */
  const num = (where: string, what: string, v: number | undefined, min = 0, max = Infinity) => {
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) add("bad_number", where, `${what} isn't a number. Enter a value${max !== Infinity ? ` from ${min} to ${max}` : ""}.`);
    else if (v < min) add("bad_number", where, `${what} is ${v}, which is below ${min}. Enter ${min} or more.`);
    else if (v > max) add("bad_number", where, `${what} is ${v}, which is above ${max}. Enter ${max} or less.`);
  };

  const stepIds = new Set(model.steps.map((s) => s.id));
  const services = model.services ?? {};

  for (const [id, sv] of Object.entries(services)) {
    const at = `services.${id}`;
    for (const [k, v] of Object.entries(sv.deliverables ?? {})) num(`${at}.deliverables.${k}`, `${sv.name}: ${k}`, v);
    num(`${at}.adhoc.chance`, `${sv.name}: the chance of an ad-hoc request`, sv.adhoc?.chance, 0, 1);
    num(`${at}.adhoc.requests`, `${sv.name}: requests from a client who asks`, sv.adhoc?.requests);
    for (const [i, link] of (sv.servicing ?? []).entries()) {
      const r = link.recurrence;
      if (!("driver" in r)) continue;
      const lat = `${at}.servicing.${i}.recurrence`;
      num(`${lat}.perMonth`, `${sv.name}: tasks a month per ${r.driver}`, r.perMonth);
      if (r.per !== undefined && !(Number.isFinite(r.per) && r.per > 0)) add("bad_number", `${lat}.per`, `${sv.name}: "per" must be above 0 (words use 1000).`);
      if (r.driver === "adhoc" ? sv.adhoc === undefined : sv.deliverables === undefined) {
        add(
          "driver_without_deliverables",
          lat,
          r.driver === "adhoc"
            ? `${sv.name} has a servicing step driven by ad-hoc requests, but no ad-hoc chance or requests are set for it. Set them, or the step makes no tasks.`
            : `${sv.name} has a servicing step driven by ${r.driver}, but the service has no deliverables. Set them, or the step makes no tasks.`,
        );
      }
    }
  }

  for (const [id, c] of Object.entries(model.clients ?? {})) {
    const at = `clients.${id}`;
    const o = c.overrides;
    if (o) {
      for (const [k, v] of Object.entries(o)) {
        if (k === "stepFactor") continue;
        num(`${at}.overrides.${k}`, `${c.name}: ${k}`, v as number | undefined, 0, k === "adhocChance" ? 1 : Infinity);
      }
      if (typeof o.stepFactor === "number") num(`${at}.overrides.stepFactor`, `${c.name}: the time factor on every step`, o.stepFactor);
      else for (const [stepId, v] of Object.entries(o.stepFactor ?? {})) num(`${at}.overrides.stepFactor.${stepId}`, `${c.name}: the time factor on ${stepId}`, v);
    }
    for (const [role, v] of Object.entries(c.handHoldingHours ?? {})) num(`${at}.handHoldingHours.${role}`, `${c.name}: hand-holding hours for ${role}`, v);
  }

  const groups = model.clientGroups ?? {};
  for (const [id, p] of Object.entries(model.people ?? {})) {
    const at = `people.${id}`;
    num(`${at}.reservedShare`, `${p.name}: team time`, p.reservedShare, 0, 1);
    for (const [i, v] of (p.ramp ?? []).entries()) num(`${at}.ramp.${i}`, `${p.name}: ramp month ${i + 1}`, v, 0, 1);
    for (const [sid, v] of Object.entries(p.portfolio ?? {})) num(`${at}.portfolio.${sid}`, `${p.name}: clients on ${services[sid]?.name ?? sid}`, v);
  }
  for (const [sid, g] of Object.entries(groups)) {
    const count = Math.round(g.count);
    let sum = 0;
    const holders: string[] = [];
    for (const p of Object.values(model.people ?? {})) {
      const n = p.portfolio?.[sid];
      if (n !== undefined && Number.isFinite(n) && n > 0) {
        sum += n;
        holders.push(`${p.name} ${n}`);
      }
    }
    if (sum > count) {
      add("portfolio_over_count", `clientGroups.${sid}`, `People hold ${sum} ${services[sid]?.name ?? sid} clients between them (${holders.join(", ")}), but only ${count} are counted. Lower someone's number or raise the count.`);
    }
  }

  for (const [id, r] of Object.entries(model.roles)) {
    if (r.unit) num(`roles.${id}.unit.perHour`, `${r.name}: ${r.unit.label} an hour`, r.unit.perHour, 0);
  }

  for (const s of model.steps) {
    const at = `steps.${s.id}`;
    num(`${at}.work`, `${s.name}: hands-on time`, s.work);
    if (s.split) {
      const { automatable: a, augmentable: g, manual: m } = s.split;
      num(`${at}.split.automatable`, `${s.name}: the automatable share`, a, 0, 1);
      num(`${at}.split.augmentable`, `${s.name}: the augmentable share`, g, 0, 1);
      num(`${at}.split.manual`, `${s.name}: the manual share`, m, 0, 1);
      if ([a, g, m].every((v) => Number.isFinite(v)) && Math.abs(a + g + m - 1) > SPLIT_TOLERANCE) {
        add("split_not_one", `${at}.split`, `${s.name}: the work split adds up to ${round(a + g + m)}, not 1 (automatable ${a}, augmentable ${g}, manual ${m}). Make the three shares add to 100%.`);
      }
    }
    for (const [tier, v] of Object.entries(s.tierMultiplier ?? {})) num(`${at}.tierMultiplier.${tier}`, `${s.name}: the ${tier} multiplier`, v);
    if (s.toClientManager && s.role === null) {
      add("manager_step_without_role", at, `${s.name} goes to the client's manager but has no role. Give it the role it falls back to when a client has no manager, or turn the setting off.`);
    }
  }

  for (const [i, c] of (model.changes ?? []).entries()) {
    const at = `changes.${i}`;
    if (!Number.isFinite(c.adoption) || c.adoption < 0 || c.adoption > 1) {
      add("adoption_out_of_range", `${at}.adoption`, `${c.name}: adoption is ${c.adoption}. Enter a share from 0 to 1 (0.8 is 80%).`);
    }
    if (!Number.isFinite(c.startMonth) || c.startMonth < 1) add("bad_number", `${at}.startMonth`, `${c.name}: the start month is ${c.startMonth}. Months count from 1.`);
    num(`${at}.rampMonths`, `${c.name}: months to full effect`, c.rampMonths);
    for (const [j, e] of c.effects.entries()) {
      const eat = `${at}.effects.${j}`;
      if (!stepIds.has(e.step)) add("change_unknown_step", `${eat}.step`, `${c.name} acts on step "${e.step}", which isn't in the model. Point it at a step that exists, or remove the effect.`);
      if (e.part === "automatable") {
        num(`${eat}.remove`, `${c.name}: the share it removes`, e.remove, 0, 1);
        num(`${eat}.residualHours`, `${c.name}: the time left for checking`, e.residualHours);
      } else if (!Number.isFinite(e.factor)) add("bad_number", `${eat}.factor`, `${c.name}: the speed-up factor isn't a number.`);
      else if (e.factor < 1) add("augmentation_slower", `${eat}.factor`, `${c.name}: an augmentation with a factor of ${e.factor} would slow the step down. Use 1 or more (1.5 is 50% faster).`);
    }
  }

  return out;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * What the web layer shows before a run (P5): everything wrong with the model's capacity inputs, in plain English. `simulate`
 * doesn't throw on these and doesn't call this: a run with a problem still runs, on the value the engine can use (a malformed
 * number counts as 0, a portfolio above the count is cut off at the count). The web layer decides what to do with them.
 */
export function capacityProblems(model: EngineModel): CapacityProblem[] {
  return checkCapacityInputs(model);
}
