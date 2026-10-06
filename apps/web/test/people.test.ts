import { describe, expect, it } from "vitest";
import { larkspurBundle, larkspurPersonIds, speedsNormalisedFor, toEngineModel } from "@transpera-flow/db";
import {
  absenceCandidates,
  absenceRating,
  absenceTest,
  resolvePeople,
  simulate,
  toRatingConfig,
  type AbsenceFinding,
  type AbsenceTest,
  type EnginePerson,
} from "@transpera-flow/engine";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import {
  CAPACITY_FACTOR_MIN_ITEMS,
  absenceCoverage,
  absenceRows,
  capacityFactorsShown,
  factorWords,
  leaveDays,
  personDetail,
  personFactors,
  personRows,
  untestedSoleHolders,
  weeksLabel,
} from "@/lib/people";

// The People page's numbers (B2, issue #31), worked out from a Larkspur run with the start date pinned so leave is stable.

const START = "2026-10-06";
const bundle = larkspurBundle();
const model = toEngineModel(bundle, { startDate: START });
const result = simulate(model, 12, 1);
const fte = new Map(bundle.people.map((p) => [p.id, Number(p.fte)]));
const config = toRatingConfig(ANALYSIS_DEFAULTS, model.hoursPerWeek);
const id = larkspurPersonIds;

describe("personRows", () => {
  const rows = personRows(model, result, fte);

  it("reads client work, sales work and overtime off the run", () => {
    expect(rows.length).toBe(bundle.people.length);
    for (const r of rows) {
      const k = result.kpi.people[r.id]!;
      expect(r.clientWork).toBe(k.ongoing.mean + k.servicing.mean);
      expect(r.salesWork).toBe(k.pipeline.mean);
      expect(r.overtime).toBe(k.overtime.mean);
      expect(r.average).toBe(k.util.mean);
      expect(r.p90).toBe(k.util.p90);
    }
  });

  it("keeps the order: first role in role order, then name (never by how busy)", () => {
    const roleOrder = Object.keys(model.roles);
    const keys = rows.map((r) => {
      const p = result.resolvedPeople[r.id]!;
      return [roleOrder.indexOf(p.roles[0] ?? ""), r.name] as const;
    });
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    expect(keys).toEqual(sorted);
  });

  it("counts leave inside the period", () => {
    const ruby = rows.find((r) => r.id === id.ruby)!;
    expect(ruby.leaveDays).toBe(10);
    expect(rows.find((r) => r.id === id.jess)!.leaveDays).toBe(0);
  });
});

describe("leaveDays", () => {
  const person = (leave?: [number, number][]): EnginePerson => ({ name: "P", roles: [], capacity: 37.5, ...(leave ? { leave } : {}) });
  // A 37.5 hour week has 7.5 hour days; a 10-week period is 375 hours.
  const week = 37.5;
  const horizon = 10 * week;
  it("is 0 with no leave", () => expect(leaveDays(person(), horizon, week)).toBe(0));
  it("counts leave fully inside", () => expect(leaveDays(person([[75, 150]]), horizon, week)).toBe(10));
  it("clips leave straddling the start", () => expect(leaveDays(person([[-15, 15]]), horizon, week)).toBe(2));
  it("clips leave straddling the end", () => expect(leaveDays(person([[360, 400]]), horizon, week)).toBe(2));
  it("ignores leave after the period", () => expect(leaveDays(person([[400, 500]]), horizon, week)).toBe(0));
  it("adds up several periods", () => expect(leaveDays(person([[0, 7.5], [75, 82.5]]), horizon, week)).toBe(2));
  it("uses the workspace day, not the person's hours", () => {
    const partTime: EnginePerson = { ...person([[0, 15]]), capacity: 15 };
    expect(leaveDays(partTime, horizon, week)).toBe(2);
  });
});

