"use client";

// The process page's "Issues and solutions" card (Q8). Current issues (Open, Testing solutions) come first, one row each: a rating dot,
// the title, a status pill and its owners, and under it the solutions tried. The row opens the issue page. Issues belong to the process,
// so a row names no step. Solved issues follow as their solution: the solution that resolved the issue is the row, with "Solved <issue>"
// under it and the person's verdict, or, resolved with no solution, the issue and how it was resolved. Won't fix is folded at the end.
// "Other improvements" (solutions for no issue) sit in the same section. The register still owns saving and the New issue dialog.
// It is a section card in the process page's main column, like the Issue page's sections; `#issues` links here.

import { CircleAlert, CircleCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { RATING_LABELS } from "@transpera-flow/engine";
import type { IssueRow } from "@transpera-flow/db";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/page-kit";
import { Skeleton } from "@/components/ui/skeleton";
import { IssueStatusPill } from "@/components/issues/status-pill";
import { IssueTrackView } from "@/components/issue-track";
import { VerdictWord } from "@/components/solutions/solution-cards";
import { issueHref, RESOLVE_HOW_LABELS, shortDate } from "@/lib/issues/pages";
import { entryView, type RegisterEntry } from "@/lib/issues/register";
import { EDIT_ONLY } from "@/lib/phone";
import { issueCounts, issueCountsText } from "@/lib/process-page/issue-counts";
import { TRACK_STAGES, issueGroups, linkedSolutions, solvedBy, trackOf } from "@/lib/process-page/track";
import { solutionHref } from "@/lib/solutions/cards";
import type { SolutionsData } from "@/lib/solutions/cards";

const DOT: Record<string, string> = { risk: "var(--rate-risk)", bad: "var(--rate-bad)", good: "var(--rate-good)", great: "var(--rate-great)" };

export interface IssuesCardProps {
  entries: RegisterEntry[];
  names: { step: Map<string, string>; person: Map<string, string> };
  openNew: () => void;
  canEdit: boolean;
  loading: boolean;
  error: ReactNode;
  /** `/w/<slug>` (or `/demo`): the issue and solution pages live under it. */
  base: string;
  solutions: Pick<SolutionsData, "solutions" | "links">;
  /** Where "Build solution" opens the Editor for an issue, or null. */
  buildHref: (issue: IssueRow) => string | null;
  registerHref?: string;
  /** "Other improvements": the solutions for no issue. */
  other: ReactNode;
}

export function IssuesCard(p: IssuesCardProps) {
  const tracked = p.entries.flatMap((e) => (e.kind === "tracked" ? [e] : []));
  const counts = issueCounts(tracked.map((e) => e.issue.status));
  const groups = issueGroups(tracked, (e) => e.issue.status);
  return (
    <SectionCard
      id="issues"
      section="issues"
      title="Issues and solutions"
      description={p.loading && tracked.length === 0 ? "Checking the latest run…" : issueCountsText(counts)}
      descriptionProps={{ "data-issue-counts": "" }}
      actionIsEdit
      actionClassName={EDIT_ONLY}
      action={
        p.canEdit && tracked.length > 0 ? (
          <Button type="button" size="sm" onClick={p.openNew}>
            Log an issue
          </Button>
        ) : undefined
      }
      contentClassName="gap-4"
    >
      {p.error}
      {tracked.length === 0 ? (
        p.loading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : (
          <EmptyState
            icon={CircleAlert}
            data-issues-empty=""
            action={
              p.canEdit ? (
                <span className={EDIT_ONLY} data-edit-entry>
                  <Button type="button" size="sm" onClick={p.openNew}>
                    Log an issue
                  </Button>
                </span>
              ) : undefined
            }
          >
            Log the problems you find on this map, then link solutions to them.
          </EmptyState>
        )
      ) : (
        <>
          <section className="flex flex-col gap-2" aria-labelledby="issues-current-heading" data-issue-group="current">
            <h3 id="issues-current-heading" className="text-sm font-semibold">
              Current issues <span className="font-normal text-fg-3">{groups.current.length}</span>
            </h3>
            {groups.current.length > 0 ? (
              <ul className="flex flex-col gap-2" aria-label="Current issues">
                {groups.current.map((e) => (
                  <IssueRowView key={e.issue.id} entry={e} issue={e.issue} {...p} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-2" data-no-current>
                Nothing open: every issue here is solved or closed.
              </p>
            )}
          </section>
          {groups.solved.length > 0 && (
            <section className="flex flex-col gap-2" aria-labelledby="issues-solved-heading" data-issue-group="solved">
              <h3 id="issues-solved-heading" className="text-sm font-semibold">
                Solved <span className="font-normal text-fg-3">{groups.solved.length}</span>
              </h3>
              <ul className="flex flex-col gap-2" aria-label="Solved">
                {groups.solved.map((e) => (
                  <SolvedRowView key={e.issue.id} issue={e.issue} base={p.base} solutions={p.solutions} />
                ))}
              </ul>
            </section>
          )}
          {groups.wontFix.length > 0 && (
            <details className="group flex flex-col gap-2" data-issue-group="wont_fix">
              <summary className="w-fit cursor-pointer text-sm font-semibold hover:underline">
                Won&apos;t fix <span className="font-normal text-fg-3">{groups.wontFix.length}</span>
              </summary>
              <ul className="mt-2 flex flex-col gap-2" aria-label="Won't fix">
                {groups.wontFix.map((e) => (
                  <IssueRowView key={e.issue.id} entry={e} issue={e.issue} {...p} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {p.registerHref && (
        <Link href={p.registerHref} className="text-xs text-fg-2 hover:underline">
          Open the full register →
        </Link>
      )}
      <div id="solutions" className="flex scroll-mt-16 flex-col gap-2">
        <h3 className="text-sm font-semibold">Other improvements</h3>
        <p className="-mt-1.5 text-xs text-fg-3">Solutions that are not for a particular issue.</p>
        {p.other}
      </div>
    </SectionCard>
  );
}

const ROW = "relative flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3 transition-colors focus-within:bg-muted/70 hover:bg-muted/70";

/** An issue not solved yet (or closed as won't fix): its rating, title, status and owners, the solutions tried, and its progress. */
function IssueRowView({ entry, issue, names, base, solutions, buildHref }: IssuesCardProps & { entry: RegisterEntry; issue: IssueRow }) {
  const v = entryView(entry);
  const linked = linkedSolutions(solutions, issue.id);
  const track = trackOf(issue, linked);
  const owners = (issue.owner_ids.length ? issue.owner_ids : issue.owner_person_id ? [issue.owner_person_id] : []).map((id) => names.person.get(id) ?? "someone who left");
  return (
    <li id={`issue-${v.id}`} data-issue={v.id} data-source={v.source} className={ROW}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <i aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: DOT[v.rating] }} />
        <span className="sr-only">{RATING_LABELS[v.rating]}: </span>
        {/* The whole row opens the issue; the other links sit above it. */}
        <Link href={issueHref(base, issue)} className="min-w-0 text-sm font-semibold after:absolute after:inset-0 after:content-[''] hover:underline">
          {issue.number != null && <span className="mr-1.5 font-mono font-normal text-fg-3">#{issue.number}</span>}
          {v.title}
        </Link>
        <IssueStatusPill status={issue.status} />
        {track.stage !== null && (
          <span className="text-xs text-fg-3" data-issue-stage>
            {TRACK_STAGES[track.stage]}
          </span>
        )}
      </div>
      {owners.length > 0 && (
        <p className="relative pl-5 text-xs text-fg-2">
          {owners.length > 1 ? "Owners" : "Owner"}: {owners.join(", ")}
        </p>
      )}
      {linked.length > 0 && (
        <ul className="relative flex flex-col gap-0.5 pl-5 text-xs text-fg-2" aria-label="Solutions tried">
          {linked.map((s) => (
            <li key={s.solution.id} data-solution={s.solution.id} className="flex flex-wrap items-baseline gap-x-2">
              <Link href={solutionHref(base, s.solution.id)} className="relative z-10 hover:underline">
                Solution: {s.solution.name}
              </Link>
              <VerdictWord verdict={s.verdict} className="text-xs" />
            </li>
          ))}
        </ul>
      )}
      {(linked.length > 0 || buildHref(issue)) && (
        <details className="relative z-10 pl-5 text-xs">
          <summary className="w-fit cursor-pointer text-fg-2 hover:underline">Progress</summary>
          <IssueTrackView track={{ ...track, solutions: [] }} base={base} buildHref={buildHref(issue)} />
        </details>
      )}
    </li>
  );
}

/**
 * A solved issue, shown as its solution: the solution that resolved it is the row (opening the solution), with "Solved <issue>" under
 * it and the person's verdict. Resolved with no linked solution, the row is the issue, with how it was resolved and the note.
 */
function SolvedRowView({ issue, base, solutions }: { issue: IssueRow; base: string; solutions: IssuesCardProps["solutions"] }) {
  const by = solvedBy(issue, linkedSolutions(solutions, issue.id));
  const date = shortDate(issue.resolved_at);
  const note = issue.resolution_note?.trim() || null;
  const issueName = (
    <>
      {issue.number != null && <span className="mr-1 font-mono text-fg-3">#{issue.number}</span>}
      {issue.title}
    </>
  );
  const rowLink = "min-w-0 text-sm font-semibold after:absolute after:inset-0 after:content-[''] hover:underline";
  return (
    <li id={`issue-${issue.id}`} data-issue={issue.id} data-solved={by ? "solution" : (issue.resolved_how ?? "unknown")} className={ROW}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <CircleCheck aria-hidden className="size-3.5 shrink-0 text-good" />
        {by ? (
          <Link href={solutionHref(base, by.solution.id)} className={rowLink} data-solution={by.solution.id}>
            <span className="sr-only">Solution: </span>
            {by.solution.name}
          </Link>
        ) : (
          <Link href={issueHref(base, issue)} className={rowLink}>
            {issueName}
          </Link>
        )}
        <IssueStatusPill status={issue.status} />
        {date && <span className="text-xs text-fg-3">{date}</span>}
      </div>
      {by ? (
        <p className="relative pl-6 text-xs text-fg-2" data-solved-issue>
          Solved{" "}
          <Link href={issueHref(base, issue)} className="relative z-10 underline decoration-dotted underline-offset-2 hover:decoration-solid">
            {issueName}
          </Link>
        </p>
      ) : (
        <p className="relative pl-6 text-xs text-fg-2" data-resolved-how>
          {issue.resolved_how ? RESOLVE_HOW_LABELS[issue.resolved_how] : "Resolved"}
        </p>
      )}
      {(by?.verdict || note) && (
        <p className="relative flex flex-wrap items-baseline gap-x-1.5 pl-6 text-xs text-fg-2">
          {by?.verdict && (
            <span data-solved-verdict>
              Verdict: <VerdictWord verdict={by.verdict} className="text-xs" />
            </span>
          )}
          {by?.verdict && note && <span aria-hidden>·</span>}
          {note && <span className="min-w-0">{note}</span>}
        </p>
      )}
    </li>
  );
}
