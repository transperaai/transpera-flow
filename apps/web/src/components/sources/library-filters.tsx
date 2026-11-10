"use client";

import type { ReactNode } from "react";
import type { LinkTargets, SourceKind } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { ClearFilters, FilterMenu, Toolbar, ToolbarSearch, type FilterOption } from "@/components/page-kit";
import { NativeSelect } from "@/components/ui/native-select";
import { SORTS, SORT_LABELS, type LibraryQuery } from "@/lib/sources/library";
import { SOURCE_KIND_LABELS, SOURCE_KINDS } from "@/lib/sources/validate";

/** The (i) texts for the library's search and filters. */
export const LIBRARY_HELP = {
  search: {
    label: "Search",
    description: "Finds sources that have every word you type, in the title, in the names of the people, or anywhere in the text. It doesn't matter if the words are in capitals.",
    example: "refund Dana finds the notes where Dana talks about refunds.",
  },
  kind: {
    label: "Kind",
    description: "Shows only one sort of material: a transcript, notes, an SOP, a spreadsheet, a data export, a screenshot or something else.",
    example: "SOP, to see only the written procedures.",
  },
  process: {
    label: "Process",
    description: "Shows only the sources linked to one process, or to one of its steps.",
    example: "Onboarding, to see what you know about onboarding.",
  },
  sort: {
    label: "Sort by",
    description: "Puts the newest or the oldest first, going by the date of the conversation or notes, or sorts by title.",
    example: "Newest first.",
  },
  unlinked: {
    label: "Not linked only",
    description: "Shows only the sources that aren't linked to a process, a step, an issue or a solution yet. They can't be traced from anywhere, so they don't count as evidence until you link them.",
    example: "Notes from a call, added last week and not linked to anything yet.",
  },
} as const;

/** How many sources each choice would show; a kind's count is left out where the page doesn't know it (a workspace's library is asked for a page at a time). */
export interface LibraryCounts {
  kinds: Partial<Record<SourceKind, number>> | null;
  processes: Record<string, number>;
}

/** One choice at a time: ticking another replaces the one that was on, unticking it shows them all. */
const single = <V extends string>(current: V | "all", next: string[]): V | "all" => (next.find((v) => v !== current) ?? (next.includes(current) ? current : "all")) as V | "all";

/**
 * The library's toolbar: search, the Kind and Process filters, "Not linked only", the sort and the count. They change the query the page
 * asks the database for. Kind and Process take one choice each (the database is asked for one), shown as the list pages' filter menus.
 */
export function LibraryFilters({
  query,
  filtered,
  targets,
  counts,
  count,
  set,
  onClear,
}: {
  query: LibraryQuery;
  filtered: boolean;
  targets: LinkTargets;
  counts: LibraryCounts;
  /** The line that says how many show. */
  count: ReactNode;
  set: (patch: Partial<LibraryQuery>) => void;
  onClear: () => void;
}) {
  const kindOptions: FilterOption[] = SOURCE_KINDS.map((k) => ({ value: k, label: SOURCE_KIND_LABELS[k], count: counts.kinds?.[k] }));
  const processOptions: FilterOption[] = targets.processes.map((p) => ({ value: p.id, label: p.name, count: counts.processes[p.id] ?? 0 }));
  return (
    <Toolbar label="Filter sources">
      <span role="search" className="flex w-full min-w-0 items-center sm:w-auto">
        <ToolbarSearch value={query.search} onChange={(search) => set({ search })} label="Search sources" placeholder="Title, person, words in the text…" />
        <Help {...LIBRARY_HELP.search} />
      </span>
      <FilterMenu name="Kind" options={kindOptions} selected={query.kind === "all" ? [] : [query.kind]} onChange={(next) => set({ kind: single(query.kind, next) })} help={<Help {...LIBRARY_HELP.kind} />} />
      {processOptions.length > 0 && (
        <FilterMenu name="Process" options={processOptions} selected={query.processId === "all" ? [] : [query.processId]} onChange={(next) => set({ processId: single(query.processId, next) })} help={<Help {...LIBRARY_HELP.process} />} />
      )}
      <span className="flex h-8 items-center text-sm">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={query.unlinkedOnly} onChange={(e) => set({ unlinkedOnly: e.target.checked })} />
          Not linked only
        </label>
        <Help {...LIBRARY_HELP.unlinked} />
      </span>
      {filtered && <ClearFilters onClick={onClear} />}
      <span className="ml-auto flex items-center gap-3">
        {count}
        <span className="flex items-center">
          <NativeSelect value={query.sort} onChange={(e) => set({ sort: e.target.value as LibraryQuery["sort"] })} aria-label="Sort sources">
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
          <Help {...LIBRARY_HELP.sort} />
        </span>
      </span>
    </Toolbar>
  );
}
