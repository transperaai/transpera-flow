// What a `transpera-process/2` file carries beyond its steps (issue #167, B14), turned into the rows `import_process_bundle`
// writes: sources (with ids chosen here). Nothing here writes: the preview calls it to show
// what would happen, the import calls it and hands the rows to the database. (A file used to carry company facts and
// proposals too, which waited as suggestions; Suggestions are gone, docs/plans/cut-list.md item 2, and the format no longer
// has them.)

import type { FileSource, ProcessFile } from "../index";
import type { WorkspaceRef, ImportContext } from "./context";

/** Ids the caller chose, so rows that point at each other can be built before anything is written. */
export interface FileIds {
  processId: string;
  /** File source id → the id the source gets. */
  sources: ReadonlyMap<string, string>;
  /** File step id → the id the step gets. */
  steps: ReadonlyMap<string, string>;
}

export interface ExtrasPlan {
  sources: { id: string; kind: string; title: string; speakers: string[]; recorded_at: string | null; body: string | null }[];
  /** Things the upload left out or changed, in plain words. */
  notes: string[];
}

export const sourceRows = (sources: readonly FileSource[], ids: ReadonlyMap<string, string>): ExtrasPlan["sources"] =>
  sources.map((s) => ({ id: ids.get(s.id)!, kind: s.kind, title: s.title, speakers: s.speakers, recorded_at: s.date ?? null, body: s.body ?? null }));

/**
 * Plan everything a /2 file carries beyond the process. `ids` are the ids the rows will have; for a preview they can be made up.
 * Never throws for a problem with one item: it is left out and said in `notes`, and the rest goes ahead.
 */
export async function planFileExtras(ctx: ImportContext, ws: WorkspaceRef, file: ProcessFile, ids: FileIds): Promise<ExtrasPlan> {
  const plan: ExtrasPlan = {
    sources: sourceRows(file.sources ?? [], ids.sources),
    notes: [],
  };
  return plan;
}
