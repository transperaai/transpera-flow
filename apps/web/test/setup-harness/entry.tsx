// The two Set up pages (Tiers & clients, People & roles) on a bare page, for ../setup-browser.test.ts (capacity build P1): the real
// components with the Server Actions stood in for by ../build-harness.ts (each call is noted on `window.__serverActions`). Nothing here ships.

import { createRoot } from "react-dom/client";
import type { CapacitySetup, SetupClient, SetupPerson, SetupRole, SetupService, SetupTier } from "@transpera-flow/db";
import type { ClientAssignmentRow, ClientRow, ClientServiceRow } from "@transpera-flow/db";
import { PeopleAndRoles } from "@/components/setup/people-roles";
import { TiersAndClients } from "@/components/setup/tiers-clients";
import type { WorkspaceSettingsData } from "@/lib/data";

declare global {
  interface Window {
    mountSetup: (options: { page: "clients" | "people"; who: "owner" | "viewer"; extraTiers?: number }) => void;
    __serverActions?: { name: string; args: unknown[] }[];
  }
}

const WS = "00000000-0000-4000-8000-000000000001";
const ORG = "d0000000-0000-4000-8000-000000000001";
const PERF = "d0000000-0000-4000-8000-000000000002";
const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const tier = (n: number, over: Partial<SetupTier> = {}): SetupTier => ({ id: id("a", n), key: `T${n}`, name: `Tier ${n}`, sort: n, both_count: n === 2 ? 5 : 0, provenance: {}, ...over });

function service(dept: string, t: SetupTier, over: Partial<SetupService>): SetupService {
  return {
    id: id(dept === ORG ? "b" : "c", Number(t.key.slice(1))),
    name: `${dept === ORG ? "Organic" : "Performance"} ${t.name}`,
    active: true,
    department_id: dept,
    tier_id: t.id,
    pricing_model: "retainer",
    price: 4500,
    price_low: null,
    price_high: null,
    margin: 0,
    tenure_months: 12,
    churn_monthly_base: 0.02,
    churn_health_sensitivity: 3,
    mix_share: 1,
    entry_process_id: null,
    path_tags: [],
    words: null,
    links: null,
    tech_hours: null,
    meetings: null,
    builds: null,
    creative_sets: null,
    channels: null,
    adhoc_chance: null,
    adhoc_requests: null,
    price_rise_churn: 0.5,
    provenance: {},
    ...over,
  };
}

