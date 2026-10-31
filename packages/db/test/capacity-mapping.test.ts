import { describe, expect, it } from "vitest";
import { larkspurBundle, toEngineModel, type CapacityClientRow, type CapacityInputs, type CapacityServiceRow, type ClientGroupRow, type ProcessBundle } from "../src";

// P2b (docs/plans/capacity/p2b-mapping-brief.md section 1): P1's Set up columns reach the engine in a tier workspace, and only there.
// Larkspur (3 services, 10 people, 18 named clients, no counted clients) is the base; `capacity` is added by hand, so each test reads
// as one row of the brief's table.

const START = "2026-10-05";
const base = larkspurBundle();
const [S1, S2, S3] = base.services.map((s) => s.id) as [string, string, string];
const ROLE_A = base.roles[1]!.id; // Account manager: client-facing
const ROLE_SHARED = base.roles[2]!.id; // Designer: a shared team
const [P1, P2] = base.people.map((p) => p.id) as [string, string];
const C1 = base.clients![0]!.id;
const DEPT = "d0000000-0000-4000-8000-000000000001";
const T1 = "f0000000-0000-4000-8000-000000000001";
const T2 = "f0000000-0000-4000-8000-000000000002";

const blank = {
  words: null, links: null, tech_hours: null, meetings: null, builds: null, creative_sets: null, channels: null,
} as const;
const svc = (id: string, tier: string | null, over: Partial<CapacityServiceRow> = {}): CapacityServiceRow => ({
  id, department_id: tier ? DEPT : null, tier_id: tier, ...blank, adhoc_chance: null, adhoc_requests: null, ...over,
});
const client = (id: string, over: Partial<CapacityClientRow> = {}): CapacityClientRow => ({
  id, ...blank, hand_holding_hours: null, adhoc_chance: null, adhoc_requests: null, adhoc_hours: null, step_factor: null, ...over,
});

/** The bundle as a tier workspace: S1 is Tier 1 and S2 Tier 2 of one department, S3 has none. Everything else is blank. */
function tiered(over: Partial<CapacityInputs> = {}, bundle: ProcessBundle = base): ProcessBundle {
  const capacity: CapacityInputs = {
    tiers: [{ id: T1, key: "T1", sort: 1 }, { id: T2, key: "T2", sort: 2 }],
    services: [svc(S1, T1), svc(S2, T2), svc(S3, null)],
    clients: [],
    roles: bundle.roles.map((r) => ({ id: r.id, kind: r.id === ROLE_SHARED ? "shared" : "client_facing", unit: null })),
    people: [],
    personTiers: [],
    portfolio: [],
    ...over,
  };
  return { ...bundle, capacity };
}
const model = (b: ProcessBundle, planned = false) => toEngineModel(b, { startDate: START, planned });
const plain = model(base);

describe("a service is one tier of one department", () => {
  it("maps the department id and the tier key onto the services that have them", () => {
    const m = model(tiered());
    expect(m.services![S1]).toMatchObject({ department: DEPT, tier: "T1" });
    expect(m.services![S2]).toMatchObject({ department: DEPT, tier: "T2" });
    // A service with no department and tier is as it was.
    expect(m.services![S3]).toEqual(plain.services![S3]);
  });
});

