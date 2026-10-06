import { describe, expect, it } from "vitest";
import {
  clientRoleLoads,
  detectIssues,
  northbeamModel,
  northbeamWithClients,
  rosterLoads,
  runOnce,
  simulate,
  type EngineClient,
  type EngineModel,
  type EnginePerson,
  type EngineService,
} from "../src";

// Client roster, fallback ongoing load, overtime and the floor (docs/PRD.md
// §6.3.4, §6.8 item 2, decisions D7 and D13; issue #18).

const HPW = 40;

const service = (fallbackOngoing?: Record<string, number>, extra: Partial<EngineService> = {}): EngineService => ({
  name: "Retainer",
  pricingModel: "retainer",
  price: 1000,
  margin: 0.5,
  tenureMonths: 12,
  churnMonthly: 0,
  mixShare: 1,
  pathTags: [],
  ...(fallbackOngoing ? { fallbackOngoing } : {}),
  ...extra,
});

const person = (name: string, roles: string[], extra: Partial<EnginePerson> = {}): EnginePerson => ({ name, roles, capacity: HPW, ...extra });

const client = (assignments: Record<string, string>, services = ["svc"]): EngineClient => ({ name: "Client", services, mrr: 1000, assignments });

/**
 * One role `r` with two people; one step `a` (constant `work` hours) that
 * every lead passes and is then won (or lost). No warm-up.
 */
function model(extra: Partial<EngineModel> = {}, opts: { leads?: number; work?: number; outcome?: "won" | "lost" } = {}): EngineModel {
  return {
    horizonWeeks: 10,
    hoursPerWeek: HPW,
    leadsPerWeek: opts.leads ?? 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    roles: { r: { name: "Role r", count: 2, cost: 50, ongoing: 0 } },
    people: { ann: person("Ann", ["r"]), bob: person("Bob", ["r"]) },
    services: { svc: service({ r: 4.33 * 10 }) },
    entry: "a",
    sinks: { won: "won", lost: "lost" },
    steps: [
      { id: "a", name: "A", role: "r", work: opts.work ?? 1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: opts.outcome ?? "won", p: 1 }] },
    ],
    ...extra,
  };
}

describe("clientRoleLoads and rosterLoads", () => {
  it("a client's load is its services' fallback hours a month / 4.33, summed over services", () => {
    const m = model({ services: { a: service({ r: 8.66 }), b: service({ r: 4.33, x: 10 }) } });
    expect(clientRoleLoads(m, { services: ["a", "b"] })).toEqual({ r: 3 });
  });

  it("with no fallback load on any of its services, the roles' `ongoing` hours per client apply", () => {
    const m = model({ services: { a: service() } });
    m.roles.r!.ongoing = 1.5;
    expect(clientRoleLoads(m, { services: ["a"] })).toEqual({ r: 1.5 });
    expect(clientRoleLoads(m, { services: [] })).toEqual({ r: 1.5 });
  });

  it("per-person load and client counts come from assignments; unassigned load is shared by capacity", () => {
    const m = model({
      people: { ann: person("Ann", ["r"]), bob: person("Bob", ["r"], { capacity: 20 }) },
      clients: { c1: client({ r: "ann" }), c2: client({ r: "ann" }), c3: client({ r: "bob" }), c4: client({}) },
    });
    const loads = rosterLoads(m, m.people!);
    // 10 h/wk per client; c4's is split 40:20 between them.
    expect(loads.ann!.hours).toBeCloseTo(20 + 10 * (2 / 3), 10);
    expect(loads.bob!.hours).toBeCloseTo(10 + 10 / 3, 10);
    expect(loads.ann!.clients).toBe(2);
    expect(loads.bob!.clients).toBe(1);
  });
});

