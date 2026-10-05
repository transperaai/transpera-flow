// Proposed issues and solution ideas on the Suggestions page (A52 slice 1; docs/PRD.md §7.1c). Framework-free: what a
// proposal says to a reviewer, the (i) help for the screen, and reviewing in memory for the public demo. The database
// does the same in `public.review_proposals` (migration 20261124000000_suggestions_v2.sql): accepting a proposed issue
// creates it through the Acknowledge path (`save_issue`), rejecting one drops it, and a solution idea can only be
// dismissed for now (building it in the Editor is slice 2).

import type { ProposalApplied, ProposalRow, IssueProposalPayload } from "@transpera-flow/db";
import { readIdea } from "@/lib/suggestions/idea";
import { RATING_LABELS, ratingOfStored } from "@transpera-flow/engine";
import type { IssueStore } from "@/lib/issues/store";
import type { HelpProps } from "@/components/help";

export type ProposalDecision = "accept" | "reject";
export type ProposalReviewStatus = "accepted" | "rejected" | "dismissed" | "not_found" | "already_reviewed" | "failed";

/** What happened to one proposal (the shape `public.review_proposals` returns). */
export interface ProposalReviewResult {
  id: string;
  status: ProposalReviewStatus;
  message?: string;
  applied?: ProposalApplied;
}

export type ProposalOutcome = { status: "ok"; results: ProposalReviewResult[]; proposals: ProposalRow[] } | { status: "error"; message: string };

export interface ProposalBackend {
  review(ids: string[], decision: ProposalDecision, note: string | null): Promise<ProposalOutcome>;
}

/** Names the cards show: where a proposal points. Anything missing is shown generally ("a step that has gone"). */
export interface ProposalLookups {
  processes: Record<string, string>;
  steps: Record<string, string>;
  /** Issue id to its number, title and process (a solution idea is for one; Build it opens the Editor on the process). */
  issues: Record<string, { number: number | null; title: string; processId?: string | null }>;
}

export interface ProposalView {
  /** "Issue" or "Solution idea". */
  kind: string;
  /** Who proposed it: "Claude (MCP)" or a play-link visitor's name. */
  from: string;
  title: string;
  /** One or two plain lines under the title. */
  lines: string[];
  /** For a solution idea: the issue it is for. */
  issue: { id: string; number: number | null; title: string } | null;
}

const STORED = ["critical", "serious", "warning", "info"];
const list = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** How a proposal reads to a reviewer. */
export function describeProposal(p: ProposalRow, lookups: ProposalLookups): ProposalView {
  const from = p.created_via === "play_link" ? `${p.proposer_name?.trim() || "A visitor"} (play link)` : p.created_via === "upload" ? `Upload (${p.import_source ?? "a file"})` : "Claude (MCP)";
  if (p.kind === "issue") {
    const payload = p.payload as IssueProposalPayload;
    const rating = RATING_LABELS[ratingOfStored(STORED.includes(payload.severity as never) ? payload.severity! : "warning")];
    const links = (Array.isArray(payload.links) ? payload.links : []).filter((l) => typeof l === "object" && l !== null);
    const steps = links.flatMap((l) => (l.step_id ? [lookups.steps[l.step_id] ?? "a step that has gone"] : []));
    const processes = [...new Set(links.flatMap((l) => (!l.step_id && l.process_id ? [lookups.processes[l.process_id] ?? "a process that has gone"] : [])))];
    const touches = steps.length ? `Touches ${list(steps)}.` : processes.length ? `Touches the whole of ${list(processes)}.` : "Touches nothing in particular yet.";
    const lines = [`Proposed rating: ${rating}. ${touches}`];
    if (payload.target_measure) {
      lines.push(`Target: ${payload.target_measure}${payload.target_now ? `, now ${payload.target_now}` : ""}${payload.target_goal ? `, goal ${payload.target_goal}` : ""}.`);
    }
    if (p.detail) lines.push(p.detail);
    return { kind: "Issue", from, title: p.title, lines, issue: null };
  }
  const idea = readIdea(p.payload);
  const target = p.issue_id ? lookups.issues[p.issue_id] : undefined;
  const lines: string[] = [];
  if (p.detail) lines.push(p.detail);
  const replaced = idea.replaces.map((id) => lookups.steps[id] ?? "a step that has gone");
  lines.push(`Proposed steps: ${idea.steps.length ? idea.steps.map((s) => s.name).join(" → ") : "none that can be shown"}${replaced.length ? `. Would replace ${list(replaced)}` : ""}.`);
  if (idea.expect) lines.push(`${idea.expect} Not simulated yet.`);
  return {
    kind: "Solution idea",
    from,
    title: p.title,
    lines,
    issue: p.issue_id ? { id: p.issue_id, number: target?.number ?? null, title: target?.title ?? "an issue that has gone" } : null,
  };
}

/** One line after a review: "Accepted. Now issue #16." / "Rejected 1. 1 couldn't be accepted: …". */
export function proposalSummary(results: readonly ProposalReviewResult[], decision: ProposalDecision): string {
  const done = results.filter((r) => r.status === "accepted" || r.status === "rejected" || r.status === "dismissed");
  const failed = results.filter((r) => r.status === "failed");
  const parts: string[] = [];
  if (done.length) {
    const word = decision === "accept" ? "Accepted" : done.every((r) => r.status === "dismissed") ? "Dismissed" : "Rejected";
    const numbers = done.flatMap((r) => (r.applied?.number ? [`#${r.applied.number}`] : []));
    parts.push(numbers.length ? `${word}. Now ${numbers.length === 1 ? "issue" : "issues"} ${numbers.join(", ")}.` : `${word}${done.length > 1 ? ` ${done.length}` : ""}.`);
  }
  if (failed.length) {
    parts.push(`${failed.length} couldn't be ${decision === "accept" ? "accepted" : "removed"} and ${failed.length === 1 ? "is" : "are"} still waiting: ${[...new Set(failed.map((f) => f.message ?? "unknown error"))].join("; ")}.`);
  }
  const already = results.filter((r) => r.status === "already_reviewed").length;
  if (already) parts.push(`${already} had already been dealt with.`);
  const gone = results.filter((r) => r.status === "not_found").length;
  if (gone) parts.push(`${gone} ${gone === 1 ? "isn't" : "aren't"} yours to review (or no longer exist${gone === 1 ? "s" : ""}).`);
  return parts.join(" ") || "Nothing to review.";
}