describe("a tier's deliverables and ad-hoc rule", () => {
  it("maps every deliverable column to its engine key, and leaves a blank one out (not 0)", () => {
    const row = svc(S1, T1, { words: 4000, links: 8, tech_hours: 10, meetings: 4, builds: 5, creative_sets: 2, channels: 3, adhoc_chance: 0.9, adhoc_requests: 6.5 });
    const m = model(tiered({ services: [row, svc(S2, T2, { words: 1500, meetings: 1 }), svc(S3, null)] }));
    expect(m.services![S1]!.deliverables).toEqual({ words: 4000, links: 8, techHours: 10, meetings: 4, builds: 5, creativeSets: 2, channels: 3 });
    expect(m.services![S1]!.adhoc).toEqual({ chance: 0.9, requests: 6.5 });
    expect(m.services![S2]!.deliverables).toEqual({ words: 1500, meetings: 1 });
    expect("links" in m.services![S2]!.deliverables!).toBe(false);
    expect(m.services![S2]!.adhoc).toBeUndefined();
  });

  it("keeps a real 0 (entered) as 0", () => {
    const m = model(tiered({ services: [svc(S1, T1, { words: 0, adhoc_chance: 0, adhoc_requests: 0 }), svc(S2, T2), svc(S3, null)] }));
    expect(m.services![S1]!.deliverables).toEqual({ words: 0 });
    expect(m.services![S1]!.adhoc).toEqual({ chance: 0, requests: 0 });
  });

  it("leaves the ad-hoc rule out when only half of it is entered (the check names it)", () => {
    const m = model(tiered({ services: [svc(S1, T1, { adhoc_chance: 0.5 }), svc(S2, T2, { adhoc_requests: 3 }), svc(S3, null)] }));
    expect(m.services![S1]!.adhoc).toBeUndefined();
    expect(m.services![S2]!.adhoc).toBeUndefined();
  });
});

describe("a named client's own values", () => {
  it("maps the overrides: deliverable keys, adhocChance, adhocRequests, adhocHours and stepFactor; blanks are left out", () => {
    const own = client(C1, { channels: 6, meetings: 4, words: 2000, links: 1, tech_hours: 2, builds: 3, creative_sets: 4, adhoc_chance: 1, adhoc_requests: 8, adhoc_hours: 1, step_factor: 1.2 });
    const m = model(tiered({ clients: [own] }));
    expect(m.clients![C1]!.overrides).toEqual({
      channels: 6, meetings: 4, words: 2000, links: 1, techHours: 2, builds: 3, creativeSets: 4, adhocChance: 1, adhocRequests: 8, adhocHours: 1, stepFactor: 1.2,
    });
    const partial = model(tiered({ clients: [client(C1, { meetings: 2 })] }));
    expect(partial.clients![C1]!.overrides).toEqual({ meetings: 2 });
    // A client with nothing of its own, or no Set up row, has no overrides.
    expect(model(tiered({ clients: [client(C1)] })).clients![C1]!.overrides).toBeUndefined();
    expect(model(tiered()).clients![C1]!.overrides).toBeUndefined();
  });
});

describe("a client's manager and hand-holding hours", () => {
  const assigned = base.clientAssignments!.filter((a) => a.client_id === C1);
  const mine = assigned.find((a) => a.role_id === ROLE_A);

  it("the person assigned in a client-facing role is the client's manager", () => {
    expect(mine, "Larkspur's first client has an account manager").toBeDefined();
    expect(model(tiered()).clients![C1]!.manager).toBe(mine!.person_id);
  });

  it("an assignment in a shared role is not a manager", () => {
    const only = { ...base, clientAssignments: [{ client_id: C1, role_id: ROLE_SHARED, person_id: P1, workspace_id: base.workspace.id }] };
    expect(model(tiered({}, only)).clients![C1]!.manager).toBeUndefined();
  });

  it("hand-holding hours sit on the manager's client-facing role", () => {
    const m = model(tiered({ clients: [client(C1, { hand_holding_hours: 3 })] }));
    expect(m.clients![C1]!.handHoldingHours).toEqual({ [ROLE_A]: 3 });
    // Blank or 0: none. No manager to hold them: none.
    expect(model(tiered({ clients: [client(C1)] })).clients![C1]!.handHoldingHours).toBeUndefined();
    expect(model(tiered({ clients: [client(C1, { hand_holding_hours: 0 })] })).clients![C1]!.handHoldingHours).toBeUndefined();
    const unmanaged = { ...base, clientAssignments: [] };
    expect(model(tiered({ clients: [client(C1, { hand_holding_hours: 3 })] }, unmanaged)).clients![C1]!.handHoldingHours).toBeUndefined();
  });
});

