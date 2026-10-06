import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runResults, toEngineModel } from "@transpera-flow/db";
import { simulate, type DetectedIssue } from "@transpera-flow/engine";
import { labelNames } from "@transpera-flow/db";
import { aliasesFor, applyAliases, buildAiInput, squeeze } from "@/lib/ai/facts";
import { analyseWithAi, quotationProblems, screenOutput, type AiDraftRequest, type AiModel } from "@/lib/ai/analyse";
import { aiInputForRun, quotesFromBundle } from "@/lib/ai/input";
import { aiDetections, aiViewFromRow, readInsights } from "@/lib/ai/types";
import { demoFirstPrinciples } from "@/lib/first-principles/demo-seed";
import { buildInsights, limitInsights } from "@/lib/insights/insights";
import { registerEntries } from "@/lib/issues/register";
import { MemoryIssueStore } from "@/lib/issues/store";
import { parsePromoteInput } from "@/lib/issues/validate";
import { acknowledgeInsight, dismissInsight } from "@/lib/insights/actions";
import { NarrationError } from "@/lib/narration/narrate";
import type { IssuesState } from "@/lib/issues/use-issues";
import type { IssueRow } from "@transpera-flow/db";
import { demoBundle } from "@/lib/sources/demo";
import { northbeamStepIds } from "@transpera-flow/db";

vi.mock("server-only", () => ({}));

// AI analysis (issue #111, A46): drafts checked number by number, items with an unmatched number dropped, one redraft
// naming what failed, a clear failure when nothing is left. Every model here is a deterministic fake: tests never
// call the Anthropic API (a fetch that would is made to fail).

const bundle = demoBundle();
const model = toEngineModel(bundle);
const result = simulate(model, 10, 1);
const fp = demoFirstPrinciples();
const run = { bundle, model, result, firstPrinciples: fp };
const built = aiInputForRun({ ...run, quotes: [{ step: "Audit & proposal", quote: "Most weeks that's my Sunday, honestly" }] })!;
const { input, findings } = built;
const results = input.payload.results as Record<string, string>;
const first = findings[0]!;
const firstSentence = (s: string) => s.slice(0, s.search(/[.!?](\s|$)/) + 1);
const AUDIT = northbeamStepIds.audit;

/** What a good analysis looks like: every figure copied from the facts. */
const good = (): { read: string[]; insights: { title: string; type: string; rating: string; stepId: string | null; evidence: string; why: string; facts?: string[] }[]; review: { step: string; level: string; text: string }[] } => ({
  read: [`Over the run Northbeam wins ${results.wins}. ${firstSentence(first.evidence)}`],
  insights: [
    { title: "The audit step holds up the whole line", type: "bottleneck", rating: "bad", stepId: AUDIT, evidence: firstSentence(first.evidence), why: "Everything after it waits, and the first principles say proposals should go out quickly.", facts: [input.facts[0]!.id] },
  ],
  review: [{ step: "saa", level: "bad", text: "Automating the lead qualifier comes before you have decided to delete that step." }],
});

