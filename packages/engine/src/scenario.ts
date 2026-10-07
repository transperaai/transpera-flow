// Scenario patches (docs/PRD.md §4.1 "Levers and scenarios", §5, decision D10).
//
// A scenario is a list of patches `{path, op, value}` applied to the engine
// model *after* it has been built from the stored rows. Because patches act on
// the current baseline, a `multiply` patch keeps its meaning when the
// baseline is re-measured: halving a step that is re-measured from 6 h to 8 h
// gives 4 h, not the 3 h it gave before. `set` pins a fact (a head-count, a
// price, an FTE) whatever the baseline says.
//
// Stacking applies several scenarios' patches in order: every patch of the
// first scenario in its listed order, then the second's, and so on. Each patch
// acts on the result of the ones before it, so order matters when ops mix
// (×0.5 then +1 is not +1 then ×0.5).
//
// Paths use the stored rows' vocabulary and ids (`steps.<step_id>.work_hours`,
// `people.<person_id>.fte`; `health.late_penalty` for the workspace setting
// `health_late_penalty`), so a scenario means the same thing in the
// browser, on the server and in the database. A path whose target is missing
// (a deleted step, a person who left) is reported, never silently skipped.
//
// Framework-free and dependency-free, like the rest of the engine.

import type { EngineModel, EnginePerson, EngineStep } from "./model";
import { withClientGroups } from "./clients";
import { healthRules, servicingLinks, tasksPerWeek } from "./servicing";

/** Servicing tasks a week per servicing process from the roster's clients, in process id order. */
export function servicingTasksPerWeek(m: EngineModel): Map<string, number> {
  const out = new Map<string, number>();
  const roster = withClientGroups(m).clients;
  if (!roster) return out;
  for (const client of Object.values(roster)) {
    for (const sid of client.services) {
      const service = m.services?.[sid];
      if (!service) continue;
      for (const link of servicingLinks(m, service)) out.set(link.process, (out.get(link.process) ?? 0) + tasksPerWeek(link.recurrence));
    }
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export const PATCH_OPS = ["set", "multiply", "add"] as const;
export type PatchOp = (typeof PATCH_OPS)[number];

export interface ScenarioPatch {
  path: string;
  op: PatchOp;
  value: number;
}

/** A scenario as far as patching is concerned. */
export interface PatchSet {
  patch: ScenarioPatch[];
}

/** The most patches one scenario may hold (the database checks the same). */
export const MAX_PATCHES = 200;

/** Fields a patch can address, per collection. */
export const PATCH_FIELDS = {
  demand: ["leads_per_week", "active_clients", "churn_monthly"],
  finances: ["retainer"],
  services: ["price", "mix_share", "churn_health_sensitivity"],
  roles: ["headcount", "cost_rate", "ongoing_hours"],
  people: ["fte"],
  steps: ["work_hours", "wait_hours", "rework_rate"],
  /**
   * The workspace's health rules (docs/PRD.md §6.3.5, issue #79), stored as
   * `settings.health_<field>`: the starting health of a client with none
   * entered, and the health gained for a servicing task done on time and lost
   * for a late or a missed one.
   */
  health: ["initial", "recover", "late_penalty", "missed_penalty"],
} as const;

/** Highest value a health-rule patch may leave (health runs 0–100). */
export const MAX_HEALTH_RULE = 100;

/** Highest churn sensitivity a patch may leave (the app's limit for the field). */
export const MAX_CHURN_SENSITIVITY = 100;

/** The engine's name (`EngineHealthRules`) for each health-rule patch field. */
export const HEALTH_RULE_KEYS = { initial: "initial", recover: "recover", late_penalty: "latePenalty", missed_penalty: "missedPenalty" } as const;

/**
 * Symbolic targets resolved against the model when the patch is applied, so a
 * library scenario works in any workspace: `roles.@busiest` is the role with
 * the highest offered load per hour of capacity, `steps.@heaviest` the step
 * that takes the most hands-on hours per week (see `offeredLoad`).
 */
export const SELECTORS = { roles: ["@busiest"], steps: ["@heaviest"] } as const;

export type PatchTarget =
  | { kind: "demand"; field: (typeof PATCH_FIELDS.demand)[number] }
  | { kind: "finances"; field: (typeof PATCH_FIELDS.finances)[number] }
  | { kind: "health"; field: (typeof PATCH_FIELDS.health)[number] }
  | { kind: "services"; id: string; field: (typeof PATCH_FIELDS.services)[number] }
  | { kind: "roles"; id: string; field: (typeof PATCH_FIELDS.roles)[number] }
  | { kind: "people"; id: string; field: (typeof PATCH_FIELDS.people)[number] }
  | { kind: "steps"; id: string; field: (typeof PATCH_FIELDS.steps)[number] };

const has = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

/** Ids are opaque, but may not be empty, contain dots or start with `@` unless they are a known selector. */
const ID = /^[^.\s]{1,100}$/;

/** The target a path names, or null if the path isn't in the grammar. Does not check that the target exists. */
export function parsePatchPath(path: string): PatchTarget | null {
  const parts = path.split(".");
  if (parts.length === 2) {
    const [kind, field] = parts as [string, string];
    if (kind === "demand" && has(PATCH_FIELDS.demand, field)) return { kind, field };
    if (kind === "finances" && has(PATCH_FIELDS.finances, field)) return { kind, field };
    if (kind === "health" && has(PATCH_FIELDS.health, field)) return { kind, field };
    return null;
  }
  if (parts.length !== 3) return null;
  const [kind, id, field] = parts as [string, string, string];
  if (!ID.test(id)) return null;
  if (id.startsWith("@") && !(kind in SELECTORS && has(SELECTORS[kind as keyof typeof SELECTORS], id))) return null;
  if (kind === "services" && has(PATCH_FIELDS.services, field)) return { kind, id, field };
  if (kind === "roles" && has(PATCH_FIELDS.roles, field)) return { kind, id, field };
  if (kind === "people" && has(PATCH_FIELDS.people, field)) return { kind, id, field };
  if (kind === "steps" && has(PATCH_FIELDS.steps, field)) return { kind, id, field };
  return null;
}

export function isScenarioPatch(v: unknown): v is ScenarioPatch {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 3 || !keys.every((k) => k === "path" || k === "op" || k === "value")) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.path === "string" &&
    parsePatchPath(p.path) !== null &&
    typeof p.op === "string" &&
    has(PATCH_OPS, p.op) &&
    typeof p.value === "number" &&
    Number.isFinite(p.value)
  );
}

