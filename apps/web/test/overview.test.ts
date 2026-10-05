import { describe, expect, it } from "vitest";
import { defaultCompanyPart, partOf, toEngineModel } from "@transpera-flow/db";
import { simulate, type DetectedIssue } from "@transpera-flow/engine";
import { demoLandingRedirect } from "@/lib/demo/landing";
import { litIds } from "@/lib/map/highlight";
import { companyMap } from "@/lib/overview/company-map";
import { labelIndexes, monthLabel, niceTicks } from "@/lib/overview/axis";
import { sortFindings, ratingCounts } from "@/lib/overview/findings";
import { checkpointMonths, checkpointWeeks, mrrAfter, mrrSeries, percentile, startingMrr, summarise } from "@/lib/overview/projection";
import { demoBundle } from "@/lib/sources/demo";

const finding = (key: string, rating: DetectedIssue["rating"], cost?: number) =>
  ({ key, rating, cost: { perMonth: cost ?? null, hoursPerMonth: null, method: "" } }) as unknown as DetectedIssue;

describe("findings", () => {
  it("sorts worst rating first, then dearest, then as found", () => {
    const sorted = sortFindings([finding("a", "bad", 10), finding("b", "risk"), finding("c", "bad", 500), finding("d", "risk", 5), finding("e", "bad")]);
    expect(sorted.map((f) => f.key)).toEqual(["d", "b", "c", "a", "e"]);
  });
  it("counts per rating", () => {
    const counts = ratingCounts([finding("a", "bad"), finding("b", "bad"), finding("c", "risk")]);
    expect(counts.find((c) => c.rating === "bad")?.count).toBe(2);
    expect(counts.find((c) => c.rating === "risk")?.count).toBe(1);
  });
});

describe("projection", () => {
  it("samples a horizon in a handful of runs, ending at the horizon", () => {
    for (const m of [1, 3, 6, 12, 24]) {
      const months = checkpointMonths(m);
      expect(months.at(-1)).toBeCloseTo(m);
      expect(months.length).toBeLessThanOrEqual(6);
    }
    expect(checkpointWeeks([1, 3])).toEqual([4, 13]);
  });
  it("interpolates percentiles", () => expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3));
  it("projects MRR from today's clients, wins and churn, with a range", () => {
    const model = toEngineModel(demoBundle());
    const start = startingMrr(model);
    expect(start.mrr).toBeGreaterThan(0);
    const result = simulate(model, 10, 1);
    const band = mrrAfter(model, summarise(model, result), start);
    expect(band.lo).toBeLessThanOrEqual(band.mean);
    expect(band.mean).toBeLessThanOrEqual(band.hi);
  });
});

describe("company map", () => {
  const live = demoBundle();
  const parts = [partOf(live), ...(live.otherProcesses ?? [])];
  it("draws each process as a card holding its steps, and every step stays on the map", () => {
    const map = companyMap(live, parts);
    const top = map.bundle.steps.filter((s) => !s.parent_step_id);
    expect(top.map((s) => s.id).sort()).toEqual(parts.map((p) => p.process.id).sort());
    const working = parts.flatMap((p) => p.steps).filter((s) => s.kind !== "start" && s.kind !== "end");
    for (const s of working) expect(map.bundle.steps.some((x) => x.id === s.id || x.id === s.child_process_id)).toBe(true);
    expect(map.processOfStep.get(working[0]!.id)).toBe(working[0]!.process_id);
  });
  it("moves neighbours out of the way when a card opens", () => {
    const closed = companyMap(live, parts).bundle.steps.filter((s) => !s.parent_step_id);
    const first = parts[0]!.process.id;
    const open = companyMap(live, parts, new Set([first])).bundle.steps.filter((s) => !s.parent_step_id);
    const x = (list: typeof closed, id: string) => Number(list.find((s) => s.id === id)!.x);
    const others = parts.slice(1).map((p) => p.process.id);
    expect(others.some((id) => x(open, id) > x(closed, id))).toBe(true);
  });
});

