// The demo's forecast plans (B7, issue #36): an in-memory store for the length of the tab, like the demo's solutions
// (solutions/demo.ts). Saving writes nothing but this list. Seeded with two plans so "compare" works on first open.

import { useSyncExternalStore } from "react";
import { NORTHBEAM_WORKSPACE_ID, northbeamRoleIds, type ForecastPlanMarker, type ForecastPlanRow } from "@transpera-flow/db";
import { DEMO_FORECAST_SOLUTION_ID } from "./demo";

const SEEDED_AT = "2026-10-05T00:00:00.000Z";

const seed = (id: string, name: string, markers: ForecastPlanMarker[]): ForecastPlanRow => ({
  id,
  workspace_id: NORTHBEAM_WORKSPACE_ID,
  name,
  markers,
  created_at: SEEDED_AT,
  updated_at: SEEDED_AT,
  created_by: null,
});

const hire = (id: string, date: string): ForecastPlanMarker => ({ id, kind: "hire", date, role_id: northbeamRoleIds.ppc, fte: 1 });

/** The plans the demo opens with. */
export const DEMO_PLANS: ForecastPlanRow[] = [
  seed("00000000-0000-4000-8000-0000000f0301", "Hire in January", [hire("00000000-0000-4000-8000-0000000f0311", "2027-01-01")]),
  seed("00000000-0000-4000-8000-0000000f0302", "Hire in March", [
    hire("00000000-0000-4000-8000-0000000f0312", "2027-03-01"),
    { id: "00000000-0000-4000-8000-0000000f0313", kind: "solution", date: "2027-04-01", solution_id: DEMO_FORECAST_SOLUTION_ID },
  ]),
];

let state: ForecastPlanRow[] = DEMO_PLANS;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const byName = (a: ForecastPlanRow, b: ForecastPlanRow) => a.name.localeCompare(b.name);

/** Save a plan into the demo's list (this tab only): a new one when `id` is null, else the one with that id. */
export function saveDemoPlan(plan: { id: string | null; name: string; markers: ForecastPlanMarker[] }): ForecastPlanRow {
  const now = new Date().toISOString();
  const existing = plan.id ? state.find((p) => p.id === plan.id) : undefined;
  const row: ForecastPlanRow = {
    id: existing?.id ?? crypto.randomUUID(),
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    name: plan.name,
    markers: structuredClone(plan.markers),
    created_at: existing?.created_at ?? now,
    updated_at: now,
    created_by: null,
  };
  state = (existing ? state.map((p) => (p.id === row.id ? row : p)) : [...state, row]).sort(byName);
  emit();
  return row;
}

/** Delete a plan from the demo's list. */
export function deleteDemoPlan(id: string): void {
  state = state.filter((p) => p.id !== id);
  emit();
}

/** The demo's plans as they are now (outside a component; the tests read this). */
export const demoPlansNow = (): ForecastPlanRow[] => state;

/** Puts the seeded plans back (tests). */
export function resetDemoPlans(): void {
  state = DEMO_PLANS;
  emit();
}

/** The demo's plans by name, kept up to date as they are saved. */
export function useDemoPlans(): ForecastPlanRow[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
    () => DEMO_PLANS,
  );
}
