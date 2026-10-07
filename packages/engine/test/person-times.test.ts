import { describe, expect, it } from "vitest";
import {
  calibrate,
  proposePersonTimes,
  stepIdsByName,
  type CalibrationStep,
  type PersonTimesPerson,
  type StepLogRow,
} from "../src";

// Per-person times from a log that names people (docs/PRD.md §6.3.7; issue #227).

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 9);
const est = { work: "estimated", wait: "estimated", rework: "estimated", routing: "estimated" } as const;

function step(id: string, extra: Partial<CalibrationStep> = {}): CalibrationStep {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    kind: "task",
    workHours: 1,
    workDist: "lognormal",
    workCv: null,
    waitHours: 0,
    waitDist: "lognormal",
    waitCv: null,
    rework: 0,
    worked: true,
    sources: est,
    ...extra,
  };
}

let seq = 0;
function visits(stepName: string, person: string | null, hours: number[]): StepLogRow[] {
  return hours.map((h) => ({ item: `i${seq++}`, step: stepName, started: T0 + seq * HOUR, finished: T0 + seq * HOUR + 1, hours: h, source: null, person }));
}

const person = (id: string, canDo: string[], extra: Partial<PersonTimesPerson> = {}): PersonTimesPerson => ({ id, canDo, every: null, steps: {}, ...extra });

const STEPS = [step("kickoff"), step("audit")];
const alt = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? b : a));

