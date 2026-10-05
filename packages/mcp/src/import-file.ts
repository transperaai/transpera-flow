// Upload a process (issue #166, B13): a checked `transpera-process/1` file (packages/db/src/process-file.ts) becomes a new
// process with a draft revision. The file is turned into the same process_json `import_process` takes and written by the
// same code (`importNewProcess` in building-tools.ts), so matching, defaults, the editor's graph rules, evidence marks
// ("to confirm") and auto-layout are not duplicated here. What this adds: roles are only ever matched to roles the company
// already has (an unknown one is mapped by the person uploading, or left blank; none is created), people are never created,
// and the upload is written to the change log as "Imported from <file or link>".

import {
  findGaps,
  gapInputFromFile,
  listProcesses,
  loadCompanyModel,
  PROCESS_FILE_FORMAT_2,
  type EvidenceField,
  type GapInput,
  type ProcessFile,
  type SimulationGap,
} from "@transpera-flow/db";
import { normalizeName } from "./building";
import { importNewProcess, type ImportBundle, type ImportBundleResult, type ImportEdgeJson, type ImportStepJson, type ProcessJson } from "./building-tools";
import { planFileExtras, type ExtrasPlan, type FileIds, type SuggestionView } from "./file-extras";
import { resolveWorkspace, type ToolContext } from "./context";
import { ToolError } from "./result";

type Named = { id: string; name: string };

const KIND = { step: "task", decision: "decision", wait: "wait", start: "start", end: "end" } as const;

const check = <T>(r: { data: T | null; error: unknown }): T => {
  if (r.error) throw r.error;
  return r.data as T;
};

/** What the preview shows beyond the file itself: the company's roles, which of the file's roles it has, and name clashes. */
export interface ImportPreview {
  workspace: { id: string; name: string };
  /** The company's roles a role in the file can be mapped to (inactive ones are hidden, as everywhere). */
  roles: Named[];
  /** The file's roles that match one of the company's by name, with the one they match. */
  matchedRoles: { name: string; role: Named }[];
  /** The roles the file names that the company doesn't have: the person uploading maps each or leaves it blank. */
  unknownRoles: string[];
  /** People the file names that aren't in the company; those steps are left unassigned (none is created). */
  unknownPeople: string[];
  /** An existing process already called what the file's process is called. */
  nameTaken: Named | null;
  canEdit: boolean;
  /** A /2 file: what it carries beyond the steps, as the upload would write it. */
  extras?: {
    sources: { title: string; kind: string; date: string | null }[];
    suggestions: SuggestionView[];
    proposals: ExtrasPlan["proposalViews"];
    firstPrinciplesParts: number;
    /** Left out or changed, in plain words. */
    notes: string[];
    /** Where the file disagrees with the company's own values. */
    conflicts: string[];
  };
  /** What the process still lacks for meaningful simulation numbers (issue #167), as the preview shows it. */
  gap: { input: GapInput; roleOf: Record<string, string>; gaps: SimulationGap[] };
}

/** The company's roles and people, as the ones a file can name. */
async function lookups(ctx: ToolContext, workspaceId: string): Promise<{ roles: Named[]; people: Named[] }> {
  const roles = check(await ctx.db.from("roles").select("id, name").eq("workspace_id", workspaceId).eq("active", true).order("name")) as Named[];
  const people = check(await ctx.db.from("people").select("id, name").eq("workspace_id", workspaceId).order("name")) as Named[];
  return { roles, people };
}

const byName = (list: readonly Named[], name: string): Named | undefined => list.find((x) => normalizeName(x.name) === normalizeName(name));

/** An existing process with this name (ignoring case and punctuation), as the import itself would refuse it. */
async function processNamed(ctx: ToolContext, workspaceId: string, name: string): Promise<Named | null> {
  const found = (await listProcesses(ctx.db, workspaceId)).find((p) => normalizeName(p.name) === normalizeName(name));
  return found ? { id: found.id, name: found.name } : null;
}

