import { describe, expect, it } from "vitest";
import { emptyFirstPrinciples, firstPrinciplesFlags, type FirstPrinciples } from "@transpera-flow/engine";
import { mergeFirstPrinciples, type FpInput } from "../../src/process-import/first-principles";
import { ImportError } from "../../src/process-import/errors";

// Merging what Claude reads in a transcript into a process's first principles (issue #119, A54): pure, no database.

const ctx = {
  steps: [
    { id: "s-qualify", name: "Qualify lead" },
    { id: "s-discovery", name: "Discovery call" },
    { id: "s-proposal", name: "Audit & proposal" },
    { id: "s-proposal-review", name: "Audit review" },
  ],
  people: [
    { id: "p-maya", name: "Maya Collins" },
    { id: "p-tom", name: "Tom Reed" },
  ],
};
const merge = (input: FpInput, current: FirstPrinciples = emptyFirstPrinciples(), mode: "merge" | "replace" = "merge") => mergeFirstPrinciples(current, input, ctx, mode);

describe("filling in from a transcript", () => {
  const first = merge({
    job: { who: "Founders", progress: "More enquiries" },
    statements: [
      { text: "Retainers are 12-month contracts", kind: "truth", source: "Contract template" },
      { text: "Leads go cold after 48 hours" },
    ],
    requirements: [
      { text: "Every proposal is reviewed", owner: "maya", why: "Pricing errors", verdict: "keep", step: "audit review" },
      { text: "Finance checks credit", owner: "Finance", why: "We've always done it", step: "qualify" },
    ],
    deletes: [{ step: "Qualify lead", agreed_by: "Tom" }],
    improvements: [{ stage: "automate", text: "Auto-qualify leads", step: "qualify" }],
    why: { problem: "Proposals are late", chain: ["Maya is busy", "Only she can price"], root: "No written pricing rules" },
    measures: [{ text: "Win rate over 30%", kpi: "winRate", comparator: "atLeast", target: 30, horizon: "6 months" }, { text: "Clients feel looked after" }],
  });

  it("resolves people and steps by name, and keeps an owner who isn't in People as typed", () => {
    expect(first.warnings).toEqual([]);
    expect(first.doc.requirements[0]).toMatchObject({ owner_person_id: "p-maya", owner_text: "", step_id: "s-proposal-review", verdict: "keep" });
    expect(first.doc.requirements[1]).toMatchObject({ owner_person_id: null, owner_text: "Finance", step_id: "s-qualify", verdict: "challenge" });
    expect(first.doc.deletes).toEqual([{ step_id: "s-qualify", breaks_if_removed: "", agreed_by: "p-tom", added_back: false }]);
  });

  it("defaults a statement to an assumption and stores a measure's target in the engine's unit", () => {
    expect(first.doc.statements.map((s) => s.kind)).toEqual(["truth", "assumption"]);
    expect(first.doc.measures[0]).toMatchObject({ id: "m1", kpi: "winRate", target: 0.3, comparator: "atLeast", horizon: "6 months" });
    expect(first.doc.measures[1]).toMatchObject({ id: "m2", kpi: null, target: null });
  });

  it("reports which steps of the flow changed", () => {
    expect(first.changed).toEqual(["job", "truths", "reqs", "del", "saa", "why", "measures"]);
    expect(merge({ job: { who: "Founders" } }, first.doc).changed).toEqual([]);
  });

  it("leaves the answers the rule checks flag for Claude to see", () => {
    const flags = firstPrinciplesFlags(first.doc, { ...ctx, roles: [] });
    expect(flags.reqs.map((f) => f.code)).toEqual(["owner_team", "no_reason"]);
    expect(flags.saa.map((f) => f.code)).toEqual(["order"]);
    expect(flags.measures.map((f) => f.code)).toEqual(["measure_unmapped"]);
  });
});

