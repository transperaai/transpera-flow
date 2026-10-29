import { describe, expect, it } from "vitest";
import type { SandboxChange } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { prepareScenario } from "@/lib/sandbox/run";
import { priceRiseTradeoff } from "@/lib/sandbox/price-rise";

// The price rise's trade-off on real paired runs (the demo, as the Sandbox runs it: same seed, the pinned warm-up, the pair without the
// rise): the months before the rise are exactly 0, gained - lost = net in every replication and month, and a cut has no break-even.

const START = DEMO_FORECAST_START;
const eff = (list: SandboxChange[]) => list.map((c) => ({ change: c, scenarioId: "s", scenarioName: "S", inherited: false }));
const rise = (value: number): SandboxChange => ({ id: "7f000000-0000-4000-8000-0000000000b5", lever: "B5", target: null, op: "set", value, from: "2027-03" });

function pair(value: number) {
  const p = prepareScenario(demoForecastBundle(), eff([rise(value)]), [], 12, START);
  if (p.error !== null) throw new Error(p.error);
  const go = (model: (typeof p.segments)[number]["model"]) => simulate(model, 8, 1, { monthly: true, monthStarts: p.monthStarts, ...(p.start ? { initialState: p.start } : {}) });
  const a = go(p.segments[0]!.model).monthlySamples!;
  const b = go(p.pair![0]!.model).monthlySamples!;
  return { a, b, riseMonths: p.riseMonths };
}

describe("the price rise's trade-off on the demo", () => {
  it("+8% from March: months before it are exactly 0, gained - lost = net per replication and month, and it has a break-even", () => {
    const { a, b, riseMonths } = pair(0.08);
    expect(riseMonths).toEqual([5]);
    for (let i = 0; i < a.revenue.length; i++) {
      for (let m = 0; m < 5; m++) {
        // Money to the last bits (a stay's fee spread over its months; engine-versioning.md): 1e-12 relative.
        expect(Math.abs(a.revenue[i]![m]! - b.revenue[i]![m]!)).toBeLessThan(1e-12 * b.revenue[i]![m]!);
        expect(a.rise[i]![m]).toBe(0);
        expect(a.clientsLost[i]![m]).toBe(b.clientsLost[i]![m]);
      }
    }
    const t = priceRiseTradeoff(a, b, riseMonths, { monthlyFee: 4000, clientMonthsAfter: 200 })!;
    for (let m = 0; m < 5; m++) expect([t.gained[m]!.mean, t.lost[m]!.mean, t.net[m]!.mean, t.extraLeavers[m]!.mean]).toEqual([0, 0, 0, 0]);
    t.gained.forEach((g, m) => expect(g.mean - t.lost[m]!.mean).toBeCloseTo(t.net[m]!.mean, 6));
    expect(t.total.gained.mean).toBeGreaterThan(0);
    expect(t.outcome).toBe("breakEven");
    expect(t.breakEven).toBeGreaterThan(0);
  });

  it("-10% from March is a cut: the stayers pay less, nobody extra leaves, and there is no break-even", () => {
    const { a, b, riseMonths } = pair(-0.1);
    const t = priceRiseTradeoff(a, b, riseMonths, { monthlyFee: 4000, clientMonthsAfter: 200 })!;
    expect(t.total.gained.mean).toBeLessThan(0);
    expect(t.total.extraLeavers.mean).toBe(0);
    expect(t.outcome).toBe("cut");
    expect(t.breakEvenRate).toBeNull();
  });
});
