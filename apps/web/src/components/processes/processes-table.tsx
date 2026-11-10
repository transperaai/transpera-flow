"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, ChevronRight, CornerDownRight, Workflow } from "lucide-react";
import { PROCESS_CATEGORIES, PROCESS_CATEGORY_HELP, PROCESS_CATEGORY_LABELS } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { EmptyState } from "@/components/page-kit";
import { EditMarker, ListTable, ListTableHeader } from "@/components/processes/list-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { MapSkeleton } from "@/components/map/map-placeholder";
import { Skeleton } from "@/components/ui/skeleton";
import { confirmedRatings, registerEntries, stepRatingOf } from "@/lib/issues/register";
import type { ProcessCardData } from "@/lib/processes/data";
import { shortDate, type CompanyRowData, type ProcessRowData } from "@/lib/processes/rows";
import { EDIT_ONLY } from "@/lib/phone";

// The map is heavy and only needed once a row is opened.
const ProcessCanvas = dynamic(() => import("@/components/process-canvas").then((m) => m.ProcessCanvas), {
  ssr: false,
  loading: () => <MapSkeleton height={256} />,
});

type Card = { state: "loading" } | { state: "none" } | { state: "error" } | { state: "ready"; data: ProcessCardData };

/**
 * Every process as a table, sub-processes indented under their parent (issue #101). A row opens in place to its map
 * card (the goal line and a read-only map); "Open" goes to the process's own page.
 */
