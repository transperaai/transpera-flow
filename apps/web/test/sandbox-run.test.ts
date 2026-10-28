import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { northbeamPersonIds, northbeamRoleIds, northbeamStepIds, type ProcessBundle, type SandboxChange, type SandboxScenarioRow, type SolutionRow } from "@transpera-flow/db";
import { applyPatches, simulate, type MonthBusy, type MonthlyResult, type Stat } from "@transpera-flow/engine";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_SOLUTION_ID, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { addMonths, dateAtPosition, hoursToDate, monthBounds, positionOfDate, stepDate } from "@/lib/forecast/positions";
import { spliceMonthly } from "@/lib/forecast/splice";
import { timelineData } from "@/lib/forecast/timeline";
import { solutionCopy } from "@/lib/solutions/bundle";
import { DEMO_SCENARIOS, DEMO_THEN_LEADS_ID, deleteDemoScenario, demoScenariosNow, resetDemoScenarios, saveDemoScenario } from "@/lib/sandbox/demo";
import { descendantsOf, effectiveChanges, effectiveLimitProblem, type EffectiveChange } from "@/lib/sandbox/effective";
import { laneMarkers } from "@/lib/sandbox/lane";
import { applyPeopleChanges, hireNames, leaveEnd, MAX_SEGMENTS, scenarioModel, scenarioSegments, withSolution } from "@/lib/sandbox/run";
import { SANDBOX_CHANGED_ELSEWHERE, sandboxFailure } from "@/lib/sandbox/save-errors";
import { parseSandboxInput } from "@/lib/sandbox/validate";

// The Sandbox's pure logic (docs/plans/sandbox-p1-brief.md §3, §6): effective changes, changes become people and leave in the bundle,
// a patch from a month or a solution going live is a spliced run, and a change that cannot apply is skipped and listed; positions, the
// demo's scenarios and the save messages. (The checks the database makes are in packages/db/test/sandbox-scenarios.test.ts.)

const START = DEMO_FORECAST_START;
const HPW = 40;
const PPC = northbeamRoleIds.ppc;
const DAN = northbeamPersonIds["Dan Okafor"]!;
const LEAH = northbeamPersonIds["Leah Brooks"]!;
const id = () => randomUUID();
/** `date` is an ISO date; a hire or a solution goes by its month (`from` is "YYYY-MM"), leave by its Monday. */
const hire = (date: string, extra: Record<string, unknown> = {}): SandboxChange => ({ id: id(), lever: "D1", target: PPC, op: "set", value: 1, from: date.slice(0, 7), ...extra }) as SandboxChange;
const leave = (date: string, weeks: number, person = DAN): SandboxChange => ({ id: id(), lever: "D3", target: person, op: "set", value: weeks, from: date });
const solution = (date: string, solutionId = DEMO_FORECAST_SOLUTION_ID): SandboxChange => ({ id: id(), lever: "E6", target: solutionId, op: "set", value: 1, from: date.slice(0, 7) });
const leaver = (person: string, date?: string): SandboxChange => ({ id: id(), lever: "D2", target: person, op: "set", value: 0, ...(date ? { from: date.slice(0, 7) } : {}) });
const fte = (person: string, value: number, date?: string, op: SandboxChange["op"] = "set"): SandboxChange => ({ id: id(), lever: "D4", target: person, op, value, ...(date ? { from: date.slice(0, 7) } : {}) });
const patch = (lever: SandboxChange["lever"], target: string | null, op: SandboxChange["op"], value: number, date?: string): SandboxChange => ({ id: id(), lever, target, op, value, ...(date ? { from: date.slice(0, 7) } : {}) });
const eff = (changes: SandboxChange[], name = "S"): EffectiveChange[] => changes.map((change) => ({ change, scenarioId: "s", scenarioName: name, inherited: false }));

const bundle = demoForecastBundle();
const built = forecastModel(bundle, 12, START);
const live = built.model!;
const monthStarts = built.monthStarts!;
const bounds = monthBounds(monthStarts, live.horizonWeeks * live.hoursPerWeek);
const run = (b: ProcessBundle) => {
  const f = forecastModel(b, 12, START);
  if (f.error) throw new Error(f.error);
  return simulate(f.model!, 30, 1, { monthly: true, monthStarts: f.monthStarts! });
};
const segs = (changes: SandboxChange[], solutions: SolutionRow[] = [DEMO_FORECAST_SOLUTION], b: ProcessBundle = bundle) => scenarioSegments(b, eff(changes), solutions, START, bounds, HPW);

