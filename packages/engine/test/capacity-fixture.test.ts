import { describe, expect, it } from "vitest";
import { capacityModel, checkCapacityInputs, effectiveDeliverables, stepParts, tasksPerMonth } from "../src";

// The prototype's example agency as an engine model (fixtures/capacity.ts; the `capacity` golden). These tests check it is a
// clean input and still says what the prototype says.

describe("capacityModel", () => {
  const m = capacityModel();

  it("has no capacity-input problems", () => {
    expect(checkCapacityInputs(m)).toEqual([]);
  });

  it("is six services: three tiers in each of two departments", () => {
    expect(Object.keys(m.services!).sort()).toEqual(["org-T1", "org-T2", "org-T3", "perf-T1", "perf-T2", "perf-T3"]);
    expect(m.services!["org-T1"]).toMatchObject({ department: "org", tier: "T1", price: 11000, deliverables: { words: 4000, links: 8, techHours: 10, meetings: 4 }, adhoc: { chance: 0.9, requests: 6.5 } });
    expect(m.services!["perf-T2"]).toMatchObject({ department: "perf", tier: "T2", deliverables: { channels: 1.5, builds: 3, creativeSets: 1, meetings: 1 } });
  });

  it("counts the prototype's clients: portfolios add up to the counted groups, beside 13 named", () => {
    expect(m.clientMix).toBe("groups-add");
    expect(Object.keys(m.clients!)).toHaveLength(13);
    expect(Object.fromEntries(Object.entries(m.clientGroups!).map(([k, g]) => [k, g.count]))).toEqual({ "org-T2": 27, "org-T3": 50, "perf-T2": 31, "perf-T3": 37 });
    expect(m.people!.laura!.portfolio).toEqual({ "org-T2": 2, "org-T3": 7 });
    expect(m.people!.laura!.reservedShare).toBe(0.35);
  });

  it("puts every servicing step in exactly one process, and every change on a step that exists", () => {
    const inProcess = Object.values(m.servicingProcesses!).flatMap((p) => p.steps);
    expect(new Set(inProcess).size).toBe(inProcess.length);
    const servicingSteps = m.steps.filter((s) => /^[op]\d+$/.test(s.id)).map((s) => s.id);
    expect(servicingSteps.sort()).toEqual([...inProcess].sort());
    expect(servicingSteps).toHaveLength(28); // o1-o15 and p1-p13 (the prototype's p1-p13 without onboarding)
    const ids = new Set(m.steps.map((s) => s.id));
    for (const c of m.changes!) for (const e of c.effects) expect(ids.has(e.step), `${c.id} -> ${e.step}`).toBe(true);
  });

  it("every split sums to 1 and 'who: owner' steps go to the client's manager", () => {
    for (const s of m.steps.filter((x) => x.split)) {
      const { automatable: a, augmentable: g, manual: n } = s.split!;
      expect(a + g + n).toBeCloseTo(1, 12);
    }
    expect(m.steps.find((s) => s.id === "o12")).toMatchObject({ role: "mgr_org", toClientManager: true });
    expect(m.steps.find((s) => s.id === "o4")).toMatchObject({ role: "content" });
    expect(m.steps.find((s) => s.id === "o8")).toMatchObject({ person: "karl" });
  });

  it("gives the numbers the prototype's calculator gives for one Organic Tier 1 client", () => {
    // o12 Monthly report: 60 min × 1.5 for Tier 1 = 1.5 h, once a month.
    const o12 = m.steps.find((s) => s.id === "o12")!;
    expect(stepParts(o12, "T1", [], 0).total).toBeCloseTo(1.5, 12);
    // With the "report page" change (removes 70% of the automatable half, 90% adoption): 0.75 × (1 − 0.63) + 0.45 + 0.3 = 1.0275.
    expect(stepParts(o12, "T1", m.changes, 0).total).toBeCloseTo(1.0275, 12);
    // o4 Writing: 4 h per 1,000 words, 4,000 words a month = 4 tasks = 16 h.
    const e = effectiveDeliverables(m, undefined, "org-T1");
    const o4 = m.steps.find((s) => s.id === "o4")!;
    const content = m.services!["org-T1"]!.servicing!.find((l) => l.process === "org-content")!;
    expect(tasksPerMonth(content.recurrence, e.deliverables, e.adhoc) * o4.work).toBeCloseTo(16, 12);
    // o14 Ad hoc: 0.9 × 6.5 = 5.85 requests × 45 min.
    const adhoc = m.services!["org-T1"]!.servicing!.find((l) => l.process === "org-adhoc")!;
    const o14 = m.steps.find((s) => s.id === "o14")!;
    expect(tasksPerMonth(adhoc.recurrence, e.deliverables, e.adhoc) * o14.work).toBeCloseTo((5.85 * 45) / 60, 12);
  });
});
