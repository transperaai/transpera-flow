// The forecast (issue #35, B6): will someone become too busy, and when?
//
// A run asked for month-by-month numbers (`simulate(model, reps, seed, { monthly: true })`) says how busy each role
// and person is in each month of the horizon, with the 10-90% range of the replications. For each role and person,
// this finds the first month their busy share crosses the "Too busy" cut-off (rule 1, from the workspace's analysis
// rules), on the average and in a bad month (the 90th percentile), and writes it as an insight: rated by rule 1 as any
// other finding is, in plain English from a fixed template, with every number taken from the run.
//
// Someone already too busy on average in the first month isn't a forecast: the run's own "Too busy" insight says so.
// Pure: no I/O, no clock, no randomness.

import { eligible } from "./eligibility";
import { flattenModel } from "./flatten";
import type { DetectedIssue } from "./issues";
import { noCost } from "./cost";
import type { EngineModel, MonthBusy, MonthlyResult, SimulationResult } from "./model";
import {
  RATING_RULES,
  bandOf,
  rateRule,
  ratingFields,
  resolveRatingConfig,
  resolveRule,
  type RatingConfigInput,
  type RatingSubject,
} from "./ratings";

/** The prefix of a forecast insight's key: `forecast:role:<id>`, `forecast:person:<id>`. */
export const FORECAST_KEY_PREFIX = "forecast";

/** The "Too busy" band and above (Bad, Operational risk): band 2 of rule 1's cut-offs. */
const TOO_BUSY_BAND = 2;

/** A month in which a busy share first reaches the line, and the share then. */
export interface Crossing {
  /** 0 is the run's first month. */
  month: number;
  value: number;
}

/** When a busy series first crosses the "Too busy" cut-off, on the average and in a bad month. */
export interface BusyCrossing {
  average: Crossing | null;
  badMonth: Crossing | null;
}

/**
 * The first month a series is too busy (rule 1's Bad band or above), on its average and on its 90th percentile.
 * Months with nobody there (null) never cross.
 */
export function firstCrossing(series: readonly (MonthBusy | null)[], cutoffs: readonly [number, number, number]): BusyCrossing {
  const upper = RATING_RULES.busy.upperInclusive;
  let average: Crossing | null = null;
  let badMonth: Crossing | null = null;
  series.forEach((m, i) => {
    if (!m) return;
    if (!average && bandOf(cutoffs, m.mean, upper) >= TOO_BUSY_BAND) average = { month: i, value: m.mean };
    if (!badMonth && bandOf(cutoffs, m.p90, upper) >= TOO_BUSY_BAND) badMonth = { month: i, value: m.p90 };
  });
  return { average, badMonth };
}

export interface ForecastAlertOptions {
  /** The month's name for month `i` of the run (0 is the first), as people read it: "February". Default: "month 1", "month 2"… */
  monthName?: (i: number) => string;
}

