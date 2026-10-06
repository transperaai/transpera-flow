// Checking and planning the restore of a workspace backup (issue #39, B10 part 2a). Pure: no I/O, so the browser previews
// with it and the server re-checks with it. Nothing here writes; the restore itself (an RPC) is slice 2b.
//
// `checkWorkspaceBundle` says whether a parsed file is a `transpera-workspace/1` backup it can restore, with plain-sentence
// errors, warnings and a summary. `planWorkspaceImport` turns a checked bundle into the plan the restore function takes: one
// draft per process (its live version, or its draft when never published), the company model, issues, sources, scenarios,
// blocks and pending suggestions, each row cut down to the columns the restore accepts, with every id replaced by a
// placeholder that keeps the order of the old ids (the engine sorts by id, so a restore must not reshuffle them).
//
// Not restored (decisions 1 to 4 on #39): history and older versions, the company map (the new workspace keeps its own),
// solutions, decided suggestions, detections, issue history, source files and everything about who made what.

import { ENGINE_VERSION } from "@transpera-flow/engine";
import type { Database } from "./database.types";
import type { WorkspaceSettings } from "./types";
import { WORKSPACE_BUNDLE_FORMAT, type Row, type WorkspaceBundle } from "./workspace-bundle";

export const PLAN_FORMAT = "transpera-workspace-import/1";

/** What a restore will take. These are starting values; the 2b performance test is the arbiter. */
export const WORKSPACE_IMPORT_LIMITS = {
  /** The file as read, and decompressed on the server. */
  backupBytes: 25 * 1024 * 1024,
  /** The request body, gzipped (Vercel's limit is 4.5 MB). */
  compressedBytes: 4 * 1024 * 1024,
  /** The serialised plan. */
  planBytes: 10 * 1024 * 1024,
  processes: 200,
  steps: 2000,
  edges: 4000,
  sources: 300,
  sourceChars: 5_000_000,
  issues: 2000,
  people: 1000,
  clients: 5000,
  scenarios: 500,
  blocks: 500,
  suggestions: 1000,
  proposals: 500,
} as const;
export const MAX_BACKUP_BYTES = WORKSPACE_IMPORT_LIMITS.backupBytes;
export const MAX_COMPRESSED_BYTES = WORKSPACE_IMPORT_LIMITS.compressedBytes;

type Tables = Database["public"]["Tables"];
const cols = <T extends keyof Tables>(_table: T, ...c: (keyof Tables[T]["Row"] & string)[]): readonly string[] => c;

/**
 * The columns the restore accepts for each plan section (everything else is dropped). `workspace_id`, `created_by`,
 * `updated_at` and every `*_by` are never sent. `created_at` is carried where loaders order by it, and not on steps or edges
 * (the database tells an import's own edges from later edits by `created_at < now()`). Extras the plan adds beyond table
 * columns: `processes` also has archived, layout, steps, edges and first_principles; `issues` also has links, owner_ids and
 * source_ids; `market_schedule` may carry `condition_preset` in place of `condition_id`.
 */
export const IMPORT_COLUMNS = {
  roles: cols("roles", "id", "name", "color", "default_cost_rate", "headcount", "ongoing_hours_per_client_week", "active", "provenance", "created_at"),
  people: cols("people", "id", "name", "active", "capacity_hours_week", "cost_rate", "end_date", "fte", "notes", "start_date", "provenance", "created_at"),
  person_roles: cols("person_roles", "person_id", "role_id", "created_at"),
  person_leave: cols("person_leave", "id", "person_id", "start_date", "end_date", "note", "created_at"),
  lead_sources: cols("lead_sources", "id", "name", "conversion_to_qualified", "volume_week", "provenance", "created_at"),
  seasonality: cols("seasonality", "id", "month", "multiplier", "provenance", "created_at"),
  demand_settings: cols("demand_settings", "growth_monthly", "provenance", "created_at"),
  churn_drivers: cols("churn_drivers", "id", "name", "description", "driver", "enabled", "example", "month", "value", "weight", "provenance", "created_at"),
  market_conditions: cols("market_conditions", "id", "name", "churn", "conv", "cycle", "hire", "leads", "pay", "price", "created_at"),
  market_schedule: cols("market_schedule", "id", "condition_id", "from_month", "to_month", "created_at"),
  lever_settings: cols("lever_settings", "hidden", "created_at"),
  analysis_rules: cols("analysis_rules", "settings", "created_at"),
  clients: cols("clients", "id", "name", "active", "health", "mrr", "notes", "start_date", "provenance", "created_at"),
  sources: cols("sources", "id", "kind", "title", "body", "recorded_at", "speakers", "created_at"),
  processes: cols("processes", "id", "parent_process_id", "name", "kind", "entity_name", "description"),
  steps: cols(
    "steps", "id", "assumption", "child_process_id", "conflict", "cost_override", "current_wip", "dropoff_benchmark", "expected_wait_hours", "entry_step_id",
    "kind", "lost_per_day_waiting", "name", "notes", "outcome", "parent_step_id", "person_id", "provenance", "replaced_by", "rework_rate", "rework_to_step_id",
    "role_id", "sla_hours", "target_cycle_hours", "tool", "wait_dist", "wait_hours", "wait_params", "work_dist", "work_hours", "work_params", "x", "y",
  ),
  edges: cols("edges", "id", "condition_tag", "from_step_id", "label", "probability", "to_step_id"),
  first_principles: cols(
    "first_principles", "deletes", "improvements", "job_done", "job_progress", "job_situation", "job_who", "measures", "requirements", "root_cause", "statements",
    "why_chain", "why_problem",
  ),
  scenarios: cols("scenarios", "id", "parent_scenario_id", "name", "description", "patch", "created_at"),
  blocks: cols("blocks", "id", "name", "description", "type", "steps", "created_at"),
  issues: cols(
    "issues", "id", "client_id", "created_at", "detected_key", "evidence", "evidence_metrics", "evidence_sources", "owner_person_id", "person_id", "process_id",
    "resolution", "resolution_note", "resolved_how", "role_id", "scenario_id", "severity", "source", "status", "step_id", "target_goal", "target_measure",
    "target_now", "title", "type",
  ),
  services: cols(
    "services", "id", "name", "active", "churn_health_sensitivity", "churn_monthly_base", "entry_process_id", "fallback_ongoing_load", "margin", "mix_share",
    "path_tags", "price", "pricing_model", "tenure_months", "provenance", "created_at",
  ),
  service_servicing: cols("service_servicing", "id", "process_id", "service_id", "recurrence", "sla_hours", "provenance", "created_at"),
  client_groups: cols("client_groups", "id", "service_id", "client_count", "churn_monthly", "fee", "starting_health", "stay_months", "provenance", "created_at"),
  client_services: cols("client_services", "client_id", "service_id", "start_date", "created_at"),
  client_assignments: cols("client_assignments", "client_id", "role_id", "person_id", "created_at"),
  person_skills: cols("person_skills", "person_id", "step_id", "efficiency", "provenance", "created_at"),
  source_links: cols("source_links", "id", "insight_key", "issue_id", "kind", "process_id", "source_id", "step_id"),
  suggestions: cols("suggestions", "id", "target_table", "target_id", "patch", "evidence", "note", "created_at"),
  proposals: cols("suggestion_proposals", "id", "kind", "title", "detail", "payload", "evidence", "note", "issue_id", "created_at"),
} as const;