describe("fallback ongoing load follows the roster", () => {
  it("is derived from each person's assigned clients", () => {
    const m = model({ clients: { c1: client({ r: "ann" }), c2: client({ r: "ann" }), c3: client({ r: "bob" }) } });
    const r = runOnce(m, 1, false);
    expect(r.people.ann!.ongoingHours).toBeCloseTo(20, 10);
    expect(r.people.bob!.ongoingHours).toBeCloseTo(10, 10);
    expect(r.people.ann!.clients).toBeCloseTo(2, 10);
    expect(r.roles.r!.ongoingHours).toBeCloseTo(30, 10);
    expect(r.activeEnd).toBe(3);
  });

  it("is recomputed as clients are won: each win adds a client, assigned by round-robin", () => {
    const m = model({ clients: {} }, { leads: 1 });
    const r = runOnce(m, 3, true);
    const wins = r.entities!.filter((e) => e.outcome === "won").map((e) => e.done!).sort((a, b) => a - b);
    expect(wins.length).toBeGreaterThan(4);
    expect(r.activeEnd).toBe(wins.length);
    // Round-robin: the 1st, 3rd, … win goes to Ann, the others to Bob; each carries 10 h/wk from its win on.
    const H = m.horizonWeeks * HPW;
    const hours = (who: 0 | 1) => wins.reduce((sum, t, i) => sum + (i % 2 === who ? (10 * (H - t)) / HPW : 0), 0);
    expect(r.people.ann!.ongoingHours * m.horizonWeeks).toBeCloseTo(hours(0), 8);
    expect(r.people.bob!.ongoingHours * m.horizonWeeks).toBeCloseTo(hours(1), 8);
  });

  it("is recomputed as clients churn: they leave one by one and their load goes with them", () => {
    // A weekly churn chance of 1: every client leaves at the first weekly tick.
    const certain = model({ services: { svc: service({ r: 43.3 }, { churnMonthly: 4.33 }) }, clients: { c1: client({ r: "ann" }), c2: client({ r: "bob" }) } });
    const gone = runOnce(certain, 1, false);
    expect(gone.people.ann!.ongoingHours).toBeCloseTo(10 / certain.horizonWeeks, 10);
    expect(gone.clientsChurned).toBe(2);
    expect(gone.activeEnd).toBe(0);

    // At 50% a month over a long run, some leave and the reported load falls with them.
    const clients = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, client({ r: i % 2 ? "ann" : "bob" })]));
    const churny = model({ horizonWeeks: 26, services: { svc: service({ r: 43.3 }, { churnMonthly: 0.5 }) }, clients });
    const r = runOnce(churny, 1, false);
    expect(r.clientsChurned).toBeGreaterThan(5);
    expect(r.activeEnd).toBe(20 - r.clientsChurned!);
    expect(r.roles.r!.ongoingHours).toBeLessThan(200);
    expect(r.roles.r!.ongoingHours).toBeGreaterThan(10 * r.activeEnd);
  });

  it("a client's load goes to its assignee even outside their role, or to the role's pool when the assignee is unknown", () => {
    const m = model({
      roles: { r: { name: "R", count: 1, cost: 1, ongoing: 0 }, s: { name: "S", count: 1, cost: 1, ongoing: 0 } },
      people: { ann: person("Ann", ["r"]), bob: person("Bob", ["s"]) },
      services: { svc: service({ r: 43.3, s: 43.3 }) },
      clients: { c1: client({ r: "bob", s: "gone" }) },
    });
    const r = runOnce(m, 1, false);
    expect(r.people.bob!.ongoingHours).toBeCloseTo(20, 10);
    expect(r.people.ann!.ongoingHours).toBe(0);
    expect(r.roles.r!.ongoingHours).toBeCloseTo(10, 10);
  });
});

