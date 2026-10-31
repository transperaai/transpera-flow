import { describe, expect, it } from "vitest";
import {
  applyPlay,
  capacitySetupFromModel,
  defaultPlay,
  hireIds,
  playChanges,
  playIsDefault,
  priceDriverEffect,
  splitWhole,
  toEngineStepChange,
  winEntries,
  winMix,
  PLAY_MONTHS,
  PRICE_REACTION,
  type CapacityChangeRow,
  type PlayContext,
  type PlayState,
} from "@transpera-flow/db";
import { capacityModel, simulate, type EngineModel } from "@transpera-flow/engine";
import { prepareScenario } from "@transpera-flow/db/sandbox";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";

// The free-play Sandbox's levers (capacity build P7, docs/plans/capacity/p7-sandbox-brief.md section 3): each prototype lever becomes the
// expected registry change or model edit, "Win new clients" lands N x k clients by tier, "Clients react" doubles from Barely to Normally,
// a swapped block takes the step's hours down by what the engine says it freed, a named client leaves, and a map version runs its map.

const START = "2026-11-02";

/** Today's example agency (no change swapped in: `changes` is unset, as in a real workspace) and the changes it had as the library. */
const full = capacityModel();
const { changes: engineChanges, ...today } = full;
const model: EngineModel = today;
const library: CapacityChangeRow[] = (engineChanges ?? []).map((c) => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  effects: c.effects,
  adoption: c.adoption,
  ramp_months: c.rampMonths,
  tiers: c.tiers ?? null,
  cost_monthly: null,
  issue_id: null,
  source: "estimate",
  provenance: {},
}));
const setup = capacitySetupFromModel(model);
for (const s of setup.services) s.price_rise_churn = 0.5;
const ctx: PlayContext = { startDate: START, setup, library, winMix: (d) => winMix(setup, model, d) };
const play = (over: Partial<PlayState> = {}): PlayState => ({ ...defaultPlay(), ...over });

describe("the levers become registry changes", () => {
  it("nothing moved is no change at all, and the default is recognised", () => {
    expect(playChanges(defaultPlay(), ctx)).toEqual([]);
    expect(playIsDefault(defaultPlay())).toBe(true);
    expect(playIsDefault(play({ leads: 5 }))).toBe(false);
    expect(applyPlay(model, defaultPlay(), ctx)).toBe(model);
  });

  it("A1 leads and A3 win rate: a multiple, from the market's month", () => {
    const c = playChanges(play({ leads: 10, win: -20, marketFrom: 3 }), ctx);
    expect(c).toMatchObject([
      { lever: "A1", target: null, op: "multiply", value: 1.1, from: "2027-02" },
      { lever: "A3", target: null, op: "multiply", value: 0.8, from: "2027-02" },
    ]);
  });

  it("B3 churn: a multiple of base churn for the whole run", () => {
    const [c] = playChanges(play({ churn: 25 }), ctx);
    expect(c).toMatchObject({ lever: "B3", target: null, op: "multiply", value: 1.25 });
    expect(c!.from).toBeUndefined();
  });

  it("B5 prices: all tiers is one change, a tier is one per service of that tier in both departments", () => {
    expect(playChanges(play({ price: 8, priceFrom: 3 }), ctx)).toMatchObject([{ lever: "B5", target: null, op: "set", value: 0.08, from: "2027-02" }]);
    const t2 = playChanges(play({ price: 8, priceFrom: 0, priceTier: "T2" }), ctx);
    expect(t2.map((c) => c.target).sort()).toEqual(["org-T2", "perf-T2"]);
    expect(t2.every((c) => c.lever === "B5" && c.value === 0.08 && c.from === "2026-11")).toBe(true);
  });

  it("D2 someone leaves, D1 a hire, E6 a map version: each from its month", () => {
    const c = playChanges(play({ leavers: [{ person: "diya", month: 2 }], hires: [{ role: "links", month: 4 }], versions: { proc: { solution: "sol-1", month: 5 } } }), ctx);
    expect(c).toMatchObject([
      { lever: "D2", target: "diya", op: "set", value: 0, from: "2027-01" },
      { lever: "D1", target: "links", op: "set", value: 1, from: "2027-03" },
      { lever: "E6", target: "sol-1", op: "set", value: 1, from: "2027-04" },
    ]);
    expect(new Set(c.map((x) => x.id)).size).toBe(3);
    expect(hireIds(play({ hires: [{ role: "links", month: 4 }] }))).toEqual([c[1]!.id]);
  });

  it("the months are clamped to the run", () => {
    const c = playChanges(play({ leads: 5, marketFrom: 99 }), ctx);
    expect(c[0]!.from).toBe("2027-10");
  });
});

