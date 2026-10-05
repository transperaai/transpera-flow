// The JSON workspace bundle (issue #39, B10 part 1: export only; PRD §9): everything one workspace holds, as the backup and
// migration format `transpera-workspace/1`. A future import reads this; nothing here writes.
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

/** Columns never exported, in any table: who made a row, and anyone's email. */
export const NEVER_EXPORTED = ["created_by", "published_by", "reviewed_by", "user_id", "email", "proposer_email", "proposer_name"] as const;

/** Removes the columns that are never exported. */
export function scrub(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (!(NEVER_EXPORTED as readonly string[]).includes(k)) out[k] = v;
  return out;
}

const PAGE = 1000;

/** A reader over a Supabase client acting as the signed-in user: pages of 1000 (the API's cap), in a stable order. */
export function supabaseReader(db: Db): TableReader {
  return async (table, workspaceId) => {
    const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table);
    if (!spec) throw new Error(`Not a bundle table: ${table}`);
    const all: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = (db as unknown as { from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => { order: (c: string) => unknown } } } })
        .from(table)
        .select(spec.columns ?? "*")
        .eq("workspace_id", workspaceId) as unknown as { order: (c: string) => unknown };
      for (const col of spec.order) q = q.order(col) as typeof q;
      const { data, error } = await (q as unknown as { range: (a: number, b: number) => Promise<{ data: Row[] | null; error: { message: string } | null }> }).range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      all.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    return all;
  };
}

export interface WorkspaceBundle {
  format: typeof WORKSPACE_BUNDLE_FORMAT;
  exported_at: string;
  engine_version: string;
  /** What the file is, for a person opening it. */
  about: string;
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

/**
 * The workspace's bundle, or null when the signed-in user can't read the workspace (not a member, or no such workspace: the
 * same answer, so it can't be used to find workspaces). `readWorkspace` reads the one `workspaces` row under RLS.
 */
export async function exportWorkspaceBundle(
  workspaceId: string,
  readWorkspace: (id: string) => Promise<Row | null>,
  read: TableReader,
  now: Date = new Date(),
): Promise<WorkspaceBundle | null> {
  const ws = await readWorkspace(workspaceId);
  if (!ws || ws.id !== workspaceId) return null;

  const names = Object.keys(BUNDLE_TABLES) as (keyof typeof BUNDLE_TABLES)[];
  const data = Object.fromEntries(
    await Promise.all(
      names.map(async (n) => {
        const rows = await read(BUNDLE_TABLES[n].table, workspaceId);
        // Belt and braces: a row of another workspace is dropped even if a policy let it through.
        return [n, rows.filter((r) => r.workspace_id === workspaceId).map(scrub)] as const;
      }),
    ),
  ) as Record<keyof typeof BUNDLE_TABLES, Row[]>;

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
    "roles", "people", "person_roles", "person_skills", "person_leave", "services", "service_servicing", "client_groups", "client_services",
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

  return {
    format: WORKSPACE_BUNDLE_FORMAT,
    exported_at: now.toISOString(),
    engine_version: ENGINE_VERSION,
    about:
      "A Transpera Flow workspace backup (export only; importing a bundle is not available yet). Rows keep their ids and column names. Named clients are hidden in the product and kept here, flagged hidden. People's emails, members, tokens and who created a row are never included.",
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
}

/** The reader of the `workspaces` row, as the signed-in user. */
export function supabaseWorkspaceReader(db: Db): (id: string) => Promise<Row | null> {
  return async (id) => {
    const { data, error } = await db.from("workspaces").select("id, name, slug, plan, settings, provenance").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as Row | null) ?? null;
  };
}
