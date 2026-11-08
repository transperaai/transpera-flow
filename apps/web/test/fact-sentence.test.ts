import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DetectedIssue } from "@transpera-flow/engine";
import { FactsList } from "@/components/facts-list";
import { factSentence, type FactNames } from "@/lib/insights/fact-sentence";

// Facts from the run, one plain sentence each (Q3 item 4): the sentence for each rule kind, worked out by hand from the
// engine's metrics, with at most one number in it; the list shows the three worst and the rest behind "Show all N".

const names: FactNames = {
  step: (id) => ({ s1: "Vet domains", s2: "Write proposal" })[id] ?? null,
  role: (id) => ({ r1: "SEO Manager", r2: "Content team" })[id] ?? null,
  person: (id) => ({ p1: "Karl", p2: "Laura" })[id] ?? null,
};

const fact = (key: string, over: Partial<DetectedIssue> = {}): DetectedIssue =>
  ({ key, type: "capacity", rating: "bad", title: "A title", evidence: "Long evidence. More.", metrics: {}, stepId: null, roleId: null, personId: null, ...over }) as DetectedIssue;

const numbersIn = (s: string) => (s.match(/\d+(\.\d+)?/g) ?? []).length;

describe("the sentence for each rule kind", () => {
  const cases: [string, DetectedIssue, string][] = [
    ["capacity, a person", fact("capacity:person:p1", { personId: "p1", roleId: "r1", metrics: { utilisation: 0.924 } }), "Karl is busy 92% of the time"],
    ["capacity, a role", fact("capacity:role:r2", { roleId: "r2", metrics: { utilisation: 1.05 } }), "Content team is busy 105% of the time"],
    ["capacity, client work alone", fact("capacity:role:r1", { roleId: "r1", title: "SEO Manager: client work alone exceeds capacity", metrics: { utilisation: 1.4 } }), "SEO Manager's client work alone is more than the time the team has"],
    ["overtime", fact("overtime:person:p2", { personId: "p2", metrics: { overtime_hours_week: 6.25 } }), "Laura works 6.3 h a week of overtime"],
    ["queue", fact("queue:step:s2", { stepId: "s2", metrics: { queue_growth_week: 2 } }), "Work keeps piling up at Write proposal"],
    ["wait (its own title)", fact("wait:step:s1", { stepId: "s1", title: "Work waits 3.2 working days for Vet domains" }), "Work waits 3.2 working days for Vet domains"],
    ["rework (its own title)", fact("rework:step:s2", { stepId: "s2", title: "12% of Write proposal is done twice" }), "12% of Write proposal is done twice"],
    ["drop-off (its own title)", fact("dropoff:step:s2", { stepId: "s2", title: "30% of work is lost at Write proposal" }), "30% of work is lost at Write proposal"],
    ["sla", fact("sla:step:s1", { stepId: "s1", title: "Vet domains misses its 24 h SLA 31% of the time", metrics: { breach_share: 0.31, sla_hours: 24 } }), "Vet domains misses its deadline 31% of the time"],
    ["single point of failure, a named person", fact("spof:step:s1", { stepId: "s1", personId: "p1", roleId: "r1", metrics: { work_lost: 0.4 } }), "Only Karl can do Vet domains: if they're away, that work stops"],
    ["single point of failure, a role", fact("spof:step:s2", { stepId: "s2", roleId: "r2" }), "Only one Content team can do Write proposal: if they're away, that work stops"],
    ["cycle time", fact("cycle:process:pipeline", { metrics: { target_ratio: 2.14 } }), "Takes 2.1× its target time end to end"],
    ["goal not met (its own title)", fact("success:measure:m1", { title: "Goal not reliably met: Win rate" }), "Goal not reliably met: Win rate"],
    ["spare time", fact("spare:person:p2", { personId: "p2", metrics: { free_hours_week: 8.6 } }), "Laura has about 9 h a week free"],
    ["churn risk (its own title)", fact("churn_risk:client:c1", { title: "Harbourline: health falling, at risk of churning" }), "Harbourline: health falling, at risk of churning"],
    ["forecast", fact("forecast:role:r1", { title: "SEO Manager gets too busy in Mar (92% on average)" }), "SEO Manager gets too busy in Mar"],
    ["forecast, uncovered", fact("forecast:uncovered:r1", { title: "Uncovered from Mar: no one in Content team to do 40 hours of work a week" }), "Uncovered from Mar: no one in Content team to do 40 hours of work a week"],
  ];

  it.each(cases)("%s", (_name, f, expected) => {
    expect(factSentence(f, names)).toBe(expected);
  });

  it("has at most one number in each (a month name is not one)", () => {
    for (const [name, f] of cases) expect(numbersIn(factSentence(f, names)), name).toBeLessThanOrEqual(1);
  });

  it("falls back to the title when the numbers it needs are missing, and says 'this step' for an unknown step", () => {
    expect(factSentence(fact("capacity:person:p1", { title: "Karl at 92% utilisation", personId: "p1" }), names)).toBe("Karl at 92% utilisation");
    expect(factSentence(fact("queue:step:zz", { stepId: "zz" }), names)).toBe("Work keeps piling up at this step");
    expect(factSentence(fact("something_new:x:1", { title: "Whatever it is" }), names)).toBe("Whatever it is");
  });
});

describe("the facts list", () => {
  const many = Array.from({ length: 7 }, (_, i) => fact(`queue:step:s${i}`, { stepId: "s1", rating: i === 0 ? "risk" : "bad" }));
  it("shows the three worst, a dot with its rating for screen readers, and 'Show all N' for the rest", () => {
    const html = renderToStaticMarkup(createElement(FactsList, { facts: many, names }));
    expect(html.match(/data-fact="/g)).toHaveLength(3);
    expect(html).toContain("Show all 7");
    expect(html).toContain("Operational risk: ");
  });
  it("has no 'Show all' for three or fewer, and says so for none", () => {
    expect(renderToStaticMarkup(createElement(FactsList, { facts: many.slice(0, 3), names }))).not.toContain("Show all");
    expect(renderToStaticMarkup(createElement(FactsList, { facts: [], names }))).toContain("Nothing stands out");
  });
  it("keeps each row to the sentence: no source, step, cost or evidence text", () => {
    const html = renderToStaticMarkup(createElement(FactsList, { facts: [fact("queue:step:s1", { stepId: "s1", evidence: "Long evidence text." })], names }));
    expect(html).not.toContain("Long evidence text");
    expect(html).toContain("Work keeps piling up at Vet domains");
  });
});
