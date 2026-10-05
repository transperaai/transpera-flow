import type { LinkTargets } from "./source-links";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "./database.types";
import type { CompanyModel, SnapshotProcess } from "./company";
import type { CitingRow } from "./evidence";
import { uiStatus, type StoredIssueStatus } from "./issue-status";
import { partitionSteps } from "./retired";
import type { RunRow } from "./runs";
import type {
  BlockRow,
  SolutionIssueRow,
  SolutionRow,
  ChurnDriverRow,
  ClientAssignmentRow,
  ClientGroupRow,
  ClientRow,
  ClientServiceRow,
  DemandSettingsRow,
  IssueEventRow,
  IssueLinkRef,
  IssueRow,
  ResolveHow,
  LeadSourceRow,
  MarketConditionRow,
  MarketScheduleRow,
  EdgeRow,
  PersonRow,
  ProcessBundle,
  ProcessPart,
  ProcessRevisionRow,
  ProcessRow,
  ProvenanceMap,
  ScenarioRow,
  SeasonalityRow,
  ServiceRow,
  ServiceServicingRow,
  SourceLinkRow,
  SourceRow,
  StepRow,
  SuggestionRow,
  SuggestionStatus,
  WorkspaceRow,
  WorkspaceSettings,
} from "./types";

// Reads shared by the web app (signed-in session) and the MCP server (API
// token). Both pass a client that acts as the user, so RLS decides what is
// visible; the service-role key is never used here.

export type Db = SupabaseClient<Database>;

/** Rows a query returned, or its error thrown. */
function rows<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data as T;
}

/** The `ServiceRow` columns. */
export const SERVICE_COLUMNS =
  "id, workspace_id, name, pricing_model, price, margin, tenure_months, churn_monthly_base, churn_health_sensitivity, mix_share, entry_process_id, path_tags, fallback_ongoing_load, active" as const;

/** The `ServiceServicingRow` columns. */
export const SERVICE_SERVICING_COLUMNS = "id, workspace_id, service_id, process_id, recurrence, sla_hours, provenance" as const;

/**
 * What a run of `process` needs of the workspace's other processes (issue
 * #19): the servicing links, and the other processes at their live
 * revisions: every servicing process, and for a servicing process the
 * pipeline it runs beside (the first pipeline with a live revision, as
 * `/w/[slug]` opens). Processes never published aren't simulated.
 */
