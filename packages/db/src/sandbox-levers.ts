// The Sandbox's levers (docs/plans/sandbox-design.md, docs/plans/sandbox-p1-brief.md §2): ONE registry that says what a change
// is, where it may point, how it may be timed and how it reaches the engine. A scenario (`sandbox_scenarios.changes`) is a list
// of `SandboxChange`s; each names a lever by id.
//
// Adding a lever later is ONE entry in SANDBOX_LEVERS plus ONE row in `private.sandbox_levers()` (a `create or replace` in the
// migration that adds it) and, if it has a value rule beyond the sanity bounds, one `when` in `private.is_sandbox_change` and one
// `case` in `valueProblem` below. A test (sandbox-scenarios.test.ts) keeps the table and this registry equal and runs one table of
// cases through the SQL checks and `parseChanges`. A lever that is a patch also needs a `PATCH_FIELDS` field in the engine.
//
// Pure: no database, no React. Both apps/web and packages/mcp may import it.

import { parsePatchPath, type EngineModel, type PatchOp, type ScenarioPatch } from "@transpera-flow/engine";

export type SandboxLeverId = "A1" | "A6" | "B1" | "B2" | "B3" | "C1" | "C2" | "D1" | "D2" | "D3" | "D4" | "D5" | "E1" | "E2" | "E3" | "E6" | "X1" | "X2" | "X3";

/** One change: a lever, what it points at, and a value. With no `from` it applies to the whole run. */
export interface SandboxChange {
  id: string;
  lever: SandboxLeverId;
  target: string | null;
  op: PatchOp;
  value: number;
  /** "YYYY-MM" (from the 1st of the month), or "YYYY-MM-DD" (a Monday) for leave (D3). `until` is reserved for a later phase. */
  from?: string;
  /** Extras of one lever: a hire's name (D1). Later levers widen this. */
  params?: { name: string };
}

export type SandboxTarget = "none" | "service" | "service_or_none" | "role" | "person" | "step" | "solution" | "health_rule";
export type SandboxUnit = "per_week" | "clients" | "share" | "money" | "people" | "fte" | "hours" | "weeks" | "none";

export interface SandboxLever {
  id: SandboxLeverId;
  /** The design's groups; X = kept for migrated rows, never offered. */
  group: "A" | "B" | "C" | "D" | "E" | "X";
  label: string;
  description: string;
  target: SandboxTarget;
  selector?: "@busiest" | "@heaviest";
  /** Ops the database accepts. */
  ops: readonly PatchOp[];
  /** UI ranges per op (the app clamps; SQL only sanity-checks). The ops listed here are the ones the dialog offers. */
  range: Partial<Record<PatchOp, { min: number; max: number; step: number }>>;
  unit: SandboxUnit;
  /** Shown value = stored value × this (A1 is stored per week and entered per month). Default 1. */
  displayScale?: number;
  /** Can apply to the whole run (no `from`). Leave (D3) cannot. */
  wholeRun: boolean;
  /** How a change from a month reaches the engine; false: it cannot be timed. Later phases add "channel". */
  timed: false | "people" | "splice";
  timing?: "month" | "monday";
  /** Its timed months count toward the cap of 6 (each costs one more run). */
  capped: boolean;
  /** The whole-run patch (and the spliced segment's patch). */
  patchPath?: (target: string | null) => string;
  /** The people-over-time edit. */
  people?: "hire" | "leaver" | "leave" | "fte";
  /** A solution going live (E6). */
  solution?: true;
  /** Settings -> Levers hide-list id (LEVER_KIND_IDS); null: always shown. */
  kind: string | null;
  /** "individual": it stores one person's pay and must be read through a redacting reader before it ships (docs/plans/sandbox-p1-brief.md, "Pay"). */
  pay: "none" | "role" | "individual";
  /** False: runs when saved, never offered for a new change. */
  offered: boolean;
  /** Why it would not move the result in this model, or null (design suggestion 8). */
  applies?: (model: EngineModel) => string | null;
}

