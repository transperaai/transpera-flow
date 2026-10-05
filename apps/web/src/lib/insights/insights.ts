// Insights v2 (issue #110, A45): what the latest run found, as rated rows. An insight is a detection the team has not
// acted on; once acknowledged it is a tracked issue and the row says "Issue #N". Pure: the components render the
// results, and nothing here touches the map (D24: only acknowledged issues reach it).

import type { FindingCitation, IssueRow } from "@transpera-flow/db";
import { compareCostsDesc, compareRatingsDesc, noCost, ruleOfFinding, type DetectedIssue, type IssueCost, type IssueType, type Rating } from "@transpera-flow/engine";
import { RULES_UI } from "@/lib/rules/catalogue";
import { TYPE_LABELS, type RegisterEntry } from "@/lib/issues/register";

/**
 * What produced an insight: one of the analysis rules (only insights acknowledged before B17: rules now give facts, not
 * findings), AI (A46), or a person who added it by hand (B17).
 */
export type InsightSource = { kind: "rule"; name: string; ruleId: string | null } | { kind: "ai"; name: "AI" | "AI, edited"; edited?: boolean } | { kind: "manual"; name: "By hand" };

/**
 * A detection that may carry its origin. A rule's has none; the AI's (A46) is `origin: "ai"`, with its own "why it
 * matters"; a finding (B17) also carries its id, where it sits (`findingProcessId`, null across the company) and the facts
 * it rests on.
 */
export type Detection = DetectedIssue & {
  origin?: "rule" | "ai" | "manual";
  why?: string;
  findingId?: string;
  findingProcessId?: string | null;
  facts?: FindingCitation[];
  /** An AI finding someone has changed since AI wrote it. */
  edited?: boolean;
};

export interface Insight {
  key: string;
  title: string;
  rating: Rating;
  type: IssueType;
  cost: IssueCost;
  /** The number behind it, as a short phrase ("Strategist is busy 92% of the time"). */
  number: string;
  /** What we found beyond the number: the rest of the evidence, empty when the number says it all. */
  found: string;
  /** Why it matters, in plain words. */
  why: string;
  /** The steps it touches (today one; the field is a list so a finding on several steps can say so). */
  stepIds: string[];
  source: InsightSource;
  detection: Detection;
  /** The tracked issue it became, if acknowledged. */
  issue: IssueRow | null;
  /** The row of an earlier dismissal that has expired (the process was published again): acknowledging or dismissing reuses it. */
  dismissed: IssueRow | null;
}

/** Why a finding of each type matters, in plain words (the detection itself carries the numbers). */
export const WHY_IT_MATTERS: Record<IssueType, string> = {
  bottleneck: "Work queues up here, so everything after it waits and the whole process slows down.",
  spof: "If this one person or role is away, the work stops. Clients feel it first.",
  manual: "Work done by hand costs time every time it runs and is easy to get wrong.",
  delay: "Waiting adds days to the process without adding value, and clients notice slow answers.",
  failure: "Work done twice costs the time of both rounds and can reach clients wrong.",
  idea: "A change worth testing: it could remove work or time from the process.",
  capacity: "Someone who is too busy has no room for a bad month or a new client, and quality slips first.",
  sla: "Missed deadlines break promises to clients and put the relationship at risk.",
  churn_risk: "A client who is unhappy may leave, and their monthly fee goes with them.",
  perception_gap: "What people say happens and what the simulation shows disagree, so one of them is wrong.",
  broken_scenario: "A saved scenario no longer matches the process, so its result can't be trusted until it is fixed.",
};

/** The evidence after its first sentence: what "What we found" adds to the number. Empty when there is nothing more. */
export function rest(evidence: string): string {
  return evidence.slice(headline(evidence).length).trim();
}

/** The first sentence of a finding's evidence, which carries its main number. */
export function headline(evidence: string): string {
  const end = evidence.search(/[.!?](\s|$)/);
  return end === -1 ? evidence : evidence.slice(0, end + 1);
}

export function sourceOf(d: Detection): InsightSource {
  if (d.origin === "ai") return d.edited ? { kind: "ai", name: "AI, edited", edited: true } : { kind: "ai", name: "AI" };
  if (d.origin === "manual") return { kind: "manual", name: "By hand" };
  const id = ruleOfFinding(d);
  return { kind: "rule", ruleId: id, name: id ? RULES_UI[id].name : TYPE_LABELS[d.type] };
}

/**
 * The insights in a list of register entries: each detection of the latest run, as it stands (not acknowledged yet)
 * or as the issue it became. A dismissed one is left out. Worst rating first, then dearest, then as found.
 */
export function buildInsights(entries: readonly RegisterEntry[]): Insight[] {
  const out: Insight[] = [];
  for (const e of entries) {
    const d = e.detection as Detection | null;
    if (!d) continue;
    if (e.kind === "tracked" && (!e.issue.detected_key || e.issue.status === "dismissed")) continue;
    const issue = e.kind === "tracked" ? e.issue : null;
    out.push({
      key: d.key,
      title: d.title,
      rating: d.rating,
      type: d.type,
      cost: d.cost,
      number: headline(d.evidence),
      found: rest(d.evidence),
      why: d.why ?? WHY_IT_MATTERS[d.type],
      stepIds: d.stepId ? [d.stepId] : [],
      source: sourceOf(d),
      detection: d,
      issue,
      dismissed: e.kind === "detected" ? (e.dismissed ?? null) : null,
    });
  }
  const none = noCost("");
  return out
    .map((x, n) => ({ x, n }))
    .sort((a, b) => compareRatingsDesc(a.x.rating, b.x.rating) || compareCostsDesc(a.x.cost ?? none, b.x.cost ?? none) || a.n - b.n)
    .map(({ x }) => x);
}

/** Ratings the filter chips show, worst first. Findings are never Great, so that chip only appears if something is. */
export function ratingCountsOf(insights: readonly Insight[]): { rating: Rating; count: number }[] {
  const order: Rating[] = ["risk", "bad", "good", "great"];
  return order.map((rating) => ({ rating, count: insights.filter((i) => i.rating === rating).length })).filter((c) => c.rating !== "great" || c.count > 0);
}

export const filterByRating = (insights: readonly Insight[], rating: Rating | ""): Insight[] => (rating ? insights.filter((i) => i.rating === rating) : [...insights]);

/**
 * The first `n` insights for a short list (the Overview shows five). AI insights have no cost, so they sort after the
 * costed rule findings of their rating and could all fall below the cut; if any exists and none is in the first `n`, the
 * top AI insight takes the last place, so the AI's view is never hidden behind "Show all".
 */
export function limitInsights(insights: readonly Insight[], n: number): Insight[] {
  const head = insights.slice(0, n);
  if (head.length < n || head.some((i) => i.source.kind === "ai")) return head;
  const ai = insights.slice(n).find((i) => i.source.kind === "ai");
  return ai ? [...head.slice(0, n - 1), ai] : head;
}
