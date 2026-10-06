// Shared, memoised fixture data for the stories: Northbeam (the demo company) and one run of it. Everything is fixed: the seed,
// the number of runs and the start date, so a story renders the same pixels every time. Never `new Date()` here.

import { simulate, toRatingConfig, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import {
  defaultCompanyPart,
  northbeamBundle,
  northbeamIssues,
  northbeamStepIds,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  partOf,
  toEngineModel,
  type ProcessBundle,
  type ProcessPart,
  type SolutionIssueRow,
  type SolutionRow,
} from "@transpera-flow/db";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { timelineData, type TimelineData } from "@/lib/forecast/timeline";
import { solutionCopy } from "@/lib/solutions/bundle";
import type { SolutionsData } from "@/lib/solutions/cards";
import { demoBundle } from "@/lib/sources/demo";

export { DEMO_FORECAST_START, northbeamIssues, northbeamStepIds };

let run: { bundle: ProcessBundle; model: EngineModel; result: SimulationResult } | undefined;
/** Northbeam's process, its engine model and 30 runs of it (seed 1). */
export function northbeamRun() {
  if (!run) {
    const bundle = demoBundle();
    const model = toEngineModel(bundle);
    run = { bundle, model, result: simulate(model, 30, 1) };
  }
  return run;
}

let forecast: { bundle: ProcessBundle; model: EngineModel; result: SimulationResult; data: TimelineData; cutoffs: readonly [number, number, number] } | undefined;
/** The demo forecast (a planned hire, leave and a market schedule), 12 months from the fixed start date, month by month. */
export function northbeamForecast() {
  if (!forecast) {
    const bundle = demoForecastBundle();
    const built = forecastModel(bundle, 12, DEMO_FORECAST_START);
    if (!built.model) throw new Error("The demo forecast has no model.");
    const result = simulate(built.model, 30, 1, { monthly: true, monthStarts: built.monthStarts });
    const data = timelineData(built.model, result, bundle, DEMO_FORECAST_START);
    if (!data) throw new Error("The demo forecast has no timeline.");
    const cutoffs = toRatingConfig(ANALYSIS_DEFAULTS, bundle.workspace.settings.hours_per_week).rules.busy.cutoffs;
    forecast = { bundle, model: built.model, result, data, cutoffs };
  }
  return forecast;
}

/** Northbeam's company map as the Editor holds it: the stored map's cards and lines, with the processes they link to. */
export function companyBundle(): ProcessBundle {
  const base = northbeamBundle();
  const parts: ProcessPart[] = [partOf(base), ...(base.otherProcesses ?? [])];
  const company = defaultCompanyPart(base.workspace.id, parts);
  return { ...base, process: company.process, revision: company.revision, steps: company.steps, edges: company.edges, retired: [], otherProcesses: parts };
}

/** A rating for every step of a bundle, cycling through the four bands, so the map shows each at least once. */
export function ratingsByStep(bundle: ProcessBundle): (stepId: string) => { rank: number; label: string } | null {
  const bands = [
    { rank: 0, label: "Great" },
    { rank: 1, label: "Good" },
    { rank: 2, label: "Bad" },
    { rank: 3, label: "Operational risk" },
  ];
  const at = new Map(bundle.steps.map((s, i) => [s.id, bands[i % bands.length]!]));
  return (stepId) => at.get(stepId) ?? null;
}

// Solutions, as the Solutions list holds them.
const STAMP = "2026-10-05T10:00:00.000Z";

const solution = (id: string, extra: Partial<SolutionRow> = {}): SolutionRow => {
  const live = demoBundle();
  return {
    id,
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    process_id: NORTHBEAM_PROCESS_ID,
    base_revision_id: live.revision.id,
    name: `Solution ${id}`,
    notes: "",
    steps: solutionCopy(live),
    changed_step_ids: [northbeamStepIds.audit],
    lever_changes: [],
    created_at: STAMP,
    updated_at: STAMP,
    created_by: "u1",
    ...extra,
  };
};
const link = (solutionId: string, issueId: string, extra: Partial<SolutionIssueRow> = {}): SolutionIssueRow => ({
  solution_id: solutionId,
  issue_id: issueId,
  workspace_id: NORTHBEAM_WORKSPACE_ID,
  auto_verdict: "pass",
  holds_pct: 92,
  auto_note: "ok",
  user_verdict: null,
  user_notes: "",
  created_at: STAMP,
  updated_at: STAMP,
  created_by: "u1",
  ...extra,
});

/** Two solutions: one that solves two issues (a pass and a fail), one not linked to any. */
export function solutionsFixture(): { data: SolutionsData; issues: ReturnType<typeof northbeamIssues> } {
  const issues = northbeamIssues();
  const [a, b] = issues;
  return {
    issues,
    data: {
      solutions: [solution("s1", { name: "AI lead qualifier" }), solution("s2", { name: "Faster proposals", created_at: "2026-10-03T10:00:00.000Z" })],
      links: [link("s1", a!.id), link("s1", b!.id, { auto_verdict: "fail", holds_pct: 40, user_verdict: "fail" })],
      aiIds: ["s1"],
    },
  };
}
