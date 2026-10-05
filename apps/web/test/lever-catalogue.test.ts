import { describe, expect, it } from "vitest";
import { larkspurBundle, northbeamBundle, toEngineModel } from "@transpera-flow/db";
import { ANALYSIS_RULE_IDS } from "@transpera-flow/engine";
import { RULES_UI } from "@/lib/rules/catalogue";
import { cleanHidden, isLeverShown, kindsOf, LEVER_GROUP_ORDER, LEVER_KINDS, leverKind, leverKindId, visibleLevers } from "@/lib/scenarios/lever-catalogue";
import { buildLevers, GROUP_LABELS } from "@/lib/scenarios/levers";
import { horizonLabel, horizonWeeks, isHorizonMonths, monthsForWeeks } from "@/lib/horizon";

// Settings -> Levers (issue #123, A58): the catalogue of levers people can switch on or off, its wording, how the
// sliders on a process page map onto it, and the check that no lever, rule or market setting lacks an (i).

const START = { startDate: "2026-10-05" };
const models = [toEngineModel(northbeamBundle(), START), toEngineModel(larkspurBundle(), START)];

describe("the lever catalogue", () => {
  it("has the prototype's six groups, in order, each with levers", () => {
    expect(LEVER_GROUP_ORDER.map((g) => GROUP_LABELS[g])).toEqual(["Demand", "People", "Process", "Clients and churn", "Finances", "Market"]);
    for (const g of LEVER_GROUP_ORDER) expect(kindsOf(g).length, g).toBeGreaterThan(0);
    expect(LEVER_KINDS).toHaveLength(21);
  });

  it("gives every lever a unique id, a name, a plain description and an example", () => {
    expect(new Set(LEVER_KINDS.map((k) => k.id)).size).toBe(LEVER_KINDS.length);
    for (const k of LEVER_KINDS) {
      expect(k.label.trim(), k.id).not.toBe("");
      expect(k.description.trim().length, `${k.id} description`).toBeGreaterThan(10);
      expect(k.example.trim().length, `${k.id} example`).toBeGreaterThan(5);
      expect(k.id.startsWith(`${k.group}.`) || k.group === "clients" || k.group === "market", k.id).toBe(true);
    }
  });

  it("uses the prototype's wording", () => {
    expect(leverKind("process.time")).toMatchObject({
      label: "Time each step takes",
      description: "How long the work itself takes.",
      example: "Writing a proposal takes 2 hours. With a template, 1 hour.",
    });
    expect(leverKind("market.schedule")?.description).toBe("When the market is expected to change over the next 2 years.");
  });

  it("points a lever set on a Settings page at that page", () => {
    for (const k of LEVER_KINDS.filter((x) => x.control === "settings")) {
      expect(k.settingsPath, k.id).toMatch(/^\/settings#/);
      expect(k.settingsLabel, k.id).toBeTruthy();
    }
  });
});

describe("the sliders on a process page map onto it", () => {
  const levers = models.flatMap((m) => buildLevers(m));

  it("puts every generated lever in a lever kind that has a slider", () => {
    expect(levers.length).toBeGreaterThan(40);
    for (const l of levers) {
      const id = leverKindId(l);
      expect(id, l.path).not.toBeNull();
      expect(leverKind(id!)?.control, l.path).toBe("slider");
      expect(leverKind(id!)?.group, l.path).toBe(l.group);
    }
  });

  it("gives every lever kind marked as a slider at least one slider", () => {
    const used = new Set(levers.map((l) => leverKindId(l)));
    for (const k of LEVER_KINDS.filter((x) => x.control === "slider")) expect(used.has(k.id), k.id).toBe(true);
  });

  it("hides every slider of a kind that is switched off, and only those", () => {
    const all = buildLevers(models[0]!);
    const shown = visibleLevers(all, ["process.time"]);
    expect(shown.some((l) => leverKindId(l) === "process.time")).toBe(false);
    expect(shown).toHaveLength(all.filter((l) => leverKindId(l) !== "process.time").length);
    expect(visibleLevers(all, [])).toEqual(all);
    expect(isLeverShown({ path: "demand.leads_per_week" }, ["demand.enquiries"])).toBe(false);
    expect(isLeverShown({ path: "demand.leads_per_week" }, ["process.time"])).toBe(true);
    // A lever the catalogue doesn't know always shows.
    expect(isLeverShown({ path: "something.new" }, LEVER_KINDS.map((k) => k.id))).toBe(true);
  });

  it("keeps only real lever ids when cleaning a saved list", () => {
    expect(cleanHidden(["finances.prices", "nope", 3, "process.time", "process.time"])).toEqual(["process.time", "finances.prices"]);
    expect(cleanHidden([])).toEqual([]);
  });
});

describe("no lever, rule or market setting is without an (i)", () => {
  // The rules' own settings (cut-offs, escalators, money) went with the rules editor in B17; each rule keeps its help.
  it("has a description and example for every analysis rule", () => {
    for (const id of ANALYSIS_RULE_IDS) {
      expect(RULES_UI[id].help.description.trim().length, id).toBeGreaterThan(10);
      expect(RULES_UI[id].help.example.trim().length, id).toBeGreaterThan(5);
    }
  });
});

describe("the horizon picker", () => {
  it("counts a month as a twelfth of 52 weeks", () => {
    expect([1, 3, 6, 12, 24].map(horizonWeeks)).toEqual([4, 13, 26, 52, 104]);
    expect(monthsForWeeks(13)).toBe(3);
    expect(monthsForWeeks(104)).toBe(24);
    expect(monthsForWeeks(20)).toBeNull();
    expect(isHorizonMonths(24)).toBe(true);
    expect(isHorizonMonths(2)).toBe(false);
    expect(horizonLabel(1)).toBe("1 month");
    expect(horizonLabel(24)).toBe("24 months");
  });
});
