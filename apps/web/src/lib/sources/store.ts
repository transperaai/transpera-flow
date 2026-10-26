// Where sources go. `live` (./live-store.ts) calls Server Actions that write
// to the database as the signed-in user; `MemorySourceStore` keeps them in
// memory for the public demo (lost on reload) and for tests.
//
// A source is never added without a link (issue #118, A53): `create` takes the links with it and refuses none.

import { linkColumns, sameTarget, linkTarget, type SourceLinkRow, type SourceLinkTarget, type SourceRow } from "@transpera-flow/db";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { parseNewSource } from "./links";
import { cleanSourceField, formatSpeakers, isSourceField, type Scalar, type SourceField, type SourceInput } from "./validate";

export type SaveSourceResult = { status: "ok"; source: SourceRow; links: SourceLinkRow[] } | { status: "error"; message: string };
export type RemoveSourceResult = { status: "ok" } | { status: "error"; message: string };
export type LinkSourceResult = { status: "ok"; link: SourceLinkRow } | { status: "error"; message: string };

export interface SourceStore {
  /** Add a source with the links it must have (at least one). */
  create(input: SourceInput, links: SourceLinkTarget[]): Promise<SaveSourceResult>;
  /** Save one field if its stored value is still `base` (per-field saves). Speakers travel as "a, b" text. */
  saveField(id: string, field: SourceField, base: Scalar, value: Scalar): Promise<SaveOutcome<Scalar>>;
  remove(id: string): Promise<RemoveSourceResult>;
  /** Link a source to one more thing. */
  link(sourceId: string, target: SourceLinkTarget): Promise<LinkSourceResult>;
  /** Take a link away (the source stays, and is flagged if it was its last). */
  unlink(linkId: string): Promise<RemoveSourceResult>;
}

/** A field as the form shows it: speakers as "a, b". */
export const sourceFieldValue = (row: SourceRow, field: SourceField): Scalar =>
  field === "speakers" ? formatSpeakers(row.speakers) || null : (row[field] ?? null);

export class MemorySourceStore implements SourceStore {
  private rows: Map<string, SourceRow>;
  private linkRows: Map<string, SourceLinkRow>;

  constructor(
    private readonly workspaceId: string,
    initial: readonly SourceRow[] = [],
    private readonly now: () => string = () => new Date().toISOString(),
    initialLinks: readonly SourceLinkRow[] = [],
  ) {
    this.rows = new Map(initial.map((r) => [r.id, r]));
    this.linkRows = new Map(initialLinks.map((l) => [l.id, l]));
  }

  /** Everything it holds now, oldest first: what a page shows after changes made on another page of the tab. */
  snapshot(): { sources: SourceRow[]; links: SourceLinkRow[] } {
    return { sources: [...this.rows.values()], links: [...this.linkRows.values()] };
  }

  private makeLink(sourceId: string, target: SourceLinkTarget): SourceLinkRow {
    return { id: crypto.randomUUID(), workspace_id: this.workspaceId, source_id: sourceId, ...linkColumns(target), created_at: this.now(), created_by: null };
  }

  async create(input: SourceInput, links: SourceLinkTarget[]): Promise<SaveSourceResult> {
    const parsed = parseNewSource(input, links);
    if (!parsed.ok) return { status: "error", message: parsed.error };
    const at = this.now();
    const row: SourceRow = { ...parsed.value.input, id: crypto.randomUUID(), workspace_id: this.workspaceId, created_at: at, updated_at: at };
    this.rows.set(row.id, row);
    const made: SourceLinkRow[] = [];
    for (const target of parsed.value.links) {
      if (made.some((l) => sameTarget(linkTarget(l)!, target))) continue;
      const link = this.makeLink(row.id, target);
      this.linkRows.set(link.id, link);
      made.push(link);
    }
    return { status: "ok", source: row, links: made };
  }

  async saveField(id: string, field: SourceField, base: Scalar, value: Scalar): Promise<SaveOutcome<Scalar>> {
    const row = this.rows.get(id);
    if (!row) return { status: "not_found" };
    const clean = isSourceField(field) ? cleanSourceField(field, value) : null;
    if (!clean) return { status: "error", message: "That value isn't valid." };
    const stored = sourceFieldValue(row, field);
    const next = { ...row, [field]: clean.value, updated_at: this.now() } as SourceRow;
    const shown = sourceFieldValue(next, field);
    if (stored !== base && stored !== shown) return { status: "conflict", theirs: stored };
    this.rows.set(id, next);
    return { status: "saved", value: shown };
  }

  async remove(id: string): Promise<RemoveSourceResult> {
    this.rows.delete(id);
    for (const [linkId, l] of this.linkRows) if (l.source_id === id) this.linkRows.delete(linkId);
    return { status: "ok" };
  }

  async link(sourceId: string, target: SourceLinkTarget): Promise<LinkSourceResult> {
    if (!this.rows.has(sourceId)) return { status: "error", message: "That source isn't there any more." };
    const same = [...this.linkRows.values()].some((l) => l.source_id === sourceId && sameTarget(linkTarget(l)!, target));
    if (same) return { status: "error", message: "That source is already linked to that." };
    const link = this.makeLink(sourceId, target);
    this.linkRows.set(link.id, link);
    return { status: "ok", link };
  }

  async unlink(linkId: string): Promise<RemoveSourceResult> {
    this.linkRows.delete(linkId);
    return { status: "ok" };
  }
}