const LOCALE = "en-GB";
const num = (v: number, digits = 1) => v.toLocaleString(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const pct = (share: number) => `${Math.round(share * 100)}%`;

/**
 * "Too busy" alerts from a month-by-month run: one insight per role, then per person whose roles aren't all alerted
 * already, for the first month they cross the cut-off. Empty when the run has no month-by-month numbers.
 */
export function forecastAlerts(
  model: EngineModel,
  result: SimulationResult,
  configInput?: RatingConfigInput,
  options: ForecastAlertOptions = {},
): DetectedIssue[] {
  const monthly = result.monthly;
  if (!monthly || !monthly.months.length) return [];
  model = flattenModel(model);
  const config = resolveRatingConfig(configInput);
  const people = result.resolvedPeople;
  const named = model.people !== undefined;
  const monthName = options.monthName ?? ((i: number) => `month ${i + 1}`);
  const useBadMonth = RATING_RULES.busy.badMonth && config.escalators.badMonth;
  const hoursPerDay = model.hoursPerWeek / 5;
  const reps = result.reps;
  const out: DetectedIssue[] = [];

  /** The step with the longest wait for a person that month among `steps`, if anyone waited there at all. */
  const longestWait = (stepIds: string[], month: number): { stepId: string; hours: number } | null => {
    let best: { stepId: string; hours: number } | null = null;
    for (const id of stepIds) {
      const w = monthly.waits[id]?.[month];
      if (w != null && w > 0 && (!best || w > best.hours)) best = { stepId: id, hours: w };
    }
    return best;
  };
  const stepName = (id: string) => model.steps.find((s) => s.id === id)?.name ?? id;

  const alert = (
    kind: "role" | "person",
    id: string,
    label: string,
    subject: RatingSubject,
    series: readonly (MonthBusy | null)[],
    stepIds: string[],
    roleId: string | null,
    personId: string | null,
  ): DetectedIssue | null => {
    const resolved = resolveRule(config, "busy", subject);
    if (!resolved.enabled) return null;
    const { average, badMonth } = firstCrossing(series, resolved.cutoffs);
    const bad = useBadMonth ? badMonth : null;
    // Too busy on average from the first month: not a forecast (the run's own insight covers it). Never: nothing to say.
    if (average?.month === 0 || (!average && !bad)) return null;
    const at = Math.min(average?.month ?? Infinity, bad?.month ?? Infinity);
    const m = series[at]!;
    const outcome = rateRule(config, "busy", resolved, { average: m.mean, p90: m.p90, onBottleneck: false });
    if (outcome.rating === "great") return null;
    const viaBadMonth = !average || (bad !== null && bad.month < average.month);
    const when = monthName(at);
    const line = resolved.cutoffs[1];
    const wait = longestWait(stepIds, at);
    const late = monthly.lateTasks[at]?.mean ?? 0;
    const lateN = Math.round(late);
    const consequences: string[] = [];
    if (wait) {
      const days = wait.hours / hoursPerDay;
      // Under an hour isn't worth a warning.
      if (days >= 1) consequences.push(`a ${num(days)}-working-day wait at ${stepName(wait.stepId)}`);
      else if (wait.hours >= 1) consequences.push(`a ${num(wait.hours, 0)}-hour wait at ${stepName(wait.stepId)}`);
    }
    if (lateN > 0) consequences.push(`${lateN} client task${lateN === 1 ? "" : "s"} across the business late or missed that month`);
    const act = at > 0 ? `Hire or move work by ${monthName(at - 1)}` : "Act now";
    const peak = series.reduce<{ i: number; v: number } | null>((p, s, i) => (s && (!p || s.mean > p.v) ? { i, v: s.mean } : p), null);
    const sentences = [
      `Forecast over ${monthly.months.length} month${monthly.months.length === 1 ? "" : "s"}, ${reps} simulated runs, against the ${pct(line)} "Too busy" line.`,
      average
        ? `On average ${label} crosses it in ${monthName(average.month)} (${pct(average.value)}).`
        : `On average ${label} stays under it (at most ${pct(peak?.v ?? 0)}, in ${monthName(peak?.i ?? 0)}).`,
      bad ? `In a bad month (the 90th percentile of the runs) that happens in ${monthName(bad.month)} (${pct(bad.value)}).` : "",
      `In ${when}: ${num(m.work)} h/wk of work against ${num(m.capacity)} h/wk available (${pct(m.mean)}, range ${pct(m.p10)}–${pct(m.p90)}).`,
      consequences.length ? `${act}, or expect ${consequences.join(" and ")}.` : `${act}.`,
    ];
    return {
      key: `${FORECAST_KEY_PREFIX}:${kind}:${id}`,
      type: "capacity",
      ...ratingFields(outcome),
      cost: noCost("A forecast: nothing is lost yet. Once it is too busy, the run's own \"Too busy\" insight prices it."),
      title: `${label} gets too busy in ${when} (${pct(viaBadMonth ? bad!.value : average!.value)}${viaBadMonth ? " in a bad month" : " on average"})`,
      evidence: sentences.filter(Boolean).join(" "),
      metrics: {
        month: at + 1,
        utilisation: m.mean,
        utilisation_p10: m.p10,
        utilisation_p90: m.p90,
        too_busy_line: line,
        ...(average ? { average_month: average.month + 1 } : {}),
        ...(bad ? { bad_month: bad.month + 1 } : {}),
        capacity_hours_week: m.capacity,
        work_hours_week: m.work,
        ...(wait ? { wait_hours: wait.hours } : {}),
        ...(lateN > 0 ? { late_tasks: late } : {}),
      },
      stepId: wait?.stepId ?? stepIds[0] ?? null,
      roleId,
      personId,
      fix: null,
    };
  };

  const alerted = new Set<string>();
  for (const rid of Object.keys(model.roles).sort()) {
    const series = monthly.roles[rid];
    if (!series) continue;
    const members = Object.keys(people).filter((pid) => people[pid]!.roles.includes(rid));
    const only = named && members.length === 1 ? members[0]! : null;
    const name = model.roles[rid]!.name;
    const label = only ? `${name} (${people[only]!.name})` : name;
    const steps = model.steps.filter((s) => s.role === rid).map((s) => s.id);
    const found = alert("role", rid, label, { roleId: rid, personId: only }, series, steps, rid, only);
    if (found) {
      out.push(found);
      alerted.add(rid);
    }
  }
  for (const pid of Object.keys(people).sort()) {
    const p = people[pid]!;
    const series = monthly.people[pid];
    if (!series || !(p.capacity > 0)) continue;
    // Their role's alert names them when they are its only member, and speaks for them otherwise.
    if (p.roles.length && p.roles.every((rid) => alerted.has(rid))) continue;
    const main = p.roles[0] ?? null;
    const label = named ? p.name : `One ${main ? (model.roles[main]?.name ?? "person") : "person"}`;
    const steps = model.steps.filter((s) => eligible(pid, p, s)).map((s) => s.id);
    const found = alert("person", pid, label, { personId: named ? pid : null, roleId: main }, series, steps, main, named ? pid : null);
    if (found) out.push(found);
  }
  return out;
}

/** The month of a forecast an hour of the run falls in (0 is the first); null outside the horizon. */
export function monthOfHour(monthly: Pick<MonthlyResult, "months">, hour: number): number | null {
  const i = monthly.months.findIndex((m) => hour >= m.start && hour < m.end);
  return i < 0 ? null : i;
}
