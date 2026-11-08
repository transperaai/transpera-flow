import { describe, expect, it } from "vitest";
import {
  availableShare,
  changeRamp,
  effectiveDeliverables,
  rampShare,
  recurrenceLabel,
  stepParts,
  stepTimeFactor,
  tasksPerMonth,
  tasksPerWeek,
  type EngineClient,
  type EngineModel,
  type EngineStep,
  type EngineStepChange,
  type Recurrence,
} from "../src";

// The definitions behind the capacity inputs (docs/adr/0022-capacity-inputs.md). Every expected number is worked by hand
// from the prototype's example agency (docs/prototypes/client-capacity-app.PROTOTYPE.html: base(), PROCS, LIB) and
// requirements section 7; the prototype's minutes are hours / 60 here because the engine's unit is working hours.

const min = (m: number) => m / 60;
const WEEKS = 52 / 12;

const model: Pick<EngineModel, "services"> = {
  services: {
    orgT1: {
      name: "Organic Tier 1", pricingModel: "retainer", price: 11000, margin: 0, tenureMonths: 24, churnMonthly: 0.01, mixShare: 1, pathTags: [],
      department: "org", tier: "T1",
      deliverables: { words: 4000, links: 8, techHours: 10, meetings: 4 },
      adhoc: { chance: 0.9, requests: 6.5 },
    },
    orgT2: {
      name: "Organic Tier 2", pricingModel: "retainer", price: 4500, margin: 0, tenureMonths: 24, churnMonthly: 0.02, mixShare: 1, pathTags: [],
      department: "org", tier: "T2",
      deliverables: { words: 1500, links: 5, techHours: 5, meetings: 1 },
      adhoc: { chance: 0.7, requests: 4 },
    },
    perfT1: {
      name: "Performance Tier 1", pricingModel: "retainer", price: 8000, margin: 0, tenureMonths: 24, churnMonthly: 0.01, mixShare: 1, pathTags: [],
      department: "perf", tier: "T1",
      deliverables: { channels: 4, builds: 5, creativeSets: 2, meetings: 4 },
      adhoc: { chance: 0.95, requests: 8.5 },
    },
  },
};

describe("effectiveDeliverables", () => {
  it("is the tier's values for a client with no overrides, and 0 for what the tier doesn't set", () => {
    const e = effectiveDeliverables(model, undefined, "orgT1");
    expect(e.deliverables).toEqual({ words: 4000, links: 8, techHours: 10, meetings: 4, builds: 0, creativeSets: 0, channels: 0 });
    expect(e.adhoc).toEqual({ chance: 0.9, requests: 6.5 });
    expect(e.adhocHours).toBeUndefined();
  });

  it("lets a named client's override replace single values (Harbourline: ad hoc 1 × 8, Kestrel: an hour a request)", () => {
    const harbourline: Pick<EngineClient, "overrides"> = { overrides: { adhocChance: 1, adhocRequests: 8, meetings: 4 } };
    const h = effectiveDeliverables(model, harbourline, "orgT1");
    expect(h.adhoc).toEqual({ chance: 1, requests: 8 });
    expect(h.deliverables.words).toBe(4000); // not overridden: the tier's
    const kestrel: Pick<EngineClient, "overrides"> = { overrides: { adhocChance: 1, adhocRequests: 10, adhocHours: 1 } };
    const k = effectiveDeliverables(model, kestrel, "orgT1");
    expect(k.adhoc).toEqual({ chance: 1, requests: 10 });
    expect(k.adhocHours).toBe(1);
  });

  it("an override of 0 replaces the tier's value (it is not 'unset')", () => {
    const e = effectiveDeliverables(model, { overrides: { links: 0 } }, "orgT1");
    expect(e.deliverables.links).toBe(0);
  });

  it("gives Northwind Retail 6 channels where its tier has 4, and all 0 for a service the model lacks", () => {
    expect(effectiveDeliverables(model, { overrides: { channels: 6 } }, "perfT1").deliverables.channels).toBe(6);
    const none = effectiveDeliverables(model, undefined, "nope");
    expect(Object.values(none.deliverables).every((v) => v === 0)).toBe(true);
    expect(none.adhoc).toEqual({ chance: 0, requests: 0 });
  });

  it("treats a negative or non-finite value as 0", () => {
    const e = effectiveDeliverables(model, { overrides: { words: -5, links: Number.NaN } }, "orgT1");
    expect(e.deliverables.words).toBe(0);
    expect(e.deliverables.links).toBe(0);
  });
});

