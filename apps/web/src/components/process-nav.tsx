"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Check, ChevronRight, ChevronsUpDown, Network, Plus } from "lucide-react";
import { companyMap, flattenCompanyMap, type ProcessListing } from "@transpera-flow/db";
import { RATING_LABELS, type Rating } from "@transpera-flow/engine";
import type { CreateProcessResult } from "@/app/w/[slug]/process-actions";
import { NewProcessDialog } from "@/components/new-process-dialog";
import { RatingDot } from "@/components/processes/rating";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trailOf } from "@/lib/processes/rows";

/**
 * The title of a process page (issues #76, #101): breadcrumbs above it (Processes, then the processes it sits
 * inside) and the process switcher, which is the title itself. The name opens every process of the workspace,
 * indented by how deep it sits and marked with its rating, with "All processes" at the foot. Editors can start a
 * new servicing process from it.
 */
export function ProcessNav({
  processes,
  current,
  hrefs,
  create,
  ratings,
  processesHref,
  companyMapHref,
}: {
  processes: ProcessListing[];
  current: string;
  /** Where each process opens, by id. */
  hrefs: Record<string, string>;
  /** Start a servicing process (signed-in editors only). */
  create?: (prev: CreateProcessResult, form: FormData) => Promise<CreateProcessResult>;
  /** Each process's rating (the worst of its open issues), by id; none shows a grey dot. */
  ratings?: Record<string, Rating | null>;
  /** The Processes page, for the breadcrumb and the foot of the switcher. */
  processesHref?: string;
  /** The company map, the same place as the Processes page's Company map button. */
  companyMapHref?: string;
}) {
  const [adding, setAdding] = useState(false);
  // The company map's order: top-level processes, each followed by the child processes inside it (issue #102).
  const ordered = flattenCompanyMap(companyMap(processes));
  const here = processes.find((p) => p.id === current);
  const name = here?.name ?? "Process";
  const byId = new Map(processes.map((p) => [p.id, { id: p.id, name: p.name, parentId: p.parentId ?? null }]));
  const trail = here ? trailOf({ id: here.id, parentId: here.parentId ?? null }, byId) : [];
  const crumbs = (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
      {processesHref && (
        <Link href={processesHref} className="hover:text-accent hover:underline">
          Processes
        </Link>
      )}
      {trail.map((t, i) => (
        <Fragment key={t.id}>
          {(processesHref || i > 0) && <ChevronRight aria-hidden className="size-3 shrink-0" />}
          <Link href={hrefs[t.id] ?? "#"} className="max-w-40 truncate hover:text-accent hover:underline">
            {t.name}
          </Link>
        </Fragment>
      ))}
      {(processesHref || trail.length > 0) && <ChevronRight aria-hidden className="size-3 shrink-0" />}
    </nav>
  );
  if (processes.length <= 1 && !create) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-1">
        {crumbs}
        <h1 className="truncate px-1 font-display text-base font-bold">{name}</h1>
      </div>
    );
  }
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1">
        {crumbs}
        <h1 className="min-w-0 text-base">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="max-w-full gap-1.5 px-2 font-display text-base font-bold" aria-label={`Process: ${name}. Switch process`}>
                <span className="truncate">{name}</span>
                <ChevronsUpDown className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[70vh] min-w-72 max-w-[calc(100vw-2rem)]">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Switch to another process</DropdownMenuLabel>
              {companyMapHref && (
                <DropdownMenuItem asChild>
                  <Link href={companyMapHref} className="font-medium text-accent">
                    <Network /> Company map
                  </Link>
                </DropdownMenuItem>
              )}
              {ordered.map(({ process: p, depth }) => (
                <DropdownMenuItem key={p.id} asChild>
                  <Link href={hrefs[p.id]!} aria-current={p.id === current ? "page" : undefined} style={{ paddingLeft: 8 + (depth - 1) * 16 }}>
                    <RatingDot rating={ratings?.[p.id] ?? null} />
                    <span className="sr-only">{ratings?.[p.id] ? `${RATING_LABELS[ratings[p.id]!]}: ` : "Not rated: "}</span>
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {p.kind === "servicing" && <Badge variant="secondary">servicing</Badge>}
                    {!p.live && (
                      <Badge variant="outline" className="border-warn bg-warn-soft text-fg">
                        not published
                      </Badge>
                    )}
                    {p.id === current && <Check className="text-accent" aria-hidden />}
                  </Link>
                </DropdownMenuItem>
              ))}
              {(create || processesHref) && <DropdownMenuSeparator />}
              {create && (
                <DropdownMenuItem onSelect={() => setAdding(true)}>
                  <Plus /> New process…
                </DropdownMenuItem>
              )}
              {processesHref && (
                <DropdownMenuItem asChild>
                  <Link href={processesHref} className="font-medium text-accent">
                    All processes →
                  </Link>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </h1>
      </div>
      {create && <NewProcessDialog open={adding} onOpenChange={setAdding} create={create} />}
    </>
  );
}
