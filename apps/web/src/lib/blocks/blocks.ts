// Blocks (issue #116): saved bundles of steps, and the Editor commands that make one from a group and put one into a
// process. Pure, like ../editor/groups.ts: each returns an Edit against the process as the editor shows it.
//
// A block holds its steps with ids local to it. Putting a block into a process builds a new group named after the block
// around fresh copies of its steps, so inserted steps never share an id with anything (and show as added against the live
// map), and a block can be put in as many times as you like.

import { ancestorsOf, isGroup, STEP_PURPOSE_KEY, type BlockBundle, type BlockEdge, type BlockStep, type EdgeRow, type ProcessBundle, type ProcessPart, type StepRow } from "@transpera-flow/db";
import { GROUP_PADDING, openGroupSize } from "@/lib/map/groups";
import { deleteSteps, newId, newStepRow } from "@/lib/editor/commands";
import { edgeRow, groupRow, nearestFreeSpot, type ViewHint } from "@/lib/editor/groups";
import { applyEdit, type Edit, type Op, type RowChange } from "@/lib/editor/ops";

/** The key in a group's `provenance` that names the library block it was made from (capacity P8). */
export const BLOCK_MARK = "block";

/** The library block a group was made from, or null. */
export function blockOfStep(step: { provenance?: unknown }): string | null {
  const p = step.provenance;
  const v = p && typeof p === "object" ? (p as Record<string, unknown>)[BLOCK_MARK] : null;
  return typeof v === "string" ? v : null;
}

/** How much of a block's name the group keeps. */
const NAME_MAX = 200;

/** The columns of a step a block keeps; anything else in a stored document is ignored. */
const STEP_KEYS = [
  "id", "name", "kind", "outcome", "role_id", "person_id", "work_hours", "work_dist", "work_params", "wait_hours", "wait_dist", "wait_params",
  "rework_rate", "rework_to_step_id", "tool", "purpose", "split", "split_notes", "tier_multiplier", "to_client_manager", "notes", "sla_hours", "expected_wait_hours", "lost_per_day_waiting", "dropoff_benchmark",
  "target_cycle_hours", "current_wip", "x", "y", "parent_step_id", "entry_step_id", "child_process_id", "assumption", "conflict", "provenance",
] as const;
const EDGE_KEYS = ["id", "from_step_id", "to_step_id", "probability", "condition_tag", "label"] as const;
/** Numbers a step holds; the database refuses anything else. */
const STEP_NUMBERS = ["work_hours", "wait_hours", "rework_rate", "x", "y"] as const;

function pickKeys<T extends object>(row: object, keys: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in row) out[k] = (row as Record<string, unknown>)[k];
  return out as T;
}

/** A step as a block keeps it: no revision, workspace or process, and nothing that belongs to the process it came from. */
function toBlockStep(s: StepRow): BlockStep {
  const row = structuredClone(pickKeys<BlockStep>(s, STEP_KEYS));
  // A child process belongs to one holder step, and nothing is sitting at a step that has just been saved.
  return { ...row, child_process_id: null, current_wip: null };
}

function toBlockEdge(e: EdgeRow): BlockEdge {
  return { id: e.id, from_step_id: e.from_step_id, to_step_id: e.to_step_id, probability: e.probability, condition_tag: e.condition_tag, label: e.label };
}

/** Of the top-level steps of a bundle, the one the outside would enter at: one nothing else of the bundle leads to, leftmost. */
function entryOf(steps: readonly BlockStep[], edges: readonly BlockEdge[]): string | null {
  const top = steps.filter((s) => s.parent_step_id === null);
  const led = new Set(edges.map((e) => e.to_step_id));
  const pool = top.filter((s) => !led.has(s.id));
  const pick = [...(pool.length ? pool : top)].sort((a, b) => Number(a.x) - Number(b.x) || Number(a.y) - Number(b.y))[0];
  return pick?.id ?? null;
}

/** The steps of a group, at any depth, and the connections among them, as a block. Null if `groupId` isn't a group. */
export function blockFromGroup(bundle: ProcessBundle, groupId: string): BlockBundle | null {
  const group = bundle.steps.find((s) => s.id === groupId);
  if (!group || !isGroup(group)) return null;
  const byId = new Map(bundle.steps.map((s) => [s.id, s]));
  const inside = bundle.steps.filter((s) => s.id !== groupId && ancestorsOf(s.id, byId).includes(groupId));
  const ids = new Set(inside.map((s) => s.id));
  // The group's own steps become the block's top level, and sit where they sat in the group's box.
  const steps = inside.map((s) => ({ ...toBlockStep(s), parent_step_id: s.parent_step_id === groupId ? null : s.parent_step_id }));
  const edges = bundle.edges.filter((e) => ids.has(e.from_step_id) && ids.has(e.to_step_id)).map(toBlockEdge);
  const entry = group.entry_step_id && ids.has(group.entry_step_id) ? group.entry_step_id : entryOf(steps, edges);
  return { steps, edges, entry_step_id: entry };
}

