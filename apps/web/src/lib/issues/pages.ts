// What the Issues list and the Issue page show (issue #113, A48), as pure functions: the filters and what the URL says
// about them, the counts, the sort, the status as shown, the "Logged <date> from insight <rule>" line, the history
// lines and the "Resolved <date> · by …" bar. The components render the results.

import { ISSUE_STATUSES, isActiveStatus, isVisibleIssue, type IssueEventRow, type IssueRow, type IssueStatus, type ResolveHow } from "@transpera-flow/db";
import { compareCostsDesc, compareRatingsDesc, noCost, ratingOfStored, ruleOfFinding, type IssueCost, type Rating } from "@transpera-flow/engine";
import { RULES_UI } from "@/lib/rules/catalogue";
import { RATINGS_WORST_FIRST, STATUS_LABELS } from "./register";

// ---------------------------------------------------------------------------
// The list: filters, counts, sort
// ---------------------------------------------------------------------------

/** The statuses a person can filter by (a dismissed insight is never an issue they see). */
export const LISTED_STATUSES = ["open", "testing", "resolved", "wont_fix"] as const satisfies readonly IssueStatus[];
export type ListedStatus = (typeof LISTED_STATUSES)[number];

/** The owner filter's value for issues nobody owns. */
export const UNASSIGNED = "none";

export interface ListState {
  /** The statuses shown. */
  status: ListedStatus[];
  /** The ratings shown; empty is all. */
  ratings: Rating[];
  /** Owners (person ids, or UNASSIGNED); empty is all. */
  owners: string[];
  /** Processes (ids); empty is all. */
  processes: string[];
  /** Words in the title (or its number); "" is all. */
  q: string;
}

