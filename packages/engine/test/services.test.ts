import { describe, expect, it } from "vitest";
import {
  northbeamModel,
  northbeamWithServices,
  runOnce,
  simulate,
  type EngineEdge,
  type EngineModel,
  type EngineService,
  type EngineStep,
} from "../src";

// Services, end-step outcomes and revenue (docs/PRD.md §6.4 revenue rules,
// §13 metric definitions, decision D8).

const WEEKS_PER_MONTH = 4.33;

function service(overrides: Partial<EngineService> = {}): EngineService {
  return {
    name: "Retainer",
    pricingModel: "retainer",
    price: 1000,
    margin: 0.5,
    tenureMonths: 12,
    churnMonthly: 0,
    mixShare: 1,
    pathTags: [],
    ...overrides,
  };
}

/**
 * A hand-checkable model: `items` entities start as current WIP at one
 * decision (no resource, a constant 40-hour wait), so every one of them
 * leaves it at t = 40 and takes one of `next`. No new arrivals; a horizon of
 * 4 weeks of 40 hours, so a client won at t = 40 is billed for 3 weeks.
 */
function decision(next: EngineEdge[], overrides: Partial<EngineModel> = {}, items = 10): EngineModel {
  return {
    horizonWeeks: 4,
    hoursPerWeek: 40,
    leadsPerWeek: 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 0,
    roles: {},
    entry: "decide",
    sinks: { won: "won", lost: "lost" },
    steps: [
      {
        id: "decide",
        name: "Client decision",
        role: null,
        work: 0,
        wait: 40,
        waitDist: { kind: "constant" },
        rework: 0,
        currentWip: items,
        next,
      },
    ],
    ...overrides,
  };
}

/** A pass-through step with no resource and no wait. */
const pass = (id: string, next: EngineEdge[]): EngineStep => ({
  id,
  name: id,
  role: null,
  work: 0,
  wait: 0,
  rework: 0,
  next,
});

/** Many arrivals through pass-through steps: cheap, and plenty for proportions. */
function stream(steps: EngineStep[], overrides: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 20_000,
    hoursPerWeek: 1,
    leadsPerWeek: 1,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 0,
    roles: {},
    warmupWeeks: 0,
    entry: steps[0]!.id,
    sinks: { won: "won", lost: "lost" },
    steps,
    ...overrides,
  };
}