describe("parseSandboxInput", () => {
  const ok = (name: string, changes: unknown[], extra: Record<string, unknown> = {}) => parseSandboxInput({ name, changes, ...extra });

  it("accepts a scenario with each kind of change, trims the name and the description, and defaults the horizon to a year", () => {
    const changes = [hire("2027-01-01", { params: { name: "Jade" } }), leave("2026-12-07", 3), solution("2027-04-01"), patch("A1", null, "multiply", 1.25, "2027-05-01")];
    const r = parseSandboxInput({ name: "  Hire in January  ", description: "  why  ", changes });
    expect(r).toMatchObject({ ok: true, value: { name: "Hire in January", description: "why", parent_id: null, horizon_months: 12 } });
    if (r.ok) expect(r.value.changes).toEqual(changes);
  });

  it("refuses what the database refuses, with a plain message", () => {
    const bad: [string, unknown[]][] = [
      ["an unknown lever", [{ ...hire("2027-01-01"), lever: "Z9" }]],
      ["an extra key", [hire("2027-01-01", { rate: 40 })]],
      ["until", [hire("2027-01-01", { until: "2027-09" })]],
      ["not an object", ["hire"]],
      ["no id", [{ lever: "D1", target: PPC, op: "set", value: 1 }]],
      ["a hire from 2027-13", [hire("2027-01-01", { from: "2027-13" })]],
      ["leave on a Wednesday", [leave("2027-03-03", 1)]],
      ["leave with no start", [{ ...leave("2027-03-01", 1), from: undefined }]],
      ["fte 0", [hire("2027-01-01", { value: 0 })]],
      ["fte 2.5", [hire("2027-01-01", { value: 2.5 })]],
      ["weeks 53", [leave("2027-01-04", 53)]],
      ["weeks 1.5", [leave("2027-01-04", 1.5)]],
      ["5 solutions", Array.from({ length: 5 }, (_, i) => solution(i < 4 ? `2027-0${i + 1}-01` : "2027-01-01"))],
      ["201 changes", Array.from({ length: 201 }, () => patch("A1", null, "add", 0))],
      ["7 months", ["01", "02", "03", "04", "05", "06", "07"].map((m) => patch("A1", null, "add", 0, `2027-${m}-01`))],
      ["a name over 120", [hire("2027-01-01", { params: { name: "x".repeat(121) } })]],
    ];
    for (const [what, changes] of bad) expect(ok("S", changes).ok, what).toBe(false);
    expect(ok("S", [leave("2027-03-03", 1)])).toEqual({ ok: false, error: "Leave starts on a Monday." });
    expect(ok("   ", []).ok).toBe(false);
    expect(ok("x".repeat(121), []).ok).toBe(false);
    expect(parseSandboxInput({ name: "S", changes: "no" }).ok).toBe(false);
    expect(parseSandboxInput({ name: "S", changes: [], horizon_months: 25 }).ok).toBe(false);
    expect(parseSandboxInput({ name: "S", changes: [], horizon_months: 0 }).ok).toBe(false);
    expect(parseSandboxInput({ name: "S", changes: [], horizon_months: 24 }).ok).toBe(true);
    expect(parseSandboxInput({ name: "S", changes: [], parent_id: "nope" }).ok).toBe(false);
    expect(parseSandboxInput(null).ok).toBe(false);
  });

  it("refuses two solutions for one process in one month, and allows them in different months or for different processes", () => {
    const solutions = [
      { id: "aaaaaaaa-0000-4000-8000-000000000001", process_id: "p1" },
      { id: "aaaaaaaa-0000-4000-8000-000000000002", process_id: "p1" },
      { id: "aaaaaaaa-0000-4000-8000-000000000003", process_id: "p2" },
    ];
    const context = { solutions, processName: (p: string) => (p === "p1" ? "Sales pipeline" : "Servicing") };
    const [a, b, c] = solutions.map((s) => s.id) as [string, string, string];
    const two = (x: SandboxChange, y: SandboxChange) => parseSandboxInput({ name: "P", changes: [x, y] }, context);
    expect(two(solution("2027-04-01", a), solution("2027-04-01", b))).toEqual({ ok: false, error: "Two solutions for Sales pipeline can't go live in the same month." });
    expect(two(solution("2027-04-01", a), solution("2027-05-01", b)).ok).toBe(true);
    expect(two(solution("2027-04-01", a), solution("2027-04-01", c)).ok).toBe(true);
  });

  it("checks the parent and the limits of the effective changes, and of the scenarios that build on this one", () => {
    const row = (n: string, parent: string | null, changes: SandboxChange[]) => ({ id: `${n}0000000-0000-4000-8000-000000000000`, name: `S${n}`, parent_id: parent ? `${parent}0000000-0000-4000-8000-000000000000` : null, changes });
    const months = (...ms: string[]) => ms.map((m) => patch("A1", null, "add", 0, `2027-${m}-01`));
    const parent = row("a", null, months("01", "02", "03", "04"));
    const child = row("b", "a", months("05"));
    const base = { solutions: [], processName: () => "p", scenarios: [parent, child] };
    // The child alone is fine; its parent's four months plus two of its own are six; plus a seventh is not.
    expect(parseSandboxInput({ name: "C", parent_id: parent.id, changes: months("05", "06") }, { ...base, selfId: child.id }).ok).toBe(true);
    const over = parseSandboxInput({ name: "C", parent_id: parent.id, changes: months("05", "06", "07") }, { ...base, selfId: child.id });
    expect(over).toEqual({ ok: false, error: expect.stringMatching(/more than 6 different months/) });
    // Editing the parent so that the child goes over.
    const grow = parseSandboxInput({ name: "A", parent_id: null, changes: months("01", "02", "03", "04", "06", "07") }, { ...base, selfId: parent.id });
    expect(grow).toEqual({ ok: false, error: expect.stringMatching(/“Sb” builds on this one: it .*more than 6 different months/) });
    // A parent that is gone, itself, or something that builds on it.
    expect(parseSandboxInput({ name: "C", parent_id: "ffffffff-0000-4000-8000-000000000000", changes: [] }, base).ok).toBe(false);
    expect(parseSandboxInput({ name: "A", parent_id: child.id, changes: [] }, { ...base, selfId: parent.id })).toEqual({ ok: false, error: "A scenario can't build on itself or on one that builds on it." });
  });
});

describe("effectiveChanges", () => {
  const row = (n: number, parent: number | null, changes: SandboxChange[]) => ({ id: `0000000${n}-0000-4000-8000-000000000000`, name: `S${n}`, parent_id: parent === null ? null : `0000000${parent}-0000-4000-8000-000000000000`, changes });
  const a = patch("A1", null, "multiply", 2);
  const b = patch("B3", null, "multiply", 1.5);
  const c = hire("2027-03-01");

  it("is the parents' changes first, root first, tagged with where they came from, then its own", () => {
    const rows = [row(1, null, [a]), row(2, 1, [b]), row(3, 2, [c])];
    const r = effectiveChanges(rows[2]!, rows);
    expect(r.ok && r.changes.map((e) => [e.change.id, e.scenarioName, e.inherited])).toEqual([[a.id, "S1", true], [b.id, "S2", true], [c.id, "S3", false]]);
    expect(r.ok && r.parents.map((p) => p.name)).toEqual(["S1", "S2"]);
  });

  it("works for a draft that is not in the list, and for one with no parent", () => {
    const rows = [row(1, null, [a])];
    const draft = { id: "new", name: "Draft", parent_id: rows[0]!.id, changes: [c] };
    const r = effectiveChanges(draft, rows);
    expect(r.ok && r.changes.map((e) => e.change.id)).toEqual([a.id, c.id]);
    const alone = effectiveChanges(rows[0]!, rows);
    expect(alone.ok && alone.changes.every((e) => !e.inherited)).toBe(true);
  });

  it("is an error, not a throw, for a missing parent, a loop and a chain too deep", () => {
    expect(effectiveChanges({ id: "x", name: "X", parent_id: "ffffffff-0000-4000-8000-000000000000", changes: [] }, [])).toEqual({ ok: false, error: "The scenario this one builds on isn't there any more." });
    const loop = [row(1, 2, []), row(2, 1, [])];
    expect(effectiveChanges(loop[0]!, loop)).toEqual({ ok: false, error: "These scenarios build on each other in a loop." });
    const deep = Array.from({ length: 8 }, (_, i) => row(i + 1, i === 0 ? null : i, []));
    expect(effectiveChanges(deep[7]!, deep).ok).toBe(false);
    expect(effectiveChanges(deep[5]!, deep).ok).toBe(true);
  });

  it("finds the scenarios that build on one, directly and further down, and checks the limits on the whole", () => {
    const rows = [row(1, null, []), row(2, 1, []), row(3, 2, []), row(4, null, [])];
    expect(descendantsOf(rows[0]!.id, rows).sort()).toEqual([rows[1]!.id, rows[2]!.id].sort());
    expect(descendantsOf(rows[3]!.id, rows)).toEqual([]);
    const months = ["01", "02", "03", "04", "05", "06", "07"].map((m) => patch("A1", null, "add", 0, `2027-${m}-01`));
    expect(effectiveLimitProblem(months.slice(0, 6))).toBeNull();
    expect(effectiveLimitProblem(months)).toMatch(/more than 6 different months/);
    expect(effectiveLimitProblem(Array.from({ length: 5 }, (_, i) => solution(`2027-0${i + 1}-01`)))).toMatch(/more than 4 solutions/);
  });
});

