// Where sources go. `live` (./live-store.ts) calls Server Actions that write
// to the database as the signed-in user; `MemorySourceStore` keeps them in
// memory for the public demo (lost on reload) and for tests.
//
// A source is never added without a link (issue #118, A53): `create` takes the links with it and refuses none.

import { linkColumns, sameTarget, linkTarget, type SourceFile, type SourceLinkRow, type SourceLinkTarget, type SourceRow } from "@transpera-flow/db";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { parseNewSource } from "./links";
import { checkSourceFile, decodeText, displayName } from "./file-check";
import { MAX_BODY, cleanSourceField, formatSpeakers, isSourceField, type Scalar, type SourceField, type SourceInput } from "./validate";

export type SaveSourceResult = { status: "ok"; source: SourceRow; links: SourceLinkRow[] } | { status: "error"; message: string };
export type RemoveSourceResult = { status: "ok" } | { status: "error"; message: string };
export type LinkSourceResult = { status: "ok"; link: SourceLinkRow } | { status: "error"; message: string };
/** A file kept as a source's original, and the text read from it (now the source's full text). */
export type AttachFileResult = { status: "ok"; file: SourceFile; body: string | null } | { status: "error"; message: string };
export type FileLinkResult = { status: "ok"; url: string } | { status: "error"; message: string };

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
  /** Keep a file as the source's original, its text becoming the source's full text (issue #182). */
  attachFile?(sourceId: string, file: File): Promise<AttachFileResult>;
  /** A short-lived link that downloads the source's original file. */
  fileLink?(sourceId: string): Promise<FileLinkResult>;
  /** The source's original file, if it has one. */
  file?(sourceId: string): Promise<SourceFile | null>;
}

/** A field as the form shows it: speakers as "a, b". */
export const sourceFieldValue = (row: SourceRow, field: SourceField): Scalar =>
  field === "speakers" ? formatSpeakers(row.speakers) || null : (row[field] ?? null);

export class MemorySourceStore implements SourceStore {
  private rows: Map<string, SourceRow>;
  private linkRows: Map<string, SourceLinkRow>;
  /** Files kept in the tab (the demo): nothing is uploaded anywhere. */
  private files = new Map<string, { meta: SourceFile; blob: Blob }>();

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

  /** In the tab only: text files are read here; spreadsheets and PDFs need the server, so a workspace. */
  async attachFile(sourceId: string, file: File): Promise<AttachFileResult> {
    const row = this.rows.get(sourceId);
    if (!row) return { status: "error", message: "That source isn't there any more." };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkSourceFile(file.name, bytes);
    if (!check.ok) return { status: "error", message: check.error };
    if (check.type === "xlsx" || check.type === "pdf") return { status: "error", message: "The demo reads .txt, .md and .csv files only. In a workspace, spreadsheets and PDFs are read too." };
    const text = (decodeText(bytes) ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_BODY) || null;
    const meta: SourceFile = { path: `${this.workspaceId}/${sourceId}/${crypto.randomUUID()}/${file.name}`, name: displayName(file.name), type: check.type, size: bytes.length };
    this.files.set(sourceId, { meta, blob: file });
    this.rows.set(sourceId, { ...row, body: text, updated_at: this.now() });
    return { status: "ok", file: meta, body: text };
  }

  async fileLink(sourceId: string): Promise<FileLinkResult> {
    const kept = this.files.get(sourceId);
    if (!kept) return { status: "error", message: "This source has no file." };
    return { status: "ok", url: URL.createObjectURL(kept.blob) };
  }

  async file(sourceId: string): Promise<SourceFile | null> {
    return this.files.get(sourceId)?.meta ?? null;
  }
}