describe("reported ongoing utilisation is the load the run used (prototype bug, PRD §6.8 item 2)", () => {
  // The pooled model: 5 starting clients × 2 h/wk on one person, no churn;
  // every lead is won and adds a client.
  const pooled: EngineModel = {
    ...model({ people: undefined, services: undefined, activeClients: 5 }, { leads: 1, work: 2 }),
    roles: { r: { name: "Role r", count: 1, cost: 50, ongoing: 2 } },
  };

  it("reports the live client count's load, not the starting count's", () => {
    const r = runOnce(pooled, 2, true);
    const H = pooled.horizonWeeks * HPW;
    const wins = r.entities!.filter((e) => e.outcome === "won").map((e) => e.done!);
    expect(wins.length).toBeGreaterThan(4);
    const expected = (2 * (5 * H + wins.reduce((sum, t) => sum + (H - t), 0))) / H;
    const reported = r.roles.r!.ongoingHours;
    expect(reported).toBeCloseTo(expected, 8);
    // The prototype reported 5 × 2 = 10 h/wk whatever was won.
    expect(reported).toBeGreaterThan(10.5);
    expect(r.people["r#1"]!.ongoingHours).toBeCloseTo(reported, 8);
  });

  it("each service was stretched by exactly the availability that load left", () => {
    const r = runOnce(pooled, 2, true);
    const wins = r.entities!.filter((e) => e.outcome === "won").map((e) => e.done!);
    for (const seg of r.entities!.flatMap((e) => e.trace)) {
      if (seg.tS === null || seg.tE === null || seg.tS < 0) continue;
      const frac = 2 / (seg.tE - seg.tS);
      const active = (HPW - frac * HPW) / 2;
      // Wins at the same instant may land just before or after the start.
      const before = 5 + wins.filter((t) => t < seg.tS!).length;
      const upTo = 5 + wins.filter((t) => t <= seg.tS!).length;
      expect(Math.round(active * 1e6) / 1e6).toBeGreaterThanOrEqual(before);
      expect(Math.round(active * 1e6) / 1e6).toBeLessThanOrEqual(upTo);
    }
  });
});