describe("tasksPerMonth", () => {
  const t1 = effectiveDeliverables(model, undefined, "orgT1");
  const perf = effectiveDeliverables(model, undefined, "perfT1");
  const tasks = (r: Recurrence, e = t1) => tasksPerMonth(r, e.deliverables, e.adhoc);

  it("old recurrences: monthly, weekly (52/12 weeks a month), fortnightly, Poisson", () => {
    expect(tasks({ every: "month", times: 1 })).toBe(1);
    expect(tasks({ every: "month", times: 1 / 3 })).toBeCloseTo(0.3333333, 7); // the prototype's strategy review, Tier 1
    expect(tasks({ every: "week", times: 1 })).toBeCloseTo(WEEKS, 12); // 4.3333...
    expect(tasks({ every: "week", times: 0.5 })).toBeCloseTo(WEEKS / 2, 12);
    expect(tasks({ poissonPerMonth: 2.5 })).toBe(2.5);
  });

  it("agrees with tasksPerWeek to within the 4.33 vs 52/12 difference for the old variants", () => {
    for (const r of [{ every: "month", times: 2 }, { every: "week", times: 1 }, { poissonPerMonth: 3 }] as Recurrence[]) {
      expect(tasks(r) / (tasksPerWeek(r) * 4.33)).toBeCloseTo(1, 2);
    }
  });

  it("words: 4,000 words a month at 'per 1,000' is 4 tasks; Tier 2's 1,500 is 1.5", () => {
    const words: Recurrence = { perMonth: 1, driver: "words", per: 1000 };
    expect(tasks(words)).toBe(4);
    expect(tasks(words, effectiveDeliverables(model, undefined, "orgT2"))).toBe(1.5);
  });

  it("links, meetings and technical hours: the value times perMonth", () => {
    expect(tasks({ perMonth: 1, driver: "links" })).toBe(8);
    expect(tasks({ perMonth: 1, driver: "meetings" })).toBe(4);
    expect(tasks({ perMonth: 1, driver: "techHours" })).toBe(10);
    expect(tasks({ perMonth: 0.5, driver: "builds" }, perf)).toBe(2.5);
  });

  it("per channel: a Performance Tier 1 client on 4 channels has 4 pacing checks; a client on 6 has 6", () => {
    const pacing: Recurrence = { perMonth: 1, driver: "channels" };
    expect(tasks(pacing, perf)).toBe(4);
    const northwind = effectiveDeliverables(model, { overrides: { channels: 6 } }, "perfT1");
    expect(tasks(pacing, northwind)).toBe(6);
  });

  it("ad hoc is chance × requests: Tier 1 Organic 0.9 × 6.5 = 5.85; Harbourline 1 × 8 = 8", () => {
    const adhoc: Recurrence = { perMonth: 1, driver: "adhoc" };
    expect(tasks(adhoc)).toBeCloseTo(5.85, 12);
    const harbourline = effectiveDeliverables(model, { overrides: { adhocChance: 1, adhocRequests: 8 } }, "orgT1");
    expect(tasks(adhoc, harbourline)).toBe(8);
    expect(tasks(adhoc, perf)).toBeCloseTo(0.95 * 8.5, 12); // 8.075
  });

  it("a driver of 0 means no tasks", () => {
    expect(tasks({ perMonth: 1, driver: "creativeSets" })).toBe(0); // Organic has none
    expect(tasks({ perMonth: 1, driver: "adhoc" }, effectiveDeliverables(model, undefined, "nope"))).toBe(0);
  });

  it("a malformed recurrence gives 0, not NaN", () => {
    expect(tasks({ perMonth: 1, driver: "words", per: 0 })).toBe(0);
    expect(tasks({ perMonth: Number.NaN, driver: "words" })).toBe(0);
    expect(tasks({ every: "month", times: -1 })).toBe(0);
  });

  it("the old tasksPerWeek gives 0 for a driver recurrence, which needs deliverables, and the label says what it is", () => {
    expect(tasksPerWeek({ perMonth: 1, driver: "links" })).toBe(0);
    expect(recurrenceLabel({ perMonth: 1, driver: "words", per: 1000 })).toBe("1 a month per 1000 words");
    expect(recurrenceLabel({ perMonth: 2, driver: "links" })).toBe("2 a month per links");
  });
});

