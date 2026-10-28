import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { northbeamRoleIds, sandboxLever, type SandboxChange } from "@transpera-flow/db";
import { applyPatches, headcount } from "@transpera-flow/engine";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { describeChange } from "@/lib/sandbox/describe";
import { patchOf } from "@transpera-flow/db";
import { explainFull } from "@/lib/sandbox/explain";
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

describe("3. explaining a result that looks worse because someone is full", () => {
  const stat = (mean: number) => ({ mean, p10: mean, p90: mean });
  const busy = (...means: (number | null)[]) => means.map((m) => (m === null ? null : { ...stat(m), capacity: 40, work: 40 * m }));
  const run = (o: { strat: (number | null)[]; dan?: (number | null)[]; lost: number[]; won: number[] }) => ({
    roles: { strat: busy(...o.strat), sales: busy(0.5, 0.5, 0.5, 0.5) },
    people: { dan: busy(...(o.dan ?? [0.5, 0.5, 0.5, 0.5])) },
    clientsLost: o.lost.map(stat),
    sales: { opportunities: [], won: o.won.map(stat), lost: [], conversion: [] },
  });
  const live = run({ strat: [0.7, 0.7, 0.7, 0.7], lost: [6, 6, 7, 7], won: [10, 10, 10, 10] });
  const monthNames = ["January 2027", "February 2027", "March 2027", "April 2027"];
  const roles = { strat: { name: "Strategist" }, sales: { name: "Sales" } };
  const input = (scenario: ReturnType<typeof run>, extra: Partial<Parameters<typeof explainFull>[0]> = {}) => ({ live, scenario, monthNames, roles, people: {}, ...extra });

  it("says who is full, from when, and what got worse (38 against 26)", () => {
    const scenario = run({ strat: [0.8, 0.9, 1, 1], lost: [8, 9, 10, 11], won: [10, 10, 9, 8] });
    const [note, ...rest] = explainFull(input(scenario));
    expect(rest).toEqual([]);
    expect(note!.text).toBe("The strategist role is full from March 2027, so new work waits and more clients leave (38 against 26 with no changes) and fewer deals are won (37 against 40 with no changes).");
    expect(note!.hireRoleId).toBe("strat");
    expect(note!.month).toBe(2);
  });

  it("says only what got worse", () => {
    expect(explainFull(input(run({ strat: [1, 1, 1, 1], lost: [6, 6, 7, 7], won: [8, 8, 8, 8] })))[0]!.text).toBe(
      "The strategist role is full from January 2027, so new work waits and fewer deals are won (32 against 40 with no changes).",
    );
    expect(explainFull(input(run({ strat: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [10, 10, 10, 10] })))[0]!.text).toMatch(/so new work waits and more clients leave \(36 against 26 with no changes\)\.$/);
  });

  it("says nothing when nobody is full, when it is full no sooner than before, or when nothing got worse", () => {
    expect(explainFull(input(run({ strat: [0.8, 0.9, 0.95, 0.9], lost: [9, 9, 9, 9], won: [5, 5, 5, 5] })))).toEqual([]);
    expect(explainFull(input(run({ strat: [1, 1, 1, 1], lost: [5, 5, 6, 6], won: [11, 11, 11, 11] })))).toEqual([]);
    // Full in the live forecast too, from the same month.
    const fullLive = { ...live, roles: { ...live.roles, strat: busy(1, 1, 1, 1) } };
    expect(explainFull({ ...input(run({ strat: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [5, 5, 5, 5] })), live: fullLive })).toEqual([]);
    // Full sooner than live: counts.
    expect(explainFull({ ...input(run({ strat: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [5, 5, 5, 5] })), live: { ...live, roles: { ...live.roles, strat: busy(0.9, 1, 1, 1) } } })).toHaveLength(1);
  });

  it("names a person who is full when their role is not named, only if the reader may see them", () => {
    const scenario = run({ strat: [0.8, 0.8, 0.8, 0.8], dan: [0.9, 1, 1, 1], lost: [9, 9, 9, 9], won: [10, 10, 10, 10] });
    const dan = { dan: { name: "Dan Okafor", roles: ["sales"] } };
    expect(explainFull(input(scenario, { people: dan }))[0]).toMatchObject({ text: expect.stringMatching(/^Dan Okafor is full from February 2027, so new work waits and more clients leave/) as unknown as string, hireRoleId: "sales", month: 1 });
    expect(explainFull(input(scenario, { people: {} }))).toEqual([]);
    // The person's role is named already: one sentence.
    const both = run({ strat: [1, 1, 1, 1], dan: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [10, 10, 10, 10] });
    expect(explainFull(input(both, { people: { dan: { name: "Dan Okafor", roles: ["strat"] } } }))).toHaveLength(1);
  });

  it("keeps acronyms in a role's name and limits the sentences", () => {
    const r = { ...roles, ppc: { name: "PPC specialist" } };
    const scenario = { ...run({ strat: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [10, 10, 10, 10] }), roles: { strat: busy(1, 1, 1, 1), sales: busy(1, 1, 1, 1), ppc: busy(1, 1, 1, 1) } };
    const notes = explainFull({ ...input(scenario), roles: r, live: { ...live, roles: { strat: busy(0.5), sales: busy(0.5), ppc: busy(0.5) } } });
    expect(notes).toHaveLength(2);
    expect(explainFull({ ...input(scenario), roles: r, limit: 3, live: { ...live, roles: { strat: busy(0.5), sales: busy(0.5), ppc: busy(0.5) } } }).map((n) => n.text.split(" is full")[0])).toEqual(["The strategist role", "The sales role", "The PPC specialist role"]);
  });
});
