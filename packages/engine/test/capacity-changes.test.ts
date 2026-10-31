import { describe, expect, it } from "vitest";
import { capacityModel, capacityProblems, runOnce, simulate, stepPartsDetail, type EngineClient, type EngineModel, type EngineService, type EngineStep, type EngineStepChange } from "../src";

// P3 (docs/plans/capacity/p3-engine-changes-brief.md): the engine reads step splits, tier multipliers and changes. Small hand-checkable
// models with constant distributions, so a drawn time is its mean exactly.

const HPW = 40;
const MIN = 1 / 60;

interface Opts {
  work?: number;
  split?: EngineStep["split"];
  mult?: Record<string, number>;
  changes?: EngineStepChange[];
  /** Service ids with their tier keys (default: one service `sa` on T1). */
  tiers?: Record<string, string | undefined>;
  clients?: Record<string, EngineClient>;
  weeks?: number;
  perMonth?: number;
  extra?: Partial<EngineModel>;
  adhoc?: boolean;
}

const service = (tier: string | undefined, adhoc: boolean | undefined, perMonth: number): EngineService => ({
  name: `Service ${tier}`,
  pricingModel: "retainer",
  price: 4330,
  margin: 0.5,
  tenureMonths: 12,
  churnMonthly: 0,
  mixShare: 1,
  pathTags: [],
  ...(tier !== undefined ? { tier } : {}),
  deliverables: { meetings: perMonth },
  ...(adhoc ? { adhoc: { chance: 1, requests: perMonth } } : {}),
  servicing: [{ process: "care", recurrence: adhoc ? { perMonth: 1, driver: "adhoc" } : { perMonth: 1, driver: "meetings" }, sla: 1000 }],
});

/** One servicing process `care` of one constant step `task`; two people; no warm-up, no leads, no churn. */
function model(o: Opts = {}): EngineModel {
  const tiers = o.tiers ?? { sa: "T1" };
  const clients = o.clients ?? { c1: { name: "C1", services: ["sa"], mrr: 4330, assignments: {} } };
  return {
    horizonWeeks: o.weeks ?? 26,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    roles: { r: { name: "Role r", count: 2, cost: 50, ongoing: 0 } },
    people: { ann: { name: "Ann", roles: ["r"], capacity: HPW }, bob: { name: "Bob", roles: ["r"], capacity: HPW } },
    services: Object.fromEntries(Object.entries(tiers).map(([id, tier]) => [id, service(tier, o.adhoc, o.perMonth ?? 4)])),
    servicingProcesses: { care: { name: "Care", entry: "task", steps: ["task"] } },
    clients,
    entry: "a",
    sinks: { won: "won", lost: "lost" },
    ends: { care_done: { outcome: "done" } },
    steps: [
      { id: "a", name: "A", role: "r", work: 1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "won", p: 1 }] },
      {
        id: "task",
        name: "Task",
        role: "r",
        work: o.work ?? 1,
        wait: 0,
        rework: 0,
        workDist: { kind: "constant" },
        next: [{ to: "care_done", p: 1 }],
        ...(o.split ? { split: o.split } : {}),
        ...(o.mult ? { tierMultiplier: o.mult } : {}),
      },
    ],
    ...(o.changes ? { changes: o.changes } : {}),
    ...o.extra,
  };
}

const automation = (id: string, over: Partial<EngineStepChange> = {}, remove = 0.9, residualHours?: number): EngineStepChange => ({
  id,
  name: id,
  kind: "automation",
  effects: [{ step: "task", part: "automatable", remove, ...(residualHours !== undefined ? { residualHours } : {}) }],
  adoption: 1,
  startMonth: 1,
  rampMonths: 0,
  ...over,
});

/** The mean hands-on hours of a visit to `task`. */
const mean = (m: EngineModel): number => runOnce(m, 1, false).steps.task!.avgHandsOn!;
const monthly = (m: EngineModel) => simulate(m, 1, 1, { monthly: true, personTime: true }).personTime!;
const sum = (p: { automatable: number; augmentable: number; manual: number }) => p.automatable + p.augmentable + p.manual;

