import type { SolutionsData } from "@/lib/solutions/cards";
import "server-only";
import { cache } from "react";
import {
  DEMAND_SETTINGS_COLUMNS,
  LEAD_SOURCE_COLUMNS,
  listProcesses,
  loadBlocks,
  loadCompanyProcessId,
  loadSetupCounts,
  type SetupCounts,
  loadSolutionIssues,
  loadSolutions,
  loadChurnDrivers,
  loadClientGroups,
  loadTeam,
  loadClients,
  loadMarket,
  type MarketConditionRow,
  type PersonCapacityFactorRow,
  type MarketScheduleRow,
  loadIssuesForReader,
  loadIssueEvents,
  loadLiveRevisionIds,
  loadLiveProcessBySlug,
  loadProcessBundle,
  loadProcessBySlug,
  loadScenarios,
  loadSources,
  searchSources,
  countSources,
  loadDismissedTours,
  existingSourceIds,
  loadSourceLinks,
  loadLinkTargets,
  loadStepNames,
  loadCitingRows,
  citationsBySource,
  type LinkTargets,
  type SourceCitation,
  type SourceLinkRow,
  type SourceRow,
  type SourceListRow,
  SEASONALITY_COLUMNS,
  SERVICE_COLUMNS,
  SERVICE_SERVICING_COLUMNS,
  type ServiceServicingRow,
  type BlockRow,
  type ChurnDriverRow,
  type SandboxScenarioRow,
  loadSandboxScenarios,
  type ClientGroupRow,
  type DemandSettingsRow,
  type IssueEventRow,
  type IssueRow,
  type LeadSourceRow,
  type PersonLeaveRow,
  type PersonRoleRow,
  type PersonRow,
  type PersonSkillRow,
  type ProcessBundle,
  type ProcessListing,
  type RoleRow,
  type ScenarioRow,
  type SeasonalityRow,
  type ServiceRow,
  type StepRow,
  type WorkspaceRow,
  type WorkspaceSettings,
  type PurposeCategory,
  loadWorkspaceLogoSha,
} from "@transpera-flow/db";
import type { HeadlineNumbers } from "./overview/headline";
import { roleUsage, type RoleUsage } from "./roles";
import { rpc, rpcRows } from "@transpera-flow/db/client";
import { getDb } from "./auth/session";
import { readTierSetup, type TierSetup } from "./tier-setup";
import { columnList } from "./columns";

/** Workspaces the signed-in user can see (RLS decides). */
export async function listWorkspaces(): Promise<Pick<WorkspaceRow, "id" | "name" | "slug">[]> {
  const db = await getDb();
  return db.selectFrom("workspaces").select(["id", "name", "slug"]).orderBy("name").execute();
}

/** One row of the agency's workspace list: what `agency_workspace_list` returns, with the stored headline numbers typed. */
export interface AgencyWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  /** Open or in-progress issues rated Operational risk. */
  openRiskIssues: number;
  /** The latest change to a process version, issue, finding, source, solution or (for those who manage) the audit log; null if none. */
  lastActivity: string | null;
  /** Null until someone opens the workspace's Overview (the numbers are recorded from its run). */
  headline: { numbers: HeadlineNumbers; computedAt: string } | null;
}

/** Every workspace the signed-in user reads, with its headline numbers (RLS decides which). For agency admins' home page. */
export async function listAgencyWorkspaces(): Promise<AgencyWorkspaceRow[]> {
  const db = await getDb();
  const data = await rpcRows(db, "agency_workspace_list");
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    openRiskIssues: Number(r.open_risk_issues),
    lastActivity: r.last_activity,
    headline: r.numbers && r.computed_at ? { numbers: r.numbers as unknown as HeadlineNumbers, computedAt: r.computed_at } : null,
  }));
}

