// The company map drives the run (Q17, D51, ADR 0023). `companyBundle` applies a company map revision to a bundle: the processes on the map are what
// run, and its hand-off lines between pipelines say where won clients carry on. `companyEngineModel` is the one entry that turns a map revision into
// the engine's model, with the notes a person should read about what the engine can't honour. Pure.
//
// The map is applied to the bundle, not the model: the bundle comes back rooted at the map's sales pipeline with `otherProcesses` cut to the map's
// processes (and the processes they hold), and an optional `handoffs` list that `toEngineModel` reads. For a map that holds every process today's run
// uses, with no pipeline-to-pipeline line, the bundle has the same root and the same `otherProcesses` and no `handoffs`, so the model is today's,
// deep-equal (the system-made map is always such a map: `engine-model-snapshot.test.ts` proves it on the seeds).

import type { EngineModel } from "@transpera-flow/engine";
import { ModelError, toEngineModel, type ModelOptions } from "./model";
import { partOf } from "./servicing";
import type { CompanyHandoff, EdgeRow, ProcessBundle, ProcessPart, StepRow } from "./types";

/** What kind of thing a note is about, so a screen can group or pick them. */
export type CompanyRunNoteKind =
  | "pipeline-moved"
  | "not-on-map"
  | "unpublished"
  | "no-service-link"
  | "service-entry"
  | "fork"
  | "share"
  | "condition"
  | "servicing-out"
  | "loop"
  | "no-won-end"
  | "lost-end"
  | "won-end";

/** A thing about the company map the run can't honour or has changed, in plain words. */
export interface CompanyRunNote {
  kind: CompanyRunNoteKind;
  message: string;
}

/** Why the run can't start when no pipeline is on the map. */
export const NO_PIPELINE_ON_MAP = "The company map has no sales pipeline on it. Add one to simulate the business.";

export interface CompanyBundleResult {
  /** The bundle the map's run is built from; null when the run can't start (`problem` says why). */
  bundle: ProcessBundle | null;
  notes: CompanyRunNote[];
  problem: string | null;
}

