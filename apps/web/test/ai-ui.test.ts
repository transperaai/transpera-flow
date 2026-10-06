import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SETTINGS, type FindingRow } from "@transpera-flow/db";
import { AnalysisPanel } from "@/components/findings/analysis-panel";
import { AiReviewPanel } from "@/components/ai/ai-review-panel";
import { AiSettingsPage } from "@/components/ai/ai-settings";
import { SidebarProvider } from "@/components/ui/sidebar";
import { demoAiView } from "@/lib/ai/demo";
import { AI_SWITCHES } from "@/lib/ai/switches";
import type { AiAnalysisView, AiPanelData } from "@/lib/ai/types";
import { factsDigest, joinAnalysisHash } from "@/lib/ai/facts-digest";
import type { FindingsState } from "@/lib/findings/use-findings";
import { NORTHBEAM_PROCESS_ID } from "@transpera-flow/db";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/w/s", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/app/w/[slug]/ai-actions", () => ({ analyseProcess: async () => ({ status: "ok", message: "" }), analyseCompany: async () => ({ status: "ok", message: "" }) }));
vi.mock("@/app/w/[slug]/findings-actions", () => ({ createFinding: async () => ({ status: "forbidden" }), editFinding: async () => ({ status: "forbidden" }), decideFinding: async () => ({ status: "forbidden" }) }));
vi.mock("@/app/w/[slug]/settings/ai/actions", () => ({ saveAiSwitch: async () => ({ status: "error", message: "" }) }));

// What the AI panels say in each state (issue #111, A46; B17): the analysis panel (Analyse, the read, out of date, cost and
// model, the findings to review), the first-principles review panel and Settings -> AI analysis.

const view = (over: Partial<AiAnalysisView> = {}): AiAnalysisView => ({
  status: "ok",
  reason: null,
  trigger: "publish",
  summary: ["The Strategist is the constraint."],
  insights: [],
  review: [
    { step: "saa", level: "bad", text: "Automating Qualify lead comes before deciding to delete it." },
    { step: "why", level: "ok", text: "The root cause is in the process." },
  ],
  checked: 4,
  dropped: 1,
  model: "claude-opus-5-5",
  at: "2026-10-01T09:00:00.000Z",
  revisionId: "r",
  runBy: "Ed Itor",
  ...over,
});
const data = (over: Partial<AiPanelData> = {}): AiPanelData => ({ view: view(), configured: true, hasFirstPrinciples: true, versionNumber: 3, ...over });
const proposal = (over: Partial<FindingRow> = {}): FindingRow => ({
  id: "f1",
  workspace_id: "w",
  process_id: "p",
  step_id: null,
  origin: "ai",
  status: "proposed",
  rating: "bad",
  type: "delay",
  title: "Proposals wait for one person",
  evidence: "Work waits 6.2 working days for Audit & proposal.",
  why: "Founders go elsewhere.",
  facts: [{ kind: "fact", key: "wait:step:a", text: "Work waits 6.2 working days for Audit & proposal." }],
  person_labels: {},
  source_ids: [],
  ai_key: "ai:insight:aaaaaaaaaaaa",
  analysis_id: "a",
  run_id: "run-1",
  edited: false,
  created_by: null,
  created_at: "2026-10-01T09:00:00.000Z",
  updated_by: null,
  updated_at: "2026-10-01T09:00:00.000Z",
  decided_by: null,
  decided_at: null,
  ...over,
});
const findingsState = (canEdit = true): FindingsState => ({
  findings: [],
  busy: false,
  error: null,
  canEdit,
  create: async () => null,
  edit: async () => null,
  accept: async () => null,
  dismiss: async () => null,
  receive: () => {},
  dismissError: () => {},
});
const read = (ai: AiPanelData, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(AnalysisPanel, {
      mode: "live",
      scope: "process",
      ai,
      findings: findingsState(over.mode !== "readonly"),
      proposed: [],
      options: { processes: [{ id: "p", name: "Lead to live" }], company: false, steps: [] },
      defaultProcessId: "p",
      stepName: () => null,
      analyse: async () => ({ status: "ok", message: "" }),
      firstPrinciplesHref: "/w/s/p/p/first-principles",
      ...over,
    } as Parameters<typeof AnalysisPanel>[0]),
  );
const panel = (ai: AiPanelData, step: "saa" | "job" = "saa", over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AiReviewPanel, { mode: "live", processId: "p", step, ai, ...over }));

