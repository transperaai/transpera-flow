import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { northbeamPersonIds, northbeamRoleIds, northbeamStepIds, type ForecastPlanMarker, type ProcessBundle, type SolutionRow } from "@transpera-flow/db";
import { simulate, type MonthBusy, type MonthlyResult, type Stat } from "@transpera-flow/engine";
import { comparePlans } from "@/lib/forecast/compare";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_SOLUTION_ID, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { PLAN_CHANGED_ELSEWHERE, planFailure } from "@/lib/forecast/plan-save";
import { applyPlanPeople, leaveEnd, parsePlanInput, planSegments, withSolution } from "@/lib/forecast/plan";
import { DEMO_PLANS, deleteDemoPlan, demoPlansNow, resetDemoPlans, saveDemoPlan } from "@/lib/forecast/plans-demo";
import { addMonths, dateAtPosition, hoursToDate, monthBounds, positionOfDate, stepDate } from "@/lib/forecast/positions";
import { solutionCopy } from "@/lib/solutions/bundle";
import { spliceMonthly } from "@/lib/forecast/splice";
import { timelineData } from "@/lib/forecast/timeline";

// Forecast plans (issue #36, B7): the pure logic. Markers become people and leave in the bundle; a solution marker is a
// spliced run; positions, the comparison and the demo's plans.

const START = DEMO_FORECAST_START;
const HPW = 40;
const PPC = northbeamRoleIds.ppc;
const DAN = northbeamPersonIds["Dan Okafor"]!;
const LEAH = northbeamPersonIds["Leah Brooks"]!;
const id = () => randomUUID();
const hire = (date: string, extra: Record<string, unknown> = {}): ForecastPlanMarker => ({ id: id(), kind: "hire", date, role_id: PPC, fte: 1, ...extra }) as ForecastPlanMarker;
const leave = (date: string, weeks: number, person = DAN): ForecastPlanMarker => ({ id: id(), kind: "leave", date, person_id: person, weeks });
const solution = (date: string, solutionId = DEMO_FORECAST_SOLUTION_ID): ForecastPlanMarker => ({ id: id(), kind: "solution", date, solution_id: solutionId });

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

describe("parsePlanInput", () => {
  const ok = (name: string, markers: unknown[]) => parsePlanInput({ name, markers });

  it("accepts a plan with each kind and trims the name", () => {
    const markers = [hire("2027-01-01", { name: " Jade " }), leave("2026-12-07", 3), solution("2027-04-01")];
    const r = ok("  Hire in January  ", markers);
    expect(r).toMatchObject({ ok: true, value: { name: "Hire in January" } });
    if (r.ok) expect(r.value.markers).toEqual([{ ...markers[0], name: "Jade" }, markers[1], markers[2]]);
  });

  it("refuses every case the database refuses", () => {
    const bad: [string, unknown[]][] = [
      ["unknown kind", [{ id: id(), kind: "fire", date: "2027-01-01" }]],
      ["extra key", [hire("2027-01-01", { rate: 40 })]],
      ["not an object", ["hire"]],
      ["no id", [{ kind: "hire", date: "2027-01-01", role_id: PPC, fte: 1 }]],
      ["duplicate id", [hire("2027-01-01", { id: "11111111-1111-4111-8111-111111111111" }), leave("2027-01-04", 1, DAN) && { ...leave("2027-01-04", 1), id: "11111111-1111-4111-8111-111111111111" }]],
      ["2027-02-30", [hire("2027-02-30")]],
      ["27-01-01", [hire("27-01-01")]],
      ["out of range date", [hire("1999-12-31")]],
      ["a hire dated mid-month", [hire("2027-01-16")]],
      ["a solution dated mid-month", [solution("2027-04-16")]],
      ["leave on a Wednesday", [leave("2027-03-03", 1)]],
      ["fte 0", [hire("2027-01-01", { fte: 0 })]],
      ["fte 2.5", [hire("2027-01-01", { fte: 2.5 })]],
      ["fte string", [hire("2027-01-01", { fte: "1" })]],
      ["weeks 0", [leave("2027-01-04", 0)]],
      ["weeks 53", [leave("2027-01-04", 53)]],
      ["weeks 1.5", [leave("2027-01-04", 1.5)]],
      ["5 solutions", Array.from({ length: 5 }, () => solution("2027-04-01"))],
      ["41 markers", Array.from({ length: 41 }, () => hire("2027-01-01"))],
      ["a name over 120", [hire("2027-01-01", { name: "x".repeat(121) })]],
    ];
    for (const [what, markers] of bad) expect(ok("Plan", markers).ok, what).toBe(false);
    expect(parsePlanInput({ name: "   ", markers: [] }).ok).toBe(false);
    expect(parsePlanInput({ name: "x".repeat(121), markers: [] }).ok).toBe(false);
    expect(parsePlanInput({ name: "Plan", markers: "no" }).ok).toBe(false);
    expect(parsePlanInput(null).ok).toBe(false);
    expect(ok("Plan", Array.from({ length: 40 }, () => hire("2027-01-01"))).ok).toBe(true);
  });

  it("refuses two solutions for one process in one month, and allows them in different months or for different processes", () => {
    const solutions = [
      { id: "aaaaaaaa-0000-4000-8000-000000000001", process_id: "p1" },
      { id: "aaaaaaaa-0000-4000-8000-000000000002", process_id: "p1" },
      { id: "aaaaaaaa-0000-4000-8000-000000000003", process_id: "p2" },
    ];
    const context = { solutions, processName: (p: string) => (p === "p1" ? "Sales pipeline" : "Servicing") };
    const [a, b, c] = solutions.map((s) => s.id) as [string, string, string];
    const same = parsePlanInput({ name: "P", markers: [solution("2027-04-01", a), solution("2027-04-15", b)] }, context);
    expect(same).toEqual({ ok: false, error: "Two solutions for Sales pipeline can't go live in the same month." });
    expect(parsePlanInput({ name: "P", markers: [solution("2027-04-01", a), solution("2027-05-01", b)] }, context).ok).toBe(true);
    expect(parsePlanInput({ name: "P", markers: [solution("2027-04-01", a), solution("2027-04-01", c)] }, context).ok).toBe(true);
  });
});