describe("overtime and the floor (decision D7)", () => {
  // Ann carries 44 h/wk of client work against 40 h; Bob carries none.
  const overloaded = (cap: number | undefined, extra: Partial<EngineModel> = {}) =>
    model({
      services: { svc: service({ r: 4.33 * 11 }) },
      clients: { c1: client({ r: "ann" }), c2: client({ r: "ann" }), c3: client({ r: "ann" }), c4: client({ r: "ann" }) },
      ...(cap !== undefined ? { overtimeCap: cap } : {}),
      ...extra,
    });

  it("with no cap (the default) there is no overtime and utilisation shows above 100%", () => {
    const r = simulate(overloaded(undefined), 3, 1);
    expect(r.people.ann!.ongoingHours).toBeCloseTo(44, 8);
    expect(r.people.ann!.util).toBeCloseTo(1.1, 8);
    expect(r.people.ann!.overtimeHours).toBe(0);
    expect(r.kpi.overtimeHours.mean).toBe(0);
    expect(r.kpi.overtimeCost!.mean).toBe(0);
  });

  it("within the cap, the overflow becomes overtime hours and cost, and utilisation stays at 100%", () => {
    const m = overloaded(0.2);
    const r = simulate(m, 3, 1);
    expect(r.people.ann!.overtimeHours).toBeCloseTo(4, 8);
    expect(r.people.ann!.util).toBeCloseTo(1, 8);
    expect(r.people.ann!.overtime).toBeCloseTo(0.1, 8);
    expect(r.people.bob!.overtimeHours).toBe(0);
    expect(r.roles.r!.overtimeHours).toBeCloseTo(4, 8);
    expect(r.kpi.overtimeHours.mean).toBeCloseTo(4 * m.horizonWeeks, 8);
    // Ann's cost rate is her role's: 50 an hour.
    expect(r.kpi.overtimeCost!.mean).toBeCloseTo(4 * m.horizonWeeks * 50, 6);
    expect(r.kpi.overtimeCost!.p10).toBeLessThanOrEqual(r.kpi.overtimeCost!.mean);
  });

  it("a person's own cost rate prices their overtime", () => {
    const m = overloaded(0.2, { people: { ann: person("Ann", ["r"], { cost: 80 }), bob: person("Bob", ["r"]) } });
    expect(simulate(m, 1, 1).kpi.overtimeCost!.mean).toBeCloseTo(4 * m.horizonWeeks * 80, 6);
  });

  it("with payHidden, everything but the pay-dependent figures is the same, and those are unavailable, not 0", () => {
    const full = overloaded(0.2, { people: { ann: person("Ann", ["r"], { cost: 80 }), bob: person("Bob", ["r"]) } });
    const hidden: EngineModel = {
      ...full,
      payHidden: true,
      people: { ann: person("Ann", ["r"]), bob: person("Bob", ["r"]) },
    };
    const rf = simulate(full, 3, 1);
    const rh = simulate(hidden, 3, 1);
    expect(rf.kpi.overtimeCost).not.toBeNull();
    expect(rh.kpi.overtimeCost).toBeNull();
    expect(rh.kpi.overtimeHours).toEqual(rf.kpi.overtimeHours);
    expect(rh.kpi.won).toEqual(rf.kpi.won);
    expect(rh.kpi.labour).toEqual(rf.kpi.labour);
    expect(rh.people).toEqual(rf.people);

    const issuesFull = detectIssues(full, rf);
    const issuesHidden = detectIssues(hidden, rh);
    const ot = issuesHidden.find((i) => i.key === "overtime:person:ann")!;
    expect(ot.cost).toMatchObject({ perMonth: null, hoursPerMonth: null, payHidden: true });
    expect(ot.metrics).not.toHaveProperty("overtime_cost");
    expect(ot.evidence).not.toMatch(/cost|[£$]/i);
    const otFull = issuesFull.find((i) => i.key === "overtime:person:ann")!;
    expect(ot.rating).toBe(otFull.rating);
    expect(ot.title).toBe(otFull.title);
    // No issue shows a money figure built from a person's pay.
    for (const i of issuesHidden) if (i.cost.payHidden) expect(i.cost.perMonth).toBeNull();
    expect(issuesHidden.map((i) => i.key).sort()).toEqual(issuesFull.map((i) => i.key).sort());
  });

  it("beyond the cap, overtime stops at the cap and utilisation shows above 100%", () => {
    const r = simulate(overloaded(0.05), 3, 1);
    expect(r.people.ann!.overtimeHours).toBeCloseTo(2, 8);
    expect(r.people.ann!.util).toBeCloseTo(44 / 42, 8);
    expect(r.people.ann!.util).toBeGreaterThan(1);
  });

  it("overtime extends pipeline capacity too: with room under the cap, pipeline work is stretched less", () => {
    // Ann is pinned to the step. Capacity 40 + 20% = 48 h; 44 h of client work leaves 4 h: 10% of a week.
    const pinned = (cap: number) => {
      const m = overloaded(cap);
      m.leadsPerWeek = 0.5;
      // Lost, so no new client adds to Ann's load.
      m.steps = m.steps.map((s) => ({ ...s, person: "ann", next: [{ to: "lost", p: 1 }] }));
      return m;
    };
    const durations = (m: EngineModel) =>
      runOnce(m, 1, true)
        .entities!.flatMap((e) => e.trace)
        .filter((s) => s.tS !== null && s.tE !== null)
        .map((s) => s.tE! - s.tS!);
    // Work 1 h at 10% of the week takes 10 h; with no cap, the 8% floor: 12.5 h.
    for (const d of durations(pinned(0.2))) expect(d).toBeCloseTo(10, 8);
    for (const d of durations(pinned(0))) expect(d).toBeCloseTo(12.5, 8);
  });

  it("with pipeline work while overloaded, overtime counts it up to the cap", () => {
    const m = overloaded(0.2, { leadsPerWeek: 2 });
    m.steps = m.steps.map((s) => ({ ...s, person: "ann", next: [{ to: "lost", p: 1 }] }));
    const r = simulate(m, 5, 1);
    const ann = r.people.ann!;
    expect(ann.overtimeHours).toBeGreaterThan(4);
    expect(ann.overtimeHours).toBeLessThanOrEqual(8 + 1e-9);
    expect(ann.util).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("client work over capacity raises a critical capacity issue; within the cap, an overtime finding instead", () => {
    const none = detectIssues(overloaded(0), simulate(overloaded(0), 3, 1));
    const critical = none.find((i) => i.key === "capacity:person:ann")!;
    expect(critical.rating).toBe("risk");
    expect(critical.title).toBe("Ann: client work alone exceeds capacity");
    expect(none.some((i) => i.key.startsWith("overtime:"))).toBe(false);

    const within = detectIssues(overloaded(0.2), simulate(overloaded(0.2), 3, 1));
    expect(within.find((i) => i.key === "capacity:person:ann")?.title).not.toContain("client work alone");
    const ot = within.find((i) => i.key === "overtime:person:ann")!;
    expect(ot.type).toBe("capacity");
    expect(ot.title).toBe("Ann works 4 h/wk overtime");
    // 4 of 8 cap hours: Bad on the average; raised to Operational risk because Ann is the bottleneck.
    expect(ot).toMatchObject({ rating: "risk", escalation: { base: "bad", bottleneck: true } });
    expect(ot.metrics.overtime_cost).toBeCloseTo(4 * 10 * 50, 6);

    const beyond = detectIssues(overloaded(0.05), simulate(overloaded(0.05), 3, 1));
    expect(beyond.find((i) => i.key === "capacity:person:ann")!.title).toBe("Ann: client work alone exceeds capacity even with overtime");
    expect(beyond.find((i) => i.key === "overtime:person:ann")!.rating).toBe("risk");
  });

  it("never blocks a run: a roster far beyond everyone's capacity still simulates", () => {
    const clients = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, client({ r: "ann" })]));
    const r = simulate(model({ clients, overtimeCap: 0.1 }, { leads: 3 }), 3, 1);
    expect(r.people.ann!.util).toBeGreaterThan(9);
    expect(r.won).toBeGreaterThan(0);
  });
});

