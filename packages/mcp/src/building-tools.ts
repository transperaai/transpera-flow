// Process-building tools (docs/PRD.md §7.1, §7.1b; issue #24): add_source,
// create_process, add_step, update_step, remove_step, connect_steps,
// set_routing, import_process, publish_process, discard_draft,
// list_templates and create_from_template.
//
// Every one acts as the token's user through RLS
// (docs/adr/0002-mcp-acts-as-user-via-pre-request.md) and writes only into the
// process's draft revision, which it opens (or continues) with `open_draft`
// (docs/adr/0004-drafts-as-revisions.md); the live revision is never edited,
// and the database refuses it too (`edit_drafts_only`). Writes are ordinary
// row inserts and deletes plus per-field compare-and-set saves
// (`save_fields`, docs/adr/0001-per-field-saves.md), exactly what the canvas
// sends, so open editors see them through Realtime and a field someone else
// changed meanwhile is reported, not overwritten. The rules for values,
// evidence and the graph live in building.ts; the text is templated, never
// written by a language model. Every row write is audit-logged with
// actor_kind 'mcp' (migration 20261013000000_mcp_building.sql).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  checklistItems,
  EVIDENCE_COLUMNS,
  linkColumns,
  listProcesses,
  loadProcessBundle,
  SOURCE_COLUMNS,
  type EdgeRow,
  type Json,
  type ProcessBundle,
  type SourceRow,
  type StepRow,
} from "@transpera-flow/db";
import {
  BUILD_STEP_KINDS,
  IMPORT_STEP_KINDS,
  buildNewStep,
  buildStepChange,
  connectionProblem,
  DISTRIBUTIONS,
  flattenNesting,
  graphWarnings,
  isUuid,
  nextOutcome,
  normalizeName,
  outgoingTotal,
  OUTCOMES,
  placeStep,
  planImport,
  resolveName,
  reworkProblem,
  revisionDiff,
  startProblem,
  type BuildStepKind,
  type Citation,
  type EdgeChange,
  type Holder,
  type Graph,
  type ImportEdge,
  type ImportPlan,
  type ImportStep,
  type Stamp,
  type StepFields,
  type StepOwner,
} from "./building";
import { resolveProcess, resolveWorkspace, type ProcessWithDraft, type ToolContext, type WorkspaceRef } from "./context";
import { runTool, ToolError } from "./result";
import { NEEDS_LINKS, linkJson, linksArg, recordIssueSources, resolveLinks } from "./source-links";
import { PROCESS_TEMPLATES, type ProcessTemplate } from "./templates";

export const BUILDING_TOOL_NAMES = [
  "add_source",
  "link_source",
  "create_process",
  "add_step",
  "update_step",
  "remove_step",
  "connect_steps",
  "set_routing",
  "import_process",
  "publish_process",
  "discard_draft",
  "list_templates",
  "create_from_template",
] as const;

const MAX_IMPORT_STEPS = 200;
/** Most processes and steps one import creates in one transaction (the same limits as `import_new_process`). */
const MAX_IMPORT_PROCESSES = 200;
const MAX_IMPORT_TOTAL_STEPS = 1000;
const MAX_IMPORT_EDGES = 500;
const PROBABILITY_TOLERANCE = 1e-3;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const workspaceArg = z.string().optional().describe("Workspace id, slug or name. Defaults to the active workspace (set_active_workspace).");
const processArg = z.string().optional().describe("Process id or name. Defaults to the workspace's only process.");
const stepRef = z.string().min(1).describe("Step id, or its name (a unique part of it is enough; an ambiguous name returns candidates).");

const citationArg = z
  .object({
    field: z.enum(EVIDENCE_COLUMNS).describe("The value the quote supports."),
    source: z.string().min(1).describe("Source id (from add_source) or title."),
    speaker: z.string().max(200).nullish(),
    quote: z.string().trim().min(1).max(2000).describe("The speaker's words, verbatim."),
    timestamp: z.string().max(100).nullish().describe("Where in the source: a time in the recording ('00:14:05'), a page or a date."),
    value: z
      .number()
      .min(0)
      .nullish()
      .describe("The number stated, in the field's units: hours, a 0–1 share for rework_rate, items for current_wip. Different values across citations become a conflict."),
  })
  .strict();

const paramsArg = z
  .object({ cv: z.number().min(0).nullish(), min: z.number().min(0).nullish(), mode: z.number().min(0).nullish(), max: z.number().min(0).nullish() })
  .strict()
  .describe("Lognormal takes cv (spread relative to the mean); triangular takes min, mode and max in hours.");

const stepFieldsShape = {
  kind: z.enum(BUILD_STEP_KINDS).optional().describe("task (default), wait, decision, start or end."),
  outcome: z.enum(OUTCOMES).optional().describe("End steps only: won, lost or done."),
  role: z.string().nullish().describe("Role id or name (an existing role of the workspace); null for none."),
  person: z.string().nullish().describe("Person id or name to pin the step to; null for anyone in the role."),
  work_hours: z.number().min(0).max(10_000).optional().describe("Hands-on hours per item (mean)."),
  work_dist: z.enum(DISTRIBUTIONS).optional(),
  work_params: paramsArg.optional(),
  wait_hours: z.number().min(0).max(100_000).optional().describe("Waiting hours per item (mean)."),
  wait_dist: z.enum(DISTRIBUTIONS).optional(),
  wait_params: paramsArg.optional(),
  rework_rate: z.number().min(0).max(1).optional().describe("Share of items sent back (0–1)."),
  rework_to: z.string().nullish().describe("Step the rework goes back to (id or name); null repeats this step."),
  tool: z.string().max(200).nullish(),
  notes: z.string().max(4000).nullish(),
  sla_hours: z.number().min(0).nullish(),
  current_wip: z.number().int().min(0).nullish().describe("Items sitting at this step now."),
  x: z.number().min(-1e6).max(1e6).optional(),
  y: z.number().min(-1e6).max(1e6).optional(),
  evidence: z.array(citationArg).max(50).optional().describe("Citations for the step's numbers: every number that came from a source should cite it."),
  assumptions: z
    .array(z.object({ field: z.enum(EVIDENCE_COLUMNS), reasoning: z.string().trim().min(1).max(2000) }).strict())
    .max(10)
    .optional()
    .describe("Reasoning for numbers no source states; each stays an assumption to confirm."),
};

type StepFieldsJson = z.infer<z.ZodObject<typeof stepFieldsShape>>;

/** A step of process_json: the step tools' fields, plus the steps it holds and the child process it holds (issue #102). */
export interface ImportStepJson extends Omit<StepFieldsJson, "kind"> {
  id?: string;
  name: string;
  kind?: BuildStepKind;
  parent?: string | null;
  entry?: string | null;
  steps?: ImportStepJson[];
  child_process?: string;
  process?: ProcessJson;
}

export interface ImportEdgeJson {
  from: string;
  to: string;
  probability?: number;
  condition_tag?: string | null;
  label?: string | null;
}

export interface ProcessJson {
  name?: string;
  kind?: "pipeline" | "servicing";
  entity_name?: string;
  description?: string | null;
  steps: ImportStepJson[];
  edges?: ImportEdgeJson[];
  remove_missing?: boolean;
  assumptions?: { step: string; field: (typeof EVIDENCE_COLUMNS)[number]; reasoning: string }[];
}

const importStepArg: z.ZodType<ImportStepJson> = z.lazy(() =>
  z
    .object({
      id: z.string().optional().describe("The step's stable id, to match an existing step exactly."),
      name: z.string().trim().min(1).max(200),
      ...stepFieldsShape,
      kind: z
        .enum(IMPORT_STEP_KINDS)
        .optional()
        .describe(
          "task (default), wait, decision, start or end; or group (a box of steps inside this process: give it `steps`) or subprocess " +
            "(a step that holds a child process: give it `child_process` or `process`). A group and a sub-process step have no hours, role or rework of their own.",
        ),
      parent: z.string().nullish().describe("The group this step sits in (a group's name or id), instead of listing it in the group's `steps`; null for the top level."),
      entry: z.string().nullish().describe("A group's first step (name or id). Default: the first of its `steps`."),
      steps: z
        .array(importStepArg)
        .max(MAX_IMPORT_STEPS)
        .optional()
        .describe("A group's steps (the step is then a group). They can hold groups too, to any depth. Edges to and from them go in the process's `edges`, by name; names stay unique across the whole JSON."),
      child_process: z.string().optional().describe("A sub-process step: an existing process (id or name) that becomes its child, shown inside this step. It must not already sit inside another process."),
      process: processJsonArg.optional().describe("A sub-process step: a new child process to create in this call (same shape as process_json; its name defaults to this step's name), or, if the step already holds one, the steps to write into it."),
    })
    .strict(),
);
/** A step tool's arguments (add_step, update_step, a step of process_json). */
type StepArgs = Partial<Omit<StepFieldsJson, "kind"> & { name: string; kind: BuildStepKind }>;
const importEdgeArg = z
  .object({
    from: z.string().min(1).describe("Step id or name (in process_json or the process)."),
    to: z.string().min(1),
    probability: z.number().min(0).max(1).optional(),
    condition_tag: z.string().max(100).nullish(),
    label: z.string().max(200).nullish(),
  })
  .strict();
const processJsonArg: z.ZodType<ProcessJson> = z.lazy(() =>
  z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      kind: z.enum(["pipeline", "servicing"]).optional(),
      entity_name: z.string().trim().min(1).max(100).optional(),
      description: z.string().max(4000).nullish(),
      steps: z.array(importStepArg).max(MAX_IMPORT_STEPS),
      edges: z.array(importEdgeArg).max(MAX_IMPORT_EDGES).optional(),
      remove_missing: z.boolean().optional().describe("With target: remove the draft's steps process_json doesn't list (default false)."),
      assumptions: z
        .array(z.object({ step: z.string().min(1), field: z.enum(EVIDENCE_COLUMNS), reasoning: z.string().trim().min(1).max(2000) }).strict())
        .max(500)
        .optional()
        .describe("Reasoning for numbers no source states, by step name (the same as a step's own `assumptions`)."),
    })
    .strict(),
);