describe("item 1: the tier multiplier and the client's factor on every draw", () => {
  it("a model with none of the new fields takes the step's time exactly", () => {
    expect(mean(model({ work: 0.7 }))).toBeCloseTo(0.7, 12);
  });

  it("a multiplier of 1.5 on Tier 1 makes a Tier 1 client's task take 1.5 times as long, and leaves a Tier 2 client alone", () => {
    const mult = { T1: 1.5 };
    expect(mean(model({ mult }))).toBeCloseTo(1.5, 12);
    expect(mean(model({ mult, tiers: { sa: "T2" } }))).toBe(1);
    // A service with no tier takes no multiplier.
    expect(mean(model({ mult, tiers: { sa: undefined } }))).toBe(1);
    // ...and in one model with both, each client's task takes its own tier's time.
    const both = model({
      mult,
      tiers: { sa: "T1", sb: "T2" },
      clients: { c1: { name: "C1", services: ["sa"], mrr: 1, assignments: { r: "ann" } }, c2: { name: "C2", services: ["sb"], mrr: 1, assignments: { r: "bob" } } },
    });
    const sh = simulate(both, 1, 1, { personTime: true }).personTime!.stepHours;
    expect(sh.ann!.task! / sh.bob!.task!).toBeCloseTo(1.5, 9);
  });

  it("the client's own factor multiplies once, with the tier multiplier and the split", () => {
    const clients = { c1: { name: "C1", services: ["sa"], mrr: 1, assignments: {}, overrides: { stepFactor: 2 } } };
    expect(mean(model({ clients, mult: { T1: 1.5 } }))).toBeCloseTo(3, 12);
    expect(mean(model({ clients }))).toBe(2);
    // Per step id: a step not listed is 1.
    const byId = { c1: { name: "C1", services: ["sa"], mrr: 1, assignments: {}, overrides: { stepFactor: { task: 4 } } } };
    expect(mean(model({ clients: byId, mult: { T1: 1.5 } }))).toBeCloseTo(6, 12);
    // A split with no change in force does not move the time.
    expect(mean(model({ clients, split: { automatable: 0.7, augmentable: 0.2, manual: 0.1 } }))).toBe(2);
  });

  it("a client's own ad-hoc hours replace the base time before the split: the residual is not scaled", () => {
    const clients = { c1: { name: "C1", services: ["sa"], mrr: 1, assignments: {}, overrides: { adhocHours: 2 } } };
    const split = { automatable: 1, augmentable: 0, manual: 0 };
    const change = automation("auto", {}, 0.5, 0.1);
    // 2 h base, half of it removed, 0.1 h of checking added: 1.1 h (scaling the result instead would give 1.2).
    expect(mean(model({ adhoc: true, clients, split, changes: [change], work: 1 }))).toBeCloseTo(1.1, 12);
    expect(mean(model({ adhoc: true, clients, work: 1 }))).toBe(2);
  });

  it("work with no client uses no tier: a pipeline step's multiplier is ignored", () => {
    const m = model({ extra: { leadsPerWeek: 2 } });
    m.steps[0] = { ...m.steps[0]!, tierMultiplier: { T1: 5 }, split: { automatable: 0, augmentable: 0, manual: 1 } };
    expect(runOnce(m, 1, false).steps.a!.avgHandsOn).toBe(1);
  });
});

