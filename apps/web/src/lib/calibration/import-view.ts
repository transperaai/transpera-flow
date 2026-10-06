// What the import wizard shows of a file (issue #40), as pure functions so the privacy rules are testable: client and person
// values are never shown (the mapper counts them, the preview labels them "Client 1", "Person 1"), and amounts are shown
// only to owners and editors. Nothing here is stored.

import type { ImportColumn, ImportKindSpec } from "@transpera-flow/db/csv-import";

const cut = (v: string, max = 40) => (v.length > max ? `${v.slice(0, max)}…` : v);

/** Up to three sample values of a column for the mapper, or how many different values there are for an identity column. */
export function sampleLine(column: ImportColumn, samples: readonly string[][], index: number | null, canSeeAmounts: boolean): string {
  if (index === null) return "";
  const values = samples.map((r) => (r[index] ?? "").trim()).filter((v) => v !== "");
  if (!values.length) return `Nothing in the first ${samples.length} row${samples.length === 1 ? "" : "s"}.`;
  if (column.type === "client" || column.type === "person") {
    const n = new Set(values).size;
    return `${n} different value${n === 1 ? "" : "s"} in the first ${samples.length} row${samples.length === 1 ? "" : "s"}`;
  }
  if (column.type === "amount" && !canSeeAmounts) return "Amounts are shown to owners and editors only.";
  return values.slice(0, 3).map((v) => cut(v)).join(", ");
}

export interface PreviewTable {
  columns: { id: string; label: string }[];
  rows: string[][];
}

/**
 * The first parsed rows as a table, one column for each matched column of the kind. A `client` column shows "Client 1",
 * "Client 2"… and a `person` column "Person 1"…, numbered in order of first appearance, never the file's values. An amount
 * shows only to owners and editors (otherwise "—").
 */
export function previewTable(spec: ImportKindSpec, matched: ReadonlySet<string>, preview: readonly Record<string, string>[], canSeeAmounts: boolean): PreviewTable {
  const columns = spec.columns.filter((c) => matched.has(c.id));
  const numbering = new Map<string, Map<string, number>>();
  const label = (c: ImportColumn, value: string): string => {
    if (value === "") return "";
    if (c.type === "client" || c.type === "person") {
      const seen = numbering.get(c.id) ?? new Map<string, number>();
      numbering.set(c.id, seen);
      if (!seen.has(value)) seen.set(value, seen.size + 1);
      return `${c.type === "client" ? "Client" : "Person"} ${seen.get(value)}`;
    }
    if (c.type === "amount") return canSeeAmounts ? value : "—";
    return cut(value, 60);
  };
  return {
    columns: columns.map((c) => ({ id: c.id, label: c.label })),
    rows: preview.map((r) => columns.map((c) => label(c, r[c.id] ?? ""))),
  };
}

/** Problems with the matched columns: a required column with no header, and a header used for two columns (both say so). */
export function mappingProblems(spec: ImportKindSpec, index: Record<string, number | null>): Record<string, string> {
  const out: Record<string, string> = {};
  const byHeader = new Map<number, ImportColumn[]>();
  for (const c of spec.columns) {
    const i = index[c.id] ?? null;
    if (i === null) {
      if (c.required) out[c.id] = `Choose a column for ${c.label}.`;
      continue;
    }
    byHeader.set(i, [...(byHeader.get(i) ?? []), c]);
  }
  for (const group of byHeader.values()) {
    if (group.length < 2) continue;
    for (const c of group) out[c.id] = `Used for ${group.filter((o) => o !== c).map((o) => o.label).join(" and ")} too`;
  }
  return out;
}
