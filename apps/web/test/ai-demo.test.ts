import { describe, expect, it, vi } from "vitest";
import { toEngineModel } from "@transpera-flow/db";
import { absenceTest, shadowPricesFor, simulate } from "@transpera-flow/engine";
import { screenOutput } from "@/lib/ai/analyse";
import { DEMO_AI_OUTPUT, demoAiView } from "@/lib/ai/demo";
import { aiInputForRun, costedRoleIds, ruleFindings } from "@/lib/ai/input";
import { demoFirstPrinciples } from "@/lib/first-principles/demo-seed";
import { demoBundle } from "@/lib/sources/demo";

vi.mock("server-only", () => ({}));

// The demo's AI text (issue #111, A46) is written in advance and never calls an AI. It still has to be true: it goes through
// the real number check against the Northbeam sample's own run (30 replications, seed 1, as the pages run it).

const bundle = demoBundle();
const model = toEngineModel(bundle);
const result = simulate(model, 30, 1);
const firstPrinciples = demoFirstPrinciples();
const absence = absenceTest(model, { seed: 1, weeks: 2 });
const shadowPrices = shadowPricesFor(model, costedRoleIds(ruleFindings({ bundle, model, result, firstPrinciples, absence })), { reps: 30, seed: 1 });
const input = aiInputForRun({ bundle, model, result, firstPrinciples, absence, shadowPrices })!.input;

describe("the demo's AI text", () => {
  it("passes the number check against the sample's run, every item", () => {
    const out = screenOutput(JSON.parse(JSON.stringify(DEMO_AI_OUTPUT)), input);
    expect(out.rejected, JSON.stringify(out.rejected, null, 1)).toEqual([]);
    expect(out.dropped).toBe(0);
    expect(out.readFailed).toBe(false);
    expect(out.insights).toHaveLength(DEMO_AI_OUTPUT.insights.length);
    expect(out.review).toHaveLength(DEMO_AI_OUTPUT.review.length);
  });

  it("has the keys the real pipeline would give, and numbers of figures checked", () => {
    const out = screenOutput(JSON.parse(JSON.stringify(DEMO_AI_OUTPUT)), input);
    const view = demoAiView(bundle.process.id)!;
    expect(view.insights.map((i) => i.key)).toEqual(out.insights.map((i) => i.item.key));
    const checked = (out.summary?.checked ?? 0) + out.insights.reduce((n, i) => n + i.checked, 0) + out.review.reduce((n, r) => n + r.checked, 0);
    expect(view.checked).toBe(checked);
  });

  it("cites facts the sample's run has, by the keys and words the engine gives them", () => {
    const out = screenOutput(JSON.parse(JSON.stringify(DEMO_AI_OUTPUT)), input);
    const view = demoAiView(bundle.process.id)!;
    view.insights.forEach((i, n) => {
      const real = out.insights[n]!.item.facts!;
      expect(i.facts!.map((f) => f.key)).toEqual(real.map((f) => f.key));
      // The demo keeps each fact's first sentence.
      i.facts!.forEach((f, k) => expect(real[k]!.text.startsWith(f.text)).toBe(true));
    });
  });

  it("points at steps the sample has", () => {
    const ids = new Set(bundle.steps.map((s) => s.id));
    for (const i of demoAiView(bundle.process.id)!.insights) if (i.stepId) expect(ids.has(i.stepId)).toBe(true);
  });

  it("is only for the pipeline", () => {
    expect(demoAiView("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
