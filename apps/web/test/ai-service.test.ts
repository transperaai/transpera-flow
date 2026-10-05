import { describe, expect, it, vi } from "vitest";
import { AI_DAILY_RUN_LIMIT, DEFAULT_AI_SETTINGS, toEngineModel, type ProposedFinding, type SaveAiAnalysisInput } from "@transpera-flow/db";
import { absenceTest, simulate } from "@transpera-flow/engine";
import type { AiDraftRequest, AiModel } from "@/lib/ai/analyse";
import { aiInputForRun } from "@/lib/ai/input";
import { analysisModelHash, isStale } from "@/lib/ai/model-hash";
import { replyOf } from "@/lib/ai/reply";
import { proposedFindings, runAnalysis, stepProcesses, type AiRunDeps } from "@/lib/ai/service";
import { demoFirstPrinciples } from "@/lib/first-principles/demo-seed";
import { demoBundle } from "@/lib/sources/demo";

vi.mock("server-only", () => ({}));

// When AI analysis runs, and what it stores (issue #111, A46; issue #175, B17): only when someone presses Analyse, never
// for a viewer, never without a key, not again while the model is unchanged (the cache), every model call reserved first
// (the per-workspace cap and the per-process cooldown), and what it found stored as PROPOSED findings citing their facts.
// The model is a fake: tests never call the Anthropic API.

const bundle = demoBundle();
const model = toEngineModel(bundle);
const result = simulate(model, 10, 1);
const fp = demoFirstPrinciples();
const facts = aiInputForRun({ bundle, model, result, firstPrinciples: fp })!.input.facts;
const AUDIT = bundle.steps.find((s) => s.name === "Audit & proposal")!.id;

function fakeModel(output: unknown = { read: ["Fine."], insights: [], review: [] }): AiModel & { calls: AiDraftRequest[] } {
  const calls: AiDraftRequest[] = [];
  return {
    name: "fake",
    calls,
    async draft(req) {
      calls.push(req);
      return { output, model: "fake", usage: null };
    },
  };
}

/** An analysis that proposes one finding on Audit & proposal, citing the first fact, every figure copied from it. */
const finding = () => ({
  read: ["Fine."],
  insights: [{ title: "Proposals queue for one person", type: "delay", rating: "bad", stepId: AUDIT, evidence: "Most of the wait is in one queue.", why: "Founders go elsewhere.", facts: [facts[0]!.id] }],
  review: [],
});

type Deps = AiRunDeps & { saved: SaveAiAnalysisInput[]; proposed: { analysisId: string; findings: ProposedFinding[] }[]; built: number };

function deps(over: Partial<AiRunDeps> = {}): Deps {
  const saved: SaveAiAnalysisInput[] = [];
  const proposed: Deps["proposed"] = [];
  const d: Deps = {
    force: false,
    scope: "process",
    workspaceId: "w",
    processId: "p",
    revisionId: "r1",
    settings: { ...DEFAULT_AI_SETTINGS },
    canWrite: true,
    existing: null,
    modelHash: "hash-1",
    reserve: async () => ({ status: "ok", runId: "run-1" }),
    build: async () => {
      d.built++;
      return { bundle, model, result, firstPrinciples: fp };
    },
    model: fakeModel(),
    save: async (row) => {
      saved.push(row);
      return "analysis-1";
    },
    propose: async (analysisId, findings) => {
      proposed.push({ analysisId, findings });
      return { added: findings.length };
    },
    saved,
    proposed,
    built: 0,
    ...over,
  };
  return d;
}

