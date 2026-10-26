"use server";

import { refresh } from "next/cache";
import type { BlockBundle, Json, ProcessBundle, SolutionIssueRow, SolutionRow } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { parseSolutionInput, type SaveSolutionResult } from "@/lib/solutions/save";
import { serverVerdict, type CopyRun } from "@/lib/solutions/server-verdict";
import { parsePatches, type ScenarioPatch } from "@transpera-flow/engine";
import { isId } from "@/lib/sources/validate";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

const SOLUTION_ISSUE_COLS = ["solution_id", "issue_id", "workspace_id", "auto_verdict", "holds_pct", "auto_note", "user_verdict", "user_notes", "created_at", "updated_at", "created_by"] as const;

// Saving a solution (issue #114, A49). `save_solution` creates the solution and its links in one transaction, as the
// signed-in user through row-level security (owners and editors write; everyone in the workspace reads). It writes only
// the solution's own rows: the process, its live version and its draft are never touched (D18). Linking an issue moves it to
// Testing solutions and logs the event in the database (`solution_issue_tested`, through A47's history).
//
// The automatic verdict is worked out here, by simulating the stored copy against the issue's target as it is in the database.
// What the browser showed or sent is ignored.

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "You don't have permission to save solutions here." } as const;
const invalid = { status: "error", message: "That solution isn't valid." } as const;

/** A stored solution's lever changes, as patches (anything that isn't valid counts as none). */
const leversOf = (stored: unknown): ScenarioPatch[] => {
  const p = parsePatches(stored);
  return p.ok ? p.patches : [];
};

function failure(e: unknown) {
  const error = { code: pgCode(e), message: (e as { message?: string } | null)?.message };
  const m = error.message ?? "";
  if (/issue is closed/.test(m)) return { status: "error", message: "That issue is already resolved, marked won't fix or dismissed, so a solution can't be linked to it." } as const;
  if (/only a detection/.test(m)) return { status: "error", message: "That issue is only a detection. Acknowledge it as an issue first." } as const;
  if (/another process/.test(m)) return { status: "error", message: "That issue is about another process, so this solution can't be linked to it." } as const;
  if (/already been dealt with/.test(m)) return { status: "error", message: "That idea has already been built or dismissed." } as const;
  if (/linked to the idea's issue/.test(m)) return { status: "error", message: "A solution built from an idea has to be linked to the idea's issue." } as const;
  if (/idea is for another process/.test(m)) return { status: "error", message: "That idea is for another process." } as const;
  if (/no such idea/.test(m)) return { status: "error", message: "That idea isn't there any more, or isn't yours to build." } as const;
  if (/published version/.test(m)) return { status: "error", message: "A solution has to start from a published version of the process." } as const;
  if (error.code === "42501") return forbidden;
  if (error.code === "23503") return { status: "error", message: "The process, its live version or an issue is no longer there. Reload and try again." } as const;
  if (error.code === "23514") return { status: "error", message: "Some of those values aren't allowed." } as const;
  return { status: "error", message: "Couldn't save the solution. Try again." } as const;
}

/**
 * Save a solution, with the issues it solves and the automatic verdict against each (worked out here). With `ideaId` (A52: "Build it" on
 * a solution idea) the solution is saved through `build_proposal`, which also marks the idea built, in the same transaction.
 */
export async function createSolution(workspaceId: unknown, input: unknown, ideaId?: unknown): Promise<SaveSolutionResult> {
  if (!isId(workspaceId)) return invalid;
  if (ideaId !== undefined && ideaId !== null && !isId(ideaId)) return invalid;
  const parsed = parseSolutionInput(input);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  const v = parsed.value;
  const links: { issue_id: string; auto_verdict: string | null; holds_pct: number | null; auto_note: string }[] = [];
  // The copy is simulated once, for all the issues it is linked to.
  let base: ProcessBundle | undefined;
  let run: CopyRun | undefined;
  for (const l of v.links) {
    const r = await serverVerdict({ db, workspaceId, processId: v.processId, baseRevisionId: v.baseRevisionId, copy: v.copy, levers: v.levers, issueId: l.issueId, base, run });
    if (!r.ok) return { status: "error", message: r.message };
    base = r.base;
    run = r.run;
    const checked = r.verdict.status !== "unchecked";
    links.push({ issue_id: l.issueId, auto_verdict: checked ? r.verdict.status : null, holds_pct: checked ? r.verdict.holdsPct : null, auto_note: r.verdict.note });
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
  let data;
  try {
    data = typeof ideaId === "string" ? await rpc(db, "build_proposal", { ...args, p_proposal: ideaId }) : await rpc(db, "save_solution", args);
  } catch (e) {
    return failure(e);
  }
  // The sidebar's pending count lives in the shared layout, which navigation doesn't re-render.
  if (typeof ideaId === "string") refresh();
  const solution = data as unknown as SolutionRow;
  const saved = await db.selectFrom("solution_issues").select(SOLUTION_ISSUE_COLS).where("solution_id", "=", solution.id).execute().catch(() => []);
  return { status: "ok", solution, links: saved as unknown as SolutionIssueRow[] };
}

export type LinkSolutionResult = { status: "ok"; link: SolutionIssueRow } | { status: "error"; message: string };

/**
 * Link a saved solution to an issue it solves. The automatic verdict is worked out here from the stored copy and the issue's
 * target. The issue moves to Testing solutions. (For a solution started without an issue; A50's solution page puts a button on it.)
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
  const r = await serverVerdict({ db, workspaceId, processId: sol.process_id, baseRevisionId: sol.base_revision_id, copy: sol.steps as unknown as BlockBundle, levers: leversOf(sol.lever_changes), issueId });
  if (!r.ok) return { status: "error", message: r.message };
  const checked = r.verdict.status !== "unchecked";
  try {
    const data = await db
      .insertInto("solution_issues")
      .values({
        solution_id: solutionId,
        issue_id: issueId,
        workspace_id: workspaceId,
        auto_verdict: checked ? r.verdict.status : null,
        holds_pct: checked ? r.verdict.holdsPct : null,
        auto_note: r.verdict.note.slice(0, 1000),
      })
      .returning(SOLUTION_ISSUE_COLS)
      .executeTakeFirstOrThrow();
    return { status: "ok", link: data as unknown as SolutionIssueRow };
  } catch (e) {
    if (pgCode(e) === "23505") return { status: "error", message: "That solution is already linked to this issue." };
    return failure(e);
  }
}