export const MAX_CHANGES = 200;
export const MAX_CHANGES_CHARS = 100_000;
export const MAX_SOLUTION_CHANGES = 4;
export const MAX_CHANGE_MONTHS = 6;
export const MAX_SCENARIO_NAME = 120;
export const MAX_SCENARIO_DESCRIPTION = 2000;
/** A workspace keeps at most this many: the restore's limit of 900 plus the library's 4, with room. */
export const MAX_SCENARIOS = 1000;
export const MAX_PARENT_DEPTH = 5;
export const MAX_HORIZON_MONTHS = 24;
/** A hire's FTE the database accepts, and the narrower range the dialog offers. */
export const HIRE_FTE = { accepted: { min: 0.1, max: 2 }, offered: { min: 0.1, max: 1.5 } } as const;

const WEEKS_PER_MONTH = 52 / 12;
const SPLICE = { timed: "splice", timing: "month", capped: true } as const;

/** A model with a client roster (named clients, or client groups with clients counted): the pooled client count and churn do nothing. */
function hasClientRoster(model: EngineModel): boolean {
  if (model.clients !== undefined) return true;
  return Object.values(model.clientGroups ?? {}).some((g) => g.count > 0);
}

const ROSTER_REASON = "Your clients are counted per service or by name, so this does nothing here. Change them in Settings, Clients.";