describe("absenceRows", () => {
  const test = absenceTest(model, { seed: result.seed, reps: 4 });
  const rows = absenceRows(model, test, config);

  it("has one row per person tested, in the same order as the How busy rows", () => {
    expect(rows.map((r) => r.id).sort()).toEqual(test.people.map((f) => f.personId).sort());
    const busyOrder = personRows(model, result, fte).map((r) => r.id);
    expect(rows.map((r) => r.id)).toEqual(busyOrder.filter((x) => rows.some((r) => r.id === x)));
  });

  it("names the steps only they can do, in model step order", () => {
    const hana = rows.find((r) => r.id === id.hana)!;
    const stepNames = model.steps.filter((s) => absenceCandidates(model).find((c) => c.personId === id.hana)!.stepIds.includes(s.id)).map((s) => s.name);
    expect(hana.steps).toEqual(stepNames);
    expect(hana.steps.length).toBe(2);
    expect(hana.name).toBe(resolvePeople(model)[id.hana]!.name);
    expect(hana.role).not.toBe("");
  });

  it("rates as absenceRating does", () => {
    for (const r of rows) {
      const f = test.people.find((p) => p.personId === r.id)!;
      expect(r.rating).toBe(absenceRating(config, f, { stepId: f.stepIds[0] }));
      expect(r.workLost).toBe(f.workLost);
    }
  });

  it("says how many weeks were watched when the queues didn't recover", () => {
    const f: AbsenceFinding = { ...test.people[0]!, recovered: false, recoveryWeeks: 7 };
    const [row] = absenceRows(model, { ...test, people: [f] }, config);
    expect(row!.recovered).toBe(false);
    expect(row!.weeksWatched).toBe(6);
    expect(row!.rating).toBe("risk");
  });
});

describe("untestedSoleHolders", () => {
  it("lists candidates the test left out", () => {
    const full = absenceTest(model, { seed: 1, reps: 2 });
    expect(untestedSoleHolders(model, full)).toEqual([]);
    const fewer: AbsenceTest = { ...full, people: full.people.slice(0, 1) };
    expect(untestedSoleHolders(model, fewer).sort()).toEqual(
      absenceCandidates(model)
        .map((c) => c.personId)
        .filter((p) => p !== full.people[0]!.personId)
        .sort(),
    );
  });

  it("respects maxPeople", () => {
    const limited = absenceTest(model, { seed: 1, reps: 2, maxPeople: 2 });
    expect(limited.people.length).toBe(2);
    expect(untestedSoleHolders(model, limited).length).toBe(absenceCandidates(model).length - 2);
  });
});

describe("a member's own absence result", () => {
  it("equals the editor's for the same person (common random numbers)", () => {
    const full = absenceTest(model, { seed: 1, reps: 4 });
    const own = absenceTest(model, { seed: 1, reps: 4, personIds: [id.imogen] });
    expect(own.people.length).toBe(1);
    expect(own.people[0]).toEqual(full.people.find((f) => f.personId === id.imogen));
  });

  it("finds nothing for a person who isn't a sole holder", () => {
    expect(absenceTest(model, { seed: 1, reps: 2, personIds: [id.jess] }).people).toEqual([]);
  });
});

describe("capacityFactorsShown", () => {
  const nine = { measuredItems: 9, entered: false };
  const ten = { measuredItems: CAPACITY_FACTOR_MIN_ITEMS, entered: false };
  const entered = { measuredItems: 0, entered: true };
  const on = { capacity_factor_enabled: true };

  it("shows nothing when the setting is off, whatever the factors", () => {
    expect(capacityFactorsShown({}, [ten, entered])).toEqual([]);
    expect(capacityFactorsShown({ capacity_factor_enabled: false }, [ten, entered])).toEqual([]);
    expect(capacityFactorsShown(null, [ten])).toEqual([]);
    expect(capacityFactorsShown(undefined, [ten])).toEqual([]);
  });
  it("needs 10 measured items when on", () => {
    expect(capacityFactorsShown(on, [nine])).toEqual([]);
    expect(capacityFactorsShown(on, [nine, ten])).toEqual([ten]);
  });
  it("shows an entered factor when on", () => expect(capacityFactorsShown(on, [entered])).toEqual([entered]));
  it("reads only a real true", () => {
    expect(capacityFactorsShown({ capacity_factor_enabled: "true" }, [ten, entered])).toEqual([]);
    expect(capacityFactorsShown({ capacity_factor_enabled: 1 }, [ten])).toEqual([]);
  });
  it("shows nothing with no factors", () => expect(capacityFactorsShown(on, [])).toEqual([]));

  it("shows real rows (C6): entered ones when on, none when off", () => {
    const b = larkspurBundle();
    const [first, second] = b.steps;
    b.personCapacityFactors = [
      { person_id: id.jess!, workspace_id: b.workspace.id, step_id: second!.id, factor: 1.25, source: "entered" },
      { person_id: id.jess!, workspace_id: b.workspace.id, step_id: null, factor: 0.9, source: "entered" },
      { person_id: id.jess!, workspace_id: b.workspace.id, step_id: first!.id, factor: 0.8, source: "entered" },
    ];
    const names = new Map(b.steps.map((s) => [s.id, s.name]));
    expect(capacityFactorsShown(b.workspace.settings, personFactors(b, id.jess!, names))).toEqual([]);
    expect(capacityFactorsShown({ ...b.workspace.settings, capacity_factor_enabled: true }, personFactors(b, id.jess!, names))).toHaveLength(3);
  });
});

