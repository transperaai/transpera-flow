import { describe, expect, it } from "vitest";
import { SANDBOX_LIBRARY, northbeamBundle, type SandboxChange } from "@transpera-flow/db";
import { northbeamWithClientGroups, northbeamWithClients, northbeamWithServices, simulate, type EngineModel } from "@transpera-flow/engine";
import { applyModelChanges, hasClientRoster } from "@/lib/sandbox/edits";
import { prepareScenario } from "@/lib/sandbox/run";

// The whole-run levers that are edits of the model rather than patches (docs/plans/sandbox-p3-brief.md §5.4): clients on the book and base
// churn for a roster (B1, B3), a fee range (A5), a churn driver as a chance (B4) and the price driver a price rise switches on (B5).

let n = 0;
const ch = (lever: string, op: SandboxChange["op"], value: number, target: string | null = null, params?: SandboxChange["params"]): SandboxChange =>
  ({ id: `7d000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, lever, target, op, value, ...(params ? { params } : {}) }) as SandboxChange;
const apply = (model: ReturnType<typeof northbeamWithClients>, ...changes: SandboxChange[]) => applyModelChanges(model, changes, { churnDrivers: [] });

describe("clients on the book (B1) and base churn (B3) for a roster", () => {
  const groups = northbeamWithClientGroups();
  const seo = Object.keys(groups.clientGroups!)[0]!;

  it("knows a roster from a pooled count", () => {
    expect(hasClientRoster(groups)).toBe(true);
    expect(hasClientRoster(northbeamWithClients())).toBe(true);
    expect(hasClientRoster(northbeamWithServices())).toBe(false);
  });

  it("changes the count of one type's group, or of every type, rounded and kept between 0 and 2,000", () => {
    const before = groups.clientGroups![seo]!.count;
    const one = apply(groups, ch("B1", "add", 5, seo));
    expect(one.problems).toEqual([]);
    expect(one.model.clientGroups![seo]!.count).toBe(before + 5);
    expect(one.model.activeClients).toBe(groups.activeClients + 5);
    expect(apply(groups, ch("B1", "multiply", 0.5, seo)).model.clientGroups![seo]!.count).toBe(Math.round(before * 0.5));
    expect(apply(groups, ch("B1", "add", -9999, seo)).model.clientGroups![seo]!.count).toBe(0);
    expect(apply(groups, ch("B1", "add", 9999, seo)).model.clientGroups![seo]!.count).toBe(2000);
    for (const [sid, g] of Object.entries(apply(groups, ch("B1", "multiply", 2)).model.clientGroups!)) expect(g.count, sid).toBe(groups.clientGroups![sid]!.count * 2);
  });

  it("refuses to set the count for every type at once, and says a type that is gone is gone", () => {
    expect(apply(groups, ch("B1", "set", 10)).problems[0]!.message).toMatch(/Pick a type/);
    expect(apply(groups, ch("B1", "add", 1, "5ead0000-0000-4000-8000-00000000dead")).problems[0]!.message).toBe("A service in this scenario is no longer there");
  });

  it("adds named clients as average clients of the type, and refuses to take any away", () => {
    const named = northbeamWithClients();
    const have = Object.keys(named.clients!).length;
    const added = apply(named, ch("B1", "add", 2, "seo"));
    expect(added.problems).toEqual([]);
    expect(Object.keys(added.model.clients!)).toHaveLength(have + 2);
    expect(added.model.activeClients).toBe(have + 2);
    const mine = Object.values(added.model.clients!).filter((c) => c.name.includes("(added)"));
    expect(mine.map((c) => c.services)).toEqual([["seo"], ["seo"]]);
    const seoMrr = Object.values(named.clients!).filter((c) => c.services.includes("seo")).map((c) => c.mrr);
    expect(mine[0]!.mrr).toBeCloseTo(seoMrr.reduce((a, b) => a + b, 0) / seoMrr.length);
    const removed = apply(named, ch("B1", "add", -1, "seo"));
    expect(removed.model.clients).toEqual(named.clients);
    expect(removed.problems[0]!.message).toMatch(/can't be removed/);
  });

  it("changes the base churn of a type's group and service, clamped to 0 to 1", () => {
    const g = apply(groups, ch("B3", "multiply", 2, seo)).model;
    expect(g.clientGroups![seo]!.churnMonthly).toBeCloseTo(groups.clientGroups![seo]!.churnMonthly * 2);
    expect(g.services![seo]!.churnMonthly).toBeCloseTo(groups.services![seo]!.churnMonthly * 2);
    expect(apply(groups, ch("B3", "add", 5, seo)).model.clientGroups![seo]!.churnMonthly).toBe(1);
    expect(apply(groups, ch("B3", "set", 0.04, seo)).model.clientGroups![seo]!.churnMonthly).toBe(0.04);
  });
});

describe("a fee range (A5), a churn driver as a chance (B4) and the price driver for a price rise (B5)", () => {
  const model = northbeamWithClients();

  it("sets a service's fee and a range around it, and clears an old range when the new one is a single fee", () => {
    const ranged = apply(model, ch("A5", "set", 4000, "seo", { low: 3000, high: 6000 })).model;
    expect(ranged.services!.seo).toMatchObject({ price: 4000, priceRange: { low: 3000, high: 6000 } });
    const flat = apply(ranged, ch("A5", "set", 4000, "seo", { low: 4000, high: 4000 })).model;
    expect(flat.services!.seo!.price).toBe(4000);
    expect(flat.services!.seo!.priceRange).toBeUndefined();
    expect(apply(model, ch("A5", "set", 1, "5ead0000-0000-4000-8000-00000000dead")).problems).toHaveLength(1);
  });

  it("switches a driver on in chance mode with its effect and how long a hit lasts, and refuses early tenure and the market", () => {
    const late = apply(model, ch("B4", "set", 0.5, "late", { chance: 0.1, months: 4 })).model.churnDrivers!.find((d) => d.id === "late")!;
    expect(late).toMatchObject({ enabled: true, chance: 0.1, effect: 0.5, effectMonths: 4 });
    const measured = apply(model, ch("B4", "set", 0.5, "late")).model.churnDrivers!.find((d) => d.id === "late")!;
    expect(measured).toMatchObject({ chance: null, effect: 0.5, effectMonths: 3 });
    for (const id of ["tenure", "market"]) expect(apply(model, ch("B4", "set", 0.5, id)).problems[0]!.message).toMatch(/don't have chances/);
    expect(apply(model, ch("B4", "set", 0.5, "custom:gone")).problems[0]!.message).toBe("A churn driver in this scenario is no longer there");
  });

  it("switches the price driver on for a price rise, and leaves one in chance mode as the user set it", () => {
    const on = apply(model, ch("B5", "set", 0.1)).model.churnDrivers!.find((d) => d.id === "price")!;
    expect(on.enabled).toBe(true);
    const own = { ...model, churnDrivers: [{ id: "price", weight: 1, enabled: false, chance: 0.2, effect: 30, effectMonths: 3 }] };
    expect(apply(own, ch("B5", "set", 0.1)).model.churnDrivers![0]).toMatchObject({ enabled: false, effect: 30 });
  });
});

describe("the Downturn starter on Northbeam's client groups (B3 on a roster, coordinator item 6)", () => {
  it("raises every group's base churn by half, through the runner, and the run loses more clients than the live one", () => {
    const downturn = SANDBOX_LIBRARY.find((s) => s.name === "Downturn")!;
    const start = "2026-10-05";
    const eff = (list: readonly SandboxChange[]) => list.map((c) => ({ change: c as SandboxChange, scenarioId: "s", scenarioName: "Downturn", inherited: false }));
    const live = prepareScenario(northbeamBundle(), [], [], 12, start);
    const scenario = prepareScenario(northbeamBundle(), eff(downturn.changes), [], 12, start);
    expect(scenario.error).toBeNull();
    expect(scenario.problems).toEqual([]);
    const liveGroups = live.segments[0]!.model.clientGroups!;
    const groupsNow = scenario.segments[0]!.model.clientGroups!;
    expect(Object.keys(groupsNow).length).toBeGreaterThan(0);
    for (const [sid, g] of Object.entries(groupsNow)) expect(g.churnMonthly).toBeCloseTo(liveGroups[sid]!.churnMonthly * 1.5, 12);
    const run = (m: EngineModel, s: typeof live) => simulate(m, 8, 1, { monthly: true, monthStarts: s.monthStarts, ...(s.start ? { initialState: s.start } : {}) }).kpi.clientsChurned!.mean;
    expect(run(scenario.segments[0]!.model, scenario)).toBeGreaterThan(run(live.segments[0]!.model, live));
  });
});
