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
import { rpc, rpcRows } from "@transpera-flow/db/client";
import type { DB } from "@transpera-flow/db";
import { getDb } from "./auth/session";

// Reads for the Suggestions page (issue #25), as the signed-in user
// (RLS decides what's visible).

type Db = Awaited<ReturnType<typeof getDb>>;

// The proposal columns as a list, whichever form `PROPOSAL_ROW_COLUMNS` is exported in.
const PROPOSAL_COLUMNS = (Array.isArray(PROPOSAL_ROW_COLUMNS) ? PROPOSAL_ROW_COLUMNS : String(PROPOSAL_ROW_COLUMNS).split(",").map((s) => s.trim())) as unknown as (keyof DB["suggestion_proposals"] & string)[];

export interface WorkspaceHead {
  id: string;
  name: string;
  slug: string;
}

async function workspaceBySlug(db: Db, slug: string) {
  return (await db.selectFrom("workspaces").select(["id", "name", "slug", "settings", "provenance"]).where("slug", "=", slug).executeTakeFirst()) ?? null;
}

/** The company model as it is now, and the snapshot a run saved now would keep. */
export async function currentModel(db: Db, workspace: { id: string; name: string; slug: string; settings: unknown; provenance?: unknown }) {
  const [model, processes] = await Promise.all([loadCompanyModel(db, workspace), loadLiveRevisions(db, workspace.id)]);
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
  /** A visitor's email and the text held from members and viewers, for each play-link idea. Agency admins and the Owner only; empty for everyone else (B4). */
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
  db: Db,
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
    links.some((l) => l.process_id) || playProcessIds.length ? db.selectFrom("processes").select(["id", "name"]).where("workspace_id", "=", ws).execute() : null,
    stepIds.length ? db.selectFrom("steps").select(["id", "name"]).where("workspace_id", "=", ws).where("id", "in", stepIds).execute() : null,
    issueIds.length ? db.selectFrom("issues").select(["id", "number", "title", "process_id"]).where("workspace_id", "=", ws).where("id", "in", issueIds).execute() : null,
    wants("roles") ? db.selectFrom("roles").select(["id", "name"]).where("workspace_id", "=", ws).execute() : null,
    wants("services") ? db.selectFrom("services").select(["id", "name"]).where("workspace_id", "=", ws).execute() : null,
    // A person's name only for a reader who sees everyone: `team_capacity` gives everyone else labels, which are not names.
    wants("people") && opts.seesEveryone ? rpc(db, "team_capacity", { ws }) : null,
  ]);
  const teamPeople = ((team ?? { people: [] }) as { sees_everyone?: boolean; people?: { id: string; name: string }[] }).sees_everyone ? ((team as { people: { id: string; name: string }[] }).people ?? []) : [];
  return {
    processes: Object.fromEntries((processes ?? []).map((r) => [r.id, r.name])),
    steps: Object.fromEntries((steps ?? []).map((r) => [r.id, r.name])),
    issues: Object.fromEntries((issues ?? []).map((r) => [r.id, { number: r.number, title: r.title, processId: r.process_id }])),
    roles: Object.fromEntries((roles ?? []).map((r) => [r.id, r.name])),
    services: Object.fromEntries((services ?? []).map((r) => [r.id, r.name])),
    ...(teamPeople.length ? { people: Object.fromEntries(teamPeople.map((r) => [r.id, r.name])) } : {}),
    ...(opts.currency ? { currency: opts.currency } : {}),
  };
}

