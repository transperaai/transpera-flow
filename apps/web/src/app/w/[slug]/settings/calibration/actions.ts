"use server";

import { refresh } from "next/cache";
import type { Json } from "@transpera-flow/db";
import { parseClientApplyRequest } from "@/lib/calibration/client-request";
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

// Calibration from a clients file and a servicing log (issue #41, part 2): record the files and the results as computed, and
// apply the churn changes the person ticked (none is fine: the checks are saved on their own), in one call
// (`record_client_calibration`, one transaction). A group's normal churn changes live, marked measured, skipping any group
// whose churn changed since the file was read. Client ids never get here: the page sends counts, names the model has and numbers.

export type ClientApplyOutcome =
  | { status: "ok"; calibrationId: string; results: { key: string; status: string }[] }
  | { status: "error"; message: string };

export async function recordClientCalibration(input: unknown): Promise<ClientApplyOutcome> {
  const supabase = await createClient();
  // The workspace's own service names are the only names stored (RLS: members read them).
  const workspace = typeof input === "object" && input !== null ? (input as { workspaceId?: unknown }).workspaceId : null;
  const { data: services } = typeof workspace === "string" ? await supabase.from("services").select("name").eq("workspace_id", workspace) : { data: [] };
  const parsed = parseClientApplyRequest(input, (services ?? []).map((s) => s.name));
  if (!parsed.ok) return { status: "error", message: parsed.message };
  const r = parsed.request;
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return { status: "error", message: "Your session has ended. Sign in again." };

  const denied = "Only owners and editors can apply calibration here.";
  const file = (f: typeof r.clients) => (f ? ({ file_name: f.fileName, column_map: f.columnMap, row_count: f.rowCount } as Json) : null);
  const { data, error } = await supabase.rpc("record_client_calibration", {
    p_workspace: r.workspaceId,
    p_clients: file(r.clients),
    p_log: file(r.log),
    p_results: r.results as unknown as Json,
    p_keys: r.keys,
  });
  if (error) return { status: "error", message: error.code === "42501" ? denied : "Couldn't save. Try again." };
  const out = data as { status: string; calibration_id?: string; results?: { key: string; status: string }[] } | null;
  if (!out || out.status !== "ok" || !out.calibration_id) return { status: "error", message: denied };
  // Settings (churn drivers, client groups) and the model read what changed.
  refresh();
  return { status: "ok", calibrationId: out.calibration_id, results: [...(out.results ?? []), ...r.skipped] };
}