/**
 * Review proposals in memory, as `review_proposals` does: each on its own, a failure leaving that one waiting. Accepting
 * a proposed issue saves it through the issue store's `save` (the Acknowledge path), so it is numbered and has a history.
 */
export async function reviewProposalsInMemory(
  proposals: readonly ProposalRow[],
  ids: readonly string[],
  decision: ProposalDecision,
  note: string | null,
  opts: { at: string; by: string | null; issues: IssueStore },
): Promise<{ proposals: ProposalRow[]; results: ProposalReviewResult[] }> {
  let next = [...proposals];
  const results: ProposalReviewResult[] = [];
  for (const id of ids) {
    const p = next.find((x) => x.id === id);
    if (!p) {
      results.push({ id, status: "not_found" });
      continue;
    }
    if (p.status !== "pending") {
      results.push({ id, status: "already_reviewed" });
      continue;
    }
    let applied: ProposalApplied | null = null;
    if (decision === "accept") {
      if (p.kind !== "issue") {
        results.push({ id, status: "failed", message: "A solution idea is built in the Editor, not accepted" });
        continue;
      }
      const payload = p.payload as IssueProposalPayload;
      const saved = await opts.issues.save({
        title: p.title,
        severity: payload.severity ?? "warning",
        type: payload.type ?? "manual",
        evidence: p.detail,
        target_measure: payload.target_measure ?? null,
        target_now: payload.target_now ?? null,
        target_goal: payload.target_goal ?? null,
        links: payload.links ?? [],
        owner_ids: [],
        source_ids: [],
      });
      if (saved.status === "error") {
        results.push({ id, status: "failed", message: saved.message });
        continue;
      }
      applied = { issue_id: saved.issue.id, number: saved.issue.number };
    }
    const status = decision === "accept" ? "accepted" : p.kind === "solution_idea" ? "dismissed" : "rejected";
    next = next.map((x) => (x.id === id ? { ...x, status, applied, review_note: note, reviewed_by: opts.by, reviewed_at: opts.at } : x));
    results.push(applied ? { id, status, applied } : { id, status });
  }
  return { proposals: next, results };
}

/** The (i) beside each part of the Suggestions screen: what it does, in plain words, with an example. */
export const SUGGESTIONS_HELP = {
  ideas: {
    label: "Solution ideas",
    description: "Ideas for fixing an issue, from AI or from someone trying their own changes. They are not built and not simulated. Build one to open the Editor with the steps placed, or dismiss it. Nothing changes until you do.",
    example: "“Fast-track partner leads past Check fit”, for the issue about slow first contact.",
  },
  buildIt: {
    label: "Build it",
    description: "Opens the Editor in solution mode with the idea's steps already placed. Adjust them, simulate, then save: that turns the idea into a real solution, tested against the issue.",
    example: "Build “Fast-track partner leads”, check the new steps, and save it as a solution.",
  },
  ideaMap: {
    label: "Proposed steps",
    description: "A small picture of the steps the idea would add, left to right. If it would replace a step you already have, that step is named beside it.",
    example: "Partner lead arrives, then Book discovery call, then Quick check by AI.",
  },
  dismiss: {
    label: "Dismiss",
    description: "Throws an idea away. It leaves this list and nothing else changes. You can't get it back, but AI can suggest it again later.",
    example: "Dismiss an idea that doesn't fit how your team works.",
  },
  other: {
    label: "Other suggestions",
    description: "Everything else AI proposes: new issues, and changes to people, clients, services, demand and company settings. Each waits for you to accept or reject it.",
    example: "“Ad-hoc requests wait 20 h for an SEO specialist”, or “Arjun Mehta: FTE 0.8 to 1.0 from 1 Nov”.",
  },
  issues: {
    label: "Proposed issues",
    description: "Problems AI thinks are worth tracking. Accepting one adds it to your issues, the same as acknowledging an insight. Rejecting it drops it.",
    example: "Accepting “Leads wait a day for a discovery call” makes it issue #4, ready for an owner and solutions.",
  },
  accept: {
    label: "Accept",
    description: "Says yes. A proposed issue is added to your issues with its rating, what it touches and its target. A company change is made, marked as an estimate.",
    example: "Accept a proposed issue and it appears in Issues as the next number.",
  },
  reject: {
    label: "Reject",
    description: "Says no. Nothing is created or changed, and the proposal leaves this list.",
    example: "Reject a proposed issue you already know about.",
  },
  model: {
    label: "Company model changes",
    description: "Changes Claude suggested to people, clients, services, demand and company settings. Accepted values are marked as estimates and keep the quotes they cite.",
    example: "“Claude suggests lead volume 6/wk for Google Ads, was 4/wk.”",
  },
  show: {
    label: "Which suggestions",
    description: "Shows what is waiting, or lets you look back at what was accepted or rejected.",
    example: "Pick Rejected to see what you turned down last week.",
  },
  bulk: {
    label: "Review several at once",
    description: "Tick the suggestions you want, then accept or reject them together.",
    example: "Select all, then Accept selected after checking the quotes.",
  },
} as const satisfies Record<string, HelpProps>;
