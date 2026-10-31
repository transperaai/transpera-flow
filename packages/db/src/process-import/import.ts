// Writing a process into a company (issue #24, #166): a new process with a draft revision, from `process_json` (what an
// uploaded file is turned into, import-file.ts) or from a built-in template (the process library). Both act as the
// signed-in user through RLS, so only editors can; nothing is published; and an import is written by one database
// transaction (`import_new_process`, `import_process_bundle`), so a failed call leaves nothing behind. The rules for values,
// evidence and the graph live in building.ts. The text is templated, never written by a language model.
//
// This was the MCP server's process-building code. MCP is read-only now (docs/plans/cut-list.md item 5): what the web app's
// "Upload process" and process library need lives here, and the tools that edited a draft, with the ability to write into an
// existing draft, are gone.

import { checklistItems, EVIDENCE_COLUMNS, listProcesses, loadProcessBundle, type Json, type SourceRow, type StepRow } from "../index";
import { rpc } from "../client";
import {
  flattenNesting,
  graphWarnings,
  normalizeName,
  planImport,
  resolveName,
  type BuildStepKind,
  type Citation,
  type Graph,
  type ImportEdge,
  type ImportPlan,
  type ImportStep,
  type Stamp,
  type StepFields,
  type StepOwner,
} from "./building";
import { resolveWorkspace, type ProcessWithDraft, type ImportContext, type WorkspaceRef } from "./context";
import { ImportError } from "./errors";
import { PROCESS_TEMPLATES } from "./templates";

/** Most steps one import creates in one transaction (the database checks the same limit). */
const MAX_IMPORT_TOTAL_STEPS = 1000;

// ---------------------------------------------------------------------------
// process_json
// ---------------------------------------------------------------------------

type EvidenceColumn = (typeof EVIDENCE_COLUMNS)[number];

/** A quote that backs a number, citing a source by id or title. */
interface CitationJson {
  field: EvidenceColumn;
  source: string;
  speaker?: string | null;
  quote: string;
  timestamp?: string | null;
  value?: number | null;
}

interface ParamsJson {
  cv?: number | null;
  min?: number | null;
  mode?: number | null;
  max?: number | null;
}

/** The fields a step of process_json can give (role and person by id or name). */
interface StepFieldsJson {
  kind?: BuildStepKind;
  outcome?: "won" | "lost" | "done";
  role?: string | null;
  person?: string | null;
  work_hours?: number;
  work_dist?: "constant" | "triangular" | "lognormal";
  work_params?: ParamsJson;
  wait_hours?: number;
  wait_dist?: "constant" | "triangular" | "lognormal";
  wait_params?: ParamsJson;
  rework_rate?: number;
  rework_to?: string | null;
  tool?: string | null;
  notes?: string | null;
  sla_hours?: number | null;
  current_wip?: number | null;
  x?: number;
  y?: number;
  evidence?: CitationJson[];
  assumptions?: { field: EvidenceColumn; reasoning: string }[];
}

/** A step of process_json: its fields, and the group it sits in (`parent`, by name) or is the first step of (`entry`). */
export interface ImportStepJson extends StepFieldsJson {
  id?: string;
  name: string;
  parent?: string | null;
  entry?: string | null;
  steps?: ImportStepJson[];
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
  assumptions?: { step: string; field: EvidenceColumn; reasoning: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DbError = { code?: string; message?: string };
type Named = { id: string; name: string };

/** The columns of a source the import reads (the row's text and dates included). */
const SOURCE_FIELDS = ["id", "workspace_id", "kind", "title", "speakers", "recorded_at", "body", "file_url", "created_at", "updated_at"] as const;

/** A write RLS, a trigger or a check refused, as an ImportError the caller can act on. */
export function writeError(error: DbError, what: string): ImportError {
  if (error.code === "42501") return new ImportError("forbidden", `You don't have permission to ${what} in this workspace (Agency admins and the Owner can).`);
  if (error.code === "23514") return new ImportError("invalid_input", `Some of those values aren't allowed: ${error.message ?? ""}`.trim());
  if (error.code === "23503") return new ImportError("not_found", "Something that change refers to no longer exists.");
  if (error.code === "23505") return new ImportError("duplicate", `That already exists: ${error.message ?? ""}`.trim());
  return new ImportError("write_failed", `Couldn't ${what}: ${error.message ?? "unknown error"}`);
}

/** Run a database call and turn a thrown pg error into the ImportError `writeError` makes for it. */
async function writing<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw writeError(error as DbError, what);
  }
}

