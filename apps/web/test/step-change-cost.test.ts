import { describe, expect, it } from "vitest";
import type { StoredStepChange } from "@transpera-flow/db";
import { stepChangeFromForm } from "@/components/editor/step-change-dialog";

// The Automate / Augment form asks no cost a month: nothing simulates it yet (Austin, 7 Nov). A cost stored before is kept as it was.
const STEP = "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9c11";
const form = { name: "Pace it by machine", kind: "automation" as const, remove: "85", checking: "2", factor: "1.5", adoption: "70", ramp: "3", tiers: [] };

describe("the cost a month", () => {
  it("is null on a new change", () => {
    expect(stepChangeFromForm(STEP, null, form).cost_monthly).toBeNull();
  });

  it("is kept on an edited change that had one", () => {
    const existing: StoredStepChange = { id: "1c1c6f0e-6d0a-4d5e-9d57-2f1d1d2a9c11", name: "Old", kind: "automation", effects: [{ step: STEP, part: "automatable", remove: 0.5 }], adoption: 1, ramp_months: 0, tiers: null, cost_monthly: 400 };
    const made = stepChangeFromForm(STEP, existing, form);
    expect(made.cost_monthly).toBe(400);
    expect(made.effects).toEqual([{ step: STEP, part: "automatable", remove: 0.85, residualHours: 2 / 60 }]);
  });
});
