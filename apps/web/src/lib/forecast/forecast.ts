// The forecast (issue #35, B6): the company model run forward month by month with its planned hires, end dates and
// leave, and "who gets too busy, and when" from it. Pure (no React): the page, the People page and the Overview's
// team load chart (B15) build the same model and read the same alerts.

import { ModelError, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import { forecastAlerts, toRatingConfig, type AnalysisSettings, type DetectedIssue, type EngineModel, type ScenarioPatch, type SimulationResult } from "@transpera-flow/engine";
import { horizonWeeks } from "@/lib/horizon";
import { withLeverChanges } from "@/lib/solutions/levers";
import { visibleFindings } from "@/lib/rules/edit";
import { calendarMonthStarts, timelineMonths } from "./timeline";

/** The horizon the forecast opens on: a year ahead. */
export const DEFAULT_FORECAST_MONTHS = 12;

/** Today, as the ISO date a forecast starts on. */
export const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * The company model for a forecast of `months` months from `startDate`: planned hires join on their start date and
 * people with an end date leave then (other screens simulate today's team), and the market schedule applies month
 * by month as always. An error message instead when the model can't be simulated yet.
 */
export function forecastModel(
  bundle: ProcessBundle,
  months: number,
  startDate: string,
  /** The lever changes of the solutions live in this run, in go-live order (B4; D46 said they weren't applied, D48 amends it). */
  levers: readonly ScenarioPatch[] = [],
): { model: EngineModel; monthStarts: number[]; error: null } | { model: null; monthStarts: null; error: string } {
  try {
    const model = { ...withLeverChanges(toEngineModel(bundle, { startDate, planned: true }), levers).model, horizonWeeks: horizonWeeks(months) };
    // The run's months are the calendar's, so "February" in an alert is February.
    return { model, monthStarts: calendarMonthStarts(startDate, model.horizonWeeks, model.hoursPerWeek), error: null };
  } catch (err) {
    if (err instanceof ModelError) return { model: null, monthStarts: null, error: err.message };
    throw err;
  }
}

/**
 * The forecast's alerts as insights, under the workspace's analysis rules: the first month each role and person gets
 * too busy, named by the calendar month, and none when rule 1 is switched off.
 */
export function forecastInsights(model: EngineModel, result: SimulationResult, rules: AnalysisSettings, startDate: string): DetectedIssue[] {
  if (!result.monthly) return [];
  const months = timelineMonths(startDate, result.monthly.months, model.hoursPerWeek);
  // When a month's name comes round again its name alone is ambiguous: "October 2027".
  const repeats = new Set(months.map((m) => m.name)).size < months.length;
  const name = (i: number) => (repeats ? months[i]?.long : months[i]?.name) ?? `month ${i + 1}`;
  const alerts = forecastAlerts(model, result, toRatingConfig(rules, model.hoursPerWeek), { monthName: name });
  return visibleFindings(rules, alerts);
}