/** The Suggestions page. */
export async function loadSuggestionsPage(slug: string): Promise<SuggestionsPageData | null> {
  const db = await getDb();
  const workspace = await workspaceBySlug(db, slug);
  if (!workspace) return null;
  const ws = workspace.id;
  const [canEdit, canManage, seesPeople, suggestions, proposals, model, sources] = await Promise.all([
    rpc(db, "can_edit_workspace", { ws }),
    rpc(db, "can_manage_workspace", { ws }),
    rpc(db, "can_see_people", { ws }),
    loadSuggestions(db, ws),
    loadProposals(db, ws),
    loadCompanyModel(db, workspace),
    loadSources(db, ws),
  ]);
  // A visitor's email and the wording held from members and viewers are for Agency admins and the Owner (B4); empty for the rest.
  const contacts = canEdit === true ? await loadPlayContacts(db, ws) : {};
  const currency = (workspace.settings as { currency?: string } | null)?.currency;
  let changes: AuditEntry[] | null = null;
  const people: Record<string, string> = {};
  const stepNames: Record<string, string> = {};
  if (canManage) {
    const [log, members] = await Promise.all([
      db
        .selectFrom("audit_log")
        .select(["id", "created_at", "actor_id", "actor_kind", "action", "target_table", "target_id", "diff"])
        .where("workspace_id", "=", ws)
        .where("target_table", "in", [...COMPANY_AUDIT_TABLES])
        .orderBy("created_at", "desc")
        .orderBy("id")
        .limit(50)
        .execute(),
      rpcRows(db, "workspace_members", { ws }),
    ]);
    // actor_kind is check-constrained; diff is jsonb.
    changes = log as unknown as AuditEntry[];
    for (const m of members ?? []) if (m.email) people[m.user_id] = m.email;
    // The steps the log names (a skill's, a per-person time's). A step id is stable across a process's versions, so it has one row per
    // revision: newest first, the first name per id wins (a draft's copy counts as newest, so an unpublished rename can show; only
    // owners and agency admins read this). At most 50 entries, so at most 50 ids; the page-at-a-time read is kept from when a
    // response was capped by PostgREST's `max-rows`.
    const ids = auditStepIds(changes);
    if (ids.length) {
      const PAGE = 1000;
      const rows: { id: string; name: string }[] = [];
      for (let from = 0; ; from += PAGE) {
        const page = await db
          .selectFrom("steps")
          .select(["id", "name", "created_at"])
          .where("workspace_id", "=", ws)
          .where("id", "in", ids)
          .orderBy("created_at", "desc")
          .orderBy("id")
          .limit(PAGE)
          .offset(from)
          .execute();
        rows.push(...page);
        if (page.length < PAGE) break;
      }
      Object.assign(stepNames, newestStepNames(rows));
    }
  }
  return {
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    canEdit: canEdit === true,
    suggestions,
    proposals,
    lookups: await proposalLookups(db, ws, proposals, { currency, seesEveryone: seesPeople === true }),
    contacts,
    model,
    sources: Object.fromEntries(sources.map((s) => [s.id, s.title])),
    changes,
    people,
    stepNames,
  };
}

const countOf = async (q: { executeTakeFirstOrThrow(): Promise<{ count: number | string | bigint }> }) => Number((await q.executeTakeFirstOrThrow()).count);

/** The numbers beside the sidebar's Processes, Issues and Sources items: how many processes, tracked issues still open and sources linked to nothing. */
export const shellCounts = cache(async (workspaceId: string): Promise<{ processes: number; openIssues: number; unlinkedSources: number }> => {
  const db = await getDb();
  const [processes, issues, unlinked] = await Promise.all([
    countOf(db.selectFrom("processes").select((eb) => eb.fn.countAll<number>().as("count")).where("workspace_id", "=", workspaceId).where("is_company", "=", false).where("archived_at", "is", null)),
    countOf(db.selectFrom("issues").select((eb) => eb.fn.countAll<number>().as("count")).where("workspace_id", "=", workspaceId).where("status", "in", [...ACTIVE_STORED_STATUSES])),
    // The count is a warning, not a page: if it can't be read (say the function isn't there yet), show none rather than break the shell.
    rpc(db, "unlinked_source_count", { p_workspace: workspaceId }).catch((err: unknown) => {
      console.error("Couldn't count the unlinked sources; showing none.", err instanceof Error ? err.message : err);
      return null;
    }),
  ]);
  return { processes, openIssues: issues, unlinkedSources: unlinked ?? 0 };
});

/** How many suggestions wait for review (for the workspace nav): company-model changes, proposed issues and solution ideas. */
export const pendingSuggestionCount = cache(async (workspaceId: string): Promise<number> => {
  const db = await getDb();
  const [changes, proposals] = await Promise.all([
    countOf(db.selectFrom("suggestions").select((eb) => eb.fn.countAll<number>().as("count")).where("workspace_id", "=", workspaceId).where("status", "=", "pending")),
    countPendingProposals(db, workspaceId),
  ]);
  return changes + proposals;
});

/** One waiting solution idea (A52), for "Build it" in the Editor. Null when it isn't there, isn't an idea, or has been dealt with. */
export async function loadIdeaProposal(workspaceId: string, ideaId: string): Promise<ProposalRow | null> {
  const db = await getDb();
  const r = await db
    .selectFrom("suggestion_proposals")
    .select(PROPOSAL_COLUMNS)
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", ideaId)
    .where("kind", "=", "solution_idea")
    .where("status", "=", "pending")
    .executeTakeFirst();
  return (r as unknown as ProposalRow | undefined) ?? null;
}

/** The solution ideas waiting for one issue (A52), with the names their cards show: the Issue page's "AI ideas". */
export async function loadIssueIdeas(workspaceId: string, issueId: string): Promise<{ ideas: ProposalRow[]; lookups: ProposalLookups }> {
  const db = await getDb();
  const r = await db
    .selectFrom("suggestion_proposals")
    .select(PROPOSAL_COLUMNS)
    .where("workspace_id", "=", workspaceId)
    .where("issue_id", "=", issueId)
    .where("kind", "=", "solution_idea")
    .where("status", "=", "pending")
    .orderBy("created_at", "desc")
    .orderBy("id")
    .execute();
  const ideas = r as unknown as ProposalRow[];
  return { ideas, lookups: await proposalLookups(db, workspaceId, ideas) };
}
