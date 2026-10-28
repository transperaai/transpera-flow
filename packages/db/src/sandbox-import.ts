// The scenarios of a backup, as the restore plan takes them (docs/plans/sandbox-p1-brief.md §5). A backup made since the Sandbox
// holds `sandbox_scenarios` (changes); an older one holds `scenarios` (patches), which are converted with `changesFromPatch`
// (whole-run changes, no parent: the old parent link meant "copied from"). Pure: no I/O.
//
// What it does so the restore cannot fail on a scenario:
//   * a scenario whose changes are not valid (as the database checks) is left out, with a warning;
//   * solutions are not restored, so a change that puts one live (E6) is left out, with a warning;
//   * names are unique in a workspace (ignoring case and spaces): a clash, or a name a library scenario holds that this one is not
//     (the restored workspace is seeded with the library), gets " (2)", " (3)", ...;
//   * a parent that is not restored, or a chain deeper than the database takes, or a loop, is cleared.

import { changesFromPatch, changesProblem, changesWithoutIds, MAX_PARENT_DEPTH, MAX_SCENARIO_DESCRIPTION, MAX_SCENARIO_NAME, nameKey, SANDBOX_LIBRARY, uniqueName, type SandboxChange } from "./sandbox-levers";
import type { Row } from "./workspace-bundle";