/** "'A'", "'A' and 'B'", "'A', 'B' and 'C'". */
function quoted(names: readonly string[]): string {
  const q = names.map((n) => `'${n}'`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

const byRank = (rank: ReadonlyMap<string, number>) => (a: string, b: string) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * `bundle`'s run on the company map `company` (any revision of it: live, the open draft or an earlier version). `parts` is every process at its live
 * revision, in the workspace's order (`loadLiveParts`). The bundle's own process, when it is on the map, keeps the bundle's revision of it.
 */
export function companyBundle(bundle: ProcessBundle, company: ProcessPart, parts: readonly ProcessPart[]): CompanyBundleResult {
  const notes: CompanyRunNote[] = [];
  const note = (kind: CompanyRunNoteKind, message: string) => notes.push({ kind, message });

  // Every process the map can run, by id: the bundle's own revision of its process first, then the live ones.
  const byId = new Map<string, ProcessPart>();
  const add = (p: ProcessPart) => {
    if (!p.process.is_company && !p.process.archived_at && !byId.has(p.process.id)) byId.set(p.process.id, p);
  };
  if (!bundle.process.is_company && bundle.steps.length) add(partOf(bundle));
  parts.forEach(add);
  (bundle.otherProcesses ?? []).forEach(add);
  // The workspace's order: how today's pipeline is picked, and how a fork is broken.
  const rank = new Map<string, number>();
  parts.forEach((p, i) => rank.set(p.process.id, i));
  for (const id of byId.keys()) if (!rank.has(id)) rank.set(id, parts.length + rank.size);
  const order = byRank(rank);

  // The cards: a holder step per process. A card of a process with no live version (never published, or archived) isn't simulated.
  const cards = company.steps.filter((s) => s.kind === "subprocess" && s.child_process_id);
  const cardOf = new Map<string, string>();
  const cardName = new Map<string, string>();
  for (const s of cards) {
    if (!cardOf.has(s.id)) cardOf.set(s.id, s.child_process_id!);
    if (!cardName.has(s.child_process_id!)) cardName.set(s.child_process_id!, s.name);
  }
  const names: Record<string, string> = {};
  for (const [pid, name] of cardName) names[pid] = byId.get(pid)?.process.name ?? name;
  for (const [pid, p] of byId) names[pid] = p.process.name;
  const nameOf = (pid: string) => names[pid] ?? "A process";

  const cardIds = [...new Set(cards.map((s) => s.child_process_id!))].sort(order);
  for (const pid of cardIds) {
    if (!byId.has(pid)) note("unpublished", `'${nameOf(pid)}' has no published version, so it isn't simulated.`);
  }
  const runnable = cardIds.filter((pid) => byId.has(pid));
  const pipelines = runnable.filter((pid) => byId.get(pid)!.process.kind !== "servicing");
  const servicing = runnable.filter((pid) => byId.get(pid)!.process.kind === "servicing");

  // The lines between cards (a group of cards, or a step that isn't a card, is drawn only).
  const lines: { from: string; to: string; edge: EdgeRow }[] = [];
  for (const e of [...company.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const from = cardOf.get(e.from_step_id);
    const to = cardOf.get(e.to_step_id);
    if (from && to && from !== to) lines.push({ from, to, edge: e });
  }
  const pipelineLines = lines.filter((l) => pipelines.includes(l.from) && pipelines.includes(l.to));

  // The sales pipeline: the first pipeline card no line from another pipeline leads into (all of them in a ring: the first).
  const root = pipelines.find((pid) => !pipelineLines.some((l) => l.to === pid)) ?? pipelines[0];
  if (root === undefined) return { bundle: null, notes, problem: NO_PIPELINE_ON_MAP };

  // Today's pipeline (the workspace's first top-level pipeline) isn't on the map: the next one runs.
  const today = [...byId.values()].filter((p) => p.process.kind !== "servicing" && !p.process.parent_process_id).sort((a, b) => order(a.process.id, b.process.id))[0]?.process.id;
  if (today !== undefined && today !== root && !runnable.includes(today)) note("pipeline-moved", `'${nameOf(today)}' isn't on this company map.`);

  // The chain of hand-offs from the sales pipeline: each process hands on to one pipeline. A fork follows the first by the workspace's order; the
  // line that closes a loop is left out.
  const chain: string[] = [root];
  const handoffs: CompanyHandoff[] = [];
  const endsOf = (pid: string, outcome?: string) => byId.get(pid)!.steps.filter((s) => s.kind === "end" && (outcome === undefined || s.outcome === outcome));
  for (let cur = root; ; ) {
    const out = pipelineLines.filter((l) => l.from === cur);
    const targets = [...new Set(out.map((l) => l.to))].sort(order);
    const fresh = targets.filter((t) => !chain.includes(t));
    for (const t of targets) {
      if (chain.includes(t)) note("loop", `The line from '${nameOf(cur)}' ${t === root ? "back " : ""}to '${nameOf(t)}' closes a loop, so it isn't used.`);
    }
    const next = fresh[0];
    if (next === undefined) break;
    if (fresh.length > 1) note("fork", `'${nameOf(cur)}' hands on to ${quoted(fresh.map(nameOf))}. The run follows only '${nameOf(next)}'.`);
    // Only a won end of the sales pipeline, and any end of a handed-to process, carries a client on.
    if (!endsOf(cur, cur === root ? "won" : undefined).length) {
      note("no-won-end", `'${nameOf(cur)}' has no ${cur === root ? "won " : ""}end, so nothing is handed on to '${nameOf(next)}'.`);
      break;
    }
    const used = out.filter((l) => l.to === next);
    const share = Math.min(...used.map((l) => Number(l.edge.probability)));
    if (share < 1) note("share", `The ${Math.round(share * 100)}% on the line to '${nameOf(next)}' isn't used: every won client goes through it.`);
    if (used.some((l) => l.edge.condition_tag?.trim())) note("condition", `The condition on the line to '${nameOf(next)}' isn't used: every won client goes through it.`);
    handoffs.push({ from: cur, to: next });
    chain.push(next);
    cur = next;
  }
  // A handed-to process's lost end doesn't lose the client (a win sticks), and a won end doesn't win them again: its ends are all `done`.
  for (const pid of chain.slice(1)) {
    if (endsOf(pid, "lost").length) note("lost-end", `'${nameOf(pid)}' has a lost end. A client who reaches it still counts as won, so the run treats it as done.`);
    else if (endsOf(pid, "won").length) note("won-end", `'${nameOf(pid)}' has a won end. The client was already counted as won, so the run treats it as done.`);
  }

  // A servicing process runs for its services' clients; a line out of it can't start anything.
  for (const pid of servicing) {
    if (lines.some((l) => l.from === pid)) note("servicing-out", `Work handed on from '${nameOf(pid)}' isn't simulated.`);
  }

  // Which processes run: the sales pipeline, the processes handed on to, the servicing cards, and the processes these hold.
  const run = new Set<string>([...chain, ...servicing]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, p] of byId) {
      if (run.has(pid)) continue;
      const parent = p.process.parent_process_id;
      const held = [...run].some((r) => byId.get(r)!.steps.some((s) => s.child_process_id === pid));
      if ((parent && run.has(parent)) || held) {
        run.add(pid);
        grew = true;
      }
    }
  }

  // Servicing: linked to a service but not on the map (its work isn't simulated), and on the map but linked to nothing.
  const services = new Map(bundle.services.filter((s) => s.active).map((s) => [s.id, s]));
  const linksOf = (pid: string) => (bundle.servicingLinks ?? []).filter((l) => l.process_id === pid && services.has(l.service_id));
  for (const [pid, p] of [...byId].sort(([a], [b]) => order(a, b))) {
    if (p.process.kind !== "servicing" || run.has(pid)) continue;
    const served = [...new Set(linksOf(pid).map((l) => services.get(l.service_id)!.name))];
    if (served.length) note("not-on-map", `'${nameOf(pid)}' is linked to ${quoted(served)} but isn't on this company map, so its work isn't simulated.`);
  }
  for (const pid of servicing) {
    if (!linksOf(pid).length) note("no-service-link", `Nothing starts '${nameOf(pid)}': it isn't linked to a service.`);
  }
  // A service that enters another process than the sales pipeline gets no arrivals, as before the map drove the run.
  for (const sv of [...services.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (sv.entry_process_id !== null && sv.entry_process_id !== root) {
      note("service-entry", `'${sv.name}' starts at '${nameOf(sv.entry_process_id)}', not the sales pipeline, so no new clients arrive for it.`);
    }
  }

  // The bundle: rooted at the sales pipeline, the other processes in today's order (the bundle's, then the rest in the workspace's), the hand-offs.
  const rootPart = byId.get(root)!;
  const earlier = (bundle.otherProcesses ?? []).map((p) => p.process.id).filter((id) => id !== root && run.has(id));
  const rest = [...run].filter((id) => id !== root && !earlier.includes(id)).sort(order);
  const same = rootPart.process.id === bundle.process.id;
  const result: ProcessBundle = {
    ...bundle,
    process: rootPart.process,
    revision: rootPart.revision,
    steps: rootPart.steps as StepRow[],
    edges: rootPart.edges,
    ...(same ? {} : { retired: [] }),
    otherProcesses: [...earlier, ...rest].map((id) => byId.get(id)!),
    companyNames: names,
  };
  if (handoffs.length) result.handoffs = handoffs;
  else delete result.handoffs;
  return { bundle: result, notes, problem: null };
}

/** The engine's model for `bundle` run on the company map `company`, with the map's notes. Throws `ModelError` when the run can't start. */
export function companyEngineModel(
  company: ProcessPart,
  bundle: ProcessBundle,
  parts: readonly ProcessPart[],
  options: ModelOptions = {},
): { model: EngineModel; notes: CompanyRunNote[]; bundle: ProcessBundle } {
  const made = companyBundle(bundle, company, parts);
  if (!made.bundle) throw new ModelError(made.problem ?? NO_PIPELINE_ON_MAP);
  return { model: toEngineModel(made.bundle, options), notes: made.notes, bundle: made.bundle };
}
