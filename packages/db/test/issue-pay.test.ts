import { describe, expect, it } from "vitest";
import { OVERTIME_COST_CLAUSE, payFreeIssueFields } from "../src";

// Saved issues carry no pay (B1 2b, issue #30): pure, no database. The migration cleans old rows with the same pattern in
// SQL (saved-text-privacy.test.ts).

const sentence = (money: string, weeks = "26") =>
  `Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average (range 3–5) within the 10% cap, costing about ${money} at cost rates over the ${weeks}-week run. The cap is used up: more client work pushes utilisation past 100%. Rated Bad.`;
const clean = "Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average (range 3–5) within the 10% cap. The cap is used up: more client work pushes utilisation past 100%. Rated Bad.";

describe("payFreeIssueFields", () => {
  it.each([["pound", "£1,040"], ["dollar", "$1,040"], ["Australian dollar", "A$1,040.50"], ["euro", "€9"]])("turns the old %s sentence into a full stop", (_, money) => {
    expect(payFreeIssueFields({ evidence: sentence(money) }).evidence).toBe(clean);
  });

  it("handles a long horizon written with a thousands separator", () => {
    expect(payFreeIssueFields({ evidence: sentence("£70", "1,040") }).evidence).toBe(clean);
  });

  it("drops overtime_cost and keeps every other metric and every other field", () => {
    const out = payFreeIssueFields({
      title: "Ann works 4 h/wk overtime",
      evidence: sentence("£1,040"),
      evidence_metrics: { overtime_hours_week: 4, overtime_cost: 1040, utilisation: 1 },
    });
    expect(out).toEqual({ title: "Ann works 4 h/wk overtime", evidence: clean, evidence_metrics: { overtime_hours_week: 4, utilisation: 1 } });
  });

  it("leaves text without the clause alone, and any other money in it", () => {
    const text = "The retainer is £1,000 a month and costing about nothing.";
    expect(payFreeIssueFields({ evidence: text }).evidence).toBe(text);
    expect(payFreeIssueFields({ evidence: clean }).evidence).toBe(clean);
  });

  it("is idempotent", () => {
    const once = payFreeIssueFields({ evidence: sentence("£1,040"), evidence_metrics: { overtime_cost: 1, a: 2 } });
    expect(payFreeIssueFields(once)).toEqual(once);
  });

  it("leaves null and missing evidence, and non-object metrics, alone", () => {
    expect(payFreeIssueFields({ evidence: null })).toEqual({ evidence: null });
    expect(payFreeIssueFields({})).toEqual({});
    expect(payFreeIssueFields({ evidence_metrics: null })).toEqual({ evidence_metrics: null });
    expect(payFreeIssueFields({ evidence_metrics: [1] })).toEqual({ evidence_metrics: [1] });
  });

  it("does not change the object it is given", () => {
    const input = { evidence: sentence("£1"), evidence_metrics: { overtime_cost: 1 } };
    const copy = JSON.parse(JSON.stringify(input));
    payFreeIssueFields(input);
    expect(input).toEqual(copy);
  });

  it("strips every clause in a text, not just the first", () => {
    expect(payFreeIssueFields({ evidence: `${sentence("£1")} ${sentence("£2")}` }).evidence).toBe(`${clean} ${clean}`);
  });

  it("exports the pattern the migration repeats", () => {
    expect(OVERTIME_COST_CLAUSE.source).toBe(", costing about .+? at cost rates over the [\\d,]+-week run\\.");
  });
});