describe("rampShare and availableShare", () => {
  const monthHours = WEEKS * 38; // 164.667 hours in a 38-hour-week month
  const starter = { from: 2 * monthHours + 1, ramp: [0.4, 0.6, 0.8] };

  it("is 1 with no ramp", () => {
    expect(rampShare({}, 0)).toBe(1);
    expect(rampShare({ from: 500 }, 5, monthHours)).toBe(1);
    expect(rampShare({ ramp: [] }, 0)).toBe(1);
  });

  it("follows the prototype's 40%, 60%, 80%, then full, from the month they start", () => {
    expect(rampShare(starter, 2, monthHours)).toBe(0.4);
    expect(rampShare(starter, 3, monthHours)).toBe(0.6);
    expect(rampShare(starter, 4, monthHours)).toBe(0.8);
    expect(rampShare(starter, 5, monthHours)).toBe(1);
    expect(rampShare(starter, 11, monthHours)).toBe(1);
  });

  it("starts at month 0 with no 'from'", () => {
    expect(rampShare({ ramp: [0.5] }, 0)).toBe(0.5);
    expect(rampShare({ ramp: [0.5] }, 1)).toBe(1);
  });

  it("clamps entries to 0-1", () => {
    expect(rampShare({ ramp: [1.5, -1] }, 0)).toBe(1);
    expect(rampShare({ ramp: [1.5, -1] }, 1)).toBe(0);
  });

  it("available share is (1 - team time) × ramp: Laura's 35% team time leaves 65%", () => {
    expect(availableShare({ reservedShare: 0.35 }, 0)).toBeCloseTo(0.65, 12);
    expect(availableShare({}, 0)).toBe(1);
  });

  it("combines the two: 20% team time in the 60% month is 0.8 × 0.6 = 0.48", () => {
    expect(availableShare({ ...starter, reservedShare: 0.2 }, 3, monthHours)).toBeCloseTo(0.48, 12);
  });

  it("clamps team time to 0-1", () => {
    expect(availableShare({ reservedShare: 1.4 }, 0)).toBe(0);
    expect(availableShare({ reservedShare: -0.2 }, 0)).toBe(1);
  });
});

/** The prototype's pacing check: 25 minutes, split 70/20/10 (p1). */
const p1: EngineStep = { id: "p1", name: "Pacing checks", role: "pmm", work: min(25), wait: 0, rework: 0, split: { automatable: 0.7, augmentable: 0.2, manual: 0.1 }, next: [] };

/** Requirements section 7's pacing: 55 minutes, split 70/20/10. */
const pacing55: EngineStep = { ...p1, id: "pacing", work: min(55) };

const change = (over: Partial<EngineStepChange> & Pick<EngineStepChange, "effects">): EngineStepChange => ({
  id: "c", name: "A change", kind: "automation", adoption: 1, startMonth: 1, rampMonths: 0, ...over,
});