/** Open and Testing solutions: what the list shows until a person chooses otherwise. */
export const DEFAULT_STATUSES: ListedStatus[] = ["open", "testing"];
/** Every status. */
export const ALL_STATUSES_STATE: ListedStatus[] = [...LISTED_STATUSES];
export const DEFAULT_LIST_STATE: ListState = { status: DEFAULT_STATUSES, ratings: [], owners: [], processes: [], q: "" };

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const csv = (v: string | string[] | undefined): string[] =>
  (first(v) ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * The list's filters from the URL's query. Anything unrecognised is the default, so a stale link still opens. The old `show=` links
 * still work: `resolved` is Resolved and Won't fix, `all` is every status.
 */
export function parseListState(params: Params): ListState {
  const named = csv(params.status);
  const known = named.filter((s): s is ListedStatus => (LISTED_STATUSES as readonly string[]).includes(s));
  const show = first(params.show);
  let status: ListedStatus[] = DEFAULT_STATUSES;
  if (known.length) status = LISTED_STATUSES.filter((s) => known.includes(s));
  else if (named.includes("none")) status = [];
  else if (show === "resolved") status = ["resolved", "wont_fix"];
  else if (show === "all") status = ALL_STATUSES_STATE;
  const ratings = csv(params.rating);
  return {
    status,
    ratings: RATINGS_WORST_FIRST.filter((r) => ratings.includes(r)),
    owners: csv(params.owner),
    processes: csv(params.process),
    q: (first(params.q) ?? "").trim().slice(0, 100),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The query string for filters ("" when they are the defaults, so the plain URL stays plain). */
export function listQuery(state: ListState): string {
  const q = new URLSearchParams();
  if (!sameSet(state.status, DEFAULT_STATUSES)) q.set("status", state.status.length ? state.status.join(",") : "none");
  if (state.ratings.length) q.set("rating", state.ratings.join(","));
  if (state.owners.length) q.set("owner", state.owners.join(","));
  if (state.processes.length) q.set("process", state.processes.join(","));
  if (state.q) q.set("q", state.q);
  const s = q.toString().replace(/%2C/g, ",");
  return s ? `?${s}` : "";
}

/** Whether any filter differs from what the list starts with (then "Clear filters" shows). */
export const filtersOn = (state: ListState): boolean => listQuery(state) !== "";

/** The issues a person sees: everything but a dismissed insight. */
export const visibleIssues = (issues: readonly IssueRow[]): IssueRow[] => issues.filter(isVisibleIssue);

/** Whether an issue is still to be dealt with (Open or Testing solutions). */
export const isOpenIssue = (i: Pick<IssueRow, "status">): boolean => isActiveStatus(i.status);

/** The people who own an issue (several, or the one the older column names). */
export const ownersOf = (i: Pick<IssueRow, "owner_ids" | "owner_person_id">): string[] => (i.owner_ids.length ? i.owner_ids : i.owner_person_id ? [i.owner_person_id] : []);

/** The processes an issue is about: the ones it links to, else the one it was logged on. */
export function processesOf(i: Pick<IssueRow, "links" | "process_id">): string[] {
  const ids = i.links.map((l) => l.process_id).filter((x): x is string => !!x);
  if (!ids.length && i.process_id) ids.push(i.process_id);
  return [...new Set(ids)];
}

export type Facet = "status" | "ratings" | "owners" | "processes";

function matches(i: IssueRow, state: ListState, skip?: Facet): boolean {
  if (skip !== "status" && !(state.status as readonly string[]).includes(i.status)) return false;
  if (skip !== "ratings" && state.ratings.length && !state.ratings.includes(ratingOfStored(i.severity))) return false;
  if (skip !== "owners" && state.owners.length) {
    const o = ownersOf(i);
    if (!(o.length ? o.some((x) => state.owners.includes(x)) : state.owners.includes(UNASSIGNED))) return false;
  }
  if (skip !== "processes" && state.processes.length && !processesOf(i).some((p) => state.processes.includes(p))) return false;
  const q = state.q.toLowerCase();
  if (q && !`#${i.number ?? ""} ${i.title}`.toLowerCase().includes(q)) return false;
  return true;
}

/**
 * How many issues each choice of a filter would show, given the other filters: the numbers on the dropdowns. An issue counts under
 * each value it has for that filter (its owners; UNASSIGNED when it has none).
 */
export function facetCounts(issues: readonly IssueRow[], state: ListState, facet: Facet): Map<string, number> {
  const valuesOf = (i: IssueRow): string[] => {
    if (facet === "status") return [i.status];
    if (facet === "ratings") return [ratingOfStored(i.severity)];
    if (facet === "owners") return ownersOf(i).length ? ownersOf(i) : [UNASSIGNED];
    return processesOf(i);
  };
  const out = new Map<string, number>();
  for (const i of visibleIssues(issues)) {
    if (!matches(i, state, facet)) continue;
    for (const v of valuesOf(i)) out.set(v, (out.get(v) ?? 0) + 1);
  }
  return out;
}

/** The issues the list shows, most severe first, then costliest first (no cost last), then by number. */
export function listIssues(issues: readonly IssueRow[], state: ListState, costOf: (i: IssueRow) => IssueCost | null = () => null): IssueRow[] {
  const none = noCost("");
  return visibleIssues(issues)
    .filter((i) => matches(i, state))
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

/** What the Issues list says about the solutions tested for each issue (`solutionSummaries` in lib/solutions/cards.ts, A50). */
export interface SolutionSummary {
  tested: number;
  /** A solution passed, by the person's own verdict (QA round 2: no automatic one). */
  passed: boolean;
}

export const NO_SOLUTIONS: SolutionSummary = { tested: 0, passed: false };

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
    case "solution_status":
      return `Solution ${d.solution ? `“${d.solution}”` : "a solution"} went from ${SOLUTION_STATUS_WORDS[d.from ?? ""] ?? d.from} to ${SOLUTION_STATUS_WORDS[d.to ?? ""] ?? d.to}.`;
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

// ---------------------------------------------------------------------------
// The history as a timeline (Q10): newest first, an icon per kind and one plain line
// ---------------------------------------------------------------------------

/** What an entry is about, for its icon. */
export type TimelineKind = "created" | "edited" | "status" | "linked" | "solution" | "resolved" | "reopened";

export interface TimelineLine {
  id: string;
  kind: TimelineKind;
  when: string;
  who: string;
  text: string;
}

/** The explanation under the History heading. */
export const HISTORY_FOLD = "Written automatically when the issue is created, edited, changes status, gains or loses a link, a solution is judged, or it's resolved.";

const SOLUTION_STATUS_WORDS: Record<string, string> = { idea: "Idea", testing: "Testing", works: "Works", doesnt_work: "Doesn't work", adopted: "Adopted" };

/** One history entry as one plain line with the kind that picks its icon: "Status: Open → Testing solutions", "Linked step Domain vetting". */
export function timelineLine(e: Pick<IssueEventRow, "kind" | "detail">, names: Omit<HistoryNames, "who">): { kind: TimelineKind; text: string } {
  const d = e.detail as {
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
  const quoted = (s: string | undefined) => (s ? `“${s}”` : "a solution");
  const stepName = (s: { step_id: string | null }) => (s.step_id ? (names.step(s.step_id) ?? "a step") : "the whole process");
  switch (e.kind) {
    case "created":
      return { kind: "created", text: d.migrated ? "Logged (from the old register)" : d.acknowledged ? "Acknowledged from an insight" : "Logged" };
    case "solution_status":
      return { kind: "solution", text: `Solution ${quoted(d.solution)}: ${SOLUTION_STATUS_WORDS[d.from ?? ""] ?? d.from} → ${SOLUTION_STATUS_WORDS[d.to ?? ""] ?? d.to}` };
    case "solution_tested": {
      const parts = [d.solution ? `Tried solution ${quoted(d.solution)}` : "Started testing solutions"];
      if (d.solution && d.from && d.to && d.from !== d.to) parts.push(`Status: ${shown(d.from)} → ${shown(d.to)}`);
      return { kind: "solution", text: parts.join(". ") };
    }
    case "resolved": {
      const how = d.how ? ` ${d.how === "solution" && d.solution ? `by solution “${d.solution}”` : RESOLVE_HOW_BAR[d.how]}` : "";
      return { kind: "resolved", text: `${d.to === "wont_fix" ? "Marked Won't fix" : "Resolved"}${how}${d.note ? `: “${d.note}”` : ""}` };
    }
    case "reopened":
      return { kind: "reopened", text: "Reopened" };
    default: {
      const parts: string[] = [];
      let kind: TimelineKind = "edited";
      const sv = d.solution_verdict;
      if (sv) {
        kind = "solution";
        if (sv.verdict !== sv.was) parts.push(sv.verdict ? `Your verdict on ${quoted(sv.solution)}: ${sv.verdict === "pass" ? "Pass" : "Fail"}` : `Cleared your verdict on ${quoted(sv.solution)}`);
        if (sv.notes_changed) parts.push(`Updated your note on ${quoted(sv.solution)}`);
      }
      if (d.solution_deleted) {
        kind = "solution";
        parts.push(`Deleted solution ${quoted(d.solution_deleted.solution)}`);
      }
      if (d.fields?.length) parts.push(`Edited ${list(d.fields.map((f) => FIELD_WORDS[f] ?? f))}`);
      const l = d.linked;
      const linked: string[] = [];
      if (l?.steps?.added?.length) linked.push(`Linked step ${list(l.steps.added.map(stepName))}`);
      if (l?.steps?.removed?.length) linked.push(`Unlinked step ${list(l.steps.removed.map(stepName))}`);
      if (l?.owners?.added?.length) linked.push(`Added owner ${list(l.owners.added.map((p) => names.person(p) ?? "someone"))}`);
      if (l?.owners?.removed?.length) linked.push(`Removed owner ${list(l.owners.removed.map((p) => names.person(p) ?? "someone"))}`);
      if (l?.sources?.added?.length) linked.push(`Linked source ${list(l.sources.added.map((s) => names.source(s) ?? "a source"))}`);
      if (l?.sources?.removed?.length) linked.push(`Unlinked source ${list(l.sources.removed.map((s) => names.source(s) ?? "a source"))}`);
      if (linked.length) {
        parts.push(...linked);
        if (kind === "edited") kind = "linked";
      }
      if (d.from && d.to) {
        parts.push(`Status: ${shown(d.from)} → ${shown(d.to)}`);
        if (kind === "edited") kind = "status";
      }
      return { kind, text: parts.length ? parts.join(". ") : "Edited" };
    }
  }
}

/** The history newest first, as timeline lines. */
export function timelineLines(events: readonly IssueEventRow[], names: HistoryNames, now?: Date): TimelineLine[] {
  return [...events]
    .sort((a, b) => b.seq - a.seq)
    .map((e) => ({ id: e.id, when: shortDate(e.at, now), who: names.who(e.actor), ...timelineLine(e, names) }));
}