export async function loadServicingContext(
  db: Db,
  workspaceId: string,
  process: Pick<ProcessRow, "id" | "kind">,
): Promise<{ servicingLinks: ServiceServicingRow[]; otherProcesses: ProcessPart[] }> {
  const [processes, links] = await Promise.all([
    listProcesses(db, workspaceId),
    db.from("service_servicing").select(SERVICE_SERVICING_COLUMNS).eq("workspace_id", workspaceId).order("id"),
  ]);
  const live = processes.filter((p) => p.id !== process.id && p.live_revision_id);
  // A child process runs inside its parent, so it is never the pipeline a servicing process runs beside.
  const pipeline = process.kind === "servicing" ? live.find((p) => p.kind !== "servicing" && !p.parent_process_id) : undefined;
  const base = live.filter((p) => p.kind === "servicing" || p === pipeline);
  // The child processes (any depth) of this process and of those, which the steps holding them are simulated through.
  const reached = new Set([process.id, ...base.map((p) => p.id)]);
  const children: typeof live = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of live) {
      if (p.parent_process_id && reached.has(p.parent_process_id) && !reached.has(p.id)) {
        reached.add(p.id);
        children.push(p);
        grew = true;
      }
    }
  }
  const wanted = [...base, ...children.filter((c) => !base.includes(c))];
  const revisionIds = wanted.map((p) => p.live_revision_id!);
  const [revisions, steps, edges] = revisionIds.length
    ? await Promise.all([
        db.from("process_revisions").select("id, workspace_id, process_id, number, status").in("id", revisionIds),
        db.from("steps").select("*").in("revision_id", revisionIds),
        db.from("edges").select("*").in("revision_id", revisionIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  const stepRows = (rows(steps) ?? []) as StepRow[];
  const edgeRows = (rows(edges) ?? []) as EdgeRow[];
  const revisionRows = (rows(revisions) ?? []) as ProcessRevisionRow[];
  const otherProcesses: ProcessPart[] = [];
  // The pipeline first: a servicing bundle runs beside it.
  for (const p of pipeline ? [pipeline, ...wanted.filter((w) => w !== pipeline)] : wanted) {
    const revision = revisionRows.find((r) => r.id === p.live_revision_id);
    if (!revision) continue;
    const { draft_revision_id: _draft, ...row } = p;
    otherProcesses.push({
      process: row,
      revision,
      // Split or replaced steps are never simulated (./retired.ts).
      steps: partitionSteps(stepRows.filter((s) => s.revision_id === revision.id)).steps,
      edges: edgeRows.filter((e) => e.revision_id === revision.id),
    });
  }
  // recurrence and provenance are jsonb; the table's check limits recurrence to RecurrenceJson.
  return { servicingLinks: (rows(links) ?? []) as unknown as ServiceServicingRow[], otherProcesses };
}

/** The `ClientRow`, `ClientServiceRow` and `ClientAssignmentRow` columns. */
export const CLIENT_COLUMNS = "id, workspace_id, name, start_date, mrr, health, provenance, notes, active" as const;
export const CLIENT_SERVICE_COLUMNS = "client_id, service_id, workspace_id, start_date" as const;
export const CLIENT_ASSIGNMENT_COLUMNS = "client_id, role_id, person_id, workspace_id" as const;

/** A workspace's client roster: clients by name, their services and assignments. */
export async function loadClients(
  db: Db,
  workspaceId: string,
): Promise<{ clients: ClientRow[]; clientServices: ClientServiceRow[]; clientAssignments: ClientAssignmentRow[] }> {
  const [clients, clientServices, clientAssignments] = await Promise.all([
    db.from("clients").select(CLIENT_COLUMNS).eq("workspace_id", workspaceId).order("name").order("id"),
    db.from("client_services").select(CLIENT_SERVICE_COLUMNS).eq("workspace_id", workspaceId),
    db.from("client_assignments").select(CLIENT_ASSIGNMENT_COLUMNS).eq("workspace_id", workspaceId),
  ]);
  return {
    // provenance is jsonb; ClientRow gives it its shape.
    clients: (rows(clients) ?? []) as ClientRow[],
    clientServices: rows(clientServices) ?? [],
    clientAssignments: rows(clientAssignments) ?? [],
  };
}

/** The `ClientGroupRow` columns. */
export const CLIENT_GROUP_COLUMNS = "id, workspace_id, service_id, client_count, fee, churn_monthly, stay_months, starting_health, provenance" as const;

/** A workspace's client groups (clients counted per service), by creation order. */
export async function loadClientGroups(db: Db, workspaceId: string): Promise<ClientGroupRow[]> {
  const r = await db.from("client_groups").select(CLIENT_GROUP_COLUMNS).eq("workspace_id", workspaceId).order("created_at").order("id");
  // provenance is jsonb; ProvenanceMap is its app-side shape.
  return (rows(r) ?? []) as ClientGroupRow[];
}

/** The `ChurnDriverRow` columns. */
export const CHURN_DRIVER_COLUMNS = "id, workspace_id, driver, name, description, example, weight, enabled, value, month, provenance" as const;

/** The churn drivers a workspace has set, built-ins first (by creation order), then its own by name. */
export async function loadChurnDrivers(db: Db, workspaceId: string): Promise<ChurnDriverRow[]> {
  const r = await db.from("churn_drivers").select(CHURN_DRIVER_COLUMNS).eq("workspace_id", workspaceId).order("created_at").order("id");
  // driver is check-constrained to ChurnDriverKey; provenance is jsonb.
  return (rows(r) ?? []) as ChurnDriverRow[];
}

/** The `LeadSourceRow`, `SeasonalityRow` and `DemandSettingsRow` columns. */
export const LEAD_SOURCE_COLUMNS = "id, workspace_id, name, volume_week, conversion_to_qualified, provenance" as const;
export const SEASONALITY_COLUMNS = "id, workspace_id, month, multiplier, provenance" as const;
export const DEMAND_SETTINGS_COLUMNS = "workspace_id, growth_monthly, provenance" as const;

/** The `MarketConditionRow` and `MarketScheduleRow` columns. */
export const MARKET_CONDITION_COLUMNS = "id, workspace_id, name, preset, leads, conv, cycle, price, churn, hire, pay" as const;
export const MARKET_SCHEDULE_COLUMNS = "id, workspace_id, from_month, to_month, condition_id" as const;

/** A workspace's market conditions (presets first, then its own by name) and its 24-month schedule in month order. */
export async function loadMarket(db: Db, workspaceId: string): Promise<{ marketConditions: MarketConditionRow[]; marketSchedule: MarketScheduleRow[] }> {
  const [conditions, schedule] = await Promise.all([
    db.from("market_conditions").select(MARKET_CONDITION_COLUMNS).eq("workspace_id", workspaceId).order("created_at").order("id"),
    db.from("market_schedule").select(MARKET_SCHEDULE_COLUMNS).eq("workspace_id", workspaceId).order("from_month").order("id"),
  ]);
  return {
    // preset is check-constrained to MarketPreset.
    marketConditions: (rows(conditions) ?? []) as MarketConditionRow[],
    marketSchedule: rows(schedule) ?? [],
  };
}

/** Load one process revision with everything needed to render and simulate it. */
export async function loadProcessBundle(
  db: Db,
  workspace: Pick<WorkspaceRow, "id" | "name" | "slug"> & { settings: unknown },
  process: ProcessRow,
  revisionId: string,
): Promise<ProcessBundle> {
  const ws = workspace.id;
  const [revision, roles, steps, edges, people, personRoles, personSkills, personLeave, services, leadSources, seasonality, demand, roster, clientGroups, churnDrivers, servicing, market, settingsProvenance] =
    await Promise.all([
      db.from("process_revisions").select("id, workspace_id, process_id, number, status").eq("id", revisionId).single(),
      db.from("roles").select("*").eq("workspace_id", ws),
      db.from("steps").select("*").eq("revision_id", revisionId),
      db.from("edges").select("*").eq("revision_id", revisionId),
      db.from("people").select("id, workspace_id, name, fte, capacity_hours_week, cost_rate, active, start_date, end_date").eq("workspace_id", ws),
      db.from("person_roles").select("person_id, role_id, workspace_id").eq("workspace_id", ws),
      db.from("person_skills").select("person_id, step_id, workspace_id").eq("workspace_id", ws),
      db.from("person_leave").select("id, person_id, workspace_id, start_date, end_date").eq("workspace_id", ws),
      // Services' and settings' provenance: the robustness check perturbs only estimated values (issue #79).
      db.from("services").select(`${SERVICE_COLUMNS}, provenance`).eq("workspace_id", ws),
      db.from("lead_sources").select(LEAD_SOURCE_COLUMNS).eq("workspace_id", ws),
      db.from("seasonality").select(SEASONALITY_COLUMNS).eq("workspace_id", ws),
      db.from("demand_settings").select(DEMAND_SETTINGS_COLUMNS).eq("workspace_id", ws).maybeSingle(),
      loadClients(db, ws),
      loadClientGroups(db, ws),
      loadChurnDrivers(db, ws),
      // The company map runs nothing: it needs no other processes (the Editor draws its cards from the live processes it is given).
      process.is_company ? { servicingLinks: [], otherProcesses: [] } : loadServicingContext(db, ws, process),
      loadMarket(db, ws),
      db.from("workspaces").select("provenance").eq("id", ws).maybeSingle(),
    ]);
  const wsProvenance = rows(settingsProvenance)?.provenance;

  // Split or replaced steps stay in the revision for scenarios to re-point, never drawn or simulated (./retired.ts).
  const { steps: inUse, retired } = partitionSteps((rows(steps) ?? []) as StepRow[]);
  // The casts narrow text columns that check constraints already limit, and the settings jsonb.
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      settings: workspace.settings as WorkspaceSettings,
      // jsonb; ProvenanceMap is its app-side shape.
      ...(wsProvenance ? { provenance: wsProvenance as ProvenanceMap } : {}),
    },
    process,
    revision: rows(revision) as ProcessRevisionRow,
    roles: rows(roles) ?? [],
    steps: inUse,
    retired,
    edges: rows(edges) ?? [],
    people: rows(people) ?? [],
    personRoles: rows(personRoles) ?? [],
    personSkills: rows(personSkills) ?? [],
    personLeave: rows(personLeave) ?? [],
    // pricing_model is check-constrained; fallback_ongoing_load is jsonb.
    services: (rows(services) ?? []) as ServiceRow[],
    // Provenance is jsonb; LeadSourceRow and the others give it its shape.
    leadSources: (rows(leadSources) ?? []) as LeadSourceRow[],
    seasonality: (rows(seasonality) ?? []) as SeasonalityRow[],
    demand: rows(demand) as DemandSettingsRow | null,
    ...roster,
    clientGroups,
    churnDrivers,
    ...servicing,
    ...market,
  };
}

