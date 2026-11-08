import { describe, expect, it } from "vitest";
import { DEFAULT_PURPOSES, type PurposeCategory } from "@transpera-flow/db";
import { larkspurWithPurposes, simulate, type MonthlyResult, type Stat, type TimeSplit } from "@transpera-flow/engine";
import { DEMO_FORECAST_START } from "@/lib/forecast/demo";
import { SMALL_TEAM_NOTE, spliceMonthly } from "@transpera-flow/db/sandbox";
import { timelineMonths } from "@/lib/forecast/timeline";
import { IDLE, NOT_SET, UNCOVERED, personChoices, stackOf, timeView } from "@/lib/sandbox/time";
import { fakeSplit, fakeTime } from "./fake-time";

// Where the time goes (sandbox phase 4): the engine's per-purpose hours read as rows of hours and shares. Pure.

const stat = (mean: number, spread = 1): Stat => ({ mean, p10: mean - spread, p90: mean + spread });
const series = (...v: number[]): Stat[] => v.map((m) => stat(m));

/** Three months, a hand-made split: 100 hours available a month, 30 client job, 10 winning, 15 fixing's own, 5 rework, 20 client hours, 10 idle, 10 not drawn. */
const split = (over: Partial<TimeSplit> = {}): TimeSplit => ({
  purpose: { client_job: series(30, 30, 30), winning: series(10, 10, 10), fixing: series(15, 15, 15), mystery: series(10, 0, 0) },
  rework: series(5, 5, 5),
  // The engine's range of each key plus the rework, per replication: narrower than the two ranges added.
  withRework: { client_job: series(35, 35, 35), winning: series(15, 15, 15), fixing: [stat(20, 0.5), stat(20, 0.5), stat(20, 0.5)], mystery: series(15, 5, 5) },
  ongoing: series(20, 20, 20),
  idle: series(10, 20, 20),
  hours: series(100, 100, 100),
  uncovered: series(4, 0, 0),
  ...over,
});
const monthly = (team: TimeSplit, people: Record<string, TimeSplit> = {}, roles: Record<string, TimeSplit> = {}): MonthlyResult =>
  ({ months: [0, 1, 2].map((i) => ({ start: i * 160, end: (i + 1) * 160 })), time: { purposes: ["client_job", "winning", "fixing", "mystery"], roles, people, team } }) as unknown as MonthlyResult;
const months = timelineMonths(DEMO_FORECAST_START, [0, 1, 2].map((i) => ({ start: i * 160, end: (i + 1) * 160 })), 40);
const rowOf = (v: ReturnType<typeof timeView>, id: string) => v.rows.find((r) => r.id === id)!;

