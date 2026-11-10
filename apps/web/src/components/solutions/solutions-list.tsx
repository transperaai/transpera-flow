"use client";

// The Solutions list (issue #115, A50; Q12): every solution that has been built and simulated, as a table like the Issues list: its name, the
// issue or issues it fixes (every solution is tied to one), its status, the process and when it was last changed. Its filters live in the
// URL, as the Issues list's do. "✎ New solution" starts
// from an issue (components/solutions/new-solution.tsx). The demo keeps its solutions in this tab.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import type { IssueRow, SolutionStatus } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { ClearFilters, EmptyState, FilterMenu, MetaLine, PageHeader, StatusPill, Toolbar, ToolbarSearch, type FilterOption } from "@/components/page-kit";
import { LinkIssueButton, NewSolutionButton } from "@/components/solutions/new-solution";
import { ListCount, ListTable, ListTableHeader } from "@/components/processes/list-table";
import { TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { issueHref, shortDate } from "@/lib/issues/pages";
import { NO_SOLUTIONS_DATA, solutionHref, solutionsListHref, type SolutionsData } from "@/lib/solutions/cards";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { SOLUTIONS_LIST_HELP } from "@/lib/solutions/help";
import { NO_ISSUE, NO_ISSUE_WORDS, issuesBySolution, matchesIssueFilter } from "@/lib/solutions/list";
import { SOLUTION_STATUS_OPTIONS } from "@/lib/solutions/status";

/** The Solutions page's header card: the title, one sentence and how many there are, and "✎ New solution" for editors. */
export function SolutionsHeader({
  count,
  canEdit,
  processes,
  issues,
  base,
}: {
  /** How many solutions there are (left out while nothing is published). */
  count?: number;
  canEdit: boolean;
  /** The processes a solution can start from (the published ones). */
  processes: readonly { id: string; name: string }[];
  /** The workspace's issues: a new solution starts from one of the open ones. */
  issues: readonly IssueRow[];
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
          <span>Every solution that has been built and simulated, each one tied to the issue it fixes. They never change the live map.</span>
          {count === undefined ? "" : <span data-solutions-count>{count === 1 ? "1 solution" : `${count} solutions`}</span>}
        </MetaLine>
      }
      actionsLabel="Solutions actions"
      actions={canEdit ? <NewSolutionButton issues={issues} processes={processes} base={base} /> : undefined}
    />
  );
}

/** The Solutions list's filters, as they are kept in the URL (`?status=works,testing&issue=<id>&process=<id>&q=budget`). */
export interface SolutionFilters {
  status: string[];
  process: string[];
  issue: string[];
  q: string;
}

const NO_FILTERS: SolutionFilters = { status: [], process: [], issue: [], q: "" };
const csv = (v: string | null) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

/** The filters a URL's query asks for; unknown statuses are left out. */
export function parseSolutionFilters(params: Pick<URLSearchParams, "get">): SolutionFilters {
  const known = new Set<string>(SOLUTION_STATUS_OPTIONS.map((o) => o.value));
  return {
    status: csv(params.get("status")).filter((s) => known.has(s)),
    process: csv(params.get("process")),
    issue: csv(params.get("issue")),
    q: (params.get("q") ?? "").trim().slice(0, 100),
  };
}

/** The query string for the filters ("" with none on, so the plain URL stays plain). */
export function solutionFiltersQuery(f: SolutionFilters): string {
  const q = new URLSearchParams();
  if (f.status.length) q.set("status", f.status.join(","));
  if (f.issue.length) q.set("issue", f.issue.join(","));
  if (f.process.length) q.set("process", f.process.join(","));
  if (f.q) q.set("q", f.q);
  const s = q.toString().replace(/%2C/g, ",");
  return s ? `?${s}` : "";
}

