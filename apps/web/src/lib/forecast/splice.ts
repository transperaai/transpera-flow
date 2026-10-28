// Joining the month-by-month numbers of a plan's runs (B7, issue #36). A solution can't switch a process's steps in the
// middle of a run, so a plan with solutions is run once per go-live month (the model with the solutions live by then, from
// month 0, same seed) and the runs are spliced: months before a solution's month come from the run without it, from that
// month on from the run with it. Busy shares, waits and late tasks (flows) switch at once; clients, revenue and clients at
// risk (stocks) carry on from where they were and change only as the later run changes. Pure.

import type { MonthBusy, MonthlyResult, SimulationResult, Stat } from "@transpera-flow/engine";

const ZERO: Stat = { mean: 0, p10: 0, p90: 0 };

/**
 * Segments sorted by `from`, the first at 0, all with the same `months`.
 *
 * Flows (`roles`, `people`, `uncovered`, `waits`, `lateTasks`): month `m` takes the value of the segment whose range holds
 * `m`; a key missing in that segment gives null (a zero `Stat` for `lateTasks`). The sales, client-movement, revenue,
 * overtime-hour and money series (sandbox phase 2) are flows too: what happens in a month is that month's, so month `m`
 * is the segment holding `m`'s own number; `money` is null if any segment's is (pay hidden). Stocks (`clients`, `mrr`, `atRisk`): the
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

  // The money series: flows, month by month from the segment holding the month.
  const at = (m: number) => segments[segmentOf(m)]!.monthly;
  const series = (get: (r: MonthlyResult, m: number) => Stat | undefined): Stat[] => Array.from({ length: n }, (_, m) => get(at(m), m) ?? ZERO);
  const numbers = (get: (r: MonthlyResult, m: number) => number | undefined): number[] => Array.from({ length: n }, (_, m) => get(at(m), m) ?? 0);
  const moneyKeys = (pick: (money: NonNullable<MonthlyResult["money"]>) => Record<string, number[]>) =>
    [...new Set(segments.flatMap((s) => (s.monthly.money ? Object.keys(pick(s.monthly.money)) : [])))].sort();
  const money: MonthlyResult["money"] = segments.some((s) => s.monthly.money === null)
    ? null
    : {
        labour: numbers((r, m) => r.money!.labour[m]),
        labourByRole: Object.fromEntries(moneyKeys((x) => x.labourByRole).map((key) => [key, numbers((r, m) => r.money!.labourByRole[key]?.[m])])),
        labourByPerson: Object.fromEntries(moneyKeys((x) => x.labourByPerson).map((key) => [key, numbers((r, m) => r.money!.labourByPerson[key]?.[m])])),
        overtimeCost: series((r, m) => r.money!.overtimeCost[m]),
        overheads: numbers((r, m) => r.money!.overheads[m]),
        profit: series((r, m) => r.money!.profit[m]),
      };

  return {
    months: first.months,
    sales: {
      opportunities: series((r, m) => r.sales.opportunities[m]),
      won: series((r, m) => r.sales.won[m]),
      lost: series((r, m) => r.sales.lost[m]),
      conversion: series((r, m) => r.sales.conversion[m]),
    },
    clientsWon: series((r, m) => r.clientsWon[m]),
    clientsLost: series((r, m) => r.clientsLost[m]),
    revenue: {
      total: series((r, m) => r.revenue.total[m]),
      recurring: series((r, m) => r.revenue.recurring[m]),
      oneOff: series((r, m) => r.revenue.oneOff[m]),
      hourly: series((r, m) => r.revenue.hourly[m]),
      fromNew: series((r, m) => r.revenue.fromNew[m]),
      lostToChurn: series((r, m) => r.revenue.lostToChurn[m]),
      rise: series((r, m) => r.revenue.rise[m]),
    },
    overtimeHours: series((r, m) => r.overtimeHours[m]),
    money,
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

/** The runs' per-replication months (`monthlySamples`) spliced the same way as the flows above: month m from the segment holding it. */
export function spliceSamples(segments: readonly { from: number; samples: NonNullable<SimulationResult["monthlySamples"]> }[]): NonNullable<SimulationResult["monthlySamples"]> {
  const first = segments[0]!.samples;
  if (segments.length === 1) return first;
  const segmentOf = (m: number) => {
    let s = 0;
    for (let i = 0; i < segments.length; i++) if (segments[i]!.from <= m) s = i;
    return s;
  };
  const join = (pick: (x: NonNullable<SimulationResult["monthlySamples"]>) => number[][]) =>
    pick(first).map((row, i) => row.map((_, m) => pick(segments[segmentOf(m)]!.samples)[i]![m]!));
  return { revenue: join((x) => x.revenue), rise: join((x) => x.rise), clientsLost: join((x) => x.clientsLost) };
}