const PROCESS_COLUMNS = "id, workspace_id, name, kind, entity_name, description, live_revision_id, parent_process_id, is_company" as const;

/**
 * A workspace's processes, oldest first. The company map (a stored process whose steps hold the top-level processes,
 * B11) is not one of them unless `includeCompany` is set: it is never simulated, listed as an ordinary process or
 * counted.
 */
export async function listProcesses(
  db: Db,
  workspaceId: string,
  { includeCompany = false }: { includeCompany?: boolean } = {},
): Promise<(ProcessRow & { draft_revision_id: string | null })[]> {
  let q = db.from("processes").select(`${PROCESS_COLUMNS}, draft_revision_id`).eq("workspace_id", workspaceId);
  if (!includeCompany) q = q.eq("is_company", false);
  const r = await q.order("created_at").order("id");
  return rows(r) as (ProcessRow & { draft_revision_id: string | null })[];
}

/**
 * The workspace's company map at its live revision: the process, and its steps (one holder per process on the map, at
 * its stored position) and edges (the handoff lines). Null if the workspace has none or it isn't visible. Layout only:
 * nothing here is simulated.
 */
export async function loadLiveCompanyPart(db: Db, workspaceId: string): Promise<ProcessPart | null> {
  const found = await db.from("processes").select(`${PROCESS_COLUMNS}, draft_revision_id`).eq("workspace_id", workspaceId).eq("is_company", true).maybeSingle();
  if (found.error) throw found.error;
  const company = found.data as unknown as (ProcessRow & { draft_revision_id: string | null }) | null;
  if (!company?.live_revision_id) return null;
  const [revision, steps, edges] = await Promise.all([
    db.from("process_revisions").select("id, workspace_id, process_id, number, status").eq("id", company.live_revision_id).maybeSingle(),
    db.from("steps").select("*").eq("revision_id", company.live_revision_id).order("y").order("x").order("id"),
    db.from("edges").select("*").eq("revision_id", company.live_revision_id).order("id"),
  ]);
  if (revision.error) throw revision.error;
  if (steps.error) throw steps.error;
  if (edges.error) throw edges.error;
  if (!revision.data) return null;
  const { draft_revision_id: _draft, ...process } = company;
  return {
    process,
    revision: revision.data as ProcessRevisionRow,
    steps: steps.data as unknown as StepRow[],
    edges: edges.data as unknown as EdgeRow[],
  };
}