const routeArg = z
  .object({
    to: z.string().min(1).describe("Step id or name."),
    probability: z.number().min(0).max(1),
    condition_tag: z.string().max(100).nullish(),
    label: z.string().max(200).nullish(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function check<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data as T;
}

/** A write RLS, a trigger or a check refused, as a ToolError the caller can act on. */
export function writeError(error: { code?: string; message?: string }, what: string): ToolError {
  if (error.code === "42501") return new ToolError("forbidden", `You don't have permission to ${what} in this workspace (editors and owners can).`);
  if (error.code === "55000") return new ToolError("not_draft", "That revision is no longer a draft (someone published or discarded it); call the tool again to open a new draft.");
  if (error.code === "23514") return new ToolError("invalid_input", `Some of those values aren't allowed: ${error.message ?? ""}`.trim());
  if (error.code === "23503") return new ToolError("not_found", "Something that change refers to no longer exists.");
  if (error.code === "23505") return new ToolError("duplicate", `That already exists: ${error.message ?? ""}`.trim());
  return new ToolError("write_failed", `Couldn't ${what}: ${error.message ?? "unknown error"}`);
}

const userIds = new WeakMap<ToolContext, Promise<string | null>>();

/** The token owner's user id, for provenance `by` (read once per request). */
function userIdOf(ctx: ToolContext): Promise<string | null> {
  if (ctx.userId !== undefined) return Promise.resolve(ctx.userId);
  let p = userIds.get(ctx);
  if (!p) {
    p = Promise.resolve(ctx.db.from("api_tokens").select("user_id").eq("token_hash", ctx.tokenHash).maybeSingle()).then(
      (r) => (r.data as { user_id: string } | null)?.user_id ?? null,
      () => null,
    );
    userIds.set(ctx, p);
  }
  return p;
}

async function stampOf(ctx: ToolContext): Promise<Stamp> {
  return { at: new Date().toISOString(), by: await userIdOf(ctx) };
}

const newId = (): string => crypto.randomUUID();

/** publish_process's change summary (private.revision_changes): ids by kind of change. */
type RevisionChanges = { added: string[]; removed: string[]; changed: string[] };

interface Draft {
  revision_id: string;
  number: number;
  created: boolean;
}

/** Open the process's draft (a copy of live with the same ids), or continue the open one. */
async function openDraft(ctx: ToolContext, proc: { id: string; name: string }): Promise<Draft> {
  const { data, error } = await ctx.db.rpc("open_draft", { target_process: proc.id });
  if (error) throw writeError(error, "edit processes");
  const r = data as { status: string; revision_id?: string; number?: number; created?: boolean };
  // open_draft locks the process for update, so a process the user may read but not edit is not found.
  if (r.status !== "ok") throw new ToolError("forbidden", `You don't have permission to edit '${proc.name}' (editors and owners can).`);
  return { revision_id: r.revision_id!, number: r.number!, created: r.created === true };
}

export interface Editing {
  ws: WorkspaceRef;
  proc: ProcessWithDraft;
  draft: Draft;
  bundle: ProcessBundle;
  owner: StepOwner;
  stamp: Stamp;
}

async function loadDraft(ctx: ToolContext, ws: WorkspaceRef, proc: ProcessWithDraft, draft: Draft): Promise<ProcessBundle> {
  return loadProcessBundle(ctx.db, ws, proc, draft.revision_id);
}

/** Resolve the workspace and process, and open (or continue) its draft. */
export async function beginEdit(ctx: ToolContext, args: { workspace?: string; process?: string }, assumptions: string[]): Promise<Editing> {
  const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
  const proc = await resolveProcess(ctx, ws, args.process, assumptions);
  const draft = await openDraft(ctx, proc);
  const bundle = await loadDraft(ctx, ws, { ...proc, draft_revision_id: draft.revision_id }, draft);
  return {
    ws,
    proc: { ...proc, draft_revision_id: draft.revision_id },
    draft,
    bundle,
    owner: { revision_id: draft.revision_id, workspace_id: ws.id, process_id: proc.id },
    stamp: await stampOf(ctx),
  };
}

/** For a step given by id with no process: the process that has it (in its draft or live revision). */
async function processForStep(ctx: ToolContext, ws: WorkspaceRef, args: { process?: string; step: string }, assumptions: string[]): Promise<string | undefined> {
  if (args.process || !isUuid(args.step.trim())) return args.process;
  const processes = await listProcesses(ctx.db, ws.id);
  if (processes.length <= 1) return undefined;
  const revisions = processes.flatMap((p) => [p.live_revision_id, p.draft_revision_id]).filter((id): id is string => !!id);
  const rows = check(await ctx.db.from("steps").select("process_id").eq("id", args.step.trim()).in("revision_id", revisions));
  const ids = [...new Set(rows.map((r) => r.process_id))];
  if (ids.length === 1) {
    assumptions.push(`No process given; using '${processes.find((p) => p.id === ids[0])?.name}', which has that step.`);
    return ids[0];
  }
  return undefined;
}

export const header = (e: Pick<Editing, "ws" | "proc" | "draft">) => ({
  workspace: { id: e.ws.id, name: e.ws.name },
  process: { id: e.proc.id, name: e.proc.name },
  draft: { revision_id: e.draft.revision_id, number: e.draft.number, opened_now: e.draft.created },
});

/** A step as the tools return it, with its role's and person's names. */
function stepOut(row: StepRow, bundle: Pick<ProcessBundle, "roles" | "people">) {
  const { revision_id: _r, workspace_id: _w, process_id: _p, ...rest } = row as StepRow & { created_at?: string; updated_at?: string; created_by?: string };
  const { created_at: _c, updated_at: _u, created_by: _b, ...out } = rest as typeof rest & { created_at?: string; updated_at?: string; created_by?: string };
  return {
    ...out,
    role: row.role_id ? { id: row.role_id, name: bundle.roles.find((r) => r.id === row.role_id)?.name ?? null } : null,
    person: row.person_id ? { id: row.person_id, name: bundle.people.find((p) => p.id === row.person_id)?.name ?? null } : null,
  };
}

const edgeOut = (e: EdgeRow, steps: readonly StepRow[]) => ({
  id: e.id,
  from: { id: e.from_step_id, name: steps.find((s) => s.id === e.from_step_id)?.name ?? null },
  to: { id: e.to_step_id, name: steps.find((s) => s.id === e.to_step_id)?.name ?? null },
  probability: Number(e.probability),
  condition_tag: e.condition_tag,
  label: e.label,
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface Lookups {
  roles: { id: string; name: string }[];
  people: { id: string; name: string }[];
  sources: (SourceRow & { name: string })[];
  steps: StepRow[];
  warnings: string[];
}

async function loadSources(ctx: ToolContext, ws: WorkspaceRef): Promise<Lookups["sources"]> {
  const rows = check(await ctx.db.from("sources").select(SOURCE_COLUMNS).eq("workspace_id", ws.id)) as unknown as SourceRow[];
  return rows.map((s) => ({ ...s, name: s.title }));
}

type Named = { id: string; name: string };

async function lookupsFor(
  ctx: ToolContext,
  ws: WorkspaceRef,
  from: { roles: readonly Named[]; people: readonly Named[]; steps: StepRow[] },
  needsSources: boolean,
  /** Sources an upload is about to add in the same transaction (not in the database yet), which its steps' evidence cites. */
  pendingSources: Lookups["sources"] = [],
): Promise<Lookups> {
  return {
    roles: from.roles.map((r) => ({ id: r.id, name: r.name })),
    people: from.people.map((p) => ({ id: p.id, name: p.name })),
    sources: needsSources ? [...(await loadSources(ctx, ws)), ...pendingSources] : [],
    steps: from.steps,
    warnings: [],
  };
}

const hasCitations = (steps: readonly { evidence?: unknown[] }[]) => steps.some((s) => s.evidence?.length);

/** Tool arguments as step fields: role, person and sources resolved to ids (ambiguous names return candidates). */
function toFields(args: StepArgs, l: Lookups, where: string): StepFields {
  const f: StepFields = {};
  if (args.name !== undefined) f.name = args.name;
  for (const key of ["kind", "outcome", "work_hours", "work_dist", "wait_hours", "wait_dist", "rework_rate", "tool", "notes", "sla_hours", "current_wip", "x", "y"] as const) {
    if (args[key] !== undefined) (f as Record<string, unknown>)[key] = args[key];
  }
  const params = (p: z.infer<typeof paramsArg> | undefined) =>
    p && Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as StepFields["work_params"];
  if (args.work_params) f.work_params = params(args.work_params);
  if (args.wait_params) f.wait_params = params(args.wait_params);
  if (args.role !== undefined) f.role_id = args.role === null ? null : resolveName(l.roles, args.role, "role", where).id;
  if (args.person !== undefined) f.person_id = args.person === null ? null : resolveName(l.people, args.person, "person", where).id;
  if (args.evidence?.length) {
    f.evidence = args.evidence.map((c): Citation => {
      const source = resolveName(l.sources, c.source, "source", where);
      const speaker = c.speaker?.trim() || null;
      if (speaker && source.speakers.length && !source.speakers.some((s) => normalizeName(s) === normalizeName(speaker))) {
        l.warnings.push(`'${speaker}' isn't listed as a speaker of '${source.title}' (${source.speakers.join(", ")}).`);
      }
      return { field: c.field, source_id: source.id, speaker, quote: c.quote, timestamp: c.timestamp ?? null, value: c.value ?? null };
    });
  }
  if (args.assumptions?.length) f.reasoning = Object.fromEntries(args.assumptions.map((a) => [a.field, a.reasoning]));
  return f;
}

/** Per-field compare-and-set of one row; fields someone else changed meanwhile are returned, not overwritten. */
async function saveFields(
  ctx: ToolContext,
  table: "steps" | "edges",
  revisionId: string,
  id: string,
  base: Record<string, unknown>,
  changes: Record<string, unknown>,
): Promise<{ field: string; theirs: unknown }[]> {
  if (!Object.keys(changes).length) return [];
  const { data, error } = await ctx.db.rpc("save_fields", {
    target: table,
    key: { revision_id: revisionId, id } as Json,
    base: base as Json,
    changes: changes as Json,
  });
  if (error) throw writeError(error, "edit processes");
  const r = data as { status: string; conflicts?: Record<string, unknown> };
  if (r.status === "not_found") throw new ToolError("not_found", `The ${table === "steps" ? "step" : "connection"} ${id} is no longer in the draft.`);
  return Object.entries(r.conflicts ?? {}).map(([field, theirs]) => ({ field, theirs }));
}

interface EditConflict {
  table: "steps" | "edges";
  id: string;
  field: string;
  theirs: unknown;
}

/** Write a plan into the draft: new steps, step changes, edge removals, changes and inserts, then step removals. */
async function applyPlan(
  ctx: ToolContext,
  revisionId: string,
  plan: Pick<ImportPlan, "insertSteps" | "updateSteps" | "removeSteps" | "insertEdges" | "updateEdges" | "removeEdges">,
): Promise<EditConflict[]> {
  const conflicts: EditConflict[] = [];
  if (plan.insertSteps.length) {
    // A group's first step is set once its steps are all in place (the database checks it when each request commits).
    const { error } = await ctx.db.from("steps").insert(plan.insertSteps.map((s) => ({ ...s, entry_step_id: null, provenance: s.provenance as Json })));
    if (error) throw writeError(error, "add steps");
  }
  // Moves into and out of groups first, then first steps, which need their group's steps to be in place.
  const entries = [
    ...plan.insertSteps.filter((s) => s.entry_step_id).map((s) => ({ id: s.id, base: { entry_step_id: null } as Record<string, unknown>, changes: { entry_step_id: s.entry_step_id } as Record<string, unknown> })),
    ...plan.updateSteps.filter((u) => typeof u.changes.entry_step_id === "string").map((u) => ({ id: u.id, base: { entry_step_id: u.base.entry_step_id ?? null }, changes: { entry_step_id: u.changes.entry_step_id } })).map((e) => ({ ...e, base: { entry_step_id: null } })),
  ];
  // Each request is checked on its own when it commits, so the order matters: steps leave their groups first, then kinds and
  // other fields change (a group becoming a task is empty by then; a task becoming a group is one before steps move in), then
  // steps enter groups.
  const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
  const phases: ((u: (typeof plan.updateSteps)[number]) => { base: Record<string, unknown>; changes: Record<string, unknown> } | null)[] = [
    // Every group's first step is cleared before any step moves (whatever order the JSON lists them in), and set again at the
    // end, once the steps are in place: a step can't leave a group that still names it.
    (u) => ("entry_step_id" in u.changes ? { base: pick(u.base, ["entry_step_id"]), changes: { entry_step_id: null } } : null),
    (u) => (u.changes.parent_step_id === null ? { base: pick(u.base, ["parent_step_id"]), changes: { parent_step_id: null } } : null),
    (u) => {
      const changes = Object.fromEntries(Object.entries(u.changes).filter(([k]) => k !== "entry_step_id" && k !== "parent_step_id"));
      return Object.keys(changes).length ? { base: Object.fromEntries(Object.entries(u.base).filter(([k]) => k in changes)), changes } : null;
    },
    (u) => (typeof u.changes.parent_step_id === "string" ? { base: pick(u.base, ["parent_step_id"]), changes: { parent_step_id: u.changes.parent_step_id } } : null),
  ];
  for (const phase of phases) {
    for (const u of plan.updateSteps) {
      const part = phase(u);
      if (!part) continue;
      for (const c of await saveFields(ctx, "steps", revisionId, u.id, part.base, part.changes)) conflicts.push({ table: "steps", id: u.id, ...c });
    }
  }
  for (const e of entries) {
    for (const c of await saveFields(ctx, "steps", revisionId, e.id, e.base, e.changes)) conflicts.push({ table: "steps", id: e.id, ...c });
  }
  if (plan.removeEdges.length) {
    const { error } = await ctx.db.from("edges").delete().eq("revision_id", revisionId).in("id", plan.removeEdges.map((e) => e.id));
    if (error) throw writeError(error, "remove connections");
  }
  for (const u of plan.updateEdges) {
    for (const c of await saveFields(ctx, "edges", revisionId, u.id, u.base, u.changes)) conflicts.push({ table: "edges", id: u.id, ...c });
  }
  if (plan.insertEdges.length) {
    const { error } = await ctx.db.from("edges").insert(plan.insertEdges);
    if (error) throw writeError(error, "connect steps");
  }
  if (plan.removeSteps.length) {
    const { error } = await ctx.db.from("steps").delete().eq("revision_id", revisionId).in("id", plan.removeSteps.map((s) => s.id));
    if (error) throw writeError(error, "remove steps");
  }
  return conflicts;
}

const emptyPlan = () => ({
  insertSteps: [] as StepRow[],
  updateSteps: [] as ImportPlan["updateSteps"],
  removeSteps: [] as StepRow[],
  insertEdges: [] as EdgeRow[],
  updateEdges: [] as EdgeChange[],
  removeEdges: [] as EdgeRow[],
});

function conflictNote(conflicts: EditConflict[]): string {
  if (!conflicts.length) return "";
  return ` ${plural(conflicts.length, "field")} changed by someone else meanwhile ${conflicts.length === 1 ? "was" : "were"} left as they are (${conflicts.map((c) => c.field).join(", ")}).`;
}

/** The draft's checklist rail as data: conflicts first, then assumptions (evidence.ts `checklistItems`). */
function checklist(steps: readonly StepRow[]) {
  return checklistItems(steps).map((i) => ({
    kind: i.kind,
    step: { id: i.stepId, name: i.stepName },
    field: i.column,
    value: i.value,
    reasoning: i.reasoning,
    evidence: i.evidence,
    values: i.values,
  }));
}

const warningsFor = (g: Graph, ids: readonly string[]) => graphWarnings(g).filter((w) => w.step_id === null || ids.includes(w.step_id));

/** A new process with an empty draft revision (processes aren't revisioned, so its row is written directly). */
async function createProcessWithDraft(
  ctx: ToolContext,
  ws: WorkspaceRef,
  input: { name: string; kind: "pipeline" | "servicing"; entity_name: string; description: string | null; source: "mcp" | "import" | "template"; parent_process_id?: string },
  /** For the process library (B12): made with `create_library_process`, so the company map gives it no card of its own (the person places it). */
  { offMap = false }: { offMap?: boolean } = {},
): Promise<{ proc: ProcessWithDraft; draft: Draft }> {
  const existing = await listProcesses(ctx.db, ws.id);
  const clash = existing.find((p) => normalizeName(p.name) === normalizeName(input.name));
  if (clash) {
    throw new ToolError("name_taken", `'${ws.name}' already has a process called '${clash.name}'; pass it as import_process's target to change it`, [
      { id: clash.id, name: clash.name },
    ]);
  }
  const columns = "id, workspace_id, name, kind, entity_name, description, live_revision_id, draft_revision_id, parent_process_id";
  let made: { data: unknown; error: { code?: string; message: string } | null };
  if (offMap && !input.parent_process_id) {
    const { data: reply, error: rpcError } = await ctx.db.rpc("create_library_process", {
      p_workspace: ws.id,
      p_name: input.name,
      p_kind: input.kind,
      p_entity_name: input.entity_name,
      p_description: input.description ?? undefined,
      p_source: input.source,
    });
    if (rpcError) throw writeError(rpcError, "create processes");
    const r = reply as { status: string; process_id?: string };
    if (r.status === "name_taken") throw new ToolError("name_taken", `'${ws.name}' already has a process called '${input.name}'`);
    if (r.status !== "created" || !r.process_id) throw new ToolError("forbidden", `Couldn't create '${input.name}' in '${ws.name}' (${r.status}).`);
    made = await ctx.db.from("processes").select(columns).eq("id", r.process_id).single();
  } else {
    made = await ctx.db
      .from("processes")
      .insert({
        workspace_id: ws.id,
        name: input.name,
        kind: input.kind,
        entity_name: input.entity_name,
        description: input.description,
        source: input.source,
        ...(input.parent_process_id ? { parent_process_id: input.parent_process_id } : {}),
      })
      .select(columns)
      .single();
  }
  const { data, error } = made;
  if (error) throw writeError(error, "create processes");
  const proc = data as unknown as ProcessWithDraft;
  const draft = await openDraft(ctx, proc);
  return { proc: { ...proc, draft_revision_id: draft.revision_id }, draft };
}

function templateSummary(t: ProcessTemplate) {
  return {
    id: t.id,
    name: t.name,
    industry: t.industry,
    kind: t.kind,
    entity_name: t.entity_name,
    description: t.description,
    steps: t.steps.map((s) => ({ name: s.name, kind: s.kind ?? "task" })),
  };
}

/** Reasoning given at the top of process_json, moved onto its steps. */
function withTopLevelReasoning<T extends { id?: string; name: string; assumptions?: { field: (typeof EVIDENCE_COLUMNS)[number]; reasoning: string }[] }>(steps: T[], top: ProcessJson["assumptions"]): T[] {
  if (!top?.length) return steps;
  return steps.map((s) => {
    const extra = top.filter((a) => normalizeName(a.step) === normalizeName(s.name) || a.step === s.id);
    if (!extra.length) return s;
    const mine = s.assumptions ?? [];
    return { ...s, assumptions: [...mine, ...extra.filter((a) => !mine.some((m) => m.field === a.field)).map((a) => ({ field: a.field, reasoning: a.reasoning }))] };
  });
}

// ---------------------------------------------------------------------------
// import_process
// ---------------------------------------------------------------------------

type DraftBundle = Graph & { roles: readonly Named[]; people: readonly Named[]; retired?: StepRow[] };

/** What import_process returns for one process: the draft it wrote and what to check, with the child processes written beside it. */
export interface ImportOutcome {
  workspace: { id: string; name: string };
  process: { id: string; name: string };
  draft: { revision_id: string; number: number; opened_now: boolean };
  created: boolean;
  matched: ImportPlan["matched"];
  diff: ReturnType<typeof revisionDiff>;
  not_overwritten: ImportPlan["kept"];
  conflicts: ImportPlan["conflicts"];
  edit_conflicts: EditConflict[];
  checklist: ReturnType<typeof checklist>;
  warnings: string[];
  /** The child processes of its sub-process steps that this call created or wrote into. */
  children: (ImportOutcome & { step: string })[];
  /** A /2 upload: what was written beside the process (sources, pending suggestions and proposals, first principles). */
  bundle?: ImportBundleResult;
  text: string;
}

interface PreparedImport {
  /**
   * Create the process and its draft, or open the existing draft (as a child of `parent`). For a new process at the top of
   * an import (`parent` null) this writes the whole import, children included, in one database transaction
   * (`import_new_process`): it is all there afterwards or none of it is. Anything else writes only the process and draft.
   */
  ensure(parent: ProcessWithDraft | null): Promise<{ proc: ProcessWithDraft; draft: Draft }>;
  /** A new process's part of the one-transaction write, and those of the new processes inside it. */
  collect(parentId: string | null, nodes: ImportNode[], adopts: { id: string; parent_id: string }[]): void;
  /** Take what the one-transaction write returned (the draft of each new process). */
  settle(parentId: string | null, results: ReadonlyMap<string, { revision_id: string; number: number }>): void;
  /** Write the steps and edges, then the child processes'. */
  write(): Promise<ImportOutcome>;
}

/** A new process as `import_new_process` takes it: its row, and the steps and edges of its first draft. */
interface ImportNode {
  id: string;
  parent_id: string | null;
  name: string;
  kind: "pipeline" | "servicing";
  entity_name: string;
  description: string | null;
  steps: unknown[];
  edges: unknown[];
}

interface ImportScope {
  ctx: ToolContext;
  ws: WorkspaceRef;
  assumptions: string[];
  /** Names of the processes this call will create, to refuse two with the same name. */
  reserved: Set<string>;
  /** Every process of the workspace, as read once. */
  processes: ProcessWithDraft[];
  /** The step holding each child process in this call, so no process is held twice. */
  claimed: Map<string, string>;
  stamp: Stamp;
  /** A /2 upload's sources, rows and ids, written in the same transaction as the process (issue #167). */
  bundle?: ImportBundle;
  /** What `import_process_bundle` returned (the counts it wrote), for the top-level process. */
  bundleResult?: ImportBundleResult;
}

/**
 * What a `transpera-process/2` upload carries beyond the process itself (issue #167). Everything is written by one call to
 * `import_process_bundle`, so it is all there afterwards or none of it is. Ids are chosen by the caller so rows that point at
 * each other (a step's evidence cites a source, a proposal links to the new process) can be built before anything is written.
 */
export interface ImportBundle {
  /** The new process's id. */
  processId: string;
  /** The file name or link, shown in the review queue as "Upload (name)". */
  importSource: string;
  /** Sources to add. Each `id` is a placeholder the evidence cites; the database replaces it with the id it makes. Each is linked to the process. */
  sources: { id: string; kind: string; title: string; speakers: string[]; recorded_at: string | null; body: string | null }[];
  /** The rest of the extras, as `import_process_bundle` takes them: `first_principles` (its columns), `suggestions`, `proposals`. */
  extras: { first_principles?: Json; suggestions?: Json; proposals?: Json };
}

/** What `import_process_bundle` wrote beyond the process. */
export interface ImportBundleResult {
  sources: number;
  suggestions: number;
  proposals: number;
  first_principles: boolean;
}

/**
 * Check a whole import before writing any of it (a failed call creates no
 * process, opens no draft and moves no child), then return what writes it.
 * `json` is process_json or a sub-process step's `process`; steps held in
 * groups are unfolded (flattenNesting), and the processes held by sub-process
 * steps are prepared the same way, to any depth.
 */
async function prepareImport(
  scope: ImportScope,
  json: ProcessJson,
  opts: { target?: ProcessWithDraft; create?: { id: string; name: string; kind: "pipeline" | "servicing"; entity_name: string; source: "import" }; ancestors: string[] },
): Promise<PreparedImport> {
  const { ctx, ws, assumptions, stamp } = scope;
  const { steps: flat, holders } = flattenNesting(json.steps);
  const target = opts.target ?? null;

  // The child process each sub-process step holds: one it already holds, an existing process to adopt, or a new one.
  const current = target?.draft_revision_id ?? target?.live_revision_id;
  const currentBundle = current ? await loadProcessBundle(ctx.db, ws, target!, current) : null;
  const heldNow = (stepName: string, id?: string) => {
    const row = currentBundle?.steps.find((r) => (id !== undefined && r.id === id) || normalizeName(r.name) === normalizeName(stepName));
    return row?.child_process_id ?? null;
  };
  const processById = new Map(scope.processes.map((pr) => [pr.id, pr]));
  const self = target?.id ?? null;
  interface Held {
    step: string;
    /** The process it holds now, or will once created or adopted. */
    id: string;
    /** Set when an existing process is adopted as the step's child. */
    adopt?: ProcessWithDraft;
    /** The steps to write into it (an existing child or a new one). */
    inline?: { json: ProcessJson; existing: ProcessWithDraft | null; prepared: PreparedImport };
  }
  const held: Held[] = [];
  const holderNames = new Set((holders as Holder<ProcessJson>[]).map((h) => normalizeName(h.step)));
  /** A child process sits in one step: refuse a second holder, in this call or already in the draft. */
  const claim = (childId: string, childName: string, step: string) => {
    const first = scope.claimed.get(childId);
    if (first !== undefined) {
      throw new ToolError("invalid_input", `'${childName}' can't sit in both '${first}' and '${step}': a process is held by one step.`);
    }
    const other = currentBundle?.steps.find((r) => r.child_process_id === childId && normalizeName(r.name) !== normalizeName(step) && !holderNames.has(normalizeName(r.name)));
    if (other) throw new ToolError("invalid_input", `'${childName}' is already held by the step '${other.name}'; remove that step first, or give the child to just one.`);
    scope.claimed.set(childId, step);
  };
  for (const h of holders as Holder<ProcessJson>[]) {
    const idGiven = flat.find((st) => normalizeName(st.name) === normalizeName(h.step))?.id;
    const now = heldNow(h.step, idGiven);
    if (h.child_process !== undefined) {
      const child = resolveProcessRef(scope.processes, h.child_process, `for step '${h.step}'`);
      if (child.id === self || opts.ancestors.includes(child.id)) throw new ToolError("invalid_input", `Step '${h.step}': a process can't sit inside itself; '${child.name}' is this process or one that holds it.`);
      if (child.parent_process_id && child.parent_process_id !== self) {
        throw new ToolError("invalid_input", `Step '${h.step}': '${child.name}' already sits inside '${processById.get(child.parent_process_id)?.name ?? "another process"}'; a process has one parent.`);
      }
      if (now && now !== child.id) throw new ToolError("invalid_input", `Step '${h.step}' already holds '${processById.get(now)?.name ?? "another process"}'; remove that first.`);
      claim(child.id, child.name, h.step);
      held.push({ step: h.step, id: child.id, ...(child.parent_process_id === self ? {} : { adopt: child }) });
      continue;
    }
    const inlineJson = h.process!;
    const existing = now ? (processById.get(now) ?? null) : null;
    const childId = existing?.id ?? newId();
    if (existing) claim(existing.id, existing.name, h.step);
    const name = inlineJson.name ?? h.step;
    const childOpts = existing
      ? { target: existing, ancestors: [...opts.ancestors, ...(self ? [self] : [])] }
      : { create: { id: childId, name, kind: inlineJson.kind ?? json.kind ?? target?.kind ?? opts.create?.kind ?? "pipeline", entity_name: inlineJson.entity_name ?? target?.entity_name ?? opts.create?.entity_name ?? "item", source: "import" as const }, ancestors: [...opts.ancestors, ...(self ? [self] : [])] };
    const prepared = await prepareImport(scope, { ...inlineJson, ...(existing ? {} : { name }) }, childOpts);
    held.push({ step: h.step, id: childId, inline: { json: inlineJson, existing, prepared } });
  }
  const childIds = new Map(held.map((x) => [normalizeName(x.step), x.id]));

  let create: Parameters<typeof createProcessWithDraft>[2] | null = null;
  let createId = "";
  if (!target) {
    const c = opts.create;
    if (!c) throw new ToolError("invalid_input", "process_json needs a name for a new process (or pass `target` to write into an existing one).");
    const clash = scope.processes.find((pr) => normalizeName(pr.name) === normalizeName(c.name));
    if (clash || scope.reserved.has(normalizeName(c.name))) {
      throw new ToolError("name_taken", `'${ws.name}' already has a process called '${clash?.name ?? c.name}'; pass it as import_process's target to change it`, clash ? [{ id: clash.id, name: clash.name }] : undefined);
    }
    scope.reserved.add(normalizeName(c.name));
    create = { name: c.name, kind: c.kind, entity_name: c.entity_name, description: json.description?.trim() || null, source: c.source };
    createId = c.id;
  }

  const planFor = async (from: DraftBundle, owner: StepOwner, ids: ReadonlyMap<string, string>) => {
    const l = await lookupsFor(
      ctx,
      ws,
      from as Graph & { roles: readonly Named[]; people: readonly Named[]; steps: StepRow[] },
      hasCitations(flat),
      (scope.bundle?.sources ?? []).map((s) => ({ id: s.id, workspace_id: ws.id, kind: s.kind, title: s.title, speakers: s.speakers, recorded_at: s.recorded_at, body: s.body, file_url: null, name: s.title }) as unknown as Lookups["sources"][number]),
    );
    const steps: ImportStep[] = withTopLevelReasoning(flat, json.assumptions).map((st) => {
      const { id, name, rework_to, ...rest } = st;
      const child = ids.get(normalizeName(name));
      return {
        ...toFields({ name, ...rest } as StepArgs, l, ` (step '${name}')`),
        ...(child ? { child_process_id: child } : {}),
        ...(rest.parent !== undefined ? { parent: rest.parent } : {}),
        ...(rest.entry !== undefined ? { entry: rest.entry } : {}),
        ...(id !== undefined ? { id } : {}),
        name,
        ...(rework_to !== undefined ? { rework_to } : {}),
      };
    });
    const plan = planImport({ steps, edges: (json.edges ?? []) as ImportEdge[], remove_missing: json.remove_missing }, { ...from, retired: from.retired ?? [] }, owner, stamp, { newId });
    return { l, plan };
  };

  // Plan against what the draft will be (the open draft, else a copy of live, else empty). A new process's draft starts empty,
  // so this plan is the one that gets written (in one transaction, see `ensure`); for an existing process it is a check.
  const dry = await planFor(
    currentBundle ??
      ({
        steps: [],
        edges: [],
        roles: check(await ctx.db.from("roles").select("id, name").eq("workspace_id", ws.id)),
        people: check(await ctx.db.from("people").select("id, name").eq("workspace_id", ws.id)),
      } as DraftBundle),
    { revision_id: current ?? newId(), workspace_id: ws.id, process_id: target?.id ?? (createId || newId()) },
    childIds,
  );

  let ensured: { proc: ProcessWithDraft; draft: Draft } | null = null;
  // Set when the whole import has been written by `import_new_process`: steps, edges and moves are already in.
  let writtenAtOnce = false;
  const prepared: PreparedImport = {
    collect(parentId, nodes, adopts) {
      const { plan } = dry;
      if (!create || plan.updateSteps.length || plan.removeSteps.length || plan.updateEdges.length || plan.removeEdges.length) {
        throw new Error("a new process's import plan only adds steps and connections");
      }
      nodes.push({
        id: createId,
        parent_id: parentId,
        name: create.name,
        kind: create.kind,
        entity_name: create.entity_name,
        description: create.description,
        steps: plan.insertSteps,
        edges: plan.insertEdges,
      });
      for (const h of held) if (h.adopt) adopts.push({ id: h.adopt.id, parent_id: createId });
      for (const h of held) h.inline?.prepared.collect(createId, nodes, adopts);
    },
    settle(parentId, results) {
      const r = results.get(createId);
      if (!create || !r) throw new Error("import_new_process returned no draft for a new process");
      const draft: Draft = { revision_id: r.revision_id, number: r.number, created: true };
      ensured = {
        proc: { id: createId, workspace_id: ws.id, name: create.name, kind: create.kind, entity_name: create.entity_name, description: create.description, live_revision_id: null, draft_revision_id: r.revision_id, parent_process_id: parentId } as ProcessWithDraft,
        draft,
      };
      writtenAtOnce = true;
      for (const h of held) h.inline?.prepared.settle(createId, results);
    },
    async ensure(parent) {
      if (ensured) return ensured;
      if (target) {
        const draft = await openDraft(ctx, target);
        ensured = { proc: { ...target, draft_revision_id: draft.revision_id }, draft };
      } else if (!parent) {
        const nodes: ImportNode[] = [];
        const adopts: { id: string; parent_id: string }[] = [];
        prepared.collect(null, nodes, adopts);
        // One transaction has to finish inside the database's statement timeout, so an import has a size limit (checked again there).
        const stepCount = nodes.reduce((n, x) => n + x.steps.length, 0);
        if (nodes.length > MAX_IMPORT_PROCESSES) throw new ToolError("invalid_input", `An import can create at most ${MAX_IMPORT_PROCESSES} processes (this one has ${nodes.length}). Split it into smaller imports.`);
        if (stepCount > MAX_IMPORT_TOTAL_STEPS) throw new ToolError("invalid_input", `An import can have at most ${MAX_IMPORT_TOTAL_STEPS} steps in all, child processes included (this one has ${stepCount}). Split it into smaller imports.`);
        const bundle = scope.bundle;
        const { data, error } = bundle
          ? await ctx.db.rpc("import_process_bundle", {
              p_workspace: ws.id,
              p_nodes: nodes as unknown as Json,
              p_adopt: adopts as unknown as Json,
              p_extras: { sources: bundle.sources.map(({ id, ...rest }) => ({ ref: id, ...rest })), import_source: bundle.importSource, ...bundle.extras } as unknown as Json,
            })
          : await ctx.db.rpc("import_new_process", { p_workspace: ws.id, p_nodes: nodes as unknown as Json, p_adopt: adopts as unknown as Json });
        if (error) {
          if (error.code === "23505" && error.hint === "name_taken") throw new ToolError("name_taken", error.message);
          throw writeError(error, "create processes");
        }
        let made = data as unknown as { process_id: string; revision_id: string; number: number }[];
        if (bundle) {
          const out = data as unknown as { processes: typeof made } & ImportBundleResult;
          made = out.processes;
          scope.bundleResult = { sources: out.sources, suggestions: out.suggestions, proposals: out.proposals, first_principles: out.first_principles };
        }
        const results = new Map(made.map((r) => [r.process_id, r]));
        prepared.settle(null, results);
      } else {
        const made = await createProcessWithDraft(ctx, ws, { ...create!, ...(parent ? { parent_process_id: parent.id } : {}) });
        ensured = { proc: made.proc, draft: made.draft };
      }
      return ensured!;
    },
    async write() {
      const { proc, draft } = await prepared.ensure(null);
      // Every child exists, and belongs to this process, before the step that holds it is written.
      for (const h of held) {
        if (h.adopt && !writtenAtOnce) {
          const { error } = await ctx.db.from("processes").update({ parent_process_id: proc.id }).eq("id", h.adopt.id);
          if (error) throw writeError(error, "move a process inside another");
        }
        if (h.inline) h.id = (await h.inline.prepared.ensure(proc)).proc.id;
      }
      const ids = new Map(held.map((x) => [normalizeName(x.step), x.id]));
      const bundle = await loadDraft(ctx, ws, proc, draft);
      const e: Editing = { ws, proc, draft, bundle, owner: { revision_id: draft.revision_id, workspace_id: ws.id, process_id: proc.id }, stamp };
      const { l, plan } = writtenAtOnce ? dry : await planFor(bundle, e.owner, ids);
      assumptions.push(...plan.assumptions);
      const editConflicts = writtenAtOnce ? [] : await applyPlan(ctx, draft.revision_id, plan);

      const after = await loadDraft(ctx, ws, proc, draft);
      const live = proc.live_revision_id ? await loadProcessBundle(ctx.db, ws, proc, proc.live_revision_id) : null;
      const diff = revisionDiff(live && { steps: [...live.steps, ...(live.retired ?? [])], edges: live.edges }, { steps: [...after.steps, ...(after.retired ?? [])], edges: after.edges });
      const items = checklist(after.steps);
      const nConflicts = items.filter((i) => i.kind === "conflict").length;
      const warnings = [...graphWarnings(after).map((w) => (w.step ? `${w.step}: ${w.warning}` : w.warning)), ...l.warnings];

      const children: ImportOutcome["children"] = [];
      for (const h of held) if (h.inline) children.push({ step: h.step, ...(await h.inline.prepared.write()) });

      const created = !target;
      return {
        ...header(e),
        created,
        matched: plan.matched,
        diff,
        not_overwritten: plan.kept,
        conflicts: plan.conflicts,
        edit_conflicts: editConflicts,
        checklist: items,
        warnings,
        children,
        ...(scope.bundleResult && !opts.ancestors.length && !target ? { bundle: scope.bundleResult } : {}),
        text:
          `${!created ? `Wrote into the draft of '${proc.name}'` : `Created '${proc.name}' as a draft`}: ${diff.text}` +
          (!created ? ` Matched ${plan.matched.filter((m) => m.by === "id").length} by id and ${plan.matched.filter((m) => m.by === "name").length} by name.` : "") +
          (plan.kept.length ? ` ${plural(plan.kept.length, "entered value")} kept and flagged as ${plan.kept.length === 1 ? "a conflict" : "conflicts"}.` : "") +
          ` To confirm before publishing: ${plural(nConflicts, "conflict")}, ${plural(items.length - nConflicts, "assumption")}.` +
          (held.length
            ? ` Child processes: ${held.map((x) => `'${x.step}' holds '${(children.find((c) => c.step === x.step)?.process.name ?? x.adopt?.name ?? processById.get(x.id)?.name) ?? x.step}'${x.adopt ? " (moved inside it)" : ""}`).join("; ")}.`
            : "") +
          conflictNote(editConflicts),
      };
    },
  };
  return prepared;
}

/** Refuse unless the caller can edit the workspace's processes (editors and owners). */
async function requireCanEdit(ctx: ToolContext, ws: WorkspaceRef): Promise<void> {
  const { data: canEdit, error: accessError } = await ctx.db.rpc("can_edit_workspace", { ws: ws.id });
  if (accessError) throw writeError(accessError, "edit processes");
  if (canEdit !== true) throw new ToolError("forbidden", `You don't have permission to edit processes in '${ws.name}' (editors and owners can).`);
}

/** Prepare a new process (kind and entity defaulted as the tool says) from process_json. */
function prepareNewProcess(scope: ImportScope, json: ProcessJson): Promise<PreparedImport> {
  if (!json.name) throw new ToolError("invalid_input", "process_json needs a name for a new process (or pass `target` to write into an existing one).");
  const kind = json.kind ?? "pipeline";
  if (!json.kind) scope.assumptions.push("kind defaulted to pipeline.");
  const entity = json.entity_name ?? (kind === "pipeline" ? "lead" : "item");
  if (!json.entity_name) scope.assumptions.push(`entity_name defaulted to '${entity}'.`);
  return prepareImport(scope, json, { create: { id: scope.bundle?.processId ?? newId(), name: json.name, kind, entity_name: entity, source: "import" }, ancestors: [] });
}

/**
 * Create a new process, as a draft, from process_json: what `import_process` does without a `target`, for callers that
 * aren't an MCP session (the web app's upload, issue #166). Acts as `ctx.db`'s user through RLS, so it needs an editor;
 * checks the whole import before writing any of it; never publishes.
 */
export async function importNewProcess(ctx: ToolContext, workspaceId: string, json: ProcessJson, assumptions: string[] = [], bundle?: ImportBundle): Promise<ImportOutcome> {
  const ws = await resolveWorkspace(ctx, workspaceId, assumptions);
  await requireCanEdit(ctx, ws);
  const processes = await importProcesses(ctx, ws.id);
  const scope: ImportScope = { ctx, ws, assumptions, reserved: new Set(), processes, claimed: new Map(), stamp: await stampOf(ctx), ...(bundle ? { bundle } : {}) };
  const prepared = await prepareNewProcess(scope, json);
  await prepared.ensure(null);
  return prepared.write();
}

/** create_from_template's work: a new process with the template's steps in its draft (`offMap`: see createProcessWithDraft). */
async function fromTemplate(ctx: ToolContext, ws: WorkspaceRef, template: string, name: string | undefined, assumptions: string[], opts: { offMap?: boolean } = {}) {
  const t = resolveName(PROCESS_TEMPLATES, template, "template");
  const finalName = name ?? t.name;
  if (!name) assumptions.push(`name defaulted to '${t.name}'.`);
  const { proc, draft } = await createProcessWithDraft(ctx, ws, { name: finalName, kind: t.kind, entity_name: t.entity_name, description: t.description, source: "template" }, opts);
  const owner = { revision_id: draft.revision_id, workspace_id: ws.id, process_id: proc.id };
  const plan = planImport({ steps: t.steps, edges: t.edges }, { steps: [], edges: [], retired: [] }, owner, await stampOf(ctx), { newId, origin: `template '${t.name}'` });
  assumptions.push(...plan.assumptions);
  await applyPlan(ctx, draft.revision_id, plan);
  const bundle = await loadDraft(ctx, ws, proc, draft);
  return { t, proc, draft, bundle };
}

/**
 * A new process from a template, for the process library in the web app's editors (B12, #164): what `create_from_template`
 * does, as the signed-in user through RLS, except that the company map gives the new process no card of its own: the person
 * places it, by a link, in the draft they are editing. Never publishes. Returns the new process's id, name and kind.
 */
export async function createProcessFromTemplate(
  ctx: ToolContext,
  workspaceId: string,
  template: string,
  name?: string,
): Promise<{ id: string; name: string; kind: "pipeline" | "servicing" }> {
  const assumptions: string[] = [];
  const ws = await resolveWorkspace(ctx, workspaceId, assumptions);
  await requireCanEdit(ctx, ws);
  const { proc } = await fromTemplate(ctx, ws, template, name, assumptions, { offMap: true });
  return { id: proc.id, name: proc.name, kind: proc.kind as "pipeline" | "servicing" };
}

/**
 * The workspace's processes as an import sees them. Where a process sits is its live holder (`listProcesses` derives
 * `parent_process_id` from the live links, B12, ADR 0014); an import also writes the stored column when it creates a process
 * inside another or moves one inside (which the database still checks, and which keeps it off the company map), and that holds
 * before the holder is published. So a process sits where its live holder is, or else where the stored column says.
 */
async function importProcesses(ctx: ToolContext, workspaceId: string): Promise<ProcessWithDraft[]> {
  const [processes, stored] = await Promise.all([
    listProcesses(ctx.db, workspaceId),
    ctx.db.from("processes").select("id, parent_process_id").eq("workspace_id", workspaceId).not("parent_process_id", "is", null),
  ]);
  if (stored.error) throw writeError(stored.error, "read processes");
  const column = new Map((stored.data ?? []).map((r) => [r.id, r.parent_process_id as string]));
  return processes.map((p) => ({ ...p, parent_process_id: p.parent_process_id ?? column.get(p.id) ?? null }));
}

/** The ids of the processes that hold `proc`, nearest first. */
function ancestorsOf(processes: readonly ProcessWithDraft[], proc: ProcessWithDraft): string[] {
  const out: string[] = [];
  for (let at: ProcessWithDraft | undefined = proc; at?.parent_process_id && !out.includes(at.parent_process_id); at = processes.find((p) => p.id === at!.parent_process_id)) {
    out.push(at.parent_process_id);
  }
  return out;
}

/** An existing process by id or name (exactly, ignoring case and punctuation), for a sub-process step's `child_process`. */
function resolveProcessRef(processes: readonly ProcessWithDraft[], ref: string, where: string): ProcessWithDraft {
  return resolveName(processes, ref, "process", ` ${where}`, { strict: true });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerBuildingTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "add_source",
    {
      title: "Add source",
      description:
        "Store a transcript, notes, a data export or a screenshot link from the audit as a source of the workspace, with its speakers and date, and " +
        "link it to what it is evidence for: `links` is required (a process, step, insight, issue or solution; each by id or name). A source linked to " +
        "nothing doesn't count as evidence. Returns the source id that step tools cite in `evidence` (with speaker, verbatim quote, timestamp and the value stated). " +
        "Only when you are adding a source to cite in import_process, add_step or update_step evidence, and the process it describes does not exist yet, pass `link_later: true` instead of `links`: " +
        "citing it links it to those steps, and you then call link_source for the process.",
      inputSchema: {
        title: z.string().trim().min(1).max(200),
        kind: z.enum(["transcript", "notes", "data", "screenshot"]).optional().describe("Default transcript."),
        speakers: z.union([z.array(z.string().trim().min(1).max(200)).max(50), z.string().max(10_000)]).optional().describe("Names, as a list or 'a, b'."),
        recorded_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date the conversation or notes are from."),
        body: z.string().max(500_000).optional().describe("The transcript or notes text."),
        file_url: z.string().regex(/^https?:\/\/\S+$/).max(2000).optional().describe("Link to the recording or screenshot."),
        links: linksArg.optional().describe("What the source is evidence for: at least one of { process }, { step } (with `process` if the name is not unique), { insight } (a detection key), { issue } (number, id or title), { solution }."),
        link_later: z.boolean().optional().describe("import_process / add_step / update_step only, when `links` is left out: citing the source in their evidence links it to those steps, and you then call link_source for the process. Until then it shows as 'Not linked to anything yet'."),
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        // Fail before anything is written: a source with nothing to say what it is evidence for is not added silently.
        if (!args.links?.length && !args.link_later) throw new ToolError("links_required", NEEDS_LINKS);
        if (args.links?.length && args.link_later) throw new ToolError("invalid_input", "Pass `links` or `link_later: true`, not both.");
        const resolved = args.links?.length ? await resolveLinks(ctx, ws, args.links) : null;
        const raw = typeof args.speakers === "string" ? args.speakers.split(/[,;\n]/) : (args.speakers ?? []);
        const speakers = [...new Set(raw.map((s) => s.trim().slice(0, 200)).filter(Boolean))];
        if (speakers.length > 50) throw new ToolError("invalid_input", "List up to 50 speakers.");
        if (!args.kind) assumptions.push("kind defaulted to transcript.");
        const fields = {
          kind: args.kind ?? "transcript",
          title: args.title.trim(),
          speakers,
          recorded_at: args.recorded_at ?? null,
          body: args.body?.trim() ? args.body : null,
          file_url: args.file_url?.trim() || null,
        };
        // With links, the source and its links are saved together by the database function, so there is never a half-added source.
        let sourceId: string;
        if (resolved) {
          const { data: id, error } = await ctx.db.rpc("add_source", { p_workspace: ws.id, p_source: fields, p_links: resolved.targets.map(linkJson) });
          if (error || !id) throw writeError(error ?? {}, "add sources");
          sourceId = id;
          await recordIssueSources(ctx, ws.id, id, resolved.targets);
        } else {
          const { data, error } = await ctx.db.from("sources").insert({ workspace_id: ws.id, ...fields }).select("id").single();
          if (error) throw writeError(error, "add sources");
          sourceId = data.id;
          assumptions.push("link_later: the source is not linked to anything yet; citing it in a step's evidence links it to that step.");
        }
        const { data, error } = await ctx.db.from("sources").select(SOURCE_COLUMNS).eq("id", sourceId).single();
        if (error) throw writeError(error, "add sources");
        const source = data as unknown as SourceRow;
        return {
          workspace: { id: ws.id, name: ws.name },
          source: { id: source.id, kind: source.kind, title: source.title, speakers: source.speakers, recorded_at: source.recorded_at, file_url: source.file_url, body_length: source.body?.length ?? 0 },
          links: resolved?.text ?? [],
          text: `Added ${source.kind} '${source.title}'${speakers.length ? ` (${speakers.join(", ")})` : ""}${resolved ? `, linked to ${resolved.text.join("; ")}` : ", not linked to anything yet"}. Cite it in a step's evidence as source ${source.id}.`,
        };
      }),
  );

  server.registerTool(
    "link_source",
    {
      title: "Link source",
      description:
        "Link an existing source to more things it is evidence for: a process, step, insight, issue or solution (each by id or name). A source " +
        "can have several links; one that is already linked to a thing is left as it is. Use it for a source added with link_later, or " +
        "when a source turns out to support something else.",
      inputSchema: {
        source: z.string().min(1).describe("Source id or title."),
        links: linksArg.min(1).describe("At least one of { process }, { step } (with `process` if the name is not unique), { insight }, { issue }, { solution }."),
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const sources = await loadSources(ctx, ws);
        const source = resolveName(sources, args.source, "source", ` in '${ws.name}'`);
        const resolved = await resolveLinks(ctx, ws, args.links);
        const added: string[] = [];
        const already: string[] = [];
        for (const [i, t] of resolved.targets.entries()) {
          const { error } = await ctx.db.from("source_links").insert({ workspace_id: ws.id, source_id: source.id, ...linkColumns(t) });
          if (!error) {
            added.push(resolved.text[i]!);
            await recordIssueSources(ctx, ws.id, source.id, [t]);
          }
          else if (error.code === "23505") already.push(resolved.text[i]!);
          else throw writeError(error, "link sources");
        }
        return {
          workspace: { id: ws.id, name: ws.name },
          source: { id: source.id, title: source.name },
          added,
          already_linked: already,
          text: `${added.length ? `Linked '${source.name}' to ${added.join("; ")}.` : `'${source.name}' was already linked to all of those.`}${already.length && added.length ? ` Already linked: ${already.join("; ")}.` : ""}`,
        };
      }),
  );

  server.registerTool(
    "create_process",
    {
      title: "Create process",
      description:
        "Create a new process as a draft (nothing is live until publish_process). It starts with a start step and end steps (Won and Lost for a " +
        "pipeline, Done for servicing); add steps between them with add_step, or build the whole graph at once with import_process.",
      inputSchema: {
        name: z.string().trim().min(1).max(200),
        kind: z.enum(["pipeline", "servicing"]).optional().describe("pipeline (default): leads to won or lost; servicing: recurring work for clients."),
        entity_name: z.string().trim().min(1).max(100).optional().describe("What flows through it: 'lead', 'report' (default: lead or item)."),
        description: z.string().max(4000).optional(),
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const kind = args.kind ?? "pipeline";
        if (!args.kind) assumptions.push("kind defaulted to pipeline.");
        const entity = args.entity_name ?? (kind === "pipeline" ? "lead" : "item");
        if (!args.entity_name) assumptions.push(`entity_name defaulted to '${entity}'.`);
        const { proc, draft } = await createProcessWithDraft(ctx, ws, { name: args.name, kind, entity_name: entity, description: args.description?.trim() || null, source: "mcp" });
        const owner = { revision_id: draft.revision_id, workspace_id: ws.id, process_id: proc.id };
        const stamp = await stampOf(ctx);
        const specs: ImportStep[] =
          kind === "pipeline"
            ? [{ name: "Start", kind: "start" }, { name: "Won", kind: "end", outcome: "won" }, { name: "Lost", kind: "end", outcome: "lost" }]
            : [{ name: "Start", kind: "start" }, { name: "Done", kind: "end", outcome: "done" }];
        const plan = planImport({ steps: specs, edges: [{ from: "Start", to: specs[1]!.name }] }, { steps: [], edges: [], retired: [] }, owner, stamp, { newId });
        await applyPlan(ctx, draft.revision_id, plan);
        const bundle = await loadDraft(ctx, ws, proc, draft);
        return {
          ...header({ ws, proc, draft }),
          process: { id: proc.id, name: proc.name, kind, entity_name: entity, description: proc.description },
          steps: bundle.steps.map((s) => stepOut(s, bundle)),
          edges: bundle.edges.map((e) => edgeOut(e, bundle.steps)),
          text: `Created ${kind} process '${proc.name}' as a draft with ${specs.map((s) => s.name).join(", ")}. Add steps with add_step (after 'Start', before '${specs[1]!.name}') or import_process with target '${proc.name}'.`,
        };
      }),
  );

  server.registerTool(
    "add_step",
    {
      title: "Add step",
      description:
        "Add a step to the process's draft. `after` inserts it after a step (taking over that step's one outgoing connection); `before` inserts " +
        "it before a step (taking over the connections into it); both put it between them. Numbers you leave out get the editor's defaults, " +
        "marked as assumptions (listed in `assumptions` and badged on the canvas); numbers from a source should cite it in `evidence`.",
      inputSchema: {
        name: z.string().trim().min(1).max(200),
        after: z.string().optional().describe("Step (id or name) this one comes after."),
        before: z.string().optional().describe("Step (id or name) this one comes before."),
        ...stepFieldsShape,
        process: processArg,
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const e = await beginEdit(ctx, args, assumptions);
        const { bundle } = e;
        const where = ` in '${e.proc.name}'`;
        const clash = bundle.steps.find((s) => normalizeName(s.name) === normalizeName(args.name));
        if (clash) throw new ToolError("name_taken", `'${e.proc.name}' already has a step called '${clash.name}'; use update_step to change it`, [{ id: clash.id, name: clash.name }]);
        const after = args.after ? resolveName(bundle.steps, args.after, "step", where) : null;
        const before = args.before ? resolveName(bundle.steps, args.before, "step", where) : null;
        const l = await lookupsFor(ctx, e.ws, e.bundle, !!args.evidence?.length);
        const fields = toFields(args, l, where);
        const id = newId();
        if (args.rework_to !== undefined) fields.rework_to_step_id = args.rework_to === null ? null : resolveName(bundle.steps, args.rework_to, "step", where).id;
        if (fields.x === undefined || fields.y === undefined) Object.assign(fields, { ...placeStep(bundle, after, before), ...(fields.x !== undefined ? { x: fields.x } : {}), ...(fields.y !== undefined ? { y: fields.y } : {}) });
        const built = buildNewStep(id, fields, e.owner, e.stamp, { outcome: nextOutcome(bundle.steps) });
        assumptions.push(...built.assumptions);
        const row = built.row;

        const plan = { ...emptyPlan(), insertSteps: [row] };
        let graph: Graph = { steps: [...bundle.steps, row], edges: [...bundle.edges] };
        const start = startProblem(graph);
        if (start) throw new ToolError("invalid_input", start);
        const rework = reworkProblem(graph, id, row.rework_to_step_id);
        if (rework) throw new ToolError("invalid_input", rework);
        const reroute = (edge: EdgeRow, change: Partial<EdgeRow>) => {
          plan.updateEdges.push({ id: edge.id, base: Object.fromEntries(Object.keys(change).map((k) => [k, edge[k as keyof EdgeRow]])), changes: change });
          graph = { ...graph, edges: graph.edges.map((x) => (x.id === edge.id ? { ...x, ...change } : x)) };
        };
        const connect = (from: string, to: string, probability: number) => {
          const problem = connectionProblem(graph, from, to);
          if (problem) throw new ToolError("invalid_input", problem);
          const edge: EdgeRow = { id: newId(), ...e.owner, from_step_id: from, to_step_id: to, probability, condition_tag: null, label: null };
          plan.insertEdges.push(edge);
          graph = { ...graph, edges: [...graph.edges, edge] };
        };
        if (after && after.kind === "end") throw new ToolError("invalid_input", `End steps can't lead anywhere ('${after.name}' is an end step).`);
        if (before && before.kind === "start") throw new ToolError("invalid_input", "Nothing can lead into the start step.");
        if (before && row.kind === "end") throw new ToolError("invalid_input", "An end step can't come before another step.");
        if (after && row.kind === "start") throw new ToolError("invalid_input", "The start step can't come after another step.");
        if (after && before) {
          const between = bundle.edges.find((x) => x.from_step_id === after.id && x.to_step_id === before.id);
          if (between) reroute(between, { to_step_id: id });
          else {
            const share = Math.max(0, Math.round((1 - outgoingTotal(bundle, after.id)) * 1000) / 1000);
            connect(after.id, id, share);
            assumptions.push(`'${after.name}' → '${row.name}' takes the ${Math.round(share * 1000) / 10}% '${after.name}''s other branches leave.`);
          }
          connect(id, before.id, 1);
        } else if (after) {
          const out = bundle.edges.filter((x) => x.from_step_id === after.id);
          if (out.length > 1) {
            throw new ToolError(
              "ambiguous",
              `'${after.name}' branches to ${out.length} steps; pass \`before\` too to say which branch '${row.name}' goes on`,
              out.map((x) => ({ id: x.to_step_id, name: bundle.steps.find((s) => s.id === x.to_step_id)?.name ?? x.to_step_id })),
            );
          }
          if (out.length === 1 && row.kind !== "end") reroute(out[0]!, { from_step_id: id });
          connect(after.id, id, out.length === 1 && row.kind === "end" ? Math.max(0, 1 - outgoingTotal(bundle, after.id)) : 1);
        } else if (before) {
          for (const x of bundle.edges.filter((x) => x.to_step_id === before.id)) reroute(x, { to_step_id: id });
          connect(id, before.id, 1);
        }
        const editConflicts = await applyPlan(ctx, e.draft.revision_id, plan);
        const touched = [id, ...(after ? [after.id] : []), ...(before ? [before.id] : [])];
        const conflictText = built.conflicts.map((c) => ` ${c.text}`).join("");
        return {
          ...header(e),
          step: stepOut(row, bundle),
          edges: graph.edges.filter((x) => x.from_step_id === id || x.to_step_id === id).map((x) => edgeOut(x, graph.steps)),
          conflicts: built.conflicts,
          edit_conflicts: editConflicts,
          warnings: [...warningsFor(graph, touched).map((w) => (w.step ? `${w.step}: ${w.warning}` : w.warning)), ...l.warnings],
          text:
            `Added '${row.name}' to the draft of '${e.proc.name}'${after ? ` after '${after.name}'` : ""}${before ? ` before '${before.name}'` : ""}.` +
            (built.assumptions.length ? ` ${plural(built.assumptions.length, "value")} ${built.assumptions.length === 1 ? "is an assumption" : "are assumptions"} to confirm.` : "") +
            conflictText +
            conflictNote(editConflicts),
        };
      }),
  );

  server.registerTool(
    "update_step",
    {
      title: "Update step",
      description:
        "Change a step in the process's draft (its id stays). Only the fields you pass change. A value someone entered or measured is never " +
        "overwritten: a different value is flagged as a conflict for a person to settle. New citations in `evidence` join the value's " +
        "evidence; sources that disagree become a triangular range and a conflict. `name` renames the step.",
      inputSchema: {
        step: stepRef,
        name: z.string().trim().min(1).max(200).optional().describe("New name."),
        ...stepFieldsShape,
        process: processArg,
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const process = await processForStep(ctx, ws, args, assumptions);
        const e = await beginEdit(ctx, { workspace: ws.id, process }, assumptions);
        const { bundle } = e;
        const where = ` in '${e.proc.name}'`;
        const row = resolveName(bundle.steps, args.step, "step", where);
        if (args.name && normalizeName(args.name) !== normalizeName(row.name)) {
          const clash = bundle.steps.find((s) => s.id !== row.id && normalizeName(s.name) === normalizeName(args.name!));
          if (clash) throw new ToolError("name_taken", `'${e.proc.name}' already has a step called '${clash.name}'`, [{ id: clash.id, name: clash.name }]);
        }
        const l = await lookupsFor(ctx, e.ws, e.bundle, !!args.evidence?.length);
        const fields = toFields(args, l, where);
        if (args.rework_to !== undefined) fields.rework_to_step_id = args.rework_to === null ? null : resolveName(bundle.steps, args.rework_to, "step", where).id;
        const change = buildStepChange(row, fields, e.stamp, { outcome: nextOutcome(bundle.steps.filter((s) => s.id !== row.id)) });
        assumptions.push(...change.assumptions);

        const plan = { ...emptyPlan(), updateSteps: Object.keys(change.changes).length ? [{ id: row.id, name: change.row.name, base: change.base, changes: change.changes }] : [] };
        let graph: Graph = { steps: bundle.steps.map((s) => (s.id === row.id ? change.row : s)), edges: bundle.edges };
        const start = startProblem(graph);
        if (start) throw new ToolError("invalid_input", start);
        const rework = reworkProblem(graph, row.id, change.row.rework_to_step_id);
        if (rework) throw new ToolError("invalid_input", rework);
        // As the editor's setStepKind: an end step loses its way out, a start step its ways in, and rework can't point at either.
        const dropped: EdgeRow[] = [];
        if (change.row.kind !== row.kind && (change.row.kind === "end" || change.row.kind === "start")) {
          dropped.push(...graph.edges.filter((x) => (change.row.kind === "end" ? x.from_step_id === row.id : x.to_step_id === row.id)));
          for (const s of graph.steps.filter((s) => s.rework_to_step_id === row.id)) {
            plan.updateSteps.push({ id: s.id, name: s.name, base: { rework_to_step_id: row.id }, changes: { rework_to_step_id: null } });
          }
        }
        plan.removeEdges = dropped;
        graph = { ...graph, edges: graph.edges.filter((x) => !dropped.includes(x)) };
        const editConflicts = await applyPlan(ctx, e.draft.revision_id, plan);
        const changed = Object.keys(change.changes).filter((k) => k !== "assumption" && k !== "conflict" && !k.startsWith("provenance."));
        const text = !Object.keys(change.changes).length && !dropped.length
          ? `Nothing to change on '${row.name}'${change.kept.length ? `: ${change.kept.map((k) => k.reason).join("; ")}` : ""}.`
          : `Updated '${change.row.name}' in the draft of '${e.proc.name}'${changed.length ? ` (${changed.join(", ")})` : ""}.` +
            (change.kept.length ? ` Kept ${change.kept.map((k) => `${k.field} ${JSON.stringify(k.kept)}`).join(", ")} (entered or measured); the new value is flagged as a conflict.` : "") +
            change.conflicts.map((c) => ` ${c.text}`).join("") +
            (dropped.length ? ` Removed ${plural(dropped.length, "connection")} a ${change.row.kind} step can't have.` : "") +
            conflictNote(editConflicts);
        return {
          ...header(e),
          step: stepOut(change.row, bundle),
          changes: change.changes,
          not_overwritten: change.kept,
          conflicts: change.conflicts,
          edit_conflicts: editConflicts,
          removed_edges: dropped.map((x) => edgeOut(x, graph.steps)),
          warnings: [...warningsFor(graph, [row.id]).map((w) => (w.step ? `${w.step}: ${w.warning}` : w.warning)), ...l.warnings],
          text,
        };
      }),
  );

  server.registerTool(
    "remove_step",
    {
      title: "Remove step",
      description:
        "Remove a step from the process's draft, with its connections (live keeps it until publish). `reconnect: true` joins the steps that led " +
        "into it to the one step it led to. `replaced_by` records which steps took over its work (a split or replacement), so saved scenarios " +
        "aimed at it can be re-pointed.",
      inputSchema: {
        step: stepRef,
        reconnect: z.boolean().optional().describe("Lead the steps before it straight to the step after it (default false)."),
        replaced_by: z.array(z.string().min(1)).max(20).optional().describe("Steps (id or name) that take over its work."),
        process: processArg,
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const process = await processForStep(ctx, ws, args, assumptions);
        const e = await beginEdit(ctx, { workspace: ws.id, process }, assumptions);
        const { bundle } = e;
        const where = ` in '${e.proc.name}'`;
        const row = resolveName(bundle.steps, args.step, "step", where);
        const replacements = (args.replaced_by ?? []).map((r) => resolveName(bundle.steps, r, "step", where));
        if (replacements.some((r) => r.id === row.id)) throw new ToolError("invalid_input", "A step can't replace itself.");
        const incoming = bundle.edges.filter((x) => x.to_step_id === row.id && x.from_step_id !== row.id);
        const outgoing = bundle.edges.filter((x) => x.from_step_id === row.id);
        const plan = emptyPlan();
        const rerouted: EdgeRow[] = [];
        let edges = bundle.edges.filter((x) => x.from_step_id !== row.id && x.to_step_id !== row.id);
        if (args.reconnect) {
          if (outgoing.length !== 1) {
            throw new ToolError("invalid_input", `'${row.name}' leads to ${outgoing.length} steps; reconnect needs exactly one. Remove it without reconnect and use set_routing.`);
          }
          const next = outgoing[0]!.to_step_id;
          for (const x of incoming) {
            const twin = edges.find((y) => y.from_step_id === x.from_step_id && y.to_step_id === next);
            if (twin) {
              // Already connected: that branch takes this one's share too.
              const probability = Math.min(1, Math.round((Number(twin.probability) + Number(x.probability)) * 1000) / 1000);
              plan.updateEdges.push({ id: twin.id, base: { probability: twin.probability }, changes: { probability } });
              plan.removeEdges.push(x);
              edges = edges.map((y) => (y.id === twin.id ? { ...y, probability } : y));
            } else if (connectionProblem({ steps: bundle.steps, edges }, x.from_step_id, next)) {
              plan.removeEdges.push(x);
            } else {
              plan.updateEdges.push({ id: x.id, base: { to_step_id: x.to_step_id }, changes: { to_step_id: next } });
              const moved = { ...x, to_step_id: next };
              rerouted.push(moved);
              edges = [...edges, moved];
            }
          }
          plan.removeEdges.push(...outgoing);
        } else plan.removeEdges.push(...incoming, ...outgoing);
        for (const s of bundle.steps.filter((s) => s.id !== row.id && s.rework_to_step_id === row.id)) {
          plan.updateSteps.push({ id: s.id, name: s.name, base: { rework_to_step_id: row.id }, changes: { rework_to_step_id: null } });
        }
        plan.removeSteps.push(row);
        const editConflicts = await applyPlan(ctx, e.draft.revision_id, plan);
        if (replacements.length) {
          // As the editor's split (docs/adr/0006-retired-steps-and-broken-scenarios.md): the row stays, retired, under the same id.
          const retired: StepRow = { ...row, replaced_by: replacements.map((r) => r.id), assumption: false, conflict: false };
          const { error } = await ctx.db.from("steps").insert({ ...retired, provenance: retired.provenance as Json });
          if (error) throw writeError(error, "record replacements");
        }
        const steps = bundle.steps.filter((s) => s.id !== row.id);
        const graph = { steps, edges };
        const neighbours = [...incoming.map((x) => x.from_step_id), ...outgoing.map((x) => x.to_step_id)];
        return {
          ...header(e),
          removed: { id: row.id, name: row.name, replaced_by: replacements.map((r) => ({ id: r.id, name: r.name })) },
          removed_edges: plan.removeEdges.map((x) => edgeOut(x, bundle.steps)),
          rerouted_edges: rerouted.map((x) => edgeOut(x, steps)),
          edit_conflicts: editConflicts,
          warnings: warningsFor(graph, neighbours).map((w) => (w.step ? `${w.step}: ${w.warning}` : w.warning)),
          text:
            `Removed '${row.name}' from the draft of '${e.proc.name}'` +
            (replacements.length ? `, replaced by ${replacements.map((r) => `'${r.name}'`).join(" and ")}` : "") +
            (rerouted.length ? `; ${plural(rerouted.length, "connection")} now lead${rerouted.length === 1 ? "s" : ""} straight on` : "") +
            `. Live keeps it until the draft is published.` +
            conflictNote(editConflicts),
        };
      }),
  );

  server.registerTool(
    "connect_steps",
    {
      title: "Connect steps",
      description:
        "Connect two steps in the process's draft. Without `probability`, the new branch takes whatever share the step's other branches leave " +
        "(as on the canvas). The editor's rules apply: nothing leaves an end step or enters the start step, and a step can't lead to itself.",
      inputSchema: {
        from: stepRef,
        to: stepRef,
        probability: z.number().min(0).max(1).optional(),
        condition_tag: z.string().max(100).nullish().describe("Only entities whose service carries this tag take the branch."),
        label: z.string().max(200).nullish(),
        process: processArg,
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const e = await beginEdit(ctx, args, assumptions);
        const { bundle } = e;
        const where = ` in '${e.proc.name}'`;
        const from = resolveName(bundle.steps, args.from, "step", where);
        const to = resolveName(bundle.steps, args.to, "step", where);
        const problem = connectionProblem(bundle, from.id, to.id);
        if (problem) throw new ToolError("invalid_input", problem + (problem.includes("already leads") ? " Use set_routing to change its probability." : ""));
        const probability = args.probability ?? Math.max(0, Math.round((1 - outgoingTotal(bundle, from.id)) * 1000) / 1000);
        if (args.probability === undefined) assumptions.push(`probability defaulted to ${Math.round(probability * 1000) / 10}% (the share '${from.name}''s other branches leave).`);
        const edge: EdgeRow = {
          id: newId(),
          ...e.owner,
          from_step_id: from.id,
          to_step_id: to.id,
          probability,
          condition_tag: args.condition_tag?.trim() || null,
          label: args.label?.trim() || null,
        };
        await applyPlan(ctx, e.draft.revision_id, { ...emptyPlan(), insertEdges: [edge] });
        const graph = { steps: bundle.steps, edges: [...bundle.edges, edge] };
        return {
          ...header(e),
          edge: edgeOut(edge, bundle.steps),
          warnings: warningsFor(graph, [from.id]).map((w) => (w.step ? `${w.step}: ${w.warning}` : w.warning)),
          text: `Connected '${from.name}' to '${to.name}' (${Math.round(probability * 1000) / 10}%) in the draft of '${e.proc.name}'.`,
        };
      }),
  );

  server.registerTool(
    "set_routing",
    {
      title: "Set routing",
      description:
        "Set all of a step's outgoing branches at once in the process's draft: each route's target and probability (they must add up to 100%). " +
        "Branches to the same targets keep their ids; others are removed; new ones are added.",
      inputSchema: {
        step: stepRef,
        routes: z.array(routeArg).min(1).max(20),
        process: processArg,
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const process = await processForStep(ctx, ws, args, assumptions);
        const e = await beginEdit(ctx, { workspace: ws.id, process }, assumptions);
        const { bundle } = e;
        const where = ` in '${e.proc.name}'`;
        const step = resolveName(bundle.steps, args.step, "step", where);
        if (step.kind === "end") throw new ToolError("invalid_input", `End steps can't lead anywhere ('${step.name}' is an end step).`);
        if (step.kind === "start" && args.routes.length !== 1) throw new ToolError("invalid_input", "The start step leads to exactly one step.");
        const routes = args.routes.map((r) => ({ ...r, target: resolveName(bundle.steps, r.to, "step", where) }));
        const total = routes.reduce((sum, r) => sum + r.probability, 0);
        if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) {
          throw new ToolError("invalid_input", `The routes add up to ${Math.round(total * 1000) / 10}%; they must add up to 100%.`);
        }
        const existing = bundle.edges.filter((x) => x.from_step_id === step.id);
        const others = bundle.edges.filter((x) => x.from_step_id !== step.id);
        const plan = emptyPlan();
        const result: EdgeRow[] = [];
        for (const r of routes) {
          if (result.some((x) => x.to_step_id === r.target.id)) throw new ToolError("invalid_input", `'${r.target.name}' is listed twice.`);
          const problem = connectionProblem({ steps: bundle.steps, edges: others }, step.id, r.target.id);
          if (problem) throw new ToolError("invalid_input", problem);
          const old = existing.find((x) => x.to_step_id === r.target.id);
          const want = {
            probability: r.probability,
            ...(r.condition_tag !== undefined ? { condition_tag: r.condition_tag?.trim() || null } : {}),
            ...(r.label !== undefined ? { label: r.label?.trim() || null } : {}),
          };
          if (old) {
            const changes = Object.fromEntries(Object.entries(want).filter(([k, v]) => (k === "probability" ? Number(old.probability) !== v : old[k as keyof EdgeRow] !== v)));
            if (Object.keys(changes).length) plan.updateEdges.push({ id: old.id, base: Object.fromEntries(Object.keys(changes).map((k) => [k, old[k as keyof EdgeRow]])), changes });
            result.push({ ...old, ...want });
          } else {
            const edge: EdgeRow = { id: newId(), ...e.owner, from_step_id: step.id, to_step_id: r.target.id, condition_tag: null, label: null, ...want };
            plan.insertEdges.push(edge);
            result.push(edge);
          }
        }
        plan.removeEdges = existing.filter((x) => !result.some((y) => y.id === x.id));
        const editConflicts = await applyPlan(ctx, e.draft.revision_id, plan);
        return {
          ...header(e),
          step: { id: step.id, name: step.name },
          routes: result.map((x) => edgeOut(x, bundle.steps)),
          removed_edges: plan.removeEdges.map((x) => edgeOut(x, bundle.steps)),
          edit_conflicts: editConflicts,
          text:
            `'${step.name}' now leads to ${result.map((x) => `'${bundle.steps.find((s) => s.id === x.to_step_id)?.name}' (${Math.round(Number(x.probability) * 1000) / 10}%)`).join(", ")} in the draft of '${e.proc.name}'.` +
            conflictNote(editConflicts),
        };
      }),
  );

  server.registerTool(
    "import_process",
    {
      title: "Import process",
      description:
        "Write a whole process graph (steps with numbers, evidence and reasoning, and edges) into a draft. Without `target`, creates a new " +
        "process as a draft. With `target`, writes into that process's draft (opening one if needed): steps are matched by stable id, then by " +
        "name, and keep their ids; values someone entered or measured are never overwritten but flagged as conflicts; a step whose edges are " +
        "listed gets exactly those edges. Steps can hold steps: give a step `steps` and it is a group (a box of steps inside the process, to any " +
        "depth), or give it `child_process` (an existing process) or `process` (a new one, written in the same call) and it holds a child process " +
        "of its own. The engine simulates the detailed steps, so a group or child process changes how the map is drawn, not the numbers. Names and " +
        "the graph are checked before anything is written, so a failed call creates no process and opens no draft. Returns the diff against live, " +
        "the conflicts and the checklist of assumptions to confirm, with the same for each child process written.",
      inputSchema: {
        process_json: z
          .union([processJsonArg, z.string().max(2_000_000)])
          .describe(
            "{name?, kind?, entity_name?, description?, steps: [{id?, name, kind?, outcome?, role?, work_hours?, ..., evidence?, assumptions?, " +
              "steps?: [...a group's steps], entry?, parent?, child_process?: 'existing process', process?: {...a new child process}}], " +
              "edges: [{from, to, probability?}], remove_missing?, assumptions?: [{step, field, reasoning}]} (an object, or the same as a JSON string).",
          ),
        target: z.string().optional().describe("Existing process (id or name) to write into; omit to create a new process."),
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        let json: ProcessJson;
        if (typeof args.process_json === "string") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(args.process_json);
          } catch {
            throw new ToolError("invalid_input", "process_json isn't valid JSON.");
          }
          const r = processJsonArg.safeParse(parsed);
          if (!r.success) throw new ToolError("invalid_input", `process_json: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
          json = r.data;
        } else json = args.process_json;
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        await requireCanEdit(ctx, ws);

        const processes = await importProcesses(ctx, ws.id);
        const scope: ImportScope = { ctx, ws, assumptions, reserved: new Set(), processes, claimed: new Map(), stamp: await stampOf(ctx) };
        let prepared: PreparedImport;
        if (args.target) {
          const target = await resolveProcess(ctx, ws, args.target, assumptions);
          const ignored = (["name", "kind", "entity_name", "description"] as const).filter((k) => json[k] !== undefined && json[k] !== (target as unknown as Record<string, unknown>)[k]);
          if (ignored.length) assumptions.push(`process_json's ${ignored.join(", ")} ${ignored.length === 1 ? "was" : "were"} ignored: they belong to the process, not its draft.`);
          prepared = await prepareImport(scope, json, { target, ancestors: ancestorsOf(processes, target) });
        } else {
          prepared = await prepareNewProcess(scope, json);
        }
        await prepared.ensure(null);
        return prepared.write();
      }),
  );

  server.registerTool(
    "publish_process",
    {
      title: "Publish process",
      description:
        "Make the process's draft live (the old live revision is kept as superseded). Refused while any step is an unconfirmed assumption or an " +
        "unsettled conflict, listing them, unless `accept_estimates: true`, which publishes them as estimates and records that choice in the audit log.",
      inputSchema: {
        process: processArg,
        accept_estimates: z.boolean().optional().describe("Publish even with unconfirmed assumptions or conflicts (default false)."),
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = await resolveProcess(ctx, ws, args.process, assumptions);
        if (args.accept_estimates === undefined) assumptions.push("accept_estimates defaulted to false.");
        const draftSteps = proc.draft_revision_id ? (await loadProcessBundle(ctx.db, ws, proc, proc.draft_revision_id)).steps : [];
        const { data, error } = await ctx.db.rpc("publish_process", { target_process: proc.id, accept_estimates: args.accept_estimates ?? false });
        if (error) throw writeError(error, "publish processes");
        const r = data as {
          status: string;
          revision_id?: string;
          number?: number;
          previous_revision_id?: string | null;
          changes?: { steps: RevisionChanges; edges: RevisionChanges };
          steps?: { id: string; name: string; assumption: boolean; conflict: boolean }[];
        };
        if (r.status === "not_found") throw new ToolError("forbidden", `You don't have permission to publish '${proc.name}' (editors and owners can).`);
        if (r.status === "no_draft") throw new ToolError("no_draft", `'${proc.name}' has no draft to publish.`);
        if (r.status === "unresolved") {
          const items = checklist(draftSteps);
          const steps = r.steps ?? [];
          throw new ToolError(
            "unresolved",
            `'${proc.name}' still has ${plural(steps.length, "step")} with unconfirmed assumptions or conflicts (${steps.map((s) => s.name).join(", ")}). ` +
              "Confirm them on the canvas, or publish with accept_estimates: true to keep them as estimates.",
            items.length ? items : steps,
          );
        }
        try {
          ctx.onPublished?.(proc.id);
        } catch {
          // A hook that starts background work never fails a publish.
        }
        const names = new Map(draftSteps.map((s) => [s.id, s.name]));
        const named = (ids: string[] = []) => ids.map((id) => ({ id, name: names.get(id) ?? null }));
        const changes = r.changes;
        const estimates = draftSteps.filter((s) => s.assumption || s.conflict).length;
        return {
          workspace: { id: ws.id, name: ws.name },
          process: { id: proc.id, name: proc.name },
          revision: { id: r.revision_id, number: r.number, previous_revision_id: r.previous_revision_id ?? null },
          accepted_estimates: args.accept_estimates === true && estimates > 0,
          changes: changes && {
            steps: { added: named(changes.steps.added), removed: changes.steps.removed, changed: named(changes.steps.changed) },
            edges: changes.edges,
          },
          text:
            `Published '${proc.name}' as revision ${r.number}` +
            (changes ? ` (${changes.steps.added.length} steps added, ${changes.steps.removed.length} removed, ${changes.steps.changed.length} changed)` : "") +
            (args.accept_estimates && estimates ? `, accepting ${plural(estimates, "step")} with estimates` : "") +
            ". Simulations, forecasts and reports now use it.",
        };
      }),
  );

  server.registerTool(
    "discard_draft",
    {
      title: "Discard draft",
      description: "Throw away the process's draft and every change in it. Live is unchanged.",
      inputSchema: { process: processArg, workspace: workspaceArg },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = await resolveProcess(ctx, ws, args.process, assumptions);
        const { data, error } = await ctx.db.rpc("discard_draft", { target_process: proc.id });
        if (error) throw writeError(error, "discard drafts");
        const r = data as { status: string; revision_id?: string };
        if (r.status === "not_found") throw new ToolError("forbidden", `You don't have permission to discard the draft of '${proc.name}' (editors and owners can).`);
        if (r.status === "no_draft") throw new ToolError("no_draft", `'${proc.name}' has no draft.`);
        return {
          workspace: { id: ws.id, name: ws.name },
          process: { id: proc.id, name: proc.name },
          discarded_revision_id: r.revision_id,
          text: proc.live_revision_id
            ? `Discarded the draft of '${proc.name}'; the live revision is unchanged.`
            : `Discarded the draft of '${proc.name}'. It was never published, so it has no steps now; import_process with target '${proc.name}' starts it again.`,
        };
      }),
  );

  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description: "The process templates create_from_template can start a draft from, with their steps.",
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool(async () => ({
        templates: PROCESS_TEMPLATES.map(templateSummary),
        text: `${plural(PROCESS_TEMPLATES.length, "template")}: ${PROCESS_TEMPLATES.map((t) => `${t.name} (${t.kind})`).join(", ")}.`,
      })),
  );

  server.registerTool(
    "create_from_template",
    {
      title: "Create from template",
      description:
        "Create a new process as a draft from a template (list_templates). Every number in it is a generic estimate, marked as an assumption " +
        "to confirm; roles are left for you to assign.",
      inputSchema: {
        template: z.string().min(1).describe("Template id or name."),
        name: z.string().trim().min(1).max(200).optional().describe("Name for the new process (default: the template's name)."),
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const { t, proc, draft, bundle } = await fromTemplate(ctx, ws, args.template, args.name, assumptions);
        const items = checklist(bundle.steps);
        return {
          ...header({ ws, proc, draft }),
          template: { id: t.id, name: t.name },
          steps: bundle.steps.map((s) => stepOut(s, bundle)),
          edges: bundle.edges.map((x) => edgeOut(x, bundle.steps)),
          checklist: items,
          text: `Created '${proc.name}' from the '${t.name}' template as a draft: ${plural(bundle.steps.length, "step")}, ${plural(items.length, "assumption")} to confirm.`,
        };
      }),
  );
}
