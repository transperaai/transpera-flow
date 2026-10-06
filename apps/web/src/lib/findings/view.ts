// Findings as the pages show them (issue #175, B17; decision D40). Pure.
//
// The engine's rule results are FACTS: evidence, never findings. A FINDING is what AI or a person concludes from them.
// AI findings arrive proposed and wait in a review list for someone who can edit; findings by hand start accepted. Only
// accepted findings are listed on the process pages and the Overview, where the existing insight list shows them (with
// Acknowledge as issue, D24) under the key `finding:<origin>:<id>`.
//
// Insights acknowledged before B17 are tracked issues with a rule's or AI's key. They are kept as accepted findings: the
// list shows them, linked to their issue, with the live fact's cost when the run still finds it (D38).

import { findingKey, isVisibleIssue, readCitations, type FindingCitation, type FindingRow, type IssueRow } from "@transpera-flow/db";
import { noCost, ratingOfStored, type DetectedIssue, type IssueType } from "@transpera-flow/engine";
import type { Detection } from "@/lib/insights/insights";

/** A finding as a detection, which the insight list shows, acknowledges as an issue and highlights on the map. */
export function findingDetection(f: FindingRow): Detection {
  return {
    key: findingKey(f),
    type: f.type,
    rating: f.rating,
    escalation: { base: f.rating, badMonth: false, bottleneck: false },
    cost: noCost("A finding is a judgement, so it has no cost of its own; the facts it cites may."),
    title: f.title,
    evidence: f.evidence.trim() || f.title,
    metrics: {},
    stepId: f.step_id,
    roleId: null,
    personId: null,
    fix: null,
    origin: f.origin,
    why: f.why.trim() || undefined,
    findingId: f.id,
    findingProcessId: f.process_id,
    facts: readCitations(f.facts),
    ...(f.edited ? { edited: true } : {}),
    ...(f.proposed_via === "connector" ? { via: "connector" as const } : {}),
  };
}

/** An issue acknowledged from an insight before B17, as the detection it came from (its own words; no cost). */
export function legacyDetection(issue: IssueRow): Detection {
  const rating = ratingOfStored(issue.severity);
  return {
    key: issue.detected_key!,
    type: issue.type as IssueType,
    rating,
    escalation: { base: rating, badMonth: false, bottleneck: false },
    cost: noCost(""),
    title: issue.title,
    evidence: issue.evidence?.trim() || issue.title,
    metrics: {},
    stepId: issue.step_id ?? issue.links.find((l) => l.step_id)?.step_id ?? null,
    roleId: issue.role_id,
    personId: issue.person_id,
    fix: null,
    origin: issue.detected_key!.startsWith("ai:") ? "ai" : "rule",
  };
}

/** Where a finding sits: a process id, or null for across the company. */
export type FindingScope = string | null;

/**
 * What a page's finding list is made of: its accepted findings, and the issues acknowledged from findings or insights
 * (each as the live fact when the run still finds it, else in the issue's own words). `facts` are this run's facts (null
 * while the run isn't in): they are evidence and never listed themselves, but give a tracked issue its cost.
 */
export function pageDetections(input: { findings: readonly FindingRow[]; issues: readonly IssueRow[]; facts: readonly DetectedIssue[] | null }): Detection[] {
  const accepted = input.findings.filter((f) => f.status === "accepted").map(findingDetection);
  const keys = new Set(accepted.map((d) => d.key));
  const facts = new Map((input.facts ?? []).map((f) => [f.key, f]));
  const legacy: Detection[] = [];
  for (const i of input.issues) {
    const key = i.detected_key;
    if (!key || keys.has(key) || key.startsWith("finding:") || !isVisibleIssue(i)) continue;
    keys.add(key);
    legacy.push(facts.get(key) ?? legacyDetection(i));
  }
  return [...accepted, ...legacy];
}

/** Proposed AI findings waiting for review, newest analysis first. */
export const proposedFindings = (findings: readonly FindingRow[]): FindingRow[] =>
  findings.filter((f) => f.status === "proposed" && f.origin === "ai").sort((a, b) => b.created_at.localeCompare(a.created_at));

/** The findings of one process (and the processes inside it, by their steps or their own id), or across the company (`null`). */
export function findingsIn(findings: readonly FindingRow[], scope: { processIds: ReadonlySet<string> } | null): FindingRow[] {
  return findings.filter((f) => (scope ? f.process_id !== null && scope.processIds.has(f.process_id) : f.process_id === null));
}

/** The citations of a finding, facts first. */
export const citationsOf = (d: Pick<Detection, "facts">): FindingCitation[] => [...(d.facts ?? [])].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "fact" ? -1 : 1));
