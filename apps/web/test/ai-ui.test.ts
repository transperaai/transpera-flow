import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SETTINGS } from "@transpera-flow/db";
import { AiRead } from "@/components/ai/ai-read";
import { AiReviewPanel } from "@/components/ai/ai-review-panel";
import { AiSettingsPage } from "@/components/ai/ai-settings";
import { SidebarProvider } from "@/components/ui/sidebar";
import { demoAiView } from "@/lib/ai/demo";
import { AI_SWITCHES } from "@/lib/ai/switches";
import type { AiAnalysisView, AiPanelData } from "@/lib/ai/types";
import { NORTHBEAM_PROCESS_ID } from "@transpera-flow/db";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/w/s", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/app/w/[slug]/ai-actions", () => ({ runAiAnalysisNow: async () => ({ status: "ok", message: "" }) }));
vi.mock("@/app/w/[slug]/settings/ai/actions", () => ({ saveAiSwitch: async () => ({ status: "error", message: "" }) }));

// What the AI panels say in each state (issue #111, A46): the read, the review panel and Settings -> AI analysis.

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
const read = (ai: AiPanelData, over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AiRead, { mode: "live", scope: "process", processId: "p", ai, firstPrinciplesHref: "/w/s/p/p/first-principles", ...over }));
const panel = (ai: AiPanelData, step: "saa" | "job" = "saa", over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AiReviewPanel, { mode: "live", processId: "p", step, ai, ...over }));

describe("the AI read", () => {
  it("shows the read, where it is from, and how much was checked", () => {
    const html = read(data());
    expect(html).toContain("AI read of this run");
    expect(html).toContain("The Strategist is the constraint.");
    expect(html).toContain("Version 3, written 1 Oct 2026 by claude-opus-5-5. Reviewed by AI · run by Ed Itor. 4 numbers checked against the run; 1 item left out");
    expect(html).toContain("Run again");
    // The (i)s beside the title and Run again were removed on purpose (QA wave 1): the read's own line says what it uses.
    expect(html).not.toContain("About AI read");
  });

  it("says AI analysis isn't set up when the server has no key", () => {
    const html = read(data({ view: null, configured: false }));
    expect(html).toContain("AI analysis isn&#x27;t set up");
    expect(html).not.toContain("Write first principles");
    expect(html).toContain("disabled");
  });

  it("asks for first principles when there are none", () => {
    const html = read(data({ view: null, hasFirstPrinciples: false }));
    expect(html).toContain("Write its first principles so the review can judge it against your goal");
    expect(html).toContain('href="/w/s/p/p/first-principles"');
    expect(read(data({ view: null, hasFirstPrinciples: false }), { scope: "company" })).toContain("AI hasn&#x27;t reviewed the company yet");
  });

  it("says it hasn't run yet when it could", () => {
    expect(read(data({ view: null }))).toContain("AI hasn&#x27;t reviewed this version yet. It reviews each version when it is published");
  });

  it("says why it couldn't write a read, and keeps the insights it could", () => {
    expect(read(data({ view: view({ summary: [], reason: "the read was left out: it cited figures that aren't in the run" }) }))).toContain("AI couldn&#x27;t write a read that matched the run: the read was left out");
    expect(read(data({ view: view({ summary: [], status: "failed", reason: "the model declined to write it" }) }))).toContain("AI couldn&#x27;t review this version: the model declined to write it");
  });

  it("has no Run again for a viewer or an earlier version", () => {
    expect(read(data(), { mode: "readonly" })).not.toContain("Run again");
    expect(read(data(), { canRun: false })).not.toContain("Run again");
  });

  it("on the demo shows the written-in-advance read and a Run again that is never disabled", () => {
    const html = read(data({ view: demoAiView(NORTHBEAM_PROCESS_ID), versionNumber: 3 }), { mode: "demo" });
    expect(html).toContain("The Strategist is the constraint");
    expect(html).toContain("Run again");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Run again/);
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

  it("has a Run again for editors only", () => {
    expect(panel(data())).toContain("Run again");
    expect(panel(data(), "saa", { mode: "readonly" })).not.toContain("Run again");
  });
});

describe("Settings -> AI analysis", () => {
  const page = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(SidebarProvider, null, createElement(AiSettingsPage, { mode: "live", workspaceId: "w", initial: { ...DEFAULT_AI_SETTINGS }, configured: true, ...over })));

  it("has the five switches of the prototype, each with an (i)", () => {
    const html = page();
    expect(AI_SWITCHES.map((s) => s.label)).toEqual([
      "Review after each published version",
      "Review when market conditions change",
      "Suggest issues (they land in Suggestions)",
      "Suggest solution ideas using blocks from the library",
      "Read linked sources and quotes",
    ]);
    for (const s of AI_SWITCHES) {
      expect(html).toContain(s.label);
      expect(html).toContain(`About ${s.label}`);
      expect(html).toContain(`data-ai-switch="${s.key}"`);
    }
    expect((html.match(/role="switch"/g) ?? []).length).toBe(5);
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