describe("item 2: changes over time", () => {
  const SPLIT = { automatable: 0.7, augmentable: 0.2, manual: 0.1 };

  it("section 7's example: 55 minutes split 70/20/10, 90% removed with 3 minutes left, takes 23.35 minutes at full adoption and 29.68 at 80%", () => {
    const run = (adoption: number, work = 55 * MIN) =>
      mean(model({ work, split: SPLIT, changes: [automation("auto", { adoption }, 0.9, 3 * MIN)] })) / MIN;
    expect(run(1)).toBeCloseTo(23.35, 9);
    expect(run(0.8)).toBeCloseTo(29.68, 9);
    // No change in force: the 55 minutes.
    expect(mean(model({ work: 55 * MIN, split: SPLIT }))).toBeCloseTo(55 * MIN, 12);
    // A 70-minute baseline: 49 / 14 / 7 -> 4.9 + 3 + 14 + 7 = 28.9, so the saving moves from 31.65 to 41.1 minutes.
    expect(run(1, 70 * MIN)).toBeCloseTo(28.9, 9);
    expect(55 - run(1)).toBeCloseTo(31.65, 9);
    expect(70 - run(1, 70 * MIN)).toBeCloseTo(41.1, 9);
  });

  it("an augmentation speeds the augmentable part", () => {
    const aug: EngineStepChange = { id: "ai", name: "ai", kind: "augmentation", effects: [{ step: "task", part: "augmentable", factor: 2 }], adoption: 0.5, startMonth: 1, rampMonths: 0 };
    // 20% augmentable at adoption 0.5: 0.2 / (1 + 0.5) = 0.1333; total 0.7 + 0.1333 + 0.1 = 0.9333.
    expect(mean(model({ split: SPLIT, changes: [aug] }))).toBeCloseTo(0.7 + 0.2 / 1.5 + 0.1, 12);
  });

  it("a change starting in month 3 with a 2-month ramp acts at 0, 1/3, 2/3 and 1 in months 2 to 5", () => {
    const m = model({ split: { automatable: 1, augmentable: 0, manual: 0 }, changes: [automation("auto", { startMonth: 3, rampMonths: 2 }, 0.9)] });
    const t = monthly(m).monthly!;
    const ratio = (i: number) => sum(t.actual[i]!) / sum(t.before[i]!);
    // Month index 0 is month 1.
    expect(ratio(0)).toBe(1);
    expect(ratio(1)).toBe(1);
    expect(ratio(2)).toBeCloseTo(1 - 0.9 / 3, 12);
    expect(ratio(3)).toBeCloseTo(1 - (0.9 * 2) / 3, 12);
    expect(ratio(4)).toBeCloseTo(1 - 0.9, 12);
    expect(ratio(5)).toBeCloseTo(1 - 0.9, 12);
    // The run's second to fifth months, as the brief says: 0 / 1/3 / 2/3 / 1 of the effect.
    expect([1, 2, 3, 4].map((i) => (1 - ratio(i)) / 0.9)).toEqual([0, 1 / 3, 2 / 3, 1].map((v) => expect.closeTo(v, 12)));
  });

  it("a change with no ramp acts in full from its start month", () => {
    const m = model({ split: { automatable: 1, augmentable: 0, manual: 0 }, changes: [automation("auto", { startMonth: 2 }, 0.5)] });
    const t = monthly(m).monthly!;
    expect(sum(t.actual[0]!) / sum(t.before[0]!)).toBe(1);
    expect(sum(t.actual[1]!) / sum(t.before[1]!)).toBeCloseTo(0.5, 12);
  });

  it("a change limited to a tier leaves other tiers' clients alone", () => {
    const split = { automatable: 1, augmentable: 0, manual: 0 };
    const c = [automation("auto", { tiers: ["T1"] }, 0.5)];
    expect(mean(model({ split, changes: c }))).toBeCloseTo(0.5, 12);
    expect(mean(model({ split, changes: c, tiers: { sa: "T2" } }))).toBe(1);
    expect(mean(model({ split, changes: c, tiers: { sa: undefined } }))).toBe(1);
    // Without the filter it acts on every client.
    expect(mean(model({ split, changes: [automation("auto", {}, 0.5)], tiers: { sa: "T2" } }))).toBeCloseTo(0.5, 12);
  });

  it("the tier multiplier is part of the base the split and the changes act on", () => {
    const split = { automatable: 1, augmentable: 0, manual: 0 };
    expect(mean(model({ split, mult: { T1: 2 }, changes: [automation("auto", {}, 0.5, 0.1)] }))).toBeCloseTo(2 * 0.5 + 0.1, 12);
  });

  it("a change reads the month the work starts in: months follow the model's channels when it has them", () => {
    // Team time makes the run use channel months; changes use the same ones.
    const m = model({ split: { automatable: 1, augmentable: 0, manual: 0 }, changes: [automation("auto", { startMonth: 3 }, 0.5)] });
    m.people!.ann!.reservedShare = 0.1;
    const t = monthly(m).monthly!;
    expect(sum(t.actual[1]!) / sum(t.before[1]!)).toBe(1);
    expect(sum(t.actual[2]!) / sum(t.before[2]!)).toBeCloseTo(0.5, 12);
  });
});