export function SolutionsList({
  data,
  issues,
  processes,
  base,
  mode,
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
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const inTab = useDemoSolutions();
  const shown = mode === "demo" ? inTab : (data ?? NO_SOLUTIONS_DATA);
  const canEdit = mode !== "readonly";
  // The filters are the URL's, as on the Issues list: Back and Forward change them, and a link or a reload shows the same list.
  const filters = useMemo(() => parseSolutionFilters(params), [params]);
  const { status: statuses, process: procs, issue: issueIds } = filters;
  const setFilters = (next: SolutionFilters) => router.push(`${pathname}${solutionFiltersQuery(next)}`, { scroll: false });
  const setStatuses = (status: string[]) => setFilters({ ...filters, status });
  const setProcs = (process: string[]) => setFilters({ ...filters, process });
  const setIssueIds = (issue: string[]) => setFilters({ ...filters, issue });
  // The search box is typed into at once; the URL follows (replacing, so each keystroke is not a history step).
  const [search, setSearchText] = useState(filters.q);
  const [seen, setSeen] = useState(filters.q);
  if (seen !== filters.q) {
    setSeen(filters.q);
    setSearchText(filters.q);
  }
  const setSearch = (v: string) => {
    setSearchText(v);
    setSeen(v.trim());
    router.replace(`${pathname}${solutionFiltersQuery({ ...filters, q: v.trim() })}`, { scroll: false });
  };
  const processName = useMemo(() => new Map(processes.map((p) => [p.id, p.name])), [processes]);
  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues]);
  const linked = useMemo(() => issuesBySolution(shown.links), [shown.links]);
  const q = search.trim().toLowerCase();
  const matches = (s: SolutionsData["solutions"][number], skip?: "status" | "process" | "issue") => {
    if (skip !== "status" && statuses.length && !statuses.includes(s.status satisfies SolutionStatus)) return false;
    if (skip !== "process" && procs.length && !procs.includes(s.process_id)) return false;
    if (skip !== "issue" && !matchesIssueFilter(s, linked, issueIds)) return false;
    if (!q) return true;
    const titles = (linked.get(s.id) ?? []).map((id) => {
      const i = issueById.get(id);
      return i ? `${i.number ?? ""} ${i.title}` : "";
    });
    return [s.name, processName.get(s.process_id) ?? "", ...titles].some((t) => t.toLowerCase().includes(q));
  };
  const list = shown.solutions.filter((s) => matches(s)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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
  // The Issue filter: every issue that has a solution, by number, and "No issue".
  const linkedIssueIds = [...new Set(shown.links.map((l) => l.issue_id))].filter((id) => issueById.has(id));
  const issueOptions: FilterOption[] = [
    ...[...linkedIssueIds]
      .sort((x, y) => (issueById.get(x)!.number ?? 0) - (issueById.get(y)!.number ?? 0))
      .map((id) => {
        const i = issueById.get(id)!;
        return { value: id, label: `${i.number == null ? "" : `#${i.number} `}${i.title}`, count: shown.solutions.filter((s) => (linked.get(s.id) ?? []).includes(id) && matches(s, "issue")).length };
      }),
    { value: NO_ISSUE, label: NO_ISSUE_WORDS, count: shown.solutions.filter((s) => (linked.get(s.id) ?? []).length === 0 && matches(s, "issue")).length },
  ];
  const filtered = Boolean(q) || statuses.length > 0 || procs.length > 0 || issueIds.length > 0;
  const clear = () => {
    setSearchText("");
    setSeen("");
    setFilters(NO_FILTERS);
  };
  const workspaceId = shown.solutions[0]?.workspace_id ?? "";
  const body: ReactNode =
    shown.solutions.length === 0 ? (
      <EmptyState icon={FlaskConical} data-testid="solutions-empty">
        No solutions yet. Start one from an issue.
      </EmptyState>
    ) : list.length === 0 ? (
      <EmptyState icon={FlaskConical} data-testid="solutions-empty" data-filtered action={<ClearFilters onClick={clear} />}>
        No solutions match these filters.
      </EmptyState>
    ) : (
      <ListTable className="min-w-[44rem] text-left" data-solutions-table aria-label="Solutions">
        <ListTableHeader>
          <TableRow>
            <TableHead className="px-4">Solution</TableHead>
            <TableHead className="px-3">
              <span className="inline-flex items-center">
                Fixes
                <Help {...SOLUTIONS_LIST_HELP.solves} />
              </span>
            </TableHead>
            <TableHead className="px-3">Status</TableHead>
            <TableHead className="px-3">Process</TableHead>
            <TableHead className="px-3">Updated</TableHead>
          </TableRow>
        </ListTableHeader>
        <TableBody>
          {list.map((s) => {
            const href = solutionHref(base, s.id);
            const mine = (linked.get(s.id) ?? []).map((id) => issueById.get(id)).filter((i): i is IssueRow => Boolean(i));
            const status = SOLUTION_STATUS_OPTIONS.find((o) => o.value === s.status);
            return (
              <TableRow key={s.id} data-testid="solution-row" data-solution={s.id} className="cursor-pointer" onClick={() => router.push(href)}>
                <TableCell className="px-4 py-2.5">
                  <Link href={href} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                    {s.name}
                  </Link>
                </TableCell>
                <TableCell className="max-w-72 px-3 py-2.5 text-xs whitespace-normal" data-solution-issues>
                  {mine.length > 0 ? (
                    <ul className="flex flex-col gap-0.5">
                      {mine.map((i) => (
                        <li key={i.id} className="min-w-0">
                          <Link href={issueHref(base, i)} className="hover:underline" onClick={(e) => e.stopPropagation()} data-solves={i.id}>
                            <span className="mr-1 font-mono text-muted-foreground">{i.number == null ? "" : `#${i.number}`}</span>
                            {i.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-no-issue>
                      <span className="text-muted-foreground">{NO_ISSUE_WORDS}</span>
                      {canEdit && mode === "live" && workspaceId ? <LinkIssueButton solution={s} issues={issues} processName={processName.get(s.process_id) ?? "this process"} workspaceId={workspaceId} /> : null}
                    </span>
                  )}
                </TableCell>
                <TableCell className="px-3 py-2.5 whitespace-nowrap">{status && <StatusPill label={status.label} tone={status.tone} value={s.status} />}</TableCell>
                <TableCell className="px-3 py-2.5 text-xs text-fg-2">{processName.get(s.process_id) ?? "A process"}</TableCell>
                <TableCell className="px-3 py-2.5 text-xs whitespace-nowrap text-fg-2 tabular-nums">{shortDate(s.updated_at)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </ListTable>
    );
  return (
    <div className="flex flex-col gap-3" data-solutions-list data-list-href={solutionsListHref(base)}>
      {shown.solutions.length > 0 && (
        <Toolbar label="Filter solutions">
          <ToolbarSearch value={search} onChange={setSearch} label="Search solutions" placeholder="Search solutions" />
          <FilterMenu name="Status" options={statusOptions} selected={statuses} onChange={setStatuses} />
          <FilterMenu name="Issue" options={issueOptions} selected={issueIds} onChange={setIssueIds} />
          {processOptions.length > 1 && <FilterMenu name="Process" options={processOptions} selected={procs} onChange={setProcs} />}
          {filtered && <ClearFilters onClick={clear} />}
          <ListCount data-solutions-shown>{list.length === shown.solutions.length ? `${list.length} ${list.length === 1 ? "solution" : "solutions"}` : `${list.length} of ${shown.solutions.length} solutions`}</ListCount>
        </Toolbar>
      )}
      {body}
    </div>
  );
}
