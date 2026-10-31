import { describe, expect, it } from "vitest";
import {
  SETUP_FIELDS,
  checkSetupValue,
  effectiveClientValue,
  formatRamp,
  parseRamp,
  missingForCapacity,
  setupFieldRule,
  sourceLabel,
  tierCount,
  tierFieldsFor,
  uniqueClients,
  type CapacitySetup,
  type SetupClient,
  type SetupPerson,
  type SetupRole,
  type SetupService,
} from "../src";

// The pure helpers behind the Set up screens, checked by hand against the prototype's example (`base()`):
// Organic T2 has Laura 2 + Karl 5 + Nadiya 6 + Zach 4 + JC 3 + the resigning manager 7 = 27 clients.

const svc = (id: string, department_id: string | null, tier_id: string | null, extra: Partial<SetupService> = {}): SetupService => ({
  id, name: id, active: true, department_id, tier_id, pricing_model: "retainer", price: 0, price_low: null, price_high: null, margin: 0, tenure_months: 12,
  churn_monthly_base: 0, churn_health_sensitivity: 3, mix_share: 1, entry_process_id: null, path_tags: [], words: null, links: null, tech_hours: null, meetings: null,
  builds: null, creative_sets: null, channels: null, adhoc_chance: null, adhoc_requests: null, price_rise_churn: 0.5, provenance: {}, ...extra,
});
const client = (id: string, service_ids: string[], extra: Partial<SetupClient> = {}): SetupClient => ({
  id, name: id, active: true, mrr: 0, start_date: null, health: null, notes: null, provenance: {}, service_ids, assignments: {}, channels: null, hand_holding_hours: null,
  adhoc_chance: null, adhoc_requests: null, adhoc_hours: null, meetings: null, words: null, links: null, tech_hours: null, builds: null, creative_sets: null, step_factor: null, ...extra,
});
const person = (id: string, role_ids: string[], extra: Partial<SetupPerson> = {}): SetupPerson => ({
  id, name: id, email: null, active: true, fte: 1, capacity_hours_week: 38, cost_rate: null, start_date: null, end_date: null, notes: null, reserved_share: 0, salary_monthly: 5000,
  label: null, ramp: null, provenance: {}, role_ids, tier_ids: [], ...extra,
});
const role = (id: string, kind: "client_facing" | "shared", extra: Partial<SetupRole> = {}): SetupRole => ({
  id, name: id, color: null, active: true, default_cost_rate: 0, headcount: 1, ongoing_hours_per_client_week: 0, department_id: null, kind, line: 0.85, rule_of_thumb: null, unit: null, leadership: false, provenance: {}, ...extra,
});

describe("tierCount", () => {
  const data = {
    clients: [client("n1", ["org-t1"]), client("n2", ["org-t1", "perf-t1"]), client("gone", ["org-t1"], { active: false })],
    portfolio: [
      { service_id: "org-t2", client_count: 2 }, { service_id: "org-t2", client_count: 5 }, { service_id: "org-t2", client_count: 6 },
      { service_id: "org-t2", client_count: 4 }, { service_id: "org-t2", client_count: 3 }, { service_id: "org-t2", client_count: 7 },
      { service_id: "org-t1", client_count: 0 },
    ],
    groups: [{ service_id: "org-t2", client_count: 3 }],
  };
  it("is the active named clients, plus everyone's portfolio, plus the group's remainder", () => {
    expect(tierCount("org-t2", data)).toBe(2 + 5 + 6 + 4 + 3 + 7 + 3);
    expect(tierCount("org-t1", data)).toBe(2);
    expect(tierCount("perf-t1", data)).toBe(1);
    expect(tierCount("nothing", data)).toBe(0);
  });
});

