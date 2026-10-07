import "server-only";
import { cache } from "react";
import {
  ACTIVE_STORED_STATUSES,
  loadCompanyModel,
  loadLiveRevisions,
  loadSources,
  loadPlayContacts,
  loadProposals,
  loadSuggestions,
  PROPOSAL_ROW_COLUMNS,
  countPendingProposals,
  snapshotModel,
  type CompanyModel,
  type IssueProposalPayload,
  type PlayContact,
  type ProposalRow,
  type SuggestionRow,
} from "@transpera-flow/db";
import { auditStepIds, COMPANY_AUDIT_TABLES, newestStepNames, type AuditEntry } from "./suggestions/audit";
import { readIdea } from "./suggestions/idea";
import type { ProposalLookups } from "./suggestions/proposals";
import { createClient } from "./supabase/server";

// Reads for the Suggestions page (issue #25), as the signed-in user
// (RLS decides what's visible).

type Supabase = Awaited<ReturnType<typeof createClient>>;

export interface WorkspaceHead {
  id: string;
  name: string;
  slug: string;
}

async function workspaceBySlug(supabase: Supabase, slug: string) {
  const { data, error } = await supabase.from("workspaces").select("id, name, slug, settings, provenance").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return data;
}

/** The company model as it is now, and the snapshot a run saved now would keep. */
export async function currentModel(supabase: Supabase, workspace: { id: string; name: string; slug: string; settings: unknown; provenance?: unknown }) {
  const [model, processes] = await Promise.all([loadCompanyModel(supabase, workspace), loadLiveRevisions(supabase, workspace.id)]);
  return { model, snapshot: snapshotModel(model, processes), processes };
}

export interface SuggestionsPageData {
  workspace: WorkspaceHead;
  canEdit: boolean;
  suggestions: SuggestionRow[];
  /** Proposed issues and solution ideas (A52), newest first. */
  proposals: ProposalRow[];
  /** What the proposals point at, by name. */
  lookups: ProposalLookups;
  /** A visitor's email and the text held from members and viewers, for each play-link idea. Owners, editors and agency admins only; empty for everyone else (B4). */
  contacts: Record<string, PlayContact>;
  model: CompanyModel;
  /** Titles of the sources suggestions cite. */
  sources: Record<string, string>;
  /** Recent company-model changes, for owners and agency admins (RLS); null for everyone else. */
  changes: AuditEntry[] | null;
  /** User id → email, for the change log (owners and agency admins only). */
  people: Record<string, string>;
  /** Step id → name (the newest revision's), for the steps the change log names: skills and per-person times (#230). `{}` when there is no log. */
  stepNames: Record<string, string>;
}

const PATH_ID = /^(services|roles|people|steps)\.([^.]+)\./;

/**
 * The names the proposals' cards show: processes, steps and the issues ideas are for, and for a visitor's idea (B4) the roles, services
 * and (only for a reader who sees everyone) people its lever changes name.
 */
