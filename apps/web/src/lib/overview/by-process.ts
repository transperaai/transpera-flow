// "Findings by process" on the Overview (issue #173, B15): the insights and tracked issues grouped by the process they
// sit in, each group with its rating, its top finding and its counts, and an "Across the company" group first for what
// sits in no single process (how busy roles and people are, client groups and churn, the forecast). Pure.
//
// A group's rating is the one the map, the process page and the Processes table give the process (decision D24): the worst
// of its confirmed open issues, never what a run only detected (`processRatings`). Insights not yet acknowledged show as
// "N new insights", and the top finding carries its own rating.

import { isActiveStatus, isVisibleIssue, type IssueRow, type ProcessPart, type SolutionRow } from "@transpera-flow/db";
import { compareRatingsDesc, ratingOfStored, type DetectedIssue, type Rating } from "@transpera-flow/engine";
import type { Insight } from "@/lib/insights/insights";
import { processRatings } from "@/lib/processes/rows";
import { worseOf } from "./health";

/** The id of the "Across the company" group. */
export const COMPANY_GROUP = "company";

/** Subjects of a finding's key (`<detector>:<subject kind>:<id>`) that are about the company, not one process. */
const COMPANY_SUBJECTS = new Set(["role", "person", "client", "group", "driver", "uncovered"]);

/**
 * Which process a finding belongs to, or `COMPANY_GROUP`. A finding about a role, a person, a client group, a churn
 * driver or the forecast is the company's, even when it shows on the step where the work is; one about a step is that
 * step's process; the cycle-time rule names its process; success measures are the company model's (the pipeline's)
 * first principles.
 */
export function groupOfFinding(
  finding: Pick<DetectedIssue, "key" | "stepId">,
  processOfStep: (stepId: string) => string | null | undefined,
  pipelineId: string,
): string {
  const [detector, subject, id] = finding.key.split(":");
  if (detector === "forecast" || (subject && COMPANY_SUBJECTS.has(subject))) return COMPANY_GROUP;
  if (detector === "cycle" && subject === "process") return !id || id === "pipeline" ? pipelineId : id;
  if (detector === "success") return pipelineId;
  return (finding.stepId && processOfStep(finding.stepId)) || COMPANY_GROUP;
}

/** Which group a tracked issue belongs to: its finding's, when it came from one; else the process it names or its first step's. */
export function groupOfIssue(
  issue: Pick<IssueRow, "detected_key" | "process_id" | "step_id" | "links">,
  processOfStep: (stepId: string) => string | null | undefined,
  pipelineId: string,
  processIds: ReadonlySet<string>,
): string {
  if (issue.detected_key) return groupOfFinding({ key: issue.detected_key, stepId: issue.step_id }, processOfStep, pipelineId);
  const named = [issue.process_id, ...issue.links.map((l) => l.process_id)].find((p): p is string => !!p && processIds.has(p));
  if (named) return named;
  const step = [issue.step_id, ...issue.links.map((l) => l.step_id)].find((s): s is string => !!s && !!processOfStep(s));
  return (step && processOfStep(step)) || COMPANY_GROUP;
}

export interface FindingGroup {
  /** A process id, or `COMPANY_GROUP`. */
  id: string;
  name: string;
  /**
   * The worst rating among its confirmed open issues (a Great one is not a problem), as the map and the Processes table
   * rate it; null ("Not rated") when it has none.
   */
  rating: Rating | null;
  /** Its insights, worst first (as the register sorts them). */
  insights: Insight[];
  /** Its tracked issues, every status (what the expanded list matches insights against). */
  issues: IssueRow[];
  /** Tracked issues still open or having a solution tested. */
  openIssues: number;
  /** Insights nobody has acknowledged yet. */
  newInsights: number;
  /** Solutions of this process not yet used to resolve an issue. */
  solutionsInProgress: number;
  /** What to read first: the top insight still open, else the worst open issue. */
  top: { title: string; rating: Rating } | null;
}

/** An insight that still asks for something: not acknowledged, or acknowledged as an issue that is still open. */
const isOpenInsight = (i: Insight) => !i.issue || isActiveStatus(i.issue.status);

/**
 * The groups: "Across the company" first (even when empty, so the tier always says where those go), then one per process
 * in the order given.
 */
export function findingsByProcess(input: {
  parts: readonly { process: Pick<ProcessPart["process"], "id" | "name" | "kind" | "parent_process_id">; steps: ProcessPart["steps"] }[];
  pipelineId: string;
  insights: readonly Insight[];
  issues: readonly IssueRow[];
  solutions: readonly Pick<SolutionRow, "id" | "process_id">[];
}): FindingGroup[] {
  const { parts, pipelineId, insights, issues, solutions } = input;
  const stepProcess = new Map(parts.flatMap((p) => p.steps.map((s) => [s.id, p.process.id] as const)));
  const processOfStep = (id: string) => stepProcess.get(id);
  const processIds = new Set(parts.map((p) => p.process.id));
  const implemented = new Set(issues.flatMap((i) => (i.status === "resolved" && i.resolved_solution_id ? [i.resolved_solution_id] : [])));

  const groups = new Map<string, FindingGroup>();
  const ratings = processRatings(
    parts.map((p) => ({ id: p.process.id, name: p.process.name, kind: p.process.kind, parentId: p.process.parent_process_id })),
    issues.filter(isVisibleIssue),
    parts.flatMap((p) => p.steps),
  );
  const empty = (id: string, name: string): FindingGroup => ({ id, name, rating: null, insights: [], issues: [], openIssues: 0, newInsights: 0, solutionsInProgress: 0, top: null });
  groups.set(COMPANY_GROUP, empty(COMPANY_GROUP, "Across the company"));
  for (const p of parts) groups.set(p.process.id, empty(p.process.id, p.process.name));
  const at = (id: string) => groups.get(id) ?? groups.get(COMPANY_GROUP)!;

  for (const insight of insights) at(groupOfFinding(insight.detection, processOfStep, pipelineId)).insights.push(insight);
  for (const issue of issues) {
    if (!isVisibleIssue(issue)) continue;
    at(groupOfIssue(issue, processOfStep, pipelineId, processIds)).issues.push(issue);
  }
  for (const s of solutions) {
    const g = groups.get(s.process_id);
    if (g && !implemented.has(s.id)) g.solutionsInProgress++;
  }

  for (const g of groups.values()) {
    const open = g.issues.filter((i) => isActiveStatus(i.status));
    g.openIssues = open.length;
    g.newInsights = g.insights.filter((i) => !i.issue).length;
    if (g.id === COMPANY_GROUP) {
      let rating: Rating | null = null;
      for (const i of open) if (ratingOfStored(i.severity) !== "great") rating = worseOf(rating, ratingOfStored(i.severity));
      g.rating = rating;
    } else g.rating = ratings[g.id] ?? null;
    const topInsight = g.insights.find(isOpenInsight);
    const topIssue = [...open].sort((a, b) => compareRatingsDesc(ratingOfStored(a.severity), ratingOfStored(b.severity)))[0];
    g.top = topInsight ? { title: topInsight.title, rating: topInsight.rating } : topIssue ? { title: topIssue.title, rating: ratingOfStored(topIssue.severity) } : null;
  }
  return [...groups.values()];
}