describe("item 3: what the changes free", () => {
  const split = { automatable: 0.6, augmentable: 0.3, manual: 0.1 };
  const c1 = automation("c1", {}, 0.5, 0.1);
  const c2 = automation("c2", {}, 0.5);
  const clients = {
    c1: { name: "C1", services: ["sa"], mrr: 1, assignments: { r: "ann" } },
    c2: { name: "C2", services: ["sa"], mrr: 1, assignments: { r: "bob" } },
    c3: { name: "C3", services: ["sa"], mrr: 1, assignments: { r: "bob" } },
  };

  it("hours freed are the difference between the same draws before and after the changes", () => {
    const m = model({ split: { automatable: 1, augmentable: 0, manual: 0 }, changes: [automation("auto", {}, 0.5)], clients });
    const pt = simulate(m, 3, 1, { personTime: true }).personTime!;
    const act = pt.partHours!.actual;
    const bef = pt.partHours!.before;
    for (const pid of Object.keys(bef)) {
      const freed = sum(bef[pid]!.task!) - sum(act[pid]!.task!);
      expect(pt.freed!.byPerson[pid]!.auto).toBeCloseTo(freed, 9);
      // The actual hours are the step hours that were worked.
      expect(sum(act[pid]!.task!)).toBeCloseTo(pt.stepHours[pid]!.task!, 9);
    }
    expect(pt.freed!.total).toBeCloseTo(pt.freed!.byChange.auto!, 12);
    // Half of an all-automatable step's time is freed.
    expect(pt.freed!.total).toBeCloseTo(sum(bef.ann!.task!) / 2 + sum(bef.bob!.task!) / 2, 9);
  });

  it("hours freed per person add up to the total freed, and to the sum of the changes", () => {
    const m = model({ split, changes: [c1, c2], clients });
    const pt = simulate(m, 3, 1, { personTime: true }).personTime!;
    const perPerson = Object.values(pt.freed!.byPerson).map((row) => Object.values(row).reduce((s, v) => s + v, 0));
    expect(perPerson).toHaveLength(2);
    expect(perPerson.reduce((s, v) => s + v, 0)).toBeCloseTo(pt.freed!.total, 9);
    expect(Object.values(pt.freed!.byChange).reduce((s, v) => s + v, 0)).toBeCloseTo(pt.freed!.total, 9);
    // And the total is the parts' difference.
    let diff = 0;
    for (const pid of Object.keys(pt.partHours!.before)) diff += sum(pt.partHours!.before[pid]!.task!) - sum(pt.partHours!.actual[pid]!.task!);
    expect(pt.freed!.total).toBeCloseTo(diff, 9);
    // Bob has two of the three clients: twice Ann's hours.
    const tot = (pid: string) => Object.values(pt.freed!.byPerson[pid]!).reduce((s, v) => s + v, 0);
    expect(tot("bob") / tot("ann")).toBeCloseTo(2, 1);
  });

  it("the ordering rule: changes act in the order of the list, so the earlier one is credited first", () => {
    // 1 h automatable. c1 (half, plus 0.1 h of checking) first: 1 -> 0.6, saving 0.4; then c2 (half): 0.6 -> 0.3, saving 0.3.
    const only = { automatable: 1, augmentable: 0, manual: 0 };
    const ratio = (list: EngineStepChange[]) => {
      const pt = simulate(model({ split: only, changes: list }), 1, 1, { personTime: true }).personTime!;
      const before = sum(pt.partHours!.before.ann!.task!) + sum(pt.partHours!.before.bob?.task ?? { automatable: 0, augmentable: 0, manual: 0 });
      return Object.fromEntries(Object.entries(pt.freed!.byChange).map(([id, v]) => [id, v / before]));
    };
    const fwd = ratio([c1, c2]);
    expect(fwd.c1).toBeCloseTo(0.4, 9);
    expect(fwd.c2).toBeCloseTo(0.3, 9);
    // The other way round: c2 saves 0.5, then c1 takes 0.5 -> 0.35 (0.15). The total differs (0.65): c1's 0.1 h of checking is not halved by c2 now.
    const rev = ratio([c2, c1]);
    expect(rev.c2).toBeCloseTo(0.5, 9);
    expect(rev.c1).toBeCloseTo(0.15, 9);
    expect(fwd.c1! + fwd.c2!).toBeCloseTo(0.7, 9);
    expect(rev.c1! + rev.c2!).toBeCloseTo(0.65, 9);
    // The same split by the pure function.
    const d = stepPartsDetail({ id: "task", work: 1, split: only }, undefined, [c1, c2], 0);
    expect(d.freed.map((f) => [f.change, f.hours])).toEqual([["c1", expect.closeTo(0.4, 12)], ["c2", expect.closeTo(0.3, 12)]]);
  });

  it("the monthly series carries the parts and each change's hours freed, and the months add up to the run", () => {
    const m = model({ split, changes: [automation("c", { startMonth: 3 }, 0.5)], clients });
    const pt = simulate(m, 1, 1, { monthly: true, personTime: true }).personTime!;
    const t = pt.monthly!;
    expect(t.actual).toHaveLength(6);
    expect(t.freed.c!.slice(0, 2)).toEqual([0, 0]);
    expect(t.freed.c![2]).toBeGreaterThan(0);
    const monthsInRun = 26 / (52 / 12);
    // The per-month average is the monthly series' total over the months of the run.
    expect(t.freed.c!.reduce((s, v) => s + v, 0) / monthsInRun).toBeCloseTo(pt.freed!.byChange.c!, 6);
    for (let i = 0; i < 6; i++) expect(sum(t.before[i]!) - sum(t.actual[i]!)).toBeCloseTo(t.freed.c![i]!, 9);
  });

  it("a model whose steps have no split reports no parts and nothing freed", () => {
    const m = model({ mult: { T1: 1.5 }, changes: [automation("c")] });
    const pt = simulate(m, 1, 1, { personTime: true }).personTime!;
    // No step has a split: the part outputs are absent.
    expect(pt.partHours).toBeUndefined();
    expect(pt.freed).toBeUndefined();
  });

  it("replications are averaged", () => {
    const m = model({ split, changes: [c1], clients });
    const one = simulate(m, 1, 1, { personTime: true }).personTime!;
    const four = simulate(m, 4, 1, { personTime: true }).personTime!;
    expect(four.freed!.total).toBeCloseTo(one.freed!.total, 0);
    expect(Object.keys(four.partHours!.actual).sort()).toEqual(["ann", "bob"]);
  });
});