describe("counted clients and portfolios", () => {
  const group = (service_id: string, client_count: number): ClientGroupRow => ({
    id: `g${client_count}-${service_id.slice(-2)}`, workspace_id: base.workspace.id, service_id, client_count, fee: 4500, churn_monthly: 0.02, stay_months: 40, starting_health: 75, provenance: {},
  });

  it("each tier service's group count is its group's count plus everyone's portfolio, simulated beside the named clients", () => {
    const b = tiered({ portfolio: [{ person_id: P1, service_id: S1, client_count: 3 }, { person_id: P2, service_id: S1, client_count: 2 }, { person_id: P1, service_id: S2, client_count: 4 }] });
    const m = model({ ...b, clientGroups: [group(S1, 5)] });
    expect(m.clientMix).toBe("groups-add");
    expect(m.clientGroups![S1]).toEqual({ count: 10, fee: 4500, churnMonthly: 0.02, stayMonths: 40, health: 75 });
    // S2 has no group row: its count is the portfolio, and its fee, churn and tenure are the service's own.
    const sv2 = base.services.find((s) => s.id === S2)!;
    expect(m.clientGroups![S2]).toEqual({ count: 4, fee: Number(sv2.price), churnMonthly: Number(sv2.churn_monthly_base), stayMonths: Number(sv2.tenure_months), health: 80 });
    expect(m.clientGroups![S3]).toBeUndefined();
    // The 18 named clients are still there, and everyone counts in the headline number.
    expect(Object.keys(m.clients!)).toHaveLength(18);
    expect(m.activeClients).toBe(18 + 10 + 4);
  });

  it("without any counted client there are no groups and no mix", () => {
    const m = model(tiered());
    expect(m.clientGroups).toBeUndefined();
    expect(m.clientMix).toBeUndefined();
    expect(Object.keys(m.clients!)).toHaveLength(18);
  });

  it("counts a portfolio of someone who isn't on the team on the start date, as Set up's own count does", () => {
    const m = model(tiered({ portfolio: [{ person_id: "00000000-0000-4000-8000-0000000000aa", service_id: S1, client_count: 6 }] }));
    expect(m.clientGroups![S1]!.count).toBe(6);
    expect(Object.values(m.people!).every((p) => p.portfolio === undefined)).toBe(true);
  });

  it("maps a person's portfolio by service id (a service that isn't a tier service is not mapped)", () => {
    const m = model(tiered({ portfolio: [{ person_id: P1, service_id: S1, client_count: 3 }, { person_id: P1, service_id: S2, client_count: 0 }, { person_id: P1, service_id: S3, client_count: 7 }] }));
    expect(m.people![P1]!.portfolio).toEqual({ [S1]: 3 });
    expect(m.people![P2]!.portfolio).toBeUndefined();
  });
});

