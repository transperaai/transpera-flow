// What AI analysis stores and shows (issue #111, A46; docs/adr/0013-ai-analysis.md). Pure: no database, no model.
//
// An analysis belongs to one process version. It holds an "AI read" (paragraphs), AI insights (the same shape as a
// rule's finding, marked `origin: "ai"`, which the insight list already knows how to show, acknowledge and dismiss),
// and a review of the version's first principles. Everything in it passed the number check before it was stored.

import type { AiAnalysisRow, AiAnalysisStatus, AiAnalysisTrigger } from "@transpera-flow/db";
import { noCost, type FpFlagLevel, type FpStepKey, type IssueType, type Rating } from "@transpera-flow/engine";
import type { Detection } from "@/lib/insights/insights";
import { costOfUsage } from "./cost";

/** What the AI may file an insight under. Perception gaps and broken scenarios are the app's own. */
export const AI_ISSUE_TYPES = ["bottleneck", "spof", "manual", "delay", "failure", "idea", "capacity", "sla", "churn_risk"] as const satisfies readonly IssueType[];
/** The ratings the AI may suggest: a finding is never Great. */
export const AI_RATINGS = ["risk", "bad", "good"] as const satisfies readonly Rating[];
export const AI_REVIEW_LEVELS = ["bad", "warn", "ok", "info"] as const satisfies readonly FpFlagLevel[];
export const AI_REVIEW_STEPS = ["job", "truths", "reqs", "del", "saa", "why", "measures"] as const satisfies readonly FpStepKey[];

/** How much one analysis may hold; the database checks the same limits. */
export const AI_MAX_INSIGHTS = 8;
export const AI_MAX_REVIEW = 12;
export const AI_MAX_PARAGRAPHS = 3;

export interface AiInsight {
  /** `ai:insight:<hash>`: stable for the same title on the same step, so an acknowledged one stays matched across re-runs. */
  key: string;
  type: (typeof AI_ISSUE_TYPES)[number];
  /** The rating AI suggests (the insight's rating until someone changes the issue's). */
  rating: (typeof AI_RATINGS)[number];
  title: string;
  /** One or two sentences; the first carries the main number. */
  evidence: string;
  /** Why it matters, in AI's words (it ties the number to the process's first principles). */
  why: string;
  stepId: string | null;
  /** The facts (and quotes) it rests on, as they read when cited (B17). Empty on analyses from before. */
  facts?: { kind: "fact" | "quote"; key: string; text: string }[];
}

export interface AiReviewFinding {
  step: (typeof AI_REVIEW_STEPS)[number];
  level: (typeof AI_REVIEW_LEVELS)[number];
  text: string;
}

/** An analysis as the pages use it. */
export interface AiAnalysisView {
  status: AiAnalysisStatus;
  /** In words: why it didn't run, or why it came back without a read. */
  reason: string | null;
  trigger: AiAnalysisTrigger;
  summary: string[];
  insights: AiInsight[];
  review: AiReviewFinding[];
  /** Numbers in what was kept, each matched to a figure of the run. */
  checked: number;
  /** Items dropped because they cited a figure that isn't in the run. */
  dropped: number;
  model: string | null;
  /** When it was written (ISO). */
  at: string;
  /** The version it is of. */
  revisionId: string;
  /** Who ran it (the name recorded when the run was reserved), if known. AI wrote the text; this person started it. */
  runBy?: string | null;
  /** The stored row's id (what its proposed findings cite). */
  id?: string;
  /** The hash of the model it read (B17); null on analyses from before. */
  modelHash?: string | null;
  /** Roughly what the model calls cost, in US dollars; null when it can't be priced. */
  costUsd?: number | null;
}

export type AiMode = "live" | "readonly" | "demo";

