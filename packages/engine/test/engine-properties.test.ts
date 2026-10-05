import { describe, expect, it } from "vitest";
import { northbeamModel, runOnce, simulate, type EngineModel } from "../src";
import { largeModel } from "./fixtures/large-model";
import { EventQueue } from "../src/event-queue";

describe("random streams", () => {
  it("keeps the arrival sequence when a step's work time changes", () => {
    const base = northbeamModel();
    const faster: EngineModel = {
      ...base,
      steps: base.steps.map((s) => (s.id === "audit" ? { ...s, work: 2, rework: 0.05 } : s)),
    };
    // The automatic warm-up differs between the two (it depends on cycle
    // time), but the measured window's arrivals come from their own stream.
    const arrivals = (m: EngineModel) =>
      runOnce(m, 7, true)
        .entities!.map((e) => e.t0)
        .filter((t) => t >= 0);
    expect(arrivals(faster)).toEqual(arrivals(base));
  });

  it("keeps other steps' service draws when one step changes", () => {
    // A fixed warm-up, so both runs draw the same number of warm-up samples.
    const base: EngineModel = { ...northbeamModel(), warmupWeeks: 4 };
    const changed: EngineModel = {
      ...base,
      steps: base.steps.map((s) => (s.id === "seo" ? { ...s, work: 20 } : s)),
    };
    // The qualify step is visited in the same order in both, so its first
    // service durations must match exactly.
    const qualifyDurations = (m: EngineModel) =>
      runOnce(m, 3, true)
        .entities!.flatMap((e) => e.trace.filter((s) => s.step === "qualify" && s.tE !== null && s.tS! >= 0))
        .sort((a, b) => a.tS! - b.tS!)
        .slice(0, 20)
        .map((s) => s.tE! - s.tS!);
    expect(qualifyDurations(changed)).toEqual(qualifyDurations(base));
  });
});

describe("event queue", () => {
  it("pops in time order, breaking ties by insertion order", () => {
    const q = new EventQueue<{ t: number; n: number }>();
    const times = [5, 1, 3, 1, 9, 0, 3, 7, 1];
    times.forEach((t, n) => q.push({ t, n }));
    const out: { t: number; n: number }[] = [];
    for (let e = q.pop(); e; e = q.pop()) out.push(e);
    expect(out.map((e) => e.t)).toEqual([...times].sort((a, b) => a - b));
    expect(out.filter((e) => e.t === 1).map((e) => e.n)).toEqual([1, 3, 8]);
    expect(out.filter((e) => e.t === 3).map((e) => e.n)).toEqual([2, 6]);
  });

  it("handles interleaved pushes and pops", () => {
    const q = new EventQueue<{ t: number }>();
    let x = 12345;
    const rand = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let last = -Infinity;
    let now = 0;
    for (let i = 0; i < 5000; i++) {
      q.push({ t: now + rand() * 10 });
      if (i % 3 === 0) {
        const e = q.pop()!;
        expect(e.t).toBeGreaterThanOrEqual(last);
        last = e.t;
        now = e.t;
      }
    }
  });
});

describe("behaviour", () => {
  it("never lowers throughput when capacity is added at the bottleneck", () => {
    const base = northbeamModel();
    const hired: EngineModel = { ...base, roles: { ...base.roles, strat: { ...base.roles.strat!, count: 2 } } };
    const before = simulate(base, 30, 1);
    const after = simulate(hired, 30, 1);
    expect(after.won).toBeGreaterThanOrEqual(before.won);
    expect(after.roles.strat!.util).toBeLessThan(before.roles.strat!.util);
    expect(after.cycleP50).toBeLessThan(before.cycleP50);
  });

  it("gives identical results for the same seed", () => {
    expect(simulate(northbeamModel(), 10, 99)).toEqual(simulate(northbeamModel(), 10, 99));
  });
});

describe("performance", () => {
  it("runs 40 steps, 25 people, 26 weeks, 30 reps within the PRD target (1.5 s)", { tags: ["perf"] }, () => {
    const model = largeModel();
    expect(Object.values(model.roles).reduce((a, r) => a + r.count, 0)).toBe(25);
    simulate(model, 3, 1); // warm up the JIT
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      simulate(model, 30, 1);
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(1500);
  });
});
