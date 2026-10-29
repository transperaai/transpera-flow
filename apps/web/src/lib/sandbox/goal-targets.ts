// What goal seek can aim at and what it can move (docs/plans/sandbox-p5-brief.md section 9). Pure: no React, no runs.
//
// Targets: every role (or one) at most X% busy in every month (on the average, or "in 9 of 10 runs"); monthly churn over the run at most X%
// (average only: a ratio of means has no range); profit over the run, or in one month, at least Y (admins and the Owner: a run without costs has
// none). Levers: headcount by role, hours available, step time, opportunities, a price rise and fees, each over a range within the registry's.

import { sandboxLever, type SandboxChange } from "@transpera-flow/db";
import type { MonthlyResult } from "@transpera-flow/engine";
import { formatNumber, formatPercent, formatWholeCurrency } from "@/lib/format";
import { churnRate, monthProfit, peakBusy, totalProfit } from "./measures";
import type { SeekAnswer, SeekSpec } from "./goal-seek";

export type GoalTarget =
  | { kind: "busy"; roleId: string | null; roleName: string | null; limit: number; nines: boolean }
  | { kind: "churn"; limit: number }
  | { kind: "profit"; threshold: number; month: number | null; monthName: string | null; low: boolean };

export interface TargetSpec {
  measure: (m: MonthlyResult) => number | null;
  meets: (v: number) => boolean;
  gap: (v: number) => number;
  /** The number is a share (0 to 1): half a point is noise. */
  share: boolean;
  /** "every role stays under 85% busy in every month". */
  clause: string;
  /** How a measured number is written, for the probe table. */
  show: (v: number) => string;
}

export function targetSpec(t: GoalTarget, currency: string): TargetSpec {
  switch (t.kind) {
    case "busy": {
      const who = t.roleName ? `${t.roleName} stays` : "every role stays";
      return {
        measure: (m) => peakBusy(m, { roleId: t.roleId, nines: t.nines }),
        meets: (v) => v <= t.limit + 1e-9,
        gap: (v) => Math.max(0, v - t.limit),
        share: true,
        clause: `${who} under ${formatPercent(t.limit)} busy in every month${t.nines ? ", in 9 of 10 runs" : ""}`,
        show: (v) => `${formatPercent(v)} at its busiest`,
      };
    }
    case "churn":
      return {
        measure: churnRate,
        meets: (v) => v <= t.limit + 1e-9,
        gap: (v) => Math.max(0, v - t.limit),
        share: true,
        clause: `monthly churn stays under ${formatNumber(t.limit * 100, 1)}%`,
        show: (v) => `${formatNumber(v * 100, 2)}% a month`,
      };
    case "profit": {
      const when = t.month === null ? "over the run" : `in ${t.monthName ?? `month ${t.month + 1}`}`;
      return {
        measure: (m) => (t.month === null ? totalProfit(m) : monthProfit(m, t.month, t.low)),
        meets: (v) => v >= t.threshold - 1e-9,
        gap: (v) => Math.max(0, t.threshold - v),
        share: false,
        clause: `profit ${when} is at least ${formatWholeCurrency(t.threshold, currency)}${t.low ? ", in 9 of 10 runs" : ""}`,
        show: (v) => formatWholeCurrency(v, currency),
      };
    }
  }
}

/** The lever a goal seek moves, with the range it searches by default (narrowable inside the registry's range). */
export interface GoalLever {
  id: "D5" | "D6" | "E1" | "A1" | "B5" | "B2";
  label: string;
  /** What it points at: a role (the busiest by default), a step (the heaviest), a service or nothing. */
  target: "role" | "step" | "service_or_none" | "role_or_none" | "none";
  op: SandboxChange["op"];
  lo: number;
  hi: number;
  step: number;
  whole: boolean;
  /** The lever's value when nothing is changed (add 0, multiply 1, a price change of 0). */
  today: number;
  /** The levers whose model a target can't tell apart from "nothing" are still listed; this one is for a Viewer: money-free. */
  moneyFree: boolean;
}

export const GOAL_LEVERS: readonly GoalLever[] = [
  { id: "D5", label: "People in a role", target: "role", op: "add", lo: 0, hi: 10, step: 1, whole: true, today: 0, moneyFree: true },
  { id: "D6", label: "Hours available", target: "role_or_none", op: "multiply", lo: 0.8, hi: 1.3, step: 0.05, whole: false, today: 1, moneyFree: true },
  { id: "E1", label: "Time a step takes", target: "step", op: "multiply", lo: 0.3, hi: 1.5, step: 0.05, whole: false, today: 1, moneyFree: true },
  { id: "A1", label: "Opportunities coming in", target: "none", op: "multiply", lo: 0.5, hi: 3, step: 0.05, whole: false, today: 1, moneyFree: true },
  { id: "B5", label: "Price rise", target: "service_or_none", op: "set", lo: -0.2, hi: 0.5, step: 0.01, whole: false, today: 0, moneyFree: true },
  { id: "B2", label: "Fees", target: "service_or_none", op: "multiply", lo: 0.5, hi: 2, step: 0.05, whole: false, today: 1, moneyFree: true },
];

