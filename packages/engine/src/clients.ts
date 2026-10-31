// Client roster load (docs/PRD.md §6.3.4, decision D13; issue #18).
//
// With a roster, ongoing client work is per client: each client needs some
// hours a week from each role, and those hours go to the person assigned to
// it for that role. Pure functions of the model, shared by the simulation
// (which re-applies them as clients are won and churn) and the app (which
// shows each person's starting load without running anything).

import type { EngineClient, EngineModel, EnginePerson, SimulationResult } from "./model";
import { CLIENT_HEALTH_CUTOFFS, rateClientHealth, type Cutoffs, type Rating } from "./ratings";
import { hasServicing } from "./servicing";

/** Weeks in a month for monthly loads, as elsewhere in the engine (4.33). */
export const LOAD_WEEKS_PER_MONTH = 4.33;

/**
 * Hours a week a client needs from each role id. For each of its services
 * that has a fallback ongoing load: that service's hours per month / 4.33.
 * A service with servicing processes adds none: its tasks are the work
 * (docs/PRD.md §6.3.4, §6.3.5). When none of its services has either (or it
 * has no services the model knows), the roles' `ongoing` hours per client a
 * week, as the pooled model uses. Roles the model doesn't have, and zero
 * loads, are left out.
 */
export function clientRoleLoads(model: EngineModel, client: Pick<EngineClient, "services">): Record<string, number> {
  const out: Record<string, number> = {};
  let fromServices = false;
  for (const sid of client.services) {
    const service = model.services?.[sid];
    if (service && hasServicing(model, service)) {
      fromServices = true;
      continue;
    }
    const fallback = service?.fallbackOngoing;
    if (!fallback) continue;
    fromServices = true;
    for (const rid of Object.keys(fallback).sort()) {
      const monthly = fallback[rid]!;
      if (!(rid in model.roles) || !(monthly > 0)) continue;
      out[rid] = (out[rid] ?? 0) + monthly / LOAD_WEEKS_PER_MONTH;
    }
  }
  if (!fromServices) {
    for (const rid in model.roles) {
      const weekly = model.roles[rid]!.ongoing || 0;
      if (weekly > 0) out[rid] = weekly;
    }
  }
  return out;
}

/**
 * Hours a week of a client's unplanned hand-holding, by role id (docs/adr/0022-capacity-inputs.md): `handHoldingHours` a month /
 * 4.33, for the roles the model has. It is load like `fallbackOngoing`, but on top of the servicing tasks, not instead of them.
 * Empty for a client with none.
 */
export function clientHandHolding(model: Pick<EngineModel, "roles">, client: Pick<EngineClient, "handHoldingHours">): Record<string, number> {
  const out: Record<string, number> = {};
  const hh = client.handHoldingHours;
  if (!hh) return out;
  for (const rid of Object.keys(hh).sort()) {
    const monthly = hh[rid]!;
    if (rid in model.roles && Number.isFinite(monthly) && monthly > 0) out[rid] = monthly / LOAD_WEEKS_PER_MONTH;
  }
  return out;
}

/** Role ids of the steps that go to a client's manager (`toClientManager`): the client-facing roles. */
export function managerRoles(model: Pick<EngineModel, "steps">): Set<string> {
  return new Set(model.steps.flatMap((s) => (s.toClientManager && s.role ? [s.role] : [])));
}

/** Monthly churn of a client: the mean of its known services' base churn, or the model's. */
export function clientChurnMonthly(model: EngineModel, client: Pick<EngineClient, "services">): number {
  const known = client.services.map((sid) => model.services?.[sid]).filter((sv) => sv !== undefined);
  if (!known.length) return model.churnMonthly;
  return known.reduce((sum, sv) => sum + sv.churnMonthly, 0) / known.length;
}

/** Someone carrying a share of a role's load for a client. */
export interface Carrier {
  person: string;
  share: number;
}

/**
 * Members of each role who can carry pooled load (capacity above 0), in
 * people order, with their share: capacity split evenly across their roles,
 * over the role's total. The same split as the pooled `ongoing` load.
 */