describe("the analysis panel", () => {
  it("shows the read, who and what wrote it, how much was checked and what it cost, with Analyse again", () => {
    const html = read(data({ view: view({ costUsd: 0.0612 }) }));
    expect(html).toContain("AI analysis");
    expect(html).toContain("The Strategist is the constraint.");
    expect(html).toContain("Written 1 Oct 2026 by claude-opus-5-5, run by Ed Itor. 4 numbers checked against the run; 1 item left out");
    expect(html).toContain("Cost about $0.06.");
    expect(html).toContain("Analyse again");
    expect(html).toContain("Add a finding");
    expect(html).not.toContain("Out of date");
  });

  it("marks a stored analysis out of date when what it read has changed since, and keeps showing it", () => {
    const html = read(data({ stale: true }));
    expect(html).toContain('data-analysis="stale"');
    expect(html).toContain("Out of date");
    expect(html).toContain("What this read has changed since it was written (the process, the facts from its run, its first principles or sources). Analyse again to bring it up to date.");
    expect(html).toContain("The Strategist is the constraint.");
    expect(read(data({ stale: true }), { scope: "company" })).toContain("(the company model, the facts");
  });

  it("marks it out of date when the page's facts differ from those it read, once the run is in", () => {
    const facts = [{ key: "wait:step:a", rating: "bad", type: "delay" }];
    const hash = joinAnalysisHash("base", factsDigest(facts));
    const at = (pageFacts: typeof facts | null) => read(data({ view: view({ modelHash: hash }) }), { facts: pageFacts });
    expect(at(facts)).not.toContain("Out of date");
    expect(at(null)).not.toContain("Out of date");
    expect(at([{ ...facts[0]!, rating: "risk" }])).toContain("Out of date");
    expect(at([...facts, { key: "queue:step:b", rating: "bad", type: "delay" }])).toContain("Out of date");
  });

  it("says AI analysis isn't set up when the server has no key, and still offers a finding by hand", () => {
    const html = read(data({ view: null, configured: false }));
    expect(html).toContain("AI analysis isn&#x27;t set up");
    expect(html).toContain("You can still add findings by hand");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Analyse<\/button>/);
  });

  it("asks for first principles when there are none", () => {
    const html = read(data({ view: null, hasFirstPrinciples: false }));
    expect(html).toContain("Write this process&#x27;s first principles first");
    expect(html).toContain('href="/w/s/p/p/first-principles"');
  });

  it("says it hasn't run yet, and that Analyse runs it", () => {
    expect(read(data({ view: null }))).toContain("Not analysed yet. Press Analyse to have AI read the facts and propose findings for you to review.");
  });

  it("says why it couldn't write an analysis", () => {
    expect(read(data({ view: view({ summary: [], status: "failed", reason: "the model declined to write it" }) }))).toContain("AI couldn&#x27;t write an analysis that matched the run: the model declined to write it");
  });

  it("lists the proposed findings for an editor to accept, edit or dismiss, each with the facts it rests on", () => {
    const html = read(data(), { proposed: [proposal(), proposal({ id: "f2", status: "accepted", title: "Already accepted" })] });
    expect(html).toContain("To review · 1");
    expect(html).toContain("Proposals wait for one person");
    expect(html).not.toContain("Already accepted");
    expect(html).toContain("Rests on 1 fact");
    // The facts open under it before anyone accepts (closed at first), and each button names the finding it acts on.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="cited-f1"');
    for (const b of [">Accept<", ">Edit<", ">Dismiss<"]) expect(html).toContain(b);
    for (const b of ["Accept", "Edit", "Dismiss"]) expect(html).toContain(`aria-label="${b}: Proposals wait for one person"`);
  });

  it("shows a viewer no review list and no buttons, only that findings are waiting", () => {
    const html = read(data(), { mode: "readonly", proposed: [proposal()] });
    expect(html).not.toContain("To review");
    expect(html).not.toContain("Proposals wait for one person");
    expect(html).toContain("AI proposed 1 finding, waiting for someone who can edit to review.");
    expect(html).not.toContain("Analyse");
    expect(html).not.toContain("Add a finding");
  });

  it("has no Analyse on an earlier version", () => {
    expect(read(data(), { canRun: false })).not.toContain("Analyse again");
  });

  it("on the demo shows the written-in-advance read and an Analyse that is never disabled", () => {
    const html = read(data({ view: demoAiView(NORTHBEAM_PROCESS_ID), versionNumber: 3 }), { mode: "demo" });
    expect(html).toContain("The Strategist is the constraint");
    expect(html).toContain("Written in advance for the demo");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Analyse again/);
  });
});