export const SANDBOX_LEVERS: readonly SandboxLever[] = [
  {
    id: "A1",
    group: "A",
    label: "Opportunities coming in",
    description: "How many opportunities arrive a month (the qualified leads, in total).",
    target: "none",
    ops: ["set", "multiply", "add"],
    range: { set: { min: 0, max: 10_000, step: 1 }, multiply: { min: 0, max: 5, step: 0.05 } },
    unit: "per_week",
    displayScale: WEEKS_PER_MONTH,
    wholeRun: true,
    ...SPLICE,
    patchPath: () => "demand.leads_per_week",
    kind: "demand.enquiries",
    pay: "none",
    offered: true,
  },
  {
    id: "A6",
    group: "A",
    label: "Traffic by type",
    description: "How opportunities split across service types, as percentages that add up to 100%. Set one type's share; the others keep their proportions to one another and share the rest.",
    target: "service",
    ops: ["set", "multiply", "add"],
    // Stored as the type's weight (a set patch on mix_share); the dialog shows and takes a percentage of all traffic and converts
    // (apps/web/src/lib/sandbox/traffic.ts). Only "set" is offered: a saved multiply or add still runs, as a weight.
    range: { set: { min: 0, max: 1000, step: 1 } },
    unit: "share",
    wholeRun: true,
    ...SPLICE,
    patchPath: (t) => `services.${t}.mix_share`,
    kind: null,
    pay: "none",
    offered: true,
    applies: (m) => (Object.keys(m.services ?? {}).length >= 2 ? null : "You need two or more service types to split traffic between them."),
  },
  {
    id: "B1",
    group: "B",
    label: "Clients on the book",
    description: "How many clients you start with.",
    target: "none",
    ops: ["set", "multiply", "add"],
    range: { set: { min: 0, max: 100_000, step: 1 } },
    unit: "clients",
    wholeRun: true,
    timed: false,
    capped: false,
    patchPath: () => "demand.active_clients",
    kind: "clients.count",
    pay: "none",
    offered: true,
    applies: (m) => (hasClientRoster(m) ? ROSTER_REASON : null),
  },
  {
    id: "B2",
    group: "B",
    label: "Fees",
    description: "What a new client pays each month, per service. Clients already on the book keep their fee.",
    target: "service_or_none",
    ops: ["set", "multiply", "add"],
    range: { set: { min: 0, max: 10_000_000, step: 50 }, multiply: { min: 0, max: 5, step: 0.05 } },
    unit: "money",
    wholeRun: true,
    ...SPLICE,
    patchPath: (t) => (t ? `services.${t}.price` : "finances.retainer"),
    kind: "finances.prices",
    pay: "none",
    offered: true,
  },
  {
    id: "B3",
    group: "B",
    label: "Base churn",
    description: "The chance a client leaves in a month when nothing is going wrong.",
    target: "none",
    ops: ["set", "multiply", "add"],
    range: { set: { min: 0, max: 1, step: 0.005 }, multiply: { min: 0, max: 5, step: 0.05 } },
    unit: "share",
    wholeRun: true,
    ...SPLICE,
    patchPath: () => "demand.churn_monthly",
    kind: "clients.churn",
    pay: "none",
    offered: true,
    applies: (m) => (hasClientRoster(m) ? ROSTER_REASON : null),
  },
  {
    id: "C1",
    group: "C",
    label: "Role cost",
    description: "What an hour of a role costs.",
    target: "role",
    selector: "@busiest",
    ops: ["set", "multiply", "add"],
    range: { set: { min: 0, max: 10_000, step: 1 }, multiply: { min: 0, max: 5, step: 0.05 } },
    unit: "money",
    wholeRun: true,
    ...SPLICE,
    patchPath: (t) => `roles.${t}.cost_rate`,
    kind: "finances.roleCost",
    // A role's rate, which every member already reads (roles.default_cost_rate). Nothing shown in phase 1 uses cost, so it is not offered yet.
    pay: "role",
    offered: false,
  },
  {
    id: "C2",
    group: "C",
    label: "Overheads a month",
    description: "Your fixed costs a month (rent, tools, insurance), which come off revenue with pay to give profit.",
    target: "none",
    ops: ["set", "multiply", "add"],
    range: { set: { min: 0, max: 100_000_000, step: 100 }, multiply: { min: 0, max: 5, step: 0.05 } },
    unit: "money",
    wholeRun: true,
    ...SPLICE,
    patchPath: () => "finances.overhead_monthly",
    // No Settings -> Levers kind: always shown.
    kind: null,
    pay: "none",
    offered: true,
  },
  {
    id: "D1",
    group: "D",
    label: "Hire",
    description: "A new person in a role, at an FTE, from a month.",
    target: "role",
    ops: ["set"],
    range: { set: { min: HIRE_FTE.offered.min, max: HIRE_FTE.offered.max, step: 0.1 } },
    unit: "fte",
    wholeRun: true,
    timed: "people",
    timing: "month",
    capped: false,
    people: "hire",
    kind: "people.starters",
    pay: "none",
    offered: true,
  },
  {
    id: "D2",
    group: "D",
    label: "Someone leaves",
    description: "A person stops working from a month.",
    target: "person",
    ops: ["set"],
    range: { set: { min: 0, max: 0, step: 1 } },
    unit: "none",
    wholeRun: true,
    timed: "people",
    timing: "month",
    capped: false,
    people: "leaver",
    kind: "people.headcount",
    pay: "none",
    offered: true,
  },
  {
    id: "D3",
    group: "D",
    label: "Leave",
    description: "Someone is away for whole weeks from a Monday.",
    target: "person",
    ops: ["set"],
    range: { set: { min: 1, max: 52, step: 1 } },
    unit: "weeks",
    wholeRun: false,
    timed: "people",
    timing: "monday",
    capped: false,
    people: "leave",
    kind: "people.leave",
    pay: "none",
    offered: true,
  },
  {
    id: "D4",
    group: "D",
    label: "FTE change",
    description: "A person's full-time equivalent, from a month.",
    target: "person",
    ops: ["set", "multiply", "add"],
    range: { set: { min: 0, max: 1.5, step: 0.1 }, multiply: { min: 0, max: 2, step: 0.05 } },
    unit: "fte",
    wholeRun: true,
    timed: "people",
    timing: "month",
    // It splits the person in two rows, but for someone pinned to a step or assigned clients it falls back to a splice, so it counts.
    capped: true,
    patchPath: (t) => `people.${t}.fte`,
    people: "fte",
    kind: "people.hours",
    pay: "none",
    offered: true,
  },
  {
    id: "D5",
    group: "D",
    label: "Headcount by role",
    description: "How many people do a role.",
    target: "role",
    selector: "@busiest",
    ops: ["set", "multiply", "add"],
    range: { set: { min: 0, max: 100, step: 1 }, add: { min: -20, max: 20, step: 1 } },
    unit: "people",
    wholeRun: true,
    ...SPLICE,
    patchPath: (t) => `roles.${t}.headcount`,
    kind: "people.headcount",
    pay: "none",
    offered: true,
  },
  {
    id: "E1",
    group: "E",
    label: "Step time",
    description: "Hands-on hours for a step.",
    target: "step",
    selector: "@heaviest",
    ops: ["set", "multiply", "add"],
    range: { multiply: { min: 0.1, max: 2, step: 0.05 }, set: { min: 0, max: 1000, step: 0.25 } },
    unit: "hours",
    wholeRun: true,
    ...SPLICE,
    patchPath: (t) => `steps.${t}.work_hours`,
    kind: "process.time",
    pay: "none",
    offered: true,
  },
  {
    id: "E2",
    group: "E",
    label: "Waiting time",
    description: "Time a step waits on someone outside (a client reply), in hours.",
    target: "step",
    selector: "@heaviest",
    ops: ["set", "multiply", "add"],
    range: { multiply: { min: 0.1, max: 2, step: 0.05 }, set: { min: 0, max: 80, step: 1 } },
    unit: "hours",
    wholeRun: true,
    ...SPLICE,
    patchPath: (t) => `steps.${t}.wait_hours`,
    kind: "process.wait",
    pay: "none",
    offered: true,
  },
  {
    id: "E3",
    group: "E",
    label: "Rework",
    description: "The chance a step is done again.",
    target: "step",
    selector: "@heaviest",
    ops: ["set", "multiply", "add"],
    range: { multiply: { min: 0.1, max: 2, step: 0.05 }, set: { min: 0, max: 0.95, step: 0.01 } },
    unit: "share",
    wholeRun: true,
    ...SPLICE,
    patchPath: (t) => `steps.${t}.rework_rate`,
    kind: "process.rework",
    pay: "none",
    offered: true,
  },
  {
    id: "E6",
    group: "E",
    label: "Solution goes live",
    description: "A saved solution (a changed process map) goes live from a month.",
    target: "solution",
    ops: ["set"],
    range: { set: { min: 1, max: 1, step: 1 } },
    unit: "none",
    wholeRun: true,
    ...SPLICE,
    solution: true,
    kind: null,
    pay: "none",
    offered: true,
  },
  // Kept for migrated rows: they run when saved and are never offered.
  {
    id: "X1",
    group: "X",
    label: "Client health rule",
    description: "A workspace health rule (starting health, recovery, late and missed penalties).",
    target: "health_rule",
    ops: ["set", "multiply", "add"],
    range: {},
    unit: "none",
    wholeRun: true,
    timed: false,
    capped: false,
    patchPath: (t) => `health.${t}`,
    kind: null,
    pay: "none",
    offered: false,
  },
  {
    id: "X2",
    group: "X",
    label: "Client hours per client",
    description: "Ongoing hours a client needs from a role each week.",
    target: "role",
    selector: "@busiest",
    ops: ["set", "multiply", "add"],
    range: {},
    unit: "hours",
    wholeRun: true,
    timed: false,
    capped: false,
    patchPath: (t) => `roles.${t}.ongoing_hours`,
    kind: null,
    pay: "none",
    offered: false,
  },
  {
    id: "X3",
    group: "X",
    label: "Churn sensitivity to health",
    description: "How much a client's health moves its chance of leaving.",
    target: "service",
    ops: ["set", "multiply", "add"],
    range: {},
    unit: "none",
    wholeRun: true,
    timed: false,
    capped: false,
    patchPath: (t) => `services.${t}.churn_health_sensitivity`,
    kind: null,
    pay: "none",
    offered: false,
  },
];

