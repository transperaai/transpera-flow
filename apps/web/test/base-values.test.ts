import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { bundleForProcess, northbeamBundle, northbeamServicingProcessIds, northbeamStepIds, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import { StepBaseValues } from "@/components/step-base-values";
import {
  clearStepSplit,
  describeSplit,
  rebalance,
  setSourceLabel,
  setSplitNote,
  setStepSplit,
  setTierMultiplier,
  setToClientManager,
  splitFromPercents,
  splitPercents,
  type Percents,
} from "@/lib/editor/base-values";
import { describeValue } from "@/lib/editor/describe";
import { applyEdit } from "@/lib/editor/ops";
import { parseFieldUpdate, parseNewStep, STEP_FIELDS } from "@/lib/editor/validate";
import { DEFAULT_TIER_SETUP } from "@/lib/tier-setup";

// A step's base values in the editor (capacity P4): the commands, the validation the server actions apply, the slider rule, and
// what the inspector section shows (and, read-only, lets nobody change).

const bundle = (): ProcessBundle => northbeamBundle();
const AUDIT = northbeamStepIds.audit;
const stepOf = (b: ProcessBundle, id = AUDIT): StepRow => b.steps.find((s) => s.id === id)!;
const run = (b: ProcessBundle, edit: ReturnType<typeof setStepSplit>): ProcessBundle => (edit ? applyEdit(b, edit) : b);
const sum = (p: Percents) => p[0] + p[1] + p[2];

describe("the slider rule", () => {
  it("always adds up to 100, in steps of 5, from any start and any move", () => {
    const starts: Percents[] = [[0, 0, 100], [100, 0, 0], [70, 20, 10], [33, 33, 34], [0, 50, 50], [5, 0, 95]];
    for (const start of starts) {
      for (const index of [0, 1, 2] as const) {
        for (let v = 0; v <= 100; v += 5) {
          const out = rebalance(start, index, v);
          expect(sum(out), `${start} ${index} ${v}`).toBe(100);
          expect(out[index]).toBe(v);
          expect(out.every((x) => x >= 0 && x % 5 === 0), `${start} ${index} ${v}`).toBe(true);
        }
      }
    }
  });

  it("takes from the other two in proportion to what they hold (the prototype's way)", () => {
    expect(rebalance([70, 20, 10], 0, 40)).toEqual([40, 40, 20]);
    expect(rebalance([0, 0, 100], 0, 70)).toEqual([70, 0, 30]);
    expect(rebalance([50, 50, 0], 2, 20)).toEqual([40, 40, 20]);
    // Two empty others share what is left.
    expect(rebalance([100, 0, 0], 0, 60)).toEqual([60, 20, 20]);
    expect(rebalance([0, 0, 0] as Percents, 1, 50)).toEqual([25, 50, 25]);
  });

  it("rounds a value that isn't a step and clamps one outside 0 to 100", () => {
    expect(rebalance([0, 0, 100], 0, 62)[0]).toBe(60);
    expect(rebalance([0, 0, 100], 0, 150)).toEqual([100, 0, 0]);
    expect(rebalance([0, 0, 100], 0, -5)[0]).toBe(0);
  });

  it("reads a step without a split as all manual, and turns percents into shares that pass the database's check", () => {
    expect(splitPercents(null)).toEqual([0, 0, 100]);
    expect(splitPercents({ automatable: 0.7, augmentable: 0.2, manual: 0.1 })).toEqual([70, 20, 10]);
    const s = splitFromPercents([35, 55, 10]);
    expect(s).toEqual({ automatable: 0.35, augmentable: 0.55, manual: 0.1 });
    expect(parseFieldUpdate("steps", { split: null }, { split: s })).not.toBeNull();
    expect(describeSplit(s)).toBe("35% automatable, 55% augmentable, 10% manual");
  });
});

describe("the commands", () => {
  it("set the split as one whole value, with one undo", () => {
    const b = bundle();
    const edit = setStepSplit(b, AUDIT, [70, 20, 10])!;
    expect(edit.ops).toHaveLength(1);
    const after = applyEdit(b, edit);
    expect(stepOf(after).split).toEqual({ automatable: 0.7, augmentable: 0.2, manual: 0.1 });
    expect(setStepSplit(after, AUDIT, [70, 20, 10])).toBeNull();
    expect(setStepSplit(b, AUDIT, [70, 20, 20])).toBeNull();
  });

  it("clear the split, its notes and its source label together", () => {
    let b = run(bundle(), setStepSplit(bundle(), AUDIT, [70, 20, 10]));
    b = applyEdit(b, setSplitNote(b, AUDIT, "automatable", "Pull spend")!);
    b = applyEdit(b, setSourceLabel(b, AUDIT, "split", "interview", { at: "2026-10-31T00:00:00Z" })!);
    expect(stepOf(b).split_notes).toEqual({ automatable: "Pull spend" });
    expect(stepOf(b).provenance.split).toMatchObject({ source: "interview", at: "2026-10-31T00:00:00Z" });
    const cleared = applyEdit(b, clearStepSplit(b, AUDIT)!);
    expect(stepOf(cleared)).toMatchObject({ split: null, split_notes: null });
    expect(stepOf(cleared).provenance.split).toBeNull();
    expect(clearStepSplit(bundle(), AUDIT)).toBeNull();
  });

  it("notes: one line for a part, blank takes it away, none left is null", () => {
    let b = applyEdit(bundle(), setSplitNote(bundle(), AUDIT, "manual", "  Decide\n and change ")!);
    expect(stepOf(b).split_notes).toEqual({ manual: "Decide and change" });
    b = applyEdit(b, setSplitNote(b, AUDIT, "automatable", "Pull")!);
    b = applyEdit(b, setSplitNote(b, AUDIT, "manual", "")!);
    expect(stepOf(b).split_notes).toEqual({ automatable: "Pull" });
    b = applyEdit(b, setSplitNote(b, AUDIT, "automatable", null)!);
    expect(stepOf(b).split_notes).toBeNull();
  });

  it("tier multipliers: one tier at a time, blank is 1, none left is null", () => {
    let b = applyEdit(bundle(), setTierMultiplier(bundle(), AUDIT, "T1", 1.3)!);
    b = applyEdit(b, setTierMultiplier(b, AUDIT, "T3", 0.8)!);
    expect(stepOf(b).tier_multiplier).toEqual({ T1: 1.3, T3: 0.8 });
    b = applyEdit(b, setTierMultiplier(b, AUDIT, "T1", null)!);
    b = applyEdit(b, setTierMultiplier(b, AUDIT, "T3", null)!);
    expect(stepOf(b).tier_multiplier).toBeNull();
  });

  it("send the step to the client's manager and keep the role", () => {
    const b = applyEdit(bundle(), setToClientManager(bundle(), AUDIT, true)!);
    expect(stepOf(b)).toMatchObject({ to_client_manager: true, role_id: stepOf(bundle()).role_id });
    expect(setToClientManager(b, AUDIT, true)).toBeNull();
    expect(stepOf(applyEdit(b, setToClientManager(b, AUDIT, false)!)).to_client_manager).toBe(false);
  });

  it("describe their changes in words for the draft's change list", () => {
    expect(describeValue("split", { automatable: 0.7, augmentable: 0.2, manual: 0.1 }, new Map())).toBe("70% automatable, 20% augmentable, 10% manual");
    expect(describeValue("tier_multiplier", { T1: 1.3 }, new Map())).toBe("T1 ×1.3");
    expect(describeValue("to_client_manager", true, new Map())).toBe("the client's manager");
    expect(describeValue("provenance.split", { source: "interview" }, new Map())).toBe("interview");
  });
});

describe("what the server actions accept", () => {
  const ok = (changes: Record<string, unknown>, base: Record<string, unknown>) => parseFieldUpdate("steps", base, changes) !== null;

  it("a split that adds up, null to clear it", () => {
    expect(ok({ split: { automatable: 0.5, augmentable: 0.3, manual: 0.2 } }, { split: null })).toBe(true);
    expect(ok({ split: null }, { split: { automatable: 0.5, augmentable: 0.3, manual: 0.2 } })).toBe(true);
    for (const bad of [{ automatable: 0.5, augmentable: 0.5, manual: 0.5 }, { automatable: 1 }, { automatable: -0.5, augmentable: 1, manual: 0.5 }, { automatable: 0.5, augmentable: 0.3, manual: 0.2, other: 0 }, "x", [1]]) {
      expect(ok({ split: bad }, { split: null }), JSON.stringify(bad)).toBe(false);
    }
  });

  it("notes, multipliers, the manager flag and source labels", () => {
    expect(ok({ split_notes: { manual: "Decide" } }, { split_notes: null })).toBe(true);
    expect(ok({ split_notes: { other: "x" } }, { split_notes: null })).toBe(false);
    expect(ok({ split_notes: { manual: "a\nb" } }, { split_notes: null })).toBe(false);
    expect(ok({ tier_multiplier: { T1: 1.3 } }, { tier_multiplier: null })).toBe(true);
    expect(ok({ tier_multiplier: { T1: -1 } }, { tier_multiplier: null })).toBe(false);
    expect(ok({ tier_multiplier: { T1: "2" } }, { tier_multiplier: null })).toBe(false);
    expect(ok({ to_client_manager: true }, { to_client_manager: false })).toBe(true);
    expect(ok({ to_client_manager: null }, { to_client_manager: false })).toBe(false);
    for (const label of ["interview", "calculator", "measured", "estimate"]) {
      expect(ok({ "provenance.split": { source: label, at: "2026-10-31T00:00:00Z" } }, { "provenance.split": null }), label).toBe(true);
    }
    expect(ok({ "provenance.split": { source: "hunch" } }, { "provenance.split": null })).toBe(false);
    expect(Object.keys(STEP_FIELDS)).toEqual(expect.arrayContaining(["provenance.work", "provenance.split", "provenance.tier_multiplier"]));
  });

  it("a deleted step comes back with its base values (undo), and a new one without any", () => {
    const row = { ...stepOf(bundle()), id: "11111111-1111-4111-8111-111111111111", split: { automatable: 0.5, augmentable: 0.3, manual: 0.2 }, tier_multiplier: { T1: 1.2 }, to_client_manager: true };
    expect(parseNewStep(row)).toMatchObject({ split: row.split, tier_multiplier: row.tier_multiplier, to_client_manager: true });
    const plain = parseNewStep({ ...stepOf(bundle()), id: "11111111-1111-4111-8111-111111111111" })!;
    expect(plain.split).toBeNull();
    expect(parseNewStep({ ...row, split: { automatable: 2, augmentable: 0, manual: 0 } })).toBeNull();
    expect(parseNewStep({ ...row, to_client_manager: "yes" })).toBeNull();
  });
});

const editorStub = () => ({ run: vi.fn() }) as never;
const stamp = () => ({ at: "2026-10-31T00:00:00Z" });
const html = (b: ProcessBundle, step: StepRow, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(StepBaseValues, { bundle: b, step, editor: editorStub(), stamp, ...over }));

describe("the inspector section", () => {
  it("shows the split, its lines and its source, and the slider values", () => {
    let b = applyEdit(bundle(), setStepSplit(bundle(), AUDIT, [70, 20, 10])!);
    b = applyEdit(b, setSplitNote(b, AUDIT, "automatable", "Pull spend and budgets")!);
    b = applyEdit(b, setSourceLabel(b, AUDIT, "split", "estimate", stamp())!);
    const out = html(b, stepOf(b));
    expect(out).toContain("Work split (sums to 100%)");
    expect(out).toContain(">70%<");
    expect(out).toContain("Pull spend and budgets");
    expect(out).toContain('data-source-pill="estimate"');
    expect(out).toContain("Low confidence");
    expect(out).toContain("data-clear-split");
    expect(out).not.toContain("No split entered");
  });

  it("read-only: every control is disabled and there is no Clear split", () => {
    const b = applyEdit(bundle(), setStepSplit(bundle(), AUDIT, [70, 20, 10])!);
    const out = html(b, stepOf(b), { readOnly: true });
    expect(out).not.toContain("data-clear-split");
    const controls = out.match(/<(input|select)[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(3);
    for (const c of controls) expect(c, c).toContain("disabled");
  });

  it("a servicing step shows how often each service runs it, a driver from the tier, and where it is set", () => {
    const base = northbeamBundle();
    const proc = Object.values(northbeamServicingProcessIds)[0]!;
    const sb = bundleForProcess(base, proc)!;
    const step = sb.steps.find((s) => s.kind === "task")!;
    const plain = html(sb, step);
    expect(plain).toContain("data-how-often");
    expect(plain).toContain('data-recurrence="fixed"');
    expect(plain).toContain("Set on the servicing link");
    // A driver recurrence with no tier values yet reads "Set in Tiers & clients"; with them, the values by tier.
    const link = sb.servicingLinks!.find((l) => l.process_id === proc)!;
    const driver = { ...sb, servicingLinks: sb.servicingLinks!.map((l) => (l === link ? { ...l, recurrence: { perMonth: 1, driver: "words" as const, per: 1000 } } : l)) };
    expect(html(driver, step)).toContain("from the tier (words ÷ 1,000), Set in Tiers &amp; clients");
    const tierSetup = { keys: ["T1", "T2", "T3"], services: { [link.service_id]: { tier: "T2", deliverables: { words: 1500 } } } };
    expect(html(driver, step, { tierSetup })).toContain("from the tier (words ÷ 1,000), T2 1500");
    // Tier multipliers: one number for each of the workspace's tiers.
    expect(plain).toContain("Tier multiplier on time");
    for (const t of DEFAULT_TIER_SETUP.keys) expect(plain).toContain(`>${t}<`);
    expect(plain).toContain("The client&#x27;s manager");
  });

  it("a pipeline step has no how-often or tier section until it has a multiplier", () => {
    const out = html(bundle(), stepOf(bundle()));
    expect(out).not.toContain("data-how-often");
    expect(out).not.toContain("data-tier-multiplier");
    const set = applyEdit(bundle(), setTierMultiplier(bundle(), AUDIT, "T1", 1.5)!);
    expect(html(set, stepOf(set))).toContain("data-tier-multiplier");
  });
});

describe("the tier setup", () => {
  it("reads the tier keys in sort order and each tier service's deliverables from Set up; without tiers it reads T1 to T3", async () => {
    const { tierSetupFrom } = await import("@/lib/tier-setup");
    expect(tierSetupFrom(null)).toEqual(DEFAULT_TIER_SETUP);
    const setup = {
      tiers: [{ id: "b", key: "T2", sort: 2 }, { id: "a", key: "T1", sort: 1 }],
      services: [{ id: "s1", tier_id: "a", words: 4000, links: null, tech_hours: 2 }, { id: "s2", tier_id: null, words: 1 }],
    } as never;
    expect(tierSetupFrom(setup)).toEqual({ keys: ["T1", "T2"], services: { s1: { tier: "T1", deliverables: { words: 4000, techHours: 2 } } } });
    expect(tierSetupFrom({ tiers: [], services: [] } as never).keys).toEqual(["T1", "T2", "T3"]);
  });
});