describe("item 5: bad inputs", () => {
  const split = { automatable: 1, augmentable: 0, manual: 0 };

  it("a model with a bad split still runs, and treats the step as all manual", () => {
    const bad = model({ split: { automatable: 0.5, augmentable: 0.5, manual: 0.5 }, changes: [automation("c")], work: 0.8 });
    expect(capacityProblems(bad).map((p) => p.code)).toContain("split_not_one");
    expect(mean(bad)).toBeCloseTo(0.8, 12);
    const pt = simulate(bad, 2, 1, { personTime: true }).personTime!;
    expect(pt.partHours).toBeUndefined();
    // Any non-number or out-of-range share does the same.
    for (const s of [{ automatable: -0.5, augmentable: 1, manual: 0.5 }, { automatable: Number.NaN, augmentable: 0, manual: 1 }, { automatable: 2, augmentable: -1, manual: 0 }]) {
      expect(mean(model({ split: s, changes: [automation("c")], work: 0.8 }))).toBeCloseTo(0.8, 12);
    }
    // A tier multiplier still applies to a step whose split is bad.
    expect(mean(model({ split: { automatable: 1, augmentable: 1, manual: 1 }, mult: { T1: 2 }, work: 0.8 }))).toBeCloseTo(1.6, 12);
  });

  it("every problem the check names on a change runs as the repaired change would", () => {
    const fine = automation("c", {}, 1, 0);
    const cases: [string, EngineStepChange, EngineStepChange][] = [
      ["adoption above 1", automation("c", { adoption: 1.7 }, 1, 0), fine],
      ["adoption below 0", automation("c", { adoption: -1 }, 1, 0), automation("c", { adoption: 0 }, 1, 0)],
      ["adoption not a number", automation("c", { adoption: Number.NaN }, 1, 0), automation("c", { adoption: 0 }, 1, 0)],
      ["start month 0", automation("c", { startMonth: 0 }, 1, 0), fine],
      ["start month not a number", automation("c", { startMonth: Number.NaN }, 1, 0), automation("c", { startMonth: 999 }, 1, 0)],
      ["ramp below 0", automation("c", { rampMonths: -2 }, 1, 0), fine],
      ["ramp not a number", automation("c", { rampMonths: Number.NaN }, 1, 0), fine],
      ["remove above 1", automation("c", {}, 3, 0), fine],
      ["remove below 0", automation("c", {}, -1, 0), automation("c", {}, 0, 0)],
      ["residual below 0", automation("c", {}, 1, -2), fine],
      [
        "factor below 1",
        { id: "c", name: "c", kind: "augmentation", effects: [{ step: "task", part: "augmentable", factor: 0.5 }], adoption: 1, startMonth: 1, rampMonths: 0 },
        { id: "c", name: "c", kind: "augmentation", effects: [{ step: "task", part: "augmentable", factor: 1 }], adoption: 1, startMonth: 1, rampMonths: 0 },
      ],
      [
        "factor not a number",
        { id: "c", name: "c", kind: "augmentation", effects: [{ step: "task", part: "augmentable", factor: Number.NaN }], adoption: 1, startMonth: 1, rampMonths: 0 },
        { id: "c", name: "c", kind: "augmentation", effects: [{ step: "task", part: "augmentable", factor: 1 }], adoption: 1, startMonth: 1, rampMonths: 0 },
      ],
    ];
    for (const [name, broken, repaired] of cases) {
      const both = { split: { automatable: 0.6, augmentable: 0.3, manual: 0.1 }, weeks: 26 };
      const a = simulate(model({ ...both, changes: [broken] }), 2, 1, { monthly: true, personTime: true });
      const b = simulate(model({ ...both, changes: [repaired] }), 2, 1, { monthly: true, personTime: true });
      expect(capacityProblems(model({ ...both, changes: [broken] })).length, name).toBeGreaterThan(0);
      expect(a.personTime, name).toEqual(b.personTime);
      expect(Number.isFinite(a.personTime!.freed!.total), name).toBe(true);
    }
    expect(split).toBeDefined();
  });

  it("an effect on a step the model doesn't have acts on nothing", () => {
    const stray: EngineStepChange = { ...automation("c"), effects: [{ step: "nope", part: "automatable", remove: 1 }] };
    expect(capacityProblems(model({ split, changes: [stray] })).map((p) => p.code)).toContain("change_unknown_step");
    expect(mean(model({ split, changes: [stray] }))).toBe(1);
  });

  it("a negative tier multiplier counts as 0 and one that isn't a number as 1", () => {
    expect(mean(model({ mult: { T1: Number.NaN } }))).toBe(1);
    expect(mean(model({ mult: { T1: -2 } }))).toBe(0);
  });
});

