import { describe, expect, it } from "vitest";
import { detectLoops, northbeamModel, simulate, type EngineModel, type EngineStep } from "../src";
import { largeModel } from "./fixtures/large-model";

// Issue #174: rework loops (same-step redo and back-edges) and the per-step
// facts the process page and the analysis rework read.

type Next = EngineStep["next"];
const step = (id: string, next: Next, extra: Partial<EngineStep> = {}): EngineStep => ({
  id,
  name: id,
  role: "r",
  work: 1,
  wait: 0,
  rework: 0,
  workDist: { kind: "constant" },
  next,
  ...extra,
});
const to = (id: string, p = 1): Next[number] => ({ to: id, p });

function model(steps: EngineStep[], extra: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 200,
    hoursPerWeek: 40,
    leadsPerWeek: 1,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 0,
    roles: { r: { name: "R", count: 5, cost: 10, ongoing: 0 } },
    entry: steps[0]!.id,
    sinks: { won: "done", lost: "lost" },
    steps,
    ...extra,
  };
}

describe("detectLoops", () => {
  it("finds none in a straight line", () => {
    expect(detectLoops(model([step("a", [to("b")]), step("b", [to("done")])]))).toEqual([]);
  });

  it("finds a same-step redo", () => {
    const loops = detectLoops(model([step("a", [to("b")]), step("b", [to("done")], { rework: 0.3 })]));
    expect(loops).toEqual([{ id: "redo:b", kind: "redo", steps: ["b"], from: "b", to: "b", body: ["b"] }]);
  });

  it("finds a single back-edge, from the step that sends items back to the one they return to", () => {
    const loops = detectLoops(
      model([step("a", [to("b")]), step("b", [to("c")]), step("c", [to("d")]), step("d", [to("b", 0.2), to("done", 0.8)])]),
    );
    expect(loops).toEqual([{ id: "back:d>b", kind: "back-edge", steps: ["b", "c", "d"], from: "d", to: "b", body: ["b", "c", "d"] }]);
  });

  it("finds nested loops in a stable order", () => {
    const m = model([
      step("a", [to("b")]),
      step("b", [to("c")]),
      step("c", [to("b", 0.1), to("d", 0.9)]),
      step("d", [to("a", 0.1), to("done", 0.9)], { rework: 0.2 }),
    ]);
    const loops = detectLoops(m);
    expect(loops.map((l) => [l.id, l.kind, l.steps])).toEqual([
      ["redo:d", "redo", ["d"]],
      ["back:c>b", "back-edge", ["b", "c"]],
      ["back:d>a", "back-edge", ["a", "b", "c", "d"]],
    ]);
    expect(detectLoops(m)).toEqual(loops);
  });

  it("counts a step sending items back to itself as a loop of one", () => {
    const loops = detectLoops(model([step("a", [to("a", 0.5), to("done", 0.5)])]));
    expect(loops.map((l) => [l.id, l.steps])).toEqual([["back:a>a", ["a"]]]);
  });

  it("finds loops inside a group and a child process, by their leaf steps", () => {
    const m = model(
      [
        step("a", [to("box")]),
        step("b", [to("c")], { parent: "box" }),
        step("c", [to("b", 0.3)], { parent: "box" }),
        step("z", [to("done")]),
      ],
      {
        groups: { box: { name: "Box", entry: "b", next: [to("z")], exits: [] } },
      },
    );
    // c has one edge, back to b; it leaves through the group only when it has none, so give it the exit as well.
    m.steps[2]!.next = [to("b", 0.3), to("z", 0.7)];
    expect(detectLoops(m).map((l) => [l.id, l.steps])).toEqual([["back:c>b", ["b", "c"]]]);

    const child = model(
      [step("a", [to("proc")]), step("x", [to("y")], { parent: "proc", rework: 0.2 }), step("y", [to("x", 0.5), to("done", 0.5)], { parent: "proc" })],
      { groups: { proc: { name: "Child", entry: "x", next: [to("done")] } } },
    );
    expect(detectLoops(child).map((l) => l.id)).toEqual(["redo:x", "back:y>x"]);
  });

  it("starts from a service's entry too", () => {
    const m = model([step("a", [to("done")]), step("s1", [to("s2")]), step("s2", [to("s1", 0.5), to("done", 0.5)])], {
      services: {
        svc: { name: "S", pricingModel: "retainer", price: 1, margin: 0, tenureMonths: 1, churnMonthly: 0, mixShare: 1, pathTags: [], entry: "s1" },
      },
    });
    expect(detectLoops(m).map((l) => l.id)).toEqual(["back:s2>s1"]);
  });
});

