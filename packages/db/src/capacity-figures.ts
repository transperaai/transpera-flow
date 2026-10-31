// The Capacity page's derived figures (capacity build P5, docs/plans/capacity/p5-capacity-brief.md).
//
// Pure functions over three things: the engine's result for the current book of clients (busy share per person and role, hours by step,
// clients by service: `simulate(…, { personTime: true })` on `todayModel(model)`), the engine model, and the Set up data
// (`loadCapacitySetup`: lines, salaries, tiers served, counts). No I/O, no clock, no randomness.
//
// Names are the prototype's (docs/prototypes/client-capacity-app.PROTOTYPE.html: `personMax`, `capDept`, `lines`, `salaries`, `revenue`,
// `reassign`, `pickLeastBusy`). Where the engine and the prototype's definition can't agree the figure says which it is: busy share is the
// ENGINE's (queues and spread included); the hours a client "needs" (time to serve, the leaver's move, a shared team's room per client) are
// PLANNED hours from capacity-inputs.ts (tasks a month × the steps' time with the tier multiplier and changes), which is the calculator's.
//
// Ids: the engine model's people, roles and services are keyed by the same ids as the Set up rows (toEngineModel maps them that way).

import {
  CAPACITY_WEEKS_PER_MONTH,
  availableShare,
  effectiveDeliverables,
  rankBottlenecks,
  stepTimeFactor,
  tasksPerMonth,
  type Bottlenecks,
  type EngineClient,
  type EngineModel,
  type SimulationResult,
} from "@transpera-flow/engine";
import type { CapacitySetup, SetupPerson, SetupRole } from "./capacity-setup";
import { tierCount, uniqueClients } from "./capacity-setup";

/** Months to hire a replacement (the prototype's `hiringDelay`). Not stored in Set up yet. */
export const DEFAULT_HIRING_DELAY_MONTHS = 2;
/** The busy share a "goal" DLER is measured against (D24). */
export const DLER_GOAL = 4.5;
const MONTH_WEEKS = CAPACITY_WEEKS_PER_MONTH;

// ---------------------------------------------------------------------------------------------------------------------
// The run for "today"

/**
 * The model for "today" (P5 brief section 2): the current book of clients, so no new leads and nobody leaving. Churn is switched off too,
 * or the mean client count over a year would be lower than the book is today. Everything else is the workspace's own model.
 */