describe("Win new clients", () => {
  it("shares a total across tiers by largest remainder, to the total exactly", () => {
    expect(splitWhole(6, [0.1, 0.4, 0.5])).toEqual([1, 2, 3]);
    expect(splitWhole(7, [0.1, 0.4, 0.5])).toEqual([1, 3, 3]);
    expect(splitWhole(5, [1, 1])).toEqual([3, 2]);
    expect(splitWhole(0, [1, 1])).toEqual([0, 0]);
  });

  it("N clients a month for k months land N x k clients, in the usual mix by tier", () => {
    const entries = winEntries(play({ add: { org: 2, perf: 1 }, addFrom: 1, addMonths: 6 }), ctx);
    const total = (dept: string) => entries.filter((e) => e.service.startsWith(dept)).reduce((s, e) => s + e.count, 0);
    expect(total("org")).toBe(12);
    expect(total("perf")).toBe(6);
    // The mix is 10 / 40 / 50: 12 -> 1, 5, 6 (largest remainder: 1.2, 4.8, 6 -> 1, 5, 6).
    const byTier = (dept: string) => Object.fromEntries(["T1", "T2", "T3"].map((t) => [t, entries.filter((e) => e.service === `${dept}-${t}`).reduce((s, e) => s + e.count, 0)]));
    expect(byTier("org")).toEqual({ T1: 1, T2: 5, T3: 6 });
    // Six months, from month 2 (1-based) to month 7.
    expect(Math.min(...entries.map((e) => e.month))).toBe(2);
    expect(Math.max(...entries.map((e) => e.month))).toBe(7);
  });

  it("one tier takes them all, spread over the months with the extra ones first", () => {
    const entries = winEntries(play({ add: { org: 1 }, addFrom: 0, addMonths: 3, addTier: "T2" }), ctx);
    expect(entries).toEqual([
      { service: "org-T2", month: 1, count: 1 },
      { service: "org-T2", month: 2, count: 1 },
      { service: "org-T2", month: 3, count: 1 },
    ]);
    expect(winEntries(play({ add: { org: 1, perf: 0 }, addMonths: 1, addTier: "T9" }), ctx)).toEqual([]);
  });

  it("run through the engine, the clients land and are placed least busy", () => {
    const m = applyPlay(model, play({ add: { org: 2 }, addFrom: 1, addMonths: 3, addTier: "T2" }), ctx);
    expect(m.placeNewClients).toBe("least-busy");
    expect(m.wonClients).toHaveLength(3);
    const a = simulate(model, 3, 1, { monthly: true });
    const b = simulate(m, 3, 1, { monthly: true });
    const last = (r: typeof a) => r.monthly!.clients["org-T2"]!.at(-1)!.mean;
    // 2 a month for 3 months = 6, less what the example's churn takes of them in the months after.
    expect(last(b) - last(a)).toBeGreaterThan(4.3);
    expect(last(b) - last(a)).toBeLessThan(6.6);
    expect(b.kpi.won.mean).toBeGreaterThanOrEqual(a.kpi.won.mean + 5);
  });
});

