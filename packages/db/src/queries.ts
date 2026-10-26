import type { LinkTargets } from "./source-links";
import { sql, type Kysely } from "kysely";
import type { DB } from "./db-types";
import { rpc, rpcRows } from "./rpc";
import { columns } from "./columns";
import { pgCode } from "./pg-error";
import { shareToggles } from "./share-reader";
import type { Json } from "./db-types";
import type { CompanyModel, SnapshotProcess } from "./company";
import type { CitingRow } from "./evidence";
import { uiStatus, type StoredIssueStatus } from "./issue-status";
import { hideAiIssueKey } from "./person-labels";
import { partitionSteps } from "./retired";
import type { RunRow } from "./runs";
import type {
  BlockRow,
  ForecastPlanRow,
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
  PersonCapacityFactorRow,
  PersonLeaveRow,
  PersonRoleRow,
  PersonRow,
  PersonSkillRow,
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
  SourceKind,
  SourceListRow,
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

export type Db = Kysely<DB>;

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
  revisionId?: string,
): Promise<{ servicingLinks: ServiceServicingRow[]; otherProcesses: ProcessPart[] }> {
  const [processes, links, heldHere] = await Promise.all([
    listProcesses(db, workspaceId),
    db.selectFrom("service_servicing").select(columns(SERVICE_SERVICING_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("id").execute(),
    // The processes this revision links to (a draft may hold one its live version does not yet: B12).
    revisionId ? db.selectFrom("steps").select("child_process_id").where("revision_id", "=", revisionId).where("child_process_id", "is not", null).execute() : [],
  ]);
  const live = processes.filter((p) => p.id !== process.id && p.live_revision_id);
  // A child process runs inside its parent, so it is never the pipeline a servicing process runs beside.
  const pipeline = process.kind === "servicing" ? live.find((p) => p.kind !== "servicing" && !p.parent_process_id) : undefined;
  const base = live.filter((p) => p.kind === "servicing" || p === pipeline);
  // The child processes (any depth) of this process and of those, which the steps holding them are simulated through.
  const reached = new Set([process.id, ...base.map((p) => p.id)]);
  const children: typeof live = [];
  for (const h of heldHere as { child_process_id: string | null }[]) {
    const p = live.find((x) => x.id === h.child_process_id);
    if (p && !reached.has(p.id)) {
      reached.add(p.id);
      children.push(p);
    }
  }
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
        db.selectFrom("process_revisions").select(["id", "workspace_id", "process_id", "number", "status"]).where("id", "in", revisionIds).execute(),
        db.selectFrom("steps").selectAll().where("revision_id", "in", revisionIds).execute(),
        db.selectFrom("edges").selectAll().where("revision_id", "in", revisionIds).execute(),
      ])
    : [[], [], []];
  const stepRows = steps as unknown as StepRow[];
  const edgeRows = edges as unknown as EdgeRow[];
  const revisionRows = revisions as ProcessRevisionRow[];
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
  return { servicingLinks: links as unknown as ServiceServicingRow[], otherProcesses };
}

/** The `ClientRow`, `ClientServiceRow` and `ClientAssignmentRow` columns. */
export const CLIENT_COLUMNS = "id, workspace_id, name, start_date, mrr, health, provenance, notes, active" as const;
export const CLIENT_SERVICE_COLUMNS = "client_id, service_id, workspace_id, start_date" as const;
export const CLIENT_ASSIGNMENT_COLUMNS = "client_id, role_id, person_id, workspace_id" as const;

/** Who is looking: whether they see every person, and the person record linked to their membership (B1 2/3). */
export interface Viewer {
  seesEveryone: boolean;
  ownPersonId: string | null;
}

/** The whole team's simulation inputs, as `public.team_capacity` gives them to the caller (B1 2/3). */
export interface TeamInputs {
  viewer: Viewer;
  people: PersonRow[];
  personRoles: PersonRoleRow[];
  personSkills: PersonSkillRow[];
  personLeave: PersonLeaveRow[];
  clientAssignments: ClientAssignmentRow[];
  /** Per-person times (C6): everyone's for those who see everyone, only the caller's own person's otherwise; none from `share_team_capacity`. */
  personCapacityFactors: PersonCapacityFactorRow[];
}

/**
 * The whole team's simulation inputs, as `public.team_capacity` gives them to the caller: the stored values for owners,
 * editors and agency admins; for members and viewers, "Team member N" labels (their own person keeps their name) and a null cost rate for everyone but
 * themselves: no pay, and no average of it. Never email, notes, leave notes or skill efficiency. Per-person times (C6) come the same
 * way: everyone's for those who see everyone, only the caller's own otherwise. A bundle's per-person times must come only from
 * here: reading `person_capacity_factors` directly would bypass `shareReaderDb` and put an editor's times into a share snapshot.
 */
