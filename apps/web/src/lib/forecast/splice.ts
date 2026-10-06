// Joining the month-by-month numbers of a plan's runs (B7, issue #36). A solution can't switch a process's steps in the
// middle of a run, so a plan with solutions is run once per go-live month (the model with the solutions live by then, from
// month 0, same seed) and the runs are spliced: months before a solution's month come from the run without it, from that
// month on from the run with it. Busy shares, waits and late tasks (flows) switch at once; clients, revenue and clients at
// risk (stocks) carry on from where they were and change only as the later run changes. Pure.

import type { MonthBusy, MonthlyResult, Stat } from "@transpera-flow/engine";

const ZERO: Stat = { mean: 0, p10: 0, p90: 0 };

/**
 * Segments sorted by `from`, the first at 0, all with the same `months`.
 *
 * Flows (`roles`, `people`, `uncovered`, `waits`, `lateTasks`): month `m` takes the value of the segment whose range holds
 * `m`; a key missing in that segment gives null (a zero `Stat` for `lateTasks`). Stocks (`clients`, `mrr`, `atRisk`): the
 * first segment as is; a later segment starting at `k` is shifted by the gap it leaves at `k − 1` (the spliced value there
 * less its own), and floored at 0, so only the change from month `k` follows its run. A key missing on either side counts as 0.
 */
export function spliceMonthly(segments: readonly { from: number; monthly: MonthlyResult }[]): MonthlyResult {
  const first = segments[0]!.monthly;
  if (segments.length === 1) return first;
  const n = first.months.length;
  const segmentOf = (m: number) => {
    let s = 0;
    for (let i = 0; i < segments.length; i++) if (segments[i]!.from <= m) s = i;
    return s;
  };

  const flow = <T>(pick: (r: MonthlyResult) => Record<string, T[]>): Record<string, (T | null)[]> => {
    const keys = [...new Set(segments.flatMap((s) => Object.keys(pick(s.monthly))))];
    const out: Record<string, (T | null)[]> = {};
    for (const key of keys) out[key] = Array.from({ length: n }, (_, m) => pick(segments[segmentOf(m)]!.monthly)[key]?.[m] ?? null);
    return out;
  };
  const roles = flow<MonthBusy | null>((r) => r.roles) as MonthlyResult["roles"];
  const people = flow<MonthBusy | null>((r) => r.people) as MonthlyResult["people"];
  const uncovered = flow<number | null>((r) => r.uncovered) as MonthlyResult["uncovered"];
  const waits = flow<number | null>((r) => r.waits) as MonthlyResult["waits"];
  const lateTasks = Array.from({ length: n }, (_, m) => segments[segmentOf(m)]!.monthly.lateTasks[m] ?? ZERO);

  /** A stock's series, month by month: `get(segment, month)` is that run's `Stat`, a missing one counting as 0. */
  const stock = (get: (r: MonthlyResult, m: number) => Stat | undefined): Stat[] => {
    const out: Stat[] = [];
    for (let m = 0; m < n; m++) {
      const s = segmentOf(m);
      const here = get(segments[s]!.monthly, m) ?? ZERO;
      if (s === 0) {
        out.push({ ...here });
        continue;
      }
      const k = segments[s]!.from;
      const offset = out[k - 1]!.mean - (get(segments[s]!.monthly, k - 1) ?? ZERO).mean;
      out.push({ mean: Math.max(0, here.mean + offset), p10: Math.max(0, here.p10 + offset), p90: Math.max(0, here.p90 + offset) });
    }
    return out;
  };
  const keysOf = (pick: (r: MonthlyResult) => Record<string, Stat[]>) => [...new Set(segments.flatMap((s) => Object.keys(pick(s.monthly))))].sort();
  const clients: Record<string, Stat[]> = {};
  for (const key of keysOf((r) => r.clients)) clients[key] = stock((r, m) => r.clients[key]?.[m]);
  const atRisk: Record<string, Stat[]> = {};
  for (const key of keysOf((r) => r.atRisk)) atRisk[key] = stock((r, m) => r.atRisk[key]?.[m]);

  return {
    months: first.months,
    roles,
    uncovered,
    people,
    waits,
    lateTasks,
    clients,
    mrr: stock((r, m) => r.mrr[m]),
    atRisk,
  };
}
