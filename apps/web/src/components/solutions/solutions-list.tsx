"use client";

// The Solutions list (issue #115, A50; prototype: "Solutions"): every solution that has been built and simulated, as cards, with
// "✎ New solution". The demo keeps its solutions in this tab.

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import type { IssueRow, SolutionStatus } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { SolutionCards } from "@/components/solutions/solution-cards";
import { ClearFilters, EmptyState, FilterMenu, MetaLine, PageHeader, Toolbar, ToolbarSearch, type FilterOption } from "@/components/page-kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { NO_SOLUTIONS_DATA, solutionsListHref, type SolutionsData } from "@/lib/solutions/cards";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { SOLUTIONS_LIST_HELP } from "@/lib/solutions/help";
import { newSolutionHref } from "@/lib/solutions/links";
import { SOLUTION_STATUS_OPTIONS } from "@/lib/solutions/status";
import { EDIT_ONLY } from "@/lib/phone";
import { cn } from "@/lib/utils";

/** "✎ New solution": starts one on a process. With one process it goes straight to the Editor; with several it asks which. */
export function NewSolutionButton({ processes, base }: { processes: readonly { id: string; name: string }[]; base: string }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const from = solutionsListHref(base);
  const choice = picked || processes[0]?.id || "";
  const style = cn(buttonVariants(), "bg-edit text-edit-fg hover:bg-edit/90");
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

/** The Solutions page's header card: the title, one sentence and how many there are, and "✎ New solution" for editors. */
export function SolutionsHeader({
  count,
  canEdit,
  processes,
  base,
}: {
  /** How many solutions there are (left out while nothing is published). */
  count?: number;
  canEdit: boolean;
  /** The processes a solution can start from (the published ones). */
  processes: readonly { id: string; name: string }[];
  base: string;
}) {
  return (
    <PageHeader
      label="Solutions"
      testId="solutions-header"
      eyebrow={<span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Improve</span>}
      title="Solutions"
      meta={
        <MetaLine>
          <span>Every solution that has been built and simulated, with how it did against each issue&apos;s target. They never change the live map.</span>
          {count === undefined ? "" : <span data-solutions-count>{count === 1 ? "1 solution" : `${count} solutions`}</span>}
        </MetaLine>
      }
      actionsLabel="Solutions actions"
      actions={canEdit ? <NewSolutionButton processes={processes} base={base} /> : undefined}
    />
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
}) {
  const inTab = useDemoSolutions();
  const shown = mode === "demo" ? inTab : (data ?? NO_SOLUTIONS_DATA);
  const canEdit = mode !== "readonly";
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [procs, setProcs] = useState<string[]>([]);
  const processName = useMemo(() => new Map(processes.map((p) => [p.id, p.name])), [processes]);
  const issueTitle = useMemo(() => new Map(issues.map((i) => [i.id, i.title])), [issues]);
  const q = search.trim().toLowerCase();
  const matches = (s: SolutionsData["solutions"][number], skip?: "status" | "process") => {
    if (skip !== "status" && statuses.length && !statuses.includes(s.status satisfies SolutionStatus)) return false;
    if (skip !== "process" && procs.length && !procs.includes(s.process_id)) return false;
    if (!q) return true;
    const linked = shown.links.filter((l) => l.solution_id === s.id).map((l) => issueTitle.get(l.issue_id) ?? "");
    return [s.name, processName.get(s.process_id) ?? "", ...linked].some((t) => t.toLowerCase().includes(q));
  };
  const list = shown.solutions.filter((s) => matches(s));
  const statusOptions: FilterOption[] = SOLUTION_STATUS_OPTIONS.map((o) => ({
    value: o.value,
    label: o.label,
    count: shown.solutions.filter((s) => s.status === o.value && matches(s, "status")).length,
    dot: `var(--${o.tone})`,
  }));
  const processIds = [...new Set(shown.solutions.map((s) => s.process_id))].filter((id) => processName.has(id));
  const processOptions: FilterOption[] = processIds
    .map((id) => ({ value: id, label: processName.get(id) ?? "A process", count: shown.solutions.filter((s) => s.process_id === id && matches(s, "process")).length }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const filtered = Boolean(q) || statuses.length > 0 || procs.length > 0;
  const clear = () => {
    setSearch("");
    setStatuses([]);
    setProcs([]);
  };
  const body: ReactNode =
    shown.solutions.length > 0 && list.length === 0 ? (
      <EmptyState icon={FlaskConical} data-testid="solutions-empty" data-filtered action={<ClearFilters onClick={clear} />}>
        No solutions match these filters.
      </EmptyState>
    ) : (
      <SolutionCards data={{ solutions: list, links: shown.links }} issues={issues} processes={processes} base={base} demo={mode === "demo"} canEdit={canEdit} viewerId={viewerId} memberNames={memberNames} from={solutionsListHref(base)} />
    );
  return (
    <div className="flex flex-col gap-4" data-solutions-list>
      {shown.solutions.length > 0 && (
        <Toolbar label="Filter solutions">
          <ToolbarSearch value={search} onChange={setSearch} label="Search solutions" placeholder="Search solutions" />
          <FilterMenu name="Status" options={statusOptions} selected={statuses} onChange={setStatuses} />
          {processOptions.length > 1 && <FilterMenu name="Process" options={processOptions} selected={procs} onChange={setProcs} />}
          {filtered && <ClearFilters onClick={clear} />}
        </Toolbar>
      )}
      {body}
    </div>
  );
}