describe("compatibility and determinism", () => {
  it("a model without a roster or cap runs exactly as with an explicit 0% cap", () => {
    const golden = JSON.stringify(simulate(northbeamModel(), 10, 1));
    expect(JSON.stringify(simulate({ ...northbeamModel(), overtimeCap: 0 }, 10, 1))).toBe(golden);
  });

  it("the golden model's flow is untouched: only reported ongoing load changed", () => {
    const r = simulate(northbeamModel(), 30, 1);
    // Wins and cycle time never depended on the reporting bug.
    expect(r.bnRole).toBe("strat");
    expect(r.roles.strat!.util).toBeGreaterThan(0.8);
    expect(r.roles.strat!.util).toBeLessThan(0.9);
    expect(r.kpi.overtimeHours.mean).toBe(0);
  });

  it("Northbeam's roster: same seed, same result; strategist still the bottleneck; Nina's PPC book tips her into overtime", () => {
    const a = simulate(northbeamWithClients(), 30, 1);
    expect(a).toEqual(simulate(northbeamWithClients(), 30, 1));
    expect(a.bnRole).toBe("strat");
    expect(a.people.nina!.ongoingHours).toBeGreaterThan(35);
    expect(a.people.nina!.clients).toBeGreaterThan(8);
    expect(a.kpi.overtimeHours.p90).toBeGreaterThan(0);
    expect(a.kpi.overtimeCost!.mean).toBeGreaterThan(0);
    // Per-role totals stay near the prototype's pooled 26 clients' load.
    expect(a.roles.seo!.ongoingHours).toBeGreaterThan(55);
    expect(a.roles.seo!.ongoingHours).toBeLessThan(75);
  });

  it("churn has its own streams: a different lead rate doesn't change which roster clients churn", () => {
    const churnOnly = (leads: number) => {
      const m = northbeamWithClients();
      m.leadsPerWeek = leads;
      // Nobody is won, so only roster clients can churn.
      m.steps = m.steps.map((s) => (s.id === "decision" ? { ...s, next: [{ to: "lost", p: 1 }] } : s));
      m.services = Object.fromEntries(Object.entries(m.services!).map(([id, s]) => [id, { ...s, churnMonthly: 0.3 }]));
      return runOnce(m, 5, false).clientsChurned;
    };
    expect(churnOnly(3)).toBe(churnOnly(9));
  });
});