/**
 * The workspace's first process at its live revision, or null if not visible.
 * Only the live revision: simulation, forecasts and reports never see a draft.
 */
export async function loadLiveProcessBySlug(db: Db, slug: string): Promise<ProcessBundle | null> {
  return (await loadProcessBySlug(db, slug, { draft: false }))?.live ?? null;
}

/** A workspace's process as the process picker lists it (issue #76). */
export interface ProcessListing {
  id: string;
  name: string;
  kind: ProcessRow["kind"];
  /** Published at least once. */
  live: boolean;
  /** Has an open draft. */
  draft: boolean;
  /** The process it sits inside, or null (or absent) for a top-level process: the company map's steps (issue #102). */
  parentId?: string | null;
}

/**
 * The live revision of a process that has never been published: no steps,
 * number 0, and the nil uuid for an id (it matches no rows). The editor shows
 * the process's draft against it, so everything in the draft is new, and
 * publishing makes the draft the first live revision (issue #76).
 */
export const UNPUBLISHED_REVISION_ID = "00000000-0000-0000-0000-000000000000";

export function unpublishedLive(draft: ProcessBundle): ProcessBundle {
  return {
    ...draft,
    revision: { id: UNPUBLISHED_REVISION_ID, workspace_id: draft.workspace.id, process_id: draft.process.id, number: 0, status: "published" },
    steps: [],
    edges: [],
    retired: [],
  };
}

/** True for the stand-in live revision of a never-published process. */
export const isUnpublished = (bundle: Pick<ProcessBundle, "revision">) => bundle.revision.id === UNPUBLISHED_REVISION_ID;

/**
 * A workspace's process at its live revision, and its draft revision if one
 * is open (for the editor; issue #9), with the workspace's processes for the
 * picker. Without `processId`, the first process with a live revision (the
 * default at `/w/[slug]`). A process never published (issue #76) comes with
 * an empty stand-in live revision (`unpublishedLive`) and its draft. Null if
 * not visible, or if there is nothing to show.
 */
export async function loadProcessBySlug(
  db: Db,
  slug: string,
  { draft = true, processId, includeCompany = false }: { draft?: boolean; processId?: string; includeCompany?: boolean } = {},
): Promise<{ live: ProcessBundle; draft: ProcessBundle | null; processes: ProcessListing[] } | null> {
  const { data: workspace, error } = await db.from("workspaces").select("id, name, slug, settings").eq("slug", slug).maybeSingle();
  if (error) throw error;
  if (!workspace) return null;
  const everything = await listProcesses(db, workspace.id, { includeCompany });
  // The company map (the Editor and History open it by its id) is never in the list of processes to pick from.
  const all = everything.filter((p) => !p.is_company);
  // The default is a top-level process: a child process opens from the step that holds it, or from the list.
  const process = processId ? everything.find((p) => p.id === processId) : (all.find((p) => p.live_revision_id && !p.parent_process_id) ?? all.find((p) => p.live_revision_id));
  if (!process) return null;
  const processes = all.map((p) => ({ id: p.id, name: p.name, kind: p.kind, live: Boolean(p.live_revision_id), draft: Boolean(p.draft_revision_id), parentId: p.parent_process_id }));
  const { draft_revision_id: draftId, ...row } = process;
  if (!process.live_revision_id) {
    // Never published: only its draft exists.
    if (!draftId) return null;
    const drafted = await loadProcessBundle(db, workspace, row, draftId);
    return { live: unpublishedLive(drafted), draft: draft ? drafted : null, processes };
  }
  const [live, drafted] = await Promise.all([
    loadProcessBundle(db, workspace, row, process.live_revision_id),
    draft && draftId ? loadProcessBundle(db, workspace, row, draftId) : null,
  ]);
  return { live, draft: drafted, processes };
}

export const SCENARIO_COLUMNS = "id, workspace_id, name, description, patch, parent_scenario_id" as const;

/** A workspace's saved scenarios, oldest first. */
export async function loadScenarios(db: Db, workspaceId: string): Promise<ScenarioRow[]> {
  const r = await db.from("scenarios").select(SCENARIO_COLUMNS).eq("workspace_id", workspaceId).order("created_at").order("name");
  // The database checks patch's shape (private.is_scenario_patch).
  return rows(r) as unknown as ScenarioRow[];
}

export const BLOCK_COLUMNS = "id, workspace_id, name, description, type, steps, created_at, updated_at" as const;

