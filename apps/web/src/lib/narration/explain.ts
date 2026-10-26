// "Explain this run" (issue #29; docs/PRD.md §7.3): a saved run's headline
// results in prose, drafted by Claude on demand, checked number by number and
// cached per run in `narrations`. Everyone in the workspace reads a cached
// explanation; editors draft one (it costs an API call).

import type { Db, RunRow } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { runNarrationInput } from "./facts";
import type { NarrationModel } from "./narrate";
import { cachedNarration, findNarration, fromCache, type StoredNarration } from "./service";

export type ExplainResult =
  | { status: "ok"; narration: StoredNarration }
  | { status: "error"; code: "not_found" | "forbidden"; message: string };

async function runAndProcess(db: Db, runId: string): Promise<{ run: RunRow; processName: string } | null> {
  const data = await db
    .selectFrom("runs")
    .select(["id", "workspace_id", "process_id", "name", "scenario_id", "revision_ids", "engine_version", "reps", "seed", "params_snapshot", "results", "duration_ms", "created_at", "created_by"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!data) return null;
  const run = data as unknown as RunRow;
  let processName = "the process";
  if (run.process_id) {
    const p = await db.selectFrom("processes").select("name").where("id", "=", run.process_id).executeTakeFirst();
    if (p?.name) processName = p.name;
  }
  return { run, processName };
}

/** The cached explanation of a run, if there is one that still checks out. */
export async function cachedExplanation(db: Db, run: Pick<RunRow, "id" | "workspace_id" | "name" | "created_at" | "results">, processName: string): Promise<StoredNarration | null> {
  const input = runNarrationInput(run, processName);
  const row = await findNarration(db, run.workspace_id, run.id, input);
  return row ? fromCache(row, input) : null;
}

/** Explain a saved run: the cache, or (for editors) a new draft. */
export async function explainRun(db: Db, runId: string, { model, regenerate = false }: { model: NarrationModel | null; regenerate?: boolean }): Promise<ExplainResult> {
  const found = await runAndProcess(db, runId);
  if (!found) return { status: "error", code: "not_found", message: "That saved run isn't available." };
  const { run, processName } = found;
  if (!regenerate) {
    const hit = await cachedExplanation(db, run, processName);
    if (hit) return { status: "ok", narration: hit };
  }
  const edit = await rpc(db, "can_edit_workspace", { ws: run.workspace_id });
  if (!edit) return { status: "error", code: "forbidden", message: "Only editors can ask for a new explanation: it calls the Anthropic API." };
  const narration = await cachedNarration(db, { workspaceId: run.workspace_id, targetId: run.id, input: runNarrationInput(run, processName), model, regenerate });
  return { status: "ok", narration };
}
