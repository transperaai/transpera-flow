"use server";

import { refresh } from "next/cache";
import type { Json } from "@transpera-flow/db";
import { parseApplyRequest } from "@/lib/calibration/request";
import { createClient } from "@/lib/supabase/server";

// Calibration (issue #41): record the step log and the proposals as computed and apply the ones the person ticked, in
// one call (`record_calibration`, one transaction: a refused or failed apply leaves no record, so retries don't pile
// them up). Runs as the signed-in user: row-level security lets owners and editors write; step values go into the
// process's draft (never live) and lead volumes live, all marked measured, skipping any value changed since the log
// was read.

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

  const denied = "Only owners and editors can apply calibration here.";
  const { data, error } = await supabase.rpc("record_calibration", {
    p_workspace: r.workspaceId,
    p_process: r.processId,
    p_file_name: r.fileName,
    p_column_map: r.columnMap as Json,
    p_row_count: r.rowCount,
    p_results: r.results as unknown as Json,
    p_keys: r.keys,
  });
  if (error) return { status: "error", message: error.code === "42501" ? denied : "Couldn't apply. Try again." };
  const out = data as { status: string; calibration_id?: string; results?: { key: string; status: string }[]; draft?: { revision_id: string; number: number; created: boolean } | null };
  if (out.status !== "ok" || !out.calibration_id) return { status: "error", message: denied };
  // The process page, the Editor and the sidebar read the draft and the lead sources.
  refresh();
  return { status: "ok", calibrationId: out.calibration_id, results: [...(out.results ?? []), ...r.skipped], draft: out.draft ?? null };
}