/**
 * Check the shape of a patch list from outside (a form, an API call, a jsonb
 * column): an array of at most `MAX_PATCHES` `{path, op, value}` objects with
 * paths in the grammar. It does not check that targets exist; `applyPatches`
 * reports those against a model.
 */
export function parsePatches(input: unknown): { ok: true; patches: ScenarioPatch[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Patches must be a list." };
  if (input.length > MAX_PATCHES) return { ok: false, error: `A scenario can hold at most ${MAX_PATCHES} changes.` };
  for (let i = 0; i < input.length; i++) {
    const p: unknown = input[i];
    if (!isScenarioPatch(p)) {
      const path = typeof p === "object" && p && "path" in p ? String((p as { path: unknown }).path) : "?";
      return { ok: false, error: `Change ${i + 1} (${path}) isn't a valid {path, op, value}.` };
    }
  }
  return { ok: true, patches: (input as ScenarioPatch[]).map(({ path, op, value }) => ({ path, op, value })) };
}

export type PatchProblem =
  /** Not in the path grammar, or not a number. */
  | "invalid"
  /** The step, role, person or service it names isn't in the model. */
  | "missing_target"
  /** The result was out of range (or not whole where it must be) and was brought into range. */
  | "clamped";

export interface PatchIssue {
  /** Index into the patches passed to `applyPatches`. */
  index: number;
  path: string;
  problem: PatchProblem;
  message: string;
}

export interface PatchedModel {
  model: EngineModel;
  issues: PatchIssue[];
}

/** Issues that make a scenario "needs attention": something it asks for could not be applied. */
export const isBlocking = (issue: PatchIssue) => issue.problem !== "clamped";

const combine = (current: number, op: PatchOp, value: number) =>
  op === "set" ? value : op === "multiply" ? current * value : current + value;

/** Highest rework probability a patch may leave (1 would repeat forever). */
export const MAX_REWORK = 0.95;

/** Id prefix of people a head-count patch adds. */
export const HIRE_PREFIX = "hire:";

/**
 * Apply patches to a copy of the model, in order. Invalid paths and missing
 * targets are skipped and reported; out-of-range results are clamped and
 * reported. The input model is not changed.
 */
export function applyPatches(model: EngineModel, patches: readonly ScenarioPatch[]): PatchedModel {
  const m: EngineModel = structuredClone(model);
  const issues: PatchIssue[] = [];

  patches.forEach((patch, index) => {
    const report = (problem: PatchProblem, message: string) => issues.push({ index, path: patch.path, problem, message });
    const target = typeof patch?.path === "string" ? parsePatchPath(patch.path) : null;
    if (!target || !has(PATCH_OPS, patch.op) || typeof patch.value !== "number" || !Number.isFinite(patch.value)) {
      report("invalid", `'${String(patch?.path)}' isn't a change Transpera Flow can make.`);
      return;
    }
    /** The new value, clamped to [min, max] (and to a whole number if asked), reporting any clamp. */
    const next = (current: number, min: number, max = Infinity, whole = false) => {
      const raw = combine(current, patch.op, patch.value);
      let v = Math.min(max, Math.max(min, raw));
      if (whole) v = Math.round(v);
      if (v !== raw) report("clamped", `${patch.path} would be ${round(raw)}; using ${round(v)}.`);
      return v;
    };

    switch (target.kind) {
      case "demand":
        if (target.field === "leads_per_week") m.leadsPerWeek = next(m.leadsPerWeek, 0);
        else if (target.field === "active_clients") m.activeClients = next(m.activeClients, 0, Infinity, true);
        else m.churnMonthly = next(m.churnMonthly, 0, 1);
        return;
      case "finances":
        m.retainer = next(m.retainer, 0);
        return;
      case "health": {
        // Acts on the rules in force: the workspace's, or the estimated defaults where it has none.
        const key = HEALTH_RULE_KEYS[target.field];
        m.health = { ...m.health, [key]: next(healthRules(m)[key], 0, MAX_HEALTH_RULE) };
        return;
      }
      case "services": {
        const svc = m.services?.[target.id];
        if (!svc) return report("missing_target", `There is no service '${target.id}'.`);
        if (target.field === "price") svc.price = next(svc.price, 0);
        else if (target.field === "mix_share") svc.mixShare = next(svc.mixShare, 0);
        else svc.churnSensitivity = next(svc.churnSensitivity ?? 0, 0, MAX_CHURN_SENSITIVITY);
        return;
      }
      case "roles": {
        const id = target.id.startsWith("@") ? busiestRole(m) : target.id;
        const role = id ? m.roles[id] : undefined;
        if (!id || !role) return report("missing_target", `There is no role '${target.id}'.`);
        if (target.field === "cost_rate") role.cost = next(role.cost, 0);
        else if (target.field === "ongoing_hours") role.ongoing = next(role.ongoing, 0);
        else setHeadcount(m, id, next(headcount(m, id), 0, Infinity, true), (msg) => report("clamped", msg));
        return;
      }
      case "people": {
        const person = m.people?.[target.id];
        if (!person) return report("missing_target", `There is no person '${target.id}'.`);
        const fte = next(person.capacity / m.hoursPerWeek, 0, 2);
        if (fte > 0) person.capacity = fte * m.hoursPerWeek;
        else if (pinnedSteps(m, target.id).length) {
          person.capacity = 0;
          report("clamped", `${person.name} is pinned to a step, so they stay in the model with no capacity of their own.`);
        } else delete m.people![target.id];
        return;
      }
      case "steps": {
        const id = target.id.startsWith("@") ? heaviestStep(m) : target.id;
        const step = id ? m.steps.find((s) => s.id === id) : undefined;
        if (!step) return report("missing_target", `There is no step '${target.id}'.`);
        if (target.field === "work_hours") scaleDuration(step, "work", next(step.work, 0));
        else if (target.field === "wait_hours") scaleDuration(step, "wait", next(step.wait, 0));
        else step.rework = next(step.rework, 0, MAX_REWORK);
        return;
      }
    }
  });
  return { model: m, issues };
}

/**
 * Stack scenarios: apply each one's patches in turn, first scenario first.
 * Issue indexes count across the concatenated list; `scenario` says whose.
 */
export function applyScenarios(
  model: EngineModel,
  scenarios: readonly PatchSet[],
): { model: EngineModel; issues: (PatchIssue & { scenario: number })[] } {
  const all = scenarios.flatMap((s) => s.patch);
  const owner = scenarios.flatMap((s, i) => s.patch.map(() => i));
  const { model: patched, issues } = applyPatches(model, all);
  return { model: patched, issues: issues.map((issue) => ({ ...issue, scenario: owner[issue.index]! })) };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** A duration's new mean; a triangular range scales with it so its mean moves the same way. */
function scaleDuration(step: EngineStep, phase: "work" | "wait", value: number) {
  const old = step[phase];
  step[phase] = value;
  const key = phase === "work" ? "workDist" : "waitDist";
  const dist = step[key];
  if (dist?.kind !== "triangular") return;
  if (old > 0) {
    const k = value / old;
    step[key] = { kind: "triangular", min: dist.min * k, mode: dist.mode * k, max: dist.max * k };
  } else {
    delete step[key];
  }
}

function pinnedSteps(m: EngineModel, personId: string) {
  return m.steps.filter((s) => s.person === personId);
}

/** People in a role: named people who hold it, or the role's head-count when the model has none. */
export function headcount(m: EngineModel, roleId: string): number {
  if (!m.people || !Object.keys(m.people).length) return m.roles[roleId]?.count ?? 0;
  return Object.values(m.people).filter((p) => p.roles.includes(roleId)).length;
}

/**
 * Change a role's head-count. Without named people this is the role's
 * `count`. With named people, hires are added as full-time people in the
 * role who can do every step of it ("New Strategist"); a reduction removes
 * earlier hires first, then people who hold only this role, last id first,
 * never someone a step is pinned to.
 */
function setHeadcount(m: EngineModel, roleId: string, target: number, warn: (msg: string) => void) {
  const role = m.roles[roleId]!;
  role.count = target;
  if (!m.people || !Object.keys(m.people).length) return;
  const people = m.people;
  const inRole = () => Object.keys(people).filter((id) => people[id]!.roles.includes(roleId));
  let current = inRole().length;
  let n = 0;
  while (current < target) {
    let id: string;
    do id = `${HIRE_PREFIX}${roleId}:${++n}`;
    while (people[id]);
    const hire: EnginePerson = { name: n === 1 ? `New ${role.name}` : `New ${role.name} ${n}`, roles: [roleId], capacity: m.hoursPerWeek };
    people[id] = hire;
    current++;
  }
  if (current > target) {
    const removable = inRole()
      .filter((id) => !pinnedSteps(m, id).length && (id.startsWith(HIRE_PREFIX) || people[id]!.roles.length === 1))
      .sort((a, b) => Number(b.startsWith(HIRE_PREFIX)) - Number(a.startsWith(HIRE_PREFIX)) || (a < b ? 1 : a > b ? -1 : 0));
    while (current > target && removable.length) {
      delete people[removable.shift()!];
      current--;
    }
    if (current > target) warn(`${role.name} can't go below ${current}: the others also hold other roles or are pinned to steps.`);
    role.count = current;
  }
}

// ---------------------------------------------------------------------------
// Offered load: a deterministic estimate from the model alone (no simulation),
// used to resolve selectors and to rank levers.
// ---------------------------------------------------------------------------

export interface OfferedLoad {
  /** Expected visits per arriving item, rework included. */
  visits: Record<string, number>;
  /** Hands-on hours per week each step asks for. */
  stepHours: Record<string, number>;
  /** Hours per week asked of each role (pipeline + ongoing client work) and the capacity it has. */
  roles: Record<string, { hours: number; capacity: number; load: number }>;
}

/** Expected visits to each step (by index) of one item entering at `entry`, rework left out. */
function visitsFrom(m: EngineModel, index: Map<string, number>, entry: string): number[] {
  // v = entry + Σ v(from) × p(from → to), by fixed-point iteration.
  let v = new Array<number>(m.steps.length).fill(0);
  for (let iter = 0; iter < 500; iter++) {
    const nv = new Array<number>(m.steps.length).fill(0);
    const e = index.get(entry);
    if (e !== undefined) nv[e] = 1;
    m.steps.forEach((s, i) => {
      for (const edge of s.next) {
        const j = index.get(edge.to);
        if (j !== undefined) nv[j]! += v[i]! * edge.p;
      }
    });
    const delta = nv.reduce((a, x, i) => a + Math.abs(x - v[i]!), 0);
    v = nv;
    if (delta < 1e-9) break;
  }
  return v;
}

export function offeredLoad(m: EngineModel): OfferedLoad {
  const index = new Map(m.steps.map((s, i) => [s.id, i]));
  const v = visitsFrom(m, index, m.entry);
  const visits: Record<string, number> = {};
  const stepHours: Record<string, number> = {};
  m.steps.forEach((s, i) => {
    const repeats = 1 / (1 - Math.min(s.rework, MAX_REWORK));
    visits[s.id] = v[i]! * repeats;
    // Role-level estimate at the role's normal time: per-person times (EnginePerson.capacityFactor, C6) are not applied here.
    stepHours[s.id] = s.role || s.person ? m.leadsPerWeek * visits[s.id]! * s.work : 0;
  });
  // Servicing tasks from the roster as it stands (docs/PRD.md §6.3.5): each
  // process's tasks a week times the visits one task makes to each step.
  const tasks = servicingTasksPerWeek(m);
  for (const [pid, rate] of tasks) {
    const sv = visitsFrom(m, index, m.servicingProcesses![pid]!.entry);
    m.steps.forEach((s, i) => {
      if (!(sv[i]! > 0) || !(s.role || s.person)) return;
      stepHours[s.id]! += (rate * sv[i]! * s.work) / (1 - Math.min(s.rework, MAX_REWORK));
    });
  }

  const roles: OfferedLoad["roles"] = {};
  const named = m.people && Object.keys(m.people).length ? m.people : null;
  for (const rid in m.roles) {
    const role = m.roles[rid]!;
    const capacity = named
      ? Object.values(named).reduce((a, p) => a + (p.roles.includes(rid) ? p.capacity / p.roles.length : 0), 0)
      : Math.max(1, role.count) * m.hoursPerWeek;
    roles[rid] = { hours: m.activeClients * (role.ongoing || 0), capacity, load: 0 };
  }
  for (const s of m.steps) {
    const rid = s.role ?? (s.person ? named?.[s.person]?.roles[0] : undefined);
    if (rid && roles[rid]) roles[rid].hours += stepHours[s.id]!;
  }
  for (const rid in roles) roles[rid]!.load = roles[rid]!.capacity > 0 ? roles[rid]!.hours / roles[rid]!.capacity : Infinity;
  return { visits, stepHours, roles };
}

/** The role with the highest offered load per hour of capacity (first by id on a tie). */
export function busiestRole(m: EngineModel): string | null {
  const { roles } = offeredLoad(m);
  let best: string | null = null;
  for (const rid of Object.keys(roles).sort()) if (best === null || roles[rid]!.load > roles[best]!.load) best = rid;
  return best;
}

/** The staffed step that takes the most hands-on hours per week (first by id on a tie). */
export function heaviestStep(m: EngineModel): string | null {
  const { stepHours } = offeredLoad(m);
  let best: string | null = null;
  for (const s of [...m.steps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!(s.role || s.person)) continue;
    if (best === null || stepHours[s.id]! > stepHours[best]!) best = s.id;
  }
  return best;
}