export function todayModel(model: EngineModel): EngineModel {
  const services = model.services ? Object.fromEntries(Object.entries(model.services).map(([id, s]) => [id, { ...s, churnMonthly: 0 }])) : model.services;
  const clientGroups = model.clientGroups ? Object.fromEntries(Object.entries(model.clientGroups).map(([id, g]) => [id, { ...g, churnMonthly: 0 }])) : model.clientGroups;
  return { ...model, leadsPerWeek: 0, churnMonthly: 0, ...(services ? { services } : {}), ...(clientGroups ? { clientGroups } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Who is who

const LEADERSHIP = /director|head of|founder|strategy lead/i;

/** Leadership: the directors and heads. (No flag is stored; it is read from the role's name. Reported in the P5 handover.) */
export function isLeadershipRole(role: Pick<SetupRole, "name">): boolean {
  return LEADERSHIP.test(role.name);
}

interface Lookups {
  roleById: Map<string, SetupRole>;
  personRole: (p: SetupPerson) => SetupRole | null;
  deptOf: (p: SetupPerson) => string | null;
}

function lookups(setup: Pick<CapacitySetup, "roles">): Lookups {
  const roleById = new Map(setup.roles.map((r) => [r.id, r]));
  const personRole = (p: SetupPerson): SetupRole | null => {
    const roles = p.role_ids.map((id) => roleById.get(id)).filter((r): r is SetupRole => !!r && r.active !== false);
    return roles.find((r) => r.kind === "client_facing") ?? roles[0] ?? null;
  };
  return { roleById, personRole, deptOf: (p) => personRole(p)?.department_id ?? null };
}

const activePeople = (setup: Pick<CapacitySetup, "people">) => setup.people.filter((p) => p.active);

// ---------------------------------------------------------------------------------------------------------------------
// Busy share, person's max

export interface PersonBusy {
  id: string;
  name: string;
  roleId: string | null;
  roleName: string;
  departmentId: string | null;
  kind: "client_facing" | "shared";
  /** The role's line (D17). */
  line: number;
  /** The engine's mean busy share, and its 10-90% range. */
  busy: number;
  low: number;
  high: number;
  /** At or over the line. */
  over: boolean;
  /** Clients over the run, by tier key (a client of two services of one department counts under each). */
  clientsByTier: Record<string, number>;
  clients: number;
  /** Hours a month the person asks of their own time, from the run (hands-on). */
  hours: number;
  team: number;
}

export interface RoleBusy {
  id: string;
  name: string;
  departmentId: string | null;
  kind: "client_facing" | "shared";
  line: number;
  busy: number;
  low: number;
  high: number;
  over: boolean;
  people: number;
}

/** Per person and per role: the engine's busy share and range, against the role's line. */
export function busyShares(setup: CapacitySetup, model: EngineModel, result: SimulationResult): { people: PersonBusy[]; roles: RoleBusy[] } {
  const { personRole, deptOf } = lookups(setup);
  const tierKeyOf = (serviceId: string): string => model.services?.[serviceId]?.tier ?? setup.tiers.find((t) => t.id === setup.services.find((s) => s.id === serviceId)?.tier_id)?.key ?? "";
  const people: PersonBusy[] = [];
  for (const p of activePeople(setup)) {
    const k = result.kpi.people[p.id];
    const role = personRole(p);
    if (!k || !role) continue;
    const dept = deptOf(p);
    const clientsByTier: Record<string, number> = {};
    let clients = 0;
    for (const [sid, n] of Object.entries(result.personTime?.clients[p.id] ?? {})) {
      const svc = setup.services.find((s) => s.id === sid);
      if (dept && svc?.department_id && svc.department_id !== dept) continue;
      const tier = tierKeyOf(sid);
      clientsByTier[tier] = (clientsByTier[tier] ?? 0) + n;
      clients += n;
    }
    const hours = Object.values(result.personTime?.stepHours[p.id] ?? {}).reduce((s, v) => s + v, 0);
    people.push({
      id: p.id,
      name: p.name,
      roleId: role.id,
      roleName: role.name,
      departmentId: dept,
      kind: role.kind,
      line: role.line,
      busy: k.util.mean,
      low: k.util.p10,
      high: k.util.p90,
      over: k.util.mean >= role.line,
      clientsByTier,
      clients,
      hours,
      team: p.reserved_share,
    });
  }
  const roles: RoleBusy[] = [];
  for (const r of setup.roles) {
    const k = result.kpi.roles[r.id];
    if (!k || r.active === false) continue;
    roles.push({
      id: r.id,
      name: r.name,
      departmentId: r.department_id,
      kind: r.kind,
      line: r.line,
      busy: k.util.mean,
      low: k.util.p10,
      high: k.util.p90,
      over: k.util.mean >= r.line,
      people: people.filter((p) => p.roleId === r.id).length,
    });
  }
  return { people, roles };
}

/** A person's own maximum: their clients × their line ÷ their busy share (the prototype's `personMax`). 0 when nobody is asked of them. */
export function personMax(clients: number, line: number, busy: number): { max: number; canTake: number } {
  const max = busy > 0 ? (clients * line) / busy : 0;
  return { max, canTake: max - clients };
}

// ---------------------------------------------------------------------------------------------------------------------
// Planned hours (the calculator's figure, from capacity-inputs.ts)

export interface PlannedHours {
  /** Hours a month, everyone together. */
  total: number;
  /** By the role the step is done by. A step for "the client's manager" is under `manager`. */
  byRole: Record<string, number>;
  /** Hours the client's manager does (steps with `toClientManager`, and hand-holding). */
  manager: number;
  byPurpose: Record<string, number>;
  /** Hours by step id (hand-holding is under "hand"). */
  bySteps: Record<string, number>;
}

/**
 * The hours a month one client of a service needs, planned: for each servicing process of the service, tasks a month
 * (`tasksPerMonth` of its recurrence at the client's values) × the sum of its steps' time (`work` × `stepTimeFactor`: tier multiplier,
 * the split with the changes in force in the month, the client's own factor). A named client's `adhocHours` replaces the ad-hoc steps' time
 * and its `handHoldingHours` are added to its manager. Ignores routing, rework and waiting: it is the plan, not the simulation.
 */
export function plannedServiceHours(model: EngineModel, serviceId: string, client?: EngineClient | null, monthIndex = 0): PlannedHours {
  const out: PlannedHours = { total: 0, byRole: {}, manager: 0, byPurpose: {}, bySteps: {} };
  const svc = model.services?.[serviceId];
  if (!svc) return out;
  const eff = effectiveDeliverables(model, client, serviceId);
  const stepOf = new Map(model.steps.map((s) => [s.id, s]));
  const own = client?.overrides?.stepFactor;
  for (const link of svc.servicing ?? []) {
    const proc = model.servicingProcesses?.[link.process];
    if (!proc) continue;
    const tasks = tasksPerMonth(link.recurrence, eff.deliverables, eff.adhoc);
    if (!(tasks > 0)) continue;
    const isAdhoc = "driver" in link.recurrence && link.recurrence.driver === "adhoc";
    for (const id of proc.steps) {
      const step = stepOf.get(id);
      if (!step) continue;
      const base = isAdhoc && eff.adhocHours !== undefined ? { ...step, work: eff.adhocHours } : step;
      const h = tasks * base.work * stepTimeFactor(base, svc.tier, model.changes, monthIndex, own);
      if (!(h > 0)) continue;
      add(out, step, h);
    }
  }
  if (client?.handHoldingHours) {
    const h = Object.values(client.handHoldingHours).reduce((s, v) => s + v, 0);
    if (h > 0) {
      out.total += h;
      out.manager += h;
      out.byPurpose["Hand-holding"] = (out.byPurpose["Hand-holding"] ?? 0) + h;
      out.bySteps.hand = (out.bySteps.hand ?? 0) + h;
    }
  }
  return out;
}

function add(out: PlannedHours, step: { id: string; role: string | null; toClientManager?: boolean; purpose?: string }, h: number): void {
  out.total += h;
  if (step.toClientManager) out.manager += h;
  else if (step.role) out.byRole[step.role] = (out.byRole[step.role] ?? 0) + h;
  const purpose = step.purpose?.trim() || "Other";
  out.byPurpose[purpose] = (out.byPurpose[purpose] ?? 0) + h;
  out.bySteps[step.id] = (out.bySteps[step.id] ?? 0) + h;
}

// ---------------------------------------------------------------------------------------------------------------------
// Department ceiling (the prototype's capDept)

export interface CeilingLimit {
  /** "Client-facing people" or the shared team's name. */
  name: string;
  kind: "people" | "team";
  roleId?: string;
  max: number;
}

export interface DepartmentCeiling {
  departmentId: string;
  clients: number;
  /** The lowest limit. */
  max: number;
  /** Its name. */
  limit: string;
  /** Every limit, lowest first. */
  limits: CeilingLimit[];
  /** Whole clients of room: floor(max − clients), at least 0. */
  room: number;
  perPerson: Record<string, { max: number; canTake: number; clients: number }>;
}

/** The share of a department's wins that go to each of its tier services (the services' `mixShare`, normalised; equal when none is set). */
export function winMix(setup: CapacitySetup, model: EngineModel, departmentId: string): Record<string, number> {
  const ids = setup.services.filter((s) => s.active && s.department_id === departmentId && s.tier_id && model.services?.[s.id]).map((s) => s.id);
  const weights = ids.map((id) => Math.max(0, model.services![id]!.mixShare));
  const sum = weights.reduce((a, b) => a + b, 0);
  return Object.fromEntries(ids.map((id, i) => [id, sum > 0 ? weights[i]! / sum : 1 / ids.length]));
}

/**
 * How many clients a department can hold: each client-facing person's own maximum at their line, added up, capped by each shared team: how
 * many clients its capacity at its line could serve at the department's win mix (the clients it serves now, plus its room in hours at the
 * line ÷ the hours one more client of the mix brings it). Returns every limit, lowest first, and names the lowest.
 */
export function departmentCeiling(setup: CapacitySetup, model: EngineModel, result: SimulationResult, departmentId: string): DepartmentCeiling {
  const { people } = busyShares(setup, model, result);
  const cf = people.filter((p) => p.kind === "client_facing" && p.departmentId === departmentId);
  const perPerson: DepartmentCeiling["perPerson"] = {};
  let clients = 0;
  let sum = 0;
  for (const p of cf) {
    const m = personMax(p.clients, p.line, p.busy);
    perPerson[p.id] = { max: m.max, canTake: m.canTake, clients: p.clients };
    clients += p.clients;
    sum += m.max;
  }
  const limits: CeilingLimit[] = [{ name: "Client-facing people", kind: "people", max: sum }];
  const mix = winMix(setup, model, departmentId);
  for (const role of setup.roles) {
    if (role.kind !== "shared" || role.active === false) continue;
    const util = result.kpi.roles[role.id]?.util.mean ?? 0;
    const demand = setup.people.filter((p) => p.role_ids.includes(role.id)).reduce((s, p) => s + Object.values(result.personTime?.stepHours[p.id] ?? {}).reduce((a, b) => a + b, 0), 0);
    // Hours one more client of the win mix brings this team.
    let per = 0;
    for (const [sid, share] of Object.entries(mix)) per += share * (plannedServiceHours(model, sid).byRole[role.id] ?? 0);
    if (!(per > 0) || !(util > 0) || !(demand > 0)) continue;
    const headroomHours = demand * (role.line / util - 1);
    limits.push({ name: role.name, kind: "team", roleId: role.id, max: Math.max(0, clients + headroomHours / per) });
  }
  limits.sort((a, b) => a.max - b.max);
  const low = limits[0]!;
  return { departmentId, clients, max: low.max, limit: low.name, limits, room: Math.max(0, Math.floor(low.max - clients)), perPerson };
}

// ---------------------------------------------------------------------------------------------------------------------
// Service lines, DLER, per employee

export interface ServiceLines {
  byDepartment: { id: string; name: string; clients: number }[];
  both: number;
  unique: number;
}

/** Clients by service line: each department's, taking both (named with two departments + each tier's counted "taking both"), unique. */
export function serviceLines(setup: CapacitySetup): ServiceLines {
  const u = uniqueClients(setup);
  return { byDepartment: setup.departments.map((d) => ({ id: d.id, name: d.name, clients: u.byDepartment[d.id] ?? 0 })), both: u.both, unique: u.unique };
}

export interface DlerRow {
  departmentId: string | null;
  name: string;
  /** Retainers a month. */
  retainers: number;
  /** Salaries a month; null when the viewer can't see pay. */
  salaries: number | null;
  /** Retainers ÷ salaries; null when salaries are hidden or zero. No ":1". */
  ratio: number | null;
}

/** The department a named client's fee counts under: its manager's, else its first service's. */
function clientDepartment(setup: CapacitySetup, c: CapacitySetup["clients"][number]): string | null {
  const { roleById } = lookups(setup);
  for (const roleId of Object.keys(c.assignments)) {
    const d = roleById.get(roleId);
    if (d?.kind === "client_facing" && d.department_id) return d.department_id;
  }
  return setup.services.find((s) => c.service_ids.includes(s.id))?.department_id ?? null;
}

/** Retainers a month for a department: counted clients at their tier's fee, named clients at their own. */
export function departmentRetainers(setup: CapacitySetup, departmentId: string): number {
  let sum = 0;
  for (const s of setup.services) {
    if (!s.active || s.department_id !== departmentId || !s.tier_id) continue;
    const named = setup.clients.filter((c) => c.active && c.service_ids.includes(s.id)).length;
    sum += Math.max(0, tierCount(s.id, setup) - named) * s.price;
  }
  for (const c of setup.clients) if (c.active && clientDepartment(setup, c) === departmentId) sum += c.mrr;
  return sum;
}

/** Whether a person's salary is in DLER: not a contractor, and leadership only when the setting is on. */
function inDler(setup: CapacitySetup, p: SetupPerson, role: SetupRole | null): boolean {
  if (!p.active || p.label === "contractor") return false;
  return setup.dlerIncludesLeadership || !(role && isLeadershipRole(role));
}

/**
 * DLER: retainers ÷ salaries, per department and for the whole business (all retainers ÷ all salaries of the departments). Directors and heads are in
 * only when `dler_includes_leadership` is on; contractors never. Where pay is hidden the salaries and ratios are null.
 */
export function dler(setup: CapacitySetup): { departments: DlerRow[]; whole: DlerRow } {
  const { personRole, deptOf } = lookups(setup);
  const row = (departmentId: string | null, name: string, retainers: number, ps: SetupPerson[]): DlerRow => {
    const salaries = setup.payHidden ? null : ps.reduce((s, p) => s + (p.salary_monthly ?? 0), 0);
    return { departmentId, name, retainers, salaries, ratio: salaries && salaries > 0 ? retainers / salaries : null };
  };
  const departments = setup.departments.map((d) =>
    row(
      d.id,
      d.name,
      departmentRetainers(setup, d.id),
      activePeople(setup).filter((p) => deptOf(p) === d.id && inDler(setup, p, personRole(p))),
    ),
  );
  const retainers = departments.reduce((s, d) => s + d.retainers, 0);
  const salaries = setup.payHidden ? null : departments.reduce((s, d) => s + (d.salaries ?? 0), 0);
  return { departments, whole: { departmentId: null, name: "Whole business", retainers, salaries, ratio: salaries && salaries > 0 ? retainers / salaries : null } };
}

export interface PerEmployee {
  departmentId: string;
  clients: number;
  employees: number;
  clientsPerEmployee: number | null;
  /** Retainers a month ÷ employees. */
  revenuePerEmployee: number | null;
}

/** Clients and revenue per employee (D22): the department's clients and retainers ÷ everyone in it, contractors and leadership out. */
export function perEmployee(setup: CapacitySetup, departmentId: string): PerEmployee {
  const { personRole, deptOf } = lookups(setup);
  const employees = activePeople(setup).filter((p) => {
    const role = personRole(p);
    return deptOf(p) === departmentId && p.label !== "contractor" && !(role && isLeadershipRole(role));
  }).length;
  const clients = uniqueClients(setup).byDepartment[departmentId] ?? 0;
  return {
    departmentId,
    clients,
    employees,
    clientsPerEmployee: employees > 0 ? clients / employees : null,
    revenuePerEmployee: employees > 0 ? departmentRetainers(setup, departmentId) / employees : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Hiring advice

export interface HiringAdvice {
  roleId: string;
  name: string;
  line: number;
  /** 0-based month the role's mean busy share first passes its line in the run; null when it never does. */
  overFrom: number | null;
  /** `overFrom` minus the hiring delay: 0 or less means start hiring now. */
  hireBy: number | null;
  /** The role's mean busy share by month. */
  series: (number | null)[];
}

/** Per role: the first month its mean busy share passes its line in the 12-month run, minus the hiring delay. Roles that never pass get no month. */
export function hiringAdvice(setup: CapacitySetup, result: SimulationResult, delayMonths = DEFAULT_HIRING_DELAY_MONTHS): HiringAdvice[] {
  const monthly = result.monthly;
  if (!monthly) return [];
  const out: HiringAdvice[] = [];
  for (const role of setup.roles) {
    const series = monthly.roles[role.id];
    if (!series || role.active === false) continue;
    const values = series.map((m) => (m ? m.mean : null));
    const first = values.findIndex((v) => v !== null && v >= role.line);
    out.push({ roleId: role.id, name: role.name, line: role.line, overFrom: first < 0 ? null : first, hireBy: first < 0 ? null : first - delayMonths, series: values });
  }
  return out.sort((a, b) => (a.overFrom ?? 99) - (b.overFrom ?? 99));
}

// ---------------------------------------------------------------------------------------------------------------------
// What if someone leaves

export interface LeaverRow {
  id: string;
  name: string;
  line: number;
  before: number;
  after: number;
  goesOver: boolean;
}

export interface LeaverResult {
  leaverId: string;
  kind: "client_facing" | "shared";
  /** Clients the leaver hands over (named and counted). */
  clients: number;
  /** Colleague id → clients they receive. */
  received: Record<string, number>;
  /** Clients nobody serves the tier of. */
  unplaced: number;
  /** Colleagues whose busy share changes, busiest after first. */
  rows: LeaverRow[];
  goOver: string[];
}

/**
 * Takes `leaverId` out and hands each of their clients, one at a time, to the least-busy colleague of the department who serves the tier.
 * The leaver is removed from the candidates FIRST (the prototype let them take clients back). A move adds the client's planned manager hours
 * ÷ the colleague's hours a month to the colleague's busy share (the engine's busy share is the start). A person of a shared team has no
 * clients: their hours are shared equally by the rest of the team.
 */
export function leaver(setup: CapacitySetup, model: EngineModel, result: SimulationResult, leaverId: string): LeaverResult | null {
  const { deptOf } = lookups(setup);
  const { people } = busyShares(setup, model, result);
  const who = people.find((p) => p.id === leaverId);
  if (!who) return null;
  const setupPerson = setup.people.find((p) => p.id === leaverId)!;
  const hoursOf = (id: string): number => {
    const ep = result.resolvedPeople[id] ?? model.people?.[id];
    return ep ? ep.capacity * MONTH_WEEKS * availableShare(ep, 0) : 0;
  };
  const busyNow = new Map(people.map((p) => [p.id, p.busy]));
  const before = new Map(busyNow);
  const received: Record<string, number> = {};
  let clients = 0;
  let unplaced = 0;

  if (who.kind === "shared") {
    const mates = people.filter((p) => p.roleId === who.roleId && p.id !== leaverId);
    const mine = Object.values(result.personTime?.stepHours[leaverId] ?? {}).reduce((s, v) => s + v, 0);
    for (const m of mates) {
      const h = hoursOf(m.id);
      if (h > 0) busyNow.set(m.id, (busyNow.get(m.id) ?? 0) + mine / mates.length / h);
    }
    return finish(who.kind, mates.map((m) => m.id));
  }

  const dept = deptOf(setupPerson);
  // Candidates exclude the leaver first.
  const candidates = people.filter((p) => p.id !== leaverId && p.kind === "client_facing" && p.departmentId === dept && hoursOf(p.id) > 0 && model.people?.[p.id]?.until === undefined);
  const serves = (id: string, tierKey: string): boolean => {
    const tiers = model.people?.[id]?.tiers ?? result.resolvedPeople[id]?.tiers;
    return !tiers || tiers.length === 0 || tiers.includes(tierKey);
  };
  const give = (serviceId: string, client: EngineClient | null): void => {
    clients++;
    const tier = model.services?.[serviceId]?.tier ?? "";
    let best: PersonBusy | null = null;
    for (const c of candidates) if (serves(c.id, tier) && (!best || (busyNow.get(c.id) ?? 0) < (busyNow.get(best.id) ?? 0))) best = c;
    if (!best) {
      unplaced++;
      return;
    }
    busyNow.set(best.id, (busyNow.get(best.id) ?? 0) + plannedServiceHours(model, serviceId, client).manager / hoursOf(best.id));
    received[best.id] = (received[best.id] ?? 0) + 1;
  };
  const mp = model.people?.[leaverId] ?? result.resolvedPeople[leaverId];
  // Counted clients first, tier by tier, then the named ones.
  for (const [sid, n] of Object.entries(mp?.portfolio ?? {}).sort(([a], [b]) => a.localeCompare(b))) for (let i = 0; i < Math.round(n); i++) give(sid, null);
  for (const c of Object.values(model.clients ?? {})) {
    if (c.manager !== leaverId) continue;
    for (const sid of c.services) {
      const svc = setup.services.find((s) => s.id === sid);
      if (!svc || (dept && svc.department_id !== dept)) continue;
      give(sid, c);
    }
  }
  return finish(who.kind, candidates.map((c) => c.id));

  function finish(kind: LeaverResult["kind"], affected: string[]): LeaverResult {
    const rows: LeaverRow[] = [];
    for (const id of affected) {
      const p = people.find((q) => q.id === id)!;
      const b = before.get(id) ?? 0;
      const a = busyNow.get(id) ?? 0;
      if (Math.abs(a - b) <= 0.005) continue;
      rows.push({ id, name: p.name, line: p.line, before: b, after: a, goesOver: a >= p.line && b < p.line });
    }
    rows.sort((x, y) => y.after - x.after);
    return { leaverId, kind, clients, received, unplaced, rows, goOver: rows.filter((r) => r.goesOver).map((r) => r.id) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Time to serve

export interface TierTime {
  serviceId: string;
  tierKey: string;
  tierName: string;
  fee: number;
  hours: number;
  /** Fee ÷ hours; null with no hours. */
  feePerHour: number | null;
  byPurpose: { name: string; hours: number }[];
}

export interface NamedClientTime {
  id: string;
  name: string;
  departmentId: string | null;
  manager: string | null;
  fee: number;
  hours: number;
  feePerHour: number | null;
  byPurpose: { name: string; hours: number }[];
}

const purposes = (m: Record<string, number>) =>
  Object.entries(m)
    .map(([name, hours]) => ({ name, hours }))
    .sort((a, b) => b.hours - a.hours);

/** Planned hours a month for one client of each tier, by purpose, and for each named client; fee ÷ hours. */
export function timeToServe(setup: CapacitySetup, model: EngineModel): { departments: { id: string; name: string; tiers: TierTime[] }[]; named: NamedClientTime[] } {
  const departments = setup.departments.map((d) => ({
    id: d.id,
    name: d.name,
    tiers: setup.services
      .filter((s) => s.active && s.department_id === d.id && s.tier_id && model.services?.[s.id])
      .map((s) => {
        const tier = setup.tiers.find((t) => t.id === s.tier_id)!;
        const h = plannedServiceHours(model, s.id);
        return { serviceId: s.id, tierKey: tier.key, tierName: tier.name, sort: tier.sort, fee: s.price, hours: h.total, feePerHour: h.total > 0 ? s.price / h.total : null, byPurpose: purposes(h.byPurpose) };
      })
      .sort((a, b) => a.sort - b.sort)
      .map(({ sort: _sort, ...t }) => t),
  }));
  const named: NamedClientTime[] = [];
  for (const c of setup.clients) {
    if (!c.active) continue;
    const ec = model.clients?.[c.id];
    const byPurpose: Record<string, number> = {};
    let hours = 0;
    for (const sid of c.service_ids) {
      if (!model.services?.[sid]) continue;
      const h = plannedServiceHours(model, sid, ec ?? null);
      hours += h.total;
      for (const [k, v] of Object.entries(h.byPurpose)) byPurpose[k] = (byPurpose[k] ?? 0) + v;
    }
    const fee = ec?.mrr ?? c.mrr;
    named.push({ id: c.id, name: c.name, departmentId: clientDepartment(setup, c), manager: ec?.manager ?? Object.values(c.assignments)[0] ?? null, fee, hours, feePerHour: hours > 0 ? fee / hours : null, byPurpose: purposes(byPurpose) });
  }
  return { departments, named };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bottleneck

export interface BottleneckFigure {
  person: PersonBusy;
  /** How far over the line (negative: still under). */
  over: number;
  /** What fills their month: the steps with the most hours, each linked to its step (`stepId`; "hand" has none). */
  steps: { stepId: string; name: string; hours: number }[];
  /** The next most stretched, by distance over the line. */
  next: PersonBusy[];
  /** The engine's role and step ranking (P0's `rankBottlenecks`). */
  ranking: Bottlenecks;
}

/** The person most over their line (or closest to it), and what fills their month; plus the role and step ranking. */
export function bottleneck(setup: CapacitySetup, model: EngineModel, result: SimulationResult, topSteps = 5): BottleneckFigure | null {
  const { people } = busyShares(setup, model, result);
  const ranked = people.filter((p) => p.hours > 0 || p.busy > 0).sort((a, b) => b.busy - b.line - (a.busy - a.line));
  const top = ranked[0];
  if (!top) return null;
  const nameOf = new Map(model.steps.map((s) => [s.id, s.name]));
  const steps = Object.entries(result.personTime?.stepHours[top.id] ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, topSteps)
    .map(([stepId, hours]) => ({ stepId, name: stepId === "hand" ? "Hand-holding" : (nameOf.get(stepId) ?? stepId), hours }));
  return { person: top, over: top.busy - top.line, steps, next: ranked.slice(1, 5), ranking: rankBottlenecks(model, result) };
}