describe("Clients react to a price rise (D36)", () => {
  const rise = (reaction: PlayState["priceReaction"]) => play({ price: 10, priceFrom: 2, priceReaction: reaction });

  it("the price driver is set to 0.5x, 1x and 2x the tier's extra churn for a 10% rise", () => {
    expect(PRICE_REACTION.barely.factor).toBe(0.5);
    expect(PRICE_REACTION.normally.factor).toBe(1);
    expect(PRICE_REACTION.strongly.factor).toBe(2);
    expect(priceDriverEffect(rise("barely"), setup)).toBeCloseTo(0.25, 12);
    expect(priceDriverEffect(rise("normally"), setup)).toBeCloseTo(0.5, 12);
    expect(priceDriverEffect(rise("strongly"), setup)).toBeCloseTo(1, 12);
    expect(priceDriverEffect(rise("normally"), setup)).toBe(2 * priceDriverEffect(rise("barely"), setup));
  });

  it("one tier takes that tier's own rate, and all tiers the mean weighted by clients", () => {
    const s2 = { ...setup, services: setup.services.map((s) => ({ ...s, price_rise_churn: s.tier_id === "T1" ? 2 : 0.4 })) };
    expect(priceDriverEffect(play({ price: 10, priceTier: "T1", priceReaction: "normally" }), s2)).toBeCloseTo(2, 12);
    expect(priceDriverEffect(play({ price: 10, priceTier: "T3", priceReaction: "normally" }), s2)).toBeCloseTo(0.4, 12);
    const all = priceDriverEffect(play({ price: 10, priceReaction: "normally" }), s2);
    expect(all).toBeGreaterThan(0.4);
    expect(all).toBeLessThan(2);
  });

  it("run through the engine, Normally loses about twice the clients Barely does to the rise", () => {
    // The workspace's own price driver is on with a planned 10% rise in month 3; the lever sets how hard clients react.
    const base: EngineModel = { ...model, churnDrivers: [{ id: "price", weight: 1, enabled: true, value: 10, month: 3 }] };
    const lost = (reaction: PlayState["priceReaction"]) => {
      const r = simulate(applyPlay(base, rise(reaction), ctx), 6, 1, { monthly: true });
      return r.churnCauses!.causes.find((c) => c.id === "price")!.clients;
    };
    const barely = lost("barely");
    const normally = lost("normally");
    expect(barely).toBeGreaterThan(0);
    expect(normally / barely).toBeGreaterThan(1.6);
    expect(normally / barely).toBeLessThan(2.4);
    const driver = applyPlay(base, rise("normally"), ctx).churnDrivers!.find((d) => d.id === "price")!;
    expect(driver).toMatchObject({ enabled: true, effect: 0.5, effectMonths: 3, value: 10, month: 3 });
  });
});

describe("a block swapped in for a step", () => {
  const pacing = library.find((c) => c.id === "pacing")!;

  it("becomes an engine change starting in the chosen month (1-based), with its adoption and ramp", () => {
    const m = applyPlay(model, play({ blocks: { pacing: 2 } }), ctx);
    expect(m.changes).toHaveLength(1);
    expect(m.changes![0]).toEqual(toEngineStepChange(pacing, 3));
    expect(m.changes![0]).toMatchObject({ id: "pacing", startMonth: 3, adoption: 0.9, kind: "automation" });
    expect(model.changes).toBeUndefined();
  });

  it("takes the swapped step's hours down by the hours the engine says the block freed, and no other step's", () => {
    const m = applyPlay(model, play({ blocks: { pacing: 0 } }), ctx);
    const a = simulate(model, 2, 1, { personTime: true });
    const b = simulate(m, 2, 1, { personTime: true });
    const byStep = (r: typeof a) => {
      const o: Record<string, number> = {};
      for (const per of Object.values(r.personTime!.stepHours)) for (const [s, h] of Object.entries(per)) o[s] = (o[s] ?? 0) + h;
      return o;
    };
    const before = byStep(a);
    const after = byStep(b);
    const freed = b.personTime!.freed!;
    expect(freed.byChange.pacing).toBeGreaterThan(0);
    expect(before.p1! - after.p1!).toBeCloseTo(freed.byChange.pacing!, 0);
    expect(after.p1!).toBeLessThan(before.p1! * 0.6);
    // Other steps keep their hours, give or take the few clients that leave sooner or later when a team is less busy (the load driver).
    for (const s of Object.keys(before)) if (s !== "p1") expect(Math.abs(after[s]! / before[s]! - 1), s).toBeLessThan(0.03);
  });
});