/** Everything the preview needs to know about the company to show what an upload would do. */
export async function previewProcessFile(ctx: ToolContext, workspaceId: string, file: ProcessFile, name?: string): Promise<ImportPreview> {
  const ws = await resolveWorkspace(ctx, workspaceId, []);
  const { data: canEdit } = await ctx.db.rpc("can_edit_workspace", { ws: ws.id });
  const { roles, people } = await lookups(ctx, ws.id);
  const matchedRoles: ImportPreview["matchedRoles"] = [];
  const unknownRoles: string[] = [];
  const seen = new Set<string>();
  for (const s of file.steps) {
    if (!s.role || seen.has(normalizeName(s.role))) continue;
    seen.add(normalizeName(s.role));
    const role = byName(roles, s.role);
    if (role) matchedRoles.push({ name: s.role, role });
    else unknownRoles.push(s.role);
  }
  const unknownPeople = [...new Set(file.steps.flatMap((s) => (s.person && !byName(people, s.person) ? [s.person] : [])))];
  let extras: ImportPreview["extras"];
  if (file.format === PROCESS_FILE_FORMAT_2) {
    const plan = await planFileExtras(ctx, ws, file, previewIds(file));
    extras = {
      sources: (file.sources ?? []).map((x) => ({ title: x.title, kind: x.kind, date: x.date ?? null })),
      suggestions: plan.suggestionViews,
      proposals: plan.proposalViews,
      firstPrinciplesParts: plan.firstPrinciplesParts,
      notes: plan.notes,
      conflicts: plan.conflicts,
    };
  }
  // Incoming volume: the company's lead sources (a servicing process has no recurrence until it is linked to a service).
  let volume: GapInput["volume"] = "missing";
  if (file.kind === "pipeline") {
    const company = await loadCompanyModel(ctx.db, ws);
    if (company.leadSources.some((l) => Number(l.volume_week) > 0)) volume = "known";
  }
  const suggestedVolume = !!file.company?.demand?.lead_sources.some((l) => (l.volume_per_week ?? 0) > 0);
  const gapInput = gapInputFromFile(file, { hasRole: (r) => !!byName(roles, r), volume, volumeSuggested: suggestedVolume });
  return {
    workspace: { id: ws.id, name: ws.name },
    roles,
    matchedRoles,
    unknownRoles,
    unknownPeople,
    nameTaken: await processNamed(ctx, ws.id, name?.trim() || file.name),
    canEdit: canEdit === true,
    ...(extras ? { extras } : {}),
    gap: { input: gapInput, roleOf: Object.fromEntries(file.steps.flatMap((x) => (x.role ? [[x.id, x.role]] : []))), gaps: findGaps(gapInput) },
  };
}

/** Made-up ids for a preview (nothing is written with them). */
function previewIds(file: ProcessFile): FileIds {
  return { processId: crypto.randomUUID(), sources: new Map((file.sources ?? []).map((x) => [x.id, crypto.randomUUID()])), steps: new Map(file.steps.map((x) => [x.id, crypto.randomUUID()])) };
}

export interface ImportFileOptions {
  workspaceId: string;
  /** Where the file came from, for the change log: its file name, or the link. */
  source: string;
  /** A different name for the process than the file gives. */
  name?: string;
  /**
   * For each role in the file the company doesn't have: the id of a company role to use instead, or null for none. A role
   * the company has is matched by name without being listed here; one that is missing from here is left blank. A Map, not an
   * object: a role can be called anything, "constructor" and "__proto__" included.
   */
  roleMap?: ReadonlyMap<string, string | null>;
}

export interface ImportFileResult {
  process: Named;
  revision_id: string;
  steps: number;
  links: number;
  /** Values the draft marks as assumptions or conflicts, for the person to confirm on the canvas. */
  to_confirm: number;
  /** Things worth a look: graph warnings, steps left without a role or person, a change-log entry that couldn't be written. */
  warnings: string[];
  /** A /2 file: what was written beside the process (sources, pending suggestions and proposals, first principles). */
  bundle?: ImportBundleResult;
}

/** The process_json for a checked file, with its roles and people resolved against the company's. */
/** The engine column each /2 evidence field is stored in. */
const COLUMN: Record<EvidenceField, "work_hours" | "wait_hours" | "rework_rate" | "current_wip" | "sla_hours"> = {
  hands_on_hours: "work_hours",
  wait_hours: "wait_hours",
  rework_rate: "rework_rate",
  waiting_now: "current_wip",
  sla_hours: "sla_hours",
};

