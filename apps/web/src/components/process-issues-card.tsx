"use client";

// The process page's "Issues and solutions" card (Q8). Each issue is one row: a rating dot, the title, the step it sits on (a link that
// lights the step on the map), a status pill and its owner, and under it the solutions linked to it. The row opens the issue
// page. "Other improvements" (solutions for no issue) sit in the same card. The register still owns saving and the New issue dialog.

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { RATING_LABELS } from "@transpera-flow/engine";
import type { IssueRow } from "@transpera-flow/db";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/issues/status-pill";
import { IssueTrackView } from "@/components/issue-track";
import { VerdictWord } from "@/components/solutions/solution-cards";
import { issueHref } from "@/lib/issues/pages";
import { entryView, type RegisterEntry } from "@/lib/issues/register";
import { EDIT_ONLY } from "@/lib/phone";
import { issueCounts, issueCountsText } from "@/lib/process-page/issue-counts";
import { TRACK_STAGES, linkedSolutions, trackOf } from "@/lib/process-page/track";
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
  /** Light this step on the map and bring the map into view. */
  onShowStep: (stepId: string) => void;
  /** Where "Build solution" opens the Editor for an issue, or null. */
  buildHref: (issue: IssueRow) => string | null;
  registerHref?: string;
  /** "Other improvements": the solutions for no issue. */
  other: ReactNode;
}

export function IssuesCard(p: IssuesCardProps) {
  const tracked = p.entries.flatMap((e) => (e.kind === "tracked" ? [e.issue] : []));
  const counts = issueCounts(tracked.map((i) => i.status));
  return (
    <Card id="issues" className="scroll-mt-16" aria-labelledby="issues-heading">
      <CardHeader>
        <CardTitle id="issues-heading" className="font-display text-base font-bold">
          Issues and solutions
        </CardTitle>
        <CardDescription data-issue-counts>{p.loading && tracked.length === 0 ? "Checking the latest run…" : issueCountsText(counts)}</CardDescription>
        {p.canEdit && tracked.length > 0 && (
          <CardAction className={EDIT_ONLY} data-edit-entry>
            <Button type="button" size="sm" onClick={p.openNew}>
              Log an issue
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {p.error}
        {tracked.length === 0 ? (
          p.loading ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-lg bg-muted/40 px-4 py-8 text-center" data-issues-empty>
              <CircleAlert aria-hidden className="size-8 text-fg-3" />
              <p className="max-w-md text-sm text-fg-2">Log the problems you find on this map, then link solutions to them.</p>
              {p.canEdit && (
                <span className={EDIT_ONLY} data-edit-entry>
                  <Button type="button" size="sm" onClick={p.openNew}>
                    Log an issue
                  </Button>
                </span>
              )}
            </div>
          )
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Issues">
            {p.entries.map((e) => (e.kind === "tracked" ? <IssueRowView key={e.issue.id} entry={e} issue={e.issue} {...p} /> : null))}
          </ul>
        )}
        {p.registerHref && (
          <Link href={p.registerHref} className="text-xs text-fg-2 hover:underline">
            Open the full register →
          </Link>
        )}
        <div id="solutions" className="flex scroll-mt-16 flex-col gap-2">
          <h3 className="text-sm font-bold">Other improvements</h3>
          <p className="-mt-1.5 text-xs text-fg-3">Solutions that are not for a particular issue.</p>
          {p.other}
        </div>
      </CardContent>
    </Card>
  );
}

function IssueRowView({ entry, issue, names, base, solutions, onShowStep, buildHref }: IssuesCardProps & { entry: RegisterEntry; issue: IssueRow }) {
  const v = entryView(entry);
  const linked = linkedSolutions(solutions, issue.id);
  const track = trackOf(issue, linked);
  const owners = (issue.owner_ids.length ? issue.owner_ids : issue.owner_person_id ? [issue.owner_person_id] : []).map((id) => names.person.get(id) ?? "someone who left");
  const first = v.stepIds[0];
  const stepName = first ? (names.step.get(first) ?? "a removed step") : null;
  return (
    <li
      id={`issue-${v.id}`}
      data-issue={v.id}
      data-source={v.source}
      className="relative flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3 transition-colors focus-within:bg-muted/70 hover:bg-muted/70"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <i aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: DOT[v.rating] }} />
        <span className="sr-only">{RATING_LABELS[v.rating]}: </span>
        {/* The whole row opens the issue; the step link and the other links sit above it. */}
        <Link href={issueHref(base, issue)} className="min-w-0 text-sm font-semibold after:absolute after:inset-0 after:content-[''] hover:underline">
          {issue.number != null && <span className="mr-1.5 font-mono font-normal text-fg-3">#{issue.number}</span>}
          {v.title}
        </Link>
        <StatusPill status={issue.status} />
        {track.stage !== null && (
          <span className="text-xs text-fg-3" data-issue-stage>
            {TRACK_STAGES[track.stage]}
          </span>
        )}
      </div>
      {(stepName || owners.length > 0) && (
        <p className="relative flex flex-wrap items-center gap-x-1.5 pl-5 text-xs text-fg-2">
          {first && stepName && (
            <>
              <span>On</span>
              <button type="button" onClick={() => onShowStep(first)} className="relative z-10 underline decoration-dotted underline-offset-2 hover:decoration-solid" data-issue-step={first}>
                {stepName}
              </button>
              {v.stepIds.length > 1 && <span>+{v.stepIds.length - 1} more</span>}
            </>
          )}
          {stepName && owners.length > 0 && <span aria-hidden>·</span>}
          {owners.length > 0 && (
            <span>
              {owners.length > 1 ? "Owners" : "Owner"}: {owners.join(", ")}
            </span>
          )}
        </p>
      )}
      {linked.length > 0 && (
        <ul className="relative flex flex-col gap-0.5 pl-5 text-xs text-fg-2" aria-label="Linked solutions">
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
