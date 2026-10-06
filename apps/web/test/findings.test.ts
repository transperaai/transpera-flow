import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findingDraftProblem, findingIdOfKey, findingKey, northbeamIssues, partOf, readCitations, toEngineModel, type FindingRow, type IssueRow } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { FactsList } from "@/components/findings/facts-list";
import { costOfUsage, formatCost } from "@/lib/ai/cost";
import { MemoryFindingsStore } from "@/lib/findings/use-findings";
import { findingDetection, findingsIn, legacyDetection, pageDetections, proposedFindings } from "@/lib/findings/view";
import { buildInsights, sourceOf } from "@/lib/insights/insights";
import { registerEntries } from "@/lib/issues/register";
import { COMPANY_GROUP, findingsByProcess, groupOfFinding, groupOfIssue } from "@/lib/overview/by-process";
import { rerate } from "@/lib/rules/edit";
import { demoBundle } from "@/lib/sources/demo";

// Findings (issue #175, B17; decision D40): the engine's results are facts, shown as evidence and never as findings; a
// finding is AI's (proposed until someone accepts it) or a person's (accepted as they add it); only accepted findings are
// listed, and insights acknowledged before B17 are kept as accepted findings, linked to their issue.

const live = demoBundle();
const parts = [partOf(live), ...(live.otherProcesses ?? [])];
const pipeline = live.process.id;
const model = toEngineModel(live);
const facts = rerate(model, simulate(model, 6, 1), {}, pipeline);
const AUDIT = live.steps.find((s) => s.name === "Audit & proposal")!.id;

const finding = (over: Partial<FindingRow> = {}): FindingRow => ({
  id: "00000000-0000-4000-a000-000000000001",
  workspace_id: live.workspace.id,
  process_id: pipeline,
  step_id: AUDIT,
  origin: "ai",
  status: "accepted",
  rating: "bad",
  type: "delay",
  title: "Proposals wait for one person",
  evidence: "Work waits 6.2 working days for Audit & proposal.",
  why: "Founders go elsewhere.",
  facts: [{ kind: "fact", key: facts[0]!.key, text: facts[0]!.title }],
  person_labels: {},
  source_ids: [],
  ai_key: "ai:insight:aaaaaaaaaaaa",
  analysis_id: null,
  run_id: null,
  edited: false,
  proposed_via: null,
  created_by: null,
  created_at: "2026-10-01T09:00:00.000Z",
  updated_by: null,
  updated_at: "2026-10-01T09:00:00.000Z",
  decided_by: null,
  decided_at: null,
  ...over,
});

const issue = (over: Partial<IssueRow>): IssueRow => ({ ...northbeamIssues()[0]!, ...over });

describe("a finding's key", () => {
  it("is the shape an issue's detected key must have, and leads back to the finding", () => {
    const f = finding();
    expect(findingKey(f)).toBe(`finding:ai:${f.id}`);
    expect(findingKey({ ...f, origin: "manual" })).toBe(`finding:by_hand:${f.id}`);
    expect(findingKey(f)).toMatch(/^[a-z_]+:[a-z_]+:\S{1,200}$/);
    expect(findingIdOfKey(findingKey(f))).toBe(f.id);
    expect(findingIdOfKey("wait:step:x")).toBeNull();
  });

  it("reads stored citations forgivingly", () => {
    expect(readCitations([{ kind: "fact", key: "k", text: "t" }, { kind: "x", key: "k", text: "t" }, { kind: "quote", key: "Step", text: "" }, "nope"])).toEqual([{ kind: "fact", key: "k", text: "t" }]);
    expect(readCitations(null)).toEqual([]);
  });
});