describe("applyPeopleChanges", () => {
  it("adds a hire as a person with a role and a start date, numbering the default names", () => {
    const a = hire("2027-01-01");
    const b = hire("2027-03-01", { value: 0.5 });
    const { bundle: out, problems, planPeople } = applyPeopleChanges(bundle, [a, b], START);
    expect(problems).toEqual([]);
    const added = out.people.slice(bundle.people.length);
    expect(added.map((p) => p.name)).toEqual(["New PPC specialist", "New PPC specialist 2"]);
    expect(added[0]).toMatchObject({ id: a.id, fte: 1, capacity_hours_week: null, cost_rate: null, active: true, start_date: "2027-01-01", end_date: null });
    expect(added[1]).toMatchObject({ fte: 0.5, start_date: "2027-03-01" });
    expect(out.personRoles.slice(bundle.personRoles.length)).toEqual([
      { person_id: a.id, role_id: PPC, workspace_id: bundle.workspace.id },
      { person_id: b.id, role_id: PPC, workspace_id: bundle.workspace.id },
    ]);
    expect([...planPeople].sort()).toEqual([a.id, b.id].sort());
    expect(bundle.people.some((p) => p.id === a.id)).toBe(false);
    const model = forecastModel(out, 12, START).model!;
    expect(model.people![a.id]!.from).toBe(hoursToDate(START, "2027-01-01", HPW));
    expect(model.people![a.id]!.roles).toEqual([PPC]);
    expect(model.people![b.id]!.name).toBe("New PPC specialist 2");
  });

  it("uses the name typed, and a hire with no month is there from the start", () => {
    const named = hire("2027-01-01", { params: { name: "Jade" } });
    expect(applyPeopleChanges(bundle, [named], START).bundle.people.at(-1)!.name).toBe("Jade");
    const whole = { ...hire("2027-01-01"), from: undefined } as SandboxChange;
    delete whole.from;
    expect(applyPeopleChanges(bundle, [whole], START).bundle.people.at(-1)).toMatchObject({ start_date: null });
    const [x, y] = [hire("2027-02-01"), hire("2027-03-01")];
    expect(hireNames(bundle, [named, x, y])).toEqual(new Map([[named.id, "Jade"], [x.id, "New PPC specialist"], [y.id, "New PPC specialist 2"]]));
  });

  it("adds leave from the Monday to the Friday of its last week", () => {
    expect(leaveEnd("2026-12-07", 3)).toBe("2026-12-25");
    const m = leave("2026-12-07", 3);
    const { bundle: out, problems } = applyPeopleChanges(bundle, [m], START);
    expect(problems).toEqual([]);
    expect(out.personLeave.filter((l) => l.person_id === DAN)).toEqual([{ id: m.id, person_id: DAN, workspace_id: bundle.workspace.id, start_date: "2026-12-07", end_date: "2026-12-25" }]);
    const windows = forecastModel(out, 12, START).model!.people![DAN]!.leave!;
    expect(windows).toHaveLength(1);
    expect(windows[0]![1] - windows[0]![0]).toBeCloseTo(15 * 8, 6);
  });

  it("skips a change whose role, person or person's place is gone, and says so", () => {
    const gone = hire("2027-01-01", { target: randomUUID(), params: { name: "New SEO specialist" } });
    const noPerson = leave("2027-01-04", 1, randomUUID());
    const inactive = leave("2027-01-04", 1, DAN);
    const fine = hire("2027-02-01");
    const away: ProcessBundle = { ...bundle, people: bundle.people.map((p) => (p.id === DAN ? { ...p, active: false } : p)) };
    const { bundle: out, problems } = applyPeopleChanges(away, [gone, noPerson, inactive, fine], START);
    expect(problems.map((p) => p.changeId)).toEqual([gone.id, noPerson.id, inactive.id]);
    expect(problems[0]!.message).toBe("The role of “New SEO specialist” isn't there any more");
    expect(problems[2]!.message).toMatch(/Dan Okafor is no longer on the team/);
    expect(out.people).toHaveLength(away.people.length + 1);
    expect(out.personLeave).toEqual(away.personLeave);
  });

  it("merges leave that overlaps or touches Settings' leave, so the engine doesn't count it twice", () => {
    // Settings: Leah is away 14 December to 8 January.
    const settings = bundle.personLeave.filter((l) => l.person_id === LEAH);
    expect(settings).toHaveLength(1);
    const overlap = applyPeopleChanges(bundle, [leave("2026-12-21", 2, LEAH)], START).bundle;
    expect(overlap.personLeave.filter((l) => l.person_id === LEAH).map((l) => [l.start_date, l.end_date])).toEqual([["2026-12-14", "2027-01-08"]]);
    const touching = applyPeopleChanges(bundle, [leave("2027-01-11", 1, LEAH)], START).bundle;
    expect(touching.personLeave.filter((l) => l.person_id === LEAH).map((l) => [l.start_date, l.end_date])).toEqual([["2026-12-14", "2027-01-15"]]);
    const apart = applyPeopleChanges(bundle, [leave("2027-02-01", 1, LEAH)], START).bundle;
    expect(apart.personLeave.filter((l) => l.person_id === LEAH)).toHaveLength(2);
    expect(forecastModel(overlap, 12, START).model!.people![LEAH]!.leave).toHaveLength(1);
    // Two scenario leaves for one person that overlap each other.
    const both = applyPeopleChanges(bundle, [leave("2027-03-01", 2, DAN), leave("2027-03-08", 2, DAN)], START).bundle;
    expect(both.personLeave.filter((l) => l.person_id === DAN).map((l) => [l.start_date, l.end_date])).toEqual([["2027-03-01", "2027-03-19"]]);
  });

  it("leaves other people's leave alone", () => {
    const out = applyPeopleChanges(bundle, [leave("2027-03-01", 1, DAN)], START).bundle;
    expect(out.personLeave.filter((l) => l.person_id === LEAH)).toEqual(bundle.personLeave.filter((l) => l.person_id === LEAH));
  });

  it("someone who leaves (D2) ends the day before the month; whole-run, the day before the start (they are gone); an earlier end date is kept", () => {
    const from = applyPeopleChanges(bundle, [leaver(DAN, "2027-03-01")], START).bundle.people.find((p) => p.id === DAN)!;
    expect(from.end_date).toBe("2027-02-28");
    expect(forecastModel({ ...bundle, people: applyPeopleChanges(bundle, [leaver(DAN, "2027-03-01")], START).bundle.people }, 12, START).model!.people![DAN]!.until).toBe(hoursToDate(START, "2027-03-01", HPW));
    const whole = applyPeopleChanges(bundle, [leaver(DAN)], START).bundle;
    expect(whole.people.find((p) => p.id === DAN)!.end_date).toBe("2026-10-04");
    expect(forecastModel(whole, 12, START).model!.people![DAN]).toBeUndefined();
    const early: ProcessBundle = { ...bundle, people: bundle.people.map((p) => (p.id === DAN ? { ...p, end_date: "2027-01-31" } : p)) };
    expect(applyPeopleChanges(early, [leaver(DAN, "2027-06-01")], START).bundle.people.find((p) => p.id === DAN)!.end_date).toBe("2027-01-31");
    expect(applyPeopleChanges(bundle, [leaver(randomUUID(), "2027-06-01")], START).problems).toHaveLength(1);
  });

  it("an FTE change from a month splits the person: the old row ends the day before, a copy starts on the 1st with the new FTE and the same roles, skills and later leave", () => {
    const c = fte(DAN, 0.5, "2027-03-01");
    const withLeave: ProcessBundle = { ...bundle, personLeave: [...bundle.personLeave, { id: randomUUID(), person_id: DAN, workspace_id: bundle.workspace.id, start_date: "2027-04-05", end_date: "2027-04-16" }] };
    const r = applyPeopleChanges(withLeave, [c], START);
    expect(r.handled.has(c.id)).toBe(true);
    expect(r.planPeople.has(c.id)).toBe(true);
    const old = r.bundle.people.find((p) => p.id === DAN)!;
    const copy = r.bundle.people.find((p) => p.id === c.id)!;
    expect(old).toMatchObject({ end_date: "2027-02-28", fte: 1 });
    expect(copy).toMatchObject({ fte: 0.5, capacity_hours_week: null, start_date: "2027-03-01", end_date: null, name: "Dan Okafor (from Mar 2027)" });
    expect(r.bundle.personRoles.filter((x) => x.person_id === c.id).map((x) => x.role_id)).toEqual(r.bundle.personRoles.filter((x) => x.person_id === DAN).map((x) => x.role_id));
    expect(r.bundle.personSkills.filter((x) => x.person_id === c.id).map((x) => x.step_id)).toEqual(r.bundle.personSkills.filter((x) => x.person_id === DAN).map((x) => x.step_id));
    // The leave in April belongs to the copy, not to the row that has ended.
    expect(r.bundle.personLeave.filter((l) => l.person_id === DAN).map((l) => l.start_date)).toEqual(bundle.personLeave.filter((l) => l.person_id === DAN).map((l) => l.start_date));
    expect(r.bundle.personLeave.filter((l) => l.person_id === c.id).map((l) => [l.start_date, l.end_date])).toEqual([["2027-04-05", "2027-04-16"]]);
    const model = forecastModel(r.bundle, 12, START).model!;
    expect(model.people![DAN]!.until).toBe(hoursToDate(START, "2027-03-01", HPW));
    expect(model.people![c.id]!.from).toBe(hoursToDate(START, "2027-03-01", HPW));
    expect(model.people![c.id]!.capacity).toBe(0.5 * HPW);
  });

  it("an FTE change multiplies or adds to the old FTE, clamped to 0 to 2; two in one month, and two in a row, chain", () => {
    const copyOf = (c: SandboxChange) => applyPeopleChanges(bundle, [c], START).bundle.people.find((p) => p.id === c.id);
    expect(copyOf(fte(DAN, 0.5, "2027-03-01", "multiply"))).toMatchObject({ fte: 0.5 });
    expect(copyOf(fte(DAN, 5, "2027-03-01", "add"))).toMatchObject({ fte: 2 });
    expect(copyOf(fte(DAN, -5, "2027-03-01", "add"))).toMatchObject({ fte: 0 });
    const first = fte(DAN, 0.5, "2027-03-01");
    const sameMonth = fte(DAN, 0.2, "2027-03-01", "add");
    const same = applyPeopleChanges(bundle, [first, sameMonth], START);
    expect(same.bundle.people.filter((p) => p.id === first.id)).toHaveLength(1);
    expect(same.bundle.people.find((p) => p.id === first.id)!.fte).toBeCloseTo(0.7);
    const later = fte(DAN, 0.25, "2027-07-01", "multiply");
    const chain = applyPeopleChanges(bundle, [later, first], START).bundle;
    expect(chain.people.find((p) => p.id === DAN)!.end_date).toBe("2027-02-28");
    expect(chain.people.find((p) => p.id === first.id)).toMatchObject({ end_date: "2027-06-30", fte: 0.5 });
    expect(chain.people.find((p) => p.id === later.id)).toMatchObject({ start_date: "2027-07-01", fte: 0.125, end_date: null });
    // Leaving after a split ends every row of the person.
    const gone = applyPeopleChanges(bundle, [first, later, leaver(DAN, "2027-05-01")], START).bundle;
    expect(gone.people.find((p) => p.id === first.id)!.end_date).toBe("2027-04-30");
    expect(gone.people.some((p) => p.id === later.id)).toBe(false);
  });

  it("an FTE change for someone pinned to a step, or assigned clients, is not split: it stays a (spliced) patch", () => {
    const step = bundle.steps.find((s) => s.role_id)!;
    const pinned: ProcessBundle = { ...bundle, steps: bundle.steps.map((s) => (s.id === step.id ? { ...s, person_id: DAN } : s)) };
    const c = fte(DAN, 0.5, "2027-03-01");
    const r = applyPeopleChanges(pinned, [c], START);
    expect(r.handled.has(c.id)).toBe(false);
    expect(r.bundle.people).toEqual(pinned.people);
    const seg = scenarioSegments(pinned, eff([c]), [], START, bounds, HPW);
    expect(seg.segments.map((s) => s.from)).toEqual([0, 5]);
    expect(seg.segments[1]!.patches).toEqual([{ path: `people.${DAN}.fte`, op: "set", value: 0.5 }]);
    expect(seg.segments[0]!.patches).toEqual([]);
    // Assigned clients count only when clients are named (counted per service, the roster is hidden).
    const named: ProcessBundle = { ...bundle, clientGroups: [], clientAssignments: [{ client_id: randomUUID(), role_id: PPC, person_id: DAN, workspace_id: bundle.workspace.id }] };
    expect(applyPeopleChanges(named, [c], START).handled.has(c.id)).toBe(false);
    expect(applyPeopleChanges(bundle, [c], START).handled.has(c.id)).toBe(true);
  });

  it("an FTE change with no month, or from a month on or before the start, is a whole-run patch", () => {
    for (const c of [fte(DAN, 0.5), fte(DAN, 0.5, "2026-10-01")]) {
      const r = scenarioSegments(bundle, eff([c]), [], START, bounds, HPW);
      expect(r.segments).toHaveLength(1);
      expect(r.segments[0]!.patches).toEqual([{ path: `people.${DAN}.fte`, op: "set", value: 0.5 }]);
    }
  });
});

