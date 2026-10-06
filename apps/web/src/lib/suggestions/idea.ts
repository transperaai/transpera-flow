// A solution idea as a map (A52 slice 2): the proposed steps become a block, so the Suggestions card can draw them with the
// block library's picture and the Editor can put them in with the same commands as a library block (insert, or replace the
// step the idea would replace). Pure: no I/O.

import type { BlockBundle, BlockEdge, BlockStep, ProcessBundle, ProposalRow, ProposedStep } from "@transpera-flow/db";
import { parsePatches, type ScenarioPatch } from "@transpera-flow/engine";
import { blockProblem, insertBlock, replaceProblem, replaceWithBlock } from "@/lib/blocks/blocks";
import type { Edit } from "@/lib/editor/ops";
import { solutionEditorHref } from "@/lib/solutions/links";

/** The kinds a block can hold. Anything else an idea names (a start or end step, a made-up kind) becomes a task. */
const BLOCK_KINDS = ["task", "wait", "decision"] as const;
type BlockKind = (typeof BLOCK_KINDS)[number];

/** How far apart the steps sit on the map, left to right, as the Editor's own default spacing. */
const GAP = 240;

/** An idea can't have more steps than the database accepts (the MCP tool caps it at the same number). */
export const MAX_IDEA_STEPS = 30;

/** A solution idea's payload as it can safely be read: whatever was stored, a well-formed idea (A52). */
export interface ReadIdea {
  steps: ProposedStep[];
  /** Null when the payload gave no (usable) list: the steps are then a chain in order. */
  edges: { from: string; to: string }[] | null;
  replaces: string[];
  expect: string | null;
  /** Lever changes the idea brings (B4: a visitor's moves), through `parsePatches`; anything invalid counts as none. */
  levers: ScenarioPatch[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Read a stored idea payload defensively: the database only checks that `steps` is an array, so anything may be in it (a person
 * with edit access can insert one, and a visitor's proposal from a play link will too). Only object steps are kept, up to 30; a
 * name is made a string (else "Step n"); a key is a unique string (else `s<n>`); a role only counts when it is a string; edges and
 * replaced steps are read only when they are lists, keeping string ids, and an edge from a step to itself or to a step that isn't
 * there is dropped. Nothing here throws.
 */
export function readIdea(payload: unknown): ReadIdea {
  const p = isObject(payload) ? payload : {};
  const raw = Array.isArray(p.steps) ? p.steps : [];
  const used = new Set<string>();
  const steps: ProposedStep[] = [];
  for (const s of raw.filter(isObject).slice(0, MAX_IDEA_STEPS)) {
    const n = steps.length + 1;
    let key = typeof s.key === "string" && s.key.trim() ? s.key : `s${n}`;
    if (used.has(key)) key = `s${n}`;
    for (let i = 0; used.has(key); i++) key = `s${n}_${i}`;
    used.add(key);
    const name = typeof s.name === "string" ? s.name.trim() : typeof s.name === "number" ? String(s.name) : "";
    const step: ProposedStep = { key, name: name.slice(0, 200) || `Step ${n}` };
    if (typeof s.kind === "string") step.kind = s.kind;
    if (typeof s.role === "string" && s.role.trim()) step.role = s.role;
    if (typeof s.block_id === "string") step.block_id = s.block_id;
    if (s.ai === true) step.ai = true;
    steps.push(step);
  }
  const edges = Array.isArray(p.edges)
    ? p.edges.flatMap((e) => (isObject(e) && typeof e.from === "string" && typeof e.to === "string" && e.from !== e.to && used.has(e.from) && used.has(e.to) ? [{ from: e.from, to: e.to }] : []))
    : null;
  const replaces = Array.isArray(p.replaces_step_ids) ? p.replaces_step_ids.filter((x): x is string => typeof x === "string") : [];
  const levers = parsePatches(p.levers);
  return { steps, edges, replaces, expect: typeof p.expect === "string" && p.expect.trim() ? p.expect.trim() : null, levers: levers.ok ? levers.patches : [] };
}

/**
 * The idea's steps as a block: one step each, in the order given, joined by the idea's edges (a chain when it gave none).
 * `roles` names the workspace's roles so a step's `role` ("Sales") becomes that role's id; a role that isn't there is left
 * unset. An AI step is a task that takes a few minutes and says so in its tool. Reads the payload with `readIdea`, so it never throws.
 */
export function ideaToBlock(payload: unknown, roles: readonly { id: string; name: string }[] = []): BlockBundle {
  const idea = readIdea(payload);
  const steps: BlockStep[] = idea.steps.map((s, i) => {
    const kind: BlockKind = (BLOCK_KINDS as readonly string[]).includes(s.kind ?? "") ? (s.kind as BlockKind) : "task";
    const role = s.role ? roles.find((r) => r.name.trim().toLowerCase() === s.role!.trim().toLowerCase()) : undefined;
    return {
      id: s.key,
      name: s.name,
      kind,
      outcome: null,
      role_id: role?.id ?? null,
      person_id: null,
      work_hours: kind === "task" ? (s.ai ? 0.1 : 1) : 0,
      work_dist: "lognormal",
      work_params: {},
      wait_hours: kind === "wait" ? 8 : 0,
      wait_dist: "lognormal",
      wait_params: {},
      rework_rate: 0,
      rework_to_step_id: null,
      tool: s.ai ? "AI" : null,
      notes: s.ai ? "Proposed by AI. Check the time it takes." : null,
      sla_hours: null,
      expected_wait_hours: null,
      lost_per_day_waiting: null,
      dropoff_benchmark: null,
      target_cycle_hours: null,
      current_wip: null,
      x: i * GAP,
      y: 0,
      parent_step_id: null,
      entry_step_id: null,
      child_process_id: null,
      assumption: s.ai === true,
      conflict: false,
      provenance: {},
    };
  });
  const pairs = idea.edges ?? steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id }));
  const edges: BlockEdge[] = pairs.map((e, i) => ({ id: `e${i + 1}`, from_step_id: e.from, to_step_id: e.to, probability: 1, condition_tag: null, label: null }));
  return { steps, edges, entry_step_id: steps[0]?.id ?? null };
}