/** The keys of `WorkspaceSettings`, which the type checker keeps complete. */
const SETTING_KEYS: Record<keyof WorkspaceSettings, true> = {
  hours_per_week: true,
  horizon_weeks: true,
  currency: true,
  leads_per_week: true,
  active_clients: true,
  churn_monthly: true,
  retainer: true,
  availability_floor: true,
  overtime_cap: true,
  health_recover: true,
  health_late_penalty: true,
  health_missed_penalty: true,
  health_initial: true,
  client_health_benchmark_low: true,
  client_health_benchmark_high: true,
};
export const WORKSPACE_SETTING_KEYS = Object.keys(SETTING_KEYS) as readonly (keyof WorkspaceSettings)[];

export interface SummaryLine {
  key: string;
  label: string;
  count: number;
}

export interface ImportSummary {
  /** "Will be restored". */
  restored: SummaryLine[];
  /** "Stays in the file". */
  leftOut: SummaryLine[];
  /** Whether the workspace settings would be written (an owner or agency admin), suggested (an editor), or aren't in the file. */
  settings: "applied" | "suggested" | "none";
  /** The numbers the limits are checked against. */
  measures: { processes: number; steps: number; edges: number; sources: number; sourceChars: number; issues: number; people: number; clients: number; scenarios: number; blocks: number; suggestions: number; proposals: number; planBytes: number };
}

export interface BundleCheck {
  ok: boolean;
  /** Plain sentences; any error blocks the restore. */
  errors: string[];
  /** Shown; they don't block. */
  warnings: string[];
  /** What would be restored and what is left out, with counts (empty when the file can't be read at all). */
  summary: ImportSummary;
}

/** One process of the plan: its live version (or its draft, if never published), as a draft to open. */
export interface PlanProcess {
  id: string;
  parent_process_id: string | null;
  name: unknown;
  kind: unknown;
  entity_name: unknown;
  description: unknown;
  archived: boolean;
  layout: unknown;
  steps: Row[];
  edges: Row[];
  first_principles: Row | null;
}

/** The restore function's `p_plan`: placeholders only (`00000000-0000-4000-8000-` and a rank). */
export interface ImportPlan {
  format: typeof PLAN_FORMAT;
  settings: Record<string, unknown> | null;
  roles: Row[];
  people: Row[];
  person_roles: Row[];
  person_leave: Row[];
  lead_sources: Row[];
  seasonality: Row[];
  demand_settings: Row | null;
  churn_drivers: Row[];
  market_conditions: Row[];
  /** Rows carry `condition_id` (a custom condition) or `condition_preset` (the key of a preset the new workspace already has). */
  market_schedule: Row[];
  lever_settings: Row | null;
  analysis_rules: Row | null;
  clients: Row[];
  sources: Row[];
  processes: PlanProcess[];
  scenarios: Row[];
  blocks: Row[];
  issues: Row[];
  services: Row[];
  service_servicing: Row[];
  client_groups: Row[];
  client_services: Row[];
  client_assignments: Row[];
  person_skills: Row[];
  source_links: Row[];
  suggestions: Row[];
  proposals: Row[];
}

export const PLACEHOLDER_PREFIX = "00000000-0000-4000-8000-";
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;