describe("revenue KPIs match the §13 definitions (hand-checked)", () => {
  it("retainer won at t = 40 with no churn: MRR, 3 weeks billed, LTV = price × tenure", () => {
    const res = simulate(decision([{ to: "won", p: 1 }], { services: { seo: service() } }), 3, 1);
    expect(res.won).toBe(10);
    expect(res.kpi.mrrAdded).toEqual({
      mean: 10_000,
      p10: 10_000,
      p90: 10_000,
    });
    expect(res.mrrAdded).toBe(10_000);
    expect(res.kpi.billed.mean).toBeCloseTo((10 * 1000 * 3) / WEEKS_PER_MONTH, 9);
    expect(res.kpi.ltvAdded.mean).toBe(10 * 1000 * 12);
    expect(res.kpi.lostRevenue.mean).toBe(0);
  });

  it("billed in horizon is net of churn: survival drops at each weekly tick", () => {
    // 0.433 a month is 0.1 a week: the three weeks after the win bill 1, 0.9 and 0.81.
    const model = decision([{ to: "won", p: 1 }], {
      services: { seo: service({ churnMonthly: 0.433 }) },
    });
    const res = simulate(model, 1, 1);
    expect(res.kpi.billed.mean).toBeCloseTo(((10 * 1000) / WEEKS_PER_MONTH) * (1 + 0.9 + 0.81), 6);
    // Churn doesn't change new MRR or LTV (tenure is the service's own).
    expect(res.kpi.mrrAdded.mean).toBe(10_000);
    expect(res.kpi.ltvAdded.mean).toBe(120_000);
  });

  it("bills the stub of a horizon that ends mid-week", () => {
    // 3.5 weeks: won at t = 40, billed for weeks [40, 80), [80, 120) and half of [120, 160).
    const model = decision([{ to: "won", p: 1 }], {
      horizonWeeks: 3.5,
      services: { seo: service({ churnMonthly: 0.433 }) },
    });
    expect(simulate(model, 1, 1).kpi.billed.mean).toBeCloseTo(
      ((10 * 1000) / WEEKS_PER_MONTH) * (1 + 0.9 + 0.81 / 2),
      6,
    );
  });

  it("a lost entity books no revenue; lost revenue is its expected value", () => {
    const res = simulate(decision([{ to: "lost", p: 1 }], { services: { seo: service() } }), 1, 1);
    expect(res.lost).toBe(10);
    expect(res.kpi.mrrAdded.mean).toBe(0);
    expect(res.kpi.billed.mean).toBe(0);
    expect(res.kpi.ltvAdded.mean).toBe(0);
    expect(res.kpi.lostRevenue.mean).toBe(10 * 1000 * 12);
  });

  it("prices each entity by its own service: retainer, one-off and hourly", () => {
    const model = decision(
      [
        { to: "won", p: 0.5, tag: "win" },
        { to: "lost", p: 0.5, tag: "lose" },
      ],
      {
        services: {
          retainer: service({
            price: 1000,
            tenureMonths: 12,
            pathTags: ["win"],
          }),
          project: service({
            pricingModel: "one_off",
            price: 5000,
            tenureMonths: 0,
            pathTags: ["win"],
          }),
          audit: service({
            pricingModel: "one_off",
            price: 2000,
            pathTags: ["lose"],
          }),
          hours: service({
            pricingModel: "hourly",
            price: 90,
            pathTags: ["win"],
          }),
        },
      },
      200,
    );
    const r = runOnce(model, 5, true);
    const count = (id: string) => r.entities!.filter((e) => e.service === id).length;
    const [retainer, project, audit, hours] = ["retainer", "project", "audit", "hours"].map(count) as [
      number,
      number,
      number,
      number,
    ];
    expect(Math.min(retainer, project, audit, hours)).toBeGreaterThan(0);
    // Tagged at arrival (here: as starting WIP), routed by tag.
    for (const e of r.entities!) expect(e.outcome).toBe(e.service === "audit" ? "lost" : "won");
    expect(r.services).toEqual({
      retainer: { arrivals: 0, won: retainer, lost: 0 },
      project: { arrivals: 0, won: project, lost: 0 },
      audit: { arrivals: 0, won: 0, lost: audit },
      hours: { arrivals: 0, won: hours, lost: 0 },
    });
    // New MRR counts retainers only; a one-off bills and adds its price once;
    // hourly work bills the hands-on hours worked for the client after the sale (engine 1.11.0; none here:
    // this model has no post-sale steps), and `billed` leaves it out.
    expect(r.newMrr).toBe(retainer * 1000);
    expect(r.billed).toBeCloseTo((retainer * 1000 * 3) / WEEKS_PER_MONTH + project * 5000, 6);
    expect(r.ltvAdded).toBe(retainer * 12_000 + project * 5000);
    expect(r.lostRevenue).toBe(audit * 2000);
    // Revenue by kind (engine 1.11.0): the pooled retainers' fees (the model has no roster) and the one-offs; the hourly service had no work.
    expect(r.revenue.oneOff).toBe(project * 5000);
    expect(r.revenue.hourly).toBe(0);
    expect(r.hourly.hours).toEqual({ hours: 0, revenue: 0 });
    expect(r.revenue.fromNew).toBeCloseTo(r.revenue.oneOff + r.revenue.recurring, 6);
    // One-off jobs don't become ongoing clients.
    expect(r.activeEnd).toBe(retainer + hours);
  });

  it("gives each revenue KPI a range across replications", () => {
    const res = simulate(northbeamWithServices(), 30, 1);
    for (const key of ["mrrAdded", "billed", "ltvAdded", "lostRevenue"] as const) {
      const s = res.kpi[key];
      expect(s.p10).toBeLessThanOrEqual(s.mean);
      expect(s.mean).toBeLessThanOrEqual(s.p90);
      expect(s.p10).toBeLessThan(s.p90);
    }
  });
});

