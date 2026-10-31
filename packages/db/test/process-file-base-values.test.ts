import { describe, expect, it } from "vitest";
import type { SourceLabel } from "@transpera-flow/engine";
import { checkProcessFile } from "../src/process-file";
import { SOURCE_LABELS, SOURCED_VALUES, SPLIT_PARTS } from "../src/process-file-2";
import { STEP_SOURCE_LABELS } from "../src";

// Step base values in the process file (capacity P4): the split, its notes, tier multipliers, manager routing and source labels,
// each read, each refused in plain words, and a file without them read exactly as before. Pure; no database.

const clone = (v: unknown) => JSON.parse(JSON.stringify(v));

function base(step: Record<string, unknown> = {}) {
  return clone({
    format: "transpera-process/2",
    name: "Small",
    kind: "servicing",
    steps: [
      { id: "a", name: "Begin", type: "start" },
      { id: "b", name: "Pacing", type: "step", role: "Strategist", hands_on_hours: 1, ...step },
      { id: "c", name: "Finish", type: "end" },
    ],
    links: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  });
}
const check = (step: Record<string, unknown>) => checkProcessFile(base(step));
const stepOf = (step: Record<string, unknown>) => check(step).file!.steps.find((s) => s.id === "b")!;
const SPLIT = { automatable: 0.7, augmentable: 0.2, manual: 0.1 };