describe("company map from the stored process (B11)", () => {
  const live = demoBundle();
  const parts = [partOf(live), ...(live.otherProcesses ?? [])];
  const stored = defaultCompanyPart(live.workspace.id, parts);
  const handoffs = (map: ReturnType<typeof companyMap>) => map.bundle.edges.filter((e) => parts.some((p) => p.process.id === e.from_step_id) && parts.some((p) => p.process.id === e.to_step_id));
  const position = (map: ReturnType<typeof companyMap>, id: string) => {
    const s = map.bundle.steps.find((x) => x.id === id)!;
    return [Number(s.x), Number(s.y)];
  };

  it("draws the stored positions and the stored handoff lines, the same as with none stored", () => {
    const withStored = companyMap(live, parts, new Set(), stored);
    const without = companyMap(live, parts);
    expect(withStored.bundle.steps).toEqual(without.bundle.steps);
    expect(withStored.bundle.edges).toEqual(without.bundle.edges);
    // One handoff from the pipeline to each servicing process.
    expect(handoffs(withStored)).toHaveLength(parts.filter((p) => p.process.kind === "servicing").length);
  });

  it("takes positions, labels and lines from the stored map, not from a layout", () => {
    const moved = {
      ...stored,
      steps: stored.steps.map((s, i) => (i === 0 ? { ...s, x: 500, y: 700 } : s)),
      edges: stored.edges.slice(0, 1).map((e) => ({ ...e, label: "Won deals" })),
    };
    const map = companyMap(live, parts, new Set(), moved);
    expect(position(map, parts.find((p) => p.process.id === moved.steps[0]!.child_process_id)!.process.id)).toEqual([500, 700]);
    expect(handoffs(map)).toHaveLength(1);
    expect(handoffs(map)[0]!.label).toBe("Won deals");
  });

  it("puts a process the map has no holder for below the others, and keeps open cards from covering their neighbours", () => {
    const missing = parts[0]!.process.id;
    const partial = { ...stored, steps: stored.steps.filter((s) => s.child_process_id !== missing), edges: [] };
    const map = companyMap(live, parts, new Set(), partial);
    const lowest = Math.max(...partial.steps.map((s) => Number(s.y)));
    expect(position(map, missing)[1]).toBeGreaterThan(lowest);
    const closed = companyMap(live, parts, new Set(), stored);
    const open = companyMap(live, parts, new Set([parts[0]!.process.id]), stored);
    const others = parts.slice(1).map((p) => p.process.id);
    expect(others.some((id) => position(open, id)[0] > position(closed, id)[0])).toBe(true);
  });
});

describe("lighting a finding on the map", () => {
  const live = demoBundle();
  const parts = [partOf(live), ...(live.otherProcesses ?? [])];
  it("lights the closed card that holds the step, and opens nothing", () => {
    const map = companyMap(live, parts);
    const step = parts[0]!.steps.find((s) => s.kind !== "start" && s.kind !== "end")!;
    expect([...litIds(map.bundle.steps, new Set(), [step.id])]).toEqual([step.process_id]);
    // With the card open it is the step itself.
    expect([...litIds(map.bundle.steps, new Set([step.process_id]), [step.id])]).toEqual([step.id]);
  });
});

describe("axis", () => {
  it("labels weeks for one month and months after that", () => {
    expect(monthLabel(0, 3)).toBe("Now");
    expect(monthLabel(0.5, 1)).toBe("Week 2");
    expect(monthLabel(4, 24)).toBe("Month 4");
  });
  it("picks nice ticks around the data", () => {
    const t = niceTicks(104_000, 131_000);
    expect(t[0]).toBeLessThanOrEqual(104_000);
    expect(t.at(-1)).toBeGreaterThanOrEqual(131_000);
    expect(t.length).toBeLessThanOrEqual(8);
  });
  it("always labels the first and last point and never prints one over the last", () => {
    // 24 months: Now, 4, 8, 12, 16, 20, 24 with room for 4 labels.
    expect(labelIndexes(7, 4)).toEqual([0, 2, 4, 6]);
    for (const [n, max] of [[7, 7], [7, 4], [5, 3], [13, 5], [2, 4], [1, 4]] as const) {
      const idx = labelIndexes(n, max);
      expect(idx[0]).toBe(0);
      expect(idx.at(-1)).toBe(n - 1);
      expect(idx.length).toBeLessThanOrEqual(Math.max(max, 2));
    }
  });
});

describe("the MRR series", () => {
  const model = toEngineModel(demoBundle());
  const months = [1, 2];
  const runs = months.map((m) => {
    const shorter = { ...model, horizonWeeks: Math.round(m * (52 / 12)) };
    return summarise(shorter, simulate(shorter, 6, 1));
  });
  it("starts at today's MRR and is deterministic", () => {
    const a = mrrSeries(model, months, runs);
    const b = mrrSeries(model, months, runs);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ month: 0, mean: startingMrr(model).mrr });
    expect(a.map((p) => p.month)).toEqual([0, 1, 2]);
    for (const p of a) expect(p.lo).toBeLessThanOrEqual(p.hi);
  });
  it("gives the same point whichever horizon it was asked for", () => {
    const shorter = mrrSeries({ ...model, horizonWeeks: 4 }, [1], [runs[0]!]);
    const longer = mrrSeries({ ...model, horizonWeeks: 9 }, months, runs);
    expect(shorter[1]).toEqual(longer[1]);
  });
});

describe("the old demo links", () => {
  it("send ?process= and ?nested=1 to the process page", () => {
    expect(demoLandingRedirect("abc", undefined)).toBe("/demo/p/abc");
    expect(demoLandingRedirect("abc", "1")).toBe("/demo/p/abc?nested=1");
    expect(demoLandingRedirect(undefined, "1")).toMatch(/^\/demo\/p\/[0-9a-f-]+\?nested=1$/);
    expect(demoLandingRedirect(undefined, undefined)).toBeNull();
  });
});

describe("a company with no client records", () => {
  it("projects revenue from the interim client count, decaying at the monthly churn rate", () => {
    const base = toEngineModel(demoBundle());
    const model = { ...base, clients: undefined, clientGroups: undefined, activeClients: 20, churnMonthly: 0.05 };
    const start = startingMrr(model);
    expect(start.clients).toBe(20);
    const result = simulate(model, 6, 1);
    const band = mrrAfter(model, summarise(model, result), start);
    expect(band.lo).toBeLessThanOrEqual(band.mean);
    expect(band.mean).toBeLessThanOrEqual(band.hi);
  });
});
