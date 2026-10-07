// The JSON workspace bundle (issue #39, B10 part 1: export only; PRD §9): everything one workspace holds, as the backup and
// migration format `transpera-workspace/1`. A future import
// reads this; nothing here writes.
//
// What it holds: the workspace and its settings; the company model (roles, people, services, client groups, named clients
// flagged hidden, demand, market, churn drivers, levers, analysis rules); every process with ALL its versions (published,
// superseded and draft: steps, edges and first principles of each, the company map included); scenarios, solutions and
// blocks; issues with their links, owners, sources and history; sources and their links; pending and decided suggestions.
// Rows keep their database ids and column names so references stay intact and nothing is lost. The step `kind` and
// `outcome` values and the edge `label` and `condition_tag` are the ones a `transpera-process/2` file uses.
//
// What it never holds: other workspaces' rows, people's emails, members and their user ids, API tokens, share links,
// access lists, AI keys, who created a row (`created_by`), derived results (runs, AI analyses, narrations, robustness
// checks, the old reports). Every read is as the signed-in user (RLS decides what a viewer may read) and filtered to the
// one workspace as well, so a policy mistake could not leak another workspace's rows into the file.

import { restoreSizeWarning } from "./workspace-import";
import { ENGINE_VERSION } from "@transpera-flow/engine";
import type { Db } from "./queries";

export const WORKSPACE_BUNDLE_FORMAT = "transpera-workspace/1";

export type Row = Record<string, unknown>;

/** Reads every row of a table that belongs to a workspace (ordered, all pages), as the signed-in user. */
export type TableReader = (table: string, workspaceId: string) => Promise<Row[]>;

interface TableSpec {
  table: string;
  /** Stable order, which also pages. */
  order: readonly string[];
  /** The columns to read, when not all of them: `suggestion_proposals.proposer_email` is not readable by the app's users, so a `select *` would be refused. */
  columns?: string;
}

const T = (table: string, ...order: string[]): TableSpec => ({ table, order: order.length ? order : ["id"] });

/** The tables a bundle reads, by section. `workspaces` itself is read by id. */
export const BUNDLE_TABLES = {
  roles: T("roles"),
  people: T("people"),
  person_roles: T("person_roles", "person_id", "role_id"),
  person_skills: T("person_skills", "person_id", "step_id"),
  person_leave: T("person_leave"),
  // C6: per-person times, kept in a backup (RLS: editors only). The restore leaves them out and says so. `step_id` is null for a
  // person's default: nulls sort last, and (person_id, step_id) is unique, so the order is total and the paging stable.
  person_capacity_factors: T("person_capacity_factors", "person_id", "step_id"),
  services: T("services"),
  service_servicing: T("service_servicing"),
  client_groups: T("client_groups"),
  clients: T("clients"),
  client_services: T("client_services", "client_id", "service_id"),
  client_assignments: T("client_assignments", "client_id", "role_id"),
  lead_sources: T("lead_sources"),
  seasonality: T("seasonality"),
  demand_settings: T("demand_settings", "workspace_id"),
  market_conditions: T("market_conditions"),
  market_schedule: T("market_schedule"),
  churn_drivers: T("churn_drivers"),
  lever_settings: T("lever_settings", "workspace_id"),
  analysis_rules: T("analysis_rules", "workspace_id"),
  processes: T("processes"),
  process_revisions: T("process_revisions"),
  steps: T("steps"),
  edges: T("edges"),
  first_principles: T("first_principles"),
  scenarios: T("scenarios"),
  solutions: T("solutions"),
  solution_issues: T("solution_issues", "solution_id", "issue_id"),
  blocks: T("blocks"),
  issues: T("issues"),
  issue_links: T("issue_links"),
  issue_owners: T("issue_owners", "issue_id", "person_id"),
  issue_sources: T("issue_sources", "issue_id", "source_id"),
  issue_events: T("issue_events"),
  sources: T("sources"),
  source_links: T("source_links"),
  suggestions: T("suggestions"),
  suggestion_proposals: {
    ...T("suggestion_proposals"),
    columns: "id, workspace_id, kind, title, detail, payload, evidence, note, issue_id, status, created_via, applied, review_note, reviewed_at, created_at, updated_at, import_source",
  },
} as const satisfies Record<string, TableSpec>;