const NOT_A_BACKUP = "This isn't a Transpera Flow workspace backup. Choose the .json file that Export → JSON backup made.";
const num = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const isObj = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
/** Lower-case text of a string; anything else (an object with its own `toString`, say) gives "", which no id equals. */
const lc = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : "");
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const idOf = (r: Row): string | null => (typeof r.id === "string" ? lc(r.id) : null);
const pick = (row: Row, columns: readonly string[]): Row => {
  const out: Row = {};
  for (const c of columns) if (row[c] !== undefined) out[c] = row[c];
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
// The checker

const SECTION_ARRAYS = ["processes", "scenarios", "solutions", "solution_issues", "blocks", "issues", "sources", "source_links", "suggestions", "suggestion_proposals"] as const;
/** Tables whose rows have an `id` column (company-model tables without one are keyed otherwise). */
const NO_ID_TABLES = new Set(["person_roles", "person_skills", "client_services", "client_assignments", "demand_settings", "lever_settings", "analysis_rules", "solution_issues"]);

const things = (key: string) => key.replace(/^company_model\./, "").replace(/_/g, " ");

function expectedCounts(b: WorkspaceBundle): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, rows] of Object.entries(b.company_model)) out[`company_model.${k}`] = rows.length;
  const versions = b.processes.flatMap((p) => rowsOf(p.versions));
  out.processes = b.processes.length;
  out.process_versions = versions.length;
  out.steps = versions.reduce((n, v) => n + rowsOf(v.steps).length, 0);
  out.edges = versions.reduce((n, v) => n + rowsOf(v.edges).length, 0);
  for (const k of ["scenarios", "solutions", "solution_issues", "blocks", "issues", "sources", "source_links", "suggestions", "suggestion_proposals"] as const) out[k] = b[k].length;
  return out;
}

/** The first thing wrong with the shape of the file, or null. */
function shapeProblem(v: Row): string | null {
  const ws = v.workspace;
  if (!isObj(ws) || typeof ws.id !== "string" || !UUID.test(ws.id)) return "the workspace has no id";
  const cm = v.company_model;
  if (!isObj(cm)) return "the company model is missing";
  for (const [k, rows] of Object.entries(cm)) if (!Array.isArray(rows)) return `company_model.${k} isn't a list`;
  for (const k of SECTION_ARRAYS) if (!Array.isArray(v[k])) return `${k} isn't a list`;
  if (!isObj(v.counts)) return "the counts are missing";

  const checkTable = (name: string, rows: unknown[], needId: boolean): string | null => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (!isObj(r)) return `a row of ${name} isn't an object`;
      if (r.id === undefined && !needId) continue;
      if (typeof r.id !== "string" || !UUID.test(r.id)) return `a row of ${name} has no valid id`;
      const id = lc(r.id);
      if (seen.has(id)) return `an id repeats in ${name}`;
      seen.add(id);
    }
    return null;
  };
  for (const [k, rows] of Object.entries(cm)) {
    const p = checkTable(`company_model.${k}`, rows as unknown[], !NO_ID_TABLES.has(k));
    if (p) return p;
  }
  for (const k of SECTION_ARRAYS) {
    const p = checkTable(k, v[k] as unknown[], !NO_ID_TABLES.has(k));
    if (p) return p;
  }
  const versionIds = new Set<string>();
  const parents = new Map<string, string | null>();
  for (const p of v.processes as Row[]) {
    if (!Array.isArray(p.versions)) return "a process has no list of versions";
    parents.set(lc(p.id), typeof p.parent_process_id === "string" ? lc(p.parent_process_id) : null);
    for (const ver of p.versions as unknown[]) {
      if (!isObj(ver)) return "a version isn't an object";
      if (typeof ver.id !== "string" || !UUID.test(ver.id)) return "a version has no valid id";
      if (versionIds.has(lc(ver.id))) return "an id repeats in process versions";
      versionIds.add(lc(ver.id));
      if (!Array.isArray(ver.steps) || !Array.isArray(ver.edges)) return "a version has no list of steps or edges";
      const s = checkTable("the steps of a version", ver.steps, true) ?? checkTable("the edges of a version", ver.edges, true);
      if (s) return s;
      if (ver.first_principles != null && !isObj(ver.first_principles)) return "a version's first principles aren't an object";
    }
  }
  // Loops in the nesting: one walk with colours (0 new, 1 on the current path, 2 done), so a deep chain costs one pass.
  const colour = new Map<string, 1 | 2>();
  for (const start of parents.keys()) {
    if (colour.has(start)) continue;
    const path: string[] = [];
    let at: string | null | undefined = start;
    while (at && !colour.has(at)) {
      colour.set(at, 1);
      path.push(at);
      at = parents.get(at);
    }
    if (at && colour.get(at) === 1) return "processes are nested in a loop";
    for (const x of path) colour.set(x, 2);
  }
  for (const i of v.issues as Row[]) if (i.events !== undefined && !Array.isArray(i.events)) return "an issue's history isn't a list";
  return null;
}

/** Every row that names a workspace, in the whole bundle. */
function* allRows(b: WorkspaceBundle): Generator<Row> {
  for (const rows of Object.values(b.company_model)) yield* rowsOf(rows);
  for (const p of b.processes) {
    yield p;
    for (const v of rowsOf(p.versions)) {
      yield v;
      yield* rowsOf(v.steps);
      yield* rowsOf(v.edges);
      if (isObj(v.first_principles)) yield v.first_principles;
    }
  }
  for (const k of ["scenarios", "solutions", "solution_issues", "blocks", "issues", "sources", "source_links", "suggestions", "suggestion_proposals"] as const) yield* b[k];
  for (const i of b.issues) yield* rowsOf(i.events);
}