/** Every step of the bundle as a block (the Editor's block mode, where the whole map is the block), moved to the top left. */
export function blockFromSteps(bundle: Pick<ProcessBundle, "steps" | "edges">): BlockBundle {
  const steps = bundle.steps.map(toBlockStep);
  const top = steps.filter((s) => s.parent_step_id === null);
  const dx = top.length ? GROUP_PADDING.left - Math.min(...top.map((s) => Number(s.x))) : 0;
  const dy = top.length ? GROUP_PADDING.top - Math.min(...top.map((s) => Number(s.y))) : 0;
  const placed = steps.map((s) => (s.parent_step_id === null ? { ...s, x: Math.round(Number(s.x) + dx), y: Math.round(Number(s.y) + dy) } : s));
  const edges = bundle.edges.map(toBlockEdge);
  return { steps: placed, edges, entry_step_id: entryOf(placed, edges) };
}

/**
 * The Editor's map for editing an existing block (Q15): the block's steps and edges as rows of `base` (the process lending its roles
 * and people), keeping their ids so saving reads the same bundle back. A role or person since deleted is dropped, as `materialize` does.
 */
export function bundleFromBlock(base: ProcessBundle, block: BlockBundle, name: string): ProcessBundle {
  const { revision } = base;
  const owner = { revision_id: revision.id, workspace_id: revision.workspace_id, process_id: revision.process_id };
  const roles = new Set(base.roles.map((r) => r.id));
  const people = new Set(base.people.map((p) => p.id));
  const template = newStepRow(base, "task", null, 0, 0);
  const steps = parentsFirst(block.steps).map(
    (s): StepRow => ({
      ...template,
      ...pickKeys<BlockStep>(s, STEP_KEYS),
      ...owner,
      id: s.id,
      parent_step_id: s.parent_step_id ?? null,
      entry_step_id: s.entry_step_id ?? null,
      work_params: { ...s.work_params },
      wait_params: { ...s.wait_params },
      provenance: structuredClone(s.provenance ?? {}),
      current_wip: null,
      child_process_id: null,
      purpose: typeof s.purpose === "string" && STEP_PURPOSE_KEY.test(s.purpose) ? s.purpose : null,
      split: s.split ? { ...s.split } : null,
      split_notes: s.split_notes ? { ...s.split_notes } : null,
      tier_multiplier: s.tier_multiplier ? { ...s.tier_multiplier } : null,
      to_client_manager: s.to_client_manager === true,
      role_id: s.role_id && roles.has(s.role_id) ? s.role_id : null,
      person_id: s.person_id && people.has(s.person_id) ? s.person_id : null,
    }),
  );
  const edges = block.edges.map((e): EdgeRow => ({ ...pickKeys<BlockEdge>(e, EDGE_KEYS), ...owner, id: e.id }));
  return { ...base, process: { ...base.process, name }, steps, edges, retired: [] };
}

/** How many steps a block has: the work steps, not the boxes that group them. */
export function blockStepCount(block: BlockBundle): number {
  return block.steps.filter((s) => !isGroup(s)).length;
}