/** A workspace's id, name, slug and branding by slug, for the shell around its pages (null if it doesn't exist or isn't visible). */
export const loadWorkspaceHead = cache(async (slug: string): Promise<(Pick<WorkspaceRow, "id" | "name" | "slug"> & { branding: unknown }) | null> => {
  const db = await getDb();
  return (await db.selectFrom("workspaces").select(["id", "name", "slug", "branding"]).where("slug", "=", slug).executeTakeFirst()) ?? null;
});

/** The hash of a workspace's logo, or null when it has none: what the shell builds the logo's URL from (RLS: members read it). */
export const loadLogoSha = cache(async (workspaceId: string): Promise<string | null> => loadWorkspaceLogoSha(await getDb(), workspaceId));

/** The workspace's sources (RLS: everyone in the workspace can read them). */
export async function loadWorkspaceSources(workspaceId: string): Promise<SourceRow[]> {
  return loadSources(await getDb(), workspaceId);
}

/** The Sources page: the workspace, its sources, and every value citing each one (issue #21). */
export async function loadSourcesPage(
  slug: string,
): Promise<{
  workspace: Pick<WorkspaceRow, "id" | "name" | "slug">;
  /** The library's first page: rows without their full text. */
  sources: SourceListRow[];
  /** How many sources match (all of them, on the first page). */
  total: number;
  /** How many sources the workspace has. */
  totalAll: number;
  /** Cited sources that no longer exist: the page lists what cited them apart. */
  deletedSourceIds: string[];
  citations: Record<string, SourceCitation[]>;
  links: SourceLinkRow[];
  targets: LinkTargets;
} | null> {
  const db = await getDb();
  const workspace = await db.selectFrom("workspaces").select(["id", "name", "slug"]).where("slug", "=", slug).executeTakeFirst();
  if (!workspace) return null;
  const [page, totalAll, rows, links, targets] = await Promise.all([
    searchSources(db, workspace.id, { sort: "newest" }),
    countSources(db, workspace.id),
    loadCitingRows(db, workspace.id),
    loadSourceLinks(db, workspace.id),
    loadLinkTargets(db, workspace.id),
  ]);
  // A link to a step that is in no current version still has a name somewhere: an earlier version's.
  const current = new Set(targets.steps.map((s) => s.id));
  const citations = Object.fromEntries(citationsBySource(rows));
  const cited = Object.keys(citations);
  const existing = await existingSourceIds(db, cited);
  const missing = [...new Set(links.flatMap((l) => (l.step_id && !current.has(l.step_id) ? [l.step_id] : [])))];
  const olderSteps = await loadStepNames(db, missing);
  return { workspace, sources: page.rows, total: page.total, totalAll, deletedSourceIds: cited.filter((id) => !existing.has(id)), citations, links, targets: { ...targets, olderSteps } };
}

/** What "+ Link" needs on any screen: the workspace's source links and the things a source can be linked to. */
export async function loadSourceLinking(workspaceId: string): Promise<{ links: SourceLinkRow[]; targets: LinkTargets }> {
  const db = await getDb();
  const [links, targets] = await Promise.all([loadSourceLinks(db, workspaceId), loadLinkTargets(db, workspaceId)]);
  return { links, targets };
}

/** The categories stored on the workspace as they are (null while it has none and uses the defaults), the base a save checks against. */
/** The workspace's tier keys and what each tier's service gets (capacity P4): P1's tables when they exist, else T1 to T3. */
export async function loadTierSetup(workspaceId: string): Promise<TierSetup> {
  return readTierSetup(await getDb(), workspaceId);
}

export async function loadStoredPurposes(workspaceId: string): Promise<PurposeCategory[] | null> {
  const row = await (await getDb()).selectFrom("workspaces").select(["settings"]).where("id", "=", workspaceId).executeTakeFirst();
  return (row?.settings as WorkspaceSettings | undefined)?.purposes ?? null;
}