describe("the AI review panel", () => {
  it("lists AI's findings on the step on screen only, marked by level", () => {
    const html = panel(data(), "saa");
    expect(html).toContain("Automating Qualify lead comes before deciding to delete it.");
    expect(html).not.toContain("The root cause is in the process.");
    expect(html).toContain('data-ai-finding="bad"');
    expect(html).toContain("Needs fixing");
    expect(panel(data(), "job")).toContain("Nothing to add on this step.");
  });

  it("says what it reviewed and how much was checked", () => {
    expect(panel(data())).toContain("Reviewed by AI · run by Ed Itor. It reviewed version 3 and its first principles. 4 numbers checked against the run; 1 finding left out");
  });

  it("replaces the old placeholder: nothing says it isn't switched on", () => {
    expect(panel(data())).not.toContain("Not switched on yet");
    expect(panel(data({ view: null }))).not.toContain("Not switched on yet");
  });

  it("says AI analysis isn't set up, or that it hasn't run, or that it failed", () => {
    expect(panel(data({ view: null, configured: false }))).toContain("AI analysis isn&#x27;t set up");
    expect(panel(data({ view: null }))).toContain("AI hasn&#x27;t reviewed this version yet");
    expect(panel(data({ view: null, hasFirstPrinciples: false }))).toContain("Publish this one");
    expect(panel(data({ view: view({ status: "failed", review: [], reason: "it timed out" }) }))).toContain("AI couldn&#x27;t review this version: it timed out");
  });

  it("has Analyse for editors only", () => {
    expect(panel(data())).toContain("Analyse");
    expect(panel(data(), "saa", { mode: "readonly" })).not.toContain(">Analyse<");
  });
});

describe("Settings -> AI analysis", () => {
  const page = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(SidebarProvider, null, createElement(AiSettingsPage, { mode: "live", workspaceId: "w", initial: { ...DEFAULT_AI_SETTINGS }, configured: true, ...over })));

  it("has the three switches left once analysis runs only on demand (B17), each with an (i)", () => {
    const html = page();
    expect(AI_SWITCHES.map((s) => s.label)).toEqual([
      "Suggest issues (they land in Suggestions)",
      "Suggest solution ideas using blocks from the library",
      "Read linked sources and quotes",
    ]);
    for (const s of AI_SWITCHES) {
      expect(html).toContain(s.label);
      expect(html).toContain(`About ${s.label}`);
      expect(html).toContain(`data-ai-switch="${s.key}"`);
    }
    expect((html.match(/role="switch"/g) ?? []).length).toBe(3);
    // Nothing reviews a version on its own any more.
    expect(html).not.toContain("Review after each published version");
    expect(html).not.toContain("Review when market conditions change");
    expect(html).toContain("Runs when you press Analyse");
  });

  it("gives every switch plain-English help with an example, and the two suggest switches say what turning them off does", () => {
    for (const s of AI_SWITCHES) {
      expect(s.description.length, s.key).toBeGreaterThan(40);
      expect(s.example.length, s.key).toBeGreaterThan(10);
    }
    // Both feed the Suggestions page now, and Claude's propose tools obey them.
    expect(AI_SWITCHES.filter((s) => s.later)).toEqual([]);
    for (const key of ["suggest_issues", "suggest_solutions"]) {
      const d = AI_SWITCHES.find((x) => x.key === key)!.description;
      expect(d).toMatch(/wait in Suggestions/);
      expect(d).toMatch(/Turn it off and Claude can no longer propose/);
      expect(d).not.toMatch(/built yet|isn't built|aren't built/);
    }
  });

  it("says what is sent whatever the sources switch is", () => {
    const d = AI_SWITCHES.find((x) => x.key === "read_sources")!.description;
    expect(d).toMatch(/first principles \(including the source notes on your truths\)/);
    expect(d).toMatch(/names of the process, its steps and roles/);
  });

  it("starts with reading sources off, and says that sending quotes is why", () => {
    const html = page();
    const sources = html.slice(html.indexOf('data-ai-switch="read_sources"'));
    expect(sources).toMatch(/aria-checked="false"/);
    expect(sources).toContain("Sends short quotes from your sources to Anthropic");
  });

  it("says when the server has no key, and is read-only for a viewer", () => {
    expect(page({ configured: false })).toContain("AI analysis isn&#x27;t set up");
    expect(page({ mode: "readonly" })).toContain("Only owners and editors can change these.");
    expect(page({ mode: "demo", workspaceId: null, configured: false })).not.toContain("isn&#x27;t set up:");
  });
});
