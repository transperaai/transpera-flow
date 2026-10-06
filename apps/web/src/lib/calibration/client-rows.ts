import type { ClientCalibrationRows, ProcessBundle } from "@transpera-flow/db";

// What the clients-file calibration (issue #41, part 2) reads from a workspace: its services and client groups, the
// servicing links and the names of the servicing processes, and which process simulates which services. Framework-free,
// so the server's loader and the demo use the same code.

/** The stored rows the estimators need, from a process's bundle (the workspace-wide parts are the same in every bundle). */
export function clientCalibrationRows(bundle: ProcessBundle, processes: readonly { id: string; name: string; kind: string }[]): ClientCalibrationRows {
  return {
    services: bundle.services,
    clientGroups: bundle.clientGroups ?? [],
    servicing: bundle.servicingLinks ?? [],
    processes: processes.map((p) => ({ id: p.id, name: p.name, kind: p.kind as "pipeline" | "servicing" })),
    hoursPerWeek: Number(bundle.workspace.settings.hours_per_week) || 40,
  };
}

/** A process to simulate, and the services whose clients it runs (the ones to back-solve there). */
export interface SimulationPlanItem {
  processId: string;
  serviceIds: string[];
}

/**
 * Which process runs each service that has a client group: the one it enters, or the workspace's default (live)
 * process when it enters none. One-off and inactive services have no churn to calibrate.
 */
export function simulationPlan(rows: Pick<ClientCalibrationRows, "services" | "clientGroups">, defaultProcessId: string): SimulationPlanItem[] {
  const grouped = new Set(rows.clientGroups.map((g) => g.service_id));
  const by = new Map<string, string[]>();
  for (const s of rows.services) {
    if (!s.active || s.pricing_model === "one_off" || !grouped.has(s.id)) continue;
    const pid = s.entry_process_id ?? defaultProcessId;
    by.set(pid, [...(by.get(pid) ?? []), s.id]);
  }
  return [...by.entries()].map(([processId, serviceIds]) => ({ processId, serviceIds: serviceIds.sort() })).sort((a, b) => (a.processId < b.processId ? -1 : 1));
}
