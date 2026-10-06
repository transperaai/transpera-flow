import "server-only";
import type { ImportDetails, ImportKind } from "@transpera-flow/db/csv-import";
import { createClient } from "@/lib/supabase/server";
import { isImportKind, storedImportDetails } from "./import-request";

// What the Historical data page (issue #40) needs about earlier imports: the last 50 records of the workspace for the Imports
// card, and the latest column map of each kind, offered to the wizard next time. Records are insert-only, so a second import of a
// kind adds one and the first stays listed. RLS lets every member read them. `created_by` is not selected: no one is named (#30).

export interface ImportRecord {
  id: string;
  kind: ImportKind;
  fileName: string;
  rowCount: number;
  importedAt: string;
  /** Column id to the header the person matched. */
  columnMap: Record<string, string>;
  /** Counts only; null for records made before `details` existed (or whose details aren't as expected). */
  details: ImportDetails | null;
}

export interface ImportsData {
  imports: ImportRecord[];
  /** The latest column map of each kind. */
  previous: Partial<Record<ImportKind, Record<string, string>>>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const stringMap = (v: unknown): Record<string, string> =>
  isObject(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};

export async function loadImports(workspaceId: string): Promise<ImportsData> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("datasets")
    .select("id, kind, file_name, row_count, imported_at, column_map, details")
    .eq("workspace_id", workspaceId)
    .order("imported_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(50);
  const imports: ImportRecord[] = [];
  const previous: ImportsData["previous"] = {};
  for (const d of data ?? []) {
    if (!isImportKind(d.kind)) continue;
    const columnMap = stringMap(d.column_map);
    imports.push({
      id: d.id,
      kind: d.kind,
      fileName: d.file_name,
      rowCount: d.row_count,
      importedAt: d.imported_at,
      columnMap,
      details: isObject(d.details) && Object.keys(d.details).length ? storedImportDetails(d.details) : null,
    });
    // Newest first: the first of each kind is the latest.
    if (!previous[d.kind] && Object.keys(columnMap).length) previous[d.kind] = columnMap;
  }
  return { imports, previous };
}