describe("applyPlanPeople", () => {
  it("adds a hire as a person with a role and a start date, numbering the default names", () => {
    const a = hire("2027-01-01");
    const b = hire("2027-03-01", { fte: 0.5 });
    const { bundle: out, problems } = applyPlanPeople(bundle, [a, b]);
    expect(problems).toEqual([]);
    const added = out.people.slice(bundle.people.length);
    expect(added.map((p) => p.name)).toEqual(["New PPC specialist", "New PPC specialist 2"]);
    expect(added[0]).toMatchObject({ id: a.id, fte: 1, capacity_hours_week: null, cost_rate: null, active: true, start_date: "2027-01-01", end_date: null });
    expect(added[1]).toMatchObject({ fte: 0.5, start_date: "2027-03-01" });
    expect(out.personRoles.slice(bundle.personRoles.length)).toEqual([
      { person_id: a.id, role_id: PPC, workspace_id: bundle.workspace.id },
      { person_id: b.id, role_id: PPC, workspace_id: bundle.workspace.id },
    ]);
    expect(bundle.people.some((p) => p.id === a.id)).toBe(false);
    const model = forecastModel(out, 12, START).model!;
    expect(model.people![a.id]!.from).toBe(hoursToDate(START, "2027-01-01", HPW));
    expect(model.people![a.id]!.roles).toEqual([PPC]);
    expect(forecastModel(out, 12, START).model!.people![b.id]!.name).toBe("New PPC specialist 2");
  });

  it("uses the name typed", () => {
    const { bundle: out } = applyPlanPeople(bundle, [hire("2027-01-01", { name: "Jade" })]);
    expect(out.people.at(-1)!.name).toBe("Jade");
  });

  it("adds leave from the Monday to the Friday of its last week", () => {
    expect(leaveEnd("2026-12-07", 3)).toBe("2026-12-25");
    const m = leave("2026-12-07", 3);
    const { bundle: out, problems } = applyPlanPeople(bundle, [m]);
    expect(problems).toEqual([]);
    expect(out.personLeave.filter((l) => l.person_id === DAN)).toEqual([{ id: m.id, person_id: DAN, workspace_id: bundle.workspace.id, start_date: "2026-12-07", end_date: "2026-12-25" }]);
    const windows = forecastModel(out, 12, START).model!.people![DAN]!.leave!;
    expect(windows).toHaveLength(1);
    expect(windows[0]![1] - windows[0]![0]).toBeCloseTo(15 * 8, 6);
  });

  it("skips a marker whose role, person or person's place is gone, and says so", () => {
    const gone = hire("2027-01-01", { role_id: randomUUID(), name: "New SEO specialist" });
    const noPerson = leave("2027-01-04", 1, randomUUID());
    const inactive = leave("2027-01-04", 1, DAN);
    const fine = hire("2027-02-01");
    const away: ProcessBundle = { ...bundle, people: bundle.people.map((p) => (p.id === DAN ? { ...p, active: false } : p)) };
    const { bundle: out, problems } = applyPlanPeople(away, [gone, noPerson, inactive, fine]);
    expect(problems.map((p) => p.markerId)).toEqual([gone.id, noPerson.id, inactive.id]);
    expect(problems[0]!.message).toBe("The role of “New SEO specialist” isn't there any more");
    expect(problems[2]!.message).toMatch(/Dan Okafor is no longer on the team/);
    expect(out.people).toHaveLength(away.people.length + 1);
    expect(out.personLeave).toEqual(away.personLeave);
  });

  it("merges leave that overlaps or touches Settings' leave, so the engine doesn't count it twice", () => {
    // Settings: Leah is away 14 December to 8 January.
    const settings = bundle.personLeave.filter((l) => l.person_id === LEAH);
    expect(settings).toHaveLength(1);
    const overlap = applyPlanPeople(bundle, [leave("2026-12-21", 2, LEAH)]).bundle;
    expect(overlap.personLeave.filter((l) => l.person_id === LEAH).map((l) => [l.start_date, l.end_date])).toEqual([["2026-12-14", "2027-01-08"]]);
    const touching = applyPlanPeople(bundle, [leave("2027-01-11", 1, LEAH)]).bundle;
    expect(touching.personLeave.filter((l) => l.person_id === LEAH).map((l) => [l.start_date, l.end_date])).toEqual([["2026-12-14", "2027-01-15"]]);
    const apart = applyPlanPeople(bundle, [leave("2027-02-01", 1, LEAH)]).bundle;
    expect(apart.personLeave.filter((l) => l.person_id === LEAH)).toHaveLength(2);
    expect(forecastModel(overlap, 12, START).model!.people![LEAH]!.leave).toHaveLength(1);
    // Two plan leaves for one person that overlap each other.
    const both = applyPlanPeople(bundle, [leave("2027-03-01", 2, DAN), leave("2027-03-08", 2, DAN)]).bundle;
    expect(both.personLeave.filter((l) => l.person_id === DAN).map((l) => [l.start_date, l.end_date])).toEqual([["2027-03-01", "2027-03-19"]]);
  });

  it("leaves other people's leave alone", () => {
    const out = applyPlanPeople(bundle, [leave("2027-03-01", 1, DAN)]).bundle;
    expect(out.personLeave.filter((l) => l.person_id === LEAH)).toEqual(bundle.personLeave.filter((l) => l.person_id === LEAH));
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

describe("planSegments", () => {
  const seg = (markers: ForecastPlanMarker[], solutions: SolutionRow[] = [DEMO_FORECAST_SOLUTION]) => planSegments(bundle, markers, solutions, START, bounds, HPW);
  const clone = (name: string, workHours: number, process_id = DEMO_FORECAST_SOLUTION.process_id): SolutionRow => ({
    ...DEMO_FORECAST_SOLUTION,
    id: randomUUID(),
    name,
    process_id,
    steps: { ...DEMO_FORECAST_SOLUTION.steps, steps: DEMO_FORECAST_SOLUTION.steps.steps.map((s) => (s.id === northbeamStepIds.ppc ? { ...s, work_hours: workHours } : s)) },
  });

  it("is one segment for a plan with no solutions, with the people applied", () => {
    const r = seg([hire("2027-01-01")]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ from: 0, solutionIds: [] });
    expect(r.segments[0]!.bundle.people).toHaveLength(bundle.people.length + 1);
  });

  it("starts a segment for each distinct go-live month, with every solution live by then", () => {
    const servicing = bundle.otherProcesses![0]!;
    const other: SolutionRow = { ...DEMO_FORECAST_SOLUTION, id: randomUUID(), name: "Other", process_id: servicing.process.id, steps: solutionCopy({ steps: servicing.steps, edges: [] }) };
    // The 1st of the fourth month, and a solution of another process in the same month: one segment with both.
    const r = seg([solution("2027-01-01"), solution("2027-01-01", other.id)], [DEMO_FORECAST_SOLUTION, other]);
    expect(r.segments.map((s) => s.from)).toEqual([0, 3]);
    expect(r.segments[0]!.solutionIds).toEqual([]);
    expect(r.segments[1]!.solutionIds.sort()).toEqual([DEMO_FORECAST_SOLUTION.id, other.id].sort());
  });

  it("puts a solution from month 0 in the only segment", () => {
    for (const date of ["2026-10-01", "2026-10-05", "2020-01-01"]) {
      const r = seg([solution(date)]);
      expect(r.segments).toHaveLength(1);
      expect(r.segments[0]!.solutionIds).toEqual([DEMO_FORECAST_SOLUTION_ID]);
    }
  });

  it("leaves out a solution at or after the horizon and lists it", () => {
    const m = solution("2027-10-04");
    const r = seg([m, solution("2028-06-01", randomUUID())]);
    expect(r.later).toEqual([m.id]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.solutionIds).toEqual([]);
  });

  it("lets the later solution of one process replace the earlier one from its month", () => {
    const first = clone("Fast", 4);
    const second = clone("Faster", 2);
    const r = seg([solution("2027-01-01", first.id), solution("2027-04-01", second.id)], [first, second]);
    expect(r.segments.map((s) => s.from)).toEqual([0, 3, 6]);
    const work = (s: (typeof r.segments)[number]) => forecastModel(s.bundle, 12, START).model!.steps.find((x) => x.id === northbeamStepIds.ppc)!.work;
    expect(r.segments.map(work)).toEqual([8, 4, 2]);
    expect(r.segments[2]!.solutionIds.at(-1)).toBe(second.id);
  });

  it("skips a missing solution and one of a process outside the model, as problems, and still runs the rest", () => {
    const stray = clone("Stray", 1, randomUUID());
    const r = seg([solution("2027-01-01", randomUUID()), solution("2027-02-01", stray.id), hire("2027-01-01")], [stray]);
    expect(r.problems.map((p) => p.message)).toEqual(["A solution in this plan was deleted", "“Stray” changes a process the forecast doesn't run"]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.bundle.people).toHaveLength(bundle.people.length + 1);
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

describe("a solution marker applies that solution's changes from its month only", () => {
  const goLive = "2027-01-01";
  const month = 3;
  const sol = DEMO_FORECAST_SOLUTION;
  const plan = planSegments(bundle, [solution(goLive)], [sol], START, bounds, HPW);
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
    const at0 = planSegments(bundle, [solution("2026-10-01")], [sol], START, bounds, HPW);
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

describe("comparePlans", () => {
  const a = fake(4, 0.5, 10, 100);
  const b = fake(4, 0.9, 10, 160, { atRisk: { svc: Array.from({ length: 4 }, () => stat(3, 0.5)) }, roles: { r: Array.from({ length: 4 }, () => busy(0.9)), extra: Array.from({ length: 4 }, () => null) } });
  const model = { ...live, roles: { ...live.roles, r: { name: "Role R", count: 1 }, extra: { name: "Extra", count: 0 } } } as unknown as typeof live;
  const services = [{ id: "svc", name: "PPC" }] as ProcessBundle["services"];
  const c = comparePlans(model, a, b, { services }, START, [0.7, 0.85, 0.95]);

  it("has the difference of the averages, and null where a role isn't there", () => {
    expect(c.mrr.diff).toEqual([60, 60, 60, 60]);
    expect(c.mrr.a).toBe(a.mrr);
    expect(c.atRisk.map((r) => [r.id, r.name])).toEqual([["svc", "PPC"]]);
    expect(c.atRisk[0]!.diff).toEqual([2, 2, 2, 2]);
    expect(c.roles.map((r) => r.id)).toEqual(["r"]);
    const lopsided = comparePlans(model, { ...a, roles: { r: a.roles.r!, extra: [busy(0.4), null, null, null] } }, b, { services }, START, [0.7, 0.85, 0.95]);
    expect(lopsided.roles.find((r) => r.id === "extra")!.diff).toEqual([null, null, null, null]);
  });

  it("totals the last month and the months a role is too busy", () => {
    expect(c.totals.mrr).toEqual([130, 190]);
    expect(c.totals.atRisk).toEqual([1, 3]);
    expect(c.totals.tooBusyMonths).toEqual([0, 4]);
    expect(c.months).toHaveLength(4);
  });

  it("has no clients at risk for a pooled model", () => {
    const pooled = comparePlans(model, { ...a, atRisk: {} }, { ...b, atRisk: {} }, { services }, START, [0.7, 0.85, 0.95]);
    expect(pooled.atRisk).toEqual([]);
    expect(pooled.totals.atRisk).toBeNull();
  });
});

describe("timelineData with a plan", () => {
  const planned = applyPlanPeople(bundle, [hire("2027-01-01"), leave("2026-12-07", 1, DAN)]).bundle;
  const f = forecastModel(planned, 12, START);
  const r = simulate(f.model!, 10, 1, { monthly: true, monthStarts: f.monthStarts! });
  const planPeople = new Set([planned.people.at(-1)!.id]);

  it("draws Settings' markers from the model without the plan, and names the plan's people", () => {
    const data = timelineData(f.model!, r, planned, START, { markersModel: live, planPeople })!;
    expect(data.markers.map((m) => m.personId).sort()).toEqual([...new Set(live.people ? Object.entries(live.people).filter(([, p]) => (p.from ?? 0) > 0 || p.leave?.length).map(([pid]) => pid) : [])].sort());
    expect(data.markers.some((m) => m.personId === planned.people.at(-1)!.id)).toBe(false);
    expect(data.people.map((p) => p.name)).toContain("New PPC specialist (plan)");
  });

  it("is unchanged without options", () => {
    const plain = timelineData(f.model!, r, planned, START)!;
    expect(plain.markers.some((m) => m.personId === planned.people.at(-1)!.id)).toBe(true);
    expect(plain.people.map((p) => p.name)).toContain("New PPC specialist");
    expect(timelineData(f.model!, r, planned, START, {})).toEqual(plain);
  });
});

describe("the demo's plans", () => {
  it("opens with two plans that parse and apply cleanly", () => {
    resetDemoPlans();
    expect(demoPlansNow().map((p) => p.name)).toEqual(["Hire in January", "Hire in March"]);
    for (const p of DEMO_PLANS) {
      expect(parsePlanInput({ name: p.name, markers: p.markers }).ok).toBe(true);
      const r = planSegments(bundle, p.markers, [DEMO_FORECAST_SOLUTION], START, bounds, HPW);
      expect(r.problems).toEqual([]);
      expect(r.later).toEqual([]);
    }
    expect(planSegments(bundle, DEMO_PLANS[1]!.markers, [DEMO_FORECAST_SOLUTION], START, bounds, HPW).segments.map((s) => s.from)).toEqual([0, 6]);
  });

  it("saves, renames and deletes in the tab's store", () => {
    resetDemoPlans();
    const row = saveDemoPlan({ id: null, name: "Mine", markers: [hire("2027-02-01")] });
    expect(demoPlansNow().map((p) => p.name)).toEqual(["Hire in January", "Hire in March", "Mine"]);
    saveDemoPlan({ id: row.id, name: "Aardvark", markers: row.markers });
    expect(demoPlansNow().map((p) => p.name)).toEqual(["Aardvark", "Hire in January", "Hire in March"]);
    deleteDemoPlan(row.id);
    expect(demoPlansNow()).toHaveLength(2);
    resetDemoPlans();
  });
});

describe("planFailure", () => {
  it("says what went wrong in plain words", () => {
    expect(planFailure({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe("A plan with that name already exists.");
    expect(planFailure({ code: "23514", message: "forecast_plans: a workspace keeps at most 50 plans" })).toBe("This workspace already has 50 plans. Delete one first.");
    expect(planFailure({ code: "23514", message: "forecast_plans: a plan has at most 4 solutions" })).toBe("A plan can have up to 4 solutions.");
    for (const what of ["a hire needs a role of this workspace", "leave needs a person of this workspace", "a solution marker needs a solution of this workspace"]) {
      expect(planFailure({ code: "23514", message: `forecast_plans: ${what}` })).toBe("Something in this plan isn't there any more. Reload and try again.");
    }
    expect(planFailure({ code: "42501", message: "forecast_plans: you cannot edit this workspace" })).toBe("You don't have permission to change plans here.");
    expect(planFailure({ code: "XX000", message: "boom" })).toBe("Couldn't save the plan. Try again.");
    expect(planFailure(null)).toBe("Couldn't save the plan. Try again.");
    expect(PLAN_CHANGED_ELSEWHERE).toBe("Someone else changed or deleted this plan. Reload to see it.");
  });
});
