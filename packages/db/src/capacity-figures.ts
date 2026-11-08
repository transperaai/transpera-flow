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
  type EngineMarket,
  type EngineModel,
  type SimulationResult,
} from "@transpera-flow/engine";
import type { CapacitySetup, SetupPerson, SetupRole } from "./capacity-setup";
import { tierCount, uniqueClients } from "./capacity-setup";

/**
 * Months to hire a replacement before the market stretches it (the prototype's `hiringDelay`; the Sandbox's "Hiring delay" lever starts
 * from none). The workspace stores no base of its own, so this is the base; the workspace's market settings stretch it (`hiringDelayAt`).
 */
export const DEFAULT_HIRING_DELAY_MONTHS = 2;

/** The hiring delay, in whole months, for a hire planned for month `i` of the run: the base x the market's "time to hire" that month (as the Sandbox does). */
export function hiringDelayAt(market: EngineMarket | undefined, i: number, base = DEFAULT_HIRING_DELAY_MONTHS): number {
  const months = market?.months;
  if (!months?.length) return base;
  return Math.max(0, Math.round(base * (months[Math.min(Math.max(0, i), months.length - 1)]!.hire ?? 1)));
}
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

/** Leadership: the roles flagged as such in Set up (`roles.leadership`). Left out of clients and revenue per employee; DLER follows its own setting. */
export function isLeadershipRole(role: Pick<SetupRole, "leadership">): boolean {
  return role.leadership;
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

export type RoomStatus = "Plenty of room" | "Some room" | "Tight" | "Full";

export interface RoomPulse {
  status: RoomStatus;
  tone: "ok" | "warn" | "bad";
  /** Room rounded for talking about: the nearest 5 from 10 up, else the nearest whole client. */
  approx: number;
  /** "about 15 more clients"; empty when full. */
  words: string;
}

/**
 * Room for more clients as a pulse check (Q1 item 15), not a fact: a status word from the room as a share of today's clients (plenty from
 * 20%, some from 5%, tight above 0, full at 0), with the figure rounded to the nearest 5 once it is 10 or more.
 */
export function roomPulse(room: number, clients: number): RoomPulse {
  const whole = Math.max(0, Math.floor(room));
  const approx = whole >= 10 ? Math.round(whole / 5) * 5 : whole;
  if (whole < 1) return { status: "Full", tone: "bad", approx: 0, words: "" };
  const share = clients > 0 ? whole / clients : 1;
  const status: RoomStatus = share >= 0.2 ? "Plenty of room" : share >= 0.05 ? "Some room" : "Tight";
  return { status, tone: status === "Tight" ? "warn" : "ok", approx, words: `about ${approx} more ${approx === 1 ? "client" : "clients"}` };
}

/** What stops a department taking more clients, in words: "its client managers", or the team's name. */
export function limitedBy(limit: string): string {
  return limit === "Client-facing people" ? "client managers" : limit;
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
  /** Retainers a month credited to the people averaged. */
  retainers: number;
  /** How many people's DLER the average is over (client-facing, salary entered, contractors out). */
  people: number;
  /** The average of those people's DLER (D40); null when pay is hidden or nobody qualifies. No ":1". */
  ratio: number | null;
  /** The viewer can't see pay, so no ratio is worked out. */
  hidden: boolean;
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
 * What each client-facing person's clients pay a month (D40): the fee of every client they manage.
 * - A named client's fee goes to the person who looks after it in the client-facing role of each service's department. A client taking
 *   both services counts each service's share of its fee with that service's manager (split by the services' tier fees; equally when
 *   they have none).
 * - Counted clients: the person's portfolio count × the tier's fee.
 */
export function personFees(setup: CapacitySetup): Map<string, number> {
  const { roleById } = lookups(setup);
  const fees = new Map<string, number>();
  const add = (id: string, v: number) => fees.set(id, (fees.get(id) ?? 0) + v);
  for (const r of setup.portfolio) {
    const svc = setup.services.find((x) => x.id === r.service_id);
    if (svc?.active && svc.tier_id) add(r.person_id, r.client_count * svc.price);
  }
  for (const c of setup.clients) {
    if (!c.active) continue;
    const svcs = setup.services.filter((x) => x.active && x.tier_id && c.service_ids.includes(x.id));
    if (!svcs.length) continue;
    const total = svcs.reduce((a, x) => a + x.price, 0);
    for (const svc of svcs) {
      const managerRole = Object.keys(c.assignments).find((rid) => {
        const role = roleById.get(rid);
        return role?.kind === "client_facing" && role.department_id === svc.department_id;
      });
      const manager = managerRole ? c.assignments[managerRole] : undefined;
      if (manager) add(manager, total > 0 ? (c.mrr * svc.price) / total : c.mrr / svcs.length);
    }
  }
  return fees;
}

/**
 * DLER (D40, amending D9 and D24): the average of each client-facing person's DLER. A person's DLER is the monthly retainers of the
 * clients they manage (`personFees`) ÷ their monthly salary. A department's is the mean over its client-facing people; the whole business's is
 * the mean over all of them. People with no salary entered and contractors are left out; directors are in only when
 * `dler_includes_leadership` is on (D48: off unless set). Where pay is hidden the ratios are null.
 *
 * `retainers` (the Sandbox): the retainers a month each department takes in a month of a run, in place of today's. A department's pool is
 * shared among its people in proportion to the fees they manage today (a hire or anyone with none takes the department's average share),
 * so a leaver's clients and a hire's work move the average the way the run says.
 */
export function dler(setup: CapacitySetup, retainers?: Record<string, number>): { departments: DlerRow[]; whole: DlerRow } {
  const { personRole, deptOf } = lookups(setup);
  const fees = personFees(setup);
  type Member = { dept: string; fee: number; salary: number };
  const members: Member[] = [];
  for (const p of activePeople(setup)) {
    const role = personRole(p);
    const dept = deptOf(p);
    if (!dept || role?.kind !== "client_facing" || !inDler(setup, p, role)) continue;
    const salary = p.salary_monthly;
    if (!setup.payHidden && !(salary !== null && salary > 0)) continue;
    members.push({ dept, fee: fees.get(p.id) ?? 0, salary: salary ?? 0 });
  }
  const hidden = setup.payHidden;
  // Each member's fee this month: their own, or their share of the department's pool from the run.
  const feeOf = (m: Member, mine: Member[]): number => {
    const pool = retainers?.[m.dept];
    if (pool === undefined) return m.fee;
    const mean = mine.reduce((a, x) => a + x.fee, 0) / (mine.length || 1);
    const weight = (x: Member) => (x.fee > 0 ? x.fee : mean);
    const sum = mine.reduce((a, x) => a + weight(x), 0);
    return sum > 0 ? (pool * weight(m)) / sum : pool / (mine.length || 1);
  };
  const row = (departmentId: string | null, name: string, ms: Member[]): DlerRow => {
    const fee = ms.map((m) => feeOf(m, members.filter((x) => x.dept === m.dept)));
    const ratios = hidden ? [] : ms.map((m, k) => fee[k]! / m.salary);
    return { departmentId, name, retainers: fee.reduce((a, b) => a + b, 0), people: ms.length, ratio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null, hidden };
  };
  const departments = setup.departments.map((d) => row(d.id, d.name, members.filter((m) => m.dept === d.id)));
  return { departments, whole: row(null, "Whole business", members) };
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
export function hiringAdvice(
  setup: CapacitySetup,
  result: SimulationResult,
  /** Whole months, or the delay for a hire planned for a given month (see `hiringDelayAt`). */
  delay: number | ((month: number) => number) = DEFAULT_HIRING_DELAY_MONTHS,
): HiringAdvice[] {
  // A hire planned for month m is delayed by the market of month m, so find the month whose own delay lands on the month it is needed.
  const hireBy = (needed: number): number => {
    if (typeof delay === "number") return needed - delay;
    let m = Math.max(0, needed - delay(needed));
    for (let k = 0; k < 3; k++) m = Math.max(0, needed - delay(m));
    return needed - delay(m);
  };
  const monthly = result.monthly;
  if (!monthly) return [];
  const out: HiringAdvice[] = [];
  for (const role of setup.roles) {
    const series = monthly.roles[role.id];
    if (!series || role.active === false) continue;
    const values = series.map((m) => (m ? m.mean : null));
    const first = values.findIndex((v) => v !== null && v >= role.line);
    out.push({ roleId: role.id, name: role.name, line: role.line, overFrom: first < 0 ? null : first, hireBy: first < 0 ? null : hireBy(first), series: values });
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

export interface LeaversResult {
  /** The people taken out, as found (ids that aren't anyone are dropped), in the order given. */
  leaverIds: string[];
  /** Clients the client-facing leavers hand over (named and counted). */
  clients: number;
  /** Colleague id → clients they receive. */
  received: Record<string, number>;
  /** Clients nobody left serves the tier of. */
  unplaced: number;
  /** Shared teams (role ids) whose remaining people share a leaver's hours. */
  sharedTeams: string[];
  /** Shared teams (role ids) with nobody left to share a leaver's hours. */
  emptyTeams: string[];
  /** Colleagues whose busy share changes, busiest after first. */
  rows: LeaverRow[];
  /** Colleagues the move takes from under their line to at or over it. */
  goOver: string[];
}

export interface LeaverResult extends LeaversResult {
  leaverId: string;
  kind: "client_facing" | "shared";
}

/**
 * Takes every person in `leaverIds` out at once, then hands each client-facing leaver's clients, one at a time, to the least-busy colleague
 * of that leaver's department who serves the tier. All the leavers are removed from the candidates FIRST, so no leaver takes another's
 * clients (nor their own back, as the prototype let them). A move adds the client's planned manager hours ÷ the colleague's hours a month
 * to the colleague's busy share (the engine's busy share is the start). A person of a shared team has no clients: their hours are shared
 * equally by the rest of the team who stay. Leavers are handled in the order given; within one, counted clients tier by tier, then named.
 */
export function leavers(setup: CapacitySetup, model: EngineModel, result: SimulationResult, leaverIds: readonly string[]): LeaversResult | null {
  const { deptOf } = lookups(setup);
  const { people } = busyShares(setup, model, result);
  const leaving = [...new Set(leaverIds)].map((id) => people.find((p) => p.id === id)).filter((p): p is PersonBusy => !!p);
  if (!leaving.length) return null;
  const gone = new Set(leaving.map((p) => p.id));
  const hoursOf = (id: string): number => {
    const ep = result.resolvedPeople[id] ?? model.people?.[id];
    return ep ? ep.capacity * MONTH_WEEKS * availableShare(ep, 0) : 0;
  };
  const busyNow = new Map(people.map((p) => [p.id, p.busy]));
  const before = new Map(busyNow);
  const received: Record<string, number> = {};
  const affected = new Set<string>();
  const sharedTeams = new Set<string>();
  const emptyTeams = new Set<string>();
  let clients = 0;
  let unplaced = 0;

  // Shared teams: the leaver's hours, shared equally by the team's people who stay.
  for (const who of leaving.filter((p) => p.kind === "shared")) {
    const mates = people.filter((p) => p.roleId === who.roleId && !gone.has(p.id));
    const mine = Object.values(result.personTime?.stepHours[who.id] ?? {}).reduce((s, v) => s + v, 0);
    if (!mates.length) {
      if (who.roleId) emptyTeams.add(who.roleId);
      continue;
    }
    if (who.roleId) sharedTeams.add(who.roleId);
    for (const m of mates) {
      affected.add(m.id);
      const h = hoursOf(m.id);
      if (h > 0) busyNow.set(m.id, (busyNow.get(m.id) ?? 0) + mine / mates.length / h);
    }
  }

  // Client-facing: every leaver is out of the candidates before the first client is handed out.
  const serves = (id: string, tierKey: string): boolean => {
    const tiers = model.people?.[id]?.tiers ?? result.resolvedPeople[id]?.tiers;
    return !tiers || tiers.length === 0 || tiers.includes(tierKey);
  };
  for (const who of leaving.filter((p) => p.kind === "client_facing")) {
    const dept = deptOf(setup.people.find((p) => p.id === who.id)!);
    const candidates = people.filter((p) => !gone.has(p.id) && p.kind === "client_facing" && p.departmentId === dept && hoursOf(p.id) > 0 && model.people?.[p.id]?.until === undefined);
    for (const c of candidates) affected.add(c.id);
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
    const mp = model.people?.[who.id] ?? result.resolvedPeople[who.id];
    // Counted clients first, tier by tier, then the named ones.
    for (const [sid, n] of Object.entries(mp?.portfolio ?? {}).sort(([a], [b]) => a.localeCompare(b))) for (let i = 0; i < Math.round(n); i++) give(sid, null);
    for (const c of Object.values(model.clients ?? {})) {
      if (c.manager !== who.id) continue;
      for (const sid of c.services) {
        const svc = setup.services.find((s) => s.id === sid);
        if (!svc || (dept && svc.department_id !== dept)) continue;
        give(sid, c);
      }
    }
  }

  const rows: LeaverRow[] = [];
  for (const id of affected) {
    const p = people.find((q) => q.id === id)!;
    const b = before.get(id) ?? 0;
    const a = busyNow.get(id) ?? 0;
    if (Math.abs(a - b) <= 0.005) continue;
    rows.push({ id, name: p.name, line: p.line, before: b, after: a, goesOver: a >= p.line && b < p.line });
  }
  rows.sort((x, y) => y.after - x.after);
  return { leaverIds: leaving.map((p) => p.id), clients, received, unplaced, sharedTeams: [...sharedTeams], emptyTeams: [...emptyTeams], rows, goOver: rows.filter((r) => r.goesOver).map((r) => r.id) };
}

/** One person leaves: `leavers` with a single id, saying which kind of person it was. */
export function leaver(setup: CapacitySetup, model: EngineModel, result: SimulationResult, leaverId: string): LeaverResult | null {
  const res = leavers(setup, model, result, [leaverId]);
  if (!res) return null;
  const kind = busyShares(setup, model, result).people.find((p) => p.id === leaverId)!.kind;
  return { ...res, leaverId, kind };
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

/**
 * How close under their own utilisation threshold someone can be before they count as at risk ("near"): 10 percentage points, so a
 * threshold of 85% puts everyone from 75% up at risk. At or over the threshold is "over".
 */
export const AT_RISK_MARGIN = 0.1;

export type RiskStatus = "over" | "near";

/** Over (at or past the threshold), near (within `AT_RISK_MARGIN` under it), or null (fine). */
export function riskOf(busy: number, line: number): RiskStatus | null {
  return busy >= line ? "over" : busy >= line - AT_RISK_MARGIN - 1e-9 ? "near" : null;
}

export interface AtRiskPerson {
  person: PersonBusy;
  status: RiskStatus;
  /** What fills their month (hours a month, from the run), by the steps' purpose key, largest first; hand-holding is "Hand-holding". */
  byPurpose: { name: string; hours: number }[];
  /** The steps that take the most of their month, biggest first (`stepId` "hand" is hand-holding, which has no step). */
  steps: { stepId: string; name: string; hours: number }[];
}

/**
 * Everyone at risk, client-facing and shared teams alike: over their own utilisation threshold or within `AT_RISK_MARGIN` under it, over
 * first, then busiest first. Each with the hours the run gave them, by the purpose of the steps.
 */
export function atRisk(setup: CapacitySetup, model: EngineModel, result: SimulationResult, topSteps = 3): { over: number; near: number; people: AtRiskPerson[] } {
  const { people } = busyShares(setup, model, result);
  const purposeOf = new Map(model.steps.map((s) => [s.id, s.purpose?.trim() || "Other"]));
  const nameOf = new Map(model.steps.map((s) => [s.id, s.name]));
  const out: AtRiskPerson[] = [];
  for (const p of people) {
    const status = riskOf(p.busy, p.line);
    if (!status) continue;
    const hours: Record<string, number> = {};
    for (const [stepId, h] of Object.entries(result.personTime?.stepHours[p.id] ?? {})) {
      if (!(h > 0)) continue;
      const key = stepId === "hand" ? "Hand-holding" : (purposeOf.get(stepId) ?? "Other");
      hours[key] = (hours[key] ?? 0) + h;
    }
    const steps = Object.entries(result.personTime?.stepHours[p.id] ?? {})
      .filter(([, h]) => h > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topSteps)
      .map(([stepId, h]) => ({ stepId, name: stepId === "hand" ? "Hand-holding" : (nameOf.get(stepId) ?? stepId), hours: h }));
    out.push({ person: p, status, byPurpose: purposes(hours), steps });
  }
  out.sort((a, b) => (a.status === b.status ? 0 : a.status === "over" ? -1 : 1) || b.person.busy - a.person.busy || a.person.name.localeCompare(b.person.name));
  return { over: out.filter((x) => x.status === "over").length, near: out.filter((x) => x.status === "near").length, people: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Overview, per department (capacity build P6)

/** Whether a person whose salary counts in a department's (or the business's) DLER has none entered. False where pay is hidden. */
export function dlerSalariesMissing(setup: CapacitySetup, departmentId: string | null): boolean {
  if (setup.payHidden) return false;
  const { personRole, deptOf } = lookups(setup);
  return activePeople(setup).some((p) => {
    const d = deptOf(p);
    if (!d || (departmentId !== null && d !== departmentId)) return false;
    const role = personRole(p);
    return role?.kind === "client_facing" && inDler(setup, p, role) && p.salary_monthly === null;
  });
}

export interface DepartmentTimePart {
  name: string;
  hours: number;
  share: number;
}

/** The process each step of the model is in, by step id: a servicing process's own name; steps outside any (the sales pipeline) are "Sales". */
export function modelProcessOfStep(model: EngineModel): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of Object.values(model.servicingProcesses ?? {})) for (const id of p.steps) out.set(id, p.name);
  for (const s of model.steps) if (!out.has(s.id)) out.set(s.id, "Sales");
  return out;
}

/**
 * Where a department's time goes (hours a month, from the run): every step hour its people spend, grouped by the step's purpose
 * (default) or by the process the step is in (`by: { processOfStep }`, using the process names). `names` turns a purpose key into the words
 * the workspace uses; hand-holding is its own part either way.
 */
export function departmentTime(
  setup: CapacitySetup,
  model: EngineModel,
  result: SimulationResult,
  departmentId: string,
  names: Record<string, string> = {},
  by?: { processOfStep: ReadonlyMap<string, string> },
): { total: number; parts: DepartmentTimePart[] } {
  const { deptOf } = lookups(setup);
  const purposeOf = new Map(model.steps.map((s) => [s.id, s.purpose?.trim() || "Other"]));
  const hours: Record<string, number> = {};
  let total = 0;
  for (const p of activePeople(setup)) {
    if (deptOf(p) !== departmentId) continue;
    for (const [stepId, h] of Object.entries(result.personTime?.stepHours[p.id] ?? {})) {
      if (!(h > 0)) continue;
      const name = stepId === "hand" ? "Hand-holding" : by ? (by.processOfStep.get(stepId) ?? "Other") : (names[purposeOf.get(stepId) ?? "Other"] ?? purposeOf.get(stepId) ?? "Other");
      hours[name] = (hours[name] ?? 0) + h;
      total += h;
    }
  }
  return { total, parts: purposes(hours).map((x) => ({ ...x, share: total > 0 ? x.hours / total : 0 })) };
}

export interface WholeBusiness {
  /** Organic + Performance − taking both. */
  unique: number;
  byDepartment: { name: string; clients: number }[];
  both: number;
  employees: number;
  /** All retainers a month ÷ all employees (D22's definition of an employee). */
  revenuePerEmployee: number | null;
  /** The average of every client-facing person's DLER (D40). */
  dler: DlerRow;
}

export function wholeBusiness(setup: CapacitySetup): WholeBusiness {
  const lines = serviceLines(setup);
  const per = setup.departments.map((d) => perEmployee(setup, d.id));
  const employees = per.reduce((s, p) => s + p.employees, 0);
  const dl = dler(setup).whole;
  return {
    unique: lines.unique,
    byDepartment: lines.byDepartment.map((d) => ({ name: d.name, clients: d.clients })),
    both: lines.both,
    employees,
    revenuePerEmployee: employees > 0 ? setup.departments.reduce((a, d) => a + departmentRetainers(setup, d.id), 0) / employees : null,
    dler: dl,
  };
}