describe("loop outputs", () => {
  it("are zero with no loops", () => {
    const r = simulate(model([step("a", [to("b")]), step("b", [to("done")])]), 5, 1);
    expect(r.loops).toEqual([]);
  });

  it("show a 50% redo as about one extra pass on half the items", () => {
    // 50% redo: items go round a geometric number of times (mean 1), but "at least once" is half of them.
    const m = model([step("a", [to("done")], { rework: 0.5 })], { leadsPerWeek: 4 });
    const r = simulate(m, 20, 1);
    const l = r.loops![0]!;
    expect(l.id).toBe("redo:a");
    expect(l.share.mean).toBeGreaterThan(0.45);
    expect(l.share.mean).toBeLessThan(0.55);
    // Per item that loops: 1 / (1 - 0.5) = 2 times round.
    expect(l.meanRounds.mean).toBeGreaterThan(1.8);
    expect(l.meanRounds.mean).toBeLessThan(2.2);
    // Extra hands-on: 1 h per pass; passes a month = items a month x (0.5 / 0.5 = 1) pass each.
    const itemsPerMonth = 4 * (52 / 12);
    expect(l.extraHandsOnHoursPerMonth.r!.mean).toBeGreaterThan(itemsPerMonth * 0.85);
    expect(l.extraHandsOnHoursPerMonth.r!.mean).toBeLessThan(itemsPerMonth * 1.15);
    expect(l.extraHandsOnHoursPerMonthTotal.mean).toBeCloseTo(l.extraHandsOnHoursPerMonth.r!.mean, 9);
    // One hour of repeat work per pass, no queueing in this lightly loaded model: about 1 h on average per item.
    expect(l.extraCycleHours.mean).toBeGreaterThan(0.85);
    expect(l.extraCycleHours.mean).toBeLessThan(1.15);
    expect(l.extraCycleHoursPerLooper.mean).toBeGreaterThan(l.extraCycleHours.mean);
  });

  it("counts a back-edge's repeat passes at every step of the loop, by role", () => {
    const m = model(
      [step("a", [to("b")]), step("b", [to("c")], { role: "s" }), step("c", [to("b", 0.5), to("done", 0.5)])],
      { roles: { r: { name: "R", count: 5, cost: 10, ongoing: 0 }, s: { name: "S", count: 5, cost: 10, ongoing: 0 } }, leadsPerWeek: 4 },
    );
    const r = simulate(m, 20, 1);
    const l = r.loops![0]!;
    expect(l.id).toBe("back:c>b");
    expect(l.share.mean).toBeGreaterThan(0.45);
    expect(l.share.mean).toBeLessThan(0.55);
    // Each round repeats b (role s) and c (role r), an hour each; a is outside the loop.
    expect(l.extraHandsOnHoursPerMonth.s!.mean).toBeGreaterThan(0);
    expect(l.extraHandsOnHoursPerMonth.s!.mean).toBeCloseTo(l.extraHandsOnHoursPerMonth.r!.mean, 0);
    // The step "a" before the loop is never counted.
    expect(r.loops![0]!.extraHandsOnHoursPerMonth.r!.mean).toBeLessThan(4 * (52 / 12) * 2.5);
  });

  it("are the same for the same seed, and leave the model's other results alone", () => {
    const m = northbeamModel();
    const a = simulate(m, 10, 7);
    const b = simulate(m, 10, 7);
    expect(a.loops).toEqual(b.loops);
    expect(a.stepFacts).toEqual(b.stepFacts);
    expect(a.loops!.length).toBeGreaterThan(0);
  });

  it("find a loop in Northbeam with sensible numbers", () => {
    const r = simulate(northbeamModel(), 10, 1);
    for (const l of r.loops!) {
      expect(l.share.mean).toBeGreaterThanOrEqual(0);
      expect(l.share.mean).toBeLessThanOrEqual(1);
      expect(l.extraHandsOnHoursPerMonthTotal.mean).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("loop outputs are unbiased and add up", () => {
  it("never average in runs with nothing to divide by: rounds are at least 1 per looper, a 5 h step shows 5 h", () => {
    // Few items in a short horizon: many runs have no looper or no visit at all.
    const m = model([step("a", [to("b")], { work: 5, rework: 0.5 }), step("b", [to("done")])], { horizonWeeks: 6, leadsPerWeek: 0.5 });
    const r = simulate(m, 30, 1);
    const l = r.loops!.find((x) => x.id === "redo:a")!;
    expect(l.meanRounds.mean).toBeGreaterThanOrEqual(1);
    expect(l.meanRounds.p10).toBeGreaterThanOrEqual(1);
    expect(l.extraCycleHoursPerLooper.mean).toBeGreaterThanOrEqual(5);
    expect(r.steps.a!.avgHandsOn).toBeCloseTo(5, 9);
    expect(r.stepFacts!.a!.handsOnHours).toBeCloseTo(5, 9);
  });

  it("is not biased low when the loop takes long relative to the run (300 h wait in the loop, 30% redo)", () => {
    const m = model([step("a", [to("done")], { rework: 0.3, wait: 300, waitDist: { kind: "constant" } })], { horizonWeeks: 100, leadsPerWeek: 1 });
    const l = simulate(m, 20, 1).loops![0]!;
    expect(l.share.mean).toBeGreaterThan(0.27);
    expect(l.share.mean).toBeLessThan(0.33);
    // Rounds per looper 1 / 0.7 = 1.43, each repeat pass 1 h work + 300 h wait: about 431 h.
    expect(l.meanRounds.mean).toBeGreaterThan(1.3);
    expect(l.meanRounds.mean).toBeLessThan(1.57);
    expect(l.extraCycleHoursPerLooper.mean).toBeGreaterThan(390);
    expect(l.extraCycleHoursPerLooper.mean).toBeLessThan(470);
  });

  it("counts items that join a loop part-way, whatever order the edges are drawn in", () => {
    const edges = (flip: boolean): EngineStep[] => [
      step("a", flip ? [to("c", 0.5), to("b", 0.5)] : [to("b", 0.5), to("c", 0.5)]),
      step("b", [to("c")]),
      step("c", flip ? [to("done", 0.7), to("b", 0.3)] : [to("b", 0.3), to("done", 0.7)]),
    ];
    const m = model(edges(false), { leadsPerWeek: 4 });
    const flipped = model(edges(true), { leadsPerWeek: 4 });
    expect(detectLoops(m).map((l) => l.id)).toEqual(["back:c>b"]);
    expect(detectLoops(flipped)).toEqual(detectLoops(m));
    for (const x of [m, flipped]) {
      const l = simulate(x, 20, 1).loops![0]!;
      // Every item goes round with chance 0.3, wherever it joined; a round is 2 h (b and c), 0.3 / 0.7 rounds an item.
      expect(l.share.mean).toBeGreaterThan(0.26);
      expect(l.share.mean).toBeLessThan(0.34);
      const expected = 4 * (52 / 12) * (0.3 / 0.7) * 2;
      expect(l.extraHandsOnHoursPerMonthTotal.mean).toBeGreaterThan(expected * 0.88);
      expect(l.extraHandsOnHoursPerMonthTotal.mean).toBeLessThan(expected * 1.12);
    }
  });

  it("counts each repeat pass once when loops nest or overlap: loops add up to the total", () => {
    const nested = model(
      [
        step("a", [to("b")]),
        step("b", [to("c")]),
        step("c", [to("b", 0.2), to("d", 0.8)], { rework: 0.2 }),
        step("d", [to("a", 0.2), to("b", 0.1), to("done", 0.7)], { rework: 0.1 }),
      ],
      { leadsPerWeek: 3 },
    );
    expect(detectLoops(nested).length).toBeGreaterThanOrEqual(4);
    const r = simulate(nested, 20, 1);
    const sum = r.loops!.reduce((a, l) => a + l.extraHandsOnHoursPerMonthTotal.mean, 0);
    expect(sum).toBeCloseTo(r.rework!.extraHandsOnHoursPerMonthTotal.mean, 6);
    const byRole = r.loops!.reduce((a, l) => a + (l.extraHandsOnHoursPerMonth.r?.mean ?? 0), 0);
    expect(byRole).toBeCloseTo(r.rework!.extraHandsOnHoursPerMonth.r!.mean, 6);
    expect(r.rework!.extraHandsOnHoursPerMonthTotal.mean).toBeGreaterThan(0);
    expect(r.rework!.extraCycleHoursPerItem.mean).toBeGreaterThan(0);
  });

  it("matches the hours actually worked on repeat passes for two back-edges into one step (hand count)", () => {
    // a -> b -> {c 1}; c -> {b 0.2, d 0.8}; d -> {b 0.25, done 0.75}. Each step 1 h, one pass of b,c is 2 h and of b,c,d 3 h.
    const m = model(
      [step("a", [to("b")]), step("b", [to("c")]), step("c", [to("b", 0.2), to("d", 0.8)]), step("d", [to("b", 0.25), to("done", 0.75)])],
      { leadsPerWeek: 4, horizonWeeks: 300 },
    );
    // Visits to b per item: geometric with return chance 1 - 0.8 * 0.75 = 0.4, so 1 / 0.6 = 1.667 visits to b, repeats 0.667.
    // Hours per visit of b: always b and c (2 h); d only on 80% of the visits: 2.8 h. Repeat hours per item = 0.667 * 2.8.
    const expected = 4 * (52 / 12) * (0.4 / 0.6) * 2.8;
    const r = simulate(m, 20, 1);
    expect(r.rework!.extraHandsOnHoursPerMonthTotal.mean).toBeGreaterThan(expected * 0.93);
    expect(r.rework!.extraHandsOnHoursPerMonthTotal.mean).toBeLessThan(expected * 1.07);
    expect(r.loops!.reduce((a, l) => a + l.extraHandsOnHoursPerMonthTotal.mean, 0)).toBeCloseTo(r.rework!.extraHandsOnHoursPerMonthTotal.mean, 6);
  });

  it("puts a pinned person with no role under 'unassigned'", () => {
    const m = model([step("a", [to("done")], { role: null, person: "p", rework: 0.5 })], {
      people: { p: { name: "Pat", roles: [], capacity: 40 } },
      leadsPerWeek: 2,
    });
    const l = simulate(m, 10, 1).loops![0]!;
    expect(Object.keys(l.extraHandsOnHoursPerMonth)).toEqual(["unassigned"]);
  });
});

describe("step facts", () => {
  it("split hands-on from waiting, and flag steps only one person can do", () => {
    const m = model(
      [
        step("a", [to("b")], { work: 2, wait: 6 }),
        step("b", [to("c")], { role: "solo", work: 1 }),
        step("c", [to("done")], { person: "p1", work: 1 }),
      ],
      {
        roles: { r: { name: "R", count: 2, cost: 1, ongoing: 0 }, solo: { name: "Solo", count: 1, cost: 1, ongoing: 0 } },
        people: {
          p1: { name: "Pat", roles: ["r"], capacity: 40 },
          p2: { name: "Quinn", roles: ["r"], capacity: 40 },
          p3: { name: "Sam", roles: ["solo"], capacity: 40 },
        },
        leadsPerWeek: 1,
      },
    );
    const facts = simulate(m, 5, 1).stepFacts!;
    expect(facts.a!.handsOnHours).toBeCloseTo(2, 6);
    expect(facts.a!.fixedWaitHours).toBeGreaterThan(4);
    expect(facts.a!.handsOnShare).toBeLessThan(0.4);
    expect(facts.a!.keyPerson).toBeNull();
    expect(facts.b!.keyPerson).toEqual({ personId: "p3", personName: "Sam" });
    expect(facts.c!.keyPerson).toEqual({ personId: "p1", personName: "Pat" });
    expect(facts.c!.fixedWaitHours).toBe(0);
  });

  it("add part-time stretch so hands-on, stretch, queue and fixed wait cover the time at the step", () => {
    const part = model([step("a", [to("done")], { work: 1, wait: 3, waitDist: { kind: "constant" } })], {
      roles: { r: { name: "R", count: 1, cost: 1, ongoing: 4 } },
      activeClients: 5,
      leadsPerWeek: 0.5,
    });
    const f = simulate(part, 10, 1).stepFacts!.a!;
    expect(f.handsOnHours).toBeCloseTo(1, 9);
    expect(f.stretchHours).toBeGreaterThan(0.5);
    expect(f.fixedWaitHours).toBeCloseTo(3, 9);
    const none = simulate(model([step("a", [to("done")])], { leadsPerWeek: 0.5 }), 5, 1).stepFacts!.a!;
    expect(none.stretchHours).toBe(0);
  });

  it("honour leave and empty roles for key-person risk", () => {
    const people = {
      p1: { name: "Pat", roles: ["r"], capacity: 40, leave: [[0, 1e9]] as [number, number][] },
      p2: { name: "Quinn", roles: ["r"], capacity: 40 },
      z: { name: "Zed", roles: ["z"], capacity: 0 },
    };
    const m = model(
      [step("a", [to("b")]), step("b", [to("c")], { role: "z" }), step("c", [to("done")], { role: null, person: "z" })],
      { roles: { r: { name: "R", count: 2, cost: 1, ongoing: 0 }, z: { name: "Z", count: 1, cost: 1, ongoing: 0 } }, people },
    );
    const f = simulate(m, 3, 1).stepFacts!;
    // Pat is away the whole run, so Quinn is the only one for a.
    expect(f.a!.keyPerson).toEqual({ personId: "p2", personName: "Quinn" });
    expect(f.a!.nobodyCanDo).toBe(false);
    // Zed has no capacity: nobody can do b or c, which is not a key person but a flag.
    for (const id of ["b", "c"]) {
      expect(f[id]!.keyPerson).toBeNull();
      expect(f[id]!.nobodyCanDo).toBe(true);
    }
    const empty = model([step("a", [to("done")])], { roles: { r: { name: "R", count: 0, cost: 1, ongoing: 0 } } });
    const e = simulate(empty, 3, 1).stepFacts!.a!;
    expect(e.keyPerson).toBeNull();
    expect(e.nobodyCanDo).toBe(true);
  });

  it("report the cycle time median and 90th percentile", () => {
    const r = simulate(northbeamModel(), 5, 1);
    expect(r.cycleP50).toBeGreaterThan(0);
    expect(r.cycleP90).toBeGreaterThanOrEqual(r.cycleP50);
    expect(r.kpi.cycle.p50).toBe(r.cycleP50);
    expect(r.kpi.cycle.p90).toBe(r.cycleP90);
  });
});

describe("performance with loops", () => {
  it("runs the 40-step model, which has redo loops, within the PRD target (1.5 s)", () => {
    const m = largeModel();
    expect(detectLoops(m).length).toBeGreaterThan(0);
    simulate(m, 3, 1);
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      simulate(m, 30, 1);
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(1500);
  });
});