/**
 * Keys that name an account or a person's contact details, in a column or at any depth of a JSON column: who made, changed,
 * reviewed or published something (`created_by`, `updated_by`, `reviewed_by`, `published_by`, `edited_by`, any `*_by`; the
 * `by` in `provenance` and `resolved`), who did it in a history (`actor`), `user_id`, `author`, `uid`, and emails and names
 * typed by a proposer. The migrations write `auth.uid()` into exactly these. Matched without regard to case.
 */
export const ACCOUNT_KEY = /^(by|actor|actor_id|user_id|uid|author|author_id|email|proposer_email|proposer_name|user_name|user_email)$|_by$|^(created|updated|edited|reviewed|published|accepted|resolved)_by_/i;

/** Keys that end in `_by` but are not accounts: the steps that took over a retired step's work, and the person who agreed a first-principles item. */
const NOT_ACCOUNTS = new Set(["replaced_by", "agreed_by"]);
const isAccountKey = (k: string): boolean => ACCOUNT_KEY.test(k) && !NOT_ACCOUNTS.has(k);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every account id found under an account key, anywhere in `value` (a second net: the same id is then removed wherever it turns up). */
export function collectAccountIds(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectAccountIds(v, into);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (isAccountKey(k)) {
        if (typeof v === "string" && UUID.test(v)) into.add(v.toLowerCase());
      } else collectAccountIds(v, into);
    }
  }
  return into;
}

/**
 * `value` without any account key at any depth, and without any string equal to an account id found by `collectAccountIds`
 * (a property holding one is dropped; an array element holding one is dropped).
 */
export function scrubDeep<T>(value: T, ids: ReadonlySet<string> = new Set()): T {
  const isId = (v: unknown) => typeof v === "string" && ids.has(v.toLowerCase());
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.filter((x) => !isId(x)).map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!isAccountKey(k) && !isId(x)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Removes account keys and ids from a row (kept for the tests; the export scrubs everything it holds in one pass). */
export function scrub(row: Row): Row {
  return scrubDeep(row, collectAccountIds(row));
}

/** The most rows of one table, and in all, a bundle will hold: past that the export says so instead of exhausting memory. */
export const MAX_TABLE_ROWS = 250_000;
export const MAX_BUNDLE_ROWS = 600_000;

export class BundleTooLargeError extends Error {
  constructor(what: string) {
    super(`This workspace is too large to export in one file (${what}).`);
    this.name = "BundleTooLargeError";
  }
}

export interface ReaderOptions {
  /** Rows asked for per request (the API may return fewer, whatever its own limit). */
  pageSize?: number;
  maxRows?: number;
}

/**
 * A reader over a Supabase client acting as the signed-in user, in a stable order. It asks for the next rows after what it
 * has, and stops only on an empty page, so an API that returns fewer rows than asked (a lower max-rows) can't truncate it.
 */
export function supabaseReader(db: Db, options: ReaderOptions = {}): TableReader {
  const pageSize = options.pageSize ?? 1000;
  const maxRows = options.maxRows ?? MAX_TABLE_ROWS;
  return async (table, workspaceId) => {
    const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table);
    if (!spec) throw new Error(`Not a bundle table: ${table}`);
    const all: Row[] = [];
    for (;;) {
      let q = (db as unknown as { from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => { order: (c: string) => unknown } } } })
        .from(table)
        .select(spec.columns ?? "*")
        .eq("workspace_id", workspaceId) as unknown as { order: (c: string) => unknown };
      for (const col of spec.order) q = q.order(col) as typeof q;
      const from = all.length;
      const { data, error } = await (q as unknown as { range: (a: number, b: number) => Promise<{ data: Row[] | null; error: { message: string } | null }> }).range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      all.push(...data);
      if (all.length > maxRows) throw new BundleTooLargeError(`${table} has more than ${maxRows} rows`);
    }
    return all;
  };
}

export interface WorkspaceBundle {
  format: typeof WORKSPACE_BUNDLE_FORMAT;
  exported_at: string;
  engine_version: string;
  /** "everything" for an editor or owner; "published" for a viewer (no drafts, no pending suggestions or proposals). */
  scope: "everything" | "published";
  /** What the file is, for a person opening it. */
  about: string;
  /** Present only when the workspace is bigger than a restore takes: the same sentence as the end of `about`. */
  restore_warning?: string;
  workspace: { id: string; name: string; slug: string; plan: string | null; settings: unknown; provenance: unknown };
  company_model: Record<string, Row[]>;
  /** Every process, the company map included, each with all of its versions. */
  processes: Row[];
  scenarios: Row[];
  solutions: Row[];
  solution_issues: Row[];
  blocks: Row[];
  issues: Row[];
  sources: Row[];
  source_links: Row[];
  suggestions: Row[];
  suggestion_proposals: Row[];
  /** Rows per section, so a reader can tell a truncated file. */
  counts: Record<string, number>;
}

