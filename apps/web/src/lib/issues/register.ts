// The issues register in the browser (issue #17): tracked issues from the
// database merged with the issues the latest run detected, filters, the fix
// each one links to, and the badges on the map. Pure functions; the
// components render the results.

import { isActiveStatus, isDismissalCurrent, isVisibleIssue, type IssueRow, type IssueSource, type IssueStatus, type ScenarioRow } from "@transpera-flow/db";
import {
  RATINGS,
  compareCostsDesc,
  RATING_LABELS,
  ratingRank,
  compareRatingsDesc,
  noCost,
  ratingOfStored,
  storedOfRating,
  type DetectedIssue,
  type IssueCost,
  type IssueType,
  type Rating,
  type ScenarioPatch,
} from "@transpera-flow/engine";
import { formatNumber, formatWholeCurrency } from "@/lib/format";
import type { PromoteInput } from "./validate";

export type RegisterEntry =
  /** A stored issue; `detection` is what the latest run detected for its key, if it still does. */
  | { kind: "tracked"; issue: IssueRow; detection: DetectedIssue | null }
  /**
   * Detected by the latest run and not tracked yet: read-only, regenerated each run. `dismissed` is the row of an
   * earlier dismissal that has expired (the process has a newer published version), so the insight is listed again;
   * acknowledging or dismissing it again reuses that row.
   */
  | { kind: "detected"; detection: DetectedIssue; dismissed?: IssueRow };

export const TYPE_LABELS: Record<IssueType, string> = {
  bottleneck: "Bottleneck",
  spof: "Single point of failure",
  manual: "Manual work",
  delay: "Delay",
  failure: "Failure / rework",
  idea: "Idea",
  capacity: "Capacity",
  sla: "SLA",
  churn_risk: "Churn risk",
  perception_gap: "Perception gap",
  broken_scenario: "Broken scenario",
};

export const STATUS_LABELS: Record<IssueStatus, string> = {
  open: "Open",
  testing: "Testing solutions",
  resolved: "Resolved",
  wont_fix: "Won't fix",
  // Not an issue a person sees: a dismissed insight. The register and the map never list it.
  dismissed: "Dismissed",
};

/** "Issue #12": the stable number the issue carries in its workspace, as the insight's link and the issue pages show it. */
export const issueLabel = (issue: Pick<IssueRow, "number">): string => (issue.number == null ? "Issue" : `Issue #${issue.number}`);

/** The four ratings, most severe first: the order the register, filters and reports list them in. */
export const RATINGS_WORST_FIRST: readonly Rating[] = [...RATINGS].reverse();

export const SOURCE_LABELS: Record<IssueSource, string> = {
  manual: "Audit finding",
  detected: "Detected",
  promoted: "Tracked detection",
};

const NO_COST = noCost("");

/**
 * An issue's cost per month, as the screens print it: always an estimate, in
 * the workspace currency. No money method shows time, or "n/a".
 */
export function formatIssueCost(cost: IssueCost | null, currency: string): string {
  // Depends on people's pay, which this viewer may not see (the screens add an (i); see PayHidden).
  if (cost?.payHidden) return "—";
  if (cost?.perMonth != null) return `About ${formatWholeCurrency(cost.perMonth, currency)} a month (estimate)`;
  if (cost?.hoursPerMonth != null) return `About ${formatNumber(cost.hoursPerMonth, cost.hoursPerMonth < 10 ? 1 : 0)} h a month (estimate, time only)`;
  return "Cost per month: n/a";
}

const isOpen = isActiveStatus;

/** The process a dismissed row sits on: its process, else the first one it links. */
export const dismissalProcess = (i: Pick<IssueRow, "process_id" | "links">): string | null => i.process_id ?? i.links.find((l) => l.process_id)?.process_id ?? null;

/** An entry's shared fields, whichever kind it is. */
export function entryView(e: RegisterEntry) {
  if (e.kind === "detected") {
    const d = e.detection;
    return {
      id: d.key,
      title: d.title,
      evidence: d.evidence,
      type: d.type,
      rating: d.rating,
      source: "detected" as IssueSource,
      cost: d.cost as IssueCost | null,
      status: null,
      stepId: d.stepId,
      stepIds: d.stepId ? [d.stepId] : ([] as string[]),
      personId: d.personId,
      processId: null as string | null,
      processIds: [] as string[],
      open: true,
    };
  }
  const i = e.issue;
  // Everything it touches: the steps it links to, else the one the compatibility column names.
  const linkedSteps = i.links.flatMap((l) => (l.step_id ? [l.step_id] : []));
  const stepIds = linkedSteps.length ? linkedSteps : i.step_id ? [i.step_id] : [];
  const processIds = [...new Set([...i.links.flatMap((l) => (l.process_id ? [l.process_id] : [])), ...(i.process_id ? [i.process_id] : [])])];
  return {
    id: i.id,
    title: i.title,
    evidence: i.evidence,
    type: i.type,
    // Stored issues keep the database's four values; they stand for the four ratings one to one.
    rating: ratingOfStored(i.severity),
    source: i.source,
    // A tracked issue is costed by what the latest run detects for it.
    cost: (e.detection?.cost ?? null) as IssueCost | null,
    status: i.status,
    stepId: stepIds[0] ?? null,
    stepIds,
    personId: i.person_id,
    processId: i.process_id,
    processIds,
    // A resolved issue (or won't fix) stays off the map and out of the open list, however it was resolved and even if the
    // analysis detects the problem again (D38): the detection shows as an insight linking to it, and a person reopens it.
    open: isOpen(i.status),
  };
}