describe("uniqueClients", () => {
  const services = [svc("org-t1", "org", "t1"), svc("org-t2", "org", "t2"), svc("perf-t1", "perf", "t1"), svc("perf-t2", "perf", "t2"), svc("plain", null, null)];
  const tiers = [{ id: "t1", both_count: 1 }, { id: "t2", both_count: 5 }];

  it("adds each department's clients and takes off the ones counted twice: named with two departments, and the tiers' counts", () => {
    const data = {
      services,
      tiers,
      groups: [],
      clients: [client("harbourline", ["org-t1", "perf-t1"]), client("meridian", ["org-t1"]), client("northwind", ["perf-t1"])],
      portfolio: [{ service_id: "org-t2", client_count: 20 }, { service_id: "perf-t2", client_count: 12 }],
    };
    const u = uniqueClients(data);
    // org: 2 named on T1 + 20 = 22; perf: 2 named + 12 = 14; both: 1 named + 1 + 5 = 7; unique = 22 + 14 - 7.
    expect(u.byDepartment).toEqual({ org: 22, perf: 14 });
    expect(u.both).toBe(7);
    expect(u.unique).toBe(29);
  });

  it("ignores inactive clients and services without a tier", () => {
    const u = uniqueClients({
      services,
      tiers: [],
      groups: [{ service_id: "plain", client_count: 9 }],
      clients: [client("old", ["org-t1", "perf-t1"], { active: false })],
      portfolio: [],
    });
    expect(u).toEqual({ byDepartment: { org: 0, perf: 0 }, both: 0, unique: 0 });
  });
});

describe("missingForCapacity", () => {
  const departments = [{ id: "org", name: "Organic (SEO)", sort: 1 }, { id: "perf", name: "Performance", sort: 2 }];
  const tiers = [{ id: "t1", key: "T1", name: "Tier 1", sort: 1, both_count: 0, provenance: {} }];
  const base = {
    departments,
    tiers,
    services: [
      svc("org-t1", "org", "t1", { words: 4000, links: 8, tech_hours: 10, meetings: 4, adhoc_chance: 0.9, adhoc_requests: null }),
      svc("perf-t1", "perf", "t1", { channels: 4, builds: 5, creative_sets: 2, meetings: 4, adhoc_chance: 0.95, adhoc_requests: 8.5 }),
    ],
    roles: [role("mgr", "client_facing"), role("content", "shared", { unit: "words" }), role("links", "shared")],
    people: [person("karl", ["mgr"]), person("sarah", ["content"], { salary_monthly: null }), person("free", ["content"], { salary_monthly: null, label: "contractor" })],
    portfolio: [],
    clients: [],
  };

  it("lists a blank tier deliverable, a client-facing person with no clients, a shared role with no unit or rate, and a person with no salary", () => {
    const m = missingForCapacity(base, { rates: { content: 1000 } });
    expect(m.map((x) => [x.kind, x.id, x.field ?? ""])).toEqual([
      ["tier_deliverable", "org-t1", "adhoc_requests"],
      ["client_facing_portfolio", "karl", ""],
      ["shared_role_unit", "links", ""],
      ["shared_role_rate", "links", ""],
      ["person_salary", "sarah", ""],
    ]);
    expect(m[0]!.label).toBe("Organic (SEO) T1: requests if they ask");
  });

  it("every shared role is missing its rate until one is keyed (rates aren't stored in Set up)", () => {
    expect(missingForCapacity(base).filter((x) => x.kind === "shared_role_rate").map((x) => x.id)).toEqual(["content", "links"]);
  });

  it("a portfolio count, or a named client they look after, fills a client-facing person in", () => {
    expect(missingForCapacity({ ...base, portfolio: [{ person_id: "karl", service_id: "org-t1", client_count: 3, provenance: {} }] }).some((x) => x.kind === "client_facing_portfolio")).toBe(false);
    expect(missingForCapacity({ ...base, portfolio: [{ person_id: "karl", service_id: "org-t1", client_count: 0, provenance: {} }] }).some((x) => x.kind === "client_facing_portfolio")).toBe(true);
    expect(missingForCapacity({ ...base, clients: [client("n1", ["org-t1"], { assignments: { mgr: "karl" } })] }).some((x) => x.kind === "client_facing_portfolio")).toBe(false);
  });

  it("says nothing about salaries when the viewer can't see pay, and skips people who are not active", () => {
    expect(missingForCapacity(base, { salariesVisible: false }).some((x) => x.kind === "person_salary")).toBe(false);
    expect(missingForCapacity({ ...base, people: [person("gone", ["mgr"], { active: false, salary_monthly: null })] }).some((x) => x.id === "gone")).toBe(false);
  });

  it("is empty when everything is entered", () => {
    const full = {
      ...base,
      services: [
        svc("org-t1", "org", "t1", { words: 1, links: 1, tech_hours: 1, meetings: 1, adhoc_chance: 0, adhoc_requests: 0 }),
        svc("perf-t1", "perf", "t1", { channels: 1, builds: 1, creative_sets: 1, meetings: 1, adhoc_chance: 0, adhoc_requests: 0 }),
      ],
      roles: [role("mgr", "client_facing"), role("content", "shared", { unit: "words" })],
      people: [person("karl", ["mgr"])],
      portfolio: [{ person_id: "karl", service_id: "org-t1", client_count: 1, provenance: {} }],
    };
    expect(missingForCapacity(full, { rates: { content: 1000 } })).toEqual([]);
  });
});