describe("withSolution", () => {
  const ppcWork = (b: ProcessBundle) => forecastModel(b, 12, START).model!.steps.find((s) => s.id === northbeamStepIds.ppc)!.work;

  it("replaces the main process's steps with the solution's copy", () => {
    const out = withSolution(bundle, DEMO_FORECAST_SOLUTION)!;
    expect(ppcWork(bundle)).toBe(8);
    expect(ppcWork(out)).toBe(4);
    expect(bundle.steps.find((s) => s.id === northbeamStepIds.ppc)!.work_hours).toBe(8);
  });

  it("swaps only the matching servicing process when the solution is for one of those", () => {
    const part = bundle.otherProcesses![0]!;
    const copy = solutionCopy({ steps: part.steps.map((s) => ({ ...s, name: `${s.name} (new)` })), edges: [] });
    const out = withSolution(bundle, { process_id: part.process.id, steps: copy as SolutionRow["steps"] })!;
    expect(out.steps).toBe(bundle.steps);
    expect(out.otherProcesses![0]!.steps.map((s) => s.name)).toEqual(part.steps.map((s) => `${s.name} (new)`));
    expect(out.otherProcesses![0]!.steps.every((s) => s.process_id === part.process.id && s.revision_id === part.revision.id)).toBe(true);
    expect(out.otherProcesses![0]!.revision).toBe(part.revision);
    expect(out.otherProcesses!.slice(1)).toEqual(bundle.otherProcesses!.slice(1));
  });

  it("gives null for a process the forecast doesn't run", () => {
    expect(withSolution(bundle, { process_id: randomUUID(), steps: DEMO_FORECAST_SOLUTION.steps })).toBeNull();
  });
});

