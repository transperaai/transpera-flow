// What the Issues list and the Issue page show (issue #113, A48), as pure functions: the filters and what the URL says
// about them, the counts, the sort, the status as shown, the "Logged <date> from insight <rule>" line, the history
// lines and the "Resolved <date> · by …" bar. The components render the results.

import { ISSUE_STATUSES, isActiveStatus, isVisibleIssue, type IssueEventRow, type IssueRow, type IssueStatus, type ResolveHow } from "@transpera-flow/db";
import { RATINGS, compareCostsDesc, compareRatingsDesc, noCost, ratingOfStored, ruleOfFinding, type IssueCost, type Rating } from "@transpera-flow/engine";
import { RULES_UI } from "@/lib/rules/catalogue";
import { RATINGS_WORST_FIRST, STATUS_LABELS } from "./register";

// ---------------------------------------------------------------------------
// The list: filters, counts, sort
// ---------------------------------------------------------------------------

/** Open: Open and Testing solutions. Resolved: Resolved and Won't fix (both are closed). */
export type ShowFilter = "open" | "resolved" | "all";
export const SHOW_FILTERS: readonly ShowFilter[] = ["open", "resolved", "all"];
export const SHOW_LABELS: Record<ShowFilter, string> = { open: "Open", resolved: "Resolved", all: "All" };

export interface ListState {
  show: ShowFilter;
  /** One rating, or "" for all. */
  rating: Rating | "";
}

export const DEFAULT_LIST_STATE: ListState = { show: "open", rating: "" };

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The list's filters from the URL's query. Anything unrecognised is the default, so a stale link still opens. */
export function parseListState(params: Params): ListState {
  const show = first(params.show);
  const rating = first(params.rating);
  return {
    show: (SHOW_FILTERS as readonly string[]).includes(show ?? "") ? (show as ShowFilter) : DEFAULT_LIST_STATE.show,
    rating: (RATINGS as readonly string[]).includes(rating ?? "") ? (rating as Rating) : "",
  };
}