function build(who: "owner" | "viewer", extraTiers: number) {
  const tiers = [tier(1), tier(2), tier(3), ...Array.from({ length: extraTiers }, (_, i) => tier(4 + i))];
  const services: SetupService[] = [];
  for (const t of tiers) {
    services.push(
      service(ORG, t, t.key === "T2" ? { price: 4500, words: 1500, links: 5, tech_hours: 5, meetings: 1, adhoc_chance: 0.7, adhoc_requests: null, provenance: { words: { source: "estimate" } } } : {}),
      service(PERF, t, t.key === "T2" ? { price: 3500, channels: 1.5, builds: 3, creative_sets: 1, meetings: 1, adhoc_chance: 0.7, adhoc_requests: 4.3 } : {}),
    );
  }
  const orgT1 = services[0]!;
  const roles: SetupRole[] = [
    { id: id("e", 1), name: "SEO Manager", color: null, active: true, default_cost_rate: 0, headcount: 1, ongoing_hours_per_client_week: 0, department_id: ORG, kind: "client_facing", line: 0.85, rule_of_thumb: 10, unit: null, provenance: { line: { source: "estimate" } } },
    { id: id("e", 2), name: "Content team", color: null, active: true, default_cost_rate: 0, headcount: 1, ongoing_hours_per_client_week: 0, department_id: ORG, kind: "shared", line: 0.85, rule_of_thumb: null, unit: "words", provenance: {} },
    { id: id("e", 3), name: "Technical SEO", color: null, active: true, default_cost_rate: 0, headcount: 1, ongoing_hours_per_client_week: 0, department_id: ORG, kind: "shared", line: 0.85, rule_of_thumb: null, unit: null, provenance: {} },
  ];
  const person = (n: number, name: string, role: string, over: Partial<SetupPerson> = {}): SetupPerson => ({
    id: id("f", n), name, email: null, active: true, fte: 1, capacity_hours_week: 38, cost_rate: null, start_date: null, end_date: null, notes: null, reserved_share: 0,
    salary_monthly: who === "owner" ? 7500 : null, label: null, ramp: null, provenance: {}, role_ids: [role], tier_ids: [], ...over,
  });
  const people = [person(1, "Karl", roles[0]!.id, { reserved_share: 0.2, salary_monthly: who === "owner" ? 10000 : null }), person(2, "Sarah", roles[1]!.id, { salary_monthly: null })];
  const clients: SetupClient[] = [
    {
      id: id("1", 1), name: "Harbourline Group", active: true, mrr: 13000, start_date: null, health: null, notes: null, provenance: {}, service_ids: [orgT1.id], assignments: { [roles[0]!.id]: people[0]!.id },
      channels: null, hand_holding_hours: 3, adhoc_chance: 1, adhoc_requests: 8, adhoc_hours: null, meetings: 4, words: null, links: null, tech_hours: null, builds: null, creative_sets: null, step_factor: null,
    },
  ];
  const setup: CapacitySetup = {
    workspaceId: WS,
    currency: "AUD",
    departments: [{ id: ORG, name: "Organic (SEO)", sort: 1 }, { id: PERF, name: "Performance", sort: 2 }],
    tiers,
    services,
    groups: [],
    clients,
    roles,
    people,
    portfolio: [{ person_id: people[0]!.id, service_id: services[2]!.id, client_count: 6, provenance: {} }],
    rampDefault: [0.4, 0.6, 0.8],
    rampDefaultProvenance: null,
    dlerIncludesLeadership: true,
    dlerProvenance: null,
    canEdit: who === "owner",
    payHidden: who !== "owner",
  };
  const data = {
    workspace: { id: WS, name: "Acme", slug: "acme", settings: { currency: "AUD", hours_per_week: 38 } },
    canEdit: who === "owner",
    canManage: who === "owner",
    roles: roles.map((r) => ({ id: r.id, name: r.name, color: null, active: true })),
    roleUsage: {},
    steps: [],
    people: people.map((p) => ({ id: p.id, workspace_id: WS, name: p.name, email: null, fte: 1, capacity_hours_week: p.capacity_hours_week, cost_rate: null, active: true, start_date: null, end_date: null, notes: null })),
    personRoles: people.flatMap((p) => p.role_ids.map((r) => ({ person_id: p.id, role_id: r, workspace_id: WS }))),
    personSkills: [],
    personLeave: [],
    personCapacityFactors: [],
    services: services.map((s) => ({ ...s, fallback_ongoing_load: {} })),
    processes: [],
    conditionTags: [],
    leadSources: [],
    seasonality: [],
    demand: null,
    servicingLinks: [],
    clientGroups: [],
    churnDrivers: [],
    marketConditions: [],
    marketSchedule: [],
  } as unknown as WorkspaceSettingsData;
  const roster = {
    clients: clients.map((c) => ({ id: c.id, workspace_id: WS, name: c.name, start_date: null, mrr: c.mrr, health: null, provenance: {}, notes: null, active: true })) as ClientRow[],
    clientServices: [{ client_id: clients[0]!.id, service_id: orgT1.id, workspace_id: WS, start_date: null }] as ClientServiceRow[],
    clientAssignments: [{ client_id: clients[0]!.id, role_id: roles[0]!.id, person_id: people[0]!.id, workspace_id: WS }] as ClientAssignmentRow[],
  };
  return { setup, data, roster };
}

window.mountSetup = ({ page, who, extraTiers = 0 }) => {
  const { setup, data, roster } = build(who, extraTiers);
  createRoot(document.getElementById("root")!).render(
    <div className="flex flex-col gap-6 p-4">{page === "clients" ? <TiersAndClients setup={setup} data={data} roster={roster} /> : <PeopleAndRoles setup={setup} data={data} />}</div>,
  );
};