describe("factorWords", () => {
  it("reads a factor in words", () => {
    expect(factorWords(0.8)).toBe("20% faster");
    expect(factorWords(1)).toBe("normal time");
    expect(factorWords(1.25)).toBe("25% slower");
    expect(factorWords(0.5)).toBe("50% faster");
    expect(factorWords(2)).toBe("100% slower");
    expect(factorWords(0.9)).toBe("10% faster");
  });
});

describe("personFactors", () => {
  const b = larkspurBundle();
  const [s1, s2, s3] = b.steps;
  const names = new Map([s1!, s2!, s3!].map((s) => [s.id, s.name]));
  const row = (person: string, step: string | null, factor: number, source = "entered") => ({ person_id: person, workspace_id: b.workspace.id, step_id: step, factor, source });

  it("puts the default first and then the steps in the process's order, never by value, and drops steps it doesn't know", () => {
    const withRows = {
      ...b,
      personCapacityFactors: [row(id.jess!, s3!.id, 0.6), row(id.jess!, "00000000-0000-4000-8000-00000000dead", 1.9), row(id.jess!, s1!.id, 1.9), row(id.jess!, null, 1.1), row(id.hana!, s2!.id, 0.7)],
    };
    const shown = personFactors(withRows, id.jess!, names);
    expect(shown.map((f) => f.stepName)).toEqual(["Every step", s1!.name, s3!.name]);
    expect(shown.map((f) => f.factor)).toEqual([1.1, 1.9, 0.6]);
    expect(shown[0]).toMatchObject({ stepId: null, measuredItems: 0, entered: true });
    // Someone else's rows never appear for this person.
    expect(personFactors(withRows, id.hana!, names).map((f) => f.factor)).toEqual([0.7]);
  });

  it("has nothing for a person with no rows, or a bundle with no list; a measured source is not 'entered'", () => {
    expect(personFactors(b, id.jess!, names)).toEqual([]);
    expect(personFactors({ ...b, personCapacityFactors: [] }, id.jess!, names)).toEqual([]);
    expect(personFactors({ ...b, personCapacityFactors: [row(id.jess!, null, 0.9, "measured")] }, id.jess!, names)[0]!.entered).toBe(false);
  });
});

describe("speedsNormalisedFor", () => {
  it("is true only when the switch is on and this viewer's model uses normal times", () => {
    const b = larkspurBundle();
    const on = { ...b, workspace: { ...b.workspace, settings: { ...b.workspace.settings, capacity_factor_enabled: true } } };
    expect(speedsNormalisedFor(b)).toBe(false);
    expect(speedsNormalisedFor(on)).toBe(false);
    expect(speedsNormalisedFor({ ...on, viewer: { seesEveryone: false, ownPersonId: id.jess! } })).toBe(true);
    expect(speedsNormalisedFor({ ...b, viewer: { seesEveryone: false, ownPersonId: id.jess! } })).toBe(false);
    expect(speedsNormalisedFor({ ...on, viewer: { seesEveryone: true, ownPersonId: null } })).toBe(false);
  });
});