/**
 * Tracked issues and this run's detections in one list. A detection whose key
 * a tracked issue carries shows once, as that tracked issue. Open issues come
 * first, most severe first; closed ones last, most recently changed first.
 */
export function registerEntries(
  tracked: readonly IssueRow[],
  detected: readonly DetectedIssue[],
  /** A process's live revision id. With it, a dismissal ends when its process is published again. */
  revisionOf?: (processId: string | null | undefined) => string | undefined,
): RegisterEntry[] {
  const byKey = new Map(detected.map((d) => [d.key, d]));
  // A dismissed insight is kept as a row so it doesn't come back, but it is never an issue: while the dismissal lasts
  // it holds its key (so the detection isn't listed again) and nothing else, which keeps it out of the register, the
  // counts and the map. Once its process has a newer published version the dismissal has expired: the row steps aside
  // and the detection, if the run still finds it, is listed as an insight again.
  const expired = new Map<string, IssueRow>();
  const live: IssueRow[] = [];
  for (const i of tracked) {
    if (i.status === "dismissed" && i.detected_key && !isDismissalCurrent(i, revisionOf?.(dismissalProcess(i)))) expired.set(i.detected_key, i);
    else live.push(i);
  }
  const trackedKeys = new Set(live.flatMap((i) => (i.detected_key ? [i.detected_key] : [])));
  const entries: RegisterEntry[] = [
    ...live.filter(isVisibleIssue).map((issue): RegisterEntry => ({ kind: "tracked", issue, detection: issue.detected_key ? (byKey.get(issue.detected_key) ?? null) : null })),
    ...detected.filter((d) => !trackedKeys.has(d.key)).map((detection): RegisterEntry => ({ kind: "detected", detection, ...(expired.has(detection.key) ? { dismissed: expired.get(detection.key)! } : {}) })),
  ];
  const updated = (e: RegisterEntry) => (e.kind === "tracked" ? e.issue.updated_at : "");
  // Stable sort: equal entries keep tracked-then-detected, each in its own order.
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const oa = entryView(a.e).open;
      const ob = entryView(b.e).open;
      if (oa !== ob) return oa ? -1 : 1;
      if (!oa) return updated(b.e).localeCompare(updated(a.e)) || a.i - b.i;
      const va = entryView(a.e);
      const vb = entryView(b.e);
      // Most severe first, then costliest first (issue #108); no cost sorts last.
      return compareRatingsDesc(va.rating, vb.rating) || compareCostsDesc(va.cost ?? NO_COST, vb.cost ?? NO_COST) || a.i - b.i;
    })
    .map(({ e }) => e);
}

/**
 * What belongs to one process on its page: an entry on a step keeps only if the step is one of `stepIds` (the
 * process's own and those inside it); one on no step keeps if it is this process's (a detection is, by the run it came from).
 */
export function entriesInProcess(entries: readonly RegisterEntry[], processId: string, stepIds: ReadonlySet<string>): RegisterEntry[] {
  return entries.filter((e) => {
    const v = entryView(e);
    // On a step of this process; or on none in particular: a detection is this process's, an issue is if it links it whole.
    return v.stepIds.length ? v.stepIds.some((id) => stepIds.has(id)) : e.kind === "detected" || v.processIds.includes(processId);
  });
}

export interface IssueFilters {
  /** A process id; detected issues belong to the process that was run. */
  process: string;
  /** A person id: the issue is about them or they own it. */
  person: string;
  rating: Rating | "";
  source: IssueSource | "";
  /** "active": open, testing solutions, or detected; "" for everything. */
  status: IssueStatus | "active" | "";
  /** A step id, e.g. from clicking a badge on the map. */
  step: string;
}

export const NO_FILTERS: IssueFilters = { process: "", person: "", rating: "", source: "", status: "active", step: "" };

/** The entries that pass every filter. `processId` is the process the detections came from. */
export function filterEntries(entries: readonly RegisterEntry[], f: IssueFilters, processId: string | null): RegisterEntry[] {
  return entries.filter((e) => {
    const v = entryView(e);
    if (f.process && !(e.kind === "detected" ? processId === f.process : v.processIds.includes(f.process))) return false;
    if (f.person && v.personId !== f.person && !(e.kind === "tracked" && (e.issue.owner_person_id === f.person || e.issue.owner_ids.includes(f.person)))) return false;
    if (f.rating && v.rating !== f.rating) return false;
    if (f.source && v.source !== f.source) return false;
    if (f.status === "active" && !v.open) return false;
    if (f.status && f.status !== "active" && v.status !== f.status) return false;
    if (f.step && !v.stepIds.includes(f.step)) return false;
    return true;
  });
}

