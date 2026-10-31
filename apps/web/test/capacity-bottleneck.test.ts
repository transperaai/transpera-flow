import { describe, expect, it } from "vitest";
import { larkspurModel, northbeamModel, rankBottlenecks, simulate, type EngineModel } from "@transpera-flow/engine";

// The logic that names the bottleneck and the work waiting on it lives in the
// engine (`rankBottlenecks`, packages/engine/src/bottlenecks.ts); the old
// bottleneck panel only wrapped it. These tests pin its output on the two
// fixtures so the Capacity page can rely on it.

const summary = (model: EngineModel) => {
  const b = rankBottlenecks(model, simulate(model, 30, 1), { limit: 3 });
  return {
    top: b.top?.id ?? null,
    topName: b.top?.name ?? null,
    queueStep: b.top?.queueStep?.name ?? null,
    topEvidence: b.top?.evidence ?? null,
    roles: b.roles.map((r) => r.id),
    steps: b.steps.map((s) => s.name),
    stepEvidence: b.steps[0]?.evidence ?? null,
  };
};

describe("bottleneck logic, pinned", () => {
  it("Northbeam", () => {
    expect(summary(northbeamModel())).toMatchInlineSnapshot(`
      {
        "queueStep": "Audit & proposal",
        "roles": [
          "strat",
          "ppc",
          "am",
        ],
        "stepEvidence": "“Audit & proposal” has avg 1.4 items waiting (peak 5.4); each waits avg 1.9 working days before work starts.",
        "steps": [
          "Audit & proposal",
          "Kickoff & strategy",
          "PPC campaign setup",
        ],
        "top": "strat",
        "topEvidence": "Strategist is 84% utilised (range 73–99%): 33.8 h/week of work across 1 person, 54% on the pipeline and 30% on client work. Work queues longest at “Audit & proposal” (avg 1.4 items waiting).",
        "topName": "Strategist",
      }
    `);
  });
  it("Larkspur", () => {
    expect(summary(larkspurModel())).toMatchInlineSnapshot(`
      {
        "queueStep": "Content plan & first articles",
        "roles": [
          "copy",
          "design",
          "strat",
        ],
        "stepEvidence": "“Turn the request round” has avg 3.7 items waiting (peak 13); each waits avg 3.4 working days before work starts.",
        "steps": [
          "Turn the request round",
          "Design the assets",
          "Creative concepts",
        ],
        "top": "copy",
        "topEvidence": "Copywriter is 110% utilised (range 98–125%): 45.7 h/week of work across 1 person, 8% on the pipeline and 113% on client work. Work queues longest at “Content plan & first articles” (avg 1.1 items waiting).",
        "topName": "Copywriter",
      }
    `);
  });
});