export function rolePools(model: EngineModel, people: Record<string, EnginePerson>): Record<string, Carrier[]> {
  const pools: Record<string, Carrier[]> = {};
  for (const rid in model.roles) {
    const members = Object.entries(people).filter(([, p]) => p.capacity > 0 && p.roles.includes(rid));
    const total = members.reduce((sum, [, p]) => sum + p.capacity / p.roles.length, 0);
    pools[rid] = total > 0 ? members.map(([id, p]) => ({ person: id, share: p.capacity / p.roles.length / total })) : [];
  }
  return pools;
}

/** Who carries a client's load for a role: its assignee if the model has them, otherwise the role's pool. */
export function carriersFor(
  pools: Record<string, Carrier[]>,
  people: Record<string, EnginePerson>,
  roleId: string,
  assignee: string | undefined,
): Carrier[] {
  if (assignee !== undefined && assignee in people) return [{ person: assignee, share: 1 }];
  return pools[roleId] ?? [];
}

/** A person's starting load from the roster. */
export interface PersonLoad {
  /** Ongoing client hours a week, all roles together. */
  hours: number;
  /** The same by role id. */
  byRole: Record<string, number>;
  /** Clients assigned to them in any role (pooled load doesn't count). */
  clients: number;
}

/**
 * Each person's ongoing load from the roster as it stands (before anything
 * is won or churns): what the simulation starts from. Empty without a roster.
 */
export function rosterLoads(source: EngineModel, people: Record<string, EnginePerson>): Record<string, PersonLoad> {
  const model = withClientGroups(source);
  const out: Record<string, PersonLoad> = {};
  for (const pid in people) out[pid] = { hours: 0, byRole: {}, clients: 0 };
  if (!model.clients) return out;
  const pools = rolePools(model, people);
  const facing = managerRoles(model);
  for (const cid of Object.keys(model.clients)) {
    const client = model.clients[cid]!;
    const loads = clientRoleLoads(model, client);
    const carry = (rid: string, weekly: number, assignee: string | undefined) => {
      for (const c of carriersFor(pools, people, rid, assignee)) {
        const load = out[c.person]!;
        const hours = weekly * c.share;
        load.hours += hours;
        load.byRole[rid] = (load.byRole[rid] ?? 0) + hours;
      }
    };
    for (const rid in loads) carry(rid, loads[rid]!, client.assignments[rid]);
    // Hand-holding is on top of the servicing tasks; for a client-facing role it is the client's manager's.
    const hand = clientHandHolding(model, client);
    for (const rid in hand) carry(rid, hand[rid]!, facing.has(rid) && client.manager !== undefined ? client.manager : client.assignments[rid]);
    const mine = new Set(Object.values(client.assignments));
    if (client.manager !== undefined) mine.add(client.manager);
    for (const pid of mine) if (pid in out) out[pid]!.clients++;
  }
  return out;
}

// Client groups (docs/PRD.md decision D27; issue #120).
//
// A group counts the clients of one service instead of naming them. The
// engine turns each group into that many unnamed roster clients up front, so
// everything downstream (servicing tasks, health, churn, billing, load) is the
// one roster path, and late or missed work still moves health and drives
// churn. A client's base churn is read at `clientChurnMonthly` and applied at
// the weekly churn tick: that is where churn causes (A56) plug in, not here.

/** The most unnamed clients one group expands to, so a typo (1,500,000) can't freeze the browser. */
export const MAX_GROUP_CLIENTS = 2000;

const GROUP_KEY = "group:";

/** Roster key of the `n`th (from 1) unnamed client of a service's group. */
export const groupClientKey = (serviceId: string, n: number): string => `${GROUP_KEY}${serviceId}:${n}`;

/** The service id a roster key belongs to when it is an unnamed group client; null for a named client. */
export function groupServiceOf(clientKey: string): string | null {
  if (!clientKey.startsWith(GROUP_KEY)) return null;
  const at = clientKey.lastIndexOf(":");
  return at >= GROUP_KEY.length ? clientKey.slice(GROUP_KEY.length, at) : null;
}