describe("timeView", () => {
  const view = timeView(monthly(split()), months, DEFAULT_PURPOSES, { kind: "team" });

  it("has a row per category in the list's order, then Idle and the work nobody was there for", () => {
    expect(view.rows.map((r) => r.id)).toEqual([...DEFAULT_PURPOSES.map((c) => c.key), NOT_SET, IDLE, UNCOVERED]);
    expect(view.rows.map((r) => r.name).slice(0, 3)).toEqual(["Moves the client's job forward", "Client upkeep", "Required"]);
  });

  it("counts rework as Fixing and the client hours that are not steps as Client upkeep", () => {
    expect(rowOf(view, "fixing").hours.map((s) => s.mean)).toEqual([20, 20, 20]);
    // Its range is the engine's range of the sum, not the two ranges added (which would be 18 to 22).
    expect(rowOf(view, "fixing").hours[0]).toEqual({ mean: 20, p10: 19.5, p90: 20.5 });
    expect(rowOf(view, "client_upkeep").hours.map((s) => s.mean)).toEqual([20, 20, 20]);
    expect(rowOf(view, "client_job").hours.map((s) => s.mean)).toEqual([30, 30, 30]);
    // Client hours are not folded into the client's job.
    expect(rowOf(view, "client_job").runHours).toBe(90);
  });

  it("puts a key the list doesn't have in Not set", () => {
    expect(rowOf(view, NOT_SET).hours.map((s) => s.mean)).toEqual([10, 0, 0]);
    // And leaves the row out when nothing is in it.
    expect(timeView(monthly(split({ purpose: { client_job: series(1, 1, 1) } })), months, DEFAULT_PURPOSES, { kind: "team" }).rows.some((r) => r.id === NOT_SET)).toBe(false);
  });

  it("shares are hours over the hours available; they add up to 100% without overtime, with uncovered outside it", () => {
    for (const m of [0, 1, 2]) {
      const stack = stackOf(view, m);
      expect(stack.reduce((a, r) => a + r.share, 0), `month ${m}`).toBeCloseTo(1, 9);
      expect(stack.some((r) => r.id === UNCOVERED)).toBe(false);
    }
    expect(rowOf(view, "fixing").share[0]).toBeCloseTo(0.2, 9);
    expect(rowOf(view, UNCOVERED).hours[0]!.mean).toBe(4);
  });

  it("flags a month where there is more work than hours: idle is 0 and the stack goes above 100%", () => {
    const over = timeView(monthly(split({ idle: series(0, 20, 20), hours: series(80, 100, 100) })), months, DEFAULT_PURPOSES, { kind: "team" });
    expect(over.over).toEqual([true, false, false]);
    expect(stackOf(over, 0).reduce((a, r) => a + r.share, 0)).toBeGreaterThan(1);
    expect(over.notes.join(" ")).toMatch(/overtime is capped/);
    expect(view.notes.join(" ")).not.toMatch(/overtime is capped/);
  });

  it("whole-run share is hours over hours, with no range", () => {
    expect(rowOf(view, "fixing").runHours).toBe(60);
    expect(rowOf(view, "fixing").runShare).toBeCloseTo(60 / 300, 9);
  });

  it("follows a rename and a reorder of the list without a new run", () => {
    const list: PurposeCategory[] = [...DEFAULT_PURPOSES].reverse().map((c) => (c.key === "winning" ? { ...c, name: "Selling" } : c));
    const again = timeView(monthly(split()), months, list, { kind: "team" });
    expect(again.rows.slice(0, 2).map((r) => r.id)).toEqual(["removable", "fixing"]);
    expect(rowOf(again, "winning").name).toBe("Selling");
    expect(rowOf(again, "winning").hours).toEqual(rowOf(view, "winning").hours);
  });
});

describe("timeView scopes", () => {
  const people = { ann: split({ uncovered: null, hours: series(40, 40, 40), idle: series(0, 0, 0), purpose: { client_job: series(20, 20, 20), winning: series(0, 0, 0), fixing: series(0, 0, 0) }, rework: series(5, 5, 5), withRework: { client_job: series(25, 25, 25), winning: series(5, 5, 5), fixing: series(5, 5, 5) }, ongoing: series(15, 15, 15) }) };
  const roles = { design: split({ hours: series(60, 60, 60) }) };
  const m = monthly(split(), people, roles);

  it("a role reads its own split; a person theirs, with no uncovered row", () => {
    expect(timeView(m, months, DEFAULT_PURPOSES, { kind: "role", id: "design" }).total.map((s) => s.mean)).toEqual([60, 60, 60]);
    const ann = timeView(m, months, DEFAULT_PURPOSES, { kind: "person", id: "ann" });
    expect(ann.total.map((s) => s.mean)).toEqual([40, 40, 40]);
    expect(ann.rows.some((r) => r.id === UNCOVERED)).toBe(false);
    expect(rowOf(ann, "fixing").hours.map((s) => s.mean)).toEqual([5, 5, 5]);
  });

  it("'everyone else' is the team less one person, month by month", () => {
    const others = timeView(m, months, DEFAULT_PURPOSES, { kind: "others", except: "ann" });
    expect(others.total.map((s) => s.mean)).toEqual([60, 60, 60]);
    expect(rowOf(others, "client_job").hours.map((s) => s.mean)).toEqual([10, 10, 10]);
    expect(rowOf(others, "fixing").hours.map((s) => s.mean)).toEqual([15, 15, 15]);
    // The individual is not in the others' rows, and the others plus the person add up to the team.
    const ann = timeView(m, months, DEFAULT_PURPOSES, { kind: "person", id: "ann" });
    const team = timeView(m, months, DEFAULT_PURPOSES, { kind: "team" });
    for (const r of team.rows.filter((r) => r.kind === "category")) expect((rowOf(others, r.id)?.runHours ?? 0) + (rowOf(ann, r.id)?.runHours ?? 0), r.id).toBeCloseTo(r.runHours, 9);
  });

  it("falls back to the team when the person isn't in the run", () => {
    expect(timeView(m, months, DEFAULT_PURPOSES, { kind: "others", except: "nobody" }).total).toEqual(timeView(m, months, DEFAULT_PURPOSES, { kind: "team" }).total);
  });
});