describe("tierFieldsFor and effectiveClientValue", () => {
  it("gives Performance its own fields and any other department the Organic ones", () => {
    expect(tierFieldsFor("Performance")).toEqual(["channels", "builds", "creative_sets", "meetings", "adhoc_chance", "adhoc_requests"]);
    expect(tierFieldsFor("Organic (SEO)")).toEqual(["words", "links", "tech_hours", "meetings", "adhoc_chance", "adhoc_requests"]);
  });
  it("a client's own value wins; blank takes its tier's", () => {
    const services = [svc("perf-t1", "perf", "t1", { channels: 4, adhoc_chance: 0.95 })];
    expect(effectiveClientValue(client("a", ["perf-t1"], { channels: 6 }), services, "channels")).toBe(6);
    expect(effectiveClientValue(client("a", ["perf-t1"]), services, "channels")).toBe(4);
    expect(effectiveClientValue(client("a", ["perf-t1"]), services, "words")).toBeNull();
    expect(effectiveClientValue(client("a", ["perf-t1"], { adhoc_chance: 0 }), services, "adhoc_chance")).toBe(0);
  });
});

describe("the field rules", () => {
  it("accept in-range numbers, null where allowed, and refuse the rest", () => {
    const chance = setupFieldRule("services", "adhoc_chance")!;
    expect(checkSetupValue(chance, 0.9)).toEqual({ ok: true, value: 0.9 });
    expect(checkSetupValue(chance, null)).toEqual({ ok: true, value: null });
    for (const bad of [1.1, -0.1, "0.5", Number.NaN, Infinity]) expect(checkSetupValue(chance, bad).ok, String(bad)).toBe(false);
    const salary = setupFieldRule("people", "salary_monthly")!;
    expect(checkSetupValue(salary, 0).ok).toBe(true);
    expect(checkSetupValue(salary, -1).ok).toBe(false);
    const share = setupFieldRule("people", "reserved_share")!;
    expect(checkSetupValue(share, 0.9).ok).toBe(true);
    expect(checkSetupValue(share, 0.91).ok).toBe(false);
    expect(checkSetupValue(share, null).ok).toBe(false);
    const count = setupFieldRule("person_portfolio", "client_count")!;
    expect(checkSetupValue(count, 3).ok).toBe(true);
    expect(checkSetupValue(count, 2.5).ok).toBe(false);
  });
  it("trim text, turn empty optional text into null, and check enums, ids and ramps", () => {
    expect(checkSetupValue(setupFieldRule("tiers", "name")!, "  Tier 4 ")).toEqual({ ok: true, value: "Tier 4" });
    expect(checkSetupValue(setupFieldRule("tiers", "name")!, "  ").ok).toBe(false);
    expect(checkSetupValue(setupFieldRule("roles", "unit")!, " ")).toEqual({ ok: true, value: null });
    expect(checkSetupValue(setupFieldRule("people", "label")!, "offshore").ok).toBe(true);
    expect(checkSetupValue(setupFieldRule("people", "label")!, "intern").ok).toBe(false);
    expect(checkSetupValue(setupFieldRule("roles", "kind")!, "shared").ok).toBe(true);
    expect(checkSetupValue(setupFieldRule("roles", "kind")!, null).ok).toBe(false);
    expect(checkSetupValue(setupFieldRule("roles", "department_id")!, "a0000000-0000-4000-8000-000000000001").ok).toBe(true);
    expect(checkSetupValue(setupFieldRule("roles", "department_id")!, "nope").ok).toBe(false);
    expect(checkSetupValue(setupFieldRule("people", "ramp")!, [0.4, 0.6, 0.8]).ok).toBe(true);
    expect(checkSetupValue(setupFieldRule("people", "ramp")!, []).ok).toBe(false);
    expect(checkSetupValue(setupFieldRule("people", "ramp")!, [0.4, 1.2]).ok).toBe(false);
  });
  it("only knows the columns the screens save", () => {
    expect(setupFieldRule("services", "id")).toBeNull();
    expect(setupFieldRule("services", "workspace_id")).toBeNull();
    expect(setupFieldRule("people", "cost_rate")).toBeNull();
    expect(setupFieldRule("nothing", "name")).toBeNull();
    expect(setupFieldRule("toString", "name")).toBeNull();
    expect(Object.keys(SETUP_FIELDS).sort()).toEqual(["clients", "departments", "people", "person_portfolio", "roles", "services", "tiers"]);
  });
});

