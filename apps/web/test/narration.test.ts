import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunResults } from "@transpera-flow/db";
import { editCheck, restoreNames, runNarrationInput } from "@/lib/narration/facts";
import { demoExplanation, demoNarrator } from "@/lib/narration/demo";
import { checkText, narrate, NarrationError, type DraftRequest, type NarrationModel } from "@/lib/narration/narrate";

vi.mock("server-only", () => ({}));

// Narration (issue #29; docs/PRD.md §7.3, D15): drafts checked number by
// number, one redraft naming the failures, the template as the fallback with
// the reason, and names kept from the model. Every model here is a deterministic fake:
// tests never call the Anthropic API.

const START = "2026-09-30";

function runResults(): RunResults {
  return {
    horizon_weeks: 13,
    hours_per_week: 40,
    currency: "GBP",
    reps: 30,
    won: { mean: 8.6, p10: 6, p90: 12 },
    lost: { mean: 78.25, p10: 70, p90: 91 },
    cycle: { mean: 225, p50: 220, p90: 304 },
    mrr_added: { mean: 33005, p10: 22400, p90: 45500 },
    billed: { mean: 349352.6, p10: 333536, p90: 371455 },
    overtime_hours: { mean: 0, p10: 0, p90: 0 },
    bottleneck: { role: "Strategist", util: { mean: 0.965, p10: 0.867, p90: 1.013 } },
  } as RunResults;
}

const run = runNarrationInput({ id: "r", name: "Audit baseline", created_at: `${START}T09:00:00Z`, results: runResults() }, "Lead to live");

/** A fake model: returns the scripted drafts in turn (a function of the request), recording each request. */
function fake(...drafts: ((req: DraftRequest) => string[] | Error)[]): NarrationModel & { calls: DraftRequest[] } {
  const calls: DraftRequest[] = [];
  return {
    name: "fake-model",
    calls,
    async draft(req) {
      calls.push(req);
      const next = drafts[Math.min(calls.length - 1, drafts.length - 1)]!(req);
      if (next instanceof Error) throw next;
      return { paragraphs: next, model: "fake-model", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: calls.length > 1 ? 90 : 0 } };
    },
  };
}

const factsOf = (req: DraftRequest) => JSON.parse(req.facts.slice(req.facts.indexOf("{"))) as Record<string, unknown>;
const templateFrom = (req: DraftRequest) => factsOf(req).templatedExplanation as string[];

describe("what the model is sent", () => {
  it("sends the run's figures in the average-plus-range form, and no workspace or evidence", () => {
    const sent = JSON.stringify(run.payload);
    expect(sent).toMatch(/avg £[\d,]+ \(range £[\d,]+–£[\d,]+\)/);
    expect(sent).not.toContain("austin");
    expect(run.purpose).toBe("explain");
  });

  it("the templated text passes its own check, so the fallback is always printable", () => {
    expect(checkText(run.payload.templatedExplanation as string[], run.check).problems).toEqual([]);
    expect(checkText(run.template, run.check).problems).toEqual([]);
    expect(checkText(run.template, editCheck(run)).problems).toEqual([]);
  });

  it("the cache key follows the facts: same run, same hash; other figures, another", () => {
    const again = runNarrationInput({ id: "other", name: "Audit baseline", created_at: "2030-01-01T00:00:00Z", results: { ...runResults(), reps: 30 } }, "Lead to live");
    expect(again.hash).toBe(run.hash);
    expect(runNarrationInput({ id: "r", name: "Audit baseline", created_at: START, results: { ...runResults(), reps: 40 } }, "Lead to live").hash).not.toBe(run.hash);
  });

  it("holds no person's name and so aliases no one: a narration's saved text has nothing to put names back into (B1 2b)", () => {
    expect(run.aliases).toEqual([]);
    expect(JSON.stringify(run.payload)).not.toMatch(/Team member/);
  });

  it("maps labels back to names without touching other words", () => {
    const aliases = [
      { name: "Sam", label: "Team member A" },
      { name: "Northgate Motors", label: "Client B" },
    ];
    expect(restoreNames("Team member A helps Client B; Client BC is another.", aliases)).toBe("Sam helps Northgate Motors; Client BC is another.");
  });
});

