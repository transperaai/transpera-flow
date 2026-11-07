import { describe, expect, it } from "vitest";
import { changeWarning, zeroPartWarning } from "@/lib/solutions/step-changes";
import { splitPercents } from "@/lib/editor/base-values";

// A change on a part of a step that the work split gives 0% does nothing yet: the panel says so and still lets it save.
const STEP = "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9c11";

describe("the zero-part warning", () => {
  it("warns for the part a change acts on when its share is 0%, and for a step with no split (all manual)", () => {
    expect(zeroPartWarning("automatable", splitPercents(null))).toBe("This step's automatable part is 0%, so this changes nothing yet. Set the work split above first.");
    expect(zeroPartWarning("augmentable", [40, 0, 60])).toBe("This step's augmentable part is 0%, so this changes nothing yet. Set the work split above first.");
  });

  it("is silent when the part has a share", () => {
    expect(zeroPartWarning("automatable", [40, 0, 60])).toBeNull();
    expect(zeroPartWarning("augmentable", [0, 25, 75])).toBeNull();
  });

  it("reads the part each effect on this step acts on, and ignores effects on other steps", () => {
    const change = { effects: [{ step: "other", part: "augmentable" as const, factor: 2 }, { step: STEP, part: "automatable" as const, remove: 0.8 }] };
    expect(changeWarning(change, STEP, [0, 50, 50])).toContain("automatable part is 0%");
    expect(changeWarning(change, STEP, [30, 0, 70])).toBeNull();
  });
});