describe("a real run", () => {
  const model = { ...larkspurWithPurposes(), horizonWeeks: 26 };
  const result = simulate(model, 6, 1, { monthly: true }).monthly!;
  const ms = timelineMonths(DEMO_FORECAST_START, result.months, model.hoursPerWeek);

  it("has every default category's hours, rework in Fixing and client hours in Client upkeep", () => {
    const v = timeView(result, ms, DEFAULT_PURPOSES, { kind: "team" });
    for (const id of ["client_job", "client_upkeep", "winning", "required", "coordination", "fixing", "removable"]) expect(rowOf(v, id).runHours, id).toBeGreaterThan(0);
    const fixing = result.time.team.purpose.fixing;
    expect(fixing).toBeUndefined();
    expect(rowOf(v, "fixing").runHours).toBeCloseTo(result.time.team.rework.reduce((a, s) => a + s.mean, 0), 6);
    expect(rowOf(v, "client_upkeep").runHours).toBeCloseTo(result.time.team.ongoing.reduce((a, s) => a + s.mean, 0), 6);
  });

  it("each person's rows add up to the hours available when nobody is over", () => {
    for (const id of Object.keys(result.time.people)) {
      const v = timeView(result, ms, DEFAULT_PURPOSES, { kind: "person", id });
      v.months.forEach((_, m) => {
        const sum = stackOf(v, m).reduce((a, r) => a + r.share, 0);
        if (!v.over[m] && v.total[m]!.mean > 0) expect(sum, `${id} month ${m}`).toBeCloseTo(1, 1);
      });
    }
  });
});

