"use server";

import { refresh } from "next/cache";
import type { Json } from "@transpera-flow/db";
import { parseApplyRequest } from "@/lib/calibration/request";
import { createClient } from "@/lib/supabase/server";

// Calibration (issue #41): store the record of the step log and the proposals as computed, then apply the ones the person
// ticked. Runs as the signed-in user: row-level security lets owners and editors write, and `apply_calibration` puts step
// values into the process's draft (never live) and lead volumes live, all marked measured, skipping any value that
// changed since the log was read.

export type ApplyOutcome =
  | {
      status: "ok";
      calibrationId: string;
      results: { key: string; status: string }[];
      draft: { revision_id: string; number: number; created: boolean } | null;
    }
  | { status: "error"; message: string };

export async function applyCalibration(input: unknown): Promise<ApplyOutcome> {
  const parsed = parseApplyRequest(input);
  if (!parsed.ok) return { status: "error", message: parsed.message };
  const r = parsed.request;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return { status: "error", message: "Your session has ended. Sign in again." };

  const denied = { status: "error", message: "Only owners and editors can apply calibration here." } as const;
  const { data: dataset, error: datasetError } = await supabase
    .from("datasets")
    .insert({ workspace_id: r.workspaceId, kind: "step_log", process_id: r.processId, file_name: r.fileName, column_map: r.columnMap as Json, row_count: r.rowCount })
    .select("id")
    .single();
  if (datasetError || !dataset) return datasetError?.code === "42501" ? denied : { status: "error", message: "Couldn't save the log's record. Try again." };

  const { data: calibration, error: calibrationError } = await supabase
    .from("calibrations")
    .insert({ workspace_id: r.workspaceId, dataset_id: dataset.id, process_id: r.processId, results: r.results as unknown as Json })
    .select("id")
    .single();
  if (calibrationError || !calibration) return calibrationError?.code === "42501" ? denied : { status: "error", message: "Couldn't save the proposals. Try again." };

  const { data, error } = await supabase.rpc("apply_calibration", { p_calibration: calibration.id, p_keys: r.keys });
  if (error) return { status: "error", message: error.code === "42501" ? denied.message : "Couldn't apply. Try again." };
  const out = data as { status: string; results?: { key: string; status: string }[]; draft?: { revision_id: string; number: number; created: boolean } | null };
  if (out.status !== "ok") return denied;
  // The process page, the Editor and the sidebar read the draft and the lead sources.
  refresh();
  return { status: "ok", calibrationId: calibration.id, results: out.results ?? [], draft: out.draft ?? null };
}