describe("scenarioSegments", () => {
  const clone = (name: string, workHours: number, process_id = DEMO_FORECAST_SOLUTION.process_id): SolutionRow => ({
    ...DEMO_FORECAST_SOLUTION,
    id: randomUUID(),
    name,
    process_id,
    steps: { ...DEMO_FORECAST_SOLUTION.steps, steps: DEMO_FORECAST_SOLUTION.steps.steps.map((s) => (s.id === northbeamStepIds.ppc ? { ...s, work_hours: workHours } : s)) },
  });

  it("is one segment for a scenario with no timed patch or solution, with the people applied, and whole-run patches in it", () => {
    const lead = patch("A1", null, "multiply", 1.25);
    const r = segs([hire("2027-01-01"), lead]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ from: 0, solutionIds: [], patches: [{ path: "demand.leads_per_week", op: "multiply", value: 1.25 }], patchChangeIds: [lead.id] });
    expect(r.segments[0]!.bundle.people).toHaveLength(bundle.people.length + 1);
    expect(segs([]).segments).toHaveLength(1);
  });

  it("puts a whole-run patch in every segment and a timed patch in its month's segment and the ones after it", () => {
    const whole = patch("B3", null, "set", 0.02);
    const july = patch("A1", null, "multiply", 1.5, "2027-04-01");
    const jan = patch("B2", null, "multiply", 1.1, "2027-01-01");
    const r = segs([july, whole, jan]);
    expect(r.segments.map((s) => s.from)).toEqual([0, 3, 6]);
    expect(r.segments.map((s) => s.patchChangeIds)).toEqual([[whole.id], [whole.id, jan.id], [july.id, whole.id, jan.id]]);
    expect(r.segments[2]!.patches.map((p) => p.path)).toEqual(["demand.leads_per_week", "demand.churn_monthly", "finances.retainer"]);
  });

  it("treats a month on or before the start as the whole run, and one at or after the horizon as 'later'", () => {
    const early = patch("A1", null, "multiply", 2, "2026-10-01");
    const late = patch("A1", null, "multiply", 3, "2027-11-01");
    const r = segs([early, late]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.patchChangeIds).toEqual([early.id]);
    expect(r.later).toEqual([late.id]);
  });

  it("starts a segment for each distinct go-live month, with every solution live by then", () => {
    const servicing = bundle.otherProcesses![0]!;
    const other: SolutionRow = { ...DEMO_FORECAST_SOLUTION, id: randomUUID(), name: "Other", process_id: servicing.process.id, steps: solutionCopy({ steps: servicing.steps, edges: [] }) };
    const r = segs([solution("2027-01-01"), solution("2027-01-01", other.id)], [DEMO_FORECAST_SOLUTION, other]);
    expect(r.segments.map((s) => s.from)).toEqual([0, 3]);
    expect(r.segments[0]!.solutionIds).toEqual([]);
    expect(r.segments[1]!.solutionIds.sort()).toEqual([DEMO_FORECAST_SOLUTION.id, other.id].sort());
  });

  it("puts a solution from month 0 in the only segment", () => {
    for (const date of ["2026-10-01", "2026-10-05", "2020-01-01"]) {
      const r = segs([solution(date)]);
      expect(r.segments).toHaveLength(1);
      expect(r.segments[0]!.solutionIds).toEqual([DEMO_FORECAST_SOLUTION_ID]);
    }
  });

  it("leaves out a solution at or after the horizon and lists it", () => {
    const m = solution("2027-11-01");
    const r = segs([m, solution("2028-06-01", randomUUID())]);
    expect(r.later).toEqual([m.id, expect.any(String)]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.solutionIds).toEqual([]);
  });

  it("lets the later solution of one process replace the earlier one from its month, with only the winner's lever changes", () => {
    const first = { ...clone("Fast", 4), lever_changes: [{ path: "demand.leads_per_week", op: "multiply" as const, value: 0.8 }] };
    const second = { ...clone("Faster", 2), lever_changes: [{ path: "demand.leads_per_week", op: "multiply" as const, value: 0.8 }] };
    const a = solution("2027-01-01", first.id);
    const b = solution("2027-04-01", second.id);
    const r = segs([a, b], [first, second]);
    expect(r.segments.map((s) => s.from)).toEqual([0, 3, 6]);
    const work = (s: (typeof r.segments)[number]) => forecastModel(s.bundle, 12, START).model!.steps.find((x) => x.id === northbeamStepIds.ppc)!.work;
    expect(r.segments.map(work)).toEqual([8, 4, 2]);
    expect(r.segments[2]!.solutionIds.at(-1)).toBe(second.id);
    // x0.8 once, not x0.64: a replaced solution keeps neither its steps nor its levers.
    expect(r.segments[1]!.patchChangeIds).toEqual([a.id]);
    expect(r.segments[2]!.patchChangeIds).toEqual([b.id]);
  });

  it("puts a solution's lever changes at its change's place among the patches", () => {
    const sol = { ...clone("Levered", 4), lever_changes: [{ path: "demand.churn_monthly", op: "set" as const, value: 0.01 }] };
    const before = patch("A1", null, "multiply", 2);
    const after = patch("B2", null, "multiply", 1.1);
    const live = solution("2027-01-01", sol.id);
    const r = segs([before, live, after], [sol]);
    expect(r.segments[1]!.patchChangeIds).toEqual([before.id, live.id, after.id]);
    expect(r.segments[1]!.patches.map((p) => p.path)).toEqual(["demand.leads_per_week", "demand.churn_monthly", "finances.retainer"]);
  });

  it("skips a missing solution and one of a process outside the model, as problems, and still runs the rest", () => {
    const stray = clone("Stray", 1, randomUUID());
    const missing = solution("2027-01-01", randomUUID());
    const strayChange = solution("2027-02-01", stray.id);
    const r = segs([missing, strayChange, hire("2027-01-01")], [stray]);
    expect(r.problems.map((p) => [p.changeId, p.message])).toEqual([[missing.id, "A solution in this scenario was deleted"], [strayChange.id, "“Stray” changes a process the forecast doesn't run"]]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.bundle.people).toHaveLength(bundle.people.length + 1);
  });

  it("refuses more than six change months, running nothing", () => {
    const months = ["11", "12"].map((m) => `2026-${m}-01`).concat(["01", "02", "03", "04", "05"].map((m) => `2027-${m}-01`));
    const r = segs(months.map((d) => patch("A1", null, "add", 0, d)));
    expect(r.error).toMatch(/more than 6 different months/);
    expect(r.segments).toEqual([]);
    expect(MAX_SEGMENTS).toBe(7);
    expect(segs(months.slice(0, 6).map((d) => patch("A1", null, "add", 0, d))).segments).toHaveLength(7);
  });
});