describe("what a page lists", () => {
  it("lists accepted findings only, never a proposed, dismissed or superseded one, and never a fact on its own", () => {
    const list = pageDetections({
      findings: [finding(), finding({ id: "00000000-0000-4000-a000-000000000002", status: "proposed" }), finding({ id: "00000000-0000-4000-a000-000000000003", status: "dismissed" }), finding({ id: "00000000-0000-4000-a000-000000000004", status: "superseded" })],
      issues: [],
      facts,
    });
    expect(list.map((d) => d.key)).toEqual([findingKey(finding())]);
    expect(facts.length).toBeGreaterThan(0);
  });

  it("shows a finding with its origin, why, step, where it sits and the facts it rests on; it has no cost of its own", () => {
    const d = findingDetection(finding());
    expect(d).toMatchObject({ origin: "ai", why: "Founders go elsewhere.", stepId: AUDIT, findingProcessId: pipeline, rating: "bad", type: "delay" });
    expect(d.facts).toHaveLength(1);
    expect(d.cost.perMonth).toBeNull();
    const [insight] = buildInsights(registerEntries([], [findingDetection(finding({ origin: "manual", ai_key: null }))]));
    expect(insight!.source).toEqual({ kind: "manual", name: "By hand" });
  });

  it("keeps insights acknowledged before B17 as accepted findings: costed by the live fact while the run still finds it, else in the issue's own words", () => {
    const fact = facts.find((f) => f.cost.perMonth != null) ?? facts[0]!;
    const still = issue({ id: "i1", detected_key: fact.key, status: "open" });
    const gone = issue({ id: "i2", detected_key: "wait:step:gone", status: "resolved", title: "Old wait", evidence: "It waited." });
    const dismissed = issue({ id: "i3", detected_key: "spare:person:x", status: "dismissed" });
    const byHand = issue({ id: "i4", detected_key: null });
    const fromFinding = issue({ id: "i5", detected_key: findingKey(finding()) });
    const list = pageDetections({ findings: [finding()], issues: [still, gone, dismissed, byHand, fromFinding], facts });
    expect(list.map((d) => d.key).sort()).toEqual([findingKey(finding()), fact.key, "wait:step:gone"].sort());
    expect(list.find((d) => d.key === fact.key)).toBe(fact);
    expect(legacyDetection(gone)).toMatchObject({ title: "Old wait", evidence: "It waited.", origin: "rule", rating: expect.any(String) });
    // Each reads as the issue it became.
    const insights = buildInsights(registerEntries([still, gone, fromFinding], list));
    expect(insights.filter((i) => i.issue).map((i) => i.issue!.id).sort()).toEqual(["i1", "i2", "i5"]);
  });

  it("reviews only proposed AI findings, newest first, and keeps a process's findings to it", () => {
    const a = finding({ id: "a", status: "proposed", created_at: "2026-10-01T09:00:00Z" });
    const b = finding({ id: "b", status: "proposed", created_at: "2026-10-02T09:00:00Z" });
    expect(proposedFindings([a, b, finding({ id: "c" })]).map((f) => f.id)).toEqual(["b", "a"]);
    const company = finding({ id: "d", process_id: null });
    expect(findingsIn([a, company], { processIds: new Set([pipeline]) }).map((f) => f.id)).toEqual(["a"]);
    expect(findingsIn([a, company], null).map((f) => f.id)).toEqual(["d"]);
  });
});

describe("findings Claude proposed over the connector (B20)", () => {
  it("carries where it came from into its detection, and names its source", () => {
    const viaApp = findingDetection(finding());
    const viaConnector = findingDetection(finding({ proposed_via: "connector" }));
    expect(viaApp).not.toHaveProperty("via");
    expect(viaConnector).toMatchObject({ origin: "ai", via: "connector" });
    expect(sourceOf(viaApp)).toEqual({ kind: "ai", name: "AI" });
    expect(sourceOf(viaConnector)).toEqual({ kind: "ai", name: "Claude (connector)" });
    expect(sourceOf(findingDetection(finding({ proposed_via: "connector", edited: true })))).toEqual({ kind: "ai", name: "Claude (connector), edited", edited: true });
    expect(sourceOf(findingDetection(finding({ edited: true })))).toEqual({ kind: "ai", name: "AI, edited", edited: true });
  });
});

