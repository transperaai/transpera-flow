import { describe, expect, it } from "vitest";
import { changesProblem, northbeamBundle, toEngineModel, type SandboxChange } from "@transpera-flow/db";
import type { EngineModel } from "@transpera-flow/engine";
import { MAX_BARS, rankTornado, tornadoVariants, type TornadoVariant } from "@/lib/sandbox/tornado";

// The tornado's variants and ranking (sandbox phase 5b), without running anything.

const model = (): EngineModel => ({ ...toEngineModel(northbeamBundle(), { startDate: "2026-11-02", planned: true, purposes: true }), horizonWeeks: 52 });
const ids = (v: TornadoVariant[]) => v.map((x) => x.leverId);

describe("which levers, which steps", () => {
  const m = model();
  it("profit: the 12 levers a model offers, each moved down and up once, as valid changes", () => {
    const v = tornadoVariants(m, [], "profit");
    expect(ids(v)).toEqual(expect.arrayContaining(["A1", "A3", "B3", "D6", "B5", "B2", "E1", "D5", "C1", "C2"]));
    expect(v.length).toBeGreaterThanOrEqual(8);
    expect(v.length).toBeLessThanOrEqual(12);
    const all = v.flatMap((x) => [x.low, x.high, ...(x.base ? [x.base] : [])]);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(changesProblem(all)).toBeNull();
  });

  it("relative levers are ×0.9 and ×1.1 with no target; headcount is one person each way on the busiest role; a price is ±10 points against its own baseline", () => {
    const v = Object.fromEntries(tornadoVariants(m, [], "profit").map((x) => [x.leverId, x]));
    for (const id of ["A1", "A3", "B3", "D6", "B2"]) {
      expect(v[id]!.low).toMatchObject({ op: "multiply", value: 0.9, target: null });
      expect(v[id]!.high).toMatchObject({ op: "multiply", value: 1.1 });
      expect([v[id]!.lowLabel, v[id]!.highLabel]).toEqual(["−10%", "+10%"]);
    }
    expect(v.D5!.low).toMatchObject({ op: "add", value: -1, target: "@busiest" });
    expect(v.D5!.high).toMatchObject({ op: "add", value: 1, target: "@busiest" });
    expect([v.D5!.lowLabel, v.D5!.highLabel]).toEqual(["−1 person", "+1 person"]);
    expect(v.E1!.low.target).toBe("@heaviest");
    expect(v.B5!.low).toMatchObject({ op: "set", value: -0.1 });
    expect(v.B5!.high).toMatchObject({ op: "set", value: 0.1 });
    expect(v.B5!.base).toMatchObject({ lever: "B5", op: "set", value: 0 });
    for (const x of Object.values(v)) if (x.leverId !== "B5") expect(x.base).toBeNull();
  });

  it("money levers (role cost, overheads) only for profit, since they move nothing else", () => {
    for (const measure of ["atRisk", "peakBusy", "tooBusy", "lost", "purpose"] as const) {
      const got = ids(tornadoVariants(m, [], measure));
      expect(got, measure).not.toContain("C1");
      expect(got, measure).not.toContain("C2");
      expect(got.length).toBeGreaterThan(5);
    }
    expect(ids(tornadoVariants(m, [], "profit"))).toEqual(expect.arrayContaining(["C1", "C2"]));
  });

  it("a lever kind switched off in Settings, Levers is not tried", () => {
    const got = ids(tornadoVariants(m, ["people.headcount", "finances.roleCost", "demand.enquiries"], "profit"));
    expect(got).not.toContain("D5");
    expect(got).not.toContain("C1");
    expect(got).not.toContain("A1");
    expect(got).toContain("A3");
  });

  it("rework is skipped when the heaviest step has none, waiting when it has none", () => {
    const heaviest = tornadoVariants(m, [], "profit").find((x) => x.leverId === "E1")!;
    expect(heaviest).toBeTruthy();
    const noRework: EngineModel = { ...m, steps: m.steps.map((s) => ({ ...s, rework: 0 })) };
    expect(ids(tornadoVariants(noRework, [], "profit"))).not.toContain("E3");
    const withRework: EngineModel = { ...m, steps: m.steps.map((s) => ({ ...s, rework: 0.2 })) };
    expect(ids(tornadoVariants(withRework, [], "profit"))).toContain("E3");
    const noWait: EngineModel = { ...m, steps: m.steps.map((s) => ({ ...s, wait: 0 })) };
    expect(ids(tornadoVariants(noWait, [], "profit"))).not.toContain("E2");
  });

  it("a model with clients as one pool, and one with client groups, get the same levers (the step ones depend on which step is heaviest)", () => {
    const pooled: EngineModel = { ...m, clients: undefined, clientGroups: undefined };
    const rest = (v: TornadoVariant[]) => ids(v).filter((id) => !id.startsWith("E"));
    expect(rest(tornadoVariants(pooled, [], "lost"))).toEqual(rest(tornadoVariants(m, [], "lost")));
    expect(ids(tornadoVariants(pooled, [], "lost"))).toContain("B3");
  });
});

