// Where the Sources library gets its rows. `live` asks the database through Server Actions (a page of rows without their full
// text, and a source's text when it is opened); `memory` answers from the sources the public demo holds in the tab.

import type { SourceListRow } from "@transpera-flow/db";
import { readSourceBody, searchSourcesPage } from "@/app/w/[slug]/source-actions";
import { PAGE_SIZE, filterSources, toListRow, type LibraryQuery } from "./library";
import type { MemorySourceStore } from "./store";

export interface LibraryPage {
  rows: SourceListRow[];
  /** How many sources match the query in all, not only on this page. */
  total: number;
}

export interface LibraryBackend {
  search(query: LibraryQuery, offset: number, limit?: number): Promise<LibraryPage>;
  /** A source's full text. */
  body(id: string): Promise<string | null>;
}

export function liveLibraryBackend(workspaceId: string): LibraryBackend {
  return {
    async search(query, offset, limit = PAGE_SIZE) {
      const r = await searchSourcesPage(workspaceId, query, offset, limit);
      if (r.status === "error") throw new Error(r.message);
      return { rows: r.rows, total: r.total };
    },
    async body(id) {
      const r = await readSourceBody(id);
      if (r.status === "error") throw new Error(r.message);
      return r.body;
    },
  };
}

export function memoryLibraryBackend(store: MemorySourceStore): LibraryBackend {
  return {
    async search(query, offset, limit = PAGE_SIZE) {
      const { sources, links } = store.snapshot();
      const found = filterSources(sources, links, query);
      return { rows: found.slice(offset, offset + limit).map((s) => toListRow(s, query.search)), total: found.length };
    },
    async body(id) {
      return store.snapshot().sources.find((s) => s.id === id)?.body ?? null;
    },
  };
}
