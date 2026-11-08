"use client";

// The Solution page (issue #115, A50; descoped in Q12, decision D44; QA round 2): the header (name, status, the issues it fixes, the process,
// when it was last edited, and Open in editor), the notes (what the solution changes, in the team's own words) with its sources, and the
// live map above this solution's map. The measures table, the revenue chart, the market stress test and the per-issue verdict cards are gone:
// the numbers live in the Sandbox, and the per-issue verdicts stay in the database.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { IssueRow, ProcessBundle, SolutionRow, SolutionStatus } from "@transpera-flow/db";
import { EditableText, HEADER_PILL, MetaLine, PageHeader, SectionCard } from "@/components/page-kit";
import { DeleteSolution } from "@/components/solutions/delete-solution";
import { LinkIssueButton } from "@/components/solutions/new-solution";
import { SolutionMaps } from "@/components/solutions/solution-maps";
import { SolutionStatusMenu } from "@/components/solutions/status-menu";
import { LinkedSources, useSourceLinking } from "@/components/sources/linking-context";
import { TagPill } from "@/components/tag-pill";
import { Help } from "@/components/help";
import { buttonVariants } from "@/components/ui/button";
import { deleteSolution, saveSolutionNotes } from "@/app/w/[slug]/solution-page-actions";
import { issueHref } from "@/lib/issues/pages";
import type { ScreenMode } from "@/lib/mode";
import { editedDate, linksOf, solutionHref, solutionsListHref, type SolutionsData } from "@/lib/solutions/cards";
import { compareMaps } from "@/lib/solutions/compare";
import { SOLUTION_PAGE_HELP } from "@/lib/solutions/help";
import { solutionEditorHref } from "@/lib/solutions/links";
import { NO_ISSUE_WORDS } from "@/lib/solutions/list";
import { EDIT_ONLY } from "@/lib/phone";
import { cn } from "@/lib/utils";

export interface SolutionPageProps {
  workspaceId: string;
  solutionId: string;
  data: SolutionsData;
  issues: IssueRow[];
  processes: { id: string; name: string }[];
  /** `/w/<slug>`. */
  base: string;
  mode: Exclude<ScreenMode, "demo">;
  viewerId?: string | null;
  memberNames?: Readonly<Record<string, string>>;
  /** The version of the process the solution was copied from, for the maps and the lines. */
  compareBase?: ProcessBundle | null;
  /** A sentence when the process has been published since the solution was copied from it. */
  movedOn?: string | null;
}