describe("proposePersonTimes", () => {
  it("proposes each person's time against the step's mean, and says nothing about anyone else", () => {
    const rows = [...visits("Kickoff", "sam", Array(12).fill(2)), ...visits("Kickoff", "jo", Array(12).fill(3))];
    const { proposals, minSample } = proposePersonTimes({ steps: STEPS, rows, people: [person("sam", ["kickoff"]), person("jo", ["kickoff"])] });
    expect(minSample).toBe(10);
    expect(proposals.map((p) => [p.personId, p.proposed, p.n, p.stepN, p.measured])).toEqual([
      ["sam", 0.8, 12, 24, 0.8],
      ["jo", 1.2, 12, 24, 1.2],
    ]);
    const sam = proposals[0]!;
    expect(sam.key).toBe("factor:sam:kickoff");
    expect(sam.set).toEqual({ factor: 0.8 });
    expect(sam.before).toEqual({ factor: null });
    expect(sam.target).toEqual({ table: "person_capacity_factors", id: "sam", step_id: "kickoff" });
    expect(sam.note).toContain("12 of the step's 24 logged visits");
    expect(sam.note).toContain("0.8 ×");
    expect(sam.note).not.toMatch(/sam|jo|1\.2/i);
  });

  it("blocks, in order: can't do, person under 10, all visits theirs, zero hours", () => {
    const run = (rows: StepLogRow[], p: PersonTimesPerson) => proposePersonTimes({ steps: STEPS, rows, people: [p] }).proposals[0]!;
    const cant = run([...visits("Kickoff", "a", Array(12).fill(1)), ...visits("Kickoff", null, Array(12).fill(2))], person("a", []));
    expect(cant.blocked).toMatch(/^Not one of the steps this person does/);
    const few = run([...visits("Kickoff", "a", Array(4).fill(1)), ...visits("Kickoff", null, Array(12).fill(2))], person("a", ["kickoff"]));
    expect(few.blocked).toBe("Too few to measure: 4 of the 10 needed.");
    expect(few.enough).toBe(false);
    const small = run(visits("Kickoff", "a", Array(10).fill(1)), person("a", ["kickoff"]));
    expect(small.blocked).toBe("Every logged visit at this step is theirs, so the step's normal time is already their time.");
    const zero = run([...visits("Kickoff", "a", Array(10).fill(0)), ...visits("Kickoff", null, Array(10).fill(0))], person("a", ["kickoff"]));
    expect(zero.blocked).toBe("The step's logged hands-on hours are all zero.");
    for (const b of [cant, few, small, zero]) {
      expect([b.measured, b.proposed, b.set, b.before, b.changed]).toEqual([null, null, null, null, false]);
    }
    // "The step has N visits, M needed" can't be reached while n >= minSample (the step has at least n): it guards the order.
  });

  it("limits to 0.5 and 2, and tells a small difference in a wide spread from a clear one", () => {
    const low = proposePersonTimes({
      steps: STEPS,
      rows: [...visits("Kickoff", "a", Array(10).fill(0.2)), ...visits("Kickoff", null, Array(10).fill(10))],
      people: [person("a", ["kickoff"])],
    }).proposals[0]!;
    expect(low.proposed).toBe(0.5);
    expect(low.limited).toBe(true);
    expect(low.measured).toBeLessThan(0.5);
    expect(low.note).toContain("so 0.5 is proposed");
    const high = proposePersonTimes({
      steps: STEPS,
      rows: [...visits("Kickoff", "a", Array(10).fill(100)), ...visits("Kickoff", null, Array(100).fill(1))],
      people: [person("a", ["kickoff"])],
    }).proposals[0]!;
    expect(high.proposed).toBe(2);
    expect(high.limited).toBe(true);

    // Person mean 2.2 vs others 2.0 with a wide spread: within the usual spread.
    const wide = proposePersonTimes({
      steps: STEPS,
      rows: [...visits("Kickoff", "a", alt(0.2, 4.2, 10)), ...visits("Kickoff", null, alt(0.1, 3.9, 10))],
      people: [person("a", ["kickoff"])],
    }).proposals[0]!;
    expect(wide.within).toBe(true);
    expect(wide.limited).toBe(false);
    expect(wide.note).toContain("within the usual spread");
    // A clear difference with a tight spread.
    const clear = proposePersonTimes({
      steps: STEPS,
      rows: [...visits("Kickoff", "a", alt(1.9, 2.1, 10)), ...visits("Kickoff", null, alt(2.9, 3.1, 10))],
      people: [person("a", ["kickoff"])],
    }).proposals[0]!;
    expect(clear.within).toBe(false);
  });

  it("compares with the stored step time, then the every-step time, then normal", () => {
    const rows = [...visits("Kickoff", "a", Array(10).fill(2)), ...visits("Kickoff", null, Array(10).fill(3))]; // 0.8
    const run = (p: PersonTimesPerson) => proposePersonTimes({ steps: STEPS, rows, people: [p] }).proposals[0]!;
    const same = run(person("a", ["kickoff"], { steps: { kickoff: { factor: 0.8, source: "entered" } } }));
    expect([same.changed, same.current, same.currentSource, same.before]).toEqual([false, 0.8, "entered", { factor: 0.8 }]);
    expect(run(person("a", ["kickoff"], { steps: { kickoff: { factor: 1.1, source: "measured" } } })).changed).toBe(true);
    // Every step only: counts for `changed`, `current` stays null.
    const every = run(person("a", ["kickoff"], { every: { factor: 0.8, source: "entered" } }));
    expect([every.changed, every.current, every.every, every.before]).toEqual([false, null, 0.8, { factor: null }]);
    expect(run(person("a", ["kickoff"], { every: { factor: 1.3, source: "entered" } })).changed).toBe(true);
    // Nothing: compared with 1.
    expect(run(person("a", ["kickoff"])).changed).toBe(true);
    const normal = proposePersonTimes({
      steps: STEPS,
      rows: [...visits("Kickoff", "a", Array(10).fill(2)), ...visits("Kickoff", null, Array(10).fill(2))],
      people: [person("a", ["kickoff"])],
    }).proposals[0]!;
    expect(normal.changed).toBe(false);
  });

  it("keeps the order of the people and steps given, whatever the values", () => {
    const people = [person("c", ["kickoff", "audit"]), person("a", ["kickoff", "audit"]), person("b", ["kickoff", "audit"])];
    const mk = (hs: Record<string, number>) => {
      const rows: StepLogRow[] = [];
      for (const [p, h] of Object.entries(hs)) for (const s of ["Audit", "Kickoff"]) rows.push(...visits(s, p, Array(10).fill(h)));
      rows.push(...visits("Audit", null, Array(10).fill(2)), ...visits("Kickoff", null, Array(10).fill(2)));
      return rows;
    };
    const order = (rows: StepLogRow[]) => proposePersonTimes({ steps: STEPS, rows, people }).proposals.map((p) => p.key);
    const expected = ["factor:c:kickoff", "factor:c:audit", "factor:a:kickoff", "factor:a:audit", "factor:b:kickoff", "factor:b:audit"];
    expect(order(mk({ a: 1, b: 2, c: 3 }))).toEqual(expected);
    expect(order(mk({ a: 3, b: 1, c: 2 }))).toEqual(expected);
  });

  it("is deterministic, and the order of rows doesn't matter", () => {
    const rows = [...visits("Kickoff", "a", alt(1, 2, 14)), ...visits("Kickoff", "b", alt(2, 4, 14)), ...visits("Kickoff", null, alt(1, 3, 6))];
    const people = [person("a", ["kickoff"]), person("b", ["kickoff"])];
    const one = proposePersonTimes({ steps: STEPS, rows, people });
    expect(proposePersonTimes({ steps: STEPS, rows, people })).toEqual(one);
    expect(proposePersonTimes({ steps: STEPS, rows: [...rows].reverse(), people })).toEqual(one);
  });

  it("ignores unmatched steps, ignored steps and visits without hours", () => {
    const rows = [
      ...visits("Nowhere", "a", Array(12).fill(1)),
      ...visits("Kickoff", "a", Array(10).fill(1)),
      ...visits("Kickoff", null, Array(10).fill(2)),
      { item: "x", step: "Kickoff", started: T0, finished: null, hours: null, source: null, person: "a" },
    ];
    const { proposals } = proposePersonTimes({ steps: [...STEPS, step("wait", { kind: "wait", worked: false })], rows, people: [person("a", ["kickoff"])] });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.n).toBe(10);
    expect(proposals[0]!.stepN).toBe(20);
  });
});

describe("stepIdsByName", () => {
  it("matches names ignoring case and spacing, and a shared name matches neither", () => {
    const m = stepIdsByName([
      { id: "1", name: "Kick  Off" },
      { id: "2", name: "audit" },
      { id: "3", name: "Audit" },
    ]);
    expect(m.get("kick off")).toBe("1");
    expect(m.get("audit")).toBeNull();
  });

  it("leaves calibrate's output unchanged by a person on the rows", () => {
    const steps = [step("kickoff"), step("kickoff2", { name: "Kickoff" })];
    const rows = [...visits("Kickoff", null, Array(10).fill(2)), ...visits("Audit", null, [1]), ...visits("kickoff2", null, Array(11).fill(2))];
    const named = rows.map((r, i) => ({ ...r, person: i % 2 ? "x" : null }));
    const run = (r: StepLogRow[]) => calibrate({ steps: [...steps, step("audit")], edges: [], rows: r, hoursPerWeek: 40 });
    expect(JSON.stringify(run(named))).toBe(JSON.stringify(run(rows)));
  });
});