const L_ = WORKSPACE_IMPORT_LIMITS;

export function checkWorkspaceBundle(value: unknown): BundleCheck {
  const empty: ImportSummary = {
    restored: [],
    leftOut: [],
    settings: "none",
    measures: { processes: 0, steps: 0, edges: 0, sources: 0, sourceChars: 0, issues: 0, people: 0, clients: 0, scenarios: 0, blocks: 0, suggestions: 0, proposals: 0, planBytes: 0 },
  };
  const stop = (message: string): BundleCheck => ({ ok: false, errors: [message], warnings: [], summary: empty });

  if (!isObj(value)) return stop(NOT_A_BACKUP);
  const format = value.format;
  if (format === "transpera-process/1" || format === "transpera-process/2") return stop("This is a process file, not a workspace backup. Upload it from Processes → Upload process.");
  if (typeof format === "string" && format.startsWith("transpera-workspace/") && format !== WORKSPACE_BUNDLE_FORMAT) {
    return stop(`This backup is in a format this version of Transpera Flow can't read (${format}). It may have been made by a newer version.`);
  }
  if (format !== WORKSPACE_BUNDLE_FORMAT) return stop(NOT_A_BACKUP);

  // Before any walk over the rows: a list far past what a restore takes is refused at once. The cap is twice the limit, because
  // the lists also hold what isn't restored (detections, the company map, processes with no version).
  const WORK_CAP: [string, number, string][] = [
    ["processes", L_.processes, "processes"],
    ["issues", L_.issues, "issues"],
    ["sources", L_.sources, "sources"],
    ["scenarios", L_.scenarios, "scenarios"],
    ["blocks", L_.blocks, "blocks"],
    ["suggestions", L_.suggestions, "suggestions"],
    ["suggestion_proposals", L_.proposals, "proposals"],
  ];
  for (const [k, max, what] of WORK_CAP) {
    const list = value[k];
    if (Array.isArray(list) && list.length > max * 2) return stop(`The backup has ${num(list.length)} ${what}; a restore takes at most ${num(max)}.`);
  }
  const model = value.company_model;
  if (isObj(model)) {
    for (const [k, max] of [["people", L_.people], ["clients", L_.clients]] as const) {
      const list = model[k];
      if (Array.isArray(list) && list.length > max * 2) return stop(`The backup has ${num(list.length)} ${k}; a restore takes at most ${num(max)}.`);
    }
  }

  const problem = shapeProblem(value);
  if (problem) return stop(`The backup is damaged: ${problem}, so nothing was restored.`);
  const bundle = value as unknown as WorkspaceBundle;
  const errors: string[] = [];
  const warnings: string[] = [];

  const wsId = lc(bundle.workspace.id);
  for (const r of allRows(bundle)) {
    if (r.workspace_id !== undefined && (typeof r.workspace_id !== "string" || lc(r.workspace_id) !== wsId)) {
      errors.push("The backup mixes rows from more than one workspace.");
      break;
    }
  }

  const expected = expectedCounts(bundle);
  for (const [key, held] of Object.entries(expected)) {
    const said = (bundle.counts as Record<string, unknown>)[key];
    if (said !== held) errors.push(`The backup looks cut short or edited: it says ${typeof said === "number" ? num(said) : 0} ${things(key)} but holds ${num(held)}.`);
  }

  const companies = bundle.processes.filter((p) => p.is_company === true).length;
  if (companies === 0) warnings.push("No company map in the backup; the new one is laid out from the processes.");
  if (companies > 1) errors.push("The backup is damaged: it holds more than one company map, so nothing was restored.");

  let planned: ReturnType<typeof planWorkspaceImport>;
  try {
    planned = planWorkspaceImport(bundle, { canManage: true });
  } catch {
    return { ok: false, errors: [...errors, "The backup is damaged: its rows don't fit together, so nothing was restored."], warnings, summary: empty };
  }
  const { summary } = planned;
  const m = summary.measures;
  const L = WORKSPACE_IMPORT_LIMITS;
  const over = (n: number, max: number, what: string, suffix = "") => {
    if (n > max) errors.push(`The backup has ${num(n)} ${what}${suffix}; a restore takes at most ${num(max)}.`);
  };
  over(m.processes, L.processes, "processes");
  over(m.steps, L.steps, "steps", " in the versions it would restore");
  over(m.edges, L.edges, "edges", " in the versions it would restore");
  over(m.sources, L.sources, "sources");
  over(m.sourceChars, L.sourceChars, "characters of source text");
  over(m.issues, L.issues, "issues");
  over(m.people, L.people, "people");
  over(m.clients, L.clients, "clients");
  over(m.scenarios, L.scenarios, "scenarios");
  over(m.blocks, L.blocks, "blocks");
  over(m.suggestions, L.suggestions, "pending suggestions");
  over(m.proposals, L.proposals, "pending proposals");
  if (m.planBytes > L.planBytes) errors.push(`The backup is too big to restore in one go: it comes to ${num(m.planBytes)} bytes once prepared, and a restore takes at most ${num(L.planBytes)}.`);

  if (bundle.engine_version !== ENGINE_VERSION) warnings.push(`This backup was made with engine ${typeof bundle.engine_version === "string" ? bundle.engine_version : "unknown"}; this is ${ENGINE_VERSION}. Numbers may differ slightly.`);
  if (bundle.scope === "published") warnings.push("This backup was made by a viewer: it has no drafts and no pending suggestions.");
  for (const line of summary.leftOut) if (line.count > 0 && !QUIET_LEFT_OUT.has(line.key)) warnings.push(`Stays in the file: ${num(line.count)} ${line.label}.`);
  warnings.push(...planned.warnings);

  return { ok: errors.length === 0, errors, warnings, summary };
}