export async function proposalLookups(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ws: string,
  proposals: readonly ProposalRow[],
  opts: { currency?: string; seesEveryone?: boolean } = {},
): Promise<ProposalLookups> {
  const playIdeas = proposals.filter((p) => p.kind === "solution_idea" && p.created_via === "play_link");
  const leverPaths = playIdeas.flatMap((p) => readIdea(p.payload).levers.map((l) => PATH_ID.exec(l.path)).flatMap((m) => (m ? [{ family: m[1]!, id: m[2]! }] : [])));
  const leverSteps = leverPaths.filter((x) => x.family === "steps" && !x.id.startsWith("@")).map((x) => x.id);
  const wants = (family: string) => leverPaths.some((x) => x.family === family);
  const playProcessIds = playIdeas.flatMap((p) => ((p.payload as { process_id?: unknown }).process_id && typeof (p.payload as { process_id?: unknown }).process_id === "string" ? [(p.payload as { process_id: string }).process_id] : []));
  const links = proposals.flatMap((p) => {
    const l = p.kind === "issue" ? (p.payload as IssueProposalPayload).links : undefined;
    return Array.isArray(l) ? l.filter((x) => typeof x === "object" && x !== null) : [];
  });
  const stepIds = [
    ...new Set([
      ...links.flatMap((l) => (typeof l.step_id === "string" ? [l.step_id] : [])),
      ...proposals.flatMap((p) => (p.kind === "solution_idea" ? readIdea(p.payload).replaces : [])),
      ...leverSteps,
    ]),
  ];
  const issueIds = [...new Set(proposals.flatMap((p) => (p.issue_id ? [p.issue_id] : [])))];
  const [processes, steps, issues, roles, services, team] = await Promise.all([
    links.some((l) => l.process_id) || playProcessIds.length ? supabase.from("processes").select("id, name").eq("workspace_id", ws) : null,
    stepIds.length ? supabase.from("steps").select("id, name").eq("workspace_id", ws).in("id", stepIds) : null,
    issueIds.length ? supabase.from("issues").select("id, number, title, process_id").eq("workspace_id", ws).in("id", issueIds) : null,
    wants("roles") ? supabase.from("roles").select("id, name").eq("workspace_id", ws) : null,
    wants("services") ? supabase.from("services").select("id, name").eq("workspace_id", ws) : null,
    // A person's name only for a reader who sees everyone: `team_capacity` gives everyone else labels, which are not names.
    wants("people") && opts.seesEveryone ? supabase.rpc("team_capacity", { ws }) : null,
  ]);
  for (const r of [processes, steps, issues, roles, services, team]) if (r?.error) throw r.error;
  const teamPeople = ((team?.data ?? { people: [] }) as { sees_everyone?: boolean; people?: { id: string; name: string }[] }).sees_everyone ? ((team?.data as { people: { id: string; name: string }[] }).people ?? []) : [];
  return {
    processes: Object.fromEntries((processes?.data ?? []).map((r) => [r.id, r.name])),
    steps: Object.fromEntries((steps?.data ?? []).map((r) => [r.id, r.name])),
    issues: Object.fromEntries((issues?.data ?? []).map((r) => [r.id, { number: r.number, title: r.title, processId: r.process_id }])),
    roles: Object.fromEntries((roles?.data ?? []).map((r) => [r.id, r.name])),
    services: Object.fromEntries((services?.data ?? []).map((r) => [r.id, r.name])),
    ...(teamPeople.length ? { people: Object.fromEntries(teamPeople.map((r) => [r.id, r.name])) } : {}),
    ...(opts.currency ? { currency: opts.currency } : {}),
  };
}

/** The Suggestions page. */
export async function loadSuggestionsPage(slug: string): Promise<SuggestionsPageData | null> {
  const supabase = await createClient();
  const workspace = await workspaceBySlug(supabase, slug);
  if (!workspace) return null;
  const ws = workspace.id;
  const [canEdit, canManage, seesPeople, suggestions, proposals, model, sources] = await Promise.all([
    supabase.rpc("can_edit_workspace", { ws }),
    supabase.rpc("can_manage_workspace", { ws }),
    supabase.rpc("can_see_people", { ws }),
    loadSuggestions(supabase, ws),
    loadProposals(supabase, ws),
    loadCompanyModel(supabase, workspace),
    loadSources(supabase, ws),
  ]);
  if (canEdit.error) throw canEdit.error;
  if (canManage.error) throw canManage.error;
  // A visitor's email and the wording held from members and viewers are for owners, editors and agency admins (B4); empty for the rest.
  const contacts = canEdit.data === true ? await loadPlayContacts(supabase, ws) : {};
  const currency = (workspace.settings as { currency?: string } | null)?.currency;
  let changes: AuditEntry[] | null = null;
  const people: Record<string, string> = {};
  const stepNames: Record<string, string> = {};
  if (canManage.data) {
    const [log, members] = await Promise.all([
      supabase
        .from("audit_log")
        .select("id, created_at, actor_id, actor_kind, action, target_table, target_id, diff")
        .eq("workspace_id", ws)
        .in("target_table", [...COMPANY_AUDIT_TABLES])
        .order("created_at", { ascending: false })
        .order("id")
        .limit(50),
      supabase.rpc("workspace_members", { ws }),
    ]);
    if (log.error) throw log.error;
    // actor_kind is check-constrained; diff is jsonb.
    changes = (log.data ?? []) as unknown as AuditEntry[];
    for (const m of members.data ?? []) people[m.user_id] = m.email;
    // The steps the log names (a skill's, a per-person time's). A step id is stable across a process's versions, so it has one row per
    // revision: newest first, the first name per id wins (a draft's copy counts as newest, so an unpublished rename can show; only
    // owners and agency admins read this). PostgREST caps a response (`max-rows`, 1,000 by default) and the oldest rows would drop
    // off, which could leave an id unnamed, so read it a page at a time. At most 50 entries, so at most 50 ids.
    const ids = auditStepIds(changes);
    if (ids.length) {
      const PAGE = 1000;
      const rows: { id: string; name: string }[] = [];
      for (let from = 0; ; from += PAGE) {
        const page = await supabase
          .from("steps")
          .select("id, name, created_at")
          .eq("workspace_id", ws)
          .in("id", ids)
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, from + PAGE - 1);
        if (page.error) throw page.error;
        rows.push(...(page.data ?? []));
        if ((page.data ?? []).length < PAGE) break;
      }
      Object.assign(stepNames, newestStepNames(rows));
    }
  }
  return {
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    canEdit: canEdit.data === true,
    suggestions,
    proposals,
    lookups: await proposalLookups(supabase, ws, proposals, { currency, seesEveryone: seesPeople.data === true }),
    contacts,
    model,
    sources: Object.fromEntries(sources.map((s) => [s.id, s.title])),
    changes,
    people,
    stepNames,
  };
}

