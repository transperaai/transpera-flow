import { describe, expect, it } from "vitest";
import { checkCapacityInputs, larkspurModel, northbeamModel, northbeamWithClientGroups, northbeamWithServicing, type CapacityProblemCode, type EngineModel } from "../src";

// The input check for the capacity fields: one case per problem the brief names, a clean model, and the existing fixtures,
// which set none of the new fields and so have no problems.

/** A small valid model that sets the new fields. */
function valid(): EngineModel {
  return {
    horizonWeeks: 13, hoursPerWeek: 40, leadsPerWeek: 1, activeClients: 0, churnMonthly: 0, retainer: 0,
    roles: { mgr: { name: "Manager", count: 1, cost: 0, ongoing: 0, unit: { label: "tasks", perHour: 2 } }, wr: { name: "Writers", count: 1, cost: 0, ongoing: 0 } },
    services: {
      orgT1: {
        name: "Organic Tier 1", pricingModel: "retainer", price: 11000, margin: 0, tenureMonths: 24, churnMonthly: 0.01, mixShare: 1, pathTags: [],
        department: "org", tier: "T1", deliverables: { words: 4000, links: 8 }, adhoc: { chance: 0.9, requests: 6.5 },
        servicing: [{ process: "serv", recurrence: { perMonth: 1, driver: "words", per: 1000 }, sla: 40 }],
      },
    },
    clientGroups: { orgT1: { count: 10, fee: 11000, churnMonthly: 0.01, stayMonths: 24, health: 80 } },
    clients: { n1: { name: "Harbourline", services: ["orgT1"], mrr: 13000, assignments: {}, manager: "laura", overrides: { adhocChance: 1, adhocRequests: 8, stepFactor: { s1: 1.2 } }, handHoldingHours: { mgr: 3 } } },
    people: { laura: { name: "Laura", roles: ["mgr"], capacity: 38, reservedShare: 0.35, ramp: [0.4, 0.6], tiers: ["T1"], portfolio: { orgT1: 4 } } },
    servicingProcesses: { serv: { name: "Serving", entry: "s1", steps: ["s1"] } },
    changes: [{ id: "c1", name: "Pacing tool", kind: "automation", adoption: 0.8, startMonth: 2, rampMonths: 1, effects: [{ step: "s1", part: "automatable", remove: 0.9, residualHours: 0.05 }] }],
    entry: "s1", sinks: { won: "won", lost: "lost" }, ends: { done: { outcome: "done" } },
    steps: [{ id: "s1", name: "Pacing", role: "mgr", toClientManager: true, work: 0.9, split: { automatable: 0.7, augmentable: 0.2, manual: 0.1 }, tierMultiplier: { T1: 1.3 }, wait: 0, rework: 0, next: [{ to: "done", p: 1 }] }],
  };
}

const codes = (m: EngineModel): CapacityProblemCode[] => checkCapacityInputs(m).map((p) => p.code);

