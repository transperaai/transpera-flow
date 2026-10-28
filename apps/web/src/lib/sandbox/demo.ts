// The demo's Sandbox scenarios (docs/plans/sandbox-p1-brief.md §5): an in-memory store for the length of the tab, like the demo's
// solutions (solutions/demo.ts). Saving writes nothing but this list. Seeded with "Hire in January", "Hire in March" (which also puts a
// solution live in April) and "Hire in March, then more leads" (which builds on it), so compare works on first open.

import { useSyncExternalStore } from "react";
import { northbeamSandboxScenarios, NORTHBEAM_HIRE_JANUARY_ID, NORTHBEAM_HIRE_MARCH_ID, NORTHBEAM_WORKSPACE_ID, type SandboxScenarioRow } from "@transpera-flow/db";
import { DEMO_FORECAST_SOLUTION_ID } from "@/lib/forecast/demo";
import type { SaveInput } from "./store-types";

const SEEDED_AT = "2026-10-05T00:00:00.000Z";
export const DEMO_THEN_LEADS_ID = "50000000-0000-4000-8000-000000000007";

const fixture = northbeamSandboxScenarios();
const january = fixture.find((s) => s.id === NORTHBEAM_HIRE_JANUARY_ID)!;
const march = fixture.find((s) => s.id === NORTHBEAM_HIRE_MARCH_ID)!;

/** The scenarios the demo opens with. */
export const DEMO_SCENARIOS: SandboxScenarioRow[] = ([
  january,
  {
    ...march,
    changes: [...march.changes, { id: "5b0000f2-0000-4000-8000-000000000002", lever: "E6", target: DEMO_FORECAST_SOLUTION_ID, op: "set", value: 1, from: "2027-04" }],
  },
  {
    id: DEMO_THEN_LEADS_ID,
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    name: "Hire in March, then more leads",
    description: "Builds on “Hire in March”: 25% more leads from May.",
    parent_id: NORTHBEAM_HIRE_MARCH_ID,
    changes: [{ id: "5b0000f3-0000-4000-8000-000000000001", lever: "A1", target: null, op: "multiply", value: 1.25, from: "2027-05" }],
    horizon_months: 12,
    start_date: null,
    created_at: SEEDED_AT,
    updated_at: SEEDED_AT,
    created_by: null,
  },
] as SandboxScenarioRow[]).map((s) => ({ ...s, created_at: SEEDED_AT, updated_at: SEEDED_AT }));

let state: SandboxScenarioRow[] = DEMO_SCENARIOS;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const byName = (a: SandboxScenarioRow, b: SandboxScenarioRow) => a.name.localeCompare(b.name);

/** Save a scenario into the demo's list (this tab only): a new one when `id` is null, else the one with that id. */
export function saveDemoScenario(scenario: SaveInput & { id: string | null }): SandboxScenarioRow {
  const now = new Date().toISOString();
  const existing = scenario.id ? state.find((p) => p.id === scenario.id) : undefined;
  const row: SandboxScenarioRow = {
    id: existing?.id ?? crypto.randomUUID(),
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    name: scenario.name,
    description: scenario.description,
    parent_id: scenario.parent_id,
    changes: structuredClone(scenario.changes),
    horizon_months: scenario.horizon_months,
    start_date: existing?.start_date ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    created_by: null,
  };
  state = (existing ? state.map((p) => (p.id === row.id ? row : p)) : [...state, row]).sort(byName);
  emit();
  return row;
}

/** Delete a scenario from the demo's list; refused (with the names) while others build on it. */
export function deleteDemoScenario(id: string): { ok: true } | { ok: false; message: string } {
  const children = state.filter((s) => s.parent_id === id);
  if (children.length) return { ok: false, message: `Other scenarios build on this one: ${children.map((c) => `“${c.name}”`).join(", ")}. Delete them or change what they build on first.` };
  state = state.filter((p) => p.id !== id);
  emit();
  return { ok: true };
}

/** The demo's scenarios as they are now (outside a component; the tests read this). */
export const demoScenariosNow = (): SandboxScenarioRow[] => state;

/** Puts the seeded scenarios back (tests). */
export function resetDemoScenarios(): void {
  state = DEMO_SCENARIOS;
  emit();
}

/** The demo's scenarios by name, kept up to date as they are saved. */
export function useDemoScenarios(): SandboxScenarioRow[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
    () => DEMO_SCENARIOS,
  );
}
