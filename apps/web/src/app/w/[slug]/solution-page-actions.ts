"use server";

import { SOLUTION_ISSUE_COLUMNS, type SolutionIssueRow } from "@transpera-flow/db";
import { MAX_NOTES } from "@/lib/solutions/cards";
import { isId } from "@/lib/sources/validate";
import { createClient } from "@/lib/supabase/server";

// What the Solution page writes (issue #115, A50): your verdict and note on each issue a solution solves, and the notes on
// the solution. As the signed-in user through row-level security: owners and editors write, everyone in the workspace reads.
// The database logs a changed verdict or note on the issue's history (`solution_verdict_logged`), so nothing is logged here.

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "You don't have permission to change solutions here." } as const;
const invalid = { status: "error", message: "That isn't valid." } as const;

const failure = (error: { code?: string }) =>
  error.code === "42501" ? forbidden : ({ status: "error", message: "Couldn't save. Try again." } as const);

export type VerdictResult = { status: "ok"; link: SolutionIssueRow } | { status: "error"; message: string };

/**
 * Your verdict and/or your note on one issue a solution solves. Only the fields in `patch` are written, so saving a note never
 * rewrites a verdict (and the other way round): `verdict` null clears it, and a field left out is left alone. Anyone who can't
 * edit the workspace changes no rows, and is told so.
 */
export async function saveSolutionVerdict(workspaceId: unknown, solutionId: unknown, issueId: unknown, patch: unknown): Promise<VerdictResult> {
  if (!isId(workspaceId) || !isId(solutionId) || !isId(issueId)) return invalid;
  const p = (typeof patch === "object" && patch !== null ? patch : {}) as { verdict?: unknown; notes?: unknown };
  const hasVerdict = "verdict" in p && p.verdict !== undefined;
  const hasNotes = "notes" in p && p.notes !== undefined;
  if (!hasVerdict && !hasNotes) return invalid;
  if (hasVerdict && p.verdict !== null && p.verdict !== "pass" && p.verdict !== "fail") return invalid;
  if (hasNotes && (typeof p.notes !== "string" || p.notes.length > MAX_NOTES)) return { status: "error", message: "Keep the note to 4,000 characters." };
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return signedOut;
  const { data, error } = await supabase
    .from("solution_issues")
    .update({ ...(hasVerdict ? { user_verdict: p.verdict as "pass" | "fail" | null } : {}), ...(hasNotes ? { user_notes: p.notes as string } : {}) })
    .eq("solution_id", solutionId)
    .eq("issue_id", issueId)
    .eq("workspace_id", workspaceId)
    .select(SOLUTION_ISSUE_COLUMNS);
  if (error) return failure(error);
  if (!data.length) return forbidden;
  return { status: "ok", link: data[0] as unknown as SolutionIssueRow };
}

export type DeleteSolutionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * Delete a solution (issue #182). Its links to issues go with it; the database first writes them to the audit log and adds a
 * line to each issue's history (`log_solution_delete`). An issue it fixed keeps its resolution, without the pick. Anyone who
 * can't edit the workspace deletes nothing, and is told so.
 */
export async function deleteSolution(workspaceId: unknown, solutionId: unknown): Promise<DeleteSolutionResult> {
  if (!isId(workspaceId) || !isId(solutionId)) return invalid;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return signedOut;
  const { data, error } = await supabase.from("solutions").delete().eq("id", solutionId).eq("workspace_id", workspaceId).select("id");
  if (error) return error.code === "42501" ? forbidden : { status: "error", message: "Couldn't delete. Try again." };
  if (!data.length) return forbidden;
  return { status: "ok" };
}

export type NotesResult = { status: "ok"; notes: string } | { status: "error"; message: string };

/** The notes on a solution as a whole (not on one issue). */
export async function saveSolutionNotes(workspaceId: unknown, solutionId: unknown, notes: unknown): Promise<NotesResult> {
  if (!isId(workspaceId) || !isId(solutionId)) return invalid;
  if (typeof notes !== "string" || notes.length > MAX_NOTES) return { status: "error", message: "Keep the notes to 4,000 characters." };
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return signedOut;
  const { data, error } = await supabase.from("solutions").update({ notes }).eq("id", solutionId).eq("workspace_id", workspaceId).select("notes");
  if (error) return failure(error);
  if (!data.length) return forbidden;
  return { status: "ok", notes: data[0]!.notes };
}