describe("merge mode", () => {
  const base = merge({
    statements: [{ text: "Leads go cold after 48 hours" }],
    requirements: [{ text: "Finance checks credit", owner: "Finance", why: "Habit" }],
    improvements: [{ stage: "simplify", text: "One template", step: "proposal" }],
    measures: [{ text: "Win rate over 30%", kpi: "winRate", target: 30 }],
  }).doc;

  it("updates the item it recognises by its text, changing only the fields given", () => {
    const r = merge({ requirements: [{ text: "finance checks credit!", owner: "Tom Reed" }], statements: [{ text: "Leads go cold after 48 hours", test: "Check the CRM" }] }, base);
    expect(r.doc.requirements).toHaveLength(1);
    expect(r.doc.requirements[0]).toMatchObject({ owner_person_id: "p-tom", owner_text: "", why: "Habit", verdict: "challenge" });
    expect(r.doc.statements[0]).toMatchObject({ test: "Check the CRM", kind: "assumption" });
    expect(r.changed).toEqual(["truths", "reqs"]);
  });

  it("adds what is new and removes nothing", () => {
    const r = merge({ requirements: [{ text: "Sales can't quote prices", owner: "Maya Collins" }], measures: [{ text: "New wins", kpi: "won", target: 6 }] }, base);
    expect(r.doc.requirements.map((x) => x.text)).toEqual(["Finance checks credit", "Sales can't quote prices"]);
    expect(r.doc.measures.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(r.doc.improvements).toEqual(base.improvements);
  });

  it("keeps a measure's target unless its number changes, and re-reads a new target in the new unit", () => {
    expect(merge({ measures: [{ text: "Win rate over 30%", horizon: "3 months" }] }, base).doc.measures[0]).toMatchObject({ target: 0.3, horizon: "3 months" });
    expect(merge({ measures: [{ text: "Win rate over 30%", kpi: "won" }] }, base).doc.measures[0]).toMatchObject({ kpi: "won", target: null });
    expect(merge({ measures: [{ text: "Win rate over 30%", target: 40 }] }, base).doc.measures[0]!.target).toBeCloseTo(0.4);
  });

  it("matches an improvement by stage and text, so the same words at another stage are another item", () => {
    const r = merge({ improvements: [{ stage: "accelerate", text: "One template", step: "proposal" }] }, base);
    expect(r.doc.improvements.map((i) => i.stage)).toEqual(["simplify", "accelerate"]);
  });

  it("changes the why only where given, and replaces the chain", () => {
    const withWhy = merge({ why: { problem: "Late", chain: ["a", "b"], root: "No rules" } }, base).doc;
    const r = merge({ why: { root: "No written rules" } }, withWhy);
    expect(r.doc.why).toEqual({ problem: "Late", chain: ["a", "b"], root: "No written rules" });
    expect(merge({ why: { chain: ["x"] } }, withWhy).doc.why.chain).toEqual(["x"]);
  });
});

describe("replace mode", () => {
  const base = merge({ requirements: [{ text: "A" }, { text: "B" }], measures: [{ text: "Wins", kpi: "won", target: 6 }, { text: "Rate", kpi: "winRate", target: 30 }], statements: [{ text: "S" }] }).doc;

  it("swaps each list that is given, and leaves the others alone", () => {
    const r = merge({ requirements: [{ text: "C" }] }, base, "replace");
    expect(r.doc.requirements.map((x) => x.text)).toEqual(["C"]);
    expect(r.doc.statements).toEqual(base.statements);
    expect(r.doc.measures).toEqual(base.measures);
  });

  it("lets a replaced measure keep its id when its text matches, so findings on it carry over", () => {
    const r = merge({ measures: [{ text: "Rate", kpi: "winRate", target: 35 }, { text: "Brand new" }] }, base, "replace");
    expect(r.doc.measures.map((m) => [m.id, m.text])).toEqual([["m2", "Rate"], ["m3", "Brand new"]]);
  });
});

describe("what can't be placed", () => {
  it("warns about a step or person that doesn't match, and still stores the rest", () => {
    const r = merge({
      requirements: [{ text: "Legal signs off", owner: "Nobody Known", step: "Contract signing" }],
      deletes: [{ step: "Contract signing" }, { step: "Qualify lead", agreed_by: "Zed" }],
    });
    expect(r.warnings).toEqual(expect.arrayContaining(["Requirement 'Legal signs off': no single step matches 'Contract signing'.", "Delete candidate: no single step matches 'Contract signing'.", "Delete candidate 'Qualify lead': no single person matches 'Zed'."]));
    expect(r.doc.requirements[0]).toMatchObject({ owner_text: "Nobody Known", step_id: null });
    expect(r.doc.deletes).toEqual([{ step_id: "s-qualify", breaks_if_removed: "", agreed_by: null, added_back: false }]);
  });

  it("names the candidates for an ambiguous step, once", () => {
    const r = merge({ requirements: [{ text: "R", step: "audit" }] });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("Audit & proposal");
    expect(r.warnings[0]).toContain("Audit review");
    expect(r.doc.requirements[0]!.step_id).toBeNull();
  });

  it("refuses a list that would grow past its limit", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ text: `Statement ${i}` }));
    expect(() => merge({ statements: many })).toThrow(ImportError);
  });

  it("drops blank items and clears an owner when given null", () => {
    const base = merge({ requirements: [{ text: "R", owner: "Maya" }] }).doc;
    expect(merge({ requirements: [{ text: "  " }] }, base).changed).toEqual([]);
    expect(merge({ requirements: [{ text: "R", owner: null }] }, base).doc.requirements[0]).toMatchObject({ owner_person_id: null, owner_text: "" });
  });
});
