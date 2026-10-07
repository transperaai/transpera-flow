import type { SolutionsData } from "@/lib/solutions/cards";
import "server-only";
import { cache } from "react";
import {
  DEMAND_SETTINGS_COLUMNS,
  LEAD_SOURCE_COLUMNS,
  listProcesses,
  loadBlocks,
  loadSolutionIssues,
  loadProposals,
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
  type ForecastPlanRow,
  loadForecastPlans,
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
} from "@transpera-flow/db";
import type { HeadlineNumbers } from "./overview/headline";
import { roleUsage, type RoleUsage } from "./roles";
import { createClient } from "./supabase/server";

/** Workspaces the signed-in user can see (RLS decides). */
export async function listWorkspaces(): Promise<Pick<WorkspaceRow, "id" | "name" | "slug">[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("workspaces").select("id, name, slug").order("name");
  if (error) throw error;
  return data;
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
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("agency_workspace_list");
  if (error) throw error;
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
  const supabase = await createClient();
  const { data, error } = await supabase.from("workspaces").select("id, name, slug, branding").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return data;
});

/** The workspace's sources (RLS: everyone in the workspace can read them). */
export async function loadWorkspaceSources(workspaceId: string): Promise<SourceRow[]> {
  return loadSources(await createClient(), workspaceId);
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
  const supabase = await createClient();
  const { data: workspace, error } = await supabase.from("workspaces").select("id, name, slug").eq("slug", slug).maybeSingle();
  if (error) throw error;
  if (!workspace) return null;
  const [page, totalAll, rows, links, targets] = await Promise.all([
    searchSources(supabase, workspace.id, { sort: "newest" }),
    countSources(supabase, workspace.id),
    loadCitingRows(supabase, workspace.id),
    loadSourceLinks(supabase, workspace.id),
    loadLinkTargets(supabase, workspace.id),
  ]);
  // A link to a step that is in no current version still has a name somewhere: an earlier version's.
  const current = new Set(targets.steps.map((s) => s.id));
  const citations = Object.fromEntries(citationsBySource(rows));
  const cited = Object.keys(citations);
  const existing = await existingSourceIds(supabase, cited);
  const missing = [...new Set(links.flatMap((l) => (l.step_id && !current.has(l.step_id) ? [l.step_id] : [])))];
  const olderSteps = await loadStepNames(supabase, missing);
  return { workspace, sources: page.rows, total: page.total, totalAll, deletedSourceIds: cited.filter((id) => !existing.has(id)), citations, links, targets: { ...targets, olderSteps } };
}

/** What "+ Link" needs on any screen: the workspace's source links and the things a source can be linked to. */
export async function loadSourceLinking(workspaceId: string): Promise<{ links: SourceLinkRow[]; targets: LinkTargets }> {
  const supabase = await createClient();
  const [links, targets] = await Promise.all([loadSourceLinks(supabase, workspaceId), loadLinkTargets(supabase, workspaceId)]);
  return { links, targets };
}

/** The workspace's first process at its live revision, or null if not visible. */
export async function loadLiveProcess(slug: string): Promise<ProcessBundle | null> {
  return loadLiveProcessBySlug(await createClient(), slug);
}

/** Each process's live revision id, which a dismissed insight is measured against. */
export async function loadWorkspaceLiveRevisionIds(workspaceId: string): Promise<Record<string, string>> {
  return loadLiveRevisionIds(await createClient(), workspaceId);
}

/**
 * The workspace's tracked issues, newest first (RLS: everyone in the workspace can read them). A member or viewer gets an
 * opaque `detected_key` where it is a hash of AI text (B1 2b).
 */
export async function loadWorkspaceIssues(workspaceId: string): Promise<IssueRow[]> {
  return loadIssuesForReader(await createClient(), workspaceId);
}

/** One issue's history, oldest first (RLS: everyone in the workspace can read it). */
export async function loadWorkspaceIssueEvents(workspaceId: string, issueId: string): Promise<IssueEventRow[]> {
  return loadIssueEvents(await createClient(), workspaceId, issueId);
}

/** The workspace's processes, by id and name, for the register's process filter. */
export async function loadProcessNames(workspaceId: string): Promise<{ id: string; name: string }[]> {
  return (await listProcesses(await createClient(), workspaceId)).map((p) => ({ id: p.id, name: p.name }));
}

