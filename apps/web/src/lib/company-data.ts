import "server-only";
import { cache } from "react";
import { ACTIVE_STORED_STATUSES, loadCompanyModel, loadLiveRevisions, snapshotModel, type CompanyModel } from "@transpera-flow/db";
import { auditStepIds, COMPANY_AUDIT_TABLES, newestStepNames, type AuditEntry } from "./change-log/audit";
import { rpc, rpcRows } from "@transpera-flow/db/client";
import { getDb } from "./auth/session";

// Reads for the company model's pages, as the signed-in user (RLS decides what's visible): the model as it is now (for the
// "model changed since this run" banner), the change log, and the sidebar's counts. (The Suggestions page's reads lived here until
// it was removed, 28 Oct 2026.)

type Db = Awaited<ReturnType<typeof getDb>>;

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

export interface ChangeLogPageData {
  workspace: WorkspaceHead;
  model: CompanyModel;
  /** Recent company-model changes, for owners and agency admins (RLS); null for everyone else. */
  changes: AuditEntry[] | null;
  /** User id → email, for the change log (owners and agency admins only). */
  people: Record<string, string>;
  /** Step id → name (the newest revision's), for the steps the change log names: skills and per-person times (#230). `{}` when there is no log. */
  stepNames: Record<string, string>;
}

/** Settings -> Change log. */
export async function loadChangeLogPage(slug: string): Promise<ChangeLogPageData | null> {
  const db = await getDb();
  const workspace = await workspaceBySlug(db, slug);
  if (!workspace) return null;
  const ws = workspace.id;
  const [canManage, model] = await Promise.all([rpc(db, "can_manage_workspace", { ws }), loadCompanyModel(db, workspace)]);
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
  return { workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug }, model, changes, people, stepNames };
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