const lc = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : "");
const isObj = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
/** JSON with sorted keys, so two lists compare equal whatever order a database or a file put their keys in. */
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]` : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v) ?? "null";
const isFirstOfMonth = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-01$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export interface SandboxImport {
  /** Plan rows (`id`, `parent_id`, `name`, `description`, `changes`, `horizon_months`, `start_date`, `created_at`), parents first. */
  rows: Row[];
  /** Scenarios left out (not valid, or a patch with no lever). */
  dropped: number;
  /** Change lists that lost an E6 change (solutions are not restored): how many changes. */
  solutionChanges: number;
  /** Scenarios renamed because the name was taken. */
  renamed: number;
  /** Parents cleared (not restored, too deep, or a loop). */
  clearedParents: number;
  /** Plain sentences for the preview. */
  warnings: string[];
}

export function planSandboxScenarios(current: readonly unknown[], legacy: readonly unknown[]): SandboxImport {
  const warnings: string[] = [];
  let dropped = 0;
  let solutionChanges = 0;
  let renamed = 0;
  let clearedParents = 0;
  const candidates: Row[] = [];

  for (const raw of current) {
    if (!isObj(raw) || typeof raw.id !== "string") continue;
    candidates.push({ ...raw, changes: raw.changes });
  }
  for (const raw of legacy) {
    if (!isObj(raw) || typeof raw.id !== "string") continue;
    let changes: SandboxChange[];
    try {
      changes = changesFromPatch(Array.isArray(raw.patch) ? (raw.patch as never[]) : []);
    } catch {
      dropped++;
      continue;
    }
    candidates.push({ id: raw.id, name: raw.name, description: raw.description, changes, parent_id: null, created_at: raw.created_at });
  }

  // Valid changes, minus solutions.
  const kept: Row[] = [];
  for (const c of candidates) {
    const list = Array.isArray(c.changes) ? (c.changes as unknown[]) : null;
    if (!list) {
      dropped++;
      continue;
    }
    const withoutSolutions = list.filter((x) => !(isObj(x) && x.lever === "E6"));
    solutionChanges += list.length - withoutSolutions.length;
    if (changesProblem(withoutSolutions) !== null) {
      dropped++;
      continue;
    }
    kept.push({ ...c, changes: withoutSolutions });
  }

  // Parents: only restored ones, no loop, at most MAX_PARENT_DEPTH deep.
  const byId = new Map(kept.map((r) => [lc(r.id), r]));
  const parentOf = (r: Row) => (r.parent_id == null ? null : (byId.get(lc(r.parent_id)) ?? null));
  for (const r of kept) {
    if (r.parent_id == null) continue;
    let depth = 0;
    let at: Row | null = parentOf(r);
    let ok = at !== null;
    const seen = new Set([lc(r.id)]);
    while (at && ok) {
      depth++;
      if (seen.has(lc(at.id)) || depth > MAX_PARENT_DEPTH) ok = false;
      seen.add(lc(at.id));
      at = parentOf(at);
    }
    if (!ok) {
      r.parent_id = null;
      clearedParents++;
    }
  }
  // The depth of a child counts from the root, so a deep chain is cut where it passes the limit: clearing the parent of the deepest rows first is enough, repeated.
  const depthOf = (r: Row): number => {
    let d = 0;
    for (let at = parentOf(r); at; at = parentOf(at)) d++;
    return d;
  };
  for (const r of [...kept].sort((a, b) => depthOf(b) - depthOf(a))) {
    if (depthOf(r) > MAX_PARENT_DEPTH) {
      r.parent_id = null;
      clearedParents++;
    }
  }

  // Parents before children (stable otherwise).
  const placed = new Set<string>();
  const ordered: Row[] = [];
  const place = (r: Row) => {
    if (placed.has(lc(r.id))) return;
    const p = parentOf(r);
    if (p) place(p);
    placed.add(lc(r.id));
    ordered.push(r);
  };
  for (const r of kept) place(r);

  // Names. The library's four are in every new workspace: a scenario with the same name and the same changes is skipped by the
  // restore, so it keeps its name; any other that takes a library name gets a suffix. Everything else is made unique in order.
  const libraryShape = new Map(SANDBOX_LIBRARY.map((l) => [nameKey(l.name), canon(changesWithoutIds(l.changes))]));
  const taken = new Set(libraryShape.keys());
  const rows: Row[] = [];
  for (const r of ordered) {
    let name = (typeof r.name === "string" ? r.name.trim() : "") || "Scenario";
    if (name.length > MAX_SCENARIO_NAME) name = name.slice(0, MAX_SCENARIO_NAME).trim();
    const isLibrary = libraryShape.get(nameKey(name)) === canon(changesWithoutIds(r.changes as SandboxChange[]));
    if (isLibrary) {
      // Skipped by the restore when the library row has equal changes; keeps the name either way.
      rows.push({ ...r, name });
      continue;
    }
    const unique = uniqueName(name, taken);
    if (unique !== name) renamed++;
    rows.push({ ...r, name: unique });
  }

  const out: Row[] = rows.map((r) => {
    const row: Row = {
      id: r.id,
      parent_id: r.parent_id ?? null,
      name: r.name,
      description: typeof r.description === "string" ? r.description.slice(0, MAX_SCENARIO_DESCRIPTION) : null,
      changes: r.changes,
      // Always given: the restore inserts the columns any row carries, and a row without one would get null, not the default.
      horizon_months: typeof r.horizon_months === "number" && Number.isInteger(r.horizon_months) && r.horizon_months >= 1 && r.horizon_months <= 24 ? r.horizon_months : 12,
    };
    if (isFirstOfMonth(r.start_date)) row.start_date = r.start_date;
    if (r.created_at !== undefined) row.created_at = r.created_at;
    return row;
  });

  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (dropped) warnings.push(`${n(dropped, "scenario isn't", "scenarios aren't")} valid and ${dropped === 1 ? "was" : "were"} left out.`);
  if (solutionChanges) warnings.push(`${n(solutionChanges, "change that puts", "changes that put")} a solution live ${solutionChanges === 1 ? "was" : "were"} left out of the scenarios: solutions aren't restored.`);
  if (renamed) warnings.push(`${n(renamed, "scenario was", "scenarios were")} renamed because ${renamed === 1 ? "its name was" : "their names were"} already taken.`);
  if (clearedParents) warnings.push(`${n(clearedParents, "scenario", "scenarios")} no longer ${clearedParents === 1 ? "builds" : "build"} on another: ${clearedParents === 1 ? "its" : "their"} base isn't in the backup.`);
  return { rows: out, dropped, solutionChanges, renamed, clearedParents, warnings };
}