/** Models already expanded (so the simulation's repeated calls cost nothing). */
const expanded = new WeakSet<EngineModel>();
const memo = new WeakMap<EngineModel, EngineModel>();

/**
 * The model with its client groups expanded: `clients` holds one unnamed
 * client per counted client (named `<service> <n>`, billing the group's fee,
 * starting at its health, assigned to nobody), and each grouped service takes
 * the group's normal churn and typical stay. Groups for services the model
 * doesn't know are ignored. A model with no groups, or whose groups count no
 * clients at all, is returned as it is (its interim count or named roster applies).
 * Pure, deterministic and memoised, so the same model always gives the same
 * clients in the same order (service id order, then number).
 */
export function withClientGroups(model: EngineModel): EngineModel {
  const groups = model.clientGroups;
  if (!groups || expanded.has(model) || !Object.keys(groups).length) return model;
  const cached = memo.get(model);
  if (cached) return cached;
  const counted = (sid: string) => (model.services?.[sid] ? Math.min(MAX_GROUP_CLIENTS, Math.max(0, Math.round(groups[sid]!.count))) : 0);
  // Groups with no clients counted at all don't switch the model over: the interim client count (or named roster) stays.
  if (!Object.keys(groups).some((sid) => counted(sid) > 0)) {
    memo.set(model, model);
    return model;
  }
  const services = { ...model.services };
  // "groups-add" (docs/adr/0022-capacity-inputs.md): the counted clients sit beside the named ones. Anything else is today's rule: they replace them.
  const add = model.clientMix === "groups-add";
  const clients: Record<string, EngineClient> = add ? { ...model.clients } : {};
  let total = add ? Object.keys(clients).length : 0;
  const portfolios = portfolioHolders(model);
  for (const sid of Object.keys(groups).sort()) {
    const g = groups[sid]!;
    const service = model.services?.[sid];
    if (!service) continue;
    services[sid] = { ...service, churnMonthly: g.churnMonthly, tenureMonths: g.stayMonths };
    const n = counted(sid);
    const holders = portfolios.length ? portfolioFill(model, sid, n, portfolios) : [];
    // (Keys stay unique beside named clients: a number whose key a named client already has is skipped.)
    for (let i = 1, k = 1; i <= n; i++, k++) {
      while (clients[groupClientKey(sid, k)]) k++;
      const holder = holders[i - 1];
      const c: EngineClient = { name: `${service.name} ${i}`, services: [sid], mrr: g.fee, health: g.health, assignments: holder?.assignments ?? {} };
      if (holder) c.manager = holder.manager;
      clients[groupClientKey(sid, k)] = c;
    }
    total += n;
  }
  const out: EngineModel = { ...model, services, clients, activeClients: total };
  expanded.add(out);
  memo.set(model, out);
  return out;
}

/** People with a portfolio, in people order (the order counted clients are dealt out in). */
function portfolioHolders(model: EngineModel): string[] {
  return Object.entries(model.people ?? {})
    .filter(([, p]) => p.portfolio && Object.values(p.portfolio).some((n) => Number.isFinite(n) && n > 0))
    .map(([id]) => id);
}

/** The roles a service's servicing steps use (the roles whose steps its clients' tasks queue for). */
function serviceRoles(model: EngineModel, sid: string): Set<string> {
  const out = new Set<string>();
  const stepRole = new Map(model.steps.map((s) => [s.id, s.role] as const));
  for (const link of model.services?.[sid]?.servicing ?? []) {
    for (const stepId of model.servicingProcesses?.[link.process]?.steps ?? []) {
      const role = stepRole.get(stepId);
      if (role) out.add(role);
    }
  }
  return out;
}

/**
 * Who looks after each of a group's `n` unnamed clients, in client order (docs/adr/0022-capacity-inputs.md): people with a
 * portfolio for the service take their count each, in people order. A client is assigned to its person in each of their roles
 * that the service's servicing steps use, and its manager is that person. The remainder (count less what people hold) is
 * left out, so it stays unassigned and shared as before. A sum above the count is cut off at the count (the check names it).
 */