describe("runAnalysis: when it runs", () => {
  it("runs when asked and stores the outcome against the version, with the hash of the model it read", async () => {
    const d = deps();
    const out = await runAnalysis(d);
    expect(out.status).toBe("stored");
    expect(d.saved).toHaveLength(1);
    expect(d.saved[0]).toMatchObject({ workspace_id: "w", process_id: "p", revision_id: "r1", status: "ok", trigger: "manual", summary: ["Fine."], model: "fake", model_hash: "hash-1" });
    expect(d.saved[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails gracefully with no API key: nothing is simulated, called or stored", async () => {
    const d = deps({ model: null });
    expect(await runAnalysis(d)).toEqual({ status: "skipped", why: "not_set_up" });
    expect(d.built).toBe(0);
    expect(d.saved).toEqual([]);
  });

  it("is refused for someone who can't write (a viewer or member), before anything runs", async () => {
    const m = fakeModel();
    const d = deps({ canWrite: false, model: m });
    expect(await runAnalysis(d)).toEqual({ status: "skipped", why: "forbidden" });
    expect(m.calls).toEqual([]);
    expect(d.built).toBe(0);
  });

  it("skips a process with no live version", async () => {
    expect(await runAnalysis(deps({ revisionId: null }))).toEqual({ status: "skipped", why: "no_live" });
  });

  it("needs first principles to review: without them nothing is called or stored", async () => {
    const m = fakeModel();
    const d = deps({ model: m, build: async () => ({ bundle, model, result, firstPrinciples: null }) });
    expect(await runAnalysis(d)).toEqual({ status: "skipped", why: "no_first_principles" });
    expect(m.calls).toEqual([]);
    expect(d.saved).toEqual([]);
  });

  it("reports a model that can't be built, saving nothing", async () => {
    const d = deps({ build: async () => ({ error: "A step has no role." }) });
    expect(await runAnalysis(d)).toEqual({ status: "skipped", why: "model_error", message: "A step has no role." });
    expect(d.saved).toEqual([]);
  });
});

describe("runAnalysis: cached until the model changes", () => {
  it("returns the stored analysis while the model hashes the same, without simulating, reserving or calling the model", async () => {
    let reserved = 0;
    const m = fakeModel();
    const d = deps({ existing: { input_hash: "x", status: "ok", model_hash: "hash-1" }, model: m, reserve: async () => (reserved++, { status: "ok", runId: "r" }) });
    expect(await runAnalysis(d)).toEqual({ status: "skipped", why: "unchanged" });
    expect([d.built, reserved, m.calls.length, d.saved.length]).toEqual([0, 0, 0, 0]);
  });

  it("runs again once the model has changed", async () => {
    const m = fakeModel();
    const d = deps({ existing: { input_hash: "x", status: "ok", model_hash: "hash-0" }, model: m });
    expect((await runAnalysis(d)).status).toBe("stored");
    expect(m.calls).toHaveLength(1);
    expect(d.saved[0]!.model_hash).toBe("hash-1");
  });

  it("also skips when the facts it would send are the ones the stored analysis read (an analysis from before the hash)", async () => {
    const first = deps();
    await runAnalysis(first);
    const existing = { input_hash: first.saved[0]!.input_hash, status: "ok", model_hash: null };
    const m = fakeModel();
    expect(await runAnalysis(deps({ existing, model: m }))).toEqual({ status: "skipped", why: "unchanged" });
    expect(m.calls).toEqual([]);
    const again = deps({ existing, force: true, model: m });
    expect((await runAnalysis(again)).status).toBe("stored");
    expect(m.calls).toHaveLength(1);
  });

  it("redoes a stored failure (it can't be 'unchanged' if nothing was written)", async () => {
    const existing = { input_hash: "x", status: "failed", model_hash: "hash-1" };
    expect((await runAnalysis(deps({ existing }))).status).toBe("stored");
  });

  it("hashes the model, not the calendar: the same bundle gives the same hash, a changed step or first principles another", () => {
    const a = analysisModelHash(bundle, fp, "process");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(analysisModelHash(bundle, fp, "process")).toBe(a);
    const slower = { ...bundle, steps: bundle.steps.map((s) => (s.id === AUDIT ? { ...s, work_hours: (s.work_hours ?? 1) + 1 } : s)) };
    expect(analysisModelHash(slower, fp, "process")).not.toBe(a);
    expect(analysisModelHash(bundle, { ...fp, why: { ...fp.why, root: "Something else" } }, "process")).not.toBe(a);
    expect(analysisModelHash(bundle, fp, "company")).not.toBe(a);
  });

  it("marks a stored analysis out of date when the model hashes differently, or (without a hash) when it read another version", () => {
    expect(isStale(null, { hash: "a", revisionId: "r1" })).toBe(false);
    expect(isStale({ modelHash: "a", revisionId: "r1" }, { hash: "a", revisionId: "r2" })).toBe(false);
    expect(isStale({ modelHash: "a", revisionId: "r1" }, { hash: "b", revisionId: "r1" })).toBe(true);
    expect(isStale({ modelHash: null, revisionId: "r1" }, { hash: "b", revisionId: "r1" })).toBe(false);
    expect(isStale({ modelHash: null, revisionId: "r1" }, { hash: "b", revisionId: "r2" })).toBe(true);
  });
});

describe("runAnalysis: the cost bound", () => {
  it("reserves a run before every model call, including forced runs and runs that will fail", async () => {
    for (const force of [false, true]) {
      const calls: string[] = [];
      const m = fakeModel({ read: ["It earns £9,876,543."], insights: [], review: [] });
      const d = deps({
        force,
        model: m,
        reserve: async () => {
          calls.push(`reserve:${m.calls.length}`);
          return { status: "ok", runId: "run-1" };
        },
      });
      await runAnalysis(d);
      expect(calls).toEqual(["reserve:0"]);
      expect(m.calls.length).toBeGreaterThan(0);
      expect(d.saved[0]).toMatchObject({ run_id: "run-1", status: "failed" });
    }
  });

  it("calls nothing and stores nothing when the database refuses the run: the daily cap, the cooldown, or no right", async () => {
    for (const [reservation, why] of [
      [{ status: "limit" }, "limit"],
      [{ status: "cooldown", retryAfterSeconds: 42 }, "cooldown"],
      [{ status: "forbidden" }, "forbidden"],
    ] as const) {
      for (const force of [false, true]) {
        const m = fakeModel();
        const d = deps({ model: m, force, reserve: async () => reservation });
        const out = await runAnalysis(d);
        expect(out, `${why} force=${force}`).toMatchObject({ status: "skipped", why });
        expect(m.calls).toEqual([]);
        expect(d.saved).toEqual([]);
      }
    }
    const cool = await runAnalysis(deps({ reserve: async () => ({ status: "cooldown", retryAfterSeconds: 42 }) }));
    expect(cool).toMatchObject({ message: expect.stringContaining("42 seconds") });
    const lim = await runAnalysis(deps({ reserve: async () => ({ status: "limit" }) }));
    expect(lim).toMatchObject({ message: expect.stringContaining(`${AI_DAILY_RUN_LIMIT} AI runs`) });
    expect(await runAnalysis(deps({ reserve: async () => ({ status: "error" }) }))).toMatchObject({ status: "error" });
  });

  it("doesn't reserve for a run it skips before the model: no key, unchanged, no first principles", async () => {
    let reserved = 0;
    const reserve = async () => {
      reserved++;
      return { status: "ok" as const, runId: "r" };
    };
    await runAnalysis(deps({ reserve, model: null }));
    await runAnalysis(deps({ reserve, existing: { input_hash: "x", status: "ok", model_hash: "hash-1" } }));
    await runAnalysis(deps({ reserve, build: async () => ({ bundle, model, result, firstPrinciples: null }) }));
    expect(reserved).toBe(0);
  });
});

describe("runAnalysis: proposed findings", () => {
  it("stores what AI found as proposed findings citing the analysis, on the step's process, with the facts they rest on", async () => {
    const d = deps({ model: fakeModel(finding()), processId: bundle.process.id });
    const out = await runAnalysis(d);
    expect(out).toMatchObject({ status: "stored", added: 1 });
    expect(d.proposed).toHaveLength(1);
    expect(d.proposed[0]!.analysisId).toBe("analysis-1");
    expect(d.proposed[0]!.findings[0]).toMatchObject({
      processId: bundle.process.id,
      stepId: AUDIT,
      rating: "bad",
      type: "delay",
      title: "Proposals queue for one person",
      aiKey: expect.stringMatching(/^ai:insight:[0-9a-f]{12}$/),
      facts: [{ kind: "fact", key: facts[0]!.key, text: expect.any(String) }],
    });
  });

  it("puts a company finding on no step across the company, and one on a step in that step's process", () => {
    const steps = stepProcesses(bundle);
    const base = { key: "ai:insight:aaaaaaaaaaaa", type: "delay" as const, rating: "bad" as const, title: "T", evidence: "E", why: "W" };
    const [onStep, onNone] = proposedFindings([{ ...base, stepId: AUDIT }, { ...base, stepId: null }], "company", "", steps);
    expect(onStep!.processId).toBe(bundle.process.id);
    expect(onNone!.processId).toBeNull();
    expect(proposedFindings([{ ...base, stepId: null }], "process", "p1", steps)[0]!.processId).toBe("p1");
    const servicing = bundle.otherProcesses?.find((o) => o.steps.length);
    if (servicing) expect(proposedFindings([{ ...base, stepId: servicing.steps[0]!.id }], "company", "", steps)[0]!.processId).toBe(servicing.process.id);
  });

  it("proposes nothing for a failed analysis, and says so when the findings couldn't be stored", async () => {
    const failed = deps({ model: fakeModel({ read: ["It earns £9,876,543."], insights: [], review: [] }) });
    await runAnalysis(failed);
    expect(failed.proposed).toEqual([]);
    const broken = deps({ model: fakeModel(finding()), propose: async () => ({ error: "nope" }) });
    expect(await runAnalysis(broken)).toMatchObject({ status: "error", message: expect.stringContaining("couldn't be saved for review") });
  });

  it("says what happened in plain words", () => {
    expect(replyOf({ status: "skipped", why: "unchanged" }, "process")).toEqual({ status: "ok", message: "Nothing has changed since the last analysis, so it wasn't run again." });
    expect(replyOf({ status: "skipped", why: "not_set_up" }, "company").status).toBe("error");
    expect(replyOf({ status: "skipped", why: "no_first_principles" }, "company").message).toContain("main process");
  });
});

describe("runAnalysis: what is stored", () => {
  it("stores a failure with its reason, so the page can say why", async () => {
    const d = deps({ model: fakeModel({ read: ["It earns £9,876,543."], insights: [], review: [] }) });
    const out = await runAnalysis(d);
    expect(out.status).toBe("stored");
    expect(d.saved[0]).toMatchObject({ status: "failed", summary: [], insights: [], review: [] });
    expect(d.saved[0]!.reason).toMatch(/aren't in the run/);
  });

  it("stores only items that passed the number check", async () => {
    const d = deps({
      model: fakeModel({
        read: ["Fine."],
        insights: [{ title: "Costs £9,876,543 a month", type: "delay", rating: "bad", stepId: null, evidence: "It costs £9,876,543.", why: "x" }],
        review: [{ step: "job", level: "info", text: "The job is clear." }],
      }),
    });
    await runAnalysis(d);
    expect(d.saved[0]).toMatchObject({ status: "ok", insights: [], review: [{ step: "job", level: "info", text: "The job is clear." }], dropped: 1 });
  });

  it("reports a save that failed", async () => {
    expect(await runAnalysis(deps({ save: async () => null }))).toEqual({ status: "error", message: "The analysis ran but couldn't be saved." });
  });

  it("includes source quotes only when the switch is on", async () => {
    const off = fakeModel();
    await runAnalysis(deps({ model: off }));
    expect(off.calls[0]!.facts).not.toContain("quotesFromSources");
    const on = fakeModel();
    await runAnalysis(deps({ model: on, settings: { ...DEFAULT_AI_SETTINGS, read_sources: true } }));
    expect(on.calls[0]!.facts).toContain("quotesFromSources");
    expect(on.calls[0]!.facts).toContain("twelve hours");
  });
});

describe("the extra runs the server makes are affordable", () => {
  it("rule 8's absence test on the Northbeam sample takes well under the request's time", () => {
    const t = Date.now();
    absenceTest(model, { seed: 1, weeks: 2 });
    expect(Date.now() - t).toBeLessThan(20_000);
  });
});