describe("ranking", () => {
  const variants = (ids: string[]): TornadoVariant[] =>
    ids.map((id) => ({ leverId: id, label: id, low: { id: `l${id}` } as SandboxChange, high: { id: `h${id}` } as SandboxChange, lowLabel: "−10%", highLabel: "+10%", base: id === "B5" ? ({ id: "b" } as SandboxChange) : null }));

  it("sorts by the longer side, longest first, and keeps ten", () => {
    const ids = Array.from({ length: 14 }, (_, i) => `L${i}`);
    const results = ids.map((id, i) => ({ leverId: id, low: 1000 - i * 10, high: 1000 + (i % 3) }));
    const bars = rankTornado(1000, variants(ids), results);
    expect(bars).toHaveLength(MAX_BARS);
    expect(bars.map((b) => b.size)).toEqual([...bars.map((b) => b.size)].sort((a, b) => b - a));
    expect(bars[0]!.leverId).toBe("L13");
  });

  it("reads each side's change from the scenario's value, and a price from its own baseline", () => {
    const bars = rankTornado(1000, variants(["A", "B5"]), [
      { leverId: "A", low: 900, high: 1080 },
      { leverId: "B5", low: 1500, high: 1700, base: 1600 },
    ]);
    const a = bars.find((b) => b.leverId === "A")!;
    expect([a.lowDelta, a.highDelta, a.size]).toEqual([-100, 80, 100]);
    const p = bars.find((b) => b.leverId === "B5")!;
    expect([p.lowDelta, p.highDelta, p.size]).toEqual([-100, 100, 100]);
  });

  it("greys effects under 1% of the scenario's value as about no change", () => {
    const bars = rankTornado(1000, variants(["A", "B"]), [
      { leverId: "A", low: 995, high: 1004 },
      { leverId: "B", low: 980, high: 1000 },
    ]);
    expect(bars.find((b) => b.leverId === "A")!.negligible).toBe(true);
    expect(bars.find((b) => b.leverId === "B")!.negligible).toBe(false);
    // A value of zero: any move at all is a move.
    const zero = rankTornado(0, variants(["A"]), [{ leverId: "A", low: 0, high: 2 }]);
    expect(zero[0]!.negligible).toBe(false);
    expect(rankTornado(0, variants(["A"]), [{ leverId: "A", low: 0, high: 0 }])[0]!.negligible).toBe(true);
  });

  it("leaves out a lever with no number at all, and keeps one with a number on one side", () => {
    const bars = rankTornado(10, variants(["A", "B"]), [
      { leverId: "A", low: null, high: null },
      { leverId: "B", low: null, high: 12 },
    ]);
    expect(bars.map((b) => b.leverId)).toEqual(["B"]);
    expect(bars[0]!.lowDelta).toBeNull();
    expect(bars[0]!.highDelta).toBe(2);
  });
});
