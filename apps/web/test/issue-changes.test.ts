import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { capacityModel, simulate, type EngineModel } from "@transpera-flow/engine";
import type { ProcessBundle } from "@transpera-flow/db";
import { capacitySetupFromModel, changeCounts, changeRunModel, changesForIssue, departmentCeiling, todayModel, type CapacityChangeRow } from "@transpera-flow/db";
import { runIssueChanges } from "@/lib/capacity/issue-runs";
import { clearCapacityRuns, CAPACITY_SEED, TODAY_REPS } from "@/lib/capacity/runs";
import type { SimClientLike } from "@/lib/capacity/client-like";
import { IssueChanges, signedWhole } from "@/components/issues/issue-changes";

// "Changes anchored to this issue" (capacity build P8 section 2): the figures the issue page shows come from one run per change in the worker. Here the
// worker is replaced by the engine itself, and the figures are checked against a direct engine run of the same change.

const ISSUE = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

const model: EngineModel = capacityModel();
const setup = capacitySetupFromModel(model);

function rows(): CapacityChangeRow[] {
  return (model.changes ?? []).map((c, i) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    effects: c.effects,
    adoption: c.adoption,
    ramp_months: c.rampMonths ?? 0,
    tiers: c.tiers ?? null,
    cost_monthly: null,
    issue_id: i === 0 || i === 1 ? ISSUE : i === 2 ? OTHER : null,
    source: "estimate",
    provenance: {},
  }));
}

/** The model as the issue page gets it from the database: no changes. */
const stored: EngineModel = { ...model, changes: [] };

const calls: EngineModel[] = [];
const client: SimClientLike = {
  run: async (m, options) => {
    calls.push(m);
    return { result: simulate(m, options.reps, options.seed, { personTime: options.personTime }), durationMs: 1 };
  },
};

beforeEach(() => {
  clearCapacityRuns();
  calls.length = 0;
});

describe("which changes belong to an issue", () => {
  it("picks the changes that name it and counts them per issue", () => {
    const all = rows();
    expect(changesForIssue(all, ISSUE).map((c) => c.id)).toEqual(all.slice(0, 2).map((c) => c.id));
    expect(changesForIssue(all, "nope")).toEqual([]);
    expect(changeCounts(all)).toEqual({ [ISSUE]: 2, [OTHER]: 1 });
  });
});

describe("runIssueChanges", () => {
  it("hours freed and more clients match a direct engine run of the same change against today", async () => {
    const mine = changesForIssue(rows(), ISSUE);
    const figures = await runIssueChanges(client, setup, stored, mine);
    expect(Object.keys(figures)).toEqual(mine.map((c) => c.id));

    const today = todayModel(stored);
    const base = simulate(today, TODAY_REPS, CAPACITY_SEED, { personTime: true });
    for (const change of mine) {
      const changedModel = changeRunModel(today, change);
      const direct = simulate(changedModel, TODAY_REPS, CAPACITY_SEED, { personTime: true });
      const f = figures[change.id]!;
      expect(f.freed).toBeCloseTo(direct.personTime!.freed!.byChange[change.id]!, 9);
      expect(f.freed).toBeGreaterThan(0);
      const dep = f.department!.id;
      const expected = departmentCeiling(setup, changedModel, direct, dep).max - departmentCeiling(setup, today, base, dep).max;
      expect(f.moreClients).toBeCloseTo(expected, 9);
      // No other department moved further.
      for (const d of setup.departments) {
        const delta = departmentCeiling(setup, changedModel, direct, d.id).max - departmentCeiling(setup, today, base, d.id).max;
        expect(Math.abs(delta)).toBeLessThanOrEqual(Math.abs(f.moreClients) + 1e-9);
      }
    }
  }, 300_000);

  it("runs today once, then one run per change, and reports progress; a second pass is served from the cache", async () => {
    const mine = changesForIssue(rows(), ISSUE);
    const progress: number[] = [];
    await runIssueChanges(client, setup, stored, mine, { onProgress: (p) => progress.push(p.done) });
    expect(calls).toHaveLength(1 + mine.length);
    expect(progress).toEqual([0, 1, 2]);
    await runIssueChanges(client, setup, stored, mine);
    expect(calls).toHaveLength(1 + mine.length);
  }, 300_000);

  it("an issue with no changes runs nothing", async () => {
    const figures = await runIssueChanges(client, setup, stored, changesForIssue(rows(), "nope"));
    expect(figures).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("signedWhole", () => {
  it("signs the figure with a real minus", () => {
    expect([signedWhole(2.6), signedWhole(-1.2), signedWhole(0.2)]).toEqual(["+3", "−1", "0"]);
  });
});

describe("the section on the issue page", () => {
  it("an issue with no changes shows the empty state, and no table", () => {
    const html = renderToStaticMarkup(createElement(IssueChanges, { changes: [], setup, bundle: {} as ProcessBundle, base: "/w/x" }));
    expect(html).toContain("Changes anchored to this issue");
    expect(html).toContain('data-empty="changes"');
    expect(html).not.toContain("data-changes-table");
  });
});