/** What /2 adds to a step: ranges, rework target, tool, SLA, items waiting now, and each value's quotes or assumed reason. */
function v2StepFields(s: ProcessFile["steps"][number], ids: FileIds, assumptions: NonNullable<ProcessJson["assumptions"]>, source: string): Partial<ImportStepJson> {
  const out: Partial<ImportStepJson> = { id: ids.steps.get(s.id)! };
  const range = (r: { min: number; max: number } | undefined, mid: number | undefined, phase: "work" | "wait") => {
    if (!r) return;
    const mode = mid ?? (r.min + r.max) / 2;
    Object.assign(out, { [`${phase}_dist`]: "triangular", [`${phase}_params`]: { min: r.min, mode, max: r.max } });
  };
  range(s.hands_on_range, s.hands_on_hours, "work");
  range(s.wait_range, s.wait_hours, "wait");
  if (s.rework_to) out.rework_to = ids.steps.get(s.rework_to)!;
  if (s.tool) out.tool = s.tool;
  if (s.sla_hours !== undefined) out.sla_hours = s.sla_hours;
  if (s.waiting_now !== undefined) out.current_wip = s.waiting_now;
  const evidence: NonNullable<ImportStepJson["evidence"]> = [];
  const values: Record<EvidenceField, number | undefined> = { hands_on_hours: s.hands_on_hours, wait_hours: s.wait_hours, rework_rate: s.rework_rate, waiting_now: s.waiting_now, sla_hours: s.sla_hours };
  for (const field of Object.keys(COLUMN) as EvidenceField[]) {
    const cites = s.evidence?.[field] ?? [];
    for (const c of cites) {
      evidence.push({ field: COLUMN[field], source: ids.sources.get(c.source)!, speaker: c.speaker ?? null, quote: c.quote, timestamp: c.time ?? null, ...(c.value !== undefined ? { value: c.value } : {}) });
    }
    const reason = s.assumed?.[field];
    if (reason) assumptions.push({ step: s.name, field: COLUMN[field], reasoning: reason });
    else if (!cites.length && values[field] !== undefined && field !== "waiting_now" && field !== "sla_hours") {
      assumptions.push({ step: s.name, field: COLUMN[field], reasoning: `Stated in the uploaded file ${source} without a quote; not yet confirmed.` });
    }
  }
  if (evidence.length) out.evidence = evidence;
  return out;
}

/** A branch's quotes (or assumed reason) have no field of their own to live in, so they are written into the notes of the step it leaves. */
function addBranchEvidenceNotes(file: ProcessFile, steps: ImportStepJson[]): void {
  const titles = new Map((file.sources ?? []).map((x) => [x.id, x.title]));
  const names = new Map(file.steps.map((x) => [x.id, x.name]));
  for (const l of file.links) {
    if (!l.evidence?.length && !l.assumed) continue;
    const from = steps.find((x) => x.name === names.get(l.from));
    if (!from) continue;
    const odds = l.probability !== undefined ? ` (${Math.round(l.probability * 1000) / 10}%)` : "";
    const quotes = (l.evidence ?? []).map((c) => `“${c.quote}” (${[c.speaker, titles.get(c.source), c.time].filter(Boolean).join(", ")})`);
    const line = `Odds to ${names.get(l.to)}${l.label ? ` [${l.label}]` : ""}${odds}: ${[...quotes, ...(l.assumed ? [`assumed: ${l.assumed}`] : [])].join(" · ")}`;
    from.notes = [from.notes, line].filter(Boolean).join("\n").slice(0, 4000);
  }
}

export function fileToProcessJson(
  file: ProcessFile,
  opts: {
    name: string;
    source: string;
    roleFor: (role: string) => string | undefined;
    personFor: (person: string) => string | undefined;
    /** A /2 upload's ids (steps and sources), so evidence, proposals and first principles can point at them. */
    ids?: FileIds;
  },
): ProcessJson {
  const ids = file.format === PROCESS_FILE_FORMAT_2 ? opts.ids : undefined;
  const groupOf = new Map<string, string>();
  for (const g of file.groups) for (const id of g.steps) groupOf.set(id, g.name);
  const name = new Map(file.steps.map((s) => [s.id, s.name]));
  const assumptions: NonNullable<ProcessJson["assumptions"]> = [];
  const steps: ImportStepJson[] = file.steps.map((s) => {
    const role = s.role ? opts.roleFor(s.role) : undefined;
    const person = s.person ? opts.personFor(s.person) : undefined;
    // Every number the file gives is stated without a source we can cite, so it stays an assumption to confirm.
    const stated: [string, number | undefined][] = [["work_hours", s.hands_on_hours], ["wait_hours", s.wait_hours], ["rework_rate", s.rework_rate]];
    if (!ids) {
      for (const [field, value] of stated) {
        if (value !== undefined) assumptions.push({ step: s.name, field: field as "work_hours", reasoning: `Stated in the uploaded file ${opts.source}; not yet confirmed.` });
      }
    }
    const extra = ids ? v2StepFields(s, ids, assumptions, opts.source) : {};
    return {
      name: s.name,
      kind: KIND[s.type],
      ...(role ? { role } : {}),
      ...(person ? { person } : {}),
      ...(s.hands_on_hours !== undefined ? { work_hours: s.hands_on_hours } : {}),
      ...(s.wait_hours !== undefined ? { wait_hours: s.wait_hours } : {}),
      ...(s.rework_rate !== undefined ? { rework_rate: s.rework_rate } : {}),
      ...(s.notes ? { notes: s.notes } : {}),
      ...(s.x !== undefined && s.y !== undefined ? { x: s.x, y: s.y } : {}),
      ...(groupOf.has(s.id) ? { parent: groupOf.get(s.id)! } : {}),
      ...extra,
    };
  });
  if (ids) addBranchEvidenceNotes(file, steps);
  for (const g of file.groups) steps.push({ name: g.name, kind: "group" });
  const edges: ImportEdgeJson[] = file.links.map((l) => ({
    from: name.get(l.from)!,
    to: name.get(l.to)!,
    ...(l.probability !== undefined ? { probability: l.probability } : {}),
    ...(l.label ? { label: l.label } : {}),
  }));
  return {
    name: opts.name,
    kind: file.kind,
    ...(file.entity_name ? { entity_name: file.entity_name } : {}),
    ...(file.description ? { description: file.description } : {}),
    steps,
    edges,
    ...(assumptions.length ? { assumptions } : {}),
  };
}

