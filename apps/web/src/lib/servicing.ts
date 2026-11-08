// Client servicing in the app (issue #19): recurrence choices for a service's
// servicing processes, the workspace's health rules, and each roster client's
// simulated health and churn for the Clients page. Pure, so it can be unit
// tested.

import { engineRecurrence, parseRecurrence, type RecurrenceDriver, type RecurrenceJson } from "@transpera-flow/db";
import { DEFAULT_HEALTH_RULES, recurrenceLabel, type ClientResult } from "@transpera-flow/engine";

/** Recurrences offered in settings, most common first. Stored values that aren't one of these are offered too. */
export const RECURRENCE_PRESETS: RecurrenceJson[] = [
  { every: "week", times: 1 },
  { every: "week", times: 0.5 },
  { every: "month", times: 2 },
  { every: "month", times: 1 },
  { every: "month", times: 0.5 },
  { every: "month", times: 1 / 3 },
  { poisson_per_month: 1 },
  { poisson_per_month: 2 },
  { poisson_per_month: 4 },
];

/** What a "From the tier" recurrence can follow, in the words the tier's deliverables use. */
export const DRIVER_CHOICES: { value: RecurrenceDriver; label: string }[] = [
  { value: "words", label: "Words" },
  { value: "links", label: "Links" },
  { value: "techHours", label: "Tech hours" },
  { value: "meetings", label: "Meetings" },
  { value: "builds", label: "Builds" },
  { value: "creativeSets", label: "Creative sets" },
  { value: "channels", label: "Channels" },
  { value: "adhoc", label: "Ad hoc requests" },
];

/** Where "From the tier" starts: one task a month for every 1000 words. */
export const TIER_RECURRENCE_START: RecurrenceJson = { perMonth: 1, driver: "words", per: 1000 };

/** The three ways a link can be paced. */
export type RecurrenceKind = "fixed" | "adhoc" | "tier";

export const recurrenceKind = (r: RecurrenceJson): RecurrenceKind => ("driver" in r ? "tier" : "poisson_per_month" in r ? "adhoc" : "fixed");

/** A recurrence in words: "monthly", "fortnightly", "ad hoc, about 2 a month", "1 a month per 1000 words, from the tier". */
export function recurrenceText(r: RecurrenceJson): string {
  const e = engineRecurrence(r);
  if (!e) return "–";
  if ("driver" in r) {
    const n = (x: number) => String(Math.round(x * 100) / 100);
    const word = (DRIVER_CHOICES.find((d) => d.value === r.driver)?.label ?? r.driver).toLowerCase();
    return `${n(r.perMonth)} a month per ${r.per && r.per !== 1 ? `${n(r.per)} ` : ""}${word}, from the tier`;
  }
  if ("every" in r && r.every === "month" && Math.abs(r.times - 1 / 3) < 1e-9) return "quarterly";
  return recurrenceLabel(e);
}

/** Options for a recurrence select: the presets, plus the current value if it isn't one. Values are JSON. */
export function recurrenceOptions(current: RecurrenceJson | null): { value: string; label: string }[] {
  const list = [...RECURRENCE_PRESETS];
  const key = (r: RecurrenceJson) => JSON.stringify(r);
  if (current && !list.some((r) => key(r) === key(current))) list.unshift(current);
  return list.map((r) => ({ value: key(r), label: recurrenceText(r) }));
}

/** A select's JSON value back to a recurrence, if valid. */
export const recurrenceFromValue = (v: string | null): RecurrenceJson | null => {
  if (!v) return null;
  try {
    return parseRecurrence(JSON.parse(v));
  } catch {
    return null;
  }
};

/** The workspace's health rules (`settings` keys), with the estimated defaults they fall back to (docs/PRD.md §6.3.5). */
export const HEALTH_SETTINGS = {
  health_initial: { label: "Starting health", unit: "of 100", max: 100, fallback: DEFAULT_HEALTH_RULES.initial, hint: "For clients with no health entered, and new wins." },
  health_recover: { label: "Task on time", unit: "health +", max: 100, fallback: DEFAULT_HEALTH_RULES.recover, hint: "Added (up to 100) for each servicing task done within its SLA." },
  health_late_penalty: { label: "Task late", unit: "health −", max: 100, fallback: DEFAULT_HEALTH_RULES.latePenalty, hint: "Taken off for a task done after its SLA." },
  health_missed_penalty: { label: "Task missed", unit: "health −", max: 100, fallback: DEFAULT_HEALTH_RULES.missedPenalty, hint: "Taken off for a task not done within twice its SLA." },
} as const;
export type HealthSetting = keyof typeof HEALTH_SETTINGS;

/** One client's simulated retention, as the Clients page shows it. */
export interface ClientRetention {
  /** Health at the start and, on average, at the horizon. */
  start: number;
  end: number;
  endLow: number;
  endHigh: number;
  /** Monthly churn probability at the horizon (mean). */
  churnMonthly: number;
  /** Share of runs in which it churned in the horizon. */
  churned: number;
  onTime: number;
  late: number;
  missed: number;
  /** Health ends below 50 on average. */
  atRisk: boolean;
  /** Weekly mean health, for a sparkline. */
  trajectory: number[];
}

export function clientRetention(r: ClientResult): ClientRetention {
  return {
    start: r.trajectory[0] ?? r.health.mean,
    end: r.health.mean,
    endLow: r.health.p10,
    endHigh: r.health.p90,
    churnMonthly: r.churnMonthly.mean,
    churned: r.churned,
    onTime: r.touchpoints.onTime,
    late: r.touchpoints.late,
    missed: r.touchpoints.missed,
    atRisk: r.health.mean < 50,
    trajectory: r.trajectory,
  };
}