/** A workspace's block library, oldest first. */
export async function loadBlocks(db: Db, workspaceId: string): Promise<BlockRow[]> {
  const r = await db.from("blocks").select(BLOCK_COLUMNS).eq("workspace_id", workspaceId).order("created_at").order("id");
  // The database checks that steps is an object with steps and edges arrays; type is check-constrained to BlockType.
  return (rows(r) ?? []) as unknown as BlockRow[];
}

export const ISSUE_COLUMNS =
  "id, workspace_id, process_id, step_id, role_id, person_id, client_id, type, severity, title, evidence, evidence_metrics, owner_person_id, status, scenario_id, source, detected_key, resolved_at, created_at, updated_at, number, dismissed_revision_id, resolution, target_measure, target_now, target_goal, resolved_how, resolved_solution_id, resolution_note" as const;

/** The history log's columns. */
export const ISSUE_EVENT_COLUMNS = "id, issue_id, workspace_id, seq, kind, at, actor, detail, tx" as const;

/** An `issues` row as stored: the status as the check allows it, and the resolution that tells Resolved from Won't fix. */
type IssueTableRow = Omit<IssueRow, "links" | "owner_ids" | "source_ids" | "status"> & { status: StoredIssueStatus; resolution: string | null };

/** Join issue rows from `issues` with what each links to, who owns it and its sources. */
/**
 * The sources an issue has, from the list an issue keeps (`issue_sources`, A47) and the links a source has to it
 * (`source_links`, A53): each source once, the issue's own list first. Triggers make a source in either appear in the other, but
 * a link made by a writer that only knows one of them (the Sources page, the MCP `link_source`) is read from here.
 */
