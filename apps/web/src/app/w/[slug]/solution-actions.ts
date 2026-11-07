"use server";

import { applyStepChangeEdit, carryStepChanges, parseStepChanges, type BlockBundle, type Json, type ProcessBundle, type SolutionIssueRow, type SolutionRow, type StepChangeEdit, type StoredStepChange } from "@transpera-flow/db";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { rpc } from "@transpera-flow/db/client";
import { parseSolutionInput, type SaveSolutionResult } from "@/lib/solutions/save";
import { serverVerdict, type CopyRun } from "@/lib/solutions/server-verdict";
import { parsePatches, type ScenarioPatch } from "@transpera-flow/engine";
import { isId } from "@/lib/sources/validate";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

const SOLUTION_ISSUE_COLS = ["solution_id", "issue_id", "workspace_id", "auto_verdict", "holds_pct", "auto_note", "user_verdict", "user_notes", "created_at", "updated_at", "created_by"] as const;

// Saving a solution (issue #114, A49). `save_solution` creates the solution and its links in one transaction, as the
// signed-in user through row-level security (Agency admins write; everyone in the workspace reads). It writes only
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
  if (/published version/.test(m)) return { status: "error", message: "A solution has to start from a published version of the process." } as const;
  if (error.code === "42501") return forbidden;
  if (error.code === "23503") return { status: "error", message: "The process, its live version or an issue is no longer there. Reload and try again." } as const;
  if (error.code === "23514") return { status: "error", message: "Some of those values aren't allowed." } as const;
  return { status: "error", message: "Couldn't save the solution. Try again." } as const;
}

/** Save a solution, with the issues it solves and the automatic verdict against each (worked out here). */
export async function createSolution(workspaceId: unknown, input: unknown, fromSolutionId?: unknown): Promise<SaveSolutionResult> {
  if (!isId(workspaceId)) return invalid;
  if (fromSolutionId !== undefined && fromSolutionId !== null && !isId(fromSolutionId)) return invalid;
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
    data = await rpc(db, "save_solution", args);
  } catch (e) {
    return failure(e);
  }
  let solution = data as unknown as SolutionRow;
  // A copy of a solution keeps its automations (D53): read from the stored source, not from what the browser sent, and only the effects on steps the copy still has.
  if (typeof fromSolutionId === "string") {
    const src = await db.selectFrom("solutions").select("step_changes").where("id", "=", fromSolutionId).where("workspace_id", "=", workspaceId).where("process_id", "=", v.processId).executeTakeFirst().catch(() => undefined);
    const carried = carryStepChanges(parseStepChanges(src?.step_changes), new Set(v.copy.steps.map((s) => s.id)));
    if (carried.length) {
      try {
        await db.updateTable("solutions").set({ step_changes: carried as unknown as Json }).where("id", "=", solution.id).execute();
        solution = { ...solution, step_changes: carried };
      } catch {
        return { status: "error", message: "The solution was saved, but its automations couldn't be copied across. Open it from the Solutions list and add them again." };
      }
    }
  }
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

export type StepChangesResult = { status: "ok"; changes: StoredStepChange[] } | { status: "error"; message: string };

const isEdit = (e: unknown): e is StepChangeEdit => {
  const o = e as { op?: unknown; key?: unknown; change?: unknown } | null;
  if (!o || typeof o !== "object") return false;
  if (o.op === "remove") return typeof o.key === "string";
  return o.op === "save" && (o.key === null || typeof o.key === "string") && typeof o.change === "object" && o.change !== null && Array.isArray((o.change as { effects?: unknown }).effects);
};

/**
 * One edit to the automations and augmentations in a solution's version (D53): add, change or remove one. One edit is one save, and
 * the new list is returned. As the signed-in user through row-level security (the same people who write solutions): anyone else
 * changes no rows and is told so. The list is written only if it is still the one the edit was made on.
 */
export async function saveStepChange(workspaceId: unknown, solutionId: unknown, edit: unknown): Promise<StepChangesResult> {
  if (!isId(workspaceId) || !isId(solutionId) || !isEdit(edit)) return invalid;
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  const read = () => db.selectFrom("solutions").select(["steps", "step_changes"]).where("id", "=", solutionId).where("workspace_id", "=", workspaceId).executeTakeFirst();
  let sol;
  try {
    sol = await read();
  } catch (e) {
    return failure(e);
  }
  if (!sol) return { status: "error", message: "That solution isn't there any more." };
  const current = parseStepChanges(sol.step_changes);
  const ids = new Set(((sol.steps as unknown as { steps?: { id?: unknown }[] }).steps ?? []).map((s) => String(s.id)));
  const next = applyStepChangeEdit(solutionId, current, edit, ids, randomUUID);
  if (!next.ok) return { status: "error", message: next.message };
  let rows;
  try {
    rows = await db
      .updateTable("solutions")
      .set({ step_changes: next.list as unknown as Json })
      .where("id", "=", solutionId)
      .where("workspace_id", "=", workspaceId)
      .where(sql<boolean>`step_changes = ${JSON.stringify(sol.step_changes)}::jsonb`)
      .returning("id")
      .execute();
  } catch (e) {
    return failure(e);
  }
  if (rows.length) return { status: "ok", changes: next.list };
  // Nothing written: someone changed the list first, or this person may not edit.
  const again = await read().catch(() => undefined);
  if (again && JSON.stringify(again.step_changes) !== JSON.stringify(sol.step_changes)) return { status: "error", message: "Someone else changed this solution's automations first. Reload the page to see them." };
  return forbidden;
}