/** A fix an issue links to: a saved scenario, or a detection's suggested patches. */
export interface IssueFix {
  name: string;
  /** A saved scenario; null for a detection's suggestion. */
  scenarioId: string | null;
  patch: ScenarioPatch[];
}

/**
 * The fix an entry links to: its saved scenario if it has one that still
 * exists, otherwise the suggestion of its current detection, otherwise none.
 */
export function fixFor(e: RegisterEntry, scenarios: readonly ScenarioRow[]): IssueFix | null {
  if (e.kind === "tracked" && e.issue.scenario_id) {
    const s = scenarios.find((x) => x.id === e.issue.scenario_id);
    if (s) return { name: s.name, scenarioId: s.id, patch: s.patch };
  }
  const fix = e.detection?.fix;
  if (!fix) return null;
  const saved = matchingScenario(fix.patch, scenarios);
  return saved ? { name: saved.name, scenarioId: saved.id, patch: saved.patch } : { name: fix.name, scenarioId: null, patch: fix.patch };
}

/** A saved scenario with exactly these patches, if there is one ("Hire a strategist" for a hire fix). */
export function matchingScenario(patch: readonly ScenarioPatch[], scenarios: readonly ScenarioRow[]): ScenarioRow | null {
  const key = (p: readonly ScenarioPatch[]) => JSON.stringify(p.map(({ path, op, value }) => [path, op, value]));
  const k = key(patch);
  return scenarios.find((s) => key(s.patch) === k) ?? null;
}

/** What promoting a detection stores: its fields, its key, and its fix if a saved scenario matches it. */
export function promoteInput(d: DetectedIssue, processId: string | null, scenarios: readonly ScenarioRow[]): PromoteInput {
  return {
    detected_key: d.key,
    type: d.type,
    severity: storedOfRating(d.rating),
    title: d.title,
    evidence: d.evidence,
    evidence_metrics: d.metrics,
    process_id: processId,
    step_id: d.stepId,
    role_id: d.roleId,
    person_id: d.personId,
    owner_person_id: null,
    // A broken-scenario issue links the scenario it is about (issue #16).
    scenario_id: d.scenarioId ?? (d.fix ? (matchingScenario(d.fix.patch, scenarios)?.id ?? null) : null),
    // A churn risk links the client it is about (issue #19).
    ...(d.clientId ? { client_id: d.clientId } : {}),
  };
}

export interface StepBadge {
  count: number;
  /** The worst rating among them. */
  rating: Rating;
  titles: string[];
}

/**
 * A step's rating on the map, from its open issues: the worst of them, as a rank
 * (higher is worse) with its label, or null for a step with none. A closed group
 * takes the worst of the steps inside it (issue #102).
 */
export function stepRatingOf(badges: Record<string, StepBadge>): (stepId: string) => { rank: number; label: string } | null {
  return (stepId) => {
    const b = badges[stepId];
    return b ? { rank: ratingRank(b.rating), label: RATING_LABELS[b.rating] } : null;
  };
}

/**
 * The red badges on the map (issue #99): open issues somebody has confirmed, that is, tracked in the register.
 * What a run only detected (an insight nobody has acknowledged yet) colours the step through its rating but
 * never adds to a badge.
 */
export function confirmedBadges(entries: readonly RegisterEntry[]): Record<string, StepBadge> {
  return stepBadges(entries.filter((e) => e.kind === "tracked"));
}

/**
 * What colours a step on the map (issue #99, decision D24): the worst rating among its confirmed open issues. Nothing
 * a run only detected reaches the map until someone acknowledges it, and a step with no confirmed issue stays
 * uncoloured. A stored issue with the lowest severity reads as Great, which is not a problem to colour a step by.
 */
export function confirmedRatings(entries: readonly RegisterEntry[]): Record<string, StepBadge> {
  return stepBadges(entries.filter((e) => e.kind === "tracked" && entryView(e).rating !== "great"));
}

/**
 * Everything the map is fed from a page's register entries (D24): the badges and the colours. Both the process page
 * and the Overview take it from here, so what reaches the map is decided in one place: confirmed issues only.
 */
export function mapFeed(entries: readonly RegisterEntry[]): { badges: Record<string, StepBadge>; ratings: Record<string, StepBadge> } {
  return { badges: confirmedBadges(entries), ratings: confirmedRatings(entries) };
}

/** Open findings per step: each step's count and worst rating, whether tracked or only detected. */
export function stepBadges(entries: readonly RegisterEntry[]): Record<string, StepBadge> {
  const out: Record<string, StepBadge> = {};
  for (const e of entries) {
    const v = entryView(e);
    if (!v.open) continue;
    for (const stepId of v.stepIds) {
      const b = (out[stepId] ??= { count: 0, rating: v.rating, titles: [] });
      b.count++;
      b.titles.push(v.title);
      if (compareRatingsDesc(v.rating, b.rating) < 0) b.rating = v.rating;
    }
  }
  return out;
}
