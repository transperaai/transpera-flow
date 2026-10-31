import { describe, expect, it } from "vitest";
import { capacityModel, simulate, type EngineClient, type EngineModel, type EngineService } from "../src";

// P7 (docs/plans/capacity/p7-sandbox-brief.md section 3): `EngineModel.wonClients` (extra clients won in a month, skipping the sales steps)
// and `EngineClient.leavesMonth` (a named client leaves in a month). Small models with constant times and no churn, so counts are exact.

const HPW = 40;

const service = (tier: string): EngineService => ({
  name: `Service ${tier}`,
  pricingModel: "retainer",
  price: 4330,
  margin: 0.5,
  tenureMonths: 12,
  churnMonthly: 0,
  mixShare: 1,
  pathTags: [],
  tier,
  deliverables: { meetings: 4 },
  servicing: [{ process: "care", recurrence: { perMonth: 1, driver: "meetings" }, sla: 1000 }],
});

/** Two services (`sa` Tier 1, `sb` Tier 2), one named client of `sa`, no leads, no churn, 26 weeks, three people. */
function model(extra: Partial<EngineModel> = {}, clients?: Record<string, EngineClient>): EngineModel {
  return {
    horizonWeeks: 26,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    roles: { r: { name: "Role r", count: 3, cost: 50, ongoing: 0 } },
    people: {
      ann: { name: "Ann", roles: ["r"], capacity: HPW, tiers: ["T1", "T2"] },
      bob: { name: "Bob", roles: ["r"], capacity: HPW, tiers: ["T1", "T2"] },
      cat: { name: "Cat", roles: ["r"], capacity: HPW, tiers: ["T2"] },
    },
    services: { sa: service("T1"), sb: service("T2") },
    servicingProcesses: { care: { name: "Care", entry: "task", steps: ["task"] } },
    clients: clients ?? { c1: { name: "C1", services: ["sa"], mrr: 4330, assignments: {} } },
    placeNewClients: "least-busy",
    entry: "a",
    sinks: { won: "won", lost: "lost" },
    ends: { care_done: { outcome: "done" } },
    steps: [
      { id: "a", name: "A", role: "r", work: 1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "won", p: 1 }] },
      { id: "task", name: "Task", role: "r", work: 1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "care_done", p: 1 }] },
    ],
    ...extra,
  };
}

const run = (m: EngineModel, reps = 1) => simulate(m, reps, 1, { monthly: true, personTime: true });
/** Mean clients of a service in each month. */
const clientsBy = (m: EngineModel, sid: string): number[] => run(m).monthly!.clients[sid]!.map((s) => s.mean);

