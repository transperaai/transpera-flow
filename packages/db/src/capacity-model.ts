// The capacity Set up data as engine inputs (work package P2b; docs/plans/capacity/p2b-mapping-brief.md, docs/adr/0022-capacity-inputs.md).
//
// Pure functions that `toEngineModel` (model.ts) calls, and only in a TIER WORKSPACE: one with at least one active service that has a
// department and a tier. Any other workspace never reaches this file, so its model is the one built before capacity existed
// (test/engine-model-snapshot.test.ts proves it). What is mapped (P1's column -> the engine's field):
//
//   services.department_id, tier_id         EngineService.department (the department id), tier (`tiers.key`)
//   services deliverables, adhoc_*          EngineService.deliverables, adhoc (a null column is left out: missing, not 0)
//   clients deliverables, adhoc_*, step_factor   EngineClient.overrides {deliverable keys, adhocChance, adhocRequests, adhocHours, stepFactor}
//   clients.hand_holding_hours              EngineClient.handHoldingHours[role], the role being the client's manager's client-facing role
//   client_assignments to a client-facing role   EngineClient.manager (that person)
//   client_groups.client_count + person_portfolio   EngineClientGroup.count (clientMix "groups-add"); EnginePerson.portfolio
//   people.reserved_share                   EnginePerson.reservedShare (left out when 0)
//   people.ramp, else settings.ramp_default EnginePerson.ramp (only a person whose start date falls after the run's start)
//   person_tiers                            EnginePerson.tiers (tier keys; no rows: every tier)
//   roles.unit                              EngineRole.unit.label
//                                           EngineModel.placeNewClients = "least-busy"
//
// Not mapped, here (P4's, in parallel): step fields (split, tier multiplier, `toClientManager`, sources) and driver recurrences.
// Not an engine input at all: tiers.both_count, services.price_rise_churn (P7), roles.line / rule_of_thumb, salary, labels.

import type { EngineClient, EngineClientGroup, EnginePerson, EngineRole, EngineService, ClientOverrides, TierDeliverables } from "@transpera-flow/engine";
import type { CapacityClientRow, CapacityDeliverableColumns, CapacityInputs, CapacityServiceRow, ClientGroupRow, ProcessBundle } from "./types";

/** New starters reach about 80% in three months. P1's default (`DEFAULT_RAMP` in capacity-setup.ts), repeated here to keep the mapping free of the loaders. */
const DEFAULT_RAMP: readonly number[] = [0.4, 0.6, 0.8];

/** The Set up columns of a tier's deliverables, and the engine key each becomes. */
const DELIVERABLE_KEYS: readonly (readonly [keyof CapacityDeliverableColumns, keyof TierDeliverables])[] = [
  ["words", "words"],
  ["links", "links"],
  ["tech_hours", "techHours"],
  ["meetings", "meetings"],
  ["builds", "builds"],
  ["creative_sets", "creativeSets"],
  ["channels", "channels"],
];

/** A finite number, or null (a column that was never entered, or junk). */
const finite = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** What the mapping reads of a tier workspace, worked out once per model. */
export interface TierContext {
  cap: CapacityInputs;
  /** Tier key by tier id. */
  tierKey: ReadonlyMap<string, string>;
  /** The Set up row of each tier service (a department and a tier), by service id. */
  tierServices: ReadonlyMap<string, CapacityServiceRow>;
  /** Role kind by role id. */
  roleKind: ReadonlyMap<string, "client_facing" | "shared">;
}

/**
 * The context when the workspace is a tier workspace: its bundle carries capacity data and at least one active service has a
 * department and a tier. Undefined otherwise, and then nothing here applies.
 */
