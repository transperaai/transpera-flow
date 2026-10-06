import { describe, expect, it } from "vitest";
import {
  absenceRating,
  absenceTest,
  detectIssues,
  larkspurModel,
  northbeamWithServicing,
  resolveRatingConfig,
  simulate,
  type AbsenceFinding,
  type EngineModel,
} from "../src";

// Rule 8's rating, pulled out of `detectIssues` (B2, #31) so the People page rates absences the same way as the Issues register.

const config = resolveRatingConfig();
const subject = { roleId: null, personId: null, stepId: null };
const finding = (over: Partial<AbsenceFinding> = {}): AbsenceFinding => ({
  personId: "p",
  stepIds: ["s"],
  workLost: 0,
  itemsLost: 0,
  winsLost: 0,
  recoveryWeeks: 0,
  recovered: true,
  extraMissed: 0,
  clientDeadlineMissed: false,
  ...over,
});

describe("absenceRating", () => {
  it("rates work lost: under 5% great, 5% to 20% bad, over 20% risk", () => {
    expect(absenceRating(config, finding({ workLost: 0.0499 }), subject)).toBe("great");
    expect(absenceRating(config, finding({ workLost: 0.05 }), subject)).toBe("bad");
    // The cut-off itself rates as the worse side (existing behaviour of the rule, kept as it was inside `detectIssues`).
    expect(absenceRating(config, finding({ workLost: 0.2 }), subject)).toBe("risk");
    expect(absenceRating(config, finding({ workLost: 0.1999 }), subject)).toBe("bad");
    expect(absenceRating(config, finding({ workLost: 0.2001 }), subject)).toBe("risk");
  });

  it("rates weeks to recover: within 1 great, up to 4 bad, over 4 risk", () => {
    expect(absenceRating(config, finding({ recoveryWeeks: 1 }), subject)).toBe("great");
    expect(absenceRating(config, finding({ recoveryWeeks: 1.5 }), subject)).toBe("bad");
    expect(absenceRating(config, finding({ recoveryWeeks: 4 }), subject)).toBe("bad");
    expect(absenceRating(config, finding({ recoveryWeeks: 4.5 }), subject)).toBe("risk");
  });

  it("takes the worse of the two", () => {
    expect(absenceRating(config, finding({ workLost: 0.01, recoveryWeeks: 3 }), subject)).toBe("bad");
    expect(absenceRating(config, finding({ workLost: 0.3, recoveryWeeks: 0 }), subject)).toBe("risk");
  });

  it("is risk when the queues never recovered, or a client deadline is missed", () => {
    expect(absenceRating(config, finding({ recovered: false, recoveryWeeks: 3 }), subject)).toBe("risk");
    expect(absenceRating(config, finding({ clientDeadlineMissed: true }), subject)).toBe("risk");
  });

  it("is null when the rule is switched off for the subject", () => {
    const off = resolveRatingConfig({ rules: { spof: { enabled: false } } });
    expect(absenceRating(off, finding({ workLost: 0.5 }), subject)).toBeNull();
  });
});

describe("the Issues register and absenceRating agree", () => {
  const cases: [string, () => EngineModel][] = [
    ["Larkspur", larkspurModel],
    ["Northbeam with servicing", northbeamWithServicing],
  ];
  for (const [name, build] of cases) {
    it(`${name}: every spof issue carries the rating absenceRating gives`, () => {
      const model = build();
      const result = simulate(model, 30, 1);
      const absence = absenceTest(model, { seed: 1 });
      const issues = detectIssues(model, result, {}, { absence }).filter((i) => i.type === "spof");
      for (const issue of issues) {
        const stepId = issue.key.replace("spof:step:", "");
        const f = absence.people.find((p) => p.stepIds.includes(stepId))!;
        expect(f).toBeDefined();
        const person = result.resolvedPeople[f.personId]!;
        const expected = absenceRating(config, f, { stepId, roleId: person.roles[0] ?? null, personId: f.personId });
        expect(issue.rating).toBe(expected);
      }
    });
  }
});