describe("wonClients", () => {
  it("N clients a month for k months land N x k clients, by service, from their month on", () => {
    const m = model({
      wonClients: [
        { service: "sb", month: 2, count: 2 },
        { service: "sb", month: 3, count: 2 },
        { service: "sb", month: 4, count: 2 },
        { service: "sa", month: 3, count: 1 },
      ],
    });
    const sb = clientsBy(m, "sb");
    // The months' mean is of weekly counts, so a month with wins part way through is between the two whole numbers; the end counts are exact.
    expect(sb[0]).toBe(0);
    expect(sb[1]!).toBeGreaterThan(0);
    expect(sb[1]!).toBeLessThanOrEqual(2);
    expect(sb[4]).toBe(6);
    expect(sb[5]).toBe(6);
    const sa = clientsBy(m, "sa");
    expect(sa[0]).toBe(1);
    expect(sa[4]).toBe(2);
    // Counted as wins, and by tier in the result.
    const r = run(m);
    expect(r.kpi.won.mean).toBe(7);
  });

  it("a won client is placed on the least busy person who serves its tier", () => {
    const m = model({ wonClients: [{ service: "sb", month: 1, count: 3 }] });
    const t = run(m).personTime!;
    // Clients are averaged over the run (the three are won through month 1, so they count for about 5/6 of it). Cat serves Tier 2 only and is idle,
    // so she is one of the least busy: she gets some of the three, and every won client is somebody's.
    const held = (id: string) => Object.values(t.clients[id] ?? {}).reduce((a, b) => a + b, 0);
    expect(held("ann") + held("bob") + held("cat")).toBeGreaterThan(2.5);
    expect(held("cat")).toBeGreaterThan(0);
  });

  it("with none, or an empty list, the model runs exactly as before", () => {
    const base = JSON.stringify(simulate(model(), 3, 1, { monthly: true }));
    expect(JSON.stringify(simulate(model({ wonClients: [] }), 3, 1, { monthly: true }))).toBe(base);
  });

  it("an entry for an unknown service, a month past the end or a count of 0 is ignored", () => {
    const base = JSON.stringify(simulate(model(), 2, 1, { monthly: true }));
    const odd = model({ wonClients: [{ service: "nope", month: 1, count: 3 }, { service: "sa", month: 40, count: 3 }, { service: "sa", month: 1, count: 0 }, { service: "sa", month: 0, count: 2 }] });
    expect(JSON.stringify(simulate(odd, 2, 1, { monthly: true }))).toBe(base);
  });

  it("injected clients do not add to the time to win", () => {
    const withLeads = (extra: Partial<EngineModel>) => model({ leadsPerWeek: 5, ...extra });
    const a = simulate(withLeads({}), 2, 1);
    const b = simulate(withLeads({ wonClients: [{ service: "sa", month: 2, count: 4 }] }), 2, 1);
    // The four extra wins add nothing to the time to win (they would pull it towards 0), and are on top of what the lead flow wins.
    expect(b.kpi.cycle.mean).toBeGreaterThan(a.kpi.cycle.mean * 0.9);
    expect(b.kpi.won.mean).toBeGreaterThanOrEqual(a.kpi.won.mean + 3);
  });

  it("on the capacity example, 2 clients a month for 3 months bring 6 clients and their work", () => {
    const base = capacityModel();
    const plus: EngineModel = { ...base, wonClients: [{ service: "org-T2", month: 2, count: 2 }, { service: "org-T2", month: 3, count: 2 }, { service: "org-T2", month: 4, count: 2 }] };
    const opts = { monthly: true, personTime: true, monthStarts: undefined } as const;
    const a = simulate(base, 4, 1, opts);
    const b = simulate(plus, 4, 1, opts);
    const last = (r: typeof a) => r.monthly!.clients["org-T2"]!.at(-1)!.mean;
    // Six won, less the few the example's churn takes in the months after.
    expect(last(b) - last(a)).toBeGreaterThan(4.5);
    expect(last(b) - last(a)).toBeLessThan(6.5);
    const hours = (r: typeof a) => Object.values(r.personTime!.stepHours).reduce((s, p) => s + Object.values(p).reduce((x, y) => x + y, 0), 0);
    expect(hours(b)).toBeGreaterThan(hours(a));
  });
});

describe("leavesMonth", () => {
  const roster = (leavesMonth?: number): Record<string, EngineClient> => ({
    c1: { name: "C1", services: ["sa"], mrr: 4330, assignments: {}, ...(leavesMonth !== undefined ? { leavesMonth } : {}) },
    c2: { name: "C2", services: ["sa"], mrr: 4330, assignments: {} },
  });

  it("a named client leaves in its month and nobody else does", () => {
    const sa = clientsBy(model({}, roster(3)), "sa");
    expect(sa[0]).toBe(2);
    expect(sa[1]).toBe(2);
    // Gone by the end of month 3 (the first weekly tick on or after its start removes it).
    expect(sa[2]!).toBeLessThan(2);
    expect(sa[2]!).toBeGreaterThanOrEqual(1);
    expect(sa[3]).toBe(1);
    expect(sa[5]).toBe(1);
  });

  it("it counts as a lost client, with its fee", () => {
    const stay = run(model({}, roster()));
    const go = run(model({}, roster(3)));
    const lostRev = (r: typeof go) => r.monthly!.revenue.lostToChurn.reduce((s, x) => s + x.mean, 0);
    const lostClients = (r: typeof go) => r.monthly!.clientsLost.reduce((s, x) => s + x.mean, 0);
    expect(lostClients(stay)).toBe(0);
    expect(lostClients(go)).toBe(1);
    expect(lostRev(go)).toBeCloseTo(4330, 6);
  });

  it("with none set, or a month past the end, the run is exactly as before", () => {
    const base = JSON.stringify(simulate(model({}, roster()), 3, 1, { monthly: true }));
    expect(JSON.stringify(simulate(model({}, roster(40)), 3, 1, { monthly: true }))).toBe(base);
  });
});
