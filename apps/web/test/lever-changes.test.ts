import { describe, expect, it } from "vitest";
import type { ScenarioPatch } from "@transpera-flow/engine";
import { describeLeverChange, describeLeverChanges, percentChange } from "@/lib/suggestions/lever-changes";

// A lever change in words (B4), for every family of change a visitor can send.

const names = { steps: { s1: "Check fit", s2: "Proposal" }, roles: { r1: "Strategist" }, services: { v1: "SEO retainer" }, people: { p1: "Marta Okoye" } };
const patch = (path: string, op: "set" | "multiply" | "add", value: number): ScenarioPatch => ({ path, op, value });

describe("describeLeverChange", () => {
  it("describes every family", () => {
    const cases: [ScenarioPatch, string][] = [
      [patch("demand.leads_per_week", "set", 12), "Leads per week: 12"],
      [patch("demand.active_clients", "set", 40), "Active clients: 40"],
      [patch("demand.churn_monthly", "set", 0.03), "Monthly churn: 3%"],
      [patch("demand.churn_monthly", "set", 0.0125), "Monthly churn: 1.3%"],
      [patch("finances.retainer", "set", 2500), "Monthly retainer: £2,500"],
      [patch("services.v1.price", "set", 1800), "Price of SEO retainer: £1,800"],
      [patch("roles.r1.headcount", "set", 3), "Strategist: 3 people"],
      [patch("roles.r1.headcount", "set", 1), "Strategist: 1 person"],
      [patch("people.p1.fte", "set", 0.8), "Hours for Marta Okoye: 0.8 FTE"],
      [patch("steps.s1.work_hours", "multiply", 0.8), "Hands-on time on Check fit: −20%"],
      [patch("steps.s1.work_hours", "multiply", 1.25), "Hands-on time on Check fit: +25%"],
      [patch("steps.s1.wait_hours", "set", 4), "Wait before Check fit: 4 h"],
      [patch("steps.s1.wait_hours", "multiply", 0.5), "Wait before Check fit: −50%"],
      [patch("steps.s2.rework_rate", "set", 0.1), "Rework on Proposal: 10%"],
      [patch("steps.s2.rework_rate", "multiply", 1), "Rework on Proposal: no change"],
    ];
    for (const [p, text] of cases) expect(describeLeverChange(p, names), text).toBe(text);
  });

  it("uses the workspace's currency", () => {
    expect(describeLeverChange(patch("demand.leads_per_week", "set", 1))).toBe("Leads per week: 1");
    expect(describeLeverChange(patch("finances.retainer", "set", 2500), {}, "USD")).toContain("$2,500");
  });

  it("an id that has gone reads as what it was", () => {
    expect(describeLeverChange(patch("steps.zzz.work_hours", "multiply", 0.5), names)).toBe("Hands-on time on a step that has gone: −50%");
    expect(describeLeverChange(patch("roles.zzz.headcount", "set", 2), names)).toBe("A role that has gone: 2 people");
    expect(describeLeverChange(patch("services.zzz.price", "set", 2), names)).toBe("Price of a service that has gone: £2");
  });

  it("a person's name is used only when the reader may see it (names.people filled); otherwise a team member", () => {
    expect(describeLeverChange(patch("people.p1.fte", "set", 0.8), { ...names, people: undefined })).toBe("Hours for a team member: 0.8 FTE");
    expect(describeLeverChange(patch("people.p2.fte", "set", 0.8), names)).toBe("Hours for a team member: 0.8 FTE");
  });

  it("a path it doesn't know is said plainly, never thrown", () => {
    expect(describeLeverChange(patch("health.initial", "set", 0.5), names)).toBe("A change this version can't describe");
    expect(describeLeverChanges([patch("demand.leads_per_week", "set", 5), patch("x", "set", 1)], names)).toEqual(["Leads per week: 5", "A change this version can't describe"]);
  });

  it("percentChange", () => {
    expect(percentChange(0.9)).toBe("−10%");
    expect(percentChange(2)).toBe("+100%");
    expect(percentChange(1.05)).toBe("+5%");
  });
});