function portfolioFill(model: EngineModel, sid: string, n: number, holders: string[]): { assignments: Record<string, string>; manager: string }[] {
  const out: { assignments: Record<string, string>; manager: string }[] = [];
  const roles = serviceRoles(model, sid);
  for (const pid of holders) {
    const person = model.people![pid]!;
    const want = Math.max(0, Math.round(person.portfolio?.[sid] ?? 0));
    if (!(want > 0)) continue;
    const assignments: Record<string, string> = {};
    for (const rid of person.roles) if (roles.has(rid)) assignments[rid] = pid;
    for (let i = 0; i < want && out.length < n; i++) out.push({ assignments, manager: pid });
  }
  return out;
}

/** One client group's simulated health. */
export interface ClientGroupHealth {
  /** The service id. */
  service: string;
  name: string;
  /** Clients in the group at the start. */
  clients: number;
  /** Average health at the horizon over its clients (0-100). */
  health: number;
  /** Average health at the start (0-100). */
  startHealth: number;
  /** Rule 9: the group's rating. */
  rating: Rating;
  /** Share of the group below the at-risk line (50) at the horizon. */
  atRisk: number;
  /** Clients of the group that churned in a run, on average. */
  churned: number;
}

/** The company's simulated client health, from a run. */
export interface ClientHealthSummary {
  /** Average health at the horizon over every client (0-100); null with no clients. */
  score: number | null;
  /** Rule 9's rating of the score. */
  rating: Rating | null;
  /** Shares of clients: healthy (health 65 or more), watch (50 to 65) and at risk (under 50). They add up to 1 with clients. */
  healthy: number;
  watch: number;
  atRisk: number;
  clients: number;
  /** One row per client group, in service id order; empty for a model with named clients only. */
  groups: ClientGroupHealth[];
}

/**
 * The company's client health and each client group's, from a run of `model`
 * (rule 9, docs/analysis-rules.md). Health is read at the horizon, averaged
 * over the replications; a client that churned keeps the health it left at.
 */
export function clientHealthSummary(model: EngineModel, result: SimulationResult, cutoffs: Cutoffs = CLIENT_HEALTH_CUTOFFS): ClientHealthSummary {
  const m = withClientGroups(model);
  const rows = Object.entries(result.clients ?? {});
  let sum = 0;
  let healthy = 0;
  let watch = 0;
  let atRisk = 0;
  const by = new Map<string, { n: number; end: number; start: number; risk: number; churned: number }>();
  for (const [key, c] of rows) {
    const h = c.health.mean;
    sum += h;
    if (h >= cutoffs[1]) healthy++;
    else if (h >= cutoffs[2]) watch++;
    else atRisk++;
    const sid = groupServiceOf(key);
    if (sid === null) continue;
    const g = by.get(sid) ?? { n: 0, end: 0, start: 0, risk: 0, churned: 0 };
    g.n++;
    g.end += h;
    g.start += c.trajectory[0] ?? h;
    g.risk += c.atRisk;
    g.churned += c.churned;
    by.set(sid, g);
  }
  const n = rows.length;
  const groups = [...by.keys()].sort().map((sid): ClientGroupHealth => {
    const g = by.get(sid)!;
    const health = g.end / g.n;
    return {
      service: sid,
      name: m.services?.[sid]?.name ?? sid,
      clients: g.n,
      health,
      startHealth: g.start / g.n,
      rating: rateClientHealth(health, cutoffs),
      atRisk: g.risk / g.n,
      churned: g.churned,
    };
  });
  return {
    score: n ? sum / n : null,
    rating: n ? rateClientHealth(sum / n, cutoffs) : null,
    healthy: n ? healthy / n : 0,
    watch: n ? watch / n : 0,
    atRisk: n ? atRisk / n : 0,
    clients: n,
    groups,
  };
}