const LEVER_BY_ID = new Map<string, SandboxLever>(SANDBOX_LEVERS.map((l) => [l.id, l]));

/** The lever with this id, or undefined. */
export const sandboxLever = (id: string): SandboxLever | undefined => LEVER_BY_ID.get(id);

/** How the SQL table (`private.sandbox_levers().target`) names a lever's target class. */
export function sqlTargetClass(lever: SandboxLever): "none" | "id" | "id_or_none" | "health" {
  switch (lever.target) {
    case "none":
      return "none";
    case "service_or_none":
      return "id_or_none";
    case "health_rule":
      return "health";
    default:
      return "id";
  }
}

/** Levers a person may pick for a new change (offered, and not hidden in Settings -> Levers). */
export function offeredLevers(hiddenKinds: readonly string[] = []): SandboxLever[] {
  return SANDBOX_LEVERS.filter((l) => l.offered && (l.kind === null || !hiddenKinds.includes(l.kind)));
}

/** Is a saved change's lever kind hidden in Settings -> Levers? (It still applies; the Sandbox says so.) */
export function leverHidden(lever: SandboxLever, hiddenKinds: readonly string[]): boolean {
  return lever.kind !== null && hiddenKinds.includes(lever.kind);
}

// ---------------------------------------------------------------------------
// Patches <-> changes
// ---------------------------------------------------------------------------