/**
 * How many steps (in each process's live and draft version) have chosen each purpose category, by key: what Settings -> Purposes says
 * before a category is deleted. Steps that chose none (Automatic) are not counted.
 */
export async function loadPurposeUse(workspaceId: string): Promise<Record<string, number>> {
  const db = await getDb();
  const processes = await db.selectFrom("processes").select(["live_revision_id", "draft_revision_id"]).where("workspace_id", "=", workspaceId).execute();
  const revisions = processes.flatMap((p) => [p.live_revision_id, p.draft_revision_id].filter((id): id is string => id !== null));
  if (!revisions.length) return {};
  const rows = await db.selectFrom("steps").select(["purpose"]).where("revision_id", "in", revisions).where("purpose", "is not", null).execute();
  const out: Record<string, number> = {};
  for (const r of rows) out[r.purpose!] = (out[r.purpose!] ?? 0) + 1;
  return out;
}

/** The workspace's first process at its live revision, or null if not visible. */
export async function loadLiveProcess(slug: string): Promise<ProcessBundle | null> {
  return loadLiveProcessBySlug(await getDb(), slug);
}

/** Each process's live revision id, which a dismissed insight is measured against. */
export async function loadWorkspaceLiveRevisionIds(workspaceId: string): Promise<Record<string, string>> {
  return loadLiveRevisionIds(await getDb(), workspaceId);
}

/**
 * The workspace's tracked issues, newest first (RLS: everyone in the workspace can read them). A member or viewer gets an
 * opaque `detected_key` where it is a hash of AI text (B1 2b).
 */
export async function loadWorkspaceIssues(workspaceId: string): Promise<IssueRow[]> {
  return loadIssuesForReader(await getDb(), workspaceId);
}

/** One issue's history, oldest first (RLS: everyone in the workspace can read it). */
export async function loadWorkspaceIssueEvents(workspaceId: string, issueId: string): Promise<IssueEventRow[]> {
  return loadIssueEvents(await getDb(), workspaceId, issueId);
}

/** The workspace's processes, by id and name, for the register's process filter. */
export async function loadProcessNames(workspaceId: string): Promise<{ id: string; name: string }[]> {
  return (await listProcesses(await getDb(), workspaceId)).map((p) => ({ id: p.id, name: p.name }));
}

/** The workspace's processes with their kind, in creation order, for the Processes page. */
export async function loadProcessList(workspaceId: string): Promise<{ id: string; name: string; kind: string }[]> {
  return (await listProcesses(await getDb(), workspaceId)).map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
}

/** The workspace's block library, oldest first (RLS: everyone in the workspace can read it). */
export async function loadWorkspaceBlocks(workspaceId: string): Promise<BlockRow[]> {
  return loadBlocks(await getDb(), workspaceId);
}

/**
 * The workspace's solutions, newest first, and which issues each solves (RLS: everyone in the workspace can read them),
 * optionally only those that change one process. If they can't be read (say the tables aren't there yet), pages show none
 * rather than break.
 */
export async function loadWorkspaceSolutions(workspaceId: string, processId?: string): Promise<SolutionsData> {
  try {
    const db = await getDb();
    const [solutions, links] = await Promise.all([loadSolutions(db, workspaceId, processId), loadSolutionIssues(db, workspaceId)]);
    const ids = new Set(solutions.map((s) => s.id));
    return { solutions, links: links.filter((l) => ids.has(l.solution_id)) };
  } catch (err) {
    console.error("Couldn't load the solutions; showing none.", err instanceof Error ? err.message : err);
    return { solutions: [], links: [] };
  }
}

/**
 * The workspace's Sandbox scenarios by name. RLS: everyone who can read the workspace reads them (Viewers run and compare, they don't
 * save). If they can't be read, the page shows none rather than break.
 */
