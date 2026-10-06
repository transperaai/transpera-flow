// Drafting AI analysis and checking it (issue #111, A46; docs/adr/0013-ai-analysis.md): ask the model, check every
// number in every item against the run's figures (the narration check, docs/adr/0011-narration.md), drop the items
// that fail, and redraft once naming what failed. Pure apart from the injected model and clock, so tests run it with
// fakes and never call the API.
//
// Unlike narration there is no template to fall back to: an item that cites a figure the run doesn't have is left out,
// and the rest is kept. A draft with nothing left is a failure, with the reason in words.
//
// What is kept is saved as the model wrote it, with people as labels ("Team member A"), and `personLabels` says which
// person each label is. Names go back when the text is shown, to the readers who may see them (B1 2b, docs/adr/0013).

import { createHash } from "node:crypto";
import { labelsUsed, type PersonLabels } from "@transpera-flow/db";
import { NarrationError } from "@/lib/narration/narrate";
import { checkNumbers, type NumberProblem } from "@/lib/narration/numbers";
import { squeeze, type AiInput } from "./facts";
import { aiFactsMessage, aiInstruction, AI_OUTPUT_SCHEMA, AI_SYSTEM } from "./prompt";
import {
  AI_ISSUE_TYPES,
  AI_MAX_INSIGHTS,
  AI_MAX_PARAGRAPHS,
  AI_MAX_REVIEW,
  AI_RATINGS,
  AI_REVIEW_LEVELS,
  AI_REVIEW_STEPS,
  type AiInsight,
  type AiReviewFinding,
} from "./types";

export interface AiDraftRequest {
  system: string;
  /** The facts block (the cached prefix). */
  facts: string;
  instruction: string;
  /** The JSON schema the answer must follow. */
  schema: typeof AI_OUTPUT_SCHEMA;
  timeoutMs: number;
}

export interface AiDraft {
  /** The parsed JSON the model wrote (not yet trusted). */
  output: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number } | null;
}

/** A model that writes the analysis: Claude in production (narration/anthropic.ts), fakes in tests, canned text on /demo. */
export interface AiModel {
  readonly name: string;
  draft(request: AiDraftRequest): Promise<AiDraft>;
}

export const AI_ATTEMPT_MS = 60_000;
export const AI_BUDGET_MS = 110_000;

export interface AiOutcome {
  status: "ok" | "unavailable" | "failed";
  /** In words: why nothing was written, or what was left out. */
  reason: string | null;
  summary: string[];
  insights: AiInsight[];
  review: AiReviewFinding[];
  /** The labels the summary, insights, review and reason use, and the person each stands for (saved beside them, B1 2b). */
  personLabels: PersonLabels;
  /** Numbers in what was kept, each matched to a figure of the run. */
  checked: number;
  /** Items left out of the last draft for citing a figure that isn't in the run (or quoting words that aren't in a source). */
  dropped: number;
  /** The model that wrote it (or the last one tried). */
  model: string | null;
  /** Items thrown away, with what was wrong, for the record. */
  rejected: { where: string; text: string; problems: NumberProblem[] }[];
  usage: NonNullable<AiDraft["usage"]>[];
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, all: readonly T[]): T | null => (typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : null);

/** Words inside quotation marks that the model was given in a source: any other quotation is made up. */
export function quotationProblems(text: string, quotes: readonly string[]): NumberProblem[] {
  const out: NumberProblem[] = [];
  const squeezed = squeeze(text);
  // Double quotes, and single quotes (‘…’ and '…', made straight by `squeeze`) that open a word and close one, so an apostrophe never pairs up.
  const found = [...squeezed.matchAll(/"([^"]{8,})"/g), ...squeezed.matchAll(/(?<![\p{L}\p{N}])'([^']{8,}?)'(?![\p{L}\p{N}])/gu)];
  for (const m of found) {
    const said = m[1]!.trim().replace(/[.,!?;:]+$/, "");
    if (said.split(" ").length < 3) continue;
    if (!quotes.some((q) => q.includes(said))) out.push({ text: `“${said}”`, reason: "a quotation that isn't in the words it was given" });
  }
  return out;
}

/**
 * A title with each label ("Team member C") swapped for the person's id. Labels are numbered by position in the roster, so
 * they shift when someone is hired; the id doesn't, and holds no name. Longest label first ("Team member 27" before "Team member 2").
 */