const stampOf = (ctx: ImportContext): Stamp => ({ at: new Date().toISOString(), by: ctx.userId ?? null });

const newId = (): string => crypto.randomUUID();

interface Draft {
  revision_id: string;
  number: number;
  created: boolean;
}

/** Open the process's draft (a new process gets an empty one). */
async function openDraft(ctx: ImportContext, proc: { id: string; name: string }): Promise<Draft> {
  const data = await writing("edit processes", () => rpc(ctx.db, "open_draft", { target_process: proc.id }));
  const r = data as { status: string; revision_id?: string; number?: number; created?: boolean };
  // open_draft locks the process for update, so a process the user may read but not edit is not found.
  if (r.status !== "ok") throw new ImportError("forbidden", `You don't have permission to edit '${proc.name}' (Agency admins and the Owner can).`);
  return { revision_id: r.revision_id!, number: r.number!, created: r.created === true };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface Lookups {
  roles: Named[];
  people: Named[];
  sources: (SourceRow & { name: string })[];
  steps: StepRow[];
  warnings: string[];
}

async function loadSources(ctx: ImportContext, ws: WorkspaceRef): Promise<Lookups["sources"]> {
  const rows = (await ctx.db.selectFrom("sources").select([...SOURCE_FIELDS]).where("workspace_id", "=", ws.id).execute()) as unknown as SourceRow[];
  return rows.map((s) => ({ ...s, name: s.title }));
}

async function lookupsFor(
  ctx: ImportContext,
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

/** A step's fields as step fields: role, person and sources resolved to ids (ambiguous names return candidates). */
function toFields(args: StepFieldsJson & { name?: string }, l: Lookups, where: string): StepFields {
  const f: StepFields = {};
  if (args.name !== undefined) f.name = args.name;
  for (const key of ["kind", "outcome", "work_hours", "work_dist", "wait_hours", "wait_dist", "rework_rate", "tool", "notes", "sla_hours", "current_wip", "x", "y"] as const) {
    if (args[key] !== undefined) (f as Record<string, unknown>)[key] = args[key];
  }
  const params = (p: ParamsJson | undefined) => p && (Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as StepFields["work_params"]);
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

/** Per-field compare-and-set of one row (a group's first step, set once its steps are in place). */
async function saveFields(ctx: ImportContext, table: "steps", revisionId: string, id: string, base: Record<string, unknown>, changes: Record<string, unknown>): Promise<void> {
  const data = await writing("edit processes", () =>
    rpc(ctx.db, "save_fields", {
      target: table,
      key: { revision_id: revisionId, id } as Json,
      base: base as Json,
      changes: changes as Json,
    }),
  );
  const r = data as { status: string };
  if (r.status === "not_found") throw new ImportError("not_found", `The step ${id} is no longer in the draft.`);
}

/** Write a new process's plan into its empty draft: the steps, then each group's first step, then the edges. */
async function applyPlan(ctx: ImportContext, revisionId: string, plan: Pick<ImportPlan, "insertSteps" | "insertEdges">): Promise<void> {
  if (plan.insertSteps.length) {
    // A group's first step is set once its steps are all in place (the database checks it when each request commits).
    await writing("add steps", () => ctx.db.insertInto("steps").values(plan.insertSteps.map((s) => ({ ...s, entry_step_id: null, provenance: s.provenance as Json }))).execute());
  }
  for (const s of plan.insertSteps.filter((x) => x.entry_step_id)) {
    await saveFields(ctx, "steps", revisionId, s.id, { entry_step_id: null }, { entry_step_id: s.entry_step_id });
  }
  if (plan.insertEdges.length) {
    await writing("connect steps", () => ctx.db.insertInto("edges").values(plan.insertEdges).execute());
  }
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

/** A new process with an empty draft revision (processes aren't revisioned, so its row is written directly). */
async function createProcessWithDraft(
  ctx: ImportContext,
  ws: WorkspaceRef,
  input: { name: string; kind: "pipeline" | "servicing"; entity_name: string; description: string | null; source: "template" },
  /** For the process library (B12): made with `create_library_process`, so the company map gives it no card of its own (the person places it). */
  { offMap = false }: { offMap?: boolean } = {},
): Promise<{ proc: ProcessWithDraft; draft: Draft }> {
  const existing = await listProcesses(ctx.db, ws.id);
  const clash = existing.find((p) => normalizeName(p.name) === normalizeName(input.name));
  if (clash) throw new ImportError("name_taken", `'${ws.name}' already has a process called '${clash.name}'. Give this one a different name.`, [{ id: clash.id, name: clash.name }]);
  const columns = ["id", "workspace_id", "name", "kind", "entity_name", "description", "live_revision_id", "draft_revision_id", "parent_process_id"] as const;
  let proc: ProcessWithDraft;
  if (offMap) {
    const reply = await writing("create processes", () =>
      rpc(ctx.db, "create_library_process", {
        p_workspace: ws.id,
        p_name: input.name,
        p_kind: input.kind,
        p_entity_name: input.entity_name,
        p_description: input.description ?? undefined,
        p_source: input.source,
      }),
    );
    const r = reply as { status: string; process_id?: string };
    if (r.status === "name_taken") throw new ImportError("name_taken", `'${ws.name}' already has a process called '${input.name}'`);
    if (r.status !== "created" || !r.process_id) throw new ImportError("forbidden", `Couldn't create '${input.name}' in '${ws.name}' (${r.status}).`);
    const processId = r.process_id;
    proc = (await writing("create processes", () => ctx.db.selectFrom("processes").select([...columns]).where("id", "=", processId).executeTakeFirstOrThrow())) as unknown as ProcessWithDraft;
  } else {
    proc = (await writing("create processes", () =>
      ctx.db
        .insertInto("processes")
        .values({ workspace_id: ws.id, name: input.name, kind: input.kind, entity_name: input.entity_name, description: input.description, source: input.source })
        .returning([...columns])
        .executeTakeFirstOrThrow(),
    )) as unknown as ProcessWithDraft;
  }
  const draft = await openDraft(ctx, proc);
  return { proc: { ...proc, draft_revision_id: draft.revision_id }, draft };
}

/** Reasoning given at the top of process_json, moved onto its steps. */
function withTopLevelReasoning<T extends { id?: string; name: string; assumptions?: { field: EvidenceColumn; reasoning: string }[] }>(steps: T[], top: ProcessJson["assumptions"]): T[] {
  if (!top?.length) return steps;
  return steps.map((s) => {
    const extra = top.filter((a) => normalizeName(a.step) === normalizeName(s.name) || a.step === s.id);
    if (!extra.length) return s;
    const mine = s.assumptions ?? [];
    return { ...s, assumptions: [...mine, ...extra.filter((a) => !mine.some((m) => m.field === a.field)).map((a) => ({ field: a.field, reasoning: a.reasoning }))] };
  });
}

// ---------------------------------------------------------------------------
// Importing a new process
// ---------------------------------------------------------------------------

type DraftBundle = Graph & { roles: readonly Named[]; people: readonly Named[]; retired?: StepRow[] };

/** What an import returns for one process: the draft it wrote and what to check, with the child processes written beside it. */
export interface ImportOutcome {
  workspace: { id: string; name: string };
  process: { id: string; name: string };
  draft: { revision_id: string; number: number; opened_now: boolean };
  checklist: ReturnType<typeof checklist>;
  warnings: string[];
  /** A /2 upload: what was written beside the process (sources). */
  bundle?: ImportBundleResult;
  text: string;
}

interface PreparedImport {
  /** The new process's part of the one-transaction write. */
  collect(nodes: ImportNode[]): void;
  /** Take what the one-transaction write returned (the draft of the new process). */
  settle(results: ReadonlyMap<string, { revision_id: string; number: number }>): void;
  /** Read back what was written. */
  write(): Promise<ImportOutcome>;
}

/** A new process as `import_new_process` takes it: its row, and the steps and edges of its first draft. */
interface ImportNode {
  id: string;
  parent_id: null;
  name: string;
  kind: "pipeline" | "servicing";
  entity_name: string;
  description: string | null;
  steps: unknown[];
  edges: unknown[];
}

interface ImportScope {
  ctx: ImportContext;
  ws: WorkspaceRef;
  assumptions: string[];
  /** Names of the processes this call will create, to refuse two with the same name. */
  reserved: Set<string>;
  /** Every process of the workspace, as read once. */
  processes: ProcessWithDraft[];
  stamp: Stamp;
  /** A /2 upload's sources, rows and ids, written in the same transaction as the process (issue #167). */
  bundle?: ImportBundle;
  /** What `import_process_bundle` returned (the counts it wrote), for the top-level process. */
  bundleResult?: ImportBundleResult;
}

/**
 * What a `transpera-process/2` upload carries beyond the process itself (issue #167). Everything is written by one call to
 * `import_process_bundle`, so it is all there afterwards or none of it is. Ids are chosen by the caller so rows that point at
 * each other (a step's evidence cites a source) can be built before anything is written.
 */
export interface ImportBundle {
  /** The new process's id. */
  processId: string;
  /** The file name or link, written to the change log. */
  importSource: string;
  /** Sources to add. Each `id` is a placeholder the evidence cites; the database replaces it with the id it makes. Each is linked to the process. */
  sources: { id: string; kind: string; title: string; speakers: string[]; recorded_at: string | null; body: string | null }[];
  /** The rest of the extras, as `import_process_bundle` takes them (none today). */
  extras: Record<string, never>;
}

/** What `import_process_bundle` wrote beyond the process. */
export interface ImportBundleResult {
  sources: number;
}

/**
 * Check a whole import before writing any of it (a failed call creates no process and opens no draft), then return what writes it.
 * `json` is process_json; steps held in groups are unfolded (flattenNesting).
 */
async function prepareImport(scope: ImportScope, json: ProcessJson, create: { id: string; name: string; kind: "pipeline" | "servicing"; entity_name: string }): Promise<PreparedImport> {
  const { ctx, ws, stamp } = scope;
  const { steps: flat } = flattenNesting(json.steps);

  const clash = scope.processes.find((pr) => normalizeName(pr.name) === normalizeName(create.name));
  if (clash || scope.reserved.has(normalizeName(create.name))) {
    throw new ImportError("name_taken", `'${ws.name}' already has a process called '${clash?.name ?? create.name}'. Give this one a different name.`, clash ? [{ id: clash.id, name: clash.name }] : undefined);
  }
  scope.reserved.add(normalizeName(create.name));
  const description = json.description?.trim() || null;

  // Plan against an empty draft: a new process's draft starts empty, so this plan is the one that gets written.
  const from: DraftBundle = {
    steps: [],
    edges: [],
    roles: await ctx.db.selectFrom("roles").select(["id", "name"]).where("workspace_id", "=", ws.id).execute(),
    people: await ctx.db.selectFrom("people").select(["id", "name"]).where("workspace_id", "=", ws.id).execute(),
  };
  const owner: StepOwner = { revision_id: newId(), workspace_id: ws.id, process_id: create.id };
  const l = await lookupsFor(
    ctx,
    ws,
    from as Graph & { roles: readonly Named[]; people: readonly Named[]; steps: StepRow[] },
    hasCitations(flat),
    (scope.bundle?.sources ?? []).map((s) => ({ id: s.id, workspace_id: ws.id, kind: s.kind, title: s.title, speakers: s.speakers, recorded_at: s.recorded_at, body: s.body, file_url: null, name: s.title }) as unknown as Lookups["sources"][number]),
  );
  const steps: ImportStep[] = withTopLevelReasoning(flat, json.assumptions).map((st) => {
    const { id, name, rework_to, ...rest } = st;
    return {
      ...toFields({ name, ...rest }, l, ` (step '${name}')`),
      ...(rest.parent !== undefined ? { parent: rest.parent } : {}),
      ...(rest.entry !== undefined ? { entry: rest.entry } : {}),
      ...(id !== undefined ? { id } : {}),
      name,
      ...(rework_to !== undefined ? { rework_to } : {}),
    };
  });
  const plan = planImport({ steps, edges: (json.edges ?? []) as ImportEdge[] }, { ...from, retired: [] }, owner, stamp, { newId });
  scope.assumptions.push(...plan.assumptions);

  let ensured: { proc: ProcessWithDraft; draft: Draft } | null = null;
  const prepared: PreparedImport = {
    collect(nodes) {
      nodes.push({
        id: create.id,
        parent_id: null,
        name: create.name,
        kind: create.kind,
        entity_name: create.entity_name,
        description,
        steps: plan.insertSteps,
        edges: plan.insertEdges,
      });
    },
    settle(results) {
      const r = results.get(create.id);
      if (!r) throw new Error("import_new_process returned no draft for a new process");
      ensured = {
        proc: { id: create.id, workspace_id: ws.id, name: create.name, kind: create.kind, entity_name: create.entity_name, description, live_revision_id: null, draft_revision_id: r.revision_id, parent_process_id: null } as ProcessWithDraft,
        draft: { revision_id: r.revision_id, number: r.number, created: true },
      };
    },
    async write() {
      const { proc, draft } = ensured!;
      const after = await loadProcessBundle(ctx.db, ws, proc, draft.revision_id);
      const items = checklist(after.steps);
      const nConflicts = items.filter((i) => i.kind === "conflict").length;
      const warnings = [...graphWarnings(after).map((w) => (w.step ? `${w.step}: ${w.warning}` : w.warning)), ...l.warnings];
      return {
        workspace: { id: ws.id, name: ws.name },
        process: { id: proc.id, name: proc.name },
        draft: { revision_id: draft.revision_id, number: draft.number, opened_now: true },
        checklist: items,
        warnings,
        ...(scope.bundleResult && create.id === scope.bundle?.processId ? { bundle: scope.bundleResult } : {}),
        text:
          `Created '${proc.name}' as a draft: ${plural(plan.insertSteps.length, "step")} and ${plural(plan.insertEdges.length, "connection")}.` +
          ` To confirm before publishing: ${plural(nConflicts, "conflict")}, ${plural(items.length - nConflicts, "assumption")}.`,
      };
    },
  };
  return prepared;
}

/** Refuse unless the caller can edit the workspace's processes (editors and owners). */
async function requireCanEdit(ctx: ImportContext, ws: WorkspaceRef): Promise<void> {
  const canEdit = await writing("edit processes", () => rpc(ctx.db, "can_edit_workspace", { ws: ws.id }));
  if (canEdit !== true) throw new ImportError("forbidden", `You don't have permission to edit processes in '${ws.name}' (Agency admins and the Owner can).`);
}

/**
 * Create a new process, as a draft, from process_json, for the web app's upload (issue #166). Acts as `ctx.db`'s user through
 * RLS, so it needs an editor; checks the whole import before writing any of it; never publishes.
 */
export async function importNewProcess(ctx: ImportContext, workspaceId: string, json: ProcessJson, assumptions: string[] = [], bundle?: ImportBundle): Promise<ImportOutcome> {
  const ws = await resolveWorkspace(ctx, workspaceId);
  await requireCanEdit(ctx, ws);
  const scope: ImportScope = { ctx, ws, assumptions, reserved: new Set(), processes: await listProcesses(ctx.db, ws.id), stamp: stampOf(ctx), ...(bundle ? { bundle } : {}) };
  if (!json.name) throw new ImportError("invalid_input", "process_json needs a name for a new process.");
  const kind = json.kind ?? "pipeline";
  if (!json.kind) assumptions.push("kind defaulted to pipeline.");
  const entity = json.entity_name ?? (kind === "pipeline" ? "lead" : "item");
  if (!json.entity_name) assumptions.push(`entity_name defaulted to '${entity}'.`);
  const prepared = await prepareImport(scope, json, { id: bundle?.processId ?? newId(), name: json.name, kind, entity_name: entity });

  const nodes: ImportNode[] = [];
  prepared.collect(nodes);
  // One transaction has to finish inside the database's statement timeout, so an import has a size limit (checked again there).
  const stepCount = nodes.reduce((n, x) => n + x.steps.length, 0);
  if (stepCount > MAX_IMPORT_TOTAL_STEPS) throw new ImportError("invalid_input", `An import can have at most ${MAX_IMPORT_TOTAL_STEPS} steps in all (this one has ${stepCount}). Split it into smaller imports.`);
  let data: unknown;
  try {
    data = bundle
      ? await rpc(ctx.db, "import_process_bundle", {
          p_workspace: ws.id,
          p_nodes: nodes as unknown as Json,
          p_adopt: [] as unknown as Json,
          p_extras: { sources: bundle.sources.map(({ id, ...rest }) => ({ ref: id, ...rest })), import_source: bundle.importSource, ...bundle.extras } as unknown as Json,
        })
      : await rpc(ctx.db, "import_new_process", { p_workspace: ws.id, p_nodes: nodes as unknown as Json, p_adopt: [] as unknown as Json });
  } catch (e) {
    const error = e as DbError & { hint?: string };
    if (error.code === "23505" && error.hint === "name_taken") throw new ImportError("name_taken", error.message ?? "");
    throw writeError(error, "create processes");
  }
  let made = data as unknown as { process_id: string; revision_id: string; number: number }[];
  if (bundle) {
    const out = data as unknown as { processes: typeof made } & ImportBundleResult;
    made = out.processes;
    scope.bundleResult = { sources: out.sources };
  }
  prepared.settle(new Map(made.map((r) => [r.process_id, r])));
  return prepared.write();
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * A new process from a built-in template, for the process library in the web app's editors (B12, #164), as the signed-in user
 * through RLS. The company map gives the new process no card of its own: the person places it, by a link, in the draft they are
 * editing. Never publishes. Returns the new process's id, name and kind.
 */
export async function createProcessFromTemplate(
  ctx: ImportContext,
  workspaceId: string,
  template: string,
  name?: string,
): Promise<{ id: string; name: string; kind: "pipeline" | "servicing" }> {
  const ws = await resolveWorkspace(ctx, workspaceId);
  await requireCanEdit(ctx, ws);
  const t = resolveName(PROCESS_TEMPLATES, template, "template");
  const { proc, draft } = await createProcessWithDraft(ctx, ws, { name: name ?? t.name, kind: t.kind, entity_name: t.entity_name, description: t.description, source: "template" }, { offMap: true });
  const owner = { revision_id: draft.revision_id, workspace_id: ws.id, process_id: proc.id };
  const plan = planImport({ steps: t.steps, edges: t.edges }, { steps: [], edges: [], retired: [] }, owner, stampOf(ctx), { newId, origin: `template '${t.name}'` });
  await applyPlan(ctx, draft.revision_id, plan);
  return { id: proc.id, name: proc.name, kind: proc.kind as "pipeline" | "servicing" };
}