describe("a named client leaves in a month", () => {
  it("sets leavesMonth on that client only", () => {
    const id = Object.keys(model.clients!)[0]!;
    const m = applyPlay(model, play({ lose: [{ id, month: 3 }, { id: "nobody", month: 1 }] }), ctx);
    expect(m.clients![id]!.leavesMonth).toBe(4);
    expect(Object.values(m.clients!).filter((c) => c.leavesMonth !== undefined)).toHaveLength(1);
    expect(model.clients![id]!.leavesMonth).toBeUndefined();
  });

  it("run through the engine, that client is gone from that month and counts as lost", () => {
    const id = Object.keys(model.clients!)[0]!;
    const svc = model.clients![id]!.services[0]!;
    const a = simulate(model, 4, 1, { monthly: true });
    const b = simulate(applyPlay(model, play({ lose: [{ id, month: 3 }] }), ctx), 4, 1, { monthly: true });
    const at = (r: typeof a, m: number) => r.monthly!.clients[svc]![m]!.mean;
    expect(at(b, 1)).toBeCloseTo(at(a, 1), 6);
    expect(at(a, 6) - at(b, 6)).toBeGreaterThan(0.9);
    expect(at(a, 6) - at(b, 6)).toBeLessThan(1.1);
  });
});

describe("hires and the market", () => {
  it("a hire takes the workspace's ramp unless it has its own", () => {
    const people = { ...model.people!, [hireIds(play({ hires: [{ role: "links", month: 3 }] }))[0]!]: { name: "New links", roles: ["links"], capacity: 40 } };
    const id = Object.keys(people).at(-1)!;
    const m = applyPlay({ ...model, people }, play({ hires: [{ role: "links", month: 3 }] }), ctx, new Set([id]));
    expect(m.people![id]!.ramp).toEqual([0.4, 0.6, 0.8]);
    expect(m.people!.diya?.ramp).toBeUndefined();
  });

  it("conditions apply from the month, with the workspace's own schedule before it", () => {
    const m = applyPlay(model, play({ market: "downturn", marketFrom: 4 }), ctx);
    expect(m.market!.months).toHaveLength(PLAY_MONTHS);
    expect(m.market!.months[3]!.leads).toBe(1);
    expect(m.market!.months[4]!.leads).toBe(0.65);
    expect(m.market!.months[11]!.churn).toBe(1.35);
  });
});

describe("a map version per process", () => {
  const bundle = demoForecastBundle();
  const demoCtx: PlayContext = { ...ctx, startDate: DEMO_FORECAST_START };

  it("picking a solution runs its map from the month it is live, and today's map before", () => {
    const c = playChanges(play({ versions: { [DEMO_FORECAST_SOLUTION.process_id]: { solution: DEMO_FORECAST_SOLUTION.id, month: 3 } } }), demoCtx);
    expect(c).toHaveLength(1);
    const eff = c.map((change) => ({ change, scenarioId: "play", scenarioName: "Free play", inherited: false }));
    const prepared = prepareScenario(bundle, eff, [DEMO_FORECAST_SOLUTION], 12, DEMO_FORECAST_START, { pair: false });
    expect(prepared.error).toBeNull();
    expect(prepared.problems).toEqual([]);
    // Two runs: today's map from the start, the solution's from month 3; the solution halves the PPC set-up step.
    expect(prepared.segments.map((s) => s.from)).toEqual([0, 3]);
    const ppc = (m: EngineModel) => m.steps.find((s) => s.id === DEMO_FORECAST_SOLUTION.changed_step_ids[0])!.work;
    expect(ppc(prepared.segments[1]!.model)).toBe(ppc(prepared.segments[0]!.model) / 2);
    // Picking nothing is one run of today's map.
    const none = prepareScenario(bundle, [], [DEMO_FORECAST_SOLUTION], 12, DEMO_FORECAST_START, { pair: false });
    expect(none.segments).toHaveLength(1);
    expect(ppc(none.segments[0]!.model)).toBe(ppc(prepared.segments[0]!.model));
  });

  it("a solution live from the first month is one run of its map", () => {
    const c = playChanges(play({ versions: { p: { solution: DEMO_FORECAST_SOLUTION.id, month: 0 } } }), demoCtx);
    const prepared = prepareScenario(bundle, c.map((change) => ({ change, scenarioId: "play", scenarioName: "Free play", inherited: false })), [DEMO_FORECAST_SOLUTION], 12, DEMO_FORECAST_START, { pair: false });
    expect(prepared.segments).toHaveLength(1);
    expect(prepared.segments[0]!.model.steps.find((s) => s.id === DEMO_FORECAST_SOLUTION.changed_step_ids[0])!.work).toBe(4);
  });
});