export function unionIssueSources(
  listed: readonly { issue_id: string; source_id: string }[],
  linked: readonly { issue_id: string; source_id: string }[],
): { issue_id: string; source_id: string }[] {
  const seen = new Set<string>();
  const out: { issue_id: string; source_id: string }[] = [];
  for (const r of [...listed, ...linked]) {
    const key = `${r.issue_id}:${r.source_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ issue_id: r.issue_id, source_id: r.source_id });
    }
  }
  return out;
}

export function assembleIssues(
  issues: readonly IssueTableRow[],
  links: readonly { issue_id: string; process_id: string | null; step_id: string | null }[],
  owners: readonly { issue_id: string; person_id: string }[],
  sources: readonly { issue_id: string; source_id: string }[],
): IssueRow[] {
  const by = <T extends { issue_id: string }>(list: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const r of list) {
      const bucket = m.get(r.issue_id);
      if (bucket) bucket.push(r);
      else m.set(r.issue_id, [r]);
    }
    return m;
  };
  const l = by(links);
  const o = by(owners);
  const s = by(sources);
  return issues.map(({ resolution, status, ...i }) => ({
    ...i,
    // The new statuses are held as the old ones plus a resolution (issue-status.ts).
    status: uiStatus(status, resolution),
    // In the order they were added (the reads are ordered).
    links: (l.get(i.id) ?? []).map(({ process_id, step_id }) => ({ process_id, step_id })),
    owner_ids: (o.get(i.id) ?? []).map((r) => r.person_id),
    source_ids: (s.get(i.id) ?? []).map((r) => r.source_id),
  }));
}

/**
 * A workspace's tracked issues (manual and promoted, and dismissed insights too: callers leave those out with
 * `isVisibleIssue`), newest first, each with its links, owners and sources.
 */
export async function loadIssues(db: Db, workspaceId: string): Promise<IssueRow[]> {
  const [issues, links, owners, sources, linked] = await Promise.all([
    db.from("issues").select(ISSUE_COLUMNS).eq("workspace_id", workspaceId).order("created_at", { ascending: false }).order("id"),
    db.from("issue_links").select("issue_id, process_id, step_id").eq("workspace_id", workspaceId).order("created_at").order("id"),
    db.from("issue_owners").select("issue_id, person_id").eq("workspace_id", workspaceId).order("created_at").order("person_id"),
    db.from("issue_sources").select("issue_id, source_id").eq("workspace_id", workspaceId).order("created_at").order("source_id"),
    db.from("source_links").select("issue_id, source_id").eq("workspace_id", workspaceId).eq("kind", "issue").order("created_at").order("id"),
  ]);
  // Check constraints limit type, severity, status and source to IssueRow's unions.
  return assembleIssues(rows(issues) as unknown as IssueTableRow[], rows(links), rows(owners), unionIssueSources(rows(sources), rows(linked).flatMap((l) => (l.issue_id ? [{ issue_id: l.issue_id, source_id: l.source_id }] : []))));
}

/** One issue with its relations, or null if it isn't there (or isn't readable). */
export async function loadIssue(db: Db, workspaceId: string, issueId: string): Promise<IssueRow | null> {
  const [issues, links, owners, sources, linked] = await Promise.all([
    db.from("issues").select(ISSUE_COLUMNS).eq("workspace_id", workspaceId).eq("id", issueId),
    db.from("issue_links").select("issue_id, process_id, step_id").eq("issue_id", issueId).order("created_at").order("id"),
    db.from("issue_owners").select("issue_id, person_id").eq("issue_id", issueId).order("created_at").order("person_id"),
    db.from("issue_sources").select("issue_id, source_id").eq("issue_id", issueId).order("created_at").order("source_id"),
    db.from("source_links").select("issue_id, source_id").eq("issue_id", issueId).eq("kind", "issue").order("created_at").order("id"),
  ]);
  return assembleIssues(rows(issues) as unknown as IssueTableRow[], rows(links), rows(owners), unionIssueSources(rows(sources), rows(linked).flatMap((l) => (l.issue_id ? [{ issue_id: l.issue_id, source_id: l.source_id }] : []))))[0] ?? null;
}

/** An issue's history, oldest first. */
export async function loadIssueEvents(db: Db, workspaceId: string, issueId: string): Promise<IssueEventRow[]> {
  const r = await db.from("issue_events").select(ISSUE_EVENT_COLUMNS).eq("workspace_id", workspaceId).eq("issue_id", issueId).order("seq");
  return rows(r) as unknown as IssueEventRow[];
}

/**
 * Mark an issue resolved (A48), saying how and leaving a note, in one write: one `resolved` history entry that carries
 * both. Reopening is `save_issue` with status `open`, which clears them (the history keeps them).
 */
export async function resolveIssue(
  db: Db,
  args: { workspaceId: string; id: string; how: ResolveHow; note?: string | null; status?: "resolved" | "wont_fix"; solutionId?: string | null },
): Promise<{ id: string } | { error: { code?: string; message?: string } }> {
  const base = { p_workspace: args.workspaceId, p_id: args.id, p_how: args.how, p_status: args.status ?? "resolved" };
  // With a solution (A50) the six-argument function; without one the five-argument function, so resolving works with or without it.
  const { data, error } = args.solutionId
    ? await db.rpc("resolve_issue", { ...base, p_note: args.note ?? "", p_solution: args.solutionId })
    : await db.rpc("resolve_issue", { ...base, p_note: args.note ?? undefined });
  if (error) return { error };
  return { id: (data as { id: string }).id };
}

/** What `save_issue` takes: the columns to set, and the links, owners and sources to replace (omit to leave as they are). */
export interface SaveIssueArgs {
  workspaceId: string;
  /** Omit to create. */
  id?: string;
  fields: Record<string, Json | undefined>;
  links?: readonly IssueLinkRef[];
  owners?: readonly string[];
  sources?: readonly string[];
}

/** Create or edit an issue with its links, owners and sources in one transaction (one history entry). Returns the stored issue's id. */
export async function saveIssue(db: Db, args: SaveIssueArgs): Promise<{ id: string } | { error: { code?: string; message?: string } }> {
  const fields = Object.fromEntries(Object.entries(args.fields).filter(([, v]) => v !== undefined)) as Record<string, Json>;
  const { data, error } = await db.rpc("save_issue", {
    p_workspace: args.workspaceId,
    ...(args.id ? { p_id: args.id } : {}),
    p_fields: fields,
    ...(args.links ? { p_links: args.links as unknown as Json } : {}),
    ...(args.owners ? { p_owners: [...args.owners] } : {}),
    ...(args.sources ? { p_sources: [...args.sources] } : {}),
  });
  if (error) return { error };
  return { id: (data as { id: string }).id };
}

/**
 * Each process's live revision id (processes never published are left out). A dismissed insight is hidden only until
 * its process's live revision changes, so the screens that list insights compare against this (`isDismissalCurrent`).
 */
export async function loadLiveRevisionIds(db: Db, workspaceId: string): Promise<Record<string, string>> {
  const r = await db.from("processes").select("id, live_revision_id").eq("workspace_id", workspaceId).eq("is_company", false);
  return Object.fromEntries(rows(r).flatMap((p) => (p.live_revision_id ? [[p.id, p.live_revision_id]] : [])));
}

/** The `SourceRow` columns. */
export const SOURCE_COLUMNS = "id, workspace_id, kind, title, speakers, recorded_at, body, file_url, created_at, updated_at" as const;

/** The workspace's sources, most recent first (RLS: everyone in the workspace can read them). */
export async function loadSources(db: Db, workspaceId: string): Promise<SourceRow[]> {
  const r = await db
    .from("sources")
    .select(SOURCE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("recorded_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .order("id");
  // The check constraint limits kind to SourceRow's union.
  return rows(r) as unknown as SourceRow[];
}

/** The `SourceLinkRow` columns. */
export const SOURCE_LINK_COLUMNS = "id, workspace_id, source_id, kind, process_id, step_id, insight_key, issue_id, solution_id, created_at, created_by" as const;

/** What every source of the workspace is linked to, oldest link first (RLS: everyone in the workspace can read them). */
export async function loadSourceLinks(db: Db, workspaceId: string): Promise<SourceLinkRow[]> {
  const r = await db.from("source_links").select(SOURCE_LINK_COLUMNS).eq("workspace_id", workspaceId).order("created_at").order("id");
  // The check constraint limits kind to SourceLinkRow's union.
  return rows(r) as unknown as SourceLinkRow[];
}

/** The names of steps by their stable ids, from whichever version holds them (the latest written wins). For links to steps that are in no current version. */
export async function loadStepNames(db: Db, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  // In batches: every id goes into the request's URL, which PostgREST limits.
  for (let i = 0; i < ids.length; i += 100) {
    const r = await db.from("steps").select("id, name, updated_at").in("id", ids.slice(i, i + 100)).order("updated_at", { ascending: false });
    for (const s of rows(r)) if (!seen.has(s.id)) out.push({ id: s.id, name: (seen.add(s.id), s.name) });
  }
  return out;
}

/**
 * What a source can be linked to (issue #118): the processes, the steps of each one's live version (its draft if it was
 * never published), and the issues, insights and solutions, as the pickers list them. An insight here is a detection the
 * team has acted on (an issue with a detection key); a dismissed one is left out. RLS decides what is visible.
 */
export async function loadLinkTargets(db: Db, workspaceId: string): Promise<LinkTargets> {
  const processes = await listProcesses(db, workspaceId);
  const revisions = processes.flatMap((p) => {
    const id = p.live_revision_id ?? p.draft_revision_id;
    return id ? [id] : [];
  });
  const [steps, issues, solutions] = await Promise.all([
    revisions.length ? db.from("steps").select("id, name, process_id, replaced_by").in("revision_id", revisions).order("created_at").order("id") : Promise.resolve({ data: [], error: null }),
    db.from("issues").select("id, number, title, status, detected_key").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).order("id"),
    db.from("solutions").select("id, name").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).order("id"),
  ]);
  const seen = new Set<string>();
  const live = rows(issues).filter((i) => i.status !== "dismissed");
  return {
    processes: processes.map((p) => ({ id: p.id, name: p.name })),
    steps: rows(steps).flatMap((s) => (s.replaced_by.length === 0 && !seen.has(s.id) && seen.add(s.id) ? [{ id: s.id, processId: s.process_id, name: s.name }] : [])),
    insights: live.flatMap((i) => (i.detected_key ? [{ key: i.detected_key, title: i.title }] : [])),
    issues: live.map((i) => ({ id: i.id, number: i.number, title: i.title })),
    solutions: rows(solutions).map((s) => ({ id: s.id, name: s.name })),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Every row of the workspace that can cite a source: the steps of each
 * process's live revision and open draft, and the demand rows. For the Sources
 * page's "what cites this" (evidence.ts `citationsBySource`).
 */
export async function loadCitingRows(db: Db, workspaceId: string): Promise<CitingRow[]> {
  const processes = await listProcesses(db, workspaceId);
  const revisions = new Map<string, "live" | "draft">();
  for (const p of processes) {
    if (p.live_revision_id) revisions.set(p.live_revision_id, "live");
    if (p.draft_revision_id) revisions.set(p.draft_revision_id, "draft");
  }
  const [steps, leadSources, seasonality, demand] = await Promise.all([
    revisions.size
      ? db.from("steps").select("id, name, process_id, revision_id, provenance, replaced_by").in("revision_id", [...revisions.keys()])
      : Promise.resolve({ data: [], error: null }),
    db.from("lead_sources").select("id, name, provenance").eq("workspace_id", workspaceId),
    db.from("seasonality").select("id, month, provenance").eq("workspace_id", workspaceId),
    db.from("demand_settings").select("workspace_id, provenance").eq("workspace_id", workspaceId),
  ]);
  return [
    // Retired steps (split or replaced, issue #16) are no longer part of the process.
    ...partitionSteps(rows(steps)).steps.map((s) => ({
      table: "steps",
      id: s.id,
      name: s.name,
      processId: s.process_id,
      revision: revisions.get(s.revision_id)!,
      provenance: s.provenance,
    })),
    ...rows(leadSources).map((l) => ({ table: "lead_sources", id: l.id, name: l.name, provenance: l.provenance })),
    ...rows(seasonality).map((m) => ({
      table: "seasonality",
      id: m.id,
      name: `Seasonality: ${MONTHS[m.month - 1] ?? m.month}`,
      provenance: m.provenance,
    })),
    ...rows(demand).map((d) => ({ table: "demand_settings", id: d.workspace_id, name: "Demand growth", provenance: d.provenance })),
  ];
}

// ---------------------------------------------------------------------------
// Company model, suggestions and saved runs (issue #25)
// ---------------------------------------------------------------------------

const PERSON_COLUMNS = "id, workspace_id, name, fte, capacity_hours_week, cost_rate, active, start_date, end_date, provenance" as const;

/** The workspace's company model: roles, people, services, clients and demand, with provenance. */
export async function loadCompanyModel(
  db: Db,
  workspace: Pick<WorkspaceRow, "id" | "name" | "slug"> & { settings: unknown; provenance?: unknown },
): Promise<CompanyModel> {
  const ws = workspace.id;
  const [roles, people, personRoles, personLeave, services, leadSources, seasonality, demand, roster] = await Promise.all([
    db.from("roles").select("*").eq("workspace_id", ws).order("name"),
    db.from("people").select(PERSON_COLUMNS).eq("workspace_id", ws).order("name"),
    db.from("person_roles").select("person_id, role_id, workspace_id").eq("workspace_id", ws),
    db.from("person_leave").select("id, person_id, workspace_id, start_date, end_date").eq("workspace_id", ws),
    db.from("services").select(`${SERVICE_COLUMNS}, provenance`).eq("workspace_id", ws).order("name"),
    db.from("lead_sources").select(LEAD_SOURCE_COLUMNS).eq("workspace_id", ws).order("created_at").order("id"),
    db.from("seasonality").select(SEASONALITY_COLUMNS).eq("workspace_id", ws).order("month"),
    db.from("demand_settings").select(DEMAND_SETTINGS_COLUMNS).eq("workspace_id", ws).maybeSingle(),
    loadClients(db, ws),
  ]);
  // The casts give jsonb columns (settings, provenance) their shapes and narrow check-constrained text.
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      settings: workspace.settings as WorkspaceSettings,
      ...(workspace.provenance ? { provenance: workspace.provenance as ProvenanceMap } : {}),
    },
    roles: rows(roles) ?? [],
    people: (rows(people) ?? []) as PersonRow[],
    personRoles: rows(personRoles) ?? [],
    personLeave: rows(personLeave) ?? [],
    services: (rows(services) ?? []) as ServiceRow[],
    leadSources: (rows(leadSources) ?? []) as LeadSourceRow[],
    seasonality: (rows(seasonality) ?? []) as SeasonalityRow[],
    demand: rows(demand) as DemandSettingsRow | null,
    ...roster,
  };
}

/** Each process's live revision (for run snapshots and "model changed since this run"). */
export async function loadLiveRevisions(db: Db, workspaceId: string): Promise<SnapshotProcess[]> {
  const processes = await listProcesses(db, workspaceId);
  const ids = processes.flatMap((p) => (p.live_revision_id ? [p.live_revision_id] : []));
  if (!ids.length) return [];
  const revisions = rows(await db.from("process_revisions").select("id, number").in("id", ids));
  return processes.flatMap((p) => {
    const r = revisions.find((x) => x.id === p.live_revision_id);
    return r ? [{ id: p.id, name: p.name, revision_id: r.id, revision: r.number }] : [];
  });
}

export const SUGGESTION_ROW_COLUMNS =
  "id, workspace_id, target_table, target_id, patch, evidence, note, status, created_via, import_source, applied, review_note, reviewed_by, reviewed_at, created_at, created_by" as const;

/** The workspace's suggestions, newest first; optionally only one status. */
export async function loadSuggestions(db: Db, workspaceId: string, status?: SuggestionStatus): Promise<SuggestionRow[]> {
  let q = db.from("suggestions").select(SUGGESTION_ROW_COLUMNS).eq("workspace_id", workspaceId);
  if (status) q = q.eq("status", status);
  const r = await q.order("created_at", { ascending: false }).order("id").limit(500);
  // Check constraints limit the text columns; patch, evidence and applied are jsonb.
  return rows(r) as unknown as SuggestionRow[];
}

export const RUN_COLUMNS =
  "id, workspace_id, process_id, name, scenario_id, revision_ids, engine_version, reps, seed, params_snapshot, results, duration_ms, created_at, created_by" as const;

/** The workspace's saved runs, newest first. */
export async function loadRuns(db: Db, workspaceId: string): Promise<RunRow[]> {
  const r = await db
    .from("runs")
    .select(RUN_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .order("id")
    .limit(200);
  // params_snapshot and results are jsonb; RunRow gives them their shapes.
  return rows(r) as unknown as RunRow[];
}

/** One saved run, or null if it isn't visible. */
export async function loadRun(db: Db, id: string): Promise<RunRow | null> {
  const r = await db.from("runs").select(RUN_COLUMNS).eq("id", id).maybeSingle();
  return rows(r) as unknown as RunRow | null;
}

export const SOLUTION_COLUMNS = "id, workspace_id, process_id, base_revision_id, name, notes, steps, changed_step_ids, lever_changes, created_at, updated_at, created_by" as const;
export const SOLUTION_ISSUE_COLUMNS = "solution_id, issue_id, workspace_id, auto_verdict, holds_pct, auto_note, user_verdict, user_notes, created_at, updated_at, created_by" as const;

/** A workspace's solutions, newest first: optionally only those that change one process. */
export async function loadSolutions(db: Db, workspaceId: string, processId?: string): Promise<SolutionRow[]> {
  let q = db.from("solutions").select(SOLUTION_COLUMNS).eq("workspace_id", workspaceId);
  if (processId) q = q.eq("process_id", processId);
  const r = await q.order("created_at", { ascending: false }).order("id");
  // The database checks the shapes of steps, changed_step_ids and lever_changes.
  return (rows(r) ?? []) as unknown as SolutionRow[];
}

/** The issues each of a workspace's solutions solves, with their verdicts. */
export async function loadSolutionIssues(db: Db, workspaceId: string): Promise<SolutionIssueRow[]> {
  const r = await db.from("solution_issues").select(SOLUTION_ISSUE_COLUMNS).eq("workspace_id", workspaceId).order("created_at").order("issue_id");
  return (rows(r) ?? []) as unknown as SolutionIssueRow[];
}
