import { describe, expect, it } from "vitest";
import { capacityProblems, simulate } from "@transpera-flow/engine";
import {
  engineRecurrence,
  larkspurBundle,
  northbeamBundle,
  northbeamStepIds,
  parseRecurrence,
  toEngineModel,
  type ProcessBundle,
  type StepRow,
} from "../src";

// Step base values (capacity P4) in the engine model: each field maps to its engine field, a step with none of them maps exactly as
// before, and a driver recurrence reaches the servicing link.

const START = "2026-10-05"; // a Monday
const audit = northbeamStepIds.audit;
const SPLIT = { automatable: 0.5, augmentable: 0.3, manual: 0.2 };

const withAudit = (over: Partial<StepRow>, b: ProcessBundle = northbeamBundle()): ProcessBundle => ({
  ...b,
  steps: b.steps.map((s) => (s.id === audit ? { ...s, ...over } : s)),
});
const auditOf = (b: ProcessBundle) => toEngineModel(b, { startDate: START }).steps.find((s) => s.id === audit)!;
const BASE_KEYS = ["split", "tierMultiplier", "toClientManager", "sources"];

describe("toEngineModel: step base values", () => {
  it("maps the split", () => {
    expect(auditOf(withAudit({ split: SPLIT })).split).toEqual(SPLIT);
  });

  it("maps the tier multipliers", () => {
    expect(auditOf(withAudit({ tier_multiplier: { T1: 1.5, T3: 0.7 } })).tierMultiplier).toEqual({ T1: 1.5, T3: 0.7 });
  });

  it("maps 'goes to the client's manager' and keeps the role as the fallback", () => {
    const step = auditOf(withAudit({ to_client_manager: true }));
    expect(step.toClientManager).toBe(true);
    expect(step.role).toBe(northbeamBundle().steps.find((s) => s.id === audit)!.role_id);
  });

  it("maps the source labels kept in provenance, and ignores any other provenance", () => {
    const at = "2026-10-31T00:00:00Z";
    const step = auditOf(
      withAudit({
        provenance: {
          work: { source: "interview", at },
          split: { source: "calculator", at },
          tier_multiplier: { source: "estimate", at },
          work_hours: { source: "measured", at },
        },
      }),
    );
    expect(step.sources).toEqual({ work: "interview", split: "calculator", tierMultiplier: "estimate" });
    expect(auditOf(withAudit({ provenance: { work: { source: "measured", at } } })).sources).toEqual({ work: "measured" });
    // The older kinds are not labels.
    expect(auditOf(withAudit({ provenance: { work: { source: "entered", at }, split: { source: "estimated", at } } }))).not.toHaveProperty("sources");
  });

  it("leaves each field undefined (not set to an empty value) when the column is null, empty or false", () => {
    const step = auditOf(withAudit({ split: null, tier_multiplier: {}, to_client_manager: false, provenance: {} }));
    for (const key of BASE_KEYS) expect(step, key).not.toHaveProperty(key);
    const bare = auditOf(withAudit({ split: null, split_notes: { manual: "A note stays in the database" } }));
    for (const key of BASE_KEYS) expect(bare, key).not.toHaveProperty(key);
    expect(bare).not.toHaveProperty("splitNotes");
  });

  it("reads numbers that arrive as strings, and drops a tier whose multiplier isn't a number", () => {
    const step = auditOf(withAudit({ tier_multiplier: { T1: "1.5", T2: "x" } as unknown as StepRow["tier_multiplier"] }));
    expect(step.tierMultiplier).toEqual({ T1: 1.5 });
  });

  it("every seed and fixture model is as it was: no step carries a base value, and the new columns change nothing", () => {
    for (const make of [northbeamBundle, larkspurBundle]) {
      const b = make();
      const model = toEngineModel(b, { startDate: START });
      for (const step of model.steps) for (const key of BASE_KEYS) expect(step, `${step.name}: ${key}`).not.toHaveProperty(key);
      // The same bundle read by code that never knew the columns: they are absent from every row.
      const old = {
        ...b,
        steps: b.steps.map((s) => {
          const { split: _a, split_notes: _b, tier_multiplier: _c, to_client_manager: _d, ...rest } = s;
          return rest as StepRow;
        }),
        otherProcesses: b.otherProcesses?.map((p) => ({
          ...p,
          steps: p.steps.map((s) => {
            const { split: _a, split_notes: _b, tier_multiplier: _c, to_client_manager: _d, ...rest } = s;
            return rest as StepRow;
          }),
        })),
      };
      expect(model).toEqual(toEngineModel(old, { startDate: START }));
      expect(capacityProblems(model)).toEqual([]);
    }
  });

  it("a split alone only labels the time: the run's step results are unchanged until a change acts on it", () => {
    const plain = simulate(toEngineModel(northbeamBundle(), { startDate: START }), 3, 7);
    const split = simulate(toEngineModel(withAudit({ split: SPLIT }), { startDate: START }), 3, 7);
    expect(split.steps).toEqual(plain.steps);
  });
});

describe("servicing recurrences", () => {
  it("parses the two old shapes and the driver shape, with per or without", () => {
    expect(parseRecurrence({ every: "month", times: 1 })).toEqual({ every: "month", times: 1 });
    expect(parseRecurrence({ poisson_per_month: 3 })).toEqual({ poisson_per_month: 3 });
    expect(parseRecurrence({ perMonth: 1, driver: "meetings" })).toEqual({ perMonth: 1, driver: "meetings" });
    expect(parseRecurrence({ perMonth: 4, driver: "words", per: 1000 })).toEqual({ perMonth: 4, driver: "words", per: 1000 });
  });

  it("refuses a bad driver, count or per", () => {
    for (const bad of [
      { perMonth: 1, driver: "pages" },
      { perMonth: 0, driver: "words" },
      { perMonth: 1001, driver: "words" },
      { perMonth: 1, driver: "words", per: 0 },
      { perMonth: 1, driver: "words", per: "x" },
      { perMonth: 1 },
      { driver: "words" },
      { perMonth: 1, driver: "words", every: "month" },
    ]) {
      expect(parseRecurrence(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("maps to the engine's {perMonth, driver, per}, reading numbers written as strings", () => {
    expect(engineRecurrence({ perMonth: 4, driver: "words", per: 1000 })).toEqual({ perMonth: 4, driver: "words", per: 1000 });
    expect(engineRecurrence({ perMonth: "4", driver: "words", per: "1000" })).toEqual({ perMonth: 4, driver: "words", per: 1000 });
    expect(engineRecurrence({ perMonth: 1, driver: "adhoc" })).toEqual({ perMonth: 1, driver: "adhoc" });
    expect(engineRecurrence({ every: "week", times: "0.5" })).toEqual({ every: "week", times: 0.5 });
    expect(engineRecurrence({ perMonth: 1, driver: "pages" })).toBeNull();
  });

  it("a servicing link with a driver recurrence reaches the model", () => {
    const b = northbeamBundle();
    const links0 = b.servicingLinks ?? [];
    const link = links0[0]!;
    const driver = { perMonth: 2, driver: "meetings" as const };
    const model = toEngineModel({ ...b, servicingLinks: links0.map((l) => (l === link ? { ...l, recurrence: driver } : l)) }, { startDate: START });
    const links = Object.values(model.services ?? {}).flatMap((sv) => sv.servicing ?? []);
    expect(links.some((l) => l.process === link.process_id && "driver" in l.recurrence && l.recurrence.driver === "meetings" && l.recurrence.perMonth === 2)).toBe(true);
  });
});
