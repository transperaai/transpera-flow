import { describe, expect, it } from "vitest";
import { absenceTest, checkRobustness, northbeamModel, runOnce, simulate, type EngineModel, type EnginePerson, type ScenarioPatch, type SimulationResult } from "../src";
import { ENGINE_VERSION } from "../src/version";
import { readFileSync } from "node:fs";

// Per-person times (capacity factors; C6, #198): hands-on time = the drawn time x the person's factor, drawn first, so no
// random stream moves. The value 1 (or no factor) is the engine as it was.

/** One step, one person, constant 4 hours, at low load (1 lead a week, 40 hours a week). */
function oneStep(capacityFactor?: EnginePerson["capacityFactor"], personStep = "a"): EngineModel {
  return {
    horizonWeeks: 52,
    warmupWeeks: 4,
    hoursPerWeek: 40,
    leadsPerWeek: 1,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 0,
    roles: { r: { name: "R", count: 1, cost: 0, ongoing: 0 } },
    entry: "a",
    sinks: { won: "done", lost: "lost" },
    steps: [{ id: personStep === "a" ? "a" : "a", name: "A", role: "r", work: 4, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "done", p: 1 }] }],
    people: { p1: { name: "Pat", roles: ["r"], capacity: 40, ...(capacityFactor ? { capacityFactor } : {}) } },
  };
}

/** Northbeam with named people, the strategist (the bottleneck) carrying `factor`. */
function nb(factor?: EnginePerson["capacityFactor"]): EngineModel {
  const base = northbeamModel();
  const people: Record<string, EnginePerson> = {};
  for (const [rid, role] of Object.entries(base.roles)) {
    for (let i = 1; i <= role.count; i++) {
      const id = `${rid}-${i}`;
      people[id] = { name: `${role.name} ${i}`, roles: [rid], capacity: base.hoursPerWeek, ...(id === "strat-1" && factor ? { capacityFactor: factor } : {}) };
    }
  }
  return { ...base, people };
}

/** The result as JSON, without the factor the people echo back (`resolvedPeople` is the model's own list). */
const json = (r: SimulationResult) => {
  const copy = JSON.parse(JSON.stringify(r)) as { resolvedPeople: Record<string, { capacityFactor?: unknown }> };
  for (const p of Object.values(copy.resolvedPeople)) delete p.capacityFactor;
  return JSON.stringify(copy);
};

