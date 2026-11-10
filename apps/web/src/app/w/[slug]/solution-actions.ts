"use server";

import { carryStepChanges, checkStepChange, cleanStepChange, type Json, type SolutionIssueRow, type SolutionRow } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { parseSolutionInput, type SaveSolutionResult } from "@/lib/solutions/save";
import { linkCheck } from "@/lib/solutions/server-verdict";
import { isId } from "@/lib/sources/validate";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

const SOLUTION_ISSUE_COLS = ["solution_id", "issue_id", "workspace_id", "auto_verdict", "holds_pct", "auto_note", "user_verdict", "user_notes", "created_at", "updated_at", "created_by"] as const;

// Saving a solution (issue #114, A49). `save_solution` creates the solution and its links in one transaction, as the
// signed-in user through row-level security (Agency admins write; everyone in the workspace reads), together with the automations
// it holds. It writes only
// the solution's own rows: the process, its live version and its draft are never touched (D18). Linking an issue moves it to
// Testing solutions and logs the event in the database (`solution_issue_tested`, through A47's history).
//
// The automatic verdict is worked out here, by simulating the stored copy against the issue's target as it is in the database.
// What the browser showed or sent is ignored.

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "You don't have permission to save solutions here." } as const;
const invalid = { status: "error", message: "That solution isn't valid." } as const;

function failure(e: unknown) {
  const error = { code: pgCode(e), message: (e as { message?: string } | null)?.message };
  const m = error.message ?? "";
  if (/issue is closed/.test(m)) return { status: "error", message: "That issue is already resolved, marked won't fix or dismissed, so a solution can't be linked to it." } as const;
  if (/only a detection/.test(m)) return { status: "error", message: "That issue is only a detection. Acknowledge it as an issue first." } as const;
  if (/another process/.test(m)) return { status: "error", message: "That issue is about another process, so this solution can't be linked to it." } as const;
  if (/published version/.test(m)) return { status: "error", message: "A solution has to start from a published version of the process." } as const;
  if (error.code === "42501") return forbidden;
  if (error.code === "23503") return { status: "error", message: "The process, its live version or an issue is no longer there. Reload and try again." } as const;
  if (error.code === "23514") return { status: "error", message: "Some of those values aren't allowed." } as const;
  return { status: "error", message: "Couldn't save the solution. Try again." } as const;
}

/** Save a solution, with the issues it solves and the automatic verdict against each (worked out here). */
export async function createSolution(workspaceId: unknown, input: unknown): Promise<SaveSolutionResult> {
  if (!isId(workspaceId)) return invalid;
  const parsed = parseSolutionInput(input);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  const v = parsed.value;
  // The automations the solution was edited with (D53) are part of what is saved. The browser's list is checked here, before anything is written: only the
  // effects on steps the saved copy has are kept, a change left with none is dropped, and each one passes the same checks as an edit (the column's check runs again).
  const copyIds = new Set(v.copy.steps.map((s) => s.id));
  const kept = carryStepChanges(v.stepChanges, copyIds).map((c) => ({ ...(c.id ? { id: c.id } : {}), ...cleanStepChange(c) }));
  for (const c of kept) {
    const problem = checkStepChange(c, copyIds);
    if (problem) return { status: "error", message: `${c.name}: ${problem}` };
  }
  // No automatic verdict (QA round 2): each link is checked, and the person gives their own verdict.
  const links: { issue_id: string; auto_verdict: string | null; holds_pct: number | null; auto_note: string }[] = [];
  for (const l of v.links) {
    const problem = await linkCheck(db, workspaceId, v.processId, l.issueId);
    if (problem) return { status: "error", message: problem };
    links.push({ issue_id: l.issueId, auto_verdict: null, holds_pct: null, auto_note: "" });
  }
  const args = {
    p_workspace: workspaceId,
    p_process: v.processId,
    p_base_revision: v.baseRevisionId,
    p_name: v.name,
    p_steps: v.copy as unknown as Json,
    p_changed: v.changedStepIds,
    p_levers: v.levers as unknown as Json,
    p_links: links,
  };
  // The solution, its links and its automations are written in one transaction: if the automations can't be saved, nothing is.
  let solution: SolutionRow;
  try {
    solution = await db.transaction().execute(async (trx) => {
      const row = (await rpc(trx, "save_solution", args)) as unknown as SolutionRow;
      if (!kept.length) return row;
      await trx.updateTable("solutions").set({ step_changes: kept as unknown as Json }).where("id", "=", row.id).execute();
      return { ...row, step_changes: kept };
    });
  } catch (e) {
    return failure(e);
  }
  const saved = await db.selectFrom("solution_issues").select(SOLUTION_ISSUE_COLS).where("solution_id", "=", solution.id).execute().catch(() => []);
  return { status: "ok", solution, links: saved as unknown as SolutionIssueRow[] };
}

export type LinkSolutionResult = { status: "ok"; link: SolutionIssueRow } | { status: "error"; message: string };

/**
 * Link a saved solution to an issue it solves (no automatic verdict, QA round 2: the person gives their own). The issue moves to
 * Testing solutions. (For a solution started without an issue; A50's solution page puts a button on it.)
 */
export async function linkSolutionToIssue(workspaceId: unknown, solutionId: unknown, issueId: unknown): Promise<LinkSolutionResult> {
  if (!isId(workspaceId) || !isId(solutionId) || !isId(issueId)) return invalid;
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  const sol = await db
    .selectFrom("solutions")
    .select(["id", "process_id", "base_revision_id", "steps", "lever_changes"])
    .where("id", "=", solutionId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst()
    .catch(() => undefined);
  if (!sol) return { status: "error", message: "That solution isn't there any more." };
  const problem = await linkCheck(db, workspaceId, sol.process_id, issueId);
  if (problem) return { status: "error", message: problem };
  try {
    const data = await db
      .insertInto("solution_issues")
      .values({
        solution_id: solutionId,
        issue_id: issueId,
        workspace_id: workspaceId,
        auto_verdict: null,
        holds_pct: null,
        auto_note: "",
      })
      .returning(SOLUTION_ISSUE_COLS)
      .executeTakeFirstOrThrow();
    return { status: "ok", link: data as unknown as SolutionIssueRow };
  } catch (e) {
    if (pgCode(e) === "23505") return { status: "error", message: "That solution is already linked to this issue." };
    return failure(e);
  }
}