describe("scenarioModel", () => {
  it("applies the patches and the horizon, with the calendar's months", () => {
    const r = scenarioModel(bundle, 6, START, [{ path: "demand.leads_per_week", op: "multiply", value: 2 }], ["c1"]);
    expect(r.error).toBeNull();
    expect(r.model!.leadsPerWeek).toBe(live.leadsPerWeek * 2);
    expect(r.model!.horizonWeeks).toBe(26);
    expect(r.monthStarts).toHaveLength(5);
    expect(r.problems).toEqual([]);
  });

  it("skips a patch whose target is gone and lists it against its change; a value brought into range is noted, not skipped", () => {
    const missing = `steps.${randomUUID()}.work_hours`;
    const r = scenarioModel(
      bundle,
      12,
      START,
      [
        { path: "demand.leads_per_week", op: "multiply", value: 2 },
        { path: missing, op: "set", value: 1 },
        { path: "steps.@heaviest.rework_rate", op: "set", value: 2 },
      ],
      ["ok", "broken", "clamped"],
    );
    expect(r.model!.leadsPerWeek).toBe(live.leadsPerWeek * 2);
    expect(r.problems.map((p) => [p.changeId, p.note ?? false])).toEqual([["broken", false], ["clamped", true]]);
    expect(r.problems[0]!.message).toMatch(/no longer in the process.*It is skipped in this run\./);
    // Same as applying only the patches that resolve.
    const good = applyPatches(live, [{ path: "demand.leads_per_week", op: "multiply", value: 2 }, { path: "steps.@heaviest.rework_rate", op: "set", value: 2 }]).model;
    expect(r.model!.steps).toEqual(good.steps);
  });

  it("names the steps that replaced a missing one", () => {
    const gone = randomUUID();
    const replacement = bundle.steps.find((s) => s.role_id)!;
    const r = scenarioModel(bundle, 12, START, [{ path: `steps.${gone}.work_hours`, op: "set", value: 1 }], ["x"], { [gone]: { name: "Old setup", replacedBy: [replacement.id] } });
    expect(r.problems[0]!.message).toContain("Old setup");
    expect(r.problems[0]!.message).toContain(replacement.name);
  });

  it("is an error message, not a throw, when the model can't be simulated", () => {
    const r = scenarioModel({ ...bundle, steps: [], edges: [] }, 12, START);
    expect(r.error).toEqual(expect.any(String));
    expect(r.model).toBeNull();
  });
});

const stat = (mean: number, spread = 0.1): Stat => ({ mean, p10: mean - spread, p90: mean + spread });
const busy = (mean: number): MonthBusy => ({ ...stat(mean), capacity: 40, work: mean * 40 });
/** A small hand-made monthly result: `n` months, with roles `r` busy at `level`, `clients` a stock starting at `c`, `mrr` at `m`. */
function fake(n: number, level: number, c: number, m: number, extra: Partial<MonthlyResult> = {}): MonthlyResult {
  return {
    months: Array.from({ length: n }, (_, i) => ({ start: i * 100, end: (i + 1) * 100 })),
    roles: { r: Array.from({ length: n }, () => busy(level)) },
    uncovered: { r: Array.from({ length: n }, () => null) },
    people: { p: Array.from({ length: n }, () => busy(level)) },
    waits: { s: Array.from({ length: n }, () => level) },
    lateTasks: Array.from({ length: n }, () => stat(level)),
    clients: { svc: Array.from({ length: n }, (_, i) => stat(c + i)) },
    mrr: Array.from({ length: n }, (_, i) => stat(m + i * 10)),
    atRisk: { svc: Array.from({ length: n }, () => stat(1, 0.5)) },
    ...extra,
  };
}

