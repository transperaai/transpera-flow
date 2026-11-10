"use client";

// The Issues list (issue #113, A48; prototype: "Issues"): the problems people have confirmed, with Open / Resolved / All
// and rating filters (both kept in the URL), sorted by rating and then cost. A cost comes from the latest run of the live
// process, simulated here in a worker as on the process page; until it is back the issues are sorted without it.
import { isReadOnly, type ScreenMode } from "@/lib/mode";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { retiredSteps, ModelError, toEngineModel, type IssueRow, type ProcessBundle, type ScenarioRow, type SourceRow } from "@transpera-flow/db";
import { RATING_LABELS, detectBrokenScenarios, ratingOfStored, resolveMoney, type IssueCost, type Rating } from "@transpera-flow/engine";
import { AcknowledgeDialog } from "@/components/acknowledge-dialog";
import { Help } from "@/components/help";
import { LIST_HELP } from "@/lib/issues/help";
import { IssueStatusPill } from "@/components/issues/status-pill";
import { RatingPill } from "@/components/overview/rating-pill";
import { Button } from "@/components/ui/button";
import { ListCount, ListTable, ListTableHeader } from "@/components/processes/list-table";
import { PageHeader } from "@/components/shell/page";
import { TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { emptyDraft, issueFormOptions, toSaveInput } from "@/lib/issues/draft";
import { DEFAULT_LIST_STATE, LISTED_STATUSES, NO_SOLUTIONS, RATINGS_WORST_FIRST, UNASSIGNED, facetCounts, filtersOn, isOpenIssue, issueHref, listIssues, listQuery, ownersOf, parseListState, processesOf, shortDate, visibleIssues, type ListState } from "@/lib/issues/pages";
import { STATUS_LABELS } from "@/lib/issues/register";
import { STATUS_TONE } from "@/components/issues/status-pill";
import { ClearFilters, EmptyState, FilterMenu, Toolbar, ToolbarSearch, type FilterOption } from "@/components/page-kit";
import { NO_SOLUTIONS_DATA, solutionSummaries, solutionsListHref, type SolutionsData } from "@/lib/solutions/cards";
import { startSolutionHref } from "@/lib/solutions/list";
import { solutionEditorHref } from "@/lib/solutions/links";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { perceptionGapDetections } from "@/lib/issues/perception";
import { useIssues } from "@/lib/issues/use-issues";
import { useDetectedIssues } from "@/lib/issues/use-detected";
import { visibleFindings } from "@/lib/rules/edit";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { useAbsenceTest } from "@/lib/sim/absence";
import { useSimulation } from "@/lib/sim/use-simulation";
import { cn } from "@/lib/utils";
import { namedForViewer, viewerOf } from "@/lib/viewer";
import { EDIT_ONLY } from "@/lib/phone";

export interface Named {
  id: string;
  name: string;
}


export function IssuesPage({
  bundle,
  issues,
  scenarios,
  processes,
  sources = [],
  mode,
  base,
  liveRevisions,
  solutions,
  description,
}: {
  bundle: ProcessBundle;
  issues: IssueRow[];
  scenarios: ScenarioRow[];
  processes: Named[];
  /** The workspace's sources, which the Acknowledge dialog can link to an issue. */
  sources?: SourceRow[];
  mode: ScreenMode;
  /** Where the workspace's pages live: `/w/<slug>` or `/demo`. An issue's page is `<base>/issues/<number>`. */
  base: string;
  liveRevisions?: Record<string, string>;
  /** The workspace's solutions and which issues they solve, for the "Solutions" column (the demo keeps its own in this tab). */
  solutions?: SolutionsData;
  /** The sentence under the page's title. The list draws the page's header itself, so New issue can sit at its right. */
  description?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const state = useIssues(bundle.workspace.id, issues, mode, liveRevisions ?? { [bundle.process.id]: bundle.revision.id });
  // The filters are the URL's: Back and Forward change them, and so does a link.
  const params = useSearchParams();
  const filters = useMemo<ListState>(() => parseListState(Object.fromEntries(params.entries())), [params]);
  // "Log a new issue" on the Solutions list opens the Issues list with the New issue dialog already open (`?new=1`), and `then=solution`
  // takes the person on to the Editor for the issue once it is saved (Q12: every solution starts from an issue).
  const [newOpen, setNewOpen] = useState(!isReadOnly(mode) && params.get("new") === "1");
  const thenSolution = params.get("then") === "solution";

  const setFilter = (next: ListState) => {
    // The filters are in the URL, so a link or a reload shows the same list.
    router.push(`${pathname}${listQuery(next)}`, { scroll: false });
  };
  // The search box is typed into at once; the URL follows (replacing, so each keystroke is not a history step).
  const [search, setSearch] = useState(filters.q);
  const [seen, setSeen] = useState(filters.q);
  if (seen !== filters.q) {
    // Back, Forward or Clear filters changed the URL's search.
    setSeen(filters.q);
    setSearch(filters.q);
  }
  const onSearch = (v: string) => {
    setSearch(v);
    setSeen(v.trim());
    router.replace(`${pathname}${listQuery({ ...filters, q: v.trim() })}`, { scroll: false });
  };

  const costs = useIssueCosts(bundle, scenarios);
  const costOf = (i: IssueRow): IssueCost | null => (i.detected_key ? (costs?.get(i.detected_key) ?? null) : null);

  const options = useMemo(
    () =>
      issueFormOptions({
        processes,
        steps: [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)],
        people: namedForViewer(viewerOf(bundle), bundle.people.filter((p) => p.active)),
        sources,
      }),
    [processes, bundle, sources],
  );
  const stepNames = useMemo(() => new Map([...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)].map((s) => [s.id, s.name])), [bundle]);
  const processNames = useMemo(() => new Map(processes.map((p) => [p.id, p.name])), [processes]);
  const peopleNames = useMemo(() => new Map(namedForViewer(viewerOf(bundle), bundle.people).map((p) => [p.id, p.name])), [bundle]);
  const inTab = useDemoSolutions();
  const solutionData = mode === "demo" ? inTab : (solutions ?? NO_SOLUTIONS_DATA);
  const summaries = useMemo(() => solutionSummaries(solutionData), [solutionData]);

  const facets = {
    status: facetCounts(state.issues, filters, "status"),
    ratings: facetCounts(state.issues, filters, "ratings"),
    owners: facetCounts(state.issues, filters, "owners"),
    processes: facetCounts(state.issues, filters, "processes"),
  };
  const list = listIssues(state.issues, filters, costOf);
  const canEdit = !isReadOnly(mode);
  const statusOptions: FilterOption[] = LISTED_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s], count: facets.status.get(s) ?? 0, dot: `var(--${STATUS_TONE[s]})` }));
  const ratingOptions: FilterOption[] = RATINGS_WORST_FIRST.map((r) => ({ value: r, label: RATING_LABELS[r], count: facets.ratings.get(r) ?? 0, dot: `var(--rate-${r})` }));
  const ownerIds = [...new Set(visibleIssues(state.issues).flatMap(ownersOf))];
  const ownerOptions: FilterOption[] = [
    ...ownerIds.map((id) => ({ value: id, label: peopleNames.get(id) ?? "Someone", count: facets.owners.get(id) ?? 0 })).sort((a, b) => a.label.localeCompare(b.label)),
    { value: UNASSIGNED, label: "Unassigned", count: facets.owners.get(UNASSIGNED) ?? 0 },
  ];
  const processIds = [...new Set(visibleIssues(state.issues).flatMap(processesOf))].filter((id) => processNames.has(id));
  const processOptions: FilterOption[] = processIds
    .map((id) => ({ value: id, label: processNames.get(id) ?? "A process", count: facets.processes.get(id) ?? 0 }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const shownCount = list.length;
  const allCount = visibleIssues(state.issues).length;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Issues"
        eyebrow="Improve"
        description={description}
        actions={
          canEdit ? (
            <span className={`flex items-center ${EDIT_ONLY}`} data-edit-entry>
              <Button type="button" onClick={() => setNewOpen(true)}>
                + New issue
              </Button>
              <Help {...LIST_HELP.newIssue} />
            </span>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3">
        <Toolbar>
          <ToolbarSearch value={search} onChange={onSearch} label="Search issues" placeholder="Search issues" />
          <FilterMenu name="Status" options={statusOptions} selected={filters.status} onChange={(status) => setFilter({ ...filters, status: LISTED_STATUSES.filter((s) => status.includes(s)) })} help={<Help {...LIST_HELP.show} />} />
          <FilterMenu name="Owner" options={ownerOptions} selected={filters.owners} onChange={(owners) => setFilter({ ...filters, owners })} help={<Help {...LIST_HELP.owner} />} />
          <FilterMenu name="Rating" options={ratingOptions} selected={filters.ratings} onChange={(ratings) => setFilter({ ...filters, ratings: RATINGS_WORST_FIRST.filter((r) => ratings.includes(r)) })} help={<Help {...LIST_HELP.rating} />} />
          {processOptions.length > 1 && <FilterMenu name="Process" options={processOptions} selected={filters.processes} onChange={(processes) => setFilter({ ...filters, processes })} help={<Help {...LIST_HELP.process} />} />}
          {filtersOn(filters) && <ClearFilters onClick={() => setFilter(DEFAULT_LIST_STATE)} />}
          <ListCount data-issue-count>{shownCount === allCount ? `${allCount} ${allCount === 1 ? "issue" : "issues"}` : `${shownCount} of ${allCount} issues`}</ListCount>
        </Toolbar>

        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}

        {list.length === 0 ? (
          <EmptyState icon={CircleAlert} data-empty action={filtersOn(filters) ? <ClearFilters onClick={() => setFilter(DEFAULT_LIST_STATE)} /> : undefined}>
            No issues here. Acknowledge an insight, or add one by hand.
          </EmptyState>
        ) : (
          <ListTable className="min-w-[44rem] text-left" data-issues-table aria-label="Issues">
            <ListTableHeader>
              <TableRow>
                <TableHead className="px-4">
                  <span className="inline-flex items-center">
                    Issue
                    <Help {...LIST_HELP.table} />
                  </span>
                </TableHead>
                <TableHead className="px-3">Rating</TableHead>
                <TableHead className="px-3">Step</TableHead>
                <TableHead className="px-3">Owners</TableHead>
                <TableHead className="px-3">Status</TableHead>
                <TableHead className="px-3">
                  <span className="inline-flex items-center">
                    Solutions
                    <Help {...LIST_HELP.solutions} />
                  </span>
                </TableHead>
              </TableRow>
            </ListTableHeader>
            <TableBody>
              {list.map((i) => {
                const touched = i.links.length
                  ? i.links.map((l) => (l.step_id ? (stepNames.get(l.step_id) ?? "A step") : `Whole process: ${processNames.get(l.process_id ?? "") ?? "process"}`))
                  : [];
                const owners = (i.owner_ids.length ? i.owner_ids : i.owner_person_id ? [i.owner_person_id] : []).map((id) => peopleNames.get(id) ?? "Someone");
                const sol = summaries[i.id] ?? NO_SOLUTIONS;
                const href = issueHref(base, i);
                return (
                  <TableRow key={i.id} data-issue-row={i.number ?? i.id} className={cn("cursor-pointer", !isOpenIssue(i) && "opacity-70")} onClick={() => router.push(href)}>
                    <TableCell className="px-4 py-2.5">
                      <Link href={href} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        <span className="mr-1.5 font-mono text-xs text-muted-foreground">{i.number ? `#${i.number}` : ""}</span>
                        {i.title}
                      </Link>
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <RatingPillOf issue={i} />
                    </TableCell>
                    <TableCell className="max-w-56 px-3 py-2.5 text-xs whitespace-normal text-fg-2">{touched.join(", ") || "—"}</TableCell>
                    <TableCell className="px-3 py-2.5 text-xs whitespace-normal">{owners.join(", ") || <span className="text-muted-foreground">No owner</span>}</TableCell>
                    <TableCell className="px-3 py-2.5 whitespace-nowrap">
                      <IssueStatusPill status={i.status} />
                      {i.resolved_at && !isOpenIssue(i) && <div className="text-xs text-muted-foreground">{shortDate(i.resolved_at)}</div>}
                    </TableCell>
                    <TableCell className="px-3 py-2.5 text-xs whitespace-nowrap" data-solutions>
                      {sol.tested ? (
                        <span>
                          {sol.tested} tested{sol.passed ? <span className="ml-1 text-good">✓ passed</span> : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </ListTable>
        )}
      </div>

      <AcknowledgeDialog
        open={newOpen}
        mode="new"
        draft={emptyDraft(bundle.process.id)}
        options={options}
        busy={state.busy}
        error={state.error}
        onClose={() => setNewOpen(false)}
        onSubmit={async (draft) => {
          const saved = await state.save(toSaveInput(draft, options));
          if (saved && thenSolution) {
            router.push(startSolutionHref(base, saved, solutionsListHref(base)) ?? solutionEditorHref(base, bundle.process.id, { issueId: saved.id, from: solutionsListHref(base) }));
          }
          return saved;
        }}
      />
    </div>
  );
}

export function RatingPillOf({ issue }: { issue: Pick<IssueRow, "severity"> }) {
  return <RatingPill rating={ratingOf(issue)} />;
}

const ratingOf = (i: Pick<IssueRow, "severity">): Rating => ratingOfStored(i.severity);

/**
 * What the latest run of the live process says each issue costs a month, by detection key: the list sorts by rating and
 * then by this. The run is simulated in a worker. Null until every cost is in (the "too busy" ones need an extra run),
 * so the list is sorted by cost once, not reshuffled as each arrives.
 */
function useIssueCosts(
  bundle: ProcessBundle,
  scenarios: ScenarioRow[],
): Map<string, IssueCost> | null {
  const model = useMemo(() => {
    try {
      return toEngineModel(bundle);
    } catch (err) {
      if (err instanceof ModelError) return null;
      throw err;
    }
  }, [bundle]);
  const sim = useSimulation(model);
  const result = sim.run?.result ?? null;
  const broken = useMemo(() => (model ? detectBrokenScenarios(model, scenarios, retiredSteps(bundle)) : []), [model, scenarios, bundle]);
  const gaps = useMemo(() => perceptionGapDetections(bundle.steps), [bundle.steps]);
  const rules = ANALYSIS_DEFAULTS;
  const absence = useAbsenceTest(model && result && sim.status === "done" ? model : null, result?.seed ?? 1, resolveMoney(rules).absenceWeeks);
  const found = useDetectedIssues(model, result, rules, bundle.process.id, bundle.workspace.settings.currency, absence);
  return useMemo(() => {
    // A model that can't be simulated has no costs to wait for.
    if (model && !found) return null;
    const detected = visibleFindings(rules, found ? [...broken, ...found, ...gaps] : gaps);
    // Still waiting for a role's shadow price: the cost of a "too busy" issue is missing until it is in.
    if (detected.some((d) => d.key.startsWith("capacity:") && d.roleId && d.cost.perMonth == null && d.cost.hoursPerMonth == null && !d.cost.payHidden)) return null;
    return new Map(detected.map((d) => [d.key, d.cost as IssueCost]));
  }, [model, found, broken, gaps, rules]);
}