export const goalLever = (id: string): GoalLever | undefined => GOAL_LEVERS.find((l) => l.id === id);

/** A range clamped to the registry's, with `lo` below `hi` and both on the lever's grid. */
export function clampRange(l: GoalLever, lo: number, hi: number): { lo: number; hi: number } {
  const reg = sandboxLever(l.id)?.range[l.op];
  const min = Math.max(reg?.min ?? -Infinity, l.op === "add" ? -20 : (reg?.min ?? -Infinity));
  const max = Math.min(reg?.max ?? Infinity, l.op === "add" ? 20 : (reg?.max ?? Infinity));
  const snap = (v: number) => +(Math.round(v / l.step) * l.step).toFixed(10);
  const a = Math.min(max, Math.max(min, snap(Math.min(lo, hi))));
  const b = Math.min(max, Math.max(min, snap(Math.max(lo, hi))));
  return a === b ? { lo: a, hi: Math.min(max, +(a + l.step).toFixed(10)) } : { lo: a, hi: b };
}

export interface GoalChoice {
  lever: GoalLever;
  /** The role, step or service the lever points at; "" for none (or for the busiest role / heaviest step by selector). */
  targetId: string;
  /** "YYYY-MM" to move the lever from a month, else the whole run. */
  from: string | null;
  lo: number;
  hi: number;
}

/** The change a probe at `x` makes (a fresh id each, as the runner only needs them unique inside one list). */
export function goalChange(c: GoalChoice, x: number, id = "5e000000-0000-4000-8000-0000000000f0"): SandboxChange {
  const l = c.lever;
  const target = l.target === "none" ? null : c.targetId === "" ? (l.id === "D5" ? "@busiest" : l.id === "E1" ? "@heaviest" : null) : c.targetId;
  return { id, lever: l.id, target, op: l.op, value: +x.toFixed(10), ...(c.from ? { from: c.from } : {}) };
}

export function seekSpecFor(c: GoalChoice, t: TargetSpec): SeekSpec {
  return { lo: c.lo, hi: c.hi, step: c.lever.step, whole: c.lever.whole, today: c.lever.today, meets: t.meets, gap: t.gap, share: t.share };
}

/** How a lever value reads: "3 more Designers", "×1.25 opportunities", "a price rise of +12%". */
export function valueWords(c: GoalChoice, x: number, targetName: string | null): string {
  const l = c.lever;
  const n = (v: number) => formatNumber(v, 2);
  switch (l.id) {
    case "D5":
      return `${n(Math.abs(x))} ${x < 0 ? "fewer" : "more"} ${targetName ?? "people in the busiest role"}`;
    case "B5":
      return `a price ${x < 0 ? "cut" : "rise"} of ${x < 0 ? "−" : "+"}${formatNumber(Math.abs(x) * 100, 1)}%`;
    case "D6":
      return `hours available ×${n(x)}`;
    case "E1":
      return `${targetName ?? "the heaviest step"} taking ×${n(x)} the time`;
    case "A1":
      return `opportunities ×${n(x)}`;
    case "B2":
      return `fees ×${n(x)}`;
  }
}

/** The answer in a sentence, for the dialog and the note on "Add as a change". Null while it is still running. */
export function answerSentence(a: SeekAnswer, c: GoalChoice, t: TargetSpec, targetName: string | null): string | null {
  switch (a.kind) {
    case "running":
      return null;
    case "cannot":
      return a.why;
    case "already":
      return `Already met across this range: ${t.clause}. The least change is ${valueWords(c, a.x, targetName)}.`;
    case "unreachable":
      return `Not reachable in this range. The closest was ${valueWords(c, a.closest.x, targetName)}: ${t.show(a.closest.value!)}.`;
    case "boundary":
      return `${a.side === "high" ? "At least" : "Up to"} ${valueWords(c, a.x, targetName)}: ${t.clause}.`;
  }
}

/** Why the search might not be reliable, in words, or null. */
export function monotoneWarning(a: SeekAnswer, c: GoalChoice, measureName: string, targetName: string | null): string | null {
  if (a.kind === "running" || a.kind === "cannot" || a.monotone.ok) return null;
  const m = a.monotone;
  const [x1, x2] = m.between;
  return `${measureName} doesn't move steadily with ${c.lever.label.toLowerCase()} across this range (it ${m.direction} between ${valueWords(c, x1, targetName)} and ${valueWords(c, x2, targetName)}), so a smaller value may also work. Narrow the range or look at the points below.`;
}
