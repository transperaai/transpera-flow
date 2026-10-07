"use client";

// The process page's Solutions section (issue #114, A49): a simple list of this process's solutions, each with the issues it
// solves and how it did against them, and the ways into the Editor's solution mode ("New solution", and "Build solution"
// on an issue). Each card opens the solution page (A50).

import Link from "next/link";
import type { IssueRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { SolutionCards } from "@/components/solutions/solution-cards";
import type { SolutionsData } from "@/lib/solutions/cards";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { buildSolutionHref, newSolutionHref } from "@/lib/solutions/links";
import { EDIT_ONLY } from "@/lib/phone";

export type { SolutionsData };

export function ProcessSolutions({
  processId,
  processName,
  viewerId,
  memberNames,
  base,
  demo,
  canEdit,
  data,
  issues,
  otherOnly = false,
}: {
  /** The process page's "Other improvements": only solutions not linked to an issue (those sit under their issue), with no build-from-issue list. */
  otherOnly?: boolean;
  processId: string;
  processName: string;
  viewerId?: string | null;
  memberNames?: Readonly<Record<string, string>>;
  /** `/w/<slug>` or `/demo`: where the Editor lives. */
  base: string;
  demo: boolean;
  /** Who can build a solution: owners and editors. */
  canEdit: boolean;
  /** This process's solutions and their links, as loaded with the page (the demo keeps its own). */
  data: SolutionsData;
  /** The workspace's issues, for names and for the issues that can have a solution built. */
  issues: IssueRow[];
}) {
  const inTab = useDemoSolutions();
  const own = demo ? inTab.solutions.filter((s) => s.process_id === processId) : data.solutions.filter((s) => s.process_id === processId);
  const links = demo ? inTab.links : data.links;
  const solutions = otherOnly ? own.filter((s) => !links.some((l) => l.solution_id === s.id)) : own;
  const from = `${base}/p/${processId}#solutions`;
  const toSolve = issues.filter(
    (i) => (i.status === "open" || i.status === "testing") && (i.process_id === processId || i.links.some((l) => l.process_id === processId)),
  );

  return (
    <div className="flex flex-col gap-3" data-testid="process-solutions">
      {canEdit && (
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-2 ${EDIT_ONLY}`} data-edit-entry>
          <Link
            href={newSolutionHref(base, processId, from)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-edit px-3 text-sm font-medium text-edit-fg hover:opacity-90"
          >
            ✎ New solution
          </Link>
          <Help
            label="New solution"
            description="Opens the Editor on a copy of this process. Change the steps, simulate, and save it as a solution. The live map and its draft don't change, and you can link the solution to issues afterwards."
            example="Try an AI lead check before the sales call, save it as “AI lead qualifier”, and compare it with live."
          />
        </div>
      )}
      <SolutionCards
        data={{ solutions, links }}
        issues={issues}
        processes={[{ id: processId, name: processName }]}
        base={base}
        demo={demo}
        canEdit={canEdit}
        viewerId={viewerId}
        memberNames={memberNames}
        from={from}
        empty={otherOnly ? "Nothing else yet. Every solution here is for an issue above." : undefined}
      />
      {canEdit && !otherOnly && toSolve.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="build-from-issue">
          <span className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
            Build from an issue
            <Help
              label="Build solution"
              description="Opens the Editor on a copy of this process with the issue's steps outlined in red. When you save, the solution is tested against the issue's target and the issue moves to Testing solutions."
              example="Issue “Website leads wait too long”: Build solution outlines Check fit and Enrich lead, and checks first contact against under 4 hours."
            />
          </span>
          <ul className="flex flex-col gap-1">
            {toSolve.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-2 text-sm">
                <span className="text-xs font-semibold">{i.number == null ? "Issue" : `#${i.number}`}</span>
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                <Link href={buildSolutionHref(base, i, from) ?? newSolutionHref(base, processId, from)} className="text-xs font-semibold text-edit hover:underline">
                  ✎ Build solution
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
