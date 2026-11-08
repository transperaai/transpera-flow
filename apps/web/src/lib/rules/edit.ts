// Rating a run with the analysis rules (issue #109): what the rules find in it, and leaving out what a switched-off rule
// found. Since B17 (D40) every page passes the documented defaults (lib/analysis/defaults.ts), and what the rules find is
// shown as facts, never as findings. Pure.

import {
  detectIssues,
  resolveMoney,
  toRatingConfig,
  withoutDisabledRules,
  type AbsenceTest,
  type AnalysisSettings,
  type DetectedIssue,
  type EngineModel,
  type SimulationResult,
} from "@transpera-flow/engine";

/**
 * Everything the Issues screens list for a run, under these rules: the rules' own findings, broken solutions and
 * perception gaps, without those of rules switched off (rules the engine doesn't rate yet still switch off).
 */
export function visibleFindings(settings: AnalysisSettings, findings: readonly DetectedIssue[]): DetectedIssue[] {
  return withoutDisabledRules(settings, findings);
}

/**
 * Rate a run again under these settings. No simulation: `result` is the run already made, and the same run serves
 * every settings document. This is what "changing a rule re-rates the latest run straight away" means.
 */
export function rerate(
  model: EngineModel,
  result: SimulationResult,
  settings: AnalysisSettings,
  processId?: string | null,
  /** The absence test's result for this model (its own pass, see `useAbsenceTest`); without it "only one person can do it" raises nothing. */
  absence?: AbsenceTest | null,
  /** The workspace currency for the cost descriptions, and the shadow prices the too-busy cost needs (issue #108). */
  costs: { currency?: string; shadowPrices?: Record<string, number>} = {},
): DetectedIssue[] {
  return detectIssues(model, result, toRatingConfig(settings, model.hoursPerWeek), {
    processId,
    absence,
    // The money settings (12-month cap, absences a year) are the workspace's.
    cost: { ...resolveMoney(settings), ...(costs.currency ? { currency: costs.currency } : {}) },
    ...(costs.shadowPrices ? { shadowPrices: costs.shadowPrices } : {}),
  });
}
