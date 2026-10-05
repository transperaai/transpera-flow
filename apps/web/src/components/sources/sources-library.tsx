"use client";

// The Sources library's table (issue #176, B18): one row per source with its title, kind, date, speakers and what it is linked
// to, and a flag on one that is linked to nothing. Search, a kind filter, a process filter, "Not linked only" and a sort sit above
// it. A row opens the side panel (sources-page.tsx). Presentational: the page owns the sources and what is open.

import { useMemo, useState } from "react";
import type { LinkTargets, SourceLinkRow, SourceRow } from "@transpera-flow/db";
import { LibraryFilters } from "@/components/library-filters";
import { Skeleton } from "@/components/ui/skeleton";
import { SOURCE_KIND_LABELS } from "@/lib/sources/validate";
import {
  DEFAULT_QUERY,
  filterSources,
  isFiltered,
  linkedSummary,
  sourceDate,
  type LibraryQuery,
} from "@/lib/sources/library";

const SHOWN = 2;

/** "Onboarding, Billing +1": the first few names, then how many more. */
function Names({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="text-fg-3">None</span>;
  const more = names.length - SHOWN;
  return (
    <span title={names.join(", ")}>
      {names.slice(0, SHOWN).join(", ")}
      {more > 0 && <span className="text-fg-3"> +{more}</span>}
    </span>
  );
}

export function SourcesLibrary({
  sources,
  links,
  targets,
  citations,
  openId,
  onOpen,
}: {
  sources: SourceRow[];
  links: SourceLinkRow[];
  targets: LinkTargets;
  /** How many values cite each source, by source id. */
  citations: Record<string, number>;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState<LibraryQuery>(DEFAULT_QUERY);
  const set = (patch: Partial<LibraryQuery>) =>
    setQuery((q) => ({ ...q, ...patch }));
  const rows = useMemo(
    () => filterSources(sources, links, targets, query),
    [sources, links, targets, query],
  );
  const linksOf = useMemo(() => {
    const by = new Map<string, SourceLinkRow[]>();
    for (const l of links)
      by.set(l.source_id, [...(by.get(l.source_id) ?? []), l]);
    return by;
  }, [links]);
  const filtered = isFiltered(query);

  return (
    <section aria-label="Source library" className="flex flex-col gap-3">
      <LibraryFilters
        query={query}
        filtered={filtered}
        targets={targets}
        set={set}
        onClear={() => setQuery(DEFAULT_QUERY)}
      />
      <p
        role="status"
        aria-live="polite"
        data-library-count
        className="text-xs text-fg-2"
      >
        {filtered
          ? `Showing ${rows.length} of ${sources.length} ${sources.length === 1 ? "source" : "sources"}.`
          : `${sources.length} ${sources.length === 1 ? "source" : "sources"}.`}
      </p>
      {rows.length === 0 ? (
        <p
          data-library-empty
          className="rounded-lg border border-dashed border-line p-4 text-fg-2"
        >
          No sources match. Clear the filters or try other words.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <table
            aria-label="Sources"
            className="w-full border-collapse text-left text-sm"
          >
            <thead className="bg-panel-2 text-xs text-fg-2">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Title
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 font-semibold md:table-cell"
                >
                  Kind
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 font-semibold md:table-cell"
                >
                  Date
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 font-semibold lg:table-cell"
                >
                  Speakers
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 font-semibold md:table-cell"
                >
                  Linked to
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const own = linksOf.get(s.id) ?? [];
                const linked = linkedSummary(own, targets);
                const unlinked = own.length === 0;
                const cites = citations[s.id] ?? 0;
                return (
                  <tr
                    key={s.id}
                    data-source-row={s.id}
                    data-linked={!unlinked}
                    data-open={openId === s.id}
                    className="cursor-pointer border-t border-line align-top hover:bg-panel-2 data-[open=true]:bg-accent-soft"
                    onClick={() => onOpen(s.id)}
                  >
                    <td className="max-w-0 px-3 py-2.5 md:max-w-xs">
                      <button
                        type="button"
                        className="block max-w-full text-left font-semibold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Open ${s.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(s.id);
                        }}
                      >
                        <span className="line-clamp-2 break-words">
                          {s.title}
                        </span>
                      </button>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-2 md:hidden">
                        <span>{SOURCE_KIND_LABELS[s.kind]}</span>
                        <span className="tabular-nums">{sourceDate(s)}</span>
                        {unlinked ? (
                          <UnlinkedFlag />
                        ) : (
                          <span>
                            {own.length === 1
                              ? "1 link"
                              : `${own.length} links`}
                          </span>
                        )}
                      </span>
                      {cites > 0 && (
                        <span className="mt-0.5 hidden text-xs text-fg-3 md:block">
                          {cites === 1
                            ? "Cited by 1 value"
                            : `Cited by ${cites} values`}
                        </span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 md:table-cell">
                      <span className="rounded-full border border-line px-1.5 text-[11px] font-semibold text-fg-2">
                        {SOURCE_KIND_LABELS[s.kind]}
                      </span>
                    </td>
                    <td className="hidden px-3 py-2.5 tabular-nums text-fg-2 md:table-cell">
                      {sourceDate(s)}
                    </td>
                    <td className="hidden max-w-48 px-3 py-2.5 text-fg-2 lg:table-cell">
                      {s.speakers.length ? (
                        <Names names={s.speakers} />
                      ) : (
                        <span className="text-fg-3">None</span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 md:table-cell">
                      {unlinked ? (
                        <UnlinkedFlag />
                      ) : (
                        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
                          {(
                            [
                              ["Processes", linked.processes],
                              ["Issues", linked.issues],
                              ["Solutions", linked.solutions],
                            ] as const
                          ).map(([label, names]) =>
                            names.length ? (
                              <div key={label} className="contents">
                                <dt className="text-fg-3">{label}</dt>
                                <dd className="min-w-0 truncate">
                                  <Names names={names} />
                                </dd>
                              </div>
                            ) : null,
                          )}
                          {linked.processes.length +
                            linked.issues.length +
                            linked.solutions.length ===
                            0 && (
                            <div className="contents">
                              <dt className="text-fg-3">Other</dt>
                              <dd>
                                {linked.other === 1
                                  ? "1 link"
                                  : `${linked.other} links`}
                              </dd>
                            </div>
                          )}
                        </dl>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The flag on a source linked to nothing, in the same words as the warning in its panel. */
function UnlinkedFlag() {
  return (
    <span
      data-unlinked-flag
      className="inline-flex items-center rounded-full bg-warn-soft px-2 py-0.5 text-xs font-semibold"
    >
      Not linked
    </span>
  );
}

/** What shows while the library loads (the route's loading.tsx). */
export function SourcesLibrarySkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading sources"
      data-library-loading
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-line">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-12 rounded-none" />
        ))}
      </div>
      <span className="sr-only">Loading sources…</span>
    </div>
  );
}
