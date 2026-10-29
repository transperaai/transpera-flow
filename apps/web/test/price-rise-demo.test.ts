import { describe, expect, it } from "vitest";
import type { SandboxChange } from "@transpera-flow/db";
import { simulate, type EngineModel } from "@transpera-flow/engine";
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

// With Settings' price driver off but a planned price rise in it (a value and a month), a B5 rise switches the driver on. The without-rise
// run must have it on too, with the same weight, value and month, so Settings' own planned rise counts in both and "lost" is the B5 rise's alone.
describe("the price rise's pair when Settings has the price driver off", () => {
  const settings = () => {
    const bundle = demoForecastBundle();
    const row = { id: "7f000000-0000-4000-8000-00000000d001", workspace_id: bundle.workspace.id, driver: "price", name: null, weight: 1.5, enabled: false, value: 10, month: 6, chance: null, effect: null, effect_months: null };
    return { ...bundle, churnDrivers: [...(bundle.churnDrivers ?? []).filter((d) => d.driver !== "price"), row] } as typeof bundle;
  };
  const prepared = () => {
    const p = prepareScenario(settings(), eff([rise(0.08)]), [], 12, START);
    if (p.error !== null) throw new Error(p.error);
    return p;
  };
  const go = (p: ReturnType<typeof prepared>, model: EngineModel) => simulate(model, 8, 1, { monthly: true, monthStarts: p.monthStarts, ...(p.start ? { initialState: p.start } : {}) }).monthlySamples!;
  const driverOf = (m: EngineModel) => m.churnDrivers!.find((d) => d.id === "price");

  it("turns the driver on in both runs with the same weight, value and month", () => {
    const p = prepared();
    expect(driverOf(p.segments[0]!.model)).toEqual({ id: "price", weight: 1.5, enabled: true, value: 10, month: 6 });
    expect(driverOf(p.pair![0]!.model)).toEqual(driverOf(p.segments[0]!.model));
    // Without a B5 rise nothing is forced: the live model keeps the driver off.
    const plain = prepareScenario(settings(), [], [], 12, START);
    expect(driverOf(plain.segments[0]!.model)!.enabled).toBe(false);
  });

  it("the pair differs only by the rise: lost equals the extra churn of the B5 rise alone, and gained - lost = net", () => {
    const p = prepared();
    const a = go(p, p.segments[0]!.model);
    const b = go(p, p.pair![0]!.model);
    // A hand-built pair: the scenario's own model with its fee channel taken out (the rise), the driver on as the scenario has it.
    const handBuilt = { ...p.segments[0]!.model };
    delete handBuilt.channels;
    const h = go(p, handBuilt);
    expect(b).toEqual(h);
    const t = priceRiseTradeoff(a, b, p.riseMonths, { monthlyFee: 4000, clientMonthsAfter: 200 })!;
    const byHand = priceRiseTradeoff(a, h, p.riseMonths, { monthlyFee: 4000, clientMonthsAfter: 200 })!;
    expect(t.lost.map((x) => x.mean)).toEqual(byHand.lost.map((x) => x.mean));
    expect(t.extraLeavers.map((x) => x.mean)).toEqual(byHand.extraLeavers.map((x) => x.mean));
    t.gained.forEach((g, m) => expect(g.mean - t.lost[m]!.mean).toBeCloseTo(t.net[m]!.mean, 6));
    // Settings' planned rise is in both runs, so it adds nothing to the B5 rise's extra leavers before the B5 rise (month 5): the months before are exactly 0.
    for (let m = 0; m < 5; m++) expect([t.lost[m]!.mean, t.extraLeavers[m]!.mean]).toEqual([0, 0]);
    // With the driver left off in the pair (the old behaviour), Settings' own rise would count as lost, and the figures differ.
    const off = { ...p.pair![0]!.model, churnDrivers: p.pair![0]!.model.churnDrivers!.map((d) => (d.id === "price" ? { ...d, enabled: false } : d)) };
    expect(go(p, off)).not.toEqual(b);
  });
});
