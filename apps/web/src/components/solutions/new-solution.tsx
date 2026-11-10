"use client";

// "✎ New solution" on the Solutions list (Q12): every solution starts from an issue. The dialog lists the open issues (searchable); picking
// one opens the Editor in solution mode on that issue's process, with the issue already linked. "Log a new issue" goes to the Issues list's
// New issue dialog and on to the Editor from there. "Link an issue" (below) is for an older solution that has none.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { IssueRow, SolutionRow } from "@transpera-flow/db";
import { linkSolutionToIssue } from "@/app/w/[slug]/solution-actions";
import { Help } from "@/components/help";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { issueProcessId } from "@/lib/solutions/area";
import { linkableIssues } from "@/lib/solutions/cards";
import { SOLUTIONS_LIST_HELP } from "@/lib/solutions/help";
import { logIssueHref, searchIssues, startSolutionHref, startableIssues } from "@/lib/solutions/list";
import { solutionsListHref } from "@/lib/solutions/cards";
import { EDIT_ONLY } from "@/lib/phone";
import { cn } from "@/lib/utils";

const rowName = (i: Pick<IssueRow, "number" | "title">) => `${i.number == null ? "" : `#${i.number} `}${i.title}`;

/** The list of issues to pick from: a search box over radio rows. */
function IssuePicker({ issues, processName, picked, onPick, label }: { issues: IssueRow[]; processName: (i: IssueRow) => string; picked: string; onPick: (id: string) => void; label: string }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => searchIssues(issues, query, processName), [issues, query, processName]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label={`Search ${label}`} placeholder="Search issues" data-issue-search />
      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted-foreground" data-no-issues>
          {issues.length === 0 ? "There are no open issues yet." : "No issues match."}
        </p>
      ) : (
        <ul role="radiogroup" aria-label={label} className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-line p-1" data-issue-options>
          {shown.map((i) => (
            <li key={i.id}>
              <label className={cn("flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted", picked === i.id && "bg-muted")}>
                <input type="radio" name="solution-issue" className="mt-1" checked={picked === i.id} onChange={() => onPick(i.id)} data-issue-option={i.id} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium break-words">{rowName(i)}</span>
                  <span className="block text-xs text-muted-foreground">{processName(i)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "✎ New solution": opens the dialog that picks the issue it fixes. Needs at least one published process. */
export function NewSolutionButton({
  issues,
  processes,
  base,
  from,
}: {
  issues: readonly IssueRow[];
  /** The processes with a published version (a solution copies one). */
  processes: readonly { id: string; name: string }[];
  base: string;
  /** Where Exit editor and a saved solution go back to (the Solutions list by default). */
  from?: string;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const names = useMemo(() => new Map(processes.map((p) => [p.id, p.name])), [processes]);
  const startable = useMemo(() => startableIssues(issues, new Set(processes.map((p) => p.id))), [issues, processes]);
  const processName = useMemo(() => (i: IssueRow) => names.get(issueProcessId(i) ?? "") ?? "A process", [names]);
  const issue = startable.find((i) => i.id === picked);
  const href = issue ? startSolutionHref(base, issue, from ?? solutionsListHref(base)) : null;
  const style = buttonVariants();
  if (!processes.length) return null;
  return (
    <span className={`flex items-center ${EDIT_ONLY}`} data-edit-entry>
      <button type="button" className={style} onClick={() => setOpen(true)} data-new-solution>
        ✎ New solution
      </button>
      <Help {...SOLUTIONS_LIST_HELP.newSolution} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg" data-new-solution-dialog>
          <DialogHeader>
            <DialogTitle>New solution</DialogTitle>
            <DialogDescription>Which issue is it for? Every solution fixes an issue. You edit a copy of the process the issue is about. The live map and its draft stay as they are.</DialogDescription>
          </DialogHeader>
          <IssuePicker issues={startable} processName={processName} picked={picked} onPick={setPicked} label="Open issues" />
          <DialogFooter className="sm:justify-between">
            <Button asChild variant="outline">
              <Link href={logIssueHref(base)} data-log-issue>
                Log a new issue
              </Link>
            </Button>
            <span className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              {href ? (
                <Button asChild>
                  <Link href={href} data-start-in-editor>
                    ✎ Start in the Editor
                  </Link>
                </Button>
              ) : (
                <Button type="button" disabled data-start-in-editor>
                  ✎ Start in the Editor
                </Button>
              )}
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}

/** "Link an issue" on a solution that has none: picks one of the issues it could fix and links it (the first save has no issue to link). */
export function LinkIssueButton({
  solution,
  issues,
  processName,
  workspaceId,
}: {
  solution: Pick<SolutionRow, "id" | "process_id" | "name">;
  issues: readonly IssueRow[];
  processName: string;
  workspaceId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useMemo(() => linkableIssues(issues, solution.process_id, new Set()), [issues, solution.process_id]);
  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await linkSolutionToIssue(workspaceId, solution.id, picked);
      if (r.status === "error") return setError(r.message);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Couldn't link. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={EDIT_ONLY} data-edit-entry>
      <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(true); }} data-link-issue={solution.id}>
        Link an issue
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg" data-link-issue-dialog onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Link an issue</DialogTitle>
            <DialogDescription>
              Which issue does “{solution.name}” fix? These are the open issues about {processName}.
            </DialogDescription>
          </DialogHeader>
          <IssuePicker issues={choices} processName={() => processName} picked={picked} onPick={setPicked} label="Issues it could fix" />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!picked || busy} onClick={() => void link()}>
              {busy ? "Linking…" : "Link issue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}
