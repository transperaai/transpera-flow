// A `CapacitySetup` (what Set up loads) that agrees with an engine model built like `capacityModel()` (the prototype's example agency,
// made-up data): same ids for departments, tiers, services, roles, people and named clients. The Capacity page's tests use it to run the
// derived figures and the page on engine results without a database. Salaries, lines and rules are the prototype's.

import type { EngineModel } from "@transpera-flow/engine";
import type { CapacitySetup, SetupClient, SetupPerson, SetupPortfolioRow, SetupRole, SetupService } from "../capacity-setup";

const SALARY: Record<string, number> = { dir_org: 12500, mgr_org: 7500, dir_perf: 12000, pmm: 7000, content: 5500, links: 2500, tech: 7500, impl: 6000, track: 7000, sales: 8000 };
const ROLE_DEPT: Record<string, "org" | "perf"> = { dir_org: "org", mgr_org: "org", content: "org", links: "org", tech: "org", dir_perf: "perf", pmm: "perf", impl: "perf", track: "perf" };
const CLIENT_FACING = new Set(["dir_org", "mgr_org", "dir_perf", "pmm"]);
const RULE: Record<string, number> = { dir_org: 10, mgr_org: 10, dir_perf: 6, pmm: 15 };

export function capacitySetupFromModel(model: EngineModel, options: { payHidden?: boolean; dlerIncludesLeadership?: boolean; canEdit?: boolean } = {}): CapacitySetup {
  const hidden = options.payHidden === true;
  const departments = [
    { id: "org", name: "Organic (SEO)", sort: 1 },
    { id: "perf", name: "Performance", sort: 2 },
  ];
  const tiers = ["T1", "T2", "T3"].map((key, i) => ({ id: key, key, name: `Tier ${i + 1}`, sort: i + 1, both_count: 0, provenance: {} }));
  const services: SetupService[] = Object.entries(model.services ?? {}).map(([id, s]) => ({
    id,
    name: s.name,
    active: true,
    department_id: s.department ?? null,
    tier_id: s.tier ?? null,
    pricing_model: s.pricingModel,
    price: s.price,
    price_low: null,
    price_high: null,
    margin: s.margin,
    tenure_months: s.tenureMonths,
    churn_monthly_base: s.churnMonthly,
    churn_health_sensitivity: s.churnSensitivity ?? 0,
    mix_share: s.mixShare,
    entry_process_id: null,
    path_tags: [],
    words: s.deliverables?.words ?? null,
    links: s.deliverables?.links ?? null,
    tech_hours: s.deliverables?.techHours ?? null,
    meetings: s.deliverables?.meetings ?? null,
    builds: s.deliverables?.builds ?? null,
    creative_sets: s.deliverables?.creativeSets ?? null,
    channels: s.deliverables?.channels ?? null,
    adhoc_chance: s.adhoc?.chance ?? null,
    adhoc_requests: s.adhoc?.requests ?? null,
    price_rise_churn: 0,
    provenance: {},
  }));
  const roles: SetupRole[] = Object.entries(model.roles).map(([id, r]) => ({
    id,
    name: r.name,
    color: null,
    active: true,
    default_cost_rate: 0,
    headcount: r.count,
    ongoing_hours_per_client_week: 0,
    department_id: ROLE_DEPT[id] ?? null,
    kind: CLIENT_FACING.has(id) ? "client_facing" : "shared",
    line: id === "dir_perf" ? 0.8 : 0.85,
    rule_of_thumb: RULE[id] ?? null,
    unit: r.unit?.label ?? null,
    provenance: {},
  }));
  const people: SetupPerson[] = Object.entries(model.people ?? {}).map(([id, p]) => ({
    id,
    name: p.name,
    email: null,
    active: true,
    fte: 1,
    capacity_hours_week: p.capacity,
    cost_rate: null,
    start_date: null,
    end_date: null,
    notes: null,
    reserved_share: p.reservedShare ?? 0,
    salary_monthly: hidden ? null : (SALARY[p.roles[0]!] ?? null),
    label: id === "free" ? "contractor" : id === "tonie" || id === "jasfer" ? "offshore" : null,
    ramp: null,
    provenance: {},
    role_ids: p.roles,
    tier_ids: p.tiers ?? [],
  }));
  const portfolio: SetupPortfolioRow[] = [];
  for (const [id, p] of Object.entries(model.people ?? {})) for (const [service_id, client_count] of Object.entries(p.portfolio ?? {})) portfolio.push({ person_id: id, service_id, client_count, provenance: {} });
  const clients: SetupClient[] = Object.entries(model.clients ?? {}).map(([id, c]) => ({
    id,
    name: c.name,
    active: true,
    mrr: c.mrr,
    start_date: null,
    health: null,
    notes: null,
    provenance: {},
    service_ids: c.services,
    assignments: c.assignments,
    channels: c.overrides?.channels ?? null,
    hand_holding_hours: c.handHoldingHours ? Object.values(c.handHoldingHours)[0]! : null,
    adhoc_chance: c.overrides?.adhocChance ?? null,
    adhoc_requests: c.overrides?.adhocRequests ?? null,
    adhoc_hours: c.overrides?.adhocHours ?? null,
    meetings: c.overrides?.meetings ?? null,
    words: null,
    links: null,
    tech_hours: null,
    builds: null,
    creative_sets: null,
    step_factor: null,
  }));
  return {
    workspaceId: "ws",
    currency: "AUD",
    departments,
    tiers,
    services,
    groups: [],
    clients,
    roles,
    people,
    portfolio,
    rampDefault: [0.4, 0.6, 0.8],
    rampDefaultProvenance: null,
    dlerIncludesLeadership: options.dlerIncludesLeadership ?? true,
    dlerProvenance: null,
    canEdit: options.canEdit ?? true,
    payHidden: hidden,
  };
}