/** What the Editor needs to place an idea: its name and map, and the live step it would replace (the first named). */
export interface IdeaSeed {
  id: string;
  title: string;
  block: BlockBundle;
  /** Step ids the idea would replace. */
  replaces: string[];
  /** The lever changes the idea brings, as the Editor puts them in the solution (B4). The server checks them against live first (`mapPlayChanges`). */
  levers: ScenarioPatch[];
  /** What the check against live left out, in words. */
  leverNotes: string[];
}

export function ideaSeed(p: Pick<ProposalRow, "id" | "title" | "payload">, roles: readonly { id: string; name: string }[] = []): IdeaSeed {
  const idea = readIdea(p.payload);
  return { id: p.id, title: p.title, block: ideaToBlock(p.payload, roles), replaces: idea.replaces, levers: idea.levers, leverNotes: [] };
}

/**
 * "✎ Build it": the Editor in solution mode on the issue's process, for that issue, with the idea's steps placed. Null when
 * the issue names no process (there is no map to open).
 */
export function buildIdeaHref(base: string, p: Pick<ProposalRow, "id" | "issue_id"> & Partial<Pick<ProposalRow, "created_via" | "payload">>, issue: { processId?: string | null } | undefined, from: string): string | null {
  // A visitor's idea (B4) is built on the process its link shared, and may be for no issue.
  if (p.created_via === "play_link") {
    const processId = (p.payload as { process_id?: unknown } | undefined)?.process_id;
    if (typeof processId === "string" && processId) return solutionEditorHref(base, processId, { issueId: p.issue_id, idea: p.id, from });
  }
  if (!p.issue_id || !issue?.processId) return null;
  return solutionEditorHref(base, issue.processId, { issueId: p.issue_id, idea: p.id, from });
}

/** Where an idea's steps go in the solution's copy of the map, and what to tell the person about it. */
export interface IdeaPlacement {
  /** Null when the steps couldn't be placed: the note says why and the Editor opens on the plain copy. */
  edit: Edit | null;
  /** The group the steps arrive in, to select. */
  id: string | null;
  note: string;
}

/**
 * Put an idea's steps into `bundle` (the live map, which a solution starts as a copy of): in place of the first step the idea would
 * replace that can be replaced, else at the end of the map. Pure, so the Editor can work it out before it draws anything. When
 * they can't be placed (no usable steps, or a step the Editor won't take) the result has no edit and a note saying so, never nothing.
 */
export function placeIdea(bundle: ProcessBundle, idea: IdeaSeed): IdeaPlacement {
  // A visitor's idea that only moves levers (B4) has no steps to place: the levers are listed in the Editor's Lever changes box.
  if (!idea.block.steps.length && idea.levers.length) {
    return { edit: null, id: null, note: "The idea changes levers only: they're listed under Lever changes. Adjust the map too if you like, simulate, then save." };
  }
  const problem = blockProblem(idea.block);
  const target = idea.replaces.find((id) => bundle.steps.some((s) => s.id === id) && !replaceProblem(bundle, id)) ?? null;
  const made = problem ? null : target ? replaceWithBlock(bundle, target, idea.block, idea.title) : insertBlock(bundle, null, idea.block, idea.title);
  if (!made) {
    const why = problem === "Add at least one step to the block first." ? "it has no usable steps" : "its steps can't be placed";
    return { edit: null, id: null, note: `The AI's steps weren't placed: ${why}. The map is a plain copy of the live one, so you can build the solution yourself.` };
  }
  const notes = [
    "The AI's steps are placed. Adjust them, simulate, then save.",
    target ? null : "Nothing in the map is marked as replaced, so the steps sit at the end: connect them where they belong.",
    target && idea.replaces.length > 1 ? "The idea names more than one step to replace. The first is replaced; the others are still there." : null,
    made.note ?? null,
  ];
  return { edit: made.edit, id: made.id, note: notes.filter(Boolean).join(" ") };
}