describe("a model without services", () => {
  it("prices every win at `retainer`, with tenure 1 / churn", () => {
    const model = decision(
      [
        { to: "won", p: 0.5 },
        { to: "lost", p: 0.5 },
      ],
      { retainer: 3000, churnMonthly: 0.05 },
      50,
    );
    const r = runOnce(model, 3, true);
    expect(r.won + r.lost).toBe(50);
    expect(r.newMrr).toBe(r.won * 3000);
    expect(r.ltvAdded).toBeCloseTo(r.won * 3000 * 20, 6);
    expect(r.lostRevenue).toBeCloseTo(r.lost * 3000 * 20, 6);
    expect(r.services).toEqual({});
    expect(r.entities!.every((e) => e.service === undefined)).toBe(true);
  });

  it("keeps Northbeam's new MRR at won × retainer in every replication", () => {
    const model = northbeamModel();
    const res = simulate(model, 10, 1);
    expect(res.kpi.mrrAdded.mean).toBe(res.won * model.retainer);
    expect(res.mrrAdded).toBe(res.won * model.retainer);
    expect(res.kpi.services).toEqual({});
  });

  it("ignores condition tags and routes by probability", () => {
    const tagged = stream([
      pass("split", [
        { to: "won", p: 0.3, tag: "x" },
        { to: "lost", p: 0.7, tag: "y" },
      ]),
    ]);
    const untagged = stream([
      pass("split", [
        { to: "won", p: 0.3 },
        { to: "lost", p: 0.7 },
      ]),
    ]);
    expect(simulate(tagged, 2, 1)).toEqual(simulate(untagged, 2, 1));
  });
});

describe("won is booked exactly once", () => {
  // The pipeline's `won` end hands the client on to onboarding, a downstream
  // process that can itself end `won` or `lost`.
  const chained = (): EngineModel => {
    const pipeline = decision([{ to: "signed", p: 1 }], {
      services: { seo: service() },
    });
    return {
      ...pipeline,
      ends: { signed: { outcome: "won", handoff: "onboard" } },
      steps: [
        pipeline.steps[0]!,
        {
          id: "onboard",
          name: "Onboarding",
          role: null,
          work: 0,
          wait: 40,
          waitDist: { kind: "constant" },
          rework: 0,
          next: [
            { to: "won", p: 0.5 },
            { to: "lost", p: 0.5 },
          ],
        },
      ],
    };
  };

  it("at the first won end, even when the entity passes another process's won end", () => {
    const r = runOnce(chained(), 1, true);
    expect(r.won).toBe(10);
    expect(r.cycle).toEqual(r.entities!.map((e) => 40 - e.t0));
    expect(r.newMrr).toBe(10 * 1000);
    expect(r.ltvAdded).toBe(10 * 12_000);
    expect(r.billed).toBeCloseTo((10 * 1000 * 3) / WEEKS_PER_MONTH, 9);
    expect(r.activeEnd).toBe(10);
    // Some ended onboarding `lost`: still won, and no lost revenue.
    expect(r.lost).toBe(0);
    expect(r.lostRevenue).toBe(0);
    expect(r.entities!.every((e) => e.outcome === "won" && e.done === 80)).toBe(true);
    expect(r.entities!.every((e) => e.trace.map((s) => s.step).join() === "decide,onboard")).toBe(true);
  });

  it("counts a `done` end as completed, not won, and books nothing", () => {
    const model: EngineModel = {
      ...decision([{ to: "closed", p: 1 }], { services: { seo: service() } }),
      ends: { closed: { outcome: "done" } },
    };
    const res = simulate(model, 1, 1);
    expect(res.kpi.done.mean).toBe(10);
    expect(res.won).toBe(0);
    expect(res.lost).toBe(0);
    expect(res.kpi.mrrAdded.mean + res.kpi.billed.mean + res.kpi.ltvAdded.mean + res.kpi.lostRevenue.mean).toBe(0);
    expect(res.trace!.every((e) => e.outcome === "done" && e.done === 40)).toBe(true);
  });
});