/** A fake model: returns the scripted drafts in turn (a function of the request), recording each request. */
function fake(...drafts: ((req: AiDraftRequest) => unknown | Error)[]): AiModel & { calls: AiDraftRequest[] } {
  const calls: AiDraftRequest[] = [];
  return {
    name: "fake-model",
    calls,
    async draft(req) {
      calls.push(req);
      const next = drafts[Math.min(calls.length - 1, drafts.length - 1)]!(req);
      if (next instanceof Error) throw next;
      return { output: next, model: "fake-model", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
    },
  };
}

describe("what the model is given", () => {
  it("holds the results, the rule findings, the first principles and the first-principles checks", () => {
    const p = input.payload as Record<string, unknown>;
    expect(Object.keys(p)).toEqual(expect.arrayContaining(["run", "results", "findings", "firstPrinciples", "firstPrinciplesChecks", "successMeasures", "steps", "market"]));
    expect(findings.length).toBeGreaterThan(0);
    // Automation of a step that is still a delete candidate is caught by the rule check, and handed to the model.
    expect(JSON.stringify(p.firstPrinciplesChecks)).toContain("still a delete candidate");
  });

  it("never sends the workspace's name or a person's real name, and says nothing of sources unless asked", () => {
    const text = JSON.stringify(input.payload);
    expect(text).not.toContain(bundle.workspace.name);
    for (const person of bundle.people) expect(text, person.name).not.toContain(person.name);
    expect(text).toContain("Team member A");
    const without = aiInputForRun(run)!.input.payload;
    expect(without).not.toHaveProperty("quotesFromSources");
    expect(input.payload).toHaveProperty("quotesFromSources");
  });

  it("has nothing to analyse without first principles", () => {
    expect(aiInputForRun({ ...run, firstPrinciples: null })).toBeNull();
  });

  it("has the same hash for the same run and a different one when the run or the answers change", () => {
    expect(aiInputForRun(run)!.input.hash).toBe(aiInputForRun(run)!.input.hash);
    expect(aiInputForRun({ ...run, result: simulate(model, 10, 2) })!.input.hash).not.toBe(aiInputForRun(run)!.input.hash);
    expect(aiInputForRun({ ...run, firstPrinciples: { ...fp, why: { ...fp.why, root: "Something else" } } })!.input.hash).not.toBe(aiInputForRun(run)!.input.hash);
  });

  it("reads quotes from the cited evidence on the steps", () => {
    expect(quotesFromBundle(bundle).some((q) => q.quote.includes("twelve hours"))).toBe(true);
  });

  it("does not turn the team's own figures into facts: a number copied from the first principles is refused", () => {
    // "12%" is in the success measures (met-today is an engine figure), but "37.5 hours" is only in a truth the team wrote.
    const out = screenOutput({ read: ["The strategist has 37.5 hours a week."], insights: [], review: [] }, input);
    expect(out.readFailed).toBe(true);
    expect(out.rejected[0]!.problems[0]!.text).toContain("37.5");
  });
});

describe("analyseWithAi", () => {
  it("keeps a draft whose figures are all the run's, with the numbers it matched", async () => {
    const m = fake(() => good());
    const out = await analyseWithAi(input, m);
    expect(out).toMatchObject({ status: "ok", reason: null, dropped: 0, model: "fake-model" });
    expect(out.summary).toHaveLength(1);
    expect(out.insights).toHaveLength(1);
    expect(out.insights[0]).toMatchObject({ type: "bottleneck", rating: "bad", stepId: AUDIT });
    expect(out.insights[0]!.key).toMatch(/^ai:insight:[0-9a-f]{12}$/);
    expect(out.review).toHaveLength(1);
    expect(out.checked).toBeGreaterThan(0);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.facts).toContain("Facts (JSON)");
  });

  it("drops an insight that cites an invented figure and keeps the rest, then redrafts once naming it", async () => {
    const bad = good();
    bad.insights.push({ title: "Proposals lose £99,999 a month", type: "delay", rating: "risk", stepId: AUDIT, evidence: "Proposals lose £99,999 a month in the queue.", why: "Money." });
    const m = fake(
      () => bad,
      (req) => {
        expect(req.instruction).toContain("£99,999");
        expect(req.instruction).toContain("the insight “Proposals lose £99,999 a month”");
        return good();
      },
    );
    const out = await analyseWithAi(input, m);
    expect(m.calls).toHaveLength(2);
    expect(out.status).toBe("ok");
    expect(out.insights.map((i) => i.title)).toEqual(["The audit step holds up the whole line"]);
    expect(out.rejected.map((r) => r.problems[0]!.text)).toContain("£99,999");
    expect(out.dropped).toBe(0);
  });

  it("keeps the first draft's good items when the redraft still has a bad one, and counts what was dropped", async () => {
    const bad = good();
    bad.insights.push({ title: "Leads wait 4,321 days", type: "delay", rating: "bad", stepId: null, evidence: "Leads wait 4,321 days.", why: "Slow." });
    const out = await analyseWithAi(input, fake(() => bad));
    expect(out.status).toBe("ok");
    expect(out.insights).toHaveLength(1);
    expect(out.dropped).toBe(1);
    expect(out.rejected.some((r) => r.problems.some((p) => p.text.includes("4,321")))).toBe(true);
  });

  it("drops the read, not the insights, when only the read cites a bad figure", async () => {
    const bad = { ...good(), read: ["Northbeam wins 400 items a week."] };
    const out = await analyseWithAi(input, fake(() => bad));
    expect(out.status).toBe("ok");
    expect(out.summary).toEqual([]);
    expect(out.insights).toHaveLength(1);
    expect(out.reason).toContain("the read was left out");
  });

  it("fails, saying why, when every draft cites figures that aren't in the run", async () => {
    const bad = { read: ["Wins are up 400%."], insights: [{ title: "Costs £1,234,567", type: "idea", rating: "good", stepId: null, evidence: "It costs £1,234,567.", why: "x" }], review: [{ step: "job", level: "warn", text: "It takes 4,321 days." }] };
    const m = fake(() => bad);
    const out = await analyseWithAi(input, m);
    expect(m.calls).toHaveLength(2);
    expect(out).toMatchObject({ status: "failed", summary: [], insights: [], review: [] });
    expect(out.reason).toMatch(/every draft cited figures that aren't in the run/);
  });

  it("drops a quotation that isn't in the sources it was given, and keeps a real one", async () => {
    expect(quotationProblems('She said "Most weeks that\'s my Sunday, honestly" to us.', input.quotes)).toEqual([]);
    expect(quotationProblems('She said "We never sleep and always chase leads" to us.', input.quotes)).toHaveLength(1);
    const real = good();
    real.insights[0]!.why = "Maya says “Most weeks that's my Sunday, honestly”, which is the same load.";
    expect((await analyseWithAi(input, fake(() => real))).insights).toHaveLength(1);
    const made = good();
    made.insights[0]!.why = "Maya says “I would rather quit than do another audit”.";
    const out = await analyseWithAi(input, fake(() => made));
    expect(out.insights).toHaveLength(0);
    expect(out.rejected.some((r) => r.problems.some((p) => p.reason.includes("quotation")))).toBe(true);
  });

  it("keeps the facts each finding cites, as the engine wrote them, and quotes it cites from the sources", async () => {
    const draft = good();
    draft.insights[0]!.facts = [input.facts[0]!.id, "fact-zzz", input.quoteRefs[0]!.id];
    const out = await analyseWithAi(input, fake(() => draft));
    expect(out.insights[0]!.facts).toEqual([
      { kind: "fact", key: first.key, text: expect.stringContaining(first.title) },
      { kind: "quote", key: "Audit & proposal", text: "Most weeks that's my Sunday, honestly" },
    ]);
  });

  it("drops a finding that cites none of the facts it was given (the engine measured nothing it rests on)", async () => {
    const draft = good();
    draft.insights[0]!.facts = [];
    const quoteOnly = good();
    quoteOnly.insights[0]!.facts = [input.quoteRefs[0]!.id];
    for (const d of [draft, quoteOnly]) {
      const out = await analyseWithAi(input, fake(() => d));
      expect(out.insights).toEqual([]);
      expect(out.rejected.some((r) => r.problems.some((p) => p.reason.includes("cites none of the facts")))).toBe(true);
    }
  });

  it("gives the facts ids with no digits, so an id can never pass the number check as a figure", () => {
    expect(input.facts.length).toBe(findings.length);
    for (const f of input.facts) expect(f.id).toMatch(/^fact-[a-z]+$/);
    expect(JSON.stringify((input.payload as { findings: { id: string }[] }).findings.map((f) => f.id))).toBe(JSON.stringify(input.facts.map((f) => f.id)));
  });

  it("turns unknown steps into no step, never keeps an unknown type, and caps the lists", async () => {
    const draft = good();
    draft.insights[0]!.stepId = "not-a-step";
    draft.insights.push({ title: "Odd", type: "perception_gap", rating: "bad", stepId: null, evidence: "Odd.", why: "x" });
    const out = await analyseWithAi(input, fake(() => draft));
    expect(out.insights).toHaveLength(1);
    expect(out.insights[0]!.stepId).toBeNull();
  });

  it("is unavailable, without calling anything, when there is no model (no API key)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    const out = await analyseWithAi(input, null);
    expect(out).toMatchObject({ status: "unavailable", summary: [], insights: [] });
    expect(out.reason).toMatch(/isn't set up/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("turns refusals, timeouts and errors into a failure with the reason, and never throws", async () => {
    for (const [err, text] of [
      [new NarrationError("refused", "declined"), /declined/],
      [new NarrationError("timeout", "slow"), /in time/],
      [new NarrationError("error", "boom"), /boom/],
      [new Error("surprise"), /surprise/],
    ] as const) {
      const out = await analyseWithAi(input, fake(() => err));
      expect(out.status).toBe("failed");
      expect(out.reason).toMatch(text);
    }
    expect((await analyseWithAi(input, fake(() => new NarrationError("unavailable", "the key was refused")))).status).toBe("unavailable");
  });

  it("keeps the first draft's good items when the redraft can't be had", async () => {
    const bad = good();
    bad.insights.push({ title: "Costs £5,555,555", type: "idea", rating: "good", stepId: null, evidence: "It costs £5,555,555.", why: "x" });
    const out = await analyseWithAi(input, fake(() => bad, () => new NarrationError("timeout", "slow")));
    expect(out.status).toBe("ok");
    expect(out.insights).toHaveLength(1);
  });

  it("gives up on the redraft when there is no time left", async () => {
    const bad = { ...good(), read: ["Wins are up 400%."] };
    let t = 0;
    const m = fake(() => bad);
    await analyseWithAi(input, m, { budgetMs: 100_000, now: () => (t += 60_000) });
    expect(m.calls).toHaveLength(1);
  });
});

/** The issue state the hooks give, over the in-memory store (as test/insights.test.ts builds it, since A47). */
function issueState(store: MemoryIssueStore): Pick<IssuesState, "promote" | "save" | "redismiss" | "revisionOf"> {
  const done = async (run: () => Promise<{ status: "ok"; issue: IssueRow } | { status: "error"; message: string }>) => {
    const r = await run();
    return r.status === "ok" ? r.issue : null;
  };
  return {
    promote: (input) => done(() => store.promote(input)),
    save: (input) => done(() => store.save(input)),
    redismiss: (id, revision) => done(() => store.redismiss(id, revision)),
    revisionOf: () => undefined,
  };
}

describe("what the team wrote isn't a fact (the probes)", () => {
  const withFp = (patch: (fp: ReturnType<typeof demoFirstPrinciples>) => void) => {
    const fp2 = demoFirstPrinciples();
    patch(fp2);
    return aiInputForRun({ ...run, firstPrinciples: fp2 })!.input;
  };
  const refused = (i: typeof input, text: string) => screenOutput({ read: [text], insights: [], review: [] }, i).readFailed;

  it("an unsourced truth's figures don't pass, though the rule check quotes it", () => {
    const i = withFp((f) => f.statements.push({ text: "We close 93% of leads within 17 days", kind: "truth", source: "", test: "", linked_parameter: null }));
    // The model is shown the check ("… is marked as a truth but has no source")…
    expect(JSON.stringify(i.payload)).toContain("We close 93% of leads within 17 days");
    // …but cannot state its figures.
    expect(refused(i, "Your own figure, 93% of leads within 17 days, is not what the run shows.")).toBe(true);
    expect(refused(i, "Leads are closed within 17 days.")).toBe(true);
    expect(refused(input, "The Strategist is busy avg 97% of the time (range 85%–101%).")).toBe(false);
  });

  it("a team named in an owner field doesn't carry figures: the check prints it unquoted, so it is cut", () => {
    const i = withFp((f) => f.requirements.push({ text: "Sign-off before any contract", owner_person_id: null, owner_text: "the 417 person sales team", why: "Legal", verdict: "keep", step_id: null }));
    expect(JSON.stringify(i.payload)).toContain("the 417 person sales team");
    expect(refused(i, "A team of 417 owns the sign-off.")).toBe(true);
  });

  it("an owner written over several lines is still cut", () => {
    const i = withFp((f) => f.requirements.push({ text: "Sign-off before any contract", owner_person_id: null, owner_text: "Team\nof 3731", why: "Legal", verdict: "keep", step_id: null }));
    expect(refused(i, "A group of 3731 owns the sign-off.")).toBe(true);
  });

  it("a ratio exemption needs the whole phrase, and only engine text can grant it", () => {
    expect(refused(input, "The rule of thumb is to add back about 1 in 10.")).toBe(false);
    expect(refused(input, "The rule of thumb is to add back about 1 in 1.")).toBe(true);
    // A step a team named "1 in 3 escalation flow" (the order check prints step names) can't exempt "1 in 3".
    const renamed = aiInputForRun({ ...run, bundle: { ...bundle, steps: bundle.steps.map((s) => (s.id === AUDIT || s.name === "Qualify lead" ? { ...s, name: "1 in 3 escalation flow" } : s)) } })!.input;
    expect(JSON.stringify(renamed.payload)).toContain("1 in 3 escalation flow");
    expect(refused(renamed, "1 in 3 leads is lost.")).toBe(true);
  });

  it("a success measure's name doesn't carry figures either, in the measures or in the rule's title", () => {
    const i = withFp((f) => f.measures.push({ id: "m9", text: "Revenue up 412% by spring", kpi: "newMrr", comparator: "atLeast", target: 50000, horizon: "" }));
    expect(JSON.stringify(i.payload)).toContain("Revenue up 412% by spring");
    expect(refused(i, "Revenue is not up 412% by spring.")).toBe(true);
    expect(refused(i, "Revenue is 412% short.")).toBe(true);
  });

  it("the measure's target and pass rate, which the engine wrote, are still facts", () => {
    const m = (input.payload.successMeasures as { target: string; today: string }[])[0]!;
    expect(refused(input, `The goal of ${m.target} is ${m.today}.`)).toBe(false);
  });
});

describe("words that state a ratio nobody computed are refused", () => {
  const ok = (text: string) => screenOutput({ read: [text], insights: [], review: [] }, input).readFailed;
  it("fractions, one in N, and figures-in-words", () => {
    for (const text of ["About a third of leads are lost.", "Roughly three quarters of runs miss it.", "About 3/4 of the work waits.", "One in ten items is done twice.", "About 1 in 10 items is done twice.", "It is a seven figures problem.", "Two thirds of the time it is busy."]) {
      expect(ok(text), text).toBe(true);
    }
  });
  it("refuses 1 in N when the facts don't print it, and lets the engine's own phrase through when they do", () => {
    expect(ok("1 in 3 leads is lost.")).toBe(true);
    expect(JSON.stringify(input.payload)).toContain("add back about 1 in 10");
    expect(ok("The rule of thumb is to add back about 1 in 10.")).toBe(false);
  });
  it("needs the \"of\" to call it a fraction, and lets idioms through (24/7, 50/50 are not ratios anyone computed)", () => {
    expect(ok("Work piles up in a quarter.")).toBe(false);
    expect(ok("A quarter of runs miss it.")).toBe(true);
    expect(ok("The queue is open 24/7 and the work splits 50/50 between two roles.")).toBe(false);
  });
  it("leaves plain engine wording alone", () => {
    expect(ok("The Strategist is busy avg 97% of the time (range 85%–101%).")).toBe(false);
  });
});

describe("the short list on the Overview", () => {
  it("never hides every AI insight below the cut", async () => {
    const rules = Array.from({ length: 8 }, (_, i) => ({ key: `capacity:role:r${i}`, type: "capacity" as const, rating: "risk" as const, escalation: { base: "risk" as const, badMonth: false, bottleneck: false }, cost: { perMonth: 1000 - i, hoursPerMonth: null, method: "" }, title: `Rule ${i}`, evidence: "Busy.", metrics: {}, stepId: null, roleId: null, personId: null, fix: null }));
    const ai = aiDetections((await analyseWithAi(input, fake(() => good()))).insights);
    const list = buildInsights(registerEntries([], [...rules, ...ai]));
    expect(list.findIndex((i) => i.source.kind === "ai"), "sorted after the costed rules").toBeGreaterThanOrEqual(5);
    const five = limitInsights(list, 5);
    expect(five).toHaveLength(5);
    expect(five.some((i) => i.source.kind === "ai")).toBe(true);
    expect(five.slice(0, 4).map((i) => i.title)).toEqual(list.slice(0, 4).map((i) => i.title));
    expect(limitInsights(list.filter((i) => i.source.kind !== "ai"), 5).some((i) => i.source.kind === "ai")).toBe(false);
    expect(limitInsights(list.slice(0, 2), 5)).toHaveLength(2);
  });
});

describe("quotations in single quotes are checked too", () => {
  it("invented ones are refused, real ones and apostrophes are not", () => {
    expect(quotationProblems("He said 'we never sleep and always chase leads' to us.", input.quotes)).toHaveLength(1);
    expect(quotationProblems("He said ‘we never sleep and always chase leads’ to us.", input.quotes)).toHaveLength(1);
    expect(quotationProblems("The Strategist's queue and the client's wait grow.", input.quotes)).toEqual([]);
    expect(quotationProblems("He said 'Most weeks that's my Sunday, honestly' to us.", input.quotes)).toEqual([]);
  });
});

describe("AI insights in the insight list", () => {
  const detections = async () => aiDetections((await analyseWithAi(input, fake(() => good()))).insights);

  it("are marked AI, carry their own rating and why, and say there is no cost", async () => {
    const d = await detections();
    const insights = buildInsights(registerEntries([], d));
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ source: { kind: "ai", name: "AI" }, rating: "bad", title: "The audit step holds up the whole line", why: expect.stringContaining("Everything after it waits") });
    expect(insights[0]!.cost.perMonth).toBeNull();
    expect(insights[0]!.stepIds).toEqual([AUDIT]);
  });

  it("can be acknowledged into an issue, which keeps its key and then reads as that issue", async () => {
    const d = await detections();
    const store = new MemoryIssueStore("w1");
    const state = issueState(store);
    const insight = buildInsights(registerEntries([], d))[0]!;
    const parsed = parsePromoteInput({ ...(await import("@/lib/issues/register")).promoteInput(insight.detection, bundle.process.id, []) });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    const issue = await acknowledgeInsight(state, insight, { processId: bundle.process.id, scenarios: [] });
    expect(issue).toMatchObject({ detected_key: insight.key, source: "promoted", type: "bottleneck" });
    const again = buildInsights(registerEntries([issue!], d));
    expect(again[0]).toMatchObject({ issue: { id: issue!.id }, source: { kind: "ai" } });
  });

  it("can be dismissed, and then stay off the list", async () => {
    const d = await detections();
    const store = new MemoryIssueStore("w1");
    const state = issueState(store);
    const insight = buildInsights(registerEntries([], d))[0]!;
    expect(await dismissInsight(state, insight, { processId: bundle.process.id, scenarios: [] })).toBe(true);
    const issues = [...(store as unknown as { rows: Map<string, never> }).rows.values()];
    expect(buildInsights(registerEntries(issues as never, d))).toHaveLength(0);
  });

  it("are read forgivingly from storage: a bad row is left out", () => {
    const stored = [
      { key: "ai:insight:abc123", type: "delay", rating: "bad", title: "Fine", evidence: "e", why: "w", stepId: null },
      { key: "capacity:role:x", type: "delay", rating: "bad", title: "Wrong key", evidence: "e", why: "w", stepId: null },
      { key: "ai:insight:def456", type: "perception_gap", rating: "bad", title: "Wrong type", evidence: "e", why: "w", stepId: null },
      "nonsense",
    ];
    expect(readInsights(stored).map((i) => i.title)).toEqual(["Fine"]);
    const view = aiViewFromRow({ id: "1", workspace_id: "w", process_id: "p", revision_id: "r", status: "ok", reason: null, trigger: "publish", summary: ["One.", 3, ""], insights: stored, review: [{ step: "job", level: "warn", text: "t" }, { step: "x", level: "warn", text: "t" }], checked: 3, dropped: 1, input_hash: "h", model: "m", model_hash: "mh", usage: [], run_id: "run", person_labels: {}, created_by: "u", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", run_by: "Ed Itor" });
    expect(view).toMatchObject({ summary: ["One."], review: [{ step: "job" }], checked: 3, dropped: 1, runBy: "Ed Itor", modelHash: "mh", costUsd: null });
    expect(view.review).toHaveLength(1);
  });
});

describe("the findings the model is given are the ones the pages show", () => {
  it("are rule findings, none of them AI's", () => {
    const keys = findings.map((f: DetectedIssue) => f.key);
    expect(keys.every((k) => !k.startsWith("ai:"))).toBe(true);
  });
});

describe("names stay out of what is saved (B1 2b)", () => {
  // The model is sent "Team member A", and what it writes is saved as it wrote it, with a map from each label to the person.
  // Names go back at render, per reader (packages/db/test/person-labels.test.ts).
  const [a, b] = bundle.people;
  const labelled = () => ({
    read: [`Over the run Northbeam wins ${results.wins}. Team member A is the busiest.`],
    insights: [
      {
        title: "Team member A holds up the whole line",
        type: "bottleneck",
        rating: "bad",
        stepId: AUDIT,
        evidence: `${firstSentence(first.evidence)} Team member B waits for Team member A.`,
        why: "Team member A prices everything.",
        facts: [input.facts[0]!.id],
      },
    ],
    review: [{ step: "saa", level: "bad", text: "Team member B owns the qualifier." }],
  });
  const everyone = [a!, b!, ...bundle.people].map((p) => p.name);

  it("saves the summary, insights, review and facts with labels, never a real name", async () => {
    const out = await analyseWithAi(input, fake(() => labelled()));
    expect(out.status).toBe("ok");
    const saved = JSON.stringify([out.summary, out.insights, out.review, out.reason]);
    for (const name of everyone) expect(saved, name).not.toContain(name);
    expect(out.summary[0]).toContain("Team member A is the busiest.");
    expect(out.insights[0]!.title).toBe("Team member A holds up the whole line");
    expect(out.insights[0]!.why).toBe("Team member A prices everything.");
    expect(out.review[0]!.text).toBe("Team member B owns the qualifier.");
  });

  it("maps exactly the labels used to the right people, for the analysis and for each insight", async () => {
    const out = await analyseWithAi(input, fake(() => labelled()));
    expect(out.personLabels).toEqual({ "Team member A": a!.id, "Team member B": b!.id });
    expect(out.insights[0]!.personLabels).toEqual({ "Team member A": a!.id, "Team member B": b!.id });
    // A text with one label maps one.
    const one = labelled();
    one.insights[0]!.evidence = firstSentence(first.evidence);
    one.insights[0]!.why = "It matters.";
    one.review = [{ step: "saa", level: "bad", text: "The qualifier needs an owner." }];
    one.read = [`Over the run Northbeam wins ${results.wins}.`];
    const few = await analyseWithAi(input, fake(() => one));
    expect(few.personLabels).toEqual({ "Team member A": a!.id });
    // None, when the model named nobody.
    expect((await analyseWithAi(input, fake(() => good()))).personLabels).toEqual({});
  });

  it("keys an insight on the title with each label swapped for the person's id: no real name, and no letter", async () => {
    const out = await analyseWithAi(input, fake(() => labelled()));
    const expected = `ai:insight:${createHash("sha1").update(`${squeeze(`person:${a!.id} holds up the whole line`)}|${AUDIT}`).digest("hex").slice(0, 12)}`;
    expect(out.insights[0]!.key).toBe(expected);
  });

  it("keeps the facts it cites as labelled text: nothing in a fact names a person either", async () => {
    const out = await analyseWithAi(input, fake(() => labelled()));
    const text = JSON.stringify(out.insights[0]!.facts);
    for (const name of everyone) expect(text, name).not.toContain(name);
    expect(out.insights[0]!.facts![0]).toMatchObject({ kind: "fact", key: input.facts[0]!.key, text: input.facts[0]!.text });
  });

  it("no longer maps stored text through restoreNames at all: the key is hashed on the labelled title", () => {
    const source = readFileSync(join(__dirname, "..", "src", "lib/ai/analyse.ts"), "utf8");
    expect(source).not.toMatch(/restoreNames|\bback\(/);
    expect(source).toContain("keyOf(personTokens(title, input.personLabels), stepId)");
  });

  it("an insight's key is the same whatever the people are called, so it holds no name; a different labelled title is a different key", async () => {
    const out = await analyseWithAi(input, fake(() => labelled()));
    const renamed = { ...input, aliases: input.aliases.map((x, i) => ({ ...x, name: `Someone Else ${i}` })) };
    const again = await analyseWithAi(renamed, fake(() => labelled()));
    expect(again.insights[0]!.key).toBe(out.insights[0]!.key);
    expect(out.insights[0]!.key).toMatch(/^ai:insight:[0-9a-f]{12}$/);
    // The same run twice dedupes; another title doesn't.
    const other = labelled();
    other.insights[0]!.title = "Team member B holds up the whole line";
    expect((await analyseWithAi(input, fake(() => other))).insights[0]!.key).not.toBe(out.insights[0]!.key);
  });

  it("buildAiInput's fact and quote refs hold labels, not names; the map covers everyone", () => {
    const [p, q] = bundle.people;
    const base = findings[0]!;
    const made = buildAiInput({
      processName: "Lead to live",
      results: runResults(model, result, "GBP"),
      findings: [{ ...base, title: `${p!.name} works late`, evidence: `${q!.name} can't cover. ${p!.name} agrees.` }],
      steps: [{ id: AUDIT, name: "Audit & proposal" }],
      roles: [],
      people: bundle.people.map((x) => ({ id: x.id, name: x.name })),
      firstPrinciples: null,
      flags: null,
      measures: [],
      quotes: [{ step: "Audit & proposal", quote: `${q!.name} said it takes twelve hours` }],
      marketOn: false,
      currency: "GBP",
    });
    expect(made.facts[0]!.text).toBe("Team member A works late. Team member B can't cover. Team member A agrees.");
    expect(made.quoteRefs[0]!.text).toBe("Team member B said it takes twelve hours");
    expect(made.quoteRefs[0]!.key).toBe("Audit & proposal");
    expect(made.personLabels["Team member A"]).toBe(p!.id);
    expect(made.personLabels["Team member B"]).toBe(q!.id);
    expect(Object.keys(made.personLabels)).toHaveLength(bundle.people.length);
    expect(made.aliases.every((x) => typeof x.id === "string")).toBe(true);
  });

  it("a first name becomes a label only as written: a step called 'mark invoice paid' is not Mark Lee", () => {
    const aliases = aliasesFor([{ id: "a", name: "Mark Lee" }, { id: "b", name: "Will Hart" }]);
    expect(applyAliases("Check, then mark invoice paid", aliases)).toBe("Check, then mark invoice paid");
    expect(applyAliases("Will Hart is at capacity; this will get worse", aliases)).toBe("Team member B is at capacity; this will get worse");
    expect(applyAliases("Ask Mark and MARK LEE about it", aliases)).toBe("Ask Team member A and Team member A about it");
  });

  it("a step called 'Mark invoice paid' stays that for a person named Mark Lee: engine text takes full names only, quotes keep first names", () => {
    const [p] = bundle.people;
    const base = findings[0]!;
    const made = buildAiInput({
      processName: "Lead to live",
      results: runResults(model, result, "GBP"),
      findings: [{ ...base, title: "Mark invoice paid is slow; Mark Lee covers it", evidence: "Mark invoice paid waits two days." }],
      steps: [{ id: AUDIT, name: "Mark invoice paid" }],
      roles: [],
      people: [{ id: p!.id, name: "Mark Lee" }],
      firstPrinciples: null,
      flags: null,
      measures: [],
      quotes: [{ step: "Mark invoice paid", quote: "Mark said it takes twelve hours; Mark Lee agrees" }],
      marketOn: false,
      currency: "GBP",
    });
    const sent = JSON.stringify(made.payload);
    expect(sent).toContain("Mark invoice paid is slow");
    expect(sent).not.toContain("Team member A invoice paid");
    expect(made.payload.steps).toEqual([{ id: AUDIT, name: "Mark invoice paid" }]);
    expect(made.facts[0]!.text).toBe("Mark invoice paid is slow; Mark Lee covers it. Mark invoice paid waits two days.".replace("Mark Lee", "Team member A"));
    // What a person typed in a quote does name people by first name.
    expect(made.quoteRefs[0]!.text).toBe("Team member A said it takes twelve hours; Team member A agrees");
    expect(JSON.stringify(made.payload.quotesFromSources)).toContain("Team member A said it takes twelve hours");
  });

  it("an insight keeps its key when the roster is reordered or grows, and another person gives another key", async () => {
    const out = await analyseWithAi(input, fake(() => labelled()));
    const letter = (i: number) => `Team member ${String.fromCharCode(65 + i)}`;
    // Maya is "A" in `input`. Hire two people ahead of her: she becomes "C", the title the model writes says so.
    const shifted = { ...input, personLabels: { [letter(0)]: "new-1", [letter(1)]: "new-2", [letter(2)]: a!.id, [letter(3)]: b!.id } };
    const hired = labelled();
    hired.insights[0]!.title = "Team member C holds up the whole line";
    hired.insights[0]!.evidence = `${firstSentence(first.evidence)} Team member D waits for Team member C.`;
    hired.insights[0]!.why = "Team member C prices everything.";
    hired.review = [{ step: "saa", level: "bad", text: "Team member D owns the qualifier." }];
    hired.read = [`Over the run Northbeam wins ${results.wins}. Team member C is the busiest.`];
    const again = await analyseWithAi(shifted, fake(() => hired));
    expect(again.status).toBe("ok");
    expect(again.insights[0]!.key).toBe(out.insights[0]!.key);
    // The new first person, in the old title's words, is a different finding.
    const other = labelled();
    const swapped = { ...input, personLabels: { ...input.personLabels, "Team member A": "someone-else" } };
    expect((await analyseWithAi(swapped, fake(() => other))).insights[0]!.key).not.toBe(out.insights[0]!.key);
  });

  it("engine text that quotes what people typed gets first names aliased: checks, measure names and success findings; step names don't", () => {
    const [p] = bundle.people;
    const base = findings[0]!;
    const made = buildAiInput({
      processName: "Lead to live",
      results: runResults(model, result, "GBP"),
      findings: [
        { ...base, key: "success:measure:m1", title: "Goal not reliably met: Maya reviews each pitch", evidence: "Maya reviews each pitch is met in 40% of runs." },
        { ...base, key: "spof:step:s1", title: "Mark invoice paid waits", evidence: "Mark invoice paid is slow." },
      ],
      steps: [{ id: AUDIT, name: "Mark invoice paid" }],
      roles: [],
      people: [{ id: p!.id, name: "Maya Shah" }],
      firstPrinciples: null,
      flags: { job: [], truths: [{ level: "warn", code: "truth_no_source", text: "“Maya checks every quote” is marked as a truth but has no source" }], reqs: [], del: [], saa: [], why: [], measures: [] },
      measures: [{ measure: { id: "m1", text: "Maya reviews each pitch", kpi: null, comparator: "atLeast", target: 1, horizon: "" }, check: null, metShare: 0.4 }],
      quotes: [],
      marketOn: false,
      currency: "GBP",
    });
    const sent = made.payload as unknown as { firstPrinciplesChecks: { text: string }[]; successMeasures: { measure: string }[]; findings: { title: string; evidence: string }[] };
    expect(sent.firstPrinciplesChecks[0].text).toBe("“Team member A checks every quote” is marked as a truth but has no source");
    expect(sent.successMeasures[0].measure).toBe("Team member A reviews each pitch");
    expect(sent.findings[0].title).toBe("Goal not reliably met: Team member A reviews each pitch");
    expect(sent.findings[0].evidence).toBe("Team member A reviews each pitch is met in 40% of runs.");
    expect(made.facts[0]!.text).toContain("Team member A reviews each pitch");
    // An engine finding that is not a success measure: "Mark" isn't a name here, and Maya isn't in it.
    expect(sent.findings[1].title).toBe("Mark invoice paid waits");
    expect(JSON.stringify(made.payload)).not.toContain("Maya");
  });

  it("a one-word name matches only as written, in aliasesFor and in labelNames; a multi-word name still matches in any case", () => {
    const people = [{ id: "00000000-0000-4000-8000-000000000001", name: "Will" }, { id: "00000000-0000-4000-8000-000000000002", name: "Ann Lee" }];
    const aliases = aliasesFor(people);
    expect(applyAliases("Will is at capacity; this will get worse. ANN LEE too.", aliases)).toBe("Team member A is at capacity; this will get worse. Team member B too.");
    const labels = { "Team member A": people[0]!.id, "Team member B": people[1]!.id };
    expect(labelNames("Will is at capacity; this will get worse. ann lee too.", labels, people)).toBe("Team member A is at capacity; this will get worse. Team member B too.");
  });
});

