import { describe, expect, it } from "vitest";
import { northbeamRoleIds, type SandboxChange } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { prepareScenario } from "@/lib/sandbox/run";
import { priceRiseTradeoff } from "@/lib/sandbox/price-rise";

// Viewers and pay (brief section 7, B1): no phase 3 lever stores one person's pay, and a reader who may not see pay (a Viewer who is
// not everyone, a share link) still gets revenue, clients, churn and the price rise's trade-off, with labour, overtime and profit null.

const START = DEMO_FORECAST_START;
const base = demoForecastBundle();
const hidden = { ...base, viewer: { seesEveryone: false, ownPersonId: null } };
const eff = (list: SandboxChange[]) => list.map((c) => ({ change: c, scenarioId: "s", scenarioName: "S", inherited: false }));
const changes: SandboxChange[] = [
  { id: "7f000000-0000-4000-8000-000000000001", lever: "C1", target: northbeamRoleIds.ppc, op: "multiply", value: 1.3, from: "2027-03" },
  { id: "7f000000-0000-4000-8000-000000000002", lever: "B5", target: null, op: "set", value: 0.08, from: "2027-03" },
];

function run(bundle: typeof base) {
  const p = prepareScenario(bundle, eff(changes), [], 12, START);
  if (p.error !== null) throw new Error(p.error);
  const go = (model: (typeof p.segments)[number]["model"]) => simulate(model, 6, 1, { monthly: true, monthStarts: p.monthStarts, ...(p.start ? { initialState: p.start } : {}) });
  expect(p.segments).toHaveLength(1);
  const withRise = go(p.segments[0]!.model);
  const without = go(p.pair![0]!.model);
  return { withRise, without, riseMonths: p.riseMonths };
}

describe("a reader who may not see pay", () => {
  const open = run(base);
  const closed = run(hidden);

  it("gets no labour, overtime or profit, in the totals or by month, whatever the role cost does", () => {
    expect(open.withRise.kpi.labourCost).not.toBeNull();
    expect(closed.withRise.kpi.labourCost).toBeNull();
    expect(closed.withRise.kpi.overtimeCost).toBeNull();
    expect(closed.withRise.kpi.profit).toBeNull();
    expect(closed.withRise.monthly!.money).toBeNull();
    expect(JSON.stringify(closed.withRise.monthly!)).not.toContain('"profit":[{');
  });

  it("gets the same revenue, the same rise and the same clients as an editor: none of it is pay", () => {
    expect(closed.withRise.kpi.revenue).toEqual(open.withRise.kpi.revenue);
    expect(closed.withRise.monthlySamples).toEqual(open.withRise.monthlySamples);
    expect(closed.withRise.monthly!.revenue).toEqual(open.withRise.monthly!.revenue);
  });

  it("still gets the price rise's trade-off, identical to an editor's", () => {
    const tradeoff = (r: typeof open) => priceRiseTradeoff(r.withRise.monthlySamples!, r.without.monthlySamples!, r.riseMonths);
    const a = tradeoff(open);
    const b = tradeoff(closed);
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(a!.total.gained.mean).toBeGreaterThan(0);
  });
});