export async function loadWorkspaceSandboxScenarios(workspaceId: string): Promise<SandboxScenarioRow[]> {
  try {
    return await loadSandboxScenarios(await getDb(), workspaceId);
  } catch (err) {
    console.error("Couldn't load the sandbox scenarios; showing none.", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Who the workspace's members are, by user id: the name of the person linked to each membership (Settings > Access). A member with
 * no person linked is left out, so pages say "A team member" for them. (RLS, B1 2/3a: `memberships` and `people` are both read in
 * full only by Agency admins and the Owner (`can_see_people`); anyone else reads only their own membership row, and
 * their own person (`can_see_person`). So a member or viewer gets only their own name, and every other author falls back to
 * "A team member": that is the rule, not a gap.)
 */
export async function loadMemberNames(workspaceId: string): Promise<Record<string, string>> {
  try {
    const db = await getDb();
    const [members, people] = await Promise.all([
      db.selectFrom("memberships").select(["user_id", "person_id"]).where("workspace_id", "=", workspaceId).execute(),
      db.selectFrom("people").select(["id", "name"]).where("workspace_id", "=", workspaceId).execute(),
    ]);
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    const out: Record<string, string> = {};
    for (const m of members) {
      const name = m.person_id ? nameOf.get(m.person_id) : undefined;
      if (name) out[m.user_id] = name;
    }
    return out;
  } catch (err) {
    console.error("Couldn't load member names; showing none.", err instanceof Error ? err.message : err);
    return {};
  }
}

/** The workspace's named clients, their services and who looks after them (issue #182): everyone in the workspace reads them. */
export async function loadWorkspaceClients(workspaceId: string) {
  return loadClients(await getDb(), workspaceId);
}

/** The workspace's saved scenarios, oldest first (RLS: everyone in the workspace can read them). */
export async function loadWorkspaceScenarios(workspaceId: string): Promise<ScenarioRow[]> {
  return loadScenarios(await getDb(), workspaceId);
}

/**
 * A process of the workspace for the editor: its live revision (an empty
 * stand-in if never published), its open draft if any (issue #9), and the
 * workspace's processes for the picker (issue #76). Without `processId`, the
 * first process with a live revision.
 */
export async function loadProcessForEditing(
  slug: string,
  processId?: string,
  /** The Editor also opens the company map (B11), by its id; no other page does. */
  { includeCompany = false }: { includeCompany?: boolean } = {},
): Promise<{ live: ProcessBundle; draft: ProcessBundle | null; processes: ProcessListing[] } | null> {
  return loadProcessBySlug(await getDb(), slug, { ...(processId ? { processId } : {}), includeCompany });
}

/**
 * An earlier version of the process `live` is, for "Viewing version N · read only" (issue #103): the published revision numbered
 * `number` if it is not the live one, else null (the caller shows live). A draft is never an old version.
 */
export async function loadProcessVersion(live: ProcessBundle, number: number): Promise<ProcessBundle | null> {
  const db = await getDb();
  const revision = await db
    .selectFrom("process_revisions")
    .select("id")
    .where("process_id", "=", live.process.id)
    .where("number", "=", number)
    .where("status", "in", ["published", "superseded"])
    .executeTakeFirst();
  if (!revision || revision.id === live.revision.id) return null;
  return loadProcessBundle(db, live.workspace, live.process, revision.id);
}

/**
 * The version of a process a solution was copied from, for the Solution page's comparison: the live version when that is still it,
 * else the earlier published one with live's roles, people and market (those are the workspace's, not a version's), and a sentence
 * saying live has moved on. Null when the process or that version can't be read.
 */
export async function loadSolutionBase(
  slug: string,
  processId: string,
  baseRevisionId: string,
  /** The live bundle the page already loaded, when it is this process's: it is reused, not loaded again. */
  loaded?: ProcessBundle | null,
): Promise<{ base: ProcessBundle; movedOn: string | null } | null> {
  // No draft is wanted (and none is loaded) for a comparison with a published version.
  const live = loaded && loaded.process.id === processId ? loaded : (await loadProcessBySlug(await getDb(), slug, { draft: false, processId }))?.live;
  if (!live) return null;
  if (live.revision.id === baseRevisionId) return { base: live, movedOn: null };
  const earlier = await loadProcessBundle(await getDb(), live.workspace, live.process, baseRevisionId);
  if (!earlier) return null;
  const base: ProcessBundle = { ...live, revision: earlier.revision, steps: earlier.steps, edges: earlier.edges, retired: earlier.retired };
  return {
    base,
    movedOn: `Live has moved on since: this solution was copied from version ${earlier.revision.number}, and live is now version ${live.revision.number}. “Live” here is version ${earlier.revision.number}, so the maps and numbers show exactly what the solution changed.`,
  };
}

/**
 * A workspace with no published process (a new one): its name and whatever
 * processes exist, for the page that stands in for the canvas (issue #88).
 */
export async function loadWorkspaceOverview(
  slug: string,
): Promise<{ workspace: Pick<WorkspaceRow, "id" | "name" | "slug">; processes: ProcessListing[] } | null> {
  const db = await getDb();
  const workspace = await db.selectFrom("workspaces").select(["id", "name", "slug"]).where("slug", "=", slug).executeTakeFirst();
  if (!workspace) return null;
  const processes = await listProcesses(db, workspace.id);
  return {
    workspace,
    processes: processes.map((p) => ({ id: p.id, name: p.name, kind: p.kind, live: p.live_revision_id !== null, draft: p.draft_revision_id !== null })),
  };
}

/** For a page with nothing published: the workspace, whether anything is published, and the oldest draft-only process. Null when the workspace doesn't exist or isn't visible. */
export async function loadPublishState(
  slug: string,
): Promise<{ workspace: { id: string; name: string; slug: string }; published: boolean; firstDraft: { id: string; name: string } | null } | null> {
  const overview = await loadWorkspaceOverview(slug);
  if (!overview) return null;
  const draft = overview.processes.find((p) => p.draft && !p.live);
  return {
    workspace: overview.workspace,
    published: overview.processes.some((p) => p.live),
    firstDraft: draft ? { id: draft.id, name: draft.name } : null,
  };
}

/** The workspace's company map process id (null if it has none), for the URLs that stand in for the company map's own pages. */
export const loadCompanyId = cache(async (workspaceId: string): Promise<string | null> => loadCompanyProcessId(await getDb(), workspaceId));

/** Counts for the start page's checklist. Editors only: members and viewers are never sent them. */
export async function loadWorkspaceSetup(workspaceId: string): Promise<SetupCounts> {
  return loadSetupCounts(await getDb(), workspaceId);
}

export interface PersonDetail extends PersonRow {
  email: string | null;
  notes: string | null;
}

export interface LeaveDetail extends PersonLeaveRow {
  note: string | null;
}

/** Everything the workspace settings page edits, and what the user may change. */
export interface WorkspaceSettingsData {
  workspace: WorkspaceRow;
  /** agency_admin, Agency admin: may manage people. */
  canEdit: boolean;
  /** agency_admin or owner: may change workspace settings. */
  canManage: boolean;
  roles: Pick<RoleRow, "id" | "name" | "color" | "active">[];
  /** How many steps (any revision), people, clients and services name each role, by role id. */
  roleUsage: Record<string, RoleUsage>;
  /** Steps someone does (working steps with a role) in the workspace's live processes, for skills. */
  steps: Pick<StepRow, "id" | "name" | "role_id">[];
  people: PersonDetail[];
  personRoles: PersonRoleRow[];
  personSkills: PersonSkillRow[];
  personLeave: LeaveDetail[];
  /** Per-person times (C6): everyone's for Agency admins, only the viewer's own person's otherwise (RLS, `can_see_person`). */
  personCapacityFactors: PersonCapacityFactorRow[];
  services: ServiceRow[];
  /** The workspace's processes, for a service's entry process. */
  processes: { id: string; name: string; kind: string }[];
  /** Condition tags on the connections of the live processes, as hints for services' path tags. */
  conditionTags: string[];
  /** Demand (issue #13): lead sources oldest first, seasonality by month, and the growth row if any. */
  leadSources: LeadSourceRow[];
  seasonality: SeasonalityRow[];
  demand: DemandSettingsRow | null;
  /** Which servicing processes each service's clients run (issue #19). */
  servicingLinks: ServiceServicingRow[];
  /** Clients counted per service (issue #120); a service with no row has none set up yet. */
  clientGroups: ClientGroupRow[];
  /** Churn drivers you have set (A56); a built-in with no row is at its default. */
  churnDrivers: ChurnDriverRow[];
  /** Market conditions (A57): presets and your own, and the 24-month schedule. */
  marketConditions: MarketConditionRow[];
  marketSchedule: MarketScheduleRow[];
}

/** `entered` or `measured`, from `provenance.factor.source` (entered when there is none). */
function factorSource(provenance: unknown): string {
  const f = (provenance as { factor?: { source?: unknown } } | null)?.factor;
  return typeof f?.source === "string" ? f.source : "entered";
}

/** How many visits a measured time rests on (`provenance.factor.n`); null when entered or when none is recorded (#227). */
function factorItems(provenance: unknown): number | null {
  const f = (provenance as { factor?: { source?: unknown; n?: unknown } } | null)?.factor;
  return f?.source === "measured" && typeof f.n === "number" && Number.isFinite(f.n) ? Math.round(f.n) : null;
}

export async function loadWorkspaceSettings(slug: string): Promise<WorkspaceSettingsData | null> {
  const db = await getDb();
  const workspace = await db.selectFrom("workspaces").select(["id", "name", "slug", "settings"]).where("slug", "=", slug).executeTakeFirst();
  if (!workspace) return null;
  const ws = workspace.id;

  const processes = await db
    .selectFrom("processes")
    .select(["id", "name", "kind", "live_revision_id"])
    .where("workspace_id", "=", ws)
    // The company map is not a process to put roles or tags on, nor is an archived one (issue #182).
    .where("is_company", "=", false)
    .where("archived_at", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const revisions = processes.flatMap((p) => (p.live_revision_id ? [p.live_revision_id] : []));

  const demandQueries = Promise.all([
    db.selectFrom("lead_sources").select(columnList<"lead_sources">(LEAD_SOURCE_COLUMNS)).where("workspace_id", "=", ws).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("seasonality").select(columnList<"seasonality">(SEASONALITY_COLUMNS)).where("workspace_id", "=", ws).orderBy("month").execute(),
    db.selectFrom("demand_settings").select(columnList<"demand_settings">(DEMAND_SETTINGS_COLUMNS)).where("workspace_id", "=", ws).executeTakeFirst(),
    db.selectFrom("service_servicing").select(columnList<"service_servicing">(SERVICE_SERVICING_COLUMNS)).where("workspace_id", "=", ws).orderBy("created_at").orderBy("id").execute(),
    loadMarket(db, ws),
    loadClientGroups(db, ws),
    loadChurnDrivers(db, ws),
  ]);
  // "Used by 3 people" counts the whole team, which a member's own reads of the per-person tables can't: team_capacity
  // gives every reader the roles and assignments of everyone (B1 2b).
  const [canEdit, canManage, roles, steps, people, personRoles, personSkills, personLeave, services, tags, roleSteps, team, factorRows] = await Promise.all([
    rpc(db, "can_edit_workspace", { ws }),
    rpc(db, "can_manage_workspace", { ws }),
    db.selectFrom("roles").select(["id", "name", "color", "active"]).where("workspace_id", "=", ws).orderBy("name").execute(),
    revisions.length
      ? db
          .selectFrom("steps")
          .select(["id", "name", "role_id"])
          .where("revision_id", "in", revisions)
          .where("kind", "not in", ["start", "end"])
          .where("role_id", "is not", null)
          .orderBy("y")
          .orderBy("x")
          .execute()
      : [],
    db
      .selectFrom("people")
      .select(["id", "workspace_id", "name", "email", "fte", "capacity_hours_week", "cost_rate", "active", "start_date", "end_date", "notes"])
      .where("workspace_id", "=", ws)
      .orderBy("name")
      .execute(),
    db.selectFrom("person_roles").select(["person_id", "role_id", "workspace_id"]).where("workspace_id", "=", ws).execute(),
    db.selectFrom("person_skills").select(["person_id", "step_id", "workspace_id"]).where("workspace_id", "=", ws).execute(),
    db
      .selectFrom("person_leave")
      .select(["id", "person_id", "workspace_id", "start_date", "end_date", "note"])
      .where("workspace_id", "=", ws)
      .orderBy("start_date")
      .execute(),
    db.selectFrom("services").select(columnList<"services">(SERVICE_COLUMNS)).where("workspace_id", "=", ws).orderBy("created_at").orderBy("id").execute(),
    revisions.length ? db.selectFrom("edges").select("condition_tag").where("revision_id", "in", revisions).where("condition_tag", "is not", null).execute() : [],
    // Every revision, live or not: a role a superseded step names can't be deleted either.
    db.selectFrom("steps").select(["id", "role_id"]).where("workspace_id", "=", ws).where("role_id", "is not", null).execute(),
    loadTeam(db, ws),
    // This page isn't a share source, so a direct read is fine here (RLS: everyone's for editors, own for members).
    db
      .selectFrom("person_capacity_factors")
      .select(["person_id", "step_id", "workspace_id", "factor", "provenance"])
      .where("workspace_id", "=", ws)
      .orderBy("person_id")
      .orderBy("step_id", (ob) => ob.asc().nullsFirst())
      .execute(),
  ]);
  const [leadSources, seasonality, demand, servicingLinks, market, clientGroups, churnDrivers] = await demandQueries;

  return {
    workspace: { ...workspace, settings: workspace.settings as unknown as WorkspaceSettings },
    canEdit: canEdit === true,
    canManage: canManage === true,
    roles,
    roleUsage: roleUsage(roleSteps, team.personRoles, team.clientAssignments, services as unknown as ServiceRow[]),
    steps: steps as Pick<StepRow, "id" | "name" | "role_id">[],
    people,
    personRoles,
    personSkills,
    personLeave,
    personCapacityFactors: factorRows.map((r) => ({
      person_id: r.person_id,
      workspace_id: r.workspace_id,
      step_id: r.step_id,
      factor: Number(r.factor),
      source: factorSource(r.provenance),
      items: factorItems(r.provenance),
    })),
    // The cast narrows pricing_model, which a check constraint limits.
    services: services as unknown as ServiceRow[],
    processes: processes.map(({ id, name, kind }) => ({ id, name, kind })),
    conditionTags: [...new Set(tags.map((e) => e.condition_tag?.trim() ?? "").filter(Boolean))].sort(),
    // The casts give the provenance jsonb its shape.
    leadSources: leadSources as unknown as LeadSourceRow[],
    seasonality: seasonality as unknown as SeasonalityRow[],
    demand: (demand ?? null) as unknown as DemandSettingsRow | null,
    // recurrence and provenance are jsonb; the table's check limits recurrence to RecurrenceJson.
    servicingLinks: servicingLinks as unknown as ServiceServicingRow[],
    clientGroups,
    churnDrivers,
    ...market,
  };
}

/** The tours of the Editor the signed-in person has dismissed (`process`, `company`). A failed read counts as none: the tour just shows. */
export async function loadDismissedEditorTours(): Promise<string[]> {
  try {
    return await loadDismissedTours(await getDb());
  } catch {
    return [];
  }
}