export function SolutionPage(props: SolutionPageProps) {
  const { workspaceId, solutionId, issues, processes, base, compareBase, movedOn } = props;
  const router = useRouter();
  // The page's data comes with the server render; this copy follows what was saved here, and follows the page when it is reloaded.
  const [local, setLocal] = useState(props.data);
  const [seen, setSeen] = useState(props.data);
  if (seen !== props.data) {
    setSeen(props.data);
    setLocal(props.data);
  }
  const solution = local.solutions.find((s) => s.id === solutionId);
  const canEdit = props.mode !== "readonly";
  const [error, setError] = useState<string | null>(null);
  const comparison = useMemo(() => (compareBase && solution ? compareMaps(compareBase, solution) : null), [compareBase, solution]);

  if (!solution) {
    return (
      <div className="flex flex-col gap-3" data-solution-missing>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Solution not found</h1>
        <p className="text-sm text-muted-foreground">It may have been deleted.</p>
        <Link href={solutionsListHref(base)} className="text-sm font-medium text-accent hover:underline">
          ← All solutions
        </Link>
      </div>
    );
  }

  const links = linksOf(local, solution.id);
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const linked = links.map((l) => issueById.get(l.issue_id)).filter((i): i is IssueRow => Boolean(i));
  const processName = processes.find((p) => p.id === solution.process_id)?.name ?? "a process";
  const here = solutionHref(base, solution.id);
  const editorHref = solutionEditorHref(base, solution.process_id, { issueId: linked[0]?.id, from: here }) + `&solution=${solution.id}`;
  const notes = [...(movedOn ? [movedOn] : [])];

  return (
    <div className="flex flex-col gap-6" data-solution-page={solution.id}>
      <PageHeader
        label="Solution"
        testId="solution-header"
        eyebrow={
          <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <Link href={solutionsListHref(base)} className="hover:underline">
              Solutions
            </Link>
            <span aria-hidden>/</span>
            <span className="min-w-0 break-words">{solution.name}</span>
          </nav>
        }
        title={solution.name}
        pills={
          <>
            <SolutionStatusMenu
              solution={solution}
              mode={props.mode}
              onError={setError}
              onSaved={(status: SolutionStatus) => setLocal((d) => ({ ...d, solutions: d.solutions.map((s): SolutionRow => (s.id === solution.id ? { ...s, status } : s)) }))}
            />
            <TagPill tag={processName} className={HEADER_PILL} />
          </>
        }
        meta={
          <MetaLine>
            <span data-edited>Edited on {editedDate(solution)}</span>
            <span>Solutions never change the live map.</span>
          </MetaLine>
        }
        below={
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-solution-issues>
            <span className="flex items-center text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
              Fixes
              <Help {...SOLUTION_PAGE_HELP.solves} />
            </span>
            {linked.length > 0 ? (
              linked.map((i) => (
                <Link key={i.id} href={issueHref(base, i)} className="font-medium hover:underline" data-solves={i.id}>
                  <span className="mr-1 font-mono text-xs text-muted-foreground">{i.number == null ? "" : `#${i.number}`}</span>
                  {i.title}
                </Link>
              ))
            ) : (
              <>
                <span className="text-muted-foreground">{NO_ISSUE_WORDS}</span>
                {canEdit && <LinkIssueButton solution={solution} issues={issues} processName={processName} workspaceId={workspaceId} />}
              </>
            )}
          </p>
        }
        actionsLabel="Solution actions"
        actions={
          <>
            {canEdit && (
              <span className={EDIT_ONLY} data-edit-entry>
                <Link href={editorHref} className={cn(buttonVariants({ variant: "outline" }), "border-edit text-edit")} data-open-in-editor>
                  ✎ Open in editor
                </Link>
              </span>
            )}
            {canEdit && (
              <span className={cn("flex flex-wrap items-center gap-2", EDIT_ONLY)} data-edit-entry>
                <DeleteSolution
                  name={solution.name}
                  linked={links.length}
                  remove={() => deleteSolution(workspaceId, solution.id)}
                  onDeleted={() => router.push(solutionsListHref(base))}
                />
              </span>
            )}
          </>
        }
      />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}



      <SectionCard
        id="notes"
        section="notes"
        title={
          <span className="flex items-center">
            Notes and sources
            <Help {...SOLUTION_PAGE_HELP.notes} />
          </span>
        }
      >
        <EditableText
          key={solution.id}
          value={solution.notes}
          canEdit={canEdit}
          label="Notes"
          emptyMessage="No notes yet. Say what this solution changes and why: which steps, what is new, what goes."
          emptyReader="No notes."
          addLabel="Add notes"
          maxLength={4000}
          data-solution-notes=""
          onSave={async (next) => {
            setError(null);
            const r = await saveSolutionNotes(workspaceId, solution.id, next);
            if (r.status === "error") return r.message;
            setLocal((d) => ({ ...d, solutions: d.solutions.map((s): SolutionRow => (s.id === solution.id ? { ...s, notes: r.notes } : s)) }));
            return null;
          }}
        />
        <SolutionSources solutionId={solution.id} name={solution.name} />
      </SectionCard>

      {comparison ? (
        <SolutionMaps key={solution.id} comparison={comparison} notes={notes} />
      ) : (
        <p className="text-sm text-fg-2" data-compare-unavailable>
          The maps aren&apos;t available: the process this solution was copied from can&apos;t be loaded.
        </p>
      )}
    </div>
  );
}

/** Where the page loads source links (a workspace), the sources that back this solution up, with "+ Link", inside the notes' card. */
function SolutionSources({ solutionId, name }: { solutionId: string; name: string }) {
  const sourceLinking = useSourceLinking();
  if (!sourceLinking) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3" data-solution-sources>
      <h3 className="text-sm font-semibold">Sources</h3>
      <LinkedSources target={{ kind: "solution", solutionId }} label={`Solution: ${name}`} empty="None linked yet." hideTitle className="flex flex-col gap-2" />
    </div>
  );
}