export async function loadTeam(db: Db, workspaceId: string): Promise<TeamInputs> {
  // A share link reads through `shareReaderDb`, which swaps in `share_team_capacity` (labels or names, no pay, no times).
  const toggles = shareToggles.get(db);
  const data = toggles ? await rpc(db, "share_team_capacity", { ws: workspaceId, show_people: toggles.people }) : await rpc(db, "team_capacity", { ws: workspaceId });
  // The function's documented shape (migration 20261207500000): sees_everyone, own_person_id and one array per table, in
  // the columns of PersonRow, PersonRoleRow, PersonSkillRow, PersonLeaveRow and ClientAssignmentRow.
  const t = data as unknown as {
    sees_everyone: boolean;
    own_person_id: string | null;
    people: PersonRow[];
    person_roles: PersonRoleRow[];
    person_skills: PersonSkillRow[];
    person_leave: PersonLeaveRow[];
    client_assignments: ClientAssignmentRow[];
    person_capacity_factors?: PersonCapacityFactorRow[];
  };
  return {
    viewer: { seesEveryone: t.sees_everyone, ownPersonId: t.own_person_id },
    people: t.people,
    personRoles: t.person_roles,
    personSkills: t.person_skills,
    personLeave: t.person_leave,
    clientAssignments: t.client_assignments,
    // numeric comes back as a number from jsonb; `share_team_capacity` has no such key, so a link's team has none.
    personCapacityFactors: (t.person_capacity_factors ?? []).map((r) => ({ ...r, factor: Number(r.factor), items: r.items == null ? null : Number(r.items) })),
  };
}

/**
 * A workspace's client roster: clients by name, their services and assignments. Pass `team` when the caller has already
 * loaded it, so `team_capacity` runs once.
 */