/** The query string for filters ("" when they are the defaults, so the plain URL stays plain). */
export function listQuery(state: ListState): string {
  const q = new URLSearchParams();
  if (state.show !== DEFAULT_LIST_STATE.show) q.set("show", state.show);
  if (state.rating) q.set("rating", state.rating);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The issues a person sees: everything but a dismissed insight. */
export const visibleIssues = (issues: readonly IssueRow[]): IssueRow[] => issues.filter(isVisibleIssue);

/** Whether an issue is still to be dealt with (Open or Testing solutions). */
export const isOpenIssue = (i: Pick<IssueRow, "status">): boolean => isActiveStatus(i.status);

const inShow = (i: IssueRow, show: ShowFilter) => show === "all" || (show === "open" ? isOpenIssue(i) : !isOpenIssue(i));

/** The counts on the Open / Resolved / All buttons. */
export function showCounts(issues: readonly IssueRow[]): Record<ShowFilter, number> {
  const v = visibleIssues(issues);
  return { open: v.filter((i) => inShow(i, "open")).length, resolved: v.filter((i) => inShow(i, "resolved")).length, all: v.length };
}

/** The counts on the rating chips: among the issues the Open / Resolved / All choice leaves. */
export function ratingCounts(issues: readonly IssueRow[], show: ShowFilter): { all: number; byRating: Record<Rating, number> } {
  const base = visibleIssues(issues).filter((i) => inShow(i, show));
  const byRating = Object.fromEntries(RATINGS.map((r) => [r, base.filter((i) => ratingOfStored(i.severity) === r).length])) as Record<Rating, number>;
  return { all: base.length, byRating };
}

/** The issues the list shows, most severe first, then costliest first (no cost last), then by number. */
export function listIssues(issues: readonly IssueRow[], state: ListState, costOf: (i: IssueRow) => IssueCost | null = () => null): IssueRow[] {
  const none = noCost("");
  return visibleIssues(issues)
    .filter((i) => inShow(i, state.show) && (!state.rating || ratingOfStored(i.severity) === state.rating))
    .sort(
      (a, b) =>
        compareRatingsDesc(ratingOfStored(a.severity), ratingOfStored(b.severity)) ||
        compareCostsDesc(costOf(a) ?? none, costOf(b) ?? none) ||
        (a.number ?? 0) - (b.number ?? 0),
    );
}

export { RATINGS_WORST_FIRST };

// ---------------------------------------------------------------------------
// Solutions tested (the rows are built in lib/solutions/cards.ts)
// ---------------------------------------------------------------------------

/**
 * What the list says about the solutions tested for each issue, and the page lists. The rows come from
 * `solutionTests` and `solutionSummaries` in lib/solutions/cards.ts (A50); AI ideas are A52's.
 */
export interface SolutionTest {
  id: string;
  name: string;
  /** "Built into the process" or "AI block", as the prototype's Type column. */
  type: string;
  built: string;
  /** The automatic verdict against this issue's target. */
  auto: "pass" | "fail" | "unchecked" | null;
  /** How often it holds across the simulated runs, as a share (0 to 1), or null. */
  holds: number | null;
  /** The person's own verdict. */
  yours: "pass" | "fail" | null;
  href: string;
}

export interface SolutionSummary {
  tested: number;
  /** A solution passed (the person's verdict, else the automatic one). */
  passed: boolean;
  /** AI ideas waiting for this issue (A52). */
  ideas: number;
}

export const NO_SOLUTIONS: SolutionSummary = { tested: 0, passed: false, ideas: 0 };

// ---------------------------------------------------------------------------
// The issue page
// ---------------------------------------------------------------------------

/** Where an issue's page is: its number in the workspace, else its id. */
export const issueHref = (base: string, issue: Pick<IssueRow, "id" | "number">): string => `${base}/issues/${issue.number ?? issue.id}`;

/** Find the issue a path segment names: its number (digits) or its id. */
export function findIssue(issues: readonly IssueRow[], segment: string): IssueRow | null {
  const visible = visibleIssues(issues);
  if (/^\d+$/.test(segment)) return visible.find((i) => i.number === Number(segment)) ?? null;
  return visible.find((i) => i.id === segment) ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "5 Oct": the short date the prototype uses. A year is added when it is not this one. */
export function shortDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Spelled out here, not by the locale, so "Sep" reads the same everywhere.
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? day : `${day} ${d.getUTCFullYear()}`;
}

/** The analysis rule an issue was acknowledged from ("Too busy"), or null for one logged by hand. */
export function insightRuleOf(issue: Pick<IssueRow, "detected_key" | "type">): string | null {
  if (!issue.detected_key) return null;
  const id = ruleOfFinding({ key: issue.detected_key, type: issue.type });
  return id ? RULES_UI[id].name : null;
}

/** "Logged 5 Oct from insight “Too busy”", or "Logged 5 Oct" for an issue added by hand. */
export function loggedLine(issue: Pick<IssueRow, "created_at" | "detected_key" | "type">, now?: Date): string {
  const rule = insightRuleOf(issue);
  return `Logged ${shortDate(issue.created_at, now)}${issue.detected_key ? ` from insight${rule ? ` “${rule}”` : ""}` : ""}`;
}

/** The status as the chip words it. */
export const statusLabel = (s: IssueStatus): string => STATUS_LABELS[s];

export const RESOLVE_HOW_LABELS: Record<ResolveHow, string> = {
  solution: "A solution fixed it",
  process_change: "We changed the process directly",
  not_a_problem: "No longer a problem",
};

/** How the "Resolved" bar words it. */
export const RESOLVE_HOW_BAR: Record<ResolveHow, string> = {
  solution: "by a solution",
  process_change: "by changing the process directly",
  not_a_problem: "no longer a problem",
};

/** The bar on a resolved issue: "Resolved 5 Oct · by changing the process directly · note". Null for an open issue. */
export function resolvedBar(
  issue: Pick<IssueRow, "status" | "resolved_at" | "resolved_how" | "resolution_note">,
  now?: Date,
  /** The solution that fixed it, when one was picked (A50): "by solution “Lead scoring”". */
  solutionName?: string | null,
): string | null {
  if (issue.status !== "resolved" && issue.status !== "wont_fix") return null;
  const head = issue.status === "wont_fix" ? "Won't fix" : "Resolved";
  const date = shortDate(issue.resolved_at, now);
  const how = issue.resolved_how ? (issue.resolved_how === "solution" && solutionName ? `by solution “${solutionName}”` : RESOLVE_HOW_BAR[issue.resolved_how]) : null;
  return [`${head}${date ? ` ${date}` : ""}`, how, issue.resolution_note?.trim() || null].filter(Boolean).join(" · ");
}

export interface HistoryNames {
  step: (id: string) => string | undefined;
  person: (id: string) => string | undefined;
  source: (id: string) => string | undefined;
  /** Who did it: "You" for the signed-in person, a name where one is known. */
  who: (actor: string | null) => string;
}

export const FIELD_WORDS: Record<string, string> = {
  title: "the title",
  type: "the kind",
  severity: "the rating",
  evidence: "what's wrong",
  scenario_id: "its linked scenario",
  role_id: "the role",
  person_id: "the person",
  client_id: "the client",
  target_measure: "the target measure",
  target_now: "the value now",
  target_goal: "the goal",
};

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

interface LinkedDetail {
  steps?: { added?: { process_id: string | null; step_id: string | null }[]; removed?: { process_id: string | null; step_id: string | null }[] };
  owners?: { added?: string[]; removed?: string[] };
  sources?: { added?: string[]; removed?: string[] };
}

/** One history entry as a sentence. The detail is what the database logged; unknown shapes fall back to a plain line. */
export function historyText(e: Pick<IssueEventRow, "kind" | "detail">, names: Omit<HistoryNames, "who">): string {
  const d = e.detail as {
    status?: string;
    acknowledged?: boolean;
    migrated?: boolean;
    from?: string;
    to?: string;
    how?: ResolveHow;
    note?: string;
    solution?: string;
    solution_verdict?: { solution?: string; verdict?: "pass" | "fail" | null; was?: "pass" | "fail" | null; notes_changed?: boolean };
    solution_deleted?: { solution?: string };
    fields?: string[];
    linked?: LinkedDetail;
  };
  const shown = (s: string | undefined) => (s && (ISSUE_STATUSES as readonly string[]).includes(s) ? STATUS_LABELS[s as IssueStatus] : s);
  switch (e.kind) {
    case "created":
      return d.migrated ? "Logged (from the old register)." : d.acknowledged ? "Acknowledged from an insight." : "Logged.";
    case "solution_tested":
      return "Started testing solutions.";
    case "resolved": {
      const how = d.how ? ` ${d.how === "solution" && d.solution ? `by solution “${d.solution}”` : RESOLVE_HOW_BAR[d.how]}` : "";
      const label = d.to === "wont_fix" ? "Marked Won't fix" : "Marked resolved";
      return `${label}${how}.${d.note ? ` “${d.note}”` : ""}`;
    }
    case "reopened":
      return "Reopened.";
    default: {
      const parts: string[] = [];
      const sv = d.solution_verdict;
      if (sv) {
        const name = sv.solution ? `“${sv.solution}”` : "a solution";
        if (sv.verdict !== sv.was) parts.push(sv.verdict ? `Your verdict on ${name}: ${sv.verdict === "pass" ? "Pass" : "Fail"}` : `Cleared your verdict on ${name}`);
        if (sv.notes_changed) parts.push(`Updated your note on ${name}`);
      }
      if (d.solution_deleted) parts.push(`Deleted solution ${d.solution_deleted.solution ? `“${d.solution_deleted.solution}”` : ""}`.trim());
      if (d.fields?.length) parts.push(`Changed ${list(d.fields.map((f) => FIELD_WORDS[f] ?? f))}`);
      const l = d.linked;
      if (l?.steps?.added?.length) parts.push(`Linked ${list(l.steps.added.map((s) => (s.step_id ? (names.step(s.step_id) ?? "a step") : "the whole process")))}`);
      if (l?.steps?.removed?.length) parts.push(`Unlinked ${list(l.steps.removed.map((s) => (s.step_id ? (names.step(s.step_id) ?? "a step") : "the whole process")))}`);
      if (l?.owners?.added?.length) parts.push(`Added owner ${list(l.owners.added.map((p) => names.person(p) ?? "someone"))}`);
      if (l?.owners?.removed?.length) parts.push(`Removed owner ${list(l.owners.removed.map((p) => names.person(p) ?? "someone"))}`);
      if (l?.sources?.added?.length) parts.push(`Linked source ${list(l.sources.added.map((s) => names.source(s) ?? "a source"))}`);
      if (l?.sources?.removed?.length) parts.push(`Unlinked source ${list(l.sources.removed.map((s) => names.source(s) ?? "a source"))}`);
      if (d.from && d.to) parts.push(`Status ${shown(d.from)} to ${shown(d.to)}`);
      return parts.length ? `${parts.join(". ")}.` : "Edited.";
    }
  }
}

export interface HistoryLine {
  id: string;
  when: string;
  who: string;
  text: string;
}

/** The history, oldest first (the order the database wrote it), as lines. */
export function historyLines(events: readonly IssueEventRow[], names: HistoryNames, now?: Date): HistoryLine[] {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ id: e.id, when: shortDate(e.at, now), who: names.who(e.actor), text: historyText(e, names) }));
}