describe("findings and facts by process on the Overview", () => {
  const stepProcess = new Map(parts.flatMap((p) => p.steps.map((s) => [s.id, p.process.id] as const)));
  const processOfStep = (id: string) => stepProcess.get(id);

  it("puts a finding where it says it sits, a company one across the company, whatever its step", () => {
    expect(groupOfFinding(findingDetection(finding()), processOfStep, pipeline)).toBe(pipeline);
    expect(groupOfFinding(findingDetection(finding({ process_id: null, step_id: null })), processOfStep, pipeline)).toBe(COMPANY_GROUP);
    // An issue from a finding sits where it was logged, not by its key.
    const ids = new Set(parts.map((p) => p.process.id));
    expect(groupOfIssue(issue({ detected_key: findingKey(finding()), process_id: pipeline, step_id: null, links: [] }), processOfStep, pipeline, ids)).toBe(pipeline);
  });

  it("gives every group its facts as evidence, each fact in exactly one group, and counts new findings, not facts", () => {
    const insights = buildInsights(registerEntries([], pageDetections({ findings: [finding()], issues: [], facts })));
    const groups = findingsByProcess({ parts, pipelineId: pipeline, insights, facts, issues: [], solutions: [] });
    expect(groups.reduce((n, g) => n + g.facts.length, 0)).toBe(facts.length);
    expect(groups.find((g) => g.id === COMPANY_GROUP)!.facts.some((f) => f.key.startsWith("capacity:"))).toBe(true);
    const lead = groups.find((g) => g.id === pipeline)!;
    expect(lead.insights.map((i) => i.title)).toEqual(["Proposals wait for one person"]);
    expect(lead.newInsights).toBe(1);
    expect(groups.reduce((n, g) => n + g.newInsights, 0)).toBe(1);
  });

  it("shows facts read-only, with what measured them and where, and no Acknowledge or Dismiss", () => {
    const html = renderToStaticMarkup(createElement(FactsList, { facts: facts.slice(0, 3), currency: "GBP", stepName: () => "Audit & proposal" }));
    expect((html.match(/data-fact=/g) ?? []).length).toBe(3);
    expect(html).not.toContain("Acknowledge");
    expect(html).not.toContain("Dismiss");
    expect(renderToStaticMarkup(createElement(FactsList, { facts: [], currency: "GBP", stepName: () => null }))).toContain("Nothing stands out");
    expect(renderToStaticMarkup(createElement(FactsList, { facts: null, currency: "GBP", stepName: () => null }))).toContain('aria-busy="true"');
  });
});

describe("findings by hand in memory (the demo)", () => {
  it("adds one accepted at once, edits it, and dismisses it; refuses one with no title", async () => {
    const store = new MemoryFindingsStore("w", []);
    expect(await store.create({ processId: "p", stepId: null, rating: "bad", type: "delay", title: " ", evidence: "", why: "" })).toMatchObject({ status: "invalid" });
    const added = await store.create({ processId: "p", stepId: null, rating: "bad", type: "delay", title: "Slow replies", evidence: "Seen in calls.", why: "Clients wait." });
    expect(added).toMatchObject({ status: "saved", finding: { origin: "manual", status: "accepted", title: "Slow replies" } });
    const id = (added as { finding: FindingRow }).finding.id;
    expect(await store.edit(id, { processId: "p", stepId: null, rating: "risk", type: "delay", title: "Replies take two days", evidence: "", why: "" }, false)).toMatchObject({ finding: { title: "Replies take two days", rating: "risk", status: "accepted" } });
    expect(await store.decide(id, "dismissed")).toMatchObject({ finding: { status: "dismissed" } });
  });

  it("checks a draft as the database does", () => {
    const ok = { processId: null, stepId: null, rating: "bad" as const, type: "delay" as const, title: "T", evidence: "", why: "" };
    expect(findingDraftProblem(ok)).toBeNull();
    expect(findingDraftProblem({ ...ok, title: "x".repeat(201) })).toMatch(/under 200/);
    expect(findingDraftProblem({ ...ok, type: "perception_gap" as never })).toMatch(/kind/);
  });
});

describe("what an analysis cost", () => {
  it("prices the model's tokens at its list price, and says so plainly; an unknown model isn't priced", () => {
    const usage = [
      { inputTokens: 6000, outputTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 5000 },
      { inputTokens: 500, outputTokens: 1200, cacheReadTokens: 5000, cacheWriteTokens: 0 },
    ];
    const usd = costOfUsage("claude-opus-5-5", usage)!;
    expect(usd).toBeCloseTo((6500 * 4 + 2700 * 20 + 5000 * 0.2 + 5000 * 5) / 1e6, 10);
    expect(formatCost(usd)).toBe("about $0.11");
    expect(formatCost(0.004)).toBe("under $0.01");
    expect(costOfUsage("some-other-model", usage)).toBeNull();
    // The id the API served it under: a snapshot date or a context-window suffix is the same model's price.
    expect(costOfUsage("claude-opus-5-5-20261001", usage)).toBe(usd);
    expect(costOfUsage("claude-opus-5-5[1m]", usage)).toBe(usd);
    expect(costOfUsage("claude-opus-5-5-preview", usage)).toBeNull();
    expect(costOfUsage("claude-opus-5-5", [])).toBeNull();
    expect(formatCost(null)).toBeNull();
  });
});