export async function loadClients(
  db: Db,
  workspaceId: string,
  team?: TeamInputs,
): Promise<{ clients: ClientRow[]; clientServices: ClientServiceRow[]; clientAssignments: ClientAssignmentRow[] }> {
  const [clients, clientServices, clientAssignments] = await Promise.all([
    db.selectFrom("clients").select(columns(CLIENT_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("name").orderBy("id").execute(),
    db.selectFrom("client_services").select(columns(CLIENT_SERVICE_COLUMNS)).where("workspace_id", "=", workspaceId).execute(),
    team ? team.clientAssignments : loadTeam(db, workspaceId).then((t) => t.clientAssignments),
  ]);
  return {
    // provenance is jsonb; ClientRow gives it its shape.
    clients: clients as unknown as ClientRow[],
    clientServices,
    clientAssignments,
  };
}

/** The `ClientGroupRow` columns. */
export const CLIENT_GROUP_COLUMNS = "id, workspace_id, service_id, client_count, fee, churn_monthly, stay_months, starting_health, provenance" as const;

/** A workspace's client groups (clients counted per service), by creation order. */
export async function loadClientGroups(db: Db, workspaceId: string): Promise<ClientGroupRow[]> {
  const r = await db.selectFrom("client_groups").select(columns(CLIENT_GROUP_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("id").execute();
  // provenance is jsonb; ProvenanceMap is its app-side shape.
  return r as unknown as ClientGroupRow[];
}

/** The `ChurnDriverRow` columns. */
export const CHURN_DRIVER_COLUMNS = "id, workspace_id, driver, name, description, example, weight, enabled, value, month, provenance" as const;

/** The churn drivers a workspace has set, built-ins first (by creation order), then its own by name. */
export async function loadChurnDrivers(db: Db, workspaceId: string): Promise<ChurnDriverRow[]> {
  const r = await db.selectFrom("churn_drivers").select(columns(CHURN_DRIVER_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("id").execute();
  // driver is check-constrained to ChurnDriverKey; provenance is jsonb.
  return r as unknown as ChurnDriverRow[];
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
    db.selectFrom("market_conditions").select(columns(MARKET_CONDITION_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("market_schedule").select(columns(MARKET_SCHEDULE_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("from_month").orderBy("id").execute(),
  ]);
  return {
    // preset is check-constrained to MarketPreset.
    marketConditions: conditions as unknown as MarketConditionRow[],
    marketSchedule: schedule,
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
  // People, roles held, skills, leave and assignments: the stored rows for editors, labels and no pay for members.
  const teamLoad = loadTeam(db, ws);
  const [revision, roles, steps, edges, team, services, leadSources, seasonality, demand, roster, clientGroups, churnDrivers, servicing, market, settingsProvenance] =
    await Promise.all([
      db.selectFrom("process_revisions").select(["id", "workspace_id", "process_id", "number", "status"]).where("id", "=", revisionId).executeTakeFirstOrThrow(),
      db.selectFrom("roles").selectAll().where("workspace_id", "=", ws).execute(),
      db.selectFrom("steps").selectAll().where("revision_id", "=", revisionId).execute(),
      db.selectFrom("edges").selectAll().where("revision_id", "=", revisionId).execute(),
      teamLoad,
      // Services' and settings' provenance: the robustness check perturbs only estimated values (issue #79).
      db.selectFrom("services").select([...columns(SERVICE_COLUMNS), "provenance"]).where("workspace_id", "=", ws).execute(),
      db.selectFrom("lead_sources").select(columns(LEAD_SOURCE_COLUMNS)).where("workspace_id", "=", ws).execute(),
      db.selectFrom("seasonality").select(columns(SEASONALITY_COLUMNS)).where("workspace_id", "=", ws).execute(),
      db.selectFrom("demand_settings").select(columns(DEMAND_SETTINGS_COLUMNS)).where("workspace_id", "=", ws).executeTakeFirst(),
      teamLoad.then((t) => loadClients(db, ws, t)),
      loadClientGroups(db, ws),
      loadChurnDrivers(db, ws),
      // The company map runs nothing: it needs no other processes (the Editor draws its cards from the live processes it is given).
      process.is_company ? { servicingLinks: [], otherProcesses: [] } : loadServicingContext(db, ws, process, revisionId),
      loadMarket(db, ws),
      db.selectFrom("workspaces").select("provenance").where("id", "=", ws).executeTakeFirst(),
    ]);
  const wsProvenance = settingsProvenance?.provenance;

  // Split or replaced steps stay in the revision for scenarios to re-point, never drawn or simulated (./retired.ts).
  const { steps: inUse, retired } = partitionSteps(steps as unknown as StepRow[]);
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
    revision: revision as ProcessRevisionRow,
    roles,
    steps: inUse,
    retired,
    edges: edges as unknown as EdgeRow[],
    people: team.people,
    personRoles: team.personRoles,
    personSkills: team.personSkills,
    personLeave: team.personLeave,
    personCapacityFactors: team.personCapacityFactors,
    viewer: team.viewer,
    // pricing_model is check-constrained; fallback_ongoing_load is jsonb.
    services: services as unknown as ServiceRow[],
    // Provenance is jsonb; LeadSourceRow and the others give it its shape.
    leadSources: leadSources as unknown as LeadSourceRow[],
    seasonality: seasonality as unknown as SeasonalityRow[],
    demand: (demand ?? null) as DemandSettingsRow | null,
    ...roster,
    clientGroups,
    churnDrivers,
    ...servicing,
    ...market,
  };
}

const PROCESS_COLUMNS = "id, workspace_id, name, kind, entity_name, description, live_revision_id, parent_process_id, is_company, archived_at" as const;

/** Where a process sits: the process whose LIVE version holds it by a link (B12, ADR 0014). */
export interface Placement {
  /** The placed process. */
  processId: string;
  holderId: string;
  holderName: string;
  /** The holder is the company map: the process is "on the map", top level. */
  holderIsCompany: boolean;
}

/**
 * Every link in a live version of the workspace's processes, from `public.process_placements`: which process holds which. A
 * process is held in at most one live version (the database refuses a second on publish), so this is where each one sits.
 */
export async function listPlacements(db: Db, workspaceId: string): Promise<Placement[]> {
  const r = await db
    .selectFrom("process_placements")
    .select(["process_id", "holder_process_id", "holder_name", "holder_is_company"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("process_id")
    .orderBy("holder_process_id")
    .execute();
  return r.flatMap((p) =>
    p.process_id && p.holder_process_id ? [{ processId: p.process_id, holderId: p.holder_process_id, holderName: p.holder_name ?? "", holderIsCompany: p.holder_is_company === true }] : [],
  );
}

/**
 * A workspace's processes, oldest first. The company map (a stored process whose steps hold the top-level processes,
 * B11) is not one of them unless `includeCompany` is set: it is never simulated, listed as an ordinary process or
 * counted.
 *
 * `parent_process_id` is DERIVED here, not read from the column (B12, ADR 0014): it is the process whose live version holds
 * this one by a link, or null when none does or the holder is the company map (top level). So "inside" means the same in the
 * app, the simulation and MCP: what the published versions say. The stored column is legacy and no longer read.
 */
export async function listProcesses(
  db: Db,
  workspaceId: string,
  { includeCompany = false, includeArchived = false }: { includeCompany?: boolean; includeArchived?: boolean } = {},
): Promise<(ProcessRow & { draft_revision_id: string | null; archived_at: string | null })[]> {
  let q = db.selectFrom("processes").select([...columns(PROCESS_COLUMNS), "draft_revision_id"]).where("workspace_id", "=", workspaceId);
  if (!includeCompany) q = q.where("is_company", "=", false);
  // An archived process (B19, migration 20261204000000) is off every list, the map and the simulation until it is restored.
  if (!includeArchived) q = q.where("archived_at", "is", null);
  const [r, placements] = await Promise.all([q.orderBy("created_at").orderBy("id").execute(), listPlacements(db, workspaceId)]);
  const parentOf = new Map(placements.filter((p) => !p.holderIsCompany).map((p) => [p.processId, p.holderId]));
  return (r as unknown as (ProcessRow & { draft_revision_id: string | null; archived_at: string | null })[]).map((p) => ({ ...p, parent_process_id: parentOf.get(p.id) ?? null }));
}

/**
 * The workspace's company map at its live revision: the process, and its steps (one holder per process on the map, at
 * its stored position) and edges (the handoff lines). Null if the workspace has none or it isn't visible. Layout only:
 * nothing here is simulated.
 */
export async function loadLiveCompanyPart(db: Db, workspaceId: string): Promise<ProcessPart | null> {
  return loadCompanyPartAt(db, workspaceId, null);
}

/**
 * The workspace's company map process id, or null if it has none or it isn't visible (RLS: everyone in the workspace
 * reads `processes`). For the pages that stand in for the company map's own URLs.
 */
export async function loadCompanyProcessId(db: Db, workspaceId: string): Promise<string | null> {
  const r = await db.selectFrom("processes").select("id").where("workspace_id", "=", workspaceId).where("is_company", "=", true).executeTakeFirst();
  return r?.id ?? null;
}

/** What the start page ticks from: cheap counts of a workspace's set-up (editors only; members and viewers are never sent them). */
export interface SetupCounts {
  roles: number;
  people: number;
  clients: number;
  clientGroups: number;
  /** Ordinary, unarchived processes (the company map is not one). */
  processes: number;
  /** Those with a live revision. */
  published: number;
  companyId: string | null;
}

/** Counts for the start page's checklist, as the caller of `db` (RLS decides what it can count). Throws on a read error. */
export async function loadSetupCounts(db: Db, workspaceId: string): Promise<SetupCounts> {
  const count = async (table: "roles" | "people" | "clients" | "client_groups") =>
    Number((await db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as("count")).where("workspace_id", "=", workspaceId).executeTakeFirstOrThrow()).count);
  const ordinary = () =>
    db
      .selectFrom("processes")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .where("is_company", "=", false)
      .where("archived_at", "is", null);
  const [roles, people, clients, clientGroups, processes, published, companyId] = await Promise.all([
    count("roles"),
    count("people"),
    count("clients"),
    count("client_groups"),
    ordinary().executeTakeFirstOrThrow(),
    ordinary().where("live_revision_id", "is not", null).executeTakeFirstOrThrow(),
    loadCompanyProcessId(db, workspaceId),
  ]);
  return {
    roles,
    people,
    clients,
    clientGroups,
    processes: Number(processes.count),
    published: Number(published.count),
    companyId,
  };
}

/**
 * Every process of the workspace at its live revision, for the Overview's company map (issue #100): the pipelines, the
 * servicing processes and the child processes, in creation order. Processes never published aren't on the map. As the
 * caller of `db` (RLS decides what is visible); a share link's snapshot (B3) builds it with the same function.
 */
export async function loadLiveParts(db: Db, workspaceId: string): Promise<ProcessPart[]> {
  const live = (await listProcesses(db, workspaceId)).filter((p) => p.live_revision_id);
  const ids = live.map((p) => p.live_revision_id!);
  if (!ids.length) return [];
  const [revisions, steps, edges] = await Promise.all([
    db.selectFrom("process_revisions").select(["id", "workspace_id", "process_id", "number", "status"]).where("id", "in", ids).execute(),
    db.selectFrom("steps").selectAll().where("revision_id", "in", ids).execute(),
    db.selectFrom("edges").selectAll().where("revision_id", "in", ids).execute(),
  ]);
  const parts: ProcessPart[] = [];
  for (const p of live) {
    const revision = (revisions as ProcessRevisionRow[]).find((r) => r.id === p.live_revision_id);
    if (!revision) continue;
    const { draft_revision_id, ...process } = p;
    void draft_revision_id;
    parts.push({
      process,
      revision,
      // Split or replaced steps are never drawn or simulated.
      steps: partitionSteps((steps as unknown as StepRow[]).filter((s) => s.revision_id === revision.id)).steps,
      edges: (edges as unknown as EdgeRow[]).filter((e) => e.revision_id === revision.id),
    });
  }
  return parts;
}

/**
 * The company map as it was at published version `number` (live or earlier), for viewing it read only. Null when the workspace
 * has no company map, it isn't visible, or `number` is not a published version of it: a draft, a number only another process
 * has, or one from another workspace all read as not found.
 */
export async function loadCompanyPartVersion(db: Db, workspaceId: string, number: number): Promise<ProcessPart | null> {
  return loadCompanyPartAt(db, workspaceId, number);
}

async function loadCompanyPartAt(db: Db, workspaceId: string, number: number | null): Promise<ProcessPart | null> {
  const found = await db
    .selectFrom("processes")
    .select([...columns(PROCESS_COLUMNS), "draft_revision_id"])
    .where("workspace_id", "=", workspaceId)
    .where("is_company", "=", true)
    .executeTakeFirst();
  const company = (found ?? null) as unknown as (ProcessRow & { draft_revision_id: string | null }) | null;
  if (!company?.live_revision_id) return null;
  const revisionQuery = db.selectFrom("process_revisions").select(["id", "workspace_id", "process_id", "number", "status"]);
  const revision =
    number === null
      ? await revisionQuery.where("id", "=", company.live_revision_id).executeTakeFirst()
      : await revisionQuery.where("process_id", "=", company.id).where("number", "=", number).where("status", "in", ["published", "superseded"]).executeTakeFirst();
  if (!revision) return null;
  const [steps, edges] = await Promise.all([
    db.selectFrom("steps").selectAll().where("revision_id", "=", revision.id).orderBy("y").orderBy("x").orderBy("id").execute(),
    db.selectFrom("edges").selectAll().where("revision_id", "=", revision.id).orderBy("id").execute(),
  ]);
  const { draft_revision_id: _draft, ...process } = company;
  return {
    process,
    revision: revision as ProcessRevisionRow,
    steps: steps as unknown as StepRow[],
    edges: edges as unknown as EdgeRow[],
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
  const workspace = await db.selectFrom("workspaces").select(["id", "name", "slug", "settings"]).where("slug", "=", slug).executeTakeFirst();
  if (!workspace) return null;
  // An archived process still opens by its id (its history is kept), but is never in the list or the default.
  const everything = await listProcesses(db, workspace.id, { includeCompany, includeArchived: Boolean(processId) });
  // The company map (the Editor and History open it by its id) is never in the list of processes to pick from.
  const all = everything.filter((p) => !p.is_company && !p.archived_at);
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
  const r = await db.selectFrom("scenarios").select(columns(SCENARIO_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("name").execute();
  // The database checks patch's shape (private.is_scenario_patch).
  return r as unknown as ScenarioRow[];
}

export const BLOCK_COLUMNS = "id, workspace_id, name, description, type, steps, created_at, updated_at" as const;

/** A workspace's block library, oldest first. */
export async function loadBlocks(db: Db, workspaceId: string): Promise<BlockRow[]> {
  const r = await db.selectFrom("blocks").select(columns(BLOCK_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("id").execute();
  // The database checks that steps is an object with steps and edges arrays; type is check-constrained to BlockType.
  return r as unknown as BlockRow[];
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
    db.selectFrom("issues").select(columns(ISSUE_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").execute(),
    db.selectFrom("issue_links").select(["issue_id", "process_id", "step_id"]).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("issue_owners").select(["issue_id", "person_id"]).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("person_id").execute(),
    db.selectFrom("issue_sources").select(["issue_id", "source_id"]).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("source_id").execute(),
    db.selectFrom("source_links").select(["issue_id", "source_id"]).where("workspace_id", "=", workspaceId).where("kind", "=", "issue").orderBy("created_at").orderBy("id").execute(),
  ]);
  // Check constraints limit type, severity, status and source to IssueRow's unions.
  return assembleIssues(issues as unknown as IssueTableRow[], links, owners, unionIssueSources(sources, linked.flatMap((l) => (l.issue_id ? [{ issue_id: l.issue_id, source_id: l.source_id }] : []))));
}

/**
 * Whether the caller sees every person (`can_see_people`: owners, editors, agency admins). Fails closed: an error reads as
 * "no", so the caller gets the less revealing view.
 */
export async function readerSeesPeople(db: Db, workspaceId: string): Promise<boolean> {
  // A share link answers with its People toggle (see `shareReaderDb`).
  const toggles = shareToggles.get(db);
  if (toggles) return toggles.people;
  try {
    return (await rpc(db, "can_see_people", { ws: workspaceId })) === true;
  } catch {
    return false;
  }
}

/**
 * `loadIssues` for a page or tool that shows issues to whoever is signed in: a reader who doesn't see everyone gets an
 * opaque `detected_key` where the stored one is a hash of AI text (see `hideAiIssueKey`). Use `loadIssues` where the
 * caller needs the stored key (editors' save paths, matching keys server-side).
 */
export async function loadIssuesForReader(db: Db, workspaceId: string): Promise<IssueRow[]> {
  const [issues, sees] = await Promise.all([loadIssues(db, workspaceId), readerSeesPeople(db, workspaceId)]);
  return sees ? issues : issues.map((i) => hideAiIssueKey(i, false));
}

/** A thrown database error as the `{ code, message }` that PostgREST's `error` had. */
function errorOf(e: unknown): { code?: string; message?: string } {
  return { code: pgCode(e), message: e instanceof Error ? e.message : String(e) };
}

/** One issue with its relations, or null if it isn't there (or isn't readable). */
export async function loadIssue(db: Db, workspaceId: string, issueId: string): Promise<IssueRow | null> {
  const [issues, links, owners, sources, linked] = await Promise.all([
    db.selectFrom("issues").select(columns(ISSUE_COLUMNS)).where("workspace_id", "=", workspaceId).where("id", "=", issueId).execute(),
    db.selectFrom("issue_links").select(["issue_id", "process_id", "step_id"]).where("issue_id", "=", issueId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("issue_owners").select(["issue_id", "person_id"]).where("issue_id", "=", issueId).orderBy("created_at").orderBy("person_id").execute(),
    db.selectFrom("issue_sources").select(["issue_id", "source_id"]).where("issue_id", "=", issueId).orderBy("created_at").orderBy("source_id").execute(),
    db.selectFrom("source_links").select(["issue_id", "source_id"]).where("issue_id", "=", issueId).where("kind", "=", "issue").orderBy("created_at").orderBy("id").execute(),
  ]);
  return assembleIssues(issues as unknown as IssueTableRow[], links, owners, unionIssueSources(sources, linked.flatMap((l) => (l.issue_id ? [{ issue_id: l.issue_id, source_id: l.source_id }] : []))))[0] ?? null;
}

/** An issue's history, oldest first. */
export async function loadIssueEvents(db: Db, workspaceId: string, issueId: string): Promise<IssueEventRow[]> {
  const r = await db.selectFrom("issue_events").select(columns(ISSUE_EVENT_COLUMNS)).where("workspace_id", "=", workspaceId).where("issue_id", "=", issueId).orderBy("seq").execute();
  return r as unknown as IssueEventRow[];
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
  try {
    const data = args.solutionId
      ? await rpc(db, "resolve_issue", { ...base, p_note: args.note ?? "", p_solution: args.solutionId })
      : await rpc(db, "resolve_issue", { ...base, p_note: args.note ?? undefined });
    return { id: (data as { id: string }).id };
  } catch (e) {
    return { error: errorOf(e) };
  }
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
  try {
    const data = await rpc(db, "save_issue", {
      p_workspace: args.workspaceId,
      ...(args.id ? { p_id: args.id } : {}),
      p_fields: fields,
      ...(args.links ? { p_links: args.links as unknown as Json } : {}),
      ...(args.owners ? { p_owners: [...args.owners] } : {}),
      ...(args.sources ? { p_sources: [...args.sources] } : {}),
    });
    return { id: (data as { id: string }).id };
  } catch (e) {
    return { error: errorOf(e) };
  }
}

/**
 * Each process's live revision id (processes never published are left out). A dismissed insight is hidden only until
 * its process's live revision changes, so the screens that list insights compare against this (`isDismissalCurrent`).
 */
export async function loadLiveRevisionIds(db: Db, workspaceId: string): Promise<Record<string, string>> {
  const r = await db.selectFrom("processes").select(["id", "live_revision_id"]).where("workspace_id", "=", workspaceId).where("is_company", "=", false).execute();
  return Object.fromEntries(r.flatMap((p) => (p.live_revision_id ? [[p.id, p.live_revision_id]] : [])));
}

/** The `SourceRow` columns. */
export const SOURCE_COLUMNS = "id, workspace_id, kind, title, speakers, recorded_at, body, file_url, created_at, updated_at" as const;

/** The workspace's sources, most recent first (RLS: everyone in the workspace can read them). */
export async function loadSources(db: Db, workspaceId: string): Promise<SourceRow[]> {
  const r = await db
    .selectFrom("sources")
    .select(columns(SOURCE_COLUMNS))
    .where("workspace_id", "=", workspaceId)
    .orderBy("recorded_at", (ob) => ob.desc().nullsLast())
    .orderBy("created_at", "desc")
    .orderBy("id")
    .execute();
  // The check constraint limits kind to SourceRow's union.
  return r as unknown as SourceRow[];
}

/** What the Sources library asks for: every part is optional, and the words are values (never built into a query string). */
export interface SourceSearch {
  search?: string;
  kind?: SourceKind;
  processId?: string;
  unlinkedOnly?: boolean;
  sort?: "newest" | "oldest" | "title" | "title-desc";
  limit?: number;
  offset?: number;
}

/** One page of the library: the rows without their full text, and how many match in all. */
export interface SourcePage {
  rows: SourceListRow[];
  total: number;
}

/** The library's page size. */
export const SOURCES_PAGE_SIZE = 50;

/**
 * One page of the workspace's sources (the `search_sources` function: every search word is matched as plain text against the
 * title, speakers and text; RLS decides what is visible). Rows carry a short excerpt, never the full text.
 */
export async function searchSources(db: Db, workspaceId: string, q: SourceSearch = {}): Promise<SourcePage> {
  const data = await rpcRows(db, "search_sources", {
    p_workspace: workspaceId,
    ...(q.search?.trim() ? { p_search: q.search } : {}),
    ...(q.kind ? { p_kind: q.kind } : {}),
    ...(q.processId ? { p_process: q.processId } : {}),
    ...(q.unlinkedOnly ? { p_unlinked: true } : {}),
    ...(q.sort ? { p_sort: q.sort } : {}),
    p_limit: q.limit ?? SOURCES_PAGE_SIZE,
    p_offset: q.offset ?? 0,
  });
  const list = (data ?? []) as unknown as (SourceListRow & { total: number })[];
  return { rows: list.map(({ total: _total, ...row }) => row), total: list.length ? Number(list[0]!.total) : 0 };
}

/** How many sources the workspace has (RLS applies), whatever the library's filters say. */
export async function countSources(db: Db, workspaceId: string): Promise<number> {
  const r = await db.selectFrom("sources").select((eb) => eb.fn.countAll<string>().as("count")).where("workspace_id", "=", workspaceId).executeTakeFirstOrThrow();
  return Number(r.count);
}

/**
 * Which of these sources still exist (RLS applies). One statement whatever the length: the list goes as one array parameter
 * (PostgREST needed batches to keep its URL short; here each batch would cost a round trip).
 */
export async function existingSourceIds(db: Db, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const r = await db.selectFrom("sources").select("id").where(sql<boolean>`${sql.ref("id")} = any(${[...ids]}::uuid[])`).execute();
  return new Set(r.map((row) => row.id));
}

/** One source's full text, read when it is opened. Null when it has none, or is not visible. */
export async function loadSourceBody(db: Db, sourceId: string): Promise<string | null> {
  const r = await db.selectFrom("sources").select("body").where("id", "=", sourceId).executeTakeFirst();
  return r?.body ?? null;
}

/** A workspace's logo as the route serves it: the bytes, their type and their SHA-256 (hex), which is also the ETag. */
export interface WorkspaceLogo {
  mime: string;
  bytes: Buffer;
  sha256: string;
}

/** The logo `public.workspace_logo` returns for a workspace (callable signed out, for share links), or null when it has none. */
export async function loadWorkspaceLogo(db: Db, workspaceId: string): Promise<WorkspaceLogo | null> {
  const { rows } = await sql<WorkspaceLogo>`select mime, bytes, sha256 from public.workspace_logo(${workspaceId}::uuid)`.execute(db);
  return rows[0] ?? null;
}

/** The hash of a workspace's logo, or null: members read it from the table (RLS), so the shell can build the logo's URL. */
export async function loadWorkspaceLogoSha(db: Db, workspaceId: string): Promise<string | null> {
  const r = await db.selectFrom("workspace_logos").select("sha256").where("workspace_id", "=", workspaceId).executeTakeFirst();
  return r?.sha256 ?? null;
}

/**
 * Keep a logo if the stored one is still `base` (its sha256, or null for none), as the signed-in user: RLS lets owners and agency
 * admins write. "conflict" means someone changed it first; a person who may not write gets the database's 42501.
 */
export async function saveWorkspaceLogo(db: Db, workspaceId: string, base: string | null, logo: WorkspaceLogo): Promise<"saved" | "conflict"> {
  const values = { mime: logo.mime, bytes: logo.bytes, sha256: logo.sha256, updated_at: new Date().toISOString() };
  if (base === null) {
    const r = await db.insertInto("workspace_logos").values({ workspace_id: workspaceId, ...values }).onConflict((oc) => oc.column("workspace_id").doNothing()).returning("workspace_id").execute();
    return r.length ? "saved" : "conflict";
  }
  const r = await db.updateTable("workspace_logos").set(values).where("workspace_id", "=", workspaceId).where("sha256", "=", base).returning("workspace_id").execute();
  return r.length ? "saved" : "conflict";
}

/** Remove the logo if the stored one is still `base`. */
export async function deleteWorkspaceLogo(db: Db, workspaceId: string, base: string): Promise<"removed" | "conflict"> {
  const r = await db.deleteFrom("workspace_logos").where("workspace_id", "=", workspaceId).where("sha256", "=", base).returning("workspace_id").execute();
  return r.length ? "removed" : "conflict";
}

/** The tours of the editor the signed-in person has dismissed (`process`, `company`); RLS shows only their own. */
export async function loadDismissedTours(db: Db): Promise<string[]> {
  const r = await db.selectFrom("user_tours").select("tour").execute();
  return r.map((t) => t.tour);
}

/** Remember that the signed-in person dismissed a tour, so it never opens on its own for them again. */
export async function dismissTour(db: Db, tour: "process" | "company"): Promise<void> {
  await db
    .insertInto("user_tours")
    .values({ tour })
    .onConflict((oc) => oc.columns(["user_id", "tour"]).doNothing())
    .execute();
}

/** The `SourceLinkRow` columns. */
export const SOURCE_LINK_COLUMNS = "id, workspace_id, source_id, kind, process_id, step_id, insight_key, issue_id, solution_id, created_at, created_by" as const;

/** What every source of the workspace is linked to, oldest link first (RLS: everyone in the workspace can read them). */
export async function loadSourceLinks(db: Db, workspaceId: string): Promise<SourceLinkRow[]> {
  const r = await db.selectFrom("source_links").select(columns(SOURCE_LINK_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("id").execute();
  // The check constraint limits kind to SourceLinkRow's union.
  return r as unknown as SourceLinkRow[];
}

/** The names of steps by their stable ids, from whichever version holds them (the latest written wins). For links to steps that are in no current version. */
export async function loadStepNames(db: Db, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (!ids.length) return [];
  // One statement, the list as one array parameter (the batches were for PostgREST's URL length).
  const r = await db
    .selectFrom("steps")
    .select(["id", "name", "updated_at"])
    .where(sql<boolean>`${sql.ref("id")} = any(${[...ids]}::uuid[])`)
    .orderBy("updated_at", "desc")
    .execute();
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const s of r) if (!seen.has(s.id)) out.push({ id: s.id, name: (seen.add(s.id), s.name) });
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
    revisions.length
      ? db.selectFrom("steps").select(["id", "name", "process_id", "replaced_by"]).where("revision_id", "in", revisions).orderBy("created_at").orderBy("id").execute()
      : Promise.resolve([]),
    db.selectFrom("issues").select(["id", "number", "title", "status", "detected_key"]).where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").execute(),
    db.selectFrom("solutions").select(["id", "name"]).where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").execute(),
  ]);
  const seen = new Set<string>();
  const sees = await readerSeesPeople(db, workspaceId);
  const live = issues.filter((i) => i.status !== "dismissed").map((i) => hideAiIssueKey(i, sees));
  return {
    processes: processes.map((p) => ({ id: p.id, name: p.name })),
    steps: steps.flatMap((s) => (s.replaced_by.length === 0 && !seen.has(s.id) && seen.add(s.id) ? [{ id: s.id, processId: s.process_id, name: s.name }] : [])),
    insights: live.flatMap((i) => (i.detected_key ? [{ key: i.detected_key, title: i.title }] : [])),
    issues: live.map((i) => ({ id: i.id, number: i.number, title: i.title })),
    solutions: solutions.map((s) => ({ id: s.id, name: s.name })),
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
      ? db.selectFrom("steps").select(["id", "name", "process_id", "revision_id", "provenance", "replaced_by"]).where("revision_id", "in", [...revisions.keys()]).execute()
      : Promise.resolve([]),
    db.selectFrom("lead_sources").select(["id", "name", "provenance"]).where("workspace_id", "=", workspaceId).execute(),
    db.selectFrom("seasonality").select(["id", "month", "provenance"]).where("workspace_id", "=", workspaceId).execute(),
    db.selectFrom("demand_settings").select(["workspace_id", "provenance"]).where("workspace_id", "=", workspaceId).execute(),
  ]);
  return [
    // Retired steps (split or replaced, issue #16) are no longer part of the process.
    ...partitionSteps(steps).steps.map((s) => ({
      table: "steps",
      id: s.id,
      name: s.name,
      processId: s.process_id,
      revision: revisions.get(s.revision_id)!,
      provenance: s.provenance,
    })),
    ...leadSources.map((l) => ({ table: "lead_sources", id: l.id, name: l.name, provenance: l.provenance })),
    ...seasonality.map((m) => ({
      table: "seasonality",
      id: m.id,
      name: `Seasonality: ${MONTHS[m.month - 1] ?? m.month}`,
      provenance: m.provenance,
    })),
    ...demand.map((d) => ({ table: "demand_settings", id: d.workspace_id, name: "Demand growth", provenance: d.provenance })),
  ];
}

// ---------------------------------------------------------------------------
// Company model, suggestions and saved runs (issue #25)
// ---------------------------------------------------------------------------

/** The workspace's company model: roles, people, services, clients and demand, with provenance. */
export async function loadCompanyModel(
  db: Db,
  workspace: Pick<WorkspaceRow, "id" | "name" | "slug"> & { settings: unknown; provenance?: unknown },
): Promise<CompanyModel> {
  const ws = workspace.id;
  // People are in name order for those who see everyone (team_capacity orders them), as the table query was.
  const teamLoad = loadTeam(db, ws);
  const [roles, team, services, leadSources, seasonality, demand, roster] = await Promise.all([
    db.selectFrom("roles").selectAll().where("workspace_id", "=", ws).orderBy("name").execute(),
    teamLoad,
    db.selectFrom("services").select([...columns(SERVICE_COLUMNS), "provenance"]).where("workspace_id", "=", ws).orderBy("name").execute(),
    db.selectFrom("lead_sources").select(columns(LEAD_SOURCE_COLUMNS)).where("workspace_id", "=", ws).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("seasonality").select(columns(SEASONALITY_COLUMNS)).where("workspace_id", "=", ws).orderBy("month").execute(),
    db.selectFrom("demand_settings").select(columns(DEMAND_SETTINGS_COLUMNS)).where("workspace_id", "=", ws).executeTakeFirst(),
    teamLoad.then((t) => loadClients(db, ws, t)),
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
    roles,
    people: team.people,
    personRoles: team.personRoles,
    personLeave: team.personLeave,
    viewer: team.viewer,
    services: services as unknown as ServiceRow[],
    leadSources: leadSources as unknown as LeadSourceRow[],
    seasonality: seasonality as unknown as SeasonalityRow[],
    demand: (demand ?? null) as DemandSettingsRow | null,
    ...roster,
  };
}

/** Each process's live revision (for run snapshots and "model changed since this run"). */
export async function loadLiveRevisions(db: Db, workspaceId: string): Promise<SnapshotProcess[]> {
  const processes = await listProcesses(db, workspaceId);
  const ids = processes.flatMap((p) => (p.live_revision_id ? [p.live_revision_id] : []));
  if (!ids.length) return [];
  const revisions = await db.selectFrom("process_revisions").select(["id", "number"]).where("id", "in", ids).execute();
  return processes.flatMap((p) => {
    const r = revisions.find((x) => x.id === p.live_revision_id);
    return r ? [{ id: p.id, name: p.name, revision_id: r.id, revision: r.number }] : [];
  });
}

export const SUGGESTION_ROW_COLUMNS =
  "id, workspace_id, target_table, target_id, patch, evidence, note, status, created_via, import_source, applied, review_note, reviewed_by, reviewed_at, created_at, created_by" as const;

/** The workspace's suggestions, newest first; optionally only one status. */
export async function loadSuggestions(db: Db, workspaceId: string, status?: SuggestionStatus): Promise<SuggestionRow[]> {
  let q = db.selectFrom("suggestions").select(columns(SUGGESTION_ROW_COLUMNS)).where("workspace_id", "=", workspaceId);
  if (status) q = q.where("status", "=", status);
  const r = await q.orderBy("created_at", "desc").orderBy("id").limit(500).execute();
  // Check constraints limit the text columns; patch, evidence and applied are jsonb.
  return r as unknown as SuggestionRow[];
}

export const RUN_COLUMNS =
  "id, workspace_id, process_id, name, scenario_id, revision_ids, engine_version, reps, seed, params_snapshot, results, duration_ms, created_at, created_by" as const;

/** The workspace's saved runs, newest first. */
export async function loadRuns(db: Db, workspaceId: string): Promise<RunRow[]> {
  const r = await db
    .selectFrom("runs")
    .select(columns(RUN_COLUMNS))
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at", "desc")
    .orderBy("id")
    .limit(200)
    .execute();
  // params_snapshot and results are jsonb; RunRow gives them their shapes.
  return r as unknown as RunRow[];
}

/** One saved run, or null if it isn't visible. */
export async function loadRun(db: Db, id: string): Promise<RunRow | null> {
  const r = await db.selectFrom("runs").select(columns(RUN_COLUMNS)).where("id", "=", id).executeTakeFirst();
  return (r ?? null) as unknown as RunRow | null;
}

export const SOLUTION_COLUMNS = "id, workspace_id, process_id, base_revision_id, name, notes, steps, changed_step_ids, lever_changes, created_at, updated_at, created_by" as const;
export const SOLUTION_ISSUE_COLUMNS = "solution_id, issue_id, workspace_id, auto_verdict, holds_pct, auto_note, user_verdict, user_notes, created_at, updated_at, created_by" as const;

/** A workspace's solutions, newest first: optionally only those that change one process. */
export async function loadSolutions(db: Db, workspaceId: string, processId?: string): Promise<SolutionRow[]> {
  let q = db.selectFrom("solutions").select(columns(SOLUTION_COLUMNS)).where("workspace_id", "=", workspaceId);
  if (processId) q = q.where("process_id", "=", processId);
  const r = await q.orderBy("created_at", "desc").orderBy("id").execute();
  // The database checks the shapes of steps, changed_step_ids and lever_changes.
  return r as unknown as SolutionRow[];
}

/** The `ForecastPlanRow` columns. */
export const FORECAST_PLAN_COLUMNS = "id, workspace_id, name, markers, created_at, updated_at, created_by" as const;

/** A workspace's forecast plans by name (RLS: only owners, editors and agency admins read them). Empty, with a log line, if they can't be read. */
export async function loadForecastPlans(db: Db, workspaceId: string): Promise<ForecastPlanRow[]> {
  try {
    const r = await db.selectFrom("forecast_plans").select(columns(FORECAST_PLAN_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("name").orderBy("id").execute();
    // The database checks the shape of markers.
    return r as unknown as ForecastPlanRow[];
  } catch (e) {
    console.error("Couldn't load the forecast plans; showing none.", e instanceof Error ? e.message : e);
    return [];
  }
}

/** The issues each of a workspace's solutions solves, with their verdicts. */
export async function loadSolutionIssues(db: Db, workspaceId: string): Promise<SolutionIssueRow[]> {
  const r = await db.selectFrom("solution_issues").select(columns(SOLUTION_ISSUE_COLUMNS)).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("issue_id").execute();
  return r as unknown as SolutionIssueRow[];
}
