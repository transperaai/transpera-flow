"use client";

// The Solutions list (issue #115, A50; prototype: "Solutions"): every solution that has been built and simulated, as cards, with
// "✎ New solution" and, when AI ideas are waiting, a bar that links to Suggestions. The demo keeps its solutions in this tab.

import Link from "next/link";
import { useState } from "react";
import type { IssueRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { SolutionCards } from "@/components/solutions/solution-cards";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { NO_SOLUTIONS_DATA, solutionsListHref, type SolutionsData } from "@/lib/solutions/cards";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { SOLUTIONS_LIST_HELP } from "@/lib/solutions/help";
import { newSolutionHref } from "@/lib/solutions/links";
import { EDIT_ONLY } from "@/lib/phone";

/** "✎ New solution": starts one on a process. With one process it goes straight to the Editor; with several it asks which. */
export function NewSolutionButton({ processes, base }: { processes: readonly { id: string; name: string }[]; base: string }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const from = solutionsListHref(base);
  const choice = picked || processes[0]?.id || "";
  const style = "inline-flex h-8 items-center gap-1.5 rounded-md bg-edit px-3 text-sm font-medium text-edit-fg hover:opacity-90";
  if (!processes.length) return null;
  return (
    <span className={`flex items-center ${EDIT_ONLY}`} data-edit-entry>
      {processes.length === 1 ? (
        <Link href={newSolutionHref(base, processes[0]!.id, from)} className={style} data-new-solution>
          ✎ New solution
        </Link>
      ) : (
        <button type="button" className={style} onClick={() => setOpen(true)} data-new-solution>
          ✎ New solution
        </button>
      )}
      <Help {...SOLUTIONS_LIST_HELP.newSolution} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-new-solution-dialog>
          <DialogHeader>
            <DialogTitle>New solution</DialogTitle>
            <DialogDescription>Which process does it change? You edit a copy of its live version. The live map and its draft stay as they are.</DialogDescription>
          </DialogHeader>
          <NativeSelect aria-label="Process" value={choice} onChange={(e) => setPicked(e.target.value)}>
            {processes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button asChild className="bg-edit text-edit-fg hover:bg-edit/90">
              <Link href={newSolutionHref(base, choice, from)}>✎ Start in the Editor</Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}

export function SolutionsList({
  data,
  issues,
  processes,
  base,
  mode,
  viewerId,
  memberNames,
  ideas = 0,
}: {
  /** As loaded with the page; the demo ignores it and shows what this tab has saved. */
  data?: SolutionsData;
  issues: IssueRow[];
  /** Every process, for naming what a solution changes. */
  processes: { id: string; name: string }[];
  /** `/w/<slug>` or `/demo`. */
  base: string;
  mode: "live" | "demo" | "readonly";
  viewerId?: string | null;
  memberNames?: Readonly<Record<string, string>>;
  /** AI ideas waiting in Suggestions (A52 supplies the count). Zero hides the bar. */
  ideas?: number;
}) {
  const inTab = useDemoSolutions();
  const shown = mode === "demo" ? inTab : (data ?? NO_SOLUTIONS_DATA);
  const canEdit = mode !== "readonly";
  return (
    <div className="flex flex-col gap-4" data-solutions-list>
      {ideas > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-token border border-line bg-panel px-3 py-2 text-sm" data-ideas-bar>
          <span>
            <b>
              {ideas} AI {ideas === 1 ? "idea" : "ideas"}
            </b>{" "}
            not built yet. Ideas live in Suggestions until someone builds them; then they become solutions here.
          </span>
          <Link href={`${base}/suggestions`} className="font-medium text-accent hover:underline">
            See ideas →
          </Link>
          <Help {...SOLUTIONS_LIST_HELP.ideas} className="ml-0" />
        </div>
      )}
      <SolutionCards data={shown} issues={issues} processes={processes} base={base} demo={mode === "demo"} canEdit={canEdit} viewerId={viewerId} memberNames={memberNames} from={solutionsListHref(base)} />
    </div>
  );
}
