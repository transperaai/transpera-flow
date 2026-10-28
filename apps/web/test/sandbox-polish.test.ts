import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { northbeamRoleIds, sandboxLever, type SandboxChange } from "@transpera-flow/db";
import { applyPatches, headcount } from "@transpera-flow/engine";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { describeChange } from "@/lib/sandbox/describe";
import { patchOf } from "@transpera-flow/db";
import { othersTotal, shareToWeight, weightToShare } from "@/lib/sandbox/traffic";
import { todayValue, trafficToday } from "@/lib/sandbox/today";

// Polish from the Sandbox click-through (see the commits on branch sandbox-polish): pure logic, a case group per item. The page's own
// behaviour is in sandbox-browser.test.ts.

const bundle = demoForecastBundle();
const model = forecastModel(bundle, 12, DEMO_FORECAST_START).model!;
const SEO = "80000000-0000-4000-8000-000000000001";
const PPC_SERVICE = "80000000-0000-4000-8000-000000000002";
const lever = (id: string) => sandboxLever(id)!;

describe("1. today's value in the change dialog", () => {
  it("reads each lever's value from the live model the runs use", () => {
    expect(todayValue(lever("A1"), null, model, "GBP")).toBe(`about ${Math.round(model.leadsPerWeek * (52 / 12))} opportunities a month`);
    expect(todayValue(lever("A1"), null, model, "GBP")).toBe("about 30 opportunities a month");
    expect(todayValue(lever("B2"), SEO, model, "GBP")).toBe("£3,500 a month");
    expect(todayValue(lever("B2"), PPC_SERVICE, model, "GBP")).toBe("£4,200 a month");
    expect(todayValue(lever("B1"), null, model, "GBP")).toBe("29 clients");
    expect(todayValue(lever("B3"), null, model, "GBP")).toMatch(/^\d+(\.\d)?% a month$/);
    expect(todayValue(lever("D5"), northbeamRoleIds.ppc, model, "GBP")).toBe("3 people");
    expect(todayValue(lever("D1"), northbeamRoleIds.strat, model, "GBP")).toBe("1 person");
    expect(todayValue(lever("E1"), model.steps[0]!.id, model, "GBP")).toMatch(/^[\d.]+ hours of hands-on time$/);
  });

  it("names the role or step a selector picks", () => {
    expect(todayValue(lever("D5"), "@busiest", model, "GBP")).toMatch(/^\d+ (person|people) \(.+\)$/);
    expect(todayValue(lever("E1"), "@heaviest", model, "GBP")).toMatch(/hands-on time \(.+\)$/);
  });

  it("matches what the runner starts from: setting the lever to today's value changes nothing", () => {
    const same = applyPatches(model, [{ path: `roles.${northbeamRoleIds.ppc}.headcount`, op: "set", value: 3 }]);
    expect(Object.keys(same.model.people!)).toEqual(Object.keys(model.people!));
    expect(headcount(model, northbeamRoleIds.ppc)).toBe(3);
    expect(todayValue(lever("A1"), null, applyPatches(model, [{ path: "demand.leads_per_week", op: "multiply", value: 2 }]).model, "GBP")).toBe("about 61 opportunities a month");
  });

  it("never shows a person's pay, and says nothing for a lever that stores one", () => {
    const person = Object.keys(model.people!)[0]!;
    const paid = { ...model, people: { ...model.people!, [person]: { ...model.people![person]!, cost: 123456 } } };
    for (const l of ["A1", "B1", "B2", "B3", "C2", "D1", "D2", "D4", "D5", "E1", "E2", "E3"]) {
      const text = todayValue(lever(l), l === "D2" || l === "D4" ? person : l === "D1" || l === "D5" ? northbeamRoleIds.ppc : l.startsWith("E") ? model.steps[0]!.id : l === "B2" ? SEO : null, paid, "GBP") ?? "";
      expect(text, l).not.toContain("123");
    }
    expect(todayValue({ ...lever("D4"), pay: "individual" }, person, model, "GBP")).toBeNull();
    expect(todayValue(lever("D4"), person, model, "GBP")).toMatch(/^[\d.]+ FTE$/);
  });

  it("has nothing to say for a leave, a solution or a missing target", () => {
    expect(todayValue(lever("D3"), Object.keys(model.people!)[0]!, model, "GBP")).toBeNull();
    expect(todayValue(lever("E6"), "x", model, "GBP")).toBeNull();
    expect(todayValue(lever("D5"), "gone", model, "GBP")).toBeNull();
  });
});