describe("base values in a /2 file", () => {
  it("reads every field", () => {
    const r = check({
      split: SPLIT,
      split_notes: { automatable: "Pull spend and budgets", augmentable: "Work out the new budget", manual: "Decide and change" },
      tier_multiplier: { T1: 1.3, T2: 1, T3: 0.8 },
      to_client_manager: true,
      sources: { work: "interview", split: "estimate", tier_multiplier: "calculator" },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.file!.steps.find((s) => s.id === "b")).toMatchObject({
      split: SPLIT,
      split_notes: { automatable: "Pull spend and budgets", augmentable: "Work out the new budget", manual: "Decide and change" },
      tier_multiplier: { T1: 1.3, T2: 1, T3: 0.8 },
      to_client_manager: true,
      sources: { work: "interview", split: "estimate", tier_multiplier: "calculator" },
    });
  });

  it("a file without them is read exactly as before: no new key on any step", () => {
    const r = checkProcessFile(base());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    for (const s of r.file!.steps) for (const k of ["split", "split_notes", "tier_multiplier", "to_client_manager", "sources"]) expect(s).not.toHaveProperty(k);
  });

  it("leaves nulls, a false manager flag and empty objects out", () => {
    const s = stepOf({ split: null, split_notes: {}, tier_multiplier: {}, to_client_manager: false, sources: {} });
    for (const k of ["split", "split_notes", "tier_multiplier", "to_client_manager", "sources"]) expect(s, k).not.toHaveProperty(k);
  });

  it("accepts shares that add up to 100% within a tenth of a percent, and all-manual", () => {
    expect(check({ split: { automatable: 0.333, augmentable: 0.333, manual: 0.334 } }).errors).toEqual([]);
    expect(check({ split: { automatable: 0, augmentable: 0, manual: 1 } }).errors).toEqual([]);
  });

  describe("plain-English problems", () => {
    const only = (step: Record<string, unknown>) => check(step).errors;

    it("a split that doesn't add up says what it adds up to", () => {
      expect(only({ split: { automatable: 0.5, augmentable: 0.3, manual: 0.3 } })).toEqual(["Step 'Pacing': the split's shares add up to 110%, but they must add up to 100%."]);
      expect(only({ split: { automatable: 0.5, augmentable: 0.3, manual: 0.1 } })[0]).toContain("add up to 90%");
    });

    it("a split with a missing, out-of-range or non-number part names the part", () => {
      expect(only({ split: { automatable: 0.5, augmentable: 0.5 } })).toEqual([expect.stringContaining('"manual" is missing')]);
      expect(only({ split: { automatable: 0.5, augmentable: 0.5, manual: 0 } })).toEqual([]);
      expect(only({ split: { automatable: 1.5, augmentable: -0.5, manual: 0 } })).toEqual([
        expect.stringContaining("automatable share is 1.5"),
        expect.stringContaining("augmentable share is -0.5"),
      ]);
      expect(only({ split: { automatable: "half", augmentable: 0.5, manual: 0 } })).toEqual([expect.stringContaining("automatable share is not a number")]);
      expect(only({ split: 0.5 })).toEqual([expect.stringContaining('"split" should be')]);
      expect(only({ split: [0.5, 0.5] })).toEqual([expect.stringContaining('"split" should be')]);
    });

    it("an extra part in the split is ignored with a warning, not an error", () => {
      const r = check({ split: { ...SPLIT, other: 0 } });
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([expect.stringContaining("a field 'other'")]);
    });

    it("split notes: text, one line, not too long; a note with no split is warned about", () => {
      expect(only({ split: SPLIT, split_notes: { manual: 4 } })).toEqual([expect.stringContaining("note for manual should be text")]);
      expect(only({ split: SPLIT, split_notes: { manual: "two\nlines" } })).toEqual([expect.stringContaining("note for manual should be one line")]);
      expect(only({ split: SPLIT, split_notes: { manual: "x".repeat(301) } })).toEqual([expect.stringContaining("301 characters")]);
      expect(only({ split: SPLIT, split_notes: "all of it" })).toEqual([expect.stringContaining('"split_notes" should be')]);
      expect(check({ split_notes: { manual: "Decide" } }).warnings).toEqual([expect.stringContaining("no split")]);
    });

    it("tier multipliers: a number from 0 to 100 for each tier", () => {
      expect(only({ tier_multiplier: { T1: -1 } })).toEqual([expect.stringContaining("tier 'T1'")]);
      expect(only({ tier_multiplier: { T1: "1.3" } })).toEqual([expect.stringContaining("tier 'T1'")]);
      expect(only({ tier_multiplier: { T1: 101 } })).toEqual([expect.stringContaining("from 0 to 100")]);
      expect(only({ tier_multiplier: { "": 1 } })).toEqual([expect.stringContaining("needs a name")]);
      expect(only({ tier_multiplier: [1, 1, 1] })).toEqual([expect.stringContaining('"tier_multiplier" should give a number for each tier')]);
      expect(only({ tier_multiplier: { T1: 0 } })).toEqual([]);
    });

    it("to_client_manager must be true or false, and a step with none and no role is warned about", () => {
      expect(only({ to_client_manager: "yes" })).toEqual([expect.stringContaining("true or false")]);
      const r = checkProcessFile(
        clone({ ...base({ to_client_manager: true }), steps: base({ to_client_manager: true }).steps.map((s: { id: string }) => (s.id === "b" ? { id: "b", name: "Pacing", type: "step", hands_on_hours: 1, to_client_manager: true } : s)) }),
      );
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([expect.stringContaining("no role")]);
    });

    it("a source label must be one of the four, for work, split or tier_multiplier", () => {
      expect(only({ sources: { work: "hunch" } })).toEqual([expect.stringContaining("'hunch'; use interview, calculator, measured, estimate")]);
      expect(only({ sources: "interview" })).toEqual([expect.stringContaining('"sources" should say where')]);
      expect(check({ sources: { cost: "interview" } }).warnings).toEqual([expect.stringContaining("'cost'")]);
      expect(check({ sources: { split: "interview" } }).warnings).toEqual([expect.stringContaining("no split")]);
      expect(check({ sources: { tier_multiplier: "interview" } }).warnings).toEqual([expect.stringContaining("no tier_multiplier")]);
    });
  });

  it("a /1 file with these fields ignores them with a warning, as it does any /2 field", () => {
    const f = base({ split: SPLIT });
    f.format = "transpera-process/1";
    const r = checkProcessFile(f);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([expect.stringContaining("'split'")]);
    expect(r.file!.steps.find((s) => s.id === "b")).not.toHaveProperty("split");
  });

  it("the file's lists are the engine's and the database's", () => {
    expect([...SOURCE_LABELS]).toEqual([...STEP_SOURCE_LABELS]);
    // A type-level check: every label the file takes is a SourceLabel of the engine.
    const labels: SourceLabel[] = [...SOURCE_LABELS];
    expect(labels).toHaveLength(4);
    expect([...SPLIT_PARTS]).toEqual(["automatable", "augmentable", "manual"]);
    expect([...SOURCED_VALUES]).toEqual(["work", "split", "tier_multiplier"]);
  });
});