describe("spliceMonthly", () => {
  it("returns a single segment as it is", () => {
    const a = fake(4, 0.5, 10, 100);
    expect(spliceMonthly([{ from: 0, monthly: a }])).toBe(a);
  });

  it("switches flows at the segment's month", () => {
    const a = fake(5, 0.5, 10, 100);
    const b = fake(5, 0.9, 10, 100);
    const s = spliceMonthly([{ from: 0, monthly: a }, { from: 2, monthly: b }]);
    expect(s.roles.r!.map((x) => x!.mean)).toEqual([0.5, 0.5, 0.9, 0.9, 0.9]);
    expect(s.people.p!.map((x) => x!.mean)).toEqual([0.5, 0.5, 0.9, 0.9, 0.9]);
    expect(s.waits.s).toEqual([0.5, 0.5, 0.9, 0.9, 0.9]);
    expect(s.lateTasks.map((x) => x.mean)).toEqual([0.5, 0.5, 0.9, 0.9, 0.9]);
    // Copied, not shifted: the busy rows are the segments' own.
    expect(s.roles.r![3]).toBe(b.roles.r![3]);
  });

  it("carries stocks on from where they were: shifted by the gap at the month before, floored at 0", () => {
    const a = fake(5, 0.5, 10, 100);
    // The solution's run has 3 fewer clients all along, and 1000 more revenue.
    const b = fake(5, 0.5, 7, 1100);
    const s = spliceMonthly([{ from: 0, monthly: a }, { from: 3, monthly: b }]);
    // Clients: a is 10, 11, 12 then b is 10, 11 (7 + 3, 7 + 4) shifted by (12 - 9) = +3: 13, 14.
    expect(s.clients.svc!.map((x) => x.mean)).toEqual([10, 11, 12, 13, 14]);
    expect(s.clients.svc![3]).toEqual({ mean: 13, p10: 13 - 0.1, p90: 13 + 0.1 });
    expect(s.mrr.map((x) => x.mean)).toEqual([100, 110, 120, 130, 140]);
    // Floored at 0: a segment that falls away to nothing doesn't go negative.
    const down = spliceMonthly([{ from: 0, monthly: fake(4, 0.5, 2, 10) }, { from: 2, monthly: fake(4, 0.5, 50, 10, { clients: { svc: [stat(50), stat(50), stat(0), stat(0)] } }) }]);
    expect(down.clients.svc!.map((x) => x.mean)).toEqual([2, 3, 0, 0]);
    expect(down.clients.svc!.every((x) => x.p10 >= 0)).toBe(true);
  });

  it("keeps p10 <= mean <= p90 across a splice, including in a month where the floor at 0 applies", () => {
    const a = fake(4, 0.5, 5, 100, { clients: { svc: Array.from({ length: 4 }, () => stat(5, 1)) } });
    // The solution's run is 4 clients higher at the month before, then falls to a wide range near 2.
    const b = fake(4, 0.5, 9, 100, { clients: { svc: [stat(9, 1), stat(9, 1), stat(2, 3), stat(6, 1)] } });
    const s = spliceMonthly([{ from: 0, monthly: a }, { from: 2, monthly: b }]);
    // Offset is 5 - 9 = -4: month 2 is mean -2, p10 -5, p90 1 before the floor; month 3 is 2 / 1 / 3.
    expect(s.clients.svc![2]).toEqual({ mean: 0, p10: 0, p90: 1 });
    expect(s.clients.svc![3]).toEqual({ mean: 2, p10: 1, p90: 3 });
    for (const series of [s.clients.svc!, s.mrr, s.atRisk.svc!]) {
      for (const x of series) {
        expect(x.p10).toBeLessThanOrEqual(x.mean);
        expect(x.mean).toBeLessThanOrEqual(x.p90);
        expect(x.p10).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("counts a key missing on either side as 0 and keeps the union of keys", () => {
    const a = fake(4, 0.5, 10, 100);
    const b = fake(4, 0.7, 10, 100, { clients: { other: [stat(5), stat(5), stat(5), stat(5)] }, roles: { r2: Array.from({ length: 4 }, () => busy(0.7)) }, atRisk: {} });
    const s = spliceMonthly([{ from: 0, monthly: a }, { from: 2, monthly: b }]);
    expect(Object.keys(s.clients).sort()).toEqual(["other", "svc"]);
    // "svc" is missing in b: its value there counts as 0, so the offset is a's 11 - 0 = 11 and it stays level from month 2 on.
    expect(s.clients.svc!.map((x) => x.mean)).toEqual([10, 11, 11, 11]);
    // "other" is missing in a (0 there): it starts at 0 and only follows b's change from month 2.
    expect(s.clients.other!.map((x) => x.mean)).toEqual([0, 0, 0, 0]);
    // A flow key missing in the segment that holds the month gives null.
    expect(Object.keys(s.roles).sort()).toEqual(["r", "r2"]);
    expect(s.roles.r!.map((x) => x?.mean ?? null)).toEqual([0.5, 0.5, null, null]);
    expect(s.roles.r2!.map((x) => x?.mean ?? null)).toEqual([null, null, 0.7, 0.7]);
    expect(s.atRisk.svc!.map((x) => x.mean)).toEqual([1, 1, 1, 1]);
  });
});

describe("a solution change applies that solution's changes from its month only", () => {
  const goLive = "2027-01-01";
  const month = 3;
  const sol = DEMO_FORECAST_SOLUTION;
  const plan = segs([solution(goLive)]);
  const base = run(plan.segments[0]!.bundle).monthly!;
  const withSol = run(plan.segments[1]!.bundle).monthly!;
  const spliced = spliceMonthly(plan.segments.map((s, i) => ({ from: s.from, monthly: [base, withSol][i]! })));
  it("is two runs, the second from the fourth month", () => {
    expect(plan.segments.map((s) => s.from)).toEqual([0, month]);
    expect(base.months).toHaveLength(12);
  });

  it("matches the live run before the month, in every series", () => {
    const upTo = <T>(xs: T[]) => xs.slice(0, month);
    for (const key of ["roles", "people", "clients", "atRisk", "uncovered", "waits"] as const) {
      for (const [k, series] of Object.entries(spliced[key])) expect(upTo(series as unknown[]), `${key}.${k}`).toEqual(upTo((base[key] as Record<string, unknown[]>)[k]!));
    }
    expect(upTo(spliced.mrr)).toEqual(upTo(base.mrr));
    expect(upTo(spliced.lateTasks)).toEqual(upTo(base.lateTasks));
  });

  it("follows the solution's run from the month, for busy shares", () => {
    for (const [k, series] of Object.entries(spliced.roles)) expect(series.slice(month), k).toEqual(withSol.roles[k]!.slice(month));
    for (const [k, series] of Object.entries(spliced.people)) expect(series.slice(month), k).toEqual(withSol.people[k]!.slice(month));
  });

  it("does something: the PPC specialists' busy share differs from live in a month after it", () => {
    const differs = spliced.roles[PPC]!.some((m, i) => i >= month && m !== null && Math.abs(m.mean - base.roles[PPC]![i]!.mean) > 1e-9);
    expect(differs).toBe(true);
    // And it is less busy, not more: the setup takes half the time.
    const after = (m: MonthlyResult) => m.roles[PPC]!.slice(month).reduce((a, x) => a + (x?.mean ?? 0), 0);
    expect(after(spliced)).toBeLessThan(after(base));
  });

  it("carries clients and revenue on from the month before, not restarting from the solution's run", () => {
    const k = month;
    for (const key of Object.keys(base.clients)) expect(spliced.clients[key]![k - 1]).toEqual(base.clients[key]![k - 1]);
    const gap = base.mrr[k - 1]!.mean - withSol.mrr[k - 1]!.mean;
    expect(spliced.mrr[k]!.mean).toBeCloseTo(Math.max(0, withSol.mrr[k]!.mean + gap), 6);
  });

  it("the same solution from month 0 is the solution's own run everywhere", () => {
    const at0 = segs([solution("2026-10-01")], [sol]);
    expect(at0.segments).toHaveLength(1);
    const only = spliceMonthly([{ from: 0, monthly: run(at0.segments[0]!.bundle).monthly! }]);
    expect(only).toEqual(run(withSolution(bundle, sol)!).monthly);
  });
});

describe("positions", () => {
  const n = bounds.length - 1;
  const firstOf = (c: number) => addMonths("2026-10-01", c);

  it("round-trips the 1st of each month", () => {
    expect(n).toBe(12);
    for (let c = 0; c < n; c++) {
      const pos = positionOfDate(firstOf(c), START, bounds, HPW);
      expect(pos, firstOf(c)).toBeCloseTo(c, 9);
      expect(dateAtPosition(pos, "month", START, bounds, HPW)).toBe(firstOf(c));
    }
  });

  it("snaps to the month under the pointer, and the first column to the 1st of the start's month", () => {
    expect(dateAtPosition(0.3, "month", START, bounds, HPW)).toBe("2026-10-01");
    expect(dateAtPosition(2.9, "month", START, bounds, HPW)).toBe("2026-12-01");
    expect(dateAtPosition(3, "month", START, bounds, HPW)).toBe("2027-01-01");
  });

  it("places a date part-way through a month by its fraction", () => {
    const mid = positionOfDate("2027-01-16", START, bounds, HPW);
    expect(mid).toBeGreaterThan(3.4);
    expect(mid).toBeLessThan(3.6);
  });

  it("snaps weeks to the Monday on or before", () => {
    for (const p of [0.2, 1.7, 2.5, 6.05, 11.9]) {
      const d = dateAtPosition(p, "week", START, bounds, HPW);
      expect(new Date(`${d}T00:00:00Z`).getUTCDay(), `${p} -> ${d}`).toBe(1);
    }
  });

  it("clamps: before the start is column 0, after the horizon the last column", () => {
    expect(positionOfDate("2020-01-01", START, bounds, HPW)).toBe(0);
    expect(positionOfDate("2030-01-01", START, bounds, HPW)).toBe(n);
    expect(dateAtPosition(-4, "month", START, bounds, HPW)).toBe("2026-10-01");
    expect(dateAtPosition(99, "month", START, bounds, HPW)).toBe(firstOf(n - 1));
    const end = dateAtPosition(99, "week", START, bounds, HPW);
    expect(end <= "2027-10-04").toBe(true);
    expect(end >= "2027-09-20").toBe(true);
  });

  it("steps a month or a week, across a year end", () => {
    expect(stepDate("2026-12-01", "month", 1)).toBe("2027-01-01");
    expect(stepDate("2027-01-01", "month", -1)).toBe("2026-12-01");
    expect(stepDate("2026-12-28", "week", 1)).toBe("2027-01-04");
    expect(stepDate("2027-01-04", "week", -1)).toBe("2026-12-28");
  });
});


describe("timelineData with a scenario", () => {
  const hired = hire("2027-01-01");
  const planned = applyPeopleChanges(bundle, [hired, leave("2026-12-07", 1, DAN)], START).bundle;
  const f = forecastModel(planned, 12, START);
  const r = simulate(f.model!, 10, 1, { monthly: true, monthStarts: f.monthStarts! });
  const planPeople = new Set([hired.id]);

  it("draws Settings' markers from the model without the scenario, and names the scenario's people", () => {
    const data = timelineData(f.model!, r, planned, START, { markersModel: live, planPeople })!;
    expect(data.markers.map((m) => m.personId).sort()).toEqual([...new Set(live.people ? Object.entries(live.people).filter(([, p]) => (p.from ?? 0) > 0 || p.leave?.length).map(([pid]) => pid) : [])].sort());
    expect(data.markers.some((m) => m.personId === hired.id)).toBe(false);
    expect(data.people.map((p) => p.name)).toContain("New PPC specialist (plan)");
  });

  it("is unchanged without options", () => {
    const plain = timelineData(f.model!, r, planned, START)!;
    expect(plain.markers.some((m) => m.personId === hired.id)).toBe(true);
    expect(plain.people.map((p) => p.name)).toContain("New PPC specialist");
    expect(timelineData(f.model!, r, planned, START, {})).toEqual(plain);
  });
});

describe("the lane", () => {
  const ctx = (changes: SandboxChange[]) => ({ bundle, solutions: [DEMO_FORECAST_SOLUTION], changes });

  it("lists every timed change in words, in order, with leave's last day; whole-run changes are not on it", () => {
    const h = hire("2027-02-01", { params: { name: "Jade" } });
    const l = leave("2026-12-14", 3, LEAH);
    const s = solution("2027-04-01");
    const p = patch("A1", null, "multiply", 1.25, "2027-05-01");
    const whole = patch("B3", null, "multiply", 1.5);
    const lane = laneMarkers(ctx([h, l, s, p, whole]), eff([h, l, s, p, whole]), [], START, HPW);
    expect(lane.map((m) => [m.kind, m.label, m.when])).toEqual([
      ["hire", "Jade starts", "1 Feb 2027"],
      ["leave", "Leah Brooks on leave for 3 weeks", "14 Dec 2026 to 1 Jan 2027"],
      ["solution", "Faster PPC campaign setup goes live", "1 Apr 2027"],
      ["change", "Opportunities coming in ×1.25", "1 May 2027"],
    ]);
    expect(lane[1]!.endDate).toBe("2027-01-01");
  });

  it("marks a parent's change as inherited, shows a problem, and says when a hire has already started", () => {
    const h = hire("2026-10-01");
    const gone = leave("2027-01-04", 1, randomUUID());
    const lane = laneMarkers(ctx([h, gone]), [{ change: h, scenarioId: "p", scenarioName: "Parent", inherited: true }, ...eff([gone])], [{ changeId: gone.id, message: "Someone is gone" }], START, HPW);
    expect(lane[0]).toMatchObject({ inherited: true, label: "New PPC specialist starts (already started)" });
    expect(lane[1]).toMatchObject({ problem: "Someone is gone", label: "someone who is gone on leave for 1 week" });
  });
});

describe("the demo's scenarios", () => {
  it("opens with three scenarios that parse, run and show the build-on", () => {
    resetDemoScenarios();
    expect(demoScenariosNow().map((s) => s.name)).toEqual(["Hire in January", "Hire in March", "Hire in March, then more leads"]);
    for (const s of DEMO_SCENARIOS) {
      expect(parseSandboxInput({ name: s.name, parent_id: s.parent_id, changes: s.changes, horizon_months: s.horizon_months }, { solutions: [DEMO_FORECAST_SOLUTION], processName: () => "p", scenarios: DEMO_SCENARIOS, selfId: s.id }).ok, s.name).toBe(true);
      const e = effectiveChanges(s, DEMO_SCENARIOS);
      expect(e.ok).toBe(true);
      if (!e.ok) continue;
      const r = scenarioSegments(bundle, e.changes, [DEMO_FORECAST_SOLUTION], START, bounds, HPW);
      expect(r.problems, s.name).toEqual([]);
      expect(r.later, s.name).toEqual([]);
    }
    const child = DEMO_SCENARIOS.find((s) => s.id === DEMO_THEN_LEADS_ID)!;
    const eff = effectiveChanges(child, DEMO_SCENARIOS);
    expect(eff.ok && eff.changes.map((c) => [c.scenarioName, c.inherited])).toEqual([["Hire in March", true], ["Hire in March", true], ["Hire in March, then more leads", false]]);
    const r = scenarioSegments(bundle, (eff as { changes: EffectiveChange[] }).changes, [DEMO_FORECAST_SOLUTION], START, bounds, HPW);
    expect(r.segments.map((s) => s.from)).toEqual([0, 6, 7]);
  });

  it("saves, renames and deletes in the tab's store, refusing to delete a parent while another builds on it", () => {
    resetDemoScenarios();
    const row = saveDemoScenario({ id: null, name: "Mine", description: null, parent_id: null, changes: [hire("2027-02-01")], horizon_months: 24 });
    expect(demoScenariosNow().map((s) => s.name)).toEqual(["Hire in January", "Hire in March", "Hire in March, then more leads", "Mine"]);
    expect(row.horizon_months).toBe(24);
    saveDemoScenario({ id: row.id, name: "Aardvark", description: null, parent_id: null, changes: row.changes, horizon_months: 24 });
    expect(demoScenariosNow()[0]!.name).toBe("Aardvark");
    expect(deleteDemoScenario(row.id)).toEqual({ ok: true });
    const refused = deleteDemoScenario(DEMO_SCENARIOS[1]!.id);
    expect(refused).toEqual({ ok: false, message: "Other scenarios build on this one: “Hire in March, then more leads”. Delete them or change what they build on first." });
    expect(demoScenariosNow()).toHaveLength(3);
    resetDemoScenarios();
  });
});

describe("sandboxFailure", () => {
  it("says what went wrong in plain words", () => {
    expect(sandboxFailure({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe("A scenario with that name already exists.");
    expect(sandboxFailure({ code: "23514", message: "sandbox_scenarios: a workspace keeps at most 1000 scenarios" })).toBe("This workspace already has 1,000 scenarios. Delete one first.");
    expect(sandboxFailure({ code: "23514", message: "sandbox_scenarios: scenarios build on each other at most 5 deep" })).toBe("Scenarios can build on each other up to 5 deep.");
    expect(sandboxFailure({ code: "23514", message: "sandbox_scenarios: a scenario cannot build on itself" })).toBe("A scenario can't build on itself.");
    expect(sandboxFailure({ code: "23514", message: 'new row violates check constraint "sandbox_scenarios_changes"' })).toMatch(/up to 200 changes, from up to 6 different months, with up to 4 solutions/);
    expect(sandboxFailure({ code: "42501", message: "denied" })).toBe("You don't have permission to change scenarios here.");
    expect(sandboxFailure({ code: "XX000", message: "boom" })).toBe("Couldn't save the scenario. Try again.");
    expect(sandboxFailure(null)).toBe("Couldn't save the scenario. Try again.");
    expect(SANDBOX_CHANGED_ELSEWHERE).toBe("Someone else changed or deleted this scenario. Reload to see it.");
  });
});