describe("ramp text", () => {
  it("reads percent lists, blank as null, and refuses anything out of range", () => {
    expect(parseRamp("40, 60, 80")).toEqual([0.4, 0.6, 0.8]);
    expect(parseRamp("40% 60%")).toEqual([0.4, 0.6]);
    expect(parseRamp("12.5")).toEqual([0.125]);
    expect(parseRamp("")).toBeNull();
    expect(parseRamp(null)).toBeNull();
    for (const bad of ["abc", "40, x", "120", "-5", "1,2,3,4,5,6,7,8,9,10,11,12,13"]) expect(parseRamp(bad), bad).toBeUndefined();
  });
  it("shows a ramp the way it is typed", () => {
    expect(formatRamp([0.4, 0.6, 0.8])).toBe("40, 60, 80");
    expect(formatRamp([0.125])).toBe("12.5");
    expect(formatRamp(null)).toBeNull();
    expect(formatRamp([])).toBeNull();
    expect(parseRamp(formatRamp([0.333333]))).toEqual([0.333]);
  });
});

describe("sourceLabel", () => {
  it("says nothing for entered numbers and names the other sources", () => {
    expect(sourceLabel({ words: { source: "entered" } }, "words")).toBeNull();
    expect(sourceLabel({}, "words")).toBeNull();
    expect(sourceLabel(null, "words")).toBeNull();
    expect(sourceLabel({ words: { source: "estimate" } }, "words")).toBe("Estimate");
    expect(sourceLabel({ words: { source: "estimated" } }, "words")).toBe("Estimate");
    expect(sourceLabel({ words: { source: "interview" } }, "words")).toBe("From an interview");
    expect(sourceLabel({ words: { source: "calculator" } }, "words")).toBe("From the calculator");
    expect(sourceLabel({ words: { source: "measured" } }, "words")).toBe("Measured");
  });
});

// Typed so the shape of the loaded data is tied to the helpers' input.
export type _Check = Pick<CapacitySetup, "departments" | "tiers" | "services" | "roles" | "people" | "portfolio" | "clients">;
