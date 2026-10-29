// The leak-check cases of a scenario share link (sandbox phase 5b, docs/plans/sandbox-p5-brief.md section 11.2), as one table that both twins run:
// `shareSnapshotLeaks` (packages/db/src/share.ts, in share-snapshot.test.ts) and `private.share_snapshot_problem` (the migration
// 20270116000000, in share-links.test.ts). Each case edits a clean scenario snapshot and says which leak it must be refused for, or none.

export type Json = Record<string, unknown>;
export type Expected = null | "mismatch" | "email" | "person" | "client" | "costs";
export interface ScenarioCase {
  name: string;
  people?: boolean;
  financials?: boolean;
  /** Edits the clean snapshot (a deep copy) in place. */
  edit?: (s: Json) => void;
  expect: Expected;
}

export const A = "5c000000-0000-4000-8000-0000000000a1";
export const B = "5c000000-0000-4000-8000-0000000000a2";
export const ROLE = "5c000000-0000-4000-8000-0000000000b1";
const change = (n: number, lever: string, over: Json = {}): Json => ({ id: `5c000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, lever, target: null, op: "multiply", value: 1.1, ...over });

/** A clean scenario snapshot for a link with these toggles: the parent (a role cost and overheads only when Financials is on), the shared scenario. */
export function cleanScenario(toggles: { people: boolean; financials: boolean }): Json {
  return {
    v: 1,
    kind: "scenario",
    toggles,
    workspaceName: "Workspace",
    scenarioId: B,
    bundle: { process: { id: "5c000000-0000-4000-8000-0000000000c1" } },
    scenarios: [
      { id: A, name: "Base plan", description: "What we expect", parent_id: null, horizon_months: 12, changes: toggles.financials ? [change(1, "C1", { target: ROLE, note: "Pay review" }), change(2, "C2", { op: "set", value: 9000 })] : [change(5, "A3", { value: 1.05 })] },
      { id: B, name: "Hire in March", description: null, parent_id: A, horizon_months: 12, changes: [change(3, "D1", { target: ROLE, op: "set", value: 1, from: "2027-03", note: "Assumes a hire by March" }), change(4, "A1", { note: "Assumes leads double" })] },
    ],
    solutions: [],
    startDate: "2027-01-04",
    months: 12,
    hiddenCostChanges: toggles.financials ? 0 : 2,
  };
}

const rows = (s: Json) => s.scenarios as Json[];
const changesOf = (s: Json, i: number) => rows(s)[i]!.changes as Json[];
const at = (s: Json, i: number, j: number) => changesOf(s, i)[j]!;

export function scenarioCases(names: { person: string; client: string; email: string }): ScenarioCase[] {
  const { person, client, email } = names;
  const first = person.split(" ")[0]!;
  const nested = (key: string, value: unknown) => (s: Json) => {
    s.extra = { deep: [{ [key]: value }] };
  };
  return [
    { name: "a clean snapshot, both toggles off", expect: null },
    { name: "a clean snapshot, People on", people: true, expect: null },
    { name: "a clean snapshot, Financials on (the role cost and overheads stay)", financials: true, expect: null },
    { name: "a clean snapshot, both on", people: true, financials: true, expect: null },
    // The six keys, by format at every depth.
    { name: "lever holding words", edit: (s) => { at(s, 1, 1).lever = "Tom Price"; }, expect: "mismatch" },
    { name: "lever that is not a lever id (Z9)", edit: nested("lever", "Z9"), expect: "mismatch" },
    { name: "lever as an array", edit: nested("lever", ["A1"]), expect: "mismatch" },
    { name: "lever as an object", edit: nested("lever", { a: "A1" }), expect: "mismatch" },
    { name: "lever of a legal shape, nested", edit: nested("lever", "B5"), expect: null },
    { name: "target holding words", edit: (s) => { at(s, 1, 0).target = `Call ${first}`; }, expect: "mismatch" },
    { name: "target holding the client's name", edit: nested("target", client), expect: "mismatch" },
    { name: "target as an array of words", edit: nested("target", [first]), expect: "mismatch" },
    { name: "target as an array of legal ids", edit: nested("target", [ROLE]), expect: "mismatch" },
    { name: "target as an object", edit: nested("target", { x: 1 }), expect: "mismatch" },
    { name: "target in a different case", edit: nested("target", "@Busiest"), expect: "mismatch" },
    { name: "target with a trailing line break", edit: nested("target", "@busiest\n"), expect: "mismatch" },
    { name: "target @busiest", edit: nested("target", "@busiest"), expect: null },
    { name: "target @heaviest", edit: nested("target", "@heaviest"), expect: null },
    { name: "target a health rule", edit: nested("target", "late_penalty"), expect: null },
    { name: "target a built-in churn driver", edit: nested("target", "handoff"), expect: null },
    { name: "target a custom driver", edit: nested("target", "custom:5c000000-0000-4000-8000-0000000000d1"), expect: null },
    { name: "target a number (a first-principles measure has one)", edit: nested("target", 0.9), expect: null },
    { name: "target null", edit: nested("target", null), expect: null },
    { name: "from holding words", edit: nested("from", "next Tuesday, ask " + first), expect: "mismatch" },
    { name: "from a month", edit: nested("from", "2027-03"), expect: null },
    { name: "from a day", edit: nested("from", "2027-03-01"), expect: null },
    { name: "from month 13", edit: nested("from", "2027-13"), expect: "mismatch" },
    { name: "from outside 2000 to 2100", edit: nested("from", "2101-01"), expect: "mismatch" },
    { name: "from as an array", edit: nested("from", ["2027-03"]), expect: "mismatch" },
    { name: "parent_id holding words", edit: nested("parent_id", first), expect: "mismatch" },
    { name: "parent_id as an object", edit: nested("parent_id", { a: A }), expect: "mismatch" },
    { name: "parent_id null", edit: nested("parent_id", null), expect: null },
    { name: "scenarioId holding words", edit: nested("scenarioId", first), expect: "mismatch" },
    { name: "startDate holding words", edit: nested("startDate", `from ${first}`), expect: "mismatch" },
    { name: "startDate one digit short", edit: nested("startDate", "2027-1-04"), expect: "mismatch" },
    { name: "a top-level startDate that isn't a date", edit: (s) => { s.startDate = "2027-1-4"; }, expect: "mismatch" },
    // The scenario link's own shape.
    { name: "no scenarios", edit: (s) => { s.scenarios = []; }, expect: "mismatch" },
    { name: "scenarios not a list", edit: (s) => { s.scenarios = rows(s)[0]; }, expect: "mismatch" },
    { name: "seven scenarios", edit: (s) => { s.scenarios = Array.from({ length: 7 }, (_, i) => ({ id: `5c000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`, name: "x", description: null, parent_id: i === 0 ? null : `5c000000-0000-4000-8000-0000000002${String(i - 1).padStart(2, "0")}`, horizon_months: 12, changes: [] })); s.scenarioId = "5c000000-0000-4000-8000-000000000206"; }, expect: "mismatch" },
    { name: "six scenarios in a chain", edit: (s) => { s.scenarios = Array.from({ length: 6 }, (_, i) => ({ id: `5c000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`, name: "x", description: null, parent_id: i === 0 ? null : `5c000000-0000-4000-8000-0000000002${String(i - 1).padStart(2, "0")}`, horizon_months: 12, changes: [] })); s.scenarioId = "5c000000-0000-4000-8000-000000000205"; }, expect: null },
    { name: "scenarioId is not the last scenario", edit: (s) => { s.scenarioId = A; }, expect: "mismatch" },
    { name: "the first scenario has a parent", edit: (s) => { rows(s)[0]!.parent_id = B; }, expect: "mismatch" },
    { name: "a scenario that doesn't build on the one before it", edit: (s) => { rows(s)[1]!.parent_id = null; }, expect: "mismatch" },
    { name: "two scenarios with the same id", edit: (s) => { rows(s)[0]!.id = B; rows(s)[1]!.parent_id = B; }, expect: "mismatch" },
    { name: "a change the database would not store (unknown lever Z9)", edit: (s) => { at(s, 1, 1).lever = "Z9"; }, expect: "mismatch" },
    { name: "a change with an extra key", edit: (s) => { at(s, 1, 1).secret = "x"; }, expect: "mismatch" },
    { name: "a change with an untrimmed note", edit: (s) => { at(s, 1, 1).note = " leading space"; }, expect: "mismatch" },
    { name: "changes not a list", edit: (s) => { rows(s)[1]!.changes = {}; }, expect: "mismatch" },
    { name: "a scenario without a name", edit: (s) => { delete rows(s)[1]!.name; }, expect: "mismatch" },
    { name: "no bundle", edit: (s) => { delete s.bundle; }, expect: "mismatch" },
    { name: "solutions not a list", edit: (s) => { s.solutions = {}; }, expect: "mismatch" },
    { name: "months 0", edit: (s) => { s.months = 0; }, expect: "mismatch" },
    { name: "months 25", edit: (s) => { s.months = 25; }, expect: "mismatch" },
    { name: "months 24", edit: (s) => { s.months = 24; }, expect: null },
    { name: "months 12.5", edit: (s) => { s.months = 12.5; }, expect: "mismatch" },
    { name: "months as a string", edit: (s) => { s.months = "12"; }, expect: "mismatch" },
    { name: "hiddenCostChanges negative", edit: (s) => { s.hiddenCostChanges = -1; }, expect: "mismatch" },
    { name: "hiddenCostChanges fractional", edit: (s) => { s.hiddenCostChanges = 1.5; }, expect: "mismatch" },
    { name: "hiddenCostChanges as a string", edit: (s) => { s.hiddenCostChanges = "2"; }, expect: "mismatch" },
    { name: "hiddenCostChanges missing", edit: (s) => { delete s.hiddenCostChanges; }, expect: "mismatch" },
    // People off: no candidate's name on a hire.
    { name: "People off: a hire with a name", edit: (s) => { at(s, 1, 0).params = { name: "Jade" }; }, expect: "person" },
    { name: "People off: a hire with a name that is a person's", edit: (s) => { at(s, 1, 0).params = { name: person }; }, expect: "person" },
    { name: "People on: a hire with a candidate's name is fine", people: true, edit: (s) => { at(s, 1, 0).params = { name: "Jade" }; }, expect: null },
    { name: "People off: a person's name in a note", edit: (s) => { at(s, 1, 1).note = `Assumes ${person} agrees`; }, expect: "person" },
    { name: "People off: a surname on its own in the description", edit: (s) => { rows(s)[0]!.description = `${person.split(" ").slice(-1)[0]} wrote it`; }, expect: "person" },
    { name: "People on: a person's name in a note is fine", people: true, edit: (s) => { at(s, 1, 1).note = `Assumes ${person} agrees`; }, expect: null },
    { name: "a client's name in a note, whatever the toggles", people: true, financials: true, edit: (s) => { at(s, 1, 1).note = `Assumes ${client} renews`; }, expect: "client" },
    { name: "a client's name in the scenario's name", edit: (s) => { rows(s)[1]!.name = `Plan for ${client}`; }, expect: "client" },
    { name: "an email in a note, whatever the toggles", people: true, financials: true, edit: (s) => { at(s, 1, 1).note = `Mail ${email}`; }, expect: "email" },
    // Financials off: no role cost, overheads or money in text.
    { name: "Financials off: a role cost change (C1)", edit: (s) => { changesOf(s, 0).push(change(9, "C1", { target: ROLE })); }, expect: "costs" },
    { name: "Financials off: an overheads change (C2)", edit: (s) => { changesOf(s, 1).push(change(9, "C2", { op: "set", value: 5000 })); }, expect: "costs" },
    { name: "Financials off: money in a note", edit: (s) => { at(s, 1, 1).note = "Costs about £4,100 a month"; }, expect: "costs" },
    { name: "Financials off: money in the description", edit: (s) => { rows(s)[0]!.description = "Budget 3,200 GBP"; }, expect: "costs" },
    { name: "Financials on: money in a note is fine", financials: true, edit: (s) => { at(s, 1, 1).note = "Costs about £4,100 a month"; }, expect: null },
    { name: "Financials off: a rate change inside a solution's lever changes", edit: (s) => { s.solutions = [{ id: A, lever_changes: [{ path: "roles.x.cost_rate", op: "set", value: 70 }] }]; }, expect: "costs" },
    { name: "Financials off: an overheads change inside a solution's lever changes", edit: (s) => { s.solutions = [{ id: A, lever_changes: [{ path: "finances.overhead_monthly", op: "set", value: 9000 }] }]; }, expect: "costs" },
    { name: "Financials on: an overheads change inside a solution's lever changes is fine", financials: true, edit: (s) => { s.solutions = [{ id: A, lever_changes: [{ path: "finances.overhead_monthly", op: "set", value: 9000 }] }]; }, expect: null },
  ];
}
