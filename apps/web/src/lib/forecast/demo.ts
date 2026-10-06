// The demo's forecast (issue #35): Northbeam with a sample plan, so the timeline has something planned to show: a
// PPC specialist hired in February, an account manager's leave over Christmas, and the sample market schedule
// (Soft from month 7, "Cautious 2027" from month 15). Only the Forecast page reads it; every other demo page simulates
// Northbeam as seeded. No database.

import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamStepIds,
  type ProcessBundle,
  type SolutionRow,
} from "@transpera-flow/db";
import { demoMarket } from "@/lib/market-demo";
import { solutionCopy } from "@/lib/solutions/bundle";
import { demoBundle } from "@/lib/sources/demo";

/** The demo forecast starts on a fixed date, so its months (and the screenshots and tests) don't move. */
export const DEMO_FORECAST_START = "2026-10-05";

export const DEMO_HIRE_ID = "00000000-0000-4000-8000-0000000f0001";

export function demoForecastBundle(): ProcessBundle {
  const bundle = demoBundle();
  const ws = bundle.workspace.id;
  const leah = northbeamPersonIds["Leah Brooks"]!;
  const { marketConditions, marketSchedule } = demoMarket();
  return {
    ...bundle,
    people: [
      ...bundle.people,
      { id: DEMO_HIRE_ID, workspace_id: ws, name: "Jade Hart", fte: 1, capacity_hours_week: null, cost_rate: null, active: true, start_date: "2027-02-01", end_date: null },
    ],
    personRoles: [...bundle.personRoles, { person_id: DEMO_HIRE_ID, role_id: northbeamRoleIds.ppc, workspace_id: ws }],
    personLeave: [...bundle.personLeave, { id: "00000000-0000-4000-8000-0000000f0101", person_id: leah, workspace_id: ws, start_date: "2026-12-14", end_date: "2027-01-08" }],
    marketConditions: marketConditions.map((c) => ({ ...c, workspace_id: ws })),
    marketSchedule: marketSchedule.map((e) => ({ ...e, workspace_id: ws })),
  };
}

export const DEMO_FORECAST_SOLUTION_ID = "00000000-0000-4000-8000-0000000f0201";

/**
 * A solution for the demo's plans (B7): Northbeam's main process with the hands-on time of "PPC campaign setup" halved
 * (8 hours to 4), so a plan that puts it live from a month shows what it does to the PPC specialists from then on.
 */
export const DEMO_FORECAST_SOLUTION: SolutionRow = (() => {
  const copy = solutionCopy(demoBundle());
  const steps = copy.steps.map((st) => (st.id === northbeamStepIds.ppc ? { ...st, work_hours: Number(st.work_hours) / 2 } : st));
  return {
    id: DEMO_FORECAST_SOLUTION_ID,
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    process_id: NORTHBEAM_PROCESS_ID,
    base_revision_id: NORTHBEAM_REVISION_ID,
    name: "Faster PPC campaign setup",
    notes: "",
    steps: { ...copy, steps },
    changed_step_ids: [northbeamStepIds.ppc],
    lever_changes: [],
    created_at: "2026-10-05T00:00:00.000Z",
    updated_at: "2026-10-05T00:00:00.000Z",
    created_by: null,
  };
})();
