// The headline numbers one workspace shows on the agency's list (issue #30, B1 part 3): flow efficiency, processes needing
// attention and client groups at risk, read off the Overview's own run and the ratings it already shows. The Overview records
// them (`recordHeadline`); the agency's home page reads them from `workspace_headlines`. Pure: no React, no clock.

import { clientHealthSummary, type EngineModel, type Rating, type SimulationResult } from "@transpera-flow/engine";
import { processHealth, timeSplitOf, workingShare } from "./health";

/** What `workspace_headlines.numbers` holds (the table's check pins this shape, and no other keys). */
export interface HeadlineNumbers {
  /** The share of elapsed time at the steps that is hands-on work, 0 to 1; null when nothing was measured. */
  flow_efficiency: number | null;
  /** Processes rated Operational risk or Bad, and all processes (the "Across the company" group isn't one). */
  processes_attention: number;
  processes_total: number;
  /** Client groups whose health is At risk at the horizon, and all client groups. */
  client_groups_at_risk: number;
  client_groups_total: number;
}

/**
 * The headline numbers from the run at the workspace's own horizon. `groups` is each process's rating as the map and the
 * Processes table give it (the "Across the company" group left out), null when it has no confirmed open issue.
 */
export function headlineNumbers(model: EngineModel, result: SimulationResult, groups: readonly { rating: Rating | null }[]): HeadlineNumbers {
  const split = timeSplitOf(model, result);
  const share = split ? workingShare(split) : null;
  const health = processHealth(groups.map((g) => g.rating));
  const clients = clientHealthSummary(model, result).groups;
  return {
    flow_efficiency: share === null || !Number.isFinite(share) ? null : Math.min(1, Math.max(0, share)),
    processes_attention: health.attention,
    processes_total: health.total,
    client_groups_at_risk: clients.filter((g) => g.rating === "risk").length,
    client_groups_total: clients.length,
  };
}

/** Exactly the five fields, copied one by one: what is stored never carries anything else the caller sent along. */
export function pickHeadline(n: HeadlineNumbers): HeadlineNumbers {
  return {
    flow_efficiency: n.flow_efficiency,
    processes_attention: n.processes_attention,
    processes_total: n.processes_total,
    client_groups_at_risk: n.client_groups_at_risk,
    client_groups_total: n.client_groups_total,
  };
}

/** True when two sets of numbers say the same thing. Stored jsonb may come back in any key order, so compare field by field. */
export function sameHeadline(a: unknown, b: HeadlineNumbers): boolean {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  const y = pickHeadline(b);
  return (Object.keys(y) as (keyof HeadlineNumbers)[]).every((k) => x[k] === y[k]) && Object.keys(x).length === Object.keys(y).length;
}

/** True when stored headline numbers are still current: same engine, same published revisions, and under an hour old. */
export function headlineIsFresh(
  stored: { engine_version: string; revision_ids: readonly string[]; computed_at: string },
  now: { engineVersion: string; revisionIds: readonly string[]; at: Date },
): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  const age = now.at.getTime() - new Date(stored.computed_at).getTime();
  return stored.engine_version === now.engineVersion && same(stored.revision_ids, now.revisionIds) && age >= 0 && age < 60 * 60 * 1000;
}
