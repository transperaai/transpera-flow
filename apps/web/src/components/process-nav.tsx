"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Check, ChevronRight, ChevronsUpDown, Network, Plus } from "lucide-react";
import { companyMap, flattenCompanyMap, type ProcessListing } from "@transpera-flow/db";
import type { CreateProcessResult } from "@/app/w/[slug]/process-actions";
import { DetailBreadcrumb } from "@/components/issues/detail-layout";
import { NewProcessDialog } from "@/components/new-process-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trailOf } from "@/lib/processes/rows";
import { EDIT_ONLY } from "@/lib/phone";

/**
 * The title of a process page (issues #76, #101): breadcrumbs above it (Processes, then the processes it sits
 * inside) and the process switcher, which is the title itself. The name opens every process of the workspace,
 * indented by how deep it sits with "All processes" at the foot. Editors can start a
 * new servicing process from it.
 *
 * `part`: `all` (the default) draws the breadcrumbs and the switcher as the title, as the History page does. `crumbs` is the process
 * page's breadcrumb (the Issue page's `DetailBreadcrumb`): Processes, the processes it sits inside, then the switcher as the last crumb,
 * never a heading (the page header's h1 is the process name).
 */
export function ProcessNav({
  processes,
  current,
  hrefs,
  create,
  processesHref,
  companyMapHref,
  part = "all",
  heading = true,
}: {
  processes: ProcessListing[];
  current: string;
  /** Where each process opens, by id. */
  hrefs: Record<string, string>;
  /** Start a servicing process (signed-in editors only). */
  create?: (prev: CreateProcessResult, form: FormData) => Promise<CreateProcessResult>;
  /** The Processes page, for the breadcrumb and the foot of the switcher. */
  processesHref?: string;
  /** The company map, the same place as the Processes page's Company map button. */
  companyMapHref?: string;
  part?: "all" | "crumbs";
  /**
   * The name (or the switcher) is the page's h1. Default true. False on a page with an h1 of its own (History): the same text in a
   * plain element, so the page has one h1.
   */
  heading?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  // The company map's order: top-level processes, each followed by the child processes inside it (issue #102).
  const ordered = flattenCompanyMap(companyMap(processes));
  const here = processes.find((p) => p.id === current);
  const name = here?.name ?? "Process";
  const byId = new Map(processes.map((p) => [p.id, { id: p.id, name: p.name, parentId: p.parentId ?? null }]));
  const trail = here ? trailOf({ id: here.id, parentId: here.parentId ?? null }, byId) : [];
  const menu = { name, ordered, current, hrefs, processesHref, companyMapHref, onNew: create ? () => setAdding(true) : undefined };
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
  const Title = heading ? "h1" : "div";
  const switcher = processes.length > 1 || !!create;
  if (part === "crumbs") {
    return (
      <>
        <DetailBreadcrumb
          items={[
            ...(processesHref ? [{ label: "Processes", href: processesHref }] : []),
            ...trail.map((t) => ({ label: t.name, href: hrefs[t.id] ?? "#" })),
            { label: switcher ? <SwitchMenu {...menu} className="-my-1 h-7 gap-1 px-1.5 text-sm font-medium text-foreground" /> : name },
          ]}
        />
        {create && <NewProcessDialog open={adding} onOpenChange={setAdding} create={create} />}
      </>
    );
  }
  if (!switcher) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-1">
        {crumbs}
        <Title className="truncate px-1 font-display text-base font-bold">{name}</Title>
      </div>
    );
  }
  const title = (
    <Title className="min-w-0 text-base">
      <SwitchMenu {...menu} className="max-w-full gap-1.5 px-2 font-display text-base font-bold" />
    </Title>
  );
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1">
        {crumbs}
        {title}
      </div>
      {create && <NewProcessDialog open={adding} onOpenChange={setAdding} create={create} />}
    </>
  );
}

/** The switcher: the process's name as a button that opens every process of the workspace, the company map and "All processes". */
function SwitchMenu({
  name,
  ordered,
  current,
  hrefs,
  processesHref,
  companyMapHref,
  onNew,
  className,
}: {
  name: string;
  ordered: { process: ProcessListing; depth: number }[];
  current: string;
  hrefs: Record<string, string>;
  processesHref?: string;
  companyMapHref?: string;
  /** Start a new process (editors only). */
  onNew?: () => void;
  className: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className={className} aria-label={`Process: ${name}. Switch process`}>
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
        {(onNew || processesHref) && <DropdownMenuSeparator />}
        {onNew && (
          <DropdownMenuItem className={EDIT_ONLY} data-edit-entry onSelect={onNew}>
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
  );
}
