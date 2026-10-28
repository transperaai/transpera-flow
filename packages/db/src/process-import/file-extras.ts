// What a `transpera-process/2` file carries beyond its steps (issue #167, B14), turned into the rows `import_process_bundle`
// writes: sources (with ids chosen here) and first principles for the draft. Nothing here writes: the preview calls it to show
// what would happen, the import calls it and hands the rows to the database. (A file used to carry company facts and
// proposals too, which waited as suggestions; Suggestions are gone, docs/plans/cut-list.md item 2, and the format no longer
// has them.)

import { firstPrinciplesToColumns, loadCompanyModel, type CompanyModel, type FileCitation, type FileSource, type Json, type ProcessFile } from "../index";
import { emptyFirstPrinciples } from "@transpera-flow/engine";
import type { WorkspaceRef, ImportContext } from "./context";
import { mergeFirstPrinciples, type FpInput } from "./first-principles";

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
  /** The first principles' columns, or null when the file has none. */
  firstPrinciples: Record<string, Json> | null;
  /** For the preview. */
  firstPrinciplesParts: number;
  /** Things the upload left out or changed, in plain words. */
  notes: string[];
}

/** "Quote" (speaker, source, time): evidence as one line of text, for fields that hold text. */
function quoteLine(c: FileCitation, titles: ReadonlyMap<string, string>): string {
  const who = [c.speaker, titles.get(c.source), c.time].filter(Boolean).join(", ");
  return `“${c.quote}”${who ? ` (${who})` : ""}`;
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
    firstPrinciples: null,
    firstPrinciplesParts: 0,
    notes: [],
  };
  const titles = new Map((file.sources ?? []).map((s) => [s.id, s.title]));
  const model = file.first_principles ? await loadCompanyModel(ctx.db, ws) : null;
  if (file.first_principles && model) planFirstPrinciples(file, model, ids, titles, plan);
  return plan;
}

// ---------------------------------------------------------------------------
// First principles
// ---------------------------------------------------------------------------

function planFirstPrinciples(file: ProcessFile, model: CompanyModel, ids: FileIds, titles: ReadonlyMap<string, string>, plan: ExtrasPlan): void {
  const fp = file.first_principles!;
  const line = (cites: readonly FileCitation[], assumed?: string) => [...cites.map((c) => quoteLine(c, titles)), ...(assumed ? [`Assumed: ${assumed}`] : [])].join(" · ");
  // Evidence for something with no text field of its own (the job, the measures, the root cause) is kept as a truth that quotes it.
  const extraTruths: NonNullable<FpInput["statements"]> = [];
  const quoted = (label: string, cites: readonly FileCitation[], assumed?: string) => {
    if (cites.length || assumed) extraTruths.push({ text: label, kind: cites.length ? "truth" : "assumption", source: line(cites, assumed) });
  };
  quoted("The job, as said", fp.job?.evidence ?? [], fp.job?.assumed);
  quoted("The biggest problem and its root cause, as said", fp.why?.evidence ?? [], fp.why?.assumed);
  for (const m of fp.measures) quoted(`Success measure “${m.text}”`, m.evidence, m.assumed);
  const input: FpInput = {
    ...(fp.job ? { job: { who: fp.job.who, progress: fp.job.progress, situation: fp.job.situation, done: fp.job.done } } : {}),
    statements: [...fp.truths.map((t) => ({ text: t.text, kind: t.kind ?? (t.evidence.length ? "truth" as const : "assumption" as const), source: line(t.evidence, t.assumed), ...(t.test ? { test: t.test } : {}) })), ...extraTruths],
    requirements: fp.requirements.map((r) => ({
      text: r.text,
      ...(r.owner ? { owner: r.owner } : {}),
      why: [r.why, line(r.evidence, r.assumed)].filter(Boolean).join(" — "),
      ...(r.verdict ? { verdict: r.verdict } : {}),
      ...(r.step ? { step: ids.steps.get(r.step) } : {}),
    })),
    measures: fp.measures.map((m) => ({ text: m.text, ...(m.kpi ? { kpi: m.kpi } : {}), ...(m.comparator ? { comparator: m.comparator } : {}), ...(m.target !== undefined ? { target: m.target } : {}), ...(m.horizon ? { horizon: m.horizon } : {}) })),
    ...(fp.why ? { why: { ...(fp.why.problem ? { problem: fp.why.problem } : {}), ...(fp.why.chain ? { chain: fp.why.chain } : {}), ...(fp.why.root ? { root: fp.why.root } : {}) } } : {}),
  };
  const merged = mergeFirstPrinciples(
    emptyFirstPrinciples(),
    input,
    { steps: file.steps.map((s) => ({ id: ids.steps.get(s.id)!, name: s.name })), people: model.people.map((p) => ({ id: p.id, name: p.name })) },
    "replace",
  );
  plan.notes.push(...merged.warnings);
  const columns = firstPrinciplesToColumns(merged.doc) as unknown as Record<string, Json>;
  plan.firstPrinciples = columns;
  plan.firstPrinciplesParts = merged.changed.length;
}