describe("stepParts", () => {
  it("splits the base time by the shares (prototype o1, Tier 1: 30 min × 1.5 = 45 → 22.5 / 13.5 / 9)", () => {
    const o1: EngineStep = { id: "o1", name: "Meeting prep", role: null, work: min(30), wait: 0, rework: 0, tierMultiplier: { T1: 1.5 }, split: { automatable: 0.5, augmentable: 0.3, manual: 0.2 }, next: [] };
    const p = stepParts(o1, "T1", [], 0);
    expect(p.base).toBeCloseTo(min(45), 12);
    expect(p.automatable).toBeCloseTo(min(22.5), 12);
    expect(p.augmentable).toBeCloseTo(min(13.5), 12);
    expect(p.manual).toBeCloseTo(min(9), 12);
    expect(p.total).toBeCloseTo(min(45), 12);
    // Tier 2 is not listed: multiplier 1.
    expect(stepParts(o1, "T2", [], 0).base).toBeCloseTo(min(30), 12);
    expect(stepParts(o1, undefined, [], 0).base).toBeCloseTo(min(30), 12);
  });

  it("a step with no split is all manual, and a change has no effect on it", () => {
    const plain: EngineStep = { id: "p7", name: "Client meeting", role: null, work: min(40), wait: 0, rework: 0, next: [] };
    const c = change({ effects: [{ step: "p7", part: "automatable", remove: 0.9 }] });
    const p = stepParts(plain, "T1", [c], 3);
    expect(p).toEqual({ automatable: 0, augmentable: 0, manual: min(40), total: min(40), base: min(40) });
  });

  it("section 7's worked example at full adoption: 38.5 → 3.85 + 3 min residual, so 55 min becomes 23.35 (about 23)", () => {
    // 55 = 38.5 + 11 + 5.5. The automatable part becomes 38.5 × (1 − 0.9) + 3 = 6.85 ("about 7"); the step is 6.85 + 11 + 5.5.
    const c = change({ effects: [{ step: "pacing", part: "automatable", remove: 0.9, residualHours: min(3) }], adoption: 1 });
    const before = stepParts(pacing55, undefined, [], 0);
    expect(before.automatable).toBeCloseTo(min(38.5), 12);
    expect(before.augmentable).toBeCloseTo(min(11), 12);
    expect(before.manual).toBeCloseTo(min(5.5), 12);
    const after = stepParts(pacing55, undefined, [c], 0);
    expect(after.automatable).toBeCloseTo(min(6.85), 12);
    expect(after.total).toBeCloseTo(min(23.35), 12);
    // The saving per client a month is about 32 min, so about 7.4 h for a 14-client manager ("about 7.5 h").
    const saving = before.total - after.total;
    expect(saving).toBeCloseTo(min(31.65), 12);
    expect(saving * 14).toBeCloseTo(7.385, 3);
  });

  it("the same change at 80% adoption, by the handover's formula a × (1 − remove × ad) + residual × ad: 29.68 min", () => {
    // a = 38.5 × (1 − 0.9 × 0.8) + 3 × 0.8 = 38.5 × 0.28 + 2.4 = 13.18; total 13.18 + 11 + 5.5.
    // Requirements section 7 says "with 80% adoption ... about 23 min": 23 is the full-adoption figure above; see the ADR.
    const c = change({ effects: [{ step: "pacing", part: "automatable", remove: 0.9, residualHours: min(3) }], adoption: 0.8 });
    const after = stepParts(pacing55, undefined, [c], 0);
    expect(after.automatable).toBeCloseTo(min(13.18), 12);
    expect(after.total).toBeCloseTo(min(29.68), 12);
  });

  it("if the baseline is corrected to 70 minutes the saving moves with it (full adoption: 41.1 min, not 31.65)", () => {
    const c = change({ effects: [{ step: "pacing", part: "automatable", remove: 0.9, residualHours: min(3) }] });
    const pacing70: EngineStep = { ...pacing55, work: min(70) };
    const before = stepParts(pacing70, undefined, [], 0);
    const after = stepParts(pacing70, undefined, [c], 0);
    // 70 = 49 + 14 + 7; the automatable part becomes 4.9 + 3 = 7.9; the step is 7.9 + 14 + 7 = 28.9.
    expect(after.total).toBeCloseTo(min(28.9), 12);
    expect(before.total - after.total).toBeCloseTo(min(41.1), 12);
    expect(before.total - after.total).toBeGreaterThan(min(31.65));
    // At 80% adoption: 49 × 0.28 + 2.4 = 16.12; 37.12 min after, a saving of 32.88 (it was 25.32 at 55).
    const at80 = change({ effects: [{ step: "pacing", part: "automatable", remove: 0.9, residualHours: min(3) }], adoption: 0.8 });
    expect(before.total - stepParts(pacing70, undefined, [at80], 0).total).toBeCloseTo(min(32.88), 12);
    expect(stepParts(pacing55, undefined, [], 0).total - stepParts(pacing55, undefined, [at80], 0).total).toBeCloseTo(min(25.32), 12);
  });

  it("the prototype's 'Unified pacing with alerts' on p1: both effects at 90% adoption", () => {
    // p1: 25 min = 17.5 / 5 / 2.5. Automation: 17.5 × (1 − 0.85 × 0.9) + 2 × 0.9 = 17.5 × 0.235 + 1.8 = 5.9125.
    // Augmentation: 5 ÷ (1 + 0.5 × 0.9) = 5 ÷ 1.45 = 3.448276. Manual 2.5. Total 11.860776.
    const c = change({
      adoption: 0.9,
      effects: [{ step: "p1", part: "automatable", remove: 0.85, residualHours: min(2) }, { step: "p1", part: "augmentable", factor: 1.5 }],
    });
    const p = stepParts(p1, "T2", [c], 0);
    expect(p.automatable).toBeCloseTo(min(5.9125), 12);
    expect(p.augmentable).toBeCloseTo(min(5 / 1.45), 12);
    expect(p.manual).toBeCloseTo(min(2.5), 12);
    expect(p.total).toBeCloseTo(min(11.860776), 6);
  });

  it("only acts on its own step", () => {
    const c = change({ effects: [{ step: "other", part: "automatable", remove: 1 }] });
    expect(stepParts(p1, undefined, [c], 0).total).toBeCloseTo(min(25), 12);
  });

  it("a change before its start month does nothing; it starts at once with no ramp", () => {
    const c = change({ startMonth: 3, effects: [{ step: "p1", part: "automatable", remove: 1 }] });
    expect(stepParts(p1, undefined, [c], 0).total).toBeCloseTo(min(25), 12); // month 1
    expect(stepParts(p1, undefined, [c], 1).total).toBeCloseTo(min(25), 12); // month 2
    expect(stepParts(p1, undefined, [c], 2).total).toBeCloseTo(min(7.5), 12); // month 3: automatable gone
  });

  it("ramps adoption as min(1, (m − start + 1) ÷ (ramp + 1)): start month 2, one month of ramp → 0, 50%, 100%", () => {
    const c = change({ startMonth: 2, rampMonths: 1, effects: [{ step: "p1", part: "automatable", remove: 1 }] });
    expect([0, 1, 2, 3].map((m) => changeRamp(c, m))).toEqual([0, 0.5, 1, 1]);
    expect(stepParts(p1, undefined, [c], 0).total).toBeCloseTo(min(25), 12);
    expect(stepParts(p1, undefined, [c], 1).total).toBeCloseTo(min(25 - 17.5 * 0.5), 12); // 16.25
    expect(stepParts(p1, undefined, [c], 2).total).toBeCloseTo(min(7.5), 12);
  });

  it("with two months of ramp the shares are 1/3, 2/3, 1", () => {
    const c = change({ rampMonths: 2, effects: [] });
    expect([0, 1, 2, 3].map((m) => changeRamp(c, m))).toEqual([1 / 3, 2 / 3, 1, 1]);
  });

  it("a tier filter limits a change to those tiers (review slides for small clients: T3 only)", () => {
    const c = change({ tiers: ["T3"], effects: [{ step: "p1", part: "automatable", remove: 1 }] });
    expect(stepParts(p1, "T1", [c], 0).total).toBeCloseTo(min(25), 12);
    expect(stepParts(p1, undefined, [c], 0).total).toBeCloseTo(min(25), 12);
    expect(stepParts(p1, "T3", [c], 0).total).toBeCloseTo(min(7.5), 12);
  });

  it("changes stack in order: two 50% removals leave 25% of the automatable part", () => {
    const half = (id: string) => change({ id, effects: [{ step: "p1", part: "automatable", remove: 0.5 }] });
    expect(stepParts(p1, undefined, [half("a"), half("b")], 0).automatable).toBeCloseTo(min(17.5 * 0.25), 12);
  });

  it("adoption 0 changes nothing", () => {
    const c = change({ adoption: 0, effects: [{ step: "p1", part: "automatable", remove: 1, residualHours: 1 }] });
    expect(stepParts(p1, undefined, [c], 0).total).toBeCloseTo(min(25), 12);
  });

  it("an effect on an empty part does nothing, so a residual is not added to nothing (as the prototype)", () => {
    const noAuto: EngineStep = { ...p1, split: { automatable: 0, augmentable: 0.3, manual: 0.7 } };
    const c = change({ effects: [{ step: "p1", part: "automatable", remove: 1, residualHours: 1 }] });
    expect(stepParts(noAuto, undefined, [c], 0).total).toBeCloseTo(min(25), 12);
  });
});

