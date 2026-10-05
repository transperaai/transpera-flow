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