/** Left-out lines that are the design, not a loss worth a warning. */
const QUIET_LEFT_OUT = new Set(["older_versions", "company_map"]);

// ---------------------------------------------------------------------------------------------------------------------
// The planner

type Mode = "null" | "drop" | "require";
export interface Ref {
  col: string;
  to: string;
  mode: Mode;
}
const R = (col: string, to: string, mode: Mode): Ref => ({ col, to, mode });

/** The id and reference columns of each flat plan section: after remapping, every one holds a placeholder or null. */
export const IMPORT_REFS: Record<string, Ref[]> = {
  person_roles: [R("person_id", "people", "require"), R("role_id", "roles", "require")],
  person_leave: [R("person_id", "people", "require")],
  services: [R("entry_process_id", "processes", "null")],
  service_servicing: [R("service_id", "services", "require"), R("process_id", "processes", "require")],
  client_groups: [R("service_id", "services", "require")],
  client_services: [R("client_id", "clients", "require"), R("service_id", "services", "require")],
  client_assignments: [R("client_id", "clients", "require"), R("role_id", "roles", "require"), R("person_id", "people", "require")],
  person_skills: [R("person_id", "people", "require"), R("step_id", "steps", "require")],
  scenarios: [R("parent_scenario_id", "scenarios", "null")],
  issues: [
    R("client_id", "clients", "null"), R("owner_person_id", "people", "null"), R("person_id", "people", "null"), R("process_id", "processes", "null"),
    R("role_id", "roles", "null"), R("scenario_id", "scenarios", "null"), R("step_id", "steps", "null"),
  ],
  source_links: [R("source_id", "sources", "require"), R("issue_id", "issues", "drop"), R("process_id", "processes", "drop"), R("step_id", "steps", "drop")],
  proposals: [R("issue_id", "issues", "drop")],
};
export const IMPORT_STEP_REFS = [R("parent_step_id", "version", "null"), R("entry_step_id", "version", "null"), R("rework_to_step_id", "version", "null"), R("person_id", "people", "null"), R("role_id", "roles", "null"), R("child_process_id", "processes", "null")];

const LABELS: Record<string, string> = {
  roles: "roles", people: "people", person_roles: "role assignments", person_leave: "leave entries", lead_sources: "lead sources", seasonality: "seasonality months",
  churn_drivers: "churn drivers", market_conditions: "market conditions", market_schedule: "market schedule rows", clients: "clients", sources: "sources",
  scenarios: "scenarios", blocks: "blocks", issues: "issues", services: "services", service_servicing: "servicing rules", client_groups: "client groups",
  client_services: "client services", client_assignments: "client assignments", person_skills: "skills", source_links: "source links", suggestions: "pending suggestions",
  proposals: "pending proposals", steps: "steps", edges: "edges", processes: "processes",
};

/** The rows with each reference checked against what is restored: a row whose required reference is missing is dropped; an optional one is cleared. */
function resolveRefs(section: string, rows: Row[], sets: Record<string, Set<string>>, refs: Ref[], note: (section: string, kind: "dropped" | "cleared") => void): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    let keep = true;
    const copy: Row = { ...row };
    for (const ref of refs) {
      const v = copy[ref.col];
      if (v == null) {
        if (ref.mode === "require") keep = false;
        continue;
      }
      if (!sets[ref.to]!.has(lc(v))) {
        if (ref.mode === "null") {
          copy[ref.col] = null;
          note(section, "cleared");
        } else {
          keep = false;
        }
      }
    }
    if (keep) out.push(copy);
    else note(section, "dropped");
  }
  return out;
}

const byCreated = (a: Row, b: Row) => text(a.created_at).localeCompare(text(b.created_at)) || text(a.id).localeCompare(text(b.id));

/** Parents before children, otherwise in the order given. One pass: each row places its unplaced ancestors first (a loop, which the checker refuses, is cut where it closes). */
function parentsFirst<T extends Row>(rows: T[], parentKey: string): T[] {
  const byId = new Map<string, T>();
  for (const r of rows) byId.set(lc(r.id), r);
  const placed = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const chain: T[] = [];
    const climbing = new Set<string>();
    let at: T | undefined = r;
    while (at && !placed.has(lc(at.id)) && !climbing.has(lc(at.id))) {
      climbing.add(lc(at.id));
      chain.push(at);
      at = at[parentKey] == null ? undefined : byId.get(lc(at[parentKey]));
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      placed.add(lc(chain[i]!.id));
      out.push(chain[i]!);
    }
  }
  return out;
}

