// The lever panel, generated from the model (docs/PRD.md §4.1 "Levers and
// scenarios", decision D10). Each lever is one scenario patch: process
// parameters are relative (`multiply`, shown as ±%) so they keep their meaning
// when the step is re-measured; facts (demand, head-count, FTE, price) are
// absolute (`set`). A relative lever on a value of 0 would do nothing, so a
// wait or rework rate that is 0 today gets an absolute lever instead.
// No React here: the panel renders these, and tests check them directly.

import type { Viewer } from "@transpera-flow/db";
import { headcount, type EngineModel, type ScenarioPatch } from "@transpera-flow/engine";
import { ownRowsOnly, viewerOf } from "@/lib/viewer";

export type LeverGroup = "demand" | "people" | "process" | "clients" | "finances" | "market";
export type LeverUnit = "per_week" | "clients" | "share" | "money" | "people" | "fte" | "hours";

export interface Lever {
  /** The patch path; unique per lever. */
  path: string;
  group: LeverGroup;
  /** Sub-heading within the group: a step's name, "Roles" or "People". */
  section: string;
  label: string;
  op: "set" | "multiply";
  /** The value in the model the lever acts on (before the lever). */
  base: number;
  unit: LeverUnit;
  /** Slider bounds, in the lever's own terms: the value for `set`, the factor for `multiply`. */
  min: number;
  max: number;
  step: number;
}

export const GROUP_LABELS: Record<LeverGroup, string> = {
  demand: "Demand",
  people: "People",
  process: "Process",
  clients: "Clients and churn",
  finances: "Finances",
  market: "Market",
};

/** Relative levers run from −90% to +100%. */
const FACTOR = { min: 0.1, max: 2, step: 0.05 } as const;

const ceilTo = (v: number, step: number) => Math.ceil(v / step) * step;

export function buildLevers(model: EngineModel, viewer?: Viewer): Lever[] {
  const levers: Lever[] = [];
  const add = (l: Lever) => levers.push(l);

  // Demand
  add({
    path: "demand.leads_per_week",
    group: "demand",
    section: "Demand",
    label: "Leads per week",
    op: "set",
    base: model.leadsPerWeek,
    unit: "per_week",
    min: 0,
    max: Math.max(20, ceilTo(model.leadsPerWeek * 3, 5)),
    step: 0.5,
  });
  add({
    path: "demand.active_clients",
    group: "clients",
    section: "Clients",
    label: "Active clients",
    op: "set",
    base: model.activeClients,
    unit: "clients",
    min: 0,
    max: Math.max(20, ceilTo(model.activeClients * 2, 10)),
    step: 1,
  });
  add({
    path: "demand.churn_monthly",
    group: "clients",
    section: "Clients",
    label: "Monthly churn",
    op: "set",
    base: model.churnMonthly,
    unit: "share",
    min: 0,
    max: 0.2,
    step: 0.005,
  });

  // People: head-count per role, FTE per named person.
  for (const [id, role] of Object.entries(model.roles)) {
    const count = headcount(model, id);
    add({ path: `roles.${id}.headcount`, group: "people", section: "Roles", label: role.name, op: "set", base: count, unit: "people", min: 0, max: count + 5, step: 1 });
  }
  // A member or viewer gets a lever for their own person only (B1 2b).
  const seen = viewerOf({ viewer });
  for (const [id, person] of ownRowsOnly(seen, Object.entries(model.people ?? {}), ([pid]) => pid)) {
    add({
      path: `people.${id}.fte`,
      group: "people",
      section: "People",
      label: person.name,
      op: "set",
      base: Math.round((person.capacity / model.hoursPerWeek) * 100) / 100,
      unit: "fte",
      min: 0,
      max: 1.5,
      step: 0.1,
    });
  }

  // Process: per step, hands-on time, wait and rework.
  for (const step of model.steps) {
    const staffed = Boolean(step.role || step.person);
    const relative = (field: string, label: string, base: number) =>
      add({ path: `steps.${step.id}.${field}`, group: "process", section: step.name, label, op: "multiply", base, unit: field === "rework_rate" ? "share" : "hours", ...FACTOR });
    if (staffed && step.work > 0) relative("work_hours", "Hands-on time", step.work);
    if (step.wait > 0) relative("wait_hours", "Wait", step.wait);
    else if (staffed) add({ path: `steps.${step.id}.wait_hours`, group: "process", section: step.name, label: "Wait", op: "set", base: 0, unit: "hours", min: 0, max: 80, step: 1 });
    if (staffed && step.rework > 0) relative("rework_rate", "Rework", step.rework);
    else if (staffed)
      add({ path: `steps.${step.id}.rework_rate`, group: "process", section: step.name, label: "Rework", op: "set", base: 0, unit: "share", min: 0, max: 0.5, step: 0.01 });
  }

  // Finances: prices by service, or the single retainer.
  const services = Object.entries(model.services ?? {});
  if (services.length) {
    for (const [id, svc] of services) {
      add({ path: `services.${id}.price`, group: "finances", section: "Prices", label: svc.name, op: "set", base: svc.price, unit: "money", min: 0, max: Math.max(1000, ceilTo(svc.price * 3, 100)), step: 50 });
    }
  } else {
    add({ path: "finances.retainer", group: "finances", section: "Prices", label: "Monthly retainer", op: "set", base: model.retainer, unit: "money", min: 0, max: Math.max(1000, ceilTo(model.retainer * 3, 100)), step: 50 });
  }
  return levers;
}

/** Where a lever sits when it changes nothing. */
export const neutral = (lever: Lever) => (lever.op === "multiply" ? 1 : lever.base);

/** Lever positions by path; a lever with no entry is at neutral. */
export type LeverValues = Record<string, number>;

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** The patches the levers stand for: one per lever moved off neutral, in panel order. */
export function leverPatches(levers: readonly Lever[], values: LeverValues): ScenarioPatch[] {
  const out: ScenarioPatch[] = [];
  for (const lever of levers) {
    const v = values[lever.path];
    if (v === undefined || !Number.isFinite(v) || same(v, neutral(lever))) continue;
    out.push({ path: lever.path, op: lever.op, value: Math.round(v * 1e6) / 1e6 });
  }
  return out;
}

/** The value a lever gives, in the model's terms (for a relative lever, base × factor). */
export const leverResult = (lever: Lever, position: number) => (lever.op === "multiply" ? lever.base * position : position);
