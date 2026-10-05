import type { CalibrationRows, ProcessBundle } from "@transpera-flow/db";

/**
 * The values a step log is compared against (issue #41): the draft's steps and edges when the process has a draft
 * (applying writes into the draft, so a change is checked against it), else live's. Lead sources, seasonality, services
 * and the working week are the workspace's.
 */
export function calibrationRows(live: ProcessBundle, draft: ProcessBundle | null): CalibrationRows {
  const current = draft ?? live;
  return {
    process: live.process,
    steps: current.steps,
    edges: current.edges,
    services: live.services,
    leadSources: live.leadSources ?? [],
    seasonality: live.seasonality ?? [],
    hoursPerWeek: Number(live.workspace.settings.hours_per_week) || 40,
  };
}