describe("services mix and condition-tagged routing", () => {
  const mixed = (): EngineModel =>
    stream([pass("split", [{ to: "won", p: 1 }])], {
      services: {
        a: service({ mixShare: 5 }),
        b: service({ mixShare: 3 }),
        c: service({ mixShare: 2 }),
      },
    });

  it("tags arrivals in proportion to the mix shares", () => {
    const res = simulate(mixed(), 5, 1);
    const total =
      res.kpi.services.a!.arrivals.mean + res.kpi.services.b!.arrivals.mean + res.kpi.services.c!.arrivals.mean;
    // ~20,000 arrivals a replication, 100,000 in all: each share's standard
    // error is below 0.002, well inside the 0.005 tolerance.
    expect(total).toBeGreaterThan(19_000);
    expect(res.kpi.services.a!.arrivals.mean / total).toBeCloseTo(0.5, 2);
    expect(res.kpi.services.b!.arrivals.mean / total).toBeCloseTo(0.3, 2);
    expect(res.kpi.services.c!.arrivals.mean / total).toBeCloseTo(0.2, 2);
  });

  it("draws tags from their own stream: the measured window's tags don't depend on the warm-up", () => {
    const tags = (m: EngineModel) =>
      runOnce(m, 4, true)
        .entities!.filter((e) => e.t0 >= 0)
        .map((e) => e.service);
    const short = { ...mixed(), horizonWeeks: 200 };
    expect(tags({ ...short, warmupWeeks: 50 })).toEqual(tags(short));
  });

  it("routes Northbeam's clients down their service's path at the kickoff", () => {
    const r = runOnce(northbeamWithServices(), 1, true);
    const kicked = r.entities!.filter((e) => e.trace.some((s) => s.step === "kickoff" && s.tL !== null));
    expect(kicked.length).toBeGreaterThan(5);
    for (const e of kicked) {
      const after = e.trace[e.trace.findIndex((s) => s.step === "kickoff" && s.tL !== null) + 1];
      if (after) expect(after.step).toBe(e.service);
    }
    expect(new Set(kicked.map((e) => e.service))).toEqual(new Set(["seo", "ppc"]));
  });

  it("enters each service at its own entry step", () => {
    const model = stream([pass("seo-brief", [{ to: "won", p: 1 }]), pass("ppc-brief", [{ to: "won", p: 1 }])], {
      horizonWeeks: 200,
      services: {
        seo: service({ entry: "seo-brief" }),
        ppc: service({ entry: "ppc-brief" }),
      },
    });
    const r = runOnce(model, 1, true);
    expect(r.entities!.length).toBeGreaterThan(100);
    for (const e of r.entities!) expect(e.trace[0]!.step).toBe(`${e.service}-brief`);
  });

  // Tagged edges take precedence; entities with no matching tag split
  // between the untagged edges in proportion to their probabilities.
  it("mixes tagged and untagged edges", () => {
    const split = pass("split", [
      { to: "won", p: 0.2, tag: "vip" },
      { to: "lost", p: 0.5 },
      { to: "closed", p: 0.3 },
    ]);
    const model = stream([split], {
      ends: { closed: { outcome: "done" } },
      services: {
        vip: service({ pathTags: ["vip"] }),
        plain: service({ pathTags: ["other"] }),
      },
    });
    const r = runOnce(model, 1, false);
    expect(r.services.vip!.won).toBe(r.services.vip!.arrivals);
    expect(r.services.vip!.lost).toBe(0);
    const plain = r.services.plain!;
    expect(plain.won).toBe(0);
    expect(plain.lost / plain.arrivals).toBeCloseTo(0.5 / 0.8, 1);
    expect(r.done).toBe(plain.arrivals - plain.lost);
  });

  it("falls back to all edges when none is untagged and none matches", () => {
    const model = stream(
      [
        pass("split", [
          { to: "won", p: 0.3, tag: "x" },
          { to: "lost", p: 0.7, tag: "y" },
        ]),
      ],
      {
        services: { z: service({ pathTags: ["z"] }) },
      },
    );
    const r = runOnce(model, 1, false);
    expect(r.won / (r.won + r.lost)).toBeCloseTo(0.3, 1);
  });

  it("is deterministic for a given seed", () => {
    expect(simulate(northbeamWithServices(), 10, 7)).toEqual(simulate(northbeamWithServices(), 10, 7));
  });

  it("rejects a mix that adds up to nothing, and an unknown entry step", () => {
    expect(() =>
      runOnce(
        stream([pass("s", [{ to: "won", p: 1 }])], {
          services: { a: service({ mixShare: 0 }) },
        }),
        1,
        false,
      ),
    ).toThrow(/mix shares/);
    expect(() =>
      runOnce(
        stream([pass("s", [{ to: "won", p: 1 }])], {
          services: { a: service({ entry: "nope" }) },
        }),
        1,
        false,
      ),
    ).toThrow(/unknown step/);
  });
});