/** Why a bundle can't be a block (or be put in), or null. Also what the database's `steps` column is checked against in the app. */
export function blockProblem(block: unknown): string | null {
  const bad = "That block's steps aren't valid.";
  const b = block as Partial<BlockBundle> | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.steps) || !Array.isArray(b.edges)) return bad;
  if (!b.steps.length) return "Add at least one step to the block first.";
  const ids = new Set<string>();
  for (const s of b.steps) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || typeof s.name !== "string" || typeof s.kind !== "string") return bad;
    if (ids.has(s.id)) return bad;
    ids.add(s.id);
  }
  const byId = new Map(b.steps.map((s) => [s.id, s]));
  for (const s of b.steps) {
    if (s.kind === "start" || s.kind === "end") return "The start and end steps stay in the process: a block can't hold them.";
    const parent = s.parent_step_id ?? null;
    if (parent !== null && !ids.has(parent)) return bad;
    if (s.entry_step_id && !ids.has(s.entry_step_id)) return bad;
    for (const k of STEP_NUMBERS) if (k in s && !Number.isFinite(Number(s[k])) ) return bad;
    if (s.kind === "group" && (s.role_id || s.person_id || Number(s.work_hours ?? 0) || Number(s.wait_hours ?? 0) || Number(s.rework_rate ?? 0))) {
      return "A group can't hold work of its own: its steps do the work.";
    }
    // Walk up the parent chain with a visited set of our own: a loop never reaches the top.
    const seen = new Set<string>([s.id]);
    for (let p = parent; p !== null; p = byId.get(p)?.parent_step_id ?? null) {
      if (seen.has(p)) return bad;
      seen.add(p);
    }
  }
  for (const e of b.edges) {
    if (!e || typeof e.id !== "string" || !ids.has(e.from_step_id) || !ids.has(e.to_step_id)) return bad;
    if (!Number.isFinite(Number(e.probability ?? 1))) return bad;
  }
  if (b.entry_step_id !== null && b.entry_step_id !== undefined && !b.steps.some((s) => s.id === b.entry_step_id && (s.parent_step_id ?? null) === null)) return bad;
  return null;
}

/** A block read from the database, made safe to put in: a malformed document reads as an empty block. */
export function readBlock(value: unknown): BlockBundle {
  const raw = value as Partial<BlockBundle> | null;
  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).map((s) => {
    const row = pickKeys<BlockStep>(s && typeof s === "object" ? s : {}, STEP_KEYS);
    return { ...row, parent_step_id: row.parent_step_id ?? null, entry_step_id: row.entry_step_id ?? null };
  });
  const edges = (Array.isArray(raw?.edges) ? raw.edges : []).map((e) => pickKeys<BlockEdge>(e && typeof e === "object" ? e : {}, EDGE_KEYS));
  const normal: BlockBundle = { steps, edges, entry_step_id: typeof raw?.entry_step_id === "string" ? raw.entry_step_id : null };
  const problem = blockProblem(normal);
  // An empty block reads as empty; anything else wrong with it reads as nothing at all.
  return problem && problem !== "Add at least one step to the block first." ? { steps: [], edges: [], entry_step_id: null } : normal;
}

/** Parents before the steps inside them, so a group is always written before its steps. */
function parentsFirst(steps: readonly BlockStep[]): BlockStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depth = (s: BlockStep) => ancestorsOf(s.id, byId).length;
  return [...steps].sort((a, b) => depth(a) - depth(b));
}

/**
 * A new group named `name`, holding fresh copies of the block's steps and the connections among them: every step and edge
 * has a new id, and the copies point at each other. The group sits in `parent` at (x, y).
 */
function materialize(
  bundle: ProcessBundle,
  block: BlockBundle,
  name: string,
  parent: string | null,
  x: number,
  y: number,
  blockId: string | null = null,
): { group: StepRow; steps: StepRow[]; edges: EdgeRow[] } {
  const { revision } = bundle;
  const owner = { revision_id: revision.id, workspace_id: revision.workspace_id, process_id: revision.process_id };
  const ids = new Map(block.steps.map((s) => [s.id, newId()]));
  const roles = new Set(bundle.roles.map((r) => r.id));
  const people = new Set(bundle.people.map((p) => p.id));
  const base = groupRow(bundle, x, y, parent);
  const entry = block.entry_step_id ?? entryOf(block.steps, block.edges);
  const group: StepRow = {
    ...base,
    name: name.trim().slice(0, NAME_MAX) || "Block",
    entry_step_id: entry ? (ids.get(entry) ?? null) : null,
    // The insertion record (P8): which library block this group came from. A solution's map carries it, so the library can count the solutions using a block.
    ...(blockId ? { provenance: { ...(base.provenance ?? {}), [BLOCK_MARK]: blockId } as unknown as StepRow["provenance"] } : {}),
  };
  const steps = parentsFirst(block.steps).map(
    (s): StepRow => ({
      ...pickKeys<BlockStep>(s, STEP_KEYS),
      ...owner,
      id: ids.get(s.id)!,
      parent_step_id: s.parent_step_id === null || s.parent_step_id === undefined ? group.id : ids.get(s.parent_step_id)!,
      entry_step_id: s.entry_step_id ? (ids.get(s.entry_step_id) ?? null) : null,
      rework_to_step_id: s.rework_to_step_id ? (ids.get(s.rework_to_step_id) ?? null) : null,
      work_params: { ...s.work_params },
      wait_params: { ...s.wait_params },
      provenance: structuredClone(s.provenance ?? {}),
      // Fresh copies: nothing is sitting at them, and none holds a child process.
      current_wip: null,
      child_process_id: null,
      // A purpose from another workspace's list that this one lacks reads as Automatic; an older block has none.
      purpose: typeof s.purpose === "string" && STEP_PURPOSE_KEY.test(s.purpose) ? s.purpose : null,
      // Base values (capacity P4) travel with the block; an older block has none.
      split: s.split ? { ...s.split } : null,
      split_notes: s.split_notes ? { ...s.split_notes } : null,
      tier_multiplier: s.tier_multiplier ? { ...s.tier_multiplier } : null,
      to_client_manager: s.to_client_manager === true,
      // A role or person deleted since the block was saved would fail the foreign key.
      role_id: s.role_id && roles.has(s.role_id) ? s.role_id : null,
      person_id: s.person_id && people.has(s.person_id) ? s.person_id : null,
    }),
  );
  const edges = block.edges.map((e): EdgeRow => ({ ...pickKeys<BlockEdge>(e, EDGE_KEYS), ...owner, id: newId(), from_step_id: ids.get(e.from_step_id)!, to_step_id: ids.get(e.to_step_id)! }));
  return { group, steps, edges };
}

