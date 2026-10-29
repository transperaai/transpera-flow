// Where the time goes (sandbox G, phase 4; shared by the web app, its exports and MCP): the engine's `MonthlyResult.time` read as hours and shares of the whole capacity, one row per
// category of the workspace's list, then Idle and (for the team and roles) Uncovered. Pure: no React. The engine only knows opaque
// purpose keys; the names, the order and the two mappings below live here, so renaming or reordering a category needs no re-run.

import type { MonthlyResult, Stat, TimeSplit } from "@transpera-flow/engine";
import { FIXING_PURPOSE, UPKEEP_PURPOSE, type PurposeCategory } from "../purposes";

export interface TimeRow {
  id: string;
  name: string;
  kind: "category" | "idle" | "uncovered";
  /** Hours in each month (mean with the 10-90% range). */
  hours: Stat[];
  /** Mean hours ÷ mean hours available that month (ratio of means). Uncovered is outside the 100%. */
  share: number[];
  /** Over the run: the sum of the months' means, and the sum of hours ÷ the sum of the hours available. No range (as the profit tile). */
  runHours: number;
  runShare: number;
}

/** The rows of a split and the totals behind them (the web's `TimeView` adds the timeline's months). */
export interface TimeRows {
  rows: TimeRow[];
  /** Hours available plus overtime worked each month: the 100%. */
  total: Stat[];
  /** Work above hours that month: idle is 0 and the categories add up to more than 100%. */
  over: boolean[];
  notes: string[];
}

export type TimeScope = { kind: "team" } | { kind: "role"; id: string } | { kind: "person"; id: string } | { kind: "others"; except: string };

/** The id of the row for hours that fit no category in the list (a deleted category on an unpublished model, or a step with no key). */
export const NOT_SET = "not_set";
export const IDLE = "idle";
export const UNCOVERED = "uncovered";

const ZERO: Stat = { mean: 0, p10: 0, p90: 0 };
const add = (a: Stat, b: Stat): Stat => ({ mean: a.mean + b.mean, p10: a.p10 + b.p10, p90: a.p90 + b.p90 });
const sub = (a: Stat, b: Stat): Stat => ({ mean: Math.max(0, a.mean - b.mean), p10: Math.max(0, a.p10 - b.mean), p90: Math.max(0, a.p90 - b.mean) });

/** The split for a scope. `others` is the team less one person, month by month on the means (their range is the team's shifted by that person's mean). */
function splitFor(time: MonthlyResult["time"], scope: TimeScope): TimeSplit | null {
  if (scope.kind === "team") return time.team;
  if (scope.kind === "role") return time.roles[scope.id] ?? null;
  if (scope.kind === "person") return time.people[scope.id] ?? null;
  const me = time.people[scope.except];
  if (!me) return time.team;
  const t = time.team;
  const minus = (a: Stat[], b: Stat[]) => a.map((s, m) => sub(s, b[m] ?? ZERO));
  return {
    purpose: Object.fromEntries(Object.entries(t.purpose).map(([k, v]) => [k, minus(v, me.purpose[k] ?? [])])),
    rework: minus(t.rework, me.rework),
    withRework: Object.fromEntries(Object.entries(t.withRework).map(([k, v]) => [k, minus(v, me.withRework[k] ?? [])])),
    ongoing: minus(t.ongoing, me.ongoing),
    idle: minus(t.idle, me.idle),
    hours: minus(t.hours, me.hours),
    uncovered: t.uncovered,
  };
}

/**
 * The split of a scope as rows, for a run of `n` months. `fixing` is its own hours plus every rework hour (rework on any step counts as Fixing), with the
 * engine's range of that sum (`withRework`); the client hours that are not steps (`ongoing`) are the fixed "Client upkeep" row. A key
 * that is not in the list goes to "Not set", whose range is the ranges added (only an approximation; normally the row is empty, as every
 * step resolves to a listed key). "Everyone else" takes a person's means off the team's, so its ranges are the team's shifted.
 */
export function timeRows(monthly: MonthlyResult, n: number, categories: readonly PurposeCategory[], scope: TimeScope): TimeRows {
  const split = splitFor(monthly.time, scope);
  const zeros = (): Stat[] => Array.from({ length: n }, () => ({ ...ZERO }));
  const total = split?.hours ?? zeros();
  const listed = new Set(categories.map((c) => c.key));
  const series = (key: string): Stat[] => {
    let out = split?.purpose[key] ? [...split.purpose[key]!] : zeros();
    // Fixing takes every rework hour: the range of the sum when the engine has it (a step that chose Fixing), else the rework itself.
    if (key === FIXING_PURPOSE && split) out = split.withRework[key] ? [...split.withRework[key]!] : out.map((s, m) => add(s, split.rework[m] ?? ZERO));
    if (key === UPKEEP_PURPOSE && split) out = out.map((s, m) => add(s, split.ongoing[m] ?? ZERO));
    return out;
  };
  const runOf = (stats: Stat[]) => stats.reduce((a, s) => a + s.mean, 0);
  const runTotal = runOf(total);
  const make = (id: string, name: string, kind: TimeRow["kind"], hours: Stat[]): TimeRow => ({
    id,
    name,
    kind,
    hours,
    share: hours.map((s, m) => (total[m]!.mean > 0 ? s.mean / total[m]!.mean : 0)),
    runHours: runOf(hours),
    runShare: runTotal > 0 ? runOf(hours) / runTotal : 0,
  });
  const rows: TimeRow[] = categories.map((c) => make(c.key, c.name, "category", series(c.key)));
  // Keys on the model's steps that the list doesn't have, and steps with no key at all.
  const other = (split ? Object.keys(split.purpose) : []).filter((k) => !listed.has(k));
  if (other.length) {
    const hours = other.map(series).reduce((acc, s) => acc.map((x, m) => add(x, s[m]!)), zeros());
    if (hours.some((s) => s.mean > 0)) rows.push(make(NOT_SET, "Not set", "category", hours));
  }
  const idle = split?.idle ?? zeros();
  rows.push(make(IDLE, "Idle", "idle", idle));
  const uncovered = split?.uncovered ?? null;
  if (uncovered) rows.push(make(UNCOVERED, "Nobody there to do it", "uncovered", uncovered));

  const over = Array.from({ length: n }, (_, m) => {
    let used = idle[m]!.mean;
    for (const r of rows) if (r.kind === "category") used += r.hours[m]!.mean;
    return used > total[m]!.mean * 1.001 + 1e-9;
  });
  const notes = [
    "Rework on any step counts as Fixing.",
    `Client hours that are not steps (the hours a role gives each client every week) are their own row, ${categories.find((c) => c.key === UPKEEP_PURPOSE)?.name ?? "Client upkeep"}.`,
  ];
  if (over.some(Boolean)) notes.push("In months marked with a dot there is more work than hours: overtime is capped, so the categories add up to more than 100% and nobody is idle.");
  if (rows.some((r) => r.kind === "uncovered" && r.runHours > 0)) notes.push("Nobody there to do it is work nobody of the role was there for (leave, or no one in the role). It is outside the 100%.");
  return { rows, total, over, notes };
}
