import "server-only";
import { loadProcessBySlug, type ClientCalibrationRows, type ProcessBundle } from "@transpera-flow/db";
import { createClient } from "@/lib/supabase/server";
import { clientCalibrationRows, simulationPlan } from "./client-rows";
import type { StoredCheck } from "./client-request";

// What the "Clients and servicing work" card (issue #41, part 2) needs: the workspace's services, client groups and
// servicing links, the live process that simulates each service's clients, and the last client calibrations. Everything is
// live, not a draft: churn is a company-model value and changes live, like lead volumes.

export interface ChurnRun {
  processId: string;
  processName: string;
  /** The services whose clients this process simulates (the ones to back-solve with it). */
  serviceIds: string[];
  /** Null when the process can't be loaded (archived, never published). */
  bundle: ProcessBundle | null;
}

export interface PastClientCalibration {
  id: string;
  createdAt: string;
  clientsFile: string | null;
  logFile: string | null;
  /** Churn proposals that could be applied, and how many were. */
  proposals: number;
  applied: number;
}

export interface ClientCalibrationPageData {
  workspaceId: string;
  rows: ClientCalibrationRows;
  runs: ChurnRun[];
  history: PastClientCalibration[];
}

export async function loadClientCalibration(slug: string): Promise<ClientCalibrationPageData | null> {
  const supabase = await createClient();
  const loaded = await loadProcessBySlug(supabase, slug, { draft: false });
  if (!loaded) return null;
  const { live, processes } = loaded;
  const workspaceId = live.workspace.id;
  const rows = clientCalibrationRows(live, processes);
  const named = new Map(processes.map((p) => [p.id, p.name]));

  // The process that runs a service is the one it enters, or the default live process.
  const runs: ChurnRun[] = [];
  for (const item of simulationPlan(rows, live.process.id)) {
    const bundle =
      item.processId === live.process.id ? live : ((await loadProcessBySlug(supabase, slug, { draft: false, processId: item.processId }))?.live ?? null);
    runs.push({ processId: item.processId, processName: named.get(item.processId) ?? bundle?.process.name ?? "", serviceIds: item.serviceIds, bundle });
  }
  // The default process is always simulated, even when it runs no client group: the checks compare with its numbers.
  if (!runs.some((r) => r.processId === live.process.id)) runs.push({ processId: live.process.id, processName: live.process.name, serviceIds: [], bundle: live });
  // The default process first: its run's simulated checks are the ones shown.
  runs.sort((a, b) => Number(b.processId === live.process.id) - Number(a.processId === live.process.id));

  const { data: past } = await supabase
    .from("calibrations")
    .select("id, created_at, applied_keys, results")
    .eq("workspace_id", workspaceId)
    .eq("results->>kind", "clients")
    .order("created_at", { ascending: false })
    .limit(5);
  const datasetIds = [...new Set((past ?? []).flatMap((c) => datasetsOf(c.results)))];
  const { data: datasets } = datasetIds.length
    ? await supabase.from("datasets").select("id, file_name").in("id", datasetIds)
    : { data: [] as { id: string; file_name: string }[] };
  const names = new Map((datasets ?? []).map((d) => [d.id, d.file_name]));
  return {
    workspaceId,
    rows,
    runs,
    history: (past ?? []).map((c) => {
      const [clients, log] = [datasetOf(c.results, "clients"), datasetOf(c.results, "servicing_log")];
      const proposals = isObject(c.results) && Array.isArray(c.results.proposals) ? c.results.proposals : [];
      return {
        id: c.id,
        createdAt: c.created_at,
        clientsFile: clients ? (names.get(clients) ?? null) : null,
        logFile: log ? (names.get(log) ?? null) : null,
        proposals: proposals.filter((p) => isObject(p) && p.set).length,
        applied: c.applied_keys.length,
      };
    }),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function datasetOf(results: unknown, key: "clients" | "servicing_log"): string | null {
  const d = isObject(results) && isObject(results.datasets) ? results.datasets[key] : null;
  return typeof d === "string" ? d : null;
}

const datasetsOf = (results: unknown): string[] => [datasetOf(results, "clients"), datasetOf(results, "servicing_log")].filter((x): x is string => x !== null);

/** The latest client calibration's checks, for the Churn drivers section to show beside the simulated values. */
export async function loadLatestChecks(workspaceId: string): Promise<{ asOf: number; checks: StoredCheck[] } | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("calibrations")
    .select("checks:results->checks, asOf:results->asOf")
    .eq("workspace_id", workspaceId)
    .eq("results->>kind", "clients")
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row || typeof row.asOf !== "number" || !Array.isArray(row.checks)) return null;
  const checks = (row.checks as unknown[]).filter((c) => isObject(c) && (c.id === "late" || c.id === "resp" || c.id === "onb")) as unknown as StoredCheck[];
  return checks.length ? { asOf: row.asOf, checks } : null;
}