/** A step card's rough size on the map. */
const CARD = { w: 200, h: 90 };

/** The first spot at or below (x, y) where a box of this size touches none of the siblings in `parent`. */
function freeSpotFor(bundle: ProcessBundle, parent: string | null, x: number, y: number, size: { width: number; height: number }): { x: number; y: number } {
  const boxes = bundle.steps
    .filter((s) => (s.parent_step_id ?? null) === parent)
    .map((s) => {
      const { width, height } = isGroup(s) ? openGroupSize(bundle.steps, s.id, "all") : { width: CARD.w, height: CARD.h };
      return { x: Number(s.x), y: Number(s.y), w: width, h: height };
    });
  const clash = (py: number) => boxes.some((b) => x < b.x + b.w && b.x < x + size.width && py < b.y + b.h && b.y < py + size.height);
  for (let i = 0; i < 60 && clash(y); i++) y += 40;
  return { x, y };
}

const stepOf = (bundle: ProcessBundle, id: string | null) => (id ? bundle.steps.find((s) => s.id === id) : undefined);

/**
 * Put a block into the process after the selected step or group, in the same group as it (so inside a nested group, the
 * block lands inside it). It arrives as a new group named after the block, joined in like `addAfter` does: a selected step
 * with nothing after it leads to the block, one with a single next step now leads to the block, which leads on to that
 * step. A step with branches, or an end step, gets the block placed beside it, unconnected. With nothing selected it goes
 * at the end of the top level, unless `view` (what the person is looking at) is given: then its box goes at the free place
 * nearest the view's centre, as `addAfter` does. The new steps are new rows, so they show as added.
 */
export function insertBlock(bundle: ProcessBundle, selectedId: string | null, block: BlockBundle, name: string, blockId: string | null = null, view?: ViewHint | null): { edit: Edit; id: string; note?: string } | null {
  if (blockProblem(block)) return null;
  const sel = stepOf(bundle, selectedId);
  const parent = sel ? (sel.parent_step_id ?? null) : null;
  const siblings = bundle.steps.filter((s) => (s.parent_step_id ?? null) === parent);
  const outgoing = sel && sel.kind !== "end" ? bundle.edges.filter((e) => e.from_step_id === sel.id) : [];
  const branches = outgoing.length > 1;
  const x0 = sel ? Number(sel.x) + (branches ? 0 : 240) : siblings.reduce((m, s) => Math.max(m, Number(s.x) + 240), 0);
  const y0 = sel ? Number(sel.y) + (branches ? 120 : 0) : siblings.length ? Number(siblings[siblings.length - 1]!.y) : 0;
  // Build it once to measure the box it needs, then put the group where that box fits.
  const probe = materialize(bundle, block, name, parent, 0, 0, blockId);
  const size = openGroupSize([probe.group, ...probe.steps], probe.group.id, "all");
  const at = !sel && view ? nearestFreeSpot(bundle, view, size) : freeSpotFor(bundle, parent, x0, y0, size);
  const made = { ...probe, group: { ...probe.group, x: at.x, y: at.y } };

  const ops: Op[] = [];
  const rows = [made.group, ...made.steps];
  if (sel && sel.kind !== "end" && outgoing.length === 0) {
    ops.push({ kind: "insert", steps: rows, edges: [...made.edges, edgeRow(bundle, sel.id, made.group.id, 1)] });
  } else if (sel && sel.kind !== "end" && outgoing.length === 1) {
    const next = outgoing[0]!;
    // sel -> block keeps the old connection's share and tag; block -> next carries on at 100%.
    ops.push({ kind: "insert", steps: rows, edges: [...made.edges, edgeRow(bundle, made.group.id, next.to_step_id, 1)] });
    ops.push({ kind: "update", changes: [{ table: "edges", id: next.id, before: { to_step_id: next.to_step_id }, after: { to_step_id: made.group.id } }] });
  } else {
    ops.push({ kind: "insert", steps: rows, edges: made.edges });
  }
  const note = sel && branches ? `${sel.name} has branches: connect the block yourself.` : sel?.kind === "end" ? `${sel.name} is an end step, so nothing leads on from it: connect the block yourself.` : undefined;
  return { edit: { label: `Inserted ${made.group.name}`, ops }, id: made.group.id, ...(note ? { note } : {}) };
}

