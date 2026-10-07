// Proposed issues and solution ideas (A52; docs/PRD.md §7.1c): what AI proposes besides company-model changes. They
// wait in `suggestion_proposals` until a person acts on them (`review_proposals`, migration
// 20261124000000_suggestions_v2.sql). Nothing here writes issues or solutions: accepting a proposed issue goes through
// the Acknowledge path (`save_issue`) inside that function.

import type { Db } from "./queries";
import type { ProposalRow, ProposalStatus } from "./types";

export const PROPOSAL_ROW_COLUMNS =
  "id, workspace_id, kind, title, detail, payload, evidence, note, issue_id, status, created_via, import_source, proposer_name, share_link_id, applied, review_note, reviewed_by, reviewed_at, created_at, created_by" as const;

/** The workspace's proposals, newest first; optionally only one status. */
export async function loadProposals(db: Db, workspaceId: string, status?: ProposalStatus): Promise<ProposalRow[]> {
  let q = db.from("suggestion_proposals").select(PROPOSAL_ROW_COLUMNS).eq("workspace_id", workspaceId);
  if (status) q = q.eq("status", status);
  const r = await q.order("created_at", { ascending: false }).order("id").limit(500);
  if (r.error) throw r.error;
  // Check constraints limit the text columns; payload, evidence and applied are jsonb.
  return (r.data ?? []) as unknown as ProposalRow[];
}

/** How many proposals wait for a person (for the sidebar's pending count). */
export async function countPendingProposals(db: Db, workspaceId: string): Promise<number> {
  const r = await db.from("suggestion_proposals").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "pending");
  // 42P01 (Postgres) and PGRST205 (PostgREST): the table isn't there yet, so nothing waits. Anything else is a real failure.
  if (r.error) {
    if (r.error.code === "42P01" || r.error.code === "PGRST205") return 0;
    throw r.error;
  }
  return r.count ?? 0;
}

/** What only owners, editors and agency admins may read about a visitor's idea (B4): their email, and the fields held from members and viewers. */
export type PlayContact = { email: string | null; held: { title?: string; note?: string; name?: string } };

/** A visitor's email and held text for each play-link idea of the workspace. Empty for anyone who may not read them (42501). */
export async function loadPlayContacts(db: Db, workspaceId: string): Promise<Record<string, PlayContact>> {
  const r = await db.rpc("play_proposal_contacts", { ws: workspaceId });
  if (r.error) {
    // 42501: members and viewers. 42883 / PGRST202: the function isn't there yet (migration not applied).
    if (r.error.code === "42501" || r.error.code === "42883" || r.error.code === "PGRST202") return {};
    throw r.error;
  }
  const out: Record<string, PlayContact> = {};
  for (const [id, v] of Object.entries((r.data ?? {}) as Record<string, { email?: string | null; held?: PlayContact["held"] }>)) {
    out[id] = { email: v.email ?? null, held: v.held ?? {} };
  }
  return out;
}