export function planWorkspaceImport(
  bundle: WorkspaceBundle,
  options: { canManage: boolean },
): { plan: ImportPlan; summary: ImportSummary; placeholderOf: Map<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const dropped = new Map<string, { dropped: number; cleared: number }>();
  const note = (section: string, kind: "dropped" | "cleared") => {
    const e = dropped.get(section) ?? { dropped: 0, cleared: 0 };
    e[kind]++;
    dropped.set(section, e);
  };
  const cm = bundle.company_model;
  const company = (k: string): Row[] => rowsOf(cm[k]);

  // Which process and version of each is restored.
  const chosen: { process: Row; version: Row }[] = [];
  let unpublishedDrafts = 0;
  let olderVersions = 0;
  let companyVersions = 0;
  let noVersion = 0;
  for (const p of bundle.processes) {
    const versions = rowsOf(p.versions);
    if (p.is_company === true) {
      companyVersions += versions.length;
      continue;
    }
    const live = versions.find((v) => v.live === true);
    const draft = versions.find((v) => v.draft === true);
    const version = live ?? draft;
    if (!version) {
      noVersion++;
      continue;
    }
    if (live && draft && draft !== live) unpublishedDrafts++;
    olderVersions += versions.length - 1 - (live && draft && draft !== live ? 1 : 0);
    chosen.push({ process: p, version });
  }
  if (noVersion) warnings.push(`${num(noVersion)} processes have no version in the backup and were left out.`);

  const sets: Record<string, Set<string>> = {
    processes: new Set(chosen.map((c) => lc(c.process.id))),
    roles: new Set(company("roles").map((r) => lc(r.id))),
    people: new Set(company("people").map((r) => lc(r.id))),
    services: new Set(company("services").map((r) => lc(r.id))),
    clients: new Set(company("clients").map((r) => lc(r.id))),
    sources: new Set(bundle.sources.map((r) => lc(r.id))),
    scenarios: new Set(bundle.scenarios.map((r) => lc(r.id))),
    steps: new Set(),
    issues: new Set(),
    version: new Set(),
  };

  // Processes, with the steps and edges of the restored version.
  const stepProcess = new Map<string, string>();
  const pre = chosen.map(({ process, version }) => {
    const stepRows = rowsOf(version.steps);
    for (const s of stepRows) {
      sets.steps!.add(lc(s.id));
      stepProcess.set(lc(s.id), lc(process.id));
    }
    return { process, version, stepRows };
  });
  const processRows: Row[] = pre.map(({ process, version, stepRows }) => {
    sets.version = new Set(stepRows.map((s) => lc(s.id)));
    const steps = resolveRefs("steps", stepRows, sets, IMPORT_STEP_REFS, note).map((s) => pick(s, IMPORT_COLUMNS.steps));
    const edges = rowsOf(version.edges).filter((e) => sets.version!.has(lc(e.from_step_id)) && sets.version!.has(lc(e.to_step_id)));
    for (let i = rowsOf(version.edges).length - edges.length; i > 0; i--) note("edges", "dropped");
    const parent = process.parent_process_id == null ? null : lc(process.parent_process_id);
    if (parent !== null && !sets.processes!.has(parent)) note("processes", "cleared");
    return {
      ...pick(process, IMPORT_COLUMNS.processes),
      parent_process_id: parent !== null && sets.processes!.has(parent) ? process.parent_process_id : null,
      archived: process.archived_at != null,
      layout: version.layout ?? {},
      steps,
      edges: edges.map((e) => pick(e, IMPORT_COLUMNS.edges)),
      first_principles: isObj(version.first_principles) ? pick(version.first_principles, IMPORT_COLUMNS.first_principles) : null,
    };
  });
  const processes = parentsFirst(processRows, "parent_process_id") as unknown as PlanProcess[];
  const stepCount = processes.reduce((n, p) => n + p.steps.length, 0);
  const edgeCount = processes.reduce((n, p) => n + p.edges.length, 0);

  // The company model.
  const flat = (section: keyof typeof IMPORT_COLUMNS, rows: Row[], refs: Ref[] = []): Row[] =>
    resolveRefs(section, rows, sets, refs, note).map((r) => pick(r, IMPORT_COLUMNS[section]));
  const one = (section: "demand_settings" | "lever_settings" | "analysis_rules"): Row | null => {
    const r = company(section)[0];
    return r ? pick(r, IMPORT_COLUMNS[section]) : null;
  };
  const customConditions = company("market_conditions").filter((c) => c.preset == null);
  const presetKey = new Map(company("market_conditions").filter((c) => c.preset != null).map((c) => [lc(c.id), text(c.preset)]));
  const customIds = new Set(customConditions.map((c) => lc(c.id)));
  const schedule: Row[] = [];
  for (const row of company("market_schedule")) {
    const key = presetKey.get(lc(row.condition_id));
    if (key) schedule.push({ ...pick(row, IMPORT_COLUMNS.market_schedule.filter((c) => c !== "condition_id")), condition_preset: key });
    else if (customIds.has(lc(row.condition_id))) schedule.push(pick(row, IMPORT_COLUMNS.market_schedule));
    else note("market_schedule", "dropped");
  }

  // Sources, then issues (sorted by number, nulls last), with their links.
  const sources = bundle.sources.map((s) => pick(s, IMPORT_COLUMNS.sources)).sort(byCreated);
  const fileOriginals = bundle.sources.filter((s) => s.file_path != null || s.file_name != null).length;
  const detections = bundle.issues.filter((i) => i.source === "detected").length;
  const keptIssues = bundle.issues.filter((i) => i.source !== "detected");
  keptIssues.sort((a, b) => {
    const an = typeof a.number === "number" ? a.number : Infinity;
    const bn = typeof b.number === "number" ? b.number : Infinity;
    return an === bn ? byCreated(a, b) : an < bn ? -1 : 1;
  });
  for (const i of keptIssues) sets.issues!.add(lc(i.id));
  const issueRows = resolveRefs("issues", keptIssues, sets, IMPORT_REFS.issues!, note).map((i) => {
    const links = rowsOf(i.links)
      .filter((l) => l.process_id != null && sets.processes!.has(lc(l.process_id)) && (l.step_id == null || stepProcess.get(lc(l.step_id)) === lc(l.process_id)))
      .map((l) => ({ process_id: l.process_id, step_id: l.step_id ?? null }));
    if (links.length < rowsOf(i.links).length) note("issues", "cleared");
    const owners = (Array.isArray(i.owner_ids) ? i.owner_ids : []).filter((x) => sets.people!.has(lc(x)));
    const srcs = (Array.isArray(i.source_ids) ? i.source_ids : []).filter((x) => sets.sources!.has(lc(x)));
    return { ...pick(i, IMPORT_COLUMNS.issues), links, owner_ids: owners, source_ids: srcs };
  });
  const issueEvents = bundle.issues.reduce((n, i) => n + rowsOf(i.events).length, 0);

  let solutionLinks = 0;
  let stepLinksGone = 0;
  const linkRows = bundle.source_links.filter((l) => {
    if (l.kind === "solution") {
      solutionLinks++;
      return false;
    }
    if (l.kind === "step" && !(l.step_id != null && l.process_id != null && stepProcess.get(lc(l.step_id)) === lc(l.process_id))) {
      stepLinksGone++;
      return false;
    }
    return true;
  });

  const restoredIds = new Set<string>([lc(bundle.workspace.id)]);
  const personSkills = flat("person_skills", company("person_skills"), IMPORT_REFS.person_skills);
  const sourceLinks = flat("source_links", linkRows, IMPORT_REFS.source_links);

  const pendingSuggestions = bundle.suggestions.filter((s) => s.status === "pending");
  const pendingProposals = bundle.suggestion_proposals.filter((s) => s.status === "pending");
  const decided = bundle.suggestions.length - pendingSuggestions.length + (bundle.suggestion_proposals.length - pendingProposals.length);

  const plan: ImportPlan = {
    format: PLAN_FORMAT,
    settings: null,
    roles: flat("roles", company("roles")),
    people: flat("people", company("people")),
    person_roles: flat("person_roles", company("person_roles"), IMPORT_REFS.person_roles),
    person_leave: flat("person_leave", company("person_leave"), IMPORT_REFS.person_leave),
    lead_sources: flat("lead_sources", company("lead_sources")),
    seasonality: flat("seasonality", company("seasonality")),
    demand_settings: one("demand_settings"),
    churn_drivers: flat("churn_drivers", company("churn_drivers")).sort(byCreated),
    market_conditions: customConditions.map((c) => pick(c, IMPORT_COLUMNS.market_conditions)).sort(byCreated),
    market_schedule: schedule,
    lever_settings: one("lever_settings"),
    analysis_rules: one("analysis_rules"),
    clients: flat("clients", company("clients")),
    sources,
    processes,
    scenarios: parentsFirst(flat("scenarios", bundle.scenarios, IMPORT_REFS.scenarios), "parent_scenario_id"),
    blocks: flat("blocks", bundle.blocks).sort(byCreated),
    issues: issueRows,
    services: flat("services", company("services"), IMPORT_REFS.services),
    service_servicing: flat("service_servicing", company("service_servicing"), IMPORT_REFS.service_servicing),
    client_groups: flat("client_groups", company("client_groups"), IMPORT_REFS.client_groups).sort(byCreated),
    client_services: flat("client_services", company("client_services"), IMPORT_REFS.client_services),
    client_assignments: flat("client_assignments", company("client_assignments"), IMPORT_REFS.client_assignments),
    person_skills: personSkills,
    source_links: sourceLinks,
    suggestions: [],
    proposals: [],
  };

  // Settings: only the keys of WorkspaceSettings.
  const settingsIn = isObj(bundle.workspace.settings) ? bundle.workspace.settings : {};
  const known: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(settingsIn)) {
    if (Object.hasOwn(SETTING_KEYS, k)) known[k] = v;
    else unknown.push(k);
  }
  for (const k of unknown.sort()) warnings.push(`The workspace setting "${k}" isn't one this version knows and was left out.`);
  plan.settings = Object.keys(known).length ? known : null;

  // Pending suggestions and proposals, last: they point at what is restored.
  for (const set of [sets.processes!, sets.steps!, sets.roles!, sets.people!, sets.services!, sets.clients!, sets.sources!, sets.scenarios!, sets.issues!]) for (const id of set) restoredIds.add(id);
  for (const k of ["blocks", "lead_sources", "seasonality", "churn_drivers", "person_leave", "client_groups", "service_servicing"] as const) for (const r of plan[k]) restoredIds.add(lc(r.id));
  for (const p of processes) for (const e of p.edges) restoredIds.add(lc(e.id));
  plan.suggestions = pendingSuggestions
    .filter((s) => {
      const ok = s.target_id == null || restoredIds.has(lc(s.target_id));
      if (!ok) note("suggestions", "dropped");
      return ok;
    })
    .map((s) => pick(s, IMPORT_COLUMNS.suggestions))
    .sort(byCreated);
  plan.proposals = flat("proposals", pendingProposals, IMPORT_REFS.proposals).sort(byCreated);

  // A pending suggestion only counted as dropped above if it pointed at nothing restored; the lists are final now.
  for (const [section, e] of dropped) {
    const label = LABELS[section] ?? section;
    if (e.dropped) warnings.push(`${num(e.dropped)} ${label} pointed at something that isn't in the backup or isn't restored, and were left out.`);
    if (e.cleared) warnings.push(`${num(e.cleared)} ${label} had a reference to something that isn't restored; the reference was cleared.`);
  }

  // Ids: new placeholders that keep the order of the old ones.
  // Rank 0 is the workspace itself (the restore swaps it for the target workspace); the other ids take 1, 2, 3 ... in their order.
  const workspaceKey = lc(bundle.workspace.id);
  const all = new Set<string>();
  for (const r of allRows(bundle)) {
    const id = idOf(r);
    if (id && id !== workspaceKey) all.add(id);
  }
  const placeholderOf = new Map<string, string>([[workspaceKey, PLACEHOLDER_PREFIX + "0".repeat(12)]]);
  [...all].sort().forEach((id, n) => placeholderOf.set(id, PLACEHOLDER_PREFIX + (n + 1).toString(16).padStart(12, "0")));
  const remapped = JSON.parse(JSON.stringify(plan).replace(UUID_ANY, (m) => placeholderOf.get(m.toLowerCase()) ?? m)) as ImportPlan;
  assertOnlyPlaceholders(remapped);
  const planBytes = JSON.stringify(remapped).length;

  const sourceChars = sources.reduce((n, s) => n + (typeof s.body === "string" ? s.body.length : 0), 0);
  const line = (key: string, count: number, label = LABELS[key] ?? key): SummaryLine => ({ key, label, count });
  const restored = [
    line("processes", processes.length, "processes, as drafts"),
    ...(["roles", "people", "services", "clients", "client_groups", "lead_sources", "churn_drivers", "market_conditions", "scenarios", "blocks", "issues", "sources", "suggestions", "proposals"] as const).map((k) => line(k, plan[k].length)),
  ].filter((l) => l.count > 0);
  const leftOut = [
    line("older_versions", olderVersions, "older versions of processes"),
    line("company_map", companyVersions, "versions of the company map (the new workspace keeps its own)"),
    line("unpublished_drafts", unpublishedDrafts, "unpublished drafts"),
    line("solutions", bundle.solutions.length + solutionLinks, "solutions and their links"),
    line("decided_suggestions", decided, "decided suggestions and proposals"),
    line("detections", detections, "detected insights (they show again until dismissed)"),
    line("step_links", stepLinksGone, "source links to steps no longer in the process"),
    line("history", issueEvents, "issue history entries"),
    line("file_originals", fileOriginals, "source file originals (the text is restored)"),
  ].filter((l) => l.count > 0);

  const summary: ImportSummary = {
    restored,
    leftOut,
    settings: plan.settings === null ? "none" : options.canManage ? "applied" : "suggested",
    measures: {
      processes: processes.length,
      steps: stepCount,
      edges: edgeCount,
      sources: sources.length,
      sourceChars,
      issues: issueRows.length,
      people: plan.people.length,
      clients: plan.clients.length,
      scenarios: plan.scenarios.length,
      blocks: plan.blocks.length,
      suggestions: plan.suggestions.length,
      proposals: plan.proposals.length,
      planBytes,
    },
  };
  return { plan: remapped, summary, placeholderOf, warnings };
}