describe("2. traffic by type as percentages", () => {
  const mix = Object.fromEntries(Object.entries(model.services!).map(([id, s]) => [id, s.mixShare]));

  it("shows the current split", () => {
    expect(trafficToday(model)).toBe("SEO retainer 55%, PPC management 45%");
    expect(todayValue(lever("A6"), SEO, model, "GBP")).toBe("SEO retainer 55%, PPC management 45%");
    expect(trafficToday({ services: { a: model.services![SEO]! } })).toBeNull();
  });

  it("round-trips a percentage to a weight and back", () => {
    for (const others of [0.45, 1, 7.3, 250]) {
      for (const percent of [0, 1, 12.5, 33.3, 40, 55, 80, 99]) {
        const weight = shareToWeight(percent / 100, others)!;
        expect(weight, `${percent}% of ${others}`).not.toBeNull();
        expect(Math.round(weightToShare(weight, others) * 1000) / 10).toBeCloseTo(percent, 0);
        expect(weightToShare(weight, others)).toBeCloseTo(percent / 100, 4);
      }
    }
    expect(shareToWeight(0.4, 0.45)).toBe(0.3);
    expect(shareToWeight(1, 0.45)).toBeNull();
    expect(shareToWeight(0.4, 0)).toBeNull();
    expect(shareToWeight(0, 0)).toBe(0);
    expect(othersTotal(mix, SEO)).toBe(0.45);
  });

  it("makes the engine give the type that share, the others keeping their proportions to one another", () => {
    const three = { ...model.services!, extra: { ...model.services![PPC_SERVICE]!, name: "Extra", mixShare: 0.2 } };
    const m3 = { ...model, services: three };
    const mix3 = Object.fromEntries(Object.entries(three).map(([id, s]) => [id, s.mixShare]));
    const weight = shareToWeight(0.4, othersTotal(mix3, SEO))!;
    const after = applyPatches(m3, [{ path: `services.${SEO}.mix_share`, op: "set", value: weight }]).model.services!;
    const total = Object.values(after).reduce((a, s) => a + s.mixShare, 0);
    expect(after[SEO]!.mixShare / total).toBeCloseTo(0.4, 6);
    // The other two still split the rest 45 : 20.
    expect(after[PPC_SERVICE]!.mixShare / after.extra!.mixShare).toBeCloseTo(0.45 / 0.2, 6);
  });

  it("reads a saved set change as '→ 40%' in the change list, and a weight of another kind as before", () => {
    const set: SandboxChange = { id: randomUUID(), lever: "A6", target: SEO, op: "set", value: 0.3 };
    const ctx = { bundle, solutions: [], changes: [set], mix };
    expect(describeChange(set, ctx)).toBe("Traffic by type, SEO retainer → 40%");
    expect(patchOf(set)).toEqual({ path: `services.${SEO}.mix_share`, op: "set", value: 0.3 });
    expect(describeChange({ ...set, op: "multiply", value: 1.5 }, ctx)).toBe("Traffic by type, SEO retainer ×1.5");
    // Without the model's weights the bundle's active services are the others.
    expect(describeChange(set, { bundle, solutions: [], changes: [set] })).toMatch(/→ \d+(\.\d)?%$/);
  });

  it("offers only 'Set to' for a new change", () => {
    expect(Object.keys(lever("A6").range)).toEqual(["set"]);
  });
});