/** Why the selection can't be replaced by a block, or null. */
export function replaceProblem(bundle: ProcessBundle, selectedId: string | null): string | null {
  const sel = stepOf(bundle, selectedId);
  if (!sel) return "Select the step or group the block should replace.";
  if (sel.kind === "start" || sel.kind === "end") return "The start and end steps stay in the process.";
  return null;
}

/**
 * Swap the selected step or group for a block: a new group named after the block takes its place. Everything that led
 * into the selection (or into a step inside it) leads into the block, what led out of it (or out of one step inside it)
 * leads out of the block, and a group whose first step it was now starts at the block. The selection, and the steps inside it if it is a group, are removed (undo brings
 * them back). The block's steps are new rows, so they show as added.
 */
export function replaceWithBlock(bundle: ProcessBundle, selectedId: string, block: BlockBundle, name: string, blockId: string | null = null): { edit: Edit; id: string; note?: string } | null {
  if (blockProblem(block) || replaceProblem(bundle, selectedId)) return null;
  const sel = stepOf(bundle, selectedId)!;
  const parent = sel.parent_step_id ?? null;
  const made = materialize(bundle, block, name, parent, Number(sel.x), Number(sel.y), blockId);

  // The selection and everything inside it: a group's connections usually start or end at a step inside it.
  const byId = new Map(bundle.steps.map((s) => [s.id, s]));
  const subtree = new Set([sel.id, ...bundle.steps.filter((s) => ancestorsOf(s.id, byId).includes(sel.id)).map((s) => s.id)]);
  const crossing = bundle.edges.filter((e) => subtree.has(e.from_step_id) !== subtree.has(e.to_step_id));
  const going = crossing.filter((e) => subtree.has(e.to_step_id));
  const leaving = crossing.filter((e) => subtree.has(e.from_step_id));
  // Exits can leave from several steps inside a group; sending all of them out of the block would make the shares add up
  // to more than 100%, so keep those of one step (the selection itself if it has any, else the leftmost) and say so.
  const sources = [...new Set(leaving.map((e) => e.from_step_id))];
  const keep = sources.includes(sel.id)
    ? sel.id
    : [...sources].sort((a, c) => Number(byId.get(a)!.x) - Number(byId.get(c)!.x) || Number(byId.get(a)!.y) - Number(byId.get(c)!.y))[0];
  const kept = leaving.filter((e) => e.from_step_id === keep);
  const note =
    sources.length > 1
      ? `${sel.name} had exits from ${sources.length} steps. The block leaves where ${byId.get(keep!)!.name} did: connect the other exits yourself.`
      : undefined;

  const ops: Op[] = [{ kind: "insert", steps: [made.group, ...made.steps], edges: made.edges }];
  const changes: RowChange[] = [
    ...going.map((e): RowChange => ({ table: "edges", id: e.id, before: { to_step_id: e.to_step_id }, after: { to_step_id: made.group.id } })),
    ...kept.map((e): RowChange => ({ table: "edges", id: e.id, before: { from_step_id: e.from_step_id }, after: { from_step_id: made.group.id } })),
  ];
  if (changes.length) ops.push({ kind: "update", changes });
  const holder = stepOf(bundle, parent);
  if (holder && holder.entry_step_id === sel.id) {
    ops.push({ kind: "update", changes: [{ table: "steps", id: holder.id, before: { entry_step_id: sel.id }, after: { entry_step_id: made.group.id } }] });
  }
  const moved = applyEdit(bundle, { label: "", ops });
  const removal = deleteSteps(moved, [sel.id]);
  if (removal) ops.push(...removal.ops);
  return { edit: { label: `Replaced ${sel.name} with ${made.group.name}`, ops }, id: made.group.id, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Turn a linked process into steps (editor brainstorm, item 3). Editing a linked process changes every process that holds it, so the
// editor no longer makes links; one that is already there can be copied in as steps and the link cut.

/** A line out of a step or a process, as the graph it leaves into sees it: where it goes, its share and tag. */
interface Out {
  to: string;
  p: number;
  tag: string | null;
  label: string | null;
}

/** A process that can't be copied in, and why (thrown inside the copy, handed back as a reason). */
class Refusal extends Error {}

/**
 * Copy a linked process's live steps and lines in where its holder step is, and cut the link. Null when it can't (see
 * `turnIntoStepsProblem` for the reason).
 *
 * The holder becomes a group named after the process, around fresh copies of the process's steps (new ids, the layout kept), put
 * where the holder was. As `replaceWithBlock` does it: the lines into the holder go to the group (which starts at the copy of the
 * process's first step), the lines out of the holder go out of the group, and the holder is removed. The ends are read exactly as
 * `resolveGraph` (packages/db/src/model.ts) reads a held process:
 * - its `done` ends are the way out of the group: a line to one leads on to the holder's next steps (a step whose only lines went
 *   to `done` ends simply has none, and leaves the group; one that also has other lines gets a line to each next step, its share
 *   multiplied in, as the engine flattens it);
 * - its `won` and `lost` ends stay ends: each is copied in as an end step of this process, beside the group.
 * A process held inside the copied one is turned into steps too (a group inside the group), so no link is left. It needs `bundle.otherProcesses`
 * to hold it, as the model does.
 *
 * `part` is the held process at its live version (`bundle.otherProcesses`). One edit, so one undo.
 */
export function turnIntoSteps(bundle: ProcessBundle, holderId: string, part: ProcessPart | null | undefined): { edit: Edit; id: string; note?: string } | null {
  const built = buildTurnInto(bundle, holderId, part);
  return "problem" in built ? null : built;
}

/** Why a holder can't be turned into steps, or null if it can. */
export function turnIntoStepsProblem(bundle: ProcessBundle, holderId: string, part: ProcessPart | null | undefined): string | null {
  const built = buildTurnInto(bundle, holderId, part);
  return "problem" in built ? built.problem : null;
}

function buildTurnInto(bundle: ProcessBundle, holderId: string, part: ProcessPart | null | undefined): { edit: Edit; id: string; note?: string } | { problem: string } {
  const holder = stepOf(bundle, holderId);
  if (!holder) return { problem: "That step isn't on this map." };
  // A card on the company map is a whole process by design (hand-off lines join them), not something the editor unpacks.
  if (bundle.process.is_company) return { problem: "A card on the company map stands for a whole process. It stays a link; only the company map's own editor changes it." };
  if (!holder.child_process_id) return { problem: `${holder.name} isn't a linked process.` };
  if (!part || part.process.id !== holder.child_process_id || !part.process.live_revision_id) {
    return { problem: `${holder.name} has no published version yet, so there is nothing to copy in. Publish it first.` };
  }
  try {
    return copyIn(bundle, holder, part);
  } catch (err) {
    if (err instanceof Refusal) return { problem: err.message };
    throw err;
  }
}

function copyIn(bundle: ProcessBundle, holder: StepRow, part: ProcessPart): { edit: Edit; id: string; note?: string } {
  const owner = { revision_id: bundle.revision.id, workspace_id: bundle.revision.workspace_id, process_id: bundle.revision.process_id };
  const parts = new Map([...(bundle.otherProcesses ?? []), part].map((p) => [p.process.id, p]));
  const parent = holder.parent_step_id ?? null;
  const made: { steps: StepRow[]; edges: EdgeRow[]; ends: StepRow[] } = { steps: [], edges: [], ends: [] };
  /** The copy of each won/lost end, by the id it had. */
  const endCopies = new Map<string, string>();

  const group = { ...groupRow(bundle, Number(holder.x), Number(holder.y), parent), name: part.process.name.trim().slice(0, NAME_MAX) || holder.name };
  const outsOfHolder: Out[] = bundle.edges
    .filter((e) => e.from_step_id === holder.id)
    .map((e) => ({ to: e.to_step_id, p: Number(e.probability), tag: e.condition_tag, label: e.label }));

  /** Copy one process's graph into `into` (a group row), `exits` being where its `done` ends lead. Returns the group with its first step set. */
  const copyGraph = (p: ProcessPart, into: StepRow, exits: readonly Out[], stack: readonly string[]): StepRow => {
    const starts = p.steps.filter((s) => s.kind === "start");
    const startLines = starts.length === 1 ? p.edges.filter((e) => e.from_step_id === starts[0]!.id) : [];
    if (startLines.length !== 1) throw new Refusal(`${p.process.name} can't be copied in: its start step needs exactly one line, to its first step.`);
    const working = p.steps.filter((s) => s.kind !== "start" && s.kind !== "end");
    const ids = new Map(working.map((s) => [s.id, newId()]));
    const entry = ids.get(startLines[0]!.to_step_id);
    if (!entry) throw new Refusal(`${p.process.name} can't be copied in: its start step doesn't lead to a step.`);
    const done = new Set(p.steps.filter((s) => s.kind === "end" && s.outcome === "done").map((s) => s.id));

    // Where each line of the process goes in the copy.
    const target = (to: string): string => {
      const step = ids.get(to);
      if (step) return step;
      const end = p.steps.find((s) => s.id === to);
      if (end?.kind !== "end") throw new Refusal(`${p.process.name} can't be copied in: a line in it leads nowhere.`);
      let copy = endCopies.get(end.id);
      if (!copy) {
        copy = newId();
        endCopies.set(end.id, copy);
        made.ends.push({ ...end, ...owner, id: copy, parent_step_id: null, entry_step_id: null, rework_to_step_id: null, work_params: { ...end.work_params }, wait_params: { ...end.wait_params }, provenance: structuredClone(end.provenance ?? {}), current_wip: null, child_process_id: null });
      }
      return copy;
    };
    /** The lines out of one step of the process, in the copy (the shape `flattenModel` gives them). */
    const linesOut = (source: StepRow, shortcut: boolean): Out[] => {
      const lines = p.edges.filter((e) => e.from_step_id === source.id);
      const leaves = lines.length > 0 && lines.every((e) => done.has(e.to_step_id));
      // Only done lines, from the top of the process: leave the group, which is where the engine sends them.
      if (shortcut && leaves && (source.parent_step_id ?? null) === null) return [];
      const outs: Out[] = [];
      for (const e of lines) {
        const share = Number(e.probability);
        if (!done.has(e.to_step_id)) {
          outs.push({ to: target(e.to_step_id), p: share, tag: e.condition_tag, label: e.label });
          continue;
        }
        // Nowhere to go on to: fine when every line of the step is a way out (it leaves the group, and the group leaves as it does).
        if (!exits.length && leaves && (source.parent_step_id ?? null) === null) continue;
        if (!exits.length) throw new Refusal(`${holder.name} leads nowhere yet, and ${p.process.name} has a step with more than one way on. Join ${holder.name} to a next step first.`);
        for (const o of exits) outs.push({ to: o.to, p: share * o.p, tag: e.condition_tag ?? o.tag, label: e.label });
      }
      // Two lines to the same step become one.
      const merged = new Map<string, Out>();
      for (const o of outs) {
        const seen = merged.get(o.to);
        merged.set(o.to, seen ? { ...seen, p: seen.p + o.p } : o);
      }
      return [...merged.values()];
    };

    // Top-level steps keep their layout, moved so the group's box has its padding around them.
    const top = working.filter((s) => (s.parent_step_id ?? null) === null);
    const dx = top.length ? GROUP_PADDING.left - Math.min(...top.map((s) => Number(s.x))) : 0;
    const dy = top.length ? GROUP_PADDING.top - Math.min(...top.map((s) => Number(s.y))) : 0;

    for (const s of working) {
      const id = ids.get(s.id)!;
      const isTop = (s.parent_step_id ?? null) === null;
      const base: StepRow & { replaced_by?: unknown } = { ...s };
      delete base.replaced_by;
      const row: StepRow = {
        ...base,
        ...owner,
        id,
        parent_step_id: isTop ? into.id : (ids.get(s.parent_step_id!) ?? into.id),
        entry_step_id: s.entry_step_id ? (ids.get(s.entry_step_id) ?? null) : null,
        rework_to_step_id: s.rework_to_step_id ? (ids.get(s.rework_to_step_id) ?? null) : null,
        work_params: { ...s.work_params },
        wait_params: { ...s.wait_params },
        provenance: structuredClone(s.provenance ?? {}),
        split: s.split ? { ...s.split } : null,
        split_notes: s.split_notes ? { ...s.split_notes } : null,
        tier_multiplier: s.tier_multiplier ? { ...s.tier_multiplier } : null,
        current_wip: null,
        child_process_id: null,
        x: isTop ? Math.round(Number(s.x) + dx) : s.x,
        y: isTop ? Math.round(Number(s.y) + dy) : s.y,
      };
      if (s.child_process_id) {
        const inner = parts.get(s.child_process_id);
        if (stack.includes(s.child_process_id)) throw new Refusal(`${p.process.name} links to ${inner?.process.name ?? s.name}, which would put it inside itself. Take one of the links out first.`);
        if (!inner || !inner.process.live_revision_id) throw new Refusal(`Publish ${s.name} first: ${p.process.name} links to it, and it has no published version yet.`);
        // A process held inside is copied in too, as a group inside the group: the lines out of its holder lead where they did.
        const box: StepRow = { ...row, kind: "group", role_id: null, person_id: null, work_hours: 0, wait_hours: 0, rework_rate: 0, rework_to_step_id: null };
        const next = linesOut(s, false);
        made.edges.push(...outEdges(bundle, id, linesOut(s, true), owner));
        made.steps.push(copyGraph(inner, box, next, [...stack, s.child_process_id]));
        continue;
      }
      made.steps.push(row);
      made.edges.push(...outEdges(bundle, id, linesOut(s, true), owner));
    }
    return { ...into, entry_step_id: entry };
  };

  if (part.process.id === bundle.process.id) throw new Refusal(`${holder.name} links to this process itself.`);
  const filled = copyGraph(part, group, outsOfHolder, [bundle.process.id, part.process.id]);

  // Ends copied in sit to the right of the group's box (or of the top-level box it is in).
  const rows = [filled, ...made.steps];
  const size = openGroupSize(rows, filled.id, "all");
  const byId = new Map(bundle.steps.map((s) => [s.id, s]));
  let root = holder;
  for (let n = 0; root.parent_step_id && byId.has(root.parent_step_id) && n < 50; n++) root = byId.get(root.parent_step_id)!;
  const endX = Math.round(Number(root.x) + (root === holder ? size.width : openGroupSize(bundle.steps, root.id, "all").width) + 48);
  const ends = made.ends.map((e, i) => ({ ...e, x: endX, y: Math.round(Number(root.y) + i * 70) }));

  const ordered = parentsFirstRows(made.steps, filled.id);
  const ops: Op[] = [{ kind: "insert", steps: [filled, ...ends, ...ordered], edges: made.edges }];
  const into = bundle.edges.filter((e) => e.to_step_id === holder.id);
  const out = bundle.edges.filter((e) => e.from_step_id === holder.id);
  const changes: RowChange[] = [
    ...into.map((e): RowChange => ({ table: "edges", id: e.id, before: { to_step_id: e.to_step_id }, after: { to_step_id: filled.id } })),
    ...out.map((e): RowChange => ({ table: "edges", id: e.id, before: { from_step_id: e.from_step_id }, after: { from_step_id: filled.id } })),
  ];
  if (changes.length) ops.push({ kind: "update", changes });
  const outer = stepOf(bundle, parent ?? "");
  if (outer && outer.entry_step_id === holder.id) {
    ops.push({ kind: "update", changes: [{ table: "steps", id: outer.id, before: { entry_step_id: holder.id }, after: { entry_step_id: filled.id } }] });
  }
  const moved = applyEdit(bundle, { label: "", ops });
  const removal = deleteSteps(moved, [holder.id]);
  if (removal) ops.push(...removal.ops);
  const note = ends.length ? `${part.process.name} has its own ${ends.map((e) => (e.outcome ?? "done")).join(" and ")} end. ${ends.length === 1 ? "It is" : "They are"} copied in beside the group.` : undefined;
  return { edit: { label: `Turned ${holder.name} into steps`, ops }, id: filled.id, ...(note ? { note } : {}) };
}

/** Rows for the lines out of a step, from the copy's id. */
function outEdges(bundle: ProcessBundle, from: string, outs: readonly Out[], owner: Pick<EdgeRow, "revision_id" | "workspace_id" | "process_id">): EdgeRow[] {
  return outs.map((o) => ({ ...edgeRow(bundle, from, o.to, o.p), ...owner, condition_tag: o.tag, label: o.label }));
}

/** Groups before the steps inside them (the database checks a group's shape as each row lands). */
function parentsFirstRows(steps: readonly StepRow[], root: string): StepRow[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depth = (s: StepRow) => ancestorsOf(s.id, byId).filter((a) => a !== root).length;
  return [...steps].sort((a, b) => depth(a) - depth(b));
}