/** The registry id and target a patch path means (the process page's sliders and the old scenarios), or null when it is in no lever. */
export function leverOfPath(path: string): { lever: SandboxLeverId; target: string | null } | null {
  const t = parsePatchPath(path);
  if (!t) return null;
  switch (t.kind) {
    case "demand":
      return { lever: t.field === "leads_per_week" ? "A1" : t.field === "active_clients" ? "B1" : "B3", target: null };
    case "finances":
      return { lever: t.field === "overhead_monthly" ? "C2" : "B2", target: null };
    case "health":
      return { lever: "X1", target: t.field };
    case "services":
      return { lever: t.field === "price" ? "B2" : t.field === "mix_share" ? "A6" : "X3", target: t.id };
    case "roles":
      return { lever: t.field === "headcount" ? "D5" : t.field === "cost_rate" ? "C1" : "X2", target: t.id };
    case "people":
      return { lever: "D4", target: t.id };
    case "steps":
      return { lever: t.field === "work_hours" ? "E1" : t.field === "wait_hours" ? "E2" : "E3", target: t.id };
  }
}

/** The whole-run patch of a change, or null for a lever that is not a patch (hire, leaver, leave, solution). */
export function patchOf(change: SandboxChange): ScenarioPatch | null {
  const lever = LEVER_BY_ID.get(change.lever);
  if (!lever?.patchPath) return null;
  return { path: lever.patchPath(change.target), op: change.op, value: change.value };
}

/** Patches as changes (whole run), in order. Throws on a path in no lever. `newId` makes each change id (a random uuid by default). */
export function changesFromPatch(patches: readonly ScenarioPatch[], newId: () => string = () => globalThis.crypto.randomUUID()): SandboxChange[] {
  return patches.map((p) => {
    const hit = leverOfPath(p.path);
    if (!hit) throw new Error(`No lever for the patch path ${p.path}`);
    return { id: newId(), lever: hit.lever, target: hit.target, op: p.op, value: p.value };
  });
}

/** Every change a patch can stand for: whole-run, a patch lever. The process page's saved scenarios are the ones that are all this. */
export const isPatchChange = (c: SandboxChange): boolean => c.from === undefined && patchOf(c) !== null;