export function ProcessesTable({
  rows,
  hrefs,
  loadCard,
  actions,
  empty,
  filtered = false,
  company,
}: {
  /** The company map's own row, pinned above the processes. */
  company?: CompanyRowData;
  rows: ProcessRowData[];
  /** Where each process opens, by id. */
  hrefs: Record<string, string>;
  /** The map card for a process (a server action); null when it has nothing to draw yet. */
  loadCard: (processId: string) => Promise<ProcessCardData | null>;
  /** A row's admin menu (rename, change type, archive), for editors. */
  actions?: (row: ProcessRowData) => ReactNode;
  /** What stands in for the table when there are no processes (issue #243): an empty state with the way to add one. */
  empty?: ReactNode;
  /** A search or filter is on, so no rows means nothing matched. */
  filtered?: boolean;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [cards, setCards] = useState<Record<string, Card>>({});

  const toggle = (id: string) => {
    const opening = !open.has(id);
    setOpen((prev) => {
      const next = new Set(prev);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    if (!opening || cards[id]?.state === "ready" || cards[id]?.state === "none") return;
    setCards((c) => ({ ...c, [id]: { state: "loading" } }));
    loadCard(id)
      .then((data) => setCards((c) => ({ ...c, [id]: data ? { state: "ready", data } : { state: "none" } })))
      .catch(() => setCards((c) => ({ ...c, [id]: { state: "error" } })));
  };

  if (rows.length === 0 && !company) {
    if (empty) return <>{empty}</>;
    return (
      <EmptyState icon={Workflow} data-processes-empty data-filtered={filtered ? "" : undefined}>
        {filtered ? "No process matches. Clear the filters or try other words." : "No processes yet. Start one with New process."}
      </EmptyState>
    );
  }
  const columns = actions ? 8 : 7;
  return (
    <ListTable aria-label="Processes">
      <ListTableHeader>
        <TableRow>
          <TableHead className="w-9 p-0" aria-label="Open or close" />
          <TableHead className="px-3">Process</TableHead>
          <TableHead className="hidden px-3 md:table-cell">
            <span className="inline-flex items-center">
              Type
              <Help label="Type" description={PROCESS_CATEGORIES.map((c) => `${PROCESS_CATEGORY_LABELS[c]}: ${PROCESS_CATEGORY_HELP[c]}`).join(" ")} example="Northbeam's lead pipeline is Sales; its monthly reporting is Routine client work." />
            </span>
          </TableHead>
          <TableHead className="hidden px-3 text-right lg:table-cell">
            <span className="inline-flex items-center">
              Steps
              <Help
                label="Steps"
                description="How many steps do work in this process, counting the steps of the processes inside it. Start and end markers and boxes that only group steps are not counted."
                example="A process with 5 steps and a sub-process of 3 shows 8."
              />
            </span>
          </TableHead>
          <TableHead className="px-3 text-right">
            <span className="inline-flex items-center">
              Open issues
              <Help
                label="Open issues"
                description="Issues you have confirmed that are still open or in progress, on this process and the processes inside it. What a run only detected is not counted until you acknowledge it."
                example="3 means three tracked issues still to fix."
              />
            </span>
          </TableHead>
          <TableHead className="hidden px-3 lg:table-cell">
            <span className="inline-flex items-center">
              Live version
              <Help
                label="Live version"
                description="The version people see and simulate today, and the day it was published. Editing happens in a draft and never changes it until you publish."
                example="v4 · 29 Sep means the fourth published version, published on 29 September."
              />
            </span>
          </TableHead>
          {actions && <TableHead className="w-10 p-0" aria-label="Change the process" />}
          <TableHead className="px-3" aria-label="Open the process" />
        </TableRow>
      </ListTableHeader>
      <TableBody>
        {company && (
          <TableRow data-company-row className="bg-muted/30">
            <TableCell className="p-0" />
            <TableCell className="min-w-20 px-3 py-2.5 sm:min-w-44">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="min-w-0 font-semibold">Company map</span>
                {company.draft && (
                  <Badge data-draft-open variant="outline" className="shrink-0 border-warn bg-warn-soft text-fg">
                    Draft open
                  </Badge>
                )}
              </span>
            </TableCell>
            <TableCell className="hidden px-3 py-2.5 text-xs md:table-cell">Company</TableCell>
            <TableCell className="hidden px-3 py-2.5 text-right text-muted-foreground lg:table-cell">·</TableCell>
            <TableCell className="px-3 py-2.5 text-right text-muted-foreground">·</TableCell>
            <TableCell className="hidden px-3 py-2.5 text-xs whitespace-nowrap lg:table-cell" data-company-version>
              {company.version ? `Version ${company.version.number}${company.version.publishedAt ? ` · ${shortDate(company.version.publishedAt)}` : ""}` : <span className="text-muted-foreground">Draft only</span>}
            </TableCell>
            {/* The company map's three buttons share the menu and Open columns, on one line. */}
            <TableCell colSpan={actions ? 2 : 1} className="px-3 py-2">
              <span className="flex flex-nowrap items-center justify-end gap-1" data-company-actions>
                {company.historyHref && (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={company.historyHref}>History</Link>
                  </Button>
                )}
                {company.editHref && (
                  <Button variant="outline" size="sm" asChild className={EDIT_ONLY}>
                    <Link href={company.editHref} data-edit-entry>
                      <EditMarker /> Edit
                    </Link>
                  </Button>
                )}
                <Button variant="outline" size="sm" asChild>
                  <Link href={company.href} aria-label="Open the company map">
                    Open <ArrowRight aria-hidden />
                  </Link>
                </Button>
              </span>
            </TableCell>
          </TableRow>
        )}
        {rows.length === 0 && (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns} className="px-3 py-6 text-center text-sm text-muted-foreground" data-processes-empty data-filtered="">
              No process matches. Clear the filters or try other words.
            </TableCell>
          </TableRow>
        )}
        {rows.map((r) => {
          const isOpen = open.has(r.id);
          const panel = `process-card-${r.id}`;
          return (
            <Fragment key={r.id}>
              <TableRow data-process={r.id} data-state={isOpen ? "open" : undefined} className="cursor-pointer data-[state=open]:bg-muted/40" onClick={() => toggle(r.id)}>
                <TableCell className="p-0 pl-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-expanded={isOpen}
                    aria-controls={panel}
                    aria-label={`${isOpen ? "Close" : "Open"} the map for ${r.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r.id);
                    }}
                    className="text-muted-foreground"
                  >
                    <ChevronRight aria-hidden className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  </Button>
                </TableCell>
                <TableCell className="min-w-20 px-3 py-2.5 sm:min-w-44">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5" style={{ paddingLeft: (r.depth - 1) * 20 }}>
                    {r.depth > 1 && <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 font-semibold">{r.name}</span>
                    {!r.live && (
                      <Badge variant="outline" className="shrink-0 border-warn bg-warn-soft text-fg">
                        not published
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="hidden px-3 py-2.5 text-xs md:table-cell">{PROCESS_CATEGORY_LABELS[r.category]}</TableCell>
                <TableCell className="hidden px-3 py-2.5 text-right tabular-nums lg:table-cell">{r.steps}</TableCell>
                <TableCell className="px-3 py-2.5 text-right tabular-nums">{r.openIssues > 0 ? <span className="font-semibold">{r.openIssues}</span> : <span className="text-muted-foreground">0</span>}</TableCell>
                <TableCell className="hidden px-3 py-2.5 text-xs whitespace-nowrap tabular-nums lg:table-cell">
                  {r.version ? `v${r.version.number}${r.version.publishedAt ? ` · ${shortDate(r.version.publishedAt)}` : ""}` : <span className="text-muted-foreground">Draft only</span>}
                </TableCell>
                {actions && (
                  <TableCell className="p-0 text-center" onClick={(e) => e.stopPropagation()}>
                    {actions(r)}
                  </TableCell>
                )}
                <TableCell className="px-3 py-2 text-right">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={hrefs[r.id] ?? "#"} onClick={(e) => e.stopPropagation()} aria-label={`Open ${r.name}`}>
                      <span className="hidden sm:inline">Open</span>
                      <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
              {isOpen && (
                <TableRow id={panel} className="bg-muted/20 hover:bg-muted/20">
                  <TableCell colSpan={columns} className="p-3 sm:p-4">
                    <MapCard row={r} card={cards[r.id] ?? { state: "loading" }} href={hrefs[r.id] ?? "#"} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </ListTable>
  );
}

/** A process's map card: its goal line, then its map, read-only. */
function MapCard({ row, card, href }: { row: ProcessRowData; card: Card; href: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {row.description && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Goal:</span> {row.description}
        </p>
      )}
      {card.state === "loading" && <Skeleton className="h-64 w-full" role="status" aria-label="Loading the map" />}
      {card.state === "error" && (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load the map. Close the row and open it again.
        </p>
      )}
      {card.state === "none" && (
        <p className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">
          {row.live ? "Nothing to draw yet: this process has no steps." : "This process hasn't been published yet, so there is no live map. Open it to see its draft."}{" "}
          <Link href={href} className="font-medium text-accent hover:underline">
            Open {row.name} →
          </Link>
        </p>
      )}
      {card.state === "ready" && <ReadOnlyMap data={card.data} />}
    </div>
  );
}

function ReadOnlyMap({ data }: { data: ProcessCardData }) {
  // Only confirmed issues reach the map (they colour a step; no badges, QA round 2), as on the process page.
  const rating = useMemo(() => stepRatingOf(confirmedRatings(registerEntries(data.issues, []))), [data.issues]);
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-card">
      <ProcessCanvas bundle={data.bundle} rating={rating} showPlayback={false} showLanes={false} height="auto" legend zoomControls />
    </div>
  );
}
