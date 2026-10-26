"use server";

import { refresh } from "next/cache";
import { loadCompanyModel, loadProposals, loadSuggestions } from "@transpera-flow/db";
import { parseReview, type ReviewOutcome, type ReviewResult } from "@/lib/suggestions/review";
import type { ProposalOutcome, ProposalReviewResult } from "@/lib/suggestions/proposals";
import { rpc } from "@transpera-flow/db/client";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Accepting and rejecting company-model suggestions (issue #25). Runs as the
// signed-in user: `review_suggestions` applies each accepted patch under RLS
// (editors for people, services, clients and demand; owners for company
// settings), stamps the evidence into the values' provenance and audit-logs
// every write. Returns the suggestions and the model as they now are.

const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function reviewSuggestions(workspaceId: unknown, ids: unknown, decision: unknown, note: unknown): Promise<ReviewOutcome> {
  if (!isId(workspaceId)) return { status: "error", message: "That workspace isn't valid." };
  const parsed = parseReview(ids, decision, note);
  if (!parsed.ok) return { status: "error", message: parsed.message };
  if (!(await getSessionUser())) return { status: "error", message: "Your session has ended. Sign in again." };
  const db = await getDb();

  let data;
  try {
    data = await rpc(db, "review_suggestions", { ids: parsed.ids, decision: parsed.decision, note: parsed.note ?? undefined });
  } catch (e) {
    return { status: "error", message: pgCode(e) === "42501" ? "You don't have permission to review suggestions here." : "Couldn't save. Try again." };
  }

  const workspace = await db
    .selectFrom("workspaces")
    .select(["id", "name", "slug", "settings", "provenance"])
    .where("id", "=", workspaceId)
    .executeTakeFirst()
    .catch(() => undefined);
  if (!workspace) return { status: "error", message: "That workspace isn't available." };
  const [suggestions, model] = await Promise.all([loadSuggestions(db, workspaceId), loadCompanyModel(db, workspace)]);
  // The sidebar's pending count lives in the shared layout, which navigation doesn't re-render.
  refresh();
  return { status: "ok", results: data as unknown as ReviewResult[], suggestions, model };
}

/**
 * Accepting and rejecting proposed issues and solution ideas (A52). `review_proposals` runs as the signed-in user: it
 * creates an accepted issue through `save_issue` (the Acknowledge path), so the issue gets its number, links and history;
 * a rejected issue is dropped and a solution idea is dismissed. Returns the proposals as they now are.
 */
export async function reviewProposals(workspaceId: unknown, ids: unknown, decision: unknown, note: unknown): Promise<ProposalOutcome> {
  if (!isId(workspaceId)) return { status: "error", message: "That workspace isn't valid." };
  const parsed = parseReview(ids, decision, note);
  if (!parsed.ok) return { status: "error", message: parsed.message };
  if (!(await getSessionUser())) return { status: "error", message: "Your session has ended. Sign in again." };
  const db = await getDb();

  let data;
  try {
    data = await rpc(db, "review_proposals", { ids: parsed.ids, decision: parsed.decision, note: parsed.note ?? undefined });
  } catch (e) {
    return { status: "error", message: pgCode(e) === "42501" ? "You don't have permission to review suggestions here." : "Couldn't save. Try again." };
  }

  const proposals = await loadProposals(db, workspaceId);
  // The sidebar's pending count lives in the shared layout, which navigation doesn't re-render.
  refresh();
  return { status: "ok", results: data as unknown as ProposalReviewResult[], proposals };
}