describe("spliceMonthly splices time as flows", () => {
  const mk = (level: number, uncovered = false) => ({ time: { ...fakeTime(4, level), team: fakeSplit(4, level, uncovered) } }) as unknown as MonthlyResult;
  const base = (level: number) => ({ ...(spliceMonthlyBase(level)) });
  function spliceMonthlyBase(level: number): MonthlyResult {
    // A full hand-made result is in sandbox-run.test.ts; only the parts the splice reads for `time` matter here, so borrow its shape.
    return { ...({} as MonthlyResult), ...mk(level), months: Array.from({ length: 4 }, (_, i) => ({ start: i, end: i + 1 })), roles: {}, uncovered: {}, people: {}, waits: {}, lateTasks: Array.from({ length: 4 }, () => stat(0)), clients: {}, atRisk: {}, mrr: Array.from({ length: 4 }, () => stat(0)), sales: { opportunities: [], won: [], lost: [], conversion: [] }, clientsWon: [], clientsLost: [], revenue: { total: [], recurring: [], oneOff: [], hourly: [], fromNew: [], lostToChurn: [], rise: [] }, overtimeHours: [], money: null } as unknown as MonthlyResult;
  }
  it("month m takes the segment that holds it, for the team, a role and a person", () => {
    const spliced = spliceMonthly([
      { from: 0, monthly: base(1) },
      { from: 2, monthly: base(3) },
    ]);
    expect(spliced.time.team.hours.map((s) => s.mean)).toEqual([...fakeSplit(4, 1).hours.slice(0, 2), ...fakeSplit(4, 3).hours.slice(2)].map((s) => s.mean));
    expect(spliced.time.team.rework.map((s) => s.mean)).toEqual([1, 1, 3, 3]);
    expect(spliced.time.team.purpose.fixing!.map((s) => s.mean)).toEqual([2, 2, 6, 6]);
    expect(spliced.time.purposes).toEqual(["client_job", "winning", "fixing"]);
  });
  it("a role or person missing from a segment is a zero series there", () => {
    const withRole = { ...base(1), time: fakeTime(4, 1) };
    const without = { ...base(2), time: { ...fakeTime(4, 2), roles: {}, people: {} } };
    const spliced = spliceMonthly([{ from: 0, monthly: withRole }, { from: 2, monthly: without }]);
    expect(spliced.time.roles.r!.rework.map((s) => s.mean)).toEqual([1, 1, 0, 0]);
    expect(spliced.time.people.p!.hours.map((s) => s.mean).slice(2)).toEqual([0, 0]);
  });
  it("the union of purposes in first-seen order, and uncovered kept when any segment has it", () => {
    const a = base(1);
    const b = { ...base(2), time: { ...fakeTime(4, 2), purposes: ["client_job", "extra"], team: { ...fakeSplit(4, 2, true), purpose: { client_job: fakeSplit(4, 2).purpose.client_job!, extra: fakeSplit(4, 2).purpose.fixing! } } } };
    const spliced = spliceMonthly([{ from: 0, monthly: a }, { from: 2, monthly: b }]);
    expect(spliced.time.purposes).toEqual(["client_job", "winning", "fixing", "extra"]);
    expect(spliced.time.team.purpose.extra!.map((s) => s.mean)).toEqual([0, 0, 4, 4]);
    expect(spliced.time.team.uncovered!.map((s) => s.mean)).toEqual([0, 0, 5, 5]);
  });
});

describe("personChoices: who a Viewer may see by person (Austin, 30 Oct)", () => {
  const team = (ids: string[]) => monthly(split(), Object.fromEntries(ids.map((id) => [id, split()])));
  const named = (ids: string[]) => ids.map((id) => ({ id, name: `Person ${id}` }));
  const viewer = { seesEveryone: false, ownPersonId: "a" };
  const admin = { seesEveryone: true, ownPersonId: null };

  it("a Viewer in a team of 2 gets only You, and the note", () => {
    const ids = ["a", "b"];
    expect(personChoices(team(ids), named(ids), viewer)).toEqual({ options: [{ value: "a", label: "You" }], note: SMALL_TEAM_NOTE });
    expect(SMALL_TEAM_NOTE).toBe("Everyone else isn't shown in a team this small.");
  });
  it("a Viewer in a team of 1 gets only You, and the note", () => {
    expect(personChoices(team(["a"]), named(["a"]), viewer)).toEqual({ options: [{ value: "a", label: "You" }], note: SMALL_TEAM_NOTE });
  });
  it("a Viewer in a team of 3 gets You and Everyone else, and no note", () => {
    const ids = ["a", "b", "c"];
    expect(personChoices(team(ids), named(ids), viewer)).toEqual({ options: [{ value: "a", label: "You" }, { value: "others", label: "Everyone else" }], note: null });
  });
  it("counts the people the split covers in that run, not the people in the workspace", () => {
    expect(personChoices(team(["a", "b"]), named(["a", "b", "c", "d"]), viewer).options).toEqual([{ value: "a", label: "You" }]);
  });
  it("a Viewer who is not in the run gets no names in a small team", () => {
    expect(personChoices(team(["b", "c"]), named(["b", "c"]), viewer)).toEqual({ options: [], note: SMALL_TEAM_NOTE });
  });
  it("an admin or the Owner sees every person by name in a team of 2 and of 3, with no note and no Everyone else", () => {
    for (const ids of [["a", "b"], ["a", "b", "c"]]) {
      expect(personChoices(team(ids), named(ids), admin)).toEqual({ options: named(ids).map((p) => ({ value: p.id, label: p.name })), note: null });
    }
  });
});
