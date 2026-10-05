"use client";

import type { LinkTargets } from "@transpera-flow/db";
import { Help, HelpLabel } from "@/components/help";
import { Input } from "@/components/ui/input";
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

/** The library's search box, filters and sort. They change the query the page asks the database for. */
export function LibraryFilters({
  query,
  filtered,
  targets,
  set,
  onClear,
}: {
  query: LibraryQuery;
  filtered: boolean;
  targets: LinkTargets;
  set: (patch: Partial<LibraryQuery>) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2" role="search">
      <label className="flex min-w-48 grow flex-col gap-1 sm:max-w-sm">
        <HelpLabel {...LIBRARY_HELP.search} />
        <Input type="search" value={query.search} onChange={(e) => set({ search: e.target.value })} placeholder="Title, person, words in the text…" aria-label="Search sources" autoComplete="off" maxLength={300} />
      </label>
      <label className="flex flex-col gap-1">
        <HelpLabel {...LIBRARY_HELP.kind} />
        <NativeSelect value={query.kind} onChange={(e) => set({ kind: e.target.value as LibraryQuery["kind"] })} aria-label="Filter by kind">
          <option value="all">All kinds</option>
          {SOURCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {SOURCE_KIND_LABELS[k]}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1">
        <HelpLabel {...LIBRARY_HELP.process} />
        <NativeSelect value={query.processId} onChange={(e) => set({ processId: e.target.value })} aria-label="Filter by process">
          <option value="all">All processes</option>
          {targets.processes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1">
        <HelpLabel {...LIBRARY_HELP.sort} />
        <NativeSelect value={query.sort} onChange={(e) => set({ sort: e.target.value as LibraryQuery["sort"] })} aria-label="Sort sources">
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </label>
      <span className="flex h-8 items-center text-sm">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={query.unlinkedOnly} onChange={(e) => set({ unlinkedOnly: e.target.checked })} />
          Not linked only
        </label>
        <Help {...LIBRARY_HELP.unlinked} />
      </span>
      {filtered && (
        <button type="button" className="h-8 text-sm text-fg-2 underline" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}