const group = (rows: Row[], key: string): Map<string, Row[]> => {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = String(r[key]);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
};

export interface ExportOptions {
  /**
   * Whether the user may edit the workspace. Editors and owners get everything; `false` gives what is published (no draft
   * versions, no pending suggestions or proposals). The export route no longer calls this for viewers (only agency admins,
   * owners and editors may export, issue #39), but bundles made that way exist, and the import checker accepts them.
   */
  canEdit: boolean;
  now?: Date;
}

/**
 * The workspace's bundle, or null when the signed-in user can't read the workspace (not a member, or no such workspace: the
 * same answer, so it can't be used to find workspaces). `readWorkspace` reads the one `workspaces` row under RLS.
 */
export async function exportWorkspaceBundle(
  workspaceId: string,
  readWorkspace: (id: string) => Promise<Row | null>,
  read: TableReader,
  options: ExportOptions,
): Promise<WorkspaceBundle | null> {
  const now = options.now ?? new Date();
  const wsRow = await readWorkspace(workspaceId);
  if (!wsRow || wsRow.id !== workspaceId) return null;

  const names = Object.keys(BUNDLE_TABLES) as (keyof typeof BUNDLE_TABLES)[];
  const raw = Object.fromEntries(
    await Promise.all(
      names.map(async (n) => {
        const rows = await read(BUNDLE_TABLES[n].table, workspaceId);
        // Belt and braces: a row of another workspace is dropped even if a policy let it through.
        return [n, rows.filter((r) => r.workspace_id === workspaceId)] as const;
      }),
    ),
  ) as Record<keyof typeof BUNDLE_TABLES, Row[]>;
  const total = Object.values(raw).reduce((n, rows) => n + rows.length, 0);
  if (total > MAX_BUNDLE_ROWS) throw new BundleTooLargeError(`${total} rows in all`);

  // A viewer gets what is published (the same as the live app shows a reader), not working drafts or pending suggestions.
  if (!options.canEdit) {
    raw.process_revisions = raw.process_revisions.filter((r) => r.status !== "draft");
    const kept = new Set(raw.process_revisions.map((r) => r.id));
    for (const t of ["steps", "edges", "first_principles"] as const) raw[t] = raw[t].filter((r) => kept.has(r.revision_id));
    raw.processes = raw.processes.map((p) => ({ ...p, draft_revision_id: null }));
    raw.suggestions = [];
    raw.suggestion_proposals = [];
  }

  // Everyone's account is scrubbed from everything, by key at any depth and then by the ids those keys held.
  const ids = collectAccountIds([raw, wsRow]);
  const data = Object.fromEntries(names.map((n) => [n, scrubDeep(raw[n], ids)])) as Record<keyof typeof BUNDLE_TABLES, Row[]>;
  const ws = scrubDeep(wsRow, ids);

  const stepsBy = group(data.steps, "revision_id");
  const edgesBy = group(data.edges, "revision_id");
  const fpBy = group(data.first_principles, "revision_id");
  const revisionsBy = group(data.process_revisions, "process_id");
  const processes = data.processes.map((p) => ({
    ...p,
    versions: (revisionsBy.get(String(p.id)) ?? []).map((rev) => ({
      ...rev,
      live: rev.id === p.live_revision_id,
      draft: rev.id === p.draft_revision_id,
      steps: stepsBy.get(String(rev.id)) ?? [],
      edges: edgesBy.get(String(rev.id)) ?? [],
      first_principles: (fpBy.get(String(rev.id)) ?? [])[0] ?? null,
    })),
  }));

  const linksBy = group(data.issue_links, "issue_id");
  const ownersBy = group(data.issue_owners, "issue_id");
  const srcBy = group(data.issue_sources, "issue_id");
  const eventsBy = group(data.issue_events, "issue_id");
  const issues = data.issues.map((i) => ({
    ...i,
    links: (linksBy.get(String(i.id)) ?? []).map(({ process_id, step_id }) => ({ process_id, step_id })),
    owner_ids: (ownersBy.get(String(i.id)) ?? []).map((o) => o.person_id),
    source_ids: (srcBy.get(String(i.id)) ?? []).map((s) => s.source_id),
    events: eventsBy.get(String(i.id)) ?? [],
  }));

  const companyKeys = [
    "roles", "people", "person_roles", "person_skills", "person_leave", "person_capacity_factors", "services", "service_servicing", "client_groups", "client_services",
    "client_assignments", "lead_sources", "seasonality", "demand_settings", "market_conditions", "market_schedule", "churn_drivers", "lever_settings", "analysis_rules",
  ] as const;
  const company_model: Record<string, Row[]> = Object.fromEntries(companyKeys.map((k) => [k, data[k]]));
  // Named clients are hidden in the product (D27) and never deleted: the bundle keeps them, flagged, as a backup.
  company_model.clients = data.clients.map((c) => ({ ...c, hidden: true }));

  const counts: Record<string, number> = {};
  for (const [k, rows] of Object.entries(company_model)) counts[`company_model.${k}`] = rows.length;
  counts.processes = processes.length;
  counts.process_versions = data.process_revisions.length;
  counts.steps = data.steps.length;
  counts.edges = data.edges.length;
  for (const k of ["scenarios", "solutions", "solution_issues", "blocks", "issues", "sources", "source_links", "suggestions", "suggestion_proposals"] as const) counts[k] = data[k].length;

  const bundle: WorkspaceBundle = {
    format: WORKSPACE_BUNDLE_FORMAT,
    exported_at: now.toISOString(),
    engine_version: ENGINE_VERSION,
    scope: options.canEdit ? "everything" : "published",
    about:
      "A Transpera Flow workspace backup. Restore it into a new, empty workspace from that workspace's Overview: each process comes back as a draft of its latest published version. Rows keep their ids and column names. Named clients are hidden in the product and kept here, flagged hidden. People's emails, members, tokens and who made or changed anything are never included. The tables are read one after another while people may be editing, so a bundle taken during edits can mix moments: exported_at is when the reading began.",
    workspace: {
      id: String(ws.id),
      name: String(ws.name),
      slug: String(ws.slug),
      plan: (ws.plan as string | null) ?? null,
      settings: ws.settings ?? {},
      provenance: ws.provenance ?? {},
    },
    company_model,
    processes,
    scenarios: data.scenarios,
    solutions: data.solutions,
    solution_issues: data.solution_issues,
    blocks: data.blocks,
    issues,
    sources: data.sources,
    source_links: data.source_links,
    suggestions: data.suggestions,
    suggestion_proposals: data.suggestion_proposals,
    counts,
  };
  // Export allows far more than a restore takes (MAX_TABLE_ROWS against WORKSPACE_IMPORT_LIMITS). A workspace over a restore limit is
  // still exported, and the file says so in plain words, so it is kept knowing it can't be restored in one go yet.
  const warning = restoreSizeWarning(bundle);
  if (warning) {
    bundle.about = `${bundle.about} ${warning}`;
    bundle.restore_warning = warning;
  }
  return bundle;
}

/** The reader of the `workspaces` row, as the signed-in user. */
export function supabaseWorkspaceReader(db: Db): (id: string) => Promise<Row | null> {
  return async (id) => {
    const { data, error } = await db.from("workspaces").select("id, name, slug, plan, settings, provenance").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as Row | null) ?? null;
  };
}

/**
 * The bundle as JSON text in pieces, one per row of each section and without indentation, so a response can be sent as it
 * is made instead of as one very large string. The pieces joined are valid JSON, equal to `JSON.stringify(bundle)`.
 */
export function* bundleJsonChunks(bundle: WorkspaceBundle): Generator<string> {
  function* part(value: unknown, depth: number): Generator<string> {
    if (Array.isArray(value)) {
      yield "[";
      for (let i = 0; i < value.length; i++) yield (i ? "," : "") + JSON.stringify(value[i]);
      yield "]";
    } else if (value && typeof value === "object" && depth < 2) {
      yield "{";
      let first = true;
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue;
        yield `${first ? "" : ","}${JSON.stringify(k)}:`;
        first = false;
        yield* part(v, depth + 1);
      }
      yield "}";
    } else yield JSON.stringify(value) ?? "null";
  }
  yield* part(bundle, 0);
}