/**
 * Create a new process, with a draft, from a checked file. Acts as the signed-in user (RLS), so it needs an editor. Writes
 * nothing if any of it is invalid, never publishes, and creates no role, person, client or other company data.
 */
export async function importProcessFile(ctx: ToolContext, file: ProcessFile, opts: ImportFileOptions): Promise<ImportFileResult> {
  const ws = await resolveWorkspace(ctx, opts.workspaceId, []);
  const name = (opts.name ?? file.name).trim();
  if (!name) throw new ToolError("invalid_input", "Give the process a name.");
  const clash = await processNamed(ctx, ws.id, name);
  if (clash) throw new ToolError("name_taken", `You already have a process called '${clash.name}'. Give this one a different name.`, [clash]);

  const { roles, people } = await lookups(ctx, ws.id);
  const warnings: string[] = [];
  const mapped = new Map<string, string | null>();
  for (const [from, to] of opts.roleMap ?? []) {
    if (to !== null && !roles.some((r) => r.id === to)) throw new ToolError("invalid_input", `Role '${from}' was matched to a role that isn't one of this company's.`);
    mapped.set(normalizeName(from), to);
  }
  let blankRoles = 0;
  const roleFor = (role: string): string | undefined => {
    const id = byName(roles, role)?.id ?? mapped.get(normalizeName(role)) ?? undefined;
    if (!id) blankRoles++;
    return id;
  };
  const unknownPeople = new Set<string>();
  const personFor = (person: string): string | undefined => {
    const found = byName(people, person);
    if (!found) unknownPeople.add(person);
    return found?.id;
  };
  // A /2 file: ids are chosen here so evidence, proposals and first principles can point at the sources, steps and process that
  // are written together with them (`import_process_bundle`, one transaction).
  const v2 = file.format === PROCESS_FILE_FORMAT_2;
  const ids: FileIds | undefined = v2 ? previewIds(file) : undefined;
  const json = fileToProcessJson(file, { name, source: `'${opts.source}'`, roleFor, personFor, ...(ids ? { ids } : {}) });
  if (blankRoles) warnings.push(`${blankRoles === 1 ? "One step has" : `${blankRoles} steps have`} no role: the file's role isn't one of your roles and wasn't mapped to one.`);
  if (unknownPeople.size) warnings.push(`${[...unknownPeople].map((p) => `'${p}'`).join(", ")} ${unknownPeople.size === 1 ? "isn't" : "aren't"} in your company, so ${unknownPeople.size === 1 ? "that step was" : "those steps were"} left unassigned.`);

  let bundle: ImportBundle | undefined;
  if (ids) {
    const plan = await planFileExtras(ctx, ws, file, ids);
    warnings.push(...plan.notes, ...plan.conflicts);
    bundle = {
      processId: ids.processId,
      importSource: opts.source,
      sources: plan.sources,
      extras: {
        ...(plan.firstPrinciples ? { first_principles: plan.firstPrinciples as never } : {}),
        suggestions: plan.suggestions as never,
        proposals: plan.proposals as never,
      },
    };
  }
  const out = await importNewProcess(ctx, ws.id, json, [], bundle);
  warnings.push(...out.warnings);

  // The change log: "Imported from <file or link>". A failure here doesn't undo a process that was made.
  const { error } = await ctx.db.rpc("log_process_import", { target_process: out.process.id, import_source: opts.source });
  if (error) warnings.push("The process was made, but the activity log entry for the import couldn't be written.");

  return {
    process: { id: out.process.id, name: out.process.name },
    revision_id: out.draft.revision_id,
    steps: file.steps.length,
    links: file.links.length,
    to_confirm: out.checklist.length,
    warnings,
    ...(out.bundle ? { bundle: out.bundle } : {}),
  };
}