describe("checkCapacityInputs", () => {
  it("finds nothing wrong in a valid model that sets the new fields", () => {
    expect(checkCapacityInputs(valid())).toEqual([]);
  });

  it("finds nothing in models that set none of them", () => {
    for (const m of [northbeamModel(), northbeamWithServicing(), northbeamWithClientGroups(), larkspurModel()]) expect(checkCapacityInputs(m)).toEqual([]);
  });

  it("names a split that doesn't add to 1, and lets one within 0.001 through", () => {
    const m = valid();
    m.steps[0]!.split = { automatable: 0.7, augmentable: 0.2, manual: 0.2 };
    const [p] = checkCapacityInputs(m);
    expect(p).toMatchObject({ code: "split_not_one", where: "steps.s1.split" });
    expect(p!.message).toBe("Pacing: the work split adds up to 1.1, not 1 (automatable 0.7, augmentable 0.2, manual 0.2). Make the three shares add to 100%.");
    m.steps[0]!.split = { automatable: 0.7, augmentable: 0.2, manual: 0.1009 };
    expect(codes(m)).toEqual([]);
    m.steps[0]!.split = { automatable: 0.7, augmentable: 0.2, manual: 0.1011 };
    expect(codes(m)).toEqual(["split_not_one"]);
  });

  it("names negative and non-finite values wherever a number is entered", () => {
    const cases: [string, (m: EngineModel) => void][] = [
      ["services.orgT1.deliverables.words", (m) => { m.services!.orgT1!.deliverables!.words = -1; }],
      ["services.orgT1.deliverables.links", (m) => { m.services!.orgT1!.deliverables!.links = Number.NaN; }],
      ["services.orgT1.adhoc.requests", (m) => { m.services!.orgT1!.adhoc!.requests = Infinity; }],
      ["services.orgT1.adhoc.chance", (m) => { m.services!.orgT1!.adhoc!.chance = 1.5; }],
      ["clients.n1.overrides.adhocRequests", (m) => { m.clients!.n1!.overrides!.adhocRequests = -2; }],
      ["clients.n1.overrides.stepFactor.s1", (m) => { m.clients!.n1!.overrides!.stepFactor = { s1: -1 }; }],
      ["clients.n1.handHoldingHours.mgr", (m) => { m.clients!.n1!.handHoldingHours!.mgr = -3; }],
      ["people.laura.reservedShare", (m) => { m.people!.laura!.reservedShare = 1.2; }],
      ["people.laura.ramp.1", (m) => { m.people!.laura!.ramp = [0.4, -0.6]; }],
      ["people.laura.portfolio.orgT1", (m) => { m.people!.laura!.portfolio = { orgT1: -1 }; }],
      ["roles.mgr.unit.perHour", (m) => { m.roles.mgr!.unit = { label: "tasks", perHour: -1 }; }],
      ["steps.s1.work", (m) => { m.steps[0]!.work = -0.5; }],
      ["steps.s1.tierMultiplier.T1", (m) => { m.steps[0]!.tierMultiplier = { T1: Number.NaN }; }],
      ["changes.0.effects.0.remove", (m) => { m.changes![0]!.effects = [{ step: "s1", part: "automatable", remove: 1.5 }]; }],
      ["changes.0.rampMonths", (m) => { m.changes![0]!.rampMonths = -1; }],
      ["services.orgT1.servicing.0.recurrence.perMonth", (m) => { m.services!.orgT1!.servicing![0]!.recurrence = { perMonth: -1, driver: "words" }; }],
    ];
    for (const [where, edit] of cases) {
      const m = valid();
      edit(m);
      const found = checkCapacityInputs(m);
      expect(found.map((p) => p.where), where).toContain(where);
      expect(found.find((p) => p.where === where)!.code).toBe("bad_number");
    }
  });

  it("names adoption outside 0-1", () => {
    for (const adoption of [80, -0.1, Number.NaN]) {
      const m = valid();
      m.changes![0]!.adoption = adoption;
      expect(checkCapacityInputs(m)).toMatchObject([{ code: "adoption_out_of_range", where: "changes.0.adoption" }]);
    }
    const m = valid();
    m.changes![0]!.adoption = 1;
    expect(codes(m)).toEqual([]);
    m.changes![0]!.adoption = 0;
    expect(codes(m)).toEqual([]);
  });

  it("names a change on an unknown step, and says which", () => {
    const m = valid();
    m.changes![0]!.effects = [{ step: "p1", part: "augmentable", factor: 1.5 }];
    const [p] = checkCapacityInputs(m);
    expect(p).toMatchObject({ code: "change_unknown_step", where: "changes.0.effects.0.step" });
    expect(p!.message).toContain('"p1"');
    expect(p!.message).toContain("Pacing tool");
  });

  it("names an augmentation with a factor under 1, and allows exactly 1", () => {
    const m = valid();
    m.changes![0]!.effects = [{ step: "s1", part: "augmentable", factor: 0.8 }];
    expect(checkCapacityInputs(m)).toMatchObject([{ code: "augmentation_slower", where: "changes.0.effects.0.factor" }]);
    m.changes![0]!.effects = [{ step: "s1", part: "augmentable", factor: 1 }];
    expect(codes(m)).toEqual([]);
  });

  it("names portfolios that add up to more than a group's count, and says who holds what", () => {
    const m = valid();
    m.people!.karl = { name: "Karl", roles: ["mgr"], capacity: 38, portfolio: { orgT1: 6 } };
    expect(codes(m)).toEqual([]); // 4 + 6 = 10 of 10
    m.people!.karl!.portfolio = { orgT1: 7 };
    const [p] = checkCapacityInputs(m);
    expect(p).toMatchObject({ code: "portfolio_over_count", where: "clientGroups.orgT1" });
    expect(p!.message).toBe("People hold 11 Organic Tier 1 clients between them (Laura 4, Karl 7), but only 10 are counted. Lower someone's number or raise the count.");
  });

  it("names toClientManager on a step with no role", () => {
    const m = valid();
    m.steps[0]!.role = null;
    expect(checkCapacityInputs(m)).toMatchObject([{ code: "manager_step_without_role", where: "steps.s1" }]);
  });

  it("names a driver recurrence on a service with no deliverables, and an ad-hoc driver with no ad-hoc rule", () => {
    const m = valid();
    delete m.services!.orgT1!.deliverables;
    expect(checkCapacityInputs(m)).toMatchObject([{ code: "driver_without_deliverables", where: "services.orgT1.servicing.0.recurrence" }]);
    const a = valid();
    a.services!.orgT1!.servicing![0]!.recurrence = { perMonth: 1, driver: "adhoc" };
    delete a.services!.orgT1!.adhoc;
    expect(codes(a)).toEqual(["driver_without_deliverables"]);
  });

  it("reports every problem, not just the first", () => {
    const m = valid();
    m.steps[0]!.role = null;
    m.changes![0]!.adoption = 2;
    m.steps[0]!.split = { automatable: 1, augmentable: 1, manual: 0 };
    expect(codes(m).sort()).toEqual(["adoption_out_of_range", "manager_step_without_role", "split_not_one"]);
  });
});