export function tierContext(bundle: Pick<ProcessBundle, "capacity" | "services">): TierContext | undefined {
  const cap = bundle.capacity;
  if (!cap) return undefined;
  const active = new Set(bundle.services.filter((s) => s.active).map((s) => s.id));
  const tierServices = new Map(cap.services.filter((s) => s.department_id && s.tier_id && active.has(s.id)).map((s) => [s.id, s]));
  if (!tierServices.size) return undefined;
  return {
    cap,
    tierKey: new Map(cap.tiers.map((t) => [t.id, t.key])),
    tierServices,
    roleKind: new Map(cap.roles.map((r) => [r.id, r.kind])),
  };
}

/** A tier's deliverables for the engine: the columns that are entered, nothing for a blank one. Undefined when none is. */
export function deliverablesOf(row: CapacityDeliverableColumns): TierDeliverables | undefined {
  const out: TierDeliverables = {};
  for (const [column, key] of DELIVERABLE_KEYS) {
    const v = finite(row[column]);
    if (v !== null) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A tier service's engine fields: its department, its tier key, its deliverables and its ad-hoc rule. The ad-hoc rule needs both the
 * chance and the requests (the engine's `ServiceAdhoc` has no half); with one blank it is left out and `checkCapacityInputs` says so.
 */
export function engineTierService(ctx: TierContext, serviceId: string): Pick<EngineService, "department" | "tier" | "deliverables" | "adhoc"> | undefined {
  const row = ctx.tierServices.get(serviceId);
  if (!row) return undefined;
  const tier = ctx.tierKey.get(row.tier_id!);
  const deliverables = deliverablesOf(row);
  const chance = finite(row.adhoc_chance);
  const requests = finite(row.adhoc_requests);
  return {
    department: row.department_id!,
    ...(tier !== undefined ? { tier } : {}),
    ...(deliverables ? { deliverables } : {}),
    ...(chance !== null && requests !== null ? { adhoc: { chance, requests } } : {}),
  };
}

/**
 * A named client's manager: the person it is assigned to in a client-facing role (the first such role by id, if it has more than
 * one), and that role. None when it has no assignment to a client-facing role.
 */
export function clientManager(ctx: TierContext, assignments: Readonly<Record<string, string>>): { person: string; role: string } | undefined {
  for (const role of Object.keys(assignments).sort()) {
    if (ctx.roleKind.get(role) === "client_facing") return { person: assignments[role]!, role };
  }
  return undefined;
}

/**
 * A named client's capacity fields: its own values as `overrides` (each replaces its tier's; a blank is left out), its manager, and its
 * hand-holding hours on the manager's role. Hand-holding for a client with no client-facing manager has no role to sit on and is not mapped.
 */
export function engineClientCapacity(ctx: TierContext, clientId: string, assignments: Readonly<Record<string, string>>): Partial<Pick<EngineClient, "overrides" | "handHoldingHours" | "manager">> {
  const row: CapacityClientRow | undefined = ctx.cap.clients.find((c) => c.id === clientId);
  const manager = clientManager(ctx, assignments);
  const out: Partial<Pick<EngineClient, "overrides" | "handHoldingHours" | "manager">> = {};
  if (manager) out.manager = manager.person;
  if (!row) return out;
  const overrides: ClientOverrides = { ...deliverablesOf(row) };
  const chance = finite(row.adhoc_chance);
  const requests = finite(row.adhoc_requests);
  const hours = finite(row.adhoc_hours);
  const factor = finite(row.step_factor);
  if (chance !== null) overrides.adhocChance = chance;
  if (requests !== null) overrides.adhocRequests = requests;
  if (hours !== null) overrides.adhocHours = hours;
  if (factor !== null) overrides.stepFactor = factor;
  if (Object.keys(overrides).length) out.overrides = overrides;
  const hand = finite(row.hand_holding_hours);
  if (manager && hand !== null && hand > 0) out.handHoldingHours = { [manager.role]: hand };
  return out;
}

/** The role's unit of work for the engine's reporting; none for a blank one. */
export function engineRoleUnit(ctx: TierContext, roleId: string): EngineRole["unit"] | undefined {
  const unit = ctx.cap.roles.find((r) => r.id === roleId)?.unit?.trim();
  return unit ? { label: unit } : undefined;
}

/**
 * A person's capacity fields. `rampStarts`: their start date falls after the run's start, so they are a new starter (anyone already
 * employed has full hours, as today). Team time is left out when 0; the ramp is theirs, else the workspace default; the tiers are the
 * keys of their `person_tiers` (none: every tier); the portfolio is their counted clients per service.
 */
export function enginePersonCapacity(
  ctx: TierContext,
  personId: string,
  options: { rampStarts: boolean; rampDefault: readonly number[] | null | undefined; serviceIds: ReadonlySet<string> },
): Partial<Pick<EnginePerson, "reservedShare" | "ramp" | "tiers" | "portfolio">> {
  const out: Partial<Pick<EnginePerson, "reservedShare" | "ramp" | "tiers" | "portfolio">> = {};
  const row = ctx.cap.people.find((p) => p.id === personId);
  const reserved = finite(row?.reserved_share);
  if (reserved !== null && reserved > 0) out.reservedShare = reserved;
  if (options.rampStarts) {
    const ramp = row?.ramp ?? (options.rampDefault && options.rampDefault.length ? options.rampDefault : DEFAULT_RAMP);
    out.ramp = [...ramp];
  }
  const tiers = ctx.cap.personTiers
    .filter((pt) => pt.person_id === personId)
    .map((pt) => ({ key: ctx.tierKey.get(pt.tier_id), sort: ctx.cap.tiers.find((t) => t.id === pt.tier_id)?.sort ?? 0 }))
    .filter((t): t is { key: string; sort: number } => t.key !== undefined)
    .sort((a, b) => a.sort - b.sort || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((t) => t.key);
  if (tiers.length) out.tiers = tiers;
  const portfolio: Record<string, number> = {};
  for (const r of ctx.cap.portfolio.filter((r) => r.person_id === personId).sort((a, b) => (a.service_id < b.service_id ? -1 : a.service_id > b.service_id ? 1 : 0))) {
    if (options.serviceIds.has(r.service_id) && ctx.tierServices.has(r.service_id) && Number.isFinite(r.client_count) && r.client_count > 0) portfolio[r.service_id] = r.client_count;
  }
  if (Object.keys(portfolio).length) out.portfolio = portfolio;
  return out;
}

/**
 * Counted clients per service in a tier workspace: a tier service's count is its group's `client_count` (counted clients nobody's
 * portfolio holds yet) plus everyone's portfolio for it; the rest of the group's numbers are the group's row, else the service's own
 * (fee, base churn, tenure) and the default health of a client with none entered. A service that is not a tier service keeps its
 * group row as it is. Undefined when no client is counted.
 */
export function engineTierClientGroups(
  ctx: TierContext,
  rows: readonly ClientGroupRow[],
  services: Record<string, EngineService>,
): Record<string, EngineClientGroup> | undefined {
  const groups: Record<string, EngineClientGroup> = {};
  for (const sid of Object.keys(services).sort()) {
    const row = rows.find((g) => g.service_id === sid);
    // Everyone's portfolio counts, whether or not they are on the team on the start date (as Set up's own count does, `tierCount`).
    const held = ctx.cap.portfolio.filter((r) => r.service_id === sid && Number.isFinite(r.client_count) && r.client_count > 0).reduce((sum, r) => sum + r.client_count, 0);
    const isTier = ctx.tierServices.has(sid);
    if (!row && !(isTier && held > 0)) continue;
    const sv = services[sid]!;
    groups[sid] = {
      count: (row ? Number(row.client_count) : 0) + (isTier ? held : 0),
      fee: row ? Number(row.fee) : sv.price,
      churnMonthly: row ? Number(row.churn_monthly) : sv.churnMonthly,
      stayMonths: row ? Number(row.stay_months) : sv.tenureMonths,
      health: row ? Number(row.starting_health) : 80,
    };
  }
  const counted = Object.values(groups).reduce((a, g) => a + Math.round(g.count), 0);
  return counted > 0 ? groups : undefined;
}