export function personTokens(title: string, labels: Record<string, string>): string {
  let out = title;
  for (const label of Object.keys(labels).sort((a, b) => b.length - a.length || (a < b ? -1 : 1))) {
    out = out.replace(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu"), `person:${labels[label]}`);
  }
  return out;
}

const keyOf = (title: string, stepId: string | null) => `ai:insight:${createHash("sha1").update(`${squeeze(title)}|${stepId ?? ""}`).digest("hex").slice(0, 12)}`;

interface Screened {
  summary: { paragraphs: string[]; checked: number } | null;
  insights: { item: AiInsight; checked: number }[];
  review: { item: AiReviewFinding; checked: number }[];
  /** Items thrown away. */
  rejected: AiOutcome["rejected"];
  dropped: number;
  /** The read was missing or failed the check. */
  readFailed: boolean;
}

/** Shape and number-check one draft's output, item by item. */
export function screenOutput(output: unknown, input: AiInput): Screened {
  const o = output && typeof output === "object" && !Array.isArray(output) ? (output as Record<string, unknown>) : {};
  const rejected: AiOutcome["rejected"] = [];
  const check = (where: string, texts: string[]) => {
    const text = texts.join("\n");
    const numbers = checkNumbers(text, input.check);
    const quotes = quotationProblems(text, input.quotes);
    const problems = [...numbers.problems, ...quotes];
    if (problems.length) rejected.push({ where, text, problems });
    return { ok: problems.length === 0, checked: numbers.numbers.length };
  };
  // Text is kept as written, with labels, and so is the key an insight is stored under: it is hashed on the labelled title,
  // so it holds nothing a member could check a guessed name against (B1 2b). Findings keyed before then are re-keyed by
  // migration 20261207700000.

  // The read.
  const paragraphs = (Array.isArray(o.read) ? o.read.filter((p): p is string => typeof p === "string" && p.trim() !== "") : []).slice(0, AI_MAX_PARAGRAPHS).map((p) => p.trim().slice(0, 2000));
  let summary: Screened["summary"] = null;
  let readFailed = true;
  let dropped = 0;
  if (paragraphs.length) {
    const r = check("the read", paragraphs);
    if (r.ok) {
      summary = { paragraphs, checked: r.checked };
      readFailed = false;
    } else dropped++;
  }

  // The insights.
  const insights: Screened["insights"] = [];
  const seen = new Set<string>();
  const ids = new Set(input.steps.map((s) => s.id));
  for (const raw of Array.isArray(o.insights) ? o.insights : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type = oneOf(r.type, AI_ISSUE_TYPES);
    const rating = oneOf(r.rating, AI_RATINGS) ?? "good";
    const title = str(r.title, 120);
    const evidence = str(r.evidence, 600);
    const why = str(r.why, 600);
    if (!type || !title || !evidence) continue;
    const stepId = typeof r.stepId === "string" && ids.has(r.stepId) ? r.stepId : null;
    const res = check(`the insight “${title}”`, [title, evidence, why]);
    if (!res.ok) {
      dropped++;
      continue;
    }
    // The facts it rests on (B17): ids the model was given, mapped back to the engine's facts and the quotes. A finding
    // that cites no fact of the run, when the run has some, rests on nothing the engine measured: it is dropped.
    const cited = [...new Set(Array.isArray(r.facts) ? r.facts.filter((x): x is string => typeof x === "string") : [])];
    const facts = [
      ...input.facts.filter((f) => cited.includes(f.id)).map((f) => ({ kind: "fact" as const, key: f.key, text: f.text })),
      ...input.quoteRefs.filter((q) => cited.includes(q.id)).map((q) => ({ kind: "quote" as const, key: q.key, text: q.text })),
    ];
    if (input.facts.length && !facts.some((f) => f.kind === "fact")) {
      rejected.push({ where: `the insight “${title}”`, text: title, problems: [{ text: title, reason: "a finding that cites none of the facts it was given" } as NumberProblem] });
      dropped++;
      continue;
    }
    const key = keyOf(personTokens(title, input.personLabels), stepId);
    if (seen.has(key)) continue;
    seen.add(key);
    const personLabels = labelsUsed([title, evidence, why, ...facts.map((f) => f.text)], input.personLabels);
    insights.push({ item: { key, type, rating, title, evidence, why, stepId, facts, personLabels }, checked: res.checked });
  }

  // The first-principles review.
  const review: Screened["review"] = [];
  for (const raw of Array.isArray(o.review) ? o.review : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const step = oneOf(r.step, AI_REVIEW_STEPS);
    const level = oneOf(r.level, AI_REVIEW_LEVELS);
    const text = str(r.text, 600);
    if (!step || !level || !text) continue;
    const res = check(`the review of ${step}`, [text]);
    if (!res.ok) {
      dropped++;
      continue;
    }
    review.push({ item: { step, level, text }, checked: res.checked });
  }
  return { summary, insights, review, rejected, dropped, readFailed };
}

const listProblems = (rejected: AiOutcome["rejected"]) =>
  rejected
    .flatMap((r) => r.problems.map((p) => `“${p.text}” (${p.reason})`))
    .slice(0, 4)
    .join(", ");

/** Draft, check, redraft once, keep what passes. Never throws. */
export async function analyseWithAi(
  input: AiInput,
  model: AiModel | null,
  { budgetMs = AI_BUDGET_MS, attemptMs = AI_ATTEMPT_MS, now = () => Date.now() }: { budgetMs?: number; attemptMs?: number; now?: () => number } = {},
): Promise<AiOutcome> {
  const empty = (status: AiOutcome["status"], reason: string, extra: Partial<AiOutcome> = {}): AiOutcome => ({
    status,
    reason,
    summary: [],
    insights: [],
    review: [],
    personLabels: {},
    checked: 0,
    dropped: 0,
    model: model?.name ?? null,
    rejected: [],
    usage: [],
    ...extra,
  });
  if (!model) return empty("unavailable", "AI analysis isn't set up: this server has no Anthropic API key");

  const started = now();
  const usage: AiOutcome["usage"] = [];
  const rejectedAll: AiOutcome["rejected"] = [];
  let lastModel = model.name;
  let summary: string[] | null = null;
  let summaryChecked = 0;
  const insights = new Map<string, { item: AiInsight; checked: number }>();
  const review = new Map<string, { item: AiReviewFinding; checked: number }>();
  let dropped = 0;
  let last: Screened | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budgetMs - (now() - started);
    if (attempt > 0 && left < 5_000) break;
    let draft: AiDraft;
    try {
      draft = await model.draft({
        system: AI_SYSTEM,
        facts: aiFactsMessage(input.payload),
        instruction: aiInstruction(last ? { problems: last.rejected.flatMap((r) => r.problems.map((problem) => ({ where: r.where, problem }))) } : undefined),
        schema: AI_OUTPUT_SCHEMA,
        timeoutMs: Math.min(attemptMs, left),
      });
    } catch (err) {
      // A redraft that fails leaves the first draft's good items in place.
      if (attempt > 0) break;
      const e = err instanceof NarrationError ? err : new NarrationError("error", err instanceof Error ? err.message : String(err));
      const reason =
        e.kind === "refused"
          ? "the model declined to write it"
          : e.kind === "timeout"
            ? "the model didn't answer in time"
            : e.kind === "unavailable"
              ? e.message
              : `the model couldn't be reached (${e.message})`;
      return empty(e.kind === "unavailable" ? "unavailable" : "failed", reason, { usage });
    }
    lastModel = draft.model;
    if (draft.usage) usage.push(draft.usage);
    const screened = screenOutput(draft.output, input);
    rejectedAll.push(...screened.rejected);
    if (!summary && screened.summary) {
      summary = screened.summary.paragraphs;
      summaryChecked = screened.summary.checked;
    }
    for (const i of screened.insights) if (!insights.has(i.item.key)) insights.set(i.item.key, i);
    for (const r of screened.review) if (!review.has(r.item.text)) review.set(r.item.text, r);
    dropped = screened.dropped;
    last = screened;
    if (!screened.dropped && !screened.readFailed) break;
  }

  const keptInsights = [...insights.values()].slice(0, AI_MAX_INSIGHTS);
  const keptReview = [...review.values()].slice(0, AI_MAX_REVIEW);
  const checked = summaryChecked + keptInsights.reduce((n, i) => n + i.checked, 0) + keptReview.reduce((n, r) => n + r.checked, 0);
  const nothing = !summary && !keptInsights.length && !keptReview.length;
  const reason = nothing
    ? `every draft cited figures that aren't in the run${listProblems(rejectedAll) ? `: ${listProblems(rejectedAll)}` : ""}`
    : !summary
      ? `the read was left out: it cited figures that aren't in the run${listProblems(rejectedAll) ? ` (${listProblems(rejectedAll)})` : ""}`
      : null;
  const kept = keptInsights.map((i) => i.item);
  const texts = [...(summary ?? []), ...kept.flatMap((i) => [i.title, i.evidence, i.why, ...(i.facts ?? []).map((f) => f.text)]), ...keptReview.map((r) => r.item.text), reason ?? ""];
  return {
    status: nothing ? "failed" : "ok",
    reason,
    summary: summary ?? [],
    insights: kept,
    review: keptReview.map((r) => r.item),
    personLabels: labelsUsed(texts, input.personLabels),
    checked,
    dropped,
    model: lastModel,
    rejected: rejectedAll,
    usage,
  };
}