/** The workspace's processes with their kind, in creation order, for the Processes page. */
export async function loadProcessList(workspaceId: string): Promise<{ id: string; name: string; kind: string }[]> {
  return (await listProcesses(await createClient(), workspaceId)).map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
}

/** The workspace's block library, oldest first (RLS: everyone in the workspace can read it). */
export async function loadWorkspaceBlocks(workspaceId: string): Promise<BlockRow[]> {
  return loadBlocks(await createClient(), workspaceId);
}

/**
 * The workspace's solutions, newest first, and which issues each solves (RLS: everyone in the workspace can read them),
 * optionally only those that change one process. If they can't be read (say the tables aren't there yet), pages show none
 * rather than break.
 */
export async function loadWorkspaceSolutions(workspaceId: string, processId?: string): Promise<SolutionsData> {
  try {
    const db = await createClient();
    const [solutions, links] = await Promise.all([loadSolutions(db, workspaceId, processId), loadSolutionIssues(db, workspaceId)]);
    const ids = new Set(solutions.map((s) => s.id));
    return { solutions, links: links.filter((l) => ids.has(l.solution_id)), aiIds: await loadAiSolutionIds(db, workspaceId) };
  } catch (err) {
    console.error("Couldn't load the solutions; showing none.", err instanceof Error ? err.message : err);
    return { solutions: [], links: [] };
  }
}

/**
 * The workspace's forecast plans by name (B7). RLS: only owners, editors and agency admins read them, so anyone else gets
 * none. If they can't be read (say the table isn't there yet), the page shows none rather than break.
 */
export async function loadWorkspaceForecastPlans(workspaceId: string): Promise<ForecastPlanRow[]> {
  try {
    return await loadForecastPlans(await createClient(), workspaceId);
  } catch (err) {
    console.error("Couldn't load the forecast plans; showing none.", err instanceof Error ? err.message : err);
    return [];
  }
}

