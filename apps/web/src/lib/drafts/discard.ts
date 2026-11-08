// Discarding one change of a draft (issue #9): put a step, an edge or one field
// back as it is live. Each is an ordinary edit (./../editor/ops.ts), so it is
// saved like any other and undo brings the change back.

import type { EdgeRow, ProcessBundle, StepRow } from "@transpera-flow/db";
import { deleteEdges, deleteSteps, updateEdge, updateStep } from "@/lib/editor/commands";
import { pick, readField, type Edit, type Table } from "@/lib/editor/ops";
import { provenanceFieldFor } from "@/lib/editor/provenance";
import { FIELD_LABELS } from "@/lib/editor/labels";
import { EDGE_BEND_FIELDS, changeOf, diffBundles, type Change } from "./diff";

/** A pseudo-field for a step's position (x and y together). */
export const POSITION = "position";

const name = (b: Pick<ProcessBundle, "steps">, id: string) => b.steps.find((s) => s.id === id)?.name ?? "step";
const has = (b: Pick<ProcessBundle, "steps">, id: string) => b.steps.some((s) => s.id === id);

/** A live row as a row of the draft revision. */
const intoDraft = <T extends StepRow | EdgeRow>(row: T, draft: ProcessBundle): T => ({ ...row, revision_id: draft.revision.id });

/**
 * A revert of step fields that also puts back each reverted value's live
 * provenance (lib/editor/provenance.ts). Its provenance key is in the change
 * whenever either side has an entry, even where it already matches live, so
 * the revert restores live as it was rather than being stamped as a fresh entry.
 */
function revertSteps(live: StepRow, draft: ProcessBundle, id: string, fields: string[]): Edit | null {
  const edit = updateStep(draft, id, pick(live, fields));
  if (!edit) return null;
  const ops = edit.ops.map((op) => {
    if (op.kind !== "update") return op;
    const changes = op.changes.map((c) => {
      const before = { ...c.before };
      const after = { ...c.after };
      for (const field of Object.keys(c.after)) {
        const key = provenanceFieldFor(field);
        if (!key || key in after) continue;
        const row = draft.steps.find((s) => s.id === c.id);
        const mine = row ? readField(row, key) : null;
        const theirs = readField(live, key);
        // Neither has an entry: nothing to put back.
        if (mine === null && theirs === null) continue;
        before[key] = mine;
        after[key] = theirs;
      }
      return { ...c, before, after };
    });
    return { ...op, changes };
  });
  return { ...edit, ops };
}

/** Why a change can't be discarded on its own, or null if it can. */
export function discardProblem(draft: ProcessBundle, change: Change): string | null {
  if (change.table === "edges" && change.live) {
    const { from_step_id: from, to_step_id: to } = change.live;
    if (!has(draft, from) || !has(draft, to)) return "Restore the steps it connects first.";
  }
  if (change.table === "steps" && change.kind === "removed" && change.live?.kind === "start") {
    if (draft.steps.some((s) => s.kind === "start")) return "The draft has another start step.";
  }
  return null;
}

/** An edit that puts one step or edge back as it is live, or null if there is nothing to do or it can't be. */
export function discardChange(live: ProcessBundle, draft: ProcessBundle, table: Table, id: string): Edit | null {
  const change = changeOf(diffBundles(live, draft), table, id);
  if (!change || discardProblem(draft, change)) return null;

  if (change.table === "steps") {
    const label = (verb: string) => `${verb} ${change.live?.name ?? change.draft?.name ?? "step"}`;
    if (change.kind === "added") {
      const edit = deleteSteps(draft, [id]);
      return edit && { ...edit, label: `Discarded new step ${change.draft!.name}` };
    }
    if (change.kind === "removed") {
      const step = intoDraft(change.live!, draft);
      const present = new Set([...draft.steps.map((s) => s.id), id]);
      const inDraft = new Set(draft.edges.map((e) => e.id));
      // Its connections come back with it, where the step at the other end is still there.
      const edges = live.edges
        .filter((e) => (e.from_step_id === id || e.to_step_id === id) && !inDraft.has(e.id))
        .filter((e) => present.has(e.from_step_id) && present.has(e.to_step_id))
        .map((e) => intoDraft(e, draft));
      // A split step's retired row (issue #16) makes way for it: the step is back in use.
      const retired = draft.retired?.find((s) => s.id === id);
      const unretire = retired ? [{ kind: "remove" as const, steps: [retired], edges: [] }] : [];
      return { label: label("Restored"), ops: [...unretire, { kind: "insert", steps: [step], edges }] };
    }
    const fields = [...change.fields.map((f) => f.field), ...(change.moved ? ["x", "y"] : [])];
    const edit = revertSteps(change.live!, draft, id, fields);
    return edit && { ...edit, label: label("Reverted") };
  }

  // Steps by name, the draft's first (a renamed step goes by its new name).
  const both = { steps: [...draft.steps, ...live.steps] };
  const edgeLabel = (verb: string) => {
    const e = (change.draft ?? change.live)!;
    return `${verb} ${name(both, e.from_step_id)} → ${name(both, e.to_step_id)}`;
  };
  if (change.kind === "added") {
    const edit = deleteEdges(draft, [id]);
    return edit && { ...edit, label: edgeLabel("Discarded new connection") };
  }
  if (change.kind === "removed") {
    return { label: edgeLabel("Restored"), ops: [{ kind: "insert", steps: [], edges: [intoDraft(change.live!, draft)] }] };
  }
  const edit = updateEdge(draft, id, pick(change.live!, [...change.fields.map((f) => f.field), ...(change.moved ? EDGE_BEND_FIELDS : [])]));
  return edit && { ...edit, label: edgeLabel("Reverted") };
}

/**
 * An edit that puts one field of a changed step or edge back as it is live.
 * Kind and outcome go back together (end steps, and only end steps, have an
 * outcome), as do x and y (`position`).
 */
export function revertField(live: ProcessBundle, draft: ProcessBundle, table: Table, id: string, field: string): Edit | null {
  const change = changeOf(diffBundles(live, draft), table, id);
  if (!change || change.kind !== "changed" || !change.live) return null;
  const fields =
    field === POSITION ? ["x", "y"] : field === "kind" || field === "outcome" ? ["kind", "outcome"] : [field];
  if (change.table === "edges") {
    const e = change.live as EdgeRow;
    if ((fields.includes("from_step_id") && !has(draft, e.from_step_id)) || (fields.includes("to_step_id") && !has(draft, e.to_step_id))) {
      return null;
    }
  }
  const patch = pick(change.live, fields);
  const edit = change.table === "steps" ? revertSteps(change.live, draft, id, fields) : updateEdge(draft, id, patch);
  const what = field === POSITION ? "position" : (FIELD_LABELS[field] ?? field);
  const both = { steps: [...draft.steps, ...live.steps] };
  const subject =
    change.table === "steps"
      ? `${change.draft!.name}'s ${what}`
      : `the ${what} of ${name(both, (change.live as EdgeRow).from_step_id)} → ${name(both, (change.live as EdgeRow).to_step_id)}`;
  return edit && { ...edit, label: `Reverted ${subject}` };
}
