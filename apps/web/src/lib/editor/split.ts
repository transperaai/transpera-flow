// Splitting a step in two (issue #16, docs/PRD.md §4.1 "Stable step IDs").
//
// Ids never change, so a split doesn't reuse the old step's id for either
// half: both halves are new steps, and the old step's row stays in the
// revision, retired, with `replaced_by` naming them. A saved scenario that
// changed the old step then "needs attention" and suggests the halves to
// re-point it to, instead of silently halving (or dropping) its effect.
//
// Pure, like ./commands.ts: the edit is a remove and an insert, so undo puts
// the step and its connections back exactly as they were.

import { EVIDENCE_COLUMNS, openConflict, type EdgeRow, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import type { Edit, Op, RowChange } from "./ops";

/** Kinds of step that can be split: the ones that hold work or a wait. */
export const SPLITTABLE = new Set<StepRow["kind"]>(["task", "wait"]);

const MAX_NAME = 200;
const part = (name: string, n: number) => {
  const suffix = ` (part ${n})`;
  return `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
};

const half = (v: number | null | undefined) => (typeof v === "number" ? Math.round((v / 2) * 1000) / 1000 : v);

/** Near a step's position, the first spot no other step covers (below, above, right, then further down). */
function freeSpot(bundle: ProcessBundle, id: string, x: number, y: number): { x: number; y: number } {
  const others = bundle.steps.filter((s) => s.id !== id);
  const clear = (px: number, py: number) => others.every((s) => Math.abs(Number(s.x) - px) >= 180 || Math.abs(Number(s.y) - py) >= 100);
  const tries = [
    [0, 130],
    [0, -130],
    [220, 0],
    [220, 130],
    [0, 260],
  ] as const;
  const [dx, dy] = tries.find(([dx, dy]) => clear(x + dx, y + dy)) ?? tries[0];
  return { x: Math.round(x + dx), y: Math.round(y + dy) };
}

/** Why a step can't be split, or null if it can. */
export function splitProblem(bundle: ProcessBundle, id: string): string | null {
  const step = bundle.steps.find((s) => s.id === id);
  if (!step) return "That step is gone.";
  if (!SPLITTABLE.has(step.kind)) return "Only task and wait steps can be split.";
  return null;
}

/**
 * Split a step into two in sequence. The first part takes its incoming
 * connections, half its hands-on time and any work sitting there now; the
 * second takes the other half, the wait, rework, SLA and outgoing
 * connections (which keep their ids). Rework aimed at the old step goes to
 * the first part. The old step's row is kept, retired, with `replaced_by`.
 */
export function splitStep(bundle: ProcessBundle, id: string, newId: () => string = () => crypto.randomUUID()): { edit: Edit; ids: [string, string] } | null {
  if (splitProblem(bundle, id) || bundle.process.is_company) return null;
  const old = bundle.steps.find((s) => s.id === id)!;
  const [a, b] = [newId(), newId()];

  const provenance = (old as StepRow & { provenance?: Record<string, unknown> }).provenance;
  // The halved hands-on time is a new estimate, not what was entered or measured.
  const kept: Record<string, unknown> = { ...(provenance && typeof provenance === "object" ? provenance : {}) };
  delete kept.work_hours;
  const halfParams = Object.fromEntries(
    Object.entries(old.work_params).map(([k, v]) => [k, k === "cv" ? v : half(v)]),
  ) as StepRow["work_params"];
  const copy = (): StepRow => {
    const row: StepRow & { replaced_by?: unknown; provenance?: unknown } = { ...old };
    delete row.replaced_by;
    // A conflict on hands-on time goes with its provenance; the halves are flagged only for the conflicts they keep (issue #21).
    const conflict = EVIDENCE_COLUMNS.some((c) => openConflict({ provenance: kept as StepRow["provenance"] }, c) !== null);
    return { ...row, conflict, work_params: { ...halfParams }, wait_params: { ...old.wait_params }, ...(provenance ? { provenance: { ...kept } as StepRow["provenance"] } : {}) };
  };
  const first: StepRow = {
    ...copy(),
    id: a,
    name: part(old.name, 1),
    work_hours: half(old.work_hours)!,
    wait_hours: 0,
    wait_params: {},
    rework_rate: 0,
    rework_to_step_id: null,
    sla_hours: null,
    // Where work is lost is after the first half, on the second.
    dropoff_benchmark: null,
  };
  const second: StepRow = {
    ...copy(),
    id: b,
    name: part(old.name, 2),
    work_hours: half(old.work_hours)!,
    rework_to_step_id: old.rework_to_step_id === id ? null : old.rework_to_step_id,
    current_wip: null,
    ...freeSpot(bundle, id, Number(old.x), Number(old.y)),
  };
  // Kept for scenarios to re-point: never drawn or simulated, and never an unconfirmed estimate.
  const retired = { ...old, replaced_by: [a, b], assumption: false, conflict: false, current_wip: null } as StepRow;

  const touching = bundle.edges.filter((e) => e.from_step_id === id || e.to_step_id === id);
  const moved: EdgeRow[] = touching.map((e) => ({
    ...e,
    from_step_id: e.from_step_id === id ? b : e.from_step_id,
    to_step_id: e.to_step_id === id ? a : e.to_step_id,
  }));
  const owner = { revision_id: old.revision_id, workspace_id: old.workspace_id, process_id: old.process_id };
  const link: EdgeRow = { ...owner, id: newId(), from_step_id: a, to_step_id: b, probability: 1, condition_tag: null, label: null };

  const refs: RowChange[] = bundle.steps
    .filter((s) => s.id !== id && s.rework_to_step_id === id)
    .map((s) => ({ table: "steps", id: s.id, before: { rework_to_step_id: id }, after: { rework_to_step_id: a } }));
  const ops: Op[] = [
    { kind: "remove", steps: [old], edges: touching },
    { kind: "insert", steps: [first, second, retired], edges: [...moved, link] },
    ...(refs.length ? [{ kind: "update" as const, changes: refs }] : []),
  ];
  return { edit: { label: `Split ${old.name}`, ops }, ids: [a, b] };
}