/** How many AI solution ideas are waiting in Suggestions (pending proposals of kind solution idea). Zero if they can't be read. */
export async function loadPendingIdeaCount(workspaceId: string): Promise<number> {
  try {
    return (await loadProposals(await createClient(), workspaceId, "pending")).filter((p) => p.kind === "solution_idea").length;
  } catch (err) {
    console.error("Couldn't count AI ideas; showing none.", err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * Who the workspace's members are, by user id: the name of the person linked to each membership (Settings > Access). A member with
 * no person linked is left out, so pages say "A team member" for them. (RLS, B1 2/3a: `memberships` and `people` are both read in
 * full only by owners, editors and agency admins (`can_see_people`); anyone else reads only their own membership row, and
 * their own person (`can_see_person`). So a member or viewer gets only their own name, and every other author falls back to
 * "A team member": that is the rule, not a gap.)
 */
export async function loadMemberNames(workspaceId: string): Promise<Record<string, string>> {
  try {
    const db = await createClient();
    const [members, people] = await Promise.all([
      db.from("memberships").select("user_id, person_id").eq("workspace_id", workspaceId),
      db.from("people").select("id, name").eq("workspace_id", workspaceId),
    ]);
    const nameOf = new Map((people.data ?? []).map((p) => [p.id, p.name]));
    const out: Record<string, string> = {};
    for (const m of members.data ?? []) {
      const name = m.person_id ? nameOf.get(m.person_id) : undefined;
      if (name) out[m.user_id] = name;
    }
    return out;
  } catch (err) {
    console.error("Couldn't load member names; showing none.", err instanceof Error ? err.message : err);
    return {};
  }
}

/**
 * The ids of solutions built from an AI idea: a proposal of kind solution idea that was built records the solution it made in
 * `applied.solution_id`. Empty if they can't be read (so every solution reads "By hand").
 */
async function loadAiSolutionIds(db: Awaited<ReturnType<typeof createClient>>, workspaceId: string): Promise<string[]> {
  try {
    // Only what is needed: a built solution idea's `applied`, which names the solution `build_proposal` made.
    const { data, error } = await db.from("suggestion_proposals").select("applied").eq("workspace_id", workspaceId).eq("kind", "solution_idea").eq("status", "built");
    if (error) throw error;
    return (data ?? []).flatMap((p) => {
      const id = (p.applied as { solution_id?: unknown } | null)?.solution_id;
      return typeof id === "string" ? [id] : [];
    });
  } catch {
    return [];
  }
}

/** The workspace's named clients, their services and who looks after them (issue #182): everyone in the workspace reads them. */
export async function loadWorkspaceClients(workspaceId: string) {
  return loadClients(await createClient(), workspaceId);
}

/** The workspace's saved scenarios, oldest first (RLS: everyone in the workspace can read them). */
export async function loadWorkspaceScenarios(workspaceId: string): Promise<ScenarioRow[]> {
  return loadScenarios(await createClient(), workspaceId);
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
  return loadProcessBySlug(await createClient(), slug, { ...(processId ? { processId } : {}), includeCompany });
}

/**
 * An earlier version of the process `live` is, for "Viewing version N · read only" (issue #103): the published revision numbered
 * `number` if it is not the live one, else null (the caller shows live). A draft is never an old version.
 */
export async function loadProcessVersion(live: ProcessBundle, number: number): Promise<ProcessBundle | null> {
  const supabase = await createClient();
  const { data: revision, error } = await supabase
    .from("process_revisions")
    .select("id")
    .eq("process_id", live.process.id)
    .eq("number", number)
    .in("status", ["published", "superseded"])
    .maybeSingle();
  if (error) throw error;
  if (!revision || revision.id === live.revision.id) return null;
  return loadProcessBundle(supabase, live.workspace, live.process, revision.id);
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
  const live = loaded && loaded.process.id === processId ? loaded : (await loadProcessBySlug(await createClient(), slug, { draft: false, processId }))?.live;
  if (!live) return null;
  if (live.revision.id === baseRevisionId) return { base: live, movedOn: null };
  const earlier = await loadProcessBundle(await createClient(), live.workspace, live.process, baseRevisionId);
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
  const supabase = await createClient();
  const { data: workspace, error } = await supabase.from("workspaces").select("id, name, slug").eq("slug", slug).maybeSingle();
  if (error) throw error;
  if (!workspace) return null;
  const processes = await listProcesses(supabase, workspace.id);
  return {
    workspace,
    processes: processes.map((p) => ({ id: p.id, name: p.name, kind: p.kind, live: p.live_revision_id !== null, draft: p.draft_revision_id !== null })),
  };
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
  /** agency_admin, owner or editor: may manage people. */
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
  /** Per-person times (C6): everyone's for owners and editors, only the viewer's own person's otherwise (RLS, `can_see_person`). */
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
  const supabase = await createClient();
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id, name, slug, settings")
    .eq("slug", slug)
    .maybeSingle();
  if (wsError) throw wsError;
  if (!workspace) return null;
  const ws = workspace.id;

  const { data: processes, error: pError } = await supabase
    .from("processes")
    .select("id, name, kind, live_revision_id")
    .eq("workspace_id", ws)
    // The company map is not a process to put roles or tags on, nor is an archived one (issue #182).
    .eq("is_company", false)
    .is("archived_at", null)
    .order("created_at")
    .order("id");
  if (pError) throw pError;
  const revisions = processes.flatMap((p) => (p.live_revision_id ? [p.live_revision_id] : []));

  const demandQueries = Promise.all([
    supabase.from("lead_sources").select(LEAD_SOURCE_COLUMNS).eq("workspace_id", ws).order("created_at").order("id"),
    supabase.from("seasonality").select(SEASONALITY_COLUMNS).eq("workspace_id", ws).order("month"),
    supabase.from("demand_settings").select(DEMAND_SETTINGS_COLUMNS).eq("workspace_id", ws).maybeSingle(),
    supabase.from("service_servicing").select(SERVICE_SERVICING_COLUMNS).eq("workspace_id", ws).order("created_at").order("id"),
    loadMarket(supabase, ws),
    loadClientGroups(supabase, ws),
    loadChurnDrivers(supabase, ws),
  ]);
  // "Used by 3 people" counts the whole team, which a member's own reads of the per-person tables can't: team_capacity
  // gives every reader the roles and assignments of everyone (B1 2b).
  const [canEdit, canManage, roles, steps, people, personRoles, personSkills, personLeave, services, tags, roleSteps, team, factorRows] = await Promise.all([
    supabase.rpc("can_edit_workspace", { ws }),
    supabase.rpc("can_manage_workspace", { ws }),
    supabase.from("roles").select("id, name, color, active").eq("workspace_id", ws).order("name"),
    supabase
      .from("steps")
      .select("id, name, role_id")
      .in("revision_id", revisions)
      .not("kind", "in", "(start,end)")
      .not("role_id", "is", null)
      .order("y")
      .order("x"),
    supabase
      .from("people")
      .select("id, workspace_id, name, email, fte, capacity_hours_week, cost_rate, active, start_date, end_date, notes")
      .eq("workspace_id", ws)
      .order("name"),
    supabase.from("person_roles").select("person_id, role_id, workspace_id").eq("workspace_id", ws),
    supabase.from("person_skills").select("person_id, step_id, workspace_id").eq("workspace_id", ws),
    supabase
      .from("person_leave")
      .select("id, person_id, workspace_id, start_date, end_date, note")
      .eq("workspace_id", ws)
      .order("start_date"),
    supabase.from("services").select(SERVICE_COLUMNS).eq("workspace_id", ws).order("created_at").order("id"),
    supabase.from("edges").select("condition_tag").in("revision_id", revisions).not("condition_tag", "is", null),
    // Every revision, live or not: a role a superseded step names can't be deleted either.
    supabase.from("steps").select("id, role_id").eq("workspace_id", ws).not("role_id", "is", null),
    loadTeam(supabase, ws),
    // This page isn't a share source, so a direct read is fine here (RLS: everyone's for editors, own for members).
    supabase.from("person_capacity_factors").select("person_id, step_id, workspace_id, factor, provenance").eq("workspace_id", ws).order("person_id").order("step_id", { nullsFirst: true }),
  ]);
  const [leadSources, seasonality, demand, servicingLinks, market, clientGroups, churnDrivers] = await demandQueries;
  for (const r of [canEdit, canManage, roles, steps, people, personRoles, personSkills, personLeave, services, tags, roleSteps, leadSources, seasonality, demand, servicingLinks, factorRows]) {
    if (r.error) throw r.error;
  }

  return {
    workspace: { ...workspace, settings: workspace.settings as unknown as WorkspaceSettings },
    canEdit: canEdit.data === true,
    canManage: canManage.data === true,
    roles: roles.data ?? [],
    roleUsage: roleUsage(roleSteps.data ?? [], team.personRoles, team.clientAssignments, (services.data ?? []) as ServiceRow[]),
    steps: steps.data ?? [],
    people: people.data ?? [],
    personRoles: personRoles.data ?? [],
    personSkills: personSkills.data ?? [],
    personLeave: personLeave.data ?? [],
    personCapacityFactors: (factorRows.data ?? []).map((r) => ({
      person_id: r.person_id,
      workspace_id: r.workspace_id,
      step_id: r.step_id,
      factor: Number(r.factor),
      source: factorSource(r.provenance),
      items: factorItems(r.provenance),
    })),
    // The cast narrows pricing_model, which a check constraint limits.
    services: (services.data ?? []) as ServiceRow[],
    processes: processes.map(({ id, name, kind }) => ({ id, name, kind })),
    conditionTags: [...new Set((tags.data ?? []).map((e) => e.condition_tag?.trim() ?? "").filter(Boolean))].sort(),
    // The casts give the provenance jsonb its shape.
    leadSources: (leadSources.data ?? []) as LeadSourceRow[],
    seasonality: (seasonality.data ?? []) as SeasonalityRow[],
    demand: demand.data as DemandSettingsRow | null,
    // recurrence and provenance are jsonb; the table's check limits recurrence to RecurrenceJson.
    servicingLinks: (servicingLinks.data ?? []) as unknown as ServiceServicingRow[],
    clientGroups,
    churnDrivers,
    ...market,
  };
}

/** The tours of the Editor the signed-in person has dismissed (`process`, `company`). A failed read counts as none: the tour just shows. */
export async function loadDismissedEditorTours(): Promise<string[]> {
  try {
    return await loadDismissedTours(await createClient());
  } catch {
    return [];
  }
}