/** Every id and reference column of the plan holds a placeholder (or null). A real id there would be a bug in the planner. */
function assertOnlyPlaceholders(plan: ImportPlan): void {
  const bad = (where: string, v: unknown) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach((x) => bad(where, x));
    if (typeof v !== "string" || !PLACEHOLDER.test(v)) throw new Error(`planWorkspaceImport: ${where} holds ${JSON.stringify(v)}, not a placeholder id`);
  };
  const flatFields = (section: string, rows: Row[], extra: string[] = []) => {
    const fields = ["id", ...(IMPORT_REFS[section] ?? []).map((r) => r.col), ...extra];
    for (const r of rows) for (const f of fields) bad(`${section}.${f}`, r[f]);
  };
  for (const section of Object.keys(plan) as (keyof ImportPlan)[]) {
    const v = plan[section];
    if (!Array.isArray(v) || section === "processes") continue;
    flatFields(section, v as Row[], section === "market_schedule" ? ["condition_id"] : section === "suggestions" ? ["target_id"] : section === "issues" ? ["owner_ids", "source_ids"] : []);
  }
  for (const i of plan.issues) for (const l of rowsOf(i.links)) {
      bad("issues.links", l.process_id);
      bad("issues.links", l.step_id);
    }
  for (const p of plan.processes) {
    bad("processes.id", p.id);
    bad("processes.parent_process_id", p.parent_process_id);
    for (const s of p.steps) for (const f of ["id", ...IMPORT_STEP_REFS.map((r) => r.col)]) bad(`steps.${f}`, s[f]);
    for (const e of p.edges) for (const f of ["id", "from_step_id", "to_step_id"]) bad(`edges.${f}`, e[f]);
  }
}