// ---------------------------------------------------------------------------
// Checks (the mirror of private.is_sandbox_change / private.is_sandbox_changes)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$/;
const DATE_SHAPE = /^(20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$/;
const TARGET_ID = /^[^.\s]{1,100}$/;
const KEYS = new Set(["id", "lever", "target", "op", "value", "from", "params"]);
const HEALTH_RULES = new Set(["initial", "recover", "late_penalty", "missed_penalty"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A real calendar date in ISO form that falls on a Monday. */
export function isMonday(d: string): boolean {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const date = new Date(t);
  return date.toISOString().slice(0, 10) === d && date.getUTCDay() === 1;
}

/** The value rules beyond the sanity bound: the ones plans already enforced (docs/plans/sandbox-p1-brief.md §1). */
function valueProblem(lever: SandboxLever, value: number, op: PatchOp): boolean {
  switch (lever.id) {
    // Overheads can be set to, or multiplied by, nothing or more; an add may be a cut (the engine keeps the total at 0 or more).
    case "C2":
      return op !== "add" && value < 0;
    case "D1":
      return value < HIRE_FTE.accepted.min || value > HIRE_FTE.accepted.max;
    case "D2":
      return value !== 0;
    case "D3":
      return !Number.isInteger(value) || value < 1 || value > 52;
    case "E6":
      return value !== 1;
    default:
      return false;
  }
}

/** Why a single change is not valid (as `private.is_sandbox_change` judges it), or null when it is. */
export function changeProblem(c: unknown): string | null {
  const bad = "A change isn't valid.";
  if (!isObject(c)) return bad;
  if (Object.keys(c).some((k) => !KEYS.has(k))) return bad;
  if (typeof c.id !== "string" || !UUID.test(c.id)) return bad;
  const lever = typeof c.lever === "string" ? LEVER_BY_ID.get(c.lever) : undefined;
  if (!lever) return "A change names a lever that doesn't exist.";
  if (typeof c.op !== "string" || !(lever.ops as readonly string[]).includes(c.op)) return `${lever.label} can't be changed that way.`;
  if (typeof c.value !== "number" || !Number.isFinite(c.value) || Math.abs(c.value) > 1_000_000_000) return `${lever.label}: that value isn't valid.`;
  const target = c.target;
  const cls = sqlTargetClass(lever);
  if (target === undefined || target === null) {
    if (cls !== "none" && cls !== "id_or_none") return `${lever.label} needs something to point at.`;
  } else if (typeof target !== "string" || cls === "none") {
    return `${lever.label} doesn't point at anything.`;
  } else if (cls === "health") {
    if (!HEALTH_RULES.has(target)) return bad;
  } else if (target.startsWith("@")) {
    if (target !== lever.selector) return bad;
  } else if (!TARGET_ID.test(target)) return bad;
  if (!("from" in c)) {
    if (!lever.wholeRun) return `${lever.label} needs a start date.`;
  } else {
    if (lever.timed === false || typeof c.from !== "string") return `${lever.label} can't start from a month.`;
    if (lever.timing === "month" ? !MONTH.test(c.from) : !(DATE_SHAPE.test(c.from) && isMonday(c.from))) {
      return lever.timing === "month" ? `${lever.label}: the month isn't valid.` : `${lever.label} starts on a Monday.`;
    }
  }
  if (valueProblem(lever, c.value, c.op as PatchOp)) {
    return lever.id === "D1" ? "A hire's FTE must be between 0.1 and 2." : lever.id === "D3" ? "Leave lasts 1 to 52 whole weeks." : `${lever.label}: that value isn't valid.`;
  }
  if ("params" in c) {
    const p = c.params;
    if (lever.id !== "D1" || !isObject(p) || Object.keys(p).some((k) => k !== "name") || typeof p.name !== "string" || p.name.length < 1 || p.name.length > 120) {
      return "A name can have up to 120 characters.";
    }
  }
  return null;
}

/** Size of the list as the database counts it: `jsonb::text` has a space after every comma and colon. */
function jsonbSize(v: unknown): number {
  if (Array.isArray(v)) return 2 + v.reduce<number>((n, x) => n + jsonbSize(x), 0) + Math.max(0, v.length - 1) * 2;
  if (isObject(v)) {
    const keys = Object.keys(v);
    return 2 + keys.reduce((n, k) => n + new TextEncoder().encode(JSON.stringify(k)).length + 2 + jsonbSize(v[k]), 0) + Math.max(0, keys.length - 1) * 2;
  }
  return new TextEncoder().encode(JSON.stringify(v) ?? "null").length;
}

/** The distinct months (`from` values) of the changes whose levers are capped: each costs one extra run. */
export function cappedMonths(changes: readonly Pick<SandboxChange, "lever" | "from">[]): string[] {
  return [...new Set(changes.filter((c) => c.from !== undefined && LEVER_BY_ID.get(c.lever)?.capped).map((c) => c.from!))].sort();
}

/** Why a list of changes is not valid (as `private.is_sandbox_changes` judges it), or null when it is. */
export function changesProblem(input: unknown): string | null {
  if (!Array.isArray(input)) return "That scenario isn't valid.";
  if (input.length > MAX_CHANGES) return `A scenario can have up to ${MAX_CHANGES} changes.`;
  if (jsonbSize(input) > MAX_CHANGES_CHARS) return "That scenario is too big.";
  for (const c of input) {
    const p = changeProblem(c);
    if (p) return p;
  }
  const changes = input as SandboxChange[];
  if (new Set(changes.map((c) => c.id)).size !== changes.length) return "A change is repeated.";
  if (changes.filter((c) => c.lever === "E6").length > MAX_SOLUTION_CHANGES) return `A scenario can have up to ${MAX_SOLUTION_CHANGES} solutions.`;
  if (cappedMonths(changes).length > MAX_CHANGE_MONTHS) return `Changes can start from up to ${MAX_CHANGE_MONTHS} different months.`;
  return null;
}

/** A list of changes as typed, checked as the database checks it. */
export function parseChanges(input: unknown): { ok: true; changes: SandboxChange[] } | { ok: false; error: string } {
  const error = changesProblem(input);
  return error === null ? { ok: true, changes: input as SandboxChange[] } : { ok: false, error };
}

// ---------------------------------------------------------------------------
// The library every new workspace starts with (private.sandbox_library())
// ---------------------------------------------------------------------------

/** The four scenarios a new workspace is given. A test keeps this equal to `private.sandbox_library()`. Change ids never start with the restore's placeholder prefix. */
export const SANDBOX_LIBRARY: readonly { name: string; description: string; changes: readonly SandboxChange[] }[] = [
  {
    name: "Hire into the busiest role",
    description: "One more full-time person in the role with the most work for its capacity.",
    changes: [{ id: "5a0d1b00-0000-4000-8000-000000000001", lever: "D5", target: "@busiest", op: "add", value: 1 }],
  },
  {
    name: "Automate the heaviest step",
    description: "Hands-on time down 60% on the step that takes the most hours each week, as automation or templates would.",
    changes: [{ id: "5a0d1b00-0000-4000-8000-000000000002", lever: "E1", target: "@heaviest", op: "multiply", value: 0.4 }],
  },
  {
    name: "More leads",
    description: "25% more leads every week.",
    changes: [{ id: "5a0d1b00-0000-4000-8000-000000000003", lever: "A1", target: null, op: "multiply", value: 1.25 }],
  },
  {
    name: "Downturn",
    description: "30% fewer leads a week, and client churn up by half.",
    changes: [
      { id: "5a0d1b00-0000-4000-8000-000000000004", lever: "A1", target: null, op: "multiply", value: 0.7 },
      { id: "5a0d1b00-0000-4000-8000-000000000005", lever: "B3", target: null, op: "multiply", value: 1.5 },
    ],
  },
];

/** A name as the database compares it for uniqueness: trimmed, lower case. */
export const nameKey = (name: string): string => name.trim().toLowerCase();

/** `name`, or `name (2)`, `name (3)`, ... when its key is taken; cut so the whole stays within 120 characters. The result's key is added to `taken`. */
export function uniqueName(name: string, taken: Set<string>): string {
  const base = name.trim();
  let candidate = base;
  for (let n = 2; taken.has(nameKey(candidate)); n++) candidate = `${base.slice(0, MAX_SCENARIO_NAME - ` (${n})`.length)} (${n})`;
  taken.add(nameKey(candidate));
  return candidate;
}

/** The changes without their ids: how the restore tells a library scenario from one that only has its name (ids differ between workspaces migrated and seeded). */
export const changesWithoutIds = (changes: readonly SandboxChange[]): unknown[] => changes.map(({ id: _id, ...rest }) => rest);