describe("per-person times (capacityFactor)", () => {
  it("a factor of exactly 1 (default, or on a step) gives a result byte-identical to none", () => {
    const none = json(simulate(oneStep(), 10, 1));
    expect(json(simulate(oneStep({ default: 1 }), 10, 1))).toBe(none);
    expect(json(simulate(oneStep({ steps: { a: 1 } }), 10, 1))).toBe(none);
    expect(json(simulate(oneStep({ default: 1, steps: { a: 1 } }), 10, 1))).toBe(none);
    const base = json(simulate(nb(), 10, 1));
    expect(json(simulate(nb({ default: 1 }), 10, 1))).toBe(base);
  });

  it("0.5 halves the person's busy hours and the step's average hands-on time; arrivals are identical", () => {
    const a = simulate(oneStep(), 10, 1);
    const b = simulate(oneStep({ default: 0.5 }), 10, 1);
    expect(b.steps.a!.avgHandsOn).toBeCloseTo(a.steps.a!.avgHandsOn! * 0.5, 9);
    expect(b.steps.a!.avgHandsOn).toBeCloseTo(2, 9);
    // Busy share is measured over the window (work straddling its edges), so roughly half, not exactly.
    expect(b.people.p1!.pipeline / a.people.p1!.pipeline).toBeGreaterThan(0.45);
    expect(b.people.p1!.pipeline / a.people.p1!.pipeline).toBeLessThan(0.55);
    // The arrivals are the same draws (their own stream): the leads of one run enter at the same hours.
    const enters = (m: EngineModel) => runOnce(m, 1, true).entities!.map((e) => e.t0);
    expect(enters(oneStep({ default: 0.5 }))).toEqual(enters(oneStep()));
    // The counted arrivals are exactly equal (a factor never shifts a stream); only completed work (`won`) moves at the window's edge.
    expect(b.steps.a!.arrivals).toBe(a.steps.a!.arrivals);
    expect(Math.abs(b.won - a.won)).toBeLessThan(1);
  });

  it("a step factor beats the default", () => {
    const r = simulate(oneStep({ default: 0.5, steps: { a: 2 } }), 10, 1);
    expect(r.steps.a!.avgHandsOn).toBeCloseTo(8, 9);
    // And a default alone applies to a step it names nothing for.
    expect(simulate(oneStep({ default: 1.25, steps: { zzz: 0.5 } }), 10, 1).steps.a!.avgHandsOn).toBeCloseTo(5, 9);
  });

  it("a factor on a step the person can't do changes nothing", () => {
    const none = json(simulate(nb(), 10, 1));
    // The strategist can't do the SEO setup step (role seo), so a factor on it is never read.
    expect(json(simulate(nb({ steps: { seo: 0.5 } }), 10, 1))).toBe(none);
    expect(json(simulate(oneStep({ steps: { elsewhere: 0.5 } }), 10, 1))).toBe(json(simulate(oneStep(), 10, 1)));
  });

  it("survives the absence test and the robustness check, moving results the expected way", async () => {
    const slow = nb({ default: 1.5 });
    const fast = nb({ default: 0.6 });
    const none = nb();
    const a0 = absenceTest(none, { seed: 1 });
    const a1 = absenceTest(slow, { seed: 1 });
    expect(a1.people.length).toBe(a0.people.length);
    expect(JSON.stringify(a1)).not.toBe(JSON.stringify(a0));
    const quick = {
      parameters: [
        { path: "demand.leads_per_week", low: 0.75, high: 1.25 },
        { path: "steps.audit.work_hours", low: 0.75, high: 1.25 },
      ],
      refineTop: 1,
    };
    const hire: ScenarioPatch[] = [{ path: "roles.strat.headcount", op: "add", value: 1 }];
    const r0 = await checkRobustness(none, hire, quick);
    const r1 = await checkRobustness(fast, hire, quick);
    expect(r1).toBeDefined();
    expect(JSON.stringify(r1.nominal)).not.toBe(JSON.stringify(r0.nominal));
    // The strategist, the bottleneck, is less busy when quicker.
    expect(simulate(fast, 20, 1).people["strat-1"]!.util).toBeLessThan(simulate(none, 20, 1).people["strat-1"]!.util);
  });

  it("0, -1, NaN and Infinity throw, naming the person", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => simulate(oneStep({ default: bad }), 2, 1), String(bad)).toThrow("Pat's per-person time must be a number above 0");
      expect(() => simulate(oneStep({ steps: { a: bad } }), 2, 1), String(bad)).toThrow("Pat's per-person time must be a number above 0");
    }
  });

  it("is monotone: at one seed, utilisation with 0.8 <= 1 <= 1.25 on the strategist's steps", () => {
    const u = (f: number) => simulate(nb({ default: f }), 20, 1).people["strat-1"]!.util;
    expect(u(0.8)).toBeLessThanOrEqual(u(1));
    expect(u(1)).toBeLessThanOrEqual(u(1.25));
    expect(u(0.8)).toBeLessThan(u(1.25));
  });

  it("is deterministic: the same factors and seed give the same result", () => {
    const m = nb({ default: 0.9, steps: { audit: 1.1 } });
    expect(JSON.stringify(simulate(m, 10, 3))).toBe(JSON.stringify(simulate(m, 10, 3)));
  });
});

describe("the version", () => {
  it("is 1.10.0 and the ledger holds 1.9.0's digest for it (no golden number moved)", () => {
    expect(ENGINE_VERSION).toBe("1.10.0");
    const ledger = JSON.parse(readFileSync(new URL("../golden/versions.json", import.meta.url), "utf8")) as { version: string; digest?: string; sha256?: string }[] | { versions: { version: string; digest?: string; sha256?: string }[] };
    const list = Array.isArray(ledger) ? ledger : ledger.versions;
    const digest = (v: string) => {
      const e = list.find((x) => x.version === v)!;
      return e.digest ?? e.sha256;
    };
    expect(digest("1.10.0")).toBe(digest("1.9.0"));
    expect(digest("1.9.0")).toMatch(/^sha256:8ebb2e03/);
  });
});
