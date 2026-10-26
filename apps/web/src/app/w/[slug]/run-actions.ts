"use server";

import { loadCompanyModel, loadLiveRevisions, snapshotModel } from "@transpera-flow/db";
import { parseSaveRun, type SaveRunResult } from "@/lib/runs/runs";
import { jsonb, pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Saving the run the process page shows (issue #25; docs/PRD.md §5 `runs`,
// D19). The server takes the model snapshot itself, as the signed-in user, so
// "model changed since this run" compares like with like. Editors, owners
// and agency admins may save runs (RLS).

export async function saveRun(input: unknown): Promise<SaveRunResult> {
  const parsed = parseSaveRun(input);
  if (!parsed.ok) return { status: "error", message: parsed.message };
  const run = parsed.value;
  if (!(await getSessionUser())) return { status: "error", message: "Your session has ended. Sign in again." };
  const db = await getDb();

  const process = await db.selectFrom("processes").select(["id", "workspace_id", "is_company"]).where("id", "=", run.processId).executeTakeFirst().catch(() => undefined);
  if (!process) return { status: "error", message: "That process isn't available." };
  if (process.is_company) return { status: "error", message: "The company map can't be simulated: it is a picture of the business, not a process." };
  const workspace = await db
    .selectFrom("workspaces")
    .select(["id", "name", "slug", "settings", "provenance"])
    .where("id", "=", process.workspace_id)
    .executeTakeFirst()
    .catch(() => undefined);
  if (!workspace) return { status: "error", message: "That workspace isn't available." };

  const [model, processes] = await Promise.all([loadCompanyModel(db, workspace), loadLiveRevisions(db, workspace.id)]);
  if (processes.find((p) => p.id === run.processId)?.revision_id !== run.revisionId) {
    return { status: "error", message: "A newer revision of this process has been published. Reload the page to run it, then save." };
  }
  try {
    const data = await db
      .insertInto("runs")
      .values({
        workspace_id: workspace.id,
        process_id: run.processId,
        name: run.name,
        revision_ids: processes.map((p) => p.revision_id),
        reps: run.reps,
        seed: run.seed,
        params_snapshot: jsonb(snapshotModel(model, processes)),
        results: jsonb(run.results),
        duration_ms: run.durationMs,
        engine_version: run.engineVersion,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { status: "ok", id: data.id };
  } catch (e) {
    return { status: "error", message: pgCode(e) === "42501" ? "You don't have permission to save runs here." : "Couldn't save the run. Try again." };
  }
}
