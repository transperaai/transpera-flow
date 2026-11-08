// What this process takes, in hours a month (Q3 item 5): the headline of the process page's Supporting data, who carries the work (by
// role, then by person), and the heaviest steps. All of it reads `SimulationResult.personTime.stepHours` (mean hands-on hours a month
// per person per step) over this process's steps, from a run with `personTime` on. Pure.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";

export interface StepSplitShares {
  automatable: number;
  augmentable: number;
  manual: number;
}

export interface PersonHours {
  id: string;
  name: string;
  hours: number;
}

export interface RoleHours {
  /** The role id, or null for hours by someone with no role. */
  id: string | null;
  label: string;
  hours: number;
  /** Largest first. */
  people: PersonHours[];
}

export interface StepHours {
  id: string;
  label: string;
  hours: number;
  split: StepSplitShares | null;
}

export interface ProcessHours {
  /** Hours a month, all roles and people. */
  total: number;
  /** Largest first. */
  roles: RoleHours[];
  /** Largest first. */
  steps: StepHours[];
  /** Hours a month by role and step, over this process's steps. */
  cells: { personId: string; stepId: string; roleId: string | null; hours: number }[];
}

/** The role an hour counts under: the step's, else the person's first role, else none. */
function roleOfHour(model: EngineModel, stepId: string, personId: string): string | null {
  const step = model.steps.find((s) => s.id === stepId);
  return step?.role ?? model.people?.[personId]?.roles[0] ?? null;
}

/** The hours this process's steps take a month. Null while there is no run, or the run was not asked for `personTime`. */
export function processHours(model: EngineModel, result: SimulationResult | null, stepIds: ReadonlySet<string>): ProcessHours | null {
  const table = result?.personTime?.stepHours;
  if (!result || !table) return null;
  const steps = new Map(model.steps.map((s) => [s.id, s]));
  const cells: ProcessHours["cells"] = [];
  for (const [personId, byStep] of Object.entries(table)) {
    for (const [stepId, hours] of Object.entries(byStep)) {
      if (hours > 0 && stepIds.has(stepId) && steps.has(stepId)) cells.push({ personId, stepId, roleId: roleOfHour(model, stepId, personId), hours });
    }
  }
  const nameOf = (id: string) => result.resolvedPeople[id]?.name ?? model.people?.[id]?.name ?? id;
  const byRole = new Map<string | null, Map<string, number>>();
  const byStep = new Map<string, number>();
  for (const c of cells) {
    const people = byRole.get(c.roleId) ?? new Map<string, number>();
    people.set(c.personId, (people.get(c.personId) ?? 0) + c.hours);
    byRole.set(c.roleId, people);
    byStep.set(c.stepId, (byStep.get(c.stepId) ?? 0) + c.hours);
  }
  const roles: RoleHours[] = [...byRole.entries()].map(([id, people]) => {
    const list = [...people.entries()].map(([pid, hours]) => ({ id: pid, name: nameOf(pid), hours })).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
    return { id, label: id ? (model.roles[id]?.name ?? "A removed role") : "No role", hours: list.reduce((s, p) => s + p.hours, 0), people: list };
  });
  roles.sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label));
  const stepRows: StepHours[] = [...byStep.entries()]
    .map(([id, hours]) => ({ id, label: steps.get(id)!.name, hours, split: steps.get(id)!.split ?? null }))
    .sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label));
  return { total: cells.reduce((s, c) => s + c.hours, 0), roles, steps: stepRows, cells };
}

// ---------------------------------------------------------------------------
// The headline
// ---------------------------------------------------------------------------

/** Which role belongs to which department, and the departments' names (from Set up). */
export interface DepartmentMap {
  names: Record<string, string>;
  ofRole: Record<string, string | null>;
}

export interface ProcessHeadline {
  /** Hours a month the process takes. */
  hours: number;
  /** Its share of the department's hours (or, with no single department, the whole business's) from the same run; null when that is 0. */
  share: number | null;
  /** Whose hours the share is of: the department's name, or null for the whole business. */
  department: string | null;
  /** Automatable hours as a share of the process's hours (each step's automatable part, from its split); null when no step has a split. */
  automatable: number | null;
}

/**
 * The headline: "This process takes 612 h a month, 37% of Organic's time; about 40% of it is automatable."
 * - the hours are `personTime.stepHours` over this process's steps;
 * - the share is of the hours of the one department its work sits in (a step's role's department, else its person's first role's), or
 *   of the whole run's hours when it spans several departments, or none is known;
 * - the automatable share is the sum over steps of hours × the step's automatable part, over the process's hours.
 */
export function processHeadline(model: EngineModel, result: SimulationResult | null, stepIds: ReadonlySet<string>, departments: DepartmentMap | null): ProcessHeadline | null {
  const table = result?.personTime?.stepHours;
  const mine = processHours(model, result, stepIds);
  if (!table || !mine || !(mine.total > 0)) return null;
  const deptOf = (roleId: string | null): string | null => (roleId && departments ? (departments.ofRole[roleId] ?? null) : null);
  const mineDepts = new Set(mine.cells.map((c) => deptOf(c.roleId)).filter((d): d is string => d !== null));
  const single = mineDepts.size === 1 ? [...mineDepts][0]! : null;
  let denominator = 0;
  for (const [personId, byStep] of Object.entries(table)) {
    for (const [stepId, hours] of Object.entries(byStep)) {
      if (!(hours > 0) || !model.steps.some((s) => s.id === stepId)) continue;
      if (single === null || deptOf(roleOfHour(model, stepId, personId)) === single) denominator += hours;
    }
  }
  const steps = new Map(model.steps.map((s) => [s.id, s]));
  const anySplit = mine.steps.some((s) => s.split);
  const automatable = anySplit ? mine.cells.reduce((sum, c) => sum + c.hours * (steps.get(c.stepId)?.split?.automatable ?? 0), 0) / mine.total : null;
  return {
    hours: mine.total,
    share: denominator > 0 ? mine.total / denominator : null,
    department: single && departments ? (departments.names[single] ?? null) : null,
    automatable,
  };
}