describe("item 6: the capacity model", () => {
  it("changes free time in the capacity model, and the figures add up", () => {
    const r = simulate(capacityModel(), 2, 1, { monthly: true, personTime: true });
    const pt = r.personTime!;
    expect(pt.freed!.total).toBeGreaterThan(0);
    expect(Object.keys(pt.freed!.byChange)).toHaveLength(capacityModel().changes!.length);
    const perPerson = Object.values(pt.freed!.byPerson).reduce((s, row) => s + Object.values(row).reduce((a, v) => a + v, 0), 0);
    expect(perPerson).toBeCloseTo(pt.freed!.total, 6);
    let diff = 0;
    for (const [pid, steps] of Object.entries(pt.partHours!.before)) for (const [sid, p] of Object.entries(steps)) diff += sum(p) - sum(pt.partHours!.actual[pid]![sid]!);
    expect(diff).toBeCloseTo(pt.freed!.total, 6);
  });
});

describe("least-busy placement counts the full step time (P2b)", () => {
  /**
   * Ann looks after a Tier 1 client and Bob a Tier 2 client with the same deliverables; the won clients are Tier 3. Which of them is
   * busier depends only on the step's tier multiplier or change, so placement must see it.
   */
  const placing = (o: Pick<Opts, "mult" | "changes" | "split">): EngineModel => {
    const base = model({
      ...o,
      weeks: 40,
      tiers: { sa: "T1", sb: "T2", sw: "T3" },
      clients: {
        c1: { name: "C1", services: ["sa"], mrr: 4330, assignments: { r: "ann" } },
        c2: { name: "C2", services: ["sb"], mrr: 4330, assignments: { r: "bob" } },
      },
      extra: { leadsPerWeek: 1.5, placeNewClients: "least-busy" },
    });
    // Won clients are light (one task a month), so one existing client's difference is several of them.
    return { ...base, services: { ...base.services!, sa: { ...base.services!.sa!, mixShare: 0 }, sb: { ...base.services!.sb!, mixShare: 0 }, sw: { ...base.services!.sw!, deliverables: { meetings: 1 } } } };
  };
  /** Won clients by the first person who worked on each. */
  const placedCounts = (m: EngineModel): Record<string, number> => {
    const seen = new Set<string>();
    const out: Record<string, number> = {};
    for (const e of runOnce(m, 3, true).entities ?? []) {
      const c = e.servicing?.client;
      const person = e.trace.find((seg) => seg.person)?.person;
      if (!c || !c.startsWith("won:") || !person || seen.has(c)) continue;
      seen.add(c);
      out[person] = (out[person] ?? 0) + 1;
    }
    return out;
  };

  it("with no multiplier and no change two alike people share the won clients about evenly", () => {
    const c = placedCounts(placing({}));
    expect(Math.abs((c.ann ?? 0) - (c.bob ?? 0))).toBeLessThanOrEqual(1);
  });

  it("a Tier 1 multiplier makes Ann the busier, so Bob is given more of the won clients", () => {
    const c = placedCounts(placing({ mult: { T1: 3 } }));
    expect(c.bob!).toBeGreaterThan(c.ann ?? 0);
  });

  it("a change that cuts Tier 1 work makes Ann the less busy, so Ann is given more of the won clients", () => {
    const m = placing({ split: { automatable: 1, augmentable: 0, manual: 0 }, changes: [automation("a", { tiers: ["T1"] }, 0.9)] });
    const c = placedCounts(m);
    expect(c.ann!).toBeGreaterThan(c.bob ?? 0);
  });
});