/** What a page needs to show AI for the version on screen. */
export interface AiPanelData {
  /** What was stored for the version on screen; null when there is nothing yet. */
  view: AiAnalysisView | null;
  /** Whether the server has an API key. */
  configured: boolean;
  /** Whether the version has first principles to review (the review judges the process against them). */
  hasFirstPrinciples: boolean;
  /** The version the analysis is of (null when unknown). */
  versionNumber: number | null;
  /** True when the model has changed since `view` was written (B17): it is kept, marked out of date, until someone analyses again. */
  stale?: boolean;
}

/** The text shown when the server has no API key (and elsewhere that AI can't run). */
export const AI_NOT_SET_UP = "AI analysis isn't set up";

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, all: readonly T[]): T | null => (typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : null);
const objects = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);

/** Stored insights, read forgivingly: anything that isn't the right shape is left out. */
export function readInsights(json: unknown): AiInsight[] {
  const out: AiInsight[] = [];
  for (const o of objects(json)) {
    const type = oneOf(o.type, AI_ISSUE_TYPES);
    const rating = oneOf(o.rating, AI_RATINGS);
    const key = str(o.key, 200);
    const title = str(o.title, 200);
    if (!type || !rating || !title || !/^ai:insight:[^\s]{1,150}$/.test(key)) continue;
    const facts = objects(o.facts).flatMap((f) => {
      const kind: "fact" | "quote" | null = f.kind === "quote" ? "quote" : f.kind === "fact" ? "fact" : null;
      const text = str(f.text, 1000);
      return kind && text ? [{ kind, key: str(f.key, 300), text }] : [];
    });
    out.push({ key, type, rating, title, evidence: str(o.evidence, 1000), why: str(o.why, 1000), stepId: str(o.stepId, 100) || null, ...(facts.length ? { facts } : {}) });
  }
  return out.slice(0, AI_MAX_INSIGHTS);
}

export function readReview(json: unknown): AiReviewFinding[] {
  const out: AiReviewFinding[] = [];
  for (const o of objects(json)) {
    const step = oneOf(o.step, AI_REVIEW_STEPS);
    const level = oneOf(o.level, AI_REVIEW_LEVELS);
    const text = str(o.text, 1000);
    if (step && level && text) out.push({ step, level, text });
  }
  return out.slice(0, AI_MAX_REVIEW);
}

export function readSummary(json: unknown): string[] {
  return (Array.isArray(json) ? json.filter((p): p is string => typeof p === "string" && p.trim() !== "") : []).map((p) => p.trim().slice(0, 2000)).slice(0, AI_MAX_PARAGRAPHS);
}

/** A stored row as the pages use it. */
export function aiViewFromRow(row: AiAnalysisRow & { run_by?: string | null }): AiAnalysisView {
  return {
    status: row.status,
    reason: row.reason,
    trigger: row.trigger,
    summary: readSummary(row.summary),
    insights: readInsights(row.insights),
    review: readReview(row.review),
    checked: row.checked,
    dropped: row.dropped,
    model: row.model,
    at: row.updated_at,
    revisionId: row.revision_id,
    runBy: row.run_by ?? null,
    id: row.id,
    modelHash: row.model_hash ?? null,
    costUsd: costOfUsage(row.model, row.usage),
  };
}

/**
 * AI insights as detections, which the insight list shows with the "AI" mark and acknowledges and dismisses like any
 * other. AI computes no cost (every figure comes from the run, and the cost methods are the engine's), so the cost
 * reads "n/a". `steps` are the process's step ids: an insight on a step that isn't there any more is kept, without the step.
 */
export function aiDetections(insights: readonly AiInsight[], stepIds?: ReadonlySet<string>): Detection[] {
  return insights.map(
    (i): Detection => ({
      key: i.key,
      type: i.type,
      rating: i.rating,
      escalation: { base: i.rating, badMonth: false, bottleneck: false },
      cost: noCost("AI doesn't estimate a cost."),
      title: i.title,
      evidence: i.evidence,
      metrics: {},
      stepId: i.stepId && (!stepIds || stepIds.has(i.stepId)) ? i.stepId : null,
      roleId: null,
      personId: null,
      fix: null,
      origin: "ai",
      why: i.why || undefined,
    }),
  );
}