/** The numbers beside the sidebar's Processes, Issues and Sources items: how many processes, tracked issues still open and sources linked to nothing. */
export const shellCounts = cache(async (workspaceId: string): Promise<{ processes: number; openIssues: number; unlinkedSources: number }> => {
  const supabase = await createClient();
  const [processes, issues, unlinked] = await Promise.all([
    supabase.from("processes").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("is_company", false).is("archived_at", null),
    supabase.from("issues").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).in("status", ACTIVE_STORED_STATUSES),
    supabase.rpc("unlinked_source_count", { p_workspace: workspaceId }),
  ]);
  if (processes.error) throw processes.error;
  if (issues.error) throw issues.error;
  // The count is a warning, not a page: if it can't be read (say the function isn't there yet), show none rather than break the shell.
  if (unlinked.error) console.error("Couldn't count the unlinked sources; showing none.", unlinked.error.message);
  return { processes: processes.count ?? 0, openIssues: issues.count ?? 0, unlinkedSources: unlinked.error ? 0 : (unlinked.data ?? 0) };
});

/** How many suggestions wait for review (for the workspace nav): company-model changes, proposed issues and solution ideas. */
export const pendingSuggestionCount = cache(async (workspaceId: string): Promise<number> => {
  const supabase = await createClient();
  const [changes, proposals] = await Promise.all([
    supabase.from("suggestions").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "pending"),
    countPendingProposals(supabase, workspaceId),
  ]);
  if (changes.error) throw changes.error;
  return (changes.count ?? 0) + proposals;
});

/** One waiting solution idea (A52), for "Build it" in the Editor. Null when it isn't there, isn't an idea, or has been dealt with. */
export async function loadIdeaProposal(workspaceId: string, ideaId: string): Promise<ProposalRow | null> {
  const supabase = await createClient();
  const r = await supabase
    .from("suggestion_proposals")
    .select(PROPOSAL_ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", ideaId)
    .eq("kind", "solution_idea")
    .eq("status", "pending")
    .maybeSingle();
  if (r.error) throw r.error;
  return (r.data as unknown as ProposalRow | null) ?? null;
}

/** The solution ideas waiting for one issue (A52), with the names their cards show: the Issue page's "AI ideas". */
export async function loadIssueIdeas(workspaceId: string, issueId: string): Promise<{ ideas: ProposalRow[]; lookups: ProposalLookups }> {
  const supabase = await createClient();
  const r = await supabase
    .from("suggestion_proposals")
    .select(PROPOSAL_ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("issue_id", issueId)
    .eq("kind", "solution_idea")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .order("id");
  if (r.error) throw r.error;
  const ideas = (r.data ?? []) as unknown as ProposalRow[];
  return { ideas, lookups: await proposalLookups(supabase, workspaceId, ideas) };
}
