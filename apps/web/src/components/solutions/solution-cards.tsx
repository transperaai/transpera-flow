"use client";

// The solution cards (issue #115, A50; prototype: "Solutions"): one card per saved solution, shared by the Solutions list and the
// process page. Each shows the type, who built it and when, the process and the steps it changes, the issues it solves with a
// verdict each, and Open and Open in Editor.

import Link from "next/link";
import type { IssueRow, SolutionIssueRow, SolutionRow, SolutionVerdict } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Card } from "@/components/ui/card";
import { issueHref } from "@/lib/issues/pages";
import { SOLUTIONS_LIST_HELP, newOnProcessHelp } from "@/lib/solutions/help";
import { builtBy, builtDate, changesLine, effectiveVerdict, linksOf, solutionHref, solutionType, VERDICT_WORDS, type SolutionsData } from "@/lib/solutions/cards";
import { solutionEditorHref } from "@/lib/solutions/links";
import { cn } from "@/lib/utils";
import { EDIT_ONLY } from "@/lib/phone";

/** "Pass" in green, "Fail" in red, "Not checked" quiet: the word always says it, so colour is never the only signal. */
export function VerdictWord({ verdict, className }: { verdict: SolutionVerdict | null; className?: string }) {
  return (
    <span
      data-verdict={verdict ?? "none"}
      className={cn("font-semibold", verdict === "pass" ? "text-good" : verdict === "fail" ? "text-crit" : "font-normal text-muted-foreground", className)}
    >
      {verdict ? VERDICT_WORDS[verdict] : "Not checked"}
    </span>
  );
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function SolutionCards({
  data,
  issues,
  processes,
  base,
  demo,
  canEdit,
  viewerId,
  memberNames,
  from,
  empty,
}: {
  data: SolutionsData;
  /** The workspace's issues, for the titles and numbers of what each solution solves. */
  issues: readonly IssueRow[];
  processes: readonly { id: string; name: string }[];
  /** `/w/<slug>` or `/demo`. */
  base: string;
  demo: boolean;
  /** Who can open the Editor: owners and editors. */
  canEdit: boolean;
  viewerId?: string | null;
  memberNames?: Readonly<Record<string, string>>;
  /** Where Exit editor goes back to. */
  from: string;
  empty?: string;
}) {
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const processName = new Map(processes.map((p) => [p.id, p.name]));
  if (data.solutions.length === 0) {
    return (
      <p className="rounded-token border border-dashed border-line p-4 text-sm text-fg-2" data-testid="solutions-empty">
        {empty ?? "No solutions yet. Build one from an issue, or start one here."}
      </p>
    );
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2" aria-label="Solutions" data-testid="solution-cards">
      {data.solutions.map((s) => (
        <li key={s.id} className="min-w-0">
          <SolutionCard
            solution={s}
            links={linksOf(data, s.id)}
            issueById={issueById}
            processName={processName.get(s.process_id) ?? "a process"}
            base={base}
            demo={demo}
            canEdit={canEdit}
            viewerId={viewerId}
            memberNames={memberNames}
            aiIds={data.aiIds}
            from={from}
          />
        </li>
      ))}
    </ul>
  );
}

function SolutionCard({
  solution: s,
  links,
  issueById,
  processName,
  base,
  demo,
  canEdit,
  viewerId,
  memberNames,
  aiIds,
  from,
}: {
  solution: SolutionRow;
  links: SolutionIssueRow[];
  issueById: Map<string, IssueRow>;
  processName: string;
  base: string;
  demo: boolean;
  canEdit: boolean;
  viewerId?: string | null;
  memberNames?: Readonly<Record<string, string>>;
  aiIds?: readonly string[];
  from: string;
}) {
  const type = solutionType(s, aiIds);
  return (
    <Card className="h-full gap-2 p-3" data-testid="solution-card" data-solution={s.id}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="inline-flex items-center text-xs font-semibold">
          <span
            data-solution-type={type}
            className={cn("inline-flex h-5 items-center rounded-full border px-2", type === "AI block" ? "border-accent/50 bg-accent/10" : "border-border bg-muted")}
          >
            {type}
          </span>
          <Help {...SOLUTIONS_LIST_HELP.type} />
        </span>
        <span className="text-xs text-muted-foreground">
          {builtBy(s.created_by, viewerId, demo, memberNames)} · {builtDate(s)}
        </span>
      </div>
      <h3 className="font-heading text-base leading-snug font-semibold">
        <Link href={solutionHref(base, s.id)} className="hover:underline">
          {s.name}
        </Link>
      </h3>
      <p className="flex flex-wrap items-center text-xs text-muted-foreground" data-changes>
        <span>
          Changes {processName} · {changesLine(s)}
        </span>
        <Help {...SOLUTIONS_LIST_HELP.changes} />
      </p>
      <div className="flex flex-col gap-1">
        <span className="flex items-center text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
          Solves
          <Help {...SOLUTIONS_LIST_HELP.solves} />
        </span>
        {links.length === 0 ? (
          <span className="text-xs text-muted-foreground">Not linked to an issue yet</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {links.map((l) => {
              const issue = issueById.get(l.issue_id);
              const v = effectiveVerdict(l);
              return (
                <li key={l.issue_id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs" data-solves={l.issue_id}>
                  {issue ? (
                    <Link href={issueHref(base, issue)} className="min-w-0 hover:underline">
                      {issue.number == null ? "" : `#${issue.number} `}
                      {trunc(issue.title, 44)}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">An issue</span>
                  )}
                  <span className="whitespace-nowrap">
                    <VerdictWord verdict={v} />
                    {l.user_verdict ? <span className="ml-1 text-muted-foreground">(yours)</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <span className="flex items-center">
          <Link href={solutionHref(base, s.id)} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90">
            Open
          </Link>
          <Help {...SOLUTIONS_LIST_HELP.open} />
        </span>
        {canEdit && (
          <span className={`flex items-center ${EDIT_ONLY}`} data-edit-entry>
            <Link
              href={solutionEditorHref(base, s.process_id, { from })}
              className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
            >
              ✎ New solution on {processName}
            </Link>
            <Help {...newOnProcessHelp(processName)} />
          </span>
        )}
      </div>
    </Card>
  );
}