describe("drafting and checking (fake models)", () => {
  it("accepts a draft whose every figure is in the facts", async () => {
    const model = fake((req) => templateFrom(req));
    const input = run;
    const out = await narrate(input, model);
    expect(out).toMatchObject({ source: "narration", validated: true, fallback: false, reason: null, model: "fake-model", rejected: [] });
    expect(out.checked).toBeGreaterThan(5);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.system).toMatch(/average with its range/);
  });

  it("rejects an invented figure, redrafts once naming it, and accepts the redraft", async () => {
    const model = fake(
      (req) => [...templateFrom(req), "Hiring saves £50k a year and doubles wins."],
      (req) => templateFrom(req),
    );
    const out = await narrate(run, model);
    expect(out.source).toBe("narration");
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.problems.map((p) => p.text)).toEqual(["doubles", "£50k"]);
    expect(model.calls[1]!.instruction).toContain("“£50k”");
    expect(model.calls[1]!.instruction).toContain("“doubles”");
    // The redraft reuses the same facts block (the cached prefix).
    expect(model.calls[1]!.facts).toBe(model.calls[0]!.facts);
    expect(out.usage).toHaveLength(2);
  });

  it("falls back to the template after two failed drafts, saying which figures failed", async () => {
    const model = fake(() => ["Wins rise to 14.2 a quarter."]);
    const input = run;
    const out = await narrate(input, model);
    expect(out).toMatchObject({ source: "template", validated: false, fallback: true, fallbackKind: "invalid", paragraphs: input.template });
    expect(out.reason).toContain("“14.2”");
    expect(out.rejected).toHaveLength(2);
    expect(model.calls).toHaveLength(2);
  });

  it("falls back on refusals, timeouts, API errors, bad shapes and a missing key", async () => {
    const input = run;
    expect((await narrate(input, fake(() => new NarrationError("refused", "declined")))).fallbackKind).toBe("refused");
    expect((await narrate(input, fake(() => new NarrationError("timeout", "timed out")))).reason).toBe("the model didn't answer in time");
    const err = await narrate(input, fake(() => new Error("socket hang up")));
    expect(err).toMatchObject({ fallbackKind: "error", source: "template" });
    expect(err.reason).toContain("socket hang up");
    expect((await narrate(input, fake(() => []))).fallbackKind).toBe("invalid");
    expect((await narrate(input, fake(() => Array.from({ length: 12 }, () => "Wins avg 8.6.")))).rejected[0]!.problems[0]!.reason).toMatch(/more than 8/);
    const none = await narrate(input, null);
    expect(none).toMatchObject({ fallbackKind: "unavailable", source: "template" });
    expect(none.reason).toMatch(/API key/);
  });

  it("stays within the time budget: no redraft when the first draft used it up", async () => {
    let t = 0;
    const model = fake((req) => {
      t += 72_000;
      return [...templateFrom(req), "It saves £50k."];
    });
    const out = await narrate(run, model, { now: () => t });
    expect(out).toMatchObject({ fallbackKind: "timeout", source: "template" });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.timeoutMs).toBe(45_000);
  });
});

describe("the demo", () => {
  it("explains a run with the stand-in (never the API), checked like Claude", async () => {
    const out = await demoExplanation({ id: "r", name: "Audit baseline", created_at: `${START}T09:00:00Z`, results: runResults() }, "Lead to live", `${START}T10:00:00Z`);
    expect(out).toMatchObject({ source: "narration", validated: true, model: demoNarrator.name, editedBy: null });
    expect(out.paragraphs.join(" ")).toContain("busiest role");
  });
});

describe("the API key stays on the server", () => {
  const src = join(__dirname, "../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

  it("only server code reads ANTHROPIC_API_KEY or imports the SDK, and the client module is server-only", () => {
    const all = files(src).filter((f) => /\.tsx?$/.test(f));
    const readers = all.filter((f) => /process\.env\.ANTHROPIC_API_KEY|@anthropic-ai\/sdk/.test(readFileSync(f, "utf8")));
    expect(readers.map((f) => f.slice(src.length))).toEqual(["/lib/narration/anthropic.ts"]);
    expect(readFileSync(join(src, "lib/narration/anthropic.ts"), "utf8")).toMatch(/^import "server-only";/);
    const clientFiles = all.filter((f) => /^["']use client["']/.test(readFileSync(f, "utf8")));
    for (const f of clientFiles) expect(readFileSync(f, "utf8"), f).not.toMatch(/narration\/(anthropic|service|explain)/);
  });
});
