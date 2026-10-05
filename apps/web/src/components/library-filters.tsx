"use client";

// The Sources library's search and filters. They narrow a list you are reading; they aren't settings, so they have no (i)s of their own.

import type { LinkTargets } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SORTS, SORT_LABELS, type LibraryQuery } from "@/lib/sources/library";
import { SOURCE_KIND_LABELS, SOURCE_KINDS } from "@/lib/sources/validate";

/** The (i) texts for the library's filters. */
export const LIBRARY_HELP = {
  unlinked: {
    label: "Not linked only",
    description:
      "Shows only the sources that aren't linked to a process, a step, an issue or a solution yet. They can't be traced from anywhere, so they don't count as evidence until you link them.",
    example:
      "Notes from a call, added last week and not linked to anything yet.",
  },
} as const;

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
      <label className="flex min-w-48 grow flex-col gap-1 text-xs font-medium text-fg-2 sm:max-w-sm">
        Search
        <Input
          type="search"
          value={query.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Title, person, words in the text…"
          aria-label="Search sources"
          autoComplete="off"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
        Kind
        <NativeSelect
          value={query.kind}
          onChange={(e) =>
            set({ kind: e.target.value as LibraryQuery["kind"] })
          }
          aria-label="Filter by kind"
        >
          <option value="all">All kinds</option>
          {SOURCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {SOURCE_KIND_LABELS[k]}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
        Process
        <NativeSelect
          value={query.processId}
          onChange={(e) => set({ processId: e.target.value })}
          aria-label="Filter by process"
        >
          <option value="all">All processes</option>
          {targets.processes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
        Sort by
        <NativeSelect
          value={query.sort}
          onChange={(e) =>
            set({ sort: e.target.value as LibraryQuery["sort"] })
          }
          aria-label="Sort sources"
        >
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </label>
      <span className="flex h-8 items-center text-sm">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={query.unlinkedOnly}
            onChange={(e) => set({ unlinkedOnly: e.target.checked })}
          />
          Not linked only
        </label>
        <Help {...LIBRARY_HELP.unlinked} />
      </span>
      {filtered && (
        <button
          type="button"
          className="h-8 text-sm text-fg-2 underline"
          onClick={onClear}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
