"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, CornerDownRight } from "lucide-react";
import { Help } from "@/components/help";
import { RatingPill } from "@/components/processes/rating";
import { Badge } from "@/components/ui/badge";
import { MapSkeleton } from "@/components/map/map-placeholder";
import { Skeleton } from "@/components/ui/skeleton";
import { confirmedBadges, confirmedRatings, registerEntries, stepRatingOf } from "@/lib/issues/register";
import type { ProcessCardData } from "@/lib/processes/data";
import { shortDate, type ProcessRowData } from "@/lib/processes/rows";

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
}: {
  rows: ProcessRowData[];
  /** Where each process opens, by id. */
  hrefs: Record<string, string>;
  /** The map card for a process (a server action); null when it has nothing to draw yet. */
  loadCard: (processId: string) => Promise<ProcessCardData | null>;
  /** A row's admin menu (rename, change type, archive), for editors. */
  actions?: (row: ProcessRowData) => ReactNode;
  /** What stands in for the table when there are no processes (issue #243): an empty state with the way to add one. */
  empty?: ReactNode;
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

  if (rows.length === 0) {
    if (empty) return <>{empty}</>;
    return <p className="rounded-token border border-dashed border-line p-6 text-sm text-muted-foreground">No processes yet. Start one with New process.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-token border bg-card">
      <table className="w-full min-w-0 border-collapse text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="w-8 p-0" aria-label="Open or close" />
            <th className="px-2 py-2 font-medium">Process</th>
            <th className="hidden px-2 py-2 font-medium md:table-cell">
              Type
              <Help
                label="Type"
                description="Sales pipeline is how new work comes in and is won. Client work is a recurring process this company runs for its own existing clients, like a monthly report."
                example="Northbeam's sales pipeline is a pipeline; its monthly reporting is client work."
              />
            </th>
            <th className="px-2 py-2 font-medium">
              Rating
              <Help
                label="Rating"
                description="The worst rating among this process's open issues, including the processes inside it. It is the same colour the map uses. Not rated means it has no open issue worse than Great."
                example="One open Operational risk issue on a step makes the whole process Operational risk."
              />
            </th>
            <th className="hidden px-2 py-2 text-right font-medium lg:table-cell">
              Steps
              <Help
                label="Steps"
                description="How many steps do work in this process, counting the steps of the processes inside it. Start and end markers and boxes that only group steps are not counted."
                example="A process with 5 steps and a sub-process of 3 shows 8."
              />
            </th>
            <th className="px-2 py-2 text-right font-medium">
              Open issues
              <Help
                label="Open issues"
                description="Issues you have confirmed that are still open or in progress, on this process and the processes inside it. What a run only detected is not counted until you acknowledge it."
                example="3 means three tracked issues still to fix."
              />
            </th>
            <th className="hidden px-2 py-2 font-medium lg:table-cell">
              Live version
              <Help
                label="Live version"
                description="The version people see and simulate today, and the day it was published. Editing happens in a draft and never changes it until you publish."
                example="v4 · 29 Sep means the fourth published version, published on 29 September."
              />
            </th>
            {actions && <th className="w-10 p-0" aria-label="Change the process" />}
            <th className="w-12 px-2 py-2 sm:w-20" aria-label="Open the process" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = open.has(r.id);
            const panel = `process-card-${r.id}`;
            return (
              <Fragment key={r.id}>
                <tr
                  data-process={r.id}
                  className={`cursor-pointer border-b transition-colors hover:bg-muted/50 ${isOpen ? "bg-muted/40" : ""}`}
                  onClick={() => toggle(r.id)}
                >
                  <td className="p-0 pl-1">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={panel}
                      aria-label={`${isOpen ? "Close" : "Open"} the map for ${r.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(r.id);
                      }}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronRight aria-hidden className={`size-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    </button>
                  </td>
                  <td className="min-w-20 px-2 py-2.5 sm:min-w-44">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5" style={{ paddingLeft: (r.depth - 1) * 20 }}>
                      {r.depth > 1 && <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0 font-semibold">{r.name}</span>
                      {!r.live && (
                        <Badge variant="outline" className="shrink-0 border-warn bg-warn-soft text-fg">
                          not published
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td className="hidden px-2 py-2.5 text-xs md:table-cell">{r.kind === "servicing" ? "Client work" : "Sales pipeline"}</td>
                  <td className="px-2 py-2.5">
                    <RatingPill rating={r.rating} />
                  </td>
                  <td className="hidden px-2 py-2.5 text-right tabular-nums lg:table-cell">{r.steps}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{r.openIssues > 0 ? <span className="font-semibold">{r.openIssues}</span> : <span className="text-muted-foreground">0</span>}</td>
                  <td className="hidden px-2 py-2.5 text-xs whitespace-nowrap lg:table-cell">
                    {r.version ? `v${r.version.number}${r.version.publishedAt ? ` · ${shortDate(r.version.publishedAt)}` : ""}` : <span className="text-muted-foreground">Draft only</span>}
                  </td>
                  {actions && (
                    <td className="p-0 text-right" onClick={(e) => e.stopPropagation()}>
                      {actions(r)}
                    </td>
                  )}
                  <td className="px-2 py-2.5 text-right">
                    <Link
                      href={hrefs[r.id] ?? "#"}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium whitespace-nowrap hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label={`Open ${r.name}`}
                    >
                      <span className="hidden sm:inline">Open</span>→
                    </Link>
                  </td>
                </tr>
                {isOpen && (
                  <tr id={panel} className="border-b bg-muted/20">
                    <td colSpan={actions ? 9 : 8} className="p-3 sm:p-4">
                      <MapCard row={r} card={cards[r.id] ?? { state: "loading" }} href={hrefs[r.id] ?? "#"} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
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
        <p className="rounded-token border border-dashed border-line p-4 text-sm text-muted-foreground">
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
  // Only confirmed issues reach the map (they colour a step and count in its badge), as on the process page.
  const { openIssues, rating } = useMemo(() => {
    const entries = registerEntries(data.issues, []);
    return {
      openIssues: Object.fromEntries(Object.entries(confirmedBadges(entries)).map(([id, b]) => [id, b.count])),
      rating: stepRatingOf(confirmedRatings(entries)),
    };
  }, [data.issues]);
  return (
    <div className="min-w-0 overflow-hidden rounded-token border bg-card">
      <ProcessCanvas bundle={data.bundle} openIssues={openIssues} rating={rating} showPlayback={false} showLanes={false} height="auto" legend zoomControls />
    </div>
  );
}