describe("personDetail", () => {
  it("has null skills for someone with no skill rows, and the role names", () => {
    const d = personDetail(model, result, bundle, id.jess, START)!;
    expect(d.skills).toBeNull();
    expect(d.roles).toEqual([model.roles[result.resolvedPeople[id.jess]!.roles[0]!]!.name]);
    expect(d.hoursPerWeek).toBe(37.5);
    expect(d.fte).toBe(1);
    expect(d.leave).toEqual([]);
  });

  it("names the steps of someone with skill rows", () => {
    const d = personDetail(model, result, bundle, id.freya, START)!;
    expect(d.skills).toHaveLength(2);
    const names = new Set(model.steps.map((s) => s.name));
    for (const s of d.skills!) expect(names.has(s)).toBe(true);
  });

  it("gives hours and FTE of a part-timer", () => {
    const d = personDetail(model, result, bundle, id.callum, START)!;
    expect(d.hoursPerWeek).toBe(22.5);
    expect(d.fte).toBe(0.6);
  });

  it("keeps leave that ends today or later, oldest first, and never reads notes", () => {
    const extra = [
      { ...bundle.personLeave[0]!, id: "x1", person_id: id.kai, start_date: "2026-01-05", end_date: "2026-01-09" },
      { ...bundle.personLeave[0]!, id: "x2", person_id: id.kai, start_date: "2026-11-02", end_date: "2026-11-06", note: "private" },
      { ...bundle.personLeave[0]!, id: "x3", person_id: id.kai, start_date: "2026-10-06", end_date: "2026-10-06" },
      ...bundle.personLeave.filter((l) => l.person_id === id.kai),
    ];
    const b = { ...bundle, personLeave: extra };
    const d = personDetail(model, result, b, id.kai, START)!;
    expect(d.leave).toEqual([
      { start: "2026-10-06", end: "2026-10-06" },
      { start: "2026-11-02", end: "2026-11-06" },
      { start: "2026-12-21", end: "2027-01-01" },
    ]);
    expect(JSON.stringify(d)).not.toContain("private");
    // A day later, the one-day leave on the 6th is over.
    expect(personDetail(model, result, b, id.kai, "2026-10-07")!.leave[0]).toEqual({ start: "2026-11-02", end: "2026-11-06" });
  });

  it("is null for a person made up from a role's head-count", () => {
    expect(personDetail(model, result, bundle, "strategist#1", START)).toBeNull();
    const bare = { ...bundle, people: [], personRoles: [], personSkills: [], personLeave: [] };
    const bareModel = toEngineModel(bare, { startDate: START });
    const bareResult = simulate(bareModel, 4, 1);
    const anyId = Object.keys(bareResult.resolvedPeople)[0]!;
    expect(personDetail(bareModel, bareResult, bare, anyId, START)).toBeNull();
  });

  it("carries start and end dates from the record", () => {
    const people = bundle.people.map((p) => (p.id === id.jess ? { ...p, start_date: "2026-01-12", end_date: "2027-03-31" } : p));
    const d = personDetail(model, result, { ...bundle, people }, id.jess, START)!;
    expect([d.startDate, d.endDate]).toEqual(["2026-01-12", "2027-03-31"]);
  });
});

describe("weeksLabel", () => {
  const label = (weeks: number, recovered: boolean, weeksWatched = 0) => weeksLabel({ weeks, recovered, weeksWatched });
  it("says under 1, 1 and N weeks when the queues recovered", () => {
    expect(label(0, true)).toBe("Under 1 week");
    expect(label(1, true)).toBe("1 week");
    expect(label(3, true)).toBe("3 weeks");
  });
  it("says not within N weeks, singular for 1, and never 0 weeks", () => {
    expect(label(7, false, 6)).toBe("Not within 6 weeks");
    expect(label(2, false, 1)).toBe("Not within 1 week");
    expect(label(1, false, 0)).toBe("Not before the run ends");
  });
});

describe("a run too short to test", () => {
  const short = { ...model, horizonWeeks: 1 };
  it("tests nobody although there are sole holders, and says so rather than 'nobody is tested'", () => {
    const test = absenceTest(short, { seed: 1, reps: 2 });
    expect(test.people).toEqual([]);
    expect(absenceCandidates(short).length).toBeGreaterThan(0);
    // untestedSoleHolders counts every candidate, which is why the page must not print "N more aren't" next to "nobody".
    expect(untestedSoleHolders(short, test).length).toBe(absenceCandidates(short).length);
    expect(absenceCoverage(short, test)).toEqual({ tooShort: true, untested: 0 });
  });
  it("is limited to a member's own person", () => {
    const test = absenceTest(short, { seed: 1, reps: 2, personIds: [id.imogen] });
    expect(absenceCoverage(short, test, [id.imogen]).tooShort).toBe(true);
    // Jess is no one's sole holder: nothing to test, so it isn't "too short" for her.
    expect(absenceCoverage(short, absenceTest(short, { seed: 1, reps: 2, personIds: [id.jess] }), [id.jess])).toEqual({ tooShort: false, untested: 0 });
  });
  it("is not too short on a normal run, and counts the sole holders left out", () => {
    const full = absenceTest(model, { seed: 1, reps: 2 });
    expect(absenceCoverage(model, full)).toEqual({ tooShort: false, untested: 0 });
    const fewer = absenceTest(model, { seed: 1, reps: 2, maxPeople: 1 });
    expect(absenceCoverage(model, fewer)).toEqual({ tooShort: false, untested: absenceCandidates(model).length - 1 });
  });
});