describe("stepTimeFactor", () => {
  const plain: EngineStep = { id: "s", name: "S", role: "r", work: 2.5, wait: 0, rework: 0, next: [] };

  it("is exactly 1 when no new field is set", () => {
    expect(stepTimeFactor(plain, undefined, undefined, 0)).toBe(1);
    expect(stepTimeFactor(plain, "T1", [], 7)).toBe(1);
    expect(stepTimeFactor({ ...plain, work: 0.1 }, undefined, undefined, 3)).toBe(1);
  });

  it("is exactly 1 for a step with a split and no change", () => {
    expect(stepTimeFactor(p1, "T1", [], 0)).toBeCloseTo(1, 12);
  });

  it("is the tier multiplier alone with no split", () => {
    expect(stepTimeFactor({ ...plain, tierMultiplier: { T1: 1.5, T3: 0.7 } }, "T1", [], 0)).toBe(1.5);
    expect(stepTimeFactor({ ...plain, tierMultiplier: { T1: 1.5, T3: 0.7 } }, "T2", [], 0)).toBe(1);
  });

  it("is total ÷ work: 29.68 ÷ 55 for the section 7 change at 80%", () => {
    const c = change({ adoption: 0.8, effects: [{ step: "pacing", part: "automatable", remove: 0.9, residualHours: min(3) }] });
    expect(stepTimeFactor(pacing55, undefined, [c], 0)).toBeCloseTo(29.68 / 55, 12);
  });

  it("multiplies in the client's own factor: a number for every step, or per step id", () => {
    expect(stepTimeFactor(plain, undefined, undefined, 0, 1.5)).toBe(1.5);
    expect(stepTimeFactor(plain, undefined, undefined, 0, { s: 2, other: 9 })).toBe(2);
    expect(stepTimeFactor(plain, undefined, undefined, 0, { other: 9 })).toBe(1);
    expect(stepTimeFactor({ ...plain, tierMultiplier: { T1: 1.5 } }, "T1", [], 0, 2)).toBe(3);
  });

  it("a step with no work has nothing to scale: only the client's factor", () => {
    expect(stepTimeFactor({ ...plain, work: 0 }, "T1", [], 0)).toBe(1);
    expect(stepTimeFactor({ ...plain, work: 0 }, "T1", [], 0, 2)).toBe(2);
  });
});
