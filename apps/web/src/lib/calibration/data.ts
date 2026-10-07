import "server-only";
import { loadProcessBySlug, type CalibrationRows } from "@transpera-flow/db";
import { createClient } from "@/lib/supabase/server";
import { calibrationRows } from "./rows";
import { personTimesSetup, type PersonTimesSetup } from "./person-times";

// What the Calibration page (issue #41) needs for one process: the values a log is compared against and the past
// calibrations of the process. The values are the draft's when there is one (applying writes into the draft, so its
// values are what a change is checked against), else live's. Lead sources, seasonality and services are workspace-wide.

export interface CalibrationProcess {
  id: string;
  name: string;
  kind: string;
}

export interface PastCalibration {
  id: string;
  createdAt: string;
  fileName: string;
  rowCount: number;
  proposals: number;
  /** Applied times and steps, not counting per-person times. */
  applied: number;
  /** Per-person times applied (#227); 0 for anyone who may not see per-person times. */
  perPersonApplied: number;
}

export interface CalibrationPageData {
  workspaceId: string;
  processes: CalibrationProcess[];
  process: CalibrationProcess;
  /** The process has an open draft: what applying adds to. */
  hasDraft: boolean;
  stored: CalibrationRows;
  history: PastCalibration[];
  /** Per-person times (#227): hidden for members and viewers, off with the switch off, else the people to match and their times now. */
  personTimes: PersonTimesSetup;
}

export async function loadCalibrationPage(slug: string, processId: string | undefined): Promise<CalibrationPageData | null> {
  const supabase = await createClient();
  const loaded = await loadProcessBySlug(supabase, slug, processId ? { processId } : {});
  if (!loaded) return null;
  const { live, draft, processes } = loaded;
  const workspaceId = live.workspace.id;
  const { data: past } = await supabase
    .from("calibrations")
    .select("id, created_at, applied_keys, dataset_id, proposals:results->proposals")
    .eq("process_id", live.process.id)
    .order("created_at", { ascending: false })
    .limit(5);
  const datasetIds = [...new Set((past ?? []).map((c) => c.dataset_id))];
  const { data: datasets } = datasetIds.length
    ? await supabase.from("datasets").select("id, file_name, row_count").in("id", datasetIds)
    : { data: [] as { id: string; file_name: string; row_count: number }[] };
  const byId = new Map((datasets ?? []).map((d) => [d.id, d]));
  const personTimes = personTimesSetup(live, (draft ?? live).steps);
  const factorKey = (k: string) => k.startsWith("factor:");
  return {
    workspaceId,
    processes: processes.filter((p) => p.live || p.draft).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    process: { id: live.process.id, name: live.process.name, kind: live.process.kind },
    hasDraft: Boolean(draft),
    stored: calibrationRows(live, draft),
    history: (past ?? []).map((c) => ({
      id: c.id,
      createdAt: c.created_at,
      fileName: byId.get(c.dataset_id)?.file_name ?? "",
      rowCount: byId.get(c.dataset_id)?.row_count ?? 0,
      proposals: Array.isArray(c.proposals) ? c.proposals.filter((p) => p && typeof p === "object" && (p as { set?: unknown }).set).length : 0,
      applied: c.applied_keys.filter((k) => !factorKey(k)).length,
      perPersonApplied: personTimes.state === "hidden" ? 0 : c.applied_keys.filter(factorKey).length,
    })),
    personTimes,
  };
}