describe("a person's team time, ramp and tiers", () => {
  it("team time is reservedShare, left out when 0", () => {
    const m = model(tiered({ people: [{ id: P1, reserved_share: 0.25, ramp: null }, { id: P2, reserved_share: 0, ramp: null }] }));
    expect(m.people![P1]!.reservedShare).toBe(0.25);
    expect("reservedShare" in m.people![P2]!).toBe(false);
  });

  describe("ramp", () => {
    const joiner = (): ProcessBundle => ({
      ...base,
      people: base.people.map((p) => (p.id === P1 ? { ...p, start_date: "2026-12-01" } : p)),
    });
    const caps = (ramp: number[] | null) => ({ people: [{ id: P1, reserved_share: 0, ramp }, { id: P2, reserved_share: 0, ramp: ramp ?? [0.5] }] });

    it("a person who starts during the run gets their own ramp, else the workspace's default, else the built-in one", () => {
      expect(model(tiered(caps([0.5, 0.9]), joiner()), true).people![P1]!.ramp).toEqual([0.5, 0.9]);
      const withDefault = tiered(caps(null), joiner());
      expect(model({ ...withDefault, workspace: { ...withDefault.workspace, settings: { ...withDefault.workspace.settings, ramp_default: [0.3, 0.6] } } }, true).people![P1]!.ramp).toEqual([0.3, 0.6]);
      expect(model(tiered(caps(null), joiner()), true).people![P1]!.ramp).toEqual([0.4, 0.6, 0.8]);
    });

    it("today's staff have no ramp, whoever has one stored", () => {
      const m = model(tiered(caps([0.5, 0.9]), joiner()), true);
      expect(m.people![P2]!.ramp).toBeUndefined();
      // Without the forecast the joiner isn't on the team at all.
      expect(model(tiered(caps([0.5, 0.9]), joiner())).people![P1]).toBeUndefined();
      expect(Object.values(model(tiered(caps([0.5, 0.9]))).people!).every((p) => p.ramp === undefined)).toBe(true);
    });
  });

  it("person_tiers are tier keys, in tier order; no rows is every tier", () => {
    const m = model(tiered({ personTiers: [{ person_id: P1, tier_id: T2 }, { person_id: P1, tier_id: T1 }, { person_id: P2, tier_id: T2 }] }));
    expect(m.people![P1]!.tiers).toEqual(["T1", "T2"]);
    expect(m.people![P2]!.tiers).toEqual(["T2"]);
    const none = model(tiered());
    expect(Object.values(none.people!).every((p) => p.tiers === undefined)).toBe(true);
  });
});

describe("roles and placement", () => {
  it("a role's unit is the unit label", () => {
    const roles = base.roles.map((r) => ({ id: r.id, kind: r.id === ROLE_SHARED ? ("shared" as const) : ("client_facing" as const), unit: r.id === ROLE_SHARED ? "words" : "  " }));
    const m = model(tiered({ roles }));
    expect(m.roles[ROLE_SHARED]!.unit).toEqual({ label: "words" });
    expect(m.roles[ROLE_A]!.unit).toBeUndefined();
  });

  it("won clients go to the least busy person who serves the tier", () => {
    expect(model(tiered()).placeNewClients).toBe("least-busy");
  });
});

describe("a workspace that isn't a tier workspace is mapped as before", () => {
  it("no capacity data: the model is the plain one", () => {
    expect(model(base)).toEqual(plain);
  });

  it("capacity data but no service with both a department and a tier: the plain model, whatever else is keyed", () => {
    const b = tiered({
      services: [svc(S1, null, { words: 5 }), svc(S2, null), svc(S3, null)],
      clients: [client(C1, { hand_holding_hours: 3, meetings: 2 })],
      people: [{ id: P1, reserved_share: 0.3, ramp: null }],
      personTiers: [{ person_id: P1, tier_id: T1 }],
      portfolio: [{ person_id: P1, service_id: S1, client_count: 3 }],
    });
    expect(model(b)).toEqual(plain);
  });

  it("a tier service with nothing keyed is the plain model plus its department, its tier, least-busy placement and the managers the assignments give", () => {
    const m = model(tiered());
    // Every named client keeps its assignments; the one in a client-facing role also becomes its manager (the only addition on clients).
    for (const c of Object.values(m.clients!)) expect(Object.values(c.assignments)).toContain(c.manager);
    m.clients = Object.fromEntries(Object.entries(m.clients!).map(([id, { manager: _manager, ...c }]) => [id, c]));
    const expected = structuredClone(plain);
    expected.services![S1] = { ...expected.services![S1]!, department: DEPT, tier: "T1" };
    expected.services![S2] = { ...expected.services![S2]!, department: DEPT, tier: "T2" };
    expected.placeNewClients = "least-busy";
    expect(m).toEqual(expected);
  });

  it("an inactive tier service doesn't make a tier workspace", () => {
    const b = tiered({ services: [svc(S1, T1), svc(S2, null), svc(S3, null)] });
    const off = { ...b, services: b.services.map((s) => (s.id === S1 ? { ...s, active: false } : s)) };
    const plainOff = model({ ...base, services: off.services });
    expect(model(off)).toEqual(plainOff);
  });
});