/** Hours as the headline writes them: whole hours, one decimal under 10. */
const hoursText = (h: number) => (h < 10 ? h.toLocaleString("en-GB", { maximumFractionDigits: 1 }) : Math.round(h).toLocaleString("en-GB"));
const percentText = (share: number) => (share > 0 && share < 0.005 ? "less than 1%" : `${Math.round(share * 100)}%`);

/** The headline as one sentence. */
export function headlineText(h: ProcessHeadline): string {
  const takes = `This process takes ${hoursText(h.hours)} h a month`;
  const of = h.share === null ? "" : `, ${percentText(h.share)} of ${h.department ? `${h.department}'s` : "the whole business's"} time`;
  const auto = h.automatable === null ? "" : `; about ${percentText(h.automatable)} of it is automatable`;
  return `${takes}${of}${auto}.`;
}

// ---------------------------------------------------------------------------
// The pie of hours by role
// ---------------------------------------------------------------------------

/** How many roles the pie names before the rest fold into "Others". */
export const PIE_SLICES = 6;

export interface PieSlice {
  /** The role id, null for "No role", or "others" for the folded slice. */
  key: string;
  label: string;
  hours: number;
  /** Of the process's hours, 0 to 1. */
  share: number;
  /** The role, for a named slice; null for "Others". */
  role: RoleHours | null;
  /** The roles folded into "Others", largest first; empty for a named slice. */
  members: RoleHours[];
}

/**
 * The roles as pie slices, largest first: the first `limit` by name, the rest folded into one "Others" slice (only when that folds two
 * or more; a single leftover role keeps its own slice). Roles with no hours are left out.
 */
export function pieSlices(roles: readonly RoleHours[], limit = PIE_SLICES): PieSlice[] {
  const rows = roles.filter((r) => r.hours > 0).sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label));
  const total = rows.reduce((s, r) => s + r.hours, 0);
  if (!(total > 0)) return [];
  const named = rows.length > limit + 1 ? rows.slice(0, limit) : rows;
  const rest = rows.slice(named.length);
  const slices: PieSlice[] = named.map((r) => ({ key: r.id ?? "none", label: r.label, hours: r.hours, share: r.hours / total, role: r, members: [] }));
  if (rest.length > 0) {
    const hours = rest.reduce((s, r) => s + r.hours, 0);
    slices.push({ key: "others", label: "Others", hours, share: hours / total, role: null, members: rest });
  }
  return slices;
}

// ---------------------------------------------------------------------------
// The strip of hours by step ("Heaviest steps")
// ---------------------------------------------------------------------------

/** How many steps the strip names before the rest group into "N other steps". */
export const STRIP_NAMED = 4;

export interface StripSegment {
  /** The step id, or "others" for the grouped segment. */
  key: string;
  label: string;
  hours: number;
  /** Of the process's hours, 0 to 1. */
  share: number;
  /** The steps grouped into "N other steps", heaviest first; empty for a named step. */
  members: StepHours[];
}

export interface HoursStrip {
  total: number;
  /** Heaviest first; the grouped segment, if any, last. */
  segments: StripSegment[];
  /** The fewest heaviest steps that take at least half the hours (at most `STRIP_NAMED`), and their share: the headline's numbers. */
  lead: { steps: StepHours[]; share: number };
}

/**
 * The process's monthly hours as one strip, split by step: the `named` heaviest steps by name, the rest as one "N other steps" segment
 * (only when that groups two or more; a single leftover step keeps its name). Null with no hours.
 */
export function hoursStrip(hours: Pick<ProcessHours, "steps"> | null, named = STRIP_NAMED): HoursStrip | null {
  const rows = (hours?.steps ?? []).filter((s) => s.hours > 0).sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label));
  const total = rows.reduce((s, r) => s + r.hours, 0);
  if (!(total > 0)) return null;
  const shown = rows.length > named + 1 ? rows.slice(0, named) : rows;
  const rest = rows.slice(shown.length);
  const segments: StripSegment[] = shown.map((r) => ({ key: r.id, label: r.label, hours: r.hours, share: r.hours / total, members: [] }));
  if (rest.length > 0) {
    const h = rest.reduce((s, r) => s + r.hours, 0);
    segments.push({ key: "others", label: `${rest.length} other steps`, hours: h, share: h / total, members: rest });
  }
  // The headline: the fewest heaviest steps that reach half the hours, or the named ones when even they don't.
  let lead = 0;
  let sum = 0;
  while (lead < Math.min(named, rows.length) && sum < total / 2) sum += rows[lead++]!.hours;
  return { total, segments, lead: { steps: rows.slice(0, lead), share: sum / total } };
}

/** The strip's headline: "3 steps take 58% of the 156 h a month", "Review takes 62% of …", or "One step, Review, takes all 12 h a month". */
export function stripHeadline(strip: HoursStrip, stepCount = strip.segments.reduce((n, s) => n + (s.members.length || 1), 0)): string {
  const total = `${hoursText(strip.total)} h a month`;
  const { steps, share } = strip.lead;
  if (stepCount === 1) return `One step, ${steps[0]!.label}, takes all ${total}.`;
  const pct = percentText(share);
  if (steps.length === 1) return `${steps[0]!.label} takes ${pct} of the ${total}.`;
  if (share < 0.5) return `The ${steps.length} heaviest steps take ${pct} of the ${total}.`;
  return `${steps.length} steps take ${pct} of the ${total}.`;
}
